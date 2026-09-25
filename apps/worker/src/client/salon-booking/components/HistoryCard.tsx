import type { BookingHistoryItem } from '../lib/api.js';
import { utcToJstDisplay } from '../lib/datetime.js';

const STATUS_LABEL: Record<string, { label: string; bg: string; fg: string }> = {
  requested: { label: 'リクエスト中', bg: '#fef3c7', fg: '#92400e' },
  confirmed: { label: '確定', bg: '#d1fae5', fg: '#065f46' },
  rejected: { label: '不可', bg: '#f3f4f6', fg: '#6b7280' },
  expired: { label: '期限切れ', bg: '#f3f4f6', fg: '#6b7280' },
  cancelled: { label: 'キャンセル', bg: '#f3f4f6', fg: '#6b7280' },
  completed: { label: '完了', bg: '#dbeafe', fg: '#1e40af' },
  no_show: { label: '無断', bg: '#fee2e2', fg: '#991b1b' },
};

// konkatsucafe fork (L-08): 店舗が電話で確かめてから確定する流れの呼び方
const KONKATSUCAFE_LABEL: Record<string, string> = {
  requested: '受付済み',
  rejected: '取り消し',
  expired: '取り消し',
};

export default function HistoryCard({ booking }: { booking: BookingHistoryItem }) {
  const meta = STATUS_LABEL[booking.status] ?? { label: booking.status, bg: '#f3f4f6', fg: '#6b7280' };
  if (booking.konkatsucafe) {
    // メニュー・担当は見せない。来店希望日時と状態だけ
    const label = KONKATSUCAFE_LABEL[booking.status] ?? meta.label;
    return (
      <li className="sb-card flex gap-3 items-start">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-gray-900">ご来店のご予約</div>
          <div className="text-xs text-gray-600 mt-1 tabular-nums">{utcToJstDisplay(booking.starts_at)}</div>
          {booking.status === 'requested' && (
            <div className="text-xs text-gray-500 mt-1">お店からお電話で確認のうえ、確定のご連絡をいたします</div>
          )}
        </div>
        <span className="sb-badge shrink-0" style={{ background: meta.bg, color: meta.fg }}>
          {label}
        </span>
      </li>
    );
  }
  return (
    <li className="sb-card flex gap-3 items-start">
      {booking.profile_image_url ? (
        <img
          src={booking.profile_image_url}
          alt={booking.staff_name}
          className="w-11 h-11 rounded-full object-cover shrink-0"
        />
      ) : (
        <div className="w-11 h-11 rounded-full bg-gray-200 shrink-0 flex items-center justify-center text-gray-400 text-sm">
          {booking.staff_name.slice(0, 1)}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-gray-900 truncate">{booking.menu_name}</div>
        <div className="text-xs text-gray-500 mt-0.5">{booking.staff_name}</div>
        <div className="text-xs text-gray-600 mt-1 tabular-nums">{utcToJstDisplay(booking.starts_at)}</div>
      </div>
      <span className="sb-badge shrink-0" style={{ background: meta.bg, color: meta.fg }}>
        {meta.label}
      </span>
    </li>
  );
}
