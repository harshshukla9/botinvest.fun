import type {
  Candidate,
  ExecutionPlan,
  ExecutionProviderId,
  FeedOutput,
  FeedRankingProviderId,
  OnboardingPreferences,
  Quote,
} from "../domain/schemas";

export interface WeeklySession {
  id: string;
  epochId: string;
  chain: "BOTCHAIN";
  wallet: string;
  executionProvider: ExecutionProviderId;
  feedRankingProvider: FeedRankingProviderId;
  status: string;
}

export interface FeedResponse {
  candidates: Candidate[];
  feed: FeedOutput;
  hasMore: boolean;
  rankedAssetCount: number;
  proof: {
    network: string;
    model: string;
    provider: string;
    teeVerified: boolean;
    inputCommitment: string;
    outputCommitment: string;
    requestedProvider?: FeedRankingProviderId;
    effectiveProvider?: FeedRankingProviderId;
    warnings?: string[];
  };
}

export interface WalletCall {
  kind: "APPROVAL" | "SWAP";
  assetId?: string;
  transaction: {
    to: string;
    from: string;
    data: string;
    value: string;
    chainId: number;
  };
}

export interface ExecutionRecord {
  plan: ExecutionPlan;
  status: "PREPARED" | "SUBMITTED" | "SETTLED" | "PARTIAL" | "FAILED";
  submissionMode: "SEQUENTIAL" | "BATCH";
  transactionHashes: string[];
  settledOutputs: Array<{
    assetId: string;
    amountOutBaseUnits: string;
    transactionHash: string;
    blockNumber?: string;
    status: "success" | "failed";
  }>;
  settledAt?: string;
  walletCalls?: WalletCall[];
}

export interface PublicConfig {
  executionMode: "live";
  chainId: number;
  network: "mainnet" | "testnet";
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  stableToken: "USDT";
  usdt: string;
  wbot: string;
  lumora: { apiBase: string; consumer: string; oracle: string };
  executionProviders: Record<ExecutionProviderId, { available: boolean }>;
  feedRankingProviders: Record<FeedRankingProviderId, { available: boolean }>;
  maxCards: number;
}

export type HistoryPeriod = "1H" | "1D" | "1W" | "1M" | "1Y" | "ALL";

export interface AssetHistoryResponse {
  period: HistoryPeriod | string;
  source: "lumora" | "unavailable";
  points: Array<{ timestamp: number; price: number }>;
}

export interface AssetDetailsResponse {
  symbol: string;
  name: string;
  iconUrl?: string;
}

export interface PortfolioHolding {
  assetId: string;
  symbol: string;
  name: string;
  contract: string;
  decimals: number;
  balanceBaseUnits: string;
  balance: number;
  priceUsd?: number;
  valueUsd?: number;
  lumoraFeedId?: string;
  iconUrl?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let accessToken: string | undefined;
let walletAddress: string | undefined;

export function configureApiAuth(next?: {
  token?: string;
  wallet?: string;
}) {
  accessToken = next?.token;
  walletAddress = next?.wallet;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  if (walletAddress) {
    headers.set("x-wallet-address", walletAddress);
    headers.set("x-tx-origin-address", walletAddress);
    headers.set("x-wallet-chain", "BOTCHAIN");
  }
  const response = await fetch(path, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      String(body.code ?? "REQUEST_FAILED"),
      String(body.message ?? "Request failed"),
      response.status,
    );
  }
  return body as T;
}

export const api = {
  config: () => request<PublicConfig>("/api/config"),
  nonce: () => request<{ nonce: string; chainId: number }>("/api/auth/nonce"),
  verify: (message: string, signature: string) =>
    request<{ token: string; actor: { wallet: string } }>("/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({ message, signature }),
    }),
  savePreferences: (preferences: OnboardingPreferences) =>
    request("/api/preferences", {
      method: "POST",
      body: JSON.stringify(preferences),
    }),
  preferences: () =>
    request<{ preferences?: OnboardingPreferences }>("/api/preferences"),
  openSession: (cadence: OnboardingPreferences["cadence"]) =>
    request<WeeklySession>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ cadence }),
    }),
  generateFeed: (
    sessionId: string,
    preferences: OnboardingPreferences,
    excludedAssetIds: string[] = [],
  ) =>
    request<FeedResponse>(`/api/sessions/${sessionId}/feed`, {
      method: "POST",
      body: JSON.stringify({ preferences, excludedAssetIds }),
    }),
  prepare: (body: unknown) =>
    request<ExecutionRecord>("/api/executions/prepare", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  submitted: (id: string, transactionHashes: string[]) =>
    request<ExecutionRecord>(`/api/executions/${id}/submitted`, {
      method: "POST",
      body: JSON.stringify({ transactionHashes }),
    }),
  reconcile: (id: string) =>
    request<ExecutionRecord>(`/api/executions/${id}/reconcile`, {
      method: "POST",
    }),
  execution: (id: string) => request<ExecutionRecord>(`/api/executions/${id}`),
  activity: () => request<{ executions: ExecutionRecord[] }>("/api/activity"),
  balances: (wallet: string) =>
    request<{
      usdtBalanceBaseUnits: string;
      usdtDecimals: number;
      botBalanceWei: string;
    }>(`/api/balances/${wallet}`),
  portfolio: (wallet: string) =>
    request<{ holdings: PortfolioHolding[] }>(`/api/portfolio/${wallet}`),
  assetHistory: (assetId: string, _period: HistoryPeriod = "1D", _retry = false) =>
    request<AssetHistoryResponse>(
      `/api/assets/${encodeURIComponent(assetId)}/history`,
    ),
  assetDetails: async (assetId: string): Promise<AssetDetailsResponse> => {
    const icon = await request<{ icon: string | null }>(
      `/api/assets/${encodeURIComponent(assetId)}/icon`,
    );
    return { symbol: assetId, name: assetId, iconUrl: icon.icon ?? undefined };
  },
  assetIcons: async () => ({ icons: {} as Record<string, string> }),
  prepareExit: (body: {
    assetId: string;
    amountInBaseUnits: string;
    slippageBps?: number;
  }) =>
    request<{
      quote: Quote;
      walletCalls: WalletCall[];
      asset: { assetId: string; symbol: string; decimals: number };
    }>("/api/exits/prepare", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
