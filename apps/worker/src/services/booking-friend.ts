// konkatsucafe fork: LIFF 予約の送信者が friends に無いときの登録。
//
// L Harness より前から友だちだった人は follow イベントが届いておらず、friends に
// 行が無い。そのままでは POST /api/liff/booking/requests が friend_not_found で
// 断ってしまう。未認証の公式アカウントでは followers API で一括取込もできない。
//
// そこで予約の送信時に限り、次の 2 つが揃ったときだけ friends に登録する:
//   1. 本人: LIFF の IDトークンを LINE で検証済み（呼び出し元が保証する）
//   2. 友だち: そのアカウントのトークンで LINE のプロフィール照会が 200 を返す
//      （プロフィール照会は、そのアカウントを友だち追加している人にしか 200 を返さない）
// Webhook が既存の友だちをプロフィール照会で登録する ensureFriendFromWebhookUser と
// 同じ考え方。違いは、別アカウントに同じ LINE ユーザーの行があるとき、その行を
// 動かさずに断ること（予約の経路からアカウントの付け替えは起こさない）。
//
// フォローの時刻は分からないので first_followed_at などは入れない（計測の時刻を偽らない）。

import { LineApiError, LineClient } from '@line-crm/line-sdk';

export type ExistingFollowerResult =
  | { registered: true; friendId: string }
  | { registered: false; reason: 'row_exists_elsewhere' | 'account_unavailable' | 'not_friend' | 'lookup_failed' };

export async function registerExistingFollowerForBooking(
  db: D1Database,
  input: { lineUserId: string; accountId: string },
): Promise<ExistingFollowerResult> {
  // 同じ LINE ユーザーの行がどこかにあれば触らない（呼び出し元の account 絞込で
  // 見つからなかった = 別アカウントの行か、アカウント未割当の旧データ）。
  const anyRow = await db
    .prepare('SELECT id FROM friends WHERE line_user_id = ?')
    .bind(input.lineUserId)
    .first<{ id: string }>();
  if (anyRow) return { registered: false, reason: 'row_exists_elsewhere' };

  const account = await db
    .prepare('SELECT channel_access_token FROM line_accounts WHERE id = ? AND is_active = 1')
    .bind(input.accountId)
    .first<{ channel_access_token: string | null }>();
  if (!account?.channel_access_token) return { registered: false, reason: 'account_unavailable' };

  let profile: { displayName?: string; pictureUrl?: string; statusMessage?: string };
  try {
    profile = await new LineClient(account.channel_access_token).getProfile(input.lineUserId);
  } catch (error) {
    if (error instanceof LineApiError && error.status === 404) {
      return { registered: false, reason: 'not_friend' };
    }
    // 一時的な失敗でも登録はしない（友だちであることを確かめられていない）。
    console.error('[booking-friend] profile lookup failed', error instanceof LineApiError ? error.status : 'error');
    return { registered: false, reason: 'lookup_failed' };
  }

  const friendId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO friends
         (id, line_user_id, display_name, picture_url, status_message, is_following, line_account_id)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(line_user_id) DO NOTHING`,
    )
    .bind(
      friendId,
      input.lineUserId,
      profile.displayName ?? null,
      profile.pictureUrl ?? null,
      profile.statusMessage ?? null,
      input.accountId,
    )
    .run();

  // 同時に Webhook 等が同じ人を入れた場合は、その行が同じアカウントのときだけ使う。
  const row = await db
    .prepare('SELECT id FROM friends WHERE line_user_id = ? AND line_account_id = ?')
    .bind(input.lineUserId, input.accountId)
    .first<{ id: string }>();
  if (!row) return { registered: false, reason: 'row_exists_elsewhere' };
  console.log(`[booking-friend] registered existing follower friendId=${row.id}`);
  return { registered: true, friendId: row.id };
}
