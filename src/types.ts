export interface AppBindings {
	ticktick_sync: D1Database;
	TICKTICK_CLIENT_ID: string;
	TICKTICK_CLIENT_SECRET: string;
	GITHUB_WEBHOOK_SECRET: string;
	GITHUB_TOKEN?: string;
	TICKTICK_PROJECT_ID: string;
	GITHUB_LOGIN: string;
	DEBUG_TOKEN?: string;
}

export interface OAuthTokenRow {
	provider: string;
	access_token: string;
	refresh_token: string | null;
	expires_at: number | null;
	updated_at: string;
}

export interface SyncedItemRow {
	source: string;
	source_repo: string;
	source_item_id: string;
	source_item_number: number;
	source_url: string;
	ticktick_project_id: string;
	ticktick_task_id: string;
	status: string;
	title: string;
	updated_at: string;
}

export interface GitHubDeliveryRow {
	delivery_id: string;
	event: string;
	action: string | null;
	status: string;
	received_at: string;
	updated_at: string;
}

export interface GitHubIssuePayload {
	action: string;
	repository: {
		full_name: string;
		name: string;
	};
	issue: {
		id: number;
		number: number;
		html_url: string;
		title: string;
		body: string | null;
		state: "open" | "closed";
		labels: Array<{ name: string }>;
	};
}

export interface GitHubApiIssue {
	id: number;
	number: number;
	html_url: string;
	title: string;
	body: string | null;
	state: "open" | "closed";
	labels: Array<{ name: string }>;
	pull_request?: {
		url: string;
	};
}

export interface TickTickTokenResponse {
	access_token: string;
	token_type?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
}

export interface TickTickTask {
	id: string;
	projectId: string;
	title: string;
	content?: string;
	status?: number;
}

export interface TickTickProject {
	id: string;
	name: string;
	closed?: boolean;
	permission?: string;
	viewMode?: string;
}
