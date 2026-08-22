import { describe, expect, it } from "vitest";
import { SiweWalletAuth } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";

describe("SIWE auth", () => {
  it("issues a signed nonce that another isolate can consume", () => {
    const env = { SESSION_SECRET: "local-dev-only-secret-change-me-0001" };
    const issuer = new SiweWalletAuth(loadConfig(env));
    const verifier = new SiweWalletAuth(loadConfig(env));
    const nonce = issuer.issueNonce();

    expect(nonce).toMatch(/^[a-f0-9]{76}$/);
    expect(verifier.consumeNonce(nonce)).toBe(true);
    expect(verifier.consumeNonce("deadbeef")).toBe(false);
    expect(verifier.consumeNonce(`${nonce.slice(0, 75)}0`)).toBe(false);
  });
});
