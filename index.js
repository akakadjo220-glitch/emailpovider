require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Supabase Admin Client (server‑side only) ──────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://supabasekong-l4cw40oks4kso84ko44ogkkw.188.241.58.227.sslip.io';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTc3MTUwMzM2MCwiZXhwIjo0OTI3MTc2OTYwLCJyb2xlIjoiYW5vbiJ9.s0AAg10GbSOn_-7RfJpnJcHNJLCEb6yzkHsKxUhz-tI';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

// Middleware
app.use(cors());
app.use(express.json());

// ─── Health ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'AfriTix Payment & SMTP Relay', version: '2.0.0' });
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── EMAIL RELAY (existing) ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/send-email', async (req, res) => {
    try {
        const { smtpConfig, to, subject, htmlBody } = req.body;

        if (!smtpConfig || !smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
            return res.status(400).json({ error: 'Configuration SMTP incomplète' });
        }
        if (!to || !subject || !htmlBody) {
            return res.status(400).json({ error: 'Paramètres email manquants (to, subject, htmlBody)' });
        }

        const transporter = nodemailer.createTransport({
            host: smtpConfig.host,
            port: smtpConfig.port || 465,
            secure: smtpConfig.port == 465,
            auth: { user: smtpConfig.user, pass: smtpConfig.pass },
            tls: { rejectUnauthorized: false }
        });

        const info = await transporter.sendMail({
            from: `"${smtpConfig.senderName || 'AfriTix Access'}" <${smtpConfig.user}>`,
            to, subject, html: htmlBody,
        });

        console.log('Email envoyé: %s', info.messageId);
        return res.status(200).json({ success: true, messageId: info.messageId });
    } catch (error) {
        console.error('Erreur email:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── PAYMENT PROXY ENDPOINTS (Keys stay server‑side) ─────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// ──── 1. PawaPay ─────────────────────────────────────────────────────────
app.post('/api/pay/pawapay', async (req, res) => {
    try {
        const { phone, amount, network } = req.body;
        if (!phone || !amount) return res.status(400).json({ success: false, error: 'Paramètres manquants (phone, amount)' });

        const config = await getSetting('pawapay_config');
        if (!config || !config.jwtToken) {
            return res.status(500).json({ success: false, error: "Configuration PawaPay manquante. Contactez l'administrateur." });
        }

        const depositId = `dep_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        // Format des correspondants PawaPay : https://docs.pawapay.cloud/#tag/deposits
        const payload = {
            depositId: depositId,
            amount: String(amount),
            currency: 'XOF',
            correspondent: network || 'ORANGE_CI',
            payer: {
                type: 'MSISDN',
                address: { value: phone.replace(/\s/g, '') }
            },
            statementDescription: 'AfriTix Ticket'
        };

        console.log(`[PawaPay] Initiating deposit ${depositId} for ${amount} XOF via ${network}`);

        const response = await fetch('https://api.pawapay.cloud/deposits', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.jwtToken}`
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (response.ok && data.depositId) {
            return res.json({
                success: true,
                transactionId: data.depositId,
                status: data.status || 'ACCEPTED',
                message: 'Paiement initié. Veuillez confirmer sur votre téléphone.'
            });
        } else {
            console.error('[PawaPay] Error response:', data);
            return res.json({
                success: false,
                error: data.message || data.errorMessage || 'Erreur PawaPay',
                details: data
            });
        }
    } catch (err) {
        console.error('[PawaPay] Server error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ──── 2. FeexPay ─────────────────────────────────────────────────────────
app.post('/api/pay/feexpay', async (req, res) => {
    try {
        const { phone, amount, network } = req.body;
        if (!phone || !amount) return res.status(400).json({ success: false, error: 'Paramètres manquants (phone, amount)' });

        const config = await getSetting('feexpay_config');
        if (!config || !config.shopId || !config.token) {
            return res.status(500).json({ success: false, error: "Configuration FeexPay manquante. Contactez l'administrateur." });
        }

        // FeexPay API docs: https://docs.feexpay.me
        const payload = {
            shop_id: config.shopId,
            token: config.token,
            amount: amount,
            phone_number: phone.replace(/\s/g, ''),
            network: network || 'MTN',
            currency: 'XOF',
            callback_url: `${SUPABASE_URL}/rest/v1/rpc/noop`,
            description: 'AfriTix Ticket Purchase'
        };

        console.log(`[FeexPay] Initiating ${network} payment for ${amount} XOF to ${phone}`);

        const response = await fetch('https://api.feexpay.me/api/transactions/requesttopay', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.token}`
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (response.ok && (data.status === 'success' || data.status === 'pending' || data.id)) {
            return res.json({
                success: true,
                transactionId: data.id || data.reference || `FP-${Date.now()}`,
                status: data.status || 'pending',
                message: 'Veuillez valider le paiement sur votre téléphone (USSD envoyé).'
            });
        } else {
            console.error('[FeexPay] Error response:', data);
            return res.json({
                success: false,
                error: data.message || data.error || 'Erreur FeexPay',
                details: data
            });
        }
    } catch (err) {
        console.error('[FeexPay] Server error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ──── 3. InTouch / TouchPay ──────────────────────────────────────────────
app.post('/api/pay/intouch', async (req, res) => {
    try {
        const { phone, amount, provider } = req.body;
        if (!phone || !amount) return res.status(400).json({ success: false, error: 'Paramètres manquants (phone, amount)' });

        const config = await getSetting('intouch_config');
        if (!config || !config.partnerId || !config.login || !config.password) {
            return res.status(500).json({ success: false, error: "Configuration InTouch manquante. Contactez l'administrateur." });
        }

        // InTouch / GTP API
        const payload = {
            idFromClient: `AFTX-${Date.now()}`,
            additionnalInfos: {
                recipientEmail: '',
                recipientFirstName: 'AfriTix',
                recipientLastName: 'Client',
                destinataire: phone.replace(/\s/g, '')
            },
            amount: String(amount),
            callback: `${SUPABASE_URL}/rest/v1/rpc/noop`,
            recipientNumber: phone.replace(/\s/g, ''),
            serviceCode: provider || 'ORANGE_MONEY_CI',
            partner_id: config.partnerId,
            login_api: config.login,
            password_api: config.password
        };

        console.log(`[InTouch] Initiating ${provider} payment for ${amount} XOF to ${phone}`);

        const response = await fetch('https://api.gfrontinch.com/GEP/rest/api/collectMoney', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'login_api': config.login,
                'password_api': config.password
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (response.ok && (data.status === 'SUCCESSFUL' || data.code === '000' || data.idFromGU)) {
            return res.json({
                success: true,
                transactionId: data.idFromGU || data.idFromClient || `INT-${Date.now()}`,
                status: data.status || 'pending',
                message: `Paiement InTouch initié. Veuillez confirmer sur votre téléphone.`
            });
        } else {
            console.error('[InTouch] Error response:', data);
            return res.json({
                success: false,
                error: data.message || data.errorMessage || "L'API InTouch a rejeté la transaction.",
                details: data
            });
        }
    } catch (err) {
        console.error('[InTouch] Server error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ──── 4. PayDunya ────────────────────────────────────────────────────────
app.post('/api/pay/paydunya', async (req, res) => {
    try {
        const { phone, amount, provider } = req.body;
        if (!phone || !amount) return res.status(400).json({ success: false, error: 'Paramètres manquants (phone, amount)' });

        const config = await getSetting('paydunya_config');
        if (!config || !config.masterKey || !config.privateKey || !config.token) {
            return res.status(500).json({ success: false, error: "Configuration PayDunya manquante. Contactez l'administrateur." });
        }

        // PayDunya Soft Pay / Direct Pay API
        // Docs: https://paydunya.com/developers/documentation
        const payload = {
            invoice: {
                total_amount: amount,
                description: 'AfriTix Ticket Purchase'
            },
            store: {
                name: 'AfriTix',
                phone: phone.replace(/\s/g, '')
            },
            actions: {
                cancel_url: 'https://afritix.com/cancel',
                return_url: 'https://afritix.com/success',
                callback_url: `${SUPABASE_URL}/rest/v1/rpc/noop`
            },
            custom_data: {
                phone_number: phone.replace(/\s/g, ''),
                payment_provider: provider || 'orange-money-senegal'
            }
        };

        console.log(`[PayDunya] Initiating ${provider} payment for ${amount} XOF to ${phone}`);

        // Step 1 : Create Invoice
        const invoiceRes = await fetch('https://app.paydunya.com/api/v1/checkout-invoice/create', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'PAYDUNYA-MASTER-KEY': config.masterKey,
                'PAYDUNYA-PRIVATE-KEY': config.privateKey,
                'PAYDUNYA-TOKEN': config.token
            },
            body: JSON.stringify(payload)
        });

        const invoiceData = await invoiceRes.json();

        if (invoiceRes.ok && invoiceData.response_code === '00') {
            // Step 2 : Process Soft Pay via the token
            const softPayRes = await fetch('https://app.paydunya.com/api/v1/softpay/process', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'PAYDUNYA-MASTER-KEY': config.masterKey,
                    'PAYDUNYA-PRIVATE-KEY': config.privateKey,
                    'PAYDUNYA-TOKEN': config.token
                },
                body: JSON.stringify({
                    invoice_token: invoiceData.token,
                    payment_token: provider || 'orange-money-senegal',
                    phone_number: phone.replace(/\s/g, ''),
                    country_code: 'sn'
                })
            });

            const softPayData = await softPayRes.json();

            if (softPayRes.ok && (softPayData.response_code === '00' || softPayData.success)) {
                return res.json({
                    success: true,
                    transactionId: invoiceData.token || `PD-${Date.now()}`,
                    status: 'pending',
                    message: 'Paiement PayDunya initié. Veuillez confirmer sur votre téléphone.'
                });
            } else {
                console.error('[PayDunya] SoftPay error:', softPayData);
                return res.json({
                    success: false,
                    error: softPayData.response_text || 'Erreur SoftPay PayDunya',
                    details: softPayData
                });
            }
        } else {
            console.error('[PayDunya] Invoice creation error:', invoiceData);
            return res.json({
                success: false,
                error: invoiceData.response_text || 'Erreur création facture PayDunya',
                details: invoiceData
            });
        }
    } catch (err) {
        console.error('[PayDunya] Server error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Start Server ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 AfriTix Server (SMTP + Payment Proxy) running on port ${PORT}`);
});
