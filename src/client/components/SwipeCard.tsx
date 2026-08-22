import { useEffect, useRef, useState } from "react";
import type { Candidate } from "../../domain/schemas";
import { formatTicketSizeUsd } from "../../domain/schemas";
import { api, type AssetHistoryResponse } from "../api";
import { formatUsdPrice } from "../price-format";
import { AssetMark } from "./AssetMark";

const SWIPE_THRESHOLD_PX = 72;
type DecisionFeedback = "invest" | "skip";

export function SwipeCard({
  candidate,
  reason,
  ticketSizeUsd,
  stableToken,
  feedback,
  onSwipe,
}: {
  candidate: Candidate;
  reason: string;
  ticketSizeUsd: number;
  stableToken: "USDT" | "USDG" | "USDC";
  feedback?: DecisionFeedback;
  infoOpen?: boolean;
  onInfoOpenChange?: (open: boolean) => void;
  onSwipe: (add: boolean) => void;
}) {
  const pointerStart = useRef<{ id: number; x: number } | undefined>(undefined);
  const [dragX, setDragX] = useState(0);
  const [history, setHistory] = useState<AssetHistoryResponse>();

  useEffect(() => {
    let cancelled = false;
    api
      .assetHistory(candidate.assetId, "1D")
      .then((result) => {
        if (!cancelled) setHistory(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [candidate.assetId]);

  function resetDrag() {
    pointerStart.current = undefined;
    setDragX(0);
  }

  const points = history?.points ?? [];
  const min = Math.min(...points.map((point) => point.price), candidate.marketPriceUsd ?? 0);
  const max = Math.max(...points.map((point) => point.price), candidate.marketPriceUsd ?? 0);
  const path = points
    .map((point, index) => {
      const x = points.length <= 1 ? 0 : (index / (points.length - 1)) * 100;
      const y = max === min ? 50 : 90 - ((point.price - min) / (max - min)) * 80;
      return `${index === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");

  return (
    <article
      className={`swipe-card${dragX ? " is-dragging" : ""}${feedback ? ` is-${feedback}` : ""}`}
      style={{ transform: `translateX(${dragX}px) rotate(${dragX / 28}deg)` }}
      onPointerDown={(event) => {
        if (feedback || (event.target as HTMLElement).closest("button, a")) return;
        pointerStart.current = { id: event.pointerId, x: event.clientX };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!pointerStart.current || pointerStart.current.id !== event.pointerId) return;
        setDragX(event.clientX - pointerStart.current.x);
      }}
      onPointerUp={(event) => {
        if (!pointerStart.current || pointerStart.current.id !== event.pointerId) return;
        const delta = event.clientX - pointerStart.current.x;
        resetDrag();
        if (Math.abs(delta) >= SWIPE_THRESHOLD_PX) onSwipe(delta > 0);
      }}
      onPointerCancel={resetDrag}
    >
      <header>
        <AssetMark symbol={candidate.symbol} iconUrl={candidate.iconUrl} size="lg" />
        <div>
          <strong>{candidate.symbol}</strong>
          <span>{candidate.name}</span>
        </div>
        <em>
          {candidate.marketPriceUsd
            ? formatUsdPrice(candidate.marketPriceUsd)
            : "Live BDEX"}
        </em>
      </header>
      <svg className="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {path ? <path d={path} fill="none" stroke="currentColor" strokeWidth="2" /> : null}
      </svg>
      <p>{reason}</p>
      <footer>
        <span>
          {formatTicketSizeUsd(ticketSizeUsd)} {stableToken}
        </span>
        <small>
          {candidate.lumoraFeedId
            ? `Lumora ${candidate.lumoraFeedId}`
            : "BDEX pool"}
          {candidate.lumoraFamily ? ` · ${candidate.lumoraFamily}` : ""}
        </small>
      </footer>
    </article>
  );
}
