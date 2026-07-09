-- ═══════════════════════════════════════════════════════════════════════════
-- ─── DATABASE PERFORMANCE OPTIMIZATION INDEXES ────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════════
-- Ce script ajoute des index stratégiques pour accélérer les requêtes et
-- supporter des milliards d'enregistrements/connexions simultanées sur Babipass.

-- 1. Optimisations pour la table 'tickets'
CREATE INDEX IF NOT EXISTS idx_tickets_event_id_status 
  ON tickets(event_id, status);

CREATE INDEX IF NOT EXISTS idx_tickets_guest_email 
  ON tickets(guest_email);

-- 2. Optimisations pour la table 'transactions'
CREATE INDEX IF NOT EXISTS idx_transactions_event_id_status 
  ON transactions(event_id, status);

CREATE INDEX IF NOT EXISTS idx_transactions_created_at 
  ON transactions(created_at DESC);

-- 3. Optimisations pour la table 'email_queue'
CREATE INDEX IF NOT EXISTS idx_email_queue_status_sent 
  ON email_queue(status, sent_at) 
  WHERE status = 'pending';

-- 4. Optimisations pour la table 'auth_otps'
CREATE INDEX IF NOT EXISTS idx_auth_otps_email 
  ON auth_otps(email);

-- 5. Optimisations pour la table 'profiles'
CREATE INDEX IF NOT EXISTS idx_profiles_email 
  ON profiles(email);

CREATE INDEX IF NOT EXISTS idx_profiles_phone 
  ON profiles(phone);
