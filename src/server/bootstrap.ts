import { BdexProvider } from "./adapters/bdex.js";
import { DeterministicRanker } from "./adapters/deterministic-ranker.js";
import { LiveCandidateProvider } from "./adapters/live-candidates.js";
import { LumoraOracle } from "./adapters/lumora.js";
import { createApp } from "./app.js";
import { SiweWalletAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { PostgresStateStore } from "./postgres-store.js";
import { MemoryStateStore } from "./store.js";

export function createServerApp() {
  const config = loadConfig();
  const store = config.DATABASE_URL
    ? new PostgresStateStore(config.DATABASE_URL)
    : new MemoryStateStore();
  if (!config.DATABASE_URL && config.NODE_ENV === "production") {
    console.warn(
      JSON.stringify({
        event: "memory_store",
        message:
          "DATABASE_URL is unset; sessions live only inside one serverless isolate.",
      }),
    );
  }
  const lumora = new LumoraOracle(
    config.network,
    config.LUMORA_API_BASE,
    config.network.lumoraConsumer,
  );
  const bdex = new BdexProvider(config.network);
  const execution = bdex;
  const candidates = new LiveCandidateProvider(config.network, bdex, lumora);
  const inference = new DeterministicRanker();

  return createApp({
    config,
    store,
    candidates,
    inference,
    execution,
    bdex,
    lumora,
    auth: new SiweWalletAuth(config),
  });
}
