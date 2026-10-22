# APIWatch — Build Roadmap

A phased plan to build APIWatch from scratch. Each phase ends with something **working and demoable**, so you're never stuck with half-built pieces.

**Guiding principle:** build the engine first, the UI second. A monitor that silently misses checks is worse than an ugly dashboard.

**Estimated total:** ~6–8 weeks part-time (about 8–10 hrs/week). Adjust freely.

---

## Overview

| Phase | Goal | Est. time | Demo at the end |
|-------|------|-----------|-----------------|
| 0 | Setup & foundations | 2–3 days | Everything boots with one command |
| 1 | Endpoint CRUD + auth | 4–5 days | Create/list monitors via API |
| 2 | Check engine (core) | 1–1.5 weeks | Endpoints get pinged automatically; results land in DB |
| 3 | Failure detection + incidents | 4–5 days | A broken endpoint opens and closes an incident by itself |
| 4 | Alerts | 4–5 days | Email + webhook fire on failure and recovery |
| 5 | Dashboard UI | 1–1.5 weeks | Live green/red grid, detail pages |
| 6 | History graphs & stats | 4–5 days | 24h / 7d charts, uptime % |
| 7 | Hardening & security | 4–5 days | SSRF-safe, tested, retention in place |
| 8 | Deploy & polish | 3–4 days | Live URL, README with screenshots |
| 9+ | Stretch features | ongoing | Status pages, Slack, multi-region… |

---

## Phase 0 — Setup & Foundations
**Goal:** a clean monorepo that boots locally.

- [x] Create monorepo (`apps/api`, `apps/web`) with npm workspaces
- [x] Scaffold NestJS app and Next.js app (TypeScript strict mode)
- [x] `docker-compose.yml` with MongoDB and Redis (optional; both can also be installed locally)
- [x] Database layer with Mongoose and `.env.example` files (switched from Postgres/Prisma to MongoDB after Phase 2; there are no migrations)
- [x] ESLint (oxlint for API, ESLint for web) and Prettier config; Husky skipped for now
- [x] Add a `/health` route to the API
- [x] Commit README and ROADMAP

**Done when:** `npm run check` + `npm run dev:api` / `npm run dev:web` runs both apps and `/health` returns OK.

---

## Phase 1 — Endpoint CRUD & Auth
**Goal:** teams can sign up and manage monitors (nothing is checked yet).

- [x] Mongoose schemas: `User`, `Team`, `Endpoint` (added in Phase 0)
- [x] Auth: register, login, `/auth/me`, JWT guard, bcrypt hashing (refresh tokens deferred; access tokens last 7d for now)
- [x] Endpoint CRUD with validation (class-validator): URL format, interval min (e.g. 30s), timeout limits
- [x] Scope every query by `teamId` (data isolation from day one)
- [x] Pause / resume flags
- [x] API tests with Supertest (24 cases, run against an in-memory fake DB: `npm run test:e2e`)

**Done when:** you can register, log in, and create/edit/delete endpoints with a REST client.

---

## Phase 2 — The Check Engine (core)
**Goal:** the system pings endpoints on its own. This is the heart of the project.

- [x] Add BullMQ and a `checks` queue
- [x] Scheduler service: on endpoint create → add repeatable job; on update → reschedule; on pause/delete → remove job
- [x] Worker (processor): load endpoint, send HTTP request with hard timeout (use `undici` or `axios`)
- [x] Assertion evaluator: status code (exact / `2xx`), body contains, response-time measurement
- [x] Classify failures: `TIMEOUT`, `DNS`, `CONN_REFUSED`, `TLS`, `BAD_STATUS`, `BAD_BODY`
- [x] `CheckResult` model + store every result
- [x] Update `currentStatus` and `lastCheckedAt` on the endpoint
- [x] Concurrency limit + jitter on schedules
- [x] **Startup reconciliation:** compare DB active endpoints vs Redis jobs and repair drift
- [x] "Check now" manual trigger
- [x] Build a small **mock target server** (`/ok`, `/fail`, `/slow`, `/flaky`) for testing

**Status: complete.** 9 engine tests run against real MongoDB and Redis (`npm run test:e2e`); they cover automatic checks, DOWN and recovery, pause/resume, delete, restart, drift repair, the no-overlap lock and the pause race.

**Done when:** you add 5 endpoints, restart the server, and checks keep running on schedule with results in the DB, including after a restart.

> ⚠️ **Watch out:** overlapping checks, hung requests, and duplicated jobs after restart. Test each deliberately.

---

## Phase 3 — Failure Detection & Incidents
**Goal:** repeated failures automatically become incidents.

- [ ] Add `consecutiveFailures` and `failureThreshold` logic
- [ ] Implement the state machine: `UP → failing → DOWN → recovered`
- [ ] `Incident` model: auto-open when threshold crossed, auto-close on first success (optionally M successes)
- [ ] Guarantee **no duplicate incidents** (transaction or unique constraint on open incident per endpoint)
- [ ] Incident API: list, filter by status, detail
- [ ] **Unit-test the state machine heavily** (success/failure sequences, flapping, threshold edges)

**Done when:** pointing a monitor at the mock `/fail` route opens an incident after N failures, and switching it to `/ok` closes it, with no human involved.

---

## Phase 4 — Alerts
**Goal:** the right people get told, exactly once.

- [ ] `AlertChannel` and `AlertLog` models
- [ ] Email dispatcher (Resend or SMTP)
- [ ] Webhook dispatcher with HMAC-SHA256 signature header
- [ ] Alert on **incident opened** and **incident resolved**
- [ ] Alerts sent through their own queue with retry + exponential backoff
- [ ] Idempotency: one alert per incident event, even if the job retries
- [ ] "Send test alert" endpoint
- [ ] Optional: re-notify every X minutes while still down

**Done when:** killing the mock server sends an email and a webhook; restoring it sends a recovery message. Failed webhook deliveries retry and are logged.

---

## Phase 5 — Dashboard UI
**Goal:** a live, readable view of everything.

- [ ] Auth pages (login/register) and protected routes in Next.js
- [ ] Overview page: grid of endpoints with green/red/grey status, last response time, 24h uptime
- [ ] Add/Edit endpoint form (interval, expected status, body check, threshold, alert channels)
- [ ] Endpoint detail page: config, recent checks table, incident history
- [ ] Incidents page: open vs resolved, durations
- [ ] **Real-time updates:** SSE endpoint in NestJS; workers publish to Redis pub/sub; a React hook subscribes and updates badges live
- [ ] Loading, empty, and error states

**Done when:** you break the mock endpoint and watch the badge turn red on the dashboard without refreshing.

---

## Phase 6 — History Graphs & Stats
**Goal:** answer "how has this API been doing?"

- [ ] Stats service: uptime % and avg / p95 response time for 24h and 7d
- [ ] Efficient queries using the `(endpointId, checkedAt)` index
- [ ] Downsample for charts (e.g. 5-min buckets for 24h, hourly for 7d)
- [ ] Response-time line chart (Recharts) with failures marked
- [ ] Uptime bar/heatmap
- [ ] Range selector (24h / 7d)
- [ ] **Hourly rollup table** + nightly job to compress/delete old raw results (retention)

**Done when:** graphs load fast with weeks of data and old raw rows are cleaned up automatically.

---

## Phase 7 — Hardening & Security
**Goal:** safe to expose to real users.

- [ ] **SSRF protection:** block private/internal IP ranges, re-validate after DNS resolution and on redirects
- [ ] Encrypt stored headers/secrets at rest
- [ ] Rate limiting, per-team endpoint caps, minimum interval enforcement
- [ ] Integration tests: full flow with mock server (fail → incident → alert → recover)
- [ ] Scheduler tests: reconciliation, interval changes, pause/resume
- [ ] Structured logging and error handling in workers
- [ ] Graceful shutdown (finish in-flight checks)

**Done when:** a request to `http://169.254.169.254` or `localhost` is rejected, and the test suite covers the core engine.

---

## Phase 8 — Deploy & Polish
**Goal:** a live URL you can show people.

- [ ] Dockerfiles for API and web
- [ ] Deploy (VPS with Docker Compose, or Vercel + Railway/Fly/Render + MongoDB Atlas + managed Redis)
- [ ] HTTPS and environment secrets
- [ ] Monitor APIWatch itself (something should watch the watcher)
- [ ] Seed script with demo endpoints
- [ ] Screenshots / short GIF in README
- [ ] Write a short "how it works" blog post or architecture diagram

**Done when:** anyone can open the live link, add an endpoint, and see it monitored.

---

## Phase 9+ — Stretch Features
Pick whatever excites you:

- [ ] Public status pages per team
- [ ] Slack / Discord / Telegram / SMS channels
- [ ] Multi-region checking (avoid false alarms from one location)
- [ ] SSL certificate expiry alerts
- [ ] Maintenance windows (mute alerts during planned downtime)
- [ ] Heartbeat monitors for cron jobs
- [ ] Multi-step checks (login → fetch → verify)
- [ ] Public API + API keys

---

## Risks & How to Handle Them

| Risk | Mitigation |
|------|------------|
| Scheduler drift or lost jobs after restart | Reconciliation on boot; test it explicitly |
| Duplicate alerts / incidents | Unique constraints, transactions, idempotency keys |
| DB growth | Retention + hourly rollups from Phase 6 |
| False positives (one blip = alarm) | `failureThreshold` and optional multi-success recovery |
| SSRF abuse | Phase 7 IP blocking; don't skip it |
| Scope creep | Finish through Phase 4 before touching UI polish |

---

## Suggested Weekly Plan

| Week | Focus |
|------|-------|
| 1 | Phase 0 and Phase 1 |
| 2 | Phase 2 (engine) |
| 3 | Phase 2 finish and Phase 3 |
| 4 | Phase 4 (alerts) |
| 5 | Phase 5 (dashboard + live updates) |
| 6 | Phase 6 (graphs) and start Phase 7 |
| 7 | Phase 7 finish and Phase 8 |
| 8 | Buffer, stretch features, polish |

---

## Definition of "MVP Complete"

You can say APIWatch works when this scenario runs end to end with **zero manual steps**:

1. Register an endpoint with a 1-minute interval and threshold of 3.
2. It gets checked every minute and the dashboard shows it green.
3. You break the target. After 3 failed checks, the badge turns red, an incident opens, and an email and webhook arrive.
4. You fix the target. The next check turns it green, the incident closes, and a recovery alert is sent.
5. The 24h graph shows the outage window accurately.
