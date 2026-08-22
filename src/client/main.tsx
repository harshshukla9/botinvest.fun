import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import "@fontsource/archivo-black/400.css";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import { App } from "./App";
import { api, type PublicConfig } from "./api";
import { BOT_NETWORKS } from "../domain/constants";
import { createWagmiConfig } from "./chain";
import "./styles.css";

const queryClient = new QueryClient();

function Root() {
  const [config, setConfig] = useState<PublicConfig>();
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : "Could not load botinvest configuration"),
      );
  }, []);

  const wagmiConfig = useMemo(() => {
    if (!config) return;
    return createWagmiConfig(BOT_NETWORKS[config.network]);
  }, [config]);

  if (error) {
    return (
      <main className="fatal-state">
        <h1>botinvest is unavailable</h1>
        <p>{error}</p>
      </main>
    );
  }
  if (!config || !wagmiConfig) {
    return (
      <main className="loading-state">
        <span />
        <h1>Loading botinvest</h1>
      </main>
    );
  }

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App config={config} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing");

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
