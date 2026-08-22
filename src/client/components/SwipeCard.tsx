import { CircleHelp } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { visibleAssetTags } from "../../domain/asset-tag-config";
import { LUMORA_APP_BASE } from "../../domain/constants";
import type { Candidate } from "../../domain/schemas";
import {
	type AssetDetailsResponse,
	type AssetHistoryResponse,
	api,
	type HistoryPeriod,
} from "../api";
import {
	type ChartPoint,
	chartPointsAttribute,
	chartPointsFromPrices,
	chartPolygonAttribute,
	interpolateChartPoints,
} from "../chart-animation";
import {
	chartDateLabels,
	chartPriceTicks,
	HISTORY_PERIOD_SECONDS,
	HISTORY_PERIODS,
	historySpanSeconds,
	isHistoryPeriodAvailable,
} from "../chart-history";
import { formatChartAxisUsdPrice, formatUsdPrice } from "../price-format";
import { AssetMark } from "./AssetMark";

const SWIPE_THRESHOLD_PX = 72;
const LOADING_DOTS = Array.from({ length: 32 }, (_, index) => index);
const CHART_MORPH_DURATION_MS = 420;
type DecisionFeedback = "invest" | "skip";

function shortDate(timestamp: number) {
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
	}).format(new Date(timestamp * 1000));
}

function shortMonthYear(timestamp: number) {
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		year: "numeric",
	}).format(new Date(timestamp * 1000));
}

function oneMonthAfter(timestamp: number) {
	const date = new Date(timestamp * 1000);
	date.setUTCMonth(date.getUTCMonth() + 1);
	return Math.floor(date.getTime() / 1000);
}

const CHART_TICK_Y = [5, 12.67, 20.33, 28];
const compactUsdFormatter = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	notation: "compact",
	maximumFractionDigits: 2,
});

function formatCount(value: number | undefined) {
	return value
		? new Intl.NumberFormat("en-US", { notation: "compact" }).format(value)
		: undefined;
}

function ChartShape({
	points,
	label,
}: {
	points: ChartPoint[];
	label: string;
}) {
	const polygonRef = useRef<SVGPolygonElement>(null);
	const lineRef = useRef<SVGPolylineElement>(null);
	const frameRef = useRef<number | undefined>(undefined);
	const currentPointsRef = useRef(points);

	useLayoutEffect(() => {
		const polygon = polygonRef.current;
		const line = lineRef.current;
		if (!polygon || !line || !points.length) return;

		if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
		const from = currentPointsRef.current;
		const applyPoints = (next: ChartPoint[]) => {
			line.setAttribute("points", chartPointsAttribute(next));
			polygon.setAttribute("points", chartPolygonAttribute(next));
			currentPointsRef.current = next;
		};
		const reducedMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		if (
			!from.length ||
			reducedMotion ||
			chartPointsAttribute(from) === chartPointsAttribute(points)
		) {
			applyPoints(points);
			return;
		}

		applyPoints(from);
		const startedAt = performance.now();
		const animate = (timestamp: number) => {
			const elapsed = Math.min(
				1,
				(timestamp - startedAt) / CHART_MORPH_DURATION_MS,
			);
			const eased = 1 - (1 - elapsed) ** 3;
			applyPoints(interpolateChartPoints(from, points, eased));
			if (elapsed < 1) frameRef.current = requestAnimationFrame(animate);
			else frameRef.current = undefined;
		};
		frameRef.current = requestAnimationFrame(animate);
		return () => {
			if (frameRef.current !== undefined)
				cancelAnimationFrame(frameRef.current);
		};
	}, [points]);

	const line = chartPointsAttribute(points);
	return (
		<svg
			viewBox="0 0 100 32"
			preserveAspectRatio="none"
			role="img"
			aria-label={label}
		>
			{CHART_TICK_Y.map((y) => (
				<line
					className="chart-gridline"
					x1="0"
					x2="100"
					y1={y}
					y2={y}
					key={y}
				/>
			))}
			{line ? (
				<>
					<polygon ref={polygonRef} points={chartPolygonAttribute(points)} />
					<polyline ref={lineRef} points={line} />
				</>
			) : null}
		</svg>
	);
}

function PriceSparkline({
	candidate,
	reason,
	infoOpen,
	onInfoOpenChange,
}: {
	candidate: Candidate;
	reason: string;
	infoOpen: boolean;
	onInfoOpenChange: (open: boolean) => void;
}) {
	const [period, setPeriod] = useState<HistoryPeriod>("1M");
	const [history, setHistory] = useState<AssetHistoryResponse>();
	const [coverageHistory, setCoverageHistory] =
		useState<AssetHistoryResponse>();
	const [retryCount, setRetryCount] = useState(0);
	const [details, setDetails] = useState<AssetDetailsResponse>();
	const [detailsFailed, setDetailsFailed] = useState(false);

	useEffect(() => {
		if (!infoOpen || details || detailsFailed) return;
		let active = true;
		void api
			.assetDetails(candidate.assetId)
			.then((result) => active && setDetails(result))
			.catch(() => active && setDetailsFailed(true));
		return () => {
			active = false;
		};
	}, [candidate.assetId, details, detailsFailed, infoOpen]);

	useEffect(() => {
		let active = true;
		setCoverageHistory(undefined);
		void api
			.assetHistory(candidate.assetId, "ALL", retryCount > 0)
			.then((result) => active && setCoverageHistory(result))
			.catch(
				() =>
					active &&
					setCoverageHistory({
						period: "ALL",
						source: "unavailable",
						points: [],
					}),
			);
		return () => {
			active = false;
		};
	}, [candidate.assetId, retryCount]);

	useEffect(() => {
		if (!coverageHistory) return;
		setPeriod((current) =>
			isHistoryPeriodAvailable(current, coverageHistory) ? current : "ALL",
		);
	}, [coverageHistory]);

	useEffect(() => {
		let active = true;
		setHistory((current) =>
			current?.source === "unavailable" ? undefined : current,
		);
		void api
			.assetHistory(candidate.assetId, period, retryCount > 0)
			.then((result) => active && setHistory(result))
			.catch(
				() =>
					active && setHistory({ period, source: "unavailable", points: [] }),
			);
		return () => {
			active = false;
		};
	}, [candidate.assetId, period, retryCount]);

	const prices = useMemo(
		() => history?.points.map((point) => point.price) ?? [],
		[history],
	);
	const chartPoints = useMemo(() => chartPointsFromPrices(prices), [prices]);
	const priceTicks = useMemo(() => chartPriceTicks(prices), [prices]);
	const first = prices[0];
	const last = prices.at(-1);
	const change = first && last ? ((last - first) / first) * 100 : 0;
	const dateLabels = chartDateLabels(history);
	const coverageSpan = historySpanSeconds(coverageHistory);
	const coverageDays = Math.max(1, Math.round(coverageSpan / (24 * 60 * 60)));
	const isNewToken =
		coverageHistory !== undefined &&
		coverageHistory.source !== "unavailable" &&
		coverageSpan < HISTORY_PERIOD_SECONDS["1M"];
	const firstTimestamp = coverageHistory?.points[0]?.timestamp;
	const oneMonthUnlock = firstTimestamp
		? oneMonthAfter(firstTimestamp)
		: undefined;
	const displayPeriod = history?.period ?? period;
	const periodLabel =
		displayPeriod === "ALL" && history?.points[0]
			? `${history.isCompleteHistory === false ? "Max available · " : ""}Since ${shortMonthYear(history.points[0].timestamp)}`
			: displayPeriod;
	const chartLabel = `${candidate.symbol} ${periodLabel} price chart`;
	const loading = history === undefined;
	const unavailable = history?.source === "unavailable";
	const compactCommunityLinks = details
		? ["X", "Telegram"].flatMap((label) => {
				const item = details.community.find(
					(community) => community.label === label && community.url,
				);
				return item?.url ? [item] : [];
			})
		: [];

	useEffect(() => {
		if (!unavailable || retryCount >= 2) return;
		const timer = window.setTimeout(
			() => setRetryCount((count) => count + 1),
			2_000,
		);
		return () => window.clearTimeout(timer);
	}, [retryCount, unavailable]);

	return (
		<div
			className={`price-chart${change < 0 ? " is-down" : ""}${infoOpen ? " has-info" : ""}`}
		>
			<div className={`chart-meta${isNewToken ? " has-coverage" : ""}`}>
				<strong>{formatUsdPrice(candidate.marketPriceUsd ?? 0)}</strong>
				<span>
					{prices.length
						? `${change >= 0 ? "+" : ""}${change.toFixed(2)}% · ${periodLabel}`
						: "—"}
				</span>
				{isNewToken ? (
					<div className="chart-coverage">
						<i aria-hidden="true" />
						New · {coverageDays} {coverageDays === 1 ? "day" : "days"}
					</div>
				) : null}
			</div>
			{unavailable ? (
				<div className="chart-unavailable" role="status">
					<strong>Price history unavailable</strong>
					<span>
						No Lumora feed or BDEX pool history has been published for this
						asset yet.
					</span>
					<button
						type="button"
						onClick={() => setRetryCount((count) => count + 1)}
					>
						Retry
					</button>
				</div>
			) : loading ? (
				<>
					<div className="chart-loading" role="status" aria-live="polite">
						<span className="sr-only">
							Loading {period === "ALL" ? "all" : period} price history
						</span>
						<div className="chart-loading-dots" aria-hidden="true">
							{LOADING_DOTS.map((index) => (
								<i
									key={index}
									style={{
										animationDelay: `${(3 - Math.floor(index / 8)) * 90}ms`,
									}}
								/>
							))}
						</div>
					</div>
					<div
						className="chart-dates chart-dates-placeholder"
						aria-hidden="true"
					>
						<span>&nbsp;</span>
						<span>&nbsp;</span>
						<span>&nbsp;</span>
					</div>
				</>
			) : (
				<>
					<div className="chart-plot">
						<ChartShape points={chartPoints} label={chartLabel} />
						<div className="chart-prices" aria-hidden="true">
							{CHART_TICK_Y.map((y, index) => (
								<span style={{ top: `${(y / 32) * 100}%` }} key={y}>
									{formatChartAxisUsdPrice(priceTicks[index] ?? 0)}
								</span>
							))}
						</div>
					</div>
					{dateLabels.length ? (
						<fieldset className="chart-dates">
							<legend className="sr-only">
								{periodLabel} chart date range
							</legend>
							<span>{dateLabels[0]}</span>
							<span>{dateLabels[1]}</span>
						</fieldset>
					) : null}
					{history.period !== period ? (
						<span className="sr-only" role="status">
							Loading {period} price history
						</span>
					) : null}
				</>
			)}
			<div className="chart-controls">
				<fieldset
					className="chart-timeframes"
					onPointerDown={(event) => event.stopPropagation()}
				>
					<legend className="sr-only">Chart timeframe</legend>
					{HISTORY_PERIODS.map((option) => {
						const disabled = !isHistoryPeriodAvailable(option, coverageHistory);
						const unlockLabel =
							option === "1M" && oneMonthUnlock
								? ` Available ${shortDate(oneMonthUnlock)}.`
								: "";
						return (
							<button
								type="button"
								aria-pressed={period === option}
								aria-label={`${option === "ALL" ? "All" : option} timeframe.${disabled ? ` Not enough price history.${unlockLabel}` : ""}`}
								disabled={disabled}
								onClick={() => setPeriod(option)}
								key={option}
							>
								{option === "ALL" ? "All" : option}
							</button>
						);
					})}
				</fieldset>
				<button
					type="button"
					className="chart-reason-toggle"
					aria-label="Asset information"
					aria-expanded={infoOpen}
					onClick={() => onInfoOpenChange(!infoOpen)}
				>
					<CircleHelp aria-hidden="true" />
				</button>
			</div>
			{infoOpen ? (
				<div className="asset-info-panel" aria-live="polite">
					{!details && !detailsFailed ? (
						<p className="asset-info-status">Loading Lumora details…</p>
					) : null}
					{detailsFailed ? (
						<p className="asset-info-status">Asset details are unavailable.</p>
					) : null}
					{details ? (
						<>
							<div className="asset-info-tags">
								<div>
									{candidate.marketCapRank ? (
										candidate.lumoraRoute ? (
											<a
												className="asset-rank-tag is-lumora"
												href={`${LUMORA_APP_BASE}/${candidate.lumoraRoute}`}
												target="_blank"
												rel="noopener noreferrer"
												aria-label={`View ${candidate.name} on Lumora`}
											>
												<img src="/assets/providers/lumora.svg" alt="" />
												Rank #{candidate.marketCapRank}
												<span aria-hidden="true">↗</span>
											</a>
										) : (
											<span className="asset-rank-tag is-lumora">
												<img src="/assets/providers/lumora.svg" alt="" />
												Rank #{candidate.marketCapRank}
											</span>
										)
									) : null}
									{candidate.discoveryProvider === "BDEX" &&
									candidate.providerLiquidityRank ? (
										<span
											className="asset-rank-tag is-bdex"
											title={`Pool ${candidate.providerLiquidityRank} of ${candidate.providerLiquidityRankTotal ?? 0} BDEX pools sorted by USDT liquidity`}
										>
											<img src="/assets/providers/bdex.svg" alt="" />
											Pool #{candidate.providerLiquidityRank} by liquidity
										</span>
									) : null}
									{visibleAssetTags(details.categories).map((tag) => (
										<span
											className={`asset-tag is-${tag.tone}`}
											key={tag.source}
										>
											{tag.label}
										</span>
									))}
									{!visibleAssetTags(details.categories).length &&
									!candidate.marketCapRank &&
									!candidate.providerLiquidityRank
										? "Not listed"
										: null}
								</div>
							</div>
							<div className="asset-info-metrics">
								<dl>
									<div>
										<dt>Market Cap:</dt>
										<dd>
											{details.marketCapUsd !== undefined
												? compactUsdFormatter.format(details.marketCapUsd)
												: "—"}
										</dd>
									</div>
									<div>
										<dt>24H Volume:</dt>
										<dd>
											{(candidate.volume24hUsd ?? details.volume24hUsd)
												? compactUsdFormatter.format(
														candidate.volume24hUsd ?? details.volume24hUsd ?? 0,
													)
												: "—"}
										</dd>
									</div>
								</dl>
								<dl>
									<div>
										<dt>Liquidity:</dt>
										<dd>
											{candidate.liquidityUsd !== undefined
												? compactUsdFormatter.format(candidate.liquidityUsd)
												: "—"}
										</dd>
									</div>
									<div>
										<dt>Token Holders:</dt>
										<dd>{formatCount(details.holderCount) ?? "—"}</dd>
									</div>
								</dl>
							</div>
							<div className="asset-info-link-row">
								<strong>Links:</strong>
								<div>
									{details.websiteUrl ? (
										<a
											href={details.websiteUrl}
											target="_blank"
											rel="noopener noreferrer"
										>
											Website ↗
										</a>
									) : null}
									{compactCommunityLinks.map((item) => (
										<a
											href={item.url}
											target="_blank"
											rel="noopener noreferrer"
											key={item.label}
										>
											{item.label} ↗
										</a>
									))}
									{!details.websiteUrl && !compactCommunityLinks.length ? (
										<span>Not listed</span>
									) : null}
								</div>
							</div>
							<p className="asset-info-reason">{reason}</p>
						</>
					) : null}
				</div>
			) : null}
			{isNewToken ? (
				<div className="chart-coverage-note">
					<span>Only {coverageDays} days of history</span>
					{oneMonthUnlock ? (
						<span>1M available {shortDate(oneMonthUnlock)}</span>
					) : null}
				</div>
			) : null}
		</div>
	);
}

export function SwipeCard({
	candidate,
	reason,
	ticketSizeUsd,
	stableToken,
	feedback,
	infoOpen,
	onInfoOpenChange,
	onSwipe,
}: {
	candidate: Candidate;
	reason: string;
	ticketSizeUsd: number;
	stableToken: "USDT";
	feedback?: DecisionFeedback;
	infoOpen: boolean;
	onInfoOpenChange: (open: boolean) => void;
	onSwipe: (add: boolean) => void;
}) {
	const pointerStart = useRef<{ id: number; x: number } | undefined>(undefined);
	const [dragX, setDragX] = useState(0);

	function resetDrag() {
		pointerStart.current = undefined;
		setDragX(0);
	}

	return (
		<article
			className={`swipe-card${dragX ? " is-dragging" : ""}${feedback ? ` is-${feedback}` : ""}`}
			style={{ transform: `translateX(${dragX}px) rotate(${dragX / 28}deg)` }}
			onPointerDown={(event) => {
				if (feedback || (event.target as HTMLElement).closest("button, a"))
					return;
				pointerStart.current = { id: event.pointerId, x: event.clientX };
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={(event) => {
				if (
					!pointerStart.current ||
					pointerStart.current.id !== event.pointerId
				)
					return;
				setDragX(
					Math.max(-120, Math.min(120, event.clientX - pointerStart.current.x)),
				);
			}}
			onPointerUp={(event) => {
				if (
					!pointerStart.current ||
					pointerStart.current.id !== event.pointerId
				)
					return;
				const distance = event.clientX - pointerStart.current.x;
				resetDrag();
				if (Math.abs(distance) >= SWIPE_THRESHOLD_PX) onSwipe(distance > 0);
			}}
			onPointerCancel={resetDrag}
		>
			{feedback ? (
				<div className={`card-decision-flash ${feedback}`} aria-live="polite">
					<div className="decision-confetti" aria-hidden="true">
						<i>✦</i>
						<i>✦</i>
						<i>✦</i>
					</div>
					<span>{feedback === "invest" ? "👍" : "👎"}</span>
					<b>{feedback === "invest" ? "In your basket" : "Skipped"}</b>
				</div>
			) : null}
			<div className="card-head">
				<div className="asset-title">
					<AssetMark
						symbol={candidate.symbol}
						iconUrl={candidate.iconUrl}
						size="lg"
					/>
					<div>
						<h2>{candidate.symbol}</h2>
						<p>{candidate.name}</p>
					</div>
				</div>
				<div className="allocation-stamp">
					<strong>{ticketSizeUsd}</strong>
					<span>{stableToken}</span>
				</div>
			</div>
			<PriceSparkline
				key={candidate.assetId}
				candidate={candidate}
				reason={reason}
				infoOpen={infoOpen}
				onInfoOpenChange={onInfoOpenChange}
			/>
		</article>
	);
}
