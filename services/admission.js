// ═══════════════════════════════════════════════════════════════════════════
// ─── SALLE D'ATTENTE APPLICATIVE (admission au checkout) ──────────────────
// ═══════════════════════════════════════════════════════════════════════════
// Pendant une vente flash, des dizaines de milliers d'acheteurs cliquent en
// même temps. Sans régulation, toutes les créations de commandes arrivent sur
// la base en même temps et la font saturer.
//
// Deux garde-fous :
//   1. Débit par événement, partagé entre toutes les instances (rate_limit_hit,
//      fenêtres d'une seconde) : au-delà de CHECKOUT_MAX_PER_SECOND_PER_EVENT,
//      l'acheteur reçoit 429 + Retry-After et le site le met en file d'attente
//      avec réessai automatique (pas d'erreur affichée, pas de perte de place).
//   2. Concurrence locale : au plus CHECKOUT_MAX_CONCURRENT créations de commande
//      simultanées par instance, pour ne jamais épuiser le pool de connexions.
// Une Waiting Room de CDN (Cloudflare…) peut s'ajouter en amont ; celle-ci
// fonctionne sans abonnement et protège aussi contre les appels directs à l'API.
// ═══════════════════════════════════════════════════════════════════════════

const MAX_PER_SECOND = Number(process.env.CHECKOUT_MAX_PER_SECOND_PER_EVENT || 50);
const MAX_CONCURRENT = Number(process.env.CHECKOUT_MAX_CONCURRENT || 20);

function createAdmission(supabase, metrics) {
    let active = 0;

    /**
     * Vrai si la demande peut entrer maintenant ; sinon { retryAfterS }.
     * En cas d'erreur base, on laisse passer (la réservation reste atomique).
     */
    async function tryEnter(eventId) {
        if (active >= MAX_CONCURRENT) {
            metrics?.inc('checkout_queued_total', { reason: 'concurrency' });
            return { admitted: false, retryAfterS: 1 + Math.ceil(Math.random() * 2) };
        }
        if (MAX_PER_SECOND > 0) {
            const { data, error } = await supabase.rpc('rate_limit_hit', {
                p_key: `checkout-event:${eventId}`,
                p_window_seconds: 1,
            });
            if (!error && data?.hits > MAX_PER_SECOND) {
                metrics?.inc('checkout_queued_total', { reason: 'event_rate' });
                // Étalement : plus la file est longue, plus l'attente proposée est longue.
                const backlogS = Math.ceil((data.hits - MAX_PER_SECOND) / MAX_PER_SECOND);
                return { admitted: false, retryAfterS: Math.min(30, 1 + backlogS + Math.floor(Math.random() * 3)) };
            }
        }
        active += 1;
        return { admitted: true };
    }

    function leave() {
        active = Math.max(0, active - 1);
    }

    /** Middleware-like : exécute fn si admis, sinon répond 429 avec Retry-After. */
    async function guard(res, eventId, fn) {
        const ticket = await tryEnter(eventId);
        if (!ticket.admitted) {
            res.set('Retry-After', String(ticket.retryAfterS));
            return res.status(429).json({
                success: false,
                code: 'QUEUE',
                retry_after: ticket.retryAfterS,
                error: 'Forte affluence : vous êtes dans la file d\'attente.',
            });
        }
        try {
            return await fn();
        } finally {
            leave();
        }
    }

    return { guard, stats: () => ({ active, maxConcurrent: MAX_CONCURRENT, maxPerSecond: MAX_PER_SECOND }) };
}

module.exports = { createAdmission };
