#!/usr/bin/env node
import { Pool } from "pg";
import { Queue } from "bullmq";
import cronParser from "cron-parser";

const POLL_INTERVAL_MS = Number(process.env.SCHEDULER_POLL_MS ?? 30000);
const RELOAD_SCHEDULES_MS = Number(process.env.SCHEDULER_RELOAD_MS ?? 60000);

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}
if (!REDIS_URL) {
  console.error("Missing REDIS_URL");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });
const queue = new Queue("run_requests", { connection: { url: REDIS_URL } });

let schedules = [];
let lastPoll = new Date(Date.now() - POLL_INTERVAL_MS - 1000);

async function loadSchedules() {
  const r = await pool.query(
    `SELECT DISTINCT ON (workflow_id) id as workflow_version_id, tenant_id, workflow_id, graph
     FROM workflow_versions
     WHERE (graph->'trigger'->>'schedule_cron' IS NOT NULL OR graph->'trigger'->>'cron' IS NOT NULL)
     ORDER BY workflow_id, published_at DESC`,
  );
  return r.rows
    .map((row) => {
      const graph = row.graph ?? {};
      const cron = graph?.trigger?.schedule_cron ?? graph?.trigger?.cron;
      const enabled = graph?.trigger?.enabled !== false;
      return {
        workflow_version_id: row.workflow_version_id,
        workflow_id: row.workflow_id,
        tenant_id: row.tenant_id,
        cron,
        enabled,
      };
    })
    .filter((s) => s.cron && s.enabled);
}

async function fireSchedule(schedule, occurrence) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const dedupeKey = `${schedule.workflow_version_id}-${occurrence.toISOString()}`;
    const te = await client.query(
      `insert into trigger_events (tenant_id, source, dedupe_key, payload)
         values ($1, 'schedule', $2, $3::jsonb)
         on conflict (tenant_id, source, dedupe_key)
         do update set payload = trigger_events.payload
         returning id`,
      [
        schedule.tenant_id,
        dedupeKey,
        JSON.stringify({
          scheduled_at: occurrence.toISOString(),
          cron: schedule.cron,
        }),
      ],
    );

    const triggerEventId = te.rows[0].id;

    const run = await client.query(
      `insert into workflow_runs (
           tenant_id, workflow_version_id, trigger_event_id,
           status, input, started_at, updated_at
         )
         values ($1, $2, $3, 'PENDING'::workflow_run_status, '{}'::jsonb, null, now())
         on conflict (tenant_id, workflow_version_id, trigger_event_id)
         do update set updated_at = now()
         returning id`,
      [schedule.tenant_id, schedule.workflow_version_id, triggerEventId],
    );

    await client.query("COMMIT");

    try {
      const job = await queue.add(
        "schedule",
        {
          tenant_id: schedule.tenant_id,
          run_id: run.rows[0].id,
          workflow_version_id: schedule.workflow_version_id,
        },
        {
          jobId: `trigger_event-${triggerEventId}`,
          removeOnComplete: 1000,
          removeOnFail: 1000,
        },
      );
      console.log(
        `enqueued schedule job ${String(job.id)} -> trigger_event ${triggerEventId}`,
      );
    } catch (e) {
      console.warn(
        "failed to enqueue schedule job (best-effort):",
        e?.message ?? e,
      );
    }
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("failed to create scheduled run:", e?.message ?? e);
  } finally {
    client.release();
  }
}

async function pollOnce() {
  const now = new Date();
  for (const s of schedules) {
    try {
      const interval = cronParser.parseExpression(s.cron, { currentDate: now });
      const prev = interval.prev();
      if (prev && prev.getTime() > lastPoll.getTime()) {
        await fireSchedule(s, prev);
      }
    } catch (e) {
      console.error(
        `cron parse/exec error for ${s.workflow_version_id}:`,
        e?.message ?? e,
      );
    }
  }
  lastPoll = now;
}

async function main() {
  console.log("scheduler starting");
  schedules = await loadSchedules();
  console.log(`loaded ${schedules.length} schedules`);

  // periodic reload of schedules
  setInterval(async () => {
    try {
      schedules = await loadSchedules();
      // console.log for visibility in container logs
      console.log(`reloaded ${schedules.length} schedules`);
    } catch (e) {
      console.error("failed to reload schedules:", e?.message ?? e);
    }
  }, RELOAD_SCHEDULES_MS).unref();

  // main poll loop
  setInterval(async () => {
    try {
      await pollOnce();
    } catch (e) {
      console.error("scheduler poll failed:", e?.message ?? e);
    }
  }, POLL_INTERVAL_MS).unref();

  process.on("SIGINT", async () => {
    console.log("scheduler shutting down");
    await queue.close();
    await pool.end();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
