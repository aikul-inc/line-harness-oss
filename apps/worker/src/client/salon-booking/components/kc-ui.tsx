// konkatsucafe fork (L-08 s3): 予約画面の部品。LINE 公式アカウントの見た目に寄せる
// （白地のカードとやわらかい灰色の区切り、画面下に固定した主ボタン、15〜16px の文字）。
// s4: 色は LINE の緑からお店のピンクに。正本は konkatsucafe-line の src/styles/global.css の
// --color-accent-dark（#c94f5a）。白い文字とのコントラスト比は 4.42:1（--color-accent #e2626d は 3.39:1 で
// 足りないため濃いほうを使う）。薄いピンク #ffdee1 は konkatsucafe-site の --color-brand-soft。
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const KC_PINK = '#c94f5a';

/** 画面の外側（ヘッダー・予約履歴のタブ）も同じピンクにする。上流の画面は緑のまま */
export function applyKonkatsucafeTheme(): void {
  document.documentElement.style.setProperty('--kc-accent', KC_PINK);
}

/** 入力欄。iOS は 16px 未満だとタップ時に拡大するので下回らせない */
export const kcInput =
  'block w-full h-12 rounded-xl border border-[#e3e3e3] bg-[#f7f7f7] px-3.5 text-[16px] text-[#111] placeholder:text-[#b5b5b5] focus:outline-none focus:border-[#c94f5a] focus:bg-white';

/** 白地の角丸カード。中の行はやわらかい灰色の線で区切る */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl bg-white px-4 ${className}`}>{children}</div>;
}

/** カードの中の 1 行（項目 1 つ） */
export function Row({ children, id, last = false }: { children: ReactNode; id?: string; last?: boolean }) {
  return (
    <div id={id} className={`py-4 ${last ? '' : 'border-b border-[#efefef]'}`}>
      {children}
    </div>
  );
}

export function Label({ text, required, htmlFor }: { text: string; required?: boolean; htmlFor?: string }) {
  const body = (
    <>
      {text}
      {/* 「必須」は灰色の札。ピンク（選択中）・赤（日曜・エラー）と見分けやすくする */}
      {required && <span className="ml-1.5 inline-block rounded bg-[#ececec] px-1.5 py-px align-middle text-[10px] font-bold text-[#555]">必須</span>}
    </>
  );
  return htmlFor ? (
    <label htmlFor={htmlFor} className="mb-2 block text-[14px] font-bold leading-snug text-[#111]">
      {body}
    </label>
  ) : (
    <p className="mb-2 text-[14px] font-bold leading-snug text-[#111]">{body}</p>
  );
}

export function Hint({ children, error = false }: { children: ReactNode; error?: boolean }) {
  // エラーは赤に「！」の印を付け、選択中のピンクと色だけで見分けさせない
  return (
    <p className={`mt-1.5 text-[12px] leading-relaxed ${error ? 'font-bold text-[#d0021b]' : 'text-[#8c8c8c]'}`}>
      {error && <span aria-hidden>！</span>}
      {children}
    </p>
  );
}

/**
 * 選ぶ形のボタン（ラジオ・チェック）。実体は input を隠して label を押す形にし、
 * キーボードや読み上げでも選べるようにする
 */
export function Chip({
  type,
  name,
  value,
  checked,
  disabled,
  onChange,
  children,
  className = '',
}: {
  type: 'radio' | 'checkbox';
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  const state = disabled
    ? 'border-[#ededed] bg-[#f5f5f5] text-[#c4c4c4]'
    : checked
      ? 'border-[#c94f5a] bg-[#c94f5a] text-white font-bold'
      : 'border-[#dcdcdc] bg-white text-[#111]';
  return (
    <label className={`relative flex cursor-pointer items-center justify-center rounded-xl border text-center transition-colors ${state} ${disabled ? 'cursor-not-allowed' : ''} ${className}`}>
      <input
        type={type}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="absolute h-px w-px opacity-0"
      />
      {children}
    </label>
  );
}

/**
 * 画面下に貼り付ける主ボタン。長い画面でも指が届く。
 * 画面の切り替えの動き（transform）の中に置くと fixed が画面に貼り付かないので、body の直下に出す
 */
export function BottomBar({ children }: { children: ReactNode }) {
  return createPortal(
    <div
      className="fixed inset-x-0 bottom-0 z-10 border-t border-[#e8e8e8] bg-white/95 px-4 pt-3 backdrop-blur"
      style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }}
    >
      <div className="mx-auto max-w-md">{children}</div>
    </div>,
    document.body,
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="block h-[52px] w-full rounded-xl text-[16px] font-bold text-white disabled:opacity-50"
      style={{ background: KC_PINK }}
    >
      {children}
    </button>
  );
}

export function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mb-3 inline-flex items-center gap-1 text-[14px] text-[#555]">
      <span aria-hidden>‹</span>
      戻る
    </button>
  );
}

export function PageTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-3 px-1">
      <h1 className="text-[18px] font-bold text-[#111]">{title}</h1>
      {sub && <p className="mt-0.5 text-[12px] text-[#8c8c8c]">{sub}</p>}
    </div>
  );
}
