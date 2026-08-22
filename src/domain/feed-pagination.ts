export function nextFeedExcludedAssetIds(
  feed: { candidates: Array<{ assetId: string }> },
) {
  return feed.candidates.map(({ assetId }) => assetId);
}

export function fillFeedPage<T>(items: T[], size = 10): T[] {
  return items.slice(0, size);
}

export function shouldPrefetchNextFeed(index: number, loadedCount: number) {
  // ponytail: keep one fixed 10-card page warm; generalize if page size becomes configurable.
  return loadedCount > 0 && index >= loadedCount - 10;
}
