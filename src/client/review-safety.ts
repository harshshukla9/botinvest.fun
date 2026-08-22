import {
	canonicalJson,
	executionIntentPayload,
} from "../domain/execution-intent-payload.js";
import {
	ticketSizeToBaseUnits,
	type Candidate,
	type ExecutionPlan,
} from "../domain/schemas.js";

export interface ReviewExecutionRecord {
	plan: ExecutionPlan;
	status: "PREPARED" | "SUBMITTED" | "SETTLED" | "PARTIAL" | "FAILED";
	walletCalls?: Array<{
		transaction: { from: string };
	}>;
}

export interface ReviewBasket {
	sessionId: string;
	epochId: string;
	chain: "BOTCHAIN";
	executionProvider: "BDEX";
	selected: Candidate[];
	ticketSizeUsd: number;
	periodLimitUsd: number;
	wallet: string;
}

export function reviewBasketKey(basket: ReviewBasket) {
	return JSON.stringify({
		sessionId: basket.sessionId,
		epochId: basket.epochId,
		executionProvider: basket.executionProvider,
		chain: basket.chain,
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
		record.plan.epochId !== basket.epochId ||
		record.plan.provider !== basket.executionProvider
	) {
		return false;
	}
	const amountInBaseUnits = ticketSizeToBaseUnits(
		basket.ticketSizeUsd,
	).toString();
	const selectedIds = basket.selected
		.map((candidate) => candidate.assetId)
		.sort();
	const quotedIds = record.plan.quotes.map((quote) => quote.assetId).sort();
	if (
		selectedIds.length !== quotedIds.length ||
		selectedIds.some((assetId, index) => assetId !== quotedIds[index]) ||
		record.plan.quotes.some(
			(quote) => quote.amountInBaseUnits !== amountInBaseUnits,
		) ||
		record.plan.totalInputBaseUnits !==
			(BigInt(amountInBaseUnits) * BigInt(selectedIds.length)).toString()
	) {
		return false;
	}
	if (!record.walletCalls?.length) return true;
	return Boolean(
		basket.wallet &&
			record.walletCalls.every(
				(call) =>
					call.transaction.from.toLowerCase() === basket.wallet.toLowerCase(),
			),
	);
}

// The wallet signs transactions the server built, so the client re-derives the
// plan hash from the plan it is about to display. A mismatch means the shown
// basket is not the basket the server authorized.
export async function executionPlanHashMatchesReviewBasket(
	record: ReviewExecutionRecord,
	basket: ReviewBasket,
) {
	if (!basket.selected.length) return false;
	const plan = record.plan;
	if (
		plan.signingWallet.toLowerCase() !== basket.wallet.toLowerCase() ||
		plan.sessionId !== basket.sessionId ||
		plan.epochId !== basket.epochId
	) {
		return false;
	}
	const json = canonicalJson(
		executionIntentPayload({
			sessionId: plan.sessionId,
			epochId: plan.epochId,
			executionProvider: plan.provider,
			chain: plan.chain,
			chainId: plan.chainId,
			inputToken: plan.inputToken,
			signingWallet: plan.signingWallet,
			totalInputBaseUnits: plan.totalInputBaseUnits,
			policyHash: plan.policyHash as `sha256:${string}`,
			quotes: plan.quotes,
			generatedAt: plan.generatedAt,
		}),
	);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(json),
	);
	const hash = Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return plan.authorizedPlanHash === `sha256:${hash}`;
}
