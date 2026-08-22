import {
	BriefcaseBusiness,
	ChevronDown,
	ExternalLink,
	FileText,
	LoaderCircle,
	RotateCcw,
	SlidersHorizontal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import type { Candidate } from "../../domain/schemas";
import type { ExecutionRecord, FeedResponse, PublicConfig } from "../api";
import { AssetMark } from "./AssetMark";
import { Confetti } from "./magicui/confetti";
import { Check, Shield } from "./Icons";

export function ReceiptScreen({
	record,
	selected,
	feed,
	config,
	onResume,
	onViewPortfolio,
	onStartNextBasket,
}: {
	record?: ExecutionRecord;
	selected: Candidate[];
	feed?: FeedResponse;
	config: PublicConfig;
	onResume: () => Promise<void>;
	onViewPortfolio: () => void;
	onStartNextBasket: () => void;
}) {
	const showConfetti = useSettlementConfetti(record);

	if (!record) {
		return (
			<main className="empty-page">
				<h1>Activity</h1>
				<p>
					Your terminal settlement receipts will appear here. A quote or
					transaction hash alone is never shown as settled.
				</p>
				<button
					type="button"
					className="button button-primary"
					onClick={onStartNextBasket}
				>
					New basket
				</button>
			</main>
		);
	}
	const isTerminal = ["SETTLED", "PARTIAL", "FAILED"].includes(record.status);
	const successfulLegs = record.settledOutputs.filter(
		(output) => output.status === "success",
	).length;
	const chainLabel = config.chainName;
	const providerLabel = record.plan.provider;
	const receiptStatus = receiptCopy(
		record.status,
		selected.length,
		successfulLegs,
		chainLabel,
		providerLabel,
	);
	const outputsByAssetId = new Map(
		record.settledOutputs.map((output) => [output.assetId, output]),
	);
	const transactionHash = record.transactionHashes.at(-1);
	const isPending = record.status === "SUBMITTED";
	const isSettled = record.status === "SETTLED";
	const stableToken = config.stableToken;
	const totalInput = formatUsd(
		formatUnits(
			BigInt(record.plan.totalInputBaseUnits),
			config.stableTokenDecimals,
		),
	);
	const settledDescription = `${totalInput} was split across ${successfulLegs} ${successfulLegs === 1 ? "asset" : "assets"} and added to your portfolio.`;
	const receiptTitle = isSettled ? "Basket settled" : receiptStatus.title;
	const receiptDescription = isSettled
		? settledDescription
		: receiptStatus.description;
	const transactionUrl = transactionHash
		? `${config.explorerUrl}/tx/${transactionHash}`
		: undefined;

	return (
		<main className="receipt-page">
			{showConfetti ? (
				<Confetti
					className="receipt-confetti"
					options={{
						colors: ["#baff00", "#111111", "#ffffff"],
						gravity: 0.9,
						particleCount: 120,
						spread: 92,
						startVelocity: 38,
					}}
				/>
			) : null}
			<header className="receipt-heading" aria-live="polite">
				<span
					className={`receipt-check ${isPending ? "pending" : record.status === "FAILED" ? "failed" : ""}`}
				>
					{isPending ? (
						<LoaderCircle />
					) : record.status === "FAILED" ? (
						<span aria-hidden="true">!</span>
					) : (
						<Check />
					)}
				</span>
				<div>
					<h1>{receiptTitle}</h1>
					<p>{receiptDescription}</p>
				</div>
			</header>
			<section className="receipt-ledger">
				<h2>What you bought</h2>
				{selected.map((candidate) => {
					const output = outputsByAssetId.get(candidate.assetId);
					const isSuccess = output?.status === "success";
					const quote =
						candidate.quote ??
						record.plan.quotes.find(
							(candidateQuote) => candidateQuote.assetId === candidate.assetId,
						);
					const fullOutput =
						isSuccess && output
							? formatUnits(
									BigInt(output.amountOutBaseUnits),
									candidate.decimals,
								)
							: undefined;
					return (
						<div className="receipt-row" key={candidate.assetId}>
							<AssetMark
								symbol={candidate.symbol}
								iconUrl={candidate.iconUrl}
								size="sm"
							/>
							<div className="receipt-asset">
								<b>{candidate.symbol}</b>
								<small>
									{quote
										? `${formatUsd(formatUnits(BigInt(quote.amountInBaseUnits), config.stableTokenDecimals))} allocation`
										: `Allocation unavailable · ${stableToken}`}
								</small>
							</div>
							<div
								className={
									isSuccess
										? "receipt-output status-complete"
										: output?.status === "failed"
											? "receipt-output status-failed"
											: "receipt-output status-pending"
								}
								title={
									fullOutput ? `${fullOutput} ${candidate.symbol}` : undefined
								}
							>
								{isSuccess && output && fullOutput ? (
									<>
										<span>
											{formatTokenAmount(fullOutput)} {candidate.symbol}
										</span>
										<small>received</small>
									</>
								) : output?.status === "failed" ? (
									<span>Not settled</span>
								) : isTerminal ? (
									<span>No output recorded</span>
								) : (
									<span>Awaiting receipt</span>
								)}
							</div>
						</div>
					);
				})}
				{!selected.length ? (
					<p className="receipt-missing-snapshot">
						The operation is preserved, but its local card snapshot is
						unavailable. Open the transaction receipt for the canonical onchain
						details.
					</p>
				) : null}
				<div
					className={`receipt-verification ${isPending ? "pending" : record.status === "FAILED" ? "failed" : ""}`}
				>
					{isPending ? <LoaderCircle /> : <Check />}
					<b>
						{isSettled
							? `Verified on ${chainLabel}`
							: `${record.status.toLowerCase()} on ${chainLabel}`}
					</b>
				</div>
				{record.settledAt ? (
					<p className="receipt-captured-at">
						Settled {formatSettledAt(record.settledAt)}
					</p>
				) : null}
			</section>
			<section className="receipt-technical">
				<details className="receipt-execution-details">
					<summary>
						<span className="receipt-detail-icon">
							<SlidersHorizontal aria-hidden="true" />
						</span>
						<span>
							<b>How this was executed</b>
							<small>
								{`${record.transactionHashes.length || record.plan.quotes.length} ${providerLabel} transactions · ${record.plan.quotes.length} swaps`}
							</small>
						</span>
						<ChevronDown aria-hidden="true" />
					</summary>
					<div className="receipt-proof">
						<p>
							<Shield />
							<span>
								Execution provider<b>{providerLabel}</b>
							</span>
						</p>
						<p>
							<Shield />
							<span>
								Authorized plan
								<b>{shortHash(record.plan.authorizedPlanHash)}</b>
							</span>
						</p>
						<p>
							<Shield />
							<span>
								Policy hash<b>{shortHash(record.plan.policyHash)}</b>
							</span>
						</p>
						<p>
							<Shield />
							<span>
								Ranking output
								<b>
									{feed
										? shortHash(feed.proof.outputCommitment)
										: "Feed snapshot unavailable"}
								</b>
							</span>
						</p>
						<div className="live-disclosure">
							{`Settlement is verified per ${chainLabel} transaction and output-token transfer to your wallet.`}
						</div>
					</div>
				</details>
				<div className="receipt-transaction-row">
					<span className="receipt-detail-icon">
						<FileText aria-hidden="true" />
					</span>
					<span>
						<b>Transaction receipt</b>
						<small>
							{transactionHash
								? shortHash(transactionHash)
								: "Awaiting operation hash"}
						</small>
					</span>
					{transactionUrl ? (
						<a
							href={transactionUrl}
							target="_blank"
							rel="noreferrer"
							aria-label={`View transaction on ${chainLabel}`}
						>
							<ExternalLink aria-hidden="true" />
						</a>
					) : null}
				</div>
			</section>
			<div className="receipt-actions">
				{isPending ? (
					<button
						type="button"
						className="button button-primary"
						onClick={() => void onResume()}
					>
						<RotateCcw aria-hidden="true" /> Check settlement
					</button>
				) : successfulLegs > 0 ? (
					<button
						type="button"
						className="button button-primary"
						onClick={onViewPortfolio}
					>
						See my portfolio <BriefcaseBusiness aria-hidden="true" />
					</button>
				) : null}
				<button
					type="button"
					className="button button-quiet"
					onClick={onStartNextBasket}
				>
					Build another basket
				</button>
			</div>
		</main>
	);
}

function useSettlementConfetti(record?: ExecutionRecord) {
	const [showConfetti, setShowConfetti] = useState(false);
	const shownExecution = useRef<string | undefined>(undefined);

	useEffect(() => {
		if (record?.status !== "SETTLED") return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const executionId = record.plan.executionId;
		if (shownExecution.current !== executionId) {
			const storageKey = `botinvest:settlement-confetti:${executionId}`;
			try {
				if (sessionStorage.getItem(storageKey)) return;
				sessionStorage.setItem(storageKey, "shown");
			} catch {
				// A blocked session store should not prevent the celebration.
			}
			shownExecution.current = executionId;
		}
		setShowConfetti(true);
		const timer = window.setTimeout(() => setShowConfetti(false), 2600);
		return () => window.clearTimeout(timer);
	}, [record?.plan.executionId, record?.status]);

	return showConfetti;
}

function formatUsd(value: string) {
	const amount = Number(value);
	if (!Number.isFinite(amount)) return `$${value}`;
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(amount);
}

function formatTokenAmount(value: string) {
	const [whole, fraction = ""] = value.split(".");
	if (!fraction) return whole;
	if (whole !== "0") {
		const compact = fraction.slice(0, 6).replace(/0+$/, "");
		return compact ? `${whole}.${compact}` : whole;
	}
	const firstNonZero = fraction.search(/[1-9]/);
	if (firstNonZero === -1) return "0";
	const compact = fraction
		.slice(0, Math.min(fraction.length, firstNonZero + 5))
		.replace(/0+$/, "");
	return `0.${compact}`;
}

function formatSettledAt(value: string) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(date);
}

function receiptCopy(
	status: ExecutionRecord["status"],
	totalLegs: number,
	successfulLegs: number,
	chainLabel: string,
	providerLabel: string,
) {
	if (status === "SUBMITTED") {
		return {
			title: "Basket submitted",
			description: `Your wallet broadcast the basket swaps. Waiting for ${chainLabel} settlement.`,
		};
	}
	if (status === "SETTLED") {
		return {
			title: "Basket settled",
			description: `All ${totalLegs} legs reached a verified terminal state on ${chainLabel}.`,
		};
	}
	if (status === "PARTIAL") {
		return {
			title: "Basket partially settled",
			description: `${successfulLegs} of ${totalLegs} legs reached a verified terminal state. Review the receipt before trying again.`,
		};
	}
	if (status === "FAILED") {
		return {
			title: "Basket not settled",
			description:
				"No output-token transfer was verified for this basket. Your wallet remains the source of truth.",
		};
	}
	return {
		title: "Basket prepared",
		description: `Fresh ${providerLabel} calls are ready for your wallet confirmation.`,
	};
}

function shortHash(hash: string) {
	return hash.length > 20 ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : hash;
}
