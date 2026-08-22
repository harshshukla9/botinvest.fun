import { getAddress, toHex } from "viem";
import type { PublicConfig } from "./api";

export type EthereumProvider = {
  isMetaMask?: boolean;
  isBraveWallet?: boolean;
  isPhantom?: boolean;
  providers?: EthereumProvider[];
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
};

export function getMetaMaskProvider(): EthereumProvider | undefined {
  if (typeof window === "undefined") return;
  const ethereum = window.ethereum as EthereumProvider | undefined;
  if (!ethereum) return;

  const announced = ethereum.providers?.filter(Boolean) ?? [];
  const fromList = announced.find(isMetaMaskProvider);
  if (fromList) return fromList;
  if (isMetaMaskProvider(ethereum)) return ethereum;
  return announced[0] ?? ethereum;
}

function isMetaMaskProvider(provider: EthereumProvider) {
  return Boolean(
    provider.isMetaMask && !provider.isBraveWallet && !provider.isPhantom,
  );
}

export function metamaskInstallUrl() {
  return "https://metamask.io/download/";
}

export async function connectMetaMask(config: PublicConfig) {
  const provider = getMetaMaskProvider();
  if (!provider) {
    throw new Error(
      "MetaMask was not found. Install the extension and refresh this page.",
    );
  }

  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
    throw new Error("MetaMask did not return an account.");
  }
  const address = getAddress(accounts[0]);
  await ensureBotChain(provider, config);
  return { provider, address };
}

export async function ensureBotChain(
  provider: EthereumProvider,
  config: PublicConfig,
) {
  const chainIdHex = `0x${config.chainId.toString(16)}`;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
    return;
  } catch (error) {
    const code = providerErrorCode(error);
    if (code === 4001) {
      throw new Error("You rejected the BOT Chain switch in MetaMask.");
    }
    if (code !== 4902 && code !== -32603 && code !== -32002) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/unrecognized chain|unknown chain|addEthereumChain/i.test(message)) {
        throw new Error(
          readableWalletError(error, "Could not switch MetaMask to BOT Chain."),
        );
      }
    }
  }

  await provider.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: chainIdHex,
        chainName: config.chainName,
        nativeCurrency: config.nativeCurrency,
        rpcUrls: [config.rpcUrl],
        blockExplorerUrls: [config.explorerUrl],
      },
    ],
  });
  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: chainIdHex }],
  });
}

export async function personalSign(
  provider: EthereumProvider,
  address: string,
  message: string,
) {
  const signature = await provider.request({
    method: "personal_sign",
    params: [toHex(message), address],
  });
  if (typeof signature !== "string") {
    throw new Error("MetaMask did not return a signature.");
  }
  return signature;
}

export function readableWalletError(error: unknown, fallback: string) {
  const code = providerErrorCode(error);
  if (code === 4001) return "You rejected the request in MetaMask.";
  if (code === -32002) {
    return "MetaMask already has a pending request. Open the extension and approve it.";
  }
  const message = error instanceof Error ? error.message : "";
  if (/user rejected|denied|rejected the request/i.test(message)) {
    return "You rejected the request in MetaMask.";
  }
  if (/Provider not found|does not exist/i.test(message)) {
    return "MetaMask was not found. Install the extension and refresh this page.";
  }
  return message || fallback;
}

function providerErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return;
  const record = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof record.code === "number") return record.code;
  if (typeof record.cause?.code === "number") return record.cause.code;
}
