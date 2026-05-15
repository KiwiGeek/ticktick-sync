import { Database } from "./db";
import type { AppBindings, TickTickProject, TickTickTask, TickTickTokenResponse } from "./types";

const TICKTICK_API_BASE = "https://api.ticktick.com/open/v1";
const TICKTICK_AUTHORIZE_URL = "https://ticktick.com/oauth/authorize";
const TICKTICK_TOKEN_URL = "https://ticktick.com/oauth/token";
const TICKTICK_PROVIDER = "ticktick";
const DEFAULT_SCOPE = "tasks:read tasks:write";

export const buildAuthorizeUrl = (
	clientId: string,
	redirectUri: string,
	state: string,
): string => {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: DEFAULT_SCOPE,
		state,
	});

	return `${TICKTICK_AUTHORIZE_URL}?${params.toString()}`;
};

const parseJsonResponse = async <T>(response: Response): Promise<T> => {
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`TickTick API error ${response.status}: ${body}`);
	}

	return (await response.json()) as T;
};

const parseTokenResponse = async (response: Response): Promise<TickTickTokenResponse> => {
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`TickTick token error ${response.status}: ${body}`);
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		return (await response.json()) as TickTickTokenResponse;
	}

	const raw = await response.text();
	const params = new URLSearchParams(raw);
	return {
		access_token: params.get("access_token") ?? "",
		refresh_token: params.get("refresh_token") ?? undefined,
		expires_in: params.get("expires_in")
			? Number(params.get("expires_in"))
			: undefined,
		scope: params.get("scope") ?? undefined,
		token_type: params.get("token_type") ?? undefined,
	};
};

export const exchangeCodeForToken = async (
	env: AppBindings,
	db: Database,
	code: string,
	redirectUri: string,
): Promise<void> => {
	const response = await fetch(TICKTICK_TOKEN_URL, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: env.TICKTICK_CLIENT_ID,
			client_secret: env.TICKTICK_CLIENT_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: redirectUri,
		}),
	});

	const token = await parseTokenResponse(response);
	if (!token.access_token) {
		throw new Error("TickTick token response did not include an access token.");
	}

	await db.saveToken(TICKTICK_PROVIDER, token);
};

const refreshToken = async (
	env: AppBindings,
	db: Database,
	refreshTokenValue: string,
): Promise<string> => {
	const response = await fetch(TICKTICK_TOKEN_URL, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: env.TICKTICK_CLIENT_ID,
			client_secret: env.TICKTICK_CLIENT_SECRET,
			grant_type: "refresh_token",
			refresh_token: refreshTokenValue,
		}),
	});

	const token = await parseTokenResponse(response);
	if (!token.access_token) {
		throw new Error("TickTick refresh response did not include an access token.");
	}

	await db.saveToken(TICKTICK_PROVIDER, token);
	return token.access_token;
};

const getAccessToken = async (env: AppBindings, db: Database): Promise<string> => {
	const tokenRow = await db.getToken(TICKTICK_PROVIDER);
	if (!tokenRow) {
		throw new Error("TickTick OAuth has not been completed yet.");
	}

	const now = Math.floor(Date.now() / 1000);
	if (tokenRow.expires_at && tokenRow.expires_at <= now) {
		if (!tokenRow.refresh_token) {
			throw new Error("TickTick access token expired and no refresh token is stored.");
		}

		return refreshToken(env, db, tokenRow.refresh_token);
	}

	return tokenRow.access_token;
};

const tickTickRequest = async <T>(
	env: AppBindings,
	db: Database,
	path: string,
	init: RequestInit = {},
): Promise<T> => {
	const accessToken = await getAccessToken(env, db);
	const response = await fetch(`${TICKTICK_API_BASE}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"content-type": "application/json",
			...(init.headers ?? {}),
		},
	});

	if (response.status === 204) {
		return undefined as T;
	}

	return parseJsonResponse<T>(response);
};

export const listProjects = async (
	env: AppBindings,
	db: Database,
): Promise<TickTickProject[]> =>
	tickTickRequest<TickTickProject[]>(env, db, "/project", {
		method: "GET",
		headers: {
			"content-type": "application/json",
		},
	});

export const createTask = async (
	env: AppBindings,
	db: Database,
	task: Pick<TickTickTask, "projectId" | "title" | "content">,
): Promise<TickTickTask> =>
	tickTickRequest<TickTickTask>(env, db, "/task", {
		method: "POST",
		body: JSON.stringify(task),
	});

export const updateTask = async (
	env: AppBindings,
	db: Database,
	task: Pick<TickTickTask, "id" | "projectId" | "title" | "content">,
): Promise<TickTickTask> =>
	tickTickRequest<TickTickTask>(env, db, `/task/${task.id}`, {
		method: "POST",
		body: JSON.stringify(task),
	});

export const completeTask = async (
	env: AppBindings,
	db: Database,
	projectId: string,
	taskId: string,
): Promise<void> => {
	await tickTickRequest<void>(env, db, `/project/${projectId}/task/${taskId}/complete`, {
		method: "POST",
		headers: {},
	});
};
