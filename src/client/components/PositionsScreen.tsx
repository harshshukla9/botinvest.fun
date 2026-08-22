import { FilePen, HandCoins, LoaderCircle, LogOut, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { formatUnits, toHex } from "viem";
import type { Candidate } from "../../domain/schemas";
import {
	api,
	type ExitPreparation,
	type PublicConfig,
	type WalletCall,
} from "../api";
import {
	ensureBotChain,
	getMetaMaskProvider,
	readableWalletError,
} from "../metamask";
import { AssetMark } from "./AssetMark";
import { Check } from "./Icons";

const usdFormatter = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 2,
});

export function PositionsScreen({
	candidates,
	wallet,
	config,
}: {
	candidates: Candidate[];
	wallet: string;
	config: PublicConfig;
}) {
	const [balances, setBalances] = useState<Record<string, string>>({});
	const [indexedPortfolio, setIndexedPortfolio] = useState<Candidate[]>([]);
	const [portfolioLoading, setPortfolioLoading] = useState(false);
	const [prepared, setPrepared] = useState<Record<string, ExitPreparation>>({});
	const [status, setStatus] = useState<Record<string, string>>({});
	const [isExitingAll, setIsExitingAll] = useState(false);
	const [exitAllOpen, setExitAllOpen] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!wallet) return;
		let cancelled = false;
		setPortfolioLoading(true);
		setError("");
		setIndexedPortfolio([]);
		setBalances({});
		api
			.portfolio(wallet)
			.then((portfolio) => {
				if (cancelled) return;
				const knownByContract = new Map(
					candidates.map((candidate) => [
						candidate.contract.toLowerCase(),
						candidate,
					]),
				);
				const assets = portfolio.tokens.map((token): Candidate => {
					const known = knownByContract.get(token.contract.toLowerCase());
					return {
						...(known ?? {
							chain: "BOTCHAIN",
							eligible: true,
							marketHealthy: true,
							permissionAllowed: true,
							tags: [token.kind === "RWA" ? "rwa" : "crypto"],
							riskFlags: [],
							crowdScoreBps: 0,
							reason: "Detected in the connected wallet on BOT Chain.",
							evidenceIds: ["botchain-portfolio"],
						}),
						assetId: token.assetId,
						symbol: token.symbol,
						name: token.name,
						kind: token.kind,
						contract: token.contract,
						decimals: token.decimals,
						iconUrl: token.iconUrl ?? known?.iconUrl,
						marketPriceUsd: token.priceUsd ?? known?.marketPriceUsd,
						marketDataSource: token.marketDataSource ?? known?.marketDataSource,
						lumoraFeedId: token.lumoraFeedId ?? known?.lumoraFeedId,
						marketDataUpdatedAt:
							token.priceUpdatedAt ?? known?.marketDataUpdatedAt,
					};
				});
				setIndexedPortfolio(assets);
				setBalances(
					Object.fromEntries(
						portfolio.tokens.map((token) => [
							token.assetId,
							token.balanceBaseUnits,
						]),
					),
				);
			})
			.catch((caught) => {
				if (!cancelled) {
					setError(
						caught instanceof Error
							? caught.message
							: "Could not read BOT Chain balances.",
					);
				}
			})
			.finally(() => {
				if (!cancelled) setPortfolioLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [candidates, wallet]);

	const positionCandidates = indexedPortfolio;
	const portfolioValueUsd = positionCandidates.reduce(
		(total, candidate) =>
			total +
			(Number(balances[candidate.assetId] ?? "0") / 10 ** candidate.decimals) *
				Number(candidate.marketPriceUsd ?? candidate.quote?.unitPriceUsd ?? 0),
		0,
	);
	const holdings = positionCandidates.filter(
		(candidate) => BigInt(balances[candidate.assetId] ?? "0") > 0n,
	);

	async function sendWalletCalls(calls: WalletCall[]) {
		const provider = getMetaMaskProvider();
		if (!provider) throw new Error("MetaMask was not found.");
		await ensureBotChain(provider, config);
		const hashes: string[] = [];
		for (const call of calls) {
			const hash = await provider.request({
				method: "eth_sendTransaction",
				params: [
					{
						from: wallet,
						to: call.transaction.to,
						data: call.transaction.data,
						value: toHex(BigInt(call.transaction.value)),
					},
				],
			});
			if (typeof hash !== "string") {
				throw new Error("MetaMask did not return a transaction hash.");
			}
			hashes.push(hash);
		}
		return hashes;
	}

	async function prepare(candidate: Candidate) {
		const amount = balances[candidate.assetId] ?? "0";
		if (BigInt(amount) <= 0n) return;
		setError("");
		setStatus((current) => ({
			...current,
			[candidate.assetId]: "Preparing fresh quote…",
		}));
		try {
			const result = await api.prepareExit(candidate.assetId, amount);
			setPrepared((current) => ({ ...current, [candidate.assetId]: result }));
			setStatus((current) => ({
				...current,
				[candidate.assetId]: "Ready for wallet confirmation",
			}));
		} catch (caught) {
			setStatus((current) => ({ ...current, [candidate.assetId]: "" }));
			setError(
				caught instanceof Error ? caught.message : "Could not prepare exit.",
			);
		}
	}

	async function confirm(candidate: Candidate) {
		const exit = prepared[candidate.assetId];
		if (!exit?.walletCalls.length) return;
		setError("");
		setStatus((current) => ({
			...current,
			[candidate.assetId]: "Settling transaction…",
		}));
		try {
			await sendWalletCalls(exit.walletCalls);
			setStatus((current) => ({
				...current,
				[candidate.assetId]: "Exit settled",
			}));
			setBalances((current) => ({ ...current, [candidate.assetId]: "0" }));
		} catch (caught) {
			setError(readableWalletError(caught, "Exit confirmation failed."));
			setStatus((current) => ({ ...current, [candidate.assetId]: "" }));
		}
	}

	async function exitAll() {
		if (!holdings.length || isExitingAll) return;

		setError("");
		setIsExitingAll(true);
		try {
			setStatus((current) => ({
				...current,
				...Object.fromEntries(
					holdings.map((candidate) => [
						candidate.assetId,
						"Preparing fresh quote…",
					]),
				),
			}));
			const attempts = await Promise.allSettled(
				holdings.map(async (candidate) => {
					const amount = balances[candidate.assetId] ?? "0";
					const preparation = await api.prepareExit(candidate.assetId, amount);
					if (!preparation.walletCalls.length) {
						throw new Error("No executable exit calls.");
					}
					return { candidate, preparation };
				}),
			);
			const exits = attempts.flatMap((attempt) =>
				attempt.status === "fulfilled" ? [attempt.value] : [],
			);
			const skipped = holdings.filter(
				(_, index) => attempts[index]?.status === "rejected",
			);
			if (!exits.length) {
				throw new Error(
					"No BOT Chain holdings have an executable BDEX exit route right now.",
				);
			}
			setPrepared((current) => ({
				...current,
				...Object.fromEntries(
					exits.map(({ candidate, preparation }) => [
						candidate.assetId,
						preparation,
					]),
				),
			}));
			setStatus((current) => ({
				...current,
				...Object.fromEntries(
					exits.map(({ candidate }) => [
						candidate.assetId,
						"Settling transaction…",
					]),
				),
				...Object.fromEntries(
					skipped.map((candidate) => [candidate.assetId, "No executable route"]),
				),
			}));
			const settledAssetIds: string[] = [];
			for (const { candidate, preparation } of exits) {
				await sendWalletCalls(preparation.walletCalls);
				settledAssetIds.push(candidate.assetId);
				setStatus((current) => ({
					...current,
					[candidate.assetId]: "Exit settled",
				}));
				setBalances((current) => ({ ...current, [candidate.assetId]: "0" }));
			}
		} catch (caught) {
			setPrepared((current) =>
				Object.fromEntries(
					Object.entries(current).filter(
						([assetId]) =>
							!holdings.some((candidate) => candidate.assetId === assetId),
					),
				),
			);
			setStatus((current) => ({
				...current,
				...Object.fromEntries(
					holdings
						.filter((candidate) => current[candidate.assetId] !== "Exit settled")
						.map((candidate) => [candidate.assetId, ""]),
				),
			}));
			setError(readableWalletError(caught, "Could not exit all holdings."));
		} finally {
			setIsExitingAll(false);
		}
	}

	return (
		<main className="positions-page">
			<header className="positions-heading">
				<div>
					<h1>Portfolio</h1>
					<p>
						Live {config.chainName} balances with Lumora oracle prices when
						available.
					</p>
				</div>
			</header>
			<section className="portfolio-summary">
				<div className="portfolio-summary-meta">
					<span>Portfolio value</span>
					<div className="portfolio-summary-value-row">
						<strong>{usdFormatter.format(portfolioValueUsd)}</strong>
						<button
							type="button"
							className="button button-primary exit-all-button"
							disabled={!holdings.length || isExitingAll}
							onClick={() => setExitAllOpen(true)}
						>
							{isExitingAll ? "Exiting…" : "Exit all positions"}
							{!isExitingAll && <LogOut aria-hidden="true" />}
						</button>
					</div>
				</div>
			</section>
			<Dialog.Root open={exitAllOpen} onOpenChange={setExitAllOpen}>
				<Dialog.Portal>
					<Dialog.Overlay className="send-dialog-overlay" />
					<Dialog.Content className="send-dialog-content exit-all-dialog">
						<div className="send-dialog-header">
							<div>
								<Dialog.Title>Exit all holdings?</Dialog.Title>
								<Dialog.Description>
									Each holding is sold with its own MetaMask confirmation, in
									order.
								</Dialog.Description>
							</div>
							<Dialog.Close asChild>
								<button
									type="button"
									className="send-dialog-close"
									aria-label="Close exit confirmation"
								>
									<X aria-hidden="true" />
								</button>
							</Dialog.Close>
						</div>
						<div className="send-dialog-actions">
							<Dialog.Close asChild>
								<button type="button" className="button button-outline">
									Cancel
								</button>
							</Dialog.Close>
							<button
								type="button"
								className="button button-primary"
								onClick={() => {
									setExitAllOpen(false);
									void exitAll();
								}}
							>
								Confirm exit all <LogOut aria-hidden="true" />
							</button>
						</div>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog.Root>
			{portfolioLoading ? (
				<div
					className="positions-empty positions-loading"
					role="status"
					aria-live="polite"
				>
					<LoaderCircle aria-hidden="true" />
					Loading wallet holdings…
				</div>
			) : !positionCandidates.length ? (
				<div className="positions-empty">
					No BOT Chain tokens were found in this wallet yet. Settle a basket to
					see holdings here.
				</div>
			) : (
				<section className="positions-list">
					{positionCandidates.map((candidate) => {
						const rawBalance = balances[candidate.assetId] ?? "0";
						const exit = prepared[candidate.assetId];
						const actionStatus = status[candidate.assetId] ?? "";
						const settled = actionStatus === "Exit settled";
						const quoteLoading = actionStatus === "Preparing fresh quote…";
						const transactionSettling = actionStatus === "Settling transaction…";
						const actionBusy = quoteLoading || transactionSettling;
						const actionLabel = settled
							? `${candidate.symbol} exit settled`
							: quoteLoading
								? `Preparing ${candidate.symbol} quote`
								: transactionSettling
									? `Settling ${candidate.symbol} transaction`
									: exit
										? `Confirm ${candidate.symbol} sale`
										: `Sell ${candidate.symbol}`;
						const balance = formatPositionBalance(
							BigInt(rawBalance),
							candidate.decimals,
						);
						const rawUnitPrice =
							candidate.marketPriceUsd ?? candidate.quote?.unitPriceUsd;
						const holdingValue =
							rawUnitPrice !== undefined
								? usdFormatter.format(
										(Number(rawBalance) / 10 ** candidate.decimals) *
											Number(rawUnitPrice),
									)
								: "Price unavailable";
						const unitPrice =
							rawUnitPrice !== undefined
								? usdFormatter.format(Number(rawUnitPrice))
								: "Price unavailable";
						return (
							<article className="position-row" key={candidate.assetId}>
								<AssetMark
									symbol={candidate.symbol}
									iconUrl={candidate.iconUrl}
									size="sm"
								/>
								<div className="position-copy">
									<div className="position-primary">
										<b>{candidate.name}</b>
										<b>{holdingValue}</b>
									</div>
									<div className="position-secondary">
										<small>{unitPrice}</small>
										<small>
											{balance} {candidate.symbol}
										</small>
									</div>
								</div>
								<button
									type="button"
									className="button button-sell"
									aria-label={actionLabel}
									title={actionLabel}
									disabled={BigInt(rawBalance) <= 0n || settled || actionBusy}
									onClick={() =>
										exit ? confirm(candidate) : prepare(candidate)
									}
								>
									{settled ? (
										<Check aria-hidden="true" />
									) : actionBusy ? (
										<LoaderCircle
											className="button-spinner"
											aria-hidden="true"
										/>
									) : exit ? (
										<FilePen aria-hidden="true" />
									) : (
										<HandCoins aria-hidden="true" />
									)}
								</button>
								{exit && !settled && (
									<small className="position-status">
										{formatUnits(
											BigInt(exit.quote.minimumAmountOut),
											config.stableTokenDecimals,
										)}{" "}
										{config.stableToken} minimum · quote is active for 60
										seconds
									</small>
								)}
								{status[candidate.assetId] &&
									status[candidate.assetId] !==
										"Ready for wallet confirmation" && (
										<small className="position-status">
											{status[candidate.assetId]}
										</small>
									)}
							</article>
						);
					})}
				</section>
			)}
			{error && (
				<p className="error-message" role="alert">
					{error}
				</p>
			)}
		</main>
	);
}

function formatPositionBalance(value: bigint, decimals: number) {
	const formatted = formatUnits(value, decimals);
	const [whole, fraction = ""] = formatted.split(".");
	const firstNonZero = fraction.search(/[1-9]/);
	const visibleDecimals =
		value > 0n && whole === "0" && firstNonZero >= 4
			? Math.min(fraction.length, firstNonZero + 2)
			: 4;
	const compactFraction = fraction.slice(0, visibleDecimals).replace(/0+$/, "");
	return compactFraction ? `${whole}.${compactFraction}` : whole;
}
