import { z } from "zod";
import {
  BOT_MAINNET_CHAIN_ID,
  BOT_TESTNET_CHAIN_ID,
  DEFAULT_SLOT_BUDGET,
  POLICY_VERSION,
  USDT_DECIMALS,
} from "./constants.js";

export const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
export const baseUnitsSchema = z.string().regex(/^[0-9]+$/);
export const appChainSchema = z.literal("BOTCHAIN");
export const executionProviderIdSchema = z.literal("BDEX");
export const feedRankingProviderIdSchema = z.enum(["DETERMINISTIC"]);
export const assetKindSchema = z.enum(["CRYPTO", "RWA"]);
export const lumoraFamilySchema = z.enum([
  "ENERGY",
  "METALS",
  "FX",
  "TREASURY",
  "CRYPTO",
  "INDICES",
  "EQUITIES",
  "DIGITAL",
  "UNKNOWN",
]);
export const MIN_TICKET_SIZE_USD = 0.1;
export const MIN_PERIOD_LIMIT_USD = MIN_TICKET_SIZE_USD;
export const TICKET_SIZE_INCREMENT_USD = 0.01;
export const TICKET_SIZE_INCREMENT_BASE_UNITS = 10_000n;

export function isTicketSizeUsd(value: number): boolean {
  const cents = value * 100;
  return (
    Number.isFinite(value) &&
    value >= MIN_TICKET_SIZE_USD &&
    Number.isSafeInteger(Math.round(value * 10 ** USDT_DECIMALS)) &&
    Math.abs(cents - Math.round(cents)) < 1e-8
  );
}

export function isPeriodLimitUsd(value: number): boolean {
  const cents = value * 100;
  return (
    Number.isFinite(value) &&
    value >= MIN_PERIOD_LIMIT_USD &&
    Number.isSafeInteger(Math.round(value * 10 ** USDT_DECIMALS)) &&
    Math.abs(cents - Math.round(cents)) < 1e-8
  );
}

export function ticketSizeToBaseUnits(ticketSizeUsd: number): bigint {
  if (!isTicketSizeUsd(ticketSizeUsd)) throw new Error("INVALID_TICKET_SIZE");
  return BigInt(Math.round(ticketSizeUsd * 10 ** USDT_DECIMALS));
}

export function formatTicketSizeUsd(ticketSizeUsd: number): string {
  return ticketSizeUsd.toFixed(2);
}

export const quoteSchema = z.object({
  requestId: z.string().min(1),
  provider: executionProviderIdSchema.default("BDEX"),
  chain: appChainSchema.default("BOTCHAIN"),
  assetId: z.string().min(1),
  tokenOut: addressSchema,
  amountInBaseUnits: baseUnitsSchema,
  estimatedAmountOut: baseUnitsSchema,
  minimumAmountOut: baseUnitsSchema,
  unitPriceUsd: z.string().regex(/^\d+(\.\d+)?$/),
  priceImpactBps: z.number().int().nonnegative(),
  routing: z.enum(["BDEX_V2", "BDEX_V3"]),
  path: z.array(addressSchema).min(2),
  fees: z
    .array(
      z.object({
        type: z.string().min(1),
        token: addressSchema,
        amount: baseUnitsSchema,
      }),
    )
    .optional(),
  providerEvidence: z.record(z.string(), z.string()).optional(),
  quotedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export const candidateSchema = z.object({
  chain: appChainSchema.default("BOTCHAIN"),
  assetId: z.string().min(1),
  symbol: z.string().min(1),
  name: z.string().min(1),
  kind: assetKindSchema,
  contract: addressSchema,
  decimals: z.number().int().min(0).max(36),
  eligible: z.boolean(),
  marketHealthy: z.boolean(),
  permissionAllowed: z.boolean(),
  marketPriceUsd: z.number().positive().optional(),
  volume24hUsd: z.number().nonnegative().optional(),
  liquidityUsd: z.number().nonnegative().optional(),
  discoveryProvider: z.literal("BDEX").optional(),
  marketDataSource: z.enum(["lumora", "bdex", "onchain"]).optional(),
  lumoraFeedId: z.string().min(1).optional(),
  lumoraAssetId: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  lumoraFamily: lumoraFamilySchema.optional(),
  iconUrl: z.string().url().optional(),
  marketDataUpdatedAt: z.string().datetime().optional(),
  tags: z.array(z.string().min(1)).optional(),
  riskFlags: z.array(z.string().min(1)).optional(),
  quote: quoteSchema.optional(),
  crowdScoreBps: z.number().int().min(0).max(10_000),
  reason: z.string().min(1).max(280),
  evidenceIds: z.array(z.string().min(1)).min(1),
});

export const rankingCandidateSchema = z.object({
  chain: appChainSchema.default("BOTCHAIN"),
  assetId: z.string().min(1),
  symbol: z.string().min(1),
  name: z.string().min(1),
  kind: assetKindSchema,
  contract: addressSchema.optional(),
  decimals: z.number().int().min(0).max(36).optional(),
  discoveryRank: z.number().int().positive(),
  priceUsd: z.number().nonnegative().optional(),
  volume24hUsd: z.number().nonnegative().optional(),
  priceChange24hPct: z.number().optional(),
  liquidityUsd: z.number().nonnegative().optional(),
  discoveryProvider: z.literal("BDEX").optional(),
  lumoraFeedId: z.string().min(1).optional(),
  lumoraFamily: lumoraFamilySchema.optional(),
  iconUrl: z.string().url().optional(),
  marketDataUpdatedAt: z.string().datetime().optional(),
  tags: z.array(z.string().min(1)).default([]),
  riskFlags: z.array(z.string().min(1)).default([]),
  marketDataSource: z.enum(["lumora", "bdex", "onchain"]).optional(),
});

export const personalizationPreferencesSchema = z.object({
  executionProvider: executionProviderIdSchema.default("BDEX"),
  activeChain: appChainSchema.default("BOTCHAIN"),
  feedRankingProvider: feedRankingProviderIdSchema.default("DETERMINISTIC"),
  cadence: z.enum(["daily", "weekly", "monthly"]),
  periodLimitUsd: z
    .number()
    .refine(isPeriodLimitUsd, {
      message: "Period limit must be at least $0.10 in $0.01 increments.",
    })
    .optional(),
  ticketSizeUsd: z.number().refine(isTicketSizeUsd, {
    message: "Ticket size must be at least $0.10 in $0.01 increments.",
  }),
  riskMode: z.enum(["conservative", "balanced", "degen"]),
  assetClasses: z
    .array(assetKindSchema)
    .min(1)
    .max(2)
    .refine((values) => new Set(values).size === values.length, {
      message: "Asset classes must be unique",
    }),
});

export const onboardingPreferencesSchema =
  personalizationPreferencesSchema.extend({
    riskDisclosureAccepted: z.literal(true),
  });

export const feedInputSchema = z.object({
  schemaVersion: z.literal("botinvest-feed-input/v1"),
  sessionId: z.string().min(1),
  epochId: z.string().min(1),
  policyVersion: z.literal(POLICY_VERSION),
  budget: z.object({
    periodBudgetBaseUnits: baseUnitsSchema,
    slotBudgetBaseUnits: baseUnitsSchema,
    maxCards: z.number().int().min(1),
  }),
  preferences: personalizationPreferencesSchema,
  candidates: z.array(candidateSchema),
  inputCommitment: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

export const rankingInputSchema = z.object({
  schemaVersion: z.literal("botinvest-ranking-input/v1"),
  sessionId: z.string().min(1),
  epochId: z.string().min(1),
  policyVersion: z.literal(POLICY_VERSION),
  budget: feedInputSchema.shape.budget,
  preferences: personalizationPreferencesSchema,
  candidates: z.array(rankingCandidateSchema).min(1),
  inputCommitment: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

export const rankedAssetSchema = z.object({
  assetId: z.string().min(1),
  rank: z.number().int().positive(),
  scoreBps: z.number().int().min(0).max(10_000),
  reason: z.string().min(1).max(280),
});

export const rankingOutputSchema = z.object({
  schemaVersion: z.literal("botinvest-ranking-output/v1"),
  sessionId: z.string().min(1),
  inputCommitment: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  policyVersion: z.literal(POLICY_VERSION),
  regime: z.enum([
    "CRYPTO_BULLISH",
    "CRYPTO_NEUTRAL",
    "CRYPTO_BEARISH",
    "RISK_OFF",
  ]),
  assets: z.array(rankedAssetSchema),
  warnings: z.array(z.string()),
});

export const feedCardSchema = z.object({
  assetId: z.string().min(1),
  action: z.literal("BUY"),
  rank: z.number().int().positive(),
  amountInBaseUnits: baseUnitsSchema,
  scoreBps: z.number().int().min(0).max(10_000),
  evidenceIds: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1).max(280),
});

export const feedOutputSchema = z.object({
  schemaVersion: z.literal("botinvest-feed-output/v1"),
  sessionId: z.string().min(1),
  inputCommitment: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  policyVersion: z.literal(POLICY_VERSION),
  regime: rankingOutputSchema.shape.regime,
  cards: z.array(feedCardSchema),
  warnings: z.array(z.string()),
});

export const selectedAssetSchema = z.object({
  assetId: z.string().min(1),
  amountInBaseUnits: baseUnitsSchema,
});

export const executionRequestSchema = z.object({
  sessionId: z.string().min(1),
  chain: appChainSchema.default("BOTCHAIN"),
  chainId: z.union([
    z.literal(BOT_MAINNET_CHAIN_ID),
    z.literal(BOT_TESTNET_CHAIN_ID),
  ]),
  inputToken: addressSchema,
  periodLimitUsd: z
    .number()
    .refine(isPeriodLimitUsd, {
      message: "Period limit must be at least $0.10 in $0.01 increments.",
    })
    .default(100),
  selections: z.array(selectedAssetSchema).min(1),
  slippageBps: z.number().int().min(1).max(100),
});

export const executionPlanSchema = z.object({
  executionId: z.string().min(1),
  sessionId: z.string().min(1),
  epochId: z.string().min(1),
  provider: executionProviderIdSchema.default("BDEX"),
  chain: appChainSchema.default("BOTCHAIN"),
  chainId: z.union([
    z.literal(BOT_MAINNET_CHAIN_ID),
    z.literal(BOT_TESTNET_CHAIN_ID),
  ]),
  inputToken: addressSchema,
  signingWallet: addressSchema,
  totalInputBaseUnits: baseUnitsSchema,
  authorizedPlanHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  policyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  callCommitments: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)),
  quotes: z.array(quoteSchema).min(1),
  generatedAt: z.string().datetime(),
});

export type ExecutionProviderId = z.infer<typeof executionProviderIdSchema>;
export type FeedRankingProviderId = z.infer<typeof feedRankingProviderIdSchema>;
export type AppChain = z.infer<typeof appChainSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type Quote = z.infer<typeof quoteSchema>;
export type RankingCandidate = z.infer<typeof rankingCandidateSchema>;
export type PersonalizationPreferences = z.infer<
  typeof personalizationPreferencesSchema
>;
export type OnboardingPreferences = z.infer<typeof onboardingPreferencesSchema>;
export type FeedInput = z.infer<typeof feedInputSchema>;
export type FeedOutput = z.infer<typeof feedOutputSchema>;
export type RankingInput = z.infer<typeof rankingInputSchema>;
export type RankingOutput = z.infer<typeof rankingOutputSchema>;
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;

export function budgetForTicket(ticketSizeUsd: number, periodLimitUsd = 100) {
  const slotBudget = ticketSizeToBaseUnits(ticketSizeUsd);
  const periodBudget = ticketSizeToBaseUnits(periodLimitUsd);
  if (slotBudget > periodBudget) throw new Error("TICKET_EXCEEDS_PERIOD_LIMIT");
  return {
    periodBudgetBaseUnits: periodBudget.toString(),
    slotBudgetBaseUnits: slotBudget.toString(),
    maxCards: Number(periodBudget / slotBudget),
  };
}

export const DEFAULT_BUDGET = budgetForTicket(
  Number(DEFAULT_SLOT_BUDGET / 10n ** BigInt(USDT_DECIMALS)),
);
