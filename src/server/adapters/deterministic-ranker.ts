import { sha256 } from "../../domain/canonical.js";
import type {
  RankingCandidate,
  RankingInput,
  RankingOutput,
} from "../../domain/schemas.js";
import type { FeedRankingProvider } from "./types.js";

const MODEL_VERSION = "botinvest-deterministic/v1";

export class DeterministicRanker implements FeedRankingProvider {
  async rank(input: RankingInput) {
    const scored = input.candidates
      .map((candidate) => ({
        candidate,
        scoreBps: scoreCandidate(candidate, input),
      }))
      .sort(
        (left, right) =>
          right.scoreBps - left.scoreBps ||
          left.candidate.discoveryRank - right.candidate.discoveryRank ||
          left.candidate.assetId.localeCompare(right.candidate.assetId),
      );
    const crypto = scored.filter(({ candidate }) => candidate.kind === "CRYPTO");
    const rwa = scored.filter(({ candidate }) => candidate.kind === "RWA");
    const groups =
      Number.parseInt(input.inputCommitment.at(-1) ?? "0", 16) % 2
        ? [rwa, crypto]
        : [crypto, rwa];
    const mixed = Array.from(
      { length: Math.max(crypto.length, rwa.length) },
      (_, index) => groups.flatMap((group) => group[index] ?? []),
    ).flat();
    const output: RankingOutput = {
      schemaVersion: "botinvest-ranking-output/v1",
      sessionId: input.sessionId,
      inputCommitment: input.inputCommitment,
      policyVersion: input.policyVersion,
      regime: marketRegime(input.candidates),
      assets: mixed.map(({ candidate, scoreBps }, index) => ({
        assetId: candidate.assetId,
        rank: index + 1,
        scoreBps,
        reason: rankingReason(candidate),
      })),
      warnings: [],
    };
    return {
      output,
      receipt: {
        network: "botinvest",
        model: MODEL_VERSION,
        provider: "deterministic",
        teeVerified: false,
        inputCommitment: input.inputCommitment,
        outputCommitment: sha256(output),
        requestedProvider: "DETERMINISTIC" as const,
        effectiveProvider: "DETERMINISTIC" as const,
      },
    };
  }
}

function scoreCandidate(candidate: RankingCandidate, input: RankingInput) {
  const liquidity = logarithmicSignal(candidate.liquidityUsd, 2_000);
  const volume = logarithmicSignal(candidate.volume24hUsd, 1_400);
  const oracle = candidate.marketDataSource === "lumora" ? 900 : 200;
  const freshness = candidate.marketDataUpdatedAt ? 400 : 0;
  const risk =
    input.preferences.riskMode === "conservative"
      ? candidate.kind === "RWA"
        ? 500
        : 0
      : input.preferences.riskMode === "degen"
        ? candidate.kind === "CRYPTO"
          ? 500
          : 0
        : 250;
  return Math.max(0, Math.min(10_000, liquidity + volume + oracle + freshness + risk));
}

function logarithmicSignal(value: number | undefined, weight: number) {
  if (!value || value <= 0) return 0;
  return Math.min(weight, Math.round(Math.log10(value + 10) * (weight / 4)));
}

function marketRegime(candidates: RankingCandidate[]) {
  const changes = candidates
    .map((candidate) => candidate.priceChange24hPct)
    .filter((value): value is number => typeof value === "number");
  if (!changes.length) return "CRYPTO_NEUTRAL" as const;
  const average = changes.reduce((sum, value) => sum + value, 0) / changes.length;
  if (average <= -3) return "RISK_OFF" as const;
  if (average >= 3) return "CRYPTO_BULLISH" as const;
  if (average <= -1) return "CRYPTO_BEARISH" as const;
  return "CRYPTO_NEUTRAL" as const;
}

function rankingReason(candidate: RankingCandidate) {
  if (candidate.lumoraFeedId) {
    return `${candidate.symbol} is ranked from a live Lumora ${candidate.lumoraFamily ?? "USD"} feed and a BDEX pool.`;
  }
  return `${candidate.symbol} is ranked from live BDEX reserves on BOT Chain.`;
}
