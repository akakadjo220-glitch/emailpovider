require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const crypto = require('crypto');

const ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(null, ALLOWED_UPLOAD_TYPES.includes(file.mimetype)),
});

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Supabase Admin Client (server‑side only) ──────────────────────────────
// Le serveur utilise la clé service_role : les tables sensibles (platform_settings,
// auth_otps, files d'attente) ne sont plus accessibles avec la clé anon.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('🔥 SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont obligatoires.');
    process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

// Réplica en lecture (facultatif) : le catalogue public y lit pour décharger la
// base principale. Achats, scans et paiements restent toujours sur la principale.
const supabaseRead = process.env.SUPABASE_READ_URL
    ? createClient(process.env.SUPABASE_READ_URL, process.env.SUPABASE_READ_KEY || SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    })
    : supabase;

// Monitoring : métriques Prometheus, sonde /ready, Sentry facultatif.
const { createMetrics, registerMonitoringRoutes, initSentry } = require('./services/metrics');
const Sentry = initSentry();
const metrics = createMetrics();

// Simple in‑memory cache for platform settings (5 min TTL)
const settingsCache = {};
const CACHE_TTL = 5 * 60 * 1000;

async function getSetting(key) {
    const cached = settingsCache[key];
    if (cached && Date.now() < cached.expiry) return cached.value;

    const { data, error } = await supabase
        .from('platform_settings')
        .select('value')
        .eq('key', key)
        .maybeSingle();

    if (error || !data) return null;
    settingsCache[key] = { value: data.value, expiry: Date.now() + CACHE_TTL };
    return data.value;
}

// ─── Rate Limiters ─────────────────────────────────────────────────────────
// Limiteurs sensibles : compteurs partagés en base entre toutes les instances.
// Le limiteur global reste en mémoire (garde-fou par instance ; la vraie
// protection anti-DDoS se fait en amont, au niveau du CDN / WAF).
const { createSharedRateLimit } = require('./services/rateLimitStore');
const sharedRateLimit = createSharedRateLimit(rateLimit, supabase);

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // Limit each IP to 1000 requests per 15 mins
    message: { success: false, error: "Trop de requêtes. Veuillez réessayer plus tard." },
    standardHeaders: true,
    legacyHeaders: false,
});

const authLimiter = sharedRateLimit({
    prefix: 'auth',
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // Limit each IP to 50 login/OTP attempts per 15 mins
    message: { success: false, error: "Trop de tentatives d'authentification. Veuillez réessayer dans 15 minutes." },
    standardHeaders: true,
    legacyHeaders: false,
});

// Envoi d'e-mails / WhatsApp : endpoints publics, fortement limités pour
// empêcher leur usage comme relais de spam.
const messagingLimiter = sharedRateLimit({
    prefix: 'messaging',
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { success: false, error: "Trop d'envois. Veuillez réessayer plus tard." },
    standardHeaders: true,
    legacyHeaders: false,
});

// Middleware
// Derrière le reverse proxy (Coolify/Traefik), l'IP client est dans X-Forwarded-For.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.use(helmet());
app.use(metrics.middleware);

// CORS_ORIGINS="https://babipass.com,https://www.babipass.com" pour restreindre.
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
if (corsOrigins.length === 0) {
    console.warn('⚠️  CORS_ORIGINS non défini : toutes les origines sont acceptées.');
}
app.use(cors(corsOrigins.length > 0 ? { origin: corsOrigins } : undefined));

// rawBody est conservé pour la vérification des signatures de webhooks.
app.use(express.json({
    limit: '1mb',
    verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Apply limiters
// Les lectures publiques (catalogue) sont servies par le cache : pas de limite
// par IP, car un opérateur mobile (CGNAT) partage une IP entre des milliers d'abonnés.
app.use('/api/', (req, res, next) => (
    req.method === 'GET' && req.path.startsWith('/public/') ? next() : globalLimiter(req, res, next)
));
app.use('/api/auth/', authLimiter);
app.use(['/api/send-email', '/api/send-whatsapp'], messagingLimiter);

// ─── Health ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'AfriTix Payment & SMTP Relay', version: '2.0.0' });
});

// ─── Dynamic XML Sitemap for Search Engines & AI Bots (SEO Engine) ──────────
let sitemapCache = null;
let sitemapCacheExpiry = 0;

app.get(['/sitemap.xml', '/api/sitemap.xml'], async (req, res) => {
    try {
        const now = Date.now();
        if (sitemapCache && now < sitemapCacheExpiry) {
            res.setHeader('Content-Type', 'application/xml');
            return res.send(sitemapCache);
        }

        // Fetch published events with slugs from Supabase
        const { data: events, error } = await supabase
            .from('events')
            .select('slug, id, created_at, date')
            .eq('status', 'published')
            .order('created_at', { ascending: false });

        if (error) throw error;

        const SITE_URL = 'https://babipass.com';
        const currentDate = new Date().toISOString().split('T')[0];

        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

        // Static high-priority URLs
        const staticPages = [
            { path: '/', priority: '1.0', changefreq: 'daily' },
            { path: '/?category=Concerts', priority: '0.9', changefreq: 'daily' },
            { path: '/?category=Festivals', priority: '0.9', changefreq: 'daily' },
            { path: '/?category=Soirées', priority: '0.9', changefreq: 'daily' },
            { path: '/?category=Sports', priority: '0.8', changefreq: 'daily' },
            { path: '/?category=Conférences', priority: '0.8', changefreq: 'weekly' },
            { path: '/about', priority: '0.6', changefreq: 'monthly' },
            { path: '/faq', priority: '0.7', changefreq: 'weekly' },
            { path: '/terms', priority: '0.5', changefreq: 'monthly' },
            { path: '/privacy', priority: '0.5', changefreq: 'monthly' }
        ];

        for (const p of staticPages) {
            xml += `  <url>\n    <loc>${SITE_URL}${p.path}</loc>\n    <lastmod>${currentDate}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>\n`;
        }

        // Dynamic published events
        if (events && events.length > 0) {
            for (const ev of events) {
                const slugOrId = ev.slug || ev.id;
                const lastmod = (ev.date || ev.created_at || new Date().toISOString()).split('T')[0];
                xml += `  <url>\n    <loc>${SITE_URL}/event/${slugOrId}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.9</priority>\n  </url>\n`;
            }
        }

        xml += `</urlset>`;

        sitemapCache = xml;
        sitemapCacheExpiry = now + (15 * 60 * 1000); // 15 minutes TTL

        res.setHeader('Content-Type', 'application/xml');
        return res.send(xml);
    } catch (sitemapErr) {
        console.error('[SEO Sitemap Error]:', sitemapErr);
        res.status(500).send('Error generating sitemap');
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── WHATSAPP AI BOT WEBHOOK ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
const WhatsAppAIBot = require('./services/WhatsAppAIBot');

app.post('/api/whatsapp/webhook', async (req, res) => {
    try {
        if (!req.body) return res.status(200).send('OK');

        // Evolution API / WaSender payload mapping (heuristic)
        let phone = req.body.from || (req.body.data && req.body.data.message && req.body.data.message.from);
        let text = req.body.text || req.body.body || (req.body.data && req.body.data.message && req.body.data.message.body);

        // Ignore messages sent by the bot itself
        let isFromMe = req.body.fromMe || (req.body.data && req.body.data.message && req.body.data.message.fromMe);

        if (phone && text && !isFromMe) {
            console.log(`[WhatsApp Webhook] Message received from ${phone}: ${text}`);
            // Do not await, reply immediately to webhook to avoid timeout
            WhatsAppAIBot.handleIncomingMessage(phone, text).catch(console.error);
        }

        res.status(200).send('OK');
    } catch (err) {
        console.error('[WhatsApp Webhook Error]', err);
        res.status(500).send('Error');
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── PUBLIC WEB AI CHATBOT ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
    try {
        const { messages, pageContext } = req.body;
        if (!messages) return res.status(400).json({ error: 'Messages are required' });

        const aiReply = await WhatsAppAIBot.handleWebChatMessage(messages, pageContext);
        res.status(200).json({ reply: aiReply });
    } catch (err) {
        console.error('[Web Chat Error]', err);
        res.status(500).json({ error: 'Erreur interne du serveur' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── CHEVERETO MEDIA UPLOAD & VERIFICATION PROXY ──────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/upload', upload.single('source'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Aucun fichier fourni (formats acceptés : JPG, PNG, WEBP, GIF, PDF ; 10 Mo max)' });
        }

        // Récupérer la configuration Chevereto
        const config = await getSetting('chevereto_config');
        if (!config || !config.enabled) {
            return res.status(400).json({ error: 'L\'hébergement Chevereto n\'est pas activé' });
        }

        const { apiUrl, apiKey } = config;
        if (!apiUrl || !apiKey) {
            return res.status(400).json({ error: 'Configuration Chevereto incomplète (URL ou Clé API manquante)' });
        }

        // Préparer le téléversement vers Chevereto
        const formData = new FormData();
        const fileBlob = new Blob([req.file.buffer], { type: req.file.mimetype });
        formData.append('source', fileBlob, req.file.originalname);

        console.log(`[Chevereto Upload] Envoi du fichier ${req.file.originalname} vers ${apiUrl}...`);

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'X-API-Key': apiKey
            },
            body: formData
        });

        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            console.error('[Chevereto Upload] Response is not JSON:', text);
            return res.status(502).json({ error: 'Réponse invalide du serveur Chevereto' });
        }

        if (!response.ok || data.status_code !== 200) {
            console.error('[Chevereto Upload] Error details:', data);
            return res.status(response.status || 500).json({ 
                error: (data.error && data.error.message) || 'Échec du téléversement sur Chevereto',
                details: data
            });
        }

        // Chevereto v1/v1.1 retourne l'URL directe dans data.image.url ou data.image.direct_url
        const imageUrl = data.image?.url || data.image?.direct_url;
        console.log(`[Chevereto Upload] Succès ! Fichier disponible sur : ${imageUrl}`);

        res.status(200).json({ url: imageUrl, details: data });
    } catch (err) {
        console.error('[Chevereto Upload Error]', err);
        res.status(500).json({ error: err.message || 'Erreur interne lors de l\'upload' });
    }
});


// ═══════════════════════════════════════════════════════════════════════════
// ─── EMAIL QUEUE SYSTEM ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// Instead of sending immediately (blocking, rate-limit risk), we:
//  1. Insert the email into the email_queue table
//  2. Return 202 Accepted immediately to the caller
//  3. A background worker picks it up and sends it gracefully
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/send-email
 * Pushes the email to the queue and returns immediately (non-blocking).
 */
app.post('/api/send-email', async (req, res) => {
    try {
        // La configuration SMTP vient uniquement du serveur : un smtpConfig envoyé
        // par le client est ignoré.
        const { to, subject, htmlBody } = req.body;

        if (!to || !subject || !htmlBody) {
            return res.status(400).json({ error: 'Paramètres email manquants (to, subject, htmlBody)' });
        }
        if (typeof to !== 'string' || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) {
            return res.status(400).json({ error: 'Adresse email invalide' });
        }

        await enqueueEmail(to, subject, htmlBody);
        console.log(`[EmailQueue] ✅ Email mis en file d'attente → ${to}`);
        return res.status(202).json({ success: true, queued: true });

    } catch (error) {
        console.error('[EmailQueue] Erreur enqueue:', error);
        return res.status(500).json({ success: false, error: "Impossible d'envoyer l'email." });
    }
});

async function getSmtpConfig() {
    const smtpConfig = await getSetting('smtp_config');
    if (!smtpConfig || !smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
        throw new Error('Configuration SMTP non configurée.');
    }
    return smtpConfig;
}

function createSmtpTransport(smtpConfig) {
    return nodemailer.createTransport({
        host: smtpConfig.host,
        port: smtpConfig.port || 465,
        secure: smtpConfig.port == 465,
        auth: { user: smtpConfig.user, pass: smtpConfig.pass },
        // Comportement historique conservé (certificat non vérifié) ; SMTP_STRICT_TLS=true
        // active la vérification une fois le certificat du serveur SMTP confirmé valide.
        tls: { rejectUnauthorized: process.env.SMTP_STRICT_TLS === 'true' }
    });
}

/**
 * Met un email en file d'attente (le worker l'envoie avec la config SMTP serveur).
 * Si la table n'existe pas, envoi direct.
 */
async function enqueueEmail(to, subject, htmlBody) {
    const { error: insertError } = await supabase
        .from('email_queue')
        .insert([{ to_email: to, subject, html_body: htmlBody }]);

    if (!insertError) return { queued: true };

    console.warn('[EmailQueue] Insert failed, falling back to direct send:', insertError.message);
    const smtpConfig = await getSmtpConfig();
    const info = await createSmtpTransport(smtpConfig).sendMail({
        from: `"${smtpConfig.senderName || 'Babipass'}" <${smtpConfig.user}>`,
        to, subject, html: htmlBody,
    });
    return { queued: false, messageId: info.messageId };
}

app.post('/api/send-whatsapp', async (req, res) => {
    try {
        const { phone, message, mediaUrl } = req.body;

        if (!phone || !message) {
            return res.status(400).json({ error: 'Paramètres WhatsApp manquants (phone, message)' });
        }
        if (!/^\+?\d{8,15}$/.test(String(phone).replace(/\s/g, '')) || String(message).length > 2000) {
            return res.status(400).json({ error: 'Paramètres WhatsApp invalides' });
        }

        // Insert into queue
        const { data: inserted, error: insertError } = await supabase
            .from('whatsapp_queue')
            .insert([{ phone, message, media_url: mediaUrl }])
            .select('id')
            .single();

        if (insertError) {
            console.error('[WhatsAppQueue] DB insert failed:', insertError.message);
            return res.status(500).json({ success: false, error: insertError.message });
        }

        console.log(`[WhatsAppQueue] ✅ Message mis en file d'attente (id: ${inserted?.id}) → ${phone}`);
        return res.status(202).json({ success: true, queued: true, id: inserted?.id });

    } catch (error) {
        console.error('[WhatsAppQueue] Erreur enqueue:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/email-queue/stats — état des files (admin connecté uniquement).
 */
app.get('/api/email-queue/stats', async (req, res) => {
    try {
        const user = await getAuthenticatedUser(req);
        if (!user) return res.status(401).json({ success: false, error: 'Authentification requise.' });
        const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
        if (String(profile?.role || '').toUpperCase() !== 'ADMIN') {
            return res.status(403).json({ success: false, error: 'Accès réservé aux administrateurs.' });
        }
        const { data, error } = await supabase.rpc('queue_stats');
        if (error) throw error;
        return res.status(200).json({ success: true, stats: data });
    } catch (err) {
        console.error('[Queue stats] Error:', err);
        return res.status(500).json({ success: false, error: 'Statistiques indisponibles.' });
    }
});

async function dispatchWhatsApp(job) {
    const { phone, message, media_url: mediaUrl } = job;
    const cleanPhone = phone.replace(/[^0-9]/g, '');

    const waConfig = await getSetting('wa_config');
    if (!waConfig) {
        throw new Error("wa_config manquante ou incomplète sur la plateforme.");
    }

    if (waConfig.provider === 'openwa') {
        if (!waConfig.openwaUrl || !waConfig.openwaSessionId) {
            throw new Error("Configuration Open WA API incomplète.");
        }
        
        let url = `${waConfig.openwaUrl}/api/sessions/${waConfig.openwaSessionId}/messages/send-text`;
        let payload = { chatId: `${cleanPhone}@c.us`, text: message };
        
        if (mediaUrl) {
            url = `${waConfig.openwaUrl}/api/sessions/${waConfig.openwaSessionId}/messages/send-image`;
            payload = {
                chatId: `${cleanPhone}@c.us`,
                url: mediaUrl,
                caption: message,
                filename: 'ticket.png'
            };
        }

        const fetchOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(waConfig.openwaToken ? { 'X-API-Key': waConfig.openwaToken } : {})
            },
            body: JSON.stringify(payload)
        };

        const response = await fetch(url, fetchOptions);
        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            throw new Error(`Open WA Error (${response.status}): ${errBody || response.statusText}`);
        }
        return await response.json();

    } else if (waConfig.provider === 'evolution') {
        if (!waConfig.evolutionUrl || !waConfig.evolutionInstance || !waConfig.evolutionApiKey) {
            throw new Error("Configuration Evolution API incomplète.");
        }

        let url = `${waConfig.evolutionUrl}/message/sendText/${waConfig.evolutionInstance}`;
        let payload = { number: cleanPhone, textMessage: { text: message } };

        if (mediaUrl) {
            url = `${waConfig.evolutionUrl}/message/sendMedia/${waConfig.evolutionInstance}`;
            payload = {
                number: cleanPhone,
                mediaMessage: {
                    mediatype: 'image',
                    caption: message,
                    media: mediaUrl
                }
            };
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': waConfig.evolutionApiKey
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Evolution API Error: ${response.statusText}`);
        }
        return await response.json();

    } else {
        if (!waConfig.token || !waConfig.instanceId) {
            throw new Error("WaSender Token ou Instance ID manquant.");
        }

        let url = `https://wasenderapi.com/api/send-message?instance_id=${waConfig.instanceId}`;
        let payload = { to: cleanPhone, text: message };

        if (mediaUrl) {
            payload = {
                to: cleanPhone,
                text: message,
                caption: message,
                imageUrl: mediaUrl
            };
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${waConfig.token}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            throw new Error(`WaSender Error (${response.status}): ${errBody}`);
        }
        return await response.json();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── OTP (codes de vérification) — entièrement côté serveur ───────────────
// ═══════════════════════════════════════════════════════════════════════════
// Les codes sont générés avec crypto.randomInt, stockés hachés dans auth_otps
// (jamais lisibles côté client), expirent après 10 minutes et sont bloqués
// après OTP_MAX_ATTEMPTS essais. Le « purpose » est inclus dans le hash : un
// code d'inscription ne peut pas servir à réinitialiser un mot de passe.
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_PEPPER = process.env.OTP_PEPPER || SUPABASE_SERVICE_ROLE_KEY;
const OTP_PURPOSES = ['signup', 'reset', 'ambassador', 'tickets'];

function normalizeIdentifier(value) {
    return String(value || '').trim().toLowerCase().replace(/\s/g, '');
}

function hashOtp(purpose, identifier, code) {
    return crypto.createHash('sha256').update(`${purpose}:${identifier}:${code}:${OTP_PEPPER}`).digest('hex');
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeLike(value) {
    return value.replace(/[%_\\]/g, '\\$&');
}

function isDeliverableEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !value.endsWith('.local');
}

async function createOtp(identifier, purpose) {
    const code = crypto.randomInt(100000, 1000000).toString();
    await supabase.from('auth_otps').delete().eq('email', identifier);
    const { error } = await supabase.from('auth_otps').insert([{
        email: identifier,
        otp_code: hashOtp(purpose, identifier, code),
        expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    }]);
    if (error) throw error;
    return code;
}

/**
 * Vérifie un code. consume=true le supprime en cas de succès.
 * Retourne true/false sans jamais révéler la raison exacte au client.
 */
async function verifyOtp(identifier, purpose, code, { consume = false } = {}) {
    if (!identifier || !/^\d{6}$/.test(String(code || ''))) return false;

    const { data: row, error } = await supabase
        .from('auth_otps')
        .select('*')
        .eq('email', identifier)
        .maybeSingle();
    if (error || !row) return false;

    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
        await supabase.from('auth_otps').delete().eq('email', identifier);
        return false;
    }
    const attempts = Number(row.attempts || 0);
    if (attempts >= OTP_MAX_ATTEMPTS) return false;

    const expected = Buffer.from(String(row.otp_code));
    const actual = Buffer.from(hashOtp(purpose, identifier, String(code)));
    const ok = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

    if (!ok) {
        // La colonne attempts est ajoutée par la migration phase 0 ; erreur ignorée si absente.
        await supabase.from('auth_otps').update({ attempts: attempts + 1 }).eq('email', identifier);
        return false;
    }
    if (consume) await supabase.from('auth_otps').delete().eq('email', identifier);
    return true;
}

function renderOtpEmail({ title, subtitle, color, intro, code }) {
    return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:24px;overflow:hidden;border:1px solid #334155;">
          <tr>
            <td style="background:${color};padding:36px 40px;text-align:center;">
              <h1 style="margin:0;color:#fff;font-size:26px;font-weight:800;letter-spacing:-0.5px;">${escapeHtml(title)}</h1>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">${escapeHtml(subtitle)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px;">
              <p style="color:#cbd5e1;font-size:15px;margin:0 0 24px;line-height:1.6;">${intro}</p>
              <div style="background:#0f172a;border:2px solid #f97316;border-radius:16px;padding:28px;text-align:center;margin:0 0 28px;">
                <p style="margin:0 0 8px;color:#64748b;font-size:12px;letter-spacing:2px;text-transform:uppercase;">Code de sécurité</p>
                <p style="margin:0;font-size:48px;font-weight:900;letter-spacing:12px;color:#f97316;font-family:'Courier New',monospace;">${code}</p>
                <p style="margin:12px 0 0;color:#64748b;font-size:12px;">⏱ Ce code expire dans <strong>10 minutes</strong></p>
              </div>
              <div style="background:#7f1d1d22;border:1px solid #dc2626;border-radius:12px;padding:16px 20px;margin:0 0 28px;">
                <p style="margin:0;color:#fca5a5;font-size:13px;line-height:1.5;">
                  <strong>⚠️ Attention :</strong> si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail. Ne communiquez jamais ce code.
                </p>
              </div>
              <p style="color:#64748b;font-size:13px;margin:0;border-top:1px solid #334155;padding-top:24px;">
                Cet email a été envoyé automatiquement par <strong>Babipass</strong>. Ne répondez pas à ce message.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#0f172a;padding:20px 40px;text-align:center;">
              <p style="margin:0;color:#475569;font-size:12px;">© Babipass – Votre billetterie en toute sécurité</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

const OTP_EMAIL_CONTENT = {
    signup: { title: 'Vérification de votre compte', subtitle: 'Babipass', color: 'linear-gradient(135deg,#ea580c 0%,#f59e0b 100%)', intro: () => 'Voici votre code de vérification pour finaliser votre inscription :' },
    reset: { title: 'Réinitialisation du mot de passe', subtitle: 'Babipass', color: 'linear-gradient(135deg,#dc2626 0%,#f97316 100%)', intro: () => 'Une demande de réinitialisation de mot de passe a été effectuée pour votre compte. Saisissez ce code pour choisir un nouveau mot de passe :' },
    ambassador: { title: '🎁 Babipass Ambassadeur', subtitle: "Programme d'Affiliation Officiel", color: 'linear-gradient(135deg,#7c3aed 0%,#4f46e5 100%)', intro: ({ name }) => `Bonjour <strong>${escapeHtml(name || 'Ambassadeur')}</strong>, voici votre code de confirmation pour activer votre compte Ambassadeur :` },
    tickets: { title: 'Récupération de Billets', subtitle: 'Babipass – Vos billets en sécurité', color: 'linear-gradient(135deg,#ea580c 0%,#f59e0b 100%)', intro: ({ count, email }) => `Une demande de récupération de <strong style="color:#f97316;">${escapeHtml(count)} billet(s)</strong> a été effectuée pour l'adresse <strong style="color:#f97316;">${escapeHtml(email)}</strong>. Pour confirmer que c'est bien vous, saisissez ce code :` },
};

const OTP_WA_MESSAGE = {
    signup: code => `🔐 *Babipass - Code de vérification*\n\nVotre code OTP est : *${code}*\n\nCe code expire dans 10 minutes. Ne le partagez jamais.`,
    reset: code => `🔐 *Babipass - Réinitialisation du mot de passe*\n\nVotre code est : *${code}*\n\nCe code expire dans 10 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.`,
    ambassador: code => `🔐 *Babipass Ambassadeur*\n\nVotre code d'activation est : *${code}*\n\nValable 10 minutes.`,
    tickets: (code, { count }) => `🔐 *Code de Sécurité Babipass*\n\nQuelqu'un tente de récupérer vos ${count} billets.\n\nVotre code de vérification est : *${code}*\n\nValable 10 minutes.`,
};

async function sendOtp({ purpose, code, email, phone, context = {} }) {
    const tasks = [];
    if (email && isDeliverableEmail(email)) {
        const content = OTP_EMAIL_CONTENT[purpose];
        tasks.push((async () => {
            const smtpConfig = await getSmtpConfig();
            await createSmtpTransport(smtpConfig).sendMail({
                from: `"Babipass" <${smtpConfig.user}>`,
                to: email,
                subject: `🔐 Votre code Babipass : ${code}`,
                html: renderOtpEmail({ ...content, intro: content.intro({ ...context, email }), code }),
            });
        })());
    }
    if (phone) {
        tasks.push(supabase.from('whatsapp_queue').insert([{ phone, message: OTP_WA_MESSAGE[purpose](code, context) }])
            .then(({ error }) => { if (error) throw error; }));
    }
    const results = await Promise.allSettled(tasks);
    results.filter(r => r.status === 'rejected').forEach(r => console.error(`[OTP ${purpose}] Envoi échoué:`, r.reason?.message || r.reason));
    return results.some(r => r.status === 'fulfilled');
}

/**
 * POST /api/auth/otp/request  { email, purpose: 'signup'|'reset', phone?, name? }
 * Pour « reset », le code n'est envoyé qu'aux coordonnées enregistrées du compte
 * (jamais à un numéro fourni par le demandeur) et la réponse est toujours
 * identique, pour ne pas révéler l'existence d'un compte.
 */
app.post('/api/auth/otp/request', async (req, res) => {
    try {
        const identifier = normalizeIdentifier(req.body.email);
        const purpose = req.body.purpose;
        if (!identifier || !['signup', 'reset'].includes(purpose)) {
            return res.status(400).json({ success: false, error: 'Paramètres invalides.' });
        }

        if (purpose === 'reset') {
            const { data: profile } = await supabase
                .from('profiles')
                .select('email, phone')
                .ilike('email', escapeLike(identifier))
                .maybeSingle();
            if (profile) {
                const code = await createOtp(identifier, purpose);
                await sendOtp({ purpose, code, email: identifier, phone: profile.phone || null });
            }
            return res.status(200).json({ success: true });
        }

        const phone = req.body.phone ? String(req.body.phone).replace(/\s/g, '') : null;
        if (!isDeliverableEmail(identifier) && !phone) {
            return res.status(400).json({ success: false, error: 'Email ou numéro requis.' });
        }
        const code = await createOtp(identifier, purpose);
        const sent = await sendOtp({ purpose, code, email: identifier, phone });
        if (!sent) return res.status(502).json({ success: false, error: "Impossible d'envoyer le code. Réessayez." });
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('[OTP request] Error:', err);
        return res.status(500).json({ success: false, error: 'Erreur lors de l\'envoi du code.' });
    }
});

/**
 * POST /api/auth/otp/verify  { email, code, purpose: 'signup'|'ambassador' }
 * Vérification avant inscription. Les codes « reset » et « tickets » ne se
 * vérifient que dans leur propre endpoint.
 */
app.post('/api/auth/otp/verify', async (req, res) => {
    try {
        const identifier = normalizeIdentifier(req.body.email);
        const purpose = req.body.purpose;
        if (!['signup', 'ambassador'].includes(purpose)) {
            return res.status(400).json({ success: false, error: 'Paramètres invalides.' });
        }
        const ok = await verifyOtp(identifier, purpose, req.body.code, { consume: true });
        if (!ok) return res.status(400).json({ success: false, error: 'Code incorrect ou expiré.' });
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('[OTP verify] Error:', err);
        return res.status(500).json({ success: false, error: 'Erreur de vérification.' });
    }
});

// ─── Password Reset via OTP ───────────────────────────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { otp_code, new_password } = req.body;
        const email = normalizeIdentifier(req.body.email);
        if (!email || !otp_code || !new_password) {
            return res.status(400).json({ success: false, error: "Email, OTP et nouveau mot de passe requis." });
        }
        if (String(new_password).length < 8) {
            return res.status(400).json({ success: false, error: "Le mot de passe doit contenir au moins 8 caractères." });
        }

        // 1. Vérifier l'OTP (expiration + nombre d'essais), puis le consommer
        const ok = await verifyOtp(email, 'reset', otp_code, { consume: true });
        if (!ok) {
            return res.status(400).json({ success: false, error: "Code OTP invalide ou expiré." });
        }

        // 2. Trouver l'utilisateur dans 'profiles'
        const { data: profileData } = await supabase
            .from('profiles')
            .select('id')
            .ilike('email', escapeLike(email))
            .maybeSingle();

        let userId = profileData?.id;
        if (!userId) {
            // Tentative 2: si le profile n'existe pas, essayer via listUsers
            const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers();
            if (usersError) return res.status(500).json({ success: false, error: "Erreur récupération utilisateur." });
            userId = usersData.users.find(u => (u.email || '').toLowerCase() === email)?.id;
        }
        if (!userId) return res.status(404).json({ success: false, error: "Utilisateur introuvable." });

        const { error: updateError } = await supabase.auth.admin.updateUserById(userId, { password: new_password });
        if (updateError) throw updateError;

        return res.status(200).json({ success: true, message: "Mot de passe mis à jour avec succès." });
    } catch (err) {
        console.error('[Reset Password] Server error:', err);
        return res.status(500).json({ success: false, error: "Erreur lors de la mise à jour du mot de passe." });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── TICKET RECOVERY (OTP obligatoire avant de révéler les billets) ───────
// ═══════════════════════════════════════════════════════════════════════════
function ticketRecoveryContact(body) {
    const channel = body.channel === 'wa' ? 'wa' : 'email';
    const contact = normalizeIdentifier(body.contact);
    return { channel, contact };
}

app.post('/api/tickets/recover/request', async (req, res) => {
    try {
        const { channel, contact } = ticketRecoveryContact(req.body);
        if (!contact) return res.status(400).json({ success: false, error: 'Contact requis.' });

        const { data: tickets, error } = await supabase.rpc('find_tickets_by_contact', { p_contact: contact });
        if (error) throw error;
        const count = (tickets || []).length;
        if (count === 0) return res.status(200).json({ success: true, count: 0 });

        const code = await createOtp(contact, 'tickets');
        await sendOtp({
            purpose: 'tickets',
            code,
            email: channel === 'email' ? contact : null,
            phone: channel === 'wa' ? contact : null,
            context: { count },
        });
        return res.status(200).json({ success: true, count });
    } catch (err) {
        console.error('[Ticket recovery request] Error:', err);
        return res.status(500).json({ success: false, error: 'Erreur système lors de la recherche.' });
    }
});

app.post('/api/tickets/recover/verify', async (req, res) => {
    try {
        const { contact } = ticketRecoveryContact(req.body);
        const ok = await verifyOtp(contact, 'tickets', req.body.code, { consume: true });
        if (!ok) return res.status(400).json({ success: false, error: 'Code incorrect ou expiré.' });

        const { data: tickets, error } = await supabase.rpc('find_tickets_by_contact', { p_contact: contact });
        if (error) throw error;
        return res.status(200).json({ success: true, tickets: tickets || [] });
    } catch (err) {
        console.error('[Ticket recovery verify] Error:', err);
        return res.status(500).json({ success: false, error: 'Erreur système lors de la récupération.' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── AMBASSADOR OTP ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/auth/ambassador-otp', async (req, res) => {
    try {
        const { name } = req.body;
        const email = normalizeIdentifier(req.body.email);
        if (!isDeliverableEmail(email)) {
            return res.status(400).json({ success: false, error: 'Email requis.' });
        }

        const code = await createOtp(email, 'ambassador');
        const sent = await sendOtp({ purpose: 'ambassador', code, email, context: { name } });
        if (!sent) return res.status(502).json({ success: false, error: "Impossible d'envoyer le code." });

        console.log('[Ambassador OTP] Code envoyé à ' + email);
        return res.status(200).json({ success: true });

    } catch (err) {
        console.error('[Ambassador OTP] Error:', err);
        return res.status(500).json({ success: false, error: "Erreur lors de l'envoi du code." });
    }
});
// ═══════════════════════════════════════════════════════════════════════════
// ─── PAIEMENTS CÔTÉ SERVEUR ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// Tous les paiements (billets, dons, tranches, commissions) passent par ce module :
// montant calculé en base, paiement vérifié auprès de l'opérateur.
const { registerCheckoutRoutes } = require('./services/checkout');
const { createAdmission } = require('./services/admission');
const admission = createAdmission(supabase, metrics);
const checkout = registerCheckoutRoutes(app, { supabase, getSetting, enqueueEmail, rateLimit: sharedRateLimit, admission, metrics });

// Agents (connexion par jeton signé), scanner et transfert de billet.
const { registerScannerRoutes } = require('./services/scanner');
registerScannerRoutes(app, { supabase, enqueueEmail, rateLimit: sharedRateLimit });

// Catalogue public cacheable (liste, carte, page événement).
const { registerCatalogRoutes } = require('./services/catalog');
registerCatalogRoutes(app, { supabase: supabaseRead });

// /metrics (protégé par METRICS_TOKEN) et /ready (base joignable).
registerMonitoringRoutes(app, {
    supabase,
    metrics,
    getGauges: async () => {
        const [{ data: queues }, { count: pendingOrders }] = await Promise.all([
            supabase.rpc('queue_stats'),
            supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        ]);
        const a = admission.stats();
        return {
            queue_email_pending: queues?.email?.pending ?? 0,
            queue_email_failed: queues?.email?.failed ?? 0,
            queue_whatsapp_pending: queues?.whatsapp?.pending ?? 0,
            queue_oldest_pending_seconds: queues?.oldest_pending_seconds ?? 0,
            orders_pending: pendingOrders ?? 0,
            checkout_active: a.active,
        };
    },
});

// ─── DIDIT API CONFIGURATION ────────────────────────────────────────────────
const DIDIT_API_KEY = process.env.DIDIT_API_KEY;
const DIDIT_WORKFLOW_ID = process.env.DIDIT_WORKFLOW_ID;
const DIDIT_WEBHOOK_SECRET = process.env.DIDIT_WEBHOOK_SECRET;
const DIDIT_CALLBACK_URL = process.env.DIDIT_CALLBACK_URL || 'https://babipass.com/organizer';
if (!DIDIT_API_KEY || !DIDIT_WORKFLOW_ID || !DIDIT_WEBHOOK_SECRET) {
    console.warn('⚠️  DIDIT_API_KEY / DIDIT_WORKFLOW_ID / DIDIT_WEBHOOK_SECRET manquants : vérification d\'identité désactivée.');
}

/** Utilisateur Supabase authentifié à partir du header Authorization: Bearer <jwt>. */
async function getAuthenticatedUser(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return null;
    const { data, error } = await supabase.auth.getUser(token);
    return error ? null : data.user;
}

// ─── DIDIT SESSION CREATION ────────────────────────────────────────────────
// La session est toujours liée à l'utilisateur connecté (jamais à un user_id fourni).
app.post('/api/didit/session', async (req, res) => {
    try {
        if (!DIDIT_API_KEY || !DIDIT_WORKFLOW_ID) {
            return res.status(503).json({ success: false, error: 'Vérification d\'identité indisponible.' });
        }
        const user = await getAuthenticatedUser(req);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Authentification requise.' });
        }
        const user_id = user.id;

        const postData = JSON.stringify({
            workflow_id: DIDIT_WORKFLOW_ID,
            vendor_data: user_id, // Lie la vérification à l'utilisateur connecté
            callback: DIDIT_CALLBACK_URL
        });

        const options = {
            hostname: 'verification.didit.me',
            path: '/v3/session/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': DIDIT_API_KEY,
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const data = await new Promise((resolve, reject) => {
            const reqUrl = require('https').request(options, (resObj) => {
                let responseBody = '';
                resObj.on('data', (chunk) => responseBody += chunk);
                resObj.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseBody);
                        if (resObj.statusCode >= 200 && resObj.statusCode < 300) {
                            resolve(parsed);
                        } else {
                            reject(new Error(`Didit API error ${resObj.statusCode}: ${responseBody}`));
                        }
                    } catch (e) {
                        reject(new Error(`Failed to parse Didit response: ${responseBody}`));
                    }
                });
            });

            reqUrl.on('error', (e) => reject(e));
            reqUrl.write(postData);
            reqUrl.end();
        });

        console.log(`[Didit Session] Created session for user ${user_id}: ${data.session_id}`);
        // Return the secure URL to the React frontend
        return res.status(200).json({ success: true, url: data.url, session_id: data.session_id });
    } catch (err) {
        console.error('[Didit Session] Server error:', err);
        return res.status(500).json({ success: false, error: 'Impossible de créer la session de vérification.' });
    }
});

/**
 * Vérifie la signature HMAC-SHA256 d'un webhook Didit.
 * Accepte X-Signature-V2 (JSON canonique : clés triées, Unicode conservé) ou
 * X-Signature (corps brut), et rejette un X-Timestamp de plus de 5 minutes.
 */
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function safeEqualHex(a, b) {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function isValidDiditSignature(req) {
    if (!DIDIT_WEBHOOK_SECRET || !req.rawBody) return false;

    const timestamp = Number(req.headers['x-timestamp']);
    if (timestamp && Math.abs(Date.now() / 1000 - timestamp) > 300) return false;

    const hmac = data => crypto.createHmac('sha256', DIDIT_WEBHOOK_SECRET).update(data, 'utf8').digest('hex');
    const sigV2 = req.headers['x-signature-v2'];
    if (sigV2 && safeEqualHex(sigV2, hmac(canonicalJson(req.body)))) return true;
    const sigRaw = req.headers['x-signature'];
    if (sigRaw && safeEqualHex(sigRaw, hmac(req.rawBody))) return true;
    return false;
}

// ─── DIDIT WEBHOOK ─────────────────────────────────────────────────────────
app.get('/api/webhooks/didit', (req, res) => {
    res.status(200).send('Didit Webhook is active (Ready for POST)');
});

app.post('/api/webhooks/didit', async (req, res) => {
    try {
        if (!isValidDiditSignature(req)) {
            console.warn('[Didit Webhook] Signature invalide ou absente : requête rejetée.');
            return res.status(401).json({ success: false, error: 'Invalid signature' });
        }

        const body = req.body;
        // Pas de log du payload complet : il contient des données d'identité (PII).
        console.log('[Didit Webhook] Received:', { session_id: body.session_id, status: body.status, webhook_type: body.webhook_type });

        const { decision, vendor_data } = body;

        // Handle vendor_data natively
        let user_id = null;
        if (typeof vendor_data === 'string') {
            user_id = vendor_data;
        } else if (vendor_data && vendor_data.user_id) {
            user_id = vendor_data.user_id;
        }

        if (!user_id) {
            console.warn('[Didit Webhook] No user_id found in vendor_data. Ignoring payload as it is not from an API session.');
            return res.status(200).json({ success: true, message: 'Ignored payload without vendor_data' });
        }

        // Check if user_id is a valid UUID to avoid Postgres type errors during Didit UI tests
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user_id);
        if (!isUUID && user_id) {
            console.log(`[Didit Webhook] Test payload detected (user_id: ${user_id}). Skipping DB update and returning 200 OK.`);
            return res.status(200).json({ success: true, message: 'Test payload accepted' });
        }

        const session_id = body.session_id || decision?.session_id || null;

        // Seuls les changements de statut de session comptent ; les autres événements
        // Didit (data.updated, activity.created, transaction.*, …) ne modifient rien.
        const webhookType = String(body.webhook_type || '').toLowerCase();
        if (webhookType && webhookType !== 'status.updated') {
            return res.status(200).json({ success: true, message: `Event ${webhookType} ignored` });
        }

        // Seule une décision finale change le profil : « Approved » → vérifié,
        // « Declined » → rejeté. Les statuts intermédiaires (Not Started, In Progress,
        // In Review, …) ne doivent jamais rejeter un organisateur.
        const topLevelStatus = String(body.status || decision?.status || '').toLowerCase();
        const FINAL_STATUSES = { approved: 'verified', declined: 'rejected' };
        const status = FINAL_STATUSES[topLevelStatus];
        if (!status) {
            console.log(`[Didit Webhook] Statut intermédiaire « ${topLevelStatus || 'vide'} » pour ${user_id} : aucune modification.`);
            return res.status(200).json({ success: true, message: 'Non-final status ignored' });
        }

        // Standard direct robust update (guaranteed to be correct since we rely on vendor_data)
        const { error } = await supabase.rpc('verify_organizer', {
            p_user_id: user_id,
            p_status: status
        });

        if (error) {
            console.error('[Didit Webhook] RPC Error:', error);
            throw error;
        }

        if (session_id) {
            await supabase.from('profiles').update({ didit_session_id: session_id }).eq('id', user_id);
            console.log(`[Didit Webhook] Saved session_id ${session_id} for user ${user_id}`);
        }

        console.log(`[Didit Webhook] User ${user_id} updated to ${status}`);
        return res.status(200).json({ success: true, status, user_id });
    } catch (err) {
        console.error('[Didit Webhook] Server error:', err);
        return res.status(500).json({ success: false, error: 'Webhook processing failed' });
    }
});

// ─── Start Server ──────────────────────────────────────────────────────────
// Dernier gestionnaire d'erreurs : trace (Sentry si actif) sans exposer le détail au client.
app.use((err, req, res, next) => {
    if (Sentry) Sentry.captureException(err);
    console.error(`[Error] ${req.method} ${req.originalUrl}:`, err);
    if (res.headersSent) return next(err);
    return res.status(err.status || 500).json({ success: false, error: 'Erreur interne du serveur.' });
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── DÉMARRAGE : API ET/OU WORKER ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// PROCESS_ROLE=api    : sert uniquement l'API HTTP (à multiplier derrière le proxy)
// PROCESS_ROLE=worker : files d'attente + tâches planifiées (une ou plusieurs instances)
// PROCESS_ROLE=all    : les deux dans le même processus (défaut, compatible avec l'existant)
const PROCESS_ROLE = (process.env.PROCESS_ROLE || 'all').toLowerCase();
const { createWorker } = require('./services/jobs');

let httpServer = null;
let worker = null;

if (PROCESS_ROLE === 'api' || PROCESS_ROLE === 'all') {
    httpServer = app.listen(PORT, () => {
        console.log(`🚀 Babipass API (${PROCESS_ROLE}) en écoute sur le port ${PORT}`);
    });
    // Connexions keep-alive plus longues que celles du proxy (évite des 502 aléatoires).
    httpServer.keepAliveTimeout = 65 * 1000;
    httpServer.headersTimeout = 66 * 1000;
}

if (PROCESS_ROLE === 'worker' || PROCESS_ROLE === 'all') {
    worker = createWorker({ supabase, getSetting, getSmtpConfig, dispatchWhatsApp, checkout });
    setTimeout(() => worker.start(), 3000);
}

// ─── Arrêt propre (déploiement, mise à l'échelle) ─────────────────────────
// Le serveur cesse d'accepter des connexions, termine les requêtes et les envois
// en cours ; les messages non terminés sont repris par un autre worker.
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Process] ${signal} reçu : arrêt propre...`);
    const force = setTimeout(() => process.exit(1), 30 * 1000);
    force.unref();
    try {
        await Promise.all([
            httpServer ? new Promise(resolve => httpServer.close(resolve)) : null,
            worker ? worker.stop() : null,
        ]);
    } finally {
        process.exit(0);
    }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Process Level Error Handling (Robustness) ─────────────────────────────
// Après une exception non gérée, l'état du processus n'est plus fiable :
// on s'arrête et le superviseur (Docker/Coolify) redémarre un processus sain.
process.on('uncaughtException', (err) => {
    console.error('🔥 [CRITICAL] Uncaught Exception:', err);
    if (!Sentry) process.exit(1);
    Sentry.captureException(err);
    Sentry.flush(2000).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 [CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});