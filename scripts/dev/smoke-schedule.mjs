import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const mailhogBaseUrl = process.env.MAILHOG_BASE_URL ?? "http://localhost:8025";
const suffix = `${Date.now()}`;
const tenantSlug = `smoke-sched-${suffix}`;
const tenantName = `Smoke Schedule ${suffix}`;
const email = `smoke-sched-${suffix}@example.com`;
const password = "Password123!";

async function request(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }

  return body;
}

async function poll(checkFn, { timeoutMs = 180000, intervalMs = 2000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await checkFn();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error("timed out waiting for condition");
}

async function main() {
  let register;
  let workflow;
  let published;
  let authHeaders;
  const graph = {
    trigger: { schedule_cron: "* * * * *", enabled: true },
    entry_node_id: "delay1",
    nodes: [
      { id: "delay1", type: "delay", config: { seconds: 1 } },
      {
        id: "http1",
        type: "http_request",
        config: { url: "http://example.com", method: "GET" },
      },
      {
        id: "notify1",
        type: "notify",
        config: {
          provider: "email",
          to: email,
          subject: "Flow Schedule Notify",
          context_path: "nodes.http1.output",
        },
      },
    ],
    edges: [
      { from: "delay1", to: "http1" },
      { from: "http1", to: "notify1" },
    ],
  };

  try {
    console.log("creating tenant + owner user...");
    register = await request("/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({
        tenant: { slug: tenantSlug, name: tenantName },
        user: { name: "Smoke Owner", email, password },
      }),
    });

    const token = register.api_key.token;
    authHeaders = { authorization: `Bearer ${token}` };

    console.log("creating workflow with schedule cron (every minute)...");
    workflow = await request("/v1/workflows", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: `Smoke Schedule ${suffix}` }),
    });

    await request(`/v1/workflows/${workflow.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ draft_graph: graph }),
    });

    console.log("publishing workflow version...");
    published = await request(`/v1/workflows/${workflow.id}/publish`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ draft_graph: graph }),
    });

    console.log(
      "waiting for scheduled run to be created and finish (may take up to ~2 minutes)...",
    );

    const finished = await poll(
      async () => {
        const runs = await request(`/v1/runs`, { headers: authHeaders });
        if (!runs?.items) return null;
        const match = runs.items.find(
          (r) => r.workflow_version_id === published.id,
        );
        if (!match) return null;
        const current = await request(`/v1/runs/${match.id}`, {
          headers: authHeaders,
        });
        return current.status === "SUCCEEDED"
          ? current
          : current.status === "FAILED"
            ? current
            : null;
      },
      { timeoutMs: 180000, intervalMs: 3000 },
    );

    assert.equal(finished.status, "SUCCEEDED");

    console.log("verifying MailHog for notification email...");
    const message = await poll(
      async () => {
        const res = await fetch(`${mailhogBaseUrl}/api/v2/messages`);
        const payload = await res.json();
        return (
          payload.items.find((item) => {
            const to = item?.Content?.Headers?.To?.[0] ?? "";
            const subject = item?.Content?.Headers?.Subject?.[0] ?? "";
            return to === email && subject === "Flow Schedule Notify";
          }) ?? null
        );
      },
      { timeoutMs: 90000, intervalMs: 2000 },
    );

    assert.ok(
      message,
      "expected MailHog to contain the scheduled notification email",
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          tenant: register.tenant.id,
          workflow: workflow.id,
          version: published.id,
          run: finished.id,
          message_id: message.ID,
        },
        null,
        2,
      ),
    );
  } finally {
    if (authHeaders && workflow) {
      const disabledGraph = {
        ...graph,
        trigger: { ...graph.trigger, enabled: false },
      };

      try {
        await request(`/v1/workflows/${workflow.id}`, {
          method: "PATCH",
          headers: authHeaders,
          body: JSON.stringify({ draft_graph: disabledGraph }),
        });
        await request(`/v1/workflows/${workflow.id}/publish`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ draft_graph: disabledGraph }),
        });
        console.log("cleaned up schedule by publishing a disabled version");
      } catch (cleanupError) {
        console.warn(
          "failed to clean up smoke schedule; disable or delete it manually:",
          cleanupError?.message ?? cleanupError,
        );
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
