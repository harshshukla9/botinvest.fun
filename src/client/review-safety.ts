import { ticketSizeToBaseUnits, type Candidate } from "../domain/schemas";

export interface ReviewExecutionRecord {
  plan: {
    sessionId: string;
    epochId: string;
    provider: "BDEX";
    quotes: Array<{ assetId: string; amountInBaseUnits: string }>;
    totalInputBaseUnits: string;
  };
  status: "PREPARED" | "SUBMITTED" | "SETTLED" | "PARTIAL" | "FAILED";
  walletCalls?: Array<{ transaction: { from: string } }>;
}

export interface ReviewBasket {
  sessionId: string;
  epochId: string;
  selected: Candidate[];
  ticketSizeUsd: number;
  periodLimitUsd: number;
  wallet: string;
}

export function reviewBasketKey(basket: ReviewBasket) {
  return JSON.stringify({
    sessionId: basket.sessionId,
    epochId: basket.epochId,
    assetIds: basket.selected.map((candidate) => candidate.assetId).sort(),
    ticketSizeUsd: basket.ticketSizeUsd,
    periodLimitUsd: basket.periodLimitUsd,
    wallet: basket.wallet.toLowerCase(),
  });
}

export function executionMatchesReviewBasket(
  record: ReviewExecutionRecord | undefined,
  basket: ReviewBasket,
) {
  if (
    !record ||
    !basket.selected.length ||
    record.plan.sessionId !== basket.sessionId ||
    record.plan.epochId !== basket.epochId
  ) {
    return false;
  }
  const amountInBaseUnits = ticketSizeToBaseUnits(basket.ticketSizeUsd).toString();
  const selectedIds = basket.selected.map((candidate) => candidate.assetId).sort();
  const quotedIds = record.plan.quotes.map((quote) => quote.assetId).sort();
  if (
    selectedIds.length !== quotedIds.length ||
    selectedIds.some((assetId, index) => assetId !== quotedIds[index]) ||
    record.plan.quotes.some((quote) => quote.amountInBaseUnits !== amountInBaseUnits)
  ) {
    return false;
  }
  if (!record.walletCalls?.length) return true;
  return record.walletCalls.every(
    (call) => call.transaction.from.toLowerCase() === basket.wallet.toLowerCase(),
  );
}
