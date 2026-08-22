import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatUnits, type Hex } from "viem";
import { useSendTransaction } from "wagmi";
import type { Candidate } from "../../domain/schemas";
import { formatTicketSizeUsd, ticketSizeToBaseUnits } from "../../domain/schemas";
import {
  ApiError,
  api,
  type ExecutionRecord,
  type FeedResponse,
  type PublicConfig,
  type WeeklySession,
} from "../api";
import { executionMatchesReviewBasket, reviewBasketKey } from "../review-safety";
import { AssetMark } from "./AssetMark";
import { ArrowRight, Check, Close, Shield } from "./Icons";

export function ReviewScreen({
  session,
  feed,
  selected,
  onRemove,
  onBack,
  onSettled,
  onExecutionChange,
  wallet,
  config,
}: {
  session: WeeklySession;
  feed: FeedResponse;
  selected: Candidate[];
  onRemove: (assetId: string) => void;
  onBack: () => void;
  onSettled: (record: ExecutionRecord) => void;
  onExecutionChange: (record: ExecutionRecord) => void;
  wallet: string;
  config: PublicConfig;
}) {
  const { sendTransactionAsync } = useSendTransaction();
  const [record, setRecord] = useState<ExecutionRecord>();
  const [phase, setPhase] = useState<"refreshing" | "signing" | "settling" | "idle">("refreshing");
  const [error, setError] = useState("");
  const [walletBalance, setWalletBalance] = useState<number>();
  const ticketSizeUsd = Number(
    formatUnits(BigInt(feed.feed.cards[0]?.amountInBaseUnits ?? "10000000"), 6),
  );
  const periodLimitUsd = ticketSizeUsd * (feed.feed.cards.length || 1);
  const basket = useMemo(
    () => ({
      sessionId: session.id,
      epochId: session.epochId,
      selected,
      ticketSizeUsd,
      periodLimitUsd,
      wallet,
    }),
    [selected, session.epochId, session.id, ticketSizeUsd, periodLimitUsd, wallet],
  );

  useEffect(() => {
    let cancelled = false;
    setPhase("refreshing");
    setError("");
    api
      .balances(wallet)
      .then((balance) => {
        if (!cancelled) {
          setWalletBalance(
            Number(formatUnits(BigInt(balance.usdtBalanceBaseUnits), balance.usdtDecimals)),
          );
        }
      })
      .catch(() => undefined);
    api
      .prepare({
        sessionId: session.id,
        chain: "BOTCHAIN",
        chainId: config.chainId,
        inputToken: config.usdt,
        periodLimitUsd,
        slippageBps: 50,
        selections: selected.map((candidate) => ({
          assetId: candidate.assetId,
          amountInBaseUnits: ticketSizeToBaseUnits(ticketSizeUsd).toString(),
        })),
      })
      .then((next) => {
        if (cancelled) return;
        setRecord(next);
        onExecutionChange(next);
        setPhase("idle");
      })
      .catch((caught) => {
        if (cancelled) return;
        setPhase("idle");
        setError(caught instanceof Error ? caught.message : "Could not prepare basket.");
      });
    return () => {
      cancelled = true;
    };
  }, [basket.sessionId, config.chainId, config.usdt, onExecutionChange, periodLimitUsd, selected, session.id, ticketSizeUsd, wallet]);

  const active = executionMatchesReviewBasket(record, basket) ? record : undefined;
  const total = selected.length * ticketSizeUsd;

  async function signAndSubmit() {
    if (!active?.walletCalls?.length) return;
    setError("");
    setPhase("signing");
    try {
      const hashes: Hex[] = [];
      for (const call of active.walletCalls) {
        const hash = await sendTransactionAsync({
          to: call.transaction.to as `0x${string}`,
          data: call.transaction.data as Hex,
          value: BigInt(call.transaction.value),
          chainId: call.transaction.chainId,
        });
        hashes.push(hash);
      }
      setPhase("settling");
      const submitted = await api.submitted(active.plan.executionId, hashes);
      const reconciled = await api.reconcile(active.plan.executionId);
      onExecutionChange(reconciled);
      onSettled(reconciled.status === "SUBMITTED" ? submitted : reconciled);
    } catch (caught) {
      setPhase("idle");
      setError(
        caught instanceof ApiError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : "MetaMask did not submit the basket.",
      );
    }
  }

  return (
    <section className="review-screen">
      <button type="button" className="text-button" onClick={onBack}>
        Back to feed
      </button>
      <h1>Review basket</h1>
      <p>
        <Shield /> Lumora prices are checked on-chain when a feed exists. MetaMask signs each BDEX call from your wallet.
      </p>
      <ul className="review-ledger">
        {selected.map((candidate) => (
          <li key={candidate.assetId}>
            <AssetMark symbol={candidate.symbol} iconUrl={candidate.iconUrl} />
            <div>
              <strong>{candidate.symbol}</strong>
              <small>{candidate.lumoraFeedId ?? "BDEX pool"}</small>
            </div>
            <span>{formatTicketSizeUsd(ticketSizeUsd)} USDT</span>
            <button type="button" onClick={() => onRemove(candidate.assetId)} aria-label={`Remove ${candidate.symbol}`}>
              <Close />
            </button>
          </li>
        ))}
        <li>
          <span>Total</span>
          <strong>{total.toFixed(2)} USDT</strong>
        </li>
        <li>
          <span>Wallet USDT</span>
          <strong>{walletBalance === undefined ? "…" : walletBalance.toFixed(2)}</strong>
        </li>
      </ul>
      {error ? <p className="send-error" role="alert">{error}</p> : null}
      <button
        type="button"
        className="button button-primary"
        disabled={!active?.walletCalls?.length || phase !== "idle"}
        onClick={() => void signAndSubmit()}
      >
        {phase === "refreshing" ? (
          <>Refreshing BDEX routes <LoaderCircle className="spin" /></>
        ) : phase === "signing" ? (
          "Confirm in MetaMask…"
        ) : phase === "settling" ? (
          "Reconciling on BOT Chain…"
        ) : (
          <>Sign basket <ArrowRight /></>
        )}
      </button>
    </section>
  );
}

