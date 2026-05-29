import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const mailhogBaseUrl = process.env.MAILHOG_BASE_URL ?? "http://localhost:8025";
const suffix = `${Date.now()}`;
const tenantSlug = `smoke-${suffix}`;
const tenantName = `Smoke ${suffix}`;
const email = `smoke-${suffix}@example.com`;
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

async function poll(checkFn, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await checkFn();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error("timed out waiting for condition");
}

async function main() {
  const register = await request("/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({
      tenant: { slug: tenantSlug, name: tenantName },
      user: { name: "Smoke Owner", email, password },
    }),
  });

  const token = register.api_key.token;
  assert.equal(register.role, "owner");

  const authHeaders = {
    authorization: `Bearer ${token}`,
  };

  const workflow = await request("/v1/workflows", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: `Smoke Workflow ${suffix}` }),
  });

  const graph = {
    entry_node_id: "delay1",
    nodes: [
      { id: "delay1", type: "delay", config: { seconds: 1 } },
      {
        id: "http1",
        type: "http_request",
        config: { url: "http://example.com", method: "GET" },
      },
      {
        id: "cond1",
        type: "condition",
        config: {
          op: "eq",
          base: "context",
          path: "nodes.http1.output.status",
          value: 200,
        },
      },
      {
        id: "notify1",
        type: "notify",
        config: {
          provider: "email",
          to: email,
          subject: "Flow Smoke Notify",
          context_path: "nodes.http1.output",
        },
      },
    ],
    edges: [
      { from: "delay1", to: "http1" },
      { from: "http1", to: "cond1" },
      { from: "cond1", to: "notify1", when: "true" },
    ],
  };

  await request(`/v1/workflows/${workflow.id}`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({ draft_graph: graph }),
  });

  const published = await request(`/v1/workflows/${workflow.id}/publish`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ draft_graph: graph }),
  });

  const run = await request(
    `/v1/workflows/${workflow.id}/versions/${published.id}/runs`,
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        input: {
          email: { to: email },
          hello: "world",
        },
      }),
    },
  );

  const finished = await poll(async () => {
    const current = await request(`/v1/runs/${run.id}`, {
      headers: authHeaders,
    });
    return current.status === "SUCCEEDED"
      ? current
      : current.status === "FAILED"
        ? current
        : null;
  });

  assert.equal(finished.status, "SUCCEEDED");

  const logs = await request(`/v1/runs/${run.id}/node-runs`, {
    headers: authHeaders,
  });
  assert.equal(logs.items.length >= 4, true);

  const message = await poll(
    async () => {
      const res = await fetch(`${mailhogBaseUrl}/api/v2/messages`);
      const payload = await res.json();
      return (
        payload.items.find((item) => {
          const to = item?.Content?.Headers?.To?.[0] ?? "";
          const subject = item?.Content?.Headers?.Subject?.[0] ?? "";
          return to === email && subject === "Flow Smoke Notify";
        }) ?? null
      );
    },
    { timeoutMs: 30000, intervalMs: 1000 },
  );

  assert.ok(message, "expected MailHog to contain the notification email");

  console.log(
    JSON.stringify(
      {
        ok: true,
        tenant: register.tenant.id,
        workflow: workflow.id,
        version: published.id,
        run: run.id,
        message_id: message.ID,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
