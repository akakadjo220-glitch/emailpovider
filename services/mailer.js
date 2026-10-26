/**
 * Envoi d'e-mails : SMTP principal (platform_settings.smtp_config, ex. Amazon SES) avec
 * bascule automatique sur le SMTP de secours (smtp_backup_config) s'il échoue.
 * Utilisé par les codes OTP, la file email_queue et l'envoi direct de secours.
 */
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const ALERT_EVERY_MS = 5 * 60 * 1000; // une ligne d'alerte par panne, pas une par e-mail

const isComplete = cfg => !!(cfg && cfg.host && cfg.user && cfg.pass);

// Expéditeur : adresse dédiée si renseignée (indispensable avec SES, dont l'identifiant est « AKIA… »).
const fromOf = (cfg, senderName) => `"${senderName || cfg.senderName || 'Babipass'}" <${cfg.fromEmail || cfg.user}>`;

function createMailer({ getSetting, pool = null }) {
    const transports = new Map(); // 'principal' | 'secours' -> { key, transport }
    let lastAlert = 0;

    function transportFor(name, cfg) {
        const key = crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
        const cached = transports.get(name);
        if (cached && cached.key === key) return cached.transport;
        if (cached) cached.transport.close();
        const transport = nodemailer.createTransport({
            host: cfg.host,
            port: cfg.port || 465,
            secure: cfg.port == 465,
            auth: { user: cfg.user, pass: cfg.pass },
            // Comportement historique conservé ; SMTP_STRICT_TLS=true active la vérification du certificat.
            tls: { rejectUnauthorized: process.env.SMTP_STRICT_TLS === 'true' },
            ...(pool || {}),
        });
        transports.set(name, { key, transport });
        return transport;
    }

    async function send({ to, subject, html, senderName }) {
        const [primary, backup] = await Promise.all([getSetting('smtp_config'), getSetting('smtp_backup_config')]);
        const targets = [['principal', primary], ['secours', backup]].filter(([, cfg]) => isComplete(cfg));
        if (!targets.length) throw new Error('Configuration SMTP non configurée.');

        let lastError;
        for (const [name, cfg] of targets) {
            try {
                return await transportFor(name, cfg).sendMail({ from: fromOf(cfg, senderName), to, subject, html });
            } catch (err) {
                lastError = err;
                if (name === 'principal' && targets.length > 1 && Date.now() - lastAlert > ALERT_EVERY_MS) {
                    lastAlert = Date.now();
                    console.error(`[Mail] SMTP principal en échec (${err.message}) : bascule sur le SMTP de secours.`);
                }
            }
        }
        throw lastError;
    }

    return { send };
}

module.exports = { createMailer, fromOf };
