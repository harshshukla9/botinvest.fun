import { defineChain, type Chain } from "viem";
import type { BotNetwork } from "../domain/constants.js";

/**
 * BOT Chain is not in viem's chain registry, so it is built from the network
 * config. Wiring multicall3 in lets viem batch the hundreds of eth_calls that
 * pair discovery needs into a handful of requests.
 */
export function botViemChain(network: BotNetwork): Chain {
  return defineChain({
    id: network.chainId,
    name: network.name === "mainnet" ? "BOT Chain" : "BOT Testnet",
    nativeCurrency: network.nativeCurrency,
    rpcUrls: { default: { http: [network.rpcUrl] } },
    blockExplorers: {
      default: {
        name: network.name === "mainnet" ? "BOT Scan" : "Bohr Scan",
        url: network.explorerUrl,
      },
    },
    contracts: {
      multicall3: { address: network.multicall3 },
    },
    testnet: network.name === "testnet",
  });
}
