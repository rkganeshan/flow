#!/usr/bin/env bash
set -euo pipefail

# Cron-triggered demo helper
# Usage (example):
# WORKFLOW_ID=... TENANT_ID=... API_KEY=... ./scripts/demo/cron-demo.sh

API_BASE=${API_BASE:-http://localhost:3000}
DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/flow_dev}
REDIS_URL=${REDIS_URL:-redis://localhost:6379}
POLL_MS=${SCHEDULER_POLL_MS:-5000}
RELOAD_MS=${SCHEDULER_RELOAD_MS:-5000}

if [ -z "${WORKFLOW_ID:-}" ] || [ -z "${TENANT_ID:-}" ] || [ -z "${API_KEY:-}" ]; then
  cat <<'USAGE'
Usage: WORKFLOW_ID=<id> TENANT_ID=<tenant_uuid> API_KEY=<token> ./scripts/demo/cron-demo.sh

Environment:
  API_BASE (default: http://localhost:3000)
  DATABASE_URL, REDIS_URL (used when running local scheduler)
  SCHEDULER_POLL_MS, SCHEDULER_RELOAD_MS (override poll times)
USAGE
  exit 1
fi

mkdir -p .tmp

echo "Starting scheduler (logs -> .tmp/scheduler.log) with poll=${POLL_MS}ms"
( export DATABASE_URL REDIS_URL SCHEDULER_POLL_MS="$POLL_MS" SCHEDULER_RELOAD_MS="$RELOAD_MS"; \
  node services/scheduler/src/cli.mjs > .tmp/scheduler.log 2>&1 ) &
SCHED_PID=$!
echo $SCHED_PID > .tmp/scheduler.pid
sleep 1
echo "Scheduler started (pid: $SCHED_PID). Waiting a moment for initialization..."
sleep 1

echo "Patching workflow draft to add cron '*/1 * * * *'..."
HTTP_CODE=$(curl -s -o /tmp/patch_resp.json -w "%{http_code}" -X PATCH "$API_BASE/v1/workflows/$WORKFLOW_ID" \
  -H "Authorization: Bearer $API_KEY" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"draft_graph":{"trigger":{"schedule_cron":"*/1 * * * *","enabled":true}}}')

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  echo "Draft patched (HTTP $HTTP_CODE)"
else
  echo "Failed to patch draft (HTTP $HTTP_CODE). Response:";
  cat /tmp/patch_resp.json; exit 1
fi

echo "Publishing workflow..."
HTTP_CODE=$(curl -s -o /tmp/publish_resp.json -w "%{http_code}" -X POST "$API_BASE/v1/workflows/$WORKFLOW_ID/publish" \
  -H "Authorization: Bearer $API_KEY" \
  -H "x-tenant-id: $TENANT_ID")

if [ "$HTTP_CODE" -ne 201 ]; then
  echo "Publish failed (HTTP $HTTP_CODE):"; cat /tmp/publish_resp.json; exit 1
fi
echo "Published. Response saved to /tmp/publish_resp.json"

if command -v jq >/dev/null 2>&1; then
  VERSION_ID=$(jq -r '.id' /tmp/publish_resp.json)
  echo "Published version id: $VERSION_ID"
else
  echo "jq not found: installed jq to extract the version id or open /tmp/publish_resp.json"
fi

echo "Tailing scheduler logs for 70 seconds to observe enqueued job..."
tail -n +1 -f .tmp/scheduler.log &
TAIL_PID=$!
sleep 70
kill $TAIL_PID || true

echo "Scheduler log (last 200 lines):"
tail -n 200 .tmp/scheduler.log || true

cat <<'SQL'
-- Run these queries (replace <TENANT_ID> and <VERSION_ID> as needed)
select id, source, dedupe_key, payload, created_at
from trigger_events
where tenant_id = '<TENANT_ID>'
order by created_at desc limit 5;

select id, workflow_version_id, status, created_at
from workflow_runs
where workflow_version_id = '<VERSION_ID>'
order by created_at desc limit 5;
SQL

echo "Demo complete. Scheduler is still running in background (pid: $SCHED_PID). To stop it: kill $SCHED_PID && rm .tmp/scheduler.pid"

exit 0
