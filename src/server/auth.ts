import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import { SiweMessage } from "siwe";
import { verifyMessage } from "viem";
import { addressSchema } from "../domain/schemas.js";
import type { AppConfig } from "./config.js";

export type ExecutionActor = {
  userId: string;
  wallet: string;
  txOrigin: string;
  chain: "BOTCHAIN";
};

const nonces = new Map<string, { expiresAt: number }>();
const NONCE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;

export class SiweWalletAuth {
  private readonly secret: Uint8Array;
  private readonly origin: URL;
  private readonly chainId: number;

  constructor(config: AppConfig) {
    this.secret = new TextEncoder().encode(config.SESSION_SECRET);
    this.origin = new URL(config.PUBLIC_ORIGIN);
    this.chainId = config.network.chainId;
  }

  issueNonce() {
    const now = Date.now();
    for (const [issued, state] of nonces) {
      if (state.expiresAt < now) nonces.delete(issued);
    }
    const nonce = randomBytes(16).toString("hex");
    nonces.set(nonce, { expiresAt: now + NONCE_TTL_MS });
    return nonce;
  }

  async verify(
    message: string,
    signature: string,
  ): Promise<{
    token: string;
    wallet: string;
    expiresAt: string;
    actor: ExecutionActor;
  }> {
    const siwe = new SiweMessage(message);
    const nonceState = siwe.nonce ? nonces.get(siwe.nonce) : undefined;
    if (!nonceState || nonceState.expiresAt < Date.now()) {
      throw new Error("SIWE_NONCE_INVALID");
    }
    nonces.delete(siwe.nonce);
    const valid = await verifyMessage({
      address: addressSchema.parse(siwe.address) as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
    if (!valid) throw new Error("SIWE_SIGNATURE_INVALID");
    if (Number(siwe.chainId) !== this.chainId) {
      throw new Error("SIWE_WRONG_CHAIN");
    }
    if (!domainsMatch(siwe.domain, this.origin.host)) {
      throw new Error("SIWE_WRONG_DOMAIN");
    }
    const wallet = addressSchema.parse(siwe.address).toLowerCase();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const token = await new SignJWT({ wallet, chain: "BOTCHAIN" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(wallet)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.secret);
    return {
      token,
      wallet,
      expiresAt: expiresAt.toISOString(),
      actor: { userId: wallet, wallet, txOrigin: wallet, chain: "BOTCHAIN" },
    };
  }

  async actor(request: Request): Promise<ExecutionActor> {
    const token = bearerToken(request);
    const { payload } = await jwtVerify(token, this.secret);
    const wallet = addressSchema.parse(String(payload.sub ?? payload.wallet)).toLowerCase();
    const requested = addressSchema
      .parse(request.header("x-wallet-address") ?? wallet)
      .toLowerCase();
    if (requested !== wallet) {
      throw new Error("WALLET_DOES_NOT_MATCH_SESSION");
    }
    return { userId: wallet, wallet, txOrigin: wallet, chain: "BOTCHAIN" };
  }
}

function domainsMatch(actual: string, expected: string) {
  const normalize = (value: string) =>
    value.toLowerCase().replace("127.0.0.1", "localhost");
  return normalize(actual) === normalize(expected);
}

function bearerToken(request: Request): string {
  const authorization = request.header("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match?.[1]) throw new Error("SIWE_ACCESS_TOKEN_REQUIRED");
  return match[1];
}
