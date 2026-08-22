import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { defineChain } from "viem";
import {
  BOT_MAINNET_CHAIN_ID,
  BOT_NETWORKS,
  BOT_TESTNET_CHAIN_ID,
  type BotNetwork,
} from "../domain/constants";

export function botChain(network: BotNetwork) {
  return defineChain({
    id: network.chainId,
    name: network.name === "mainnet" ? "BOT Chain" : "BOT Testnet",
    nativeCurrency: network.nativeCurrency,
    rpcUrls: {
      default: { http: [network.rpcUrl] },
    },
    blockExplorers: {
      default: { name: "BOT Scan", url: network.explorerUrl },
    },
  });
}

export function createWagmiConfig(network: BotNetwork) {
  const chain = botChain(network);
  return createConfig({
    chains: [chain],
    connectors: [
      injected({
        shimDisconnect: true,
        target: "metaMask",
      }),
    ],
    transports: {
      [BOT_MAINNET_CHAIN_ID]: http(network.rpcUrl),
      [BOT_TESTNET_CHAIN_ID]: http(network.rpcUrl),
    },
  });
}

export function metamaskAddChainParams(network: BotNetwork) {
  return {
    chainId: `0x${network.chainId.toString(16)}`,
    chainName: network.name === "mainnet" ? "BOT Chain" : "BOT Testnet",
    nativeCurrency: network.nativeCurrency,
    rpcUrls: [network.rpcUrl],
    blockExplorerUrls: [network.explorerUrl],
  };
}

export const defaultNetwork = BOT_NETWORKS.testnet;
