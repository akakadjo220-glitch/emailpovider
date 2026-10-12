-- =========================================================================
-- QUOTA DE BILLETS PHYSIQUES GRATUITS (SANS SOLDE / SANS COMMISSION)
-- =========================================================================

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS free_physical_tickets_granted INT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS free_physical_tickets_used INT NOT NULL DEFAULT 0;
