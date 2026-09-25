// konkatsucafe fork (L-08): お客様情報の項目が /yoyaku/ の写しのままであること、検証の範囲。
// 期待値は konkatsucafe-line の src/data/yoyaku.ts の fields から写した。すべて架空の値。
import { describe, expect, it } from 'vitest';
import { renderNotificationText } from './booking-notifier.js';
import {
  ASKED_FIELDS,
  VISIT_TIMES,
  checkVisitSlot,
  formatVisitJst,
  visitDateBounds,
  INTAKE_FIELDS,
  intakeFriendMetadata,
  intakeItems,
  normalizeTel,
  parseStoredIntake,
  validateIntake,
} from './booking-intake-fields.js';

const YOYAKU = [
  ['sei', 'お名前(姓)', 'text', true],
  ['mei', 'お名前(名)', 'text', true],
  ['gender', '性別', 'radio', true],
  ['age', '年齢', 'select', true],
  ['tel', '電話番号※入力ミスは予約が取れないためお間違えのないように', 'tel', true],
  ['lineName', 'LINE名※LINEからのご予約の方は必ずご入力ください', 'text', false],
  ['visitDate', '来店希望日', 'date', true],
  ['visitTime', '来店希望時間', 'select', true],
  ['visitCount', '来店人数', 'select', true],
  ['agreeTerms', '【ご利用条件】20歳〜65歳の独身でパートナーを探している方ですか？必ずチェックしてください', 'checkbox', true],
  ['experience', '婚活の経験はありますか？', 'checkgroup', true],
  ['message', '婚活の現状やお悩み、いつまでに結婚したいなどご入力ください。', 'textarea', false],
] as const;

// JST 2026-10-03 14:00
const STARTS = new Date('2026-10-03T05:00:00Z');

const OK = {
  sei: '架空',
  mei: '花子',
  gender: '女性',
  age: '32歳',
  tel: '０９０ー０００ー００００',
  lineName: 'はなこ（直した）',
  visitCount: '1名',
  agreeTerms: true,
  experience: ['マッチングアプリ利用', '未経験'],
  message: '  一年以内に\n結婚したい  ',
};

describe('booking intake fields (copy of konkatsucafe src/data/yoyaku.ts)', () => {
  it('keeps the 12 fields in the same order, labels, kinds and required flags', () => {
    expect(INTAKE_FIELDS.map((f) => [f.name, f.label, f.kind, f.required])).toEqual(YOYAKU);
    expect(INTAKE_FIELDS.find((f) => f.name === 'tel')?.mailLabel).toBe('電話番号');
  });

  it('keeps the options', () => {
    const opt = (name: string) => INTAKE_FIELDS.find((f) => f.name === name)?.options;
    expect(opt('gender')).toEqual(['男性', '女性']);
    expect(opt('age')).toHaveLength(49);
    expect(opt('age')?.[0]).toBe('20歳');
    expect(opt('age')?.[48]).toBe('68歳');
    expect(opt('visitTime')).toHaveLength(16);
    expect(opt('visitTime')?.[0]).toBe('10:30');
    expect(opt('visitTime')?.[15]).toBe('18:00');
    expect(opt('visitCount')).toEqual(['1名', '2名', '3名以上をご希望の場合はお電話でお問い合わせください。']);
    expect(opt('experience')).toEqual(['未経験', 'マッチングアプリ利用', 'パーティー参加', '結婚相談所利用']);
  });

  it('asks 10 fields: everything except the date and time picked from the slot', () => {
    expect(ASKED_FIELDS.map((f) => f.name)).toEqual([
      'sei', 'mei', 'gender', 'age', 'tel', 'lineName', 'visitCount', 'agreeTerms', 'experience', 'message',
    ]);
  });
});

describe('validateIntake', () => {
  it('builds 12 values in /yoyaku/ encoding, date/time from the slot in JST', () => {
    const r = validateIntake(OK, STARTS);
    expect(r).toEqual({
      ok: true,
      values: {
        sei: '架空',
        mei: '花子',
        gender: '女性',
        age: '32歳',
        tel: '090-000-0000',
        lineName: 'はなこ（直した）',
        visitDate: '2026-10-03',
        visitTime: '14:00',
        visitCount: '1名',
        agreeTerms: 'はい',
        experience: 'マッチングアプリ利用、未経験',
        message: '一年以内に\n結婚したい',
      },
    });
    if (r.ok) expect(Object.keys(r.values)).toEqual(YOYAKU.map(([n]) => n));
  });

  it('ignores date/time sent from the screen', () => {
    const r = validateIntake({ ...OK, visitDate: '2099-01-01', visitTime: '03:00' }, STARTS);
    expect(r.ok && [r.values.visitDate, r.values.visitTime]).toEqual(['2026-10-03', '14:00']);
  });

  it('allows the optional LINE name and message to be empty', () => {
    const r = validateIntake({ ...OK, lineName: '', message: undefined }, STARTS);
    expect(r.ok && [r.values.lineName, r.values.message]).toEqual(['', '']);
  });

  it.each([
    ['missing surname', { sei: ' ' }, { missing: ['お名前(姓)'], invalid: [] }],
    ['no consent', { agreeTerms: false }, { missing: ['ご利用条件'], invalid: [] }],
    ['consent as a string', { agreeTerms: 'はい' }, { missing: [], invalid: ['ご利用条件'] }],
    ['no experience', { experience: [] }, { missing: ['婚活の経験'], invalid: [] }],
    ['unknown gender', { gender: 'その他' }, { missing: [], invalid: ['性別'] }],
    ['age out of list', { age: '19歳' }, { missing: [], invalid: ['年齢'] }],
    ['two genders', { gender: ['男性', '女性'] }, { missing: [], invalid: ['性別'] }],
    ['duplicate experience', { experience: ['未経験', '未経験'] }, { missing: [], invalid: ['婚活の経験'] }],
    ['unknown count', { visitCount: '5名' }, { missing: [], invalid: ['来店人数'] }],
    ['tel too short', { tel: '090-1' }, { missing: [], invalid: ['電話番号'] }],
    ['tel with letters', { tel: '090-abcd-0000' }, { missing: [], invalid: ['電話番号'] }],
    ['surname too long', { sei: 'あ'.repeat(51) }, { missing: [], invalid: ['お名前(姓)'] }],
    ['message too long', { message: 'あ'.repeat(2001) }, { missing: [], invalid: ['ご相談内容'] }],
    ['number instead of text', { mei: 1 }, { missing: [], invalid: ['お名前(名)'] }],
  ])('rejects %s', (_label, patch, expected) => {
    expect(validateIntake({ ...OK, ...patch }, STARTS)).toEqual({ ok: false, ...expected });
  });

  it('rejects a missing intake with every required field', () => {
    const r = validateIntake(undefined, STARTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toEqual(['お名前(姓)', 'お名前(名)', '性別', '年齢', '電話番号', '来店人数', 'ご利用条件', '婚活の経験']);
    }
  });
});

describe('friend metadata and readback', () => {
  it('copies the 9 person-level fields with short labels, not the per-booking date/time/count', () => {
    const r = validateIntake(OK, STARTS);
    if (!r.ok) throw Error('unexpected');
    expect(intakeFriendMetadata(r.values)).toEqual({
      'お名前(姓)': '架空',
      'お名前(名)': '花子',
      性別: '女性',
      年齢: '32歳',
      電話番号: '090-000-0000',
      LINE名: 'はなこ（直した）',
      ご利用条件: 'はい',
      婚活の経験: 'マッチングアプリ利用、未経験',
      ご相談内容: '一年以内に\n結婚したい',
    });
  });

  it('parses stored JSON and drops unknown keys; broken JSON is null', () => {
    const stored = JSON.stringify({ version: 'v', values: { sei: '架空', extra: 'x', age: 3 } });
    const parsed = parseStoredIntake(stored);
    expect(parsed?.version).toBe('v');
    expect(parsed?.values.sei).toBe('架空');
    expect(parsed?.values.age).toBe('');
    expect(parsed && 'extra' in parsed.values).toBe(false);
    expect(parseStoredIntake('{')).toBeNull();
    expect(parseStoredIntake(null)).toBeNull();
    expect(parseStoredIntake(JSON.stringify({ values: {} }))).toBeNull();
    expect(parsed && intakeItems(parsed.values).map((i) => i.label)).toEqual([
      'お名前(姓)', 'お名前(名)', '性別', '年齢', '電話番号', 'LINE名',
      '来店希望日', '来店希望時間', '来店人数', 'ご利用条件', '婚活の経験', 'ご相談内容',
    ]);
  });

  it('normalizes phone numbers like /yoyaku/', () => {
    expect(normalizeTel('（０００）０００ー００００')).toBe('000-000-0000');
    expect(normalizeTel(' 090 0000 0000 ')).toBe('09000000000');
  });
});

describe('visit date/time like /yoyaku/ (L-08 s2)', () => {
  // JST 2026-09-25 18:10
  const NOW = new Date('2026-09-25T09:10:00Z');
  const at = (d: string, t: string) => new Date(`${d}T${t}:00+09:00`);

  it('uses the 16 /yoyaku/ times and today..+2 years', () => {
    expect(VISIT_TIMES).toHaveLength(16);
    expect([VISIT_TIMES[0], VISIT_TIMES[15]]).toEqual(['10:30', '18:00']);
    expect(visitDateBounds(NOW)).toEqual({ min: '2026-09-25', max: '2028-09-25' });
  });

  it.each([
    ['2026-09-29', '10:30', 'ok'], // 火曜も選べる（/yoyaku/ と同じ）
    ['2028-09-25', '18:00', 'ok'],
    ['2026-09-25', '18:00', 'past'], // 今日のすでに過ぎた時間（今は 18:10）
    ['2026-09-25', '17:30', 'past'],
    ['2026-09-26', '10:00', 'invalid'],
    ['2026-09-26', '18:30', 'invalid'],
    ['2026-09-26', '11:15', 'invalid'],
    ['2028-09-26', '10:30', 'invalid'],
    ['2026-09-24', '14:00', 'invalid'],
  ])('%s %s → %s', (d, t, expected) => {
    expect(checkVisitSlot(at(d, t), NOW)).toBe(expected);
  });

  it('rejects seconds and broken dates', () => {
    expect(checkVisitSlot(new Date('2026-10-01T05:00:30Z'), NOW)).toBe('invalid');
    expect(checkVisitSlot(new Date('nope'), NOW)).toBe('invalid');
  });

  it('formats the notice date in Japanese with the weekday', () => {
    expect(formatVisitJst('2026-10-03 14:00')).toBe('2026年10月3日(土) 14:00');
  });

  it('konkatsucafe notices hide menu and staff; demo adds the notice', () => {
    const ctx = { menuName: 'パンケーキ', staffName: 'カフェ受付', startsAtJst: '2026-10-03 14:00', hoursBefore: 0 };
    expect(renderNotificationText('requested', { ...ctx, style: 'konkatsucafe' })).toBe(
      'ご予約を受け付けました。\n来店希望日時: 2026年10月3日(土) 14:00\n\nお店からお電話でご予約内容を確認のうえ、確定のご連絡をいたします。',
    );
    for (const kind of ['requested', 'approved', 'rejected', 'expired', 'day_before', 'hours_before'] as const) {
      const text = renderNotificationText(kind, { ...ctx, style: 'konkatsucafe-demo' });
      expect(text).not.toMatch(/パンケーキ|カフェ受付|メニュー|担当/);
      expect(text.endsWith('※デモのため、実際のご予約にはなりません。')).toBe(true);
    }
    // 上流の書き方は変えない
    expect(renderNotificationText('requested', ctx)).toContain('メニュー: パンケーキ');
  });
});
