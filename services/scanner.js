// ═══════════════════════════════════════════════════════════════════════════
// ─── AGENTS & SCANNER (contrôle d'accès) ──────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// Les agents n'ont pas de compte Supabase : après vérification du code et du
// PIN (agent_authenticate, verrouillage après 5 échecs), le serveur délivre un
// jeton signé (HMAC-SHA256) valable 12 h. Chaque scan passe par le serveur et
// la fonction SQL scanner_check_in, qui limite l'agent à ses événements et
// valide le billet de façon atomique (pas de double entrée).
// ═══════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');

const AGENT_TOKEN_TTL_S = 12 * 60 * 60;
const MAX_SYNC_BATCH = 500;

function registerScannerRoutes(app, { supabase, enqueueEmail, rateLimit, checkout }) {
    const TOKEN_SECRET = process.env.AGENT_TOKEN_SECRET
        || crypto.createHash('sha256').update(`agent-token:${process.env.SUPABASE_SERVICE_ROLE_KEY}`).digest('hex');

    const agentLoginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 20,
        message: { success: false, error: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.' },
        standardHeaders: true,
        legacyHeaders: false,
    });
    const transferLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 10,
        message: { success: false, error: 'Trop de transferts. Réessayez plus tard.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    // Guichet : un agent peut enchaîner les ventes (file d'attente à l'entrée).
    const posSaleLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 300,
        message: { success: false, error: 'Trop de ventes en peu de temps. Patientez un instant.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    // ─── Jeton agent ─────────────────────────────────────────────────────
    const b64url = buf => Buffer.from(buf).toString('base64url');
    const sign = data => crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('base64url');

    function issueAgentToken(agent) {
        const payload = b64url(JSON.stringify({
            sub: agent.id,
            code: agent.agent_code,
            ev: agent.event_id || null,
            org: agent.organizer_id || null,
            typ: agent.agent_type || null,
            exp: Math.floor(Date.now() / 1000) + AGENT_TOKEN_TTL_S,
        }));
        return `${payload}.${sign(payload)}`;
    }

    function verifyAgentToken(token) {
        const [payload, signature] = String(token || '').split('.');
        if (!payload || !signature) return null;
        const expected = Buffer.from(sign(payload));
        const actual = Buffer.from(signature);
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
        try {
            const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            if (!claims.sub || !claims.exp || claims.exp < Date.now() / 1000) return null;
            return claims;
        } catch {
            return null;
        }
    }

    function requireAgent(req, res, next) {
        const header = req.headers.authorization || '';
        const claims = header.startsWith('Agent ') ? verifyAgentToken(header.slice(6)) : null;
        if (!claims) return res.status(401).json({ success: false, error: 'Session agent expirée. Reconnectez-vous.' });
        req.agent = claims;
        return next();
    }

    // ─── Routes agent ────────────────────────────────────────────────────

    /** POST /api/agent/login { agent_code, pin } */
    app.post('/api/agent/login', agentLoginLimiter, async (req, res) => {
        try {
            const code = String(req.body?.agent_code || '').trim();
            const pin = String(req.body?.pin || '');
            if (!code || !pin || code.length > 64 || pin.length > 32) {
                return res.status(400).json({ success: false, error: 'Identifiant Agent ou Code PIN invalide.' });
            }
            const { data, error } = await supabase.rpc('agent_authenticate', { p_agent_code: code, p_pin: pin });
            if (error) throw error;
            if (!data?.success) return res.status(401).json({ success: false, error: data?.error || 'Identifiant Agent ou Code PIN invalide.' });

            const token = issueAgentToken(data.agent);
            return res.json({
                success: true,
                agent: data.agent,
                token,
                expires_at: Date.now() + AGENT_TOKEN_TTL_S * 1000,
            });
        } catch (err) {
            console.error('[Agent login] Error:', err);
            return res.status(500).json({ success: false, error: 'Erreur serveur lors de la connexion.' });
        }
    });

    // ─── Guichet : vente en espèces (agent POS) ──────────────────────────

    function requirePos(req, res, next) {
        if (req.agent?.typ !== 'POS') return res.status(403).json({ success: false, error: "Ce compte agent n'est pas autorisé à vendre au guichet." });
        return next();
    }

    function sendSqlError(res, error, fallback) {
        const mapped = checkout?.mapSqlError(error);
        if (mapped) return res.status(mapped.status).json({ success: false, error: mapped.error, code: mapped.code });
        console.error('[Guichet]', fallback, error);
        return res.status(500).json({ success: false, error: fallback });
    }

    /** GET /api/agent/pos — événements que l'agent peut vendre, catégories, cash détenu. */
    app.get('/api/agent/pos', requireAgent, requirePos, async (req, res) => {
        const { data, error } = await supabase.rpc('agent_pos_context', { p_agent_id: req.agent.sub });
        if (error) return sendSqlError(res, error, 'Guichet indisponible pour le moment.');
        res.set('Cache-Control', 'no-store');
        return res.json({ success: true, ...data });
    });

    /**
     * POST /api/agent/sales { event_id, items: {ticketTypeId: qty}, buyer: { name?, phone } }
     * Vente en espèces : la base vérifie l'agent, l'événement, le stock et couvre la commission
     * Babipass (solde en ligne ou crédit guichet de l'organisateur) avant d'émettre les billets.
     */
    app.post('/api/agent/sales', posSaleLimiter, requireAgent, requirePos, async (req, res) => {
        const { event_id, items, buyer = {} } = req.body || {};
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const itemList = Object.entries(items && typeof items === 'object' ? items : {})
            .map(([id, qty]) => ({ id, qty: Number(qty) })).filter(i => i.qty > 0);
        const phone = String(buyer.phone || '').replace(/[^\d]/g, '');
        if (!uuid.test(String(event_id || '')) || !itemList.length || itemList.some(i => !uuid.test(i.id) || !Number.isInteger(i.qty) || i.qty > 50)) {
            return res.status(400).json({ success: false, error: 'Vente invalide.' });
        }
        if (!/^\d{8,15}$/.test(phone)) {
            return res.status(400).json({ success: false, error: "Numéro WhatsApp de l'acheteur invalide (indicatif compris)." });
        }
        const { data, error } = await supabase.rpc('agent_cash_sale', {
            p_agent_id: req.agent.sub,
            p_event_id: event_id,
            p_items: itemList,
            p_buyer: { name: String(buyer.name || '').slice(0, 200) || null, phone, contact_method: 'wa' },
        });
        if (error) return sendSqlError(res, error, "La vente n'a pas pu être enregistrée.");
        // Billets envoyés par WhatsApp ; un échec d'envoi n'annule pas la vente (billets visibles via « Retrouver mes billets »).
        checkout?.notifyOrder(data.order_id).catch(err => console.error('[Guichet] Envoi des billets échoué:', err.message));
        return res.status(201).json({ success: true, sale: data });
    });

    /** POST /api/scanner/scan { code } — code = identifiant du billet ou contenu du QR */
    app.post('/api/scanner/scan', requireAgent, async (req, res) => {
        try {
            const code = String(req.body?.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Code manquant.' });
            const { data, error } = await supabase.rpc('scanner_check_in', { p_agent_id: req.agent.sub, p_code: code });
            if (error) throw error;
            if (data?.result === 'agent_disabled') {
                return res.status(401).json({ success: false, error: 'Compte agent désactivé.' });
            }
            return res.json({ success: true, ...data });
        } catch (err) {
            console.error('[Scanner] Scan échoué:', err);
            return res.status(500).json({ success: false, error: 'Erreur lors de la validation.' });
        }
    });

    /** GET /api/scanner/snapshot — statuts des billets de l'agent, pour le mode hors-ligne */
    app.get('/api/scanner/snapshot', requireAgent, async (req, res) => {
        try {
            const { data, error } = await supabase.rpc('scanner_ticket_snapshot', { p_agent_id: req.agent.sub });
            if (error) throw error;
            return res.json({ success: true, tickets: data || [] });
        } catch (err) {
            console.error('[Scanner] Snapshot échoué:', err);
            return res.status(500).json({ success: false, error: 'Impossible de charger les billets.' });
        }
    });

    /**
     * POST /api/scanner/sync { codes: [...] } — scans faits hors-ligne.
     * Chaque code est validé comme un scan normal ; « already_used » signale un
     * billet déjà entré par un autre point de contrôle pendant la coupure.
     */
    app.post('/api/scanner/sync', requireAgent, async (req, res) => {
        try {
            const codes = Array.isArray(req.body?.codes) ? req.body.codes.slice(0, MAX_SYNC_BATCH) : [];
            const results = [];
            for (const raw of codes) {
                const code = String(raw || '').trim();
                if (!code) continue;
                const { data, error } = await supabase.rpc('scanner_check_in', { p_agent_id: req.agent.sub, p_code: code });
                results.push({ code, result: error ? 'error' : data?.result });
                if (data?.result === 'agent_disabled') break;
            }
            return res.json({ success: true, results });
        } catch (err) {
            console.error('[Scanner] Synchronisation échouée:', err);
            return res.status(500).json({ success: false, error: 'Synchronisation impossible.' });
        }
    });

    // ─── Transfert de billet ─────────────────────────────────────────────

    /**
     * POST /api/tickets/transfer { ticket_id, recipient_name, recipient_contact, channel: 'email'|'wa' }
     * Le détenteur du billet (qui en connaît l'identifiant) le cède ; l'ancien
     * billet est invalidé et un nouveau est émis au nom du destinataire.
     */
    app.post('/api/tickets/transfer', transferLimiter, async (req, res) => {
        try {
            const ticketId = String(req.body?.ticket_id || '').trim();
            const name = String(req.body?.recipient_name || '').trim().slice(0, 200);
            const channel = req.body?.channel === 'wa' ? 'wa' : 'email';
            const contact = channel === 'wa'
                ? String(req.body?.recipient_contact || '').replace(/[^\d+]/g, '')
                : String(req.body?.recipient_contact || '').trim().toLowerCase();

            if (!ticketId || !name) return res.status(400).json({ success: false, error: 'Billet et destinataire requis.' });
            if (channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
                return res.status(400).json({ success: false, error: 'Adresse email invalide.' });
            }
            if (channel === 'wa' && !/^\+?\d{8,15}$/.test(contact)) {
                return res.status(400).json({ success: false, error: 'Numéro WhatsApp invalide.' });
            }

            const { data, error } = await supabase.rpc('transfer_ticket', {
                p_ticket_id: ticketId, p_new_name: name, p_new_contact: contact,
            });
            if (error) throw error;
            if (!data?.success) return res.status(400).json({ success: false, error: data?.error || 'Transfert impossible.' });

            const newId = data.new_ticket_id;
            const { data: event } = await supabase.from('events').select('title').eq('id', data.event_id).maybeSingle();
            const eventTitle = event?.title || 'votre événement';
            const qrUrl = `${(process.env.PUBLIC_API_URL || '').replace(/\/$/, '')}/api/public/qr?s=300&d=${encodeURIComponent(newId)}`;
            const message = `🎟️ *NOUVEAU BILLET* 🎟️\n\nBonjour ${name} !\nUn billet vous a été transféré pour *${eventTitle}*.\nRéférence : ${newId}\n\nPrésentez ce QR Code à l'entrée.`;

            try {
                if (channel === 'wa') {
                    const { error: waError } = await supabase.from('whatsapp_queue').insert([{ phone: contact, message, media_url: qrUrl }]);
                    if (waError) throw waError;
                } else {
                    const safe = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
                    await enqueueEmail(contact, `🎟️ Un billet vous a été transféré : ${eventTitle}`,
                        `<p>Bonjour ${safe(name)},</p><p>Un billet vous a été transféré pour <strong>${safe(eventTitle)}</strong>.</p>`
                        + `<p><img src="${qrUrl}" alt="QR Code" width="300" height="300"/></p><p>Référence : ${safe(newId)}</p>`
                        + `<p>Présentez ce QR Code à l'entrée.</p>`);
                }
            } catch (notifyErr) {
                console.error('[Transfer] Notification échouée:', notifyErr.message);
            }

            return res.json({ success: true, new_ticket_id: newId, event_id: data.event_id, ticket_type: data.ticket_type });
        } catch (err) {
            console.error('[Transfer] Error:', err);
            return res.status(500).json({ success: false, error: 'Erreur lors du transfert.' });
        }
    });
}

module.exports = { registerScannerRoutes };
