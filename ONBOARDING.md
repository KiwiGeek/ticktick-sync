# Onboarding: Deploy TickTick Sync

This guide walks through a full setup of the TickTick Sync Worker — from collecting credentials to verifying sync in production.

For architecture and endpoint reference, see [README.md](./README.md).

## Choose your sources

GitHub and Azure DevOps are **both optional**. Enable whichever you need:

| Mode | What to configure |
|------|-------------------|
| GitHub only | TickTick + GitHub sections |
| Azure DevOps only | TickTick + Azure DevOps sections |
| Both | Everything |

Skip any section marked for a source you are not using.

---

## What you are building

A Cloudflare Worker that:

1. Optionally receives GitHub issue webhooks and/or Azure DevOps work-item Service Hooks
2. Creates / updates / completes tasks in TickTick
3. Stores OAuth tokens and source↔TickTick mappings in Cloudflare D1

Sync is **one-way only** (sources → TickTick).

If you enable both sources, they can target **different TickTick lists**.

---

## Prerequisites

Always required:

- Node.js 20+
- npm
- A Cloudflare account
- A TickTick account
- `wrangler` login access (`npx wrangler login`)

Only if using GitHub:

- Access to the GitHub repos you want to sync

Only if using Azure DevOps:

- Access to the Azure DevOps org/project/team you want to sync

---

## Credential checklist

### Always required

| Name | Type | Used for |
|------|------|----------|
| `TICKTICK_CLIENT_ID` | secret | TickTick OAuth |
| `TICKTICK_CLIENT_SECRET` | secret | TickTick OAuth |
| `DEBUG_TOKEN` | secret | Protecting debug/backfill endpoints |

### Only if using GitHub

| Name | Type | Used for |
|------|------|----------|
| `GITHUB_WEBHOOK_SECRET` | secret | Verifying GitHub webhooks |
| `GITHUB_TICKTICK_PROJECT_ID` | var | TickTick list for GitHub issues |
| `GITHUB_TOKEN` | secret | Optional: private-repo backfill / higher rate limits |
| `GITHUB_LOGIN` | var | Optional: informational |

### Only if using Azure DevOps

| Name | Type | Used for |
|------|------|----------|
| `AZURE_DEVOPS_PAT` | secret | Reading work items / Taskboard |
| `AZURE_DEVOPS_WEBHOOK_SECRET` | secret | Service Hook basic-auth password |
| `AZURE_DEVOPS_WEBHOOK_USERNAME` | secret | Recommended basic-auth username |
| `AZURE_DEVOPS_TICKTICK_PROJECT_ID` | var | TickTick list for ADO work items |
| `AZURE_DEVOPS_ORG` | var | ADO organization name |
| `AZURE_DEVOPS_PROJECT` | var | ADO project name |
| `AZURE_DEVOPS_TEAM` | var | Recommended: team for current sprint / Taskboard |
| `AZURE_DEVOPS_WORK_ITEM_TYPES` | var | Optional: default `Task,Bug` |

Details for each credential are below.

---

## 1. Create the TickTick developer app

Required for every deployment.

1. Go to the [TickTick Developer](https://developer.ticktick.com/) portal and sign in.
2. Create an application / OAuth client.
3. Copy:
   - **Client ID** → `TICKTICK_CLIENT_ID`
   - **Client Secret** → `TICKTICK_CLIENT_SECRET`
4. Register redirect URIs (exact match required):

Local:

```text
http://localhost:8787/auth/ticktick/callback
```

Production (add after you know the Worker URL):

```text
https://<your-worker>.workers.dev/auth/ticktick/callback
```

You can register both URIs on the same TickTick app.

---

## 2. Choose (or create) TickTick lists

Create one TickTick list per source you plan to enable.

| If you enable… | Create a list for… | Later set… |
|----------------|--------------------|------------|
| GitHub | GitHub issues | `GITHUB_TICKTICK_PROJECT_ID` |
| Azure DevOps | ADO Taskboard items | `AZURE_DEVOPS_TICKTICK_PROJECT_ID` |
| Both | Either one shared list, or two separate lists | both vars above |

You do **not** need the list IDs yet. After OAuth works, the Worker can list them via `/debug/projects`.

---

## 3. Create a DEBUG_TOKEN

Required for every deployment.

This is a shared secret you invent. It gates:

- `GET /debug/projects`
- `POST /sync/github/open-issues` (GitHub only)
- `POST /sync/azure-devops/taskboard` (Azure DevOps only)

Generate something long and random, for example:

```bash
openssl rand -hex 32
```

Save it as `DEBUG_TOKEN`.

---

## 4. GitHub credentials (optional)

Skip this entire section if you are not syncing GitHub.

### 4a. Webhook secret

1. Invent a random secret (or use `openssl rand -hex 32`).
2. Save it as `GITHUB_WEBHOOK_SECRET`.
3. You will paste the **same value** into the GitHub webhook “Secret” field later.

### 4b. Optional GitHub personal access token

Needed only if you want to backfill **private** repos or avoid unauthenticated rate limits.

1. GitHub → Settings → Developer settings → Personal access tokens
2. Create a classic or fine-grained token with access to the target repositories
3. Minimum useful scope: read issues / contents for those repos (`repo` for classic PATs on private repos)
4. Save as `GITHUB_TOKEN`

---

## 5. Azure DevOps credentials (optional)

Skip this entire section if you are not syncing Azure DevOps.

### 5a. Organization / project / team

From a board URL like:

```text
https://dev.azure.com/Contoso/Fabrikam/_boards/taskboard/TeamAlpha
```

| Value | Maps to |
|-------|---------|
| `Contoso` | `AZURE_DEVOPS_ORG` |
| `Fabrikam` | `AZURE_DEVOPS_PROJECT` |
| `TeamAlpha` | `AZURE_DEVOPS_TEAM` |

If you omit `AZURE_DEVOPS_TEAM`, the Worker defaults to the project name.

### 5b. Personal Access Token (PAT)

1. In Azure DevOps, open **User settings → Personal access tokens**
2. Create a new token
3. Organization: the org you will sync
4. Scopes: **Work Items → Read** (minimum)
5. Copy the token once → `AZURE_DEVOPS_PAT`

### 5c. Service Hook basic auth credentials

Azure DevOps Service Hooks authenticate with HTTP Basic Auth (not HMAC).

1. Choose a username, e.g. `ticktick-sync` → `AZURE_DEVOPS_WEBHOOK_USERNAME`
2. Generate a password secret → `AZURE_DEVOPS_WEBHOOK_SECRET`
3. You will enter the same username/password in the Service Hook UI later

---

## 6. Local development setup

### 6a. Install

```bash
git clone <your-repo-url>
cd ticktick-sync
npm install
```

### 6b. Local secrets

```bash
cp .dev.vars.example .dev.vars
```

Start with the always-required secrets, then add only the sources you use:

```dotenv
# Always required
TICKTICK_CLIENT_ID=...
TICKTICK_CLIENT_SECRET=...
DEBUG_TOKEN=...

# Only if using GitHub
GITHUB_WEBHOOK_SECRET=...
GITHUB_TOKEN=...                          # optional even when using GitHub

# Only if using Azure DevOps
AZURE_DEVOPS_PAT=...
AZURE_DEVOPS_WEBHOOK_USERNAME=ticktick-sync
AZURE_DEVOPS_WEBHOOK_SECRET=...
```

Never commit `.dev.vars`.

### 6c. Non-secret vars

Edit `wrangler.jsonc` `vars` for the sources you enabled.

Azure DevOps only example:

```jsonc
"vars": {
  "AZURE_DEVOPS_TICKTICK_PROJECT_ID": "YOUR_AZURE_DEVOPS_TICKTICK_LIST_ID",
  "AZURE_DEVOPS_ORG": "your-org",
  "AZURE_DEVOPS_PROJECT": "your-project",
  "AZURE_DEVOPS_TEAM": "your-team",
  "AZURE_DEVOPS_WORK_ITEM_TYPES": "Task,Bug"
}
```

GitHub only example:

```jsonc
"vars": {
  "GITHUB_TICKTICK_PROJECT_ID": "YOUR_GITHUB_TICKTICK_LIST_ID",
  "GITHUB_LOGIN": "your-github-username"
}
```

Both sources example:

```jsonc
"vars": {
  "GITHUB_TICKTICK_PROJECT_ID": "YOUR_GITHUB_TICKTICK_LIST_ID",
  "AZURE_DEVOPS_TICKTICK_PROJECT_ID": "YOUR_AZURE_DEVOPS_TICKTICK_LIST_ID",
  "GITHUB_LOGIN": "your-github-username",
  "AZURE_DEVOPS_ORG": "your-org",
  "AZURE_DEVOPS_PROJECT": "your-project",
  "AZURE_DEVOPS_TEAM": "your-team",
  "AZURE_DEVOPS_WORK_ITEM_TYPES": "Task,Bug"
}
```

You can leave TickTick list IDs as placeholders until after OAuth.

### 6d. Migrate local D1 and generate types

```bash
npm run db:migrate:local
npm run cf-typegen
```

### 6e. Start locally

```bash
npm run dev
```

Health check:

```bash
curl http://localhost:8787/health
```

### 6f. Complete local TickTick OAuth

1. Confirm the local redirect URI is registered in TickTick
2. Open `http://localhost:8787/auth/ticktick/start`
3. Approve access
4. You should see JSON confirming OAuth connected

### 6g. Discover TickTick list IDs

```bash
curl -H "Authorization: Bearer YOUR_DEBUG_TOKEN" \
  http://localhost:8787/debug/projects
```

Copy the `id` for each list you are using into `wrangler.jsonc`:

- GitHub (if enabled) → `GITHUB_TICKTICK_PROJECT_ID`
- Azure DevOps (if enabled) → `AZURE_DEVOPS_TICKTICK_PROJECT_ID`

Restart `npm run dev` after changing vars.

### 6h. Local backfill smoke tests

Run only the backfill(s) for sources you enabled.

GitHub (optional):

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_DEBUG_TOKEN" \
  "http://localhost:8787/sync/github/open-issues?repo=OWNER/REPO"
```

Azure DevOps Taskboard (optional):

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_DEBUG_TOKEN" \
  "http://localhost:8787/sync/azure-devops/taskboard"
```

Confirm tasks appear in the expected TickTick list(s).

### 6i. Local webhook testing

Live webhooks need a **public HTTPS** URL.

Options:

- Deploy to Cloudflare first (recommended), or
- Tunnel local `8787` with Cloudflare Tunnel / ngrok and point webhooks at the tunnel URL

Backfill does **not** require a tunnel.

---

## 7. Cloudflare production deployment

### 7a. Log in to Cloudflare

```bash
npx wrangler login
```

### 7b. Confirm D1 database

This repo already references a D1 database in `wrangler.jsonc`:

- binding: `ticktick_sync`
- database name: `ticktick_sync`

If you are setting up a **new** Cloudflare account/project, create a D1 database and put its id into `wrangler.jsonc`:

```bash
npx wrangler d1 create ticktick_sync
```

### 7c. Set production vars

Update `wrangler.jsonc` with real values for the sources you enabled (same as local once list IDs are known).

### 7d. Set production secrets

Always set:

```bash
npx wrangler secret put TICKTICK_CLIENT_ID
npx wrangler secret put TICKTICK_CLIENT_SECRET
npx wrangler secret put DEBUG_TOKEN
```

Only if using GitHub:

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_TOKEN          # optional
```

Only if using Azure DevOps:

```bash
npx wrangler secret put AZURE_DEVOPS_PAT
npx wrangler secret put AZURE_DEVOPS_WEBHOOK_USERNAME
npx wrangler secret put AZURE_DEVOPS_WEBHOOK_SECRET
```

### 7e. Apply remote migrations

```bash
npm run db:migrate:remote
```

### 7f. Deploy

```bash
npm run deploy
```

Copy the printed Worker URL, e.g.:

```text
https://ticktick-sync.<your-subdomain>.workers.dev
```

---

## 8. Production TickTick OAuth

Required for every deployment. Local OAuth tokens do **not** carry over to production (separate D1 databases).

1. Add the production callback URI in the TickTick developer app:

```text
https://<your-worker>.workers.dev/auth/ticktick/callback
```

2. Open:

```text
https://<your-worker>.workers.dev/auth/ticktick/start
```

3. Verify:

```bash
curl -H "Authorization: Bearer YOUR_DEBUG_TOKEN" \
  https://<your-worker>.workers.dev/debug/projects
```

---

## 9. Configure the GitHub webhook (optional)

Skip this section if you are not syncing GitHub.

In the GitHub repo (or org / GitHub App):

1. Settings → Webhooks → Add webhook
2. Payload URL:

```text
https://<your-worker>.workers.dev/webhooks/github
```

3. Content type: `application/json`
4. Secret: exactly `GITHUB_WEBHOOK_SECRET`
5. Events: **Issues** only (or “Let me select…” → Issues)
6. Save

Test by opening or editing an issue. A task should appear in the GitHub TickTick list.

Then backfill existing open issues if needed:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_DEBUG_TOKEN" \
  "https://<your-worker>.workers.dev/sync/github/open-issues?repo=OWNER/REPO"
```

---

## 10. Configure Azure DevOps Service Hooks (optional)

Skip this section if you are not syncing Azure DevOps.

In Azure DevOps:

**Project settings → Service hooks → Create subscription → Web Hooks**

Create one subscription per event (recommended):

| Event | Purpose |
|-------|---------|
| Work item created | New Task/Bug → TickTick task |
| Work item updated | Edits / state changes |
| Work item deleted | Complete mapped TickTick task |
| Work item restored | Recreate / reopen mapping |

For each subscription, Action settings:

| Field | Value |
|-------|-------|
| URL | `https://<your-worker>.workers.dev/webhooks/azure-devops` |
| Basic auth username | `AZURE_DEVOPS_WEBHOOK_USERNAME` |
| Basic auth password | `AZURE_DEVOPS_WEBHOOK_SECRET` |
| Resource details to send | **All** |

Optional filters:

- Work item type: `Task` and/or `Bug`  
  (the Worker also filters by `AZURE_DEVOPS_WORK_ITEM_TYPES`)

Use the Service Hook **Test** button if available, then backfill the current Taskboard:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_DEBUG_TOKEN" \
  "https://<your-worker>.workers.dev/sync/azure-devops/taskboard"
```

Optional team override:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_DEBUG_TOKEN" \
  "https://<your-worker>.workers.dev/sync/azure-devops/taskboard?team=TeamName"
```

---

## 11. Verify end-to-end

Run only the checks for sources you enabled.

### GitHub (if enabled)

1. Open a new issue → TickTick task created in the GitHub list
2. Edit the issue title → TickTick task title updates
3. Close the issue → TickTick task completes
4. Reopen the issue → new TickTick task is created and mapping is rewritten

### Azure DevOps (if enabled)

1. Create an unfulfilled Task/Bug on the current Taskboard → TickTick task in the ADO list
2. Update title/state (still unfulfilled) → TickTick task updates
3. Move to Done/Closed → TickTick task completes
4. Reopen → new TickTick task is created

---

## 12. Operational notes

- **Sources are independent.** You can run GitHub only, Azure DevOps only, or both.
- **Local vs production D1 are separate.** Re-run OAuth and migrations in each environment.
- **List routing**
  - GitHub → `GITHUB_TICKTICK_PROJECT_ID`
  - Azure DevOps → `AZURE_DEVOPS_TICKTICK_PROJECT_ID`
  - Legacy fallback: `TICKTICK_PROJECT_ID` if a source-specific id is unset
- **Reopened items** create a new TickTick task (they do not un-complete the old one).
- **Azure DevOps backfill** uses the team’s current iteration and prefers the Taskboard API, with WIQL fallback.
- **Do not commit secrets.** Keep them in `.dev.vars` locally and Wrangler secrets in production.

---

## 13. Common failures

| Symptom | Likely cause |
|---------|----------------|
| TickTick OAuth fails with redirect mismatch | Callback URI not registered exactly (including `http` vs `https`) |
| `/debug/projects` returns 401 | Wrong or missing `DEBUG_TOKEN` Bearer header |
| GitHub webhook 401 | `GITHUB_WEBHOOK_SECRET` mismatch (or GitHub not configured) |
| Azure DevOps webhook 401 | Basic auth username/password mismatch |
| Azure DevOps webhook 403 | `AZURE_DEVOPS_WEBHOOK_SECRET` not configured on the Worker |
| ADO backfill says org/project must be configured | Still using `YOUR_ORG` / `YOUR_PROJECT` placeholders |
| ADO backfill 401/403 from Azure | PAT missing, expired, or lacks Work Items Read |
| Tasks go to the wrong TickTick list | Wrong `GITHUB_TICKTICK_PROJECT_ID` / `AZURE_DEVOPS_TICKTICK_PROJECT_ID` |
| No tasks created after OAuth | Forgot production OAuth (local tokens are not shared) |
| D1 errors about missing tables | Run `npm run db:migrate:local` or `npm run db:migrate:remote` |

---

## Quick command reference

```bash
# Local
npm install
cp .dev.vars.example .dev.vars   # fill only the secrets you need
npm run db:migrate:local
npm run cf-typegen
npm run dev

# Production
npx wrangler login
npx wrangler secret put TICKTICK_CLIENT_ID
npx wrangler secret put TICKTICK_CLIENT_SECRET
npx wrangler secret put DEBUG_TOKEN
# plus only the GitHub and/or Azure DevOps secrets you need
npm run db:migrate:remote
npm run deploy

# Verify (always)
curl https://<worker>/health
curl -H "Authorization: Bearer $DEBUG_TOKEN" https://<worker>/debug/projects

# Verify GitHub (only if enabled)
curl -X POST -H "Authorization: Bearer $DEBUG_TOKEN" \
  "https://<worker>/sync/github/open-issues?repo=OWNER/REPO"

# Verify Azure DevOps (only if enabled)
curl -X POST -H "Authorization: Bearer $DEBUG_TOKEN" \
  "https://<worker>/sync/azure-devops/taskboard"
```
