// konkatsucafe fork (L-11): お客様情報つきの予約の控えを Flex メッセージ（カード）で組む。
//
// 見た目・言葉づかいは L Harness を入れる前の自前の控え（konkatsucafe-line の functions/_lib/flex.ts）に揃える。
// 色はお店のピンク #c94f5a（L-08 s4 で決定。白文字 4.42:1）。
// 文面の流れは L-08 s2 のまま（受付 → お店から電話 → 確定／取り消し → 前日）。
//
// **組めないとき・大きさの上限を超えたときは null を返す。** 呼び出し側は今のテキストで送る
// （控えが届かない事態を作らない）。
// **お客さまの電話番号はカードに載せない**（トークに残るため）。

import { DEMO_NOTICE, formatVisitJst } from './booking-intake-fields.js';
import type { NotificationKind } from './booking-notifier.js';

/**
 * 店舗の情報。正本は konkatsucafe-site の `src/data/site.ts`。**値を推測で足さない。**
 * mapUrl は正本の mapEmbedUrl から埋め込み用の `&output=embed` を外したもの（検索先は同じ）
 */
export const KONKATSUCAFE_SHOP = {
  name: 'シアワセニナリタイカフェ',
  address: '静岡県浜松市中央区海老塚町1-5ルミシアⅡ2階',
  access: '浜松駅から西に徒歩5分',
  hours: '10:00〜19:00（Lo .18:00）',
  closed: '火曜日（祝日は営業）',
  tel: '053-488-6450',
  mapUrl:
    'https://www.google.com/maps?q=%E9%9D%99%E5%B2%A1%E7%9C%8C%E6%B5%9C%E6%9D%BE%E5%B8%82%E4%B8%AD%E5%A4%AE%E5%8C%BA%E6%B5%B7%E8%80%81%E5%A1%9A%E7%94%BA1-5',
} as const;

const ACCENT = '#c94f5a';
const INK = '#4a3c40';
const MUTED = '#8d7b80';
const PALE = '#fff7f6';

/** LINE の上限（Messaging API）。バブル 1 つの JSON は 30KB まで、altText は 1500 文字まで */
export const FLEX_BUBBLE_MAX_BYTES = 30_000;
export const ALT_TEXT_MAX = 1500;
const BUTTON_LABEL_MAX = 20;

export interface KonkatsucafeCardInput {
  startsAtJst: string; // 例: "2026-10-03 14:00"
  demo: boolean;
  /** お名前（姓 名）。無ければ行を出さない */
  name?: string;
  /** 来店人数（例: "1名"）。無ければ行を出さない */
  visitCount?: string;
  /** 予約履歴を開く LIFF の URL。無ければボタンを出さない（押しても開かないボタンを出さない） */
  historyUrl?: string | null;
  /** 画像の置き場（konkatsucafeImageBase の値）。無ければ写真・アイコンなしで組む */
  imageBase?: string | null;
}

type Node = Record<string, unknown>;

/** LIFF ID から予約履歴の URL（リッチメニューの「予約の確認」と同じ行き先）を作る */
export function konkatsucafeHistoryUrl(liffId: string | null | undefined): string | null {
  if (!liffId || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(liffId)) return null;
  return `https://liff.line.me/${liffId}?liffId=${liffId}&page=salon-book&view=history`;
}

/** intake_json からカードに載せる値だけを取り出す（電話番号などは読まない） */
export function cardValuesOf(intakeJson: string | null | undefined): { name?: string; visitCount?: string } {
  if (!intakeJson) return {};
  try {
    const v = (JSON.parse(intakeJson) as { values?: Record<string, unknown> }).values ?? {};
    const s = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
    const name = `${s(v.sei)} ${s(v.mei)}`.trim();
    const visitCount = s(v.visitCount);
    return { name: name || undefined, visitCount: visitCount || undefined };
  } catch {
    return {};
  }
}

const LINE_GRAY = '#e8d9dc';

/** 画像の置き場（デモの R2 を Worker の `/images/:key` で出す）。キーは平らな名前で、差し替えるときは v を上げる */
export const KONKATSUCAFE_IMAGE_KEYS = {
  hero: 'konkatsucafe-notice-hero-v1.jpg',
  pin: 'konkatsucafe-notice-pin-v1.png',
  clock: 'konkatsucafe-notice-clock-v1.png',
  phone: 'konkatsucafe-notice-phone-v1.png',
  person: 'konkatsucafe-notice-person-v1.png',
  people: 'konkatsucafe-notice-people-v1.png',
  calendar: 'konkatsucafe-notice-calendar-v1.png',
} as const;
type ImageKey = keyof typeof KONKATSUCAFE_IMAGE_KEYS;

/** WORKER_URL から画像の URL を作る。https でなければ画像を使わない（カードは画像なしでも情報が欠けない） */
export function konkatsucafeImageBase(workerUrl: string | null | undefined): string | null {
  if (!workerUrl) return null;
  try {
    const u = new URL(workerUrl);
    if (u.protocol !== 'https:') return null;
    return `${u.origin}/images/`;
  } catch {
    return null;
  }
}

function imageUrl(base: string | null | undefined, key: ImageKey): string | null {
  return base ? `${base}${KONKATSUCAFE_IMAGE_KEYS[key]}` : null;
}

/** アイコン（あれば）＋ラベル＋値の 1 行。アイコンは飾りなので、無くても文字は欠けない */
function row(label: string, value: string, icon: string | null = null): Node {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      ...(icon ? [{ type: 'icon', url: icon, size: 'sm' }] : []),
      { type: 'text', text: label, color: MUTED, size: 'sm', flex: 3 },
      { type: 'text', text: value, color: INK, size: 'sm', flex: 6, wrap: true },
    ],
  };
}

function button(label: string, uri: string, primary: boolean): Node {
  return {
    type: 'button',
    style: primary ? 'primary' : 'secondary',
    height: 'sm',
    ...(primary ? { color: ACCENT } : {}),
    action: { type: 'uri', label, uri },
  };
}

const telUri = `tel:${KONKATSUCAFE_SHOP.tel.replace(/-/g, '')}`;

function shopBox(base: string | null | undefined): Node {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    margin: 'lg',
    paddingAll: 'md',
    cornerRadius: 'md',
    backgroundColor: PALE,
    contents: [
      { type: 'text', text: KONKATSUCAFE_SHOP.name, weight: 'bold', size: 'sm', color: ACCENT, wrap: true },
      row('住所', `${KONKATSUCAFE_SHOP.address}（${KONKATSUCAFE_SHOP.access}）`, imageUrl(base, 'pin')),
      row('営業時間', KONKATSUCAFE_SHOP.hours, imageUrl(base, 'clock')),
      row('定休日', KONKATSUCAFE_SHOP.closed, imageUrl(base, 'calendar')),
      row('お電話', KONKATSUCAFE_SHOP.tel, imageUrl(base, 'phone')),
    ],
  };
}

/** 日付のカレンダー風のブロック（月・日・曜日）と時刻。読めない日時は null（1 行の表示に戻す） */
function dateBlock(label: string, startsAtJst: string): Node | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(startsAtJst);
  if (!m) return null;
  const w = '日月火水木金土'[new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getUTCDay()];
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'lg',
    margin: 'lg',
    paddingAll: 'md',
    cornerRadius: 'md',
    backgroundColor: PALE,
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '72px',
        cornerRadius: 'md',
        backgroundColor: ACCENT,
        paddingAll: 'sm',
        contents: [
          { type: 'text', text: `${Number(m[2])}月`, size: 'xs', color: '#ffffff', align: 'center' },
          { type: 'text', text: String(Number(m[3])), size: 'xxl', weight: 'bold', color: '#ffffff', align: 'center' },
          { type: 'text', text: `${w}曜日`, size: 'xs', color: '#ffffff', align: 'center' },
        ],
      },
      {
        type: 'box',
        layout: 'vertical',
        justifyContent: 'center',
        contents: [
          { type: 'text', text: label, size: 'xs', color: MUTED },
          { type: 'text', text: m[4], size: '3xl', weight: 'bold', color: INK },
          { type: 'text', text: `${m[1]}年${Number(m[2])}月${Number(m[3])}日(${w})`, size: 'xs', color: MUTED },
        ],
      },
    ],
  };
}

/** 受付 → お電話で確認 → 確定 の進み具合。done は済んだ段の数（1〜3） */
function stepBar(done: 1 | 2 | 3): Node {
  const dot = (n: number): Node => ({
    type: 'box',
    layout: 'vertical',
    width: '24px',
    height: '24px',
    cornerRadius: '12px',
    justifyContent: 'center',
    backgroundColor: n <= done ? ACCENT : LINE_GRAY,
    contents: [{ type: 'text', text: String(n), size: 'xs', weight: 'bold', color: '#ffffff', align: 'center' }],
  });
  const line = (n: number): Node => ({
    type: 'box',
    layout: 'vertical',
    height: '3px',
    flex: 1,
    backgroundColor: n < done ? ACCENT : LINE_GRAY,
    contents: [],
  });
  const label = (text: string, n: number, align: string): Node => ({
    type: 'text',
    text,
    size: 'xxs',
    flex: 1,
    align,
    color: n <= done ? ACCENT : MUTED,
    weight: n === done ? 'bold' : 'regular',
  });
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'xs',
    margin: 'md',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        alignItems: 'center',
        paddingStart: 'lg',
        paddingEnd: 'lg',
        contents: [dot(1), line(1), dot(2), line(2), dot(3)],
      },
      {
        type: 'box',
        layout: 'horizontal',
        contents: [label('受付', 1, 'start'), label('お電話で確認', 2, 'center'), label('確定', 3, 'end')],
      },
    ],
  };
}

interface CardSpec {
  title: string;
  titleColor: string;
  lead: string;
  whenLabel: string;
  showName: boolean;
  showShop: boolean;
  buttons: ('map' | 'tel' | 'history')[];
  alt: string;
  badge: string;
  steps?: 1 | 3;
}

function specOf(kind: NotificationKind): CardSpec {
  switch (kind) {
    case 'requested':
      return {
        title: 'ご予約を受け付けました',
        titleColor: INK,
        lead: 'お店からお電話でご予約内容を確認のうえ、確定のご連絡をいたします。',
        whenLabel: '来店希望日時',
        showName: true,
        showShop: false,
        buttons: ['history'],
        alt: 'ご予約を受け付けました',
        badge: '受付',
        steps: 1,
      };
    case 'approved':
      return {
        title: 'ご予約が確定しました',
        titleColor: ACCENT,
        lead: `${KONKATSUCAFE_SHOP.name}でお待ちしております。変更・キャンセルはお店に直接ご連絡ください。`,
        whenLabel: '来店日時',
        showName: false,
        showShop: true,
        buttons: ['map', 'tel', 'history'],
        alt: 'ご予約が確定しました',
        badge: '確定',
        steps: 3,
      };
    case 'rejected':
    case 'expired':
      return {
        title: 'ご予約の受付を取り消しました',
        titleColor: INK,
        lead: 'ご不明な点はお店にお問い合わせください。',
        whenLabel: '来店希望日時',
        showName: false,
        showShop: false,
        buttons: ['tel', 'history'],
        alt: 'ご予約の受付を取り消しました',
        badge: '取り消し',
      };
    case 'day_before':
      return {
        title: '明日のご来店をお待ちしております',
        titleColor: ACCENT,
        lead: '変更・キャンセルはお店に直接ご連絡ください。',
        whenLabel: '来店日時',
        showName: false,
        showShop: true,
        buttons: ['map', 'tel', 'history'],
        alt: '明日のご来店をお待ちしております',
        badge: '明日',
      };
    case 'hours_before':
      return {
        title: '本日のご来店をお待ちしております',
        titleColor: ACCENT,
        lead: '変更・キャンセルはお店に直接ご連絡ください。',
        whenLabel: '来店日時',
        showName: false,
        showShop: true,
        buttons: ['map', 'tel', 'history'],
        alt: '本日のご来店をお待ちしております',
        badge: '本日',
      };
  }
}

/**
 * 控えのカードを組む。組めない・上限を超える・知らない種類のときは null（呼び出し側がテキストで送る）
 */
export function buildKonkatsucafeFlex(
  kind: NotificationKind,
  input: KonkatsucafeCardInput,
): { type: 'flex'; altText: string; contents: Node } | null {
  try {
    const spec = specOf(kind);
    if (!spec) return null;
    const when = formatVisitJst(input.startsAtJst);
    if (!when) return null;

    const base = input.imageBase ?? null;
    const block = dateBlock(spec.whenLabel, input.startsAtJst);
    const rows: Node[] = block ? [] : [row(spec.whenLabel, when)];
    if (spec.showName && input.name) rows.push(row('お名前', `${input.name} 様`, imageUrl(base, 'person')));
    if (input.visitCount) rows.push(row('人数', input.visitCount, imageUrl(base, 'people')));

    const badge: Node = {
      type: 'box',
      layout: 'vertical',
      backgroundColor: ACCENT,
      cornerRadius: '20px',
      paddingTop: 'xs',
      paddingBottom: 'xs',
      paddingStart: 'md',
      paddingEnd: 'md',
      contents: [{ type: 'text', text: spec.badge, size: 'xs', weight: 'bold', color: '#ffffff' }],
    };
    const heroUrl = imageUrl(base, 'hero');

    const body: Node[] = [
      // 写真が無いときは、見出しの上に札を置く（写真があるときは写真の上に重ねる）
      ...(heroUrl ? [] : [{ type: 'box', layout: 'horizontal', contents: [badge, { type: 'filler' }] }]),
      { type: 'text', text: spec.title, weight: 'bold', size: 'lg', color: spec.titleColor, wrap: true },
      ...(spec.steps ? [stepBar(spec.steps)] : []),
      ...(block ? [block] : []),
      ...(rows.length > 0
        ? [{ type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg', contents: rows }]
        : []),
      { type: 'text', text: spec.lead, size: 'sm', color: INK, wrap: true, margin: 'lg' },
    ];
    if (spec.showShop) body.push(shopBox(base));
    if (input.demo) {
      body.push({ type: 'text', text: DEMO_NOTICE, size: 'xs', color: MUTED, wrap: true, margin: 'lg' });
    }

    const footer: Node[] = [];
    for (const b of spec.buttons) {
      if (b === 'map') footer.push(button('地図を開く', KONKATSUCAFE_SHOP.mapUrl, true));
      if (b === 'tel') footer.push(button('お店に電話する', telUri, footer.length === 0));
      if (b === 'history' && input.historyUrl) {
        footer.push(button('予約内容を見る', input.historyUrl, footer.length === 0));
      }
    }

    const contents: Node = {
      type: 'bubble',
      size: 'mega',
      ...(heroUrl
        ? {
            hero: {
              type: 'box',
              layout: 'vertical',
              paddingAll: '0px',
              contents: [
                { type: 'image', url: heroUrl, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' },
                { type: 'box', layout: 'horizontal', position: 'absolute', offsetTop: '12px', offsetStart: '12px', contents: [badge] },
              ],
            },
          }
        : {}),
      body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'xl', contents: body },
      ...(footer.length > 0
        ? { footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } }
        : {}),
      styles: { footer: { separator: false } },
    };

    // altText は通知に出る 1 行。通知だけで予定が分かるように日時を入れる
    const altText = `${spec.alt}（${when}）`;
    if (altText.length > ALT_TEXT_MAX) return null;
    for (const b of footer) {
      const label = (b.action as { label: string }).label;
      if ([...label].length > BUTTON_LABEL_MAX) return null;
    }
    if (new TextEncoder().encode(JSON.stringify(contents)).length > FLEX_BUBBLE_MAX_BYTES) return null;

    return { type: 'flex', altText, contents };
  } catch {
    return null;
  }
}
