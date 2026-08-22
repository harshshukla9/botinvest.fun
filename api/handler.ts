import type { IncomingMessage, ServerResponse } from "node:http";
import { createServerApp } from "../src/server/bootstrap.js";

const app = createServerApp();

export default function handler(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const host = request.headers.host ?? "localhost";
  const protoHeader = request.headers["x-forwarded-proto"];
  const proto =
    (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader) ?? "https";
  const url = new URL(request.url ?? "/", `${proto}://${host}`);
  const path = url.searchParams.get("path");
  if (path !== null) {
    url.searchParams.delete("path");
    request.url = `/api/${path}${url.search}`;
  }
  app(request, response);
}
