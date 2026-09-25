// konkatsucafe fork (L-08): 日時 → お客様情報 → 確認 の予約。
// メニュー・担当は受け口が割り当て、枠の上限なし、受付 → 店舗が電話で確かめて承認・取り消し、自動の期限切れなし。
// 予約 1 件に 12 項目を残し、友だち情報にも写す。すべて架空値。LINE への通信は fetch を置き換えて記録し、外へは出さない。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import worker from '../index.js';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { runExpirer } from '../services/booking-expirer.js';
import { processDueReminders } from '../services/booking-reminders.js';
import { renderNotificationText, type SendNotificationParams } from '../services/booking-notifier.js';

const schema = readFileSync(new NodeURL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');
afterEach(() => vi.restoreAllMocks());

const LIFF_ID = 'login-a-Demo';
const PROFILE = 'https://api.line.me/v2/bot/profile/';
const HIDDEN = /メニュー|担当|パンケーキ|カフェ受付/;

function jstDate(days: number): string {
  return new Date(Date.now() + 9 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
}
function at(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
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
  // 受付時間は火曜を含まない（上流の枠の決まり）。konkatsucafe の流れでは使わないことを確かめる
  sqlite.exec(`
    INSERT INTO staff(id,line_account_id,name,display_name) VALUES('st','a','カフェ受付（デモ）','カフェ受付');
    INSERT INTO menus(id,line_account_id,name,description,duration_minutes,base_price)
      VALUES('m1','a','パンケーキ＆タブレットセット','デモ用の仮設定',30,1400);
    INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES('st','m1',1);
    INSERT INTO friends(id,line_user_id,display_name,is_following,line_account_id,metadata)
      VALUES('f-known','user-known','Known Friend',1,'a','{"ad_source":"synthetic-ad","お名前(姓)":"古い値"}');
    INSERT INTO friends(id,line_user_id,display_name,is_following,line_account_id)
      VALUES('f-other','user-other','Other Friend',1,'a');
  `);
  for (const weekday of [0, 1, 3, 4, 5, 6]) {
    sqlite
      .prepare('INSERT INTO staff_availability_rules(id,staff_id,weekday,start_time,end_time) VALUES(?,?,?,?,?)')
      .run(`rule-${weekday}`, 'st', weekday, '10:30', '18:30');
  }

  const followers: Record<string, string> = {
    'user-known': 'Known Friend',
    'user-other': 'Other Friend',
    'user-early': 'Early Staff',
  };
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
  const startsAt = at(date, '14:00');
  async function book(idToken: string, extra: Record<string, unknown> = {}) {
    return request(`/api/liff/booking/requests?liffId=${LIFF_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ starts_at: startsAt, intake: INTAKE, ...extra }),
    });
  }
  const admin = { Authorization: 'Bearer synthetic-key', 'Content-Type': 'application/json' };
  async function list() {
    const r = await request('/api/booking/admin/requests?account_id=a&status=all', { headers: admin });
    expect(r.status).toBe(200);
    return ((await r.json()) as { requests: Array<Record<string, unknown>> }).requests;
  }
  async function decide(id: string, action: string) {
    return request(`/api/booking/admin/requests/${id}?account_id=a`, {
      method: 'PATCH',
      headers: admin,
      body: JSON.stringify({ action }),
    });
  }
  const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const meta = (lineUserId: string) =>
    JSON.parse(
      (sqlite.prepare('SELECT metadata FROM friends WHERE line_user_id = ?').get(lineUserId) as { metadata: string })
        .metadata,
    ) as Record<string, string>;
  return { sqlite, db, request, book, list, decide, count, meta, pushes, logs, date, admin, startsAt };
}

async function created(r: Response): Promise<string> {
  expect(r.status).toBe(201);
  return ((await r.json()) as { booking_id: string }).booking_id;
}

describe('L-08 konkatsucafe booking flow (local, synthetic)', () => {
  it('menus tell the screen to use the konkatsucafe flow; demo adds the notice flag', async () => {
    for (const [intake, demo] of [['konkatsucafe', false], ['konkatsucafe-demo', true]] as const) {
      const s = setup({ intake });
      try {
        const r = await s.request(`/api/liff/booking/menus?liffId=${LIFF_ID}`);
        expect(r.status).toBe(200);
        expect(await r.json()).toMatchObject({ intake_form: 'konkatsucafe', demo_notice: demo });
      } finally {
        s.sqlite.close();
      }
    }
  });

  it('books without menu/staff: auto-assigned, 12 items on one booking, friend info gets 9 items, receipt hides menu/staff', async () => {
    const s = setup();
    try {
      const id = await created(await s.book('token-user-known'));
      const rows = await s.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id, status: 'requested', menu_id: 'm1', staff_id: 'st', friend_name: 'Known Friend' });
      const intake = rows[0].intake as { version: string; values: Record<string, string>; items: Array<{ label: string }> };
      expect(intake.version).toBe('lharness-2026-09');
      // tasks.json L-08 の evidence: 姓・名・性別・年齢・電話・LINE名・日・時・人数が 1 件の予約から取り出せる
      const v = intake.values;
      expect([v.sei, v.mei, v.gender, v.age, v.tel, v.lineName, v.visitDate, v.visitTime, v.visitCount]).toEqual([
        '架空', '花子', '女性', '32歳', '090-000-0000', 'はなこ（直した）', s.date, '14:00', '1名',
      ]);
      expect([v.agreeTerms, v.experience, v.message]).toEqual(['はい', '未経験、パーティー参加', '架空の相談です']);
      expect(intake.items.map((i) => i.label)).toEqual([
        'お名前(姓)', 'お名前(名)', '性別', '年齢', '電話番号', 'LINE名',
        '来店希望日', '来店希望時間', '来店人数', 'ご利用条件', '婚活の経験', 'ご相談内容',
      ]);
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
      expect(s.pushes).toHaveLength(1);
      expect(s.pushes[0].text).toContain('ご予約を受け付けました');
      expect(s.pushes[0].text).toContain('お店からお電話でご予約内容を確認のうえ、確定のご連絡をいたします。');
      expect(s.pushes[0].text).not.toMatch(HIDDEN);
      expect(s.pushes[0].text).not.toContain('デモのため');
      expect(s.logs.join('\n')).not.toMatch(/090|架空|花子|はなこ/);
    } finally {
      s.sqlite.close();
    }
  });

  it('ignores menu_id / staff_id sent from the screen', async () => {
    const s = setup();
    try {
      await created(await s.book('token-user-known', { menu_id: 'bogus', staff_id: 'bogus' }));
      expect((await s.list())[0]).toMatchObject({ menu_id: 'm1', staff_id: 'st' });
    } finally {
      s.sqlite.close();
    }
  });

  it('demo mode adds the demo notice to every notice and marks the booking', async () => {
    const s = setup({ intake: 'konkatsucafe-demo' });
    try {
      const id = await created(await s.book('token-user-known'));
      const raw = s.sqlite.prepare('SELECT intake_json FROM bookings WHERE id = ?').get(id) as { intake_json: string };
      expect(JSON.parse(raw.intake_json).demo).toBe(true);
      expect(s.pushes[0].text).toContain('※デモのため、実際のご予約にはなりません。');
      expect((await s.decide(id, 'approve')).status).toBe(200);
      expect(s.pushes[1].text).toContain('ご予約が確定しました');
      expect(s.pushes[1].text).toContain('※デモのため、実際のご予約にはなりません。');
    } finally {
      s.sqlite.close();
    }
  });

  it('has no capacity limit: several bookings at the same date/time all succeed', async () => {
    const s = setup();
    try {
      await created(await s.book('token-user-known'));
      await created(await s.book('token-user-known'));
      await created(await s.book('token-user-other'));
      await created(await s.book('token-user-early'));
      expect(s.count('bookings')).toBe(4);
      const starts = s.sqlite.prepare('SELECT DISTINCT starts_at FROM bookings').all();
      expect(starts).toEqual([{ starts_at: s.startsAt }]);
    } finally {
      s.sqlite.close();
    }
  });

  it('accepts /yoyaku/ times on any day incl. Tuesday and up to 2 years ahead; refuses other values', async () => {
    const s = setup();
    try {
      // 次の火曜（受付時間の決まりには無い曜日）
      let d = 1;
      while (new Date(`${jstDate(d)}T00:00:00Z`).getUTCDay() !== 2) d++;
      await created(await s.book('token-user-known', { starts_at: at(jstDate(d), '10:30') }));
      await created(await s.book('token-user-known', { starts_at: at(jstDate(d), '18:00') }));
      const limit = new Date(`${jstDate(0)}T00:00:00Z`);
      limit.setUTCFullYear(limit.getUTCFullYear() + 2);
      const max = limit.toISOString().slice(0, 10);
      await created(await s.book('token-user-known', { starts_at: at(max, '14:00') }));

      const after = new Date(limit.getTime() + 86400_000).toISOString().slice(0, 10);
      for (const [date, time] of [
        [s.date, '10:00'],
        [s.date, '10:45'],
        [s.date, '18:30'],
        [after, '14:00'],
        [jstDate(-1), '14:00'],
      ]) {
        const r = await s.book('token-user-known', { starts_at: at(date, time) });
        expect(r.status).toBe(422);
        expect(await r.json()).toEqual({ error: 'invalid_visit_datetime' });
      }
      expect(s.count('bookings')).toBe(3);
    } finally {
      s.sqlite.close();
    }
  });

  it('store approves after the call: confirmed, confirmation hides menu/staff, day-before only, 3 pushes max', async () => {
    const s = setup();
    try {
      const id = await created(await s.book('token-user-known'));
      expect((await s.decide(id, 'approve')).status).toBe(200);
      expect((await s.list())[0]).toMatchObject({ status: 'confirmed' });
      expect(s.pushes[1].text).toContain('ご予約が確定しました');
      expect(s.pushes[1].text).not.toMatch(HIDDEN);
      const reminders = s.sqlite.prepare('SELECT kind, scheduled_at FROM booking_reminders').all() as Array<{
        kind: string;
        scheduled_at: string;
      }>;
      expect(reminders.map((r) => r.kind)).toEqual(['day_before']);

      const sent: SendNotificationParams[] = [];
      const result = await processDueReminders(s.db, {
        now: new Date(reminders[0].scheduled_at),
        sender: async (p) => {
          sent.push(p);
        },
        reminderHoursBefore: 0,
      });
      expect(result.sent).toBe(1);
      const text = renderNotificationText(sent[0].kind, sent[0].ctx);
      expect(text).toContain('明日のご来店をお待ちしております');
      expect(text).not.toMatch(HIDDEN);
      expect(s.pushes.length + sent.length).toBe(3);
    } finally {
      s.sqlite.close();
    }
  });

  it('store can cancel instead: rejected with a neutral notice, or cancel after confirming (no extra notice)', async () => {
    const s = setup();
    try {
      const a = await created(await s.book('token-user-known'));
      expect((await s.decide(a, 'reject')).status).toBe(200);
      expect(s.pushes[1].text).toContain('ご予約の受付を取り消しました');
      expect(s.pushes[1].text).not.toMatch(HIDDEN);

      const b = await created(await s.book('token-user-other'));
      expect((await s.decide(b, 'approve')).status).toBe(200);
      const before = s.pushes.length;
      expect((await s.decide(b, 'cancel')).status).toBe(200);
      expect(s.pushes.length).toBe(before);
      const pendingReminders = s.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM booking_reminders WHERE booking_id = ? AND status = 'pending'`)
        .get(b) as { n: number };
      expect(pendingReminders.n).toBe(0);
    } finally {
      s.sqlite.close();
    }
  });

  it('never auto-expires konkatsucafe bookings (upstream bookings still expire)', async () => {
    const s = setup();
    try {
      const id = await created(await s.book('token-user-known'));
      s.sqlite.exec(`
        INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at)
          VALUES('upstream','a','f-other','st','m1','${s.startsAt}','${s.startsAt}','${s.startsAt}','requested',1400,'${new Date().toISOString()}');
      `);
      const sent: SendNotificationParams[] = [];
      const result = await runExpirer(s.db, {
        now: new Date(Date.now() + 25 * 3600_000),
        sender: async (p) => {
          sent.push(p);
        },
      });
      expect(result.expired).toBe(1);
      const statuses = Object.fromEntries(
        (s.sqlite.prepare('SELECT id, status FROM bookings').all() as Array<{ id: string; status: string }>).map((r) => [
          r.id,
          r.status,
        ]),
      );
      expect(statuses).toEqual({ [id]: 'requested', upstream: 'expired' });
      expect(sent.map((p) => p.toLineUserId)).toEqual(['user-other']);
    } finally {
      s.sqlite.close();
    }
  });

  it('the customer history marks konkatsucafe bookings', async () => {
    const s = setup();
    try {
      await created(await s.book('token-user-known'));
      const r = await s.request(`/api/liff/booking/me?liffId=${LIFF_ID}`, {
        headers: { Authorization: 'Bearer token-user-known' },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { upcoming: Array<Record<string, unknown>> };
      expect(body.upcoming[0]).toMatchObject({ status: 'requested', konkatsucafe: 1 });
    } finally {
      s.sqlite.close();
    }
  });

  it.each([
    ['no intake at all', { intake: undefined }],
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

  it('refuses when the account does not have exactly one menu and one staff (does not guess)', async () => {
    const s = setup();
    try {
      s.sqlite.exec(`INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES('m2','a','別メニュー',30,0);`);
      const r = await s.book('token-user-known');
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: 'booking_target_unavailable' });
      expect(s.count('bookings')).toBe(0);
      expect(s.pushes).toHaveLength(0);
    } finally {
      s.sqlite.close();
    }
  });

  it('without BOOKING_INTAKE the booking works as upstream (menu/staff required, intake ignored)', async () => {
    const s = setup({});
    try {
      const menus = await s.request(`/api/liff/booking/menus?liffId=${LIFF_ID}`);
      expect(await menus.json()).toMatchObject({ intake_form: null, demo_notice: false });
      const missing = await s.book('token-user-known');
      expect(missing.status).toBe(400);
      const r = await s.book('token-user-known', {
        menu_id: 'm1',
        staff_id: 'st',
        starts_at: at(s.date, '10:30'),
        customer_note: 'upstream note',
      });
      expect(r.status).toBe(201);
      const row = (await s.list())[0];
      expect(row).toMatchObject({ intake: null, intake_json: null, customer_note: 'upstream note' });
      expect(s.pushes[0].text).toContain('予約リクエストを受け付けました');
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
        body: JSON.stringify({ friend_id: 'f-known', menu_id: 'm1', staff_id: 'st', starts_at: at(s.date, '10:30') }),
      });
      expect(r.status).toBeLessThan(300);
      expect((await s.list())[0]).toMatchObject({ intake: null, intake_json: null });
    } finally {
      s.sqlite.close();
    }
  });
});
