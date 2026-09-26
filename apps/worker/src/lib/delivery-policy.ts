import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../index.js';

/** Tenant-wide, immutable per invocation. Missing/malformed configuration never enables delivery. */
export function deliveryEnabled(env: { DELIVERY_MODE?: string }): boolean {
  return env.DELIVERY_MODE === 'enabled';
}

/** No recipient, account ID, URL, token or message content in suppression logs. */
export function deliverySuppressed(boundary: string): void {
  console.info(JSON.stringify({ event: 'delivery_suppressed', boundary }));
}

// Deliberately narrow: arbitrary GET routes may also mutate or dispatch raw fetch.
// Add a path only after reading its handler and confirming it has no send,
// enroll, schedule or other write side effects in no-send mode.
function allowedPost(path: string): boolean {
  return ['/webhook', '/api/liff/link', '/api/auth/login', '/api/auth/logout'].includes(path);
}

function allowedGet(path: string, rawPath: string): boolean {
  return (
    [
      '/auth/line',
      '/auth/oauth',
      '/auth/callback',
      '/api/health',
      '/api/auth/session',
      '/api/line-accounts',
      '/api/friends',
      // DB SELECT only; the LINE bot-info lookup is skipped in no-send mode.
      '/api/liff/config',
    ].includes(path) ||
    /^\/(?:t|r)\/[^/]+$/.test(path) ||
    /^\/api\/friends\/[^/]+\/journey$/.test(path) ||
    isNoSendStaticPath(rawPath)
  );
}

// Vite's flat asset names, e.g. main-CcMcVBon.js / client-auj285-g.js. Only
// ASCII letters, digits, '-', '_' and single dots between name parts: no '%',
// backslash, '..', leading/trailing dot, or further path segments.
const STATIC_ASSET_NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;

/**
 * The LIFF UI bundled with this Worker (root HTML and flat /assets files).
 * `rawPath` must be the undecoded pathname of the request URL, i.e. exactly
 * what the static store receives, never Hono's decoded `c.req.path` (which
 * keeps `%2F` as one "segment"). Anything unusual fails closed. In no-send
 * mode these are answered by the static store only; see createNoSendStaticGate,
 * so a route later added on the same path never runs.
 */
export function isNoSendStaticPath(rawPath: string): boolean {
  if (rawPath === '/' || rawPath === '/index.html') return true;
  const match = /^\/assets\/([^/]+)$/.exec(rawPath);
  return match !== null && STATIC_ASSET_NAME.test(match[1]);
}

/** Undecoded pathname as the static store sees it. */
export function rawRequestPath(url: string): string {
  return new URL(url).pathname;
}

function allowedInNoSend(method: string, path: string, rawPath: string): boolean {
  if (method === 'POST') return allowedPost(path);
  if (method === 'GET') return allowedGet(path, rawPath);
  // CORS preflight only where the real request is allowed. hono/cors answers
  // OPTIONS with 204 itself and never passes it on to a route handler.
  if (method === 'OPTIONS') return allowedPost(path) || allowedGet(path, rawPath);
  return false;
}

export const deliveryPolicyMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  if (!deliveryEnabled(c.env) && !allowedInNoSend(c.req.method, c.req.path, rawRequestPath(c.req.url))) {
    deliverySuppressed('http');
    return c.json({ success: false, error: 'Delivery disabled; endpoint unavailable in no-send mode' }, 423);
  }
  await next();
};

/**
 * Registered after the CORS/rate-limit/auth middlewares and before any route.
 * In no-send mode, static UI paths are served by `serveStatic` (the asset/OGP
 * fallback) without reaching route handlers, and a preflight that somehow
 * escaped CORS handling is refused rather than routed.
 */
export function createNoSendStaticGate(
  serveStatic: (c: Context<Env>) => Promise<Response>,
): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (deliveryEnabled(c.env)) return next();
    if (c.req.method === 'OPTIONS') {
      deliverySuppressed('http');
      return c.json({ success: false, error: 'Delivery disabled; endpoint unavailable in no-send mode' }, 423);
    }
    if (c.req.method === 'GET' && isNoSendStaticPath(rawRequestPath(c.req.url))) return serveStatic(c);
    await next();
  };
}
