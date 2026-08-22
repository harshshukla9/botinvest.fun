import { sha256 } from "./canonical.js";
import type { ExecutionPlan, ExecutionRequest } from "./schemas.js";

export function executionIntent(input: {
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
}) {
  return sha256({
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
  });
}

export function callCommitment(call: {
  to: string;
  from: string;
  data: string;
  value: string;
  chainId: number;
}) {
  return sha256({
    to: call.to.toLowerCase(),
    from: call.from.toLowerCase(),
    data: call.data.toLowerCase(),
    value: call.value,
    chainId: call.chainId,
  });
}

export function requestMatchesPlan(
  request: ExecutionRequest,
  plan: ExecutionPlan,
) {
  return (
    request.sessionId === plan.sessionId &&
    request.chain === plan.chain &&
    request.chainId === plan.chainId &&
    request.inputToken.toLowerCase() === plan.inputToken.toLowerCase()
  );
}
