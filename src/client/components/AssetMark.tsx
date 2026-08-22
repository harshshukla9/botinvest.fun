import {
	createContext,
	useContext,
	useEffect,
	useState,
	type ReactNode,
} from "react";
import { api } from "../api";

const LOGO_DEV_PUBLISHABLE_KEY = "pk_Vd4Z_uMzQJCMUA21nk_6Gw";
const AssetIconsContext = createContext<Record<string, string>>({});

export function AssetIconProvider({ children }: { children: ReactNode }) {
	const [icons, setIcons] = useState<Record<string, string>>({});

	useEffect(() => {
		let mounted = true;
		api
			.assetIcons()
			.then(({ icons: next }) => {
				if (mounted) setIcons(next);
			})
			.catch(() => undefined);
		return () => {
			mounted = false;
		};
	}, []);

	return (
		<AssetIconsContext.Provider value={icons}>
			{children}
		</AssetIconsContext.Provider>
	);
}

function AssetLogo({ iconUrl, symbol }: { iconUrl?: string; symbol: string }) {
	type LogoSource = "provided" | "logoDev" | "letter";
	const fallbackSource: LogoSource =
		symbol === "WBOT" || symbol === "WETH" ? "letter" : "logoDev";
	const initialSource: LogoSource = iconUrl ? "provided" : fallbackSource;
	const [source, setSource] = useState<LogoSource>(initialSource);

	useEffect(
		() => setSource(iconUrl ? "provided" : fallbackSource),
		[iconUrl, fallbackSource],
	);

	const imageUrl =
		source === "provided"
			? iconUrl
			: source === "logoDev"
				? `https://img.logo.dev/ticker/${encodeURIComponent(symbol.toUpperCase())}?token=${LOGO_DEV_PUBLISHABLE_KEY}&size=128&format=png&theme=light&retina=true&fallback=404`
				: undefined;

	if (!imageUrl) {
		return <span aria-hidden="true">{symbol.slice(0, 1).toUpperCase()}</span>;
	}

	return (
		<img
			src={imageUrl}
			alt={`${symbol} logo`}
			onError={() =>
				setSource(source === "provided" ? fallbackSource : "letter")
			}
		/>
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
	const registeredIconUrl = useContext(AssetIconsContext)[symbol];
	const resolvedIconUrl = iconUrl ?? registeredIconUrl;

	return (
		<span
			className={`asset-mark asset-${symbol.toLowerCase()} asset-mark-${size}`}
		>
			<AssetLogo
				key={resolvedIconUrl ?? ""}
				iconUrl={resolvedIconUrl}
				symbol={symbol}
			/>
		</span>
	);
}
