import { keccak256, toBytes, type Address, type Hex } from "viem";

export const POLICY_VERSION = "botinvest-policy/v1";
export const FEED_PAGE_SIZE = 10;
export const AI_RANKING_POOL_SIZE = 60;
export const MAX_SLIPPAGE_BPS = 50;
export const MAX_PRICE_IMPACT_BPS = 100;
export const MAX_DEGEN_PRICE_IMPACT_BPS = 1_000;
export const QUOTE_TTL_SECONDS = 60;
export const LUMORA_MAX_STALENESS_SECONDS = 900;
export const USDT_DECIMALS = 6;
export const PERIOD_BUDGET = 100_000_000n;
export const DEFAULT_SLOT_BUDGET = 10_000_000n;

export const BOT_MAINNET_CHAIN_ID = 677;
export const BOT_TESTNET_CHAIN_ID = 968;

export type BotNetworkName = "mainnet" | "testnet";

export interface BotNetwork {
  name: BotNetworkName;
  chainId: typeof BOT_MAINNET_CHAIN_ID | typeof BOT_TESTNET_CHAIN_ID;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  usdt: Address;
  wbot: Address;
  multicall3: Address;
  permit2: Address;
  universalRouter: Address;
  v2Factory: Address;
  v2Router: Address;
  v2PairInitCodeHash: Hex;
  v3Factory: Address;
  v3SwapRouter: Address;
  v3Quoter: Address;
  lumoraOracle: Address;
  lumoraConsumer: Address;
}

export const BOT_NETWORKS: Record<BotNetworkName, BotNetwork> = {
  mainnet: {
    name: "mainnet",
    chainId: BOT_MAINNET_CHAIN_ID,
    rpcUrl: "https://rpc.botchain.ai",
    explorerUrl: "https://scan.botchain.ai",
    nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
    usdt: "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C",
    wbot: "0xD5452816194a3784dBa983426cCe7c122F4abd30",
    multicall3: "0x47FA21f684bBAD707A53a0f9BE59F1422F46C265",
    permit2: "0x8366170f09a04f715a13549D616a06aED16Db7c3",
    universalRouter: "0xaE6ae8630f7A888dEc0B9195C85F7515d5887655",
    v2Factory: "0x117115f3B72C8d1989178089A67D0C26f8EE0AA3",
    v2Router: "0x1414eD29FdFD322c3c0a830330ed982E2D629e76",
    v2PairInitCodeHash:
      "0xa075aa7c03cb5559a4c6202459721232c21e18148152410f6beec063e8499e6c",
    v3Factory: "0x1C51c173323ec11BB4e3C4fD2314c225Dc4b5419",
    v3SwapRouter: "0x07032d47A1b9f8460cBeE9dC17c1d3E438693929",
    v3Quoter: "0x034A705b36067cff99ABf5C662Be881cBd8d0176",
    lumoraOracle: "0x90Dfd581393104EAe03Fd349b4867A7E8F51313b",
    lumoraConsumer: "0x5E6658ac6cBC9b0109C28BED00bC4Af0F0A3f1CD",
  },
  testnet: {
    name: "testnet",
    chainId: BOT_TESTNET_CHAIN_ID,
    rpcUrl: "https://rpc.bohr.life",
    explorerUrl: "https://scan.bohr.life",
    nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
    usdt: "0x75edC9335175Fc0552D51D48439F229c10420fe3",
    wbot: "0xD5452816194a3784dBa983426cCe7c122F4abd30",
    multicall3: "0x47FA21f684bBAD707A53a0f9BE59F1422F46C265",
    permit2: "0xaE85b2bc7578F8Ca9217900a2D548151F96447de",
    universalRouter: "0x73Be0A1d8011B335A7aBeF6c45544E8ca4448AB5",
    v2Factory: "0x65b8e98ceA190d8c28B3e4716402027f634d15a3",
    v2Router: "0xD6425a02f0845B8D99e349C34D2E7A576E177345",
    v2PairInitCodeHash:
      "0x9d2cc5d1f5560e2a4119c794e0fa625b8c50af562e72436c234ec1addb77de47",
    v3Factory: "0x1C51c173323ec11BB4e3C4fD2314c225Dc4b5419",
    v3SwapRouter: "0x07032d47A1b9f8460cBeE9dC17c1d3E438693929",
    v3Quoter: "0x034A705b36067cff99ABf5C662Be881cBd8d0176",
    lumoraOracle: "0x90Dfd581393104EAe03Fd349b4867A7E8F51313b",
    lumoraConsumer: "0x5E6658ac6cBC9b0109C28BED00bC4Af0F0A3f1CD",
  },
};

export const LUMORA_API_BASE = "https://lumora-oracle.vercel.app";

export const LUMORA_CONSUMER_ABI = [
  {
    type: "function",
    name: "getPrice",
    stateMutability: "view",
    inputs: [{ name: "assetId", type: "bytes32" }],
    outputs: [
      { name: "id", type: "uint256" },
      { name: "price", type: "uint256" },
      { name: "timestamp", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "maxStaleness",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export function lumoraAssetId(feedId: string): Hex {
  return keccak256(toBytes(feedId));
}

export function botAssetId(chainId: number, token: string) {
  return `bot:${chainId}:${token.toLowerCase()}`;
}

export function explorerAddressUrl(network: BotNetwork, address: string) {
  return `${network.explorerUrl}/address/${address}`;
}

export function explorerTxUrl(network: BotNetwork, hash: string) {
  return `${network.explorerUrl}/tx/${hash}`;
}
