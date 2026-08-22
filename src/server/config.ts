import { z } from "zod";
import {
  BOT_NETWORKS,
  LUMORA_API_BASE,
  type BotNetwork,
  type BotNetworkName,
} from "../domain/constants.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_ORIGIN: z.string().url().default("http://localhost:5173"),
  SESSION_SECRET: z
    .string()
    .min(32)
    .default("local-dev-only-secret-change-me-0001"),
  BOT_CHAIN_NETWORK: z.enum(["mainnet", "testnet"]).default("testnet"),
  BOT_CHAIN_RPC_URL: z.string().url().optional(),
  LUMORA_API_BASE: z.string().url().default(LUMORA_API_BASE),
  LUMORA_CONSUMER_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  LUMORA_ORACLE_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  DATABASE_URL: z.string().optional(),
  BDEX_EXTRA_TOKENS: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema> & {
  networkName: BotNetworkName;
  network: BotNetwork;
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(source);
  const networkName = parsed.BOT_CHAIN_NETWORK;
  const defaults = BOT_NETWORKS[networkName];
  return {
    ...parsed,
    networkName,
    network: {
      ...defaults,
      rpcUrl: parsed.BOT_CHAIN_RPC_URL ?? defaults.rpcUrl,
      lumoraConsumer: (parsed.LUMORA_CONSUMER_ADDRESS ??
        defaults.lumoraConsumer) as BotNetwork["lumoraConsumer"],
      lumoraOracle: (parsed.LUMORA_ORACLE_ADDRESS ??
        defaults.lumoraOracle) as BotNetwork["lumoraOracle"],
    },
  };
}
