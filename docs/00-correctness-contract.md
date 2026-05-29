# Flow — Correctness Contract (MVP)

This document is the “truth” we keep returning to while implementing Flow.
It defines **what must be correct** even when processes crash and queues redeliver.

> Guiding rule: **Postgres is authoritative state. BullMQ/Redis is delivery.**
> Delivery is at-least-once → duplicates are normal.

---

## 1) Core invariants (non-negotiable)

### I1 — Workflow version immutability

- A `workflow_version` is **immutable** once published.
- Every `workflow_run` references exactly one `workflow_version`.

**Why:** replay/debugging, auditability, and “what code ran” must be well-defined.

---

### I2 — State is durable and idempotent

- `workflow_run` + `node_run` tables are the source of truth.
- Queue messages may be duplicated; handlers must be idempotent.

**Why:** Redis/queues are not an ACID source of truth; they can replay.

---

### I3 — A node_run is executed by at most one worker at a time

- Workers must "claim" work using a conditional DB transition:
  - `READY -> IN_PROGRESS`
- If claim fails (0 rows), the job is duplicate/stale and must be acknowledged.

**Why:** this turns at-least-once queue delivery into “effectively once per node_run attempt”.

---

### I4 — Engine decisions are deterministic and idempotent

- Given the same run state + workflow graph + node outcome, the engine must schedule the same next step.
- Creating downstream `node_run` records must be protected by uniqueness constraints or idempotent upserts.

**Why:** engine crashes and duplicate completion events must not create divergent execution paths.

---

### I5 — Terminal means terminal

- Once a `workflow_run` is terminal (`SUCCEEDED|FAILED|CANCELLED`), no additional node_runs may be scheduled.
- Completion events for nodes in terminal runs are ignored (but can be logged).

**Why:** prevents “zombie” execution after cancellation/failure.

---

## 2) Delivery semantics (what to assume)

### 2.1 Queues

We assume BullMQ provides:

- at-least-once delivery
- retries/backoff/delayed jobs

We **do not** assume:

- exactly-once delivery
- in-order delivery

---

## 3) Run lifecycle state machines

### 3.1 workflow_run.status

- `PENDING`: created but not started (optional in MVP)
- `RUNNING`
- `PAUSED`
- `SUCCEEDED`
- `FAILED`
- `CANCELLED`

Allowed transitions (MVP):

- `PENDING -> RUNNING`
- `RUNNING -> PAUSED -> RUNNING`
- `RUNNING -> SUCCEEDED|FAILED|CANCELLED`
- `PAUSED -> CANCELLED`

### 3.2 node_run.status

- `READY`
- `IN_PROGRESS`
- `SUCCEEDED`
- `FAILED_RETRYABLE`
- `FAILED_FINAL`
- `SKIPPED`

Core transitions:

- `READY -> IN_PROGRESS` (worker claim)
- `IN_PROGRESS -> SUCCEEDED|FAILED_RETRYABLE|FAILED_FINAL`

---

## 4) Idempotency boundaries (where duplicates are handled)

### 4.1 Trigger ingestion → RUN_REQUESTED

- Dedupe key = `trigger_events(tenant_id, source, dedupe_key)` unique.

### 4.2 Engine: RUN_REQUESTED → workflow_run + entry node_run

- Run creation must be idempotent with unique constraints.

### 4.3 Worker: node_job → claim

- Conditional update ensures only one worker proceeds.

### 4.4 Engine: node completion → schedule next

- Next node_run creation is idempotent (`UNIQUE(workflow_run_id, node_id)` for DAG MVP).

---

## 5) Crash consistency (expected “gaps” and how we repair)

### Gap G1 — DB commit succeeded, enqueue did not happen

- Symptom: `node_runs.status=READY` but no job enqueued.
- Fix: periodic **recovery scanner** that enqueues missing READY node_runs.

### Gap G2 — Worker claimed IN_PROGRESS then crashed

- Symptom: node_run stuck IN_PROGRESS.
- Fix: **reaper** detects stale IN_PROGRESS and re-drives (with attempt increment).

---

## 6) Side-effects and retries (safety rules)

- Retries are allowed for transient failures.
- External side-effects (notify, POST HTTP) may duplicate unless:
  - the integration supports idempotency keys, or
  - we implement a provider-level de-dupe mechanism.

MVP stance:

- We provide **at-least-once** execution and best-effort idempotency guidance.

---

## 7) What “done” means for MVP correctness

We are MVP-correct when:

- Duplicate RUN_REQUESTED does not create duplicate runs.
- Duplicate node_job does not execute business logic twice.
- Engine and worker can crash/restart without permanently breaking progress.
- We can explain, for any state, **what will happen next and why**.
