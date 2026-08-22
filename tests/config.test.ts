import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

describe("config", () => {
  it("defaults to BOT Testnet where Lumora publishes", () => {
    const config = loadConfig({
      SESSION_SECRET: "short-local-secret",
    });
    expect(config.network.chainId).toBe(968);
    expect(config.network.rpcUrl).toBe("https://rpc.bohr.life");
    expect(config.LUMORA_API_BASE).toBe(
      "https://botchain-commodity-oracle.vercel.app",
    );
  });

  it("uses official mainnet RPC and USDT when requested", () => {
    const config = loadConfig({
      BOT_CHAIN_NETWORK: "mainnet",
      SESSION_SECRET: "local-dev-only-secret-change-me-0001",
    });
    expect(config.network.chainId).toBe(677);
    expect(config.network.usdt).toBe(
      "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C",
    );
  });
});
