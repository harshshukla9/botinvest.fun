/// <reference types="vite/client" />

import type { EthereumProvider } from "./metamask";

declare global {
	interface Window {
		ethereum?: EthereumProvider;
	}
}
