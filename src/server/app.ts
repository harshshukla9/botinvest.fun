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
} from "../domain/schemas.js";
import type { BdexProvider } from "./adapters/bdex.js";
import type { LumoraOracle } from "./adapters/lumora.js";
import { ExecutionProviderError } from "./adapters/types.js";
import type { CandidateProvider, ExecutionProvider, FeedRankingProvider } from "./adapters/types.js";
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
            "https://rpc.botchain.ai",
            "https://rpc.bohr.life",
            "https://lumora-oracle.vercel.app",
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
      limit: deps.config.NODE_ENV === "production" ? 90 : 240,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );

  app.get("/api/health", async (_request, response) => {
    const [bdex, lumoraCount] = await Promise.all([
      deps.execution.health(),
      deps.lumora.listPrices().then((prices) => prices.length).catch(() => 0),
    ]);
    response.json({
      status: "ok",
      chainId: deps.config.network.chainId,
      network: deps.config.networkName,
      bdex: bdex.status,
      lumoraFeeds: lumoraCount,
    });
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
      usdt: deps.config.network.usdt,
      wbot: deps.config.network.wbot,
      lumora: {
        apiBase: deps.config.LUMORA_API_BASE,
        consumer: deps.config.network.lumoraConsumer,
        oracle: deps.config.network.lumoraOracle,
      },
      executionProviders: { BDEX: { available: true } },
      feedRankingProviders: { DETERMINISTIC: { available: true } },
      periodBudgetBaseUnits: DEFAULT_BUDGET.periodBudgetBaseUnits,
      slotBudgetBaseUnits: DEFAULT_BUDGET.slotBudgetBaseUnits,
      maxCards: DEFAULT_BUDGET.maxCards,
    });
  });

  app.get("/api/auth/nonce", (_request, response) => {
    response.json({ nonce: auth.issueNonce(), chainId: deps.config.network.chainId });
  });

  app.post("/api/auth/verify", async (request, response, next) => {
    try {
      const body = z
        .object({ message: z.string().min(1), signature: z.string().min(1) })
        .parse(request.body);
      const verified = await auth.verify(body.message, body.signature);
      response.json(verified);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/balances/:wallet", requireActor(auth), async (request, response, next) => {
    try {
      const wallet = addressSchema.parse(request.params.wallet).toLowerCase() as Address;
      assertSameWallet(response.locals.actor, wallet);
      const [usdt, bot] = await Promise.all([
        chainClient.readContract({
          address: deps.config.network.usdt,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [wallet],
        }),
        chainClient.getBalance({ address: wallet }),
      ]);
      response.json({
        address: wallet,
        usdtBalanceBaseUnits: usdt.toString(),
        usdtDecimals: USDT_DECIMALS,
        botBalanceWei: bot.toString(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/portfolio/:wallet", requireActor(auth), async (request, response, next) => {
    try {
      const wallet = addressSchema.parse(request.params.wallet).toLowerCase() as Address;
      assertSameWallet(response.locals.actor, wallet);
      const markets = await deps.bdex.listMarkets();
      const prices = deps.lumora.indexBySymbol(await deps.lumora.listPrices().catch(() => []));
      const holdings = (
        await Promise.all(
          markets.slice(0, 80).map(async (market) => {
            const balance = await deps.bdex.tokenBalance(wallet, market.token);
            if (balance === 0n) return;
            const oracle = prices.get(market.symbol.toUpperCase());
            const units = Number(formatUnits(balance, market.decimals));
            return {
              assetId: `bot:${deps.config.network.chainId}:${market.token.toLowerCase()}`,
              symbol: market.symbol,
              name: oracle?.title ?? market.name,
              contract: market.token,
              decimals: market.decimals,
              balanceBaseUnits: balance.toString(),
              balance: units,
              priceUsd: oracle?.value,
              valueUsd: oracle ? units * oracle.value : undefined,
              lumoraFeedId: oracle?.feedId,
              iconUrl: oracle?.icon,
            };
          }),
        )
      ).filter((item): item is NonNullable<typeof item> => Boolean(item));
      response.json({ wallet, holdings });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/assets/:assetId/history", async (request, response, next) => {
    try {
      const assetId = String(request.params.assetId);
      const window = Number(request.query.window ?? 86_400);
      const markets = await deps.bdex.listMarkets();
      const match = markets.find(
        (market) =>
          `bot:${deps.config.network.chainId}:${market.token.toLowerCase()}` ===
          assetId.toLowerCase(),
      );
      const prices = await deps.lumora.listPrices().catch(() => []);
      const oracle =
        (match && deps.lumora.indexBySymbol(prices).get(match.symbol.toUpperCase())) ||
        prices.find((price) => price.feedId === assetId);
      if (!oracle) {
        response.json({ period: "1D", source: "unavailable", points: [] });
        return;
      }
      const points = await deps.lumora.history(oracle.feedId, window);
      response.json({
        period: "1D",
        source: "lumora",
        points: points.map((point) => ({
          timestamp: point.timestamp,
          price: point.price,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/assets/:assetId/icon", async (request, response, next) => {
    try {
      const prices = await deps.lumora.listPrices();
      const symbol = String(request.params.assetId).split(":").at(-1) ?? "";
      const match =
        prices.find((price) => price.feedId === request.params.assetId) ??
        prices.find((price) => price.symbol.toLowerCase() === symbol.toLowerCase());
      response.json({ icon: match?.icon ?? null });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/preferences", requireActor(auth), async (request, response, next) => {
    try {
      const actor = response.locals.actor as ExecutionActor;
      const preferences = onboardingPreferencesSchema.parse(request.body);
      response.json(await deps.store.setPreferences(actor.userId, preferences, actor.wallet));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/preferences", requireActor(auth), async (_request, response, next) => {
    try {
      const actor = response.locals.actor as ExecutionActor;
      response.json({ preferences: await deps.store.getPreferences(actor.userId) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions", requireActor(auth), async (request, response, next) => {
    try {
      const actor = response.locals.actor as ExecutionActor;
      const body = z
        .object({
          cadence: z.enum(["daily", "weekly", "monthly"]).default("weekly"),
        })
        .parse(request.body ?? {});
      const session = await deps.store.openSession(
        actor.wallet,
        sessionEpochId(body.cadence),
        "BDEX",
        "BOTCHAIN",
        actor.userId,
        "DETERMINISTIC",
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
      const preferences = onboardingPreferencesSchema.parse(request.body.preferences ?? request.body);
      const excluded = z.array(z.string()).optional().parse(request.body.excludedAssetIds) ?? [];
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
        throw new PolicyError(
          "NO_ELIGIBLE_CANDIDATES_FOR_PREFERENCES",
          "No BDEX markets matched this plan.",
        );
      }
      const rankingInput = rankingInputSchema.parse({
        schemaVersion: "botinvest-ranking-input/v1",
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
      const pageIds = ranking.assets.slice(0, FEED_PAGE_SIZE).map((asset) => asset.assetId);
      const candidates = await deps.candidates.getCandidatesForFeed(
        actor.wallet,
        pageIds,
        budget.slotBudgetBaseUnits,
        new Date(),
        FEED_PAGE_SIZE,
      );
      const feedInput = feedInputSchema.parse({
        schemaVersion: "botinvest-feed-input/v1",
        sessionId: session.id,
        epochId: session.epochId,
        policyVersion: POLICY_VERSION,
        budget,
        preferences,
        candidates,
        inputCommitment: rankingInput.inputCommitment,
      });
      const cards = eligibleFeedCandidates(candidates).map((candidate, index) => {
        const rankedAsset = ranking.assets.find((asset) => asset.assetId === candidate.assetId);
        return {
          assetId: candidate.assetId,
          action: "BUY" as const,
          rank: index + 1,
          amountInBaseUnits: budget.slotBudgetBaseUnits,
          scoreBps: rankedAsset?.scoreBps ?? candidate.crowdScoreBps,
          evidenceIds: candidate.evidenceIds,
          reason: rankedAsset?.reason ?? candidate.reason,
        };
      });
      const feed = validateFeed(
        {
          schemaVersion: "botinvest-feed-output/v1",
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
          `Basket requires ${formatUnits(required, USDT_DECIMALS)} USDT, but this wallet has ${formatUnits(usdt, USDT_DECIMALS)} USDT.`,
        );
      }
      const candidates = await deps.candidates.getCandidatesForExecution(
        actor.wallet,
        parsed.selections.map((selection) => selection.assetId),
        parsed.selections[0]?.amountInBaseUnits,
        new Date(),
      );
      for (const candidate of candidates) {
        if (candidate.lumoraFeedId) {
          await deps.lumora.verifiedPrice(candidate.lumoraFeedId);
        }
      }
      validateExecutionSelection(parsed, candidates);
      const prepared = await deps.execution.prepareBasket(
        actor.wallet,
        parsed,
        candidates,
        actor.txOrigin,
      );
      const generatedAt = new Date().toISOString();
      const authorizedPlanHash = executionIntent({
        sessionId: session.id,
        epochId: session.epochId,
        executionProvider: "BDEX",
        chain: "BOTCHAIN",
        chainId: deps.config.network.chainId,
        inputToken: deps.config.network.usdt,
        signingWallet: actor.wallet,
        totalInputBaseUnits: prepared.quotes
          .reduce((sum, quote) => sum + BigInt(quote.amountInBaseUnits), 0n)
          .toString(),
        policyHash: policyHash(parsed.selections, parsed.periodLimitUsd),
        quotes: prepared.quotes,
        generatedAt,
      });
      const plan: ExecutionPlan = {
        executionId: randomUUID(),
        sessionId: session.id,
        epochId: session.epochId,
        provider: "BDEX",
        chain: "BOTCHAIN",
        chainId: deps.config.network.chainId,
        inputToken: deps.config.network.usdt,
        signingWallet: actor.wallet,
        totalInputBaseUnits: prepared.quotes
          .reduce((sum, quote) => sum + BigInt(quote.amountInBaseUnits), 0n)
          .toString(),
        authorizedPlanHash,
        policyHash: policyHash(parsed.selections, parsed.periodLimitUsd),
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
          transactionHashes: z.array(z.string().regex(/^0x[a-fA-F0-9]{64}$/)).min(1),
        })
        .parse(request.body);
      const execution = await requireOwnedExecution(deps.store, String(request.params.id), actor);
      const updated = await deps.store.updateExecution(
        execution.plan.executionId,
        "SUBMITTED",
        body.transactionHashes,
      );
      response.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/executions/:id/reconcile", requireActor(auth), async (request, response, next) => {
    try {
      const actor = response.locals.actor as ExecutionActor;
      const execution = await requireOwnedExecution(deps.store, String(request.params.id), actor);
      const hashes = execution.transactionHashes;
      if (!hashes.length) throw new PolicyError("NOT_SUBMITTED", "No transaction hashes yet.");
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

  app.post("/api/exits/prepare", requireActor(auth), async (request, response, next) => {
    try {
      const actor = response.locals.actor as ExecutionActor;
      const body = z
        .object({
          assetId: z.string().min(1),
          amountInBaseUnits: z.string().regex(/^[0-9]+$/),
          slippageBps: z.number().int().min(1).max(100).default(50),
        })
        .parse(request.body);
      const [candidate] = await deps.candidates.getCandidatesForExecution(
        actor.wallet,
        [body.assetId],
        body.amountInBaseUnits,
      );
      if (!candidate) {
        throw new PolicyError("ASSET_NOT_ELIGIBLE", "No BDEX exit route for this asset.");
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
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({ code: "INVALID_REQUEST", message: error.message });
      return;
    }
    if (error instanceof PolicyError) {
      response.status(error.code === "SESSION_NOT_FOUND" ? 404 : 400).json({
        code: error.code,
        message: error.message,
      });
      return;
    }
    if (error instanceof ExecutionProviderError) {
      response.status(409).json({
        code: error.code,
        message: error.message,
      });
      return;
    }
    const message = error instanceof Error ? error.message : "INTERNAL_ERROR";
    const authFailure = /SIWE|WALLET_DOES_NOT_MATCH|ACCESS_TOKEN/.test(message);
    response.status(authFailure ? 401 : 500).json({
      code: authFailure ? "AUTH_REQUIRED" : "INTERNAL_ERROR",
      message: authFailure ? "Connect MetaMask and sign in again." : message,
    });
  });

  return app;
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
