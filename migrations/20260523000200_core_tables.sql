-- 20260523000200_core_tables.sql
--
-- Purpose:
-- Create the minimal set of tables that make Flow a durable orchestration engine.
--
-- Design principles:
-- 1) Postgres is authoritative state.
-- 2) Use UNIQUE constraints for dedupe/correctness.
-- 3) Keep status/timestamps relational; keep configs/logs in JSONB.

BEGIN;

-- ----------
-- Tenancy
-- ----------
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------
-- Workflow definitions
-- ----------
CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,

  -- Draft graph (mutable)
  draft_graph JSONB NOT NULL DEFAULT '{}'::jsonb,
  draft_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflows_tenant_id ON workflows(tenant_id);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,

  version INT NOT NULL,
  graph JSONB NOT NULL,

  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Optional metadata
  created_by_user_id UUID NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_workflow_versions_workflow_version UNIQUE (workflow_id, version)
);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow_id ON workflow_versions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_versions_tenant_published_at ON workflow_versions(tenant_id, published_at DESC);

-- ----------
-- Trigger ingestion dedupe
-- ----------
CREATE TABLE IF NOT EXISTS trigger_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  source TEXT NOT NULL CHECK (source IN ('webhook', 'schedule')),
  dedupe_key TEXT NOT NULL,

  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_trigger_events_dedupe UNIQUE (tenant_id, source, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_trigger_events_tenant_created_at ON trigger_events(tenant_id, created_at DESC);

-- ----------
-- Execution state (durable state machine)
-- ----------
CREATE TABLE IF NOT EXISTS workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_version_id UUID NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,

  trigger_event_id UUID NULL REFERENCES trigger_events(id) ON DELETE SET NULL,

  status workflow_run_status NOT NULL,

  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  error JSONB NULL,

  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- If a run is created from a trigger_event, this prevents duplicates.
  -- (NULL trigger_event_id means ad-hoc/manual runs; those are not deduped here.)
  CONSTRAINT uq_workflow_runs_trigger UNIQUE (tenant_id, workflow_version_id, trigger_event_id)
);

-- Note: UNIQUE allows multiple NULLs; that's fine for manual runs.

CREATE INDEX IF NOT EXISTS idx_workflow_runs_tenant_created_at ON workflow_runs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_version_id ON workflow_runs(workflow_version_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

CREATE TABLE IF NOT EXISTS node_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,

  -- Stable within a workflow_version. For MVP DAG semantics, (workflow_run_id, node_id) is unique.
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,

  status node_run_status NOT NULL,

  attempt INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,

  queued_at TIMESTAMPTZ NULL,
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,

  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB NULL,
  outcome TEXT NULL,
  error JSONB NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_node_runs_run_node UNIQUE (workflow_run_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_node_runs_run_id ON node_runs(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_node_runs_status ON node_runs(status);
CREATE INDEX IF NOT EXISTS idx_node_runs_tenant_status ON node_runs(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_node_runs_tenant_queued_at ON node_runs(tenant_id, queued_at);

-- High-cardinality logs (append-only)
CREATE TABLE IF NOT EXISTS node_run_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  node_run_id UUID NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,

  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_node_run_logs_node_run_ts ON node_run_logs(node_run_id, ts);

COMMIT;
