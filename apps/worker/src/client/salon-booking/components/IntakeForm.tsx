// konkatsucafe fork (L-08): 予約の「お客様情報」。
// 項目・並び・ラベル・選択肢は konkatsucafe の /yoyaku/ と同じ（services/booking-intake-fields.ts）。
// 来店希望日・時間は前の画面で選んだ値をそのまま使い、ここでは聞き直さない。
// s3: 見た目を LINE 公式アカウントに寄せた（姓名は 2 列、LINE名はアイコンと名前、選ぶ項目はボタン）。
import { useState } from 'react';
import {
  ASKED_FIELDS,
  intakeMissingMessage,
  type IntakeField,
} from '../../../services/booking-intake-fields.js';
import type { IntakeDraft } from '../lib/api.js';
import { useSalonContext } from '../lib/context.js';
import { formatJp } from '../lib/datetime.js';
import { BackLink, BottomBar, Card, Chip, Hint, Label, PageTitle, PrimaryButton, Row, kcInput } from './kc-ui.js';

export function emptyIntake(displayName?: string): IntakeDraft {
  return {
    sei: '',
    mei: '',
    gender: '',
    age: '',
    tel: '',
    lineName: displayName ?? '',
    visitCount: '',
    agreeTerms: false,
    experience: [],
    message: '',
  };
}

/** 必須が欠けている項目の name。画面の検証だけで、正しさは受け口が確かめる */
export function missingIntakeFields(draft: IntakeDraft): string[] {
  const out: string[] = [];
  for (const f of ASKED_FIELDS) {
    if (!f.required) continue;
    const v = draft[f.name as keyof IntakeDraft];
    if (f.kind === 'checkbox' ? v !== true : Array.isArray(v) ? v.length === 0 : String(v ?? '').trim() === '') {
      out.push(f.name);
    }
  }
  return out;
}

const field = (name: string): IntakeField => {
  const f = ASKED_FIELDS.find((x) => x.name === name);
  if (!f) throw new Error(`field ${name} is missing`);
  return f;
};

export default function IntakeForm({
  slot,
  value,
  onChange,
  onNext,
  onBack,
  stepLabel,
}: {
  slot: { date: string; start: string };
  value: IntakeDraft;
  onChange: (next: IntakeDraft) => void;
  onNext: () => void;
  onBack: () => void;
  stepLabel: string;
}) {
  const [errors, setErrors] = useState<string[]>([]);

  function set<K extends keyof IntakeDraft>(key: K, v: IntakeDraft[K]) {
    onChange({ ...value, [key]: v });
    if (errors.includes(key)) setErrors(errors.filter((e) => e !== key));
  }

  function handleNext() {
    const missing = missingIntakeFields(value);
    setErrors(missing);
    if (missing.length > 0) {
      document.getElementById(`sb-intake-${missing[0]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    onNext();
  }

  const err = (name: string) =>
    errors.includes(name) ? <Hint error>{intakeMissingMessage(field(name))}</Hint> : null;

  const sei = field('sei');
  const mei = field('mei');
  const gender = field('gender');
  const age = field('age');
  const tel = field('tel');
  const lineName = field('lineName');
  const visitCount = field('visitCount');
  const agree = field('agreeTerms');
  const experience = field('experience');
  const message = field('message');

  return (
    <div className="sb-slide-up pb-28">
      <BackLink onClick={onBack} />
      <PageTitle title="お客様情報" sub={stepLabel} />

      <Card>
        {/* お名前（姓・名を 2 列） */}
        <Row id="sb-intake-sei">
          <div className="grid grid-cols-2 gap-2.5">
            <div className="min-w-0" id="sb-intake-mei">
              <Label text={sei.label} required htmlFor="kc-sei" />
              <input
                id="kc-sei"
                name="sei"
                autoComplete={sei.autocomplete}
                placeholder="山田"
                value={value.sei}
                onChange={(e) => set('sei', e.target.value)}
                className={kcInput}
              />
            </div>
            <div className="min-w-0">
              <Label text={mei.label} required htmlFor="kc-mei" />
              <input
                id="kc-mei"
                name="mei"
                autoComplete={mei.autocomplete}
                placeholder="花子"
                value={value.mei}
                onChange={(e) => set('mei', e.target.value)}
                className={kcInput}
              />
            </div>
          </div>
          {err('sei') ?? err('mei')}
        </Row>

        {/* 性別 */}
        <Row id="sb-intake-gender">
          <Label text={gender.label} required />
          <div className="grid grid-cols-2 gap-2.5" role="radiogroup" aria-label={gender.label}>
            {gender.options?.map((o) => (
              <Chip
                key={o}
                type="radio"
                name="gender"
                value={o}
                checked={value.gender === o}
                onChange={() => set('gender', o)}
                className="h-12 text-[15px]"
              >
                {o}
              </Chip>
            ))}
          </div>
          {err('gender')}
        </Row>

        {/* 年齢 */}
        <Row id="sb-intake-age">
          <Label text={age.label} required htmlFor="kc-age" />
          <select
            id="kc-age"
            name="age"
            value={value.age}
            onChange={(e) => set('age', e.target.value)}
            className={`${kcInput} appearance-none`}
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%23999' stroke-width='1.6'/%3E%3C/svg%3E\")",
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 14px center',
            }}
          >
            <option value="">選択してください</option>
            {age.options?.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          {err('age')}
        </Row>

        {/* 電話番号 */}
        <Row id="sb-intake-tel">
          <Label text={tel.label} required htmlFor="kc-tel" />
          <input
            id="kc-tel"
            name="tel"
            type="tel"
            inputMode="tel"
            autoComplete={tel.autocomplete}
            placeholder="09012345678"
            value={value.tel}
            onChange={(e) => set('tel', e.target.value)}
            className={kcInput}
          />
          {err('tel') ?? <Hint>お店からのお電話でご予約を確定します。</Hint>}
        </Row>

        {/* LINE名（アイコンと名前。小さな「変更」から直せる） */}
        <Row id="sb-intake-lineName">
          <Label text={lineName.label} />
          <LineProfile value={value.lineName} onChange={(v) => set('lineName', v)} />
        </Row>

        {/* 来店希望日時（前の画面の値） */}
        <Row>
          <Label text="来店希望日時" />
          <div className="flex items-center justify-between gap-3">
            <p className="text-[16px] font-bold text-[#111]" data-testid="sb-intake-slot">
              {formatJp(slot.date)} {slot.start}
            </p>
            <button type="button" onClick={onBack} className="shrink-0 text-[13px] font-bold text-[#c94f5a]">
              変更
            </button>
          </div>
        </Row>

        {/* 来店人数 */}
        <Row id="sb-intake-visitCount">
          <Label text={visitCount.label} required />
          <div className="grid grid-cols-2 gap-2.5" role="radiogroup" aria-label={visitCount.label}>
            {visitCount.options?.map((o, i) => (
              <Chip
                key={o}
                type="radio"
                name="visitCount"
                value={o}
                checked={value.visitCount === o}
                onChange={() => set('visitCount', o)}
                className={i < 2 ? 'h-12 text-[15px]' : 'col-span-2 min-h-12 px-3 py-2 text-[13px] leading-snug'}
              >
                {o}
              </Chip>
            ))}
          </div>
          {err('visitCount')}
        </Row>

        {/* ご利用条件の同意（/yoyaku/ と同じく来店人数の次） */}
        <Row id="sb-intake-agreeTerms">
          <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-[#f7f7f7] px-3.5 py-3">
            <input
              type="checkbox"
              name="agreeTerms"
              checked={value.agreeTerms}
              onChange={(e) => set('agreeTerms', e.target.checked)}
              className="mt-0.5 h-6 w-6 shrink-0 accent-[#c94f5a]"
            />
            <span className="text-[14px] leading-relaxed text-[#111]">
              {agree.label}
              <span className="ml-1.5 inline-block rounded bg-[#ececec] px-1.5 py-px align-middle text-[10px] font-bold text-[#555]">
                必須
              </span>
            </span>
          </label>
          {err('agreeTerms')}
        </Row>

        {/* 婚活の経験（複数） */}
        <Row id="sb-intake-experience">
          <Label text={experience.label} required />
          <div className="grid grid-cols-2 gap-2.5">
            {experience.options?.map((o) => (
              <Chip
                key={o}
                type="checkbox"
                name="experience"
                value={o}
                checked={value.experience.includes(o)}
                onChange={(on) => {
                  const next = on ? [...value.experience, o] : value.experience.filter((v) => v !== o);
                  // 並びは選択肢の順にそろえる（/yoyaku/ と同じ並びで残す）
                  set('experience', experience.options!.filter((x) => next.includes(x)));
                }}
                className="min-h-12 px-2 py-2 text-[14px] leading-snug"
              >
                {o}
              </Chip>
            ))}
          </div>
          <Hint>当てはまるものをすべてお選びください。</Hint>
          {err('experience')}
        </Row>

        {/* 婚活の現状やお悩み */}
        <Row id="sb-intake-message" last>
          <Label text={message.label} htmlFor="kc-message" />
          <textarea
            id="kc-message"
            name="message"
            rows={4}
            maxLength={2000}
            value={value.message}
            onChange={(e) => set('message', e.target.value)}
            className={`${kcInput} h-auto resize-y py-3 leading-relaxed`}
          />
        </Row>
      </Card>

      {errors.length > 0 && (
        <p className="mt-3 rounded-xl border border-[#f2b8bf] bg-white px-4 py-3 text-[14px] font-bold text-[#d0021b]" role="alert">
          ！未入力の項目があります。
        </p>
      )}

      <BottomBar>
        <PrimaryButton onClick={handleNext}>確認へ進む</PrimaryButton>
      </BottomBar>
    </div>
  );
}

/** LINE のアイコンと名前。送る値は LINE名。小さな「変更」で直せ、直すと表示の名前も変わる */
function LineProfile({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ctx = useSalonContext();
  const [editing, setEditing] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const initial = (value || ctx.displayName || '').trim().slice(0, 1);
  return (
    <div>
      <div className="flex items-center gap-3" data-testid="sb-line-profile">
        {ctx.pictureUrl && !imgFailed ? (
          <img
            src={ctx.pictureUrl}
            alt=""
            onError={() => setImgFailed(true)}
            className="h-12 w-12 shrink-0 rounded-full bg-[#eee] object-cover"
          />
        ) : (
          <div
            aria-hidden
            data-testid="sb-line-avatar-fallback"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#ffdee1] text-[18px] font-bold text-[#c94f5a]"
          >
            {initial || '?'}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[16px] font-bold text-[#111]" data-testid="sb-line-name">
            {value || '（未入力）'}
          </p>
          <p className="text-[12px] text-[#8c8c8c]">このLINEアカウントでご予約します</p>
        </div>
        <button
          type="button"
          onClick={() => setEditing(!editing)}
          className="shrink-0 rounded-full border border-[#dcdcdc] px-3 py-1 text-[12px] font-bold text-[#555]"
          aria-expanded={editing}
        >
          {editing ? '閉じる' : '変更'}
        </button>
      </div>
      {editing && (
        <div className="mt-3">
          <input
            name="lineName"
            aria-label="LINE名"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={kcInput}
          />
          <Hint>お店でお名前を確認するときに使います。</Hint>
        </div>
      )}
    </div>
  );
}
