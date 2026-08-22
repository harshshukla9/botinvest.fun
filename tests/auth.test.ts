import { describe, expect, it } from "vitest";
import { SiweWalletAuth } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";

describe("SIWE auth", () => {
  it("issues a one-time nonce", () => {
    const auth = new SiweWalletAuth(loadConfig());
    const nonce = auth.issueNonce();
    expect(nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(auth.issueNonce()).not.toBe(nonce);
  });
});
