import { useEffect, useState } from "react";
import { formatUnits, type Hex } from "viem";
import { useSendTransaction } from "wagmi";
import { api, type PortfolioHolding, type PublicConfig } from "../api";
import { AssetMark } from "./AssetMark";

export function PositionsScreen({
  wallet,
  config,
}: {
  wallet: string;
  config: PublicConfig;
}) {
  const { sendTransactionAsync } = useSendTransaction();
  const [holdings, setHoldings] = useState<PortfolioHolding[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .portfolio(wallet)
      .then((result) => {
        if (!cancelled) setHoldings(result.holdings);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not load portfolio.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  async function exitPosition(holding: PortfolioHolding) {
    setBusyId(holding.assetId);
    setError("");
    try {
      const prepared = await api.prepareExit({
        assetId: holding.assetId,
        amountInBaseUnits: holding.balanceBaseUnits,
        slippageBps: 50,
      });
      const hashes: Hex[] = [];
      for (const call of prepared.walletCalls) {
        hashes.push(
          await sendTransactionAsync({
            to: call.transaction.to as `0x${string}`,
            data: call.transaction.data as Hex,
            value: BigInt(call.transaction.value),
            chainId: call.transaction.chainId,
          }),
        );
      }
      void hashes;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Exit failed.");
    } finally {
      setBusyId("");
    }
  }

  const value = holdings.reduce((sum, holding) => sum + (holding.valueUsd ?? 0), 0);

  return (
    <section className="positions-screen">
      <span className="account-label">Indexed from BDEX balances · priced by Lumora</span>
      <h1>${value.toFixed(2)}</h1>
      {error ? <p className="send-error">{error}</p> : null}
      <ul>
        {holdings.map((holding) => (
          <li key={holding.assetId}>
            <AssetMark symbol={holding.symbol} iconUrl={holding.iconUrl} />
            <div>
              <strong>{holding.symbol}</strong>
              <small>
                {formatUnits(BigInt(holding.balanceBaseUnits), holding.decimals)} ·{" "}
                {holding.lumoraFeedId ?? "BDEX"}
              </small>
            </div>
            <button
              type="button"
              className="button button-outline"
              disabled={busyId === holding.assetId}
              onClick={() => void exitPosition(holding)}
            >
              {busyId === holding.assetId ? "Check MetaMask…" : "Exit to USDT"}
            </button>
          </li>
        ))}
      </ul>
      {!holdings.length ? <p>No BDEX token balances in this MetaMask wallet yet.</p> : null}
      <p>
        Explorer: <a href={`${config.explorerUrl}/address/${wallet}`}>{config.chainName}</a>
      </p>
    </section>
  );
}
