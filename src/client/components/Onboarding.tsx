import { useEffect, useRef, useState } from "react";
import { Wallet } from "lucide-react";
import {
	isPeriodLimitUsd,
	isTicketSizeUsd,
	type OnboardingPreferences,
} from "../../domain/schemas";
import { api, type PublicConfig } from "../api";
import {
	readAccountPreferences,
	removeAccountPreferences,
	writeAccountPreferences,
} from "../preferences-storage";
import type { WalletSession } from "../wallet-session";
import { ChainMark } from "./ChainMark";
import { ArrowRight, Check, Shield } from "./Icons";

type Step =
	| "welcome"
	| "cadence"
	| "limit"
	| "ticket"
	| "risk"
	| "assets"
	| "review"
	| "wallet";
type RiskMode = OnboardingPreferences["riskMode"];
type AssetChoice = "CRYPTO" | "RWA" | "BOTH";
type PeriodLimitChoice = 10 | 50 | 100 | "custom";
type TicketChoice = 0.1 | 1 | 10 | "custom";

interface PreferenceDraft {
	executionProvider?: OnboardingPreferences["executionProvider"];
	feedRankingProvider?: OnboardingPreferences["feedRankingProvider"];
	cadence?: OnboardingPreferences["cadence"];
	periodLimitUsd?: number;
	periodLimitChoice?: PeriodLimitChoice;
	customPeriodLimitInput: string;
	ticketSizeUsd?: number;
	ticketChoice?: TicketChoice;
	customTicketInput: string;
	riskMode?: RiskMode;
	assetChoice?: AssetChoice;
	riskDisclosureAccepted: boolean;
}

const CADENCE_OPTIONS = [
	{
		id: "daily",
		title: "Daily limit",
		description: "One fresh basket every day.",
	},
	{
		id: "weekly",
		title: "Weekly limit",
		description: "One fresh basket every week.",
	},
	{
		id: "monthly",
		title: "Monthly limit",
		description: "One fresh basket every month.",
	},
] as const;

const PERIOD_LIMIT_OPTIONS: Array<{
	id: PeriodLimitChoice;
	title: string;
	description: string;
}> = [
	{ id: 10, title: "$10", description: "Keep it tight. Learn the flow." },
	{ id: 50, title: "$50", description: "A balanced amount for the period." },
	{ id: 100, title: "$100", description: "Set a larger period budget." },
	{ id: "custom", title: "Custom", description: "Set your DCA budget." },
];

const TICKET_OPTIONS: Array<{
	id: TicketChoice;
	title: string;
	description: string;
}> = [
	{
		id: 0.1,
		title: "$0.10",
		description: "Tiny test buy. Purely for the vibes.",
	},
	{
		id: 1,
		title: "$1",
		description: "Small conviction, low exposure.",
	},
	{
		id: 10,
		title: "$10",
		description: "One clean decision with real size.",
	},
	{
		id: "custom",
		title: "Another",
		description: "Choose your own decision size.",
	},
];

const RISK_OPTIONS: Array<{
	id: RiskMode;
	title: string;
	description: string;
	tag?: string;
}> = [
	{
		id: "conservative",
		title: "Conservative",
		description:
			"Prefer steadier signals and lower-impact routes. Value can still fall.",
	},
	{
		id: "balanced",
		title: "Balanced",
		description: "Mix opportunity and restraint across eligible markets.",
		tag: "Recommended",
	},
	{
		id: "degen",
		title: "Degen",
		description:
			"Accept more volatility in the ranking. This is not a promise of higher returns.",
	},
];

const ASSET_OPTIONS: Array<{
	id: AssetChoice;
	title: string;
	description: string;
	tag?: string;
}> = [
	{
		id: "BOTH",
		title: "A mix of both",
		description:
			"Let the ranking compare eligible crypto and real-world assets on BOT Chain.",
		tag: "Recommended",
	},
	{
		id: "CRYPTO",
		title: "Crypto",
		description: "Show crypto tokens with live BDEX liquidity.",
	},
	{
		id: "RWA",
		title: "Real-world assets",
		description:
			"Show commodity, equity, and treasury assets priced by the Lumora oracle.",
	},
];

export function Onboarding({
	config,
	walletSession,
	onComplete,
	onPrefetch,
}: {
	config: PublicConfig;
	walletSession: WalletSession;
	onComplete: (preferences: OnboardingPreferences) => void | Promise<void>;
	onPrefetch: (preferences: OnboardingPreferences) => void;
}) {
	const { authenticated, connecting, wallet } = walletSession;
	const [step, setStep] = useState<Step>("welcome");
	const [draft, setDraft] = useState<PreferenceDraft>(emptyDraft);
	const [error, setError] = useState("");
	const completingPlan = useRef(false);
	const pendingPlan = useRef(false);
	const hydratedWallet = useRef<string | undefined>(undefined);
	const completedPreferences = toCompletedPreferences(draft);
	const busy = connecting;

	useEffect(() => {
		setError(walletSession.error);
	}, [walletSession.error]);

	useEffect(() => {
		const account = authenticated ? wallet : undefined;
		if (!account || pendingPlan.current || hydratedWallet.current === account)
			return;
		hydratedWallet.current = account;
		let cancelled = false;
		api
			.preferences()
			.catch(() => readAccountPreferences(account))
			.then((storedPreferences) => {
				if (cancelled || !storedPreferences) return;
				setDraft(draftFromPreferences(storedPreferences));
				setStep("wallet");
			});
		return () => {
			cancelled = true;
		};
	}, [authenticated, wallet]);

	useEffect(() => {
		if (step === "welcome") return;
		requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
	}, [step]);

	useEffect(() => {
		if (step !== "wallet" || !completedPreferences) return;
		if (!authenticated || !wallet) return;
		writeAccountPreferences(wallet, completedPreferences);
		if (completingPlan.current) return;
		completingPlan.current = true;
		void onComplete(completedPreferences);
	}, [authenticated, completedPreferences, onComplete, step, wallet]);

	async function connect() {
		if (!walletSession.ready || busy) return;
		setError("");
		await walletSession.connect();
	}

	function savePlan() {
		const preferences = toCompletedPreferences(draft);
		if (!preferences) return;
		pendingPlan.current = true;
		if (authenticated && wallet) {
			writeAccountPreferences(wallet, preferences);
			onPrefetch(preferences);
		}
		setStep("wallet");
	}

	function changeAnswers() {
		if (authenticated && wallet) removeAccountPreferences(wallet);
		completingPlan.current = false;
		pendingPlan.current = false;
		hydratedWallet.current = authenticated ? wallet : undefined;
		setDraft(emptyDraft());
		setStep("welcome");
		requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
	}

	return (
		<main
			className={`onboarding-page${step === "welcome" ? "" : " onboarding-focused"}`}
		>
			<section className="onboarding-copy">
				<span className="eyebrow">Your investment plan</span>
				<h1>
					Stocks and crypto. One <span className="headline-fun">fun</span>{" "}
					ritual.
				</h1>
				<p>
					Set your rules, swipe through real-world assets and crypto, and turn
					DCA into a ritual you&apos;ll actually enjoy. Lumora signs every price
					on BOT Chain; your preset limit keeps each session in bounds, and
					nothing moves until you approve it in MetaMask.
				</p>
				<div className="onboarding-connect-control">
					<ChainConnectSelector chainName={config.chainName} />
					<button
						type="button"
						className="button button-primary onboarding-connect-button"
						onClick={connect}
						disabled={busy || !walletSession.ready}
						aria-label="Connect wallet with MetaMask"
						title="Connect wallet with MetaMask"
					>
						<Wallet size={18} strokeWidth={1.8} />
						{busy ? "Waiting…" : "Connect MetaMask"}
					</button>
				</div>
				<div className="onboarding-points">
					<p>
						<span>1</span>
						<b>Set your rules</b>
						<small>
							Choose your investment schedule, spending limit, and amount for
							each decision.
						</small>
					</p>
					<p>
						<span>2</span>
						<b>Your personalized asset feed</b>
						<small>
							Your preferences shape a feed of eligible assets, informed by live
							market data.
						</small>
					</p>
					<p>
						<span>3</span>
						<b>Review and approve</b>
						<small>
							Policy checks every route. You review the basket and your wallet
							signs once.
						</small>
					</p>
				</div>
			</section>

			<section className="onboarding-action">
				{isQuestionStep(step) ? (
					<QuestionFlow
						step={step}
						draft={draft}
						onDraft={setDraft}
						onStep={setStep}
						onSave={savePlan}
					/>
				) : (
					<>
						<Shield />
						<span className="onboarding-kicker">Plan saved</span>
						<h2>Connect your MetaMask wallet</h2>
						<p>
							One wallet · one signed basket · {config.chainName} ·{" "}
							{config.chainId}
						</p>
						{completedPreferences ? (
							<PlanSummary preferences={completedPreferences} compact />
						) : null}
						{error ? (
							<div className="error-message" role="alert">
								{error}
							</div>
						) : null}
						<ChainConnectSelector chainName={config.chainName} />
						<button
							type="button"
							className="button button-primary"
							onClick={connect}
							disabled={busy || !walletSession.ready || authenticated}
						>
							{busy
								? "Waiting…"
								: authenticated
									? "Wallet connected"
									: "Continue with MetaMask"}{" "}
							<ArrowRight />
						</button>
						<button
							type="button"
							className="onboarding-text-button"
							onClick={changeAnswers}
						>
							Change my answers
						</button>
						<small>
							Non-custodial. No trading mandate. No autonomous execution.
						</small>
					</>
				)}
			</section>
		</main>
	);
}

function ChainConnectSelector({ chainName }: { chainName: string }) {
	return (
		<fieldset className="onboarding-chain-selector">
			<legend className="sr-only">Wallet chain</legend>
			<button type="button" className="active" aria-pressed="true" disabled>
				<ChainMark chain="BOTCHAIN" />
				<span>{chainName}</span>
			</button>
		</fieldset>
	);
}

function QuestionFlow({
	step,
	draft,
	onDraft,
	onStep,
	onSave,
}: {
	step: Extract<
		Step,
		"welcome" | "cadence" | "limit" | "ticket" | "risk" | "assets" | "review"
	>;
	draft: PreferenceDraft;
	onDraft: React.Dispatch<React.SetStateAction<PreferenceDraft>>;
	onStep: (step: Step) => void;
	onSave: () => void;
}) {
	const questionNumber =
		["cadence", "limit", "ticket", "risk", "assets"].indexOf(step) + 1;

	if (step === "welcome") {
		return (
			<>
				<span className="onboarding-kicker">New here?</span>
				<h2>Build your investing AI assistant</h2>
				<p>
					Set your period, cap, and decision size. AI handles the feed. Your
					money stays in your wallet until you review and approve a basket.
				</p>
				<button
					type="button"
					className="button button-primary"
					onClick={() => onStep("cadence")}
				>
					Answer 5 questions <ArrowRight />
				</button>
			</>
		);
	}

	return (
		<>
			{step !== "review" ? (
				<div className="question-progress">
					<span>Question {questionNumber} of 5</span>
					<div aria-hidden="true">
						{[1, 2, 3, 4, 5].map((number) => (
							<i
								className={number <= questionNumber ? "active" : ""}
								key={number}
							/>
						))}
					</div>
				</div>
			) : null}

			{step === "cadence" ? (
				<>
					<span className="onboarding-kicker">Your pace</span>
					<h2>Investment period</h2>
					<p>
						Choose when your limit resets. Keep it simple and stick to the plan.
					</p>
					<div className="question-options">
						{CADENCE_OPTIONS.map((option) => (
							<button
								type="button"
								className={
									draft.cadence === option.id
										? "question-option selected"
										: "question-option"
								}
								onClick={() =>
									onDraft((current) => ({ ...current, cadence: option.id }))
								}
								key={option.id}
							>
								<span>
									<b>{option.title}</b>
								</span>
								<small>{option.description}</small>
								{draft.cadence === option.id ? <Check /> : null}
							</button>
						))}
					</div>
					<QuestionActions
						back={() => onStep("welcome")}
						next={() => onStep("limit")}
						nextDisabled={!draft.cadence}
					/>
				</>
			) : null}

			{step === "limit" ? (
				<>
					<span className="onboarding-kicker">Your cap</span>
					<h2>Set this limit</h2>
					<p>
						Your max spend for each period. Nothing goes out until you approve a
						basket.
					</p>
					<div className="question-options ticket-options">
						{PERIOD_LIMIT_OPTIONS.map((option) => (
							<button
								type="button"
								className={
									draft.periodLimitChoice === option.id
										? "question-option selected"
										: "question-option"
								}
								onClick={() =>
									onDraft((current) => ({
										...current,
										periodLimitChoice: option.id,
										periodLimitUsd:
											typeof option.id === "number"
												? option.id
												: customPeriodLimit(current.customPeriodLimitInput),
									}))
								}
								key={option.id}
							>
								<span>
									<b>{option.title}</b>
									{option.id === 50 ? <em>Popular</em> : null}
								</span>
								<small>{option.description}</small>
								{draft.periodLimitChoice === option.id ? <Check /> : null}
							</button>
						))}
					</div>
					{draft.periodLimitChoice === "custom" ? (
						<label className="custom-ticket">
							<span>Custom period limit</span>
							<span>
								<b>$</b>
								<input
									type="number"
									min="0.1"
									step="0.01"
									inputMode="decimal"
									value={draft.customPeriodLimitInput}
									onChange={(event) => {
										const value = event.target.value;
										onDraft((current) => ({
											...current,
											customPeriodLimitInput: value,
											periodLimitUsd: customPeriodLimit(value),
										}));
									}}
									placeholder="0.10"
								/>
							</span>
							<small>Your DCA budget is the basket limit.</small>
						</label>
					) : null}
					<QuestionActions
						back={() => onStep("cadence")}
						next={() => onStep("ticket")}
						nextDisabled={!draft.periodLimitUsd}
					/>
				</>
			) : null}

			{step === "ticket" ? (
				<>
					<span className="onboarding-kicker">Your move</span>
					<h2>What will one investment decision be?</h2>
					<p>Each tap uses this amount. Stay inside your period limit.</p>
					<div className="question-options ticket-options">
						{TICKET_OPTIONS.map((option) => (
							<button
								type="button"
								className={
									draft.ticketChoice === option.id
										? "question-option selected"
										: "question-option"
								}
								onClick={() =>
									onDraft((current) => ({
										...current,
										ticketChoice: option.id,
										ticketSizeUsd:
											typeof option.id === "number"
												? option.id
												: customTicket(current.customTicketInput),
									}))
								}
								key={option.id}
							>
								<span>
									<b>{option.title}</b>
									{option.id === 1 ? <em>Easy start</em> : null}
								</span>
								<small>{option.description}</small>
								{draft.ticketChoice === option.id ? <Check /> : null}
							</button>
						))}
					</div>
					{draft.ticketChoice === "custom" ? (
						<label className="custom-ticket">
							<span>Custom ticket size</span>
							<span>
								<b>$</b>
								<input
									type="number"
									min="0.1"
									max={draft.periodLimitUsd ?? 100}
									step="0.01"
									inputMode="decimal"
									value={draft.customTicketInput}
									onChange={(event) => {
										const value = event.target.value;
										onDraft((current) => ({
											...current,
											customTicketInput: value,
											ticketSizeUsd: customTicket(value),
										}));
									}}
									placeholder={`Up to ${draft.periodLimitUsd ?? 100}.00`}
									aria-describedby="custom-ticket-help"
								/>
							</span>
							<small id="custom-ticket-help">
								{`USDT amount up to your ${draft.periodLimitUsd ?? 100}.00 DCA budget.`}
							</small>
						</label>
					) : null}
					<QuestionActions
						back={() => onStep("limit")}
						next={() => onStep("risk")}
						nextDisabled={
							!draft.ticketSizeUsd ||
							draft.ticketSizeUsd > (draft.periodLimitUsd ?? 100)
						}
					/>
				</>
			) : null}

			{step === "risk" ? (
				<>
					<span className="onboarding-kicker">Risk preference</span>
					<h2>How should we rank opportunity?</h2>
					<p>This changes ranking, not deterministic safety checks.</p>
					<div className="question-options">
						{RISK_OPTIONS.map((option) => (
							<button
								type="button"
								className={
									draft.riskMode === option.id
										? "question-option selected"
										: "question-option"
								}
								onClick={() =>
									onDraft((current) => ({ ...current, riskMode: option.id }))
								}
								key={option.id}
							>
								<span>
									<b>{option.title}</b>
									{option.tag ? <em>{option.tag}</em> : null}
								</span>
								<small>{option.description}</small>
								{draft.riskMode === option.id ? <Check /> : null}
							</button>
						))}
					</div>
					<QuestionActions
						back={() => onStep("ticket")}
						next={() => onStep("assets")}
						nextDisabled={!draft.riskMode}
					/>
				</>
			) : null}

			{step === "assets" ? (
				<>
					<span className="onboarding-kicker">Asset mix</span>
					<h2>What can appear in your feed?</h2>
					<p>
						Assets appear only when Lumora has a fresh price and BDEX has an
						executable route.
					</p>
					<div className="question-options">
						{ASSET_OPTIONS.map((option) => (
							<button
								type="button"
								className={
									draft.assetChoice === option.id
										? "question-option selected"
										: "question-option"
								}
								onClick={() =>
									onDraft((current) => ({
										...current,
										assetChoice: option.id,
									}))
								}
								key={option.id}
							>
								<span>
									<b>{option.title}</b>
									{option.tag ? <em>{option.tag}</em> : null}
								</span>
								<small>{option.description}</small>
								{draft.assetChoice === option.id ? <Check /> : null}
							</button>
						))}
					</div>
					<QuestionActions
						back={() => onStep("risk")}
						next={() => onStep("review")}
						nextDisabled={!draft.assetChoice}
					/>
				</>
			) : null}

			{step === "review" ? (
				<>
					<span className="onboarding-kicker">Review</span>
					<h2>Your investment plan</h2>
					<PlanSummary preferences={toPreviewPreferences(draft)} />
					<label className="risk-acknowledgement">
						<input
							type="checkbox"
							checked={draft.riskDisclosureAccepted}
							onChange={(event) =>
								onDraft((current) => ({
									...current,
									riskDisclosureAccepted: event.target.checked,
								}))
							}
						/>
						<span>
							I understand the ranking is not financial advice; assets can lose
							value; oracle prices can go stale; and every trade requires my
							MetaMask approval.
						</span>
					</label>
					<QuestionActions
						back={() => onStep("assets")}
						next={onSave}
						nextLabel="Save plan & connect"
						nextDisabled={!draft.riskDisclosureAccepted}
					/>
				</>
			) : null}
		</>
	);
}

function QuestionActions({
	back,
	next,
	nextDisabled,
	nextLabel = "Continue",
}: {
	back: () => void;
	next: () => void;
	nextDisabled: boolean;
	nextLabel?: string;
}) {
	return (
		<div className="question-actions">
			<button type="button" className="button button-outline" onClick={back}>
				Back
			</button>
			<button
				type="button"
				className="button button-primary"
				onClick={next}
				disabled={nextDisabled}
			>
				{nextLabel} <ArrowRight />
			</button>
		</div>
	);
}

function PlanSummary({
	preferences,
	compact = false,
}: {
	preferences: OnboardingPreferences;
	compact?: boolean;
}) {
	const risk = RISK_OPTIONS.find(
		(option) => option.id === preferences.riskMode,
	)?.title;
	const assets =
		preferences.assetClasses.length === 2
			? "Crypto + real-world assets"
			: preferences.assetClasses[0] === "CRYPTO"
				? "Crypto"
				: "Real-world assets";
	const stableToken = "USDT";
	return (
		<div className={compact ? "plan-summary compact" : "plan-summary"}>
			<p>
				<span>Frequency</span>
				<b>{cadenceLabel(preferences.cadence)}</b>
			</p>
			<p>
				<span>Ticket size</span>
				<b>
					{preferences.ticketSizeUsd} {stableToken} per card
				</b>
			</p>
			<p>
				<span>Period limit</span>
				<b>
					{preferences.periodLimitUsd ?? 100} {stableToken} total
				</b>
			</p>
			<p>
				<span>Risk mode</span>
				<b>{risk}</b>
			</p>
			<p>
				<span>Asset mix</span>
				<b>{assets}</b>
			</p>
		</div>
	);
}

function isQuestionStep(
	step: Step,
): step is Extract<
	Step,
	"welcome" | "cadence" | "limit" | "ticket" | "risk" | "assets" | "review"
> {
	return [
		"welcome",
		"cadence",
		"limit",
		"ticket",
		"risk",
		"assets",
		"review",
	].includes(step);
}

function assetClassesFrom(
	choice?: AssetChoice,
): OnboardingPreferences["assetClasses"] {
	if (choice === "CRYPTO") return ["CRYPTO"];
	if (choice === "RWA") return ["RWA"];
	if (choice === "BOTH") return ["CRYPTO", "RWA"];
	return [];
}

function assetChoiceFrom(
	assetClasses: OnboardingPreferences["assetClasses"],
): AssetChoice {
	return assetClasses.length === 2 ? "BOTH" : (assetClasses[0] ?? "BOTH");
}

function toCompletedPreferences(
	draft: PreferenceDraft,
): OnboardingPreferences | undefined {
	const assetClasses = assetClassesFrom(draft.assetChoice);
	if (
		!draft.cadence ||
		!draft.periodLimitUsd ||
		!draft.ticketSizeUsd ||
		draft.ticketSizeUsd > draft.periodLimitUsd ||
		!draft.riskMode ||
		!assetClasses.length ||
		!draft.riskDisclosureAccepted
	)
		return;
	return {
		executionProvider: "BDEX",
		activeChain: "BOTCHAIN",
		feedRankingProvider: draft.feedRankingProvider ?? "DETERMINISTIC",
		cadence: draft.cadence,
		periodLimitUsd: draft.periodLimitUsd,
		ticketSizeUsd: draft.ticketSizeUsd,
		riskMode: draft.riskMode,
		assetClasses,
		riskDisclosureAccepted: true,
	};
}

function toPreviewPreferences(draft: PreferenceDraft): OnboardingPreferences {
	return {
		executionProvider: "BDEX",
		activeChain: "BOTCHAIN",
		feedRankingProvider: draft.feedRankingProvider ?? "DETERMINISTIC",
		cadence: draft.cadence ?? "weekly",
		periodLimitUsd: draft.periodLimitUsd ?? 100,
		ticketSizeUsd: draft.ticketSizeUsd ?? 10,
		riskMode: draft.riskMode ?? "balanced",
		assetClasses: assetClassesFrom(draft.assetChoice),
		riskDisclosureAccepted: true,
	};
}

function emptyDraft(): PreferenceDraft {
	return {
		executionProvider: "BDEX",
		feedRankingProvider: "DETERMINISTIC",
		customPeriodLimitInput: "",
		customTicketInput: "",
		riskDisclosureAccepted: false,
	};
}

function draftFromPreferences(
	preferences: OnboardingPreferences,
): PreferenceDraft {
	return {
		executionProvider: preferences.executionProvider,
		feedRankingProvider: preferences.feedRankingProvider,
		cadence: preferences.cadence,
		periodLimitUsd: preferences.periodLimitUsd ?? 100,
		periodLimitChoice: isPresetPeriodLimit(preferences.periodLimitUsd ?? 100)
			? ((preferences.periodLimitUsd ?? 100) as 10 | 50 | 100)
			: "custom",
		customPeriodLimitInput: isPresetPeriodLimit(
			preferences.periodLimitUsd ?? 100,
		)
			? ""
			: String(preferences.periodLimitUsd),
		ticketSizeUsd: preferences.ticketSizeUsd,
		ticketChoice: isPresetTicket(preferences.ticketSizeUsd)
			? preferences.ticketSizeUsd
			: "custom",
		customTicketInput: isPresetTicket(preferences.ticketSizeUsd)
			? ""
			: String(preferences.ticketSizeUsd),
		riskMode: preferences.riskMode,
		assetChoice: assetChoiceFrom(preferences.assetClasses),
		riskDisclosureAccepted: true,
	};
}

function customTicket(value: string): number | undefined {
	const parsed = Number(value);
	const rounded = Math.round(parsed * 100) / 100;
	return isTicketSizeUsd(rounded) ? rounded : undefined;
}

function customPeriodLimit(value: string): number | undefined {
	const parsed = Number(value);
	const rounded = Math.round(parsed * 100) / 100;
	return isPeriodLimitUsd(rounded) ? rounded : undefined;
}

function isPresetPeriodLimit(value: number): value is 10 | 50 | 100 {
	return value === 10 || value === 50 || value === 100;
}

function isPresetTicket(value: number): value is 0.1 | 1 | 10 {
	return value === 0.1 || value === 1 || value === 10;
}

function cadenceLabel(cadence: OnboardingPreferences["cadence"]) {
	if (cadence === "daily") return "Every day";
	if (cadence === "monthly") return "Every month";
	return "Every week";
}
