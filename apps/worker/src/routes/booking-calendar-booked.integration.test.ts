// konkatsucafe fork (L-09): 予約の受付で calendar_booked を発火し、自動化の send_webhook が署名つきで飛ぶ。
// すべて架空値。外への通信は fetch を置き換えて記録し、外へは出さない（知らない宛先は投げる）。
// 仕様: konkatsucafe-line の docs/spec/2026-09-25-l09-l10-booking-mail-sheet.md の F1。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import worker from '../index.js';
import { sqliteD1 } from '../test-support/sqlite-d1.js';

const schema = readFileSync(new NodeURL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');
afterEach(() => vi.restoreAllMocks());

const LIFF_ID = 'login-a-Demo';
const PROFILE = 'https://api.line.me/v2/bot/profile/';
const ADAPTER = 'https://adapter.example/api/lharness/booking';
const SECRET = 'synthetic-webhook-secret';
const PII = /架空|花子|はなこ|090|０９０/;

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
  lineName: 'はなこ',
  visitCount: '1名',
  agreeTerms: true,
  experience: ['未経験', 'パーティー参加'],
  message: '架空の相談です',
};

interface Hook {
  url: string;
  body: string;
  signature: string | null;
}

function setup(
  options: {
    intake?: string;
    actions?: unknown[];
    adapterStatus?: number;
    accountOfAutomation?: string | null;
  } = {},
) {
  const intakeMode = 'intake' in options ? options.intake : 'konkatsucafe';
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
  sqlite
    .prepare(
      'INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,login_channel_id,liff_id) VALUES(?,?,?,?,?,?,?)',
    )
    .run('a', 'Demo A', 'channel-a', 'synthetic-secret-a', 'synthetic-token-a', 'login-a', LIFF_ID);
  sqlite.exec(`
    INSERT INTO staff(id,line_account_id,name,display_name) VALUES('st','a','カフェ受付（デモ）','カフェ受付');
    INSERT INTO menus(id,line_account_id,name,description,duration_minutes,base_price)
      VALUES('m1','a','パンケーキ＆タブレットセット','デモ用の仮設定',30,1400);
    INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES('st','m1',1);
    INSERT INTO friends(id,line_user_id,display_name,is_following,line_account_id)
      VALUES('f-known','user-known','Known Friend',1,'a');
  `);
  for (const weekday of [0, 1, 3, 4, 5, 6]) {
    sqlite
      .prepare('INSERT INTO staff_availability_rules(id,staff_id,weekday,start_time,end_time) VALUES(?,?,?,?,?)')
      .run(`rule-${weekday}`, 'st', weekday, '10:30', '18:30');
  }
  const actions = options.actions ?? [{ type: 'send_webhook', params: { url: ADAPTER, secret: SECRET } }];
  sqlite
    .prepare('INSERT INTO automations(id,name,event_type,conditions,actions,line_account_id) VALUES(?,?,?,?,?,?)')
    .run(
      'auto-1',
      '予約をメール・シートへ',
      'calendar_booked',
      '{}',
      JSON.stringify(actions),
      options.accountOfAutomation === undefined ? 'a' : options.accountOfAutomation,
    );

  const hooks: Hook[] = [];
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
    if (url.startsWith(PROFILE)) return Response.json({}, { status: 404 });
    if (url === 'https://api.line.me/v2/bot/message/push') {
      const body = JSON.parse(String(init?.body)) as { to: string; messages: Array<{ text: string }> };
      pushes.push({ to: body.to, text: body.messages[0].text });
      return Response.json({});
    }
    if (url === ADAPTER) {
      const headers = new Headers(init?.headers);
      hooks.push({ url, body: String(init?.body), signature: headers.get('x-webhook-signature') });
      return Response.json({ ok: true }, { status: options.adapterStatus ?? 200 });
    }
    throw Error(`No external egress allowed: ${url}`);
  });
  const logs: string[] = [];
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    });
  }
  const env = {
    DB: db,
    DELIVERY_MODE: 'enabled',
    ...(intakeMode !== undefined ? { BOOKING_INTAKE: intakeMode } : {}),
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
  const date = new Date(`${jstDate(3)}T00:00:00Z`).getUTCDay() === 2 ? jstDate(4) : jstDate(3);
  const startsAt = at(date, '14:00');
  async function book(extra: Record<string, unknown> = {}, idemKey: string = crypto.randomUUID()) {
    return request(`/api/liff/booking/requests?liffId=${LIFF_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
        Authorization: 'Bearer token-user-known',
      },
      body: JSON.stringify({ starts_at: startsAt, intake: INTAKE, ...extra }),
    });
  }
  const admin = { Authorization: 'Bearer synthetic-key', 'Content-Type': 'application/json' };
  async function decide(id: string, action: string) {
    return request(`/api/booking/admin/requests/${id}?account_id=a`, {
      method: 'PATCH',
      headers: admin,
      body: JSON.stringify({ action }),
    });
  }
  const automationLogs = () =>
    sqlite.prepare('SELECT status, event_data, actions_result FROM automation_logs').all() as Array<{
      status: string;
      event_data: string;
      actions_result: string;
    }>;
  return { sqlite, request, book, decide, hooks, pushes, logs, date, admin, automationLogs };
}

async function created(r: Response): Promise<string> {
  expect(r.status).toBe(201);
  return ((await r.json()) as { booking_id: string }).booking_id;
}

describe('L-09 calendar_booked → send_webhook (local, synthetic)', () => {
  it('a LIFF booking fires calendar_booked once; send_webhook POSTs the 12 items signed with the secret', async () => {
    const s = setup();
    try {
      const id = await created(await s.book());
      // tasks.json の L-09 の evidence: 自動化に calendar_booked を仕掛けると send_webhook が飛ぶ
      expect(s.hooks).toHaveLength(1);
      const hook = s.hooks[0];
      const expectedSig = createHmac('sha256', SECRET).update(hook.body).digest('hex');
      expect(hook.signature).toBe(expectedSig);

      const body = JSON.parse(hook.body) as Record<string, unknown>;
      const stored = JSON.parse(
        (s.sqlite.prepare('SELECT intake_json FROM bookings WHERE id = ?').get(id) as {
          intake_json: string;
        }).intake_json,
      );
      const row = s.sqlite.prepare('SELECT requested_at, starts_at FROM bookings WHERE id = ?').get(id) as {
        requested_at: string;
        starts_at: string;
      };
      expect(body).toMatchObject({
        friendId: 'f-known',
        event: 'calendar_booked',
        bookingId: id,
        status: 'requested',
        startsAt: row.starts_at,
        requestedAt: row.requested_at,
        menuId: 'm1',
        staffId: 'st',
        source: 'liff',
      });
      // 予約に残した 12 項目がそのまま（変換なし）で乗る
      expect(body.intake).toEqual(stored);
      expect(Object.keys((body.intake as { values: Record<string, string> }).values)).toEqual([
        'sei', 'mei', 'gender', 'age', 'tel', 'lineName',
        'visitDate', 'visitTime', 'visitCount', 'agreeTerms', 'experience', 'message',
      ]);

      // 控えは 1 通のまま。承認しても send_webhook は増えない（受付の 1 回だけ）
      expect(s.pushes).toHaveLength(1);
      expect((await s.decide(id, 'approve')).status).toBe(200);
      expect(s.pushes).toHaveLength(2);
      expect(s.hooks).toHaveLength(1);

      // 実行ログは成功。お客様情報は伏せる。ログにも出さない
      const logs = s.automationLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe('success');
      expect(logs[0].event_data).toContain('"intake":"[omitted]"');
      expect(logs[0].event_data).not.toMatch(PII);
      expect(s.logs.join('\n')).not.toMatch(PII);

      // konkatsucafe-line のアダプタに同じ本文を渡す確認用（L09_WEBHOOK_DUMP があるときだけ書く）
      const dump = process.env.L09_WEBHOOK_DUMP;
      if (dump) writeFileSync(dump, JSON.stringify({ secret: SECRET, signature: hook.signature, body: hook.body }));
    } finally {
      s.sqlite.close();
    }
  });

  it('the same Idempotency-Key does not fire twice; reject/cancel do not fire', async () => {
    const s = setup();
    try {
      const key = crypto.randomUUID();
      const id = await created(await s.book({}, key));
      expect(await created(await s.book({}, key))).toBe(id);
      expect(s.hooks).toHaveLength(1);
      expect((await s.decide(id, 'reject')).status).toBe(200);
      expect(s.hooks).toHaveLength(1);
    } finally {
      s.sqlite.close();
    }
  });

  it('store-created (admin proxy) bookings do not fire', async () => {
    const s = setup();
    try {
      const r = await s.request('/api/booking/admin/bookings?account_id=a', {
        method: 'POST',
        headers: s.admin,
        body: JSON.stringify({ friend_id: 'f-known', menu_id: 'm1', staff_id: 'st', starts_at: at(s.date, '10:30') }),
      });
      expect(r.status).toBe(201);
      expect(s.hooks).toHaveLength(0);
      expect(s.automationLogs()).toHaveLength(0);
    } finally {
      s.sqlite.close();
    }
  });

  it('refused bookings (422) do not fire', async () => {
    const s = setup();
    try {
      const r = await s.book({ intake: { ...INTAKE, agreeTerms: false } });
      expect(r.status).toBe(422);
      expect(s.hooks).toHaveLength(0);
    } finally {
      s.sqlite.close();
    }
  });

  it('upstream flow (BOOKING_INTAKE unset) also fires, with intake null', async () => {
    const s = setup({ intake: undefined });
    try {
      const id = await created(await s.book({ menu_id: 'm1', staff_id: 'st', starts_at: at(s.date, '10:30') }));
      expect(s.hooks).toHaveLength(1);
      expect(JSON.parse(s.hooks[0].body)).toMatchObject({ bookingId: id, intake: null, status: 'requested' });
    } finally {
      s.sqlite.close();
    }
  });

  it('send_webhook without a secret is sent unsigned (upstream behaviour kept)', async () => {
    const s = setup({ actions: [{ type: 'send_webhook', params: { url: ADAPTER } }] });
    try {
      await created(await s.book());
      expect(s.hooks).toHaveLength(1);
      expect(s.hooks[0].signature).toBeNull();
    } finally {
      s.sqlite.close();
    }
  });

  it('a non-2xx from the receiver is logged as failed (the booking still succeeds)', async () => {
    const s = setup({ adapterStatus: 500 });
    try {
      await created(await s.book());
      expect(s.hooks).toHaveLength(1);
      const logs = s.automationLogs();
      expect(logs[0].status).toBe('failed');
      expect(JSON.parse(logs[0].actions_result)).toEqual([
        { action: 'send_webhook', success: false, error: 'send_webhook HTTP 500' },
      ]);
    } finally {
      s.sqlite.close();
    }
  });

  it('send_message on calendar_booked cannot push (no LINE credentials are passed): pushes stay at 1', async () => {
    const s = setup({
      actions: [
        { type: 'send_message', params: { content: 'automation push' } },
        { type: 'send_webhook', params: { url: ADAPTER, secret: SECRET } },
      ],
    });
    try {
      await created(await s.book());
      expect(s.pushes).toHaveLength(1);
      expect(s.pushes[0].text).not.toContain('automation push');
      expect(s.hooks).toHaveLength(1);
      const logs = s.automationLogs();
      expect(logs[0].status).toBe('partial');
    } finally {
      s.sqlite.close();
    }
  });

  it("another account's automation does not fire", async () => {
    const s = setup({ accountOfAutomation: 'other-account' });
    try {
      await created(await s.book());
      expect(s.hooks).toHaveLength(0);
    } finally {
      s.sqlite.close();
    }
  });
});
