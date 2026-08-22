import {
	ArrowDownToLine,
	CalendarDays,
	Check,
	CheckCircle2,
	ChevronRight,
	CircleDollarSign,
	Coins,
	Copy,
	Info,
	Plus,
	ShieldCheck,
	SlidersHorizontal,
	Wallet,
	X,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import type {
	ExecutionProviderId,
	FeedRankingProviderId,
	OnboardingPreferences,
} from "../../domain/schemas";
import { formatTicketSizeUsd, isTicketSizeUsd } from "../../domain/schemas";
import { api, type PublicConfig } from "../api";

const CADENCE_OPTIONS = ["daily", "weekly", "monthly"] as const;
const RISK_OPTIONS = ["conservative", "balanced", "degen"] as const;

export function AccountScreen({
	wallet,
	config,
	preferences,
	executionProviders,
	feedRankingProviders,
	onSave,
}: {
	wallet: string;
	config: PublicConfig;
	preferences: OnboardingPreferences;
	executionProviders: Record<ExecutionProviderId, { available: boolean }>;
	feedRankingProviders: Record<FeedRankingProviderId, { available: boolean }>;
	onSave: (preferences: OnboardingPreferences) => Promise<void>;
}) {
	const [draft, setDraft] = useState(preferences);
	const [balance, setBalance] = useState<string>();
	const [nativeBalance, setNativeBalance] = useState<string>();
	const [balanceError, setBalanceError] = useState("");
	const [saveError, setSaveError] = useState("");
	const [saving, setSaving] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [systemSettingsOpen, setSystemSettingsOpen] = useState(false);
	const [topUpOpen, setTopUpOpen] = useState(false);
	const [addressCopied, setAddressCopied] = useState<"smart" | "funding">();

	useEffect(() => setDraft(preferences), [preferences]);

	useEffect(() => {
		if (!wallet) {
			setBalance(undefined);
			setNativeBalance(undefined);
			setBalanceError("");
			return;
		}
		let cancelled = false;
		setBalance(undefined);
		setNativeBalance(undefined);
		setBalanceError("");
		api
			.usdtBalance(wallet)
			.then(({ balanceBaseUnits, decimals, nativeBalanceWei }) => {
				if (cancelled) return;
				setBalance(formatUnits(BigInt(balanceBaseUnits), decimals));
				setNativeBalance(
					formatUnits(
						BigInt(nativeBalanceWei),
						config.nativeCurrency.decimals,
					),
				);
			})
			.catch((caught) => {
				if (!cancelled)
					setBalanceError(
						caught instanceof Error
							? caught.message
							: "Could not read USDT balance.",
					);
			});
		return () => {
			cancelled = true;
		};
	}, [config.nativeCurrency.decimals, wallet]);

	async function save() {
		setSaveError("");
		setSaving(true);
		try {
			const next = {
				...draft,
				feedRankingProvider: feedRankingProviders.DETERMINISTIC.available
					? draft.feedRankingProvider
					: ("DETERMINISTIC" as const),
				riskDisclosureAccepted: true as const,
			};
			await onSave(next);
			setSettingsOpen(false);
			setSystemSettingsOpen(false);
		} catch (caught) {
			setSaveError(
				caught instanceof Error ? caught.message : "Could not save settings.",
			);
		} finally {
			setSaving(false);
		}
	}

	async function copyAddress(address: string, type: "smart" | "funding") {
		if (!address) return;
		try {
			await navigator.clipboard.writeText(address);
		} catch {
			const textarea = document.createElement("textarea");
			textarea.value = address;
			textarea.style.position = "fixed";
			textarea.style.opacity = "0";
			document.body.append(textarea);
			textarea.select();
			document.execCommand("copy");
			textarea.remove();
		}
		setAddressCopied(type);
		window.setTimeout(() => setAddressCopied(undefined), 1_800);
	}

	function topUp() {
		if (!wallet) return;
		setTopUpOpen(true);
	}

	function closeSettings(open: boolean) {
		if (saving) return;
		setSettingsOpen(open);
		if (!open) {
			setDraft(preferences);
			setSaveError("");
		}
	}

	function closeSystemSettings(open: boolean) {
		if (saving) return;
		setSystemSettingsOpen(open);
		if (!open) {
			setDraft(preferences);
			setSaveError("");
		}
	}

	return (
		<main className="account-page">
			<header className="account-heading">
				<span>Account command center</span>
				<h1>Ready to invest.</h1>
				<p>
					Everything you need to manage your wallet, rules, and next basket in
					one place.
				</p>
			</header>

			<section className="account-balance" aria-labelledby="balance-title">
				<div>
					<span className="account-label" id="balance-title">
						Investing balance
					</span>
					<strong>
						{balance === undefined
							? balanceError
								? "—"
								: "Loading…"
							: `${formatAccountBalance(balance)} ${config.stableToken}`}
					</strong>
					{nativeBalance !== undefined ? (
						<small>
							{formatAccountBalance(nativeBalance)}{" "}
							{config.nativeCurrency.symbol} available for fees
						</small>
					) : null}
				</div>
				<div className="account-address">
					<div className="account-address-row">
						<code>
							{wallet ? shortAddress(wallet) : "Wallet not activated"}
						</code>
						{wallet ? (
							<button
								type="button"
								className="copy-address"
								aria-label={
									addressCopied === "smart"
										? "Address copied"
										: "Copy wallet address"
								}
								title={addressCopied === "smart" ? "Copied" : "Copy address"}
								onClick={() => void copyAddress(wallet, "smart")}
							>
								{addressCopied === "smart" ? (
									<Check aria-hidden="true" />
								) : (
									<Copy aria-hidden="true" />
								)}
							</button>
						) : null}
					</div>
					<button
						type="button"
						className="button button-top-up"
						onClick={topUp}
						disabled={!wallet}
					>
						Top up <ArrowDownToLine aria-hidden="true" />
					</button>
				</div>
			</section>

			<Dialog.Root open={topUpOpen} onOpenChange={setTopUpOpen}>
				<Dialog.Portal>
					<Dialog.Overlay className="send-dialog-overlay" />
					<Dialog.Content className="send-dialog-content account-top-up-dialog">
						<div className="send-dialog-header">
							<div>
								<span className="account-label">
									{config.chainName} · {config.chainId}
								</span>
								<Dialog.Title>Top up {config.stableToken}</Dialog.Title>
								<Dialog.Description>
									Send {config.stableToken} on {config.chainName} to your
									connected wallet.
								</Dialog.Description>
							</div>
							<Dialog.Close asChild>
								<button
									type="button"
									className="send-dialog-close"
									aria-label="Close top up"
								>
									<X aria-hidden="true" />
								</button>
							</Dialog.Close>
						</div>
						<div className="account-top-up-wallet">
							<span>Deposit address</span>
							<code>{wallet}</code>
							<button
								type="button"
								className="button button-top-up account-top-up-copy"
								onClick={() => void copyAddress(wallet, "smart")}
							>
								{addressCopied === "smart" ? (
									<>
										Copied <Check aria-hidden="true" />
									</>
								) : (
									<>
										Copy address <Copy aria-hidden="true" />
									</>
								)}
							</button>
						</div>
						<p className="account-top-up-note">
							<Info aria-hidden="true" />
							<span>
								Only send {config.stableToken} on {config.chainName} to this
								address. Keep some {config.nativeCurrency.symbol} in the wallet
								for network fees.
							</span>
						</p>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog.Root>

			<section
				className="account-command-section"
				aria-labelledby="wallet-title"
			>
				<h2 id="wallet-title">Wallets</h2>
				<div className="account-wallet-list">
					<article className="account-wallet-row">
						<span className="account-row-icon account-row-icon-acid">
							<ShieldCheck aria-hidden="true" />
						</span>
						<div className="account-row-copy">
							<strong>MetaMask wallet</strong>
							<div className="wallet-role-address">
								<code>{wallet ? shortAddress(wallet) : "Not connected"}</code>
								{wallet ? (
									<button
										type="button"
										className="copy-address copy-address-compact"
										aria-label={
											addressCopied === "smart"
												? "Address copied"
												: "Copy wallet address"
										}
										onClick={() => void copyAddress(wallet, "smart")}
									>
										{addressCopied === "smart" ? (
											<Check aria-hidden="true" />
										) : (
											<Copy aria-hidden="true" />
										)}
									</button>
								) : null}
							</div>
							<span className="account-network">{config.chainName}</span>
							<small>
								<CheckCircle2 aria-hidden="true" /> Signs and funds every
								approved investment.
							</small>
						</div>
						<ChevronRight className="account-row-chevron" aria-hidden="true" />
					</article>

					<article className="account-wallet-row">
						<span className="account-row-icon">
							<Wallet aria-hidden="true" />
						</span>
						<div className="account-row-copy">
							<strong>Block explorer</strong>
							<div className="wallet-role-address">
								<code>{new URL(config.explorerUrl).host}</code>
								{wallet ? (
									<a
										className="copy-address copy-address-compact"
										href={`${config.explorerUrl}/address/${wallet}`}
										target="_blank"
										rel="noreferrer"
										aria-label="Open wallet on the block explorer"
									>
										<ChevronRight aria-hidden="true" />
									</a>
								) : null}
							</div>
							<small>
								<Info aria-hidden="true" /> Verify every settled basket
								on-chain.
							</small>
						</div>
						<ChevronRight className="account-row-chevron" aria-hidden="true" />
					</article>
				</div>
			</section>

			<section
				className="account-command-section"
				aria-labelledby="settings-title"
			>
				<div className="account-command-heading">
					<h2 id="settings-title">Your investing rules</h2>
					<button
						type="button"
						className="account-edit-button"
						aria-expanded={settingsOpen}
						onClick={() => setSettingsOpen(true)}
					>
						Edit <ChevronRight aria-hidden="true" />
					</button>
				</div>

				<div className="account-rules-list">
					<div>
						<CalendarDays aria-hidden="true" />
						<span>Invest</span>
						<strong>
							Every{" "}
							{draft.cadence === "daily"
								? "day"
								: draft.cadence === "weekly"
									? "week"
									: "month"}
						</strong>
					</div>
					<div>
						<CircleDollarSign aria-hidden="true" />
						<span>
							{draft.cadence === "weekly"
								? "Weekly limit"
								: draft.cadence === "daily"
									? "Daily limit"
									: "Monthly limit"}
						</span>
						<strong>${formatTicketSizeUsd(draft.periodLimitUsd ?? 100)}</strong>
					</div>
					<div>
						<SlidersHorizontal aria-hidden="true" />
						<span>Per swipe</span>
						<strong>${formatTicketSizeUsd(draft.ticketSizeUsd)}</strong>
					</div>
					<div>
						<ShieldCheck aria-hidden="true" />
						<span>Risk profile</span>
						<strong className="text-capitalize">{draft.riskMode}</strong>
					</div>
					<div>
						<Coins aria-hidden="true" />
						<span>Asset focus</span>
						<strong>
							{draft.assetClasses.length === 2
								? "Crypto + real-world assets"
								: draft.assetClasses[0] === "CRYPTO"
									? "Crypto"
									: draft.assetClasses[0] === "RWA"
										? "Real-world assets"
										: "None selected"}
						</strong>
					</div>
				</div>

				<Dialog.Root open={settingsOpen} onOpenChange={closeSettings}>
					<Dialog.Portal>
						<Dialog.Overlay className="send-dialog-overlay" />
						<Dialog.Content className="send-dialog-content account-settings-dialog">
							<div className="send-dialog-header">
								<div>
									<span className="account-label">Your investing rules</span>
									<Dialog.Title>Edit investing rules</Dialog.Title>
									<Dialog.Description>
										Change the preferences that shape your next investment
										session.
									</Dialog.Description>
								</div>
								<Dialog.Close asChild>
									<button
										type="button"
										className="send-dialog-close"
										aria-label="Close investment settings"
										disabled={saving}
									>
										<X aria-hidden="true" />
									</button>
								</Dialog.Close>
							</div>

							<div className="account-settings account-settings-form">
								<div className="settings-field">
									<span>When does your DCA session reset?</span>
									<SelectMenu
										ariaLabel="When does your DCA session reset? A new session is available once per selected period."
										value={draft.cadence}
										options={CADENCE_OPTIONS.map((cadence) => ({
											value: cadence,
											label: `Every ${cadence === "daily" ? "day" : cadence === "weekly" ? "week" : "month"}`,
										}))}
										onChange={(cadence) =>
											setDraft((current) => ({
												...current,
												cadence: cadence as OnboardingPreferences["cadence"],
											}))
										}
									/>
									<small>
										A new session is available once per selected period.
									</small>
								</div>

								<label className="settings-field">
									<span>Ticket size per accepted card</span>
									<div className="ticket-input">
										<b>$</b>
										<input
											type="number"
											min="0.1"
											max={draft.periodLimitUsd ?? 100}
											step="0.01"
											inputMode="decimal"
											value={formatTicketSizeUsd(draft.ticketSizeUsd)}
											onChange={(event) =>
												setDraft((current) => ({
													...current,
													ticketSizeUsd: clampTicket(event.target.value),
												}))
											}
										/>
									</div>
									<small>
										{config.stableToken} amount from $0.10 to $
										{formatTicketSizeUsd(draft.periodLimitUsd ?? 100)}, in $0.01
										increments.
									</small>
								</label>

								<fieldset className="settings-field">
									<legend>Risk preference</legend>
									<div className="settings-options">
										{RISK_OPTIONS.map((risk) => (
											<label
												key={risk}
												className={draft.riskMode === risk ? "selected" : ""}
											>
												<input
													type="radio"
													name="risk"
													checked={draft.riskMode === risk}
													onChange={() =>
														setDraft((current) => ({
															...current,
															riskMode: risk,
														}))
													}
												/>
												<b>{risk}</b>
											</label>
										))}
									</div>
								</fieldset>

								<fieldset className="settings-field">
									<legend>Assets to include</legend>
									<div className="settings-options">
										{(["CRYPTO", "RWA"] as const).map((assetClass) => {
											const selected = draft.assetClasses.includes(assetClass);
											return (
												<label
													key={assetClass}
													className={selected ? "selected" : ""}
												>
													<input
														type="checkbox"
														checked={selected}
														onChange={() =>
															setDraft((current) => ({
																...current,
																assetClasses: selected
																	? current.assetClasses.filter(
																			(item) => item !== assetClass,
																		)
																	: [...current.assetClasses, assetClass],
															}))
														}
													/>
													<b>
														{assetClass === "CRYPTO"
															? "Crypto"
															: "Real-world assets"}
													</b>
												</label>
											);
										})}
									</div>
									{!draft.assetClasses.length ? (
										<small className="settings-error">
											Choose at least one asset type.
										</small>
									) : null}
								</fieldset>

								<div className="settings-actions">
									{saveError ? <p role="alert">{saveError}</p> : null}
									<Dialog.Close asChild>
										<button
											type="button"
											className="button button-outline"
											disabled={saving}
										>
											Cancel
										</button>
									</Dialog.Close>
									<button
										type="button"
										className="button button-primary"
										disabled={saving || !draft.assetClasses.length}
										onClick={save}
									>
										{saving ? "Saving…" : "Save and refresh my feed"}
									</button>
								</div>
							</div>
						</Dialog.Content>
					</Dialog.Portal>
				</Dialog.Root>
			</section>

			<section
				className="account-command-section"
				aria-labelledby="system-settings-title"
			>
				<div className="account-command-heading">
					<h2 id="system-settings-title">Settings</h2>
					<button
						type="button"
						className="account-edit-button"
						aria-expanded={systemSettingsOpen}
						onClick={() => setSystemSettingsOpen(true)}
					>
						Edit <ChevronRight aria-hidden="true" />
					</button>
				</div>
				<div className="account-rules-list">
					<div>
						<SlidersHorizontal aria-hidden="true" />
						<span>Execution provider</span>
						<strong>{executionProviderLabel(draft.executionProvider)}</strong>
					</div>
					<div>
						<ShieldCheck aria-hidden="true" />
						<span>Feed ranking</span>
						<strong>Deterministic</strong>
					</div>
				</div>

				<Dialog.Root
					open={systemSettingsOpen}
					onOpenChange={closeSystemSettings}
				>
					<Dialog.Portal>
						<Dialog.Overlay className="send-dialog-overlay" />
						<Dialog.Content className="send-dialog-content account-settings-dialog">
							<div className="send-dialog-header">
								<div>
									<span className="account-label">Settings</span>
									<Dialog.Title>Feed and execution</Dialog.Title>
									<Dialog.Description>
										Choose how assets are ranked and where swaps are executed.
									</Dialog.Description>
								</div>
								<Dialog.Close asChild>
									<button
										type="button"
										className="send-dialog-close"
										aria-label="Close settings"
										disabled={saving}
									>
										<X aria-hidden="true" />
									</button>
								</Dialog.Close>
							</div>

							<div className="account-settings account-settings-form">
								<fieldset className="settings-field execution-provider-setting">
									<legend>Execution provider</legend>
									<p>Choose where botinvest finds and executes your swaps.</p>
									<div className="execution-provider-options">
										{(
											[
												{
													id: "BDEX",
													name: "BDEX",
													description:
														"BOT Chain liquidity and routing across V2 and V3 pools.",
												},
											] as const
										).map((provider) => {
											const available =
												executionProviders[provider.id].available;
											return (
												<label
													key={provider.id}
													className={
														draft.executionProvider === provider.id
															? "selected"
															: ""
													}
												>
													<input
														type="radio"
														name="execution-provider"
														checked={draft.executionProvider === provider.id}
														disabled={!available}
														onChange={() =>
															setDraft((current) => ({
																...current,
																executionProvider: provider.id,
															}))
														}
													/>
													<span>
														<b>{provider.name}</b>
														<small>{provider.description}</small>
														{!available ? <em>Router not configured</em> : null}
													</span>
												</label>
											);
										})}
									</div>
									<small>
										Changing provider applies to your next basket. Prepared
										quotes will be refreshed.
									</small>
								</fieldset>

								<div className="settings-field feed-ranking-setting">
									<span>Feed ranking</span>
									<small>
										Ranking is deterministic: the same candidates, budget, and
										rules always produce the same feed, and the input and output
										commitments are shown on every basket.
									</small>
								</div>

								<div className="settings-actions">
									{saveError ? <p role="alert">{saveError}</p> : null}
									<Dialog.Close asChild>
										<button
											type="button"
											className="button button-outline"
											disabled={saving}
										>
											Cancel
										</button>
									</Dialog.Close>
									<button
										type="button"
										className="button button-primary"
										disabled={saving}
										onClick={save}
									>
										{saving ? "Saving…" : "Save and refresh my feed"}
									</button>
								</div>
							</div>
						</Dialog.Content>
					</Dialog.Portal>
				</Dialog.Root>
			</section>

			<button
				type="button"
				className="account-build-button"
				onClick={() => void onSave({ ...preferences })}
			>
				<span className="account-row-icon account-row-icon-acid">
					<Plus aria-hidden="true" />
				</span>
				<div>
					<strong>Build another basket</strong>
					<small>Open a fresh session with your current rules</small>
				</div>
				<ChevronRight aria-hidden="true" />
			</button>
		</main>
	);
}

function SelectMenu({
	ariaLabel,
	value,
	options,
	onChange,
}: {
	ariaLabel: string;
	value: string;
	options: Array<{ value: string; label: string }>;
	onChange: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const selected =
		options.find((option) => option.value === value) ?? options[0];

	return (
		<div className="select-menu">
			<button
				type="button"
				className="select-trigger"
				aria-label={ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
				onKeyDown={(event) => {
					if (event.key === "Escape") setOpen(false);
				}}
			>
				<span>{selected?.label ?? "Select an option"}</span>
				<svg viewBox="0 0 16 10" aria-hidden="true">
					<path d="m1 1 7 7 7-7" />
				</svg>
			</button>
			{open ? (
				<div className="select-options" role="listbox" aria-label={ariaLabel}>
					{options.map((option) => {
						const active = option.value === value;
						return (
							<button
								type="button"
								role="option"
								aria-selected={active}
								className={active ? "selected" : ""}
								key={option.value}
								onClick={() => {
									onChange(option.value);
									setOpen(false);
								}}
							>
								{option.label}
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
}

function clampTicket(value: string) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return 0.1;
	const rounded = Math.round(parsed * 100) / 100;
	return isTicketSizeUsd(rounded)
		? rounded
		: Math.max(0.1, Math.min(100, rounded));
}

function shortAddress(address: string) {
	return `${address.slice(0, 10)}…${address.slice(-8)}`;
}

function formatAccountBalance(value: string) {
	const [whole, fraction = ""] = value.split(".");
	const compactFraction = fraction.slice(0, 6).replace(/0+$/, "");
	return compactFraction ? `${whole}.${compactFraction}` : whole;
}

function executionProviderLabel(provider: ExecutionProviderId) {
	return provider;
}
