import { cleanAdAttribution, readLiffAdAttribution, readLiffTrackedLinkMarker, type AdAttribution } from '../lib/ad-attribution.js';

export function attributionFromSearch(search: string): AdAttribution {
  const params = new URLSearchParams(search);
  return readLiffAdAttribution((key) => params.get(key) ?? undefined);
}

/** Capture the initial LIFF state before SDK init can rewrite the URL. */
export function linkRequestWithAttribution(
  options: RequestInit | undefined,
  initial: AdAttribution,
  currentSearch: string,
): RequestInit | undefined {
  if (typeof options?.body !== 'string') return options;
  const body: unknown = JSON.parse(options.body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return options;
  return {
    ...options,
    body: JSON.stringify({
      ...body,
      attribution: cleanAdAttribution({ ...initial, ...attributionFromSearch(currentSearch) }),
    }),
  };
}

/** konkatsucafe fork (L-06 s2): 開いた URL（liff.state を含む）から計測リンクの印を読む。 */
export function trackedLinkFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  return readLiffTrackedLinkMarker((key) => params.get(key) ?? undefined);
}
