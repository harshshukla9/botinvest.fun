import type { Candidate } from "../../domain/schemas";
import type { ExecutionRecord, PublicConfig } from "../api";
import { AssetMark } from "./AssetMark";

export function ReceiptScreen({
  settlement,
  candidates,
  config,
}: {
  settlement?: ExecutionRecord;
  candidates: Candidate[];
  config: PublicConfig;
}) {
  if (!settlement) {
    return (
      <section className="receipt-ledger">
        <h1>Activity</h1>
        <p>No signed baskets yet. Swipe a feed and confirm in MetaMask.</p>
      </section>
    );
  }
  return (
    <section className="receipt-ledger">
      <span className="account-label">{settlement.status} · BDEX</span>
      <h1>Basket {settlement.status.toLowerCase()}</h1>
      <ul>
        {settlement.plan.quotes.map((quote) => {
          const candidate = candidates.find((item) => item.assetId === quote.assetId);
          return (
            <li key={quote.assetId}>
              <AssetMark symbol={candidate?.symbol ?? "?"} iconUrl={candidate?.iconUrl} />
              <div>
                <strong>{candidate?.symbol ?? quote.assetId}</strong>
                <small>{quote.routing}</small>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="receipt-proof">
        {settlement.transactionHashes.map((hash) => (
          <a key={hash} href={`${config.explorerUrl}/tx/${hash}`} target="_blank" rel="noreferrer">
            {hash.slice(0, 10)}…{hash.slice(-6)}
          </a>
        ))}
      </div>
    </section>
  );
}
