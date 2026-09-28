// Salon booking client gets its caller-context from main.ts (existing LIFF
// orchestrator). main.ts has already called liff.init() and resolved the
// LINE userId / id_token before mounting React; we just consume.
//
// friend UUID は intentionally 持たない: booking エンドポイントは id_token で
// caller を verify し、friends.line_user_id から UUID を引くため React 側では不要。

import { createContext, useContext } from 'react';

export interface SalonBookingContext {
  liffId: string;
  lineUserId: string;
  idToken: string;
  /** konkatsucafe fork (L-08): LINE のプロフィール名。「LINE名」の初期値に使う（本人が直せる） */
  displayName?: string;
  /** konkatsucafe fork (L-08 s3): LINE のプロフィールのアイコン。「LINE名」欄に名前と並べて出す */
  pictureUrl?: string;
  /** konkatsucafe fork (L-06 s2): 開いた URL の広告値（liff.init より前に読んだもの）。予約の受け口へ添える */
  attribution?: Record<string, string>;
  /** konkatsucafe fork (L-06 s2): 開いた URL の計測リンクの印（lh_link）。受け口が照合する */
  trackedLink?: string | null;
}

const Ctx = createContext<SalonBookingContext | null>(null);

export const SalonBookingProvider = Ctx.Provider;

export function useSalonContext(): SalonBookingContext {
  const v = useContext(Ctx);
  if (!v) throw new Error('SalonBookingContext not provided');
  return v;
}
