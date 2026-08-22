import { type ReactNode, useEffect } from "react";
import { Wallet } from "lucide-react";
import type { PublicConfig } from "../api";
import { WalletMenu } from "./WalletMenu";

interface Props {
  active: "week" | "positions" | "receipts" | "account";
  onNavigate: (target: Props["active"]) => void;
  wallet?: string;
  onWallet?: () => void;
  walletReady?: boolean;
  navigationEnabled?: boolean;
  config: PublicConfig;
  onDisconnect: () => void;
  children: ReactNode;
}

export function AppShell({
  active,
  onNavigate,
  wallet,
  onWallet,
  walletReady = true,
  navigationEnabled = true,
  config,
  onDisconnect,
  children,
}: Props) {
  useEffect(() => {
    document.documentElement.dataset.chain = "botchain";
  }, []);

  return (
    <div className="app-shell">
      <header className={navigationEnabled ? "topbar" : "topbar topbar-onboarding"}>
        <button
          type="button"
          className="brand"
          onClick={() => onNavigate("week")}
          aria-label="botinvest home"
        >
          bot<span>invest</span>
        </button>
        {navigationEnabled ? (
          <nav aria-label="Primary navigation">
            {(
              [
                ["week", "Basket"],
                ["positions", "Portfolio"],
                ["receipts", "Activity"],
                ["account", "Account"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={active === id ? "active" : ""}
                onClick={() => onNavigate(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        ) : null}
        {wallet && walletReady ? (
          <WalletMenu wallet={wallet} config={config} onDisconnect={onDisconnect} />
        ) : (
          <button type="button" className="wallet-menu-trigger" onClick={onWallet}>
            <Wallet aria-hidden="true" />
            Connect MetaMask
          </button>
        )}
      </header>
      {children}
    </div>
  );
}
