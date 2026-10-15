// ═══════════════════════════════════════════════════════════════════════════
// ─── WORKER : FILES D'ATTENTE ET TÂCHES PLANIFIÉES ────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// Tourne dans le processus « worker » (PROCESS_ROLE=worker ou all).
//
// Files (email_queue, whatsapp_queue) : dépilage par lots via queue_claim
// (FOR UPDATE SKIP LOCKED) — plusieurs workers ne prennent jamais le même
// message ; envois en parallèle limités ; échecs réessayés avec délai croissant.
//
// Tâches planifiées : chaque tâche prend un verrou en base (claim_job_lease)
// avant de tourner, donc une seule instance l'exécute, quel que soit le nombre
// de workers ou de redémarrages. Rappels et remerciements sont mis en file avec
// une clé de déduplication : un destinataire ne reçoit jamais deux fois le même.
// ═══════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { createHealthAlerts } = require('./alerts');

const MAX_ATTEMPTS = 5;
const QUEUE_BATCH = Number(process.env.QUEUE_BATCH || 50);
const EMAIL_CONCURRENCY = Number(process.env.EMAIL_CONCURRENCY || 5);
const WHATSAPP_CONCURRENCY = Number(process.env.WHATSAPP_CONCURRENCY || 3);
const IDLE_POLL_MS = 2000;
const SCHEDULER_TICK_MS = 15 * 1000;
const PAGE_SIZE = 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Exécute fn sur chaque élément avec au plus `limit` appels simultanés. */
async function mapWithConcurrency(items, limit, fn) {
    let index = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const item = items[index++];
            await fn(item);
        }
    });
    await Promise.all(runners);
}

function createWorker({ supabase, getSetting, getSmtpConfig, dispatchWhatsApp, checkout }) {
    const workerId = `${process.env.HOSTNAME || 'worker'}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
    let running = false;
    const loops = [];

    // Pause interrompue immédiatement par stop() (arrêt rapide lors d'un déploiement).
    const wakeUps = new Set();
    function idle(ms) {
        return new Promise(resolve => {
            const wake = () => { clearTimeout(timer); wakeUps.delete(wake); resolve(); };
            const timer = setTimeout(wake, ms);
            wakeUps.add(wake);
        });
    }

    // ─── Transport SMTP mutualisé (connexions réutilisées) ───────────────
    let transport = null;
    let transportKey = null;

    async function getTransport() {
        const smtpConfig = await getSmtpConfig();
        const key = crypto.createHash('sha256').update(JSON.stringify(smtpConfig)).digest('hex');
        if (!transport || key !== transportKey) {
            if (transport) transport.close();
            transport = nodemailer.createTransport({
                pool: true,
                maxConnections: EMAIL_CONCURRENCY,
                maxMessages: 500,
                rateDelta: 1000,
                rateLimit: Number(process.env.SMTP_MAX_PER_SECOND || 10),
                host: smtpConfig.host,
                port: smtpConfig.port || 465,
                secure: smtpConfig.port == 465,
                auth: { user: smtpConfig.user, pass: smtpConfig.pass },
                tls: { rejectUnauthorized: process.env.SMTP_STRICT_TLS === 'true' },
            });
            transportKey = key;
        }
        return { transport, smtpConfig };
    }

    async function sendEmail(job) {
        const { transport: tx, smtpConfig } = await getTransport();
        await tx.sendMail({
            from: `"${smtpConfig.senderName || 'Babipass'}" <${smtpConfig.user}>`,
            to: job.to_email,
            subject: job.subject,
            html: job.html_body,
        });
    }

    // ─── Files d'attente ─────────────────────────────────────────────────
    async function processQueue(queue, handler, concurrency) {
        const { data: jobs, error } = await supabase.rpc('queue_claim', {
            p_queue: queue, p_worker: workerId, p_limit: QUEUE_BATCH,
        });
        if (error) {
            if (!/does not exist/.test(error.message)) console.error(`[${queue}] Claim échoué:`, error.message);
            return 0;
        }
        if (!jobs?.length) return 0;

        await mapWithConcurrency(jobs, concurrency, async job => {
            try {
                await handler(job);
                const { error: doneErr } = await supabase.rpc('queue_complete', { p_queue: queue, p_id: job.id });
                if (doneErr) console.error(`[${queue}] Complétion échouée ${job.id}:`, doneErr.message);
            } catch (sendErr) {
                const { data: status } = await supabase.rpc('queue_fail', {
                    p_queue: queue, p_id: job.id, p_error: sendErr.message, p_max_attempts: MAX_ATTEMPTS,
                });
                const level = status === 'failed' ? 'error' : 'warn';
                console[level](`[${queue}] ${status === 'failed' ? 'Échec définitif' : 'Nouvel essai prévu'} ${job.id} (essai ${job.attempts}) : ${sendErr.message}`);
            }
        });
        return jobs.length;
    }

    function startQueueLoop(queue, handler, concurrency) {
        const loop = (async () => {
            while (running) {
                let processed = 0;
                try {
                    processed = await processQueue(queue, handler, concurrency);
                } catch (err) {
                    console.error(`[${queue}] Boucle :`, err.message);
                }
                // Lot plein : on enchaîne ; sinon on attend avant de revérifier.
                if (processed < QUEUE_BATCH) await idle(IDLE_POLL_MS);
            }
        })();
        loops.push(loop);
    }

    const runHealthAlerts = createHealthAlerts({ supabase });

    // ─── Tâches planifiées sous verrou ───────────────────────────────────
    const scheduled = [
        { name: 'reconcile-orders', minIntervalS: 25, ttlS: 300, run: () => checkout.reconcile() },
        { name: 'rollup-counters', minIntervalS: 55, ttlS: 300, run: runCounterRollup },
        { name: 'event-lifecycle', minIntervalS: 3500, ttlS: 1800, run: runEventLifecycle },
        { name: 'event-reminders', minIntervalS: 3500, ttlS: 1800, run: runReminders },
        { name: 'purge-operational-data', minIntervalS: 86000, ttlS: 600, run: runPurge },
        { name: 'ensure-archive-partitions', minIntervalS: 86000, ttlS: 300, run: runEnsurePartitions },
        // Alertes d'exploitation (paiements bloqués, e-mails en panne…) : voir services/alerts.js.
        { name: 'health-alerts', minIntervalS: 290, ttlS: 120, run: runHealthAlerts },
        // Archivage des vieux événements : désactivé par défaut (ARCHIVE_ENABLED=true pour l'activer).
        ...(process.env.ARCHIVE_ENABLED === 'true'
            ? [{ name: 'archive-events', minIntervalS: 82800, ttlS: 3600, run: runArchive }]
            : []),
    ];

    async function runScheduled(job) {
        const { data: acquired, error } = await supabase.rpc('claim_job_lease', {
            p_name: job.name, p_worker: workerId, p_ttl_seconds: job.ttlS, p_min_interval_seconds: job.minIntervalS,
        });
        if (error) {
            if (!/does not exist/.test(error.message)) console.error(`[Job ${job.name}] Verrou :`, error.message);
            return;
        }
        if (!acquired) return;
        const started = Date.now();
        try {
            await job.run();
        } catch (err) {
            console.error(`[Job ${job.name}] Erreur :`, err.message);
        } finally {
            await supabase.rpc('release_job_lease', { p_name: job.name, p_worker: workerId });
            const ms = Date.now() - started;
            if (ms > 5000) console.log(`[Job ${job.name}] Terminé en ${Math.round(ms / 1000)} s`);
        }
    }

    function startScheduler() {
        const loop = (async () => {
            while (running) {
                for (const job of scheduled) {
                    if (!running) break;
                    await runScheduled(job);
                }
                await idle(SCHEDULER_TICK_MS);
            }
        })();
        loops.push(loop);
    }

    // ─── Destinataires d'un événement (paginé : pas de limite à 1000) ────
    async function forEachRecipientPage(eventId, onPage) {
        for (let from = 0; ; from += PAGE_SIZE) {
            const { data, error } = await supabase
                .from('transactions')
                .select('id, guest_email, guest_name')
                .eq('event_id', eventId)
                .eq('status', 'completed')
                .not('guest_email', 'is', null)
                .order('id', { ascending: true })
                .range(from, from + PAGE_SIZE - 1);
            if (error) throw error;
            if (!data?.length) return;
            await onPage(data);
            if (data.length < PAGE_SIZE) return;
        }
    }

    /** Met en file un e-mail par destinataire unique ; ignore les doublons (dedupe_key). */
    async function enqueueForRecipients(eventId, kind, buildEmail) {
        let queued = 0;
        const seen = new Set();
        await forEachRecipientPage(eventId, async rows => {
            const batch = [];
            for (const row of rows) {
                const email = String(row.guest_email || '').trim().toLowerCase();
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seen.has(email)) continue;
                seen.add(email);
                const { subject, html } = buildEmail(row);
                batch.push({ to_email: email, subject, html_body: html, dedupe_key: `${kind}:${eventId}:${email}` });
            }
            if (!batch.length) return;
            const { error } = await supabase.from('email_queue').upsert(batch, { onConflict: 'dedupe_key', ignoreDuplicates: true });
            if (error) throw error;
            queued += batch.length;
        });
        return queued;
    }

    const isDisabled = value => value === false || value === 'false';

    async function runEventLifecycle() {
        // 1. Événements terminés depuis 24 h → « completed »
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: closed, error: closeErr } = await supabase
            .from('events')
            .update({ status: 'completed' })
            .eq('status', 'published')
            .lt('date', cutoff)
            .select('id, title');
        if (closeErr) throw closeErr;
        if (closed?.length) console.log(`[Lifecycle] ${closed.length} événement(s) passé(s) en « completed »`);

        // 2. Remerciements après l'événement
        if (isDisabled(await getSetting('enable_auto_thanks'))) return;
        const { data: events, error } = await supabase
            .from('events')
            .select('id, title, location, city')
            .eq('status', 'completed')
            .eq('thanks_email_sent', false)
            .limit(50);
        if (error) throw error;

        for (const event of events || []) {
            const queued = await enqueueForRecipients(event.id, 'thanks', row => ({
                subject: `✨ Merci de votre participation : ${event.title}`,
                html: thanksEmailHtml(event, row.guest_name ? row.guest_name.split(' ')[0] : 'Cher participant'),
            }));
            await supabase.from('events').update({ thanks_email_sent: true }).eq('id', event.id);
            console.log(`[Lifecycle] ${queued} remerciement(s) mis en file pour « ${event.title} »`);
        }
    }

    async function runReminders() {
        if (isDisabled(await getSetting('enable_auto_reminders'))) return;

        // Événements de demain (jour calendaire UTC = heure d'Abidjan/Dakar).
        const now = new Date();
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
        const { data: events, error } = await supabase
            .from('events')
            .select('id, title, date, city, location')
            .eq('status', 'published')
            .gte('date', start.toISOString())
            .lte('date', end.toISOString());
        if (error) throw error;

        for (const event of events || []) {
            const queued = await enqueueForRecipients(event.id, 'reminder', row => ({
                subject: `🎉 Rappel : "${event.title}" c'est demain !`,
                html: reminderEmailHtml(event, row.guest_name ? row.guest_name.split(' ')[0] : 'Cher participant'),
            }));
            console.log(`[Reminders] ${queued} rappel(s) mis en file pour « ${event.title} » (doublons ignorés)`);
        }
    }

    /** Reporte les compteurs de vues / clics répartis sur events.views et ambassador_links.clicks. */
    async function runCounterRollup() {
        const { error } = await supabase.rpc('rollup_counters');
        if (error && !/does not exist/.test(error.message)) throw error;
    }

    async function runEnsurePartitions() {
        const { error } = await supabase.rpc('ensure_archive_partitions', { p_months_ahead: 3 });
        if (error && !/does not exist/.test(error.message)) throw error;
    }

    /**
     * Archive par lots les événements terminés depuis ARCHIVE_AFTER_DAYS jours
     * (365 par défaut), dans la limite de 10 minutes par passage.
     */
    async function runArchive() {
        const minAgeDays = Math.max(30, Number(process.env.ARCHIVE_AFTER_DAYS || 365));
        const deadline = Date.now() + 10 * 60 * 1000;
        let totalEvents = 0;
        let totalTickets = 0;
        while (running && Date.now() < deadline) {
            const { data, error } = await supabase.rpc('archive_due_events', { p_min_age_days: minAgeDays, p_limit: 20 });
            if (error) throw error;
            totalEvents += data.archived;
            totalTickets += Number(data.tickets || 0);
            if (data.skipped?.length) console.warn('[Archive] Événements non archivés :', data.skipped);
            if (data.archived === 0) break;
        }
        if (totalEvents) console.log(`[Archive] ${totalEvents} événement(s) archivé(s), ${totalTickets} billet(s) déplacé(s)`);
    }

    async function runPurge() {
        const { data, error } = await supabase.rpc('purge_operational_data');
        if (error) throw error;
        console.log('[Purge] Données opérationnelles nettoyées :', data);
    }

    // ─── Démarrage / arrêt ───────────────────────────────────────────────
    function start() {
        if (running) return;
        running = true;
        console.log(`[Worker] Démarrage ${workerId} (lots de ${QUEUE_BATCH}, ${EMAIL_CONCURRENCY} envois e-mail simultanés)`);
        startQueueLoop('email_queue', sendEmail, EMAIL_CONCURRENCY);
        startQueueLoop('whatsapp_queue', dispatchWhatsApp, WHATSAPP_CONCURRENCY);
        startScheduler();
    }

    /** Arrêt propre : termine les envois en cours (les messages non terminés seront repris). */
    async function stop() {
        running = false;
        wakeUps.forEach(wake => wake());
        await Promise.race([Promise.all(loops), sleep(25000)]);
        if (transport) transport.close();
        console.log('[Worker] Arrêté proprement.');
    }

    return { start, stop, workerId };
}

// ─── Gabarits ─────────────────────────────────────────────────────────────
function thanksEmailHtml(event, firstName) {
    const title = escapeHtml(event.title);
    return `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"/><title>Merci !</title></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:24px;overflow:hidden;border:1px solid #334155;">
        <tr>
          <td style="background:linear-gradient(135deg,#6366f1 0%,#4338ca 100%);padding:40px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:28px;font-weight:800;">✨ Merci d'avoir été là !</h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.9);font-size:16px;">C'était un plaisir de vous accueillir</p>
          </td>
        </tr>
        <tr>
          <td style="padding:40px;">
            <p style="color:#cbd5e1;font-size:17px;margin:0 0 20px;">Bonjour <strong style="color:#fff;">${escapeHtml(firstName)}</strong> 👋,</p>
            <p style="color:#94a3b8;font-size:16px;line-height:1.6;margin:0 0 24px;">
              L'événement <strong style="color:#6366f1;">${title}</strong> est maintenant terminé. Nous espérons que vous avez passé un moment inoubliable !
            </p>
            <div style="background:#0f172a;border:1px solid #334155;border-radius:20px;padding:24px;margin-bottom:28px;text-align:center;">
               <p style="color:#94a3b8;font-size:14px;margin:0 0 8px;">ÉVÉNEMENT</p>
               <h3 style="color:#fff;font-size:20px;margin:0 0 4px;">${title}</h3>
               <p style="color:#64748b;font-size:14px;margin:0;">${escapeHtml(event.city || '')} ${event.location ? '• ' + escapeHtml(event.location) : ''}</p>
            </div>
            <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin-bottom:32px;">
              Votre présence a contribué au succès de cet événement. N'hésitez pas à suivre <strong>Babipass</strong> pour découvrir les prochains rendez-vous exclusifs !
            </p>
            <div style="text-align:center;">
              <a href="https://babipass.com" style="background:linear-gradient(135deg,#f97316 0%,#ea580c 100%);color:#fff;text-decoration:none;padding:14px 32px;border-radius:14px;font-weight:bold;display:inline-block;">Voir les prochains événements</a>
            </div>
          </td>
        </tr>
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
}

function reminderEmailHtml(event, firstName) {
    const eventDate = new Date(event.date);
    const dateStr = eventDate.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Africa/Abidjan' });
    const timeStr = eventDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Abidjan' });
    const row = (label, value) => value ? `<tr>
                  <td style="padding:4px 12px 4px 0;color:#94a3b8;font-size:14px;">${label}</td>
                  <td style="padding:4px 0;color:#e2e8f0;font-size:14px;font-weight:600;">${escapeHtml(value)}</td>
                </tr>` : '';
    return `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"/><title>Rappel Événement</title></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:24px;overflow:hidden;border:1px solid #334155;">
        <tr>
          <td style="background:linear-gradient(135deg,#f97316 0%,#ea580c 100%);padding:36px 40px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:26px;font-weight:800;">🎉 C'est demain !</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.9);font-size:15px;">Votre événement approche à grands pas</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px;">
            <p style="color:#cbd5e1;font-size:16px;margin:0 0 16px;">Bonjour <strong style="color:#fff;">${escapeHtml(firstName)}</strong> 👋,</p>
            <p style="color:#94a3b8;font-size:15px;margin:0 0 24px;">
              Nous vous rappelons que l'événement auquel vous avez acheté votre billet a lieu <strong style="color:#f97316;">demain</strong> !
            </p>
            <div style="background:#0f172a;border:1px solid #334155;border-left:4px solid #f97316;border-radius:16px;padding:24px;margin:0 0 28px;">
              <h2 style="margin:0 0 12px;color:#fff;font-size:20px;font-weight:800;">${escapeHtml(event.title)}</h2>
              <table cellpadding="0" cellspacing="0">
                ${row('📅 Date', dateStr)}
                ${row('🕐 Heure', timeStr)}
                ${row('📍 Lieu', event.location)}
                ${row('🌍 Ville', event.city)}
              </table>
            </div>
            <div style="background:#1e3a5f;border:1px solid #1d4ed8;border-radius:12px;padding:20px;margin:0 0 28px;">
              <p style="color:#93c5fd;font-size:14px;font-weight:700;margin:0 0 8px;">💡 Conseils pour demain :</p>
              <ul style="color:#bfdbfe;font-size:14px;margin:0;padding-left:20px;line-height:1.8;">
                <li>Préparez votre billet (QR code dans vos emails de confirmation)</li>
                <li>Arrivez 15 minutes avant l'heure indiquée</li>
                <li>Présentez votre billet (screenshot ou email) à l'entrée</li>
              </ul>
            </div>
            <p style="color:#64748b;font-size:13px;margin:0;text-align:center;">
              Vous recevez cet email car vous avez acheté un billet sur <strong>Babipass</strong>.
            </p>
          </td>
        </tr>
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
}

module.exports = { createWorker, mapWithConcurrency };
