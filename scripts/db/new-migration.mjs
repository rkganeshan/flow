#!/usr/bin/env node
/**
 * Create a new timestamped SQL migration file.
 *
 * Usage:
 *   npm run db:new -- create_workflows
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const migrationsDir = path.resolve(repoRoot, "migrations");

function pad(n) {
  return String(n).padStart(2, "0");
}

function utcTimestamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

const name = process.argv.slice(2).join("_").trim();
if (!name) {
  console.error(
    "Missing migration name. Example: npm run db:new -- create_workflow_tables",
  );
  process.exit(1);
}

const fileName = `${utcTimestamp()}_${name.replace(/[^a-zA-Z0-9_\-]+/g, "_")}.sql`;
const filePath = path.join(migrationsDir, fileName);

const template = `-- ${fileName}
--
-- Rules:
-- 1) Migrations are immutable once applied.
-- 2) Prefer explicit constraints/indexes (correctness + performance).
-- 3) Keep each migration focused and reviewable.

BEGIN;

-- TODO: write schema changes here

COMMIT;
`;

await fs.mkdir(migrationsDir, { recursive: true });
await fs.writeFile(filePath, template, "utf8");
console.log(`Created migration: migrations/${fileName}`);
