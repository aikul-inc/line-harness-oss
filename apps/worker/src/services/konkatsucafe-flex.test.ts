import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ALT_TEXT_MAX,
  buildKonkatsucafeFlex,
  cardValuesOf,
  FLEX_BUBBLE_MAX_BYTES,
  KONKATSUCAFE_SHOP,
  konkatsucafeHistoryUrl,
} from './konkatsucafe-flex.js';
import { notificationCardOf, sendBookingNotification, type NotificationKind } from './booking-notifier.js';

const HISTORY = konkatsucafeHistoryUrl('2011738064-qanf1Prm');
const INPUT = { startsAtJst: '2026-10-03 14:00', demo: true, name: '架空 花子', visitCount: '1名', historyUrl: HISTORY };
const KINDS: NotificationKind[] = ['requested', 'approved', 'rejected', 'expired', 'day_before', 'hours_before'];

function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts);
  if (!node || typeof node !== 'object') return [];
  const o = node as Record<string, unknown>;
  return [
    ...(['text', 'label', 'uri', 'altText'] as const).flatMap((k) => (typeof o[k] === 'string' ? [o[k] as string] : [])),
    ...Object.values(o).flatMap(texts),
  ];
}
function buttons(node: unknown): Array<{ label: string; uri: string }> {
  const out: Array<{ label: string; uri: string }> = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    if (o.type === 'button') out.push(o.action as { label: string; uri: string });
    Object.values(o).forEach(walk);
  };
  walk(node);
  return out;
}

describe('konkatsucafe の控えのカード', () => {
  test('受付: 見出し・日時・お名前・人数・電話で確認する旨・デモの注記・予約内容を見る', () => {
    const m = buildKonkatsucafeFlex('requested', INPUT)!;
    expect(m.type).toBe('flex');
    expect(m.altText).toBe('ご予約を受け付けました（2026年10月3日(土) 14:00）');
    const t = texts(m.contents).join('\n');
    for (const s of ['ご予約を受け付けました', '来店希望日時', '2026年10月3日(土) 14:00', '架空 花子 様', '1名',
      'お店からお電話でご予約内容を確認のうえ、確定のご連絡をいたします。', '※デモのため、実際のご予約にはなりません。']) {
      expect(t).toContain(s);
    }
    expect(buttons(m.contents)).toEqual([{ type: 'uri', label: '予約内容を見る', uri: HISTORY }]);
  });

  test('確定: 日時・人数・店の住所・営業時間・電話、地図と電話と予約内容のボタン。お名前は出さない', () => {
    const m = buildKonkatsucafeFlex('approved', INPUT)!;
    expect(m.altText).toBe('ご予約が確定しました（2026年10月3日(土) 14:00）');
    const t = texts(m.contents).join('\n');
    for (const s of ['ご予約が確定しました', '来店日時', '1名', KONKATSUCAFE_SHOP.address, KONKATSUCAFE_SHOP.hours,
      KONKATSUCAFE_SHOP.tel, KONKATSUCAFE_SHOP.closed]) {
      expect(t).toContain(s);
    }
    expect(t).not.toContain('花子');
    expect(buttons(m.contents).map((b) => b.label)).toEqual(['地図を開く', 'お店に電話する', '予約内容を見る']);
    expect(buttons(m.contents)[1].uri).toBe('tel:0534886450');
  });

  test('取り消し・期限切れ・前日・当日も同じ見た目で組める', () => {
    expect(buildKonkatsucafeFlex('rejected', INPUT)!.altText).toContain('ご予約の受付を取り消しました');
    expect(buildKonkatsucafeFlex('expired', INPUT)!.altText).toContain('ご予約の受付を取り消しました');
    expect(buildKonkatsucafeFlex('day_before', INPUT)!.altText).toContain('明日のご来店をお待ちしております');
    expect(buildKonkatsucafeFlex('hours_before', INPUT)!.altText).toContain('本日のご来店をお待ちしております');
  });

  test('どの種類も LINE の上限内で、ボタンは 20 文字以内・http(s)/tel だけ', () => {
    for (const k of KINDS) {
      const m = buildKonkatsucafeFlex(k, { ...INPUT, name: 'あ'.repeat(50) + ' ' + 'い'.repeat(50) })!;
      expect(m.altText.length).toBeLessThanOrEqual(ALT_TEXT_MAX);
      expect(new TextEncoder().encode(JSON.stringify(m.contents)).length).toBeLessThan(FLEX_BUBBLE_MAX_BYTES);
      for (const b of buttons(m.contents)) {
        expect([...b.label].length).toBeLessThanOrEqual(20);
        expect(b.uri).toMatch(/^(https:|tel:)/);
      }
    }
  });

  test('デモでなければ注記は出ない。履歴の URL が無ければボタンを出さない', () => {
    const m = buildKonkatsucafeFlex('requested', { ...INPUT, demo: false, historyUrl: null })!;
    expect(texts(m.contents).join('\n')).not.toContain('デモのため');
    expect(buttons(m.contents)).toEqual([]);
    expect((m.contents as Record<string, unknown>).footer).toBeUndefined();
  });

  test('色はお店のピンク #c94f5a', () => {
    expect(JSON.stringify(buildKonkatsucafeFlex('approved', INPUT))).toContain('#c94f5a');
  });

  test('大きさの上限を超える値は null（テキストに戻す）', () => {
    expect(buildKonkatsucafeFlex('requested', { ...INPUT, name: 'x'.repeat(40_000) })).toBeNull();
  });

  test('cardValuesOf は電話番号を読まない。壊れた JSON は空', () => {
    const v = cardValuesOf(JSON.stringify({ version: 'x', values: { sei: '架空', mei: '花子', tel: '090-000-0000', visitCount: '2名' } }));
    expect(v).toEqual({ name: '架空 花子', visitCount: '2名' });
    expect(cardValuesOf('{')).toEqual({});
    expect(notificationCardOf(null, 'x')).toBeUndefined();
    expect(konkatsucafeHistoryUrl('bad id/')).toBeNull();
  });
});

describe('sendBookingNotification（ネットワークは模擬）', () => {
  afterEach(() => vi.restoreAllMocks());
  const ctx = { menuName: 'm', staffName: 's', startsAtJst: '2026-10-03 14:00', hoursBefore: 0 };

  function mockPush(statuses: number[]) {
    const bodies: Array<{ messages: Array<{ type: string; text?: string }> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) !== 'https://api.line.me/v2/bot/message/push') throw Error('No external egress');
      bodies.push(JSON.parse(String(init?.body)));
      const status = statuses.shift() ?? 200;
      return new Response(status === 200 ? '{}' : '{"message":"invalid"}', { status });
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return bodies;
  }

  test('お客様情報つきの予約はカード 1 通', async () => {
    const bodies = mockPush([200]);
    await sendBookingNotification({ channelAccessToken: 't', toLineUserId: 'U', kind: 'requested',
      ctx: { ...ctx, style: 'konkatsucafe', card: { name: '架空 花子', visitCount: '1名', historyUrl: HISTORY } } });
    expect(bodies.map((b) => b.messages[0].type)).toEqual(['flex']);
  });

  test('LINE がカードを 400 で断ったらテキストで送り直す（届くのは 1 通）', async () => {
    const bodies = mockPush([400, 200]);
    await sendBookingNotification({ channelAccessToken: 't', toLineUserId: 'U', kind: 'approved',
      ctx: { ...ctx, style: 'konkatsucafe-demo' } });
    expect(bodies.map((b) => b.messages[0].type)).toEqual(['flex', 'text']);
    expect(bodies[1].messages[0].text).toContain('ご予約が確定しました');
    expect(bodies[1].messages[0].text).toContain('※デモのため');
  });

  test('400 以外の失敗はテキストに切り替えず投げる（リマインダの再送に任せ、二重に届けない）', async () => {
    const bodies = mockPush([500]);
    await expect(sendBookingNotification({ channelAccessToken: 't', toLineUserId: 'U', kind: 'day_before',
      ctx: { ...ctx, style: 'konkatsucafe' } })).rejects.toThrow();
    expect(bodies).toHaveLength(1);
  });

  test('カードが組めないときはテキスト 1 通', async () => {
    const bodies = mockPush([200]);
    await sendBookingNotification({ channelAccessToken: 't', toLineUserId: 'U', kind: 'requested',
      ctx: { ...ctx, style: 'konkatsucafe', card: { name: 'x'.repeat(40_000) } } });
    expect(bodies.map((b) => b.messages[0].type)).toEqual(['text']);
  });

  test('上流の予約（style なし）は今までどおりテキスト', async () => {
    const bodies = mockPush([200]);
    await sendBookingNotification({ channelAccessToken: 't', toLineUserId: 'U', kind: 'requested', ctx });
    expect(bodies.map((b) => b.messages[0].type)).toEqual(['text']);
  });
});
