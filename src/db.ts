import type {
	OAuthTokenRow,
	SyncedItemRow,
	TickTickTokenResponse,
	WebhookDeliveryRow,
} from "./types";

const nowIso = () => new Date().toISOString();

export class Database {
	constructor(private readonly db: D1Database) {}

	async getToken(provider: string): Promise<OAuthTokenRow | null> {
		return (
			(await this.db
				.prepare(
					`SELECT provider, access_token, refresh_token, expires_at, updated_at
					 FROM oauth_tokens
					 WHERE provider = ?1`,
				)
				.bind(provider)
				.first<OAuthTokenRow>()) ?? null
		);
	}

	async saveToken(provider: string, token: TickTickTokenResponse): Promise<void> {
		const expiresAt =
			typeof token.expires_in === "number"
				? Math.floor(Date.now() / 1000) + Math.max(token.expires_in - 60, 0)
				: null;

		await this.db
			.prepare(
				`INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5)
				 ON CONFLICT(provider) DO UPDATE SET
				   access_token = excluded.access_token,
				   refresh_token = excluded.refresh_token,
				   expires_at = excluded.expires_at,
				   updated_at = excluded.updated_at`,
			)
			.bind(
				provider,
				token.access_token,
				token.refresh_token ?? null,
				expiresAt,
				nowIso(),
			)
			.run();
	}

	async getSyncedItem(
		source: string,
		sourceRepo: string,
		sourceItemId: string,
	): Promise<SyncedItemRow | null> {
		return (
			(await this.db
				.prepare(
					`SELECT source, source_repo, source_item_id, source_item_number, source_url,
					        ticktick_project_id, ticktick_task_id, status, title, updated_at
					 FROM synced_items
					 WHERE source = ?1 AND source_repo = ?2 AND source_item_id = ?3`,
				)
				.bind(source, sourceRepo, sourceItemId)
				.first<SyncedItemRow>()) ?? null
		);
	}

	async saveSyncedItem(item: SyncedItemRow): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO synced_items (
				   source, source_repo, source_item_id, source_item_number, source_url,
				   ticktick_project_id, ticktick_task_id, status, title, updated_at
				 )
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
				 ON CONFLICT(source, source_repo, source_item_id) DO UPDATE SET
				   source_item_number = excluded.source_item_number,
				   source_url = excluded.source_url,
				   ticktick_project_id = excluded.ticktick_project_id,
				   ticktick_task_id = excluded.ticktick_task_id,
				   status = excluded.status,
				   title = excluded.title,
				   updated_at = excluded.updated_at`,
			)
			.bind(
				item.source,
				item.source_repo,
				item.source_item_id,
				item.source_item_number,
				item.source_url,
				item.ticktick_project_id,
				item.ticktick_task_id,
				item.status,
				item.title,
				item.updated_at,
			)
			.run();
	}

	async claimDelivery(
		deliveryId: string,
		provider: string,
		event: string,
		action: string | null,
	): Promise<"claimed" | "duplicate" | "processing"> {
		const timestamp = nowIso();
		const result = await this.db
			.prepare(
				`INSERT OR IGNORE INTO webhook_deliveries (
				   delivery_id, provider, event, action, status, received_at, updated_at
				 )
				 VALUES (?1, ?2, ?3, ?4, 'processing', ?5, ?5)`,
			)
			.bind(deliveryId, provider, event, action, timestamp)
			.run();

		if ((result.meta.changes ?? 0) > 0) {
			return "claimed";
		}

		const existing =
			await this.db
				.prepare(
					`SELECT delivery_id, provider, event, action, status, received_at, updated_at
					 FROM webhook_deliveries
					 WHERE delivery_id = ?1`,
				)
				.bind(deliveryId)
				.first<WebhookDeliveryRow>();

		if (existing?.status === "processed") {
			return "duplicate";
		}

		return "processing";
	}

	async completeDelivery(deliveryId: string, status: "processed" | "failed"): Promise<void> {
		await this.db
			.prepare(
				`UPDATE webhook_deliveries
				 SET status = ?2, updated_at = ?3
				 WHERE delivery_id = ?1`,
			)
			.bind(deliveryId, status, nowIso())
			.run();
	}
}
