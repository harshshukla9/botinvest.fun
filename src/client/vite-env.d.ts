/// <reference types="vite/client" />

declare module "canvas-confetti";

interface Window {
  ethereum?: {
    request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  };
}
