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
