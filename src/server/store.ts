import { randomUUID } from "node:crypto";
import type {
  AppChain,
  ExecutionPlan,
  ExecutionProviderId,
  FeedRankingProviderId,
  OnboardingPreferences,
} from "../domain/schemas.js";
import type { ProviderSnapshotCache } from "./adapters/types.js";

export type SessionStatus =
  | "OPEN"
  | "SWIPING"
  | "REVIEW"
  | "AWAITING_SIGNATURE"
  | "SUBMITTED"
  | "SETTLED"
  | "PARTIAL"
  | "FAILED"
  | "CLOSED";

export interface WeeklySession {
  id: string;
  ownerId: string;
  wallet: string;
  epochId: string;
  chain: AppChain;
  executionProvider: ExecutionProviderId;
  feedRankingProvider: FeedRankingProviderId;
  status: SessionStatus;
  executionId?: string;
  createdAt: string;
}

export interface ExecutionRecord {
  plan: ExecutionPlan;
  status: "PREPARED" | "SUBMITTED" | "SETTLED" | "PARTIAL" | "FAILED";
  submissionMode: "SEQUENTIAL" | "BATCH";
  transactionHashes: string[];
  settledOutputs: SettledOutput[];
  settledAt?: string;
}

export interface SettledOutput {
  assetId: string;
  amountOutBaseUnits: string;
  transactionHash: string;
  blockNumber?: string;
  status: "success" | "failed";
}

export interface StateStore extends ProviderSnapshotCache {
  getPreferences(ownerId: string): Promise<OnboardingPreferences | undefined>;
  setPreferences(
    ownerId: string,
    preferences: OnboardingPreferences,
    wallet?: string,
  ): Promise<OnboardingPreferences>;
  invalidatePreparedExecutions(ownerId: string): Promise<void>;
  openSession(
    wallet: string,
    epochId: string,
    executionProvider?: ExecutionProviderId,
    chain?: AppChain,
    ownerId?: string,
    feedRankingProvider?: FeedRankingProviderId,
  ): Promise<WeeklySession>;
  getSession(id: string): Promise<WeeklySession | undefined>;
  reserveExecution(sessionId: string, plan: ExecutionPlan): Promise<ExecutionRecord>;
  refreshPreparedExecution(
    id: string,
    expectedAuthorizedPlanHash: string,
    plan: ExecutionPlan,
  ): Promise<ExecutionRecord>;
  getExecution(id: string): Promise<ExecutionRecord | undefined>;
  listExecutions(wallet: string): Promise<ExecutionRecord[]>;
  updateExecution(
    id: string,
    status: ExecutionRecord["status"],
    transactionHashes?: string[],
    settledOutputs?: SettledOutput[],
  ): Promise<ExecutionRecord>;
}

export class MemoryStateStore implements StateStore {
  private preferences = new Map<string, OnboardingPreferences>();
  private sessions = new Map<string, WeeklySession>();
  private executions = new Map<string, ExecutionRecord>();
  private snapshots = new Map<
    string,
    { value: unknown; expiresAt: string; provider: string }
  >();

  async getPreferences(ownerId: string) {
    return this.preferences.get(ownerId.toLowerCase());
  }

  async setPreferences(
    ownerId: string,
    preferences: OnboardingPreferences,
    _wallet?: string,
  ) {
    this.preferences.set(ownerId.toLowerCase(), preferences);
    return preferences;
  }

  async invalidatePreparedExecutions(ownerId: string) {
    for (const [id, execution] of this.executions) {
      if (
        execution.status === "PREPARED" &&
        execution.plan.signingWallet.toLowerCase() === ownerId.toLowerCase()
      ) {
        this.executions.delete(id);
      }
    }
  }

  async openSession(
    wallet: string,
    epochId: string,
    executionProvider: ExecutionProviderId = "BDEX",
    chain: AppChain = "BOTCHAIN",
    ownerId = wallet,
    feedRankingProvider: FeedRankingProviderId = "DETERMINISTIC",
  ) {
    const normalized = wallet.toLowerCase();
    const existing = [...this.sessions.values()].find(
      (session) =>
        session.wallet === normalized &&
        session.epochId === epochId &&
        session.executionProvider === executionProvider &&
        session.feedRankingProvider === feedRankingProvider,
    );
    if (existing) return existing;
    const session: WeeklySession = {
      id: randomUUID(),
      ownerId: ownerId.toLowerCase(),
      wallet: normalized,
      epochId,
      chain,
      executionProvider,
      feedRankingProvider,
      status: "OPEN",
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async getSession(id: string) {
    return this.sessions.get(id);
  }

  async reserveExecution(sessionId: string, plan: ExecutionPlan) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");
    const record: ExecutionRecord = {
      plan,
      status: "PREPARED",
      submissionMode: "SEQUENTIAL",
      transactionHashes: [],
      settledOutputs: [],
    };
    this.executions.set(plan.executionId, record);
    session.executionId = plan.executionId;
    session.status = "REVIEW";
    return record;
  }

  async refreshPreparedExecution(
    id: string,
    expectedAuthorizedPlanHash: string,
    plan: ExecutionPlan,
  ) {
    const current = this.executions.get(id);
    if (!current) throw new Error("EXECUTION_NOT_FOUND");
    if (current.plan.authorizedPlanHash !== expectedAuthorizedPlanHash) {
      throw new Error("PLAN_HASH_MISMATCH");
    }
    if (current.status !== "PREPARED") throw new Error("EXECUTION_NOT_PREPARED");
    const next = { ...current, plan };
    this.executions.set(id, next);
    return next;
  }

  async getExecution(id: string) {
    return this.executions.get(id);
  }

  async listExecutions(wallet: string) {
    return [...this.executions.values()].filter(
      (execution) =>
        execution.plan.signingWallet.toLowerCase() === wallet.toLowerCase(),
    );
  }

  async updateExecution(
    id: string,
    status: ExecutionRecord["status"],
    transactionHashes?: string[],
    settledOutputs?: SettledOutput[],
  ) {
    const current = this.executions.get(id);
    if (!current) throw new Error("EXECUTION_NOT_FOUND");
    const next: ExecutionRecord = {
      ...current,
      status,
      transactionHashes: transactionHashes ?? current.transactionHashes,
      settledOutputs: settledOutputs ?? current.settledOutputs,
      settledAt:
        status === "SETTLED" || status === "PARTIAL" || status === "FAILED"
          ? new Date().toISOString()
          : current.settledAt,
    };
    this.executions.set(id, next);
    return next;
  }

  async getProviderSnapshot(key: string) {
    const row = this.snapshots.get(key);
    if (!row || new Date(row.expiresAt).getTime() <= Date.now()) return;
    return { value: row.value, expiresAt: row.expiresAt };
  }

  async setProviderSnapshot(
    key: string,
    provider: string,
    value: unknown,
    expiresAt: string,
  ) {
    this.snapshots.set(key, { provider, value, expiresAt });
  }
}
