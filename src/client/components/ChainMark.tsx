import type { AppChain } from "../../domain/schemas";

const CHAIN_MARKS: Record<AppChain, { label: string; src: string }> = {
	BOTCHAIN: {
		label: "BOT Chain",
		src: "/assets/chains/botchain.svg",
	},
};

export function ChainMark({
	chain,
	size = 20,
}: {
	chain: AppChain;
	size?: number;
}) {
	const mark = CHAIN_MARKS[chain];

	return (
		<img
			className={`chain-mark chain-mark-${chain.toLowerCase()}`}
			src={mark.src}
			width={size}
			height={size}
			alt=""
			aria-hidden="true"
		/>
	);
}
