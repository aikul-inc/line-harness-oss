import { LineClient } from '@line-crm/line-sdk';
import { DEMO_NOTICE, formatVisitJst } from './booking-intake-fields.js';

export type NotificationKind =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'day_before'
  | 'hours_before';

export interface NotificationContext {
  menuName: string;
  staffName: string;
  startsAtJst: string; // 例: "2026-05-10 14:00"
  hoursBefore: number;
  /**
   * konkatsucafe fork (L-08): お客様情報つきの予約（bookings.intake_json がある）の控え。
   * メニュー・担当は見せず、店舗が電話で確かめてから確定する流れの文面にする
   */
  style?: 'konkatsucafe' | 'konkatsucafe-demo';
}

/** konkatsucafe fork (L-08): bookings の intake_json から控えの書き方を決める（SQL で読んだ値を渡す） */
export function notificationStyleOf(
  intakeJson: string | null | undefined,
): NotificationContext['style'] {
  if (!intakeJson) return undefined;
  try {
    return (JSON.parse(intakeJson) as { demo?: unknown }).demo === true ? 'konkatsucafe-demo' : 'konkatsucafe';
  } catch {
    return 'konkatsucafe';
  }
}

function renderKonkatsucafeText(kind: NotificationKind, ctx: NotificationContext): string {
  const when = formatVisitJst(ctx.startsAtJst);
  const demo = ctx.style === 'konkatsucafe-demo' ? `\n\n${DEMO_NOTICE}` : '';
  switch (kind) {
    case 'requested':
      return `ご予約を受け付けました。\n来店希望日時: ${when}\n\nお店からお電話でご予約内容を確認のうえ、確定のご連絡をいたします。${demo}`;
    case 'approved':
      return `ご予約が確定しました。\n来店日時: ${when}\n\n変更・キャンセルはお店に直接ご連絡ください。${demo}`;
    case 'rejected':
      return `ご予約の受付を取り消しました。\n来店希望日時: ${when}\n\nご不明な点はお店にお問い合わせください。${demo}`;
    case 'expired':
      return `ご予約の受付を取り消しました。\n来店希望日時: ${when}\n\nご不明な点はお店にお問い合わせください。${demo}`;
    case 'day_before':
      return `明日のご来店をお待ちしております。\n来店日時: ${when}${demo}`;
    case 'hours_before':
      return `本日のご来店をお待ちしております。\n来店日時: ${when}${demo}`;
  }
}

export function renderNotificationText(
  kind: NotificationKind,
  ctx: NotificationContext,
): string {
  if (ctx.style) return renderKonkatsucafeText(kind, ctx);
  const detail = `\nメニュー: ${ctx.menuName}\n担当: ${ctx.staffName}\n日時: ${ctx.startsAtJst}`;
  switch (kind) {
    case 'requested':
      return `予約リクエストを受け付けました。${detail}\n\nお店からの返信をお待ちください。`;
    case 'approved':
      return `予約が確定しました。${detail}\n\n変更・キャンセルはお店に直接ご連絡ください。`;
    case 'rejected':
      return `申し訳ありません、ご希望の枠でお取りできませんでした。\n別の日時で再度お試しください。`;
    case 'expired':
      return `予約リクエストが 24 時間返信が無かったため、期限切れになりました。${detail}`;
    case 'day_before':
      return `明日のご予約のお知らせです。${detail}`;
    case 'hours_before':
      return `本日のご予約まであと ${ctx.hoursBefore} 時間です。${detail}`;
  }
}

export interface SendNotificationParams {
  channelAccessToken: string;
  toLineUserId: string;
  kind: NotificationKind;
  ctx: NotificationContext;
}

export async function sendBookingNotification(params: SendNotificationParams): Promise<void> {
  const text = renderNotificationText(params.kind, params.ctx);
  const client = new LineClient(params.channelAccessToken);
  await client.pushMessage(params.toLineUserId, [{ type: 'text', text }]);
}

export type BookingNotificationSender = (params: SendNotificationParams) => Promise<void>;
