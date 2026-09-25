import { useState } from 'react';
import { createApi, type IntakeDraft, type MenuItem, type StaffItem } from '../lib/api.js';
import { useSalonContext } from '../lib/context.js';
import { jstStartsAtIso, formatJp } from '../lib/datetime.js';

export default function Confirm({
  menu,
  staff,
  slot,
  intake,
  stepLabel = 'step 4 / 4',
  onSubmitted,
  onBack,
}: {
  menu: MenuItem;
  staff: StaffItem;
  slot: { date: string; start: string };
  /** konkatsucafe fork (L-08): お客様情報。あるときは一緒に送り、「ご要望」欄は出さない */
  intake?: IntakeDraft;
  stepLabel?: string;
  onSubmitted: () => void;
  onBack: () => void;
}) {
  const ctx = useSalonContext();
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idemKey] = useState(() => crypto.randomUUID());

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await createApi(ctx).createRequest(
        {
          menu_id: menu.id,
          staff_id: staff.id,
          starts_at: jstStartsAtIso(slot.date, slot.start),
          customer_note: intake ? undefined : note || undefined,
          intake,
        },
        idemKey,
      );
      onSubmitted();
    } catch (e) {
      const err = e as { status?: number; body?: { error?: string } };
      if (err.status === 409 && err.body?.error === 'slot_conflict') {
        setError('この時間枠は他の方の予約と重なりました。日時を選び直してください。');
      } else if (err.status === 422 && err.body?.error === 'invalid_intake') {
        // /yoyaku/ の受け口と同じ案内
        setError('ご入力内容を確認できませんでした。お手数ですが、入力内容をお確かめのうえ、もう一度お試しください。');
      } else {
        setError('予約リクエストの送信に失敗しました。時間をおいて再度お試しください。');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4 sb-slide-up">
      <button onClick={onBack} className="sb-back-btn">
        <span aria-hidden>←</span>
        戻る
      </button>
      <div>
        <h1 className="text-base font-bold text-gray-900">内容のご確認</h1>
        <p className="text-xs text-gray-500 mt-1">{stepLabel}</p>
      </div>
      <div className="sb-card">
        <dl className="space-y-3 text-sm">
          <Row label="メニュー" value={menu.name} />
          <Row label="担当" value={staff.display_name} />
          <Row label="日時" value={`${formatJp(slot.date)} ${slot.start}`} />
          <Row label="所要" value={`${staff.duration_minutes} 分`} />
          <Row
            label="料金"
            value={`¥${staff.price.toLocaleString()}`}
            valueClassName="font-bold text-base sb-line-green-text"
          />
        </dl>
      </div>
      {intake && (
        <div className="sb-card">
          <p className="text-xs font-medium text-gray-500 mb-3">お客様情報</p>
          <dl className="space-y-3 text-sm">
            <Row label="お名前" value={`${intake.sei} ${intake.mei}`} />
            <Row label="性別" value={intake.gender} />
            <Row label="年齢" value={intake.age} />
            <Row label="電話番号" value={intake.tel} />
            <Row label="LINE名" value={intake.lineName || '（未入力）'} />
            <Row label="来店人数" value={intake.visitCount} />
            <Row label="ご利用条件" value={intake.agreeTerms ? '確認済み' : ''} />
            <Row label="婚活の経験" value={intake.experience.join('、')} />
            <Row label="ご相談内容" value={intake.message.trim() || '（未入力）'} />
          </dl>
        </div>
      )}
      {!intake && (
      <label className="block">
        <span className="text-xs font-medium text-gray-600 mb-1 block">ご要望（任意）</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y bg-white"
          rows={3}
          placeholder="髪型の希望、アレルギー、その他"
        />
      </label>
      )}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
          {error}
        </div>
      )}
      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full text-white py-3.5 rounded-xl font-bold disabled:opacity-50"
        style={{ background: '#06C755', boxShadow: '0 1px 3px rgba(6, 199, 85, 0.3)' }}
      >
        {submitting ? '送信中…' : '予約をリクエスト'}
      </button>
      <p className="text-xs text-gray-400 text-center">
        確定すると LINE に通知が届きます
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex justify-between items-center pb-3 border-b border-gray-100 last:border-b-0 last:pb-0">
      <dt className="text-gray-500 text-xs shrink-0 mr-3">{label}</dt>
      <dd className={`text-gray-900 text-right break-words whitespace-pre-wrap min-w-0 ${valueClassName ?? ''}`}>{value}</dd>
    </div>
  );
}
