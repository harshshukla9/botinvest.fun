import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SiweMessage } from "siwe";
import { getAddress } from "viem";
import { api, type PublicConfig } from "./api";
import {
	connectMetaMask,
	getMetaMaskProvider,
	personalSign,
	readableWalletError,
	type EthereumProvider,
} from "./metamask";

const SESSION_STORAGE_KEY = "botinvest:siwe-session";

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

function writeStoredSession(session: StoredSession | undefined) {
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

	const clear = useCallback(() => {
		setSession(undefined);
		writeStoredSession(undefined);
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
					setSession(stored);
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
	}, []);

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
			const message = new SiweMessage({
				domain: window.location.host,
				address: getAddress(address),
				statement:
					"Sign in to botinvest to build and execute baskets on BOT Chain.",
				uri: window.location.origin,
				version: "1",
				chainId: config.chainId,
				nonce,
				issuedAt: new Date().toISOString(),
			}).prepareMessage();
			const signature = await personalSign(provider, address, message);
			const verified = await api.verify(message, signature);
			const next: StoredSession = {
				wallet: verified.wallet,
				token: verified.token,
				expiresAt: verified.expiresAt,
			};
			writeStoredSession(next);
			setSession(next);
		} catch (caught) {
			setError(readableWalletError(caught, "Could not connect MetaMask."));
		} finally {
			setConnecting(false);
		}
	}, [config]);

	const disconnect = useCallback(() => {
		clear();
		void providerRef.current
			?.request({
				method: "wallet_revokePermissions",
				params: [{ eth_accounts: {} }],
			})
			.catch(() => undefined);
	}, [clear]);

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
