# TickTick Sync Worker

Cloudflare Workers service built with TypeScript, Hono, and D1 that syncs GitHub issues and Azure DevOps Taskboard work items into TickTick tasks.

## Overview

This Worker mirrors work from source trackers into a TickTick project.

### GitHub issues

- `opened` creates a TickTick task
- `edited` updates the existing mapped TickTick task
- `closed` completes the TickTick task
- `reopened` creates a fresh TickTick task and rewrites the mapping

### Azure DevOps Taskboard items

- Unfulfilled Task / Bug items on the current sprint Taskboard create or update TickTick tasks
- Moving an item to a fulfilled state (`Done`, `Closed`, `Removed`, `Completed`) completes the TickTick task
- Reopening a fulfilled item creates a fresh TickTick task and rewrites the mapping
- Deleted work items complete the mapped TickTick task

The sync is intentionally one-way:

- GitHub / Azure DevOps are the source of truth
- TickTick is the attention layer
- The Worker never edits GitHub issues or Azure DevOps work items from TickTick

## Features

- Hono-based Cloudflare Worker
- D1 storage for OAuth tokens and source-to-TickTick mappings
- TickTick OAuth with access-token refresh
- GitHub `X-Hub-Signature-256` validation using the raw request body
- Azure DevOps Service Hook basic-auth validation
- Idempotent webhook handling with delivery deduplication
- Protected debug endpoints
- Backfill endpoints for existing open GitHub issues and unfulfilled Azure DevOps Taskboard items

## Endpoints

- `GET /health`
- `GET /auth/ticktick/start`
- `GET /auth/ticktick/callback`
- `POST /webhooks/github`
- `POST /webhooks/azure-devops`
- `GET /debug/projects`
- `POST /sync/github/open-issues?repo=owner/repo`
- `POST /sync/azure-devops/taskboard`
- `POST /sync/azure-devops/taskboard?team=TeamName` optional team override

## Architecture

### D1 tables

- `oauth_tokens`
  Stores TickTick OAuth tokens and refresh metadata.
- `synced_items`
  Stores the mapping between a source item (`github_issue` or `azure_devops_workitem`) and a TickTick task.
- `webhook_deliveries`
  Stores processed webhook delivery IDs so duplicate deliveries do not create duplicate tasks.
- `github_deliveries`
  Legacy table retained for migration compatibility.

### GitHub task format

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

### Azure DevOps task format

Title:

```text
[Task#42] Implement login
```

Body:

```text
Azure DevOps: https://dev.azure.com/org/project/_workitems/edit/42
Project: org/project
Type: Task
State: Active
Assigned To: someone
Iteration: project\Sprint 1
Area: project
Tags: none

<description>
```

## Configuration

### Non-secret vars in `wrangler.jsonc`

- `TICKTICK_PROJECT_ID`
  TickTick project/list ID where tasks should be created.
- `GITHUB_LOGIN`
  Your GitHub username. Informational config.
- `AZURE_DEVOPS_ORG`
  Azure DevOps organization name (the `org` in `dev.azure.com/org`).
- `AZURE_DEVOPS_PROJECT`
  Azure DevOps project name.
- `AZURE_DEVOPS_TEAM`
  Team used for the current sprint / Taskboard. Defaults to the project name when empty.
- `AZURE_DEVOPS_WORK_ITEM_TYPES`
  Comma-separated Taskboard types to sync. Default: `Task,Bug`.

### Secrets

- `TICKTICK_CLIENT_ID`
- `TICKTICK_CLIENT_SECRET`
- `GITHUB_WEBHOOK_SECRET`
- `DEBUG_TOKEN`
- `GITHUB_TOKEN` optional, for private repo backfill or better GitHub API rate limits
- `AZURE_DEVOPS_PAT` required for Azure DevOps API backfill and webhook hydration
- `AZURE_DEVOPS_WEBHOOK_USERNAME` optional basic-auth username for Service Hooks (recommended: `ticktick-sync`)
- `AZURE_DEVOPS_WEBHOOK_SECRET` basic-auth password for Service Hooks

### Local secrets

Create a local `.dev.vars` file in the project root:

```dotenv
TICKTICK_CLIENT_ID=your_ticktick_client_id
TICKTICK_CLIENT_SECRET=your_ticktick_client_secret
GITHUB_WEBHOOK_SECRET=your_github_webhook_secret
DEBUG_TOKEN=your_local_debug_token
GITHUB_TOKEN=optional_github_token
AZURE_DEVOPS_PAT=your_azure_devops_pat
AZURE_DEVOPS_WEBHOOK_USERNAME=ticktick-sync
AZURE_DEVOPS_WEBHOOK_SECRET=your_azure_devops_webhook_secret
```

Also set Azure DevOps org/project/team in `wrangler.jsonc` `vars` (or override with Wrangler env vars).

The repository ignores `.dev.vars*`, `.env*`, and `.wrangler/`, so local secrets and local D1 state are not committed.

## First-time local setup (new computer)

If you previously set this up on another machine, walk through these steps on this computer.

### 1. Install toolchain

You need Node.js 20+ and npm.

```bash
node -v
npm -v
```

### 2. Clone and install

```bash
git clone <your-repo-url>
cd ticktick-sync
npm install
```

### 3. Recreate local secrets

Copy the example file:

```bash
cp .dev.vars.example .dev.vars
```

Fill in values from your other computer or regenerate:

| Secret | Where to get it |
|--------|-----------------|
| `TICKTICK_CLIENT_ID` / `TICKTICK_CLIENT_SECRET` | [TickTick Developer](https://developer.ticktick.com/) app settings |
| `GITHUB_WEBHOOK_SECRET` | Same secret you configured on the GitHub webhook |
| `DEBUG_TOKEN` | Any long random string you choose |
| `GITHUB_TOKEN` | Optional GitHub PAT with `repo` scope for private backfill |
| `AZURE_DEVOPS_PAT` | Azure DevOps → User settings → Personal access tokens. Scopes: **Work Items (Read)** |
| `AZURE_DEVOPS_WEBHOOK_USERNAME` / `AZURE_DEVOPS_WEBHOOK_SECRET` | Values you will enter in the Azure DevOps Service Hook basic auth fields |

### 4. Set Azure DevOps vars

In `wrangler.jsonc`:

```jsonc
"vars": {
  "TICKTICK_PROJECT_ID": "your_ticktick_project_id",
  "GITHUB_LOGIN": "your_github_username",
  "AZURE_DEVOPS_ORG": "your-org",
  "AZURE_DEVOPS_PROJECT": "your-project",
  "AZURE_DEVOPS_TEAM": "your-team",
  "AZURE_DEVOPS_WORK_ITEM_TYPES": "Task,Bug"
}
```

### 5. Apply local D1 migrations and generate types

```bash
npm run db:migrate:local
npm run cf-typegen
```

### 6. Start the Worker

```bash
npm run dev
```

Default local URL:

```text
http://localhost:8787
```

### 7. Connect TickTick OAuth locally

1. Ensure your TickTick app has this redirect URI registered exactly:

```text
http://localhost:8787/auth/ticktick/callback
```

2. Open:

```text
http://localhost:8787/auth/ticktick/start
```

3. Confirm `/debug/projects` works:

```bash
curl -H "Authorization: Bearer YOUR_DEBUG_TOKEN" http://localhost:8787/debug/projects
```

4. If needed, copy a project `id` into `TICKTICK_PROJECT_ID` and restart `npm run dev`.

### 8. Smoke-test Azure DevOps backfill

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_DEBUG_TOKEN" \
  "http://localhost:8787/sync/azure-devops/taskboard"
```

Expected JSON includes `totalWorkItems`, `iteration`, `source` (`taskboard` or `wiql`), and `actionCounts`.

### 9. Local webhook testing tip

Azure DevOps Service Hooks require a public HTTPS URL. For local webhook delivery, use a tunnel (for example Cloudflare Tunnel or ngrok) pointed at `http://localhost:8787`, then set the Service Hook URL to:

```text
https://<tunnel-host>/webhooks/azure-devops
```

Backfill works without a tunnel.

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

## Deploying to Cloudflare

This is the recommended production order.

### 1. Set non-secret vars

In `wrangler.jsonc`, set:

```jsonc
"vars": {
  "TICKTICK_PROJECT_ID": "your_real_project_id",
  "GITHUB_LOGIN": "your_github_username",
  "AZURE_DEVOPS_ORG": "your-org",
  "AZURE_DEVOPS_PROJECT": "your-project",
  "AZURE_DEVOPS_TEAM": "your-team",
  "AZURE_DEVOPS_WORK_ITEM_TYPES": "Task,Bug"
}
```

### 2. Set production secrets

```bash
npx wrangler secret put TICKTICK_CLIENT_ID
npx wrangler secret put TICKTICK_CLIENT_SECRET
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put DEBUG_TOKEN
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put AZURE_DEVOPS_PAT
npx wrangler secret put AZURE_DEVOPS_WEBHOOK_USERNAME
npx wrangler secret put AZURE_DEVOPS_WEBHOOK_SECRET
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

### 9. Configure Azure DevOps Service Hooks

In Azure DevOps: **Project settings → Service hooks → Create subscription → Web Hooks**.

Create subscriptions for:

- Work item created
- Work item updated
- Work item deleted
- Work item restored (optional)

Action settings:

- URL: `https://<your-worker>.workers.dev/webhooks/azure-devops`
- Basic authentication username: same as `AZURE_DEVOPS_WEBHOOK_USERNAME`
- Basic authentication password: same as `AZURE_DEVOPS_WEBHOOK_SECRET`
- Resource details to send: **All**

Optional filters:

- Work item type: `Task` and/or `Bug` (or rely on the Worker filter)

### 10. Backfill existing open work

GitHub:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_DEBUG_TOKEN" \
  "https://<your-worker>.workers.dev/sync/github/open-issues?repo=OWNER/REPO"
```

Azure DevOps current Taskboard:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_DEBUG_TOKEN" \
  "https://<your-worker>.workers.dev/sync/azure-devops/taskboard"
```

## Backfill behavior

### GitHub

- Only open issues are imported
- Pull requests are ignored
- Existing mapped issues are updated, not duplicated
- Without `GITHUB_TOKEN`, backfill only works for public repositories and uses lower GitHub API rate limits
- With `GITHUB_TOKEN`, private repositories can be backfilled if the token can access them

### Azure DevOps

- Targets the team's **current iteration**
- Prefers the Taskboard Work Items API, then falls back to WIQL if the Taskboard API is unavailable
- Imports unfulfilled `Task` / `Bug` items by default (`Done` / `Closed` / `Removed` / `Completed` are skipped)
- Existing mapped work items are updated, not duplicated
- Requires `AZURE_DEVOPS_PAT` with Work Items Read

## Migrations

Current migrations:

- `migrations/0001_initial_schema.sql`
- `migrations/0002_webhook_deliveries.sql`

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
- Closed / fulfilled source items are completed in TickTick, not deleted
- Reopened source items currently create a fresh TickTick task and overwrite the mapping to the new task
