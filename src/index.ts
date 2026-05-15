import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { Database } from "./db";
import {
	buildTaskContent,
	buildTaskTitle,
	listOpenRepositoryIssues,
	toIssuePayload,
	verifyGitHubSignature,
} from "./github";
import {
	buildAuthorizeUrl,
	completeTask,
	createTask,
	exchangeCodeForToken,
	listProjects,
	updateTask,
} from "./ticktick";
import type { AppBindings, GitHubIssuePayload, SyncedItemRow } from "./types";

type AppEnv = {
	Bindings: AppBindings;
};

type SyncAction = "created" | "updated" | "completed" | "ignored" | "recreated";

const OAUTH_STATE_COOKIE = "ticktick_oauth_state";

const app = new Hono<AppEnv>();

const jsonError = (message: string, status = 400) =>
	Response.json({ ok: false, error: message }, { status });

const redirectUriFromRequest = (request: Request) =>
	new URL("/auth/ticktick/callback", request.url).toString();

const randomState = (): string => crypto.randomUUID();

const getDatabase = (env: AppBindings) => new Database(env.ticktick_sync);

const requireDebugToken = (request: Request, env: AppBindings): Response | null => {
	const expectedToken = env.DEBUG_TOKEN?.trim();
	if (!expectedToken) {
		return jsonError("DEBUG_TOKEN must be configured for this endpoint.", 403);
	}

	const bearer = request.headers.get("authorization");
	if (bearer !== `Bearer ${expectedToken}`) {
		return jsonError("Unauthorized debug access.", 401);
	}

	return null;
};

const buildSyncedItemRow = (
	payload: GitHubIssuePayload,
	tickTickTaskId: string,
	status: string,
	projectId: string,
): SyncedItemRow => ({
	source: "github_issue",
	source_repo: payload.repository.full_name,
	source_item_id: String(payload.issue.id),
	source_item_number: payload.issue.number,
	source_url: payload.issue.html_url,
	ticktick_project_id: projectId,
	ticktick_task_id: tickTickTaskId,
	status,
	title: buildTaskTitle(payload),
	updated_at: new Date().toISOString(),
});

const syncIssueToTickTick = async (
	env: AppBindings,
	payload: GitHubIssuePayload,
): Promise<{ action: SyncAction }> => {
	const db = getDatabase(env);
	const source = "github_issue";
	const sourceItemId = String(payload.issue.id);
	const title = buildTaskTitle(payload);
	const content = buildTaskContent(payload);
	const projectId = env.TICKTICK_PROJECT_ID;
	const existing = await db.getSyncedItem(source, payload.repository.full_name, sourceItemId);

	if (payload.action === "closed") {
		if (existing) {
			await completeTask(env, db, existing.ticktick_project_id, existing.ticktick_task_id);
			await db.saveSyncedItem(
				buildSyncedItemRow(payload, existing.ticktick_task_id, "completed", existing.ticktick_project_id),
			);
		}
		return { action: existing ? "completed" : "ignored" };
	}

	if (payload.action === "reopened") {
		const recreated = await createTask(env, db, {
			projectId,
			title,
			content,
		});
		await db.saveSyncedItem(buildSyncedItemRow(payload, recreated.id, "open", projectId));
		return { action: existing ? "recreated" : "created" };
	}

	if (existing) {
		await updateTask(env, db, {
			id: existing.ticktick_task_id,
			projectId: existing.ticktick_project_id,
			title,
			content,
		});
		await db.saveSyncedItem(
			buildSyncedItemRow(payload, existing.ticktick_task_id, "open", existing.ticktick_project_id),
		);
		return { action: "updated" };
	}

	const created = await createTask(env, db, {
		projectId,
		title,
		content,
	});
	await db.saveSyncedItem(buildSyncedItemRow(payload, created.id, "open", projectId));
	return { action: "created" };
};

app.get("/health", (c) =>
	c.json({
		ok: true,
		service: "ticktick-sync",
		timestamp: new Date().toISOString(),
	}),
);

app.get("/auth/ticktick/start", (c) => {
	const state = randomState();
	const redirectUri = redirectUriFromRequest(c.req.raw);
	setCookie(c, OAUTH_STATE_COOKIE, state, {
		httpOnly: true,
		path: "/auth/ticktick",
		sameSite: "Lax",
		secure: true,
		maxAge: 600,
	});

	return c.redirect(buildAuthorizeUrl(c.env.TICKTICK_CLIENT_ID, redirectUri, state), 302);
});

app.get("/auth/ticktick/callback", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");
	const cookieState = getCookie(c, OAUTH_STATE_COOKIE);

	if (!code) {
		return jsonError("Missing OAuth code.", 400);
	}

	if (!state || !cookieState || state !== cookieState) {
		return jsonError("Invalid OAuth state.", 400);
	}

	const redirectUri = redirectUriFromRequest(c.req.raw);
	const db = getDatabase(c.env);

	try {
		await exchangeCodeForToken(c.env, db, code, redirectUri);
		deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/auth/ticktick" });
		return c.json({ ok: true, message: "TickTick OAuth connected." });
	} catch (error) {
		return jsonError(
			error instanceof Error ? error.message : "Failed to complete TickTick OAuth.",
			502,
		);
	}
});

app.post("/webhooks/github", async (c) => {
	const rawBody = await c.req.raw.text();
	const signature = c.req.header("x-hub-signature-256");
	const validSignature = await verifyGitHubSignature(
		rawBody,
		signature,
		c.env.GITHUB_WEBHOOK_SECRET,
	);

	if (!validSignature) {
		return jsonError("Invalid GitHub webhook signature.", 401);
	}

	const event = c.req.header("x-github-event") ?? "";
	if (event !== "issues") {
		return c.json({ ok: true, ignored: true, reason: `Unsupported event: ${event}` }, 202);
	}

	let payload: GitHubIssuePayload;
	try {
		payload = JSON.parse(rawBody) as GitHubIssuePayload;
	} catch {
		return jsonError("Invalid GitHub webhook payload.", 400);
	}

	const deliveryId = c.req.header("x-github-delivery");
	const db = getDatabase(c.env);
	if (deliveryId) {
		const claim = await db.claimDelivery(deliveryId, event, payload.action);
		if (claim === "duplicate") {
			return c.json({ ok: true, duplicate: true }, 200);
		}

		if (claim === "processing") {
			return c.json({ ok: true, processing: true }, 202);
		}
	}

	const supportedActions = new Set(["opened", "edited", "closed", "reopened"]);
	if (!supportedActions.has(payload.action)) {
		if (deliveryId) {
			await db.completeDelivery(deliveryId, "processed");
		}
		return c.json({ ok: true, ignored: true, action: payload.action }, 202);
	}

	try {
		const result = await syncIssueToTickTick(c.env, payload);
		if (deliveryId) {
			await db.completeDelivery(deliveryId, "processed");
		}
		return c.json({ ok: true, result });
	} catch (error) {
		if (deliveryId) {
			await db.completeDelivery(deliveryId, "failed");
		}
		return jsonError(
			error instanceof Error ? error.message : "Failed to sync GitHub issue event.",
			502,
		);
	}
});

app.get("/debug/projects", async (c) => {
	const authError = requireDebugToken(c.req.raw, c.env);
	if (authError) {
		return authError;
	}

	try {
		const projects = await listProjects(c.env, getDatabase(c.env));
		return c.json({ ok: true, projects });
	} catch (error) {
		return jsonError(
			error instanceof Error ? error.message : "Failed to load TickTick projects.",
			502,
		);
	}
});

app.post("/sync/github/open-issues", async (c) => {
	const authError = requireDebugToken(c.req.raw, c.env);
	if (authError) {
		return authError;
	}

	const repo = c.req.query("repo")?.trim();
	if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
		return jsonError("Missing or invalid repo query. Use ?repo=owner/repo.", 400);
	}

	try {
		const issues = await listOpenRepositoryIssues(c.env, repo);
		const actionCounts: Record<SyncAction, number> = {
			created: 0,
			updated: 0,
			completed: 0,
			ignored: 0,
			recreated: 0,
		};

		for (const issue of issues) {
			const result = await syncIssueToTickTick(c.env, toIssuePayload(repo, issue, "opened"));
			actionCounts[result.action] += 1;
		}

		return c.json({
			ok: true,
			repo,
			totalIssues: issues.length,
			actionCounts,
			authMode: c.env.GITHUB_TOKEN?.trim() ? "token" : "unauthenticated",
		});
	} catch (error) {
		return jsonError(
			error instanceof Error ? error.message : "Failed to sync existing GitHub issues.",
			502,
		);
	}
});

export default app;
