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

function row(label: string, value: string): Node {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
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

function shopBox(): Node {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    margin: 'lg',
    contents: [
      { type: 'text', text: KONKATSUCAFE_SHOP.name, weight: 'bold', size: 'sm', color: INK, wrap: true },
      row('住所', `${KONKATSUCAFE_SHOP.address}（${KONKATSUCAFE_SHOP.access}）`),
      row('営業時間', KONKATSUCAFE_SHOP.hours),
      row('定休日', KONKATSUCAFE_SHOP.closed),
      row('お電話', KONKATSUCAFE_SHOP.tel),
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

    const rows: Node[] = [row(spec.whenLabel, when)];
    if (spec.showName && input.name) rows.push(row('お名前', `${input.name} 様`));
    if (input.visitCount) rows.push(row('人数', input.visitCount));

    const body: Node[] = [
      { type: 'text', text: spec.lead, size: 'sm', color: INK, wrap: true },
      { type: 'separator', margin: 'md' },
      { type: 'box', layout: 'vertical', spacing: 'sm', margin: 'md', contents: rows },
    ];
    if (spec.showShop) {
      body.push({ type: 'separator', margin: 'lg' }, shopBox());
    }
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
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: PALE,
        paddingAll: 'lg',
        contents: [{ type: 'text', text: spec.title, weight: 'bold', size: 'lg', color: spec.titleColor, wrap: true }],
      },
      body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg', contents: body },
      ...(footer.length > 0
        ? { footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } }
        : {}),
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
