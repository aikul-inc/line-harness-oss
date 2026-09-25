// konkatsucafe fork (L-08): LIFF 予約でお客様情報を聞き、予約 1 件に 12 項目を残し、友だち情報にも写す。
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

function jstDate(days: number): string {
  return new Date(Date.now() + 9 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
}

const INTAKE = {
  sei: '架空',
  mei: '花子',
  gender: '女性',
  age: '32歳',
  tel: '０９０ー０００ー００００',
  lineName: 'はなこ（直した）',
  visitCount: '1名',
  agreeTerms: true,
  experience: ['未経験', 'パーティー参加'],
  message: '架空の相談です',
};

function setup(options: { intake?: string } = { intake: 'konkatsucafe' }) {
  const { db: base, sqlite } = sqliteD1();
  sqlite.exec(schema);
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
  sqlite.exec(`
    INSERT INTO staff(id,line_account_id,name,display_name) VALUES('st','a','カフェ受付（デモ）','カフェ受付');
    INSERT INTO menus(id,line_account_id,name,description,duration_minutes,base_price)
      VALUES('m1','a','パンケーキ＆タブレットセット','デモ用の仮設定',30,1400);
    INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES('st','m1',1);
    INSERT INTO friends(id,line_user_id,display_name,is_following,line_account_id,metadata)
      VALUES('f-known','user-known','Known Friend',1,'a','{"ad_source":"synthetic-ad","お名前(姓)":"古い値"}');
  `);
  for (let weekday = 0; weekday < 7; weekday++) {
    sqlite
      .prepare('INSERT INTO staff_availability_rules(id,staff_id,weekday,start_time,end_time) VALUES(?,?,?,?,?)')
      .run(`rule-${weekday}`, 'st', weekday, '10:00', '18:30');
  }

  const followers: Record<string, string> = { 'user-known': 'Known Friend', 'user-early': 'Early Staff' };
  const pushes: Array<{ to: string; text: string }> = [];
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
  const logs: string[] = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    });
  }
  const env = {
    DB: db,
    DELIVERY_MODE: 'enabled',
    ...(options.intake !== undefined ? { BOOKING_INTAKE: options.intake } : {}),
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
  const date = jstDate(3);
  const startsAt = new Date(`${date}T14:00:00+09:00`).toISOString();
  async function book(idToken: string, extra: Record<string, unknown> = { intake: INTAKE }) {
    return request(`/api/liff/booking/requests?liffId=${LIFF_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ menu_id: 'm1', staff_id: 'st', starts_at: startsAt, ...extra }),
    });
  }
  const admin = { Authorization: 'Bearer synthetic-key', 'Content-Type': 'application/json' };
  async function list() {
    const r = await request('/api/booking/admin/requests?account_id=a&status=all', { headers: admin });
    expect(r.status).toBe(200);
    return ((await r.json()) as { requests: Array<Record<string, unknown>> }).requests;
  }
  const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const meta = (lineUserId: string) =>
    JSON.parse(
      (sqlite.prepare('SELECT metadata FROM friends WHERE line_user_id = ?').get(lineUserId) as { metadata: string })
        .metadata,
    ) as Record<string, string>;
  return { sqlite, request, book, list, count, meta, pushes, logs, date, admin, startsAt };
}

describe('L-08 booking intake (local, synthetic)', () => {
  it('menus tell the screen to ask the intake', async () => {
    const s = setup();
    try {
      const r = await s.request(`/api/liff/booking/menus?liffId=${LIFF_ID}`);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ intake_form: 'konkatsucafe', menus: [{ id: 'm1' }] });
    } finally {
      s.sqlite.close();
    }
  });

  it('one booking holds all 12 items; the admin list returns them; friend info gets 9 items', async () => {
    const s = setup();
    try {
      const created = await s.book('token-user-known');
      expect(created.status).toBe(201);
      const { booking_id } = (await created.json()) as { booking_id: string };

      const rows = await s.list();
      expect(rows).toHaveLength(1);
      const intake = rows[0].intake as { version: string; values: Record<string, string>; items: Array<{ label: string; value: string }> };
      expect(rows[0]).toMatchObject({ id: booking_id, status: 'requested', friend_name: 'Known Friend' });
      expect(intake.version).toBe('lharness-2026-09');
      // tasks.json L-08 の evidence: 姓・名・性別・年齢・電話・LINE名・日・時・人数が 1 件の予約から取り出せる
      const v = intake.values;
      expect([v.sei, v.mei, v.gender, v.age, v.tel, v.lineName, v.visitDate, v.visitTime, v.visitCount]).toEqual([
        '架空', '花子', '女性', '32歳', '090-000-0000', 'はなこ（直した）', s.date, '14:00', '1名',
      ]);
      // ユーザー依頼で足した 3 項目
      expect([v.agreeTerms, v.experience, v.message]).toEqual(['はい', '未経験、パーティー参加', '架空の相談です']);
      expect(intake.items.map((i) => i.label)).toEqual([
        'お名前(姓)', 'お名前(名)', '性別', '年齢', '電話番号', 'LINE名',
        '来店希望日', '来店希望時間', '来店人数', 'ご利用条件', '婚活の経験', 'ご相談内容',
      ]);

      // 列そのもの（L-10 が D1 から読む場合）
      const raw = s.sqlite.prepare('SELECT intake_json, customer_note FROM bookings WHERE id = ?').get(booking_id) as {
        intake_json: string;
        customer_note: string | null;
      };
      expect(JSON.parse(raw.intake_json).values).toEqual(v);
      expect(raw.customer_note).toBeNull();

      expect(s.meta('user-known')).toEqual({
        ad_source: 'synthetic-ad',
        'お名前(姓)': '架空',
        'お名前(名)': '花子',
        性別: '女性',
        年齢: '32歳',
        電話番号: '090-000-0000',
        LINE名: 'はなこ（直した）',
        ご利用条件: 'はい',
        婚活の経験: '未経験、パーティー参加',
        ご相談内容: '架空の相談です',
      });
      // 受付の控えは 1 通のまま
      expect(s.pushes).toHaveLength(1);
      expect(s.pushes[0].text).toContain('予約リクエストを受け付けました');
      // 個人情報をログに出さない
      expect(s.logs.join('\n')).not.toMatch(/090|架空|花子|はなこ/);
    } finally {
      s.sqlite.close();
    }
  });

  it('a follower from before L Harness is registered and gets the intake too', async () => {
    const s = setup();
    try {
      const created = await s.book('token-user-early');
      expect(created.status).toBe(201);
      expect(s.meta('user-early')).toMatchObject({ 'お名前(姓)': '架空', LINE名: 'はなこ（直した）' });
      expect((await s.list())[0]).toMatchObject({ friend_name: 'Early Staff' });
    } finally {
      s.sqlite.close();
    }
  });

  it.each([
    ['no intake at all', {}],
    ['no consent', { intake: { ...INTAKE, agreeTerms: false } }],
    ['option not in the list', { intake: { ...INTAKE, visitCount: '5名' } }],
    ['bad phone', { intake: { ...INTAKE, tel: '0120' } }],
    ['too long message', { intake: { ...INTAKE, message: 'あ'.repeat(2001) } }],
  ])('refuses %s with 422 and leaves nothing behind', async (_label, extra) => {
    const s = setup();
    try {
      const r = await s.book('token-user-known', extra);
      expect(r.status).toBe(422);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe('invalid_intake');
      expect(JSON.stringify(body)).not.toMatch(/0120|あああ/);
      expect(s.count('bookings')).toBe(0);
      expect(s.meta('user-known')).toEqual({ ad_source: 'synthetic-ad', 'お名前(姓)': '古い値' });
      expect(s.pushes).toHaveLength(0);
    } finally {
      s.sqlite.close();
    }
  });

  it('without BOOKING_INTAKE the booking works as upstream and ignores intake', async () => {
    const s = setup({});
    try {
      const menus = await s.request(`/api/liff/booking/menus?liffId=${LIFF_ID}`);
      expect(await menus.json()).toMatchObject({ intake_form: null });
      const r = await s.book('token-user-known', { customer_note: 'upstream note', intake: INTAKE });
      expect(r.status).toBe(201);
      const row = (await s.list())[0];
      expect(row).toMatchObject({ intake: null, intake_json: null, customer_note: 'upstream note' });
      expect(s.meta('user-known')).toEqual({ ad_source: 'synthetic-ad', 'お名前(姓)': '古い値' });
    } finally {
      s.sqlite.close();
    }
  });

  it('an unknown BOOKING_INTAKE value refuses LIFF bookings (fail-closed)', async () => {
    const s = setup({ intake: 'konkatsu-typo' });
    try {
      const menus = await s.request(`/api/liff/booking/menus?liffId=${LIFF_ID}`);
      expect(await menus.json()).toMatchObject({ intake_form: null });
      const r = await s.book('token-user-known');
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: 'intake_misconfigured' });
      expect(s.count('bookings')).toBe(0);
      expect(s.pushes).toHaveLength(0);
    } finally {
      s.sqlite.close();
    }
  });

  it('store-created bookings (admin proxy) still work without intake', async () => {
    const s = setup();
    try {
      const r = await s.request('/api/booking/admin/bookings?account_id=a', {
        method: 'POST',
        headers: s.admin,
        body: JSON.stringify({ friend_id: 'f-known', menu_id: 'm1', staff_id: 'st', starts_at: s.startsAt }),
      });
      expect(r.status).toBeLessThan(300);
      const row = (await s.list())[0];
      expect(row).toMatchObject({ intake: null, intake_json: null });
    } finally {
      s.sqlite.close();
    }
  });
});
