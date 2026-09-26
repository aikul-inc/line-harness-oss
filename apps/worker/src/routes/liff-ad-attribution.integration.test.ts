import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { Hono } from 'hono';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { liffRoutes } from './liff.js';
import { trackedLinks } from './tracked-links.js';
import { getFriendJourney } from '@line-crm/db';

// No credentials, sockets, or real API calls: every fetch is intercepted.
// Only synthetic OAuth identity responses are supplied; everything else fails closed.
const schema = readFileSync(new NodeURL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');
const ad = { gclid: 'fake-google', fbclid: 'fake-meta', utm_source: 'meta', utm_medium: 'paid social', utm_campaign: 'デモ', utm_content: 'creative-A', utm_term: 'keyword' };
afterEach(() => vi.restoreAllMocks());
function setup() {
  const { db, sqlite } = sqliteD1(); sqlite.exec(schema);
  sqlite.exec("INSERT INTO entry_routes(id,ref_code,name,run_account_friend_add_scenarios) VALUES('route','demo-route','Synthetic route',0)");
  const blocked: string[] = [];
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const fixtures: Record<string, unknown> = {
      'https://api.line.me/oauth2/v2.1/token': { access_token: 'synthetic', id_token: 'synthetic' },
      'https://api.line.me/oauth2/v2.1/verify': { sub: 'synthetic-user', name: 'Synthetic' },
      'https://api.line.me/v2/profile': { userId: 'synthetic-user', displayName: 'Synthetic' },
    };
    if (Object.hasOwn(fixtures, url)) return Response.json(fixtures[url]);
    blocked.push(url); throw new Error('LOCAL ONLY: outbound request blocked');
  });
  const app = new Hono(); app.route('/', liffRoutes); app.route('/', trackedLinks);
  const env = { DELIVERY_MODE: 'enabled', DB: db, LINE_LOGIN_CHANNEL_ID: '123', LINE_LOGIN_CHANNEL_SECRET: 'synthetic', LINE_CHANNEL_ACCESS_TOKEN: 'synthetic', LIFF_URL: 'https://liff.line.me/123-Demo', WORKER_URL: 'https://synthetic.example' };
  const request = async (path: string, headers = {}) => {
    const pending: Promise<unknown>[] = [];
    const response = await app.request(path, { headers }, env, { waitUntil(p:Promise<unknown>) { pending.push(p); }, passThroughOnException() {} } as ExecutionContext);
    await Promise.all(pending);
    return response;
  };
  return { sqlite, db, request, network, blocked };
}

describe('local advertising attribution, no real egress', () => {
  it('preserves every ad parameter in the mobile LIFF redirect and desktop QR', async () => {
    const s = setup(); try {
      const query = new URLSearchParams(ad);
      const mobile = await s.request(`/auth/line?${query}`, { 'user-agent': 'iPhone' });
      const mobileUrl = new URL(mobile.headers.get('location')!);
      for (const [key, value] of Object.entries(ad)) expect(mobileUrl.searchParams.get(key), key).toBe(value);
      const desktop = await s.request(`/auth/line?${query}`);
      const html = await desktop.text();
      const qr = new URL(decodeURIComponent(html.match(/data=([^"\s]+)/)![1]));
      for (const [key, value] of Object.entries(ad)) expect(qr.searchParams.get(key), key).toBe(value);
      expect(s.network).not.toHaveBeenCalled();
    } finally { s.sqlite.close(); }
  });

  it('follows a tracked destination through auth into the mobile LIFF URL without network', async () => {
    const s = setup(); try {
      const destination = `https://synthetic.example/auth/line?${new URLSearchParams(ad)}`;
      s.sqlite.prepare("INSERT INTO tracked_links(id,name,original_url) VALUES('ad-link','Synthetic',?)").run(destination);
      const tracked = await s.request('/t/ad-link', { 'user-agent': 'iPhone' });
      expect(tracked.headers.get('location')).toBe(destination);
      const auth = await s.request(tracked.headers.get('location')!, { 'user-agent': 'iPhone' });
      const liff = new URL(auth.headers.get('location')!);
      for (const [key,value] of Object.entries(ad)) expect(liff.searchParams.get(key),key).toBe(value);
      expect(s.sqlite.prepare("SELECT click_count FROM tracked_links WHERE id='ad-link'").get()).toEqual({click_count:1});
      expect(s.network).not.toHaveBeenCalled();
    } finally { s.sqlite.close(); }
  });

  it.each(['direct', 'liff.state'])('carries %s OAuth state through the real callback into friend metadata and route tracking', async (shape) => {
    const s = setup(); try {
      const fields = new URLSearchParams({ ...ad, ref: 'demo-route', redirect: '/complete' });
      const query = shape === 'direct' ? fields : new URLSearchParams({ 'liff.state': '/?' + fields.toString() });
      const auth = await s.request(`/auth/oauth?${query}`);
      const state = new URL(auth.headers.get('location')!).searchParams.get('state')!;
      const callback = await s.request(`/auth/callback?code=synthetic&state=${encodeURIComponent(state)}`);
      expect(callback.status).toBe(302);
      const friend = s.sqlite.prepare('SELECT id,metadata,ref_code FROM friends').get() as { id:string; metadata:string; ref_code:string };
      expect(JSON.parse(friend.metadata)).toMatchObject(ad);
      expect(friend.ref_code).toBe('demo-route');
      expect(s.sqlite.prepare('SELECT entry_route_id,gclid,fbclid FROM ref_tracking').get()).toMatchObject({ entry_route_id:'route', gclid:ad.gclid, fbclid:ad.fbclid });
      const journey = await getFriendJourney(s.db, friend.id);
      expect(journey.map(e => e.type).sort()).toEqual(['friend_add','touch']);
      // friend_add is created_at, not an observed follow timestamp: no false touch-first assertion.
      expect(s.blocked).toEqual([]);
      expect(s.network).toHaveBeenCalledTimes(3);
    } finally { s.sqlite.close(); }
  });

  it('still attempts a form push when account friend_add scenarios are disabled; local egress blocks it', async () => {
    const s = setup(); try {
      const auth = await s.request(`/auth/oauth?${new URLSearchParams({ ref:'demo-route', form:'synthetic-form' })}`);
      const state = new URL(auth.headers.get('location')!).searchParams.get('state')!;
      await s.request(`/auth/callback?code=synthetic&state=${encodeURIComponent(state)}`);
      expect(s.blocked).toContain('https://api.line.me/v2/bot/message/push');
      expect(s.sqlite.prepare('SELECT COUNT(*) AS n FROM friends').get()).toEqual({ n: 1 });
    } finally { s.sqlite.close(); }
  });
});
