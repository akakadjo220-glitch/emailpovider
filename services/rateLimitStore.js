// ═══════════════════════════════════════════════════════════════════════════
// ─── LIMITATION DE DÉBIT PARTAGÉE (express-rate-limit → Postgres) ─────────
// ═══════════════════════════════════════════════════════════════════════════
// Avec plusieurs instances du serveur, un compteur en mémoire est propre à
// chaque instance : un attaquant obtient N fois la limite. Ce store garde les
// compteurs dans Postgres (rate_limit_hit), partagés par toutes les instances.
// En cas d'erreur base, la requête passe (passOnStoreError) plutôt que de
// bloquer tout le service.
// ═══════════════════════════════════════════════════════════════════════════

class PostgresRateLimitStore {
    constructor(supabase, prefix) {
        this.supabase = supabase;
        this.prefix = prefix;
        this.windowSeconds = 60;
        this.localKeys = false;
    }

    init(options) {
        this.windowSeconds = Math.max(1, Math.ceil(options.windowMs / 1000));
    }

    async increment(key) {
        const { data, error } = await this.supabase.rpc('rate_limit_hit', {
            p_key: `${this.prefix}:${key}`,
            p_window_seconds: this.windowSeconds,
        });
        if (error) throw new Error(`rate_limit_hit: ${error.message}`);
        return { totalHits: data.hits, resetTime: new Date(data.reset_at) };
    }

    async decrement(key) {
        await this.supabase.rpc('rate_limit_decrement', {
            p_key: `${this.prefix}:${key}`,
            p_window_seconds: this.windowSeconds,
        });
    }

    async resetKey(key) {
        await this.supabase.rpc('rate_limit_reset', { p_key: `${this.prefix}:${key}` });
    }
}

/**
 * Fabrique de limiteurs partagés. Chaque limiteur reçoit son propre préfixe.
 * RATE_LIMIT_STORE=memory revient au comportement par instance (dev local).
 */
function createSharedRateLimit(rateLimit, supabase) {
    let counter = 0;
    const useMemory = process.env.RATE_LIMIT_STORE === 'memory';
    return function sharedRateLimit({ prefix, ...options }) {
        counter += 1;
        if (useMemory) return rateLimit(options);
        return rateLimit({
            ...options,
            store: new PostgresRateLimitStore(supabase, prefix || `rl${counter}`),
            passOnStoreError: true,
        });
    };
}

module.exports = { PostgresRateLimitStore, createSharedRateLimit };
