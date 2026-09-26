import { cleanAdAttribution, readLiffAdAttribution, type AdAttribution } from '../lib/ad-attribution.js';

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
