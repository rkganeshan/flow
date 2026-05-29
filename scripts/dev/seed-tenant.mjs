import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const slug = (process.env.TENANT_SLUG ?? "acme").trim();
const name = (process.env.TENANT_NAME ?? "Acme").trim();

const pool = new Pool({ connectionString: databaseUrl });

try {
  const r = await pool.query(
    `insert into tenants (slug, name)
     values ($1, $2)
     on conflict (slug) do update set name = excluded.name
     returning id, slug, name, created_at`,
    [slug, name],
  );

  console.log(JSON.stringify(r.rows[0], null, 2));
} finally {
  await pool.end();
}
