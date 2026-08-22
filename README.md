# botinvest

Non-custodial, budget-capped investing on [BOT Chain](https://dev-docs.botchain.ai/docs/intro/). A user connects **MetaMask**, sets a USDT plan, swipes a ranked feed, and signs BDEX swaps from their own wallet.

Prices come from [Lumora](https://lumora-oracle.vercel.app/docs) (REST + on-chain `CommodityConsumer`). Execution goes through official [BDEX](https://dev-docs.botchain.ai/docs/DEX/contract-addresses/) contracts. There is no Privy, no Solana path, and no simulated settlement.

## Stack

| Layer | Implementation |
|---|---|
| Wallet | MetaMask via wagmi injected connector + SIWE sessions |
| Chain | BOT Testnet `968` (default, Lumora live) or BOT Mainnet `677` |
| Budget asset | USDT on BOT Chain |
| Oracle | Lumora `GET /api/prices` and `CommodityConsumer.getPrice` |
| Execution | BDEX V2 Router02 `swapExactTokensForTokens` |
| State | In-memory locally; PostgreSQL when `DATABASE_URL` is set |

## Run locally

```bash
cd botinvest
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. Install MetaMask, then the app will add **BOT Testnet** (`https://rpc.bohr.life`, chain id `968`, symbol `BOT`) if it is missing.

```bash
npm run typecheck
npm test
npm run build
```

## Networks

From [BOT Chain developer docs](https://dev-docs.botchain.ai/docs/Developers/json-rpc-endpoint/) and [Lumora](https://lumora-oracle.vercel.app/docs):

| | Testnet | Mainnet |
|---|---|---|
| Chain ID | 968 | 677 |
| RPC | https://rpc.bohr.life | https://rpc.botchain.ai |
| Explorer | https://scan.bohr.life | https://scan.botchain.ai |
| USDT | `0x75edC9335175Fc0552D51D48439F229c10420fe3` | `0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C` |
| Lumora consumer | `0x5E6658ac6cBC9b0109C28BED00bC4Af0F0A3f1CD` | same address, switch via env when mainnet feeds are live |

Set `BOT_CHAIN_NETWORK=mainnet` only after you have USDT and BDEX liquidity on chain 677.

## Trust boundary

1. Server discovers BDEX markets and ranks them with Lumora prices.
2. Review re-quotes the selected tickets on BDEX and, when a Lumora feed exists, verifies the on-chain oracle (max staleness 900s).
3. MetaMask signs approval + swap calls from the connected EOA.
4. Settlement is the BOT Scan receipt plus ERC-20 transfers back to that wallet — never a quote or a local success flag.

The server holds no keys and cannot broadcast without the MetaMask signature.
