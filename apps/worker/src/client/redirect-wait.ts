// konkatsucafe fork (L-06): LIFF が /api/liff/link の応答をどれだけ待ってから戻り先へ移るか。
//
// 戻り先が計測リンク（/t/…）のときは、戻った /t が lu から friends の行を引いてクリックを
// その人に結び付ける。L Harness より前からの友だちは /api/liff/link の中で登録されるので
// （IDトークンの確認・プロフィール照会・書き込み）、0.5 秒では行ができる前に /t へ戻ることがある。
// 計測リンクのときだけ最長 3 秒待つ。それ以外の戻り先は従来どおり 0.5 秒。

export const LINK_WAIT_MS = 500;
export const TRACKED_LINK_WAIT_MS = 3000;

/** 戻り先が計測リンクか（main.ts の lu を付ける判定と同じ）。 */
export function isTrackedLinkRedirect(redirectUrl: string): boolean {
  return redirectUrl.includes('/t/');
}

export function linkWaitBeforeRedirectMs(redirectUrl: string): number {
  return isTrackedLinkRedirect(redirectUrl) ? TRACKED_LINK_WAIT_MS : LINK_WAIT_MS;
}

/** link の完了か、上の時間のどちらか早いほうで解ける。link の失敗では止まらない。 */
export function waitForLinkBeforeRedirect(
  linkPromise: Promise<unknown>,
  redirectUrl: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  return Promise.race([
    linkPromise.then(
      () => undefined,
      () => undefined,
    ),
    sleep(linkWaitBeforeRedirectMs(redirectUrl)),
  ]);
}
