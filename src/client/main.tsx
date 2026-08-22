import { StrictMode, useEffect, useState } from "react";
import { preload } from "react-dom";
import { createRoot } from "react-dom/client";
import "@fontsource/archivo-black/400.css";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource/instrument-serif/400.css";
import instrumentSerifRegularUrl from "@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2?url";
import { App } from "./App";
import { api, type PublicConfig } from "./api";
import "./styles.css";

preload(instrumentSerifRegularUrl, {
	as: "font",
	crossOrigin: "anonymous",
	type: "font/woff2",
});

function Root() {
	const [config, setConfig] = useState<PublicConfig>();
	const [error, setError] = useState("");

	useEffect(() => {
		api
			.config()
			.then(setConfig)
			.catch((caught) =>
				setError(
					caught instanceof Error &&
						!/basket could not be prepared/i.test(caught.message)
						? caught.message
						: "Could not reach the botcrates API. Refresh this page in a moment.",
				),
			);
	}, []);

	if (error) {
		return (
			<main className="fatal-state">
				<h1>botcrates is unavailable</h1>
				<p>{error}</p>
			</main>
		);
	}
	if (!config) {
		return (
			<main className="loading-state">
				<span />
				<h1>Loading botcrates</h1>
			</main>
		);
	}

	return <App config={config} />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing");

createRoot(root).render(
	<StrictMode>
		<Root />
	</StrictMode>,
);
