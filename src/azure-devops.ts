import type {
	AppBindings,
	AzureDevOpsTaskboardItem,
	AzureDevOpsWebhookPayload,
	AzureDevOpsWorkItem,
	AzureDevOpsWorkItemFields,
} from "./types";

const ADO_API_VERSION = "7.1";
const FULFILLED_STATES = new Set(["done", "closed", "removed", "completed"]);
const FULFILLED_COLUMNS = new Set(["done", "closed", "completed"]);
const DEFAULT_TASKBOARD_TYPES = ["Task", "Bug"];

const timingSafeEqual = (left: string, right: string): boolean => {
	if (left.length !== right.length) {
		return false;
	}

	let diff = 0;
	for (let i = 0; i < left.length; i += 1) {
		diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	}

	return diff === 0;
};

const requireConfig = (value: string | undefined, name: string): string => {
	const trimmed = value?.trim();
	if (!trimmed || /^YOUR[_-]/i.test(trimmed)) {
		throw new Error(`${name} must be configured.`);
	}
	return trimmed;
};

const getOrg = (env: AppBindings): string =>
	requireConfig(env.AZURE_DEVOPS_ORG, "AZURE_DEVOPS_ORG");

const getProject = (env: AppBindings): string =>
	requireConfig(env.AZURE_DEVOPS_PROJECT, "AZURE_DEVOPS_PROJECT");

const getTeam = (env: AppBindings, override?: string): string => {
	const team = override?.trim() || env.AZURE_DEVOPS_TEAM?.trim() || getProject(env);
	return team;
};

const getPat = (env: AppBindings): string =>
	requireConfig(env.AZURE_DEVOPS_PAT, "AZURE_DEVOPS_PAT");

export const getTaskboardWorkItemTypes = (env: AppBindings): string[] => {
	const configured = env.AZURE_DEVOPS_WORK_ITEM_TYPES?.trim();
	if (!configured) {
		return DEFAULT_TASKBOARD_TYPES;
	}

	return configured
		.split(",")
		.map((type) => type.trim())
		.filter((type) => type.length > 0);
};

export const isFulfilledState = (state: string | null | undefined): boolean => {
	if (!state) {
		return false;
	}
	return FULFILLED_STATES.has(state.trim().toLowerCase());
};

export const isFulfilledColumn = (column: string | null | undefined): boolean => {
	if (!column) {
		return false;
	}
	return FULFILLED_COLUMNS.has(column.trim().toLowerCase());
};

export const isTaskboardWorkItemType = (env: AppBindings, workItemType: string): boolean => {
	const allowed = getTaskboardWorkItemTypes(env).map((type) => type.toLowerCase());
	return allowed.includes(workItemType.trim().toLowerCase());
};

export const verifyAzureDevOpsBasicAuth = (
	authorizationHeader: string | null | undefined,
	username: string,
	password: string,
): boolean => {
	if (!authorizationHeader?.startsWith("Basic ")) {
		return false;
	}

	let decoded: string;
	try {
		decoded = atob(authorizationHeader.slice("Basic ".length));
	} catch {
		return false;
	}

	const separator = decoded.indexOf(":");
	if (separator < 0) {
		return false;
	}

	const providedUser = decoded.slice(0, separator);
	const providedPassword = decoded.slice(separator + 1);
	return timingSafeEqual(providedUser, username) && timingSafeEqual(providedPassword, password);
};

const buildAdoHeaders = (env: AppBindings): HeadersInit => {
	const pat = getPat(env);
	const credentials = btoa(`:${pat}`);
	return {
		Accept: "application/json",
		Authorization: `Basic ${credentials}`,
		"Content-Type": "application/json",
		"User-Agent": "ticktick-sync-worker",
	};
};

const adoUrl = (org: string, path: string): string => {
	const normalized = path.startsWith("/") ? path : `/${path}`;
	return `https://dev.azure.com/${encodeURIComponent(org)}${normalized}`;
};

const parseJsonOrThrow = async <T>(response: Response, label: string): Promise<T> => {
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`${label} failed (${response.status}): ${body}`);
	}
	return (await response.json()) as T;
};

const escapeWiqlString = (value: string): string => value.replace(/'/g, "''");

const fieldString = (
	fields: AzureDevOpsWorkItemFields | undefined,
	key: string,
): string | null => {
	const value = fields?.[key];
	if (typeof value === "string") {
		return value;
	}
	if (value && typeof value === "object" && "displayName" in value) {
		const displayName = (value as { displayName?: string }).displayName;
		return typeof displayName === "string" ? displayName : null;
	}
	return null;
};

const stripHtml = (value: string): string =>
	value
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.trim();

export const buildWorkItemUrl = (
	org: string,
	project: string,
	workItemId: number,
	htmlHref?: string | null,
): string => {
	if (htmlHref?.startsWith("http")) {
		return htmlHref;
	}
	return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_workitems/edit/${workItemId}`;
};

export const sourceRepoForProject = (org: string, project: string): string => `${org}/${project}`;

export const buildTaskTitle = (workItem: AzureDevOpsWorkItem): string => {
	const type = fieldString(workItem.fields, "System.WorkItemType") ?? "WorkItem";
	const title = fieldString(workItem.fields, "System.Title") ?? "(untitled)";
	return `[${type}#${workItem.id}] ${title}`;
};

export const buildTaskContent = (
	org: string,
	project: string,
	workItem: AzureDevOpsWorkItem,
): string => {
	const fields = workItem.fields ?? {};
	const htmlUrl = buildWorkItemUrl(org, project, workItem.id, workItem._links?.html?.href);
	const workItemType = fieldString(fields, "System.WorkItemType") ?? "unknown";
	const state = fieldString(fields, "System.State") ?? "unknown";
	const assignedTo = fieldString(fields, "System.AssignedTo") ?? "unassigned";
	const iteration = fieldString(fields, "System.IterationPath") ?? "none";
	const area = fieldString(fields, "System.AreaPath") ?? "none";
	const tags = fieldString(fields, "System.Tags") ?? "none";
	const descriptionRaw =
		fieldString(fields, "System.Description") ??
		fieldString(fields, "Microsoft.VSTS.TCM.ReproSteps");
	const description = descriptionRaw ? stripHtml(descriptionRaw) : "(No description)";

	return [
		`Azure DevOps: ${htmlUrl}`,
		`Project: ${org}/${project}`,
		`Type: ${workItemType}`,
		`State: ${state}`,
		`Assigned To: ${assignedTo}`,
		`Iteration: ${iteration}`,
		`Area: ${area}`,
		`Tags: ${tags}`,
		"",
		description,
	].join("\n");
};

type TeamIteration = {
	id: string;
	name: string;
	path: string;
};

type WiqlResponse = {
	workItems?: Array<{ id: number }>;
};

type WorkItemsBatchResponse = {
	value?: AzureDevOpsWorkItem[];
	count?: number;
};

type TaskboardListResponse = AzureDevOpsTaskboardItem[] | { value?: AzureDevOpsTaskboardItem[] };

const normalizeTaskboardItems = (payload: TaskboardListResponse): AzureDevOpsTaskboardItem[] => {
	if (Array.isArray(payload)) {
		return payload;
	}
	return payload.value ?? [];
};

export const getCurrentIteration = async (
	env: AppBindings,
	teamOverride?: string,
): Promise<TeamIteration> => {
	const org = getOrg(env);
	const project = getProject(env);
	const team = getTeam(env, teamOverride);
	const path =
		`/${encodeURIComponent(project)}/${encodeURIComponent(team)}` +
		`/_apis/work/teamsettings/iterations?$timeframe=current&api-version=${ADO_API_VERSION}`;

	const response = await fetch(adoUrl(org, path), {
		method: "GET",
		headers: buildAdoHeaders(env),
	});
	const payload = await parseJsonOrThrow<{ value?: TeamIteration[] }>(
		response,
		"Azure DevOps current iteration lookup",
	);
	const current = payload.value?.[0];
	if (!current?.id || !current.path) {
		throw new Error(
			`No current iteration found for team "${team}" in project "${project}".`,
		);
	}
	return current;
};

const listTaskboardWorkItemIds = async (
	env: AppBindings,
	iterationId: string,
	team: string,
): Promise<number[]> => {
	const org = getOrg(env);
	const project = getProject(env);
	const path =
		`/${encodeURIComponent(project)}/${encodeURIComponent(team)}` +
		`/_apis/work/taskboardworkitems/${encodeURIComponent(iterationId)}` +
		`?api-version=${ADO_API_VERSION}`;

	const response = await fetch(adoUrl(org, path), {
		method: "GET",
		headers: buildAdoHeaders(env),
	});
	const payload = await parseJsonOrThrow<TaskboardListResponse>(
		response,
		"Azure DevOps taskboard work items",
	);

	return normalizeTaskboardItems(payload)
		.filter(
			(item) => !isFulfilledState(item.state) && !isFulfilledColumn(item.column),
		)
		.map((item) => item.workItemId);
};

const listUnfulfilledWorkItemIdsViaWiql = async (
	env: AppBindings,
	iterationPath: string,
	team: string,
): Promise<number[]> => {
	const org = getOrg(env);
	const project = getProject(env);
	const types = getTaskboardWorkItemTypes(env)
		.map((type) => `'${escapeWiqlString(type)}'`)
		.join(", ");

	const query = [
		"SELECT [System.Id]",
		"FROM WorkItems",
		`WHERE [System.TeamProject] = '${escapeWiqlString(project)}'`,
		`AND [System.WorkItemType] IN (${types})`,
		"AND [System.State] NOT IN ('Done', 'Closed', 'Removed', 'Completed')",
		`AND [System.IterationPath] = '${escapeWiqlString(iterationPath)}'`,
		"ORDER BY [System.Id] ASC",
	].join(" ");

	const path =
		`/${encodeURIComponent(project)}/${encodeURIComponent(team)}` +
		`/_apis/wit/wiql?api-version=${ADO_API_VERSION}&$top=1000`;

	const response = await fetch(adoUrl(org, path), {
		method: "POST",
		headers: buildAdoHeaders(env),
		body: JSON.stringify({ query }),
	});
	const payload = await parseJsonOrThrow<WiqlResponse>(response, "Azure DevOps WIQL query");
	return (payload.workItems ?? []).map((item) => item.id);
};

const getWorkItemsBatch = async (
	env: AppBindings,
	ids: number[],
): Promise<AzureDevOpsWorkItem[]> => {
	if (ids.length === 0) {
		return [];
	}

	const org = getOrg(env);
	const project = getProject(env);
	const fields = [
		"System.Id",
		"System.Title",
		"System.State",
		"System.WorkItemType",
		"System.AssignedTo",
		"System.IterationPath",
		"System.AreaPath",
		"System.Tags",
		"System.Description",
		"Microsoft.VSTS.TCM.ReproSteps",
		"System.TeamProject",
	];

	const items: AzureDevOpsWorkItem[] = [];
	for (let offset = 0; offset < ids.length; offset += 200) {
		const chunk = ids.slice(offset, offset + 200);
		const path =
			`/${encodeURIComponent(project)}/_apis/wit/workitemsbatch` +
			`?api-version=${ADO_API_VERSION}`;
		const response = await fetch(adoUrl(org, path), {
			method: "POST",
			headers: buildAdoHeaders(env),
			body: JSON.stringify({
				ids: chunk,
				fields,
				errorPolicy: "omit",
			}),
		});
		const payload = await parseJsonOrThrow<WorkItemsBatchResponse>(
			response,
			"Azure DevOps work items batch",
		);
		items.push(...(payload.value ?? []));
	}

	return items;
};

export type UnfulfilledTaskboardResult = {
	workItems: AzureDevOpsWorkItem[];
	iteration: TeamIteration;
	team: string;
	source: "taskboard" | "wiql";
};

export const getWorkItem = async (
	env: AppBindings,
	workItemId: number,
): Promise<AzureDevOpsWorkItem> => {
	const org = getOrg(env);
	const project = getProject(env);
	const fields = [
		"System.Id",
		"System.Title",
		"System.State",
		"System.WorkItemType",
		"System.AssignedTo",
		"System.IterationPath",
		"System.AreaPath",
		"System.Tags",
		"System.Description",
		"Microsoft.VSTS.TCM.ReproSteps",
		"System.TeamProject",
	];
	const params = new URLSearchParams({
		"api-version": ADO_API_VERSION,
		fields: fields.join(","),
		"$expand": "links",
	});
	const path =
		`/${encodeURIComponent(project)}/_apis/wit/workitems/${workItemId}?${params.toString()}`;
	const response = await fetch(adoUrl(org, path), {
		method: "GET",
		headers: buildAdoHeaders(env),
	});
	return parseJsonOrThrow<AzureDevOpsWorkItem>(response, "Azure DevOps work item lookup");
};

export const listUnfulfilledTaskboardWorkItems = async (
	env: AppBindings,
	options?: { team?: string },
): Promise<UnfulfilledTaskboardResult> => {
	const team = getTeam(env, options?.team);
	const iteration = await getCurrentIteration(env, team);
	const allowedTypes = new Set(
		getTaskboardWorkItemTypes(env).map((type) => type.toLowerCase()),
	);

	let ids: number[] = [];
	let source: "taskboard" | "wiql" = "taskboard";

	try {
		ids = await listTaskboardWorkItemIds(env, iteration.id, team);
	} catch {
		source = "wiql";
		ids = await listUnfulfilledWorkItemIdsViaWiql(env, iteration.path, team);
	}

	if (ids.length === 0 && source === "taskboard") {
		// Taskboard API can succeed with an empty board; still fine.
	}

	const workItems = (await getWorkItemsBatch(env, ids)).filter((item) => {
		const type = fieldString(item.fields, "System.WorkItemType") ?? "";
		const state = fieldString(item.fields, "System.State");
		return allowedTypes.has(type.toLowerCase()) && !isFulfilledState(state);
	});

	return { workItems, iteration, team, source };
};

export type SyncableWorkItemAction = "opened" | "edited" | "closed" | "reopened";

export type SyncableAzureWorkItem = {
	action: SyncableWorkItemAction;
	org: string;
	project: string;
	sourceRepo: string;
	workItem: AzureDevOpsWorkItem;
	title: string;
	content: string;
	sourceUrl: string;
};

const getWebhookWorkItem = (
	payload: AzureDevOpsWebhookPayload,
): AzureDevOpsWorkItem | null => {
	const resource = payload.resource;
	if (!resource) {
		return null;
	}

	if (resource.revision?.id && resource.revision.fields) {
		return {
			id: resource.revision.id,
			rev: resource.revision.rev,
			fields: resource.revision.fields,
			url: resource.revision.url ?? resource.url,
			_links: resource.revision._links ?? resource._links,
		};
	}

	if (typeof resource.id === "number" && resource.fields) {
		const fields = resource.fields;
		const looksLikeDelta = Object.values(fields).some(
			(value) =>
				value &&
				typeof value === "object" &&
				("oldValue" in value || "newValue" in value),
		);

		if (!looksLikeDelta) {
			return {
				id: resource.id,
				rev: resource.rev,
				fields: fields as AzureDevOpsWorkItemFields,
				url: resource.url,
				_links: resource._links,
			};
		}
	}

	if (typeof resource.workItemId === "number") {
		return {
			id: resource.workItemId,
			fields: {},
			url: resource.url,
			_links: resource._links,
		};
	}

	return null;
};

const resolveOrgAndProject = (
	env: AppBindings,
	payload: AzureDevOpsWebhookPayload,
	workItem: AzureDevOpsWorkItem,
): { org: string; project: string } => {
	const org = getOrg(env);
	const configuredProject = getProject(env);
	const fieldProject = fieldString(workItem.fields, "System.TeamProject");
	const project = fieldProject || configuredProject;

	const accountBase = payload.resourceContainers?.account?.baseUrl;
	if (accountBase) {
		try {
			const hostParts = new URL(accountBase).pathname.split("/").filter(Boolean);
			if (hostParts[0]) {
				return { org: hostParts[0], project };
			}
		} catch {
			// fall through to configured org
		}
	}

	return { org, project };
};

export const toSyncableFromWebhook = async (
	env: AppBindings,
	payload: AzureDevOpsWebhookPayload,
): Promise<SyncableAzureWorkItem | { ignored: true; reason: string }> => {
	const eventType = payload.eventType;
	let workItem = getWebhookWorkItem(payload);
	if (!workItem) {
		return { ignored: true, reason: "Missing work item resource in webhook payload." };
	}

	const needsHydration =
		eventType !== "workitem.deleted" &&
		(!fieldString(workItem.fields, "System.Title") ||
			!fieldString(workItem.fields, "System.WorkItemType") ||
			!fieldString(workItem.fields, "System.State"));

	if (needsHydration) {
		try {
			workItem = await getWorkItem(env, workItem.id);
		} catch (error) {
			if (!fieldString(workItem.fields, "System.Title")) {
				return {
					ignored: true,
					reason:
						error instanceof Error
							? `Unable to load work item #${workItem.id}: ${error.message}`
							: `Unable to load work item #${workItem.id}.`,
				};
			}
		}
	}

	const { org, project } = resolveOrgAndProject(env, payload, workItem);
	const workItemType = fieldString(workItem.fields, "System.WorkItemType");

	if (workItemType && !isTaskboardWorkItemType(env, workItemType)) {
		return {
			ignored: true,
			reason: `Unsupported work item type: ${workItemType}`,
		};
	}

	if (!workItemType && eventType !== "workitem.deleted") {
		return {
			ignored: true,
			reason: "Work item type missing from webhook payload.",
		};
	}

	const state = fieldString(workItem.fields, "System.State");
	const fulfilled = isFulfilledState(state);
	let action: SyncableWorkItemAction;

	switch (eventType) {
		case "workitem.created":
			action = fulfilled ? "closed" : "opened";
			break;
		case "workitem.deleted":
			action = "closed";
			break;
		case "workitem.restored":
			action = fulfilled ? "closed" : "reopened";
			break;
		case "workitem.updated": {
			const stateChange = payload.resource?.fields?.["System.State"] as
				| { oldValue?: string; newValue?: string }
				| undefined;
			const oldState =
				typeof stateChange === "object" && stateChange
					? stateChange.oldValue
					: undefined;
			const newState =
				typeof stateChange === "object" && stateChange
					? stateChange.newValue
					: state;

			const wasFulfilled = isFulfilledState(oldState);
			const nowFulfilled = isFulfilledState(newState ?? state);

			if (!wasFulfilled && nowFulfilled) {
				action = "closed";
			} else if (wasFulfilled && !nowFulfilled) {
				action = "reopened";
			} else if (nowFulfilled) {
				action = "closed";
			} else {
				action = "edited";
			}
			break;
		}
		default:
			return { ignored: true, reason: `Unsupported event: ${eventType}` };
	}

	// Created-as-fulfilled should not create a TickTick task.
	if (eventType === "workitem.created" && action === "closed") {
		return { ignored: true, reason: "Created work item is already fulfilled." };
	}

	const sourceUrl = buildWorkItemUrl(org, project, workItem.id, workItem._links?.html?.href);
	const enriched: AzureDevOpsWorkItem = {
		...workItem,
		fields: workItem.fields ?? {},
	};

	return {
		action,
		org,
		project,
		sourceRepo: sourceRepoForProject(org, project),
		workItem: enriched,
		title: buildTaskTitle(enriched),
		content: buildTaskContent(org, project, enriched),
		sourceUrl,
	};
};

export const toSyncableFromWorkItem = (
	env: AppBindings,
	workItem: AzureDevOpsWorkItem,
	action: SyncableWorkItemAction = "opened",
): SyncableAzureWorkItem => {
	const org = getOrg(env);
	const project =
		fieldString(workItem.fields, "System.TeamProject") || getProject(env);
	const sourceUrl = buildWorkItemUrl(org, project, workItem.id, workItem._links?.html?.href);

	return {
		action,
		org,
		project,
		sourceRepo: sourceRepoForProject(org, project),
		workItem,
		title: buildTaskTitle(workItem),
		content: buildTaskContent(org, project, workItem),
		sourceUrl,
	};
};
