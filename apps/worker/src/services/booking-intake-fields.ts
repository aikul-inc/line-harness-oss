// konkatsucafe fork (L-08): 予約で聞く「お客様情報」の項目と検証。
//
// **正本は konkatsucafe-line の `src/data/yoyaku.ts` の `fields`**（さらにその正本は
// konkatsucafe-site の同名ファイル）。並び・ラベル・選択肢を 1 文字も変えずに写している。
// 依頼者側は通知メールを「行の位置で」読むため、L-10 が同じ並びでメールとシートを組めるよう、
// 予約に残す値のキーと書き方も /yoyaku/ の受け口に揃える（チェックは「はい」、複数選択は「、」）。
//
// Worker（受け口の検証）と LIFF の画面（入力欄）の両方から読むので、Worker 専用の型や
// ブラウザ専用の API には触れない。
import { shopDayStatus } from './konkatsucafe-holidays.js';

export type IntakeFieldKind =
  | 'text'
  | 'tel'
  | 'date'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'checkgroup'
  | 'textarea';

export interface IntakeField {
  name: string;
  /** 画面に出すラベル（/yoyaku/ と同じ） */
  label: string;
  /** メールとシートの見出し。指定があるときだけ label の代わりに使う */
  mailLabel?: string;
  /** 短い呼び方。未入力の案内・管理画面・友だち情報の見出しに使う */
  short: string;
  kind: IntakeFieldKind;
  required: boolean;
  options?: readonly string[];
  autocomplete?: string;
}

/**
 * `BOOKING_INTAKE` に入れる値。konkatsucafe の予約の流れ全体を切り替える
 * （お客様情報を聞く・メニューと担当を自動で割り当てる・枠の上限なし・自動の期限切れなし）。
 * `-demo` は控えに「デモのため…」を添える。これ以外の値は設定の誤りとして予約を断る
 */
export const KONKATSUCAFE_INTAKE = 'konkatsucafe';
export const KONKATSUCAFE_INTAKE_DEMO = 'konkatsucafe-demo';

/** 控えに添えるデモの注記 */
export const DEMO_NOTICE = '※デモのため、実際のご予約にはなりません。';

/**
 * 現サイトの営業時間・定休日（konkatsucafe-site の src/data/site.ts の hours・closed の写し）。
 * /yoyaku/ と同じく、日付の選択では定休日を止めず、この文を添えるだけにする
 */
export const SHOP_HOURS = '10:00〜19:00（Lo .18:00）';
export const SHOP_CLOSED = '火曜日（祝日は営業）';

/** 来店希望日として選べる範囲（/yoyaku/ の VISIT_DATE_RANGE.futureYears）。今日から 2 年先まで */
export const VISIT_DATE_FUTURE_YEARS = 2;

/** 予約に一緒に残す版。L-10 がシートの「フォーム版」に使うかを決める */
export const INTAKE_VERSION = 'lharness-2026-09';

const ages = Array.from({ length: 49 }, (_, i) => `${20 + i}歳`);

const times = Array.from({ length: 16 }, (_, i) => {
  const m = 10 * 60 + 30 + i * 30;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
});

/** `src/data/yoyaku.ts` の `fields` の写し。**並べ替えない。** */
export const INTAKE_FIELDS: readonly IntakeField[] = [
  { name: 'sei', label: 'お名前(姓)', short: 'お名前(姓)', kind: 'text', required: true, autocomplete: 'family-name' },
  { name: 'mei', label: 'お名前(名)', short: 'お名前(名)', kind: 'text', required: true, autocomplete: 'given-name' },
  { name: 'gender', label: '性別', short: '性別', kind: 'radio', required: true, options: ['男性', '女性'] },
  { name: 'age', label: '年齢', short: '年齢', kind: 'select', required: true, options: ages },
  {
    name: 'tel',
    label: '電話番号※入力ミスは予約が取れないためお間違えのないように',
    mailLabel: '電話番号',
    short: '電話番号',
    kind: 'tel',
    required: true,
    autocomplete: 'tel',
  },
  {
    name: 'lineName',
    label: 'LINE名※LINEからのご予約の方は必ずご入力ください',
    short: 'LINE名',
    kind: 'text',
    required: false,
  },
  { name: 'visitDate', label: '来店希望日', short: '来店希望日', kind: 'date', required: true },
  { name: 'visitTime', label: '来店希望時間', short: '来店希望時間', kind: 'select', required: true, options: times },
  {
    name: 'visitCount',
    label: '来店人数',
    short: '来店人数',
    kind: 'select',
    required: true,
    options: ['1名', '2名', '3名以上をご希望の場合はお電話でお問い合わせください。'],
  },
  {
    name: 'agreeTerms',
    label: '【ご利用条件】20歳〜65歳の独身でパートナーを探している方ですか？必ずチェックしてください',
    short: 'ご利用条件',
    kind: 'checkbox',
    required: true,
  },
  {
    name: 'experience',
    label: '婚活の経験はありますか？',
    short: '婚活の経験',
    kind: 'checkgroup',
    required: true,
    options: ['未経験', 'マッチングアプリ利用', 'パーティー参加', '結婚相談所利用'],
  },
  {
    name: 'message',
    label: '婚活の現状やお悩み、いつまでに結婚したいなどご入力ください。',
    short: 'ご相談内容',
    kind: 'textarea',
    required: false,
  },
];

/** 予約の枠から入れる項目。画面では聞かない（枠の選択とだぶらせない） */
export const SLOT_FIELD_NAMES: readonly string[] = ['visitDate', 'visitTime'];

/** 画面で聞く項目（12 項目から来店希望日・時間を除いた 10 項目）。並びは同じ */
export const ASKED_FIELDS: readonly IntakeField[] = INTAKE_FIELDS.filter(
  (f) => !SLOT_FIELD_NAMES.includes(f.name),
);

/** 予約ごとの値。友だち情報には写さない */
const PER_BOOKING_FIELD_NAMES: readonly string[] = ['visitDate', 'visitTime', 'visitCount'];

/** 文字数の上限（/yoyaku/ の受け口と同じ）。ここに無い項目は選択肢か形で決まる */
export const INTAKE_MAX_LENGTH: Record<string, number> = {
  sei: 50,
  mei: 50,
  tel: 20,
  lineName: 100,
  message: 2000,
};

/** 電話番号の数字の桁数（/yoyaku/ の受け口と同じ） */
export const TEL_DIGITS = { min: 9, max: 15 };

const DASHES = /[‐‑‒–—―−ー－˗֊⁃]/g;

/** 電話番号を半角にそろえる（/yoyaku/ の受け口の normalizeTel と同じ順序） */
export function normalizeTel(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\s　]/g, '')
    .replace(DASHES, '-')
    .replace(/[(（]/g, '')
    .replace(/[)）]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 画面から届く形。チェックは真偽、複数選択は配列 */
export interface IntakeInput {
  sei?: unknown;
  mei?: unknown;
  gender?: unknown;
  age?: unknown;
  tel?: unknown;
  lineName?: unknown;
  visitCount?: unknown;
  agreeTerms?: unknown;
  experience?: unknown;
  message?: unknown;
}

/** 予約に残す形。キーは `fields` の `name`、値は /yoyaku/ の受け口と同じ書き方の文字列 */
export type IntakeValues = Record<string, string>;

export interface StoredIntake {
  version: string;
  values: IntakeValues;
  /** デモの予約。控えに DEMO_NOTICE を添える */
  demo?: boolean;
}

export type IntakeResult =
  | { ok: true; values: IntakeValues }
  | { ok: false; missing: string[]; invalid: string[] };

function asStrings(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return null;
}

/** 未入力のときに項目のそばに出す案内（/yoyaku/ の missingMessage と同じ言い方） */
export function intakeMissingMessage(f: IntakeField): string {
  if (f.kind === 'checkbox') return 'ご確認のうえ、チェックしてください';
  if (f.kind === 'select' || f.kind === 'radio' || f.kind === 'checkgroup') {
    return `${f.short}をお選びください`;
  }
  return `${f.short}をご入力ください`;
}

/**
 * 届いた値を確かめ、予約に残す 12 項目を組み立てる。
 * 来店希望日・時間は `startsAt`（UTC）から日本時間で入れる。画面から届いた値は使わない。
 * 足りない・範囲外の項目は短い呼び方で返す（値そのものは返さない）。
 */
export function validateIntake(input: unknown, startsAt: Date): IntakeResult {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const missing: string[] = [];
  const invalid: string[] = [];
  const values: IntakeValues = {};

  for (const f of ASKED_FIELDS) {
    if (f.kind === 'checkbox') {
      const v = raw[f.name];
      if (v !== undefined && v !== null && typeof v !== 'boolean') {
        invalid.push(f.short);
        continue;
      }
      values[f.name] = v === true ? 'はい' : '';
      if (f.required && v !== true) missing.push(f.short);
      continue;
    }

    const list = asStrings(raw[f.name]);
    if (list === null || (f.kind !== 'checkgroup' && list.length > 1)) {
      invalid.push(f.short);
      continue;
    }
    let all = list.map((v) => v.trim()).filter((v) => v !== '');
    if (f.name === 'tel') all = all.map(normalizeTel).filter((v) => v !== '');

    const joined = all.join('');
    const max = INTAKE_MAX_LENGTH[f.name];
    let bad = max !== undefined && [...joined].length > max;
    if (!bad && f.name === 'tel' && all[0] !== undefined) {
      const tel = all[0];
      const digits = tel.replace(/-/g, '').length;
      bad = !/^[0-9-]+$/.test(tel) || digits < TEL_DIGITS.min || digits > TEL_DIGITS.max;
    }
    if (!bad && f.options) {
      const seen = new Set<string>();
      for (const v of all) {
        if (!f.options.includes(v) || seen.has(v)) {
          bad = true;
          break;
        }
        seen.add(v);
      }
    }
    if (bad) {
      invalid.push(f.short);
      continue;
    }

    // /yoyaku/ の受け口と同じく、改行は残して前後の空白だけ落とす（1 行にするのはメールを組むとき）
    values[f.name] = all.join('、');
    if (f.required && values[f.name] === '') missing.push(f.short);
  }

  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid };

  const jst = new Date(startsAt.getTime() + 9 * 3600_000).toISOString();
  const ordered: IntakeValues = {};
  for (const f of INTAKE_FIELDS) {
    if (f.name === 'visitDate') ordered[f.name] = jst.slice(0, 10);
    else if (f.name === 'visitTime') ordered[f.name] = jst.slice(11, 16);
    else ordered[f.name] = values[f.name] ?? '';
  }
  return { ok: true, values: ordered };
}

/** 友だち情報（friends.metadata）に写す 9 項目。キーは短い呼び方 */
export function intakeFriendMetadata(values: IntakeValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of INTAKE_FIELDS) {
    if (PER_BOOKING_FIELD_NAMES.includes(f.name)) continue;
    out[f.short] = values[f.name] ?? '';
  }
  return out;
}

/** 予約の列（JSON）を読み戻す。形が崩れていれば null */
export function parseStoredIntake(json: unknown): StoredIntake | null {
  if (typeof json !== 'string' || json === '') return null;
  try {
    const parsed = JSON.parse(json) as Partial<StoredIntake>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.version !== 'string') return null;
    const values = parsed.values;
    if (!values || typeof values !== 'object') return null;
    const clean: IntakeValues = {};
    for (const f of INTAKE_FIELDS) {
      const v = (values as Record<string, unknown>)[f.name];
      clean[f.name] = typeof v === 'string' ? v : '';
    }
    return parsed.demo === true
      ? { version: parsed.version, values: clean, demo: true }
      : { version: parsed.version, values: clean };
  } catch {
    return null;
  }
}

/** 管理画面の一覧に出す並び（12 項目、短い呼び方と値） */
export function intakeItems(values: IntakeValues): Array<{ name: string; label: string; value: string }> {
  return INTAKE_FIELDS.map((f) => ({ name: f.name, label: f.short, value: values[f.name] ?? '' }));
}

/** 来店希望時間の選択肢（/yoyaku/ の times。10:30〜18:00 の 30 分刻み） */
export const VISIT_TIMES: readonly string[] =
  INTAKE_FIELDS.find((f) => f.name === 'visitTime')?.options ?? [];

/** 日本時間の暦日（YYYY-MM-DD） */
export function jstDay(now: Date): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 来店希望日の下限・上限（/yoyaku/ の visitDateBounds と同じ。今日〜2 年後の同じ日） */
export function visitDateBounds(now: Date): { min: string; max: string } {
  const min = jstDay(now);
  const limit = new Date(`${min}T00:00:00Z`);
  limit.setUTCFullYear(limit.getUTCFullYear() + VISIT_DATE_FUTURE_YEARS);
  return { min, max: limit.toISOString().slice(0, 10) };
}

/**
 * 来店希望日時が受けられるか。日付の範囲と時間の選択肢は /yoyaku/ と同じ。
 * s4: ふつうの火曜（定休）と、祝日の一覧がまだ無い範囲の火曜は 'closed'（konkatsucafe-holidays.ts）。
 * 'past' は選択肢には入っているが、すでに過ぎた時刻（今日の早い時間）
 */
export function checkVisitSlot(
  startsAt: Date,
  now: Date,
): 'ok' | 'invalid_date' | 'invalid_time' | 'closed' | 'past' {
  if (Number.isNaN(startsAt.getTime())) return 'invalid_date';
  const jst = new Date(startsAt.getTime() + 9 * 3600_000).toISOString();
  const date = jst.slice(0, 10);
  const time = jst.slice(11, 16);
  if (jst.slice(16, 23) !== ':00.000' || !VISIT_TIMES.includes(time)) return 'invalid_time';
  const { min, max } = visitDateBounds(now);
  if (date < min || date > max) return 'invalid_date';
  if (shopDayStatus(date) === 'closed') return 'closed';
  if (startsAt.getTime() < now.getTime()) return 'past';
  return 'ok';
}

/** 控えの日時の書き方。`2026-10-03 14:00` → `2026年10月3日(土) 14:00` */
export function formatVisitJst(startsAtJst: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(startsAtJst);
  if (!m) return startsAtJst;
  const w = '日月火水木金土'[new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getUTCDay()];
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日(${w}) ${m[4]}`;
}
