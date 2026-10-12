/**
 * Where the game server is.
 * - Dev: nothing set. The page and the server share one address (Vite forwards /ws and /rooms), so paths stay relative.
 * - Hosted (e.g. page on Cloudflare Pages, server on EC2): set VITE_SERVER_URL=https://api.example.com at build time.
 */
const raw = (import.meta.env.VITE_SERVER_URL ?? '').trim().replace(/\/+$/, '');
const valid = /^https?:\/\/[^/\s]+$/.test(raw);
if (raw && !valid) console.error(`VITE_SERVER_URL="${raw}" ignored: must look like https://api.example.com (no path)`);

/** The server's base address, or '' when it's the page's own address (dev). */
export const SERVER_BASE = valid ? raw : '';

/** True when the server lives somewhere else than the page (a hosted build). */
export const HOSTED = SERVER_BASE !== '';

/** HTTP address of a server path, e.g. serverHttp('/rooms'). */
export function serverHttp(path: string): string {
  return SERVER_BASE + path;
}

/** WebSocket address of the game connection (wss:// when the server or the page is on https). */
export function serverWs(): string {
  if (HOSTED) return SERVER_BASE.replace(/^http/, 'ws') + '/ws';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}
