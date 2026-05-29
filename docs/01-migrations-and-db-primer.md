# Flow — Migrations + Database Primer (MVP)

This is a learning-oriented primer for why we use a DB, why we use migrations, and how that ties directly to correctness in an orchestration engine.

---

## 1) Why we need a database at all

Flow is not just an API that runs code immediately. It is a **durable orchestration system**.
That means we must remember (durably):

- what workflow definition was used
- what run is in progress
- which node ran / is running / finished
- what the outputs/errors were
- what should happen next

If we keep this only in memory:

- a process crash loses everything
- you can’t retry safely
- you can’t debug production behavior
- you can’t scale to multiple workers without coordination

**Therefore:** Postgres is the authoritative state.

---

## 2) Why Postgres (and not Redis) for authoritative state

Redis is great for:

- queues (BullMQ)
- caching
- lightweight coordination

But Redis (for our use) is not:

- our ACID truth store
- our long-term audit log
- our relational query engine

Postgres gives us:

- **transactions** (atomic multi-row changes)
- **constraints** (uniqueness = correctness)
- **indexes** (performance at scale)
- JSONB support (pragmatic configs/logs)
- durability guarantees

**Key idea:** We intentionally assume queues are at-least-once; DB constraints make the system correct anyway.

---

## 3) What migrations are

A **migration** is a versioned, ordered change to the database schema.
Examples:

- create table `workflow_runs`
- add index on `node_runs(status)`
- add column `queued_at`

### Why migrations exist

Without migrations:

- every developer’s DB drifts
- prod schema changes become manual and risky
- rolling deployments get scary (old code vs new schema)

With migrations:

- schema becomes part of the codebase
- you can recreate environments reliably
- you can review schema changes like code (PR review)

### How migrations tie to correctness

In Flow, constraints are part of correctness:

- `UNIQUE(tenant_id, source, dedupe_key)` prevents duplicate trigger events
- `UNIQUE(workflow_run_id, node_id)` prevents scheduling the same node twice

These are not “nice to have”—they are correctness mechanisms.

---

## 4) Migration approaches (and why we’ll pick one)

You’ll see three common styles:

### A) ORM-managed migrations (Prisma/TypeORM)

- Pros: integrated with models, convenient
- Cons: can hide SQL details; sometimes hard to tune indexes/constraints exactly

### B) SQL-first migrations (recommended for learning + control)

- Write explicit SQL migrations in `migrations/*.sql`
- Pros: you learn Postgres, constraints, indexes deeply; maximum control
- Cons: more manual typing

### C) Hybrid

- ORM for queries/models
- SQL migrations for schema

**For this project and learning goals:** a SQL-first migration approach is ideal.
It forces you to understand constraints/indexes and how the engine queries the DB.

---

## 5) DB concepts you will learn early (and why they matter)

### 5.1 Primary keys vs unique constraints

- PK: identity of a row
- Unique constraint: a business-level rule like “no duplicate trigger event”

### 5.2 Transactions

We will rely on transactions to:

- create a run and its entry node_run atomically

### 5.3 Indexes

We will add indexes based on the engine’s query patterns:

- find READY nodes to enqueue
- find stuck IN_PROGRESS nodes
- load a run timeline quickly

### 5.4 JSONB

Used for:

- workflow graph config
- node input/output summaries

We will still keep key fields relational (status, timestamps, ids) for queryability.

---

## 6) “DB is truth, queue is delivery” in one sentence

The DB says **what should be happening**.
The queue helps **make it happen**.
If the queue is wrong (duplicate/missed), the DB + recovery scanners repair it.

---

## 7) What we will do next

Next checkpoint:

1. Create Docker Compose with Postgres + Redis + MailHog (+ optional BullMQ UI)
2. Pick migration tooling and create the first migration
3. Implement the **minimum schema that enforces correctness invariants**
