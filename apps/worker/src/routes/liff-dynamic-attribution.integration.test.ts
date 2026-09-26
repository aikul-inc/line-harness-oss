import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { upsertFriend } from '@line-crm/db';
import worker from '../index.js';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { attributionFromSearch, linkRequestWithAttribution } from '../client/ad-attribution.js';

const schema = readFileSync(new NodeURL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');
const values = {
  gclid: 'dynamic-google',
  fbclid: 'dynamic-meta',
  utm_source: 'meta',
  utm_medium: 'paid',
  utm_campaign: 'デモ',
  utm_content: 'A',
  utm_term: 'B',
};
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const { db, sqlite } = sqliteD1();
  sqlite.exec(schema);
  for (const a of ['a', 'b'])
    sqlite
      .prepare(
        'INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret,login_channel_id,liff_id) VALUES(?,?,?,?,?,?,?)',
      )
      .run(a, a, `channel-${a}`, 'synthetic', 'synthetic', `login-${a}`, `123-${a}`);
  const friend = await upsertFriend(db, { lineUserId: 'synthetic-user' });
  sqlite
    .prepare("UPDATE friends SET line_account_id='a',metadata=?,ref_code='first' WHERE id=?")
    .run(JSON.stringify({ gclid: 'old', utm_source: 'old', keep: 'keep' }), friend.id);
  sqlite.exec("INSERT INTO entry_routes(id,name,ref_code) VALUES('route','Synthetic','campaign')");
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) === 'https://api.line.me/oauth2/v2.1/verify') {
      const params = new URLSearchParams(String(init?.body));
      const token = params.get('id_token');
      return token === 'valid'
        ? Response.json({ sub: 'synthetic-user' })
        : token === 'valid-b' && params.get('client_id') === 'login-b'
          ? Response.json({ sub: 'synthetic-user-b' })
          : new Response('{}', { status: 401 });
    }
    throw Error('Real network forbidden');
  });
  const env = {
    DB: db,
    LINE_LOGIN_CHANNEL_ID: 'login-a',
    API_KEY: 'synthetic',
    LIFF_URL: 'https://liff.line.me/123-a',
    WORKER_URL: 'https://synthetic.example',
  } as import('../index.js').Env['Bindings'];
  async function request(path: string, init?: RequestInit) {
    const pending: Promise<unknown>[] = [];
    const res = await worker.fetch(new Request(new URL(path, 'https://synthetic.example'), init), env, {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
      passThroughOnException() {},
    } as ExecutionContext);
    await Promise.all(pending);
    return res;
  }
  return { sqlite, db, friend, env, request, fetchMock };
}

describe('dynamic tracked ads through LIFF SDK to verified friend', () => {
  it('preserves dynamic allowlisted values through tracked→auth→landing→LIFF body→DB', async () => {
    const s = await setup();
    try {
      s.sqlite
        .prepare("INSERT INTO tracked_links(id,name,original_url) VALUES('link','Synthetic',?)")
        .run('https://synthetic.example/auth/line?ref=campaign&account=channel-a&utm_source=saved');
      const query = new URLSearchParams({
        ...values,
        account: 'channel-b',
        ref: 'injected',
        redirect: 'https://untrusted.example',
      });
      const tracked = await s.request(`/t/link?${query}`, { headers: { 'user-agent': 'iPhone' } });
      const target = new URL(tracked.headers.get('location')!);
      expect(target.searchParams.get('account')).toBe('channel-a');
      expect(target.searchParams.get('ref')).toBe('campaign');
      expect(target.searchParams.has('redirect')).toBe(false);
      const auth = await s.request(target.toString(), { headers: { 'user-agent': 'iPhone' } });
      const landing = await s.request(auth.headers.get('location')!, { headers: { 'user-agent': 'iPhone' } });
      const html = await landing.text();
      // Rendered landing embeds the actual LIFF target; extract it without running remote SDK.
      const encoded = html.match(/https:\/\/liff\.line\.me\/123-a\?[^"<>\s]+/)![0].replaceAll('&amp;', '&');
      const liffUrl = new URL(encoded);
      for (const [key, value] of Object.entries(values)) expect(liffUrl.searchParams.get(key), key).toBe(value);
      const initial = attributionFromSearch(liffUrl.search);
      const body = linkRequestWithAttribution(
        { method: 'POST', body: JSON.stringify({ idToken: 'valid', ref: 'campaign' }) },
        initial,
        '',
      );
      const linked = await s.request('/api/liff/link', body);
      expect(linked.status).toBe(200);
      const row = s.sqlite.prepare('SELECT metadata,ref_code FROM friends WHERE id=?').get(s.friend.id) as {
        metadata: string;
        ref_code: string;
      };
      expect(JSON.parse(row.metadata)).toMatchObject({ ...values, keep: 'keep' });
      expect(row.ref_code).toBe('first');
      expect(s.sqlite.prepare('SELECT entry_route_id,gclid,fbclid,utm_source FROM ref_tracking').get()).toMatchObject({
        entry_route_id: 'route',
        gclid: values.gclid,
        fbclid: values.fbclid,
        utm_source: 'meta',
      });
      expect(s.sqlite.prepare('SELECT COUNT(*) AS n FROM friend_scenarios').get()).toEqual({ n: 0 });
      expect(s.fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      s.sqlite.close();
    }
  });
  it('preserves stored and dynamic ads across the LINE identification bounce without forwarding arbitrary keys', async () => {
    const s = await setup();
    try {
      s.sqlite
        .prepare("INSERT INTO tracked_links(id,name,original_url,line_account_id) VALUES('link','Synthetic',?,'a')")
        .run('https://destination.example/path?utm_campaign=saved&gclid=saved#section');
      const response = await s.request('/t/link?gclid=dynamic&fbclid=new&account=b&ref=bad&redirect=bad', {
        headers: { 'user-agent': 'Line/14' },
      });
      const liff = new URL(response.headers.get('location')!);
      expect(liff.pathname).toBe('/123-a');
      expect(liff.searchParams.get('utm_campaign')).toBe('saved');
      expect(liff.searchParams.get('gclid')).toBe('dynamic');
      expect(liff.searchParams.has('account')).toBe(false);
      expect(liff.searchParams.has('ref')).toBe(false);
      const bounce = new URL(liff.searchParams.get('redirect')!);
      expect(bounce.origin).toBe('https://synthetic.example');
      expect(bounce.searchParams.get('fbclid')).toBe('new');
      bounce.searchParams.set('f', s.friend.id);
      const final = await s.request(bounce.toString(), { headers: { 'user-agent': 'Line/14' } });
      const target = new URL(final.headers.get('location')!);
      expect(target.origin).toBe('https://destination.example');
      expect(target.hash).toBe('#section');
      expect(target.searchParams.get('gclid')).toBe('dynamic');
      expect(target.searchParams.get('utm_campaign')).toBe('saved');
      expect(target.searchParams.has('account')).toBe(false);
      expect(s.fetchMock).not.toHaveBeenCalled();
    } finally {
      s.sqlite.close();
    }
  });
  it('restores valid LIFF state ads and updates only the verified account friend on first and repeated linking', async () => {
    const s = await setup();
    try {
      const friendB = await upsertFriend(s.db, { lineUserId: 'synthetic-user-b' });
      s.sqlite.prepare("UPDATE friends SET line_account_id='b' WHERE id=?").run(friendB.id);
      s.env.LINE_LOGIN_CHANNEL_ID = 'login-b';
      const beforeA = s.sqlite.prepare('SELECT metadata FROM friends WHERE id=?').get(s.friend.id);
      const state = '/?' + new URLSearchParams(values);
      const query = '?' + new URLSearchParams({ 'liff.state': state, gclid: ' ', utm_source: 'direct' });
      for (const alreadyLinked of [false, true]) {
        const body = linkRequestWithAttribution(
          {
            method: 'POST',
            body: JSON.stringify({ idToken: 'valid-b', ref: 'campaign', account: 'a', userId: s.friend.id }),
          },
          attributionFromSearch(query),
          '',
        );
        const response = await s.request('/api/liff/link', body);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ success: true, data: { alreadyLinked } });
      }
      const row = s.sqlite.prepare('SELECT metadata FROM friends WHERE id=?').get(friendB.id) as { metadata: string };
      expect(JSON.parse(row.metadata)).toMatchObject({ ...values, utm_source: 'direct' });
      expect(s.sqlite.prepare('SELECT metadata FROM friends WHERE id=?').get(s.friend.id)).toEqual(beforeA);
      expect(s.sqlite.prepare('SELECT friend_id,gclid FROM ref_tracking').all()).toEqual([
        { friend_id: friendB.id, gclid: values.gclid },
        { friend_id: friendB.id, gclid: values.gclid },
      ]);
    } finally {
      s.sqlite.close();
    }
  });
  it('does not write advertising data before ID-token verification or across accounts', async () => {
    const s = await setup();
    try {
      const before = s.sqlite.prepare('SELECT metadata FROM friends').get();
      const invalid = await s.request('/api/liff/link', {
        method: 'POST',
        body: JSON.stringify({ idToken: 'invalid', attribution: values }),
      });
      expect(invalid.status).toBe(401);
      s.env.LINE_LOGIN_CHANNEL_ID = 'login-b';
      const other = await s.request('/api/liff/link', {
        method: 'POST',
        body: JSON.stringify({
          idToken: 'valid',
          userId: s.friend.id,
          account: 'a',
          ref: 'campaign',
          attribution: values,
        }),
      });
      expect(other.status).toBe(403);
      expect(s.sqlite.prepare('SELECT metadata FROM friends').get()).toEqual(before);
      expect(s.sqlite.prepare('SELECT COUNT(*) AS n FROM ref_tracking').get()).toEqual({ n: 0 });
    } finally {
      s.sqlite.close();
    }
  });
  it('rejects an unassigned legacy friend when registered accounts exist', async () => {
    const s = await setup();
    try {
      s.sqlite.prepare('UPDATE friends SET line_account_id=NULL WHERE id=?').run(s.friend.id);
      const before = s.sqlite.prepare('SELECT metadata FROM friends').get();
      const response = await s.request('/api/liff/link', {
        method: 'POST',
        body: JSON.stringify({ idToken: 'valid', ref: 'campaign', attribution: values }),
      });
      expect(response.status).toBe(403);
      expect(s.sqlite.prepare('SELECT metadata FROM friends').get()).toEqual(before);
    } finally {
      s.sqlite.close();
    }
  });
  it('ignores invalid or empty fields and keeps existing metadata, while accepting valid nonempty updates', async () => {
    const s = await setup();
    try {
      const response = await s.request('/api/liff/link', {
        method: 'POST',
        body: JSON.stringify({
          idToken: 'valid',
          ref: 'campaign',
          attribution: {
            gclid: ' ',
            fbclid: ['bad'],
            utm_source: 'x'.repeat(513),
            utm_medium: 'bad\nvalue',
            utm_term: 42,
            utm_content: '  new  ',
            account: 'b',
          },
        }),
      });
      expect(response.status).toBe(200);
      const row = s.sqlite.prepare('SELECT metadata FROM friends').get() as { metadata: string };
      expect(JSON.parse(row.metadata)).toEqual({ gclid: 'old', utm_source: 'old', keep: 'keep', utm_content: 'new' });
    } finally {
      s.sqlite.close();
    }
  });
});
