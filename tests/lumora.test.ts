import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { lumoraAssetId } from "../src/domain/constants.js";

describe("Lumora feed ids", () => {
  it("hashes TICKER-USD the way Lumora documents", () => {
    expect(lumoraAssetId("WTI-USD")).toBe(keccak256(toBytes("WTI-USD")));
    expect(lumoraAssetId("AAPL-USD")).toMatch(/^0x[a-f0-9]{64}$/);
  });
});
