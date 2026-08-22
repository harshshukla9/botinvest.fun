export type AssetTagTone = "default" | "rwa" | "crypto";

export interface VisibleAssetTag {
  label: string;
  source: string;
  tone: AssetTagTone;
}

export const ASSET_TAG_CONFIG = {
  labels: {
    EQUITIES: "Equity",
    ENERGY: "Energy",
    METALS: "Metal",
    FX: "FX",
    TREASURY: "Treasury",
    INDICES: "Index",
    CRYPTO: "Crypto",
    DIGITAL: "Digital",
    BDEX: "BDEX",
    LUMORA: "Lumora",
  } as Record<string, string>,
  hiddenExact: [] as string[],
  hiddenPatterns: [] as RegExp[],
  tonePatterns: {
    rwa: /^(EQUITIES|ENERGY|METALS|FX|TREASURY|INDICES)$/i,
    crypto: /^(CRYPTO|DIGITAL|BDEX)$/i,
  },
} as const;

export function visibleAssetTags(categories: string[]): VisibleAssetTag[] {
  return categories
    .filter((category) => !isHiddenAssetTag(category))
    .map((source, index) => ({
      index,
      label: ASSET_TAG_CONFIG.labels[source] ?? source,
      source,
      tone: assetTagTone(source),
      priority: ASSET_TAG_CONFIG.tonePatterns.rwa.test(source) ? 0 : 1,
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ index: _index, priority: _priority, ...tag }) => tag);
}

function isHiddenAssetTag(category: string) {
  const normalized = category.trim().toLowerCase();
  return (
    ASSET_TAG_CONFIG.hiddenExact.some(
      (hidden) => hidden.toLowerCase() === normalized,
    ) || ASSET_TAG_CONFIG.hiddenPatterns.some((pattern) => pattern.test(category))
  );
}

function assetTagTone(category: string): AssetTagTone {
  if (ASSET_TAG_CONFIG.tonePatterns.rwa.test(category)) return "rwa";
  if (ASSET_TAG_CONFIG.tonePatterns.crypto.test(category)) return "crypto";
  return "default";
}
