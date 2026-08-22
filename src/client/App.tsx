import {
	ArrowLeft,
	Bot,
	ChevronLeft,
	ChevronRight,
	ArrowRight as LucideArrowRight,
	ShoppingBasket,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	fillFeedPage,
	nextFeedExcludedAssetIds,
	shouldPrefetchNextFeed,
} from "../domain/feed-pagination";
import {
	type Candidate,
	formatTicketSizeUsd,
	type OnboardingPreferences,
} from "../domain/schemas";
import {
	ApiError,
	api,
	configureApiAuth,
	type ExecutionRecord,
	type FeedResponse,
	type PublicConfig,
	type WeeklySession,
} from "./api";
import { AccountScreen } from "./components/AccountScreen";
import { AppShell } from "./components/AppShell";
import { AssetIconProvider } from "./components/AssetMark";
import { BudgetRail, BudgetSummary } from "./components/BudgetRail";
import { ArrowRight } from "./components/Icons";
import { Confetti } from "./components/magicui/confetti";
import { Onboarding } from "./components/Onboarding";
import { PositionsScreen } from "./components/PositionsScreen";
import { ReceiptScreen } from "./components/ReceiptScreen";
import { ReviewScreen } from "./components/ReviewScreen";
import { SwipeCard } from "./components/SwipeCard";
import {
	removeLegacyPreferences,
	writeAccountPreferences,
} from "./preferences-storage";
import { useWalletSession } from "./wallet-session";

type View = "week" | "positions" | "receipts" | "account";
type Stage = "loading" | "onboarding" | "swipe" | "review";
type DecisionFeedback = "invest" | "skip";
const LAST_EXECUTION_KEY = "botinvest:last-execution";
const LAST_EXECUTION_CANDIDATES_KEY = "botinvest:last-execution-candidates";
const FEED_RETRY_DELAY_MS = 900;

function rememberWarnings(
	target: Map<string, string[]>,
	response: FeedResponse,
) {
	for (const candidate of response.candidates) {
		target.set(candidate.assetId, response.feed.warnings);
	}
}

function shouldRetryFeed(error: unknown) {
	return !(
		error instanceof ApiError &&
		[
			"AUTH_REQUIRED",
			"EXECUTION_PROVIDER_CHANGED",
			"INVALID_REQUEST",
			"SESSION_NOT_FOUND",
		].includes(error.code)
	);
}

async function generateFeedWithRetry(
	sessionId: string,
	preferences: OnboardingPreferences,
) {
	try {
		return await api.generateFeed(sessionId, preferences);
	} catch (error) {
		if (!shouldRetryFeed(error)) throw error;
		await new Promise((resolve) =>
			window.setTimeout(resolve, FEED_RETRY_DELAY_MS),
		);
		return api.generateFeed(sessionId, preferences);
	}
}

export function App({ config }: { config: PublicConfig }) {
	const walletSession = useWalletSession(config);
	const { authenticated, connecting, token, wallet } = walletSession;
	const [view, setView] = useState<View>("week");
	const [stage, setStage] = useState<Stage>("onboarding");
	const [session, setSession] = useState<WeeklySession>();
	const [feed, setFeed] = useState<FeedResponse>();
	const [preferences, setPreferences] = useState<OnboardingPreferences>();
	const [index, setIndex] = useState(0);
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [assetInfoOpen, setAssetInfoOpen] = useState(false);
	const [settlement, setSettlement] = useState<ExecutionRecord>();
	const [receiptCandidates, setReceiptCandidates] = useState<Candidate[]>([]);
	const [error, setError] = useState("");
	const [decisionFeedback, setDecisionFeedback] = useState<DecisionFeedback>();
	const [loadingMore, setLoadingMore] = useState(false);
	const [feedExhausted, setFeedExhausted] = useState(false);
	const decisionTimer = useRef<number | undefined>(undefined);
	const prefetchedFeed = useRef<
		| {
				key: string;
				result: Promise<FeedResponse | undefined>;
		  }
		| undefined
	>(undefined);
	const warningsByAssetId = useRef(new Map<string, string[]>());
	const stableToken = config.stableToken;

	useEffect(() => {
		configureApiAuth({
			getAccessToken: async () => token || null,
			getWalletAddress: () => wallet || undefined,
		});
		return () => configureApiAuth(undefined);
	}, [token, wallet]);

	useEffect(() => {
		removeLegacyPreferences();
	}, []);

	useEffect(() => {
		if (!wallet || !token) return;
		const executionId = localStorage.getItem(lastExecutionKey(wallet));
		if (!executionId) return;
		setReceiptCandidates(readReceiptCandidates(wallet));
		let cancelled = false;
		api
			.execution(executionId)
			.then(async (record) => {
				if (cancelled) return;
				setSettlement(record);
				if (record.status !== "SUBMITTED") return;
				const reconciled = await api.reconcile(executionId);
				if (!cancelled) setSettlement(reconciled);
			})
			.catch(() => {
				localStorage.removeItem(lastExecutionKey(wallet));
			});
		return () => {
			cancelled = true;
		};
	}, [token, wallet]);

	const loadSession = useCallback(
		async (preferences: OnboardingPreferences) => {
			const prefetch = prefetchedFeed.current;
			const minimumLoader = new Promise((resolve) =>
				window.setTimeout(resolve, 1000),
			);
			setError("");
			setView("week");
			setStage("loading");
			setPreferences(preferences);
			setSession(undefined);
			setFeed(undefined);
			setIndex(0);
			setSelectedIds([]);
			setFeedExhausted(false);
			try {
				if (authenticated) await api.savePreferences(preferences);
				const [opened, prefetched] = await Promise.all([
					api.openSession(
						preferences.cadence,
						preferences.executionProvider,
						preferences.feedRankingProvider,
					),
					prefetch?.key === JSON.stringify(preferences)
						? prefetch.result
						: undefined,
				]);
				const generated =
					prefetched ?? (await generateFeedWithRetry(opened.id, preferences));
				await minimumLoader;
				prefetchedFeed.current = undefined;
				rememberWarnings(warningsByAssetId.current, generated);
				setSession(opened);
				setFeed({
					...generated,
					candidates: fillFeedPage(generated.candidates),
				});
				setIndex(0);
				setSelectedIds([]);
				setFeedExhausted(false);
				scrollToTop();
				setStage("swipe");
			} catch (caught) {
				await minimumLoader;
				setError(
					caught instanceof Error ? caught.message : "Could not open session",
				);
				scrollToTop();
				setStage("swipe");
			}
		},
		[authenticated],
	);

	const prefetchFeed = useCallback((preferences: OnboardingPreferences) => {
		const key = JSON.stringify(preferences);
		if (prefetchedFeed.current?.key === key) return;
		prefetchedFeed.current = {
			key,
			result: api
				.openSession(
					preferences.cadence,
					preferences.executionProvider,
					preferences.feedRankingProvider,
				)
				.then((opened) => api.generateFeed(opened.id, preferences))
				.catch(() => undefined),
		};
	}, []);

	useEffect(() => {
		if (authenticated && wallet && preferences) {
			writeAccountPreferences(wallet, preferences);
		}
	}, [authenticated, preferences, wallet]);

	useEffect(() => {
		if (!walletSession.ready || authenticated) return;
		setView("week");
		setStage("onboarding");
		setSession(undefined);
		setFeed(undefined);
		warningsByAssetId.current.clear();
		setPreferences(undefined);
		setIndex(0);
		setSelectedIds([]);
		setSettlement(undefined);
		setReceiptCandidates([]);
		setError("");
		setDecisionFeedback(undefined);
		setFeedExhausted(false);
	}, [authenticated, walletSession.ready]);

	useEffect(
		() => () => {
			if (decisionTimer.current) window.clearTimeout(decisionTimer.current);
		},
		[],
	);

	const candidates = feed?.candidates ?? [];
	const current = candidates[index];
	const currentFeedCard = current
		? feed?.feed.cards.find((card) => card.assetId === current.assetId)
		: undefined;
	const currentWarnings = current
		? (warningsByAssetId.current.get(current.assetId) ??
			feed?.feed.warnings ??
			[])
		: [];
	const nextAssetId = candidates[index + 1]?.assetId;
	const selected = selectedIds
		.map((assetId) =>
			candidates.find((candidate) => candidate.assetId === assetId),
		)
		.filter((candidate): candidate is Candidate => Boolean(candidate));
	const ticketSizeUsd = preferences?.ticketSizeUsd ?? 10;
	const periodLimitUsd = preferences?.periodLimitUsd ?? 100;
	const selectedTotalUsd = selected.length * ticketSizeUsd;
	const canAddCurrent = selectedTotalUsd + ticketSizeUsd <= periodLimitUsd;

	useEffect(() => {
		if (!nextAssetId) return;
		void Promise.all([
			api.assetHistory(nextAssetId, "ALL"),
			api.assetHistory(nextAssetId, "1M"),
		]).catch(() => undefined);
	}, [nextAssetId]);

	const recoverReviewSession = useCallback(async () => {
		if (!preferences) throw new Error("PREFERENCES_REQUIRED");
		const opened = await api.openSession(
			preferences.cadence,
			preferences.executionProvider,
			preferences.feedRankingProvider,
		);
		const generated = await api.generateFeed(opened.id, preferences);
		const available = new Set(
			generated.candidates.map((candidate) => candidate.assetId),
		);
		const retained = selectedIds.filter((assetId) => available.has(assetId));
		const assetIds = retained.length
			? retained
			: generated.candidates.slice(0, 1).map((candidate) => candidate.assetId);
		if (!assetIds.length)
			throw new Error("NO_ELIGIBLE_CANDIDATES_FOR_PREFERENCES");
		setSession(opened);
		rememberWarnings(warningsByAssetId.current, generated);
		setFeed({
			...generated,
			candidates: fillFeedPage(generated.candidates),
		});
		setSelectedIds(assetIds);
		return { sessionId: opened.id, assetIds };
	}, [preferences, selectedIds]);

	const loadMoreCandidates = useCallback(async () => {
		if (!feed || !preferences || !session || loadingMore || feedExhausted)
			return;
		setLoadingMore(true);
		try {
			const next = await api.generateFeed(
				session.id,
				preferences,
				nextFeedExcludedAssetIds(feed),
			);
			rememberWarnings(warningsByAssetId.current, next);
			const nextCandidates = fillFeedPage(next.candidates);
			setFeed((currentFeed) => {
				if (!currentFeed) return next;
				const rankOffset = currentFeed.feed.cards.length;
				return {
					...next,
					candidates: [...currentFeed.candidates, ...nextCandidates],
					feed: {
						...next.feed,
						cards: [
							...currentFeed.feed.cards,
							...next.feed.cards.map((card, cardIndex) => ({
								...card,
								rank: rankOffset + cardIndex + 1,
							})),
						],
					},
				};
			});
		} catch (caught) {
			if (
				caught instanceof ApiError &&
				caught.code !== "NO_ELIGIBLE_CANDIDATES_FOR_PREFERENCES"
			) {
				console.error("Could not load the next feed page", caught);
			}
			setFeedExhausted(true);
		} finally {
			setLoadingMore(false);
		}
	}, [feed, feedExhausted, loadingMore, preferences, session]);

	useEffect(() => {
		if (
			!feed?.hasMore ||
			feedExhausted ||
			loadingMore ||
			!shouldPrefetchNextFeed(index, candidates.length)
		) {
			return;
		}
		void loadMoreCandidates();
	}, [
		candidates.length,
		feed,
		feedExhausted,
		index,
		loadMoreCandidates,
		loadingMore,
	]);

	useEffect(() => {
		const nextCandidate = candidates[index + 1];
		if (!nextCandidate) return;
		void api.assetHistory(nextCandidate.assetId, "1M").catch(() => undefined);
	}, [candidates, index]);

	function decide(add: boolean) {
		if (!current) return;
		if (add && !selectedIds.includes(current.assetId) && canAddCurrent) {
			setSelectedIds((ids) => [...ids, current.assetId]);
		}
		setIndex((value) => Math.min(value + 1, candidates.length));
	}

	function animateDecision(add: boolean) {
		if (!current || decisionFeedback || (add && !canAddCurrent)) return;
		setDecisionFeedback(add ? "invest" : "skip");
		decisionTimer.current = window.setTimeout(() => {
			decide(add);
			setDecisionFeedback(undefined);
			decisionTimer.current = undefined;
		}, 300);
	}

	function remove(assetId: string) {
		setSelectedIds((ids) => ids.filter((id) => id !== assetId));
		setFeedExhausted(false);
	}

	function navigate(target: View) {
		if (!authenticated || stage === "onboarding") return;
		scrollToTop();
		setView(target);
		if (target === "week" && stage === "loading" && feed) setStage("swipe");
	}

	return (
		<AssetIconProvider>
			<AppShell
				active={view}
				onNavigate={navigate}
				config={config}
				wallet={wallet}
				onWallet={() => void walletSession.connect()}
				onDisconnect={walletSession.disconnect}
				walletReady={walletSession.ready}
				walletBusy={connecting}
				navigationEnabled={authenticated && stage !== "onboarding"}
			>
				{stage === "onboarding" ? (
					<Onboarding
						config={config}
						walletSession={walletSession}
						onComplete={loadSession}
						onPrefetch={prefetchFeed}
					/>
				) : view === "receipts" ? (
					<ReceiptScreen
						record={settlement}
						selected={receiptCandidates.length ? receiptCandidates : selected}
						feed={feed}
						config={config}
						onResume={async () => {
							if (!settlement) return;
							const reconciled = await api.reconcile(
								settlement.plan.executionId,
							);
							setSettlement(reconciled);
						}}
						onViewPortfolio={() => {
							scrollToTop();
							setView("positions");
						}}
						onStartNextBasket={() => {
							if (preferences) {
								void loadSession(preferences);
								setView("week");
							}
						}}
					/>
				) : view === "positions" ? (
					<PositionsScreen
						candidates={Array.from(
							new Map(
								candidates.map((candidate) => [candidate.assetId, candidate]),
							).values(),
						)}
						wallet={wallet}
						config={config}
					/>
				) : view === "account" && preferences ? (
					<AccountScreen
						wallet={wallet}
						config={config}
						preferences={preferences}
						executionProviders={config.executionProviders}
						feedRankingProviders={config.feedRankingProviders}
						onSave={async (next) => {
							if (wallet) writeAccountPreferences(wallet, next);
							prefetchedFeed.current = undefined;
							setSettlement(undefined);
							await loadSession(next);
							setView("week");
						}}
					/>
				) : stage === "review" && session && feed ? (
					<ReviewScreen
						session={session}
						feed={feed}
						config={config}
						selected={selected}
						onRemove={remove}
						onBack={() => {
							scrollToTop();
							setStage("swipe");
						}}
						onSettled={(record) => {
							setSettlement(record);
							setReceiptCandidates(
								executionCandidates(
									record,
									selected,
									wallet ? readReceiptCandidates(wallet) : [],
								),
							);
							setView("receipts");
						}}
						onSessionExpired={recoverReviewSession}
						onExecutionInvalidated={() => {
							setSettlement(undefined);
							if (wallet) {
								localStorage.removeItem(lastExecutionKey(wallet));
								localStorage.removeItem(lastExecutionCandidatesKey(wallet));
							}
						}}
						onStartAnotherBasket={() => {
							if (preferences) void loadSession(preferences);
						}}
						ticketSizeUsd={ticketSizeUsd}
						periodLimitUsd={periodLimitUsd}
						wallet={wallet}
						onExecutionChange={(record) => {
							setSettlement(record);
							const snapshot = executionCandidates(
								record,
								selected,
								wallet ? readReceiptCandidates(wallet) : [],
							);
							setReceiptCandidates(snapshot);
							if (wallet) {
								localStorage.setItem(
									lastExecutionKey(wallet),
									record.plan.executionId,
								);
								if (snapshot.length === record.plan.quotes.length) {
									localStorage.setItem(
										lastExecutionCandidatesKey(wallet),
										JSON.stringify(snapshot),
									);
								}
							}
						}}
					/>
				) : (
					<main className="swipe-page">
						<section className="swipe-workspace">
							<header className="page-heading">
								<h1>Build your basket</h1>
								<p>Swipe right to add left to skip.</p>
							</header>
							{error ? (
								<div className="fatal-state">
									<h2>Session unavailable</h2>
									<p>{error}</p>
									<button
										type="button"
										onClick={() => {
											if (preferences) void loadSession(preferences);
										}}
										disabled={!preferences}
									>
										Try again
									</button>
								</div>
							) : stage === "loading" || !feed ? (
								<div className="loading-state">
									<div className="feed-loader" role="img" aria-label="Lumora">
										<b>LX</b>
									</div>
									<h2>Building your personal feed</h2>
									<p>
										<span className="feed-providers">
											<span className="feed-providers-label">
												feed providers:
											</span>
											<span className="feed-provider">
												<img
													src="/assets/providers/lumora.svg"
													alt=""
													aria-hidden="true"
												/>
												Lumora
											</span>
											<i aria-hidden="true">·</i>
											<span className="feed-provider">
												<img
													src="/assets/providers/bdex.svg"
													alt=""
													aria-hidden="true"
												/>
												BDEX
											</span>
										</span>
									</p>
								</div>
							) : current ? (
								<>
									<div className="card-stage">
										<button
											type="button"
											className="gesture gesture-skip"
											onClick={() => animateDecision(false)}
											aria-label="Skip asset"
											disabled={Boolean(decisionFeedback)}
										>
											<ArrowLeft />
											<span>
												Skip<small>Swipe left</small>
											</span>
										</button>
										<SwipeCard
											candidate={current}
											reason={currentFeedCard?.reason ?? current.reason}
											ticketSizeUsd={ticketSizeUsd}
											stableToken={stableToken}
											feedback={decisionFeedback}
											infoOpen={assetInfoOpen}
											onInfoOpenChange={setAssetInfoOpen}
											onSwipe={animateDecision}
										/>
										<button
											type="button"
											className="gesture gesture-add"
											onClick={() => animateDecision(true)}
											aria-label={`Add ${ticketSizeUsd} ${stableToken}`}
											disabled={Boolean(decisionFeedback) || !canAddCurrent}
										>
											<LucideArrowRight />
											<span>
												Add<small>Swipe right</small>
											</span>
										</button>
									</div>
									{currentWarnings.length ? (
										<aside className="ai-warnings" aria-label="Feed warnings">
											<Bot aria-hidden="true" />
											<ul>
												{currentWarnings.map((warning) => (
													<li key={warning}>{warning}</li>
												))}
											</ul>
										</aside>
									) : null}
									<BudgetSummary
										selectedCount={selected.length}
										ticketSizeUsd={ticketSizeUsd}
										periodLimitUsd={periodLimitUsd}
										className="mobile-budget-summary"
									/>
									<div
										className={`card-actions${selected.length ? " has-selection" : ""}`}
									>
										<button
											type="button"
											className="button button-skip"
											onClick={() => animateDecision(false)}
											disabled={Boolean(decisionFeedback)}
										>
											<ChevronLeft aria-hidden="true" /> Skip
										</button>
										<button
											type="button"
											className="button button-outline"
											onClick={() => {
												scrollToTop();
												setStage("review");
											}}
											disabled={!selected.length}
										>
											Review basket ({selected.length}) <ShoppingBasket />
										</button>
										<button
											type="button"
											className="button button-primary"
											onClick={() => animateDecision(true)}
											disabled={Boolean(decisionFeedback) || !canAddCurrent}
										>
											Add {ticketSizeUsd} {stableToken}{" "}
											<ChevronRight aria-hidden="true" />
										</button>
									</div>
								</>
							) : loadingMore ? (
								<div className="loading-state loading-more">
									<div className="feed-loader" role="img" aria-label="Lumora">
										<b>LX</b>
									</div>
									<h2>Finding more assets…</h2>
									<p>Your selected basket stays ready to review.</p>
								</div>
							) : (
								<div className="feed-complete">
									{selected.length ? (
										<Confetti
											className="completion-confetti"
											options={{
												gravity: 0.9,
												particleCount: 120,
												spread: 90,
												startVelocity: 36,
											}}
										/>
									) : null}
									<h2>That’s the feed.</h2>
									<p>
										{selected.length
											? `${formatTicketSizeUsd(selected.length * ticketSizeUsd)} ${stableToken} is ready for review.`
											: `No more executable BDEX routes are available right now. Your ${stableToken} stays in your wallet.`}
									</p>
									<button
										type="button"
										className="button button-primary"
										disabled={!selected.length}
										onClick={() => {
											scrollToTop();
											setStage("review");
										}}
									>
										Review basket ({selected.length}) <ShoppingBasket />
									</button>
								</div>
							)}
						</section>
						<BudgetRail
							selected={selected}
							onRemove={remove}
							ticketSizeUsd={ticketSizeUsd}
							periodLimitUsd={periodLimitUsd}
							executionProvider={
								preferences?.executionProvider ??
								session?.executionProvider ??
								"BDEX"
							}
						/>
						<section className="evidence-detail">
							<div className="feed-method-copy">
								<h2>How your feed earns your trust</h2>
								<p>
									Your rules shape the feed. Lumora signs the prices on-chain;
									BDEX routes are checked again at review.
								</p>
								<ol className="feed-pipeline">
									<li>
										<strong>1 · Your rules</strong>
										<span>Cadence, cap, ticket, risk, and asset mix.</span>
									</li>
									<li>
										<strong>2 · Market data</strong>
										<span>
											Lumora oracle prices, verified against CommodityConsumer
											on BOT Chain.
										</span>
									</li>
									<li>
										<strong>3 · Deterministic rank</strong>
										<span>
											Ranking runs on the same bounded input and output schema
											every time.
										</span>
									</li>
									<li>
										<strong>4 · You approve</strong>
										<span>
											Policy rechecks the route. MetaMask signs last.
										</span>
									</li>
								</ol>
							</div>
							{feed ? (
								<details className="feed-proof">
									<summary>
										View proof <ArrowRight />
									</summary>
									<dl>
										<div>
											<dt>Network</dt>
											<dd>{feed.proof.network}</dd>
										</div>
										<div>
											<dt>Model</dt>
											<dd>{feed.proof.model}</dd>
										</div>
										<div>
											<dt>Provider</dt>
											<dd>{feed.proof.provider}</dd>
										</div>
										<div>
											<dt>Input</dt>
											<dd>{shortProof(feed.proof.inputCommitment)}</dd>
										</div>
										<div>
											<dt>Output</dt>
											<dd>{shortProof(feed.proof.outputCommitment)}</dd>
										</div>
									</dl>
								</details>
							) : (
								<span className="feed-proof-loading">Preparing proof…</span>
							)}
						</section>
					</main>
				)}
			</AppShell>
		</AssetIconProvider>
	);
}

function scrollToTop() {
	window.scrollTo({ top: 0, behavior: "auto" });
}

function shortProof(value: string) {
	return `${value.slice(0, 11)}…${value.slice(-6)}`;
}

function lastExecutionKey(wallet: string) {
	return `${LAST_EXECUTION_KEY}:${wallet.toLowerCase()}`;
}

function lastExecutionCandidatesKey(wallet: string) {
	return `${LAST_EXECUTION_CANDIDATES_KEY}:${wallet.toLowerCase()}`;
}

function readReceiptCandidates(wallet: string) {
	try {
		const value = JSON.parse(
			localStorage.getItem(lastExecutionCandidatesKey(wallet)) ?? "[]",
		);
		return Array.isArray(value) ? (value as Candidate[]) : [];
	} catch {
		return [];
	}
}

function executionCandidates(
	record: ExecutionRecord,
	current: Candidate[],
	fallback: Candidate[],
) {
	const quotes = new Map(
		record.plan.quotes.map((quote) => [quote.assetId, quote]),
	);
	const withQuotes = (candidates: Candidate[]) =>
		candidates.flatMap((candidate) => {
			const quote = quotes.get(candidate.assetId);
			return quote ? [{ ...candidate, quote }] : [];
		});
	const selected = withQuotes(current);
	if (selected.length === record.plan.quotes.length) return selected;
	return withQuotes(fallback);
}
