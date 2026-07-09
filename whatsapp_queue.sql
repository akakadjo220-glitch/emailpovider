-- =========================================================================
-- SYSTEME DE FILE D'ATTENTE WHATSAPP (WHATSAPP QUEUE)
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_queue (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    phone          TEXT        NOT NULL,
    message        TEXT        NOT NULL,
    media_url      TEXT,
    status         TEXT        NOT NULL DEFAULT 'pending', -- 'pending' | 'sent' | 'failed'
    attempts       INT         NOT NULL DEFAULT 0,
    error_msg      TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at   TIMESTAMPTZ
);

-- Index pour accélérer le dépilage par le worker
CREATE INDEX IF NOT EXISTS idx_whatsapp_queue_status_created
    ON public.whatsapp_queue (status, created_at)
    WHERE status = 'pending';

-- RLS: Seul le service_role (serveur backend) a accès à cette table
ALTER TABLE public.whatsapp_queue ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'whatsapp_queue' AND policyname = 'Server only access'
  ) THEN
    CREATE POLICY "Server only access"
      ON public.whatsapp_queue
      FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;
