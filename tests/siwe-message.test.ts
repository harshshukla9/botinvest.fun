import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SiweMessage } from "siwe";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { prepareSiweMessage } from "../src/client/siwe-message.js";

async function clientSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return clientSourceFiles(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    }),
  );
  return files.flat();
}

const fields = {
  domain: "localhost:5173",
  address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  statement: "Sign in to botcrates to build and execute baskets on BOT Chain.",
  uri: "http://localhost:5173",
  chainId: 968,
  nonce: "fb208046520d8a09bc3742ce978ff880",
  issuedAt: "2026-08-22T13:58:21.381Z",
};

describe("client SIWE message", () => {
  it("is byte-identical to what the siwe package produces", () => {
    const expected = new SiweMessage({
      ...fields,
      address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      version: "1",
    }).prepareMessage();

    expect(prepareSiweMessage(fields)).toBe(expected);
  });

  it("checksums the address so the server recovers the same wallet", () => {
    const message = prepareSiweMessage(fields);

    expect(message).toContain("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(new SiweMessage(message).address).toBe(
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    );
  });

  it("produces a signature the server accepts", async () => {
    const account = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const message = prepareSiweMessage({ ...fields, address: account.address });

    const signature = await account.signMessage({ message });

    const parsed = new SiweMessage(message);
    expect(parsed.nonce).toBe(fields.nonce);
    expect(parsed.chainId).toBe(968);
    expect(parsed.domain).toBe("localhost:5173");
    await expect(
      verifyMessage({ address: account.address, message, signature }),
    ).resolves.toBe(true);
  });

  it("rejects nonces and fields that would break the format", () => {
    expect(() => prepareSiweMessage({ ...fields, nonce: "short" })).toThrow();
    expect(() =>
      prepareSiweMessage({ ...fields, statement: "line one\nline two" }),
    ).toThrow();
  });

  // `siwe` calls Buffer.from, which Vite externalizes in the browser, so
  // importing it from client code breaks wallet connect at runtime only.
  it("is not bypassed by a client import of the node-only siwe package", async () => {
    const files = await clientSourceFiles("src/client");
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/from\s+["']siwe["']/.test(source)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});
