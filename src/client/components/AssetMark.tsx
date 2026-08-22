import { createContext, useContext, type ReactNode } from "react";

const AssetIconsContext = createContext<Record<string, string>>({});

export function AssetIconProvider({ children }: { children: ReactNode }) {
  return (
    <AssetIconsContext.Provider value={{}}>{children}</AssetIconsContext.Provider>
  );
}

export function AssetMark({
  symbol,
  iconUrl,
  size = "md",
}: {
  symbol: string;
  iconUrl?: string;
  size?: "sm" | "md" | "lg";
}) {
  const registered = useContext(AssetIconsContext)[symbol];
  const src = iconUrl ?? registered;
  return (
    <span className={`asset-mark size-${size}`} aria-hidden="true">
      {src ? <img src={src} alt="" /> : symbol.slice(0, 1)}
    </span>
  );
}
