import { describe, expect, it } from 'vitest';
import { attributionFromSearch, linkRequestWithAttribution } from './ad-attribution.js';
import { cleanAdAttribution, withAdAttribution } from '../lib/ad-attribution.js';

describe('advertising URL/body boundary', () => {
  it('uses valid direct values over LIFF state, but ignores empty/invalid direct values', () => {
    const search =
      '?' +
      new URLSearchParams({
        'liff.state': '/?gclid=inside&fbclid=state&utm_source=state',
        gclid: ' ',
        fbclid: 'bad\nvalue',
        utm_source: 'direct',
      });
    expect(attributionFromSearch(search)).toEqual({ gclid: 'inside', fbclid: 'state', utm_source: 'direct' });
  });
  it('does not import advertising values from absolute state URLs or fragments', () => {
    expect(
      attributionFromSearch(
        '?' + new URLSearchParams({ 'liff.state': 'https://bad.example/?gclid=bad#utm_source=bad' }),
      ),
    ).toEqual({});
  });
  it('bounds accepted strings, rejects non-string/control inputs and accepts Unicode campaign text', () => {
    expect(
      cleanAdAttribution({
        gclid: 'g'.repeat(2049),
        fbclid: 'f'.repeat(2048),
        utm_source: 'x'.repeat(513),
        utm_medium: [],
        utm_term: 7,
        utm_campaign: '  婚活 / A  ',
        utm_content: 'bad\u0000',
        account: 'b',
      }),
    ).toEqual({ fbclid: 'f'.repeat(2048), utm_campaign: '婚活 / A' });
    expect(cleanAdAttribution(['bad'])).toEqual({});
  });
  it('preserves stored destination fields on empty/invalid input and never accepts reserved routing keys', () => {
    const dest = 'https://example.test/path?gclid=saved&account=a&ref=route&redirect=%2Fnext#part';
    const result = new URL(
      withAdAttribution(
        dest,
        cleanAdAttribution({ gclid: ' ', utm_source: 'meta', account: 'b', ref: 'bad', redirect: 'bad' }),
      ),
    );
    expect(result.searchParams.get('gclid')).toBe('saved');
    expect(result.searchParams.get('account')).toBe('a');
    expect(result.searchParams.get('ref')).toBe('route');
    expect(result.searchParams.get('redirect')).toBe('/next');
    expect(result.hash).toBe('#part');
  });
  it('uses captured pre-init values after SDK URL rewrite and preserves the token/body without trusting a supplied attribution object', () => {
    const result = linkRequestWithAttribution(
      {
        method: 'POST',
        body: JSON.stringify({ idToken: 'synthetic', ref: 'route', attribution: { gclid: 'caller-injected' } }),
      },
      { gclid: 'initial' },
      '?utm_source=current',
    );
    expect(JSON.parse(String(result?.body))).toEqual({
      idToken: 'synthetic',
      ref: 'route',
      attribution: { gclid: 'initial', utm_source: 'current' },
    });
  });
});
