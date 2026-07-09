/**
 * run_email_queue_migration.cjs
 *
 * Usage (depuis le VPS dans le dossier /server) :
 *   node run_email_queue_migration.cjs
 *
 * Ou depuis votre PC local en passant la clé manuellement :
 *   node run_email_queue_migration.cjs VOTRE_SERVICE_ROLE_KEY_ICI
 */

require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL
    || 'https://supabasekong-l4cw40oks4kso84ko44ogkkw.188.241.58.227.sslip.io';

// Accept key from .env OR as a command-line argument (for local testing)
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.argv[2];

if (!SERVICE_ROLE_KEY) {
    console.error('\n[ERREUR] Passez la SERVICE_ROLE_KEY comme argument :');
    console.error('  node run_email_queue_migration.cjs VOTRE_SERVICE_ROLE_KEY\n');
    process.exit(1);
}

const SQL = `
CREATE TABLE IF NOT EXISTS public.email_queue (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    smtp_config    JSONB       NOT NULL,
    to_email       TEXT        NOT NULL,
    subject        TEXT        NOT NULL,
    html_body      TEXT        NOT NULL,
    status         TEXT        NOT NULL DEFAULT 'pending',
    attempts       INT         NOT NULL DEFAULT 0,
    error_msg      TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_email_queue_status_created
    ON public.email_queue (status, created_at);
ALTER TABLE public.email_queue ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'email_queue'
    AND policyname = 'Server only access'
  ) THEN
    CREATE POLICY "Server only access"
      ON public.email_queue
      FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $do$;
`;

async function tryPgMeta() {
    const url = `${SUPABASE_URL}/pg-meta/v1/query`;
    console.log(' [1/2] Tentative pg-meta:', url);
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ query: SQL }),
    });
    if (res.ok) return true;
    const body = await res.text();
    console.warn('     pg-meta reponse', res.status, ':', body.slice(0, 300));
    return false;
}

async function tryStudioSql() {
    // Supabase self-hosted Studio API endpoint
    const url = `${SUPABASE_URL}/studio/api/projects/default/run-sql`;
    console.log(' [2/2] Tentative Studio API:', url);
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ sql: SQL }),
    });
    if (res.ok) return true;
    const body = await res.text();
    console.warn('     Studio API reponse', res.status, ':', body.slice(0, 300));
    return false;
}

async function main() {
    console.log('\n========================================');
    console.log('  Babipass - Migration email_queue');
    console.log('========================================\n');

    if (await tryPgMeta()) {
        console.log('\n[OK] email_queue cree avec succes via pg-meta !');
        return;
    }

    if (await tryStudioSql()) {
        console.log('\n[OK] email_queue cree avec succes via Studio API !');
        return;
    }

    // All automatic methods failed - print manual instructions
    console.log('\n========================================');
    console.log('  ACTION MANUELLE REQUISE');
    console.log('========================================');
    console.log('\nConnectez-vous a votre Supabase Studio et executez ce SQL :');
    console.log('(Studio URL: http://188.241.58.227 ou le port de votre Studio self-hosted)\n');
    console.log('---- COPIEZ CE SQL ----');
    console.log(SQL.trim());
    console.log('---- FIN SQL ----\n');
    process.exit(1);
}

main().catch(err => {
    console.error('\n[FATAL]', err.message);
    process.exit(1);
});
