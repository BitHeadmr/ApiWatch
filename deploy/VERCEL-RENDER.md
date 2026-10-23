# APIWatch: Vercel frontend + Render API, MongoDB and Redis

This deployment uses Vercel for `apps/web`, and Render private Docker services for MongoDB and Redis plus a public Render web service for the NestJS API. The API is public because browsers on Vercel must call it; MongoDB and Redis must remain private.

## 0. Push the repository to GitHub

Commit and push the whole monorepo, including the root `package.json` and `package-lock.json`. Do not commit `.env` files, database passwords, or tokens.

## 1. Deploy MongoDB and Redis on Render

Create a Render Blueprint from the repository root using `render.yaml`, or create the services manually:

- `apiwatch-mongo`: Private Service, Dockerfile `apps/infra/mongo/Dockerfile`, Docker context `.`. Attach a persistent disk mounted at `/data/db` (start with the smallest suitable paid disk). Do not expose a public port.
- `apiwatch-redis`: Private Service, Dockerfile `apps/infra/redis/Dockerfile`, Docker context `.`. Attach a persistent disk mounted at `/data`. Do not expose a public port.
- Confirm both services are in the same Render region and private network as the API.

Render's filesystem is ephemeral unless a persistent disk is attached. Persistent disks are single-instance and disable zero-downtime deploys, so configure backups and expect brief downtime on redeploy. For production-critical data, a managed database is generally safer than self-hosted MongoDB.

After the private services exist, use their internal hostnames to set the API environment variables:

- `MONGODB_URI=mongodb://apiwatch-mongo:27017/apiwatch`
- `REDIS_URL=redis://apiwatch-redis:6379`

If Render shows different internal hostnames or ports, use the values displayed in its dashboard. Keep these services private; never put their internal URLs in Vercel variables.

## 2. Deploy the API on Render

The Blueprint defines `apiwatch-api` with `apps/api/Dockerfile`, the repo root as Docker context, and health check `/api/v1/health`. If creating it manually, select a Docker web service with:

- Dockerfile path: `./apps/api/Dockerfile`
- Docker context: `.`
- Health check path: `/api/v1/health`

Set these environment variables on the API service:

- `NODE_ENV=production`
- `PORT=10000` (the default expected port for a Render web service; the app reads `process.env.PORT)
- `MONGODB_URI` and `REDIS_URL` as above
- `JWT_SECRET`: a long, unique, randomly generated secret. Do not reuse a development secret.
- `JWT_EXPIRES_IN=7d`
- `CORS_ORIGIN`: the exact production Vercel origin, e.g. `https://your-project.vercel.app` (no trailing slash; add a custom domain origin if you use one)
- `CHECK_CONCURRENCY=20`
- `MIN_INTERVAL_SECONDS=30`
- `SCHEDULER_ENABLED=true`
- `RUN_WORKER=true`
- `RECONCILE_INTERVAL_SECONDS=300`
- `QUEUE_PREFIX=apiwatch`

After deploy, open `https://<your-api-service>.onrender.com/api/v1/health`. A healthy response should show `status: "ok"` and both `database` and `redis` as `"up"`. If the API is unhealthy, inspect Render logs before proceeding.

**Important worker scaling note:** the API process currently also runs scheduler/worker-related modules. Do not scale the API to multiple instances until you have verified that scheduler ownership and worker concurrency are safe for multiple replicas.

## 3. Deploy the frontend on Vercel

Import the same GitHub repository as a Vercel project. Use these settings:

- Framework preset: Next.js
- Root directory: `apps/web`
- Build command: `npm run build` (default is fine)
- Output directory: default Next.js output
- Node.js version: use Node 22 or a version compatible with the root `.nvmrc` and the app's Next.js version.

Because this is an npm-workspaces monorepo with the lockfile at the repository root, let Vercel detect the root workspace/lockfile. If the install fails due to the root directory setting, enable the Vercel setting that allows installing dependencies from the monorepo root or use Vercel's documented monorepo configuration; do not create a second lockfile inside `apps/web` without intentionally changing the workspace setup.

Set the Vercel **Production** environment variable:

- `NEXT_PUBLIC_API_URL=https://<your-api-service>.onrender.com/api/v1`

This variable is embedded into the client bundle at build time. Redeploy the frontend after changing it. Do not put `JWT_SECRET`, `MONGODB_URI`, or `REDIS_URL` in Vercel.

Once Vercel provides its production origin, copy that exact origin into Render's `CORS_ORIGIN`, then redeploy/restart the API if needed.

## 4. Production smoke test

1. Load the Vercel URL over HTTPS.
2. Register a test account and log in.
3. Add `https://jsonplaceholder.typicode.com/posts/1` as a GET monitor with expected status 200.
4. Confirm the monitor records checks and history graphs show data.
5. Add `https://httpbin.org/status/500` with expected status 200 to test failure handling.
6. Verify incident creation, recovery, and alert delivery if alert channels are configured.
7. Restart/redeploy the API and confirm checks continue after scheduler reconciliation.
8. Confirm `/api/v1/health` reports MongoDB and Redis as up.

## 5. Security and durability

- Keep MongoDB and Redis private; do not publish their ports to the public internet.
- Attach persistent disks to self-hosted MongoDB and Redis. Set up independent backups; a disk is not a backup.
- Configure HTTPS for the Vercel frontend and Render API. Vercel's standard deployment URL and Render web service URL use HTTPS.
- Set CORS to the exact frontend origin; do not use `*` with authenticated production endpoints.
- Rotate generated credentials if they are exposed. Never commit `.env.production`.
- Phase 7 SSRF protection still needs build/test verification before calling the security phase production-ready.
