// konkatsucafe fork (L-06 s2): 予約の受け口で、予約画面を開いた URL の広告値（utm_* など）と
// 計測リンクの印（lh_link）を友だち情報に残す。
//
// 計測リンクの /t → LIFF → /t?lu= の結び付けは、LINE Login の失敗や LINE の外のブラウザで落ちる
// （2026-09-28 の実機）。予約は IDトークンで本人を確かめているので、ここで埋めれば落ちても計測が残る。
//
// - 本人: 呼び出し元が IDトークンを検証し、そのアカウントの friends の行を渡す（画面の userId は使わない）
// - 広告値: /api/liff/link と同じ方針。有効な空でない値だけを項目ごとに最新で上書きし、ほかの値は消さない
// - 印: そのアカウントの有効な計測リンクと照合できたときだけ tracked_link_id として残す。
//   印があるのに照合できない（別アカウント・無効・存在しない）ときは、広告値も含めて何も書かない（fail-closed）
// - 予約そのものは止めない（書けなくても予約は成立させる）。ログに値は出さない

import { getTrackedLinkByIdOrShortCode } from '@line-crm/db';
import { cleanAdAttribution, cleanTrackedLinkMarker } from '../lib/ad-attribution.js';

export type BookingAttributionResult =
  | { saved: true; keys: string[] }
  | { saved: false; reason: 'nothing' | 'bad_marker' | 'marker_not_found' | 'marker_other_account' | 'error' };

export async function saveBookingAttribution(
  db: D1Database,
  input: { friendId: string; accountId: string; attribution: unknown; trackedLink: unknown },
): Promise<BookingAttributionResult> {
  try {
    const ad = cleanAdAttribution(input.attribution);
    const patch: Record<string, string> = { ...ad };
    if (input.trackedLink !== undefined && input.trackedLink !== null && input.trackedLink !== '') {
      const marker = cleanTrackedLinkMarker(input.trackedLink);
      if (!marker) return { saved: false, reason: 'bad_marker' };
      const link = await getTrackedLinkByIdOrShortCode(db, marker);
      if (!link || !link.is_active) return { saved: false, reason: 'marker_not_found' };
      if (link.line_account_id !== input.accountId) return { saved: false, reason: 'marker_other_account' };
      patch.tracked_link_id = link.id;
    }
    const keys = Object.keys(patch);
    if (keys.length === 0) return { saved: false, reason: 'nothing' };
    await db
      .prepare(
        `UPDATE friends
            SET metadata = json_patch(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, ?),
                updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
          WHERE id = ? AND line_account_id = ?`,
      )
      .bind(JSON.stringify(patch), input.friendId, input.accountId)
      .run();
    return { saved: true, keys };
  } catch (err) {
    console.error('[booking-attribution] save failed:', err instanceof Error ? err.message : 'unknown');
    return { saved: false, reason: 'error' };
  }
}
