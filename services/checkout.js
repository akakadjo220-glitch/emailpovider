// ═══════════════════════════════════════════════════════════════════════════
// ─── CHECKOUT CÔTÉ SERVEUR ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// Le navigateur ne décide plus de rien : prix, stock, confirmation de paiement
// et émission des billets sont faits ici et dans les fonctions SQL
// create_order / finalize_order / release_order (migration phase 1a).
//
// Un paiement n'est considéré comme réussi qu'après vérification serveur à
// serveur auprès de l'opérateur (API de statut), jamais sur la seule parole du
// navigateur. Les webhooks ne font que déclencher cette vérification.
// ═══════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');

// Faux opérateur pour les tests de charge : paiement « confirmé » sans argent.
// N'activer QUE sur un environnement de test (ALLOW_TEST_PAYMENTS=true).
const TEST_PAYMENTS_ENABLED = process.env.ALLOW_TEST_PAYMENTS === 'true';
const PROVIDERS = ['paystack', 'pawapay', 'feexpay', 'intouch', 'paydunya', ...(TEST_PAYMENTS_ENABLED ? ['loadtest'] : [])];
const VERIFY_MIN_INTERVAL_MS = 4000;
const ORDER_TTL_MINUTES = 15;

const CHECKOUT_ERRORS = {
    EVENT_NOT_ON_SALE: "Cet événement n'est pas en vente.",
    SALES_CLOSED: 'La billetterie de cet événement est fermée.',
    SOLD_OUT: "Il n'y a plus assez de places pour cette catégorie.",
    INVALID_QUANTITY: 'Quantité invalide.',
    INVALID_ITEMS: 'Panier invalide.',
    INVALID_PAYMENT_MODE: 'Mode de paiement invalide.',
    CAMPAIGN_NOT_ACTIVE: "Cette collecte n'accepte plus de contributions.",
    INVALID_AMOUNT: 'Montant invalide (minimum 100).',
    NOTHING_TO_PAY: 'Aucun paiement en attente pour ce billet.',
    INSTALLMENT_PENDING: 'Un paiement de tranche est déjà en cours pour ce billet. Patientez quelques minutes.',
    NOT_EVENT_ORGANIZER: "Cet événement ne vous appartient pas.",
    INVALID_CATEGORY: 'Catégorie de billet invalide.',
};

function registerCheckoutRoutes(app, { supabase, getSetting, enqueueEmail, rateLimit, admission, metrics }) {
    if (TEST_PAYMENTS_ENABLED) {
        console.warn('🚨🚨 ALLOW_TEST_PAYMENTS=true : le faux opérateur « loadtest » émet des billets SANS paiement. Ne JAMAIS activer en production. 🚨🚨');
    }
    const PUBLIC_API_URL = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
    const CALLBACK_SECRET = process.env.PAYMENT_CALLBACK_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!PUBLIC_API_URL) {
        console.warn('⚠️  PUBLIC_API_URL non défini : les callbacks FeexPay / InTouch / PayDunya ne pourront pas joindre le serveur.');
    }

    // Plafond par IP volontairement large : un opérateur mobile (CGNAT) partage une IP
    // entre des milliers d'acheteurs ; la charge est régulée par la salle d'attente.
    const checkoutLimiter = rateLimit({
        prefix: 'checkout',
        windowMs: 15 * 60 * 1000,
        max: Number(process.env.CHECKOUT_MAX_PER_IP || 300),
        message: { success: false, error: 'Trop de tentatives de commande. Réessayez plus tard.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    // ─── Utilitaires ─────────────────────────────────────────────────────
    function callbackToken(orderId) {
        return crypto.createHmac('sha256', CALLBACK_SECRET).update(`order-callback:${orderId}`).digest('hex').slice(0, 40);
    }

    function safeEqual(a, b) {
        const bufA = Buffer.from(String(a || ''));
        const bufB = Buffer.from(String(b || ''));
        return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
    }

    function callbackUrl(provider, orderId) {
        return `${PUBLIC_API_URL}/api/webhooks/payments/${provider}/${orderId}?t=${callbackToken(orderId)}`;
    }

    function isUuid(value) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
    }

    function mapSqlError(err) {
        const message = String(err?.message || '');
        const code = Object.keys(CHECKOUT_ERRORS).find(k => message.includes(k));
        if (!code) return null;
        const status = code === 'SOLD_OUT' || code === 'INSTALLMENT_PENDING' ? 409 : code === 'NOT_EVENT_ORGANIZER' ? 403 : 400;
        return { status, error: CHECKOUT_ERRORS[code], code };
    }

    /** Utilisateur Supabase authentifié (Authorization: Bearer <jwt>). */
    async function getAuthenticatedUser(req) {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) return null;
        const { data, error } = await supabase.auth.getUser(token);
        return error ? null : data.user;
    }

    function cleanPaymentInput(provider, payment = {}) {
        const phone = String(payment.phone || '').replace(/[^\d+]/g, '');
        // Paystack (popup) et le faux opérateur de test n'ont pas besoin de numéro Mobile Money.
        if (provider !== 'paystack' && provider !== 'loadtest' && !/^\+?\d{8,15}$/.test(phone)) return null;
        return {
            phone,
            network: payment.network ? String(payment.network).slice(0, 64) : undefined,
            countryCode: payment.countryCode ? String(payment.countryCode).slice(0, 4) : undefined,
        };
    }

    /**
     * Lance le paiement d'une commande déjà créée et répond au navigateur.
     * En cas de refus de l'opérateur, la commande est libérée.
     */
    async function startPayment(res, order, provider, payment) {
        let initiated;
        try {
            initiated = await initiate[provider](order, payment);
        } catch (initErr) {
            await supabase.rpc('release_order', { p_order_id: order.id, p_status: 'failed', p_reason: initErr.message });
            return res.status(502).json({ success: false, error: initErr.message });
        }
        const { error: refError } = await supabase.from('orders').update({ provider_ref: initiated.providerRef }).eq('id', order.id);
        if (refError) throw refError;

        return res.status(201).json({
            success: true,
            order: {
                id: order.id,
                token: order.public_token,
                kind: order.kind || 'tickets',
                amount_due: Number(order.amount_due),
                total_amount: Number(order.total_amount),
                currency: order.currency,
                quantity: order.quantity,
                expires_at: order.expires_at,
                provider,
            },
            payment: initiated.client,
        });
    }

    async function fetchJson(url, options = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            const text = await response.text();
            let data = null;
            try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
            return { ok: response.ok, status: response.status, data };
        } finally {
            clearTimeout(timer);
        }
    }

    // ─── PawaPay : code opérateur et numéro au format attendu ────────────────
    // Le site envoie un choix lisible (« WAVE_CI », « ORANGE_CI »…) et le numéro
    // tel que saisi (« 0700000000 »). PawaPay attend son propre code opérateur
    // (pays en 3 lettres, ex. MTN_MOMO_ZMB) et le numéro international sans « + ».
    // On lit les opérateurs réellement activés sur le compte (GET /active-conf,
    // mis en cache 1 h) plutôt que de deviner leurs codes.
    const PAWAPAY_COUNTRIES = {
        CI: { iso3: 'CIV', dial: '225' }, SN: { iso3: 'SEN', dial: '221' }, CM: { iso3: 'CMR', dial: '237' },
        BJ: { iso3: 'BEN', dial: '229' }, TG: { iso3: 'TGO', dial: '228' }, ML: { iso3: 'MLI', dial: '223' },
        BF: { iso3: 'BFA', dial: '226' }, GA: { iso3: 'GAB', dial: '241' }, CD: { iso3: 'COD', dial: '243' },
    };
    let pawapayConf = { at: 0, value: null };

    async function pawapayActiveConf(baseUrl, token) {
        if (pawapayConf.value && Date.now() - pawapayConf.at < 60 * 60 * 1000) return pawapayConf.value;
        const { ok, data } = await fetchJson(`${baseUrl}/active-conf`, { headers: { Authorization: `Bearer ${token}` } });
        if (!ok || !Array.isArray(data?.countries)) return pawapayConf.value; // garder l'ancienne si PawaPay ne répond pas
        pawapayConf = { at: Date.now(), value: data };
        return data;
    }

    // ─── Moyens de paiement réellement utilisables ──────────────────────────
    // Un moyen est proposé seulement s'il est activé dans l'admin (payment_toggles)
    // ET que ses clés sont saisies : jamais de bouton qui mène à une erreur.
    // La vérification des paiements déjà lancés n'en dépend pas.
    const PROVIDER_READY = {
        paystack: c => !!(c?.publicKey && c?.secretKey),
        pawapay: c => !!c?.jwtToken,
        feexpay: c => !!(c?.shopId && c?.token),
        intouch: c => !!(c?.partnerId && c?.login && c?.password),
        paydunya: c => !!(c?.masterKey && c?.privateKey && c?.token),
    };
    let availability = { at: 0, value: null };

    async function availablePayments() {
        if (availability.value && Date.now() - availability.at < 30 * 1000) return availability.value;
        const toggles = (await getSetting('payment_toggles')) || {};
        const configs = {};
        const providers = {};
        await Promise.all(Object.entries(PROVIDER_READY).map(async ([id, ready]) => {
            configs[id] = await getSetting(`${id}_config`);
            providers[id] = toggles[id] !== false && ready(configs[id]);
        }));
        if (TEST_PAYMENTS_ENABLED) providers.loadtest = true;
        const value = {
            providers,
            // Paystack peut aussi encaisser le Mobile Money (Wave, Orange…) dans sa
            // fenêtre ; « mobileMoney: false » dans paystack_config le désactive.
            paystackMobileMoney: providers.paystack && configs.paystack?.mobileMoney !== false,
        };
        availability = { at: Date.now(), value };
        return value;
    }

    async function providerUnavailable(res, provider) {
        const { providers } = await availablePayments();
        if (providers[provider]) return false;
        res.status(400).json({ success: false, code: 'PROVIDER_UNAVAILABLE', error: "Ce moyen de paiement n'est pas disponible pour le moment. Choisissez-en un autre." });
        return true;
    }

    async function resolvePawapayTarget(baseUrl, token, payment) {
        const requested = String(payment.network || 'ORANGE_CI').toUpperCase();
        const [operator, countryCode = 'CI'] = requested.split('_');
        const country = PAWAPAY_COUNTRIES[countryCode] || PAWAPAY_COUNTRIES.CI;

        let digits = String(payment.phone || '').replace(/\D/g, '');
        if (!digits.startsWith(country.dial)) digits = country.dial + digits; // CI : 225 + 10 chiffres (0 inclus)

        let correspondent = requested;
        try {
            const conf = await pawapayActiveConf(baseUrl, token);
            const list = (conf?.countries || []).find(c => c.country === country.iso3)?.correspondents || [];
            const canDeposit = c => !c.operationTypes || c.operationTypes.some(o => o.operationType === 'DEPOSIT');
            const exact = list.find(c => c.correspondent === requested);
            const byOperator = list.find(c => c.correspondent.startsWith(`${operator}_`) && canDeposit(c));
            if (exact || byOperator) correspondent = (exact || byOperator).correspondent;
            else if (list.length) throw new Error(`Ce moyen de paiement n'est pas disponible pour le moment. Choisissez-en un autre.`);
        } catch (err) {
            if (err.message.startsWith('Ce moyen')) throw err;
            console.error('[PawaPay] Configuration active illisible :', err.message);
        }
        return { correspondent, msisdn: digits };
    }

    async function getOrder(orderId) {
        const { data, error } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
        if (error) throw error;
        return data;
    }

    // ─── Initiation du paiement, par opérateur ───────────────────────────
    // Retourne { providerRef, client } ; client = données utiles au navigateur.
    const initiate = {
        async paystack(order) {
            const config = await getSetting('paystack_config');
            if (!config?.publicKey || !config?.secretKey) throw new Error('Configuration Paystack manquante.');
            return {
                providerRef: order.id,
                client: {
                    publicKey: config.publicKey,
                    reference: order.id,
                    amount: Math.round(Number(order.amount_due) * 100),
                    currency: order.currency,
                    email: order.buyer_email || `client_${order.id.slice(0, 8)}@babipass.com`,
                },
            };
        },

        async loadtest(order) {
            if (!TEST_PAYMENTS_ENABLED) throw new Error('Opérateur de test désactivé.');
            return { providerRef: order.id, client: { message: 'Paiement de test (aucun débit).' } };
        },

        async pawapay(order, payment) {
            const config = await getSetting('pawapay_config');
            if (!config?.jwtToken) throw new Error('Configuration PawaPay manquante.');
            const baseUrl = config.baseUrl || 'https://api.pawapay.cloud';
            const { correspondent, msisdn } = await resolvePawapayTarget(baseUrl, config.jwtToken, payment);
            // depositId = id de la commande (UUID exigé par PawaPay) → idempotence naturelle.
            const { ok, data } = await fetchJson(`${baseUrl}/deposits`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.jwtToken}` },
                body: JSON.stringify({
                    depositId: order.id,
                    amount: String(Math.round(Number(order.amount_due))),
                    currency: order.currency,
                    correspondent,
                    payer: { type: 'MSISDN', address: { value: msisdn } },
                    statementDescription: 'Babipass Ticket',
                }),
            });
            if (!ok || !data?.depositId || data.status === 'REJECTED') {
                console.error('[PawaPay] Initiation refusée:', data);
                throw new Error(data?.rejectionReason?.rejectionMessage || data?.message || 'Paiement PawaPay refusé.');
            }
            return { providerRef: order.id, client: { message: 'Veuillez confirmer le paiement sur votre téléphone.' } };
        },

        async feexpay(order, payment) {
            const config = await getSetting('feexpay_config');
            if (!config?.shopId || !config?.token) throw new Error('Configuration FeexPay manquante.');
            const { ok, data } = await fetchJson('https://api.feexpay.me/api/transactions/requesttopay', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
                body: JSON.stringify({
                    shop_id: config.shopId,
                    token: config.token,
                    amount: Math.round(Number(order.amount_due)),
                    phone_number: payment.phone,
                    network: payment.network || 'MTN',
                    currency: order.currency,
                    callback_url: callbackUrl('feexpay', order.id),
                    description: `Babipass commande ${order.id.slice(0, 8)}`,
                    custom_id: order.id,
                }),
            });
            const ref = data?.reference || data?.id;
            if (!ok || !ref) {
                console.error('[FeexPay] Initiation refusée:', data);
                throw new Error(data?.message || 'Paiement FeexPay refusé.');
            }
            return { providerRef: String(ref), client: { message: 'Veuillez valider le paiement sur votre téléphone.' } };
        },

        async intouch(order, payment) {
            const config = await getSetting('intouch_config');
            if (!config?.partnerId || !config?.login || !config?.password) throw new Error('Configuration InTouch manquante.');
            const { ok, data } = await fetchJson('https://api.gfrontinch.com/GEP/rest/api/collectMoney', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', login_api: config.login, password_api: config.password },
                body: JSON.stringify({
                    idFromClient: order.id,
                    additionnalInfos: { recipientEmail: '', recipientFirstName: 'Babipass', recipientLastName: 'Client', destinataire: payment.phone },
                    amount: String(Math.round(Number(order.amount_due))),
                    callback: callbackUrl('intouch', order.id),
                    recipientNumber: payment.phone,
                    serviceCode: payment.network || 'ORANGE_MONEY_CI',
                    partner_id: config.partnerId,
                    login_api: config.login,
                    password_api: config.password,
                }),
            });
            if (!ok || !(data?.status === 'SUCCESSFUL' || data?.status === 'PENDING' || data?.code === '000' || data?.idFromGU)) {
                console.error('[InTouch] Initiation refusée:', data);
                throw new Error(data?.message || "L'API InTouch a rejeté la transaction.");
            }
            return { providerRef: order.id, client: { message: 'Veuillez confirmer le paiement sur votre téléphone.' } };
        },

        async paydunya(order, payment) {
            const config = await getSetting('paydunya_config');
            if (!config?.masterKey || !config?.privateKey || !config?.token) throw new Error('Configuration PayDunya manquante.');
            const headers = {
                'Content-Type': 'application/json',
                'PAYDUNYA-MASTER-KEY': config.masterKey,
                'PAYDUNYA-PRIVATE-KEY': config.privateKey,
                'PAYDUNYA-TOKEN': config.token,
            };
            const invoice = await fetchJson('https://app.paydunya.com/api/v1/checkout-invoice/create', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    invoice: { total_amount: Math.round(Number(order.amount_due)), description: `Babipass commande ${order.id.slice(0, 8)}` },
                    store: { name: 'Babipass' },
                    actions: { callback_url: callbackUrl('paydunya', order.id) },
                    custom_data: { order_id: order.id },
                }),
            });
            if (!invoice.ok || invoice.data?.response_code !== '00' || !invoice.data?.token) {
                console.error('[PayDunya] Facture refusée:', invoice.data);
                throw new Error(invoice.data?.response_text || 'Erreur création facture PayDunya.');
            }
            const softPay = await fetchJson('https://app.paydunya.com/api/v1/softpay/process', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    invoice_token: invoice.data.token,
                    payment_token: payment.network || 'orange-money-senegal',
                    phone_number: payment.phone,
                    country_code: payment.countryCode || 'sn',
                }),
            });
            if (!softPay.ok || !(softPay.data?.response_code === '00' || softPay.data?.success)) {
                console.error('[PayDunya] SoftPay refusé:', softPay.data);
                throw new Error(softPay.data?.response_text || 'Erreur SoftPay PayDunya.');
            }
            return { providerRef: invoice.data.token, client: { message: 'Veuillez confirmer le paiement sur votre téléphone.' } };
        },
    };

    // ─── Vérification du paiement, par opérateur ─────────────────────────
    // Retourne { state: 'paid'|'failed'|'pending', amount?, currency? }.
    const verify = {
        async loadtest(order) {
            if (!TEST_PAYMENTS_ENABLED) return { state: 'pending' };
            return { state: 'paid', amount: Number(order.amount_due), currency: order.currency };
        },

        async paystack(order) {
            const config = await getSetting('paystack_config');
            if (!config?.secretKey) return { state: 'pending' };
            const { ok, data } = await fetchJson(`https://api.paystack.co/transaction/verify/${encodeURIComponent(order.provider_ref || order.id)}`, {
                headers: { Authorization: `Bearer ${config.secretKey}` },
            });
            const tx = data?.data;
            if (!ok || !tx) return { state: 'pending' };
            if (tx.status === 'success') return { state: 'paid', amount: Number(tx.amount) / 100, currency: tx.currency };
            if (['failed', 'reversed'].includes(tx.status)) return { state: 'failed' };
            return { state: 'pending' };
        },

        async pawapay(order) {
            const config = await getSetting('pawapay_config');
            if (!config?.jwtToken) return { state: 'pending' };
            const baseUrl = config.baseUrl || 'https://api.pawapay.cloud';
            const { ok, data } = await fetchJson(`${baseUrl}/deposits/${encodeURIComponent(order.id)}`, {
                headers: { Authorization: `Bearer ${config.jwtToken}` },
            });
            const deposit = Array.isArray(data) ? data[0] : (data?.data || data);
            if (!ok || !deposit) return { state: 'pending' };
            if (deposit.status === 'COMPLETED') return { state: 'paid', amount: Number(deposit.amount), currency: deposit.currency };
            if (['FAILED', 'REJECTED'].includes(deposit.status)) return { state: 'failed' };
            return { state: 'pending' };
        },

        async feexpay(order) {
            const config = await getSetting('feexpay_config');
            if (!config?.token || !order.provider_ref) return { state: 'pending' };
            const { ok, data } = await fetchJson(
                `https://api.feexpay.me/api/transactions/public/single/status/${encodeURIComponent(order.provider_ref)}`,
                { headers: { Authorization: `Bearer ${config.token}` } }
            );
            const status = String(data?.status || '').toUpperCase();
            if (!ok) return { state: 'pending' };
            if (status === 'SUCCESSFUL') return { state: 'paid', amount: Number(data.amount), currency: data.currency || order.currency };
            if (['FAILED', 'CANCELED', 'CANCELLED'].includes(status)) return { state: 'failed' };
            return { state: 'pending' };
        },

        // InTouch : pas d'API de statut intégrée ici ; la confirmation vient du
        // callback authentifié par jeton (voir webhook ci-dessous).
        async intouch() {
            return { state: 'pending' };
        },

        async paydunya(order) {
            const config = await getSetting('paydunya_config');
            if (!config?.masterKey || !order.provider_ref) return { state: 'pending' };
            const { ok, data } = await fetchJson(
                `https://app.paydunya.com/api/v1/checkout-invoice/confirm/${encodeURIComponent(order.provider_ref)}`,
                {
                    headers: {
                        'PAYDUNYA-MASTER-KEY': config.masterKey,
                        'PAYDUNYA-PRIVATE-KEY': config.privateKey,
                        'PAYDUNYA-TOKEN': config.token,
                    },
                }
            );
            if (!ok || data?.response_code !== '00') return { state: 'pending' };
            if (data.status === 'completed') return { state: 'paid', amount: Number(data.invoice?.total_amount), currency: order.currency };
            if (data.status === 'cancelled') return { state: 'failed' };
            return { state: 'pending' };
        },
    };

    // ─── Notifications après émission ────────────────────────────────────
    async function notifyBuyer(order, tickets) {
        try {
            const { data: event } = await supabase
                .from('events').select('title, date, location, city').eq('id', order.event_id).maybeSingle();
            if (!event || order.payment_mode !== 'full') return;
            const eventDate = new Date(event.date).toLocaleString('fr-FR', { timeZone: 'Africa/Abidjan' });
            const typeNames = Object.fromEntries((order.items || []).map(i => [i.ticket_type_id, i.name]));

            if (order.contact_method === 'email' && order.buyer_email) {
                const templates = await getSetting('email_templates');
                const template = Array.isArray(templates)
                    ? templates.find(t => t.id === 'ticket_purchase' && t.is_active !== false)
                    : null;
                for (const ticket of tickets) {
                    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(ticket.qr_code)}`;
                    const vars = {
                        eventTitle: event.title,
                        ticketType: typeNames[ticket.ticket_type] || 'Standard',
                        eventDate,
                        qrUrl,
                        jwsData: ticket.qr_code,
                    };
                    let subject = template?.defaultSubject || template?.subject || `🎟️ Votre billet pour ${event.title}`;
                    let html = template?.defaultHtml || template?.body
                        || `<p>Merci pour votre achat !</p><p><strong>${'{{eventTitle}}'}</strong> — ${'{{eventDate}}'}</p><p><img src="${'{{qrUrl}}'}" alt="QR"/></p><p>Billet : ${'{{jwsData}}'}</p>`;
                    for (const [key, value] of Object.entries(vars)) {
                        const safe = String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
                        html = html.split(`{{${key}}}`).join(key === 'qrUrl' ? value : safe);
                        subject = subject.split(`{{${key}}}`).join(String(value));
                    }
                    await enqueueEmail(order.buyer_email, subject, html);
                }
            }

            if (order.contact_method === 'wa' && order.buyer_phone) {
                const rows = tickets.map(ticket => ({
                    phone: order.buyer_phone,
                    message: `🎉 Félicitations pour votre achat !\n\nVoici votre billet pour l'événement *${event.title}*.\nDate: ${eventDate}\nLieu: ${event.location || ''}, ${event.city || ''}\nRéférence: ${ticket.id}\n\nPrésentez ce QR Code à l'entrée. À très vite !`,
                    media_url: `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(ticket.qr_code)}`,
                }));
                const { error } = await supabase.from('whatsapp_queue').insert(rows);
                if (error) throw error;
            }
        } catch (err) {
            console.error(`[Checkout] Notification échouée pour la commande ${order.id}:`, err.message);
        }
    }

    async function loadTickets(order) {
        if (!order.ticket_ids?.length) return [];
        const { data, error } = await supabase
            .from('tickets')
            .select('id, qr_code, ticket_type, status, guest_name')
            .in('id', order.ticket_ids);
        if (error) throw error;
        return data || [];
    }

    async function finalize(order, result, source) {
        const { data, error } = await supabase.rpc('finalize_order', {
            p_order_id: order.id,
            p_provider_ref: order.provider_ref,
            p_paid_amount: result.amount,
            p_paid_currency: result.currency || order.currency,
        });
        if (error) throw error;
        console.log(`[Checkout] Commande ${order.kind || 'tickets'} ${order.id} → ${data.status} (via ${source})`);
        if (!data.already) metrics?.inc('orders_finalized_total', { kind: order.kind || 'tickets', status: data.status });
        if (data.status === 'paid' && !data.already && (order.kind || 'tickets') === 'tickets') {
            const fresh = await getOrder(order.id);
            notifyBuyer(fresh, await loadTickets(fresh));
        }
        return data.status;
    }

    /**
     * Vérifie une commande auprès de l'opérateur et la fait avancer.
     * force=true ignore l'intervalle minimal entre deux vérifications.
     */
    async function processOrder(order, { source = 'poll', force = false, trustedResult = null } = {}) {
        // Une commande expirée reste vérifiable 48 h : un client peut valider le
        // paiement sur son téléphone après le délai ; finalize_order re-réserve
        // alors les places ou marque la commande « refund_required ».
        const lateWindowMs = 48 * 60 * 60 * 1000;
        const isLateCandidate = order.status === 'expired'
            && Date.now() - new Date(order.expires_at).getTime() < lateWindowMs;
        if (order.status !== 'pending' && !isLateCandidate) {
            return order.status;
        }

        const lastChecked = order.last_checked_at ? new Date(order.last_checked_at).getTime() : 0;
        if (!force && !trustedResult && Date.now() - lastChecked < VERIFY_MIN_INTERVAL_MS) {
            return order.status;
        }
        await supabase.from('orders').update({ last_checked_at: new Date().toISOString() }).eq('id', order.id);

        let result = trustedResult;
        if (!result) {
            try {
                result = await verify[order.provider](order);
            } catch (err) {
                console.error(`[Checkout] Vérification ${order.provider} échouée pour ${order.id}:`, err.message);
                result = { state: 'pending' };
            }
        }

        if (result.state === 'paid') return finalize(order, result, source);
        if (order.status !== 'pending') return order.status;
        if (result.state === 'failed') {
            await supabase.rpc('release_order', { p_order_id: order.id, p_status: 'failed', p_reason: 'Paiement refusé par l\'opérateur' });
            return 'failed';
        }
        if (new Date(order.expires_at).getTime() < Date.now()) {
            await supabase.rpc('release_order', { p_order_id: order.id, p_status: 'expired', p_reason: 'Délai de paiement dépassé' });
            return 'expired';
        }
        return 'pending';
    }

    // ─── Routes ──────────────────────────────────────────────────────────

    /**
     * POST /api/checkout/orders
     * { event_id, items: {ticketTypeId: qty}, payment_mode, provider,
     *   buyer: {name, email?, phone?, contact_method}, buyer_location?, referral_code?,
     *   payment: {phone?, network?, countryCode?} }
     */
    /**
     * GET /api/public/payment-methods — moyens de paiement utilisables (activés
     * ET configurés). Le site n'affiche que ceux-là, pour tous les parcours.
     */
    app.get('/api/public/payment-methods', async (req, res) => {
        try {
            const { providers, paystackMobileMoney } = await availablePayments();
            res.set('Cache-Control', 'public, max-age=30, s-maxage=30');
            return res.json({ success: true, providers, paystack_mobile_money: paystackMobileMoney });
        } catch (err) {
            console.error('[Checkout] Moyens de paiement illisibles:', err.message);
            return res.status(500).json({ success: false, error: 'Indisponible.' });
        }
    });

    app.post('/api/checkout/orders', checkoutLimiter, async (req, res) => {
        try {
            const { event_id, items, payment_mode = 'full', provider, buyer = {}, buyer_location = null, referral_code = null, payment = {} } = req.body || {};

            if (!isUuid(event_id) || !PROVIDERS.includes(provider) || !items || typeof items !== 'object') {
                return res.status(400).json({ success: false, error: 'Commande invalide.' });
            }
            if (await providerUnavailable(res, provider)) return;
            const itemList = Object.entries(items)
                .map(([id, qty]) => ({ id, qty: Number(qty) }))
                .filter(i => i.qty > 0);
            if (itemList.length === 0 || itemList.some(i => !isUuid(i.id) || !Number.isInteger(i.qty))) {
                return res.status(400).json({ success: false, error: 'Panier invalide.' });
            }

            const contactMethod = buyer.contact_method === 'wa' ? 'wa' : 'email';
            const email = contactMethod === 'email' ? String(buyer.email || '').trim().toLowerCase() : null;
            const phone = contactMethod === 'wa' ? String(buyer.phone || '').replace(/[^\d+]/g, '') : null;
            if (contactMethod === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) {
                return res.status(400).json({ success: false, error: 'Adresse email invalide.' });
            }
            if (contactMethod === 'wa' && !/^\+?\d{8,15}$/.test(phone || '')) {
                return res.status(400).json({ success: false, error: 'Numéro WhatsApp invalide.' });
            }

            const paymentInput = cleanPaymentInput(provider, payment);
            if (!paymentInput) {
                return res.status(400).json({ success: false, error: 'Numéro Mobile Money invalide.' });
            }

            // Salle d'attente : au-delà du débit autorisé pour cet événement, 429 + Retry-After.
            const createAndStart = async () => {
                const { data: order, error } = await supabase.rpc('create_order', {
                    p_event_id: event_id,
                    p_items: itemList,
                    p_payment_mode: payment_mode,
                    p_provider: provider,
                    p_buyer: { name: String(buyer.name || '').slice(0, 200) || null, email, phone, contact_method: contactMethod },
                    p_referral_code: referral_code ? String(referral_code).slice(0, 64) : null,
                    p_buyer_location: buyer_location && typeof buyer_location === 'object' ? buyer_location : null,
                    p_ttl_minutes: ORDER_TTL_MINUTES,
                });
                if (error) {
                    const mapped = mapSqlError(error);
                    metrics?.inc('checkout_rejected_total', { code: mapped?.code || 'error' });
                    if (mapped) return res.status(mapped.status).json({ success: false, error: mapped.error, code: mapped.code });
                    throw error;
                }
                metrics?.inc('orders_created_total', { kind: 'tickets', provider });

                // Si l'opérateur refuse, startPayment libère immédiatement les places.
                return startPayment(res, order, provider, paymentInput);
            };
            return await (admission ? admission.guard(res, event_id, createAndStart) : createAndStart());
        } catch (err) {
            console.error('[Checkout] Création de commande échouée:', err);
            return res.status(500).json({ success: false, error: 'Impossible de créer la commande.' });
        }
    });

    function buyerFrom(body = {}) {
        const contactMethod = body.contact_method === 'wa' ? 'wa' : 'email';
        const email = String(body.email || '').trim().toLowerCase();
        return {
            name: String(body.name || '').slice(0, 200) || null,
            email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
            phone: body.phone ? String(body.phone).replace(/[^\d+]/g, '').slice(0, 20) : null,
            contact_method: contactMethod,
        };
    }

    async function createAndPay(res, rpcName, rpcArgs, provider, payment) {
        if (!PROVIDERS.includes(provider)) return res.status(400).json({ success: false, error: 'Moyen de paiement invalide.' });
        if (await providerUnavailable(res, provider)) return;
        const paymentInput = cleanPaymentInput(provider, payment);
        if (!paymentInput) return res.status(400).json({ success: false, error: 'Numéro Mobile Money invalide.' });

        const { data: order, error } = await supabase.rpc(rpcName, { ...rpcArgs, p_provider: provider });
        if (error) {
            const mapped = mapSqlError(error);
            if (mapped) return res.status(mapped.status).json({ success: false, error: mapped.error, code: mapped.code });
            throw error;
        }
        return startPayment(res, order, provider, paymentInput);
    }

    /**
     * POST /api/checkout/donations
     * { campaign_id, amount, provider, buyer: {name, email?}, payment: {phone?, network?} }
     * La contribution n'est enregistrée qu'après vérification du paiement.
     */
    app.post('/api/checkout/donations', checkoutLimiter, async (req, res) => {
        try {
            const { campaign_id, amount, provider, buyer, payment } = req.body || {};
            if (!isUuid(campaign_id)) return res.status(400).json({ success: false, error: 'Collecte invalide.' });
            return await createAndPay(res, 'create_donation_order', {
                p_campaign_id: campaign_id,
                p_amount: Number(amount),
                p_buyer: buyerFrom(buyer),
            }, provider, payment);
        } catch (err) {
            console.error('[Checkout] Don échoué:', err);
            return res.status(500).json({ success: false, error: 'Impossible de créer la contribution.' });
        }
    });

    /**
     * POST /api/checkout/installments { ticket_id, provider, payment }
     * Règle la tranche suivante d'un achat en paiement fractionné. Le montant est
     * calculé par la base ; à la dernière tranche, les billets deviennent valables.
     */
    app.post('/api/checkout/installments', checkoutLimiter, async (req, res) => {
        try {
            const { ticket_id, provider, payment } = req.body || {};
            if (!ticket_id || String(ticket_id).length > 64) return res.status(400).json({ success: false, error: 'Billet invalide.' });
            return await createAndPay(res, 'create_installment_order', {
                p_ticket_id: String(ticket_id),
                p_buyer: {},
            }, provider, payment);
        } catch (err) {
            console.error('[Checkout] Tranche échouée:', err);
            return res.status(500).json({ success: false, error: 'Impossible de créer le paiement de la tranche.' });
        }
    });

    // ─── Billets physiques (organisateur connecté) ───────────────────────

    function physicalArgs(user, body = {}) {
        return {
            p_organizer_id: user.id,
            p_event_id: body.event_id,
            p_category_id: String(body.category_id || '').slice(0, 64),
            p_quantity: Number(body.quantity),
        };
    }

    async function requireOrganizer(req, res) {
        const user = await getAuthenticatedUser(req);
        if (!user) {
            res.status(401).json({ success: false, error: 'Authentification requise.' });
            return null;
        }
        if (!isUuid(req.body?.event_id)) {
            res.status(400).json({ success: false, error: 'Événement invalide.' });
            return null;
        }
        return user;
    }

    /** POST /api/physical/quote { event_id, category_id, quantity } — commission calculée en base */
    app.post('/api/physical/quote', async (req, res) => {
        try {
            const user = await requireOrganizer(req, res);
            if (!user) return;
            const { data, error } = await supabase.rpc('physical_batch_quote', physicalArgs(user, req.body));
            if (error) {
                const mapped = mapSqlError(error);
                if (mapped) return res.status(mapped.status).json({ success: false, error: mapped.error, code: mapped.code });
                throw error;
            }
            return res.json({ success: true, quote: data });
        } catch (err) {
            console.error('[Physical] Devis échoué:', err);
            return res.status(500).json({ success: false, error: 'Impossible de calculer la commission.' });
        }
    });

    /**
     * POST /api/physical/batches { event_id, category_id, quantity }
     * Génère le lot si la commission est réglée (gratuit, jeton pré-payé ou wallet).
     * Sinon : { status: 'payment_required', quote } → payer via /api/physical/commission-orders.
     */
    app.post('/api/physical/batches', checkoutLimiter, async (req, res) => {
        try {
            const user = await requireOrganizer(req, res);
            if (!user) return;
            const { data, error } = await supabase.rpc('create_physical_batch', physicalArgs(user, req.body));
            if (error) {
                const mapped = mapSqlError(error);
                if (mapped) return res.status(mapped.status).json({ success: false, error: mapped.error, code: mapped.code });
                throw error;
            }
            return res.json({ success: true, ...data });
        } catch (err) {
            console.error('[Physical] Lot échoué:', err);
            return res.status(500).json({ success: false, error: 'Impossible de générer les billets.' });
        }
    });

    /** POST /api/physical/commission-orders { event_id, category_id, quantity, provider, payment } */
    app.post('/api/physical/commission-orders', checkoutLimiter, async (req, res) => {
        try {
            const user = await requireOrganizer(req, res);
            if (!user) return;
            return await createAndPay(res, 'create_physical_commission_order', {
                ...physicalArgs(user, req.body),
                p_buyer: { name: user.user_metadata?.name || null, email: user.email || null, contact_method: 'email' },
            }, req.body.provider, req.body.payment);
        } catch (err) {
            console.error('[Physical] Commande de commission échouée:', err);
            return res.status(500).json({ success: false, error: 'Impossible de lancer le paiement de la commission.' });
        }
    });

    /**
     * GET /api/checkout/orders/:id?token=…
     * Statut de la commande ; déclenche une vérification auprès de l'opérateur si
     * elle est en attente. Les billets ne sont renvoyés qu'une fois payée.
     */
    app.get('/api/checkout/orders/:id', async (req, res) => {
        try {
            if (!isUuid(req.params.id)) return res.status(404).json({ success: false, error: 'Commande introuvable.' });
            let order = await getOrder(req.params.id);
            if (!order || !safeEqual(order.public_token, req.query.token)) {
                return res.status(404).json({ success: false, error: 'Commande introuvable.' });
            }

            if (order.status === 'pending' || order.status === 'expired') {
                await processOrder(order, { source: 'poll' });
                order = await getOrder(order.id);
            }

            const kind = order.kind || 'tickets';
            const body = {
                success: true,
                status: order.status,
                kind,
                amount_due: Number(order.amount_due),
                payment_mode: order.payment_mode,
                expires_at: order.expires_at,
            };
            if (order.status === 'paid' && kind === 'tickets') body.tickets = await loadTickets(order);
            if (order.status === 'paid' && kind === 'installment' && order.parent_order_id) {
                // Billets de l'achat d'origine : « valid » dès que la totalité est réglée.
                const parent = await getOrder(order.parent_order_id);
                body.tickets = await loadTickets(parent);
                body.fully_paid = Number(parent.amount_paid) >= Number(parent.total_amount);
                body.amount_paid = Number(parent.amount_paid);
                body.total_amount = Number(parent.total_amount);
            }
            return res.json(body);
        } catch (err) {
            console.error('[Checkout] Lecture de commande échouée:', err);
            return res.status(500).json({ success: false, error: 'Erreur de vérification du paiement.' });
        }
    });

    /**
     * POST /api/webhooks/payments/:provider/:orderId?t=…
     * Callback opérateur (FeexPay, InTouch, PayDunya). L'URL contient un jeton
     * HMAC propre à la commande ; on revérifie ensuite auprès de l'opérateur.
     */
    app.post('/api/webhooks/payments/:provider/:orderId', async (req, res) => {
        try {
            const { provider, orderId } = req.params;
            if (!PROVIDERS.includes(provider) || !isUuid(orderId) || !safeEqual(req.query.t, callbackToken(orderId))) {
                return res.status(401).json({ success: false });
            }
            const order = await getOrder(orderId);
            if (!order || order.provider !== provider) return res.status(404).json({ success: false });

            let trustedResult = null;
            if (provider === 'intouch') {
                // Pas d'API de statut : on s'appuie sur le callback authentifié par jeton,
                // en contrôlant que le montant correspond.
                const status = String(req.body?.status || '').toUpperCase();
                if (status === 'SUCCESSFUL' || status === 'SUCCESS') {
                    trustedResult = { state: 'paid', amount: Number(req.body?.amount ?? order.amount_due), currency: order.currency };
                } else if (['FAILED', 'FAILURE', 'CANCELLED'].includes(status)) {
                    trustedResult = { state: 'failed' };
                }
            }

            const status = await processOrder(order, { source: `webhook:${provider}`, force: true, trustedResult });
            return res.json({ success: true, status });
        } catch (err) {
            console.error('[Checkout] Webhook paiement échoué:', err);
            return res.status(500).json({ success: false });
        }
    });

    /**
     * POST /api/webhooks/paystack — signature x-paystack-signature (HMAC-SHA512).
     */
    app.post('/api/webhooks/paystack', async (req, res) => {
        try {
            const config = await getSetting('paystack_config');
            const signature = req.headers['x-paystack-signature'];
            if (!config?.secretKey || !req.rawBody || !signature) return res.status(401).end();
            const expected = crypto.createHmac('sha512', config.secretKey).update(req.rawBody).digest('hex');
            if (!safeEqual(signature, expected)) return res.status(401).end();

            const reference = req.body?.data?.reference;
            if (req.body?.event === 'charge.success' && isUuid(reference)) {
                const order = await getOrder(reference);
                if (order && order.provider === 'paystack') {
                    await processOrder(order, { source: 'webhook:paystack', force: true });
                }
            }
            return res.status(200).end();
        } catch (err) {
            console.error('[Checkout] Webhook Paystack échoué:', err);
            return res.status(500).end();
        }
    });

    // ─── Réconciliation périodique ───────────────────────────────────────
    // Vérifie les commandes en attente (au cas où un webhook serait perdu) et
    // libère celles dont le délai est dépassé. Sûr en multi-instances : les
    // fonctions SQL verrouillent la commande (FOR UPDATE).
    async function reconcile() {
        try {
            const staleBefore = new Date(Date.now() - 30 * 1000).toISOString();
            const { data: pending, error } = await supabase
                .from('orders')
                .select('*')
                .eq('status', 'pending')
                .or(`last_checked_at.is.null,last_checked_at.lt.${staleBefore}`)
                .order('created_at', { ascending: true })
                .limit(50);
            if (error) {
                if (error.code !== '42P01') console.error('[Checkout] Réconciliation:', error.message);
                return;
            }
            for (const order of pending || []) {
                await processOrder(order, { source: 'reconcile', force: true });
            }

            // Paiements tardifs : commandes expirées depuis moins de 2 h, revérifiées toutes les 2 min.
            const lateSince = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
            const lateCheckedBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
            const { data: expired } = await supabase
                .from('orders')
                .select('*')
                .eq('status', 'expired')
                .gt('expires_at', lateSince)
                .or(`last_checked_at.is.null,last_checked_at.lt.${lateCheckedBefore}`)
                .limit(50);
            for (const order of expired || []) {
                await processOrder(order, { source: 'reconcile-late', force: true });
            }
        } catch (err) {
            console.error('[Checkout] Réconciliation échouée:', err.message);
        }
    }

    return { reconcile };
}

module.exports = { registerCheckoutRoutes };
