// konkatsucafe fork (L-07 / F-17): LIFF 予約 → requested → 管理 API で承認 → confirmed。
// すべて架空値。LINE への通信は fetch を置き換えて記録し、外へは出さない。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import worker from '../index.js';
import { sqliteD1 } from '../test-support/sqlite-d1.js';

const schema = readFileSync(new NodeURL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');
afterEach(() => vi.restoreAllMocks());

const LIFF_ID = 'login-a-Demo';
const PROFILE = 'https://api.line.me/v2/bot/profile/';

/** JST の今日から days 日後の日付（YYYY-MM-DD）。 */
function jstDate(days: number): string {
  return new Date(Date.now() + 9 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
}

function setup(options: { followers?: Record<string, string>; profileStatus?: number } = {}) {
  const { db: base, sqlite } = sqliteD1();
  sqlite.exec(schema);
  // sqliteD1 は batch を持たず、better-sqlite3 は番号付きの引数（?1 など）を
  // 配列で受けない。予約の SQL はどちらも使うので、このテストの中だけで補う。
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
  account.run('a', 'Demo A', 'channel-a', 'synthetic-secret-a', 'synthetic-token-a', 'login-a', LIFF_ID);
  account.run('b', 'Demo B', 'channel-b', 'synthetic-secret-b', 'synthetic-token-b', 'login-b', 'login-b-Other');
  sqlite.exec(`
    INSERT INTO staff(id,line_account_id,name,display_name) VALUES('st','a','カフェ受付（デモ）','カフェ受付');
    INSERT INTO menus(id,line_account_id,name,description,duration_minutes,base_price)
      VALUES('m1','a','パンケーキ＆タブレットセット','デモ用の仮設定',30,1400);
    INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES('st','m1',1);
    INSERT INTO friends(id,line_user_id,display_name,is_following,line_account_id)
      VALUES('f-known','user-known','Known Friend',1,'a');
  `);
  for (let weekday = 0; weekday < 7; weekday++) {
    sqlite
      .prepare('INSERT INTO staff_availability_rules(id,staff_id,weekday,start_time,end_time) VALUES(?,?,?,?,?)')
      .run(`rule-${weekday}`, 'st', weekday, '10:30', '18:30');
  }

  // LINE 上で友だち追加している人（プロフィール照会が 200 を返す人）。
  const followers: Record<string, string> = { 'user-known': 'Known Friend', ...options.followers };
  const pushes: Array<{ to: string; text: string; token: string }> = [];
  const attempted: string[] = [];
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    attempted.push(url);
    if (url === 'https://api.line.me/oauth2/v2.1/verify') {
      const form = new URLSearchParams(String(init?.body));
      const token = form.get('id_token') ?? '';
      if (form.get('client_id') !== 'login-a' || !token.startsWith('token-')) {
        return Response.json({ error: 'invalid_request' }, { status: 400 });
      }
      return Response.json({ sub: token.slice('token-'.length) });
    }
    if (url.startsWith(PROFILE)) {
      if (options.profileStatus) return new Response('upstream', { status: options.profileStatus });
      const userId = decodeURIComponent(url.slice(PROFILE.length));
      const name = followers[userId];
      return name
        ? Response.json({ userId, displayName: name })
        : Response.json({ message: 'Not found' }, { status: 404 });
    }
    if (url === 'https://api.line.me/v2/bot/message/push') {
      const body = JSON.parse(String(init?.body)) as { to: string; messages: Array<{ text: string }> };
      const token = String((init?.headers as Record<string, string>).Authorization).replace('Bearer ', '');
      pushes.push({ to: body.to, text: body.messages[0].text, token });
      return Response.json({});
    }
    throw Error(`No external egress allowed: ${url}`);
  });
  const env = {
    DB: db,
    DELIVERY_MODE: 'enabled',
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
    const r = await worker.fetch(new Request(`https://synthetic.example${path}`, init), env, ctx);
    await Promise.all(pending);
    return r;
  }
  const startsAt = new Date(`${jstDate(3)}T10:30:00+09:00`).toISOString();
  async function book(idToken: string | null, key = crypto.randomUUID()) {
    return request(`/api/liff/booking/requests?liffId=${LIFF_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      body: JSON.stringify({ menu_id: 'm1', staff_id: 'st', starts_at: startsAt }),
    });
  }
  const admin = { Authorization: 'Bearer synthetic-key', 'Content-Type': 'application/json' };
  async function list() {
    const r = await request('/api/booking/admin/requests?account_id=a&status=all', { headers: admin });
    expect(r.status).toBe(200);
    return ((await r.json()) as { requests: Array<Record<string, unknown>> }).requests;
  }
  async function decide(id: string, action = 'approve') {
    return request(`/api/booking/admin/requests/${id}?account_id=a`, {
      method: 'PATCH',
      headers: admin,
      body: JSON.stringify({ action }),
    });
  }
  const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { sqlite, request, book, list, decide, pushes, attempted, network, count, startsAt };
}

describe('F-17 LIFF booking → requested → admin approve → confirmed (local, synthetic)', () => {
  it('a known friend books, gets one receipt, and approval confirms with day_before only (3 pushes max)', async () => {
    const s = setup();
    try {
      const created = await s.book('token-user-known');
      expect(created.status).toBe(201);
      const body = (await created.json()) as { booking_id: string; status: string };
      expect(body.status).toBe('requested');
      expect(s.pushes).toHaveLength(1);
      expect(s.pushes[0]).toMatchObject({ to: 'user-known', token: 'synthetic-token-a' });
      expect(s.pushes[0].text).toContain('予約リクエストを受け付けました');

      const rows = await s.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: body.booking_id, status: 'requested', friend_name: 'Known Friend' });

      const approved = await s.decide(body.booking_id);
      expect(approved.status).toBe(200);
      expect(await approved.json()).toEqual({ status: 'confirmed' });
      expect(s.pushes).toHaveLength(2);
      expect(s.pushes[1].text).toContain('予約が確定しました');
      const reminders = s.sqlite.prepare('SELECT kind FROM booking_reminders').all() as Array<{ kind: string }>;
      expect(reminders.map((r) => r.kind)).toEqual(['day_before']);
      // 受付・確定・前日で 3 通。これを超えない。
      expect(s.pushes.length + reminders.length).toBe(3);

      const again = await s.decide(body.booking_id);
      expect(again.status).toBe(409);
      expect(s.pushes).toHaveLength(2);
      expect(s.count('booking_reminders')).toBe(1);
      expect((await s.list())[0]).toMatchObject({ status: 'confirmed' });
    } finally {
      s.sqlite.close();
    }
  });

  it('registers a follower from before L Harness (no friends row, profile 200) and links the booking', async () => {
    const s = setup({ followers: { 'user-early': 'Early Staff' } });
    try {
      expect(s.count('friends')).toBe(1);
      const created = await s.book('token-user-early');
      expect(created.status).toBe(201);
      const { booking_id } = (await created.json()) as { booking_id: string };

      const friend = s.sqlite
        .prepare('SELECT id, display_name, is_following, line_account_id, first_followed_at FROM friends WHERE line_user_id = ?')
        .get('user-early') as Record<string, unknown>;
      expect(friend).toMatchObject({
        display_name: 'Early Staff',
        is_following: 1,
        line_account_id: 'a',
        first_followed_at: null,
      });
      expect(s.count('friends')).toBe(2);
      const booking = s.sqlite.prepare('SELECT friend_id, status FROM bookings WHERE id = ?').get(booking_id);
      expect(booking).toEqual({ friend_id: friend.id, status: 'requested' });
      expect((await s.list())[0]).toMatchObject({ id: booking_id, friend_name: 'Early Staff' });
      expect(s.pushes).toEqual([
        expect.objectContaining({ to: 'user-early', text: expect.stringContaining('予約リクエストを受け付けました') }),
      ]);

      // 2 回目は登録済みの行を使い、行を増やさない。
      const second = await s.request(`/api/liff/booking/me?liffId=${LIFF_ID}`, {
        headers: { Authorization: 'Bearer token-user-early' },
      });
      expect(second.status).toBe(200);
      expect(((await second.json()) as { upcoming: unknown[] }).upcoming).toHaveLength(1);
      expect(s.count('friends')).toBe(2);
    } finally {
      s.sqlite.close();
    }
  });

  it('refuses a non-friend (profile 404) without creating a friend, booking or push', async () => {
    const s = setup();
    try {
      const r = await s.book('token-user-stranger');
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'friend_not_found' });
      expect(s.count('friends')).toBe(1);
      expect(s.count('bookings')).toBe(0);
      expect(s.pushes).toHaveLength(0);
    } finally {
      s.sqlite.close();
    }
  });

  it('does not register when the profile lookup fails (5xx)', async () => {
    const s = setup({ profileStatus: 500 });
    try {
      const r = await s.book('token-user-early');
      expect(r.status).toBe(404);
      expect(s.count('friends')).toBe(1);
      expect(s.count('bookings')).toBe(0);
      expect(s.pushes).toHaveLength(0);
    } finally {
      s.sqlite.close();
    }
  });

  it('leaves a row that belongs to another account untouched and refuses', async () => {
    const s = setup({ followers: { 'user-other': 'Other Account' } });
    try {
      s.sqlite.exec(
        "INSERT INTO friends(id,line_user_id,display_name,is_following,line_account_id) VALUES('f-other','user-other','Other',1,'b')",
      );
      const r = await s.book('token-user-other');
      expect(r.status).toBe(404);
      expect(s.sqlite.prepare('SELECT line_account_id FROM friends WHERE id = ?').get('f-other')).toEqual({
        line_account_id: 'b',
      });
      expect(s.attempted.some((url) => url.startsWith(PROFILE))).toBe(false);
      expect(s.count('bookings')).toBe(0);
      expect(s.pushes).toHaveLength(0);
    } finally {
      s.sqlite.close();
    }
  });

  it('refuses a request without an ID token before any LINE call', async () => {
    const s = setup({ followers: { 'user-early': 'Early Staff' } });
    try {
      const r = await s.book(null);
      expect(r.status).toBe(401);
      expect(s.network).not.toHaveBeenCalled();
      expect(s.count('friends')).toBe(1);
      expect(s.count('bookings')).toBe(0);
    } finally {
      s.sqlite.close();
    }
  });
});
