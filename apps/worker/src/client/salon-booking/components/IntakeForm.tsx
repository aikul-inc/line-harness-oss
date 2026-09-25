// konkatsucafe fork (L-08): 予約の「お客様情報」。
// 項目・並び・ラベル・選択肢は konkatsucafe の /yoyaku/ と同じ（services/booking-intake-fields.ts）。
// 来店希望日・時間は前の画面で選んだ枠をそのまま使い、ここでは聞き直さない。
import { useState } from 'react';
import {
  ASKED_FIELDS,
  intakeMissingMessage,
  type IntakeField,
} from '../../../services/booking-intake-fields.js';
import type { IntakeDraft } from '../lib/api.js';
import { formatJp } from '../lib/datetime.js';

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

const inputClass =
  'w-full border border-gray-300 rounded-xl px-3 py-2.5 text-base bg-white focus:outline-none focus:ring-2 focus:ring-green-500';

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

  return (
    <div className="space-y-4 sb-slide-up">
      <button onClick={onBack} className="sb-back-btn">
        <span aria-hidden>←</span>
        戻る
      </button>
      <div>
        <h1 className="text-base font-bold text-gray-900">お客様情報</h1>
        <p className="text-xs text-gray-500 mt-1">{stepLabel}</p>
      </div>

      <div className="sb-card space-y-5">
        {ASKED_FIELDS.map((f) =>
          f.name === 'visitCount' ? (
            <div key="slot-and-count" className="space-y-5">
              <div>
                <p className="text-sm font-medium text-gray-800 mb-1">来店希望日時</p>
                <p className="text-sm text-gray-900" data-testid="sb-intake-slot">
                  {formatJp(slot.date)} {slot.start}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">前の画面で選んだ日時です</p>
              </div>
              <FieldRow field={f} value={value} set={set} error={errors.includes(f.name)} />
            </div>
          ) : (
            <FieldRow key={f.name} field={f} value={value} set={set} error={errors.includes(f.name)} />
          ),
        )}
      </div>

      {errors.length > 0 && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm" role="alert">
          未入力の項目があります。
        </div>
      )}

      <button
        onClick={handleNext}
        className="w-full text-white py-3.5 rounded-xl font-bold"
        style={{ background: '#06C755', boxShadow: '0 1px 3px rgba(6, 199, 85, 0.3)' }}
      >
        確認へ進む
      </button>
    </div>
  );
}

function FieldRow({
  field: f,
  value,
  set,
  error,
}: {
  field: IntakeField;
  value: IntakeDraft;
  set: <K extends keyof IntakeDraft>(key: K, v: IntakeDraft[K]) => void;
  error: boolean;
}) {
  const key = f.name as keyof IntakeDraft;
  const id = `sb-intake-${f.name}`;
  const label = (
    <span className="text-sm font-medium text-gray-800">
      {f.label}
      {f.required && <span className="ml-1 text-xs font-bold text-red-600">必須</span>}
    </span>
  );
  const hint = error ? (
    <p className="text-xs text-red-600 mt-1">{intakeMissingMessage(f)}</p>
  ) : null;

  if (f.kind === 'checkbox') {
    return (
      <div id={id}>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            name={f.name}
            checked={value.agreeTerms}
            onChange={(e) => set('agreeTerms', e.target.checked)}
            className="mt-1 h-5 w-5 shrink-0"
          />
          {label}
        </label>
        {hint}
      </div>
    );
  }

  if (f.kind === 'radio' || f.kind === 'checkgroup') {
    const multiple = f.kind === 'checkgroup';
    const current = value[key];
    return (
      <fieldset id={id} className="m-0 min-w-0 border-0 p-0">
        <legend className="mb-2 p-0">{label}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {f.options?.map((opt) => {
            const checked = multiple ? (current as string[]).includes(opt) : current === opt;
            return (
              <label key={opt} className="inline-flex items-center gap-2 text-sm text-gray-800">
                <input
                  type={multiple ? 'checkbox' : 'radio'}
                  name={f.name}
                  value={opt}
                  checked={checked}
                  onChange={(e) => {
                    if (!multiple) return set(key, opt as never);
                    const list = current as string[];
                    const next = e.target.checked ? [...list, opt] : list.filter((v) => v !== opt);
                    // 並びは選択肢の順にそろえる（/yoyaku/ と同じ並びで残す）
                    set(key, f.options!.filter((o) => next.includes(o)) as never);
                  }}
                  className="h-5 w-5"
                />
                {opt}
              </label>
            );
          })}
        </div>
        {hint}
      </fieldset>
    );
  }

  if (f.kind === 'select') {
    return (
      <label className="block" id={id}>
        <span className="block mb-1">{label}</span>
        <select
          name={f.name}
          value={value[key] as string}
          onChange={(e) => set(key, e.target.value as never)}
          className={inputClass}
        >
          <option value="">選択してください</option>
          {f.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        {hint}
      </label>
    );
  }

  if (f.kind === 'textarea') {
    return (
      <label className="block" id={id}>
        <span className="block mb-1">{label}</span>
        <textarea
          name={f.name}
          value={value[key] as string}
          onChange={(e) => set(key, e.target.value as never)}
          rows={4}
          maxLength={2000}
          className={`${inputClass} resize-y`}
        />
        {hint}
      </label>
    );
  }

  return (
    <label className="block" id={id}>
      <span className="block mb-1">{label}</span>
      <input
        type={f.kind === 'tel' ? 'tel' : 'text'}
        name={f.name}
        inputMode={f.kind === 'tel' ? 'tel' : undefined}
        autoComplete={f.autocomplete}
        value={value[key] as string}
        onChange={(e) => set(key, e.target.value as never)}
        className={inputClass}
      />
      {hint}
    </label>
  );
}
