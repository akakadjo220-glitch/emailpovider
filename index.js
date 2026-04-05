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
            from: `"${smtpConfig.senderName || 'Babipass'}" <${smtpConfig.user}>`,
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
// ─── AUTHENTICATION (Password Reset via OTP) ─────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { email, otp_code, new_password } = req.body;
        if (!email || !otp_code || !new_password) {
            return res.status(400).json({ success: false, error: "Email, OTP et nouveau mot de passe requis." });
        }

        const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!SERVICE_ROLE_KEY) {
            return res.status(500).json({ success: false, error: "SUPABASE_SERVICE_ROLE_KEY manquant sur le serveur. Impossible de forcer la mise à jour du mot de passe." });
        }

        const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

        // 1. Vérifier l'OTP
        const { data: otpData, error: otpError } = await supabaseAdmin
            .from('auth_otps')
            .select('*')
            .eq('email', email)
            .eq('otp_code', otp_code)
            .maybeSingle();

        if (otpError || !otpData) {
            return res.status(400).json({ success: false, error: "Code OTP invalide ou expiré." });
        }

        // 2. Trouver l'utilisateur dans 'profiles'
        const { data: profileData, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('email', email)
            .maybeSingle();

        if (profileError || !profileData) {
            // Tentative 2: si le profile n'existe pas, essayer via listUsers
            const { data: usersData, error: usersError } = await supabaseAdmin.auth.admin.listUsers();
            if (usersError) return res.status(500).json({ success: false, error: "Erreur récupération utilisateur." });

            const authUser = usersData.users.find(u => u.email === email);
            if (!authUser) return res.status(404).json({ success: false, error: "Utilisateur introuvable." });

            // Mettre à jour le mot de passe
            const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(authUser.id, { password: new_password });
            if (updateError) throw updateError;
        } else {
            // Profile trouvé, on a l'ID
            const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(profileData.id, { password: new_password });
            if (updateError) throw updateError;
        }

        // 3. Nettoyer l'OTP
        await supabaseAdmin.from('auth_otps').delete().eq('email', email);

        return res.status(200).json({ success: true, message: "Mot de passe mis à jour avec succès." });
    } catch (err) {
        console.error('[Reset Password] Server error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── TICKET RECOVERY OTP ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/auth/ticket-otp', async (req, res) => {
    try {
        const { email, ticketCount } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, error: 'Email requis.' });
        }

        // 1. Générer OTP à 6 chiffres
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();

        // 2. Supprimer les anciens OTPs pour cet email (évite les doublons)
        await supabase.from('auth_otps').delete().eq('email', email.trim().toLowerCase());

        // 3. Enregistrer le nouvel OTP
        const { error: insertError } = await supabase.from('auth_otps').insert([{
            email: email.trim().toLowerCase(),
            otp_code: otpCode,
            expires_at: expiresAt
        }]);
        if (insertError) throw insertError;

        // 4. Récupérer la config SMTP depuis platform_settings
        const smtpConfig = await getSetting('smtp_config');
        if (!smtpConfig || !smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
            return res.status(500).json({ success: false, error: 'Configuration SMTP non configurée.' });
        }

        // 5. Template email dédié - Récupération de Billets 🎫
        const count = ticketCount || '?';
        const htmlBody = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Code de récupération - Babipass</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:24px;overflow:hidden;border:1px solid #334155;">
          <!-- Header orange -->
          <tr>
            <td style="background:linear-gradient(135deg,#ea580c 0%,#f59e0b 100%);padding:36px 40px;text-align:center;">
              <div style="font-size:48px;margin-bottom:12px;">🎫</div>
              <h1 style="margin:0;color:#fff;font-size:26px;font-weight:800;letter-spacing:-0.5px;">Récupération de Billets</h1>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">Babipass – Vos billets en sécurité</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="color:#94a3b8;font-size:15px;margin:0 0 16px;">Bonjour,</p>
              <p style="color:#cbd5e1;font-size:15px;margin:0 0 24px;line-height:1.6;">
                Une demande de récupération de <strong style="color:#f97316;">${count} billet(s)</strong> a été effectuée pour l'adresse <strong style="color:#f97316;">${email}</strong>.
              </p>
              <p style="color:#cbd5e1;font-size:14px;margin:0 0 20px;">Pour confirmer que c'est bien vous, saisissez ce code de vérification à 6 chiffres :</p>

              <!-- OTP Box -->
              <div style="background:#0f172a;border:2px solid #f97316;border-radius:16px;padding:28px;text-align:center;margin:0 0 28px;">
                <p style="margin:0 0 8px;color:#64748b;font-size:12px;letter-spacing:2px;text-transform:uppercase;">Code de sécurité</p>
                <p style="margin:0;font-size:48px;font-weight:900;letter-spacing:12px;color:#f97316;font-family:'Courier New',monospace;">${otpCode}</p>
                <p style="margin:12px 0 0;color:#64748b;font-size:12px;">⏱ Ce code expire dans <strong>10 minutes</strong></p>
              </div>

              <!-- Warning -->
              <div style="background:#7f1d1d22;border:1px solid #dc2626;border-radius:12px;padding:16px 20px;margin:0 0 28px;">
                <p style="margin:0;color:#fca5a5;font-size:13px;line-height:1.5;">
                  <strong>⚠️ Attention :</strong> Si vous n'avez pas effectué cette demande, quelqu'un tente peut-être d'accéder à vos billets.
                  Ignorez cet e-mail et vos billets resteront protégés.
                </p>
              </div>

              <p style="color:#64748b;font-size:13px;margin:0;border-top:1px solid #334155;padding-top:24px;">
                Cet email a été envoyé automatiquement par <strong>Babipass</strong>. Ne répondez pas à ce message.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#0f172a;padding:20px 40px;text-align:center;">
              <p style="margin:0;color:#475569;font-size:12px;">© 2025 Babipass – Votre billetterie en toute sécurité</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

        const transporter = nodemailer.createTransport({
            host: smtpConfig.host,
            port: smtpConfig.port || 465,
            secure: smtpConfig.port == 465,
            auth: { user: smtpConfig.user, pass: smtpConfig.pass },
            tls: { rejectUnauthorized: false }
        });

        await transporter.sendMail({
            from: `"Babipass" <${smtpConfig.user}>`,
            to: email.trim(),
            subject: `🔐 Votre code de récupération : ${otpCode}`,
            html: htmlBody,
        });

        console.log(`[Ticket OTP] Code envoyé à ${email}`);
        return res.status(200).json({ success: true });

    } catch (err) {
        console.error('[Ticket OTP] Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── AMBASSADOR OTP ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/auth/ambassador-otp', async (req, res) => {
    try {
        const { email, name } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, error: 'Email requis.' });
        }

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();

        await supabase.from('auth_otps').delete().eq('email', email.trim().toLowerCase());

        const { error: insertError } = await supabase.from('auth_otps').insert([{
            email: email.trim().toLowerCase(),
            otp_code: otpCode,
            expires_at: expiresAt
        }]);
        if (insertError) throw insertError;

        const smtpConfig = await getSetting('smtp_config');
        if (!smtpConfig || !smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
            return res.status(500).json({ success: false, error: 'Configuration SMTP non configurée.' });
        }

        const htmlBody = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <title>Code Ambassadeur</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:24px;overflow:hidden;border:1px solid #334155;">
          <!-- Header violet/ambassadeur -->
          <tr>
            <td style="background:linear-gradient(135deg,#7c3aed 0%,#4f46e5 100%);padding:36px 40px;text-align:center;">
              <h1 style="margin:0;color:#fff;font-size:26px;font-weight:800;letter-spacing:-0.5px;">🎁 Babipass Ambassadeur</h1>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">Programme d'Affiliation Officiel</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="color:#cbd5e1;font-size:15px;margin:0 0 16px;">Bonjour <strong>${name || 'Ambassadeur'}</strong>,</p>
              <p style="color:#94a3b8;font-size:15px;margin:0 0 24px;">Voici votre code de confirmation pour activer votre compte Ambassadeur :</p>
              <!-- OTP Box -->
              <div style="background:#0f172a;border:2px solid #7c3aed;border-radius:16px;padding:28px;text-align:center;margin:0 0 28px;">
                <p style="margin:0;font-size:48px;font-weight:900;letter-spacing:12px;color:#8b5cf6;font-family:'Courier New',monospace;">${otpCode}</p>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

        const transporter = nodemailer.createTransport({
            host: smtpConfig.host,
            port: smtpConfig.port || 465,
            secure: smtpConfig.port == 465,
            auth: { user: smtpConfig.user, pass: smtpConfig.pass },
            tls: { rejectUnauthorized: false }
        });

        await transporter.sendMail({
            from: '"Babipass Ambassadeur" <' + smtpConfig.user + '>',
            to: email.trim(),
            subject: otpCode + " — Votre code d'activation Ambassadeur Babipass",
            html: htmlBody,
        });

        console.log('[Ambassador OTP] Code envoyé à ' + email);
        return res.status(200).json({ success: true });

    } catch (err) {
        console.error('[Ambassador OTP] Error:', err);
        return res.status(500).json({ success: false, error: err.message });
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

// ─── DIDIT API CONFIGURATION ────────────────────────────────────────────────
// In a real production environment, these should be loaded from process.env
// We are hardcoding them from the user's secure response for immediate deployment
const DIDIT_API_KEY = 'gkjZnCYzBXgXiWjLNarfXeq8HLCFK0fnzSgulw7NZ9s';
const DIDIT_WORKFLOW_ID = '8fa09204-b88d-442d-ad51-98757f60e0fb';

// ─── DIDIT SESSION CREATION ────────────────────────────────────────────────
app.post('/api/didit/session', express.json(), async (req, res) => {
    try {
        const { user_id, callback_url } = req.body;
        if (!user_id) {
            return res.status(400).json({ error: 'user_id is required' });
        }

        const postData = JSON.stringify({
            workflow_id: DIDIT_WORKFLOW_ID,
            vendor_data: user_id, // THIS IS THE MAGIC! We permanently attach the user ID!
            callback: callback_url || 'https://afritix.com' // Fallback callback
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
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ─── DIDIT WEBHOOK ─────────────────────────────────────────────────────────
app.get('/api/webhooks/didit', (req, res) => {
    res.status(200).send('Didit Webhook is active (Ready for POST)');
});

const webhookLogs = [];

app.post('/api/webhooks/didit', async (req, res) => {
    try {
        const body = req.body;

        // Log incoming webhook for deep debugging
        const logEntry = {
            timestamp: new Date().toISOString(),
            body: body
        };
        webhookLogs.unshift(logEntry);
        if (webhookLogs.length > 50) webhookLogs.pop(); // Keep last 50

        console.log('[Didit Webhook] Received:', body);

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

        // Extract the strict overarching status from the payload
        const topLevelStatus = String(body.status || decision?.status || '').toLowerCase();
        let isApproved = topLevelStatus === 'approved';

        const status = isApproved ? 'verified' : 'rejected';

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
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Debug Endpoint to view recent webhooks
app.get('/api/webhooks/didit/logs', (req, res) => {
    res.status(200).json(webhookLogs);
});

// ─── Start Server ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 AfriTix Server (SMTP + Payment Proxy) running on port ${PORT}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── CRON : Event Lifecycle Manager ────────────────────────────────────────
// Runs every hour — marks events as 'completed' 24h after their date
// ═══════════════════════════════════════════════════════════════════════════
async function runEventLifecycleCron() {
    try {
        console.log('[Cron] Running event lifecycle check...');

        const { data: expiredEvents, error: fetchErr } = await supabase
            .from('events')
            .select('id, title, date, thanks_email_sent')
            .eq('status', 'published');

        if (fetchErr) {
            console.error('[Cron] Error fetching events:', fetchErr.message);
            return;
        }

        if (!expiredEvents || expiredEvents.length === 0) {
            console.log('[Cron] No published events found.');
            return;
        }

        const now = new Date();
        const toClose = expiredEvents.filter(ev => {
            const evDate = ev.date ? new Date(ev.date) : null;
            if (!evDate) return false;
            const releaseDate = new Date(evDate.getTime() + 24 * 60 * 60 * 1000);
            return releaseDate < now;
        });

        if (toClose.length > 0) {
            const idsToClose = toClose.map(ev => ev.id);
            const { error: updateErr } = await supabase
                .from('events')
                .update({ status: 'completed' })
                .in('id', idsToClose);

            if (updateErr) {
                console.error('[Cron] Error updating events:', updateErr.message);
            } else {
                console.log(`[Cron] ✅ Marked ${toClose.length} event(s) as completed:`, toClose.map(e => e.title));
            }
        }

        // --- PART 2: Send Thank You Emails for Completed Events ---
        const enableAutoThanks = await getSetting('enable_auto_thanks');
        if (enableAutoThanks === false || enableAutoThanks === 'false') {
            console.log('[Cron] Post-event thank-you emails are globally disabled.');
            return;
        }

        const { data: eventsToThank, error: thanksErr } = await supabase
            .from('events')
            .select('id, title, date, location, city')
            .eq('status', 'completed')
            .eq('thanks_email_sent', false);

        if (thanksErr) {
            console.error('[Cron] Error fetching events for thanks:', thanksErr.message);
        } else if (eventsToThank && eventsToThank.length > 0) {
            const smtpConfig = await getSetting('smtp_config');
            if (!smtpConfig || !smtpConfig.host || !smtpConfig.user) {
                console.warn('[Cron] SMTP not configured for thank-you emails.');
                return;
            }

            const transporter = nodemailer.createTransport({
                host: smtpConfig.host,
                port: smtpConfig.port || 465,
                secure: smtpConfig.port == 465,
                auth: { user: smtpConfig.user, pass: smtpConfig.pass },
                tls: { rejectUnauthorized: false }
            });

            for (const event of eventsToThank) {
                console.log(`[Cron] Sending thank-you emails for "${event.title}"...`);
                
                const { data: recipients, error: recErr } = await supabase
                    .from('transactions')
                    .select('guest_email, guest_name')
                    .eq('event_id', event.id)
                    .eq('status', 'completed');

                if (recErr || !recipients) continue;

                let sentCount = 0;
                const uniqueEmails = new Set();

                for (const rec of recipients) {
                    if (!rec.guest_email || uniqueEmails.has(rec.guest_email)) continue;
                    uniqueEmails.add(rec.guest_email);

                    const name = rec.guest_name ? rec.guest_name.split(' ')[0] : 'Cher participant';
                    const htmlBody = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"/><title>Merci !</title></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:24px;overflow:hidden;border:1px solid #334155;">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#6366f1 0%,#4338ca 100%);padding:40px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:28px;font-weight:800;">✨ Merci d'avoir été là !</h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.9);font-size:16px;">C'était un plaisir de vous accueillir</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:40px;">
            <p style="color:#cbd5e1;font-size:17px;margin:0 0-20px;">Bonjour <strong style="color:#fff;">${name}</strong> 👋,</p>
            <p style="color:#94a3b8;font-size:16px;line-height:1.6;margin:0 0 24px;">
              L'événement <strong style="color:#6366f1;">${event.title}</strong> est maintenant terminé. Nous espérons que vous avez passé un moment inoubliable !
            </p>

            <div style="background:#0f172a;border:1px solid #334155;border-radius:20px;padding:24px;margin-bottom:28px;text-align:center;">
               <p style="color:#94a3b8;font-size:14px;margin:0 0 8px;">ÉVÉNEMENT</p>
               <h3 style="color:#fff;font-size:20px;margin:0 0 4px;">${event.title}</h3>
               <p style="color:#64748b;font-size:14px;margin:0;">${event.city || ''} ${event.location ? '• ' + event.location : ''}</p>
            </div>

            <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin-bottom:32px;">
              Votre présence a contribué au succès de cet événement. N'hésitez pas à suivre <strong>Babipass</strong> pour découvrir les prochains rendez-vous exclusifs !
            </p>

            <div style="text-align:center;">
              <a href="https://babipass.com" style="background:linear-gradient(135deg,#f97316 0%,#ea580c 100%);color:#fff;text-decoration:none;padding:14px 32px;border-radius:14px;font-weight:bold;display:inline-block;box-shadow:0 10px 15px -3px rgba(234,88,12,0.3);">Voir les prochains événements</a>
            </div>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#0f172a;padding:30px;text-align:center;border-top:1px solid #1e293b;">
            <p style="color:#475569;font-size:13px;margin:0 0 10px;">© Babipass • Plateforme de Billetterie Africaine</p>
            <p style="color:#334155;font-size:11px;margin:0;">Vous recevez cet email suite à votre participation à un événement via Babipass.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

                    try {
                        await transporter.sendMail({
                            from: `"Babipass" <${smtpConfig.user}>`,
                            to: rec.guest_email.trim(),
                            subject: `✨ Merci de votre participation : ${event.title}`,
                            html: htmlBody,
                        });
                        sentCount++;
                    } catch (mailErr) {
                        console.error(`[Cron] Failed to send thanks to ${rec.guest_email}:`, mailErr.message);
                    }
                }

                await supabase.from('events').update({ thanks_email_sent: true }).eq('id', event.id);
                console.log(`[Cron] ✅ Sent ${sentCount} thank-you email(s) for "${event.title}"`);
            }
        }
    } catch (err) {
        console.error('[Cron] Unexpected error:', err.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── CRON : J-1 Reminder Emails ────────────────────────────────────────────
// Runs every day — sends reminder emails to ticket buyers for tomorrow's events
// ═══════════════════════════════════════════════════════════════════════════
async function runReminderCron() {
    try {
        console.log('[Reminder] Checking for events happening tomorrow...');

        const enableAutoReminders = await getSetting('enable_auto_reminders');
        if (enableAutoReminders === false || enableAutoReminders === 'false') {
            console.log('[Reminder] Auto-reminders are globally disabled.');
            return;
        }

        const smtpConfig = await getSetting('smtp_config');
        if (!smtpConfig || !smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
            console.warn('[Reminder] SMTP not configured, skipping reminder emails.');
            return;
        }

        // Find events happening tomorrow (date between +24h and +48h from now)
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStart = new Date(tomorrow);
        tomorrowStart.setHours(0, 0, 0, 0);
        const tomorrowEnd = new Date(tomorrow);
        tomorrowEnd.setHours(23, 59, 59, 999);

        const { data: tomorrowEvents, error: evErr } = await supabase
            .from('events')
            .select('id, title, date, city, location')
            .eq('status', 'published')
            .gte('date', tomorrowStart.toISOString())
            .lte('date', tomorrowEnd.toISOString());

        if (evErr) {
            console.error('[Reminder] Error fetching tomorrow events:', evErr.message);
            return;
        }

        if (!tomorrowEvents || tomorrowEvents.length === 0) {
            console.log('[Reminder] No events scheduled for tomorrow.');
            return;
        }

        console.log(`[Reminder] Found ${tomorrowEvents.length} event(s) for tomorrow. Fetching buyers...`);

        const transporter = nodemailer.createTransport({
            host: smtpConfig.host,
            port: smtpConfig.port || 465,
            secure: smtpConfig.port == 465,
            auth: { user: smtpConfig.user, pass: smtpConfig.pass },
            tls: { rejectUnauthorized: false }
        });

        for (const event of tomorrowEvents) {
            // Get all completed transactions for this event
            const { data: transactions, error: trxErr } = await supabase
                .from('transactions')
                .select('guest_name, guest_email, id')
                .eq('event_id', event.id)
                .eq('status', 'completed');

            if (trxErr) {
                console.error(`[Reminder] Error fetching buyers for event ${event.id}:`, trxErr.message);
                continue;
            }

            if (!transactions || transactions.length === 0) {
                console.log(`[Reminder] No buyers for event "${event.title}".`);
                continue;
            }

            const eventDate = new Date(event.date);
            const dateStr = eventDate.toLocaleDateString('fr-FR', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
            });
            const timeStr = eventDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

            let sentCount = 0;
            for (const trx of transactions) {
                if (!trx.guest_email) continue;

                const firstName = trx.guest_name ? trx.guest_name.split(' ')[0] : 'Cher participant';

                const htmlBody = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"/><title>Rappel Événement</title></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:24px;overflow:hidden;border:1px solid #334155;">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#f97316 0%,#ea580c 100%);padding:36px 40px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:26px;font-weight:800;">🎉 C'est demain !</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.9);font-size:15px;">Votre événement approche à grands pas</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:36px 40px;">
            <p style="color:#cbd5e1;font-size:16px;margin:0 0 16px;">Bonjour <strong style="color:#fff;">${firstName}</strong> 👋,</p>
            <p style="color:#94a3b8;font-size:15px;margin:0 0 24px;">
              Nous vous rappelons que l'événement auquel vous avez acheté votre billet a lieu <strong style="color:#f97316;">demain</strong> !
            </p>

            <!-- Event Card -->
            <div style="background:#0f172a;border:1px solid #334155;border-left:4px solid #f97316;border-radius:16px;padding:24px;margin:0 0 28px;">
              <h2 style="margin:0 0 12px;color:#fff;font-size:20px;font-weight:800;">${event.title}</h2>
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:4px 12px 4px 0;color:#94a3b8;font-size:14px;">📅 Date</td>
                  <td style="padding:4px 0;color:#e2e8f0;font-size:14px;font-weight:600;">${dateStr}</td>
                </tr>
                <tr>
                  <td style="padding:4px 12px 4px 0;color:#94a3b8;font-size:14px;">🕐 Heure</td>
                  <td style="padding:4px 0;color:#e2e8f0;font-size:14px;font-weight:600;">${timeStr}</td>
                </tr>
                ${event.location ? `<tr>
                  <td style="padding:4px 12px 4px 0;color:#94a3b8;font-size:14px;">📍 Lieu</td>
                  <td style="padding:4px 0;color:#e2e8f0;font-size:14px;font-weight:600;">${event.location}</td>
                </tr>` : ''}
                ${event.city ? `<tr>
                  <td style="padding:4px 12px 4px 0;color:#94a3b8;font-size:14px;">🌍 Ville</td>
                  <td style="padding:4px 0;color:#e2e8f0;font-size:14px;font-weight:600;">${event.city}</td>
                </tr>` : ''}
              </table>
            </div>

            <!-- Reminder Tips -->
            <div style="background:#1e3a5f;border:1px solid #1d4ed8;border-radius:12px;padding:20px;margin:0 0 28px;">
              <p style="color:#93c5fd;font-size:14px;font-weight:700;margin:0 0 8px;">💡 Conseils pour demain :</p>
              <ul style="color:#bfdbfe;font-size:14px;margin:0;padding-left:20px;line-height:1.8;">
                <li>Préparez votre billet (QR code dans vos emails de confirmation)</li>
                <li>Arrivez 15 minutes avant l'heure indiquée</li>
                <li>Présentez votre billet (screenshot ou email) à l'entrée</li>
              </ul>
            </div>

            <p style="color:#64748b;font-size:13px;margin:0;text-align:center;">
              Vous recevez cet email car vous avez acheté un billet sur <strong>Babipass</strong>.<br/>
              Bonne soirée ! 🎊
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#0f172a;padding:20px 40px;text-align:center;border-top:1px solid #1e293b;">
            <p style="color:#475569;font-size:12px;margin:0;">© Babipass • Plateforme de Billetterie Africaine</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

                try {
                    await transporter.sendMail({
                        from: `"Babipass" <${smtpConfig.user}>`,
                        to: trx.guest_email.trim(),
                        subject: `🎉 Rappel : "${event.title}" c'est demain !`,
                        html: htmlBody,
                    });
                    sentCount++;
                } catch (mailErr) {
                    console.error(`[Reminder] Failed to send to ${trx.guest_email}:`, mailErr.message);
                }
            }

            console.log(`[Reminder] ✅ Sent ${sentCount} reminder(s) for "${event.title}"`);
        }

    } catch (err) {
        console.error('[Reminder] Unexpected error:', err.message);
    }
}

// Run lifecycle cron immediately on startup, then every hour
runEventLifecycleCron();
setInterval(runEventLifecycleCron, 60 * 60 * 1000);

// Run reminder cron immediately on startup, then every 24 hours
runReminderCron();
setInterval(runReminderCron, 24 * 60 * 60 * 1000);
