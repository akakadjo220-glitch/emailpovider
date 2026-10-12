// ═══════════════════════════════════════════════════════════════════════════
// ─── MONITORING : MÉTRIQUES, SANTÉ, ERREURS ───────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
//   * /metrics  : format Prometheus (Grafana, Better Stack, Datadog…), protégé
//                 par METRICS_TOKEN (Authorization: Bearer …). Sans jeton : 404.
//   * /ready    : vérifie que la base répond (sonde de disponibilité du proxy /
//                 orchestrateur) ; /health reste une simple sonde de vie.
//   * Sentry    : activé si SENTRY_DSN est défini ET le paquet @sentry/node installé.
// Les métriques sont propres à chaque instance : l'outil de collecte les agrège.
// ═══════════════════════════════════════════════════════════════════════════

const LATENCY_BUCKETS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function labelKey(labels = {}) {
    return Object.keys(labels).sort().map(k => `${k}="${String(labels[k]).replace(/["\\\n]/g, '_')}"`).join(',');
}

function createMetrics() {
    const counters = new Map();      // name → Map(labelKey → value)
    const histograms = new Map();    // name → Map(labelKey → { buckets[], sum, count })
    const startedAt = Date.now();

    function inc(name, labels = {}, value = 1) {
        if (!counters.has(name)) counters.set(name, new Map());
        const series = counters.get(name);
        const key = labelKey(labels);
        series.set(key, (series.get(key) || 0) + value);
    }

    function observe(name, labels, ms) {
        if (!histograms.has(name)) histograms.set(name, new Map());
        const series = histograms.get(name);
        const key = labelKey(labels);
        let h = series.get(key);
        if (!h) {
            h = { buckets: LATENCY_BUCKETS_MS.map(() => 0), sum: 0, count: 0 };
            series.set(key, h);
        }
        LATENCY_BUCKETS_MS.forEach((b, i) => { if (ms <= b) h.buckets[i] += 1; });
        h.sum += ms;
        h.count += 1;
    }

    /** Middleware : compte chaque requête par route (motif, pas l'URL réelle) et statut. */
    function middleware(req, res, next) {
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            const ms = Number(process.hrtime.bigint() - start) / 1e6;
            const route = req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : (res.statusCode === 404 ? 'unmatched' : 'other');
            const labels = { method: req.method, route, status: String(Math.floor(res.statusCode / 100)) + 'xx' };
            inc('http_requests_total', labels);
            observe('http_request_duration_ms', { method: req.method, route }, ms);
            if (ms > 3000) console.warn(`[Slow] ${req.method} ${route} ${Math.round(ms)} ms (statut ${res.statusCode})`);
        });
        next();
    }

    function render(extraGauges = {}) {
        const lines = [];
        lines.push('# TYPE process_uptime_seconds gauge', `process_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`);
        const mem = process.memoryUsage();
        lines.push('# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${mem.rss}`);
        for (const [name, series] of counters) {
            lines.push(`# TYPE ${name} counter`);
            for (const [key, value] of series) lines.push(`${name}${key ? `{${key}}` : ''} ${value}`);
        }
        for (const [name, series] of histograms) {
            lines.push(`# TYPE ${name} histogram`);
            for (const [key, h] of series) {
                const prefix = key ? `${key},` : '';
                LATENCY_BUCKETS_MS.forEach((b, i) => lines.push(`${name}_bucket{${prefix}le="${b}"} ${h.buckets[i]}`));
                lines.push(`${name}_bucket{${prefix}le="+Inf"} ${h.count}`);
                lines.push(`${name}_sum${key ? `{${key}}` : ''} ${Math.round(h.sum)}`);
                lines.push(`${name}_count${key ? `{${key}}` : ''} ${h.count}`);
            }
        }
        for (const [name, value] of Object.entries(extraGauges)) {
            if (typeof value === 'number' && Number.isFinite(value)) lines.push(`# TYPE ${name} gauge`, `${name} ${value}`);
        }
        return lines.join('\n') + '\n';
    }

    return { inc, observe, middleware, render };
}

/**
 * Enregistre /metrics et /ready. getGauges() fournit des jauges calculées à la
 * demande (profondeur des files, commandes en attente…).
 */
function registerMonitoringRoutes(app, { supabase, metrics, getGauges }) {
    const token = process.env.METRICS_TOKEN;

    app.get('/metrics', async (req, res) => {
        if (!token || req.headers.authorization !== `Bearer ${token}`) return res.status(404).end();
        let gauges = {};
        try { gauges = await getGauges(); } catch (err) { console.error('[Metrics] Jauges :', err.message); }
        res.set('Content-Type', 'text/plain; version=0.0.4');
        res.set('Cache-Control', 'no-store');
        return res.send(metrics.render(gauges));
    });

    app.get('/ready', async (req, res) => {
        const start = Date.now();
        try {
            const { error } = await supabase.from('platform_settings').select('key').limit(1);
            if (error) throw error;
            return res.status(200).json({ status: 'ready', db_ms: Date.now() - start });
        } catch (err) {
            return res.status(503).json({ status: 'not_ready', error: 'database_unreachable' });
        }
    });
}

/** Sentry facultatif : aucun impact si non configuré ou paquet absent. */
function initSentry() {
    if (!process.env.SENTRY_DSN) return null;
    try {
        // eslint-disable-next-line global-require
        const Sentry = require('@sentry/node');
        Sentry.init({
            dsn: process.env.SENTRY_DSN,
            environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
            tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.05),
        });
        console.log('[Sentry] Activé.');
        return Sentry;
    } catch {
        console.warn('[Sentry] SENTRY_DSN défini mais @sentry/node n\'est pas installé (npm i @sentry/node).');
        return null;
    }
}

module.exports = { createMetrics, registerMonitoringRoutes, initSentry };
