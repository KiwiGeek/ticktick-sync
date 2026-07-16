# TickTick Sync Worker

Cloudflare Workers service built with TypeScript, Hono, and D1 that syncs GitHub issues and/or Azure DevOps Taskboard work items into TickTick tasks.

**New here?** Follow the full setup guide: [ONBOARDING.md](./ONBOARDING.md)

GitHub and Azure DevOps are **independent optional sources** — enable either one, or both.

## Overview

This Worker mirrors work from optional source trackers into TickTick lists.

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

GitHub and Azure DevOps can target **different TickTick lists**.

## Features

- Hono-based Cloudflare Worker
- D1 storage for OAuth tokens and source-to-TickTick mappings
- TickTick OAuth with access-token refresh
- GitHub `X-Hub-Signature-256` validation using the raw request body
- Azure DevOps Service Hook basic-auth validation
- Idempotent webhook handling with delivery deduplication
- Per-source TickTick list routing
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

- `oauth_tokens` — TickTick OAuth tokens and refresh metadata
- `synced_items` — mapping between a source item (`github_issue` or `azure_devops_workitem`) and a TickTick task
- `webhook_deliveries` — processed webhook delivery IDs (dedup)
- `github_deliveries` — legacy table retained for migration compatibility

### List routing

| Source | TickTick list var |
|--------|-------------------|
| GitHub issues | `GITHUB_TICKTICK_PROJECT_ID` |
| Azure DevOps work items | `AZURE_DEVOPS_TICKTICK_PROJECT_ID` |

If a source-specific var is unset, the Worker falls back to legacy `TICKTICK_PROJECT_ID`.

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

### Non-secret vars (`wrangler.jsonc`)

| Var | Purpose |
|-----|---------|
| `GITHUB_TICKTICK_PROJECT_ID` | TickTick list ID for GitHub-synced tasks |
| `AZURE_DEVOPS_TICKTICK_PROJECT_ID` | TickTick list ID for Azure DevOps-synced tasks |
| `TICKTICK_PROJECT_ID` | Optional legacy fallback if a source-specific list ID is unset |
| `GITHUB_LOGIN` | Informational GitHub username |
| `AZURE_DEVOPS_ORG` | Azure DevOps organization name |
| `AZURE_DEVOPS_PROJECT` | Azure DevOps project name |
| `AZURE_DEVOPS_TEAM` | Team for current sprint / Taskboard (defaults to project name) |
| `AZURE_DEVOPS_WORK_ITEM_TYPES` | Comma-separated types to sync (default `Task,Bug`) |

Example:

```jsonc
"vars": {
  "GITHUB_TICKTICK_PROJECT_ID": "your_github_ticktick_list_id",
  "AZURE_DEVOPS_TICKTICK_PROJECT_ID": "your_azure_devops_ticktick_list_id",
  "GITHUB_LOGIN": "your_github_username",
  "AZURE_DEVOPS_ORG": "your-org",
  "AZURE_DEVOPS_PROJECT": "your-project",
  "AZURE_DEVOPS_TEAM": "your-team",
  "AZURE_DEVOPS_WORK_ITEM_TYPES": "Task,Bug"
}
```

### Secrets (Wrangler / `.dev.vars`)

Always required:

| Secret | Purpose |
|--------|---------|
| `TICKTICK_CLIENT_ID` | TickTick OAuth client id |
| `TICKTICK_CLIENT_SECRET` | TickTick OAuth client secret |
| `DEBUG_TOKEN` | Bearer token for debug/backfill endpoints |

Only if using GitHub:

| Secret | Purpose |
|--------|---------|
| `GITHUB_WEBHOOK_SECRET` | GitHub webhook HMAC secret |
| `GITHUB_TOKEN` | Optional GitHub PAT for private backfill / rate limits |

Only if using Azure DevOps:

| Secret | Purpose |
|--------|---------|
| `AZURE_DEVOPS_PAT` | Azure DevOps PAT (Work Items Read) |
| `AZURE_DEVOPS_WEBHOOK_USERNAME` | Service Hook basic-auth username |
| `AZURE_DEVOPS_WEBHOOK_SECRET` | Service Hook basic-auth password |

Local template:

```bash
cp .dev.vars.example .dev.vars
```

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

`.dev.vars*`, `.env*`, and `.wrangler/` are gitignored.

## Quick start

Full walkthrough (where to get every key, local + production): **[ONBOARDING.md](./ONBOARDING.md)**

```bash
npm install
cp .dev.vars.example .dev.vars   # fill secrets
# edit wrangler.jsonc vars
npm run db:migrate:local
npm run cf-typegen
npm run dev                      # http://localhost:8787
```

Then:

1. Open `/auth/ticktick/start` (register `http://localhost:8787/auth/ticktick/callback` in TickTick first)
2. `GET /debug/projects` with `Authorization: Bearer <DEBUG_TOKEN>`
3. Set `GITHUB_TICKTICK_PROJECT_ID` and `AZURE_DEVOPS_TICKTICK_PROJECT_ID`
4. Backfill / configure webhooks as described in ONBOARDING.md

## Backfill behavior

### GitHub

- Only open issues are imported
- Pull requests are ignored
- Existing mapped issues are updated, not duplicated
- Without `GITHUB_TOKEN`, backfill only works for public repositories

### Azure DevOps

- Targets the team's **current iteration**
- Prefers the Taskboard Work Items API, then falls back to WIQL
- Imports unfulfilled configured work item types (`Done` / `Closed` / `Removed` / `Completed` skipped)
- Existing mapped work items are updated, not duplicated
- Requires `AZURE_DEVOPS_PAT` with Work Items Read

## Migrations

- `migrations/0001_initial_schema.sql`
- `migrations/0002_webhook_deliveries.sql`

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

## Testing

```bash
npx vitest run
npx tsc --noEmit
```

## Notes

- Local D1 and remote D1 are separate databases
- Local OAuth success does not configure production OAuth
- Closed / fulfilled source items are completed in TickTick, not deleted
- Reopened source items create a fresh TickTick task and overwrite the mapping
