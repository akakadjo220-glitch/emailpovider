/**
 * Script de création de la table email_queue via l'API Supabase
 * Exécuter avec: node create_email_queue.cjs
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://supabasekong-pb8ykq5lxueompxiu9p5ust2.51.255.162.88.sslip.io';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
    console.error('❌ SUPABASE_SERVICE_ROLE_KEY est manquant dans le fichier .env');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function run() {
    console.log('🚀 Création de la table email_queue...');

    // Test de connexion simple - on insère rien, on vérifie juste si la table existe
    const { error: testError } = await supabase
        .from('email_queue')
        .select('id')
        .limit(1);

    if (!testError || testError.code !== '42P01') {
        // Table existe déjà ou autre erreur
        if (!testError) {
            console.log('✅ La table email_queue existe déjà. Rien à faire.');
            return;
        }
        console.error('❌ Erreur inattendue:', testError.message);
        return;
    }

    // Table n'existe pas (42P01 = undefined_table) → on la crée via un fetch direct
    console.log('🔧 Table introuvable, création via fetch REST...');

    const sql = `
CREATE TABLE IF NOT EXISTS public.email_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    smtp_config JSONB NOT NULL,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    html_body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    error_msg TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_email_queue_status ON public.email_queue (status, created_at);
ALTER TABLE public.email_queue ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='email_queue' AND policyname='Server only access') THEN
    CREATE POLICY "Server only access" ON public.email_queue FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
    `.trim();

    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
            'apikey': SERVICE_ROLE_KEY,
        },
        body: JSON.stringify({ query: sql }),
    });

    if (!response.ok) {
        // exec_sql n'existe peut-être pas. Instructions manuelles.
        console.log('');
        console.log('⚠️  Impossible d\'exécuter le SQL automatiquement.');
        console.log('👉 Copiez-collez manuellement ce SQL dans l\'éditeur SQL de Supabase :');
        console.log('');
        console.log(sql);
        console.log('');
    } else {
        console.log('✅ Table email_queue créée avec succès !');
    }
}

run().catch(console.error);
