-- 20260523000100_init_extensions_and_enums.sql
--
-- Purpose:
-- 1) Bootstrap basic Postgres capabilities we will rely on.
-- 2) Define enums for run/node statuses (explicit state machine states).
--
-- Why enums:
-- - They make illegal states harder to represent.
-- - They make status values consistent across services.
-- - Tradeoff: changing enums requires migrations (which is fine).

BEGIN;

-- UUID generation. gen_random_uuid() is provided by pgcrypto.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_run_status') THEN
    CREATE TYPE workflow_run_status AS ENUM (
      'PENDING',
      'RUNNING',
      'PAUSED',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'node_run_status') THEN
    CREATE TYPE node_run_status AS ENUM (
      'READY',
      'IN_PROGRESS',
      'SUCCEEDED',
      'FAILED_RETRYABLE',
      'FAILED_FINAL',
      'SKIPPED'
    );
  END IF;
END $$;

COMMIT;
