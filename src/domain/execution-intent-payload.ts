import type { ExecutionPlan } from "./schemas.js";

export interface ExecutionIntentInput {
	sessionId: string;
	epochId: string;
	executionProvider: "BDEX";
	chain: "BOTCHAIN";
	chainId: number;
	inputToken: string;
	signingWallet: string;
	totalInputBaseUnits: string;
	policyHash: `sha256:${string}`;
	quotes: ExecutionPlan["quotes"];
	generatedAt: string;
}

// Shared by the server (node:crypto) and the browser (WebCrypto) so both sides
// commit to byte-identical execution intents.
export function executionIntentPayload(input: ExecutionIntentInput) {
	return {
		sessionId: input.sessionId,
		epochId: input.epochId,
		provider: input.executionProvider,
		chain: input.chain,
		chainId: input.chainId,
		inputToken: input.inputToken.toLowerCase(),
		signingWallet: input.signingWallet.toLowerCase(),
		totalInputBaseUnits: input.totalInputBaseUnits,
		policyHash: input.policyHash,
		quotes: input.quotes.map((quote) => ({
			assetId: quote.assetId,
			tokenOut: quote.tokenOut.toLowerCase(),
			amountInBaseUnits: quote.amountInBaseUnits,
			estimatedAmountOut: quote.estimatedAmountOut,
			minimumAmountOut: quote.minimumAmountOut,
			routing: quote.routing,
			path: quote.path.map((token) => token.toLowerCase()),
		})),
		generatedAt: input.generatedAt,
	};
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, item]) => item !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, canonicalize(item)]),
		);
	}
	return value;
}
