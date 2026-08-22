import { useEffect, useMemo, useState } from "react";
import { Dialog, Popover, Select } from "radix-ui";
import {
	Check,
	ChevronDown,
	Copy,
	ExternalLink,
	LogOut,
	Send,
	Wallet,
	X,
} from "lucide-react";
import {
	createPublicClient,
	encodeFunctionData,
	erc20Abi,
	formatUnits,
	http,
	isAddress,
	parseUnits,
	toHex,
	zeroAddress,
	type Address,
	type Hex,
} from "viem";
import { api, type PublicConfig } from "../api";
import {
	ensureBotChain,
	getMetaMaskProvider,
	readableWalletError,
} from "../metamask";
import { ChainMark } from "./ChainMark";

type SendToken = {
	id: string;
	symbol: string;
	name: string;
	decimals: number;
	address?: Address;
};

type SendStatus = "idle" | "preparing" | "signing" | "success";

export function WalletMenu({
	wallet,
	config,
	onDisconnect,
}: {
	wallet: string;
	config: PublicConfig;
	onDisconnect?: () => void;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [sendOpen, setSendOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const [tokenId, setTokenId] = useState("USDT");
	const [recipient, setRecipient] = useState("");
	const [amount, setAmount] = useState("");
	const [balance, setBalance] = useState<bigint>();
	const [balanceError, setBalanceError] = useState("");
	const [sendError, setSendError] = useState("");
	const [status, setStatus] = useState<SendStatus>("idle");
	const [transactionHash, setTransactionHash] = useState<Hex>();
	const [heldTokens, setHeldTokens] = useState<SendToken[]>([]);

	const client = useMemo(
		() => createPublicClient({ transport: http(config.rpcUrl) }),
		[config.rpcUrl],
	);

	const nativeToken = useMemo<SendToken>(
		() => ({
			id: config.nativeCurrency.symbol,
			symbol: config.nativeCurrency.symbol,
			name: `${config.chainName} gas token`,
			decimals: config.nativeCurrency.decimals,
		}),
		[config.chainName, config.nativeCurrency],
	);

	const stableToken = useMemo<SendToken>(
		() => ({
			id: "USDT",
			symbol: "USDT",
			name: "Tether USD",
			decimals: config.stableTokenDecimals,
			address: config.stableTokenAddress as Address,
		}),
		[config.stableTokenAddress, config.stableTokenDecimals],
	);

	const sendTokens = useMemo(
		() => [stableToken, nativeToken, ...heldTokens],
		[heldTokens, nativeToken, stableToken],
	);

	const selectedToken = useMemo(
		() => sendTokens.find((token) => token.id === tokenId) ?? stableToken,
		[sendTokens, stableToken, tokenId],
	);

	const amountBaseUnits = parseTokenAmount(amount, selectedToken.decimals);
	const recipientValid =
		isAddress(recipient) && recipient.toLowerCase() !== zeroAddress.toLowerCase();
	const amountValid =
		amountBaseUnits !== undefined &&
		amountBaseUnits > 0n &&
		balance !== undefined &&
		amountBaseUnits <= balance;
	const busy = status === "preparing" || status === "signing";

	useEffect(() => {
		if (!sendOpen) return;
		let cancelled = false;
		api
			.portfolio(wallet)
			.then((portfolio) => {
				if (cancelled) return;
				setHeldTokens(
					portfolio.tokens.map((token) => ({
						id: token.assetId,
						symbol: token.symbol,
						name: token.name,
						decimals: token.decimals,
						address: token.contract as Address,
					})),
				);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [sendOpen, wallet]);

	useEffect(() => {
		if (!sendOpen) return;
		let cancelled = false;
		setBalance(undefined);
		setBalanceError("");

		readTokenBalance(client, wallet as Address, selectedToken)
			.then((nextBalance) => {
				if (!cancelled) setBalance(nextBalance);
			})
			.catch((caught) => {
				if (!cancelled) {
					setBalanceError(
						caught instanceof Error
							? caught.message
							: "Could not load token balance.",
					);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [client, selectedToken, sendOpen, wallet]);

	function openSend() {
		setMenuOpen(false);
		setSendOpen(true);
		setSendError("");
		setStatus("idle");
		setTransactionHash(undefined);
	}

	function closeSend(open: boolean) {
		if (busy) return;
		setSendOpen(open);
		if (!open) {
			setRecipient("");
			setAmount("");
			setSendError("");
			setStatus("idle");
			setTransactionHash(undefined);
		}
	}

	async function copyWallet() {
		await navigator.clipboard.writeText(wallet);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1_500);
	}

	async function sendToken() {
		setSendError("");
		if (!recipientValid) {
			setSendError("Enter a valid recipient address.");
			return;
		}
		if (amountBaseUnits === undefined || amountBaseUnits <= 0n) {
			setSendError("Enter a valid amount.");
			return;
		}
		if (balance === undefined || amountBaseUnits > balance) {
			setSendError(`Not enough ${selectedToken.symbol}.`);
			return;
		}

		try {
			setStatus("preparing");
			const provider = getMetaMaskProvider();
			if (!provider) throw new Error("MetaMask was not found.");
			await ensureBotChain(provider, config);
			const call = createSendCall(
				selectedToken,
				recipient as Address,
				amountBaseUnits,
			);
			setStatus("signing");
			const hash = await provider.request({
				method: "eth_sendTransaction",
				params: [
					{
						from: wallet,
						to: call.to,
						data: call.data,
						value: toHex(call.value),
					},
				],
			});
			if (typeof hash !== "string") {
				throw new Error("MetaMask did not return a transaction hash.");
			}
			setTransactionHash(hash as Hex);
			setStatus("success");
			setBalance((current) =>
				current === undefined ? current : current - amountBaseUnits,
			);
		} catch (caught) {
			setStatus("idle");
			setSendError(
				readableWalletError(caught, "The transfer could not be submitted."),
			);
		}
	}

	return (
		<>
			<Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
				<Popover.Trigger asChild>
					<button
						type="button"
						className="wallet-menu-trigger"
						aria-label={`Open wallet menu for ${wallet}`}
					>
						<Wallet aria-hidden="true" />
						{shortAddress(wallet)}
						<ChevronDown className="wallet-menu-chevron" aria-hidden="true" />
					</button>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content
						className="wallet-menu-content"
						sideOffset={8}
						align="end"
						collisionPadding={12}
					>
						<div className="wallet-menu-heading">
							<span>MetaMask wallet</span>
							<strong>{shortAddress(wallet)}</strong>
						</div>
						<fieldset className="wallet-chain-selector" aria-label="Active chain">
							<button type="button" className="active" disabled>
								<ChainMark chain="BOTCHAIN" />
								<span>
									{config.chainName} · {config.chainId}
								</span>
							</button>
						</fieldset>
						<button
							type="button"
							className="wallet-menu-action primary"
							onClick={openSend}
						>
							<Send aria-hidden="true" />
							Send tokens
						</button>
						<a
							className="wallet-menu-action"
							href={`${config.explorerUrl}/address/${wallet}`}
							target="_blank"
							rel="noreferrer"
						>
							<ExternalLink aria-hidden="true" />
							View on explorer
						</a>
						<button
							type="button"
							className="wallet-menu-action"
							onClick={() => void copyWallet()}
						>
							{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
							{copied ? "Address copied" : "Copy address"}
						</button>
						<div className="wallet-menu-separator" />
						<button
							type="button"
							className="wallet-menu-action danger"
							onClick={() => {
								setMenuOpen(false);
								onDisconnect?.();
							}}
						>
							<LogOut aria-hidden="true" />
							Disconnect
						</button>
						<Popover.Arrow className="wallet-menu-arrow" />
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>

			<Dialog.Root open={sendOpen} onOpenChange={closeSend}>
				<Dialog.Portal>
					<Dialog.Overlay className="send-dialog-overlay" />
					<Dialog.Content className="send-dialog-content">
						{status === "success" && transactionHash ? (
							<div className="send-success">
								<span className="send-success-icon">
									<Check aria-hidden="true" />
								</span>
								<Dialog.Title>Transfer submitted</Dialog.Title>
								<Dialog.Description>
									{amount} {selectedToken.symbol} is on its way to{" "}
									{shortAddress(recipient)}.
								</Dialog.Description>
								<a
									className="button button-outline"
									href={`${config.explorerUrl}/tx/${transactionHash}`}
									target="_blank"
									rel="noreferrer"
								>
									View transaction <ExternalLink aria-hidden="true" />
								</a>
								<button
									type="button"
									className="button button-primary"
									onClick={() => closeSend(false)}
								>
									Done
								</button>
							</div>
						) : (
							<>
								<div className="send-dialog-header">
									<div>
										<span className="account-label">
											{config.chainName} · {config.chainId}
										</span>
										<Dialog.Title>Send from your wallet</Dialog.Title>
										<Dialog.Description>
											Review the details, then confirm once in MetaMask.
										</Dialog.Description>
									</div>
									<Dialog.Close asChild>
										<button
											type="button"
											className="send-dialog-close"
											aria-label="Close send dialog"
											disabled={busy}
										>
											<X aria-hidden="true" />
										</button>
									</Dialog.Close>
								</div>

								<div className="send-from-row">
									<span>From</span>
									<code>{wallet}</code>
								</div>

								<div className="send-field">
									<span id="send-token-label">Token</span>
									<Select.Root
										value={selectedToken.id}
										onValueChange={(value) => {
											setTokenId(value);
											setAmount("");
											setSendError("");
										}}
										disabled={busy}
									>
										<Select.Trigger
											className="send-select-trigger"
											aria-labelledby="send-token-label"
										>
											<Select.Value />
											<Select.Icon>
												<ChevronDown aria-hidden="true" />
											</Select.Icon>
										</Select.Trigger>
										<Select.Portal>
											<Select.Content
												className="send-select-content"
												position="popper"
												sideOffset={6}
											>
												<Select.Viewport>
													{sendTokens.map((token) => (
														<Select.Item
															className="send-select-item"
															key={token.id}
															value={token.id}
														>
															<Select.ItemText>
																{token.symbol} · {token.name}
															</Select.ItemText>
															<Select.ItemIndicator>
																<Check aria-hidden="true" />
															</Select.ItemIndicator>
														</Select.Item>
													))}
												</Select.Viewport>
											</Select.Content>
										</Select.Portal>
									</Select.Root>
									<small>
										{balance === undefined
											? balanceError || "Loading balance…"
											: `Available: ${formatTokenBalance(balance, selectedToken.decimals)} ${selectedToken.symbol}`}
									</small>
								</div>

								<label className="send-field">
									<span>Recipient address</span>
									<input
										value={recipient}
										onChange={(event) => {
											setRecipient(event.target.value.trim());
											setSendError("");
										}}
										placeholder="0x…"
										autoComplete="off"
										spellCheck={false}
										disabled={busy}
									/>
								</label>

								<label className="send-field">
									<span>Amount</span>
									<div className="send-amount-input">
										<input
											type="text"
											inputMode="decimal"
											value={amount}
											onChange={(event) => {
												setAmount(event.target.value.replace(",", "."));
												setSendError("");
											}}
											placeholder="0.00"
											disabled={busy}
										/>
										<button
											type="button"
											onClick={() => {
												if (balance !== undefined) {
													setAmount(
														formatUnits(balance, selectedToken.decimals),
													);
												}
											}}
											disabled={busy || balance === undefined || balance === 0n}
										>
											Max
										</button>
										<strong>{selectedToken.symbol}</strong>
									</div>
								</label>

								{sendError || balanceError ? (
									<p className="send-error" role="alert">
										{sendError || balanceError}
									</p>
								) : null}

								<div className="send-dialog-actions">
									<Dialog.Close asChild>
										<button
											type="button"
											className="button button-outline"
											disabled={busy}
										>
											Cancel
										</button>
									</Dialog.Close>
									<button
										type="button"
										className="button button-primary"
										disabled={
											!recipientValid ||
											!amountValid ||
											busy ||
											Boolean(balanceError)
										}
										onClick={() => void sendToken()}
									>
										{status === "preparing" ? (
											"Checking transaction…"
										) : status === "signing" ? (
											"Confirm in MetaMask…"
										) : (
											<>
												Send {selectedToken.symbol}
												<Send aria-hidden="true" />
											</>
										)}
									</button>
								</div>
							</>
						)}
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog.Root>
		</>
	);
}

async function readTokenBalance(
	client: ReturnType<typeof createPublicClient>,
	wallet: Address,
	token: SendToken,
) {
	if (!token.address) return client.getBalance({ address: wallet });
	return client.readContract({
		address: token.address,
		abi: erc20Abi,
		functionName: "balanceOf",
		args: [wallet],
	});
}

function createSendCall(token: SendToken, recipient: Address, amount: bigint) {
	if (!token.address) return { to: recipient, value: amount, data: "0x" as Hex };
	return {
		to: token.address,
		value: 0n,
		data: encodeFunctionData({
			abi: erc20Abi,
			functionName: "transfer",
			args: [recipient, amount],
		}),
	};
}

function parseTokenAmount(value: string, decimals: number) {
	const normalized = value.trim();
	if (!/^(?:\d+|\d*\.\d+)$/.test(normalized)) return undefined;
	try {
		return parseUnits(normalized, decimals);
	} catch {
		return undefined;
	}
}

function formatTokenBalance(value: bigint, decimals: number) {
	const formatted = formatUnits(value, decimals);
	const [whole, fraction = ""] = formatted.split(".");
	const compactFraction = fraction.slice(0, 6).replace(/0+$/, "");
	return compactFraction ? `${whole}.${compactFraction}` : whole;
}

function shortAddress(address: string) {
	return address.length > 12
		? `${address.slice(0, 6)}…${address.slice(-4)}`
		: address;
}
