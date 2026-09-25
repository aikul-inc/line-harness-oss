import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createHmac } from 'node:crypto';
import worker from '../index.js';
import { TenantScheduler, ensureSchedulerArmed } from '../durable-objects/tenant-scheduler.js';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { upsertFriend } from '@line-crm/db';
import { deliveryEnabled } from '../lib/delivery-policy.js';

const schema = readFileSync(new NodeURL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');
afterEach(() => vi.restoreAllMocks());
function setup(mode?: string) {
  const { db, sqlite } = sqliteD1();
  sqlite.exec(schema);
  for (const id of ['a', 'b'])
    sqlite
      .prepare(
        'INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,login_channel_id) VALUES(?,?,?,?,?,?)',
      )
      .run(id, id, `channel-${id}`, `synthetic-secret-${id}`, `synthetic-token-${id}`, `login-${id}`);
  sqlite.exec(
    "INSERT INTO entry_routes(id,ref_code,name,run_account_friend_add_scenarios) VALUES('route','demo-route','Synthetic route',1)",
  );
  sqlite.exec(`INSERT INTO tags(id,name) VALUES('tag','Synthetic tag');
    INSERT INTO scenarios(id,name,trigger_type,line_account_id) VALUES('scenario','Synthetic welcome','friend_add','a');
    INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES('step','scenario',0,'text','hello');
    INSERT INTO message_templates(id,name,message_type,message_content) VALUES('intro','Synthetic intro','text','hello');
    UPDATE entry_routes SET scenario_id='scenario',tag_id='tag',intro_template_id='intro';
    INSERT INTO automations(id,name,event_type,actions) VALUES('automation','Synthetic rule','friend_add','[{"type":"send_message","message":"hello"}]');`);
  const attempted: string[] = [];
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    attempted.push(url);
    const fixtures: Record<string, unknown> = {
      'https://api.line.me/oauth2/v2.1/token': { access_token: 'synthetic', id_token: 'synthetic' },
      'https://api.line.me/oauth2/v2.1/verify': { sub: 'synthetic-user', name: 'Synthetic' },
      'https://api.line.me/v2/profile': { userId: 'synthetic-user', displayName: 'Synthetic' },
    };
    if (Object.hasOwn(fixtures, url)) return Response.json(fixtures[url]);
    throw Error('No external egress allowed');
  });
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  const env = {
    DB: db,
    DELIVERY_MODE: mode,
    API_KEY: 'synthetic-key',
    LINE_CHANNEL_SECRET: 'synthetic-secret-a',
    LINE_CHANNEL_ACCESS_TOKEN: 'synthetic-token-a',
    LINE_LOGIN_CHANNEL_ID: 'login-a',
    LINE_LOGIN_CHANNEL_SECRET: 'synthetic-secret',
    LIFF_URL: 'https://liff.line.me/123-Demo',
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
  async function follow(account: string, type = 'follow') {
    const body = JSON.stringify({
      events: [{ type, source: { type: 'user', userId: `user-${account}` }, replyToken: 'synthetic-reply' }],
    });
    return request('/webhook', {
      method: 'POST',
      body,
      headers: {
        'X-Line-Signature': createHmac('sha256', `synthetic-secret-${account}`).update(body).digest('base64'),
      },
    });
  }
  function assertNoQueues() {
    for (const table of [
      'friend_scenarios',
      'broadcasts',
      'messages_log',
      'booking_reminders',
      'event_booking_reminders',
      'meet_consultation_reminders',
    ])
      expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
  }
  return { sqlite, env, ctx, request, follow, assertNoQueues, network, attempted, logs };
}

describe('tenant-wide no-send boundaries (local only)', () => {
  it.each([undefined, '', 'disabled', 'true', 'Enabled', ' enabled '])(
    'fails closed for %s at immediate, scheduled, raw proxy and automation HTTP entry points',
    async (mode) => {
      const s = setup(mode);
      try {
        for (const path of [
          '/api/messages/push',
          '/api/messages/reply',
          '/api/messages/multicast',
          '/api/messages/broadcast',
          '/api/broadcasts',
          '/api/liff/send-form-link',
          '/api/scenarios/example/enroll/friend',
          '/api/automations',
          '/line-api/v2/bot/message/push',
          '/line-api/v2/bot/message/reply',
          '/line-api/v2/bot/message/multicast',
          '/line-api/v2/bot/message/broadcast',
          '/api/broadcasts/example/send',
          '/api/broadcasts/example/send-segment',
          '/api/unknown',
        ]) {
          const r = await s.request(path, {
            method: 'POST',
            body: JSON.stringify({ scheduledAt: '2099-01-01T00:00:00Z' }),
            headers: { 'Content-Type': 'application/json' },
          });
          expect(r.status, path).toBe(423);
          expect(await r.json()).toMatchObject({ success: false });
        }
        expect((await s.request('/unknown-side-effect')).status).toBe(423);
        expect(s.network).not.toHaveBeenCalled();
        s.assertNoQueues();
        expect(s.logs.mock.calls.every(([value]) => !String(value).includes('synthetic'))).toBe(true);
      } finally {
        s.sqlite.close();
      }
    },
  );

  it('records OAuth attribution but skips form, ref, account scenarios and cross-platform notifications', async () => {
    const s = setup();
    try {
      const fields = new URLSearchParams({
        ref: 'demo-route',
        form: 'fake-form',
        ig: 'fake-ig',
        gclid: 'fake-g',
        fbclid: 'fake-f',
        utm_source: 'meta',
        utm_medium: 'paid',
        utm_campaign: 'demo',
        utm_content: 'A',
        utm_term: 'B',
      });
      const auth = await s.request(`/auth/oauth?${fields}`);
      const state = new URL(auth.headers.get('location')!).searchParams.get('state')!;
      const res = await s.request(`/auth/callback?code=synthetic&state=${encodeURIComponent(state)}`);
      expect(await res.text()).toContain('通知は行っていません');
      const friend = s.sqlite.prepare('SELECT metadata,ref_code FROM friends').get() as {
        metadata: string;
        ref_code: string;
      };
      expect(JSON.parse(friend.metadata)).toMatchObject({
        gclid: 'fake-g',
        fbclid: 'fake-f',
        utm_content: 'A',
        utm_term: 'B',
      });
      expect(friend.ref_code).toBe('demo-route');
      expect(s.sqlite.prepare('SELECT entry_route_id FROM ref_tracking').get()).toEqual({ entry_route_id: 'route' });
      expect(s.attempted).toHaveLength(3);
      s.assertNoQueues();
    } finally {
      s.sqlite.close();
    }
  });

  it.each(['a', 'b'])(
    'links new/existing users for account %s without ref/tag/cross-platform notifications',
    async (account) => {
      const s = setup();
      try {
        s.env.LINE_LOGIN_CHANNEL_ID = `login-${account}`;
        const friend = await upsertFriend(s.env.DB, { lineUserId: 'synthetic-user', displayName: 'Synthetic' });
        s.sqlite.prepare('UPDATE friends SET line_account_id=? WHERE id=?').run(account, friend.id);
        for (const alreadyLinked of [false, true]) {
          const response = await s.request('/api/liff/link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken: 'synthetic', ref: 'demo-route', ig: 'fake-ig' }),
          });
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ success: true, data: { alreadyLinked } });
        }
        expect(s.sqlite.prepare('SELECT COUNT(*) AS n FROM ref_tracking').get()).toEqual({ n: 2 });
        expect(s.sqlite.prepare('SELECT COUNT(*) AS n FROM friend_tags').get()).toEqual({ n: 0 });
        s.assertNoQueues();
        expect(s.attempted).toEqual(Array(2).fill('https://api.line.me/oauth2/v2.1/verify'));
      } finally {
        s.sqlite.close();
      }
    },
  );

  it('records signed follows across two accounts without profile/reply/event bus/enroll, and handles unfollow', async () => {
    const s = setup('disabled');
    try {
      for (const account of ['a', 'b']) expect((await s.follow(account)).status).toBe(200);
      expect(s.sqlite.prepare('SELECT line_account_id FROM friends ORDER BY line_account_id').all()).toEqual([
        { line_account_id: 'a' },
        { line_account_id: 'b' },
      ]);
      await s.follow('b', 'unfollow');
      expect(s.sqlite.prepare("SELECT is_following FROM friends WHERE line_account_id='b'").get()).toEqual({
        is_following: 0,
      });
      expect(s.network).not.toHaveBeenCalled();
      s.assertNoQueues();
    } finally {
      s.sqlite.close();
    }
  });

  it('acknowledges a signed null payload without work', async () => {
    const s = setup();
    try {
      const body = 'null';
      const response = await s.request('/webhook', {
        method: 'POST',
        body,
        headers: { 'X-Line-Signature': createHmac('sha256', 'synthetic-secret-a').update(body).digest('base64') },
      });
      expect(response.status).toBe(200);
      expect(s.network).not.toHaveBeenCalled();
      s.assertNoQueues();
    } finally {
      s.sqlite.close();
    }
  });

  it('continues later signed relationship events after a local recording failure and returns 200', async () => {
    const s = setup();
    try {
      const original = s.env.DB.prepare.bind(s.env.DB);
      let first = true;
      vi.spyOn(s.env.DB, 'prepare').mockImplementation((sql) => {
        if (first && sql.includes('SELECT * FROM friends')) {
          first = false;
          throw Error('synthetic-private-detail');
        }
        return original(sql);
      });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const body = JSON.stringify({
        events: [null, ...['first', 'second'].map((userId) => ({ type: 'follow', source: { type: 'user', userId } }))],
      });
      const response = await s.request('/webhook', {
        method: 'POST',
        body,
        headers: { 'X-Line-Signature': createHmac('sha256', 'synthetic-secret-a').update(body).digest('base64') },
      });
      expect(response.status).toBe(200);
      expect(s.sqlite.prepare('SELECT line_user_id FROM friends').all()).toEqual([{ line_user_id: 'second' }]);
      expect(errors.mock.calls.flat().join(' ')).not.toContain('synthetic-private-detail');
      s.assertNoQueues();
      expect(s.network).not.toHaveBeenCalled();
    } finally {
      s.sqlite.close();
    }
  });

  it('records identified tracked clicks without tag/scenario or delayed notification work', async () => {
    const s = setup();
    try {
      await s.follow('a');
      const friend = s.sqlite.prepare('SELECT id FROM friends').get() as { id: string };
      s.sqlite
        .prepare(
          "INSERT INTO tracked_links(id,name,original_url,tag_id,scenario_id) VALUES('link','Synthetic','https://synthetic.example/auth/line','tag','scenario')",
        )
        .run();
      const response = await s.request(`/t/link?f=${friend.id}`);
      expect(response.status).toBe(302);
      expect(s.sqlite.prepare("SELECT click_count FROM tracked_links WHERE id='link'").get()).toEqual({
        click_count: 1,
      });
      expect(s.sqlite.prepare('SELECT COUNT(*) AS n FROM friend_tags').get()).toEqual({ n: 0 });
      s.assertNoQueues();
      expect(s.network).not.toHaveBeenCalled();
    } finally {
      s.sqlite.close();
    }
  });

  it('freezes cron and DO alarm/arming before database work or new scheduling', async () => {
    const s = setup();
    try {
      s.sqlite.exec(
        "INSERT INTO broadcasts(id,title,message_type,message_content,status,scheduled_at) VALUES('old','Existing scheduled','text','hello','scheduled','2000-01-01')",
      );
      const snapshot = s.sqlite.prepare('SELECT * FROM broadcasts').all();
      const dbAccess = vi.fn(() => {
        throw Error('Scheduler DB must not be reached');
      });
      const env = { ...s.env, DB: { prepare: dbAccess } as unknown as D1Database };
      await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() } as ScheduledEvent, env, s.ctx);
      const storage = { getAlarm: vi.fn(), setAlarm: vi.fn() };
      const state = {
        storage,
        blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
        waitUntil: vi.fn(),
      } as unknown as DurableObjectState;
      const scheduler = new TenantScheduler(state, env);
      await scheduler.alarm();
      await scheduler.ensureArmed();
      const get = vi.fn();
      await ensureSchedulerArmed({
        ...env,
        TENANT_SCHEDULER: { get, idFromName: vi.fn() } as unknown as DurableObjectNamespace<TenantScheduler>,
      });
      expect(s.sqlite.prepare('SELECT * FROM broadcasts').all()).toEqual(snapshot);
      expect(storage.setAlarm).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(dbAccess).not.toHaveBeenCalled();
      expect(s.network).not.toHaveBeenCalled();
      expect(s.logs.mock.calls.map(([x]) => JSON.parse(String(x)).boundary)).toEqual(
        expect.arrayContaining(['scheduled', 'alarm', 'arm']),
      );
    } finally {
      s.sqlite.close();
    }
  });

  it('only enables existing delivery behavior for the exact explicit value', () => {
    expect(deliveryEnabled({ DELIVERY_MODE: 'enabled' })).toBe(true);
    expect(deliveryEnabled({ DELIVERY_MODE: 'ENABLED' })).toBe(false);
  });
});
