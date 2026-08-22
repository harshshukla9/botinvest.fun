import {
	onboardingPreferencesSchema,
	type OnboardingPreferences,
} from "../domain/schemas.js";

const PREFERENCES_KEY_PREFIX = "investmade:onboarding:v3";
const LEGACY_PREFERENCES_KEY = "investmade:onboarding:v2";

export interface PreferencesStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

function browserStorage(): PreferencesStorage | undefined {
	return (globalThis as { localStorage?: PreferencesStorage }).localStorage;
}

export function preferencesKey(userId: string) {
	return `${PREFERENCES_KEY_PREFIX}:${encodeURIComponent(userId)}`;
}

export function readAccountPreferences(
	userId: string,
	storage = browserStorage(),
): OnboardingPreferences | undefined {
	if (!userId || !storage) return;
	try {
		const stored = JSON.parse(
			storage.getItem(preferencesKey(userId)) ?? "null",
		) as {
			version?: number;
			preferences?: unknown;
		} | null;
		if (stored?.version !== 3) return;
		const parsed = onboardingPreferencesSchema.safeParse(stored.preferences);
		return parsed.success ? parsed.data : undefined;
	} catch {
		return;
	}
}

export function writeAccountPreferences(
	userId: string,
	preferences: OnboardingPreferences,
	storage = browserStorage(),
) {
	if (!userId || !storage) return;
	storage.setItem(
		preferencesKey(userId),
		JSON.stringify({ version: 3, preferences }),
	);
}

export function removeAccountPreferences(
	userId: string,
	storage = browserStorage(),
) {
	if (!userId || !storage) return;
	storage.removeItem(preferencesKey(userId));
}

export function removeLegacyPreferences(storage = browserStorage()) {
	storage?.removeItem(LEGACY_PREFERENCES_KEY);
}
