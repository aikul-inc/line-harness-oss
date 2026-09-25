// konkatsucafe fork (L-08): 日時 → お客様情報 → 確認 の予約画面。
//
// - メニュー・担当は選ばせない（受け口が割り当てる。画面にも名前を出さない）
// - 日時は /yoyaku/ と同じ選び方: 来店希望日は今日〜2 年後、時間は 10:30〜18:00。
//   定休日も選べる（/yoyaku/ と同じく、営業時間・定休日の文を添えるだけ）。満席・空きなしは出さない
// - 送ると「受付」。店舗が電話で確かめてから確定の連絡がトークに届く
import { useMemo, useState } from 'react';
import IntakeForm, { emptyIntake } from '../components/IntakeForm.js';
import { useSalonContext } from '../lib/context.js';
import { createApi, type IntakeDraft } from '../lib/api.js';
import { formatJp, jstStartsAtIso, jstToday } from '../lib/datetime.js';
import {
  DEMO_NOTICE,
  SHOP_CLOSED,
  SHOP_HOURS,
  VISIT_TIMES,
  visitDateBounds,
} from '../../../services/booking-intake-fields.js';

type Step = 'datetime' | 'intake' | 'confirm' | 'done';

const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'datetime', label: '日時' },
  { key: 'intake', label: 'お客様情報' },
  { key: 'confirm', label: '確認' },
];

const CALLBACK_TEXT = 'お店からお電話でご予約内容を確認のうえ、確定のご連絡をいたします。';

const primaryButton = {
  background: '#06C755',
  boxShadow: '0 1px 3px rgba(6, 199, 85, 0.3)',
} as const;

const inputClass =
  'w-full border border-gray-300 rounded-xl px-3 py-2.5 text-base bg-white focus:outline-none focus:ring-2 focus:ring-green-500';

/** 今の日本時間（HH:MM）。今日を選んだときに、過ぎた時間を選べないようにする */
function jstNowHHMM(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16);
}

export default function KonkatsucafeBooking({ demoNotice }: { demoNotice: boolean }) {
  const ctx = useSalonContext();
  const [step, setStep] = useState<Step>('datetime');
  const [slot, setSlot] = useState<{ date: string; start: string }>({ date: '', start: '' });
  const [intake, setIntake] = useState<IntakeDraft>(() => emptyIntake(ctx.displayName));
  const stepIdx = STEPS.findIndex((s) => s.key === step);

  return (
    <div>
      {step !== 'done' && <Stepper index={stepIdx} />}
      {step === 'datetime' && (
        <VisitDateTime value={slot} onChange={setSlot} onNext={() => setStep('intake')} />
      )}
      {step === 'intake' && (
        <IntakeForm
          slot={slot}
          value={intake}
          onChange={setIntake}
          onNext={() => setStep('confirm')}
          onBack={() => setStep('datetime')}
          stepLabel={`step 2 / ${STEPS.length}`}
        />
      )}
      {step === 'confirm' && (
        <KonkatsucafeConfirm
          slot={slot}
          intake={intake}
          demoNotice={demoNotice}
          onBack={() => setStep('intake')}
          onDatetime={() => setStep('datetime')}
          onSubmitted={() => setStep('done')}
        />
      )}
      {step === 'done' && <KonkatsucafeDone demoNotice={demoNotice} />}
    </div>
  );
}

function Stepper({ index }: { index: number }) {
  return (
    <div
      className="mb-5 px-1"
      style={{ display: 'grid', gridTemplateColumns: `repeat(${STEPS.length}, minmax(0, 1fr))` }}
    >
      {STEPS.map((s, i) => {
        const done = i < index;
        const active = i === index;
        const future = i > index;
        return (
          <div key={s.key} className="relative flex flex-col items-center">
            {i > 0 && (
              <span
                aria-hidden
                className="absolute"
                style={{
                  top: 12,
                  left: '-50%',
                  width: '100%',
                  height: 2,
                  background: i <= index ? '#06C755' : '#e5e7eb',
                  zIndex: 0,
                }}
              />
            )}
            <div
              className="relative flex items-center justify-center"
              style={{
                width: 24,
                height: 24,
                borderRadius: 9999,
                background: future ? '#e5e7eb' : '#06C755',
                color: future ? '#9ca3af' : '#fff',
                fontSize: 11,
                fontWeight: 700,
                zIndex: 1,
                boxShadow: active ? '0 0 0 4px rgba(6, 199, 85, 0.18)' : 'none',
              }}
            >
              {done ? '✓' : i + 1}
            </div>
            <span
              className="mt-1.5 text-[10px] leading-tight"
              style={{ color: active ? '#111827' : '#9ca3af', fontWeight: active ? 700 : 500 }}
            >
              {s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function VisitDateTime({
  value,
  onChange,
  onNext,
}: {
  value: { date: string; start: string };
  onChange: (next: { date: string; start: string }) => void;
  onNext: () => void;
}) {
  // 開いた時点の日本時間の今日から数える（ビルド時に焼き込まない）
  const bounds = useMemo(() => visitDateBounds(new Date()), []);
  const today = jstToday();
  const nowHHMM = jstNowHHMM();
  const [errors, setErrors] = useState<{ date?: string; time?: string }>({});
  const isPast = (t: string) => value.date === today && t < nowHHMM;

  function handleNext() {
    const next: { date?: string; time?: string } = {};
    if (!value.date) next.date = '来店希望日をご入力ください';
    else if (value.date < bounds.min || value.date > bounds.max) {
      next.date = '本日から2年以内の日付をご入力ください';
    }
    if (!value.start) next.time = '来店希望時間をお選びください';
    else if (isPast(value.start)) next.time = '過ぎた時間は選べません。来店希望時間をお選びください';
    setErrors(next);
    if (!next.date && !next.time) onNext();
  }

  return (
    <div className="space-y-4 sb-slide-up">
      <div>
        <h1 className="text-base font-bold text-gray-900">来店希望日時</h1>
        <p className="text-xs text-gray-500 mt-1">step 1 / {STEPS.length}</p>
      </div>
      <div className="sb-card space-y-5">
        <label className="block">
          <span className="block mb-1 text-sm font-medium text-gray-800">
            来店希望日<span className="ml-1 text-xs font-bold text-red-600">必須</span>
          </span>
          <input
            type="date"
            name="visitDate"
            min={bounds.min}
            max={bounds.max}
            value={value.date}
            onChange={(e) => {
              const date = e.target.value;
              // 今日に変えたとき、過ぎた時間が選ばれたままにしない
              const start = date === today && value.start && value.start < nowHHMM ? '' : value.start;
              onChange({ date, start });
              setErrors({});
            }}
            className={inputClass}
          />
          {errors.date && <p className="text-xs text-red-600 mt-1">{errors.date}</p>}
        </label>
        <label className="block">
          <span className="block mb-1 text-sm font-medium text-gray-800">
            来店希望時間<span className="ml-1 text-xs font-bold text-red-600">必須</span>
          </span>
          <select
            name="visitTime"
            value={value.start}
            onChange={(e) => {
              onChange({ ...value, start: e.target.value });
              setErrors({ ...errors, time: undefined });
            }}
            className={inputClass}
          >
            <option value="">選択してください</option>
            {VISIT_TIMES.map((t) => (
              <option key={t} value={t} disabled={isPast(t)}>
                {t}
              </option>
            ))}
          </select>
          {errors.time && <p className="text-xs text-red-600 mt-1">{errors.time}</p>}
        </label>
        <ul className="text-xs text-gray-600 space-y-1" data-testid="sb-shop-hours">
          <li>営業時間　／　{SHOP_HOURS}</li>
          <li>定休日　／　{SHOP_CLOSED}</li>
        </ul>
      </div>
      <p className="text-xs text-gray-500 leading-relaxed">{CALLBACK_TEXT}</p>
      <button onClick={handleNext} className="w-full text-white py-3.5 rounded-xl font-bold" style={primaryButton}>
        次へ
      </button>
    </div>
  );
}

function KonkatsucafeConfirm({
  slot,
  intake,
  demoNotice,
  onBack,
  onDatetime,
  onSubmitted,
}: {
  slot: { date: string; start: string };
  intake: IntakeDraft;
  demoNotice: boolean;
  onBack: () => void;
  onDatetime: () => void;
  onSubmitted: () => void;
}) {
  const ctx = useSalonContext();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ text: string; toDatetime?: boolean } | null>(null);
  const [idemKey] = useState(() => crypto.randomUUID());

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await createApi(ctx).createRequest({ starts_at: jstStartsAtIso(slot.date, slot.start), intake }, idemKey);
      onSubmitted();
    } catch (e) {
      const err = e as { status?: number; body?: { error?: string } };
      const code = err.body?.error;
      if (err.status === 422 && code === 'invalid_intake') {
        // /yoyaku/ の受け口と同じ案内
        setError({
          text: 'ご入力内容を確認できませんでした。お手数ですが、入力内容をお確かめのうえ、もう一度お試しください。',
        });
      } else if (err.status === 422 && (code === 'past_datetime' || code === 'invalid_visit_datetime')) {
        setError({ text: 'ご希望の日時を選び直してください。', toDatetime: true });
      } else {
        setError({ text: '送信できませんでした。時間をおいて、もう一度お試しください。' });
      }
    } finally {
      setSubmitting(false);
    }
  }

  const rows: Array<[string, string]> = [
    ['来店希望日時', `${formatJp(slot.date)} ${slot.start}`],
    ['お名前', `${intake.sei} ${intake.mei}`],
    ['性別', intake.gender],
    ['年齢', intake.age],
    ['電話番号', intake.tel],
    ['LINE名', intake.lineName || '（未入力）'],
    ['来店人数', intake.visitCount],
    ['ご利用条件', intake.agreeTerms ? '確認済み' : ''],
    ['婚活の経験', intake.experience.join('、')],
    ['ご相談内容', intake.message.trim() || '（未入力）'],
  ];

  return (
    <div className="space-y-4 sb-slide-up">
      <button onClick={onBack} className="sb-back-btn">
        <span aria-hidden>←</span>
        戻る
      </button>
      <div>
        <h1 className="text-base font-bold text-gray-900">内容のご確認</h1>
        <p className="text-xs text-gray-500 mt-1">step 3 / {STEPS.length}</p>
      </div>
      <div className="sb-card">
        <dl className="space-y-3 text-sm">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="flex justify-between items-center pb-3 border-b border-gray-100 last:border-b-0 last:pb-0"
            >
              <dt className="text-gray-500 text-xs shrink-0 mr-3">{label}</dt>
              <dd className="text-gray-900 text-right break-words whitespace-pre-wrap min-w-0">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm" role="alert">
          {error.text}
          {error.toDatetime && (
            <button onClick={onDatetime} className="block mt-2 font-semibold underline">
              日時を選び直す
            </button>
          )}
        </div>
      )}
      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full text-white py-3.5 rounded-xl font-bold disabled:opacity-50"
        style={primaryButton}
      >
        {submitting ? '送信中…' : 'この内容で送信する'}
      </button>
      <p className="text-xs text-gray-500 text-center leading-relaxed">
        {CALLBACK_TEXT}
        {demoNotice && (
          <>
            <br />
            {DEMO_NOTICE}
          </>
        )}
      </p>
    </div>
  );
}

function KonkatsucafeDone({ demoNotice }: { demoNotice: boolean }) {
  function gotoHistory() {
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'history');
    window.location.href = url.toString();
  }
  function close() {
    const liffGlobal = (window as unknown as { liff?: { closeWindow?: () => void } }).liff;
    if (liffGlobal?.closeWindow) {
      try {
        liffGlobal.closeWindow();
        return;
      } catch {
        /* fallback */
      }
    }
    window.close();
  }
  return (
    <div className="sb-fade-in pt-8 pb-4">
      <div className="sb-card text-center">
        <div
          className="w-16 h-16 mx-auto rounded-full flex items-center justify-center text-white text-3xl font-bold"
          style={{ background: '#06C755' }}
        >
          ✓
        </div>
        <h1 className="text-lg font-bold text-gray-900 mt-4">ご予約を受け付けました</h1>
        <p className="text-sm text-gray-600 mt-3 leading-relaxed">{CALLBACK_TEXT}</p>
        {demoNotice && <p className="text-xs text-gray-500 mt-2">{DEMO_NOTICE}</p>}
        <div className="grid grid-cols-2 gap-2 mt-6">
          <button
            onClick={gotoHistory}
            className="py-3 rounded-xl font-semibold text-sm border-2 sb-line-green-text"
            style={{ borderColor: '#06C755' }}
          >
            予約の確認
          </button>
          <button onClick={close} className="py-3 rounded-xl font-semibold text-sm text-white" style={primaryButton}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
