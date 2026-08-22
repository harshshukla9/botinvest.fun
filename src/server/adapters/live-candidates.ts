import { botAssetId, type BotNetwork } from "../../domain/constants.js";
import type { Candidate, RankingCandidate } from "../../domain/schemas.js";
import type { BdexMarket, BdexProvider } from "./bdex.js";
import type { LumoraOracle, LumoraPrice } from "./lumora.js";
import type {
  CandidateDiscoveryOptions,
  CandidateProvider,
} from "./types.js";

/** Lumora families that represent a real-world asset rather than a crypto asset. */
const RWA_FAMILIES = new Set([
  "ENERGY",
  "METALS",
  "FX",
  "TREASURY",
  "INDICES",
  "EQUITIES",
]);

/**
 * A BDEX token is only credited to a Lumora feed when its pool price is inside
 * this band around the oracle price. Symbols are not unique on a permissionless
 * DEX, so agreement on price is what separates a tracking token from a token
 * that merely reused the ticker.
 */
const ORACLE_PRICE_TOLERANCE = 0.35;

/** Pages of the digital asset catalog (100 per page) kept as a symbol index. */
const DIGITAL_INDEX_PAGES = 3;
const DIGITAL_INDEX_TTL_MS = 300_000;

export interface LiveCandidateOptions {
  /** Pools with less depth than this are not worth routing a ticket through. */
  minLiquidityUsd?: number;
}

export class LiveCandidateProvider implements CandidateProvider {
  private readonly minLiquidityUsd: number;
  private digitalIndex:
    | { expiresAt: number; value: Map<string, LumoraPrice> }
    | undefined;

  constructor(
    private readonly network: BotNetwork,
    private readonly bdex: BdexProvider,
    private readonly lumora: LumoraOracle,
    options: LiveCandidateOptions = {},
  ) {
    this.minLiquidityUsd = options.minLiquidityUsd ?? 25;
  }

  async getRankingCandidates(
    limit: number,
    excludedAssetIds: string[] = [],
    options: CandidateDiscoveryOptions = {},
  ): Promise<RankingCandidate[]> {
    const excluded = new Set(excludedAssetIds.map((id) => id.toLowerCase()));
    const wanted = new Set(options.assetClasses ?? ["CRYPTO", "RWA"]);
    const { markets } = await this.bdex.snapshotMarkets();
    const tradable = markets.filter(
      (market) =>
        market.priceUsd > 0 && market.liquidityUsd >= this.minLiquidityUsd,
    );
    if (!tradable.length) return [];

    const oracles = await this.resolveOracles(tradable);
    const candidates: RankingCandidate[] = [];
    for (const [index, market] of tradable.entries()) {
      const oracle = oracles.get(market.token.toLowerCase());
      const kind =
        oracle && RWA_FAMILIES.has(oracle.family) ? ("RWA" as const) : ("CRYPTO" as const);
      const assetId = botAssetId(this.network.chainId, market.token);
      if (!wanted.has(kind) || excluded.has(assetId.toLowerCase())) continue;
      candidates.push({
        chain: "BOTCHAIN",
        assetId,
        symbol: market.symbol,
        name: oracle?.title ?? market.name,
        kind,
        contract: market.token,
        decimals: market.decimals,
        discoveryRank: index + 1,
        priceUsd: market.priceUsd,
        volume24hUsd: oracle?.volume24hUsd,
        priceChange24hPct: oracle?.change24hPct,
        liquidityUsd: market.liquidityUsd,
        discoveryProvider: "BDEX",
        providerLiquidityRank: index + 1,
        providerLiquidityRankTotal: tradable.length,
        marketCapRank: oracle?.rank,
        marketCapRankSource: oracle?.rank ? "lumora" : undefined,
        lumoraFeedId: oracle?.feedId,
        lumoraFamily: oracle?.family,
        lumoraRoute: oracle?.route,
        iconUrl: isHttpUrl(oracle?.icon) ? oracle?.icon : undefined,
        marketDataUpdatedAt: oracle?.updatedIso,
        tags: [kind, "BDEX", ...(oracle ? ["LUMORA", oracle.family] : [])],
        riskFlags: riskFlags(market, oracle),
        marketDataSource: oracle ? "lumora" : "bdex",
      });
    }

    return candidates
      .slice(0, limit)
      .map((candidate, index) => ({ ...candidate, discoveryRank: index + 1 }));
  }

  async getRankingCandidate(assetId: string) {
    const wanted = assetId.toLowerCase();
    const ranking = await this.getRankingCandidates(Number.MAX_SAFE_INTEGER);
    return ranking.find((candidate) => candidate.assetId.toLowerCase() === wanted);
  }

  async getCandidatesForFeed(
    wallet: string,
    rankedAssetIds: string[],
    amountInBaseUnits: string,
    _now: Date,
    limit: number,
  ): Promise<Candidate[]> {
    return this.hydrate(
      wallet,
      rankedAssetIds.slice(0, limit),
      amountInBaseUnits,
      false,
    );
  }

  async getCandidatesForExecution(
    wallet: string,
    assetIds: string[],
    amountInBaseUnits = "1000000",
  ): Promise<Candidate[]> {
    return this.hydrate(wallet, assetIds, amountInBaseUnits, true);
  }

  private async hydrate(
    wallet: string,
    assetIds: string[],
    amountInBaseUnits: string,
    requireQuote: boolean,
  ): Promise<Candidate[]> {
    if (!assetIds.length) return [];
    const ranking = await this.getRankingCandidates(Number.MAX_SAFE_INTEGER);
    const byId = new Map(ranking.map((item) => [item.assetId.toLowerCase(), item]));
    const candidates: Candidate[] = [];

    for (const assetId of assetIds) {
      const ranked = byId.get(assetId.toLowerCase());
      if (!ranked?.contract) continue;
      const candidate: Candidate = {
        chain: "BOTCHAIN",
        assetId: ranked.assetId,
        symbol: ranked.symbol,
        name: ranked.name,
        kind: ranked.kind,
        contract: ranked.contract,
        decimals: ranked.decimals ?? 18,
        eligible: true,
        marketHealthy: true,
        permissionAllowed: true,
        marketPriceUsd: ranked.priceUsd,
        volume24hUsd: ranked.volume24hUsd,
        liquidityUsd: ranked.liquidityUsd,
        priceChange24hPct: ranked.priceChange24hPct,
        discoveryProvider: "BDEX",
        providerLiquidityRank: ranked.providerLiquidityRank,
        providerLiquidityRankTotal: ranked.providerLiquidityRankTotal,
        marketCapRank: ranked.marketCapRank,
        marketCapRankSource: ranked.marketCapRankSource,
        marketDataSource: ranked.marketDataSource,
        lumoraFeedId: ranked.lumoraFeedId,
        lumoraFamily: ranked.lumoraFamily,
        lumoraRoute: ranked.lumoraRoute,
        iconUrl: ranked.iconUrl,
        marketDataUpdatedAt: ranked.marketDataUpdatedAt,
        tags: ranked.tags,
        riskFlags: ranked.riskFlags,
        crowdScoreBps: liquidityScoreBps(ranked.liquidityUsd ?? 0),
        reason: ranked.lumoraFeedId
          ? `Tracks Lumora ${ranked.lumoraFeedId} and clears on BDEX with $${formatUsd(ranked.liquidityUsd)} of depth.`
          : `Live BDEX pool with $${formatUsd(ranked.liquidityUsd)} of depth against ${ranked.symbol}.`,
        evidenceIds: [
          `bdex:${ranked.contract}`,
          ...(ranked.lumoraFeedId ? [`lumora:${ranked.lumoraFeedId}`] : []),
        ],
      };

      try {
        candidate.quote = await this.bdex.price(
          wallet,
          wallet,
          candidate,
          amountInBaseUnits,
          50,
        );
      } catch {
        candidate.eligible = false;
        candidate.marketHealthy = false;
        candidate.riskFlags = [...(candidate.riskFlags ?? []), "no-route"];
      }
      if (requireQuote && !candidate.quote) continue;
      candidates.push(candidate);
    }
    return candidates;
  }

  /**
   * Joins BDEX tokens to Lumora by ticker: the curated RWA feeds first, then the
   * top of the digital asset catalog. A match only stands when the pool price
   * agrees with the oracle price.
   */
  private async resolveOracles(markets: BdexMarket[]) {
    const [rwaFeeds, digitalIndex] = await Promise.all([
      this.lumora.listPrices().catch(() => [] as LumoraPrice[]),
      this.digitalAssetIndex().catch(() => new Map<string, LumoraPrice>()),
    ]);
    const rwaIndex = this.lumora.indexBySymbol(rwaFeeds);
    const resolved = new Map<string, LumoraPrice>();
    for (const market of markets) {
      const symbol = market.symbol.trim().toUpperCase();
      if (!symbol) continue;
      const oracle = rwaIndex.get(symbol) ?? digitalIndex.get(symbol);
      if (!oracle || !priceAgrees(market.priceUsd, oracle.value)) continue;
      resolved.set(market.token.toLowerCase(), oracle);
    }
    return resolved;
  }

  private async digitalAssetIndex() {
    if (this.digitalIndex && this.digitalIndex.expiresAt > Date.now()) {
      return this.digitalIndex.value;
    }
    const pages = await Promise.all(
      Array.from({ length: DIGITAL_INDEX_PAGES }, (_, index) =>
        this.lumora
          .listDigitalAssets({ page: index + 1, pageSize: 100 })
          .catch(() => [] as LumoraPrice[]),
      ),
    );
    const value = new Map<string, LumoraPrice>();
    for (const asset of pages.flat()) {
      const symbol = asset.symbol.toUpperCase();
      const existing = value.get(symbol);
      if (!existing || (asset.rank ?? Infinity) < (existing.rank ?? Infinity)) {
        value.set(symbol, asset);
      }
    }
    this.digitalIndex = { expiresAt: Date.now() + DIGITAL_INDEX_TTL_MS, value };
    return value;
  }
}

function priceAgrees(poolPriceUsd: number, oraclePriceUsd: number) {
  if (poolPriceUsd <= 0 || oraclePriceUsd <= 0) return false;
  return (
    Math.abs(poolPriceUsd - oraclePriceUsd) / oraclePriceUsd <=
    ORACLE_PRICE_TOLERANCE
  );
}

function riskFlags(market: BdexMarket, oracle?: LumoraPrice) {
  const flags: string[] = [];
  if (market.liquidityUsd < 1_000) flags.push("thin-book");
  if (!oracle) flags.push("no-oracle-feed");
  if (market.counterpartSymbol !== "USDT") flags.push("routed-via-wbot");
  return flags;
}

/** Maps pool depth onto the 0-10000 score the feed ranks on. */
function liquidityScoreBps(liquidityUsd: number) {
  const score = Math.log10(Math.max(liquidityUsd, 1) + 10) * 2_000;
  return Math.max(0, Math.min(10_000, Math.round(score)));
}

function formatUsd(value = 0) {
  return value >= 1_000
    ? `${Math.round(value / 1_000)}k`
    : value.toFixed(value >= 10 ? 0 : 2);
}

function isHttpUrl(value?: string) {
  return Boolean(value && /^https?:\/\//i.test(value));
}
