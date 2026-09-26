// konkatsucafe fork (L-08): 日時 → お客様情報 → 確認 の予約画面。
//
// - メニュー・担当は選ばせない（受け口が割り当てる。画面にも名前を出さない）
// - 日時は /yoyaku/ と同じ範囲: 来店希望日は今日〜2 年後、時間は 10:30〜18:00。
//   s4: ふつうの火曜は「定休」で押せない。祝日の火曜は「祝」の印で押せる（祝日は内閣府の一覧:
//   services/konkatsucafe-holidays.ts。一覧がまだ無い範囲の火曜は定休）。満席・空きなしは出さない
// - 送ると「受付」。店舗が電話で確かめてから確定の連絡がトークに届く
// - s3: 日付・時間は、L Harness を入れる前の自前の予約画面（konkatsucafe-line の src/pages/liff/）と
//   同じ横スクロールのボタンにした。2 年先まで出すため、月の切り替えを足した（自前は 14 日＋日付欄）。
//   日付は画面を開いた時点で組み立てる（ビルド時に焼き込まない）
import { useEffect, useMemo, useRef, useState } from 'react';
import IntakeForm, { emptyIntake } from '../components/IntakeForm.js';
import {
  BackLink,
  BottomBar,
  Card,
  Hint,
  Label,
  PageTitle,
  PrimaryButton,
  Row,
  applyKonkatsucafeTheme,
} from '../components/kc-ui.js';
import { useSalonContext } from '../lib/context.js';
import { createApi, type IntakeDraft } from '../lib/api.js';
import { formatJp, jstStartsAtIso } from '../lib/datetime.js';
import { HOLIDAY_TUESDAYS, shopDayStatus } from '../../../services/konkatsucafe-holidays.js';
import {
  DEMO_NOTICE,
  SHOP_CLOSED,
  SHOP_HOURS,
  VISIT_TIMES,
  jstDay,
  visitDateBounds,
} from '../../../services/booking-intake-fields.js';

type Step = 'datetime' | 'intake' | 'confirm' | 'done';

const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'datetime', label: '日時' },
  { key: 'intake', label: 'お客様情報' },
  { key: 'confirm', label: '確認' },
];

const CALLBACK_TEXT = 'お店からお電話でご予約内容を確認のうえ、確定のご連絡をいたします。';
const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** 帯の両端に残す余白（px）。カードがこの内側に全部入るように送る（styles.css の .kc-scroll と同じ） */
const EDGE = 16;

/**
 * 帯をなめらかに送る。送っている間は「放すと区切りで止まる」を外し、止まったら戻す
 * （付けたままだと、送り終わりにブラウザが近い区切りへ引き戻し、カードがまた端で切れる）
 */
const scrollGeneration = new WeakMap<HTMLElement, number>();

function smoothScrollStrip(box: HTMLElement, target: number, behavior: ScrollBehavior = 'smooth'): void {
  const left = Math.max(0, Math.min(target, box.scrollWidth - box.clientWidth));
  // 新しく送り始めたら、前の送りの見張りは止める（続けて押したときに古い行き先へ戻さない）
  const gen = (scrollGeneration.get(box) ?? 0) + 1;
  scrollGeneration.set(box, gen);
  if (behavior !== 'smooth') {
    box.scrollLeft = left;
    return;
  }
  box.style.scrollSnapType = 'none';
  box.scrollTo({ left, behavior: 'smooth' });
  const started = Date.now();
  let last = -1;
  let still = 0;
  const watch = () => {
    if (scrollGeneration.get(box) !== gen) return;
    const now = box.scrollLeft;
    still = Math.abs(now - last) < 0.5 ? still + 1 : 0;
    last = now;
    if ((still >= 4 && Math.abs(now - left) < 2) || Date.now() - started > 1500) {
      if (Math.abs(box.scrollLeft - left) >= 2) box.scrollLeft = left;
      box.style.scrollSnapType = '';
      return;
    }
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

/**
 * 帯の中のカードが全部見えるように送る。すでに全部見えていれば動かさない。
 * 行き先は区切り（各カードの左端 − 余白）にそろえる。帯（.kc-scroll）は position: relative なので、
 * offsetLeft は帯の中の位置
 */
function revealInStrip(box: HTMLElement, el: HTMLElement, behavior: ScrollBehavior = 'smooth'): number | null {
  const left = el.offsetLeft - EDGE;
  const right = el.offsetLeft + el.offsetWidth + EDGE - box.clientWidth;
  let target: number | null = null;
  if (box.scrollLeft > left + 0.5) target = left;
  else if (box.scrollLeft < right - 0.5) {
    // 右で切れているとき: そのカードが右端に入る最初の区切りまで送る
    target = right;
    for (const c of Array.from(box.children) as HTMLElement[]) {
      const snap = c.offsetLeft - EDGE;
      if (snap >= right - 0.5) {
        target = snap;
        break;
      }
    }
  }
  if (target === null) return null;
  smoothScrollStrip(box, target, behavior);
  return target;
}

/** 今の日本時間（HH:MM）。今日を選んだときに、過ぎた時間を選べないようにする */
function jstNowHHMM(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16);
}

export default function KonkatsucafeBooking({ demoNotice }: { demoNotice: boolean }) {
  const ctx = useSalonContext();
  useEffect(() => applyKonkatsucafeTheme(), []);
  const [step, setStep] = useState<Step>('datetime');
  const [slot, setSlot] = useState<{ date: string; start: string }>({ date: '', start: '' });
  const [intake, setIntake] = useState<IntakeDraft>(() => emptyIntake(ctx.displayName));
  const stepIdx = STEPS.findIndex((s) => s.key === step);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [step]);

  return (
    <div>
      {step !== 'done' && <Stepper index={stepIdx} />}
      {step === 'datetime' && <VisitDateTime value={slot} onChange={setSlot} onNext={() => setStep('intake')} />}
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
    <div className="mb-4 px-1" style={{ display: 'grid', gridTemplateColumns: `repeat(${STEPS.length}, minmax(0, 1fr))` }}>
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
                style={{ top: 11, left: '-50%', width: '100%', height: 2, background: i <= index ? '#c94f5a' : '#e0e0e0', zIndex: 0 }}
              />
            )}
            <div
              className="relative flex items-center justify-center"
              style={{
                width: 22,
                height: 22,
                borderRadius: 9999,
                background: future ? '#e0e0e0' : '#c94f5a',
                color: future ? '#999' : '#fff',
                fontSize: 11,
                fontWeight: 700,
                zIndex: 1,
              }}
            >
              {done ? '✓' : i + 1}
            </div>
            <span className="mt-1 text-[11px] leading-tight" style={{ color: active ? '#111' : '#999', fontWeight: active ? 700 : 500 }}>
              {s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** `YYYY-MM` の一覧（下限の月〜上限の月） */
function monthsBetween(min: string, max: string): string[] {
  const out: string[] = [];
  let y = Number(min.slice(0, 4));
  let m = Number(min.slice(5, 7));
  const endKey = max.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(key);
    if (key >= endKey) break;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** 下限〜上限のすべての日（1 本の帯に並べる。約 2 年で 731 日） */
function allDays(min: string, max: string): Array<{ value: string; w: number; d: number; m: number }> {
  const out: Array<{ value: string; w: number; d: number; m: number }> = [];
  for (let t = new Date(`${min}T00:00:00Z`).getTime(); ; t += 86400_000) {
    const date = new Date(t);
    const value = date.toISOString().slice(0, 10);
    if (value > max) break;
    out.push({ value, w: date.getUTCDay(), d: date.getUTCDate(), m: date.getUTCMonth() + 1 });
  }
  return out;
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
  // 開いた時点の日本時間の今日から組み立てる（ビルド時に焼き込まない）
  const bounds = useMemo(() => visitDateBounds(new Date()), []);
  const today = jstDay(new Date());
  const nowHHMM = jstNowHHMM();
  const months = useMemo(() => monthsBetween(bounds.min, bounds.max), [bounds]);
  const days = useMemo(() => allDays(bounds.min, bounds.max), [bounds]);
  // 見出しの月は、帯の左端に見えている日の月（指で送ると変わる）
  const [month, setMonth] = useState(() => (value.date ? value.date.slice(0, 7) : months[0]));
  const monthIdx = months.indexOf(month);
  const [errors, setErrors] = useState<{ date?: string; time?: string }>({});
  const dayRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLDivElement>(null);
  // 「‹ ›」で送っている途中は、見出しを行き先の月のまま動かさない（途中の位置で戻らないように）
  const jumping = useRef<{ target: number; until: number } | null>(null);
  const isPast = (t: string) => value.date === today && t < nowHHMM;

  // 戻ってきたときは、選んだ日・時間が全部見える位置から始める（最初の 1 回だけ）
  useEffect(() => {
    const box = dayRef.current;
    const picked = box?.querySelector<HTMLElement>('[data-selected="true"]');
    if (box && picked) revealInStrip(box, picked, 'auto');
    const tbox = timeRef.current;
    const tpicked = tbox?.querySelector<HTMLElement>('[data-selected="true"]');
    if (tbox && tpicked) revealInStrip(tbox, tpicked, 'auto');
    onDaysScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 帯を送ったら、**見えている範囲の多いほうの月**を見出しにする。
   * 帯の真ん中にある日の月を取る（日は続いて並ぶので、真ん中の日の月が見えている日の半分以上を占める）。
   * 選んだ日の月に合わせないのは、何も選んでいないときや、選んだあとに指で別の月へ送ったときに、
   * 見出しと見えている日が食い違うため
   */
  function onDaysScroll() {
    const box = dayRef.current;
    if (!box) return;
    const j = jumping.current;
    if (j) {
      if (Math.abs(box.scrollLeft - j.target) > 2 && Date.now() < j.until) return;
      jumping.current = null;
    }
    const items = box.querySelectorAll<HTMLElement>('[data-day]');
    if (items.length === 0) return;
    // 日は同じ幅で並ぶので、位置から番号を割り出す（732 個を毎回なめない）
    const first = items[0];
    const step = items.length > 1 ? items[1].offsetLeft - first.offsetLeft : 1;
    const center = box.scrollLeft + box.clientWidth / 2;
    const i = Math.min(items.length - 1, Math.max(0, Math.floor((center - first.offsetLeft) / step)));
    const key = items[i]?.dataset.day?.slice(0, 7);
    if (key && key !== month) setMonth(key);
  }

  /** 月の切り替え: その月の最初の日が左端に全部見える位置まで、なめらかに送る */
  function jumpMonth(key: string) {
    const box = dayRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-day^="${key}"]`);
    if (box && el) {
      const target = Math.max(0, Math.min(el.offsetLeft - EDGE, box.scrollWidth - box.clientWidth));
      jumping.current = { target, until: Date.now() + 1600 };
      smoothScrollStrip(box, target);
    }
    setMonth(key);
  }

  function pickDate(date: string, el?: HTMLElement | null) {
    const start = date === today && value.start && value.start < nowHHMM ? '' : value.start;
    onChange({ date, start });
    setErrors({ ...errors, date: undefined });
    // 選んだカードが端で切れていたら、全部見える位置まで送る
    if (dayRef.current && el) revealInStrip(dayRef.current, el);
  }

  function handleNext() {
    const next: { date?: string; time?: string } = {};
    if (!value.date) next.date = '来店希望日をお選びください';
    if (!value.start) next.time = '来店希望時間をお選びください';
    else if (isPast(value.start)) next.time = '過ぎた時間は選べません。来店希望時間をお選びください';
    setErrors(next);
    if (!next.date && !next.time) onNext();
  }

  const [yy, mm] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];

  return (
    <div className="sb-slide-up pb-28">
      <PageTitle title="来店希望日時" sub={`step 1 / ${STEPS.length}`} />
      <Card>
        <Row>
          <Label text="来店希望日" required />
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              aria-label="前の月"
              disabled={monthIdx <= 0}
              onClick={() => jumpMonth(months[monthIdx - 1])}
              className="flex h-9 w-9 items-center justify-center rounded-full text-[20px] text-[#555] disabled:text-[#d5d5d5]"
            >
              ‹
            </button>
            <p className="text-[15px] font-bold text-[#111]" data-testid="sb-month">
              {yy}年{mm}月
            </p>
            <button
              type="button"
              aria-label="次の月"
              disabled={monthIdx >= months.length - 1}
              onClick={() => jumpMonth(months[monthIdx + 1])}
              className="flex h-9 w-9 items-center justify-center rounded-full text-[20px] text-[#555] disabled:text-[#d5d5d5]"
            >
              ›
            </button>
          </div>
          <div
            ref={dayRef}
            onScroll={onDaysScroll}
            className="kc-scroll"
            role="radiogroup"
            aria-label="来店希望日"
            data-testid="sb-days"
          >
            {days.map((day) => {
              const status = shopDayStatus(day.value);
              const closed = status === 'closed';
              const holiday = status === 'holiday';
              const selected = !closed && value.date === day.value;
              const wColor = selected
                ? '#fff'
                : closed
                  ? '#c4c4c4'
                  : day.w === 0 || holiday
                    ? '#ff334b'
                    : day.w === 6
                      ? '#2e7cf6'
                      : '#8c8c8c';
              // 3 行目: 定休 > 祝 > 今日 > 月の 1 日
              const note = closed ? '定休' : holiday ? '祝' : day.value === today ? '今日' : day.d === 1 ? `${day.m}月` : '\u00a0';
              const noteColor = selected ? 'text-white' : closed ? 'text-[#b5b5b5]' : holiday ? 'text-[#ff334b]' : 'text-[#c94f5a]';
              return (
                <label
                  key={day.value}
                  data-day={day.value}
                  data-status={status}
                  data-selected={selected ? 'true' : undefined}
                  title={holiday ? HOLIDAY_TUESDAYS[day.value] : closed ? '定休日' : undefined}
                  className={`relative flex h-[76px] w-[58px] flex-col items-center justify-center rounded-xl border leading-tight transition-colors ${
                    closed
                      ? 'cursor-not-allowed border-[#ededed] bg-[#f5f5f5] text-[#c4c4c4]'
                      : selected
                        ? 'cursor-pointer border-[#c94f5a] bg-[#c94f5a] text-white'
                        : 'cursor-pointer border-[#dcdcdc] bg-white text-[#111]'
                  }`}
                >
                  <input
                    type="radio"
                    name="visitDate"
                    value={day.value}
                    checked={selected}
                    disabled={closed}
                    aria-label={`${day.m}月${day.d}日（${WEEKDAY[day.w]}）${closed ? ' 定休日' : holiday ? ` ${HOLIDAY_TUESDAYS[day.value]}` : ''}`}
                    onChange={(e) => pickDate(day.value, e.currentTarget.parentElement)}
                    className="absolute h-px w-px opacity-0"
                  />
                  <span className="text-[11px] font-bold" style={{ color: wColor }}>
                    {WEEKDAY[day.w]}
                  </span>
                  <span className="mt-0.5 text-[16px] font-bold">
                    {day.m}/{day.d}
                  </span>
                  <span className={`mt-0.5 text-[10px] font-bold ${noteColor}`}>{note}</span>
                </label>
              );
            })}
          </div>
          {errors.date && <Hint error>{errors.date}</Hint>}
        </Row>
        <Row last>
          <Label text="来店希望時間" required />
          <div ref={timeRef} className="kc-scroll" role="radiogroup" aria-label="来店希望時間" data-testid="sb-times">
            {VISIT_TIMES.map((t) => {
              const selected = value.start === t;
              const past = isPast(t);
              return (
                <label
                  key={t}
                  data-time={t}
                  data-selected={selected ? 'true' : undefined}
                  className={`relative flex h-11 w-[74px] items-center justify-center rounded-xl border text-[15px] transition-colors ${
                    past
                      ? 'cursor-not-allowed border-[#ededed] bg-[#f5f5f5] text-[#c4c4c4]'
                      : selected
                        ? 'cursor-pointer border-[#c94f5a] bg-[#c94f5a] font-bold text-white'
                        : 'cursor-pointer border-[#dcdcdc] bg-white text-[#111]'
                  }`}
                >
                  <input
                    type="radio"
                    name="visitTime"
                    value={t}
                    checked={selected}
                    disabled={past}
                    onChange={(e) => {
                      onChange({ ...value, start: t });
                      setErrors({ ...errors, time: undefined });
                      const chip = e.currentTarget.parentElement;
                      if (timeRef.current && chip) revealInStrip(timeRef.current, chip);
                    }}
                    className="absolute h-px w-px opacity-0"
                  />
                  {t}
                </label>
              );
            })}
          </div>
          {errors.time && <Hint error>{errors.time}</Hint>}
          <ul className="mt-3 space-y-0.5 text-[12px] text-[#8c8c8c]" data-testid="sb-shop-hours">
            <li>営業時間　／　{SHOP_HOURS}</li>
            <li>定休日　／　{SHOP_CLOSED}</li>
          </ul>
        </Row>
      </Card>
      <p className="mt-3 px-1 text-[12px] leading-relaxed text-[#8c8c8c]">{CALLBACK_TEXT}</p>
      <BottomBar>
        {value.date && value.start && !isPast(value.start) && (
          <p className="mb-2 text-center text-[13px] text-[#555]" data-testid="sb-picked">
            {formatJp(value.date)} {value.start}
          </p>
        )}
        <PrimaryButton onClick={handleNext}>次へ</PrimaryButton>
      </BottomBar>
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
      } else if (err.status === 422 && (code === 'past_datetime' || code === 'invalid_visit_datetime' || code === 'closed_day')) {
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
    <div className="sb-slide-up pb-36">
      <BackLink onClick={onBack} />
      <PageTitle title="内容のご確認" sub={`step 3 / ${STEPS.length}`} />
      <Card>
        <dl>
          {rows.map(([label, value], i) => (
            <div
              key={label}
              className={`flex items-start justify-between gap-4 py-3.5 ${i < rows.length - 1 ? 'border-b border-[#efefef]' : ''}`}
            >
              <dt className="shrink-0 text-[13px] text-[#8c8c8c]">{label}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words text-right text-[15px] text-[#111]">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <p className="mt-3 px-1 text-[12px] leading-relaxed text-[#8c8c8c]">
        {CALLBACK_TEXT}
        {demoNotice && (
          <>
            <br />
            {DEMO_NOTICE}
          </>
        )}
      </p>
      {error && (
        <div className="mt-3 rounded-xl border border-[#f2b8bf] bg-white px-4 py-3 text-[14px] font-bold text-[#d0021b]" role="alert">
          ！{error.text}
          {error.toDatetime && (
            <button type="button" onClick={onDatetime} className="mt-2 block font-bold underline">
              日時を選び直す
            </button>
          )}
        </div>
      )}
      <BottomBar>
        <PrimaryButton onClick={handleSubmit} disabled={submitting}>
          {submitting ? '送信中…' : 'この内容で送信する'}
        </PrimaryButton>
      </BottomBar>
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
    <div className="sb-fade-in pt-6">
      <Card className="py-8 text-center">
        <div
          className="mx-auto flex h-16 w-16 items-center justify-center rounded-full text-3xl font-bold text-white"
          style={{ background: '#c94f5a' }}
        >
          ✓
        </div>
        <h1 className="mt-4 text-[18px] font-bold text-[#111]">ご予約を受け付けました</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-[#555]">{CALLBACK_TEXT}</p>
        {demoNotice && <p className="mt-2 text-[12px] text-[#8c8c8c]">{DEMO_NOTICE}</p>}
        <div className="mt-6 flex flex-col gap-2.5">
          <PrimaryButton onClick={close}>トークにもどる</PrimaryButton>
          <button
            type="button"
            onClick={gotoHistory}
            className="block h-[52px] w-full rounded-xl border border-[#dcdcdc] bg-white text-[15px] font-bold text-[#111]"
          >
            予約の確認
          </button>
        </div>
      </Card>
    </div>
  );
}
