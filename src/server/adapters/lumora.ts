import {
  createPublicClient,
  formatUnits,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  LUMORA_CONSUMER_ABI,
  LUMORA_MAX_STALENESS_SECONDS,
  type BotNetwork,
} from "../../domain/constants.js";
import type { lumoraFamilySchema } from "../../domain/schemas.js";
import type { z } from "zod";

export type LumoraFamily = z.infer<typeof lumoraFamilySchema>;

export interface LumoraPrice {
  feedId: string;
  assetId: Hex;
  symbol: string;
  title: string;
  family: LumoraFamily;
  value: number;
  amount: string;
  decimals: number;
  timestamp: number;
  updatedIso: string;
  ageSeconds: number;
  fresh: boolean;
  icon?: string;
  assetType?: string;
  onchain: boolean;
  change24hPct?: number;
  volume24hUsd?: number;
}

export interface LumoraHistoryPoint {
  timestamp: number;
  price: number;
  txHash?: string;
  blockNumber?: number;
}

const FAMILY_ALIASES: Record<string, LumoraFamily> = {
  ENERGY: "ENERGY",
  METALS: "METALS",
  FX: "FX",
  TREASURY: "TREASURY",
  CRYPTO: "CRYPTO",
  INDICES: "INDICES",
  EQUITIES: "EQUITIES",
  DIGITAL: "DIGITAL",
};

export class LumoraOracle {
  private readonly client: PublicClient;
  private cache:
    | {
        expiresAt: number;
        prices: LumoraPrice[];
      }
    | undefined;

  constructor(
    private readonly network: BotNetwork,
    private readonly apiBase: string,
    private readonly consumer: Address,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.client = createPublicClient({
      transport: http(network.rpcUrl),
    });
  }

  async listPrices(force = false): Promise<LumoraPrice[]> {
    if (
      !force &&
      this.cache &&
      this.cache.expiresAt > Date.now()
    ) {
      return this.cache.prices;
    }
    const payload = await this.getJson<{
      ok?: boolean;
      prices?: unknown[];
    }>("/api/prices");
    const prices = (payload.prices ?? [])
      .map((row) => normalizePrice(row))
      .filter((row): row is LumoraPrice => Boolean(row));
    this.cache = {
      expiresAt: Date.now() + 20_000,
      prices,
    };
    return prices;
  }

  async getPrice(feedId: string): Promise<LumoraPrice> {
    const payload = await this.getJson<{ price?: unknown }>(
      `/api/prices/${encodeURIComponent(feedId)}`,
    );
    const price = normalizePrice(payload.price);
    if (!price) throw new Error(`LUMORA_PRICE_MISSING:${feedId}`);
    return price;
  }

  async history(
    feedId: string,
    windowSeconds = 86_400,
  ): Promise<LumoraHistoryPoint[]> {
    const payload = await this.getJson<{
      history?: Array<{
        value?: number;
        timestamp?: number;
        updated_at?: number;
        tx_hash?: string;
        block_number?: number;
      }>;
    }>(
      `/api/prices/${encodeURIComponent(feedId)}/history?window=${windowSeconds}`,
    );
    const points: LumoraHistoryPoint[] = [];
    for (const point of payload.history ?? []) {
      const timestamp = Number(point.updated_at ?? point.timestamp ?? 0);
      const price = Number(point.value);
      if (!Number.isFinite(price) || !Number.isFinite(timestamp) || timestamp <= 0) {
        continue;
      }
      points.push({
        timestamp: timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp,
        price,
        txHash: point.tx_hash,
        blockNumber: point.block_number,
      });
    }
    return points.sort((left, right) => left.timestamp - right.timestamp);
  }

  async digitalAssets(page = 1, pageSize = 100): Promise<LumoraPrice[]> {
    const payload = await this.getJson<{ assets?: unknown[] }>(
      `/api/digital-assets?page=${page}&pageSize=${pageSize}`,
    );
    return (payload.assets ?? [])
      .map((row) => normalizePrice(row))
      .filter((row): row is LumoraPrice => Boolean(row));
  }

  async readOnChain(feedId: string): Promise<{
    assetId: Hex;
    price: bigint;
    value: number;
    timestamp: bigint;
  }> {
    const assetId = keccak256(toBytes(feedId));
    const [id, price, timestamp] = await this.client.readContract({
      address: this.consumer,
      abi: LUMORA_CONSUMER_ABI,
      functionName: "getPrice",
      args: [assetId],
    });
    if (price === 0n) {
      throw new Error(`LUMORA_ONCHAIN_EMPTY:${feedId}`);
    }
    return {
      assetId,
      price,
      value: Number(formatUnits(price, 18)),
      timestamp: timestamp || id,
    };
  }

  async verifiedPrice(feedId: string): Promise<LumoraPrice> {
    const [rest, onchain] = await Promise.all([
      this.getPrice(feedId),
      this.readOnChain(feedId),
    ]);
    const ageSeconds = Math.max(
      0,
      Math.floor(Date.now() / 1000) - Number(onchain.timestamp),
    );
    if (ageSeconds > LUMORA_MAX_STALENESS_SECONDS) {
      throw new Error(`LUMORA_STALE:${feedId}:${ageSeconds}`);
    }
    const drift =
      rest.value === 0
        ? 1
        : Math.abs(rest.value - onchain.value) / rest.value;
    if (drift > 0.02) {
      throw new Error(
        `LUMORA_REST_ONCHAIN_MISMATCH:${feedId}:${rest.value}:${onchain.value}`,
      );
    }
    return {
      ...rest,
      value: onchain.value,
      amount: onchain.price.toString(),
      timestamp: Number(onchain.timestamp),
      ageSeconds,
      fresh: true,
      onchain: true,
      assetId: onchain.assetId,
    };
  }

  indexBySymbol(prices: LumoraPrice[]) {
    const index = new Map<string, LumoraPrice>();
    for (const price of prices) {
      index.set(price.symbol.toUpperCase(), price);
      index.set(price.feedId.toUpperCase(), price);
    }
    return index;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.apiBase}${path}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`LUMORA_HTTP_${response.status}:${path}`);
    }
    return (await response.json()) as T;
  }
}

function normalizePrice(raw: unknown): LumoraPrice | undefined {
  if (!raw || typeof raw !== "object") return;
  const row = raw as Record<string, unknown>;
  const feedId = String(row.feed_id ?? "");
  const symbol = String(row.symbol ?? "");
  const value = Number(row.value);
  if (!feedId || !symbol || !Number.isFinite(value) || value <= 0) return;
  const family = FAMILY_ALIASES[String(row.family ?? "").toUpperCase()] ?? "UNKNOWN";
  const timestamp = Number(row.timestamp ?? 0);
  return {
    feedId,
    assetId: String(row.assetId ?? keccak256(toBytes(feedId))) as Hex,
    symbol,
    title: String(row.title ?? row.name ?? symbol),
    family,
    value,
    amount: String(row.amount ?? ""),
    decimals: Number(row.decimals ?? 18),
    timestamp,
    updatedIso:
      typeof row.updated_iso === "string"
        ? row.updated_iso
        : new Date((Number(row.updated_at) || timestamp * 1000) || Date.now()).toISOString(),
    ageSeconds: Number(row.age_seconds ?? 0),
    fresh: row.fresh === true,
    icon: typeof row.icon === "string" ? row.icon : undefined,
    assetType: typeof row.asset_type === "string" ? row.asset_type : undefined,
    onchain: row.onchain !== false,
    change24hPct:
      typeof row.change_24h_pct === "number" ? row.change_24h_pct : undefined,
    volume24hUsd: typeof row.volume === "number" ? row.volume : undefined,
  };
}
