import { botAssetId, type BotNetwork } from "../../domain/constants.js";
import type { Candidate, RankingCandidate } from "../../domain/schemas.js";
import type { BdexProvider } from "./bdex.js";
import type { LumoraOracle, LumoraPrice } from "./lumora.js";
import type {
  CandidateDiscoveryOptions,
  CandidateProvider,
} from "./types.js";

export class LiveCandidateProvider implements CandidateProvider {
  constructor(
    private readonly network: BotNetwork,
    private readonly bdex: BdexProvider,
    private readonly lumora: LumoraOracle,
  ) {}

  async getRankingCandidates(
    limit: number,
    excludedAssetIds: string[] = [],
    options: CandidateDiscoveryOptions = {},
  ): Promise<RankingCandidate[]> {
    const excluded = new Set(excludedAssetIds.map((id) => id.toLowerCase()));
    const wanted = new Set(options.assetClasses ?? ["CRYPTO", "RWA"]);
    const [markets, lumoraPrices] = await Promise.all([
      this.bdex.listMarkets(),
      this.lumora.listPrices().catch(() => [] as LumoraPrice[]),
    ]);
    const lumoraBySymbol = this.lumora.indexBySymbol(lumoraPrices);

    const ranked = markets
      .map((market, index) => {
        const oracle = lumoraBySymbol.get(market.symbol.toUpperCase());
        const kind =
          oracle && oracle.family !== "CRYPTO" && oracle.family !== "DIGITAL"
            ? ("RWA" as const)
            : ("CRYPTO" as const);
        const assetId = botAssetId(this.network.chainId, market.token);
        return {
          chain: "BOTCHAIN" as const,
          assetId,
          symbol: market.symbol,
          name: oracle?.title ?? market.name,
          kind,
          contract: market.token,
          decimals: market.decimals,
          discoveryRank: index + 1,
          priceUsd: oracle?.value,
          volume24hUsd: oracle?.volume24hUsd,
          priceChange24hPct: oracle?.change24hPct,
          liquidityUsd: market.reserveUsd,
          discoveryProvider: "BDEX" as const,
          lumoraFeedId: oracle?.feedId,
          lumoraFamily: oracle?.family,
          iconUrl: oracle?.icon,
          marketDataUpdatedAt: oracle?.updatedIso,
          tags: [kind, "BDEX", ...(oracle ? ["LUMORA", oracle.family] : [])],
          riskFlags: market.reserveUsd < 1_000 ? ["thin-book"] : [],
          marketDataSource: oracle ? ("lumora" as const) : ("bdex" as const),
        } satisfies RankingCandidate;
      })
      .filter(
        (candidate) =>
          wanted.has(candidate.kind) &&
          !excluded.has(candidate.assetId.toLowerCase()),
      )
      .sort((left, right) => {
        const leftOracle = left.marketDataSource === "lumora" ? 1 : 0;
        const rightOracle = right.marketDataSource === "lumora" ? 1 : 0;
        return (
          rightOracle - leftOracle ||
          (right.liquidityUsd ?? 0) - (left.liquidityUsd ?? 0)
        );
      })
      .slice(0, limit)
      .map((candidate, index) => ({ ...candidate, discoveryRank: index + 1 }));

    return ranked;
  }

  async getCandidatesForFeed(
    wallet: string,
    rankedAssetIds: string[],
    amountInBaseUnits: string,
    now: Date,
    limit: number,
  ): Promise<Candidate[]> {
    return this.hydrate(
      wallet,
      rankedAssetIds.slice(0, limit),
      amountInBaseUnits,
      now,
      false,
    );
  }

  async getCandidatesForExecution(
    wallet: string,
    assetIds: string[],
    amountInBaseUnits = "1000000",
    now = new Date(),
  ): Promise<Candidate[]> {
    return this.hydrate(wallet, assetIds, amountInBaseUnits, now, true);
  }

  private async hydrate(
    wallet: string,
    assetIds: string[],
    amountInBaseUnits: string,
    now: Date,
    requireQuote: boolean,
  ): Promise<Candidate[]> {
    const ranking = await this.getRankingCandidates(AI_SAFE_LIMIT);
    const byId = new Map(ranking.map((item) => [item.assetId.toLowerCase(), item]));
    const candidates: Candidate[] = [];
    for (const assetId of assetIds) {
      const ranked = byId.get(assetId.toLowerCase());
      if (!ranked || !ranked.contract) continue;
      const candidate: Candidate = {
        chain: "BOTCHAIN",
        assetId: ranked.assetId,
        symbol: ranked.symbol,
        name: ranked.name,
        kind: ranked.kind,
        contract: ranked.contract,
        decimals: ranked.decimals ?? 18,
        eligible: true,
        marketHealthy: (ranked.liquidityUsd ?? 0) > 0 || Boolean(ranked.lumoraFeedId),
        permissionAllowed: true,
        marketPriceUsd: ranked.priceUsd,
        volume24hUsd: ranked.volume24hUsd,
        liquidityUsd: ranked.liquidityUsd,
        discoveryProvider: "BDEX",
        marketDataSource: ranked.marketDataSource,
        lumoraFeedId: ranked.lumoraFeedId,
        lumoraFamily: ranked.lumoraFamily,
        iconUrl: ranked.iconUrl,
        marketDataUpdatedAt: ranked.marketDataUpdatedAt,
        tags: ranked.tags,
        riskFlags: ranked.riskFlags,
        crowdScoreBps: Math.min(
          10_000,
          Math.round(Math.log10((ranked.liquidityUsd ?? 1) + 10) * 1_200),
        ),
        reason: ranked.lumoraFeedId
          ? `Priced by Lumora ${ranked.lumoraFeedId} and executable on BDEX.`
          : "Discovered from a live BDEX pool.",
        evidenceIds: [
          ranked.lumoraFeedId
            ? `lumora:${ranked.lumoraFeedId}`
            : `bdex:${ranked.contract}`,
        ],
      };
      if (requireQuote || amountInBaseUnits) {
        try {
          candidate.quote = await this.bdex.price(
            wallet,
            wallet,
            candidate,
            amountInBaseUnits,
            50,
          );
        } catch {
          if (requireQuote) continue;
        }
      }
      if (candidate.quote) {
        candidate.eligible = true;
        candidate.marketHealthy = true;
      }
      candidates.push(candidate);
    }
    return candidates.filter((candidate) =>
      requireQuote ? Boolean(candidate.quote) : candidate.eligible,
    );
  }
}

const AI_SAFE_LIMIT = 200;
