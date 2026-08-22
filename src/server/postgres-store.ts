import pg from "pg";
import {
  onboardingPreferencesSchema,
  type AppChain,
  type ExecutionPlan,
  type ExecutionProviderId,
  type FeedRankingProviderId,
  type OnboardingPreferences,
} from "../domain/schemas.js";
import type {
  ExecutionRecord,
  SettledOutput,
  StateStore,
  WeeklySession,
} from "./store.js";

export function normalizeStoredWallet(wallet: string) {
  return wallet.toLowerCase();
}

export class PostgresStateStore implements StateStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }

  async getPreferences(ownerId: string) {
    const result = await this.pool.query<{ preferences: unknown }>(
      `SELECT preferences FROM user_preferences WHERE owner_id = $1 OR wallet = $1 LIMIT 1`,
      [ownerId.toLowerCase()],
    );
    const parsed = onboardingPreferencesSchema.safeParse(
      result.rows[0]?.preferences,
    );
    return parsed.success ? parsed.data : undefined;
  }

  async setPreferences(
    ownerId: string,
    preferences: OnboardingPreferences,
    wallet = ownerId,
  ) {
    const normalizedOwner = ownerId.toLowerCase();
    const normalizedWallet = normalizeStoredWallet(wallet);
    await this.pool.query(
      `INSERT INTO user_preferences (wallet, owner_id, execution_provider, preferences, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (wallet) DO UPDATE SET
         owner_id = EXCLUDED.owner_id,
         execution_provider = EXCLUDED.execution_provider,
         preferences = EXCLUDED.preferences,
         updated_at = now()`,
      [normalizedWallet, normalizedOwner, preferences.executionProvider, JSON.stringify(preferences)],
    );
    return preferences;
  }

  async invalidatePreparedExecutions(ownerId: string) {
    await this.pool.query(
      `UPDATE executions
       SET status = 'FAILED', updated_at = now()
       WHERE status = 'PREPARED'
         AND lower(plan->>'signingWallet') = $1`,
      [ownerId.toLowerCase()],
    );
  }

  async openSession(
    wallet: string,
    epochId: string,
    executionProvider: ExecutionProviderId = "BDEX",
    chain: AppChain = "BOTCHAIN",
    ownerId = wallet,
    feedRankingProvider: FeedRankingProviderId = "DETERMINISTIC",
  ) {
    const normalizedWallet = normalizeStoredWallet(wallet);
    const existing = await this.pool.query<SessionRow>(
      `SELECT * FROM weekly_sessions
       WHERE wallet = $1 AND epoch_id = $2 AND execution_provider = $3
         AND chain = $4 AND feed_ranking_provider = $5
       LIMIT 1`,
      [normalizedWallet, epochId, executionProvider, chain, feedRankingProvider],
    );
    if (existing.rows[0]) return mapSession(existing.rows[0]);

    const inserted = await this.pool.query<SessionRow>(
      `INSERT INTO weekly_sessions (
         wallet, owner_id, epoch_id, execution_provider, chain, feed_ranking_provider, status
       ) VALUES ($1, $2, $3, $4, $5, $6, 'OPEN')
       RETURNING *`,
      [
        normalizedWallet,
        ownerId.toLowerCase(),
        epochId,
        executionProvider,
        chain,
        feedRankingProvider,
      ],
    );
    return mapSession(required(inserted.rows[0]));
  }

  async getSession(id: string) {
    const result = await this.pool.query<SessionRow>(
      `SELECT * FROM weekly_sessions WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }

  async reserveExecution(sessionId: string, plan: ExecutionPlan) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const record: ExecutionRecord = {
        plan,
        status: "PREPARED",
        submissionMode: "SEQUENTIAL",
        transactionHashes: [],
        settledOutputs: [],
      };
      await client.query(
        `INSERT INTO executions (
           id, session_id, authorized_plan_hash, execution_provider, chain, plan, status
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'PREPARED')`,
        [
          plan.executionId,
          sessionId,
          plan.authorizedPlanHash,
          plan.provider,
          plan.chain,
          JSON.stringify(plan),
        ],
      );
      await client.query(
        `UPDATE weekly_sessions
         SET execution_id = $2, status = 'REVIEW', updated_at = now()
         WHERE id = $1`,
        [sessionId, plan.executionId],
      );
      await client.query("COMMIT");
      return record;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async refreshPreparedExecution(
    id: string,
    expectedAuthorizedPlanHash: string,
    plan: ExecutionPlan,
  ) {
    const result = await this.pool.query<ExecutionRow>(
      `UPDATE executions
       SET plan = $3::jsonb, authorized_plan_hash = $4, updated_at = now()
       WHERE id = $1 AND authorized_plan_hash = $2 AND status = 'PREPARED'
       RETURNING *`,
      [id, expectedAuthorizedPlanHash, JSON.stringify(plan), plan.authorizedPlanHash],
    );
    if (!result.rows[0]) throw new Error("PLAN_HASH_MISMATCH");
    return mapExecution(result.rows[0]);
  }

  async getExecution(id: string) {
    const result = await this.pool.query<ExecutionRow>(
      `SELECT * FROM executions WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapExecution(result.rows[0]) : undefined;
  }

  async listExecutions(wallet: string) {
    const result = await this.pool.query<ExecutionRow>(
      `SELECT * FROM executions WHERE lower(plan->>'signingWallet') = $1 ORDER BY created_at DESC`,
      [wallet.toLowerCase()],
    );
    return result.rows.map(mapExecution);
  }

  async updateExecution(
    id: string,
    status: ExecutionRecord["status"],
    transactionHashes?: string[],
    settledOutputs?: SettledOutput[],
  ) {
    const result = await this.pool.query<ExecutionRow>(
      `UPDATE executions
       SET status = $2,
           transaction_hashes = COALESCE($3, transaction_hashes),
           settled_outputs = COALESCE($4::jsonb, settled_outputs),
           settled_at = CASE
             WHEN $2 IN ('SETTLED', 'PARTIAL', 'FAILED') THEN now()
             ELSE settled_at
           END,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        status,
        transactionHashes,
        settledOutputs ? JSON.stringify(settledOutputs) : null,
      ],
    );
    if (!result.rows[0]) throw new Error("EXECUTION_NOT_FOUND");
    return mapExecution(result.rows[0]);
  }

  async getProviderSnapshot(key: string) {
    const result = await this.pool.query<{
      snapshot: unknown;
      expires_at: Date;
    }>(
      `SELECT snapshot, expires_at FROM asset_metadata_cache
       WHERE cache_key = $1 AND expires_at > now()`,
      [key],
    );
    const row = result.rows[0];
    if (!row) return;
    return { value: row.snapshot, expiresAt: row.expires_at.toISOString() };
  }

  async setProviderSnapshot(
    key: string,
    provider: string,
    value: unknown,
    expiresAt: string,
  ) {
    await this.pool.query(
      `INSERT INTO asset_metadata_cache (cache_key, provider, snapshot, expires_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, now())
       ON CONFLICT (cache_key) DO UPDATE SET
         provider = EXCLUDED.provider,
         snapshot = EXCLUDED.snapshot,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()`,
      [key, provider, JSON.stringify(value), expiresAt],
    );
  }
}

interface SessionRow {
  id: string;
  wallet: string;
  owner_id: string | null;
  epoch_id: string;
  chain: AppChain;
  execution_provider: ExecutionProviderId;
  feed_ranking_provider: FeedRankingProviderId;
  status: WeeklySession["status"];
  execution_id: string | null;
  created_at: Date;
}

interface ExecutionRow {
  id: string;
  plan: ExecutionPlan;
  status: ExecutionRecord["status"];
  submission_mode: ExecutionRecord["submissionMode"];
  transaction_hashes: string[];
  settled_outputs: SettledOutput[];
  settled_at: Date | null;
}

function mapSession(row: SessionRow): WeeklySession {
  return {
    id: row.id,
    ownerId: row.owner_id ?? row.wallet,
    wallet: row.wallet,
    epochId: row.epoch_id,
    chain: row.chain,
    executionProvider: row.execution_provider,
    feedRankingProvider: row.feed_ranking_provider,
    status: row.status,
    executionId: row.execution_id ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

function mapExecution(row: ExecutionRow): ExecutionRecord {
  return {
    plan: row.plan,
    status: row.status,
    submissionMode: row.submission_mode ?? "SEQUENTIAL",
    transactionHashes: row.transaction_hashes ?? [],
    settledOutputs: row.settled_outputs ?? [],
    settledAt: row.settled_at?.toISOString(),
  };
}

function required<T>(value: T | undefined): T {
  if (!value) throw new Error("DATABASE_ROW_MISSING");
  return value;
}
