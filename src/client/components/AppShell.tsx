import { type ReactNode, useEffect } from "react";
import { Wallet } from "lucide-react";
import type { PublicConfig } from "../api";
import { WalletMenu } from "./WalletMenu";

interface Props {
	active: "week" | "positions" | "receipts" | "account";
	onNavigate: (target: Props["active"]) => void;
	config: PublicConfig;
	wallet?: string;
	onWallet?: () => void;
	onDisconnect?: () => void;
	walletReady?: boolean;
	walletBusy?: boolean;
	navigationEnabled?: boolean;
	children: ReactNode;
}

export function AppShell({
	active,
	onNavigate,
	config,
	wallet,
	onWallet,
	onDisconnect,
	walletReady = true,
	walletBusy = false,
	navigationEnabled = true,
	children,
}: Props) {
	useEffect(() => {
		const root = document.documentElement;
		const themeColor = document.querySelector<HTMLMetaElement>(
			'meta[name="theme-color"]',
		);
		const previousChain = root.dataset.chain;
		const previousThemeColor = themeColor?.content;

		root.dataset.chain = "botchain";
		if (themeColor) themeColor.content = "#f1f3f6";

		return () => {
			if (previousChain) root.dataset.chain = previousChain;
			else delete root.dataset.chain;
			if (themeColor && previousThemeColor) {
				themeColor.content = previousThemeColor;
			}
		};
	}, []);

	return (
		<div className="app-shell">
			<header
				className={navigationEnabled ? "topbar" : "topbar topbar-onboarding"}
			>
				<button
					type="button"
					className="brand"
					onClick={() => onNavigate("week")}
					aria-label="botcrates home"
				>
					bot<span>crates</span>
				</button>
				{navigationEnabled ? (
					<nav aria-label="Primary navigation">
						{[
							["week", "Basket"],
							["positions", "Portfolio"],
							["receipts", "Activity"],
							["account", "Account"],
						].map(([id, label]) => (
							<button
								type="button"
								key={id}
								className={active === id ? "nav-link active" : "nav-link"}
								onClick={() => onNavigate(id as Props["active"])}
							>
								{label}
							</button>
						))}
					</nav>
				) : null}
				{wallet ? (
					<div className="wallet-pill">
						<WalletMenu
							wallet={wallet}
							config={config}
							onDisconnect={onDisconnect}
						/>
					</div>
				) : (
					<button
						type="button"
						className="wallet-button"
						onClick={onWallet}
						disabled={!walletReady || walletBusy}
						aria-label="Connect wallet with MetaMask"
						title="Connect wallet with MetaMask"
					>
						<Wallet size={17} strokeWidth={1.7} />
						{walletBusy ? "Connecting…" : "Connect wallet"}
					</button>
				)}
			</header>
			{children}
		</div>
	);
}
