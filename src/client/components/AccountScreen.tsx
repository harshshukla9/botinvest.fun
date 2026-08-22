import type { OnboardingPreferences } from "../../domain/schemas";
import type { PublicConfig } from "../api";

export function AccountScreen({
  wallet,
  preferences,
  config,
}: {
  wallet: string;
  preferences?: OnboardingPreferences;
  config: PublicConfig;
}) {
  return (
    <section className="account-screen">
      <span className="account-label">Account</span>
      <h1>MetaMask on {config.chainName}</h1>
      <ul className="review-ledger">
        <li><span>Wallet</span><code>{wallet}</code></li>
        <li><span>Chain ID</span><strong>{config.chainId}</strong></li>
        <li><span>USDT</span><code>{config.usdt}</code></li>
        <li><span>Lumora consumer</span><code>{config.lumora.consumer}</code></li>
        <li><span>Cadence</span><strong>{preferences?.cadence ?? "—"}</strong></li>
        <li><span>Ticket</span><strong>{preferences ? `$${preferences.ticketSizeUsd}` : "—"}</strong></li>
      </ul>
      <p>
        Prices come from{" "}
        <a href="https://lumora-oracle.vercel.app/docs" target="_blank" rel="noreferrer">
          Lumora
        </a>
        . Swaps go through BDEX. Signing stays in MetaMask.
      </p>
    </section>
  );
}
