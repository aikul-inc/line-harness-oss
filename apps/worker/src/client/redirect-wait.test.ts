import { describe, expect, it } from 'vitest';
import {
  LINK_WAIT_MS,
  TRACKED_LINK_WAIT_MS,
  isTrackedLinkRedirect,
  linkWaitBeforeRedirectMs,
  waitForLinkBeforeRedirect,
  redirectAfterIdentificationFailure,
} from './redirect-wait.js';

// konkatsucafe fork (L-06): 計測リンクへ戻る前だけ、前からの友だちの登録を最長 3 秒待つ。
describe('wait for /api/liff/link before leaving LIFF', () => {
  it('waits up to 3 s only when going back to a tracked link', () => {
    expect(TRACKED_LINK_WAIT_MS).toBe(3000);
    expect(LINK_WAIT_MS).toBe(500);
    expect(linkWaitBeforeRedirectMs('https://w.example/t/Ab3xY9k?utm_source=line_demo')).toBe(3000);
    expect(isTrackedLinkRedirect('https://w.example/t/Ab3xY9k')).toBe(true);
    expect(linkWaitBeforeRedirectMs('https://lp.example/campaign')).toBe(500);
    expect(isTrackedLinkRedirect('https://lp.example/campaign')).toBe(false);
  });

  it('resolves as soon as the link call finishes, well before the cap', async () => {
    const slept: number[] = [];
    let release!: () => void;
    const link = new Promise<void>((r) => (release = r));
    const never = (ms: number) => {
      slept.push(ms);
      return new Promise<void>(() => {});
    };
    const done = waitForLinkBeforeRedirect(link, 'https://w.example/t/abc', never);
    release();
    await expect(done).resolves.toBeUndefined();
    expect(slept).toEqual([3000]);
  });

  it('gives up at the cap when the link call hangs, and a failed link call does not block', async () => {
    const hang = new Promise<void>(() => {});
    await expect(waitForLinkBeforeRedirect(hang, 'https://w.example/t/abc', async () => {})).resolves.toBeUndefined();
    await expect(
      waitForLinkBeforeRedirect(Promise.reject(new Error('network')), 'https://w.example/t/abc', () => new Promise(() => {})),
    ).resolves.toBeUndefined();
  });
});

describe('L-06 s2: identification failure goes back to /t once, without looping', () => {
  it('marks tracked-link redirects with lh_noid=1 exactly once and leaves others alone', () => {
    expect(redirectAfterIdentificationFailure('https://w.example/t/abc?utm_source=x')).toBe('https://w.example/t/abc?utm_source=x&lh_noid=1');
    expect(redirectAfterIdentificationFailure('https://w.example/t/abc')).toBe('https://w.example/t/abc?lh_noid=1');
    expect(redirectAfterIdentificationFailure('https://w.example/t/abc?lh_noid=1')).toBe('https://w.example/t/abc?lh_noid=1');
    expect(redirectAfterIdentificationFailure('https://lp.example/x')).toBe('https://lp.example/x');
  });
});
