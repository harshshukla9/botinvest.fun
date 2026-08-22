import { describe, expect, it } from "vitest";
import { eligibleFeedCandidates, policyHash } from "../src/domain/policy.js";
import type { Candidate } from "../src/domain/schemas.js";

const candidate = {
  chain: "BOTCHAIN",
  assetId: "bot:968:0xD5452816194a3784dBa983426cCe7c122F4abd30",
  symbol: "WBOT",
  name: "Wrapped BOT",
  kind: "CRYPTO",
  contract: "0xD5452816194a3784dBa983426cCe7c122F4abd30",
  decimals: 18,
  eligible: true,
  marketHealthy: true,
  permissionAllowed: true,
  crowdScoreBps: 1_000,
  reason: "BDEX",
  evidenceIds: ["bdex:wbot"],
} satisfies Candidate;

describe("botinvest policy", () => {
  it("accepts a canonical BOT Chain token identity", () => {
    expect(eligibleFeedCandidates([candidate])).toHaveLength(1);
  });

  it("rejects a mismatched contract", () => {
    expect(
      eligibleFeedCandidates([
        {
          ...candidate,
          contract: "0x75edC9335175Fc0552D51D48439F229c10420fe3",
        },
      ]),
    ).toHaveLength(0);
  });

  it("hashes a basket policy", () => {
    const hash = policyHash(
      [{ assetId: candidate.assetId, amountInBaseUnits: "10000000" }],
      100,
    );
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
