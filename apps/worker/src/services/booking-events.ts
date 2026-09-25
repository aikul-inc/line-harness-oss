// konkatsucafe fork (L-09): 予約が入ったときに `calendar_booked` を発火する。
//
// 上流では `calendar_booked` は型と管理画面の選択肢にあるだけで、どこからも発火していない。
// 予約者が LIFF から予約を入れた時点（受付 requested）で 1 回だけ流す。確定・却下・代理作成では流さない
// （同じ予約のメール・シートが 2 回入らないように。仕様は konkatsucafe-line の
// docs/spec/2026-09-25-l09-l10-booking-mail-sheet.md）。
//
// LINE の鍵は渡さない。`calendar_booked` に「メッセージを送る」自動化を仕掛けても送れずに失敗として
// 記録されるだけにして、予約 1 件 3 通（控え）の上限を自動化で超えさせない。
import { fireEvent } from './event-bus.js';
import type { StoredIntake } from './booking-intake-fields.js';

export const CALENDAR_BOOKED = 'calendar_booked';

export interface CalendarBookedParams {
  bookingId: string;
  friendId: string;
  lineAccountId: string;
  menuId: string;
  staffId: string;
  /** UTC ISO8601 */
  startsAt: string;
  /** UTC ISO8601。bookings.requested_at と同じ値 */
  requestedAt: string;
  /** bookings.intake_json の文字列。お客様情報を聞かない流れでは null */
  intakeJson: string | null;
}

/** 出来事の中身。`send_webhook` はこれに friendId を足して POST する */
export function calendarBookedEventData(p: CalendarBookedParams): Record<string, unknown> {
  return {
    event: CALENDAR_BOOKED,
    bookingId: p.bookingId,
    status: 'requested',
    startsAt: p.startsAt,
    requestedAt: p.requestedAt,
    menuId: p.menuId,
    staffId: p.staffId,
    source: 'liff',
    intake: p.intakeJson === null ? null : (JSON.parse(p.intakeJson) as StoredIntake),
  };
}

/** 失敗しても投げない（予約の成否を左右しない） */
export async function fireCalendarBooked(db: D1Database, p: CalendarBookedParams): Promise<void> {
  try {
    await fireEvent(
      db,
      CALENDAR_BOOKED,
      { friendId: p.friendId, eventData: calendarBookedEventData(p) },
      undefined,
      p.lineAccountId,
    );
  } catch (err) {
    console.error(
      `[booking] calendar_booked failed booking=${p.bookingId}:`,
      err instanceof Error ? err.message : 'unknown',
    );
  }
}
