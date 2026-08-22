CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS weekly_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  owner_id text,
  epoch_id text NOT NULL,
  execution_provider text NOT NULL DEFAULT 'BDEX'
    CHECK (execution_provider IN ('BDEX')),
  feed_ranking_provider text NOT NULL DEFAULT 'DETERMINISTIC'
    CHECK (feed_ranking_provider IN ('DETERMINISTIC')),
  chain text NOT NULL DEFAULT 'BOTCHAIN'
    CHECK (chain IN ('BOTCHAIN')),
  status text NOT NULL CHECK (
    status IN (
      'OPEN', 'SWIPING', 'REVIEW', 'AWAITING_SIGNATURE',
      'SUBMITTED', 'SETTLED', 'PARTIAL', 'FAILED', 'CLOSED'
    )
  ),
  execution_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wallet, epoch_id, chain, execution_provider, feed_ranking_provider)
);

CREATE TABLE IF NOT EXISTS executions (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES weekly_sessions(id),
  authorized_plan_hash text NOT NULL UNIQUE,
  execution_provider text NOT NULL DEFAULT 'BDEX'
    CHECK (execution_provider IN ('BDEX')),
  chain text NOT NULL DEFAULT 'BOTCHAIN'
    CHECK (chain IN ('BOTCHAIN')),
  plan jsonb NOT NULL,
  status text NOT NULL CHECK (
    status IN ('PREPARED', 'SUBMITTED', 'SETTLED', 'PARTIAL', 'FAILED')
  ),
  transaction_hashes text[] NOT NULL DEFAULT '{}',
  submission_mode text NOT NULL DEFAULT 'SEQUENTIAL'
    CHECK (submission_mode IN ('SEQUENTIAL', 'BATCH')),
  settled_outputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id)
);

ALTER TABLE weekly_sessions
  DROP CONSTRAINT IF EXISTS weekly_sessions_execution_id_fkey;

ALTER TABLE weekly_sessions
  ADD CONSTRAINT weekly_sessions_execution_id_fkey
  FOREIGN KEY (execution_id) REFERENCES executions(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS executions_status_idx ON executions(status);

CREATE TABLE IF NOT EXISTS user_preferences (
  wallet text PRIMARY KEY CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  owner_id text,
  execution_provider text NOT NULL DEFAULT 'BDEX'
    CHECK (execution_provider IN ('BDEX')),
  preferences jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_preferences_owner_id_idx
  ON user_preferences(owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS asset_metadata_cache (
  cache_key text PRIMARY KEY,
  provider text NOT NULL,
  snapshot jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asset_metadata_cache_expiry_idx
  ON asset_metadata_cache(expires_at);
