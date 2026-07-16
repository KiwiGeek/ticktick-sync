import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("ticktick-sync worker", () => {
	it("serves the health endpoint", async () => {
		const request = new IncomingRequest("https://example.com/health");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, {} as Env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			service: "ticktick-sync",
		});
	});

	it("rejects GitHub webhooks when the webhook secret is not configured", async () => {
		const request = new IncomingRequest("https://example.com/webhooks/github", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-github-event": "issues",
			},
			body: JSON.stringify({ action: "opened" }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, {} as Env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			ok: false,
			error: "GITHUB_WEBHOOK_SECRET must be configured.",
		});
	});

	it("rejects GitHub webhooks with an invalid signature", async () => {
		const request = new IncomingRequest("https://example.com/webhooks/github", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-github-event": "issues",
				"x-hub-signature-256": "sha256=not-valid",
			},
			body: JSON.stringify({ action: "opened" }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{
				GITHUB_WEBHOOK_SECRET: "super-secret",
			} as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			ok: false,
			error: "Invalid GitHub webhook signature.",
		});
	});

	it("starts the TickTick OAuth flow", async () => {
		const request = new IncomingRequest("https://example.com/auth/ticktick/start");
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{
				TICKTICK_CLIENT_ID: "client-id",
			} as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toContain(
			"https://ticktick.com/oauth/authorize?",
		);
		expect(response.headers.get("location")).toContain("client_id=client-id");
	});

	it("requires DEBUG_TOKEN for the projects debug endpoint", async () => {
		const request = new IncomingRequest("https://example.com/debug/projects");
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{
				DEBUG_TOKEN: "debug-secret",
			} as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			ok: false,
			error: "Unauthorized debug access.",
		});
	});

	it("rejects Azure DevOps webhooks with invalid basic auth", async () => {
		const request = new IncomingRequest("https://example.com/webhooks/azure-devops", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Basic ${btoa("wrong:credentials")}`,
			},
			body: JSON.stringify({ eventType: "workitem.created" }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{
				AZURE_DEVOPS_WEBHOOK_USERNAME: "ticktick-sync",
				AZURE_DEVOPS_WEBHOOK_SECRET: "webhook-secret",
			} as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			ok: false,
			error: "Invalid Azure DevOps webhook credentials.",
		});
	});

	it("requires DEBUG_TOKEN for the Azure DevOps taskboard sync endpoint", async () => {
		const request = new IncomingRequest("https://example.com/sync/azure-devops/taskboard", {
			method: "POST",
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{
				DEBUG_TOKEN: "debug-secret",
			} as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			ok: false,
			error: "Unauthorized debug access.",
		});
	});
});
