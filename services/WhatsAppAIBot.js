require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://supabasekong-l4cw40oks4kso84ko44ogkkw.188.241.58.227.sslip.io';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY);

const settingsCache = new Map();
const CACHE_TTL = 30 * 1000; // 30 seconds

async function getSetting(key) {
    const cached = settingsCache.get(key);
    if (cached && Date.now() < cached.expiry) return cached.value;

    const { data, error } = await supabase.from('platform_settings').select('value').eq('key', key).maybeSingle();
    const value = data && !error ? data.value : null;

    if (value) {
        settingsCache.set(key, { value, expiry: Date.now() + CACHE_TTL });
    }
    return value;
}

// Keep conversation history in memory 
const chatSessions = new Map(); // phone -> [{ role, content }]
const RATE_LIMIT_MAP = new Map(); // phone -> last_message_time

async function sendWaSenderMessage(to, text) {
    const waConfig = await getSetting('wa_config');
    const WASENDER_URL = waConfig?.wasenderUrl;
    const WASENDER_API_KEY = waConfig?.token;

    if (!WASENDER_URL || !WASENDER_API_KEY) {
        console.warn('[WhatsApp Bot] WaSender non configuré dans l\'admin. Simulation. Message pour:', to, '| Texte:', text.substring(0, 50) + '...');
        return;
    }

    // Convert to proper WaSender format
    // Many WaSender APIs use POST /sendText with JSON { number, text, apikey }
    // Or /api/sendText with bearer token. We will try a flexible approach.
    try {
        const payload = {
            number: to,
            text: text,
            apikey: WASENDER_API_KEY
        };
        const res = await fetch(`${WASENDER_URL}/sendText`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WASENDER_API_KEY}` // Depending on API version
            },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        console.log(`[WhatsApp Bot] Message envoyé à ${to}. Status: ${res.status}`);
        return data;
    } catch (err) {
        console.error('[WhatsApp Bot] Erreur d\'envoi WaSender:', err.message);
    }
}

async function getBabipassContext() {
    // RAG: Fetch active events - two resilient queries to avoid join failures
    const { data: events, error } = await supabase
        .from('events')
        .select('*')
        .eq('status', 'published')
        .order('date', { ascending: true });

    if (error) {
        console.error('[WhatsApp Bot] Supabase events error:', error.message);
        return "Impossible de charger le catalogue actuel.";
    }

    let context = 'Voici le catalogue actuel des événements disponibles sur Babipass :\n\n';
    if (!events || events.length === 0) {
        return context + "Aucun événement disponible actuellement.\n";
    }

    // Fetch ticket types separately (fail-safe)
    const eventIds = events.map(e => e.id);
    let ticketTypesByEvent = {};
    try {
        const { data: tts, error: ttErr } = await supabase
            .from('ticket_types')
            .select('*')
            .in('event_id', eventIds);
        if (!ttErr && tts) {
            tts.forEach(tt => {
                if (!ticketTypesByEvent[tt.event_id]) ticketTypesByEvent[tt.event_id] = [];
                ticketTypesByEvent[tt.event_id].push(tt);
            });
        }
    } catch (e) {
        console.warn('[WhatsApp Bot] Could not fetch ticket_types (non-blocking):', e.message);
    }

    events.forEach(e => {
        context += `Événement: ${e.title}\n`;
        context += `Lieu: ${e.location || 'Non précisé'}, ${e.city}\n`;
        
        // Dates et heures
        const startDate = e.date ? new Date(e.date).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Non précisée';
        const endDate = e.end_date ? new Date(e.end_date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
        context += `Date et heure: ${startDate}${endDate ? ' (Fin prévue vers ' + endDate + ')' : ''}\n`;
        
        // Description
        context += `Description de l'événement: ${e.description ? e.description.substring(0, 600).replace(/\\n/g, ' ') + '...' : 'N/A'}\n`;
        
        // Programme
        if (e.program && Array.isArray(e.program) && e.program.length > 0) {
            context += `Programme récapitulatif :\n`;
            e.program.forEach(p => {
                context += ` - ${p.time}: ${p.title} ${p.description ? '(' + p.description + ')' : ''}\n`;
            });
        }
        
        if (e.ai_context && e.ai_context.trim().length > 0) {
            context += `Instructions Spéciales / FAQ Fournies par l'organisateur: ${e.ai_context}\n`;
        }

        if (e.coordinates && e.coordinates.lat && e.coordinates.lng) {
            context += `Google Maps: https://www.google.com/maps/search/?api=1&query=${e.coordinates.lat},${e.coordinates.lng}\n`;
        }

        // Billetterie et Places
        const eventRemaining = (e.capacity || 0) - (e.sold || 0);
        context += `PLACES GLOBALES RESTANTES pour l'événement : ${eventRemaining > 0 ? eventRemaining : 0}\n`;

        context += `Détails des Tarifs (Billets) :\n`;
        const tts = ticketTypesByEvent[e.id] || [];
        if (tts.length > 0) {
            tts.forEach(tt => {
                const ttRemaining = (tt.quantity || tt.capacity || 0) - (tt.sold || 0);
                context += `- ${tt.name} : ${tt.price === 0 ? 'Gratuit' : tt.price + ' FCFA'} (Reste environ ${ttRemaining} unité(s) pour ce tarif)\n`;
            });
        } else {
            context += `- Contactez l'organisateur pour les tarifs exacts.\n`;
        }
        const linkPath = e.slug ? e.slug : e.id;
        context += `Lien exact pour réservation : https://babipass.com/event/${linkPath}\n\n`;
    });

    return context;
}

async function askQwen(messages) {
    const OPENROUTER_API_KEY = await getSetting('openrouter_api_key');

    if (!OPENROUTER_API_KEY) {
        return "⚠️ Je suis actuellement en maintenance (Clé OpenRouter manquante dans l'admin). Veuillez réessayer plus tard.";
    }
    try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'https://babipass.com',
                'X-Title': 'Babipass AI Bot'
            },
            body: JSON.stringify({
                model: 'qwen/qwen3-235b-a22b-2507',
                messages: messages,
                temperature: 0.7,
                max_tokens: 800
            })
        });

        const data = await res.json();
        if (data.error) {
            console.error('[WhatsApp Bot] OpenRouter API Error:', data.error);
            const errMsg = data.error.message || JSON.stringify(data.error);
            return `Désolé, je rencontre une erreur de configuration (OpenRouter limit: ${errMsg}).`;
        }
        return data.choices[0].message.content;
    } catch (error) {
        console.error('[WhatsApp Bot] Erreur réseau OpenRouter:', error.message);
        return "Désolé, problème de réseau. Veuillez réessayer dans quelques instants.";
    }
}

async function handleIncomingMessage(phone, text) {
    // Rate limit prevention (max 1 message per 2 seconds per user)
    const now = Date.now();
    if (RATE_LIMIT_MAP.has(phone)) {
        if (now - RATE_LIMIT_MAP.get(phone) < 2000) return;
    }
    RATE_LIMIT_MAP.set(phone, now);

    // Get or initialize session
    let session = chatSessions.get(phone) || [];

    // Auto-clean history if too long (keep last 6 interactions to save context tokens)
    if (session.length > 12) {
        session = session.slice(session.length - 12);
    }

    // Refresh context from DB for every message (RAG)
    const catalogData = await getBabipassContext();
    const supportConfig = await getSetting('support_config');
    const supportContactStr = supportConfig ?
        `WhatsApp: ${supportConfig.whatsapp || 'Non défini'} | Email: ${supportConfig.email || 'Non défini'}` :
        `Non défini`;

    const systemPrompt = `Tu es l'assistant IA exclusif de "Babipass", la plateforme n°1 de billetterie en ligne en Afrique.
Ton rôle est d'agir comme un excellent "Closer" pour maximiser les ventes.

RÈGLES IMPORTANTES:
1. Réponds de façon brève, convaincante et naturelle, comme un humain sur WhatsApp. Utilise des emojis (🔥, 🎟️, etc.).
2. Quand un client hésite ou pose des questions sur un événement, mets en avant le peu de places restantes pour créer l'urgence (ex: "Il ne reste que X places VIP, dépêche-toi !").
3. Ne propose JAMAIS de réductions imaginaires ou d'informations qui ne sont pas dans tes données.
4. Redirige toujours subtilement vers le lien d'achat de l'événement.
5. Si on te demande "Comment payer ?", explique que le paiement est 100% sécurisé via Wave, Orange Money, MTN MoMo, Moov, ou Carte Bancaire directement sur Babipass.
6. CONTACT SUPPORT : Si l'utilisateur pose une question complexe, a un problème urgent (ex: billet non reçu), demande à parler à un humain, ou si tu ne trouves pas la réponse, redirige-le vers notre équipe de support humain avec ces contacts : ${supportContactStr}.

DONNÉES EN TEMPS RÉEL (BASE DE DONNÉES BABIPASS) :
${catalogData}
`;

    const msgs = [
        { role: 'system', content: systemPrompt },
        ...session,
        { role: 'user', content: text }
    ];

    // Get AI reply
    const aiReply = await askQwen(msgs);

    // Save back to session
    session.push({ role: 'user', content: text });
    session.push({ role: 'assistant', content: aiReply });
    chatSessions.set(phone, session);

    // Send the reply out via WaSender
    await sendWaSenderMessage(phone, aiReply);
}

async function handleWebChatMessage(messages, pageContext) {
    if (!messages || !Array.isArray(messages)) return "Erreur: format de messages invalide.";

    const catalogData = await getBabipassContext();
    const supportConfig = await getSetting('support_config');
    const supportContactStr = supportConfig ?
        `WhatsApp: ${supportConfig.whatsapp || 'Non défini'} | Email: ${supportConfig.email || 'Non défini'}` :
        `Non défini`;

    const systemPrompt = `Tu es l'assistant IA exclusif de "Babipass", la plateforme n°1 de billetterie en ligne en Afrique.
Ton rôle est de répondre aux visiteurs du site web et d'agir comme un excellent "Closer".

CONTEXTE DE LA PAGE ACTUELLE DU VISITEUR:
${pageContext || 'Le visiteur navigue sur le site.'}

RÈGLES IMPORTANTES:
1. Sois courtois, utilise des emojis subtils, et réponds de manière concise (2 à 3 phrases max). L'interface de chat web est petite.
2. Si le visiteur est sur la page d'un événement, mentionne s'il reste peu de places.
3. Ne propose JAMAIS de réductions imaginaires.
4. Les paiements se font par Wave, Orange Money, MTN MoMo, Moov, ou Carte Bancaire directement sur la page.
5. Lorsque tu partages un lien vers un événement, utilise EXACTEMENT le "Lien exact pour cet événement" fourni dans tes données. N'invente jamais de lien et ne modifie pas le format de l'URL !
6. CONTACT SUPPORT : Si l'utilisateur pose une question complexe ou hors contexte, a un problème urgent, demande à parler à un humain, ou si tu n'as pas la réponse, redirige-le vers notre équipe de support humain : ${supportContactStr}.

DONNÉES EN TEMPS RÉEL (BASE DE DONNÉES BABIPASS) :
${catalogData}`;

    const fullMessages = [
        { role: 'system', content: systemPrompt },
        ...messages
    ];

    const aiReply = await askQwen(fullMessages);
    return aiReply;
}

module.exports = {
    handleIncomingMessage,
    handleWebChatMessage
};
