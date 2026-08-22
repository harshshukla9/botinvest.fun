import type { OnboardingPreferences } from "../../domain/schemas";
import { formatTicketSizeUsd } from "../../domain/schemas";

export function BudgetRail({
  preferences,
  selectedCount,
}: {
  preferences?: OnboardingPreferences;
  selectedCount: number;
}) {
  if (!preferences) return null;
  const used = selectedCount * preferences.ticketSizeUsd;
  const limit = preferences.periodLimitUsd ?? 100;
  return (
    <aside className="budget-rail">
      <span className="account-label">USDT budget · BDEX</span>
      <strong>
        ${used.toFixed(2)} / ${limit.toFixed(2)}
      </strong>
      <small>
        {formatTicketSizeUsd(preferences.ticketSizeUsd)} USDT per card ·{" "}
        {preferences.cadence}
      </small>
    </aside>
  );
}

export function BudgetSummary({
  preferences,
  selectedCount,
}: {
  preferences?: OnboardingPreferences;
  selectedCount: number;
}) {
  return <BudgetRail preferences={preferences} selectedCount={selectedCount} />;
}
