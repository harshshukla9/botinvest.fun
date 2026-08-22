import { useCallback, useEffect, useState } from "react";
import { SiweMessage } from "siwe";
import { useAccount, useConnect, useSignMessage, useSwitchChain } from "wagmi";
import {
  fillFeedPage,
  nextFeedExcludedAssetIds,
  shouldPrefetchNextFeed,
} from "../domain/feed-pagination";
import type { Candidate, OnboardingPreferences } from "../domain/schemas";
import { ApiError, api, configureApiAuth, type ExecutionRecord, type FeedResponse, type PublicConfig, type WeeklySession } from "./api";
import { metamaskAddChainParams } from "./chain";
import { AccountScreen } from "./components/AccountScreen";
import { AppShell } from "./components/AppShell";
import { AssetIconProvider } from "./components/AssetMark";
import { BudgetRail } from "./components/BudgetRail";
import { Confetti } from "./components/magicui/confetti";
import { Onboarding } from "./components/Onboarding";
import { PositionsScreen } from "./components/PositionsScreen";
import { ReceiptScreen } from "./components/ReceiptScreen";
import { ReviewScreen } from "./components/ReviewScreen";
import { SwipeCard } from "./components/SwipeCard";
import { writeAccountPreferences } from "./preferences-storage";

type View = "week" | "positions" | "receipts" | "account";
type Stage = "loading" | "onboarding" | "swipe" | "review";

export function App({ config }: { config: PublicConfig }) {
  const { address, isConnected, chainId } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const [token, setToken] = useState<string>();
  const [view, setView] = useState<View>("week");
  const [stage, setStage] = useState<Stage>("onboarding");
  const [session, setSession] = useState<WeeklySession>();
  const [feed, setFeed] = useState<FeedResponse>();
  const [preferences, setPreferences] = useState<OnboardingPreferences>();
  const [index, setIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [settlement, setSettlement] = useState<ExecutionRecord>();
  const [receiptCandidates, setReceiptCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState("");
  const [decisionFeedback, setDecisionFeedback] = useState<"invest" | "skip">();
  const [celebrate, setCelebrate] = useState(false);
  const wallet = address?.toLowerCase() ?? "";
  const authenticated = Boolean(token && wallet);

  useEffect(() => {
    configureApiAuth({ token, wallet });
    return () => configureApiAuth(undefined);
  }, [token, wallet]);

  const ensureNetwork = useCallback(async () => {
    if (chainId === config.chainId) return;
    try {
      await switchChainAsync({ chainId: config.chainId });
    } catch {
      const provider = window.ethereum;
      if (!provider?.request) throw new Error("MetaMask is not available.");
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: `0x${config.chainId.toString(16)}` }],
        });
      } catch (switchError) {
        const code = (switchError as { code?: number }).code;
        if (code !== 4902) throw switchError;
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            metamaskAddChainParams({
              name: config.network,
              chainId: config.chainId === 677 ? 677 : 968,
              rpcUrl: config.rpcUrl,
              explorerUrl: config.explorerUrl,
              nativeCurrency: config.nativeCurrency,
              usdt: config.usdt as `0x${string}`,
              wbot: config.wbot as `0x${string}`,
              multicall3: "0x47FA21f684bBAD707A53a0f9BE59F1422F46C265",
              permit2: "0x0000000000000000000000000000000000000000",
              universalRouter: "0x0000000000000000000000000000000000000000",
              v2Factory: "0x0000000000000000000000000000000000000000",
              v2Router: "0x0000000000000000000000000000000000000000",
              v2PairInitCodeHash: "0x00",
              v3Factory: "0x0000000000000000000000000000000000000000",
              v3SwapRouter: "0x0000000000000000000000000000000000000000",
              v3Quoter: "0x0000000000000000000000000000000000000000",
              lumoraOracle: config.lumora.oracle as `0x${string}`,
              lumoraConsumer: config.lumora.consumer as `0x${string}`,
            }),
          ],
        });
      }
    }
  }, [chainId, config, switchChainAsync]);

  const connectWallet = useCallback(async () => {
    const connector = connectors.find((item) => item.id === "injected" || item.name === "MetaMask") ?? connectors[0];
    if (!connector) throw new Error("MetaMask was not found. Install the MetaMask extension.");
    const connected = isConnected
      ? { accounts: address ? [address] : [] }
      : await connectAsync({ connector });
    const connectedAddress = connected.accounts[0] ?? address;
    await ensureNetwork();
    const { nonce } = await api.nonce();
    if (!connectedAddress) throw new Error("MetaMask did not return an address.");
    const message = new SiweMessage({
      domain: window.location.host,
      address: connectedAddress,
      statement: "Sign in to botinvest on BOT Chain.",
      uri: window.location.origin,
      version: "1",
      chainId: config.chainId,
      nonce,
    }).prepareMessage();
    const signature = await signMessageAsync({ message });
    const verified = await api.verify(message, signature);
    setToken(verified.token);
  }, [address, config.chainId, connectAsync, connectors, ensureNetwork, isConnected, signMessageAsync]);

  const loadSession = useCallback(
    async (nextPreferences: OnboardingPreferences) => {
      setStage("loading");
      setError("");
      setPreferences(nextPreferences);
      try {
        if (wallet) writeAccountPreferences(wallet, nextPreferences);
        await api.savePreferences(nextPreferences);
        const opened = await api.openSession(nextPreferences.cadence);
        const generated = await api.generateFeed(opened.id, nextPreferences);
        setSession(opened);
        setFeed({ ...generated, candidates: fillFeedPage(generated.candidates) });
        setIndex(0);
        setSelectedIds([]);
        setStage("swipe");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not open a BOT Chain session.");
        setStage("swipe");
      }
    },
    [wallet],
  );

  useEffect(() => {
    if (!authenticated || preferences || !wallet) return;
    api
      .preferences()
      .then((result) => {
        if (result.preferences) void loadSession(result.preferences);
      })
      .catch(() => undefined);
  }, [authenticated, loadSession, preferences, wallet]);

  const candidates = feed?.candidates ?? [];
  const current = candidates[index];
  const selected = selectedIds
    .map((assetId) => candidates.find((candidate) => candidate.assetId === assetId))
    .filter((candidate): candidate is Candidate => Boolean(candidate));
  const ticketSizeUsd = preferences?.ticketSizeUsd ?? 10;
  const periodLimitUsd = preferences?.periodLimitUsd ?? 100;
  const canAdd = selected.length * ticketSizeUsd + ticketSizeUsd <= periodLimitUsd;

  useEffect(() => {
    if (!feed?.hasMore || !shouldPrefetchNextFeed(index, candidates.length) || !session || !preferences) {
      return;
    }
    void api
      .generateFeed(session.id, preferences, nextFeedExcludedAssetIds(feed))
      .then((next) => {
        setFeed((currentFeed) => {
          if (!currentFeed) return next;
          return {
            ...next,
            candidates: [...currentFeed.candidates, ...fillFeedPage(next.candidates)],
            feed: {
              ...next.feed,
              cards: [...currentFeed.feed.cards, ...next.feed.cards],
            },
          };
        });
      })
      .catch((caught) => {
        if (!(caught instanceof ApiError && caught.code === "NO_ELIGIBLE_CANDIDATES_FOR_PREFERENCES")) {
          console.error(caught);
        }
      });
  }, [candidates.length, feed, index, preferences, session]);

  function decide(action: "invest" | "skip") {
    if (!current) return;
    setDecisionFeedback(action);
    if (action === "invest" && canAdd) {
      setSelectedIds((currentIds) => [...currentIds, current.assetId]);
    }
    window.setTimeout(() => {
      setDecisionFeedback(undefined);
      setIndex((value) => value + 1);
    }, 280);
  }

  function disconnect() {
    setToken(undefined);
    configureApiAuth(undefined);
    setStage("onboarding");
    setSession(undefined);
    setFeed(undefined);
    setPreferences(undefined);
    setSelectedIds([]);
    setSettlement(undefined);
  }

  return (
    <AssetIconProvider>
      <AppShell
        active={view}
        onNavigate={setView}
        wallet={wallet}
        walletReady={authenticated}
        navigationEnabled={stage === "swipe" || stage === "review"}
        config={config}
        onDisconnect={disconnect}
        onWallet={() => void connectWallet()}
      >
        {stage === "onboarding" || !authenticated ? (
          <Onboarding
            config={config}
            wallet={authenticated ? wallet : undefined}
            connecting={isPending}
            onConnect={connectWallet}
            onComplete={loadSession}
            onPrefetch={() => undefined}
          />
        ) : null}
        {stage === "loading" ? (
          <main className="loading-state">
            <span />
            <h1>Loading Lumora-priced BDEX markets</h1>
          </main>
        ) : null}
        {stage === "swipe" && view === "week" && current && feed && session && preferences ? (
          <main className="swipe-workspace">
            <BudgetRail preferences={preferences} selectedCount={selected.length} />
            {error ? <p className="send-error">{error}</p> : null}
            <SwipeCard
              candidate={current}
              reason={
                feed.feed.cards.find((card) => card.assetId === current.assetId)
                  ?.reason ?? current.reason
              }
              ticketSizeUsd={ticketSizeUsd}
              stableToken="USDT"
              feedback={decisionFeedback}
              infoOpen={false}
              onInfoOpenChange={() => undefined}
              onSwipe={(add) => decide(add ? "invest" : "skip")}
            />
            <div className="swipe-actions">
              <button type="button" className="button button-outline" onClick={() => decide("skip")}>
                Skip
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={!selected.length}
                onClick={() => setStage("review")}
              >
                Review {selected.length} {selected.length === 1 ? "buy" : "buys"}
              </button>
            </div>
          </main>
        ) : null}
        {stage === "review" && session && feed && preferences ? (
          <ReviewScreen
            session={session}
            feed={feed}
            selected={selected}
            wallet={wallet}
            config={config}
            onBack={() => setStage("swipe")}
            onRemove={(assetId) =>
              setSelectedIds((currentIds) => currentIds.filter((id) => id !== assetId))
            }
            onExecutionChange={setSettlement}
            onSettled={(record) => {
              setSettlement(record);
              setReceiptCandidates(selected);
              setView("receipts");
              setStage("swipe");
              if (record.status === "SETTLED") setCelebrate(true);
            }}
          />
        ) : null}
        {view === "positions" && authenticated ? (
          <PositionsScreen wallet={wallet} config={config} />
        ) : null}
        {view === "receipts" ? (
          <ReceiptScreen
            settlement={settlement}
            candidates={receiptCandidates}
            config={config}
          />
        ) : null}
        {view === "account" ? (
          <AccountScreen wallet={wallet} preferences={preferences} config={config} />
        ) : null}
        {celebrate ? (
          <Confetti
            manualstart={false}
            style={{ position: "fixed", inset: 0, pointerEvents: "none" }}
          />
        ) : null}
      </AppShell>
    </AssetIconProvider>
  );
}

