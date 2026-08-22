import { randomUUID } from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { type Address, createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { ZodError, z } from "zod";
import { sha256 } from "../domain/canonical.js";
import {
  AI_RANKING_POOL_SIZE,
  FEED_PAGE_SIZE,
  POLICY_VERSION,
  USDT_DECIMALS,
} from "../domain/constants.js";
import { callCommitment, executionIntent } from "../domain/execution-intent.js";
import {
  eligibleFeedCandidates,
  PolicyError,
  policyHash,
  validateExecutionSelection,
  validateFeed,
  validateRanking,
} from "../domain/policy.js";
import {
  addressSchema,
  budgetForTicket,
  DEFAULT_BUDGET,
  executionRequestSchema,
  feedInputSchema,
  onboardingPreferencesSchema,
  rankingInputSchema,
  type ExecutionPlan,
  type RankingCandidate,
} from "../domain/schemas.js";
import type { BdexProvider } from "./adapters/bdex.js";
import {
  LumoraStalePriceError,
  LumoraUnknownAssetError,
  type LumoraOracle,
} from "./adapters/lumora.js";
import { ExecutionProviderError } from "./adapters/types.js";
import type {
  CandidateProvider,
  ExecutionProvider,
  FeedRankingProvider,
} from "./adapters/types.js";
import { SiweWalletAuth, type ExecutionActor } from "./auth.js";
import type { AppConfig } from "./config.js";
import { sessionEpochId } from "./session-epoch.js";
import type { ExecutionRecord, StateStore } from "./store.js";

export interface AppDependencies {
  config: AppConfig;
  store: StateStore;
  candidates: CandidateProvider;
  inference: FeedRankingProvider;
  execution: ExecutionProvider;
  bdex: BdexProvider;
  lumora: LumoraOracle;
  auth?: SiweWalletAuth;
}

const HISTORY_PERIODS = ["1H", "1D", "1W", "1M", "1Y", "ALL"] as const;
type HistoryPeriod = (typeof HISTORY_PERIODS)[number];

const HISTORY_PERIOD_SECONDS: Record<HistoryPeriod, number> = {
  "1H": 3_600,
  "1D": 86_400,
  "1W": 604_800,
  "1M": 2_592_000,
  "1Y": 31_536_000,
  ALL: Number.POSITIVE_INFINITY,
};

export function createApp(deps: AppDependencies) {
  const app = express();
  const auth = deps.auth ?? new SiweWalletAuth(deps.config);
  const chainClient = createPublicClient({
    transport: http(deps.config.network.rpcUrl),
  });
  if (deps.config.NODE_ENV === "production") app.set("trust proxy", 1);

  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:", "https:"],
          connectSrc: [
            "'self'",
            deps.config.network.rpcUrl,
            deps.config.LUMORA_API_BASE,
          ],
        },
      },
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: deps.config.NODE_ENV === "production" ? 240 : 1_200,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );

  app.get("/api/health", async (_request, response, next) => {
    try {
      const [bdex, feeds] = await Promise.all([
        deps.execution.health(),
        deps.lumora.listPrices().then((prices) => prices.length).catch(() => 0),
      ]);
      response.json({
        status: "ok",
        chainId: deps.config.network.chainId,
        network: deps.config.networkName,
        bdex: bdex.status,
        lumoraFeeds: feeds,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/config", (_request, response) => {
    response.json({
      executionMode: "live",
      chainId: deps.config.network.chainId,
      network: deps.config.networkName,
      chainName:
        deps.config.networkName === "mainnet" ? "BOT Chain" : "BOT Testnet",
      rpcUrl: deps.config.network.rpcUrl,
      explorerUrl: deps.config.network.explorerUrl,
      nativeCurrency: deps.config.network.nativeCurrency,
      stableToken: "USDT",
      stableTokenAddress: deps.config.network.usdt,
      stableTokenDecimals: USDT_DECIMALS,
      wbot: deps.config.network.wbot,
      lumora: {
        apiBase: deps.config.LUMORA_API_BASE,
        oracle: deps.config.network.lumoraOracle,
        consumer: deps.config.network.lumoraConsumer,
      },
      executionProviders: { BDEX: { available: true } },
      feedRankingProviders: { DETERMINISTIC: { available: true } },
      maxCards: DEFAULT_BUDGET.maxCards,
    });
  });

  app.get("/api/auth/nonce", (_request, response) => {
    response.json({
      nonce: auth.issueNonce(),
      chainId: deps.config.network.chainId,
      issuedAt: new Date().toISOString(),
    });
  });

  app.post("/api/auth/verify", async (request, response, next) => {
    try {
      const body = z
        .object({ message: z.string().min(1), signature: z.string().min(1) })
        .parse(request.body);
      const { token, wallet, expiresAt } = await auth.verify(
        body.message,
        body.signature,
      );
      response.json({ token, wallet, expiresAt });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/assets/icons", async (_request, response, next) => {
    try {
      const candidates = await deps.candidates.getRankingCandidates(
        Number.MAX_SAFE_INTEGER,
      );
      const icons: Record<string, string> = {};
      for (const candidate of candidates) {
        if (!candidate.iconUrl) continue;
        icons[candidate.symbol] = candidate.iconUrl;
        icons[candidate.assetId] = candidate.iconUrl;
      }
      response.json({ icons });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/assets/:assetId/history", async (request, response, next) => {
    try {
      const assetId = String(request.params.assetId);
      const period = z
        .enum(HISTORY_PERIODS)
        .default("1W")
        .parse(request.query.period ?? "1W");
      const candidate = await deps.candidates.getRankingCandidate(assetId);
      if (!candidate) {
        throw new PolicyError("ASSET_NOT_FOUND", "Unknown asset.");
      }
      // Oracle-tracked assets chart the signed feed; everything else charts the
      // pool tape, which is the price that actually filled on BDEX.
      const feedId = candidate.lumoraFeedId;
      const source = feedId ? "lumora" : "bdex";
      const sourceAsset = feedId ?? candidate.contract;
      const full = feedId
        ? await deps.lumora.series(feedId)
        : candidate.contract
          ? await deps.bdex.priceHistory(candidate.contract as Address)
          : [];
      if (full.length < 2) {
        response.json({
          period,
          requestedPeriod: period,
          source: "unavailable",
          points: [],
          isCompleteHistory: false,
        });
        return;
      }

      const cutoff =
        period === "ALL"
          ? 0
          : Math.floor(Date.now() / 1000) - HISTORY_PERIOD_SECONDS[period];
      const windowed = full.filter((point) => point.timestamp >= cutoff);
      const points = (windowed.length >= 2 ? windowed : full).map(toChartPoint);

      response.json({
        period,
        requestedPeriod: period,
        effectivePeriod:
          period === "ALL"
            ? points.length === full.length
              ? "MAX"
              : "LIMITED"
            : period,
        source,
        points,
        sourceAsset,
        coverageStart: points[0]?.timestamp,
        coverageEnd: points.at(-1)?.timestamp,
        isCompleteHistory: points.length === full.length,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/assets/:assetId/details", async (request, response, next) => {
    try {
      const assetId = String(request.params.assetId);
      const candidate = await deps.candidates.getRankingCandidate(assetId);
      if (!candidate) {
        throw new PolicyError("ASSET_NOT_FOUND", "Unknown asset.");
      }
      response.json({
        assetId,
        source: candidate.lumoraFeedId ? "lumora" : "bdex",
        lumoraFeedId: candidate.lumoraFeedId,
        lumoraFamily: candidate.lumoraFamily,
        categories: assetCategories(candidate),
        volume24hUsd: candidate.volume24hUsd,
        contract: candidate.contract,
        explorerUrl: candidate.contract
          ? `${deps.config.network.explorerUrl}/token/${candidate.contract}`
          : undefined,
        websiteUrl: candidate.lumoraRoute
          ? `${deps.config.LUMORA_API_BASE}/${candidate.lumoraRoute}`
          : undefined,
        community: [
          {
            label: "BDEX pool",
            url: `${deps.config.network.explorerUrl}/address/${candidate.contract}`,
          },
          ...(candidate.lumoraFeedId
            ? [
                {
                  label: "Lumora feed",
                  url: `${deps.config.LUMORA_API_BASE}/api/prices/${encodeURIComponent(candidate.lumoraFeedId)}`,
                },
              ]
            : []),
        ],
        updatedAt: candidate.marketDataUpdatedAt,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get(
    "/api/balances/:wallet/usdt",
    requireActor(auth),
    async (request, response, next) => {
      try {
        const wallet = addressSchema
          .parse(request.params.wallet)
          .toLowerCase() as Address;
        assertSameWallet(response.locals.actor, wallet);
        const [balanceBaseUnits, nativeBalanceWei] = await Promise.all([
          chainClient.readContract({
            address: deps.config.network.usdt,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [wallet],
          }),
          chainClient.getBalance({ address: wallet }),
        ]);
        response.json({
          asset: "USDT",
          chainId: deps.config.network.chainId,
          decimals: USDT_DECIMALS,
          balanceBaseUnits: balanceBaseUnits.toString(),
          nativeBalanceWei: nativeBalanceWei.toString(),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/portfolio/:wallet/botchain",
    requireActor(auth),
    async (request, response, next) => {
      try {
        const wallet = addressSchema
          .parse(request.params.wallet)
          .toLowerCase() as Address;
        assertSameWallet(response.locals.actor, wallet);
        const candidates = await deps.candidates.getRankingCandidates(
          Number.MAX_SAFE_INTEGER,
        );
        const contracts = candidates
          .map((candidate) => candidate.contract)
          .filter((contract): contract is Address => Boolean(contract));
        const balances = await deps.bdex.tokenBalances(wallet, contracts);
        response.json({
          chainId: deps.config.network.chainId,
          address: wallet,
          tokens: candidates.flatMap((candidate) => {
            if (!candidate.contract) return [];
            const balance = balances.get(candidate.contract.toLowerCase()) ?? 0n;
            if (balance <= 0n) return [];
            return [
              {
                assetId: candidate.assetId,
                contract: candidate.contract,
                symbol: candidate.symbol,
                name: candidate.name,
                kind: candidate.kind,
                decimals: candidate.decimals ?? 18,
                balanceBaseUnits: balance.toString(),
                iconUrl: candidate.iconUrl,
                priceUsd: candidate.priceUsd,
                priceUpdatedAt: candidate.marketDataUpdatedAt,
                marketDataSource: candidate.marketDataSource,
                lumoraFeedId: candidate.lumoraFeedId,
              },
            ];
          }),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post("/api/preferences", requireActor(auth), async (request, response, next) => {
    try {
      const actor = response.locals.actor as ExecutionActor;
      const preferences = onboardingPreferencesSchema.parse(request.body);
      response.json(
        await deps.store.setPreferences(actor.userId, preferences, actor.wallet),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/preferences", requireActor(auth), async (_request, response, next) => {
    try {
      const actor = response.locals.actor as ExecutionActor;
      const preferences = await deps.store.getPreferences(actor.userId);
      if (!preferences) {
        throw new PolicyError("PREFERENCES_NOT_SET", "No saved preferences.");
      }
      response.json(preferences);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/open", requireActor(auth), async (request, response, next) => {
    try {
      const actor = response.locals.actor as ExecutionActor;
      const body = z
        .object({
          cadence: z.enum(["daily", "weekly", "monthly"]).default("weekly"),
          executionProvider: z.literal("BDEX").default("BDEX"),
          chain: z.literal("BOTCHAIN").default("BOTCHAIN"),
          feedRankingProvider: z.enum(["DETERMINISTIC"]).default("DETERMINISTIC"),
        })
        .parse(request.body ?? {});
      const session = await deps.store.openSession(
        actor.wallet,
        sessionEpochId(body.cadence),
        body.executionProvider,
        body.chain,
        actor.userId,
        body.feedRankingProvider,
      );
      response.json(session);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/:id/feed", requireActor(auth), async (request, response, next) => {
    try {
      const actor = response.locals.actor as ExecutionActor;
      const session = await deps.store.getSession(String(request.params.id));
      if (!session || session.wallet !== actor.wallet) {
        throw new PolicyError("SESSION_NOT_FOUND", "Session not found.");
      }
      const preferences = onboardingPreferencesSchema.parse(
        request.body?.preferences ?? request.body,
      );
      const excluded =
        z.array(z.string()).optional().parse(request.body?.excludedAssetIds) ?? [];
      const budget = budgetForTicket(
        preferences.ticketSizeUsd,
        preferences.periodLimitUsd ?? 100,
      );
      const rankingCandidates = await deps.candidates.getRankingCandidates(
        AI_RANKING_POOL_SIZE,
        excluded,
        {
          riskMode: preferences.riskMode,
          assetClasses: preferences.assetClasses,
        },
      );
      if (!rankingCandidates.length) {
        // An RWA-only plan is the common case here: a token qualifies as RWA
        // only when a Lumora feed both covers it and agrees with the pool
        // price, and no BDEX market currently clears that bar.
        const rwaOnly =
          preferences.assetClasses.length === 1 &&
          preferences.assetClasses[0] === "RWA";
        throw new PolicyError(
          "NO_ELIGIBLE_CANDIDATES_FOR_PREFERENCES",
          rwaOnly
            ? "No BDEX market is currently tracked by a Lumora real-world asset feed. Include crypto in your asset mix to build a basket."
            : "No BDEX market matched this plan. Lower the decision size or widen your asset mix.",
        );
      }
      const rankingInput = rankingInputSchema.parse({
        schemaVersion: "botcrates-ranking-input/v1",
        sessionId: session.id,
        epochId: session.epochId,
        policyVersion: POLICY_VERSION,
        budget,
        preferences,
        candidates: rankingCandidates,
        inputCommitment: sha256({
          sessionId: session.id,
          epochId: session.epochId,
          preferences,
          candidates: rankingCandidates.map((item) => item.assetId),
        }),
      });
      const ranked = await deps.inference.rank(rankingInput);
      const ranking = validateRanking(ranked.output, rankingInput, rankingCandidates);
      const pageIds = ranking.assets
        .slice(0, FEED_PAGE_SIZE)
        .map((asset) => asset.assetId);
      const candidates = await deps.candidates.getCandidatesForFeed(
        actor.wallet,
        pageIds,
        budget.slotBudgetBaseUnits,
        new Date(),
        FEED_PAGE_SIZE,
      );
      const feedInput = feedInputSchema.parse({
        schemaVersion: "botcrates-feed-input/v1",
        sessionId: session.id,
        epochId: session.epochId,
        policyVersion: POLICY_VERSION,
        budget,
        preferences,
        candidates,
        inputCommitment: rankingInput.inputCommitment,
      });
      const eligible = eligibleFeedCandidates(candidates);
      if (!eligible.length) {
        throw new PolicyError(
          "NO_ELIGIBLE_CANDIDATES_FOR_PREFERENCES",
          "No BDEX route could be quoted for this ticket size.",
        );
      }
      const cards = eligible.map((candidate, index) => {
        const rankedAsset = ranking.assets.find(
          (asset) => asset.assetId === candidate.assetId,
        );
        return {
          assetId: candidate.assetId,
          action: "BUY" as const,
          rank: index + 1,
          amountInBaseUnits: budget.slotBudgetBaseUnits,
          scoreBps: rankedAsset?.scoreBps || candidate.crowdScoreBps,
          marketCapRank: candidate.marketCapRank,
          marketCapRankSource: candidate.marketCapRankSource,
          evidenceIds: candidate.evidenceIds,
          reason: rankedAsset?.reason ?? candidate.reason,
        };
      });
      const feed = validateFeed(
        {
          schemaVersion: "botcrates-feed-output/v1",
          sessionId: session.id,
          inputCommitment: rankingInput.inputCommitment,
          policyVersion: POLICY_VERSION,
          regime: ranking.regime,
          cards,
          warnings: ranking.warnings,
        },
        feedInput,
        candidates,
      );
      response.json({
        candidates,
        feed,
        hasMore: ranking.assets.length > FEED_PAGE_SIZE,
        rankedAssetCount: ranking.assets.length,
        proof: ranked.receipt,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/executions/prepare", requireActor(auth), async (request, response, next) => {
    try {
      const actor = response.locals.actor as ExecutionActor;
      const parsed = executionRequestSchema.parse({
        ...request.body,
        chain: "BOTCHAIN",
        chainId: deps.config.network.chainId,
        inputToken: deps.config.network.usdt,
      });
      const session = await deps.store.getSession(parsed.sessionId);
      if (!session || session.wallet !== actor.wallet) {
        throw new PolicyError("SESSION_NOT_FOUND", "Session not found.");
      }
      const usdt = await chainClient.readContract({
        address: deps.config.network.usdt,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [actor.wallet as Address],
      });
      const required = parsed.selections.reduce(
        (sum, selection) => sum + BigInt(selection.amountInBaseUnits),
        0n,
      );
      if (usdt < required) {
        throw new PolicyError(
          "INSUFFICIENT_FUNDS",
          `This basket needs ${formatUnits(required, USDT_DECIMALS)} USDT and the wallet holds ${formatUnits(usdt, USDT_DECIMALS)} USDT.`,
        );
      }
      const candidates = await deps.candidates.getCandidatesForExecution(
        actor.wallet,
        parsed.selections.map((selection) => selection.assetId),
        parsed.selections[0]?.amountInBaseUnits,
        new Date(),
      );
      // Oracle-backed assets must still agree with the chain before money moves.
      for (const candidate of candidates) {
        if (!candidate.lumoraFeedId) continue;
        await deps.lumora.verifiedPrice(candidate.lumoraFeedId);
      }
      validateExecutionSelection(parsed, candidates);
      const prepared = await deps.execution.prepareBasket(
        actor.wallet,
        parsed,
        candidates,
        actor.txOrigin,
      );
      const generatedAt = new Date().toISOString();
      const totalInputBaseUnits = prepared.quotes
        .reduce((sum, quote) => sum + BigInt(quote.amountInBaseUnits), 0n)
        .toString();
      const intent = {
        sessionId: session.id,
        epochId: session.epochId,
        executionProvider: "BDEX" as const,
        chain: "BOTCHAIN" as const,
        chainId: deps.config.network.chainId,
        inputToken: deps.config.network.usdt,
        signingWallet: actor.wallet,
        totalInputBaseUnits,
        policyHash: policyHash(parsed.selections, parsed.periodLimitUsd),
        quotes: prepared.quotes,
        generatedAt,
      };
      const plan: ExecutionPlan = {
        executionId: randomUUID(),
        sessionId: session.id,
        epochId: session.epochId,
        provider: "BDEX",
        chain: "BOTCHAIN",
        chainId: deps.config.network.chainId,
        inputToken: deps.config.network.usdt,
        signingWallet: actor.wallet,
        totalInputBaseUnits,
        authorizedPlanHash: executionIntent(intent),
        policyHash: intent.policyHash,
        callCommitments: prepared.walletCalls.map((call) =>
          callCommitment(call.transaction),
        ),
        quotes: prepared.quotes,
        generatedAt,
      };
      const record = await deps.store.reserveExecution(session.id, plan);
      response.json({ ...record, walletCalls: prepared.walletCalls });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/executions/:id/submitted", requireActor(auth), async (request, response, next) => {
    try {
      const actor = response.locals.actor as ExecutionActor;
      const body = z
        .object({
          transactionHashes: z
            .array(z.string().regex(/^0x[a-fA-F0-9]{64}$/))
            .min(1),
          batched: z.boolean().optional(),
        })
        .parse(request.body);
      const execution = await requireOwnedExecution(
        deps.store,
        String(request.params.id),
        actor,
      );
      response.json(
        await deps.store.updateExecution(
          execution.plan.executionId,
          "SUBMITTED",
          body.transactionHashes,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/executions/:id/reconcile", requireActor(auth), async (request, response, next) => {
    try {
      const actor = response.locals.actor as ExecutionActor;
      const execution = await requireOwnedExecution(
        deps.store,
        String(request.params.id),
        actor,
      );
      const hashes = execution.transactionHashes;
      if (!hashes.length) {
        throw new PolicyError("NOT_SUBMITTED", "No transaction hashes yet.");
      }
      const outputs: ExecutionRecord["settledOutputs"] = [];
      for (const hash of hashes) {
        const receipt = await deps.bdex.receiptTransfers(
          hash as `0x${string}`,
          actor.wallet as Address,
        );
        for (const quote of execution.plan.quotes) {
          const transfer = receipt.transfers.find(
            (item) => item.token.toLowerCase() === quote.tokenOut.toLowerCase(),
          );
          if (!transfer) continue;
          outputs.push({
            assetId: quote.assetId,
            amountOutBaseUnits: transfer.amount.toString(),
            transactionHash: hash,
            blockNumber: receipt.blockNumber,
            status: receipt.status === "success" ? "success" : "failed",
          });
        }
      }
      const expected = new Set(execution.plan.quotes.map((quote) => quote.assetId));
      const successful = outputs.filter((output) => output.status === "success");
      const status =
        successful.length === expected.size
          ? "SETTLED"
          : successful.length
            ? "PARTIAL"
            : "FAILED";
      response.json(
        await deps.store.updateExecution(
          execution.plan.executionId,
          status,
          hashes,
          outputs,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/executions/:id", requireActor(auth), async (request, response, next) => {
    try {
      const actor = response.locals.actor as ExecutionActor;
      response.json(
        await requireOwnedExecution(deps.store, String(request.params.id), actor),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/activity", requireActor(auth), async (_request, response, next) => {
    try {
      const actor = response.locals.actor as ExecutionActor;
      response.json({ executions: await deps.store.listExecutions(actor.wallet) });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/positions/:assetId/exit/quote",
    requireActor(auth),
    async (request, response, next) => {
      try {
        const actor = response.locals.actor as ExecutionActor;
        const assetId = String(request.params.assetId);
        const body = z
          .object({
            amountInBaseUnits: z.string().regex(/^[0-9]+$/),
            slippageBps: z.number().int().min(1).max(100).default(50),
          })
          .parse(request.body ?? {});
        const [candidate] = await deps.candidates.getCandidatesForExecution(
          actor.wallet,
          [assetId],
          body.amountInBaseUnits,
        );
        if (!candidate) {
          throw new PolicyError(
            "ASSET_NOT_ELIGIBLE",
            "No BDEX exit route for this asset.",
          );
        }
        const prepared = await deps.execution.prepareExit(
          actor.wallet,
          candidate,
          body.amountInBaseUnits,
          body.slippageBps,
          actor.txOrigin,
        );
        response.json({
          kind: "EVM_CALLS",
          provider: "BDEX",
          asset: {
            assetId: candidate.assetId,
            symbol: candidate.symbol,
            decimals: candidate.decimals,
          },
          quote: prepared.quote,
          walletCalls: prepared.walletCalls,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.use(errorHandler);
  return app;
}

function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction,
) {
  if (error instanceof ZodError) {
    respondWithError(response, 400, "INVALID_REQUEST", error.message);
    return;
  }
  if (error instanceof PolicyError) {
    const status =
      error.code === "SESSION_NOT_FOUND" ||
      error.code === "EXECUTION_NOT_FOUND" ||
      error.code === "ASSET_NOT_FOUND" ||
      error.code === "PREFERENCES_NOT_SET"
        ? 404
        : 400;
    respondWithError(response, status, error.code, error.message);
    return;
  }
  if (error instanceof ExecutionProviderError) {
    respondWithError(response, 409, error.code, error.message);
    return;
  }
  if (error instanceof LumoraStalePriceError) {
    respondWithError(
      response,
      409,
      "STALE_ORACLE",
      "Lumora has not published a fresh price for this asset yet.",
    );
    return;
  }
  if (error instanceof LumoraUnknownAssetError) {
    respondWithError(
      response,
      404,
      "ASSET_NOT_FOUND",
      "Lumora does not publish this asset.",
    );
    return;
  }
  const message = error instanceof Error ? error.message : "INTERNAL_ERROR";
  // `jose` reports a rejected token by error name, not message, so both are
  // checked; otherwise an expired session surfaces as a confusing 500.
  const name = error instanceof Error ? error.name : "";
  if (
    /SIWE|WALLET_DOES_NOT_MATCH|ACCESS_TOKEN|AUTH/.test(message) ||
    name.startsWith("JW")
  ) {
    console.warn(
      JSON.stringify({
        event: "auth_rejected",
        path: request.path,
        reason: name ? `${name}: ${message}` : message,
        hasAuthorization: Boolean(request.header("authorization")),
        walletHeader: request.header("x-wallet-address") ?? null,
      }),
    );
    respondWithError(
      response,
      401,
      "AUTH_REQUIRED",
      "Connect MetaMask and sign in again.",
    );
    return;
  }
  console.error(
    JSON.stringify({
      event: "request_failed",
      path: request.path,
      reason: name ? `${name}: ${message}` : message,
    }),
  );
  respondWithError(response, 500, "INTERNAL_ERROR", message);
}

/**
 * The client reads `error` for the code, so both keys are sent to keep the
 * payload readable from logs as well.
 */
function respondWithError(
  response: Response,
  status: number,
  code: string,
  message: string,
) {
  response.status(status).json({ error: code, code, message });
}

function toChartPoint(point: { timestamp: number; price: number }) {
  return { timestamp: point.timestamp, price: point.price };
}

function assetCategories(candidate: RankingCandidate) {
  const categories = new Set<string>();
  if (candidate.lumoraFamily) categories.add(candidate.lumoraFamily);
  categories.add(candidate.kind);
  if (candidate.lumoraFeedId) categories.add("LUMORA");
  categories.add("BDEX");
  return [...categories];
}

function requireActor(auth: SiweWalletAuth) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      response.locals.actor = await auth.actor(request);
      next();
    } catch (error) {
      next(error);
    }
  };
}

function assertSameWallet(actor: ExecutionActor, wallet: string) {
  if (actor.wallet !== wallet.toLowerCase()) {
    throw new Error("WALLET_DOES_NOT_MATCH_SESSION");
  }
}

async function requireOwnedExecution(
  store: StateStore,
  id: string,
  actor: ExecutionActor,
) {
  const execution = await store.getExecution(id);
  if (!execution || execution.plan.signingWallet.toLowerCase() !== actor.wallet) {
    throw new PolicyError("EXECUTION_NOT_FOUND", "Execution not found.");
  }
  return execution;
}
