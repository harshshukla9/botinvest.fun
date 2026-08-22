import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

const NONCE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;

export class SiweWalletAuth {
  private readonly secret: Uint8Array;
  private readonly chainId: number;
  private readonly allowedHosts: Set<string>;

  constructor(config: AppConfig) {
    this.secret = new TextEncoder().encode(config.SESSION_SECRET);
    this.chainId = config.network.chainId;
    this.allowedHosts = new Set(
      config.allowedHosts.map((host) => normalizeHost(host)),
    );
  }

  /**
   * HMAC-tagged nonce so /auth/nonce and /auth/verify can run on different
   * serverless isolates without a shared nonce table.
   */
  issueNonce() {
    const random = randomBytes(16).toString("hex");
    const expiresAt = (Date.now() + NONCE_TTL_MS).toString(16).padStart(12, "0");
    const body = `${random}${expiresAt}`;
    return `${body}${nonceMac(this.secret, body)}`;
  }

  consumeNonce(nonce: string) {
    if (!/^[a-f0-9]{76}$/.test(nonce)) return false;
    const body = nonce.slice(0, 44);
    const mac = nonce.slice(44);
    const expected = nonceMac(this.secret, body);
    if (
      mac.length !== expected.length ||
      !timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(expected, "hex"))
    ) {
      return false;
    }
    const expiresAt = Number.parseInt(body.slice(32), 16);
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
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
    if (!siwe.nonce || !this.consumeNonce(siwe.nonce)) {
      throw new Error("SIWE_NONCE_INVALID");
    }
    const valid = await verifyMessage({
      address: addressSchema.parse(siwe.address) as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
    if (!valid) throw new Error("SIWE_SIGNATURE_INVALID");
    if (Number(siwe.chainId) !== this.chainId) {
      throw new Error("SIWE_WRONG_CHAIN");
    }
    if (!this.allowedHosts.has(normalizeHost(siwe.domain))) {
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

function nonceMac(secret: Uint8Array, body: string) {
  return createHmac("sha256", secret).update(body).digest("hex").slice(0, 32);
}

function normalizeHost(value: string) {
  return value.toLowerCase().replace("127.0.0.1", "localhost");
}

function bearerToken(request: Request): string {
  const authorization = request.header("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match?.[1]) throw new Error("SIWE_ACCESS_TOKEN_REQUIRED");
  return match[1];
}
