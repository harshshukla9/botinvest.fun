import { useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { Check, ChevronDown, Copy, ExternalLink, LogOut, Wallet } from "lucide-react";
import { Popover } from "radix-ui";
import type { PublicConfig } from "../api";
import { ChainMark } from "./ChainMark";

export function WalletMenu({
  wallet,
  config,
  onDisconnect,
}: {
  wallet: string;
  config: PublicConfig;
  onDisconnect: () => void;
}) {
  const { disconnectAsync } = useDisconnect();
  const { address } = useAccount();
  const [copied, setCopied] = useState(false);
  const display = address ?? wallet;

  async function copyWallet() {
    await navigator.clipboard.writeText(display);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  async function logout() {
    await disconnectAsync().catch(() => undefined);
    onDisconnect();
  }

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="wallet-menu-trigger" aria-label="Open wallet menu">
          <Wallet aria-hidden="true" />
          {shortAddress(display)}
          <ChevronDown className="wallet-menu-chevron" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="wallet-menu-content" sideOffset={8} align="end">
          <div className="wallet-menu-heading">
            <span>MetaMask · {config.chainName}</span>
            <strong>{shortAddress(display)}</strong>
          </div>
          <div className="wallet-chain-selector">
            <button type="button" className="active">
              <ChainMark />
              <span>{config.chainName}</span>
            </button>
          </div>
          <a
            className="wallet-menu-action primary"
            href={`${config.explorerUrl}/address/${display}`}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink aria-hidden="true" />
            View on BOT Scan
          </a>
          <button type="button" className="wallet-menu-action" onClick={() => void copyWallet()}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? "Address copied" : "Copy address"}
          </button>
          <div className="wallet-menu-separator" />
          <button type="button" className="wallet-menu-action danger" onClick={() => void logout()}>
            <LogOut aria-hidden="true" />
            Disconnect
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function shortAddress(address: string) {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
