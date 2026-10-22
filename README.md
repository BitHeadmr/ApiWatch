# APIWatch — API Uptime & Health Monitoring Dashboard

> UptimeRobot / Pingdom, but you built it yourself.

APIWatch lets a team register the APIs they run, automatically checks each one on a schedule, and tells them the moment something breaks, before a customer does.

---

## Table of Contents

1. [What It Does](#1-what-it-does)
2. [Who It's For](#2-who-its-for)
3. [Core Features](#3-core-features)
4. [Architecture Overview](#4-architecture-overview)
5. [Tech Stack](#5-tech-stack)
6. [The Check Engine (the hard part)](#6-the-check-engine-the-hard-part)
7. [Data Model](#7-data-model)
8. [API Reference](#8-api-reference)
9. [Alerting & Incident Logic](#9-alerting--incident-logic)
10. [Real-Time Dashboard](#10-real-time-dashboard)
11. [Project Structure](#11-project-structure)
12. [Getting Started](#12-getting-started)
13. [Configuration](#13-configuration)
14. [Testing Strategy](#14-testing-strategy)
15. [Security Considerations](#15-security-considerations)
16. [Deployment](#16-deployment)
17. [Future Ideas](#17-future-ideas)

---

## 1. What It Does

You register an endpoint: a URL, the HTTP method, what a healthy response looks like, and how often to check it. From then on APIWatch runs on its own:

1. A **scheduler** triggers a check at the configured interval (every minute, every 5 minutes, whatever you set).
2. A **worker** sends the HTTP request and records: *up or down*, *response time*, and *whether the response matched expectations*.
3. If an endpoint fails **N consecutive times**, the system **opens an incident** and **fires alerts** (email and/or webhook).
4. When the endpoint recovers, the incident **closes automatically** and a recovery notification is sent.
5. The **dashboard** shows live green/red status for every endpoint plus history graphs.

Nobody has to refresh a page or remember to check anything. The system watches so people don't have to.

## 2. Who It's For

A team running several backend services that wants to know the moment one goes down, rather than hearing about it from an angry customer.

## 3. Core Features

| # | Feature | Details |
|---|---------|---------|
| 1 | **Endpoint management** | Add, edit, pause, delete endpoints. Configure URL, method, headers, body, interval, timeout, expected status code, expected body content. |
| 2 | **Automatic background checks** | Scheduled, concurrent, and resilient. Survives restarts without losing or duplicating checks. |
| 3 | **Live dashboard** | Real-time green/red status per endpoint, pushed to the browser (no manual refresh). |
| 4 | **History graphs** | Response time and uptime % over the last 24 hours and 7 days. |
| 5 | **Alerts** | Email and webhook after N consecutive failures, plus a recovery notice. |
| 6 | **Incident log** | Auto-opens on repeated failure, auto-closes on recovery, with start time, end time, duration, and failure reason. |

### What counts as a "correct" response

A check is **successful** only if all configured assertions pass:

- Status code matches the expected one (default `200`; ranges like `2xx` supported)
- Response arrives within the timeout
- *(Optional)* Body contains an expected string or matches a JSON path/value
- *(Optional)* Response time is under a "degraded" threshold (marks the check as slow, not failed)

## 4. Architecture Overview

```
┌──────────────┐      REST / SSE       ┌──────────────────────┐
│  Next.js UI  │◄─────────────────────►│   NestJS API server  │
│  (dashboard) │                       │  (auth, CRUD, stats) │
└──────────────┘                       └─────────┬────────────┘
                                                 │
                    ┌────────────────────────────┼───────────────────────────┐
                    │                            │                           │
              ┌─────▼──────┐             ┌───────▼────────┐          ┌───────▼────────┐
              │  MongoDB   │             │  Redis (queue) │          │ Pub/Sub (live  │
              │ (all data) │             │    BullMQ      │          │ status events) │
              └─────▲──────┘             └───────┬────────┘          └───────▲────────┘
                    │                            │                           │
                    │                    ┌───────▼────────┐                  │
                    └────────────────────┤ Check Workers  ├──────────────────┘
                      write results      │ (NestJS proc.) │  publish result events
                                         └───────┬────────┘
                                                 │ HTTP requests
                                         ┌───────▼────────┐
                                         │ Monitored APIs │
                                         └────────────────┘
```

**Key idea:** the API server, the scheduler, and the workers are logically separate. They can run in one process during development and be split into separate processes when scaling.

## 5. Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Frontend | **Next.js + TypeScript**, Tailwind, Recharts | Fast to build, great charting, SSR if needed |
| Backend API | **NestJS + TypeScript** | Modular structure, DI, built-in scheduling/queue integrations |
| Database | **MongoDB** (via Mongoose) | Flexible documents, fast time-range queries on check history, and no migration step |
| Queue / Scheduler | **Redis + BullMQ** | Repeatable jobs, retries, concurrency control, survives restarts |
| Real-time | **Server-Sent Events (SSE)** | Simple one-way push, perfect for status updates; WebSockets are an alternative |
| Email | **Resend** or **Nodemailer (SMTP)** | Easy transactional email |
| Auth | JWT (access + refresh) or NextAuth | Team accounts |
| Infra | **Docker Compose** (optional) | Runs MongoDB + Redis if you'd rather not install them locally |
| Tooling | **npm workspaces** | One `npm install` for both apps; no extra package manager needed |
| Testing | Jest, Supertest, Playwright (optional) | Unit, integration, e2e |

## 6. The Check Engine (the hard part)

This is the heart of the project. The UI is secondary; correctness here is what makes APIWatch trustworthy.

### How scheduling works

- Each **active endpoint** has a BullMQ **repeatable job** keyed by the endpoint ID (`every: intervalSeconds`).
- Editing the interval removes and re-creates the repeatable job. Pausing removes it. Resuming adds it back.
- On app start, a **reconciliation step** compares active endpoints in the DB with scheduled jobs in Redis and fixes any drift, so a Redis flush or a deploy never silently stops monitoring.

### Known limitation: blocked ports

Node's `fetch` follows the WHATWG "bad ports" list and refuses ports such as 1, 22, 25 and 6000 before
connecting. A monitor on one of those ports records a clear "port is blocked" failure rather than a
real result. Switching the checker to `undici.request` would lift this if it ever matters.

### How a check runs

```
job fires → load endpoint config → send HTTP request (with timeout)
         → evaluate assertions → build CheckResult
         → save to DB → update endpoint's current status
         → run state machine (failure counter / incident / alert)
         → publish live event to dashboard
```

### Design rules the engine must follow

1. **Never block on a slow target.** Every request has a hard timeout; a hung API must not stall other checks.
2. **Concurrency limit.** Workers process N checks in parallel (configurable) so a spike doesn't exhaust sockets.
3. **No overlapping checks for the same endpoint.** If a check is still running when the next fires, skip or coalesce.
4. **Jitter.** Spread checks slightly so 500 endpoints on a 60s interval don't all fire in the same millisecond.
5. **Idempotent state transitions.** Opening an incident twice or sending the same alert twice must be impossible, even on retries.
6. **Distinguish failure types.** Timeout, DNS failure, connection refused, TLS error, wrong status, wrong body. These are different reasons and should be stored as such.
7. **Retry before declaring failure.** One failed ping is a blip. "N consecutive failures" is what triggers an incident.

### Failure state machine (per endpoint)

```
        success                         failure
   ┌──────────────┐               ┌───────────────┐
   │              ▼               │               ▼
 [UP] ──failure──► [UP, failCount++] ──count ≥ N──► [DOWN + incident opened + alert]
   ▲                                                        │
   │                                                        │ success
   └──────── incident closed + recovery alert ◄─────────────┘
```

- `failCount` resets to 0 on any success.
- Alert fires **once** when the threshold is crossed (not on every further failure).
- Optional: re-notify every X minutes while still down.
- Recovery can optionally require M consecutive successes to avoid flapping.

## 7. Data Model

Four MongoDB collections, defined as Mongoose schemas in `apps/api/src/database/schemas/`. Collections and
indexes are created automatically on first start, so there is **no migration step**.

| Collection | Key fields | Indexes |
|------------|-----------|---------|
| `teams` | `name`, `createdAt` | |
| `users` | `email`, `password` (bcrypt hash, never returned), `teamId`, `createdAt` | unique `email`; `teamId` |
| `endpoints` | `teamId`, `name`, `url`, `method`, `headers`, `body`, `intervalSeconds`, `timeoutMs`, `expectedStatus`, `expectedBodyContains`, `failureThreshold`, `isActive`, `currentStatus` (`UNKNOWN` / `UP` / `DOWN` / `PAUSED`), `consecutiveFailures`, `lastCheckedAt`, timestamps | `teamId`; `isActive` |
| `check_results` | `endpointId`, `checkedAt`, `success`, `statusCode`, `responseTimeMs`, `failureReason` (`TIMEOUT` / `DNS` / `CONN_REFUSED` / `TLS` / `BAD_STATUS` / `BAD_BODY` / `UNKNOWN`), `errorMessage` | `{ endpointId: 1, checkedAt: -1 }` |

Planned for later phases:

| Collection | Phase | Purpose |
|------------|-------|---------|
| `incidents` | 3 | `endpointId`, `startedAt`, `resolvedAt`, `status` (`OPEN` / `RESOLVED`), `reason`. A partial unique index on `{ endpointId }` where `status = OPEN` guarantees one open incident per endpoint, even if two workers race |
| `alert_channels` | 4 | `endpointId`, `type` (`EMAIL` / `WEBHOOK`), `target`, `secret` |
| `alert_logs` | 4 | `incidentId`, `channelId`, `type`, `success`, `sentAt` |
| `check_rollups` | 6 | Hourly aggregates (avg / p95 response time, uptime %) kept after raw results are pruned |

### MongoDB-specific design notes

- **No transactions.** Multi-document transactions need a replica set, so the code avoids them: writes are ordered
  so a failure never leaves anything inconsistent for long (for example, registration inserts the user first and
  undoes it if the team insert fails).
- **No foreign-key cascades.** Deleting an endpoint explicitly deletes its `check_results`.
- **IDs** are 24-character hex ObjectIds, and the REST API returns them as `id`.

### Data retention

Checks pile up fast (1 endpoint × 1/min = 1,440 rows/day). Plan for it:

- Keep **raw** results for 7–30 days.
- Roll up into **hourly aggregates** (avg/p95 response time, uptime %) for longer history.
- Run a nightly cleanup job (a MongoDB TTL index on `checkedAt` is a simple alternative once rollups exist).

## 8. API Reference

All routes are prefixed with `/api/v1` and require auth unless noted.

### Auth
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/auth/register` | Create account/team |
| POST | `/auth/login` | Get JWT |
| GET | `/auth/me` | Current user and team |
| POST | `/auth/refresh` | Refresh token *(planned)* |

### Endpoints (monitors)
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/endpoints` | List all with current status |
| POST | `/endpoints` | Create and schedule a monitor |
| GET | `/endpoints/:id` | Detail and config |
| PATCH | `/endpoints/:id` | Update (reschedules if interval changed) |
| DELETE | `/endpoints/:id` | Delete and unschedule |
| POST | `/endpoints/:id/pause` | Pause monitoring |
| POST | `/endpoints/:id/resume` | Resume monitoring |
| POST | `/endpoints/:id/check-now` | Run an immediate manual check and return the result |

### Stats & history
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/endpoints/:id/checks?limit=50` | Most recent raw check results (max 200). `range=24h/7d` and aggregation arrive in Phase 6 |
| GET | `/endpoints/:id/stats?range=7d` | Uptime %, avg/p95 response time |

### Incidents
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/incidents?status=open` | Incident log (filterable) |
| GET | `/incidents/:id` | Incident detail and alert history |

### Alert channels
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/endpoints/:id/channels` | Add email/webhook channel |
| DELETE | `/channels/:id` | Remove channel |
| POST | `/channels/:id/test` | Send a test alert |

### Live updates
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/stream` | SSE stream of status-change and check events |

## 9. Alerting & Incident Logic

### Triggers
- **Incident opened:** `consecutiveFailures >= failureThreshold` and no open incident exists.
- **Incident resolved:** a successful check arrives while an incident is open.

### Webhook payload (example)

```json
{
  "event": "incident.opened",
  "endpoint": { "id": "…", "name": "Payments API", "url": "https://api.example.com/health" },
  "incident": { "id": "…", "startedAt": "2026-10-01T10:15:00Z", "reason": "TIMEOUT" },
  "consecutiveFailures": 3
}
```

- Webhooks are signed with HMAC-SHA256 (`X-APIWatch-Signature`) so receivers can verify them.
- Failed deliveries retry with exponential backoff (via BullMQ) and are recorded in `AlertLog`.

### Email
Plain, scannable: what broke, since when, the failure reason, and a link to the dashboard.

## 10. Real-Time Dashboard

- **Overview page:** a grid or list of every endpoint with a green/red/grey badge, last response time, and 24h uptime.
- **Endpoint detail page:** response-time line chart, uptime bar, recent checks table, and incident history for that endpoint.
- **Incidents page:** open incidents at the top, resolved ones below, with durations.
- **Live behavior:** the browser opens an SSE connection; workers publish events to Redis pub/sub; the API server relays them to connected clients. Status badges flip without a reload.

## 11. Project Structure

```
apiwatch/
├── apps/
│   ├── api/                      # NestJS backend
│   │   └── src/
│   │       ├── auth/
│   │       ├── endpoints/        # CRUD + scheduling hooks
│   │       ├── scheduler/        # BullMQ queue setup, reconciliation
│   │       ├── checker/          # worker: HTTP check + assertions
│   │       ├── incidents/        # state machine, incident log
│   │       ├── alerts/           # email + webhook dispatchers
│   │       ├── stats/            # uptime / latency aggregation
│   │       ├── stream/           # SSE gateway
│   │       └── database/         # Mongoose schemas + connection
│   └── web/                      # Next.js frontend
│       └── src/
│           ├── app/              # routes
│           ├── components/       # StatusBadge, Charts, Forms
│           └── lib/              # API client, SSE hook
├── docker-compose.yml
├── ROADMAP.md
└── README.md
```

## 12. Getting Started

> Prerequisites: Node.js 20+, npm 10+, **MongoDB** and **Redis** (see step 2).

```bash
# 1. Clone and install
git clone https://github.com/bitheadmr/apiwatch.git
cd apiwatch
npm install

# 2. Get MongoDB and Redis running. Pick ONE option below.

# 3. Configure environment
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local

# 4. Check that everything is reachable
npm run check

# 5. Start the app (two terminals)
npm run dev:api     # API + workers on http://localhost:4000/api/v1
npm run dev:web     # Dashboard on http://localhost:3000
```

**Step 2, options for MongoDB and Redis**

| Option | Commands |
|--------|----------|
| **macOS, no Docker** (Homebrew) | `brew tap mongodb/brew && brew install mongodb-community@7.0 redis`<br>`brew services start mongodb-community@7.0 && brew services start redis` |
| **Docker** | `npm run db:up` (needs Docker Desktop running) |
| **Hosted, nothing to install** | A free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster for `MONGODB_URI`, and a free [Upstash](https://upstash.com) Redis for `REDIS_URL`, both set in `apps/api/.env` |

There is no database migration command. MongoDB creates collections and indexes on first use.

Check `http://localhost:4000/api/v1/health`. It should report the database and Redis as `up`. If the API can't reach
MongoDB it says so on startup and exits instead of running half-broken.

**Try the engine** with the bundled mock API (a third terminal):

```bash
npm run mock    # http://localhost:5001  (/ok /fail /slow /flaky /body /switch)
```

Register, then create an endpoint pointing at `http://localhost:5001/switch` with `intervalSeconds: 30`
(see `apps/api/requests.http`). It is checked immediately and then every 30 seconds. Break it with
`curl -X POST localhost:5001/switch/down` and watch `GET /endpoints/:id` flip to `DOWN` after the
failure threshold; `curl -X POST localhost:5001/switch/up` brings it back.

Open `http://localhost:3000`, register, add your first endpoint, and watch it get checked.

## 13. Configuration

`apps/api/.env`

```env
MONGODB_URI=mongodb://localhost:27017/apiwatch
REDIS_URL=redis://localhost:6379
JWT_SECRET=change-me
JWT_EXPIRES_IN=7d              # refresh tokens are planned; until then tokens last longer

# Check engine
CHECK_CONCURRENCY=20             # checks run in parallel per worker process
MIN_INTERVAL_SECONDS=30          # lowest interval a user may set
SCHEDULER_ENABLED=true           # false = API only, no queue/worker (used by the API tests)
RUN_WORKER=true                  # false = this process schedules but doesn't run checks
RECONCILE_INTERVAL_SECONDS=300   # how often the queue is re-synced with the database
QUEUE_PREFIX=apiwatch            # Redis key prefix for the queue

# Email
EMAIL_PROVIDER=resend            # resend | smtp
RESEND_API_KEY=
EMAIL_FROM=alerts@yourdomain.com

# Retention
RAW_RETENTION_DAYS=14
```

## 14. Testing Strategy

Tests run against a **real MongoDB** (and a real Redis for the engine tests), using a throwaway database per run, so your
development data is never touched. They skip with a warning if a server isn't reachable. Set `TEST_MONGODB_URI`
(for example `mongodb://localhost:27017`) to use a non-default server.

- **Unit tests:** assertion evaluator (status/body/timeout), failure state machine, uptime calculations. The state machine is the most important thing to test thoroughly.
- **Integration tests:** spin up a tiny mock server that can be told to succeed, fail, hang, or return bad bodies; verify the full check → incident → alert flow.
- **Scheduler tests:** reconciliation fixes missing jobs; interval changes reschedule correctly.
- **E2E (optional):** Playwright flow of add endpoint → see status → force failure → see incident.

## 15. Security Considerations

- **SSRF protection (important):** users supply URLs that *your server* will call. Block requests to private/internal ranges (`127.0.0.0/8`, `10.0.0.0/8`, `169.254.169.254`, etc.) and re-check after DNS resolution and redirects.
- **Secrets at rest:** encrypt stored auth headers and webhook secrets.
- **Rate limit** the API and cap endpoints per team and minimum interval.
- **Auth:** hash passwords (argon2/bcrypt), short-lived JWTs, per-team data isolation on every query.
- **Webhook signing** so receivers can trust the source.

## 16. Deployment

- **Simple:** one VPS with Docker Compose (API, web, MongoDB, Redis, reverse proxy with HTTPS).
- **Managed:** Next.js on Vercel; API on Railway/Render/Fly.io; MongoDB Atlas and a managed Redis.
- Run **at least one worker** at all times. Scale workers horizontally. BullMQ coordinates them through Redis.
- Add a `/health` endpoint on APIWatch itself and monitor it with... APIWatch (or an external pinger, so something watches the watcher).

## 17. Future Ideas

- Public **status pages** per team
- Slack / Discord / Telegram / SMS alert channels
- Multi-region checks to avoid false positives from a single location
- SSL certificate expiry monitoring
- Maintenance windows (suppress alerts during planned downtime)
- Heartbeat monitoring for cron jobs (they ping *you*)
- Multi-step checks (login → fetch → verify)
- API keys and a public API for creating monitors from CI/CD

---

*Built to be understood, not just to run. The scheduling engine is the interesting part, so spend your time there.*
