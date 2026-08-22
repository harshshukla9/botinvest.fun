import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  isAddress,
  maxUint256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { botAssetId, QUOTE_TTL_SECONDS, type BotNetwork } from "../../domain/constants.js";
import type { Candidate, ExecutionRequest, Quote } from "../../domain/schemas.js";
import { ExecutionProviderError, type ExecutionProvider, type WalletCall } from "./types.js";

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

const ERC20_META_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

export interface BdexMarket {
  token: Address;
  symbol: string;
  name: string;
  decimals: number;
  pair: Address;
  reserveUsd: number;
  counterpart: Address;
}

export class BdexProvider implements ExecutionProvider {
  readonly id = "BDEX" as const;
  readonly label = "BDEX";
  private readonly client: PublicClient;
  private markets:
    | {
        expiresAt: number;
        items: BdexMarket[];
      }
    | undefined;

  constructor(private readonly network: BotNetwork) {
    this.client = createPublicClient({
      transport: http(network.rpcUrl),
    });
  }

  async listMarkets(force = false): Promise<BdexMarket[]> {
    if (!force && this.markets && this.markets.expiresAt > Date.now()) {
      return this.markets.items;
    }
    const length = await this.client.readContract({
      address: this.network.v2Factory,
      abi: V2_FACTORY_ABI,
      functionName: "allPairsLength",
    });
    const pairIndexes = Array.from(
      { length: Number(length > 80n ? 80n : length) },
      (_, index) => BigInt(index),
    );
    const pairs = (
      await Promise.all(
        pairIndexes.map((index) =>
          this.client.readContract({
            address: this.network.v2Factory,
            abi: V2_FACTORY_ABI,
            functionName: "allPairs",
            args: [index],
          }),
        ),
      )
    ).filter((pair) => pair !== "0x0000000000000000000000000000000000000000");

    const pairState = await Promise.all(
      pairs.map(async (pair) => {
        const [token0, token1, reserves] = await Promise.all([
          this.client.readContract({
            address: pair,
            abi: V2_PAIR_ABI,
            functionName: "token0",
          }),
          this.client.readContract({
            address: pair,
            abi: V2_PAIR_ABI,
            functionName: "token1",
          }),
          this.client.readContract({
            address: pair,
            abi: V2_PAIR_ABI,
            functionName: "getReserves",
          }),
        ]);
        return { pair, token0, token1, reserves };
      }),
    );

    const quoteTokens = new Set([
      this.network.usdt.toLowerCase(),
      this.network.wbot.toLowerCase(),
    ]);
    const tokenAddresses = [
      ...new Set(
        pairState.flatMap(({ token0, token1 }) => [token0, token1]),
      ),
    ];
    const metadata = new Map<string, { symbol: string; name: string; decimals: number }>();
    await Promise.all(
      tokenAddresses.map(async (token) => {
        try {
          const [symbol, name, decimals] = await Promise.all([
            this.client.readContract({
              address: token,
              abi: ERC20_META_ABI,
              functionName: "symbol",
            }),
            this.client.readContract({
              address: token,
              abi: ERC20_META_ABI,
              functionName: "name",
            }),
            this.client.readContract({
              address: token,
              abi: ERC20_META_ABI,
              functionName: "decimals",
            }),
          ]);
          metadata.set(token.toLowerCase(), {
            symbol,
            name,
            decimals: Number(decimals),
          });
        } catch {
          metadata.set(token.toLowerCase(), {
            symbol: token.slice(2, 6).toUpperCase(),
            name: token,
            decimals: 18,
          });
        }
      }),
    );

    const items: BdexMarket[] = [];
    for (const { pair, token0, token1, reserves } of pairState) {
      const sides = [
        { token: token0, reserve: reserves[0], other: token1, otherReserve: reserves[1] },
        { token: token1, reserve: reserves[1], other: token0, otherReserve: reserves[0] },
      ];
      for (const side of sides) {
        if (!quoteTokens.has(side.other.toLowerCase())) continue;
        if (side.token.toLowerCase() === this.network.usdt.toLowerCase()) continue;
        const meta = metadata.get(side.token.toLowerCase());
        const quoteMeta = metadata.get(side.other.toLowerCase());
        if (!meta || !quoteMeta) continue;
        const quoteReserve = Number(formatUnits(side.otherReserve, quoteMeta.decimals));
        const reserveUsd =
          side.other.toLowerCase() === this.network.usdt.toLowerCase()
            ? quoteReserve
            : 0;
        items.push({
          token: side.token,
          symbol: meta.symbol,
          name: meta.name,
          decimals: meta.decimals,
          pair,
          reserveUsd,
          counterpart: side.other,
        });
      }
    }

    const unique = new Map<string, BdexMarket>();
    for (const item of items.sort((left, right) => right.reserveUsd - left.reserveUsd)) {
      if (!unique.has(item.token.toLowerCase())) {
        unique.set(item.token.toLowerCase(), item);
      }
    }
    const next = [...unique.values()];
    this.markets = { expiresAt: Date.now() + 60_000, items: next };
    return next;
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
        swapCalls.push(
          this.swapCall(
            wallet,
            quote,
            candidate.assetId,
          ),
        );
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
      walletCalls.push({
        kind: "APPROVAL",
        transaction: {
          to: this.network.usdt,
          from: wallet,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [this.network.v2Router, maxUint256],
          }),
          value: "0",
          chainId: this.network.chainId,
        },
      });
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
      walletCalls.push({
        kind: "APPROVAL",
        transaction: {
          to: candidate.contract,
          from: wallet,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [this.network.v2Router, maxUint256],
          }),
          value: "0",
          chainId: this.network.chainId,
        },
      });
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
      if (!to || !to.toLowerCase().endsWith(wallet.slice(2).toLowerCase())) continue;
      transfers.push({
        token: log.address,
        amount: BigInt(log.data),
      });
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
    if (!isAddress(wallet) || !isAddress(tokenOut)) {
      throw new ExecutionProviderError("BDEX", "INVALID_TOKEN", "Invalid swap tokens.");
    }
    const amountIn = BigInt(amountInBaseUnits);
    if (amountIn <= 0n) {
      throw new ExecutionProviderError("BDEX", "INVALID_TRANSACTION", "Amount must be positive.");
    }
    const paths = this.candidatePaths(tokenIn, tokenOut);
    let best:
      | {
          path: Address[];
          amounts: readonly bigint[];
        }
      | undefined;
    for (const path of paths) {
      try {
        const amounts = await this.client.readContract({
          address: this.network.v2Router,
          abi: V2_ROUTER_ABI,
          functionName: "getAmountsOut",
          args: [amountIn, path],
        });
        const out = amounts[amounts.length - 1] ?? 0n;
        if (!best || out > (best.amounts[best.amounts.length - 1] ?? 0n)) {
          best = { path, amounts };
        }
      } catch {
        continue;
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
    const unitPriceUsd =
      tokenIn.toLowerCase() === this.network.usdt.toLowerCase()
        ? (Number(amountIn) / 10 ** 6 / (Number(out) / 10 ** candidate.decimals)).toString()
        : candidate.marketPriceUsd?.toString() ?? "0";
    return {
      requestId: `${candidate.assetId}:${now.toISOString()}`,
      provider: "BDEX",
      chain: "BOTCHAIN",
      assetId: candidate.assetId || botAssetId(this.network.chainId, tokenOut),
      tokenOut,
      amountInBaseUnits,
      estimatedAmountOut: out.toString(),
      minimumAmountOut: minimumAmountOut.toString(),
      unitPriceUsd,
      priceImpactBps: 30,
      routing: "BDEX_V2",
      path: best.path,
      quotedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + QUOTE_TTL_SECONDS * 1000).toISOString(),
      providerEvidence: {
        router: this.network.v2Router,
        factory: this.network.v2Factory,
      },
    };
  }

  private candidatePaths(tokenIn: Address, tokenOut: Address): Address[][] {
    const paths: Address[][] = [[tokenIn, tokenOut]];
    if (
      tokenIn.toLowerCase() !== this.network.wbot.toLowerCase() &&
      tokenOut.toLowerCase() !== this.network.wbot.toLowerCase()
    ) {
      paths.push([tokenIn, this.network.wbot, tokenOut]);
    }
    if (
      tokenIn.toLowerCase() !== this.network.usdt.toLowerCase() &&
      tokenOut.toLowerCase() !== this.network.usdt.toLowerCase()
    ) {
      paths.push([tokenIn, this.network.usdt, tokenOut]);
    }
    return paths;
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
