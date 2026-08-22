import { useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import {
  isPeriodLimitUsd,
  isTicketSizeUsd,
  type OnboardingPreferences,
} from "../../domain/schemas";
import type { PublicConfig } from "../api";
import { readAccountPreferences, writeAccountPreferences } from "../preferences-storage";
import { ArrowRight, Check, Shield } from "./Icons";

type Step = "welcome" | "cadence" | "limit" | "ticket" | "risk" | "assets" | "review" | "wallet";
type RiskMode = OnboardingPreferences["riskMode"];
type AssetChoice = "CRYPTO" | "RWA" | "BOTH";

export function Onboarding({
  config,
  wallet,
  connecting,
  onConnect,
  onComplete,
  onPrefetch,
}: {
  config: PublicConfig;
  wallet?: string;
  connecting: boolean;
  onConnect: () => Promise<void>;
  onComplete: (preferences: OnboardingPreferences) => void | Promise<void>;
  onPrefetch: (preferences: OnboardingPreferences) => void;
}) {
  const [step, setStep] = useState<Step>("welcome");
  const [cadence, setCadence] = useState<OnboardingPreferences["cadence"]>("weekly");
  const [periodLimitUsd, setPeriodLimitUsd] = useState(100);
  const [ticketSizeUsd, setTicketSizeUsd] = useState(10);
  const [riskMode, setRiskMode] = useState<RiskMode>("balanced");
  const [assetChoice, setAssetChoice] = useState<AssetChoice>("BOTH");
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!wallet) return;
    const saved = readAccountPreferences(wallet);
    if (saved) {
      setCadence(saved.cadence);
      setPeriodLimitUsd(saved.periodLimitUsd ?? 100);
      setTicketSizeUsd(saved.ticketSizeUsd);
      setRiskMode(saved.riskMode);
      setAssetChoice(
        saved.assetClasses.length === 2
          ? "BOTH"
          : saved.assetClasses[0] === "RWA"
            ? "RWA"
            : "CRYPTO",
      );
    }
  }, [wallet]);

  const preferences: OnboardingPreferences | undefined =
    accepted && isPeriodLimitUsd(periodLimitUsd) && isTicketSizeUsd(ticketSizeUsd)
      ? {
          executionProvider: "BDEX",
          activeChain: "BOTCHAIN",
          feedRankingProvider: "DETERMINISTIC",
          cadence,
          periodLimitUsd,
          ticketSizeUsd,
          riskMode,
          assetClasses:
            assetChoice === "BOTH"
              ? ["CRYPTO", "RWA"]
              : [assetChoice],
          riskDisclosureAccepted: true,
        }
      : undefined;

  useEffect(() => {
    if (preferences) onPrefetch(preferences);
  }, [onPrefetch, preferences]);

  async function finish() {
    if (!preferences) return;
    if (!wallet) {
      setStep("wallet");
      return;
    }
    setBusy(true);
    setError("");
    try {
      writeAccountPreferences(wallet, preferences);
      await onComplete(preferences);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save plan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="onboarding">
      <div className="onboarding-copy">
        <span className="account-label">
          {config.chainName} · Lumora oracle · MetaMask
        </span>
        {step === "welcome" ? (
          <>
            <h1>Set a USDT budget. Swipe BOT Chain markets. Sign in MetaMask.</h1>
            <p>
              botinvest ranks live BDEX markets using{" "}
              <a href="https://lumora-oracle.vercel.app/docs" target="_blank" rel="noreferrer">
                Lumora
              </a>{" "}
              prices, then your MetaMask wallet signs every swap. The server never holds keys.
            </p>
            <button type="button" className="button button-primary" onClick={() => setStep("cadence")}>
              Start plan <ArrowRight />
            </button>
          </>
        ) : null}
        {step === "cadence" ? (
          <Choice
            title="How often should the budget reset?"
            options={[
              { id: "daily", title: "Daily", description: "A fresh limit every day." },
              { id: "weekly", title: "Weekly", description: "One basket cadence per week." },
              { id: "monthly", title: "Monthly", description: "A slower habit loop." },
            ]}
            value={cadence}
            onChange={(value) => setCadence(value as OnboardingPreferences["cadence"])}
            onNext={() => setStep("limit")}
          />
        ) : null}
        {step === "limit" ? (
          <Amount
            title="Period USDT limit"
            value={periodLimitUsd}
            onChange={setPeriodLimitUsd}
            presets={[10, 50, 100]}
            onNext={() => setStep("ticket")}
          />
        ) : null}
        {step === "ticket" ? (
          <Amount
            title="Ticket size"
            value={ticketSizeUsd}
            onChange={setTicketSizeUsd}
            presets={[0.1, 1, 10]}
            onNext={() => setStep("risk")}
          />
        ) : null}
        {step === "risk" ? (
          <Choice
            title="Risk preference"
            options={[
              { id: "conservative", title: "Conservative", description: "Prefer Lumora RWA and thicker books." },
              { id: "balanced", title: "Balanced", description: "Mix crypto and RWA signals." },
              { id: "degen", title: "Degen", description: "Lean into thinner BDEX crypto books." },
            ]}
            value={riskMode}
            onChange={(value) => setRiskMode(value as RiskMode)}
            onNext={() => setStep("assets")}
          />
        ) : null}
        {step === "assets" ? (
          <Choice
            title="What should the feed include?"
            options={[
              { id: "BOTH", title: "Crypto + RWA", description: "BDEX tokens priced by Lumora when a feed exists." },
              { id: "CRYPTO", title: "Crypto", description: "BDEX tokens and WBOT routes." },
              { id: "RWA", title: "RWA", description: "Only tokens that match a Lumora RWA feed." },
            ]}
            value={assetChoice}
            onChange={(value) => setAssetChoice(value as AssetChoice)}
            onNext={() => setStep("review")}
          />
        ) : null}
        {step === "review" || step === "wallet" ? (
          <>
            <h1>Save the plan and connect MetaMask</h1>
            <ul className="review-ledger">
              <li><span>Network</span><strong>{config.chainName} · {config.chainId}</strong></li>
              <li><span>Oracle</span><strong>Lumora</strong></li>
              <li><span>Execution</span><strong>BDEX + MetaMask</strong></li>
              <li><span>Cadence</span><strong>{cadence}</strong></li>
              <li><span>Limit</span><strong>${periodLimitUsd.toFixed(2)} USDT</strong></li>
              <li><span>Ticket</span><strong>${ticketSizeUsd.toFixed(2)} USDT</strong></li>
            </ul>
            <label className="risk-ack">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />
              <span>
                I understand this spends real USDT on BOT Chain. Quotes can fail, prices move,
                and botinvest cannot sign for me.
              </span>
            </label>
            {error ? <p className="send-error" role="alert">{error}</p> : null}
            <div className="onboarding-action">
              {!wallet ? (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void onConnect()}
                  disabled={connecting}
                >
                  <Wallet aria-hidden="true" />
                  {connecting ? "Check MetaMask…" : "Connect MetaMask"}
                </button>
              ) : (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={!preferences || busy}
                  onClick={() => void finish()}
                >
                  {busy ? "Opening session…" : "Save plan & start"} <Check />
                </button>
              )}
            </div>
            <p>
              <Shield /> Signing stays in MetaMask. Lumora prices are verified on-chain before a live basket is prepared.
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}

function Choice({
  title,
  options,
  value,
  onChange,
  onNext,
}: {
  title: string;
  options: Array<{ id: string; title: string; description: string }>;
  value: string;
  onChange: (value: string) => void;
  onNext: () => void;
}) {
  return (
    <>
      <h1>{title}</h1>
      <div className="choice-grid">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={value === option.id ? "active" : ""}
            onClick={() => onChange(option.id)}
          >
            <strong>{option.title}</strong>
            <span>{option.description}</span>
          </button>
        ))}
      </div>
      <button type="button" className="button button-primary" onClick={onNext}>
        Continue <ArrowRight />
      </button>
    </>
  );
}

function Amount({
  title,
  value,
  onChange,
  presets,
  onNext,
}: {
  title: string;
  value: number;
  onChange: (value: number) => void;
  presets: number[];
  onNext: () => void;
}) {
  return (
    <>
      <h1>{title}</h1>
      <div className="choice-grid">
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            className={value === preset ? "active" : ""}
            onClick={() => onChange(preset)}
          >
            <strong>${preset}</strong>
          </button>
        ))}
      </div>
      <label className="send-field">
        <span>Custom USD</span>
        <input
          type="number"
          min={0.1}
          step={0.01}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </label>
      <button type="button" className="button button-primary" onClick={onNext}>
        Continue <ArrowRight />
      </button>
    </>
  );
}
