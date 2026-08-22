import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  isAddress,
  maxUint256,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  botAssetId,
  QUOTE_TTL_SECONDS,
  USDT_DECIMALS,
  type BotNetwork,
} from "../../domain/constants.js";
import type { Candidate, ExecutionRequest, Quote } from "../../domain/schemas.js";
import { botViemChain } from "../chain.js";
import {
  ExecutionProviderError,
  type ExecutionProvider,
  type WalletCall,
} from "./types.js";

const V2_FACTORY_ABI = parseAbi([
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
]);

const V2_PAIR_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);

const V2_ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);

/** Emitted by every V2 pair on each reserve change, which is the pool's price tape. */
const SYNC_EVENT = parseAbiItem(
  "event Sync(uint112 reserve0, uint112 reserve1)",
);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MARKETS_TTL_MS = 45_000;
const PRICE_HISTORY_TTL_MS = 120_000;

export interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
}

export interface BdexMarket extends TokenMetadata {
  token: Address;
  pair: Address;
  /** The USDT or WBOT side of the deepest pool holding this token. */
  counterpart: Address;
  counterpartSymbol: string;
  counterpartDecimals: number;
  /** True when the token is `token0` of the pair, which fixes reserve ordering. */
  tokenIsToken0: boolean;
  tokenReserve: bigint;
  counterpartReserve: bigint;
  /** USD value of the counterpart side, i.e. the depth a buy trades against. */
  liquidityUsd: number;
  /** Pool mid price, derived from reserves and the USD value of the counterpart. */
  priceUsd: number;
}

export interface BdexSnapshot {
  markets: BdexMarket[];
  wbotPriceUsd: number;
  /** Deepest USDT/WBOT pool, which anchors every WBOT-quoted pool to USD. */
  wbotPair?: { pair: Address; usdtIsToken0: boolean };
  pairCount: number;
}

export interface PricePoint {
  timestamp: number;
  price: number;
  blockNumber: number;
}

export class BdexProvider implements ExecutionProvider {
  readonly id = "BDEX" as const;
  readonly label = "BDEX";
  private readonly client: PublicClient;
  private readonly metadata = new Map<string, TokenMetadata>();
  private snapshot: { expiresAt: number; value: BdexSnapshot } | undefined;
  private pending: Promise<BdexSnapshot> | undefined;
  private readonly priceHistories = new Map<
    string,
    { expiresAt: number; value: PricePoint[] }
  >();

  constructor(private readonly network: BotNetwork) {
    this.client = createPublicClient({
      chain: botViemChain(network),
      transport: http(network.rpcUrl, { batch: true }),
    });
  }

  get chainId() {
    return this.network.chainId;
  }

  async listMarkets(force = false): Promise<BdexMarket[]> {
    return (await this.snapshotMarkets(force)).markets;
  }

  async snapshotMarkets(force = false): Promise<BdexSnapshot> {
    if (!force && this.snapshot && this.snapshot.expiresAt > Date.now()) {
      return this.snapshot.value;
    }
    if (this.pending) return this.pending;
    this.pending = this.loadMarkets().finally(() => {
      this.pending = undefined;
    });
    const value = await this.pending;
    this.snapshot = { expiresAt: Date.now() + MARKETS_TTL_MS, value };
    return value;
  }

  async findMarket(token: string): Promise<BdexMarket | undefined> {
    const wanted = token.toLowerCase();
    const { markets } = await this.snapshotMarkets();
    return markets.find((market) => market.token.toLowerCase() === wanted);
  }

  private async loadMarkets(): Promise<BdexSnapshot> {
    const pairCount = Number(
      await this.client.readContract({
        address: this.network.v2Factory,
        abi: V2_FACTORY_ABI,
        functionName: "allPairsLength",
      }),
    );
    if (!pairCount) return { markets: [], wbotPriceUsd: 0, pairCount: 0 };

    const pairAddresses = (
      await this.client.multicall({
        contracts: Array.from({ length: pairCount }, (_, index) => ({
          address: this.network.v2Factory,
          abi: V2_FACTORY_ABI,
          functionName: "allPairs",
          args: [BigInt(index)],
        })),
        allowFailure: true,
      })
    )
      .map((entry) =>
        entry.status === "success" ? (entry.result as unknown as Address) : undefined,
      )
      .filter(
        (pair): pair is Address => Boolean(pair) && pair !== ZERO_ADDRESS,
      );

    const pairState = await this.client.multicall({
      contracts: pairAddresses.flatMap((pair) => [
        { address: pair, abi: V2_PAIR_ABI, functionName: "token0" } as const,
        { address: pair, abi: V2_PAIR_ABI, functionName: "token1" } as const,
        { address: pair, abi: V2_PAIR_ABI, functionName: "getReserves" } as const,
      ]),
      allowFailure: true,
    });

    interface PoolState {
      pair: Address;
      token0: Address;
      token1: Address;
      reserve0: bigint;
      reserve1: bigint;
    }
    const pools: PoolState[] = [];
    for (const [index, pair] of pairAddresses.entries()) {
      const token0 = pairState[index * 3];
      const token1 = pairState[index * 3 + 1];
      const reserves = pairState[index * 3 + 2];
      if (
        token0?.status !== "success" ||
        token1?.status !== "success" ||
        reserves?.status !== "success"
      ) {
        continue;
      }
      const [reserve0, reserve1] = reserves.result as readonly [
        bigint,
        bigint,
        number,
      ];
      if (reserve0 <= 0n || reserve1 <= 0n) continue;
      pools.push({
        pair,
        token0: token0.result as Address,
        token1: token1.result as Address,
        reserve0,
        reserve1,
      });
    }

    await this.loadMetadata(
      pools.flatMap((pool) => [pool.token0, pool.token1]),
    );

    const usdt = this.network.usdt.toLowerCase();
    const wbot = this.network.wbot.toLowerCase();
    const { wbotPriceUsd, wbotPair } = this.deriveWbotPrice(pools);

    const byToken = new Map<string, BdexMarket>();
    for (const pool of pools) {
      const sides = [
        {
          token: pool.token0,
          reserve: pool.reserve0,
          counterpart: pool.token1,
          counterpartReserve: pool.reserve1,
        },
        {
          token: pool.token1,
          reserve: pool.reserve1,
          counterpart: pool.token0,
          counterpartReserve: pool.reserve0,
        },
      ];
      for (const side of sides) {
        const tokenKey = side.token.toLowerCase();
        const counterpartKey = side.counterpart.toLowerCase();
        if (tokenKey === usdt || tokenKey === wbot) continue;
        if (counterpartKey !== usdt && counterpartKey !== wbot) continue;

        const meta = this.metadata.get(tokenKey);
        const counterpartMeta = this.metadata.get(counterpartKey);
        if (!meta || !counterpartMeta) continue;

        const counterpartUnits = Number(
          formatUnits(side.counterpartReserve, counterpartMeta.decimals),
        );
        const counterpartUsdPrice = counterpartKey === usdt ? 1 : wbotPriceUsd;
        const liquidityUsd = counterpartUnits * counterpartUsdPrice;
        const tokenUnits = Number(formatUnits(side.reserve, meta.decimals));
        const priceUsd = tokenUnits > 0 ? liquidityUsd / tokenUnits : 0;

        const market: BdexMarket = {
          ...meta,
          token: side.token,
          pair: pool.pair,
          counterpart: side.counterpart,
          counterpartSymbol: counterpartMeta.symbol,
          counterpartDecimals: counterpartMeta.decimals,
          tokenIsToken0: pool.token0.toLowerCase() === tokenKey,
          tokenReserve: side.reserve,
          counterpartReserve: side.counterpartReserve,
          liquidityUsd,
          priceUsd,
        };
        const existing = byToken.get(tokenKey);
        if (!existing || market.liquidityUsd > existing.liquidityUsd) {
          byToken.set(tokenKey, market);
        }
      }
    }

    const markets = [...byToken.values()].sort(
      (left, right) => right.liquidityUsd - left.liquidityUsd,
    );
    return { markets, wbotPriceUsd, wbotPair, pairCount };
  }

  /** WBOT has no oracle feed, so its USD value comes from the deepest USDT pool. */
  private deriveWbotPrice(
    pools: Array<{
      pair: Address;
      token0: Address;
      token1: Address;
      reserve0: bigint;
      reserve1: bigint;
    }>,
  ) {
    const usdt = this.network.usdt.toLowerCase();
    const wbot = this.network.wbot.toLowerCase();
    let bestUsdtReserve = 0;
    let wbotPriceUsd = 0;
    let wbotPair: BdexSnapshot["wbotPair"];
    for (const pool of pools) {
      const token0 = pool.token0.toLowerCase();
      const token1 = pool.token1.toLowerCase();
      const usdtIsToken0 = token0 === usdt && token1 === wbot;
      if (!usdtIsToken0 && !(token0 === wbot && token1 === usdt)) continue;
      const usdtReserve = usdtIsToken0 ? pool.reserve0 : pool.reserve1;
      const wbotReserve = usdtIsToken0 ? pool.reserve1 : pool.reserve0;
      const usdtUnits = Number(formatUnits(usdtReserve, USDT_DECIMALS));
      const wbotUnits = Number(formatUnits(wbotReserve, 18));
      if (wbotUnits <= 0 || usdtUnits <= bestUsdtReserve) continue;
      bestUsdtReserve = usdtUnits;
      wbotPriceUsd = usdtUnits / wbotUnits;
      wbotPair = { pair: pool.pair, usdtIsToken0 };
    }
    return { wbotPriceUsd, wbotPair };
  }

  /**
   * Reconstructs a USD price series for a token from the pool's `Sync` events.
   * WBOT-quoted pools are converted with the WBOT/USDT price that was live at
   * the same block, so the series stays denominated in USD throughout.
   */
  async priceHistory(token: Address, limit = 400): Promise<PricePoint[]> {
    const key = `${token.toLowerCase()}:${limit}`;
    const cached = this.priceHistories.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const snapshot = await this.snapshotMarkets();
    const market = snapshot.markets.find(
      (item) => item.token.toLowerCase() === token.toLowerCase(),
    );
    if (!market) return [];

    const quotedInUsdt =
      market.counterpart.toLowerCase() === this.network.usdt.toLowerCase();
    const [tokenSyncs, wbotSyncs] = await Promise.all([
      this.syncLogs(market.pair),
      quotedInUsdt || !snapshot.wbotPair
        ? Promise.resolve([])
        : this.syncLogs(snapshot.wbotPair.pair),
    ]);
    if (!tokenSyncs.length) return [];

    const wbotSeries = snapshot.wbotPair
      ? wbotSyncs.map((log) => {
          const usdtRaw = snapshot.wbotPair?.usdtIsToken0
            ? log.reserve0
            : log.reserve1;
          const wbotRaw = snapshot.wbotPair?.usdtIsToken0
            ? log.reserve1
            : log.reserve0;
          const wbotUnits = Number(formatUnits(wbotRaw, 18));
          return {
            blockNumber: log.blockNumber,
            price:
              wbotUnits > 0
                ? Number(formatUnits(usdtRaw, USDT_DECIMALS)) / wbotUnits
                : 0,
          };
        })
      : [];

    const recent = tokenSyncs.slice(-limit);
    const timestamps = await this.blockTimestamps([
      ...new Set(recent.map((log) => log.blockNumber)),
    ]);

    const points: PricePoint[] = [];
    for (const log of recent) {
      const tokenRaw = market.tokenIsToken0 ? log.reserve0 : log.reserve1;
      const counterpartRaw = market.tokenIsToken0 ? log.reserve1 : log.reserve0;
      const tokenUnits = Number(formatUnits(tokenRaw, market.decimals));
      const counterpartUnits = Number(
        formatUnits(counterpartRaw, market.counterpartDecimals),
      );
      if (tokenUnits <= 0 || counterpartUnits <= 0) continue;
      const counterpartUsd = quotedInUsdt
        ? 1
        : priceAtBlock(wbotSeries, log.blockNumber) || snapshot.wbotPriceUsd;
      if (counterpartUsd <= 0) continue;
      const timestamp = timestamps.get(log.blockNumber);
      if (!timestamp) continue;
      points.push({
        timestamp,
        blockNumber: Number(log.blockNumber),
        price: (counterpartUnits * counterpartUsd) / tokenUnits,
      });
    }

    const value = points.sort((left, right) => left.timestamp - right.timestamp);
    this.priceHistories.set(key, {
      expiresAt: Date.now() + PRICE_HISTORY_TTL_MS,
      value,
    });
    return value;
  }

  private async syncLogs(pair: Address) {
    const logs = await this.client.getLogs({
      address: pair,
      event: SYNC_EVENT,
      fromBlock: 0n,
      toBlock: "latest",
    });
    return logs.flatMap((log) =>
      log.args.reserve0 === undefined || log.args.reserve1 === undefined
        ? []
        : [
            {
              blockNumber: log.blockNumber ?? 0n,
              reserve0: log.args.reserve0,
              reserve1: log.args.reserve1,
            },
          ],
    );
  }

  private async blockTimestamps(blockNumbers: bigint[]) {
    const timestamps = new Map<bigint, number>();
    const blocks = await Promise.all(
      blockNumbers.map((blockNumber) =>
        this.client
          .getBlock({ blockNumber, includeTransactions: false })
          .catch(() => undefined),
      ),
    );
    for (const block of blocks) {
      if (!block) continue;
      timestamps.set(block.number, Number(block.timestamp));
    }
    return timestamps;
  }

  private async loadMetadata(tokens: Address[]) {
    const missing = [
      ...new Set(
        tokens
          .map((token) => token.toLowerCase())
          .filter((token) => !this.metadata.has(token)),
      ),
    ] as Address[];
    if (!missing.length) return;
    const results = await this.client.multicall({
      contracts: missing.flatMap((token) => [
        { address: token, abi: erc20Abi, functionName: "symbol" } as const,
        { address: token, abi: erc20Abi, functionName: "name" } as const,
        { address: token, abi: erc20Abi, functionName: "decimals" } as const,
      ]),
      allowFailure: true,
    });
    for (const [index, token] of missing.entries()) {
      const symbol = results[index * 3];
      const name = results[index * 3 + 1];
      const decimals = results[index * 3 + 2];
      if (
        symbol?.status !== "success" ||
        decimals?.status !== "success" ||
        typeof symbol.result !== "string"
      ) {
        continue;
      }
      this.metadata.set(token, {
        symbol: symbol.result,
        name:
          name?.status === "success" && typeof name.result === "string"
            ? name.result
            : symbol.result,
        decimals: Number(decimals.result),
      });
    }
  }

  async tokenMetadata(token: Address): Promise<TokenMetadata | undefined> {
    await this.loadMetadata([token]);
    return this.metadata.get(token.toLowerCase());
  }

  async price(
    wallet: string,
    _txOrigin: string,
    candidate: Candidate,
    amountInBaseUnits: string,
    slippageBps: number,
  ): Promise<Quote> {
    return this.quoteExactIn(
      wallet,
      candidate,
      amountInBaseUnits,
      slippageBps,
      this.network.usdt,
      candidate.contract as Address,
    );
  }

  async prepareBasket(
    wallet: string,
    request: ExecutionRequest,
    candidates: Candidate[],
  ) {
    const quotes: Quote[] = [];
    const swapCalls: WalletCall[] = [];
    const unavailableAssetIds: string[] = [];
    let totalIn = 0n;

    for (const selection of request.selections) {
      const candidate = candidates.find((item) => item.assetId === selection.assetId);
      if (!candidate) {
        unavailableAssetIds.push(selection.assetId);
        continue;
      }
      try {
        const quote = await this.price(
          wallet,
          wallet,
          candidate,
          selection.amountInBaseUnits,
          request.slippageBps,
        );
        quotes.push(quote);
        totalIn += BigInt(selection.amountInBaseUnits);
        swapCalls.push(this.swapCall(wallet, quote, candidate.assetId));
      } catch {
        unavailableAssetIds.push(selection.assetId);
      }
    }

    if (!quotes.length) {
      throw new ExecutionProviderError(
        "BDEX",
        "INSUFFICIENT_LIQUIDITY",
        "BDEX has no executable route for this basket.",
      );
    }

    const allowance = await this.client.readContract({
      address: this.network.usdt,
      abi: erc20Abi,
      functionName: "allowance",
      args: [wallet as Address, this.network.v2Router],
    });

    const walletCalls: WalletCall[] = [];
    if (allowance < totalIn) {
      walletCalls.push(
        ...this.approvalCalls(wallet, this.network.usdt, allowance),
      );
    }
    walletCalls.push(...swapCalls);
    return { quotes, walletCalls, unavailableAssetIds };
  }

  async prepareExit(
    wallet: string,
    candidate: Candidate,
    amountInBaseUnits: string,
    slippageBps: number,
  ) {
    const quote = await this.quoteExactIn(
      wallet,
      candidate,
      amountInBaseUnits,
      slippageBps,
      candidate.contract as Address,
      this.network.usdt,
    );
    const allowance = await this.client.readContract({
      address: candidate.contract as Address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [wallet as Address, this.network.v2Router],
    });
    const walletCalls: WalletCall[] = [];
    if (allowance < BigInt(amountInBaseUnits)) {
      walletCalls.push(
        ...this.approvalCalls(wallet, candidate.contract as Address, allowance),
      );
    }
    walletCalls.push(this.swapCall(wallet, quote, candidate.assetId));
    return { quote, walletCalls };
  }

  async health() {
    try {
      const length = await this.client.readContract({
        address: this.network.v2Factory,
        abi: V2_FACTORY_ABI,
        functionName: "allPairsLength",
      });
      return {
        available: length > 0n,
        status: length > 0n ? ("CONFIGURED" as const) : ("UNAVAILABLE" as const),
      };
    } catch {
      return { available: false, status: "UNAVAILABLE" as const };
    }
  }

  async tokenBalance(wallet: Address, token: Address) {
    return this.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet],
    });
  }

  async tokenBalances(wallet: Address, tokens: Address[]) {
    if (!tokens.length) return new Map<string, bigint>();
    const results = await this.client.multicall({
      contracts: tokens.map((token) => ({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [wallet],
      })),
      allowFailure: true,
    });
    const balances = new Map<string, bigint>();
    for (const [index, token] of tokens.entries()) {
      const result = results[index];
      if (result?.status !== "success") continue;
      balances.set(token.toLowerCase(), result.result as bigint);
    }
    return balances;
  }

  async nativeBalance(wallet: Address) {
    return this.client.getBalance({ address: wallet });
  }

  async receiptTransfers(hash: Hex, wallet: Address) {
    const receipt = await this.client.getTransactionReceipt({ hash });
    const transfers: Array<{ token: Address; amount: bigint }> = [];
    const transferTopic =
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    for (const log of receipt.logs) {
      if (log.topics[0]?.toLowerCase() !== transferTopic) continue;
      const to = log.topics[2];
      if (!to?.toLowerCase().endsWith(wallet.slice(2).toLowerCase())) continue;
      transfers.push({ token: log.address, amount: BigInt(log.data) });
    }
    return {
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      transfers,
    };
  }

  private async quoteExactIn(
    wallet: string,
    candidate: Candidate,
    amountInBaseUnits: string,
    slippageBps: number,
    tokenIn: Address,
    tokenOut: Address,
  ): Promise<Quote> {
    if (!isAddress(wallet) || !isAddress(tokenOut) || !isAddress(tokenIn)) {
      throw new ExecutionProviderError("BDEX", "INVALID_TOKEN", "Invalid swap tokens.");
    }
    const amountIn = BigInt(amountInBaseUnits);
    if (amountIn <= 0n) {
      throw new ExecutionProviderError(
        "BDEX",
        "INVALID_TRANSACTION",
        "Amount must be positive.",
      );
    }
    const paths = this.candidatePaths(tokenIn, tokenOut);
    const results = await this.client.multicall({
      contracts: paths.map((path) => ({
        address: this.network.v2Router,
        abi: V2_ROUTER_ABI,
        functionName: "getAmountsOut" as const,
        args: [amountIn, path],
      })),
      allowFailure: true,
    });

    let best: { path: Address[]; amounts: readonly bigint[] } | undefined;
    for (const [index, result] of results.entries()) {
      if (result.status !== "success") continue;
      const amounts = result.result as readonly bigint[];
      const path = paths[index];
      if (!path) continue;
      const out = amounts[amounts.length - 1] ?? 0n;
      if (out <= 0n) continue;
      if (!best || out > (best.amounts[best.amounts.length - 1] ?? 0n)) {
        best = { path, amounts };
      }
    }

    const out = best?.amounts[best.amounts.length - 1] ?? 0n;
    if (!best || out === 0n) {
      throw new ExecutionProviderError(
        "BDEX",
        "INSUFFICIENT_LIQUIDITY",
        `No BDEX liquidity for ${candidate.symbol}.`,
      );
    }

    const minimumAmountOut = out - (out * BigInt(slippageBps)) / 10_000n;
    const now = new Date();
    const sellingStable =
      tokenIn.toLowerCase() === this.network.usdt.toLowerCase();
    const inUnits = Number(
      formatUnits(amountIn, sellingStable ? USDT_DECIMALS : candidate.decimals),
    );
    const outUnits = Number(
      formatUnits(out, sellingStable ? candidate.decimals : USDT_DECIMALS),
    );
    const unitPriceUsd = sellingStable
      ? outUnits > 0
        ? inUnits / outUnits
        : 0
      : inUnits > 0
        ? outUnits / inUnits
        : 0;
    const priceImpactBps = this.priceImpactBps(
      unitPriceUsd,
      candidate.marketPriceUsd,
    );

    return {
      requestId: `${candidate.assetId}:${now.toISOString()}`,
      provider: "BDEX",
      chain: "BOTCHAIN",
      assetId: candidate.assetId || botAssetId(this.network.chainId, tokenOut),
      tokenOut,
      amountInBaseUnits,
      estimatedAmountOut: out.toString(),
      minimumAmountOut: minimumAmountOut.toString(),
      unitPriceUsd: unitPriceUsd > 0 ? unitPriceUsd.toFixed(12) : "0",
      priceImpactBps,
      routing: "BDEX_V2",
      path: best.path,
      quotedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + QUOTE_TTL_SECONDS * 1000).toISOString(),
      providerEvidence: {
        router: this.network.v2Router,
        factory: this.network.v2Factory,
        hops: String(best.path.length - 1),
      },
    };
  }

  /** Execution price versus the pool mid price, expressed in basis points. */
  private priceImpactBps(executionPriceUsd: number, midPriceUsd?: number) {
    if (!midPriceUsd || midPriceUsd <= 0 || executionPriceUsd <= 0) return 0;
    const impact = Math.abs(executionPriceUsd - midPriceUsd) / midPriceUsd;
    return Math.min(10_000, Math.round(impact * 10_000));
  }

  private candidatePaths(tokenIn: Address, tokenOut: Address): Address[][] {
    const paths: Address[][] = [[tokenIn, tokenOut]];
    const lowerIn = tokenIn.toLowerCase();
    const lowerOut = tokenOut.toLowerCase();
    for (const hop of [this.network.wbot, this.network.usdt]) {
      const lowerHop = hop.toLowerCase();
      if (lowerHop === lowerIn || lowerHop === lowerOut) continue;
      paths.push([tokenIn, hop, tokenOut]);
    }
    return paths;
  }

  /**
   * Tokens such as USDT revert on a non-zero to non-zero approve, so an existing
   * allowance is cleared before the new one is granted.
   */
  private approvalCalls(
    wallet: string,
    token: Address,
    currentAllowance: bigint,
  ): WalletCall[] {
    const approve = (amount: bigint, kind: WalletCall["kind"]): WalletCall => ({
      kind,
      transaction: {
        to: token,
        from: wallet,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [this.network.v2Router, amount],
        }),
        value: "0",
        chainId: this.network.chainId,
      },
    });
    return currentAllowance > 0n
      ? [approve(0n, "CANCEL_APPROVAL"), approve(maxUint256, "APPROVAL")]
      : [approve(maxUint256, "APPROVAL")];
  }

  private swapCall(wallet: string, quote: Quote, assetId: string): WalletCall {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    return {
      kind: "SWAP",
      assetId,
      transaction: {
        to: this.network.v2Router,
        from: wallet,
        data: encodeFunctionData({
          abi: V2_ROUTER_ABI,
          functionName: "swapExactTokensForTokens",
          args: [
            BigInt(quote.amountInBaseUnits),
            BigInt(quote.minimumAmountOut),
            quote.path as Address[],
            wallet as Address,
            deadline,
          ],
        }),
        value: "0",
        chainId: this.network.chainId,
      },
    };
  }
}

/** Last known price at or before `blockNumber` in an ascending series. */
function priceAtBlock(
  series: Array<{ blockNumber: bigint; price: number }>,
  blockNumber: bigint,
) {
  let price = 0;
  for (const point of series) {
    if (point.blockNumber > blockNumber) break;
    if (point.price > 0) price = point.price;
  }
  return price;
}
