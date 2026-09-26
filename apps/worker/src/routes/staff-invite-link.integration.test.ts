// konkatsucafe fork (L-06, docs/spec/2026-09-25-l06-staff-invite-link.md F2):
// 計測リンクを LINE の中で押す → LIFF で本人を確かめる → /t に戻ってクリックを記録 → 予約画面 → 予約。
// L Harness より前からの友だち（friends に行がない人）でも、クリック・広告値・予約が同じ friends の id でつながる。
// すべて架空値。LINE への通信は fetch を置き換えて記録し、外へは出さない。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import worker from '../index.js';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { attributionFromSearch, linkRequestWithAttribution } from '../client/ad-attribution.js';

const schema = readFileSync(new NodeURL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');
afterEach(() => vi.restoreAllMocks());

const LIFF_ID = 'login-a-Demo';
const PROFILE = 'https://api.line.me/v2/bot/profile/';
const LINE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Line/14.0.0';
const DESTINATION = `https://liff.line.me/${LIFF_ID}?page=salon-book&utm_source=line_demo&utm_medium=staff_invite&utm_campaign=2026-09-26_demo`;
const UTM = { utm_source: 'line_demo', utm_medium: 'staff_invite', utm_campaign: '2026-09-26_demo' };

const INTAKE = {
  sei: '架空',
  mei: '花子',
  gender: '女性',
  age: '32歳',
  tel: '09000000000',
  lineName: 'はなこ',
  visitCount: '1名',
  agreeTerms: true,
  experience: ['未経験'],
  message: '',
};

function jstDate(days: number): string {
  return new Date(Date.now() + 9 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
}

/** 明日の確認で D1 に投げる読み取りと同じ突き合わせ（報告の 6 章）。 */
const LINK_TO_BOOKING_SQL = `
SELECT lc.friend_id, lc.clicked_at, b.id AS booking_id, b.requested_at, b.status,
       json_extract(f.metadata, '$.utm_campaign') AS utm_campaign
  FROM link_clicks lc
  JOIN tracked_links tl ON tl.id = lc.tracked_link_id
  JOIN bookings b ON b.friend_id = lc.friend_id
  JOIN friends f ON f.id = lc.friend_id
 WHERE tl.name = ?
   AND julianday(b.requested_at) >= julianday(lc.clicked_at)
 ORDER BY lc.clicked_at`;

function setup(options: { profileStatus?: number; noAccounts?: boolean } = {}) {
  const { db: base, sqlite } = sqliteD1();
  sqlite.exec(schema);
  // 予約の SQL は番号付きの引数（?1 など）と batch を使うので、このテストの中だけで補う（booking-intake と同じ）。
  const db = {
    prepare(sql: string) {
      const stmt = base.prepare(sql);
      if (!/\?\d/.test(sql)) return stmt;
      return {
        ...stmt,
        bind: (...args: unknown[]) => stmt.bind(Object.fromEntries(args.map((value, i) => [i + 1, value]))),
      } as D1PreparedStatement;
    },
    async batch(stmts: D1PreparedStatement[]) {
      const out = [];
      for (const stmt of stmts) out.push(await stmt.run());
      return out;
    },
  } as unknown as D1Database;
  const account = sqlite.prepare(
    'INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,login_channel_id,liff_id) VALUES(?,?,?,?,?,?,?)',
  );
  if (!options.noAccounts) {
    account.run('a', 'Demo A', 'channel-a', 'synthetic-secret-a', 'synthetic-token-a', 'login-a', LIFF_ID);
    account.run('b', 'Demo B', 'channel-b', 'synthetic-secret-b', 'synthetic-token-b', 'login-b', 'login-b-Other');
    sqlite.exec(`
      INSERT INTO staff(id,line_account_id,name,display_name) VALUES('st','a','カフェ受付（デモ）','カフェ受付');
      INSERT INTO menus(id,line_account_id,name,description,duration_minutes,base_price)
        VALUES('m1','a','パンケーキ＆タブレットセット','デモ用の仮設定',30,1400);
      INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES('st','m1',1);
      INSERT INTO friends(id,line_user_id,display_name,is_following,line_account_id)
        VALUES('f-known','user-known','Known Friend',1,'a');
      INSERT INTO friends(id,line_user_id,display_name,is_following,line_account_id)
        VALUES('f-elsewhere','user-elsewhere','Elsewhere',1,'b');
    `);
  }

  // LINE 上で友だちの人（プロフィール照会が 200）。user-stranger は友だちでない。
  const followers: Record<string, string> = {
    'user-known': 'Known Friend',
    'user-early': 'Early Staff',
    'user-elsewhere': 'Elsewhere',
  };
  const pushes: Array<{ to: string; text: string }> = [];
  const profileLookups: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === 'https://api.line.me/oauth2/v2.1/verify') {
      const form = new URLSearchParams(String(init?.body));
      const token = form.get('id_token') ?? '';
      if (form.get('client_id') !== 'login-a' || !token.startsWith('token-')) {
        return Response.json({ error: 'invalid_request' }, { status: 400 });
      }
      return Response.json({ sub: token.slice('token-'.length) });
    }
    if (url.startsWith(PROFILE)) {
      const userId = decodeURIComponent(url.slice(PROFILE.length));
      profileLookups.push(userId);
      if (options.profileStatus) return new Response('upstream', { status: options.profileStatus });
      const name = followers[userId];
      return name ? Response.json({ userId, displayName: name }) : Response.json({}, { status: 404 });
    }
    if (url === 'https://api.line.me/v2/bot/message/push') {
      const body = JSON.parse(String(init?.body)) as { to: string; messages: Array<{ text: string }> };
      pushes.push({ to: body.to, text: body.messages[0].text });
      return Response.json({});
    }
    throw Error(`No external egress allowed: ${url}`);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const env = {
    DB: db,
    DELIVERY_MODE: 'enabled',
    BOOKING_INTAKE: 'konkatsucafe-demo',
    API_KEY: 'synthetic-key',
    LINE_CHANNEL_SECRET: 'synthetic-secret-a',
    LINE_CHANNEL_ACCESS_TOKEN: 'synthetic-token-a',
    LINE_LOGIN_CHANNEL_ID: 'login-a',
    LIFF_URL: `https://liff.line.me/${LIFF_ID}`,
    WORKER_URL: 'https://synthetic.example',
  } as import('../index.js').Env['Bindings'];
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {},
  } as ExecutionContext;
  async function request(path: string, init?: RequestInit) {
    const r = await worker.fetch(new Request(new URL(path, 'https://synthetic.example'), init), env, ctx);
    await Promise.all(pending);
    return r;
  }
  const admin = { Authorization: 'Bearer synthetic-key', 'Content-Type': 'application/json' };
  async function createLink() {
    const r = await request('/api/tracked-links', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: '【デモ】スタッフ向け予約のご案内 2026-09-26',
        originalUrl: DESTINATION,
        lineAccountId: 'a',
      }),
    });
    expect(r.status).toBe(201);
    return ((await r.json()) as { data: { id: string; trackingUrl: string } }).data;
  }
  /** LIFF の linkAndAddFlow と同じ: 開いた URL の広告値を本文に添えて /api/liff/link を呼ぶ。 */
  async function liffLink(liffUrl: URL, idToken: string) {
    const init = linkRequestWithAttribution(
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) },
      attributionFromSearch(liffUrl.search),
      '',
    );
    return request('/api/liff/link', init);
  }
  const date = new Date(`${jstDate(3)}T00:00:00Z`).getUTCDay() === 2 ? jstDate(4) : jstDate(3);
  const startsAt = new Date(`${date}T14:00:00+09:00`).toISOString();
  async function book(idToken: string) {
    return request(`/api/liff/booking/requests?liffId=${LIFF_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ starts_at: startsAt, intake: INTAKE }),
    });
  }
  const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { sqlite, request, createLink, liffLink, book, pushes, profileLookups, count };
}

describe('staff invite: tracked link → LIFF → click → booking for a follower from before L Harness', () => {
  it('ties the click, the ad values and the booking to one friends id (and sends nothing until the booking)', async () => {
    const s = setup();
    try {
      const link = await s.createLink();
      const path = new URL(link.trackingUrl).pathname;
      expect(path).toMatch(/^\/t\/[A-Za-z0-9_-]+$/);

      // 1. LINE の中で押す → LIFF へ回る。この時点ではクリックを記録しない
      const first = await s.request(path, { headers: { 'user-agent': LINE_UA } });
      expect(first.status).toBe(302);
      const liff = new URL(first.headers.get('location')!);
      expect(`${liff.origin}${liff.pathname}`).toBe(`https://liff.line.me/${LIFF_ID}`);
      for (const [k, v] of Object.entries(UTM)) expect(liff.searchParams.get(k), k).toBe(v);
      for (const k of ['gclid', 'fbclid', 'ref']) expect(liff.searchParams.has(k), k).toBe(false);
      expect(s.count('link_clicks')).toBe(0);

      // 2. LIFF が本人を確かめる。前からの友だちはここで登録され、広告値が残る
      expect(s.count('friends')).toBe(2);
      const linked = await s.liffLink(liff, 'token-user-early');
      expect(linked.status).toBe(200);
      const friend = s.sqlite
        .prepare('SELECT id,line_account_id,is_following,first_followed_at,metadata,ref_code FROM friends WHERE line_user_id=?')
        .get('user-early') as Record<string, string | number | null>;
      expect(friend).toMatchObject({ line_account_id: 'a', is_following: 1, first_followed_at: null, ref_code: null });
      expect(JSON.parse(String(friend.metadata))).toMatchObject(UTM);
      expect(s.profileLookups).toEqual(['user-early']);

      // 3. /t に lu を付けて戻る → クリックがその人に結び付き、予約画面へ
      const bounce = new URL(liff.searchParams.get('redirect')!);
      bounce.searchParams.set('lu', 'user-early');
      const second = await s.request(`${bounce.pathname}${bounce.search}`, { headers: { 'user-agent': LINE_UA } });
      expect(second.status).toBe(302);
      const dest = new URL(second.headers.get('location')!);
      expect(`${dest.origin}${dest.pathname}`).toBe(`https://liff.line.me/${LIFF_ID}`);
      expect(dest.searchParams.get('page')).toBe('salon-book');
      for (const [k, v] of Object.entries(UTM)) expect(dest.searchParams.get(k), k).toBe(v);
      expect(s.sqlite.prepare('SELECT friend_id FROM link_clicks').all()).toEqual([{ friend_id: friend.id }]);
      expect(s.sqlite.prepare('SELECT click_count FROM tracked_links WHERE id=?').get(link.id)).toEqual({ click_count: 1 });
      // 押しただけでは何も送らない
      expect(s.pushes).toEqual([]);

      // 4. 予約画面が開くと LIFF はもう一度 link を呼ぶ（行は増えない）→ 予約を送る
      expect((await s.liffLink(dest, 'token-user-early')).status).toBe(200);
      const created = await s.book('token-user-early');
      expect(created.status).toBe(201);
      const { booking_id } = (await created.json()) as { booking_id: string };
      expect(s.sqlite.prepare('SELECT friend_id FROM bookings WHERE id=?').get(booking_id)).toEqual({ friend_id: friend.id });
      expect(s.count('friends')).toBe(3);
      expect(s.pushes).toHaveLength(1);
      expect(s.pushes[0]).toMatchObject({ to: 'user-early' });

      // 5. 明日の突き合わせの SQL が 1 行を返す
      const rows = s.sqlite.prepare(LINK_TO_BOOKING_SQL).all('【デモ】スタッフ向け予約のご案内 2026-09-26');
      expect(rows).toEqual([
        expect.objectContaining({ friend_id: friend.id, booking_id, status: 'requested', utm_campaign: '2026-09-26_demo' }),
      ]);
      // ジャーニーには予約もクリックも出ない（L-09・L-11 の範囲）。friend_add は登録の時刻
      const journey = await s.request(`/api/friends/${friend.id}/journey`, {
        headers: { Authorization: 'Bearer synthetic-key' },
      });
      const events = ((await journey.json()) as { data: { events: Array<{ type: string }> } }).data.events;
      expect(events.map((e) => e.type)).toEqual(['friend_add']);
    } finally {
      s.sqlite.close();
    }
  });

  it('an already registered friend keeps working as before (no profile lookup, ad values saved)', async () => {
    const s = setup();
    try {
      const link = await s.createLink();
      const first = await s.request(new URL(link.trackingUrl).pathname, { headers: { 'user-agent': LINE_UA } });
      const liff = new URL(first.headers.get('location')!);
      expect((await s.liffLink(liff, 'token-user-known')).status).toBe(200);
      expect(s.profileLookups).toEqual([]);
      const meta = s.sqlite.prepare("SELECT metadata FROM friends WHERE id='f-known'").get() as { metadata: string };
      expect(JSON.parse(meta.metadata)).toMatchObject(UTM);
      expect(s.count('friends')).toBe(2);
    } finally {
      s.sqlite.close();
    }
  });

  it('does not register someone who is not a friend (profile 404) and saves nothing', async () => {
    const s = setup();
    try {
      const link = await s.createLink();
      const first = await s.request(new URL(link.trackingUrl).pathname, { headers: { 'user-agent': LINE_UA } });
      const liff = new URL(first.headers.get('location')!);
      const r = await s.liffLink(liff, 'token-user-stranger');
      expect(r.status).toBe(404);
      expect(s.count('friends')).toBe(2);
      expect(s.count('users')).toBe(0);
      // /t に戻っても誰でもない人のクリックになるだけ
      const bounce = new URL(liff.searchParams.get('redirect')!);
      bounce.searchParams.set('lu', 'user-stranger');
      await s.request(`${bounce.pathname}${bounce.search}`, { headers: { 'user-agent': LINE_UA } });
      expect(s.sqlite.prepare('SELECT friend_id FROM link_clicks').all()).toEqual([{ friend_id: null }]);
    } finally {
      s.sqlite.close();
    }
  });

  it('does not register when the profile lookup fails for another reason', async () => {
    const s = setup({ profileStatus: 500 });
    try {
      const link = await s.createLink();
      const first = await s.request(new URL(link.trackingUrl).pathname, { headers: { 'user-agent': LINE_UA } });
      const r = await s.liffLink(new URL(first.headers.get('location')!), 'token-user-early');
      expect(r.status).toBe(404);
      expect(s.count('friends')).toBe(2);
    } finally {
      s.sqlite.close();
    }
  });

  it('never moves or adds a row when the LINE user belongs to another account', async () => {
    const s = setup();
    try {
      const r = await s.liffLink(new URL(DESTINATION), 'token-user-elsewhere');
      expect(r.status).toBe(403);
      expect(s.profileLookups).toEqual([]);
      expect(s.sqlite.prepare("SELECT line_account_id,metadata FROM friends WHERE line_user_id='user-elsewhere'").all()).toEqual([
        { line_account_id: 'b', metadata: '{}' },
      ]);
      expect(s.count('friends')).toBe(2);
    } finally {
      s.sqlite.close();
    }
  });

  it('rejects an unverifiable ID token before any profile lookup', async () => {
    const s = setup();
    try {
      const r = await s.liffLink(new URL(DESTINATION), 'forged');
      expect(r.status).toBe(401);
      expect(s.profileLookups).toEqual([]);
      expect(s.count('friends')).toBe(2);
    } finally {
      s.sqlite.close();
    }
  });

  it('keeps the env-only legacy setup (no accounts in DB) unchanged: no lookup, 404', async () => {
    const s = setup({ noAccounts: true });
    try {
      const r = await s.liffLink(new URL(DESTINATION), 'token-user-early');
      expect(r.status).toBe(404);
      expect(s.profileLookups).toEqual([]);
      expect(s.count('friends')).toBe(0);
    } finally {
      s.sqlite.close();
    }
  });

  it('a link preview (LINE bot UA) gets OGP and records no click', async () => {
    const s = setup();
    try {
      const link = await s.createLink();
      const r = await s.request(new URL(link.trackingUrl).pathname, { headers: { 'user-agent': 'LINE-Bot' } });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('og:title');
      expect(s.count('link_clicks')).toBe(0);
    } finally {
      s.sqlite.close();
    }
  });
});
