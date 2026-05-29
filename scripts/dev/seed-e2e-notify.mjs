import "dotenv/config";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL missing");

const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query("begin");

    // Create or reuse tenant.
    const slug = "e2e";
    const tenant = await client.query(
      `insert into tenants (slug, name)
       values ($1, $2)
       on conflict (slug) do update set name = excluded.name
       returning id, slug`,
      [slug, "E2E Tenant"],
    );
    const tenantId = tenant.rows[0].id;

    // Create a workflow.
    const wf = await client.query(
      `insert into workflows (tenant_id, name, draft_graph)
       values ($1, $2, '{}'::jsonb)
       returning id`,
      [tenantId, "E2E Notify Workflow"],
    );
    const workflowId = wf.rows[0].id;

    // Draft/publish graph:
    // delay(1s) -> http_request -> condition -> notify
    const graph = {
      entry_node_id: "delay1",
      nodes: [
        { id: "delay1", type: "delay", config: { seconds: 1 } },
        {
          id: "http1",
          type: "http_request",
          config: {
            method: "GET",
            url: "http://example.com",
          },
        },
        {
          id: "cond1",
          type: "condition",
          config: {
            base: "context",
            path: "nodes.http1.output.status",
            op: "eq",
            value: 200,
          },
        },
        {
          id: "notify1",
          type: "notify",
          config: {
            provider: "email",
            to: "test@example.com",
            subject: "Flow E2E Notify",
            context_path: "nodes.http1.output",
          },
        },
      ],
      edges: [
        { from: "delay1", to: "http1" },
        { from: "http1", to: "cond1" },
        // If condition true => notify, else end.
        { from: "cond1", when: "true", to: "notify1" },
      ],
    };

    await client.query(
      `update workflows set draft_graph = $3::jsonb, draft_updated_at = now(), updated_at = now()
        where tenant_id = $1 and id = $2`,
      [tenantId, workflowId, JSON.stringify(graph)],
    );

    const nextVer = await client.query(
      "select coalesce(max(version), 0) + 1 as v from workflow_versions where workflow_id = $1",
      [workflowId],
    );
    const version = Number(nextVer.rows[0].v);

    const ver = await client.query(
      `insert into workflow_versions (tenant_id, workflow_id, version, graph)
       values ($1, $2, $3, $4::jsonb)
       returning id`,
      [tenantId, workflowId, version, JSON.stringify(graph)],
    );
    const versionId = ver.rows[0].id;

    await client.query("commit");

    console.log(
      JSON.stringify(
        {
          tenant: { id: tenantId, slug },
          workflow: { id: workflowId, name: "E2E Notify Workflow" },
          version: { id: versionId, version },
        },
        null,
        2,
      ),
    );
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error(e);
    pool.end().finally(() => process.exit(1));
  });
