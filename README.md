# TickTick GitHub Issue Sync Worker

Cloudflare Workers service built with TypeScript, Hono, and D1 that syncs GitHub issue events into TickTick tasks.

## Overview

This Worker listens for GitHub issue webhooks and mirrors them into a TickTick project.

- `opened` creates a TickTick task
- `edited` updates the existing mapped TickTick task
- `closed` completes the TickTick task
- `reopened` creates a fresh TickTick task and rewrites the mapping

The sync is intentionally one-way:

- GitHub is the source of truth
- TickTick is the attention layer
- The Worker never edits GitHub issues from TickTick

## Features

- Hono-based Cloudflare Worker
- D1 storage for OAuth tokens and GitHub-to-TickTick mappings
- TickTick OAuth with access-token refresh
- GitHub `X-Hub-Signature-256` validation using the raw request body
- Idempotent webhook handling with GitHub delivery deduplication
- Protected debug endpoints
- Backfill endpoint for importing existing open issues from a repository

## Endpoints

- `GET /health`
- `GET /auth/ticktick/start`
- `GET /auth/ticktick/callback`
- `POST /webhooks/github`
- `GET /debug/projects`
- `POST /sync/github/open-issues?repo=owner/repo`

## Architecture

### D1 tables

- `oauth_tokens`
  Stores TickTick OAuth tokens and refresh metadata.
- `synced_items`
  Stores the mapping between a GitHub issue and a TickTick task.
- `github_deliveries`
  Stores processed GitHub delivery IDs so duplicate webhook deliveries do not create duplicate tasks.

### Task format

Title:

```text
[repo-name#123] Issue title
```

Body:

```text
GitHub: https://github.com/owner/repo/issues/123
Repo: owner/repo
Labels: bug, urgent
State: open

<issue body>
```

## Configuration

### Non-secret vars in `wrangler.jsonc`

- `TICKTICK_PROJECT_ID`
  TickTick project/list ID where tasks should be created.
- `GITHUB_LOGIN`
  Your GitHub username. This is currently informational config.

### Secrets

- `TICKTICK_CLIENT_ID`
- `TICKTICK_CLIENT_SECRET`
- `GITHUB_WEBHOOK_SECRET`
- `DEBUG_TOKEN`
- `GITHUB_TOKEN` optional, for private repo backfill or better GitHub API rate limits

### Local secrets

Create a local `.dev.vars` file in the project root:

```dotenv
TICKTICK_CLIENT_ID=your_ticktick_client_id
TICKTICK_CLIENT_SECRET=your_ticktick_client_secret
GITHUB_WEBHOOK_SECRET=your_github_webhook_secret
DEBUG_TOKEN=your_local_debug_token
GITHUB_TOKEN=optional_github_token
```

The repository ignores `.dev.vars*`, `.env*`, and `.wrangler/`, so local secrets and local D1 state are not committed.

## TickTick setup

### TickTick callback URL

TickTick OAuth requires an exact callback URL match.

Local callback:

```text
http://localhost:8787/auth/ticktick/callback
```

Production callback:

```text
https://<your-worker>.workers.dev/auth/ticktick/callback
```

You must register the callback URL in the TickTick developer app before OAuth will succeed.

### Finding the TickTick project ID

1. Complete TickTick OAuth using `/auth/ticktick/start`
2. Call `GET /debug/projects` with your `DEBUG_TOKEN`
3. Copy the `id` of the TickTick project/list you want to use
4. Put that value into `TICKTICK_PROJECT_ID` in `wrangler.jsonc`

## Local development

### Install dependencies

```bash
npm install
```

### Apply local D1 migrations

```bash
npm run db:migrate:local
```

### Generate Worker types

```bash
npm run cf-typegen
```

### Start the Worker locally

```bash
npm run dev
```

The default local URL is:

```text
http://localhost:8787
```

### Complete local TickTick OAuth

Open:

```text
http://localhost:8787/auth/ticktick/start
```

If TickTick rejects the callback URL, confirm the exact registered redirect URI matches the one above.

### Inspect TickTick projects locally

PowerShell:

```powershell
Invoke-RestMethod `
  -Uri 'http://localhost:8787/debug/projects' `
  -Headers @{ 'Authorization' = 'Bearer YOUR_DEBUG_TOKEN' }
```

### Backfill open issues locally

PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri 'http://localhost:8787/sync/github/open-issues?repo=OWNER/REPO' `
  -Headers @{ 'Authorization' = 'Bearer YOUR_DEBUG_TOKEN' }
```

## Deploying to Cloudflare

This is the recommended production order.

### 1. Set the real TickTick project ID

In `wrangler.jsonc`, set:

```jsonc
"vars": {
  "TICKTICK_PROJECT_ID": "your_real_project_id",
  "GITHUB_LOGIN": "your_github_username"
}
```

### 2. Set production secrets

Run these from the repo root:

```bash
npx wrangler secret put TICKTICK_CLIENT_ID
npx wrangler secret put TICKTICK_CLIENT_SECRET
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put DEBUG_TOKEN
npx wrangler secret put GITHUB_TOKEN
```

`GITHUB_TOKEN` is optional unless you want to backfill private repositories or avoid unauthenticated GitHub API rate limits.

### 3. Apply the remote D1 migration

```bash
npm run db:migrate:remote
```

### 4. Deploy the Worker

```bash
npm run deploy
```

Wrangler will print the production `workers.dev` URL.

### 5. Update the TickTick callback URL

Register the production callback URL in the TickTick developer app:

```text
https://<your-worker>.workers.dev/auth/ticktick/callback
```

### 6. Complete production TickTick OAuth

Open:

```text
https://<your-worker>.workers.dev/auth/ticktick/start
```

This stores the production TickTick OAuth tokens in the remote D1 database.

### 7. Verify production connectivity

```bash
curl -H "Authorization: Bearer YOUR_DEBUG_TOKEN" https://<your-worker>.workers.dev/debug/projects
```

### 8. Configure the GitHub webhook

Point your GitHub webhook or private GitHub App webhook to:

```text
https://<your-worker>.workers.dev/webhooks/github
```

Recommended GitHub webhook settings:

- Content type: `application/json`
- Secret: same value as `GITHUB_WEBHOOK_SECRET`
- Events: `Issues` only

### 9. Backfill existing open issues in production

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_DEBUG_TOKEN" \
  "https://<your-worker>.workers.dev/sync/github/open-issues?repo=OWNER/REPO"
```

## GitHub backfill behavior

- Only open issues are imported
- Pull requests are ignored
- Existing mapped issues are updated, not duplicated
- Without `GITHUB_TOKEN`, backfill only works for public repositories and uses lower GitHub API rate limits
- With `GITHUB_TOKEN`, private repositories can be backfilled if the token can access them

## Migrations

Current migration:

- `migrations/0001_initial_schema.sql`

Useful commands:

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

## Testing

Run the test suite:

```bash
npx vitest run
```

Type-check the project:

```bash
npx tsc --noEmit
```

## Publishing this repo safely

Safe to commit:

- source code under `src/`
- `migrations/`
- `README.md`
- `package.json`
- `package-lock.json`
- `wrangler.jsonc`
- `worker-configuration.d.ts`
- tests

Do not commit:

- `.dev.vars`
- `.env`
- `.wrangler/`
- any real secrets copied into a file

Before pushing to GitHub, it is worth checking:

```bash
git status
git diff
```

## Notes

- Local D1 and remote D1 are separate databases
- Local OAuth success does not automatically configure production OAuth
- Closed GitHub issues are completed in TickTick, not deleted
- Reopened GitHub issues currently create a fresh TickTick task and overwrite the mapping to the new task
