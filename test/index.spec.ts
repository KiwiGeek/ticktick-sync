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
});
