import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { BOT_NETWORKS, lumoraAssetId } from "../src/domain/constants.js";
import {
  LumoraOracle,
  LumoraStalePriceError,
  LumoraUnknownAssetError,
} from "../src/server/adapters/lumora.js";

const network = BOT_NETWORKS.testnet;

function oracleWith(
  routes: Record<string, { status?: number; body: unknown }>,
): { oracle: LumoraOracle; requested: string[] } {
  const requested: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    requested.push(path);
    const route = routes[path] ?? routes[url.pathname];
    if (!route) {
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    oracle: new LumoraOracle(
      network,
      "https://oracle.test",
      network.lumoraConsumer,
      fetcher,
    ),
    requested,
  };
}

describe("Lumora feed ids", () => {
  it("hashes TICKER-USD the way Lumora documents", () => {
    expect(lumoraAssetId("WTI-USD")).toBe(keccak256(toBytes("WTI-USD")));
    expect(lumoraAssetId("AAPL-USD")).toMatch(/^0x[a-f0-9]{64}$/);
  });
});

describe("Lumora REST", () => {
  it("normalizes /api/prices rows and derives the assetId when absent", async () => {
    const { oracle } = oracleWith({
      "/api/prices": {
        body: {
          prices: [
            {
              feed_id: "WTI-USD",
              symbol: "WTI",
              title: "WTI Crude Oil",
              family: "ENERGY",
              value: 86.52759,
              amount: "86527590000000003556",
              decimals: 18,
              unit: "USD",
              timestamp: 1787405502,
              age_seconds: 120,
              fresh: true,
            },
            { feed_id: "BROKEN-USD", symbol: "BROKEN", value: 0 },
          ],
        },
      },
    });

    const prices = await oracle.listPrices();

    expect(prices).toHaveLength(1);
    expect(prices[0]?.assetId).toBe(lumoraAssetId("WTI-USD"));
    expect(prices[0]?.family).toBe("ENERGY");
    expect(prices[0]?.value).toBeCloseTo(86.52759, 5);
  });

  it("forwards window, family and q as documented", async () => {
    const { oracle, requested } = oracleWith({
      "/api/prices?window=7200&family=ENERGY&q=wti": { body: { prices: [] } },
    });

    await oracle.listPrices({ windowSeconds: 7200, family: "ENERGY", query: "wti" });

    expect(requested).toContain("/api/prices?window=7200&family=ENERGY&q=wti");
  });

  it("maps 404 to unknown asset and 409 to stale price", async () => {
    const { oracle } = oracleWith({
      "/api/prices/NOPE-USD": { status: 404, body: { error: "unknown_asset" } },
      "/api/prices/OLD-USD": { status: 409, body: { error: "stale" } },
    });

    await expect(oracle.getPrice("NOPE-USD")).rejects.toBeInstanceOf(
      LumoraUnknownAssetError,
    );
    await expect(oracle.getPrice("OLD-USD")).rejects.toBeInstanceOf(
      LumoraStalePriceError,
    );
  });

  it("asks for the full lookback and returns an ascending series", async () => {
    const { oracle, requested } = oracleWith({
      "/api/prices/WTI-USD/history?window=0": {
        body: {
          history: [
            { value: 87.1, timestamp: 1787405600, tx_hash: "0xbb", block_number: 2 },
            { value: 86.5, timestamp: 1787405502, tx_hash: "0xaa", block_number: 1 },
            { value: 0, timestamp: 1787405400 },
          ],
        },
      },
    });

    const series = await oracle.series("WTI-USD");

    expect(requested).toContain("/api/prices/WTI-USD/history?window=0");
    expect(series.map((point) => point.price)).toEqual([86.5, 87.1]);
    expect(series[0]?.txHash).toBe("0xaa");
  });
});
