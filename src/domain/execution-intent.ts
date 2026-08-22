import { sha256 } from "./canonical.js";
import {
  executionIntentPayload,
  type ExecutionIntentInput,
} from "./execution-intent-payload.js";
import type { ExecutionPlan, ExecutionRequest } from "./schemas.js";

export function executionIntent(input: ExecutionIntentInput) {
  return sha256(executionIntentPayload(input));
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
