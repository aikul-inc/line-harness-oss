import { createLiffQueryReader } from './liff-query.js';
/** Untrusted campaign inputs, never identity or proof of an ad conversion. */
export const AD_KEYS = [
  'gclid',
  'fbclid',
  'twclid',
  'ttclid',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;
export type AdAttribution = Partial<Record<(typeof AD_KEYS)[number], string>>;

export function cleanAdAttribution(input: unknown): AdAttribution {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: AdAttribution = {};
  for (const key of AD_KEYS) {
    const raw = (input as Record<string, unknown>)[key];
    if (typeof raw !== 'string' || /[\x00-\x1f\x7f]/.test(raw)) continue;
    const value = raw.trim();
    if (value && value.length <= (key.startsWith('utm_') ? 512 : 2048)) result[key] = value;
  }
  return result;
}

export function readAdAttribution(read: (key: string) => string | undefined | null): AdAttribution {
  return cleanAdAttribution(Object.fromEntries(AD_KEYS.map((key) => [key, read(key)])));
}

/** Only ad keys cross a tracked-link boundary; never account/ref/redirect/user IDs. */
export function withAdAttribution(destination: string, input: AdAttribution): string {
  if (!Object.keys(input).length) return destination;
  const url = new URL(destination);
  for (const [key, value] of Object.entries(cleanAdAttribution(input))) url.searchParams.set(key, value);
  return url.toString();
}

/** Valid direct values override valid LIFF-state values; invalid/empty direct values do not erase them. */
export function readLiffAdAttribution(read: (key: string) => string | undefined): AdAttribution {
  const state = readAdAttribution(createLiffQueryReader((key) => (key === 'liff.state' ? read(key) : undefined)));
  return { ...state, ...readAdAttribution(read) };
}

/**
 * konkatsucafe fork (L-06 s2): 計測リンクの印。/t が LIFF の飛び先にだけ付け、予約の受け口が
 * 「どの計測リンクから来たか」を友だち情報に残すのに使う。値は短縮コードか UUID の形だけを受ける。
 * 印そのものは未検証の入力で、受け口がそのアカウントの有効な計測リンクと照合してから使う。
 */
export const TRACKED_LINK_KEY = 'lh_link';
const TRACKED_LINK_VALUE = /^[A-Za-z0-9_-]{1,64}$/;

export function cleanTrackedLinkMarker(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  return TRACKED_LINK_VALUE.test(value) ? value : null;
}

/** 直接の値が有効ならそれを、なければ liff.state の中の値を使う（広告値と同じ優先順）。 */
export function readLiffTrackedLinkMarker(read: (key: string) => string | undefined): string | null {
  const direct = cleanTrackedLinkMarker(read(TRACKED_LINK_KEY));
  if (direct) return direct;
  return cleanTrackedLinkMarker(
    createLiffQueryReader((key) => (key === 'liff.state' ? read(key) : undefined))(TRACKED_LINK_KEY),
  );
}

/** LIFF の飛び先（https://liff.line.me/…）にだけ印を付ける。ほかのサイトへは渡さない。 */
export function withTrackedLinkMarker(destination: string, marker: string): string {
  const clean = cleanTrackedLinkMarker(marker);
  if (!clean) return destination;
  const url = new URL(destination);
  if (url.protocol !== 'https:' || url.hostname !== 'liff.line.me') return destination;
  url.searchParams.set(TRACKED_LINK_KEY, clean);
  return url.toString();
}
