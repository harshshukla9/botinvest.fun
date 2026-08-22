import type {
  Candidate,
  ExecutionProviderId,
  ExecutionRequest,
  FeedRankingProviderId,
  Quote,
  RankingCandidate,
  RankingInput,
  RankingOutput,
} from "../../domain/schemas.js";

export type CandidateDiscoveryOptions = {
  includeCommunity?: boolean;
  riskMode?: "conservative" | "balanced" | "degen";
  assetClasses?: Array<"CRYPTO" | "RWA">;
};

export interface ProviderSnapshotCache {
  getProviderSnapshot(
    key: string,
  ): Promise<{ value: unknown; expiresAt: string } | undefined>;
  setProviderSnapshot(
    key: string,
    provider: string,
    value: unknown,
    expiresAt: string,
  ): Promise<void>;
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

export interface AssetDiscoveryProvider {
  getRankingCandidates(
    limit: number,
    excludedAssetIds?: string[],
    options?: CandidateDiscoveryOptions,
  ): Promise<RankingCandidate[]>;
}

export interface ExecutionEligibilityProvider {
  getCandidatesForFeed(
    wallet: string,
    rankedAssetIds: string[],
    amountInBaseUnits: string,
    now: Date,
    limit: number,
    txOrigin?: string,
  ): Promise<Candidate[]>;
  getCandidatesForExecution(
    wallet: string,
    assetIds: string[],
    amountInBaseUnits?: string,
    now?: Date,
    txOrigin?: string,
  ): Promise<Candidate[]>;
}

export interface CandidateProvider
  extends AssetDiscoveryProvider,
    ExecutionEligibilityProvider {}

export interface FeedRankingProvider {
  rank(input: RankingInput): Promise<{
    output: RankingOutput;
    receipt: {
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
  }>;
}

export interface ExecutionProvider {
  readonly id: ExecutionProviderId;
  readonly label: string;
  price(
    wallet: string,
    txOrigin: string,
    candidate: Candidate,
    amountInBaseUnits: string,
    slippageBps: number,
  ): Promise<Quote>;
  prepareBasket(
    wallet: string,
    request: ExecutionRequest,
    candidates: Candidate[],
    txOrigin?: string,
  ): Promise<{
    quotes: Quote[];
    walletCalls: WalletCall[];
    unavailableAssetIds?: string[];
  }>;
  health(): Promise<{
    available: boolean;
    status: "CONFIGURED" | "UNAVAILABLE";
  }>;
  prepareExit(
    wallet: string,
    candidate: Candidate,
    amountInBaseUnits: string,
    slippageBps: number,
    txOrigin?: string,
  ): Promise<{
    quote: Quote;
    walletCalls: WalletCall[];
  }>;
}

export type NormalizedExecutionError =
  | "TOKEN_UNAUTHORIZED"
  | "INSUFFICIENT_LIQUIDITY"
  | "UNSUPPORTED_CHAIN"
  | "INVALID_TOKEN"
  | "INVALID_TRANSACTION"
  | "INSUFFICIENT_FUNDS"
  | "SIMULATION_FAILED"
  | "BASKET_TOO_LARGE"
  | "PROVIDER_UNAVAILABLE"
  | "STALE_ORACLE";

export class ExecutionProviderError extends Error {
  constructor(
    public readonly provider: ExecutionProviderId,
    public readonly code: NormalizedExecutionError,
    message: string,
    public readonly upstreamReason?: string,
  ) {
    super(message);
    this.name = "ExecutionProviderError";
  }
}
