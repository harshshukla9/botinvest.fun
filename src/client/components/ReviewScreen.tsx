import { LoaderCircle, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, toHex } from "viem";
import type { Candidate } from "../../domain/schemas";
import { formatTicketSizeUsd } from "../../domain/schemas";
import type {
	ExecutionRecord,
	FeedResponse,
	PublicConfig,
	WeeklySession,
} from "../api";
import { ApiError, api } from "../api";
import {
	ensureBotChain,
	getMetaMaskProvider,
	readableWalletError,
} from "../metamask";
import {
	executionMatchesReviewBasket,
	executionPlanHashMatchesReviewBasket,
	reviewBasketKey,
} from "../review-safety";
import { AssetMark } from "./AssetMark";
import { ArrowRight, Check, Close, Shield } from "./Icons";

const MIN_SIGNING_WINDOW_MS = 10_000;

export function ReviewScreen({
	session,
	feed,
	config,
	selected,
	onRemove,
	onBack,
	onSettled,
	onExecutionChange,
	onExecutionInvalidated,
	onSessionExpired,
	onStartAnotherBasket,
	ticketSizeUsd,
	periodLimitUsd,
	wallet,
}: {
	session: WeeklySession;
	feed: FeedResponse;
	config: PublicConfig;
	selected: Candidate[];
	onRemove: (assetId: string) => void;
	onBack: () => void;
	onSettled: (record: ExecutionRecord) => void;
	onExecutionChange: (record: ExecutionRecord) => void;
	onExecutionInvalidated: () => void;
	onSessionExpired: () => Promise<{ sessionId: string; assetIds: string[] }>;
	onStartAnotherBasket: () => void;
	ticketSizeUsd: number;
	periodLimitUsd: number;
	wallet: string;
}) {
	const [record, setRecord] = useState<ExecutionRecord>();
	const [preparedBasketKey, setPreparedBasketKey] = useState("");
	const [loading, setLoading] = useState(true);
	const [phase, setPhase] = useState<
		"idle" | "refreshing" | "simulating" | "signing" | "settling"
	>("refreshing");
	const [error, setError] = useState("");
	const [errorCode, setErrorCode] = useState("");
	const [executionConflict, setExecutionConflict] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const [walletBalance, setWalletBalance] = useState<number>();
	const autoPrepareStarted = useRef(false);
	const preparationAttempt = useRef(0);
	const total = Math.round(selected.length * ticketSizeUsd * 100) / 100;
	const stableToken = config.stableToken;
	const basket = useMemo(
		() => ({
			sessionId: session.id,
			epochId: session.epochId,
			chain: "BOTCHAIN" as const,
			executionProvider: session.executionProvider,
			selected,
			ticketSizeUsd,
			periodLimitUsd,
			wallet,
		}),
		[
			selected,
			session.epochId,
			session.executionProvider,
			session.id,
			ticketSizeUsd,
			periodLimitUsd,
			wallet,
		],
	);
	const basketKey = reviewBasketKey(basket);
	const currentBasketKey = useRef(basketKey);
	currentBasketKey.current = basketKey;
	const activeRecord =
		preparedBasketKey === basketKey &&
		executionMatchesReviewBasket(record, basket)
			? record
			: undefined;
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, []);
	useEffect(() => {
		if (!wallet) {
			setWalletBalance(undefined);
			return;
		}
		let cancelled = false;
		setWalletBalance(undefined);
		void api
			.usdtBalance(wallet)
			.then(({ balanceBaseUnits, decimals }) =>
				Number(formatUnits(BigInt(balanceBaseUnits), decimals)),
			)
			.then((balance) => {
				if (!cancelled) setWalletBalance(balance);
			})
			.catch(() => {
				if (!cancelled) setWalletBalance(undefined);
			});
		return () => {
			cancelled = true;
		};
	}, [wallet]);
	const quoteExpiry = useMemo(() => {
		const quotes =
			activeRecord?.plan.quotes ?? selected.flatMap((item) => item.quote ?? []);
		if (!quotes.length) return 0;
		return Math.max(
			0,
			Math.min(...quotes.map((quote) => new Date(quote.expiresAt).getTime())) -
				now,
		);
	}, [activeRecord, now, selected]);
	const quotesFresh = quoteExpiry > 0;
	const quotesSafeToSign = quoteExpiry > MIN_SIGNING_WINDOW_MS;
	const walletCalls = activeRecord?.walletCalls ?? [];
	const hasExecutableTransaction = walletCalls.length > 0;
	const executionWalletReady = Boolean(wallet);
	const quoteByAssetId = new Map(
		(activeRecord?.plan.quotes ?? []).map((quote) => [quote.assetId, quote]),
	);

	const prepare = useCallback(async () => {
		if (!selected.length) {
			setError("Choose at least one asset before refreshing quotes.");
			return;
		}
		const attempt = ++preparationAttempt.current;
		const requestedBasketKey = basketKey;
		setLoading(true);
		setPhase("refreshing");
		setError("");
		setErrorCode("");
		setExecutionConflict(false);
		try {
			const prepared = await api.prepareExecution(
				session.id,
				selected.map((item) => item.assetId),
				ticketSizeUsd,
				periodLimitUsd,
				config.chainId,
				config.stableTokenAddress,
			);
			if (
				attempt !== preparationAttempt.current ||
				requestedBasketKey !== currentBasketKey.current
			)
				return;
			setRecord(prepared);
			setPreparedBasketKey(requestedBasketKey);
			onExecutionChange(prepared);
		} catch (caught) {
			if (attempt !== preparationAttempt.current) return;
			const code = caught instanceof ApiError ? caught.code : "";
			const message = preparationErrorMessage(caught);
			setErrorCode(code);
			if (code === "ASSETS_UNAVAILABLE" && caught instanceof ApiError) {
				const unavailableAssetIds = Array.isArray(caught.details.assetIds)
					? caught.details.assetIds.filter(
							(assetId): assetId is string =>
								typeof assetId === "string" &&
								selected.some((candidate) => candidate.assetId === assetId),
						)
					: [];
				if (
					unavailableAssetIds.length > 0 &&
					unavailableAssetIds.length < selected.length
				) {
					autoPrepareStarted.current = false;
					setError(
						`${message} Removed the unavailable asset and refreshing the remaining basket.`,
					);
					setErrorCode("");
					for (const assetId of unavailableAssetIds) onRemove(assetId);
					return;
				}
			}
			if (code === "SESSION_NOT_FOUND") {
				try {
					const recovered = await onSessionExpired();
					const prepared = await api.prepareExecution(
						recovered.sessionId,
						recovered.assetIds,
						ticketSizeUsd,
						periodLimitUsd,
						config.chainId,
						config.stableTokenAddress,
					);
					if (attempt !== preparationAttempt.current) return;
					setRecord(prepared);
					setPreparedBasketKey(
						reviewBasketKey({
							...basket,
							sessionId: recovered.sessionId,
							epochId: prepared.plan.epochId,
							selected: selected.filter((candidate) =>
								recovered.assetIds.includes(candidate.assetId),
							),
						}),
					);
					onExecutionChange(prepared);
					setError("");
					setErrorCode("");
				} catch (recoveryError) {
					setError(
						recoveryError instanceof Error
							? recoveryError.message
							: "Could not renew local session",
					);
				}
			} else if (
				caught instanceof ApiError &&
				(code === "EXECUTION_TERMINAL" || code === "EPOCH_ALREADY_EXECUTED")
			) {
				const executionId =
					typeof caught.details.executionId === "string"
						? caught.details.executionId
						: "";
				if (executionId) {
					try {
						const existing = await api.execution(executionId);
						if (existing.status !== "PREPARED") {
							onExecutionChange(existing);
							onSettled(existing);
							return;
						}
					} catch {
						// The product recovery below is still actionable if rehydration fails.
					}
				}
				setRecord(undefined);
				setPreparedBasketKey("");
				setExecutionConflict(true);
				setError(message);
			} else {
				setError(message);
			}
		} finally {
			setLoading(false);
			setPhase("idle");
		}
	}, [
		basket,
		basketKey,
		config.chainId,
		config.stableTokenAddress,
		onExecutionChange,
		onSessionExpired,
		onSettled,
		onRemove,
		selected,
		session.id,
		ticketSizeUsd,
		periodLimitUsd,
	]);

	useEffect(() => {
		if (
			!record ||
			(preparedBasketKey === basketKey &&
				executionMatchesReviewBasket(record, basket))
		)
			return;
		preparationAttempt.current += 1;
		setRecord(undefined);
		setPreparedBasketKey("");
		setError("");
		setErrorCode("");
		setExecutionConflict(false);
		onExecutionInvalidated();
	}, [basketKey, basket, onExecutionInvalidated, preparedBasketKey, record]);

	useEffect(() => {
		if (activeRecord || autoPrepareStarted.current || !selected.length) return;
		autoPrepareStarted.current = true;
		void prepare();
	}, [activeRecord, prepare, selected]);

	function removeAsset(assetId: string) {
		preparationAttempt.current += 1;
		setRecord(undefined);
		setPreparedBasketKey("");
		setError("");
		setErrorCode("");
		setExecutionConflict(false);
		onExecutionInvalidated();
		onRemove(assetId);
	}

	async function confirmLive() {
		const signingBasketKey = basketKey;
		if (
			activeRecord?.status !== "PREPARED" ||
			!activeRecord.walletCalls?.length ||
			!wallet ||
			!selected.length
		) {
			setError("No connected wallet or executable calls are available.");
			return;
		}
		if (
			!quotesSafeToSign ||
			!(await executionPlanHashMatchesReviewBasket(activeRecord, basket)) ||
			signingBasketKey !== currentBasketKey.current
		) {
			setRecord(undefined);
			setPreparedBasketKey("");
			onExecutionInvalidated();
			setError(
				"The basket changed after preparation. Refresh quotes before signing.",
			);
			return;
		}
		setLoading(true);
		setError("");
		try {
			const provider = getMetaMaskProvider();
			if (!provider) throw new Error("MetaMask was not found.");
			setPhase("simulating");
			await ensureBotChain(provider, config);
			const accounts = await provider.request({ method: "eth_accounts" });
			const active =
				Array.isArray(accounts) && typeof accounts[0] === "string"
					? accounts[0].toLowerCase()
					: "";
			if (active !== wallet.toLowerCase()) {
				throw new Error(
					"MetaMask is on a different account than this session. Switch back and retry.",
				);
			}
			setPhase("signing");
			const transactionHashes: string[] = [];
			// Every approval and swap is its own EOA transaction, so the basket
			// settles leg by leg and a rejection stops the remaining calls.
			for (const call of activeRecord.walletCalls ?? []) {
				const hash = await provider.request({
					method: "eth_sendTransaction",
					params: [
						{
							from: call.transaction.from,
							to: call.transaction.to,
							data: call.transaction.data,
							value: toHex(BigInt(call.transaction.value)),
						},
					],
				});
				if (typeof hash !== "string") {
					throw new Error("MetaMask did not return a transaction hash.");
				}
				transactionHashes.push(hash);
			}
			const submitted = await api.markSubmitted(
				activeRecord.plan.executionId,
				transactionHashes,
				false,
			);
			setRecord(submitted);
			onExecutionChange(submitted);
			setPhase("settling");
			const reconciled = await reconcileUntilTerminal(
				activeRecord.plan.executionId,
			);
			setRecord(reconciled);
			onExecutionChange(reconciled);
			onSettled(reconciled);
		} catch (caught) {
			setError(executionErrorMessage(caught));
		} finally {
			setLoading(false);
			setPhase("idle");
		}
	}

	async function resumeReconciliation() {
		if (!record) return;
		setLoading(true);
		setError("");
		try {
			const reconciled = await reconcileUntilTerminal(record.plan.executionId);
			setRecord(reconciled);
			onExecutionChange(reconciled);
			onSettled(reconciled);
		} catch (caught) {
			setError(
				caught instanceof Error
					? caught.message
					: "Could not verify settlement yet.",
			);
		} finally {
			setLoading(false);
		}
	}

	if (loading && phase === "refreshing") {
		return (
			<main
				className="loading-state review-preparing"
				aria-live="polite"
				aria-busy="true"
			>
				<span />
				<h1>Preparing your basket…</h1>
			</main>
		);
	}

	return (
		<main className="review-page">
			<section className="review-ledger">
				<header>
					<h1>Review your basket</h1>
					<p>
						{hasExecutableTransaction
							? `Fresh ${session.executionProvider} quotes are ready for MetaMask to confirm. Each approval and swap is signed in order, so partial completion is possible.`
							: "No transaction is prepared yet. Resolve the issue below, then refresh the quotes."}
					</p>
					{error ? (
						<p className="review-error" role="alert">
							{error}
							{errorCode === "INSUFFICIENT_FUNDS" ? (
								<>
									{" "}
									Lower the ticket size or remove an asset, then refresh the
									quotes.
								</>
							) : null}
							{errorCode === "INSUFFICIENT_LIQUIDITY" ? (
								<>
									{" "}
									{session.executionProvider} cannot fill this size at the
									current pool depth. Lower the ticket size and refresh.
								</>
							) : null}
						</p>
					) : null}
				</header>
				<div className="ledger-table">
					<div className="ledger-row ledger-labels">
						<span>Asset</span>
						<span>Input (you pay)</span>
						<span>Estimated output</span>
						<span>Minimum output</span>
						<span>Impact</span>
					</div>
					{selected.map((candidate) => {
						const quote = quoteByAssetId.get(candidate.assetId);
						return (
							<div className="ledger-row" key={candidate.assetId}>
								<span className="ledger-asset">
									<AssetMark
										symbol={candidate.symbol}
										iconUrl={candidate.iconUrl}
										size="sm"
									/>
									<b>
										{candidate.symbol}
										<small>{candidate.name}</small>
									</b>
								</span>
								<span>
									<strong>{formatTicketSizeUsd(ticketSizeUsd)}</strong>{" "}
									{stableToken}
								</span>
								<span>
									<strong>
										{quote
											? formatOutput(
													quote.estimatedAmountOut,
													candidate.decimals,
												)
											: "—"}
									</strong>{" "}
									{candidate.symbol}
								</span>
								<span>
									<strong>
										{quote
											? formatOutput(quote.minimumAmountOut, candidate.decimals)
											: "—"}
									</strong>{" "}
									{candidate.symbol}
								</span>
								<span className="blue-text">
									{quote ? `${(quote.priceImpactBps / 100).toFixed(2)}%` : "—"}
								</span>
								<button
									type="button"
									className="ledger-remove"
									onClick={() => removeAsset(candidate.assetId)}
									aria-label={`Remove ${candidate.symbol}`}
								>
									<Close />
								</button>
							</div>
						);
					})}
				</div>
				<div className="ledger-totals">
					<div>
						<span>Wallet balance</span>
						<strong>
							{walletBalance === undefined
								? "—"
								: formatTicketSizeUsd(walletBalance)}
						</strong>
						<small>
							<b>{stableToken}</b>
						</small>
					</div>
					<div>
						<span>Total input</span>
						<strong>{formatTicketSizeUsd(total)}</strong>
						<small>
							<b>{stableToken}</b> to invest
						</small>
					</div>
					<div>
						<span>Remainder</span>
						<strong>
							{formatTicketSizeUsd(
								Math.round((periodLimitUsd - total) * 100) / 100,
							)}
						</strong>
						<small>
							<b>{stableToken}</b>
						</small>
					</div>
				</div>
			</section>

			<aside className="policy-rail">
				<h2>Policy checks</h2>
				{[
					{
						label: "Assets eligible",
						value: selected.length
							? `${selected.length} / ${selected.length}`
							: "No assets selected",
						ok: selected.length > 0,
					},
					{
						label: quotesSafeToSign
							? "Quotes fresh"
							: quotesFresh
								? "Quote nearly expired"
								: "Preview expired",
						value: quotesSafeToSign
							? `${Math.ceil(quoteExpiry / 1000)}s`
							: "Refresh required",
						ok: quotesSafeToSign,
					},
					{
						label: "Budget within limit",
						value: `${formatTicketSizeUsd(total)} / ${formatTicketSizeUsd(periodLimitUsd)} ${stableToken}`,
						ok: selected.length > 0,
					},
					{
						label: "Execution provider",
						value: session.executionProvider,
						ok: true,
					},
					{
						label: `${config.chainName} · ${config.chainId}`,
						value: "Connected",
						ok: true,
					},
					{
						label: hasExecutableTransaction
							? `Wallet calls · ${walletCalls.length}`
							: "Live execution",
						value: hasExecutableTransaction
							? executionWalletReady
								? "Ready"
								: "Wallet required"
							: "Quotes required",
						ok: hasExecutableTransaction && executionWalletReady,
					},
				].map(({ label, value, ok }) => (
					<div className="policy-row" key={label}>
						<span
							className={ok ? "check-circle" : "check-circle warning-circle"}
						>
							{ok ? <Check /> : "!"}
						</span>
						<b>{label}</b>
						<em>{value}</em>
					</div>
				))}
				{hasExecutableTransaction ? (
					<div className="wallet-boundary">
						<Shield />
						<p>
							<b>{walletCalls.length} confirmations · signed in order.</b>
							<br />
							Every call is committed in the plan hash your wallet verifies
							before the first signature.
						</p>
					</div>
				) : null}
				<div className="proof-block">
					<h3>Personal feed ranking</h3>
					<p>
						<span>Ranking model</span>
						<b>{feed.proof.model}</b>
					</p>
					<p>
						<span>Provider</span>
						<b>{feed.proof.provider}</b>
					</p>
					<p>
						<span>Input commitment</span>
						<b>{shortHash(feed.proof.inputCommitment)}</b>
					</p>
					<p>
						<span>Output commitment</span>
						<b>{shortHash(feed.proof.outputCommitment)}</b>
					</p>
					<p>
						<span>Network</span>
						<b>{feed.proof.network}</b>
					</p>
				</div>
				{executionConflict ? (
					<button
						type="button"
						className="button button-outline"
						onClick={onStartAnotherBasket}
					>
						Start another basket
					</button>
				) : null}
				<div className="review-actions">
					<button
						type="button"
						className="button button-outline"
						onClick={onBack}
					>
						Back to cards
					</button>
					{!activeRecord ? (
						<button
							type="button"
							className="button button-primary"
							onClick={prepare}
							disabled={loading || !selected.length}
						>
							{loading ? "Refreshing…" : "Refresh quotes"}{" "}
							{loading ? (
								<LoaderCircle className="button-spinner" />
							) : (
								<RotateCcw />
							)}
						</button>
					) : (
						<button
							type="button"
							className="button button-primary"
							onClick={
								activeRecord.status === "SUBMITTED"
									? resumeReconciliation
									: !quotesSafeToSign
										? prepare
										: confirmLive
							}
							title={
								hasExecutableTransaction
									? undefined
									: "Refresh quotes to rebuild the wallet calls."
							}
							disabled={
								loading ||
								!selected.length ||
								activeRecord.status === "SETTLED" ||
								(quotesSafeToSign &&
									activeRecord.status === "PREPARED" &&
									!hasExecutableTransaction)
							}
						>
							{activeRecord.status === "SETTLED"
								? "Settled"
								: loading
									? phaseLabel(phase)
									: activeRecord.status === "SUBMITTED"
										? "Check settlement receipt"
										: !quotesSafeToSign
											? "Refresh quotes"
											: `Sign & invest ${formatTicketSizeUsd(total)} ${stableToken}`}{" "}
							{loading ? (
								<LoaderCircle className="button-spinner" />
							) : activeRecord.status !== "SETTLED" &&
								activeRecord.status !== "SUBMITTED" &&
								!quotesSafeToSign ? (
								<RotateCcw />
							) : (
								<ArrowRight />
							)}
						</button>
					)}
				</div>
			</aside>

			<section className="execution-strip">
				<h2>Execution progress</h2>
				{(hasExecutableTransaction
					? ["Awaiting signature", "Submitted", "Settled"]
					: ["Quotes required", "Wallet confirmation", "Settlement"]
				).map((step, index) => {
					const active = activeRecord
						? activeRecord.status === "SETTLED"
							? index <= 2
							: index === 0
						: index === 0;
					return (
						<div
							className={active ? "execution-step active" : "execution-step"}
							key={step}
						>
							<span>{active ? <Check /> : index + 1}</span>
							<b>{step}</b>
						</div>
					);
				})}
			</section>
		</main>
	);
}

function executionErrorMessage(caught: unknown) {
	if (caught instanceof Error && /insufficient funds/i.test(caught.message)) {
		return "The wallet does not have enough BOT to pay gas for this basket.";
	}
	return readableWalletError(caught, "Wallet execution failed.");
}

function preparationErrorMessage(caught: unknown) {
	const message =
		caught instanceof Error ? caught.message : "Could not prepare execution";
	if (message.includes("STALE_ORACLE")) {
		return "Lumora prices went stale while preparing this basket. Refresh the quotes.";
	}
	return message;
}

function formatOutput(raw: string, decimals: number) {
	const value = Number(formatUnits(BigInt(raw), decimals));
	return Number.isFinite(value)
		? value.toLocaleString(undefined, { maximumSignificantDigits: 6 })
		: "—";
}

function shortHash(hash: string) {
	return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

async function reconcileUntilTerminal(
	executionId: string,
): Promise<ExecutionRecord> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const record = await api.reconcile(executionId);
		if (["SETTLED", "PARTIAL", "FAILED"].includes(record.status)) return record;
		await new Promise((resolve) =>
			setTimeout(resolve, attempt < 12 ? 500 : 1_500),
		);
	}
	throw new Error(
		"Transactions are submitted but not terminal yet. Check Receipts shortly.",
	);
}

function phaseLabel(
	phase: "idle" | "refreshing" | "simulating" | "signing" | "settling",
) {
	if (phase === "refreshing") return "Refreshing quotes…";
	if (phase === "simulating") return "Simulating full basket…";
	if (phase === "signing") return "Basket settlement";
	if (phase === "settling") return "Verifying settlement…";
	return "Working…";
}
