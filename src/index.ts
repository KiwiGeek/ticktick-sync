import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import {
	listUnfulfilledTaskboardWorkItems,
	toSyncableFromWebhook,
	toSyncableFromWorkItem,
	verifyAzureDevOpsBasicAuth,
	type SyncableAzureWorkItem,
} from "./azure-devops";
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
import type {
	AppBindings,
	AzureDevOpsWebhookPayload,
	GitHubIssuePayload,
	SyncedItemRow,
} from "./types";

type AppEnv = {
	Bindings: AppBindings;
};

type SyncAction = "created" | "updated" | "completed" | "ignored" | "recreated";

type SyncableItem = {
	source: string;
	sourceRepo: string;
	sourceItemId: string;
	sourceItemNumber: number;
	sourceUrl: string;
	title: string;
	content: string;
	action: "opened" | "edited" | "closed" | "reopened";
};

const OAUTH_STATE_COOKIE = "ticktick_oauth_state";
const AZURE_DEVOPS_SOURCE = "azure_devops_workitem";

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

const emptyActionCounts = (): Record<SyncAction, number> => ({
	created: 0,
	updated: 0,
	completed: 0,
	ignored: 0,
	recreated: 0,
});

const buildSyncedItemRow = (
	item: SyncableItem,
	tickTickTaskId: string,
	status: string,
	projectId: string,
): SyncedItemRow => ({
	source: item.source,
	source_repo: item.sourceRepo,
	source_item_id: item.sourceItemId,
	source_item_number: item.sourceItemNumber,
	source_url: item.sourceUrl,
	ticktick_project_id: projectId,
	ticktick_task_id: tickTickTaskId,
	status,
	title: item.title,
	updated_at: new Date().toISOString(),
});

const isConfiguredProjectId = (value: string | undefined): value is string => {
	const trimmed = value?.trim();
	return Boolean(trimmed && !/^YOUR[_-]/i.test(trimmed));
};

const resolveTickTickProjectId = (env: AppBindings, source: string): string => {
	if (source === AZURE_DEVOPS_SOURCE) {
		if (isConfiguredProjectId(env.AZURE_DEVOPS_TICKTICK_PROJECT_ID)) {
			return env.AZURE_DEVOPS_TICKTICK_PROJECT_ID.trim();
		}
	} else if (source === "github_issue") {
		if (isConfiguredProjectId(env.GITHUB_TICKTICK_PROJECT_ID)) {
			return env.GITHUB_TICKTICK_PROJECT_ID.trim();
		}
	}

	if (isConfiguredProjectId(env.TICKTICK_PROJECT_ID)) {
		return env.TICKTICK_PROJECT_ID.trim();
	}

	throw new Error(
		source === AZURE_DEVOPS_SOURCE
			? "AZURE_DEVOPS_TICKTICK_PROJECT_ID (or TICKTICK_PROJECT_ID) must be configured."
			: "GITHUB_TICKTICK_PROJECT_ID (or TICKTICK_PROJECT_ID) must be configured.",
	);
};

const syncItemToTickTick = async (
	env: AppBindings,
	item: SyncableItem,
): Promise<{ action: SyncAction }> => {
	const db = getDatabase(env);
	const projectId = resolveTickTickProjectId(env, item.source);
	const existing = await db.getSyncedItem(item.source, item.sourceRepo, item.sourceItemId);

	if (item.action === "closed") {
		if (existing) {
			await completeTask(env, db, existing.ticktick_project_id, existing.ticktick_task_id);
			await db.saveSyncedItem(
				buildSyncedItemRow(item, existing.ticktick_task_id, "completed", existing.ticktick_project_id),
			);
		}
		return { action: existing ? "completed" : "ignored" };
	}

	if (item.action === "reopened") {
		const recreated = await createTask(env, db, {
			projectId,
			title: item.title,
			content: item.content,
		});
		await db.saveSyncedItem(buildSyncedItemRow(item, recreated.id, "open", projectId));
		return { action: existing ? "recreated" : "created" };
	}

	if (existing) {
		await updateTask(env, db, {
			id: existing.ticktick_task_id,
			projectId: existing.ticktick_project_id,
			title: item.title,
			content: item.content,
		});
		await db.saveSyncedItem(
			buildSyncedItemRow(item, existing.ticktick_task_id, "open", existing.ticktick_project_id),
		);
		return { action: "updated" };
	}

	const created = await createTask(env, db, {
		projectId,
		title: item.title,
		content: item.content,
	});
	await db.saveSyncedItem(buildSyncedItemRow(item, created.id, "open", projectId));
	return { action: "created" };
};

const githubPayloadToSyncable = (payload: GitHubIssuePayload): SyncableItem => ({
	source: "github_issue",
	sourceRepo: payload.repository.full_name,
	sourceItemId: String(payload.issue.id),
	sourceItemNumber: payload.issue.number,
	sourceUrl: payload.issue.html_url,
	title: buildTaskTitle(payload),
	content: buildTaskContent(payload),
	action: payload.action as SyncableItem["action"],
});

const azurePayloadToSyncable = (item: SyncableAzureWorkItem): SyncableItem => ({
	source: AZURE_DEVOPS_SOURCE,
	sourceRepo: item.sourceRepo,
	sourceItemId: String(item.workItem.id),
	sourceItemNumber: item.workItem.id,
	sourceUrl: item.sourceUrl,
	title: item.title,
	content: item.content,
	action: item.action,
});

const syncIssueToTickTick = async (
	env: AppBindings,
	payload: GitHubIssuePayload,
): Promise<{ action: SyncAction }> => syncItemToTickTick(env, githubPayloadToSyncable(payload));

const syncAzureWorkItemToTickTick = async (
	env: AppBindings,
	item: SyncableAzureWorkItem,
): Promise<{ action: SyncAction }> => syncItemToTickTick(env, azurePayloadToSyncable(item));

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
	const webhookSecret = c.env.GITHUB_WEBHOOK_SECRET?.trim();
	if (!webhookSecret) {
		return jsonError("GITHUB_WEBHOOK_SECRET must be configured.", 403);
	}

	const rawBody = await c.req.raw.text();
	const signature = c.req.header("x-hub-signature-256");
	const validSignature = await verifyGitHubSignature(
		rawBody,
		signature,
		webhookSecret,
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
		const claim = await db.claimDelivery(deliveryId, "github", event, payload.action);
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

app.post("/webhooks/azure-devops", async (c) => {
	const webhookSecret = c.env.AZURE_DEVOPS_WEBHOOK_SECRET?.trim();
	if (!webhookSecret) {
		return jsonError("AZURE_DEVOPS_WEBHOOK_SECRET must be configured.", 403);
	}

	const username = c.env.AZURE_DEVOPS_WEBHOOK_USERNAME?.trim() ?? "";
	const validAuth = verifyAzureDevOpsBasicAuth(
		c.req.header("authorization"),
		username,
		webhookSecret,
	);
	if (!validAuth) {
		return jsonError("Invalid Azure DevOps webhook credentials.", 401);
	}

	const rawBody = await c.req.raw.text();
	let payload: AzureDevOpsWebhookPayload;
	try {
		payload = JSON.parse(rawBody) as AzureDevOpsWebhookPayload;
	} catch {
		return jsonError("Invalid Azure DevOps webhook payload.", 400);
	}

	const supportedEvents = new Set([
		"workitem.created",
		"workitem.updated",
		"workitem.deleted",
		"workitem.restored",
	]);
	if (!supportedEvents.has(payload.eventType)) {
		return c.json(
			{ ok: true, ignored: true, reason: `Unsupported event: ${payload.eventType}` },
			202,
		);
	}

	const deliveryId = payload.id ? `azure_devops:${payload.id}` : null;
	const db = getDatabase(c.env);
	if (deliveryId) {
		const claim = await db.claimDelivery(
			deliveryId,
			"azure_devops",
			payload.eventType,
			null,
		);
		if (claim === "duplicate") {
			return c.json({ ok: true, duplicate: true }, 200);
		}
		if (claim === "processing") {
			return c.json({ ok: true, processing: true }, 202);
		}
	}

	const syncable = await toSyncableFromWebhook(c.env, payload);
	if ("ignored" in syncable) {
		if (deliveryId) {
			await db.completeDelivery(deliveryId, "processed");
		}
		return c.json({ ok: true, ignored: true, reason: syncable.reason }, 202);
	}

	try {
		const result = await syncAzureWorkItemToTickTick(c.env, syncable);
		if (deliveryId) {
			await db.completeDelivery(deliveryId, "processed");
		}
		return c.json({ ok: true, result });
	} catch (error) {
		if (deliveryId) {
			await db.completeDelivery(deliveryId, "failed");
		}
		return jsonError(
			error instanceof Error ? error.message : "Failed to sync Azure DevOps work item event.",
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
		const actionCounts = emptyActionCounts();

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

app.post("/sync/azure-devops/taskboard", async (c) => {
	const authError = requireDebugToken(c.req.raw, c.env);
	if (authError) {
		return authError;
	}

	const team = c.req.query("team")?.trim();

	try {
		const { workItems, iteration, team: resolvedTeam, source } =
			await listUnfulfilledTaskboardWorkItems(c.env, { team });
		const actionCounts = emptyActionCounts();

		for (const workItem of workItems) {
			const syncable = toSyncableFromWorkItem(c.env, workItem, "opened");
			const result = await syncAzureWorkItemToTickTick(c.env, syncable);
			actionCounts[result.action] += 1;
		}

		return c.json({
			ok: true,
			org: c.env.AZURE_DEVOPS_ORG,
			project: c.env.AZURE_DEVOPS_PROJECT,
			team: resolvedTeam,
			iteration: {
				id: iteration.id,
				name: iteration.name,
				path: iteration.path,
			},
			source,
			totalWorkItems: workItems.length,
			actionCounts,
		});
	} catch (error) {
		return jsonError(
			error instanceof Error
				? error.message
				: "Failed to sync Azure DevOps taskboard work items.",
			502,
		);
	}
});

export default app;
