import type { AssetHistoryResponse, HistoryPeriod } from "./api.js";

export const HISTORY_PERIODS: HistoryPeriod[] = ["1D", "1W", "1M", "1Y", "ALL"];

export const HISTORY_PERIOD_SECONDS: Record<
	Exclude<HistoryPeriod, "ALL">,
	number
> = {
	"1H": 60 * 60,
	"1D": 24 * 60 * 60,
	"1W": 7 * 24 * 60 * 60,
	"1M": 30 * 24 * 60 * 60,
	"1Y": 365 * 24 * 60 * 60,
};

export function historySpanSeconds(history: AssetHistoryResponse | undefined) {
	const points = history?.points ?? [];
	const first = points[0];
	const last = points.at(-1);
	if (!first || !last) return 0;
	return Math.max(0, last.timestamp - first.timestamp);
}

function formatChartDate(timestamp: number, period: HistoryPeriod) {
	const date = new Date(timestamp * 1000);
	if (period === "1D") {
		const day = new Intl.DateTimeFormat("en-US", {
			month: "short",
			day: "numeric",
		}).format(date);
		const time = new Intl.DateTimeFormat("en-US", {
			hour: "numeric",
			minute: "2-digit",
			hour12: true,
		}).format(date);
		return `${day} at ${time}`;
	}
	return new Intl.DateTimeFormat(
		"en-US",
		period === "1W" || period === "1M"
			? { month: "short", day: "numeric" }
			: { month: "short", year: "numeric" },
	).format(date);
}

export function chartDateLabels(history: AssetHistoryResponse | undefined) {
	const points = history?.points ?? [];
	const first = points[0];
	const last = points.at(-1);
	if (!history || !first || !last) return [];
	return [
		formatChartDate(first.timestamp, history.period),
		formatChartDate(last.timestamp, history.period),
	];
}

export function chartPriceTicks(prices: number[]) {
	if (!prices.length) return [];
	const min = Math.min(...prices);
	const max = Math.max(...prices);
	const interval = (max - min) / 3;
	return Array.from({ length: 4 }, (_, index) =>
		Number((max - interval * index).toFixed(10)),
	);
}

export function isHistoryPeriodAvailable(
	period: HistoryPeriod,
	coverageHistory: AssetHistoryResponse | undefined,
) {
	if (
		period === "ALL" ||
		!coverageHistory ||
		coverageHistory.source === "unavailable"
	)
		return true;
	const span = historySpanSeconds(coverageHistory);
	return span >= HISTORY_PERIOD_SECONDS[period] * 0.95;
}
