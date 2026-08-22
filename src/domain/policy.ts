import { sha256 } from "./canonical.js";
import {
  MAX_DEGEN_PRICE_IMPACT_BPS,
  MAX_PRICE_IMPACT_BPS,
  POLICY_VERSION,
  QUOTE_TTL_SECONDS,
} from "./constants.js";
import {
  type Candidate,
  type ExecutionRequest,
  type FeedInput,
  type FeedOutput,
  feedOutputSchema,
  type RankingCandidate,
  type RankingInput,
  type RankingOutput,
  rankingOutputSchema,
  TICKET_SIZE_INCREMENT_BASE_UNITS,
  ticketSizeToBaseUnits,
} from "./schemas.js";

export class PolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

export function eligibleCandidates(
  candidates: Candidate[],
  now = new Date(),
): Candidate[] {
  return candidates.filter((candidate) => {
    const quote = candidate.quote;
    if (!quote) return false;
    const quoteAgeMs = now.getTime() - new Date(quote.quotedAt).getTime();
    const maxPriceImpactBps =
      candidate.kind === "CRYPTO" &&
      candidate.riskFlags?.includes("community")
        ? MAX_DEGEN_PRICE_IMPACT_BPS
        : MAX_PRICE_IMPACT_BPS;
    return Boolean(
      hasCanonicalCandidateIdentity(candidate) &&
        candidate.eligible &&
        candidate.marketHealthy &&
        candidate.permissionAllowed &&
        quote.priceImpactBps <= maxPriceImpactBps &&
        quoteAgeMs >= 0 &&
        quoteAgeMs <= QUOTE_TTL_SECONDS * 1_000 &&
        new Date(quote.expiresAt).getTime() > now.getTime(),
    );
  });
}

export function eligibleFeedCandidates(candidates: Candidate[]): Candidate[] {
  return candidates.filter(
    (candidate) =>
      hasCanonicalCandidateIdentity(candidate) &&
      candidate.eligible &&
      candidate.marketHealthy &&
      candidate.permissionAllowed,
  );
}

function hasCanonicalCandidateIdentity(candidate: Candidate): boolean {
  const match = candidate.assetId.match(/^bot:(\d+):(0x[a-fA-F0-9]{40})$/i);
  return Boolean(
    match?.[2] &&
      match[2].toLowerCase() === candidate.contract.toLowerCase(),
  );
}

export function validateFeed(
  raw: unknown,
  input: FeedInput,
  candidates: Candidate[],
): FeedOutput {
  const feed = feedOutputSchema.parse(raw);
  if (feed.sessionId !== input.sessionId) {
    throw new PolicyError(
      "SESSION_MISMATCH",
      "The ranking output references a different session.",
    );
  }
  if (feed.inputCommitment !== input.inputCommitment) {
    throw new PolicyError(
      "COMMITMENT_MISMATCH",
      "The ranking output commitment does not match.",
    );
  }

  const allowed = new Map(
    eligibleFeedCandidates(candidates).map((candidate) => [
      candidate.assetId,
      candidate,
    ]),
  );
  const seen = new Set<string>();
  let total = 0n;

  for (const card of feed.cards) {
    if (!allowed.has(card.assetId)) {
      throw new PolicyError(
        "ASSET_NOT_ELIGIBLE",
        `Asset ${card.assetId} did not pass the candidate gate.`,
      );
    }
    if (seen.has(card.assetId)) {
      throw new PolicyError(
        "DUPLICATE_ASSET",
        `Asset ${card.assetId} appeared more than once.`,
      );
    }
    if (card.amountInBaseUnits !== input.budget.slotBudgetBaseUnits) {
      throw new PolicyError(
        "INVALID_SLOT_SIZE",
        "Every card must use the selected ticket size.",
      );
    }
    seen.add(card.assetId);
    total += BigInt(card.amountInBaseUnits);
  }

  if (
    feed.cards.length > input.budget.maxCards ||
    total > BigInt(input.budget.periodBudgetBaseUnits)
  ) {
    throw new PolicyError(
      "BUDGET_EXCEEDED",
      "The feed exceeds the period budget.",
    );
  }
  return feed;
}

export function validateRanking(
  raw: unknown,
  input: RankingInput,
  candidates: RankingCandidate[],
): RankingOutput {
  const ranking = rankingOutputSchema.parse(raw);
  if (ranking.sessionId !== input.sessionId) {
    throw new PolicyError(
      "SESSION_MISMATCH",
      "The ranking references a different session.",
    );
  }
  if (ranking.inputCommitment !== input.inputCommitment) {
    throw new PolicyError(
      "COMMITMENT_MISMATCH",
      "The ranking commitment does not match.",
    );
  }
  const allowed = new Set(candidates.map((candidate) => candidate.assetId));
  const seen = new Set<string>();
  for (const [index, asset] of ranking.assets.entries()) {
    if (!allowed.has(asset.assetId)) {
      throw new PolicyError(
        "ASSET_NOT_ELIGIBLE",
        `Asset ${asset.assetId} was not supplied for ranking.`,
      );
    }
    if (seen.has(asset.assetId)) {
      throw new PolicyError(
        "DUPLICATE_ASSET",
        `Asset ${asset.assetId} appeared more than once.`,
      );
    }
    if (asset.rank !== index + 1) {
      throw new PolicyError(
        "INVALID_RANK",
        "Ranking must use sequential ranks starting at 1.",
      );
    }
    seen.add(asset.assetId);
  }
  if (ranking.assets.length === 0) {
    throw new PolicyError(
      "EMPTY_RANKING",
      "Ranking must include at least one supplied candidate.",
    );
  }

  const missing = candidates
    .filter((candidate) => !seen.has(candidate.assetId))
    .sort((left, right) => left.discoveryRank - right.discoveryRank)
    .map((candidate, index) => ({
      assetId: candidate.assetId,
      rank: ranking.assets.length + index + 1,
      scoreBps: 0,
      reason:
        "Included from BDEX discovery after the personalized shortlist.",
    }));

  return {
    ...ranking,
    assets: [...ranking.assets, ...missing],
    warnings:
      missing.length === 0
        ? ranking.warnings
        : [
            ...ranking.warnings,
            `${missing.length} supplied candidates were completed from BDEX discovery.`,
          ],
  };
}

export function validateExecutionSelection(
  request: ExecutionRequest,
  candidates: Candidate[],
  now = new Date(),
): void {
  validateExecutionAssets(request, candidates);
  const eligible = new Set(
    eligibleCandidates(candidates, now).map((candidate) => candidate.assetId),
  );

  for (const selection of request.selections) {
    if (!eligible.has(selection.assetId)) {
      throw new PolicyError(
        "ASSET_NOT_ELIGIBLE",
        `${selection.assetId} is not currently executable.`,
      );
    }
  }
}

export function validateExecutionAssets(
  request: ExecutionRequest,
  candidates: Candidate[],
): void {
  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.assetId, candidate]),
  );
  const seen = new Set<string>();
  let total = 0n;
  const periodBudget = ticketSizeToBaseUnits(request.periodLimitUsd);
  const minTicket = ticketSizeToBaseUnits(0.1);
  const increment = TICKET_SIZE_INCREMENT_BASE_UNITS;

  for (const selection of request.selections) {
    const amount = BigInt(selection.amountInBaseUnits);
    if (amount < minTicket || amount % increment !== 0n) {
      throw new PolicyError(
        "INVALID_SLOT_SIZE",
        "Each allocation must be at least 0.10 USDT in 0.01 increments.",
      );
    }
    const candidate = candidatesById.get(selection.assetId);
    if (
      !candidate ||
      !hasCanonicalCandidateIdentity(candidate) ||
      !candidate.eligible ||
      !candidate.marketHealthy ||
      !candidate.permissionAllowed
    ) {
      throw new PolicyError(
        "ASSET_NOT_ELIGIBLE",
        `${selection.assetId} is not currently executable.`,
      );
    }
    if (seen.has(selection.assetId)) {
      throw new PolicyError(
        "DUPLICATE_ASSET",
        "Each asset may appear only once.",
      );
    }
    seen.add(selection.assetId);
    total += amount;
  }

  if (total > periodBudget) {
    throw new PolicyError(
      "BUDGET_EXCEEDED",
      "Execution exceeds the period budget.",
    );
  }
}

export function policyHash(
  selections: ExecutionRequest["selections"],
  periodLimitUsd: number,
): `sha256:${string}` {
  const periodBudget = ticketSizeToBaseUnits(periodLimitUsd);
  return sha256({
    policyVersion: POLICY_VERSION,
    periodBudget: periodBudget.toString(),
    selections: [...selections].sort((left, right) =>
      left.assetId.localeCompare(right.assetId),
    ),
    maxPriceImpactBps: MAX_PRICE_IMPACT_BPS,
  });
}
