// ═══════════════════════════════════════════════════════════════════════════
// ─── CATALOGUE PUBLIC (lectures massives, cacheables) ─────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// Le catalogue et les pages événement sont les pages les plus lues, surtout
// pendant un pic de ventes. Plutôt que chaque visiteur interroge la base :
//   * filtres et pagination faits en base (le navigateur ne télécharge plus
//     tous les événements) ;
//   * cache mémoire très court par instance (absorbe les rafales) ;
//   * en-têtes Cache-Control pour qu'un CDN serve l'essentiel du trafic.
// Le stock affiché peut avoir quelques secondes de retard : sans risque, la
// réservation des places est toujours vérifiée en base au moment de l'achat.
// ═══════════════════════════════════════════════════════════════════════════

const MAX_CACHE_ENTRIES = 1000;
const LIST_TTL_MS = 30 * 1000;
const EVENT_TTL_MS = 10 * 1000;
const MAX_PAGE_SIZE = 50;
const PUBLIC_STATUSES = ['published', 'completed'];

function createMicroCache() {
    const entries = new Map();
    const inflight = new Map();
    return {
        /** Valeur en cache, ou calculée une seule fois même si 1000 requêtes arrivent ensemble. */
        async get(key, ttlMs, compute) {
            const hit = entries.get(key);
            if (hit && hit.expires > Date.now()) return hit.value;
            if (inflight.has(key)) return inflight.get(key);

            const promise = (async () => {
                try {
                    const value = await compute();
                    if (entries.size >= MAX_CACHE_ENTRIES) entries.delete(entries.keys().next().value);
                    entries.set(key, { value, expires: Date.now() + ttlMs });
                    return value;
                } finally {
                    inflight.delete(key);
                }
            })();
            inflight.set(key, promise);
            return promise;
        },
    };
}

/** Texte de recherche sûr pour un filtre PostgREST .or() (pas de , ( ) ni jokers). */
function sanitizeSearch(value) {
    return String(value || '').replace(/[,()*%\\_:"']/g, ' ').trim().slice(0, 60);
}

function setPublicCache(res, sMaxAge, swr) {
    res.set('Cache-Control', `public, max-age=${Math.min(sMaxAge, 30)}, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`);
}

function registerCatalogRoutes(app, { supabase }) {
    const cache = createMicroCache();

    /**
     * GET /api/public/events?country=&category=&city=&q=&page=1&limit=20
     * → { events, total, page, pages, cities }
     */
    app.get('/api/public/events', async (req, res) => {
        try {
            const country = String(req.query.country || 'Global').slice(0, 60);
            const category = String(req.query.category || 'Tous').slice(0, 60);
            const city = String(req.query.city || 'Tous').slice(0, 80);
            const q = sanitizeSearch(req.query.q);
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_PAGE_SIZE);
            const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 500);
            const key = `list:${country}|${category}|${city}|${q}|${page}|${limit}`;

            const body = await cache.get(key, LIST_TTL_MS, async () => {
                let query = supabase
                    .from('events')
                    .select('*, ticket_types(*)', { count: 'exact' })
                    .eq('status', 'published');
                if (country !== 'Global') query = query.eq('country', country);
                if (category !== 'Tous') query = query.eq('category', category);
                if (city !== 'Tous') query = query.eq('city', city);
                if (q) query = query.or(`title.ilike.%${q}%,city.ilike.%${q}%`);

                const from = (page - 1) * limit;
                const { data, count, error } = await query.order('date', { ascending: true }).range(from, from + limit - 1);
                if (error) throw error;

                const cities = await cache.get(`cities:${country}`, LIST_TTL_MS, async () => {
                    let cq = supabase.from('events').select('city').eq('status', 'published').limit(5000);
                    if (country !== 'Global') cq = cq.eq('country', country);
                    const { data: rows, error: cErr } = await cq;
                    if (cErr) throw cErr;
                    return [...new Set((rows || []).map(r => r.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
                });

                return {
                    success: true,
                    events: data || [],
                    total: count || 0,
                    page,
                    pages: Math.max(1, Math.ceil((count || 0) / limit)),
                    cities,
                };
            });

            setPublicCache(res, 60, 300);
            return res.json(body);
        } catch (err) {
            console.error('[Catalog] Liste échouée:', err.message);
            return res.status(500).json({ success: false, error: 'Catalogue indisponible.' });
        }
    });

    /**
     * GET /api/public/events-map?country= — repères légers pour la carte (max 500).
     */
    app.get('/api/public/events-map', async (req, res) => {
        try {
            const country = String(req.query.country || 'Global').slice(0, 60);
            const body = await cache.get(`map:${country}`, LIST_TTL_MS, async () => {
                let query = supabase
                    .from('events')
                    .select('id, slug, title, date, image, price, currency, category, city, coordinates, ticket_types(price)')
                    .eq('status', 'published')
                    .not('coordinates', 'is', null)
                    .order('date', { ascending: true })
                    .limit(500);
                if (country !== 'Global') query = query.eq('country', country);
                const { data, error } = await query;
                if (error) throw error;
                return { success: true, events: data || [] };
            });
            setPublicCache(res, 60, 300);
            return res.json(body);
        } catch (err) {
            console.error('[Catalog] Carte échouée:', err.message);
            return res.status(500).json({ success: false, error: 'Carte indisponible.' });
        }
    });

    /**
     * GET /api/public/events/:slug — page événement (par slug ou identifiant).
     * Seuls les événements publiés ou terminés sont servis ici ; un brouillon
     * reste visible par son organisateur via l'accès direct à la base.
     */
    app.get('/api/public/events/:slug', async (req, res) => {
        try {
            const slug = String(req.params.slug || '').slice(0, 200);
            const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug);
            const event = await cache.get(`event:${slug}`, EVENT_TTL_MS, async () => {
                const { data, error } = await supabase
                    .from('events')
                    .select('*, ticket_types(*), profiles(name, company, avatar)')
                    .eq(isUuid ? 'id' : 'slug', slug)
                    .in('status', PUBLIC_STATUSES)
                    .maybeSingle();
                if (error) throw error;
                return data;
            });
            if (!event) {
                res.set('Cache-Control', 'public, max-age=10, s-maxage=10');
                return res.status(404).json({ success: false, error: 'Événement introuvable.' });
            }
            setPublicCache(res, 10, 60);
            return res.json({ success: true, event });
        } catch (err) {
            console.error('[Catalog] Événement échoué:', err.message);
            return res.status(500).json({ success: false, error: 'Événement indisponible.' });
        }
    });

    /**
     * GET /api/public/highlights?country=…  — derniers événements terminés, pour
     * que l'accueil ne soit jamais vide quand rien n'est à venir. Si le pays n'en
     * a pas, on prend ceux de tous les pays.
     */
    app.get('/api/public/highlights', async (req, res) => {
        try {
            const country = String(req.query.country || 'Global').slice(0, 60);
            const events = await cache.get(`highlights:${country}`, 5 * 60 * 1000, async () => {
                const run = async (withCountry) => {
                    let query = supabase
                        .from('events')
                        .select('id, slug, title, date, image, price, currency, category, city, country, location, status, ticket_types(price)')
                        .eq('status', 'completed')
                        .order('date', { ascending: false })
                        .limit(8);
                    if (withCountry) query = query.eq('country', country);
                    const { data, error } = await query;
                    if (error) throw error;
                    return data || [];
                };
                const local = country !== 'Global' ? await run(true) : [];
                return local.length > 0 ? local : run(false);
            });
            setPublicCache(res, 300, 600);
            return res.json({ success: true, events });
        } catch (err) {
            console.error('[Catalog] Moments forts échoués:', err.message);
            return res.status(500).json({ success: false, error: 'Indisponible.' });
        }
    });

    /** GET /api/public/stats — chiffres publics (billets émis), mis en cache 1 h. */
    app.get('/api/public/stats', async (req, res) => {
        try {
            const stats = await cache.get('stats', 60 * 60 * 1000, async () => {
                const { count, error } = await supabase.from('tickets').select('id', { count: 'estimated', head: true });
                if (error) throw error;
                return { tickets_issued: count || 0 };
            });
            setPublicCache(res, 3600, 3600);
            return res.json({ success: true, ...stats });
        } catch (err) {
            console.error('[Catalog] Statistiques échouées:', err.message);
            return res.status(500).json({ success: false, error: 'Indisponible.' });
        }
    });
}

module.exports = { registerCatalogRoutes, createMicroCache, sanitizeSearch };
