import type {
	AppChain,
	Candidate,
	ExecutionPlan,
	ExecutionProviderId,
	FeedOutput,
	FeedRankingProviderId,
	OnboardingPreferences,
	Quote,
} from "../domain/schemas.js";
import { ticketSizeToBaseUnits } from "../domain/schemas.js";

export interface WeeklySession {
	id: string;
	epochId: string;
	chain: AppChain;
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
	walletCalls?: Array<{
		kind: "CANCEL_APPROVAL" | "APPROVAL" | "SWAP";
		assetId?: string;
		transaction: {
			to: string;
			from: string;
			data: string;
			value: string;
			chainId: number;
			gasLimit?: string;
			maxFeePerGas?: string;
			maxPriorityFeePerGas?: string;
			gasPrice?: string;
		};
	}>;
}

export type WalletCall = NonNullable<ExecutionRecord["walletCalls"]>[number];

export interface ExitPreparation {
	kind: "EVM_CALLS";
	provider: ExecutionProviderId;
	asset: { assetId: string; symbol: string; decimals: number };
	quote: Quote;
	walletCalls: WalletCall[];
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
	stableTokenAddress: string;
	stableTokenDecimals: number;
	wbot: string;
	lumora: { apiBase: string; oracle: string; consumer: string };
	executionProviders: Record<ExecutionProviderId, { available: boolean }>;
	feedRankingProviders: Record<FeedRankingProviderId, { available: boolean }>;
	maxCards: number;
}

export interface AssetIconsResponse {
	icons: Record<string, string>;
}

export type HistoryPeriod = "1H" | "1D" | "1W" | "1M" | "1Y" | "ALL";

export interface AssetHistoryResponse {
	period: HistoryPeriod;
	source: "lumora" | "bdex" | "unavailable";
	points: Array<{ timestamp: number; price: number }>;
	requestedPeriod?: HistoryPeriod;
	effectivePeriod?: HistoryPeriod | "MAX" | "LIMITED";
	coverageStart?: number;
	coverageEnd?: number;
	sourceAsset?: string;
	isCompleteHistory?: boolean;
}

export interface AssetDetailsResponse {
	assetId: string;
	source: "lumora" | "bdex" | "unavailable";
	lumoraFeedId?: string;
	lumoraFamily?: string;
	categories: string[];
	marketCapUsd?: number;
	volume24hUsd?: number;
	holderCount?: number;
	contract?: string;
	explorerUrl?: string;
	websiteUrl?: string;
	community: Array<{ label: string; url?: string; count?: number }>;
	updatedAt?: string;
}

export interface TokenBalanceResponse {
	asset: "USDT";
	chainId: number;
	decimals: number;
	balanceBaseUnits: string;
	nativeBalanceWei: string;
}

export interface BotPortfolioResponse {
	chainId: number;
	address: string;
	tokens: Array<{
		assetId: string;
		contract: string;
		symbol: string;
		name: string;
		kind: "CRYPTO" | "RWA";
		decimals: number;
		balanceBaseUnits: string;
		iconUrl?: string;
		priceUsd?: number;
		priceUpdatedAt?: string;
		marketDataSource?: Candidate["marketDataSource"];
		lumoraFeedId?: string;
	}>;
}

let authProvider:
	| {
			getAccessToken: () => Promise<string | null>;
			getWalletAddress: () => string | undefined;
	  }
	| undefined;

const historyRequests = new Map<string, Promise<AssetHistoryResponse>>();
const detailRequests = new Map<string, Promise<AssetDetailsResponse>>();

function assetDetails(assetId: string) {
	let requestForAsset = detailRequests.get(assetId);
	if (!requestForAsset) {
		requestForAsset = request<AssetDetailsResponse>(
			`/api/assets/${encodeURIComponent(assetId)}/details`,
		).catch((error) => {
			detailRequests.delete(assetId);
			throw error;
		});
		detailRequests.set(assetId, requestForAsset);
	}
	return requestForAsset;
}

function assetHistory(
	assetId: string,
	period: HistoryPeriod = "1W",
	refresh = false,
) {
	const cacheKey = `${assetId}:${period}`;
	if (refresh) historyRequests.delete(cacheKey);
	let requestForAsset = historyRequests.get(cacheKey);
	if (!requestForAsset) {
		requestForAsset = request<AssetHistoryResponse>(
			`/api/assets/${encodeURIComponent(assetId)}/history?period=${period}`,
		)
			.then((result) => {
				if (result.source === "unavailable") historyRequests.delete(cacheKey);
				return result;
			})
			.catch((error) => {
				historyRequests.delete(cacheKey);
				throw error;
			});
		historyRequests.set(cacheKey, requestForAsset);
	}
	return requestForAsset;
}

export class ApiError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly details: Record<string, unknown>,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export function configureApiAuth(provider: typeof authProvider) {
	authProvider = provider;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const requestAuthProvider = authProvider;
	const token = await requestAuthProvider?.getAccessToken();
	const wallet = requestAuthProvider?.getWalletAddress();
	const response = await fetch(path, {
		...init,
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(wallet
				? { "X-Wallet-Address": wallet, "X-Tx-Origin-Address": wallet }
				: {}),
			"X-Wallet-Chain": "BOTCHAIN",
			...init?.headers,
		},
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		const details =
			body && typeof body === "object" ? (body as Record<string, unknown>) : {};
		const code =
			typeof details.error === "string" ? details.error : "REQUEST_FAILED";
		const message =
			typeof details.message === "string"
				? details.message
				: apiErrorMessage(code);
		throw new ApiError(code, message, details);
	}
	return body as T;
}

function apiErrorMessage(code: string) {
	if (code === "SESSION_NOT_FOUND")
		return "This basket session expired. Start another basket.";
	if (code === "EPOCH_ALREADY_EXECUTED") {
		return "Quotes were prepared for a different basket. Start another basket to change it.";
	}
	if (code === "EXECUTION_TERMINAL") {
		return "This basket has already been submitted. Open its receipt or start another basket.";
	}
	if (code === "INVALID_REQUEST") {
		return "Choose at least one eligible asset before continuing.";
	}
	if (code === "NO_ELIGIBLE_CANDIDATES_FOR_PREFERENCES") {
		return "No executable assets matched your feed rules. Try again or adjust them in Account.";
	}
	if (code === "STALE_ORACLE") {
		return "Lumora prices are stale right now. Try again in a moment.";
	}
	return "The basket could not be prepared. Please try again.";
}

export const api = {
	config: () => request<PublicConfig>("/api/config"),
	nonce: () =>
		request<{ nonce: string; chainId: number; issuedAt: string }>(
			"/api/auth/nonce",
		),
	verify: (message: string, signature: string) =>
		request<{ token: string; expiresAt: string; wallet: string }>(
			"/api/auth/verify",
			{
				method: "POST",
				body: JSON.stringify({ message, signature }),
			},
		),
	preferences: () => request<OnboardingPreferences>("/api/preferences"),
	savePreferences: (preferences: OnboardingPreferences) =>
		request<OnboardingPreferences>("/api/preferences", {
			method: "POST",
			body: JSON.stringify(preferences),
		}),
	assetIcons: () => request<AssetIconsResponse>("/api/assets/icons"),
	assetDetails,
	assetHistory,
	usdtBalance: (wallet: string) =>
		request<TokenBalanceResponse>(
			`/api/balances/${encodeURIComponent(wallet)}/usdt`,
		),
	portfolio: (wallet: string) =>
		request<BotPortfolioResponse>(
			`/api/portfolio/${encodeURIComponent(wallet)}/botchain`,
		),
	openSession: (
		cadence: OnboardingPreferences["cadence"],
		executionProvider: ExecutionProviderId = "BDEX",
		feedRankingProvider: FeedRankingProviderId = "DETERMINISTIC",
	) =>
		request<WeeklySession>("/api/sessions/open", {
			method: "POST",
			body: JSON.stringify({
				cadence,
				executionProvider,
				chain: "BOTCHAIN",
				feedRankingProvider,
			}),
		}),
	generateFeed: (
		sessionId: string,
		preferences: OnboardingPreferences,
		excludedAssetIds: string[] = [],
	) =>
		request<FeedResponse>(`/api/sessions/${sessionId}/feed`, {
			method: "POST",
			body: JSON.stringify({ ...preferences, excludedAssetIds }),
		}),
	prepareExecution: (
		sessionId: string,
		assetIds: string[],
		ticketSizeUsd: number,
		periodLimitUsd: number,
		chainId: number,
		inputToken: string,
	) =>
		request<ExecutionRecord>("/api/executions/prepare", {
			method: "POST",
			body: JSON.stringify({
				sessionId,
				chain: "BOTCHAIN",
				chainId,
				inputToken,
				periodLimitUsd,
				selections: assetIds.map((assetId) => ({
					assetId,
					amountInBaseUnits: ticketSizeToBaseUnits(ticketSizeUsd).toString(),
				})),
				slippageBps: 50,
			}),
		}),
	markSubmitted: (
		executionId: string,
		transactionHashes: string[],
		batched = false,
	) =>
		request<ExecutionRecord>(`/api/executions/${executionId}/submitted`, {
			method: "POST",
			body: JSON.stringify({ transactionHashes, batched }),
		}),
	reconcile: (executionId: string) =>
		request<ExecutionRecord>(`/api/executions/${executionId}/reconcile`, {
			method: "POST",
		}),
	execution: (executionId: string) =>
		request<ExecutionRecord>(`/api/executions/${executionId}`),
	activity: () => request<{ executions: ExecutionRecord[] }>("/api/activity"),
	prepareExit: (assetId: string, amountInBaseUnits: string) =>
		request<ExitPreparation>(
			`/api/positions/${encodeURIComponent(assetId)}/exit/quote`,
			{
				method: "POST",
				body: JSON.stringify({ amountInBaseUnits }),
			},
		),
};
