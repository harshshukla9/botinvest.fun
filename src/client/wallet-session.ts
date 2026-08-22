import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, configureApiAuth, type PublicConfig } from "./api";
import { prepareSiweMessage } from "./siwe-message";
import {
	connectMetaMask,
	getMetaMaskProvider,
	personalSign,
	readableWalletError,
	type EthereumProvider,
} from "./metamask";

const SESSION_STORAGE_KEY = "botcrates:siwe-session";

interface StoredSession {
	wallet: string;
	token: string;
	expiresAt: string;
}

function readStoredSession(): StoredSession | undefined {
	try {
		const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw) as StoredSession;
		if (!parsed.token || !parsed.wallet) return;
		if (Date.parse(parsed.expiresAt) <= Date.now()) return;
		return parsed;
	} catch {
		return undefined;
	}
}

/**
 * Requests must carry the token as soon as it exists. React commits child
 * effects before parent effects, so wiring the API from an effect in `App` lets
 * children fire authenticated calls a beat too early and get a 401. Holding the
 * session here and reading it at request time removes the ordering entirely.
 */
let activeSession: StoredSession | undefined;
const sessionListeners = new Set<(session: StoredSession | undefined) => void>();

function registerApiAuth() {
	configureApiAuth({
		getAccessToken: async () => activeSession?.token ?? null,
		getWalletAddress: () => activeSession?.wallet,
		onUnauthorized: () => {
			if (!activeSession) return;
			writeStoredSession(undefined);
			for (const listener of sessionListeners) listener(undefined);
		},
	});
}

registerApiAuth();

function writeStoredSession(session: StoredSession | undefined) {
	activeSession = session;
	if (!session) {
		sessionStorage.removeItem(SESSION_STORAGE_KEY);
		return;
	}
	sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export interface WalletSession {
	wallet: string;
	token: string;
	authenticated: boolean;
	ready: boolean;
	connecting: boolean;
	error: string;
	connect: () => Promise<void>;
	disconnect: () => void;
	clearError: () => void;
}

export function useWalletSession(config: PublicConfig): WalletSession {
	const [session, setSession] = useState<StoredSession>();
	const [ready, setReady] = useState(false);
	const [connecting, setConnecting] = useState(false);
	const [error, setError] = useState("");
	const providerRef = useRef<EthereumProvider | undefined>(undefined);

	const applySession = useCallback((next: StoredSession | undefined) => {
		writeStoredSession(next);
		setSession(next);
	}, []);

	// Re-registering here keeps requests authenticated across a remount, and
	// across a dev hot reload that swaps either module.
	useEffect(() => {
		registerApiAuth();
		const onRejected = (next: StoredSession | undefined) => {
			setSession(next);
			setError("Your sign-in expired. Connect MetaMask to continue.");
		};
		sessionListeners.add(onRejected);
		return () => {
			sessionListeners.delete(onRejected);
		};
	}, []);

	// Restore a session only when MetaMask still exposes the same account.
	useEffect(() => {
		let cancelled = false;
		const stored = readStoredSession();
		const provider = getMetaMaskProvider();
		providerRef.current = provider;
		if (!stored || !provider) {
			if (stored) writeStoredSession(undefined);
			setReady(true);
			return;
		}
		provider
			.request({ method: "eth_accounts" })
			.then((accounts) => {
				if (cancelled) return;
				const active =
					Array.isArray(accounts) && typeof accounts[0] === "string"
						? accounts[0].toLowerCase()
						: undefined;
				if (active && active === stored.wallet.toLowerCase()) {
					applySession(stored);
				} else {
					writeStoredSession(undefined);
				}
			})
			.catch(() => writeStoredSession(undefined))
			.finally(() => {
				if (!cancelled) setReady(true);
			});
		return () => {
			cancelled = true;
		};
	}, [applySession]);

	useEffect(() => {
		const provider = providerRef.current ?? getMetaMaskProvider();
		if (!provider?.on) return;
		const onAccountsChanged = (...args: unknown[]) => {
			const accounts = args[0];
			const next =
				Array.isArray(accounts) && typeof accounts[0] === "string"
					? accounts[0].toLowerCase()
					: undefined;
			setSession((current) => {
				if (!current) return current;
				if (next && next === current.wallet.toLowerCase()) return current;
				writeStoredSession(undefined);
				return undefined;
			});
		};
		const onChainChanged = () => setError("");
		provider.on("accountsChanged", onAccountsChanged);
		provider.on("chainChanged", onChainChanged);
		return () => {
			provider.removeListener?.("accountsChanged", onAccountsChanged);
			provider.removeListener?.("chainChanged", onChainChanged);
		};
	}, []);

	const connect = useCallback(async () => {
		setError("");
		setConnecting(true);
		try {
			const { provider, address } = await connectMetaMask(config);
			providerRef.current = provider;
			const { nonce } = await api.nonce();
			const message = prepareSiweMessage({
				domain: window.location.host,
				address,
				statement:
					"Sign in to botcrates to build and execute baskets on BOT Chain.",
				uri: window.location.origin,
				chainId: config.chainId,
				nonce,
			});
			const signature = await personalSign(provider, address, message);
			const verified = await api.verify(message, signature);
			const next: StoredSession = {
				wallet: verified.wallet,
				token: verified.token,
				expiresAt: verified.expiresAt,
			};
			applySession(next);
		} catch (caught) {
			setError(readableWalletError(caught, "Could not connect MetaMask."));
		} finally {
			setConnecting(false);
		}
	}, [applySession, config]);

	const disconnect = useCallback(() => {
		applySession(undefined);
		void providerRef.current
			?.request({
				method: "wallet_revokePermissions",
				params: [{ eth_accounts: {} }],
			})
			.catch(() => undefined);
	}, [applySession]);

	return useMemo(
		() => ({
			wallet: session?.wallet ?? "",
			token: session?.token ?? "",
			authenticated: Boolean(session?.token),
			ready,
			connecting,
			error,
			connect,
			disconnect,
			clearError: () => setError(""),
		}),
		[connect, connecting, disconnect, error, ready, session],
	);
}
