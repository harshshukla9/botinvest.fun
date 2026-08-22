export interface PortfolioAsset {
  rawBalance: string;
  decimals: number;
  currentPriceUsd: number;
  history?: {
    period?: "1M";
    source?: "coingecko" | "demo" | "unavailable";
    points: Array<{ timestamp: number; price: number }>;
  };
}

export interface PortfolioSnapshot {
  currentValueUsd: number;
  changeUsd: number | null;
  changePercent: number | null;
  points: Array<{ timestamp: number; value: number }>;
}

export function calculatePortfolioSnapshot(assets: PortfolioAsset[]): PortfolioSnapshot {
  const holdings = assets
    .map((asset) => ({
      ...asset,
      units: Number(asset.rawBalance) / 10 ** asset.decimals,
      historyPoints: [...(asset.history?.points ?? [])].sort(
        (left, right) => left.timestamp - right.timestamp
      )
    }))
    .filter(
      (asset) =>
        Number.isFinite(asset.units) &&
        asset.units > 0 &&
        Number.isFinite(asset.currentPriceUsd) &&
        asset.currentPriceUsd >= 0
    );

  const currentValueUsd = holdings.reduce(
    (sum, asset) => sum + asset.units * asset.currentPriceUsd,
    0
  );
  const timestamps = [
    ...new Set(holdings.flatMap((asset) => asset.historyPoints.map((point) => point.timestamp)))
  ].sort((left, right) => left - right);

  if (!timestamps.length) {
    return { currentValueUsd, changeUsd: null, changePercent: null, points: [] };
  }

  const points = timestamps.map((timestamp) => ({
    timestamp,
    value: holdings.reduce((total, asset) => {
      const historical = [...asset.historyPoints]
        .reverse()
        .find((point) => point.timestamp <= timestamp);
      const lastHistoricalPrice = asset.historyPoints.at(-1)?.price;
      const historyScale =
        lastHistoricalPrice && lastHistoricalPrice > 0
          ? asset.currentPriceUsd / lastHistoricalPrice
          : 1;
      const price =
        historical?.price !== undefined
          ? historical.price * historyScale
          : asset.currentPriceUsd;
      return total + asset.units * price;
    }, 0)
  }));

  points[points.length - 1] = {
    timestamp: points.at(-1)?.timestamp ?? Date.now(),
    value: currentValueUsd
  };
  const startingValueUsd = points[0]?.value ?? currentValueUsd;
  const changeUsd = currentValueUsd - startingValueUsd;

  return {
    currentValueUsd,
    changeUsd,
    changePercent: startingValueUsd > 0 ? (changeUsd / startingValueUsd) * 100 : null,
    points
  };
}
