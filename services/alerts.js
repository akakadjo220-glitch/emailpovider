// ═══════════════════════════════════════════════════════════════════════════
// ─── ALERTES D'EXPLOITATION ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// Toutes les 5 minutes (tâche « health-alerts » du worker), on lit l'état de
// santé en base (ops_health_snapshot) et on prévient l'équipe AVANT que les
// clients ne se plaignent : paiements bloqués, échecs en série, e-mails ou
// WhatsApp qui ne partent plus, clients à rembourser.
//
// Destinataires (variables d'environnement, séparées par des virgules) :
//   ALERT_EMAILS="ops@babipass.com,direction@babipass.com"
//   ALERT_WHATSAPP="2250700000000"
// Les deux canaux sont utilisés : si les e-mails sont en panne, WhatsApp
// prévient quand même (et inversement). Une même alerte n'est envoyée qu'une
// fois par heure (une fois par jour pour les remboursements).
// La panne complète du serveur, elle, se détecte de l'extérieur (UptimeRobot…).
// ═══════════════════════════════════════════════════════════════════════════

const RULES = [
    {
        key: 'orders-stuck',
        test: s => s.orders_stuck >= 5,
        message: s => `${s.orders_stuck} paiements sont bloqués « en attente » depuis plus de 30 minutes. Un opérateur de paiement est peut-être en panne.`,
    },
    {
        key: 'payment-failures',
        test: s => s.orders_last_hour >= 10 && s.orders_failed_last_hour / s.orders_last_hour >= 0.5,
        message: s => `${s.orders_failed_last_hour} paiements sur ${s.orders_last_hour} ont échoué dans la dernière heure (${Math.round(100 * s.orders_failed_last_hour / s.orders_last_hour)} %).`,
    },
    {
        key: 'refund-required',
        daily: true,
        test: s => s.refund_required > 0,
        message: s => `${s.refund_required} client(s) ont payé sans pouvoir recevoir de place (stock épuisé entre-temps) : remboursement à effectuer.`,
    },
    {
        key: 'email-down',
        test: s => s.email_overdue >= 20 || s.email_failed_last_hour >= 20,
        message: s => `Les e-mails ne partent plus : ${s.email_overdue} en retard, ${s.email_failed_last_hour} en échec sur la dernière heure. Vérifier le SMTP dans l'admin.`,
    },
    {
        key: 'whatsapp-down',
        test: s => s.whatsapp_overdue >= 20 || s.whatsapp_failed_last_hour >= 20,
        message: s => `Les messages WhatsApp ne partent plus : ${s.whatsapp_overdue} en retard, ${s.whatsapp_failed_last_hour} en échec sur la dernière heure.`,
    },
];

const list = value => String(value || '').split(',').map(v => v.trim()).filter(Boolean);

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function createHealthAlerts({ supabase, env = process.env, now = () => new Date() }) {
    let warnedNoRecipient = false;

    /** Vérifie l'état de santé et met en file les alertes nécessaires. Renvoie les clés déclenchées. */
    return async function runHealthAlerts() {
        const { data: snapshot, error } = await supabase.rpc('ops_health_snapshot');
        if (error) {
            if (!/does not exist/.test(error.message)) console.error('[Alertes] État de santé illisible :', error.message);
            return [];
        }
        const s = Object.fromEntries(Object.entries(snapshot || {}).map(([k, v]) => [k, Number(v) || 0]));
        const fired = RULES.filter(rule => rule.test(s));
        if (!fired.length) return [];

        const emails = list(env.ALERT_EMAILS);
        const phones = list(env.ALERT_WHATSAPP).map(p => p.replace(/[^\d]/g, ''));
        for (const rule of fired) console.error(`[Alerte] ${rule.key} : ${rule.message(s)}`);
        if (!emails.length && !phones.length) {
            if (!warnedNoRecipient) console.warn('[Alertes] Aucun destinataire (ALERT_EMAILS / ALERT_WHATSAPP) : alertes visibles dans les logs uniquement.');
            warnedNoRecipient = true;
            return fired.map(r => r.key);
        }

        const iso = now().toISOString();
        const emailRows = [];
        const whatsappRows = [];
        for (const rule of fired) {
            const bucket = rule.daily ? iso.slice(0, 10) : iso.slice(0, 13); // jour ou heure
            const text = rule.message(s);
            for (const to of emails) {
                emailRows.push({
                    to_email: to,
                    subject: `⚠️ Babipass — ${text.slice(0, 80)}`,
                    html_body: `<p><strong>Alerte Babipass</strong> (${escapeHtml(iso.slice(0, 16).replace('T', ' '))} UTC)</p><p>${escapeHtml(text)}</p>`,
                    dedupe_key: `alert:${rule.key}:${bucket}:${to}`,
                });
            }
            for (const phone of phones) {
                whatsappRows.push({ phone, message: `⚠️ Alerte Babipass : ${text}`, dedupe_key: `alert:${rule.key}:${bucket}:${phone}` });
            }
        }
        // ignoreDuplicates : une alerte déjà envoyée dans la période n'est pas renvoyée.
        if (emailRows.length) {
            const { error: e1 } = await supabase.from('email_queue').upsert(emailRows, { onConflict: 'dedupe_key', ignoreDuplicates: true });
            if (e1) console.error('[Alertes] Mise en file e-mail impossible :', e1.message);
        }
        if (whatsappRows.length) {
            const { error: e2 } = await supabase.from('whatsapp_queue').upsert(whatsappRows, { onConflict: 'dedupe_key', ignoreDuplicates: true });
            if (e2) console.error('[Alertes] Mise en file WhatsApp impossible :', e2.message);
        }
        return fired.map(r => r.key);
    };
}

module.exports = { createHealthAlerts, RULES };
