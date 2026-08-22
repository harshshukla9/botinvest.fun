import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import { SiweMessage } from "siwe";
import { addressSchema } from "../domain/schemas.js";
import type { AppConfig } from "./config.js";

export type ExecutionActor = {
  userId: string;
  wallet: string;
  txOrigin: string;
  chain: "BOTCHAIN";
};

const nonces = new Map<string, { expiresAt: number }>();

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
    const nonce = randomBytes(16).toString("hex");
    nonces.set(nonce, { expiresAt: Date.now() + 10 * 60_000 });
    return nonce;
  }

  async verify(message: string, signature: string): Promise<{ token: string; actor: ExecutionActor }> {
    const siwe = new SiweMessage(message);
    const nonceState = siwe.nonce ? nonces.get(siwe.nonce) : undefined;
    if (!nonceState || nonceState.expiresAt < Date.now()) {
      throw new Error("SIWE_NONCE_INVALID");
    }
    nonces.delete(siwe.nonce);
    const { data } = await siwe.verify({ signature, nonce: siwe.nonce });
    if (Number(data.chainId) !== this.chainId) {
      throw new Error("SIWE_WRONG_CHAIN");
    }
    const expectedDomain = this.origin.host;
    if (data.domain !== expectedDomain) {
      throw new Error("SIWE_WRONG_DOMAIN");
    }
    const wallet = addressSchema.parse(data.address).toLowerCase();
    const token = await new SignJWT({ wallet, chain: "BOTCHAIN" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(wallet)
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(this.secret);
    return {
      token,
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

function bearerToken(request: Request): string {
  const authorization = request.header("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match?.[1]) throw new Error("SIWE_ACCESS_TOKEN_REQUIRED");
  return match[1];
}
