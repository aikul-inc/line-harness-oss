import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { Hono } from 'hono';
import worker from '../index.js';
import { createNoSendStaticGate, isNoSendStaticPath } from '../lib/delivery-policy.js';
import { sqliteD1 } from '../test-support/sqlite-d1.js';

// Read-only paths opened in no-send mode (F-16). Every case also re-proves that
// the sending surface next to it is still refused with 423.
const schema = readFileSync(new NodeURL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');
const NO_SEND_MODES = [undefined, '', 'disabled', 'true', 'Enabled', ' enabled '];
const QUEUE_TABLES = [
  'friend_scenarios',
  'broadcasts',
  'messages_log',
  'booking_reminders',
  'event_booking_reminders',
  'meet_consultation_reminders',
];
const SEND_POSTS = [
  '/api/messages/push',
  '/api/messages/broadcast',
  '/api/broadcasts',
  '/api/liff/send-form-link',
  '/api/scenarios/example/enroll/friend',
  '/line-api/v2/bot/message/push',
];

afterEach(() => vi.restoreAllMocks());

function setup(mode?: string) {
  const { db, sqlite } = sqliteD1();
  sqlite.exec(schema);
  for (const id of ['a', 'b'])
    sqlite
      .prepare(
        'INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,login_channel_id,liff_id) VALUES(?,?,?,?,?,?,?)',
      )
      .run(id, `Synthetic ${id}`, `channel-${id}`, `synthetic-secret-${id}`, `synthetic-token-${id}`, `login-${id}`, `liff-${id}`);
  const attempted: string[] = [];
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    attempted.push(url);
    if (url === 'https://api.line.me/v2/bot/info') return Response.json({ basicId: '@synthetic' });
    throw Error('No external egress allowed');
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const sql: string[] = [];
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((statement: string) => {
    sql.push(statement);
    return prepare(statement);
  });
  const assetRequests: string[] = [];
  const assets: Record<string, [string, string]> = {
    '/': ['<!DOCTYPE html><title>synthetic liff</title>', 'text/html'],
    '/index.html': ['<!DOCTYPE html><title>synthetic liff</title>', 'text/html'],
    '/assets/main-synthetic.js': ['console.log("synthetic")', 'text/javascript'],
  };
  const ASSETS = {
    fetch: vi.fn(async (input: Request | string) => {
      const req = input instanceof Request ? input : new Request(input);
      const { pathname } = new URL(req.url);
      assetRequests.push(`${req.method} ${pathname}`);
      const hit = assets[pathname];
      return hit
        ? new Response(hit[0], { status: 200, headers: { 'Content-Type': hit[1] } })
        : new Response('not found', { status: 404 });
    }),
  };
  const env = {
    DB: db,
    ASSETS,
    DELIVERY_MODE: mode,
    API_KEY: 'synthetic-key',
    LINE_CHANNEL_SECRET: 'synthetic-secret-a',
    LINE_CHANNEL_ACCESS_TOKEN: 'synthetic-token-a',
    LINE_LOGIN_CHANNEL_ID: 'login-a',
    LINE_LOGIN_CHANNEL_SECRET: 'synthetic-secret',
    LIFF_URL: 'https://liff.line.me/123-Demo',
    WORKER_URL: 'https://synthetic.example',
  } as unknown as import('../index.js').Env['Bindings'];
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {},
  } as ExecutionContext;
  async function request(path: string, init?: RequestInit) {
    const r = await worker.fetch(new Request(`https://synthetic.example${path}`, init), env, ctx);
    await Promise.all(pending);
    return r;
  }
  function rowCounts() {
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => [name, (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n]),
    );
  }
  function assertNoQueues() {
    for (const table of QUEUE_TABLES)
      expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
  }
  async function expectSendingStillLocked() {
    for (const path of SEND_POSTS) {
      const r = await request(path, {
        method: 'POST',
        body: JSON.stringify({ scheduledAt: '2099-01-01T00:00:00Z' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(r.status, path).toBe(423);
      expect(await r.json()).toMatchObject({ success: false });
    }
  }
  return { sqlite, env, request, network, attempted, sql, ASSETS, assetRequests, rowCounts, assertNoQueues, expectSendingStillLocked };
}

describe('no-send read-only paths (F-16, local only)', () => {
  it.each(NO_SEND_MODES)('serves LIFF config from the DB without contacting LINE when mode is %s', async (mode) => {
    const s = setup(mode);
    try {
      const before = s.rowCounts();
      for (const account of ['a', 'b']) {
        const r = await s.request(`/api/liff/config?liffId=liff-${account}`);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({
          success: true,
          data: { botBasicId: '', accountName: `Synthetic ${account}`, accountId: account },
        });
      }
      const missing = await s.request('/api/liff/config');
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({ success: false });
      expect(s.sql.every((q) => /^\s*SELECT\b/i.test(q))).toBe(true);
      expect(s.network).not.toHaveBeenCalled();
      await s.expectSendingStillLocked();
      expect(s.rowCounts()).toEqual(before);
      s.assertNoQueues();
      expect(s.network).not.toHaveBeenCalled();
    } finally {
      s.sqlite.close();
    }
  });

  it('keeps the existing bot-info lookup only for exact DELIVERY_MODE=enabled', async () => {
    const s = setup('enabled');
    try {
      const r = await s.request('/api/liff/config?liffId=liff-a');
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({
        success: true,
        data: { botBasicId: '@synthetic', accountName: 'Synthetic a', accountId: 'a' },
      });
      expect(s.attempted).toEqual(['https://api.line.me/v2/bot/info']);
    } finally {
      s.sqlite.close();
    }
  });

  it.each(NO_SEND_MODES)('serves the bundled LIFF UI from static assets only when mode is %s', async (mode) => {
    const s = setup(mode);
    try {
      const before = s.rowCounts();
      const html = { headers: { Accept: 'text/html' } };
      for (const path of ['/', '/?page=book&liffId=liff-a', '/index.html']) {
        const r = await s.request(path, html);
        expect(r.status, path).toBe(200);
        expect(await r.text(), path).toContain('synthetic liff');
      }
      const js = await s.request('/assets/main-synthetic.js');
      expect(js.status).toBe(200);
      expect(js.headers.get('Content-Type')).toBe('text/javascript');
      // A missing asset passes the store's own 404 through instead of a route.
      expect((await s.request('/assets/missing.js')).status).toBe(404);
      expect(s.assetRequests).toEqual(['GET /', 'GET /', 'GET /index.html', 'GET /assets/main-synthetic.js', 'GET /assets/missing.js']);
      expect(s.sql).toEqual([]);
      expect(s.network).not.toHaveBeenCalled();
      await s.expectSendingStillLocked();
      expect(s.rowCounts()).toEqual(before);
      s.assertNoQueues();
    } finally {
      s.sqlite.close();
    }
  });

  it('answers link-preview bots with read-only OGP HTML in no-send mode', async () => {
    const s = setup();
    try {
      const before = s.rowCounts();
      const r = await s.request('/?liffId=liff-a', { headers: { 'User-Agent': 'facebookexternalhit/1.1' } });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('og:');
      expect(s.sql.length).toBeGreaterThan(0);
      expect(s.sql.every((q) => /^\s*SELECT\b/i.test(q))).toBe(true);
      expect(s.ASSETS.fetch).not.toHaveBeenCalled();
      expect(s.network).not.toHaveBeenCalled();
      await s.expectSendingStillLocked();
      expect(s.rowCounts()).toEqual(before);
    } finally {
      s.sqlite.close();
    }
  });

  it.each(NO_SEND_MODES)('answers CORS preflight only for paths whose real request is allowed (mode %s)', async (mode) => {
    const s = setup(mode);
    try {
      const before = s.rowCounts();
      const preflight = (method: string) => ({
        method: 'OPTIONS',
        headers: {
          Origin: 'https://synthetic.example',
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      for (const [path, method] of [
        ['/api/liff/config', 'GET'],
        ['/api/liff/link', 'POST'],
        ['/api/auth/session', 'GET'],
        ['/webhook', 'POST'],
        ['/', 'GET'],
        ['/index.html', 'GET'],
        ['/assets/main-synthetic.js', 'GET'],
      ]) {
        const r = await s.request(path, preflight(method));
        expect(r.status, path).toBe(204);
        expect(r.headers.get('Access-Control-Allow-Origin'), path).toBe('https://synthetic.example');
        expect(r.headers.get('Access-Control-Allow-Methods'), path).toContain(method);
        expect(await r.text(), path).toBe('');
      }
      expect(s.sql).toEqual([]);
      expect(s.ASSETS.fetch).not.toHaveBeenCalled();
      expect(s.network).not.toHaveBeenCalled();
      await s.expectSendingStillLocked();
      expect(s.rowCounts()).toEqual(before);
      s.assertNoQueues();
    } finally {
      s.sqlite.close();
    }
  });

  it.each(NO_SEND_MODES)('still refuses unverified neighbours of the new read paths with 423 (mode %s)', async (mode) => {
    const s = setup(mode);
    try {
      const before = s.rowCounts();
      const cases: [string, string][] = [
        ['OPTIONS', '/api/messages/push'],
        ['OPTIONS', '/api/liff/send-form-link'],
        ['OPTIONS', '/api/broadcasts'],
        ['OPTIONS', '/api/public/media-inquiries'],
        ['OPTIONS', '/api/liff/profile'],
        ['HEAD', '/'],
        ['HEAD', '/api/liff/config'],
        ['POST', '/api/liff/config'],
        ['POST', '/'],
        ['POST', '/assets/main-synthetic.js'],
        ['GET', '/assets/'],
        ['GET', '/assets/nested/main.js'],
        ['GET', '/favicon.ico'],
        ['GET', '/book'],
        ['GET', '/o'],
        ['GET', '/r/demo-route/help'],
        ['GET', '/api/qr'],
        ['GET', '/api/forms/example'],
        ['GET', '/console'],
        ['GET', '/liff-app/'],
        ['GET', '/unknown-side-effect'],
        ['POST', '/api/liff/profile'],
        ['POST', '/api/affiliates/click'],
        ['POST', '/api/liff/send-form-link'],
      ];
      for (const [method, path] of cases) {
        const r = await s.request(path, { method, headers: { Accept: 'text/html', Origin: 'https://synthetic.example' } });
        expect(r.status, `${method} ${path}`).toBe(423);
      }
      expect(s.sql).toEqual([]);
      expect(s.ASSETS.fetch).not.toHaveBeenCalled();
      expect(s.network).not.toHaveBeenCalled();
      await s.expectSendingStillLocked();
      expect(s.rowCounts()).toEqual(before);
      s.assertNoQueues();
    } finally {
      s.sqlite.close();
    }
  });

  it('leaves static serving unchanged for DELIVERY_MODE=enabled', async () => {
    const s = setup('enabled');
    try {
      const r = await s.request('/', { headers: { Accept: 'text/html' } });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('synthetic liff');
      expect(s.assetRequests).toEqual(['GET /']);
      expect(s.network).not.toHaveBeenCalled();
    } finally {
      s.sqlite.close();
    }
  });

  it.each([
    [undefined, 'static', 0],
    ['disabled', 'static', 0],
    ['enabled', 'route', 1],
  ] as const)('never lets a route on a static path run in no-send mode (mode %s)', async (mode, body, calls) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const route = vi.fn((c: import('hono').Context) => c.text('route'));
    const serveStatic = vi.fn(async (c: import('hono').Context) => c.text('static'));
    const app = new Hono<import('../index.js').Env>();
    app.use('*', createNoSendStaticGate(serveStatic));
    app.get('/', route);
    app.get('/assets/:file', route);
    app.get('/other', route);
    app.options('/', route);
    const env = { DELIVERY_MODE: mode } as import('../index.js').Env['Bindings'];
    for (const path of ['/', '/assets/main.js']) {
      const r = await app.request(path, {}, env);
      expect(await r.text(), path).toBe(body);
    }
    expect(route).toHaveBeenCalledTimes(calls * 2);
    // Non-static paths are left to the outer allowlist; the gate itself passes them on.
    expect(await (await app.request('/other', {}, env)).text()).toBe('route');
    // A preflight that reaches the gate is refused instead of routed in no-send mode.
    expect((await app.request('/', { method: 'OPTIONS' }, env)).status).toBe(mode === 'enabled' ? 200 : 423);
  });

  // Evaluator finding (eval-DIS-67-read-paths.md §7-1): Hono's c.req.path is
  // decodeURI'd, so '%2f' looked like one segment. The static check now uses the
  // raw pathname the static store receives. Some inputs are normalised by the
  // URL parser before the Worker sees them ('..', '%2e%2e' segments, literal
  // backslashes); they are listed too and must land on a refused path.
  const MALFORMED_STATIC_PATHS = [
    '/assets/..%2f..%2fapi%2fliff%2flink',
    '/assets/..%2F..%2Fapi%2Fliff%2Flink',
    '/assets/%2e%2e%2fapi%2fliff%2flink',
    '/assets/%2E%2E%2Fapi%2Fliff%2Flink',
    '/assets/%2e%2e/api/liff/send-form-link',
    '/assets/%2E%2E/api/messages/push',
    '/assets/%252e%252e%252fapi%252fliff%252flink',
    '/assets/%252fmain-synthetic.js',
    '/assets/../api/liff/send-form-link',
    '/assets/../../api/messages/push',
    '/assets\\..\\api\\liff\\send-form-link',
    '/assets/%5cmain-synthetic.js',
    '/assets/%5C..%5Capi%5Cliff%5Clink',
    '/assets/main-synthetic.js/',
    '/assets/',
    '/index.html/',
    '//',
    '//assets/main-synthetic.js',
    '/assets//main-synthetic.js',
    '//index.html',
    '/%69ndex.html',
    '/assets/%6dain-synthetic.js',
    '/assets/.hidden',
    '/assets/main..js',
    '/assets/main-synthetic.js.',
    '/assets/main synthetic.js',
  ];

  it.each(NO_SEND_MODES)('refuses encoded, traversal and malformed static paths with 423 (mode %s)', async (mode) => {
    const s = setup(mode);
    try {
      const before = s.rowCounts();
      for (const path of MALFORMED_STATIC_PATHS) {
        const get = await s.request(path, { headers: { Accept: 'text/html' } });
        expect(get.status, `GET ${path}`).toBe(423);
        const preflight = await s.request(path, {
          method: 'OPTIONS',
          headers: { Origin: 'https://synthetic.example', 'Access-Control-Request-Method': 'GET' },
        });
        expect(preflight.status, `OPTIONS ${path}`).toBe(423);
      }
      expect(s.ASSETS.fetch).not.toHaveBeenCalled();
      expect(s.sql).toEqual([]);
      expect(s.network).not.toHaveBeenCalled();
      await s.expectSendingStillLocked();
      expect(s.rowCounts()).toEqual(before);
      s.assertNoQueues();
    } finally {
      s.sqlite.close();
    }
  });

  it('judges exactly the pathname the static store receives', async () => {
    const s = setup();
    try {
      // The parser folds these into the canonical file before the Worker runs,
      // so the check and the static store see the same, allowed pathname.
      for (const path of ['/assets/./main-synthetic.js', '/assets\\main-synthetic.js']) {
        expect((await s.request(path)).status, path).toBe(200);
      }
      expect(s.assetRequests).toEqual(['GET /assets/main-synthetic.js', 'GET /assets/main-synthetic.js']);
      // A traversal onto an API path is judged as that API path, never as static:
      // GET /api/liff/link is refused; its preflight is the ordinary allowed one.
      for (const path of ['/assets/../api/liff/link', '/assets/%2e%2e/api/liff/link']) {
        expect((await s.request(path)).status, path).toBe(423);
        expect((await s.request(path, { method: 'OPTIONS', headers: { Origin: 'https://synthetic.example' } })).status, path).toBe(204);
      }
      expect(s.ASSETS.fetch).toHaveBeenCalledTimes(2);
      expect(s.sql).toEqual([]);
      expect(s.network).not.toHaveBeenCalled();
    } finally {
      s.sqlite.close();
    }
  });

  it('accepts every file name of the current bundled LIFF build and nothing encoded', () => {
    for (const name of [
      'client-auj285-g.js',
      'hls-CWrIGcEr.js',
      'index-gY8jlH94.js',
      'main-BLtCzkF9.css',
      'main-CKixgttO.css',
      'main-CXG6-GDE.css',
      'main-CcMcVBon.js',
      'main-DCwrQdc9.js',
      'main-DM33bSmT.css',
      'main-DukyEqt-.js',
      'main-yXpynJVd.js',
      'chunk_a-b.min.js',
    ])
      expect(isNoSendStaticPath(`/assets/${name}`), name).toBe(true);
    for (const raw of MALFORMED_STATIC_PATHS.map((p) => new URL(`https://synthetic.example${p}`).pathname))
      expect(isNoSendStaticPath(raw), raw).toBe(false);
    for (const raw of ['/assets/a%2fb.js', '/assets/..', '/assets/.', '/assets/a\\b.js', '/assets/a.js?x', '/assets/a'])
      expect(isNoSendStaticPath(raw), raw).toBe(false);
  });
});
