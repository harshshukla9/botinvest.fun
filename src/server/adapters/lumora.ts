import {
  createPublicClient,
  formatUnits,
  http,
  keccak256,
  parseAbiItem,
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

/**
 * Lumora REST (https://botchain-commodity-oracle.vercel.app) exposes two catalogs
 * that share one on-chain CommodityConsumer:
 *  - `/api/prices` + `/api/feeds`: ~106 curated RWA feeds (equities, ETFs, FX, commodities)
 *  - `/api/digital-assets`: ~4.7k digital assets, paginated and searchable
 * Both use `assetId = keccak256(feed_id)` on chain, so either can be verified with eth_call.
 */
export interface LumoraPrice {
  feedId: string;
  assetId: Hex;
  symbol: string;
  title: string;
  family: LumoraFamily;
  value: number;
  amount: string;
  decimals: number;
  unit: string;
  timestamp: number;
  updatedIso: string;
  ageSeconds: number;
  fresh: boolean;
  onchain: boolean;
  icon?: string;
  assetType?: string;
  route?: string;
  source?: string;
  change24hPct?: number;
  volume24hUsd?: number;
  rank?: number;
  blockchain?: string;
  tokenAddress?: string;
  tokenDecimals?: number;
}

export interface LumoraHistoryPoint {
  timestamp: number;
  price: number;
  txHash?: string;
  blockNumber?: number;
  explorerTxUrl?: string;
}

export interface LumoraListOptions {
  /** Max age in seconds. The REST default is 7200 and it caps at 24h. */
  windowSeconds?: number;
  family?: LumoraFamily;
  query?: string;
  force?: boolean;
}

export class LumoraUnknownAssetError extends Error {
  constructor(readonly asset: string) {
    super(`LUMORA_UNKNOWN_ASSET:${asset}`);
    this.name = "LumoraUnknownAssetError";
  }
}

export class LumoraStalePriceError extends Error {
  constructor(
    readonly asset: string,
    readonly ageSeconds?: number,
  ) {
    super(`LUMORA_STALE:${asset}${ageSeconds ? `:${ageSeconds}` : ""}`);
    this.name = "LumoraStalePriceError";
  }
}

const FAMILIES: LumoraFamily[] = [
  "ENERGY",
  "METALS",
  "FX",
  "TREASURY",
  "CRYPTO",
  "INDICES",
  "EQUITIES",
  "DIGITAL",
];

const FAMILY_BY_NAME = new Map(FAMILIES.map((family) => [family, family]));

/**
 * The oracle emits this for every publish. Reading it directly is the only way
 * to chart digital assets, because `/api/prices/:asset/history` only covers the
 * curated RWA catalog.
 */
const PRICE_UPDATED_EVENT = parseAbiItem(
  "event PriceUpdated(bytes32 indexed assetId, uint256 id, uint256 price, uint256 timestamp)",
);

const PRICES_TTL_MS = 30_000;
const FEEDS_TTL_MS = 300_000;
const DIGITAL_TTL_MS = 60_000;
const HISTORY_TTL_MS = 60_000;
const CHAIN_HISTORY_TTL_MS = 300_000;
/** REST caps `pageSize` at 100 for /api/digital-assets. */
const DIGITAL_PAGE_SIZE = 100;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export class LumoraOracle {
  private readonly client: PublicClient;
  private readonly prices = new Map<string, CacheEntry<LumoraPrice[]>>();
  private readonly digital = new Map<string, CacheEntry<LumoraPrice[]>>();
  private readonly history = new Map<string, CacheEntry<LumoraHistoryPoint[]>>();
  private feeds: CacheEntry<LumoraPrice[]> | undefined;
  private inflight = new Map<string, Promise<unknown>>();

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

  get baseUrl() {
    return this.apiBase;
  }

  get consumerAddress() {
    return this.consumer;
  }

  /** `GET /api/prices` — the curated RWA feeds that are fresh inside `window`. */
  async listPrices(options: LumoraListOptions = {}): Promise<LumoraPrice[]> {
    const search = new URLSearchParams();
    if (options.windowSeconds !== undefined) {
      search.set("window", String(options.windowSeconds));
    }
    if (options.family) search.set("family", options.family);
    if (options.query) search.set("q", options.query);
    const path = `/api/prices${search.size ? `?${search}` : ""}`;
    const cached = this.prices.get(path);
    if (!options.force && cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const payload = await this.getJson<{ prices?: unknown[] }>(path);
    const value = normalizeList(payload.prices);
    this.prices.set(path, { expiresAt: Date.now() + PRICES_TTL_MS, value });
    return value;
  }

  /** `GET /api/feeds` — the full RWA catalog, including feeds that are currently stale. */
  async listFeeds(force = false): Promise<LumoraPrice[]> {
    if (!force && this.feeds && this.feeds.expiresAt > Date.now()) {
      return this.feeds.value;
    }
    const payload = await this.getJson<{ feeds?: unknown[] }>("/api/feeds");
    const value = normalizeList(payload.feeds);
    this.feeds = { expiresAt: Date.now() + FEEDS_TTL_MS, value };
    return value;
  }

  /**
   * `GET /api/prices/:asset` — accepts a ticker (`WTI`), a feed id (`WTI-USD`)
   * or an assetId. 404 means the catalog has no such asset, 409 means the feed
   * exists but has not been published inside the freshness window.
   */
  async getPrice(asset: string, windowSeconds?: number): Promise<LumoraPrice> {
    const search = new URLSearchParams();
    if (windowSeconds !== undefined) search.set("window", String(windowSeconds));
    const payload = await this.getJson<{
      price?: unknown;
      age_seconds?: number;
    }>(
      `/api/prices/${encodeURIComponent(asset)}${search.size ? `?${search}` : ""}`,
      { asset },
    );
    const price = normalizePrice(payload.price);
    if (!price) throw new LumoraStalePriceError(asset, payload.age_seconds);
    return price;
  }

  /**
   * `GET /api/prices/:asset/history` — PriceUpdated logs. `window=0` asks for the
   * full lookback, which is what a sparkline needs; the 2h default is usually a
   * single point.
   */
  async getHistory(asset: string, windowSeconds = 0): Promise<LumoraHistoryPoint[]> {
    const path = `/api/prices/${encodeURIComponent(asset)}/history?window=${windowSeconds}`;
    const cached = this.history.get(path);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const payload = await this.getJson<{
      history?: Array<Record<string, unknown>>;
    }>(path, { asset });
    const points: LumoraHistoryPoint[] = [];
    for (const point of payload.history ?? []) {
      const price = Number(point.value);
      const timestamp = readTimestampSeconds(point);
      if (!Number.isFinite(price) || price <= 0 || !timestamp) continue;
      points.push({
        timestamp,
        price,
        txHash: typeof point.tx_hash === "string" ? point.tx_hash : undefined,
        blockNumber:
          typeof point.block_number === "number" ? point.block_number : undefined,
        explorerTxUrl:
          typeof point.explorer_tx === "string" ? point.explorer_tx : undefined,
      });
    }
    const value = points.sort((left, right) => left.timestamp - right.timestamp);
    this.history.set(path, { expiresAt: Date.now() + HISTORY_TTL_MS, value });
    return value;
  }

  /**
   * Full published series for a feed. REST is tried first because it is indexed
   * and edge-cached, but it only resolves the curated RWA catalog, so digital
   * assets fall back to reading `PriceUpdated` logs from the oracle.
   */
  async series(feedId: string): Promise<LumoraHistoryPoint[]> {
    try {
      const rest = await this.getHistory(feedId, 0);
      if (rest.length) return rest;
    } catch (error) {
      if (!(error instanceof LumoraUnknownAssetError)) throw error;
    }
    return this.getChainHistory(keccak256(toBytes(feedId)));
  }

  /**
   * The full published series for an asset, read from `PriceUpdated` logs on the
   * oracle. Works for every asset the oracle knows, RWA or digital.
   */
  async getChainHistory(assetId: Hex): Promise<LumoraHistoryPoint[]> {
    const key = `chain:${assetId.toLowerCase()}`;
    const cached = this.history.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.dedupe(key, async () => {
      const logs = await this.client.getLogs({
        address: this.network.lumoraOracle,
        event: PRICE_UPDATED_EVENT,
        args: { assetId },
        fromBlock: 0n,
        toBlock: "latest",
      });
      const points: LumoraHistoryPoint[] = [];
      for (const log of logs) {
        const price = log.args.price;
        const timestamp = log.args.timestamp;
        if (price === undefined || timestamp === undefined || price === 0n) continue;
        points.push({
          timestamp: Number(timestamp),
          price: Number(formatUnits(price, 18)),
          txHash: log.transactionHash ?? undefined,
          blockNumber: Number(log.blockNumber ?? 0n),
          explorerTxUrl: log.transactionHash
            ? `${this.network.explorerUrl}/tx/${log.transactionHash}`
            : undefined,
        });
      }
      return points.sort((left, right) => left.timestamp - right.timestamp);
    });
    this.history.set(key, {
      expiresAt: Date.now() + CHAIN_HISTORY_TTL_MS,
      value,
    });
    return value;
  }

  /** `GET /api/digital-assets` — one page of the digital asset catalog. */
  async listDigitalAssets(
    options: { page?: number; pageSize?: number; query?: string } = {},
  ): Promise<LumoraPrice[]> {
    const search = new URLSearchParams({
      page: String(options.page ?? 1),
      pageSize: String(Math.min(options.pageSize ?? DIGITAL_PAGE_SIZE, DIGITAL_PAGE_SIZE)),
    });
    if (options.query) search.set("q", options.query);
    const path = `/api/digital-assets?${search}`;
    const cached = this.digital.get(path);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.dedupe(path, async () => {
      const payload = await this.getJson<{ assets?: unknown[] }>(path);
      return normalizeList(payload.assets);
    });
    this.digital.set(path, { expiresAt: Date.now() + DIGITAL_TTL_MS, value });
    return value;
  }

  /**
   * Resolve a token symbol against the digital asset catalog. The catalog lists the
   * same symbol on many chains, so the highest ranked (deepest) entry wins.
   */
  async findDigitalAsset(symbol: string): Promise<LumoraPrice | undefined> {
    const wanted = symbol.trim().toUpperCase();
    if (!wanted) return;
    const matches = (await this.listDigitalAssets({ query: wanted })).filter(
      (asset) => asset.symbol.toUpperCase() === wanted,
    );
    if (!matches.length) return;
    return matches.sort(
      (left, right) =>
        (left.rank ?? Number.MAX_SAFE_INTEGER) -
          (right.rank ?? Number.MAX_SAFE_INTEGER) ||
        (right.volume24hUsd ?? 0) - (left.volume24hUsd ?? 0),
    )[0];
  }

  /** Reads the CommodityConsumer directly. `assetId` is `keccak256(feed_id)`. */
  async readOnChain(feedId: string): Promise<{
    assetId: Hex;
    price: bigint;
    value: number;
    timestamp: number;
  }> {
    const assetId = keccak256(toBytes(feedId));
    const [, price, timestamp] = await this.client.readContract({
      address: this.consumer,
      abi: LUMORA_CONSUMER_ABI,
      functionName: "getPrice",
      args: [assetId],
    });
    if (price === 0n) throw new LumoraUnknownAssetError(feedId);
    return {
      assetId,
      price,
      value: Number(formatUnits(price, 18)),
      timestamp: Number(timestamp),
    };
  }

  /**
   * The price used for anything that touches money: REST is only trusted when it
   * agrees with the on-chain value, and the on-chain publish time decides staleness.
   */
  async verifiedPrice(feedId: string): Promise<LumoraPrice> {
    const [rest, onchain] = await Promise.all([
      this.getPrice(feedId).catch(async (error) => {
        if (error instanceof LumoraUnknownAssetError) {
          const digital = await this.findDigitalAssetByFeedId(feedId);
          if (digital) return digital;
        }
        throw error;
      }),
      this.readOnChain(feedId),
    ]);
    const ageSeconds = Math.max(
      0,
      Math.floor(Date.now() / 1000) - onchain.timestamp,
    );
    if (ageSeconds > LUMORA_MAX_STALENESS_SECONDS) {
      throw new LumoraStalePriceError(feedId, ageSeconds);
    }
    const drift =
      rest.value === 0 ? 1 : Math.abs(rest.value - onchain.value) / rest.value;
    if (drift > 0.02) {
      throw new Error(
        `LUMORA_REST_ONCHAIN_MISMATCH:${feedId}:${rest.value}:${onchain.value}`,
      );
    }
    return {
      ...rest,
      assetId: onchain.assetId,
      value: onchain.value,
      amount: onchain.price.toString(),
      timestamp: onchain.timestamp,
      updatedIso: new Date(onchain.timestamp * 1000).toISOString(),
      ageSeconds,
      fresh: true,
      onchain: true,
    };
  }

  indexBySymbol(prices: LumoraPrice[]) {
    const index = new Map<string, LumoraPrice>();
    for (const price of prices) {
      const symbol = price.symbol.toUpperCase();
      const existing = index.get(symbol);
      if (!existing || (price.rank ?? Infinity) < (existing.rank ?? Infinity)) {
        index.set(symbol, price);
      }
      index.set(price.feedId.toUpperCase(), price);
      index.set(price.assetId.toLowerCase(), price);
    }
    return index;
  }

  private async findDigitalAssetByFeedId(feedId: string) {
    const symbol = feedId.split("-")[0] ?? feedId;
    const matches = await this.listDigitalAssets({ query: symbol });
    return matches.find(
      (asset) => asset.feedId.toUpperCase() === feedId.toUpperCase(),
    );
  }

  private async dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const promise = run().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async getJson<T>(
    path: string,
    context: { asset?: string } = {},
  ): Promise<T> {
    const response = await this.fetcher(`${this.apiBase}${path}`, {
      headers: { accept: "application/json" },
      redirect: "follow",
    });
    if (response.status === 404) {
      throw new LumoraUnknownAssetError(context.asset ?? path);
    }
    if (response.status === 409) {
      throw new LumoraStalePriceError(context.asset ?? path);
    }
    if (!response.ok) {
      throw new Error(`LUMORA_HTTP_${response.status}:${path}`);
    }
    return (await response.json()) as T;
  }
}

function normalizeList(rows: unknown): LumoraPrice[] {
  if (!Array.isArray(rows)) return [];
  const prices: LumoraPrice[] = [];
  for (const row of rows) {
    const price = normalizePrice(row);
    if (price) prices.push(price);
  }
  return prices;
}

function normalizePrice(raw: unknown): LumoraPrice | undefined {
  if (!raw || typeof raw !== "object") return;
  const row = raw as Record<string, unknown>;
  const feedId = readString(row.feed_id);
  const symbol = readString(row.symbol);
  const value = Number(row.value);
  if (!feedId || !symbol || !Number.isFinite(value) || value <= 0) return;

  const timestamp = readTimestampSeconds(row);
  const assetId = readString(row.assetId);
  const family =
    FAMILY_BY_NAME.get(readString(row.family).toUpperCase() as LumoraFamily) ??
    "UNKNOWN";
  const ageSeconds = Number.isFinite(Number(row.age_seconds))
    ? Number(row.age_seconds)
    : Math.max(0, Math.floor(Date.now() / 1000) - timestamp);

  return {
    feedId,
    assetId: (assetId || keccak256(toBytes(feedId))) as Hex,
    symbol,
    title: readString(row.title) || readString(row.name) || symbol,
    family,
    value,
    amount: readString(row.amount),
    decimals: Number(row.decimals ?? 18),
    unit: readString(row.unit) || "USD",
    timestamp,
    updatedIso:
      readString(row.updated_iso) ||
      new Date((timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    ageSeconds,
    fresh: row.fresh === true,
    onchain: row.onchain !== false,
    icon: readString(row.icon) || undefined,
    assetType: readString(row.asset_type) || undefined,
    route: readString(row.route) || undefined,
    source: readString(row.source) || undefined,
    change24hPct: readNumber(row.change_24h_pct),
    volume24hUsd: readNumber(row.volume),
    rank: readNumber(row.rank),
    blockchain: readString(row.blockchain) || undefined,
    tokenAddress: readString(row.address) || undefined,
    tokenDecimals: readNumber(row.token_decimals),
  };
}

/**
 * RWA rows carry `timestamp` (seconds) while digital asset rows carry `period`;
 * both carry `updated_at` in milliseconds.
 */
function readTimestampSeconds(row: Record<string, unknown>): number {
  const candidates = [row.timestamp, row.period, row.updated_at];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    return parsed > 1e12 ? Math.floor(parsed / 1000) : Math.floor(parsed);
  }
  const iso = readString(row.updated_iso);
  const parsedIso = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsedIso) ? Math.floor(parsedIso / 1000) : 0;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function readNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
