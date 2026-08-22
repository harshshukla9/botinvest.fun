import { z } from "zod";
import {
  BOT_NETWORKS,
  LUMORA_API_BASE,
  type BotNetwork,
  type BotNetworkName,
} from "../domain/constants.js";

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(8787),
    PUBLIC_ORIGIN: z.string().url(),
    SESSION_SECRET: z
      .string()
      .min(1)
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
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV === "production" && env.SESSION_SECRET.length < 32) {
      context.addIssue({
        code: "custom",
        path: ["SESSION_SECRET"],
        message: "SESSION_SECRET must be at least 32 characters in production",
      });
    }
  })
  .transform((env) => ({
    ...env,
    SESSION_SECRET:
      env.SESSION_SECRET.length >= 32
        ? env.SESSION_SECRET
        : env.SESSION_SECRET.padEnd(32, "!"),
    DATABASE_URL: env.DATABASE_URL || undefined,
    BDEX_EXTRA_TOKENS: env.BDEX_EXTRA_TOKENS || undefined,
  }));

export type AppConfig = z.infer<typeof envSchema> & {
  networkName: BotNetworkName;
  network: BotNetwork;
  allowedHosts: string[];
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse({
    ...source,
    PUBLIC_ORIGIN: publicOriginFrom(source),
  });
  const networkName = parsed.BOT_CHAIN_NETWORK;
  const defaults = BOT_NETWORKS[networkName];
  return {
    ...parsed,
    networkName,
    allowedHosts: allowedHostsFrom(source, parsed.PUBLIC_ORIGIN),
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

function publicOriginFrom(source: NodeJS.ProcessEnv) {
  if (source.PUBLIC_ORIGIN) return source.PUBLIC_ORIGIN;
  const host =
    source.VERCEL_PROJECT_PRODUCTION_URL ||
    source.VERCEL_BRANCH_URL ||
    source.VERCEL_URL;
  if (host) return host.startsWith("http") ? host : `https://${host}`;
  return "http://localhost:5173";
}

function allowedHostsFrom(source: NodeJS.ProcessEnv, origin: string) {
  const hosts = new Set<string>();
  for (const value of [
    origin,
    source.PUBLIC_ORIGIN,
    source.VERCEL_URL,
    source.VERCEL_BRANCH_URL,
    source.VERCEL_PROJECT_PRODUCTION_URL,
  ]) {
    if (!value) continue;
    try {
      const host = (
        value.startsWith("http") ? new URL(value).host : value
      ).toLowerCase();
      if (host) hosts.add(host.replace("127.0.0.1", "localhost"));
    } catch {
      // Ignore malformed extra hosts; PUBLIC_ORIGIN is already validated.
    }
  }
  return [...hosts];
}

