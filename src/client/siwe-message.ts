import { getAddress } from "viem";

/**
 * EIP-4361 message builder.
 *
 * The `siwe` package is Node-only: `prepareMessage` reaches for `Buffer.from`,
 * which Vite externalizes in browser builds, so it throws
 * `Cannot read properties of undefined (reading 'from')`. The message is plain
 * text with a fixed field order, so the client formats it directly and the
 * server still parses and validates it with `siwe`.
 */
export interface SiweMessageFields {
	domain: string;
	address: string;
	statement: string;
	uri: string;
	chainId: number;
	nonce: string;
	issuedAt?: string;
}

export function prepareSiweMessage(fields: SiweMessageFields): string {
	const address = getAddress(fields.address);
	const issuedAt = fields.issuedAt ?? new Date().toISOString();
	assertSingleLine(fields.domain, "domain");
	assertSingleLine(fields.statement, "statement");
	assertSingleLine(fields.uri, "uri");
	if (!/^[a-zA-Z0-9]{8,}$/.test(fields.nonce)) {
		throw new Error("SIWE nonce must be at least 8 alphanumeric characters.");
	}

	return [
		`${fields.domain} wants you to sign in with your Ethereum account:`,
		address,
		"",
		fields.statement,
		"",
		`URI: ${fields.uri}`,
		"Version: 1",
		`Chain ID: ${fields.chainId}`,
		`Nonce: ${fields.nonce}`,
		`Issued At: ${issuedAt}`,
	].join("\n");
}

function assertSingleLine(value: string, field: string) {
	if (!value || /[\r\n]/.test(value)) {
		throw new Error(`SIWE ${field} must be a non-empty single line.`);
	}
}
