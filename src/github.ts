import type { AppBindings, GitHubApiIssue, GitHubIssuePayload } from "./types";

const encoder = new TextEncoder();

const toHex = (buffer: ArrayBuffer): string =>
	Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");

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

export const verifyGitHubSignature = async (
	payload: string,
	signatureHeader: string | null | undefined,
	secret: string,
): Promise<boolean> => {
	if (!signatureHeader?.startsWith("sha256=")) {
		return false;
	}

	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
	const expected = `sha256=${toHex(signature)}`;

	return timingSafeEqual(expected, signatureHeader);
};

export const buildTaskTitle = (payload: GitHubIssuePayload): string =>
	`[${payload.repository.name}#${payload.issue.number}] ${payload.issue.title}`;

export const buildTaskContent = (payload: GitHubIssuePayload): string => {
	const labels =
		payload.issue.labels.length > 0
			? payload.issue.labels.map((label) => label.name).join(", ")
			: "none";
	const issueBody = payload.issue.body?.trim();

	return [
		`GitHub: ${payload.issue.html_url}`,
		`Repo: ${payload.repository.full_name}`,
		`Labels: ${labels}`,
		`State: ${payload.issue.state}`,
		"",
		issueBody && issueBody.length > 0 ? issueBody : "(No issue body)",
	].join("\n");
};

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

const buildGitHubHeaders = (env: AppBindings): HeadersInit => {
	const headers: HeadersInit = {
		Accept: "application/vnd.github+json",
		"User-Agent": "ticktick-sync-worker",
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
	};

	if (env.GITHUB_TOKEN?.trim()) {
		headers.Authorization = `Bearer ${env.GITHUB_TOKEN.trim()}`;
	}

	return headers;
};

export const listOpenRepositoryIssues = async (
	env: AppBindings,
	repo: string,
): Promise<GitHubApiIssue[]> => {
	const issues: GitHubApiIssue[] = [];

	for (let page = 1; page <= 10; page += 1) {
		const params = new URLSearchParams({
			state: "open",
			per_page: "100",
			page: String(page),
			sort: "created",
			direction: "asc",
		});

		const response = await fetch(`${GITHUB_API_BASE}/repos/${repo}/issues?${params.toString()}`, {
			method: "GET",
			headers: buildGitHubHeaders(env),
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`GitHub API error ${response.status}: ${body}`);
		}

		const pageItems = (await response.json()) as GitHubApiIssue[];
		const filteredIssues = pageItems.filter((item) => !item.pull_request);
		issues.push(...filteredIssues);

		if (pageItems.length < 100) {
			break;
		}
	}

	return issues;
};

export const toIssuePayload = (
	repoFullName: string,
	issue: GitHubApiIssue,
	action = "opened",
): GitHubIssuePayload => ({
	action,
	repository: {
		full_name: repoFullName,
		name: repoFullName.split("/")[1] ?? repoFullName,
	},
	issue: {
		id: issue.id,
		number: issue.number,
		html_url: issue.html_url,
		title: issue.title,
		body: issue.body,
		state: issue.state,
		labels: issue.labels,
	},
});
