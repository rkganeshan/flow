#!/usr/bin/env node
/**
 * Flow SQL-first migrations (lightweight, explicit, learning-friendly)
 *
 * Why a Node script (vs dbmate/flyway)?
 * - You see the mechanics: migrations table, ordering, locking, transactions.
 * - Easy to customize as our needs evolve (per-service DB roles, safety checks).
 * - Still simple enough to understand end-to-end.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";

// Load repo-root .env for local developer ergonomics (Compose already injects env into containers).
dotenv.config();

const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const migrationsDir = path.resolve(repoRoot, "migrations");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    "Missing DATABASE_URL. Copy .env.example to .env and set DATABASE_URL.",
  );
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const showStatus = args.has("--status");
const doReset = args.has("--reset");

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      checksum_sha256 TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/**
 * Advisory lock prevents two migrators from running concurrently.
 *
 * Why this matters:
 * - Concurrent migration runners can lead to partial application or deadlocks.
 * - In prod, you run migrations as a single step in deploy pipelines.
 */
async function acquireAdvisoryLock(client) {
  // Use two signed 32-bit integers for pg_advisory_lock.
  // This avoids bigint range issues across drivers/versions.
  const hash = crypto
    .createHash("sha256")
    .update("flow-schema-migrations")
    .digest();
  const key1 = hash.readInt32BE(0);
  const key2 = hash.readInt32BE(4);
  await client.query("SELECT pg_advisory_lock($1, $2);", [key1, key2]);
  return async () => {
    await client.query("SELECT pg_advisory_unlock($1, $2);", [key1, key2]);
  };
}

async function listMigrationFiles() {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  const sqlFiles = entries
    .filter((e) => e.isFile() && e.name.match(/\.sql$/))
    .map((e) => e.name)
    .sort();

  return sqlFiles;
}

async function getAppliedMigrations(client) {
  const res = await client.query(
    "SELECT filename, checksum_sha256, applied_at FROM schema_migrations ORDER BY filename ASC;",
  );
  const map = new Map();
  for (const row of res.rows) map.set(row.filename, row);
  return map;
}

async function applyMigration(client, filename) {
  const fullPath = path.join(migrationsDir, filename);
  const sqlBuf = await fs.readFile(fullPath);
  const checksum = sha256(sqlBuf);
  const sql = sqlBuf.toString("utf8");

  // Apply each migration inside its own transaction.
  // Why: if it fails, we rollback and leave DB consistent.
  await client.query("BEGIN;");
  try {
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations(filename, checksum_sha256) VALUES ($1, $2);",
      [filename, checksum],
    );
    await client.query("COMMIT;");
    console.log(`Applied ${filename}`);
  } catch (err) {
    await client.query("ROLLBACK;");
    throw new Error(`Migration failed: ${filename}\n${err?.stack || err}`);
  }
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await ensureSchema(client);

    if (doReset) {
      // Destructive reset intended for local dev only.
      // We keep it explicit because in real systems resets are dangerous.
      await client.query("BEGIN;");
      try {
        await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
        await client.query("COMMIT;");
      } catch (e) {
        await client.query("ROLLBACK;");
        throw e;
      }
      await ensureSchema(client);
      console.log("Database reset complete.");
      return;
    }

    const releaseLock = await acquireAdvisoryLock(client);
    try {
      const files = await listMigrationFiles();
      const applied = await getAppliedMigrations(client);

      if (showStatus) {
        for (const f of files) {
          const a = applied.get(f);
          console.log(
            `${a ? "APPLIED" : "PENDING"}\t${f}${a ? `\t${a.applied_at.toISOString()}` : ""}`,
          );
        }
        return;
      }

      for (const filename of files) {
        const fullPath = path.join(migrationsDir, filename);
        const sqlBuf = await fs.readFile(fullPath);
        const checksum = sha256(sqlBuf);

        const existing = applied.get(filename);
        if (existing) {
          if (existing.checksum_sha256 !== checksum) {
            throw new Error(
              `Checksum mismatch for already-applied migration ${filename}.\n` +
                `This indicates the migration file was edited after apply (not allowed).\n` +
                `Applied: ${existing.checksum_sha256}\nCurrent: ${checksum}`,
            );
          }
          continue;
        }

        await applyMigration(client, filename);
      }

      console.log("Migrations up to date.");
    } finally {
      await releaseLock();
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
