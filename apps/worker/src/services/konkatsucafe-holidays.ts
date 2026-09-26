// konkatsucafe fork (L-08 s4): 定休日（火曜）と祝日の火曜。
//
// 現サイトの正本（konkatsucafe-site の src/data/site.ts）は `closed: '火曜日（祝日は営業）'`。
// ふつうの火曜は予約を受けない。祝日の火曜は受ける。
//
// **祝日の正本は内閣府「国民の祝日について」の CSV**（振替休日・国民の休日を含む）。
//   https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv
//   2026-09-25 取得、sha256 cec37a743c96995cdb9cb52b685c9003634682a9b0e1a640a6b9b96881fe964a、
//   掲載の最終日 2027-11-23（勤労感謝の日）＝ 2027 年分まで公表済み。
// ここにはそのうち 2026〜2027 年の火曜だけを写す。**計算で祝日を推測して足さない。**
//
// 一覧が公表されていない範囲（HOLIDAY_LIST_COVERS_UNTIL より後）の火曜は、祝日かどうか
// 分からないので定休として受けない。内閣府が翌年分を公表したら、この表と日付を足す。
//
// Worker（受け口の判定）と LIFF の画面（カルーセルの表示）の両方から読む。

/** 定休の曜日（0=日）。火曜 */
export const CLOSED_WEEKDAY = 2;

/** 祝日の一覧がこの日まで公表済み（内閣府 CSV は年ごとに公表。2027 年分まで） */
export const HOLIDAY_LIST_COVERS_UNTIL = '2027-12-31';

/** 内閣府 CSV の 2026〜2027 年の祝日のうち、火曜のもの（日付 → 名称） */
export const HOLIDAY_TUESDAYS: Readonly<Record<string, string>> = {
  '2026-05-05': 'こどもの日',
  '2026-08-11': '山の日',
  '2026-09-22': '休日',
  '2026-11-03': '文化の日',
  '2027-02-23': '天皇誕生日',
  '2027-05-04': 'みどりの日',
  '2027-11-23': '勤労感謝の日',
};

/**
 * `YYYY-MM-DD` の営業の区分。
 * - 'open': 火曜以外
 * - 'holiday': 祝日の火曜（営業）
 * - 'closed': ふつうの火曜、または祝日の一覧がまだ無い範囲の火曜（定休として受けない）
 */
export function shopDayStatus(ymd: string): 'open' | 'holiday' | 'closed' {
  const w = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  if (w !== CLOSED_WEEKDAY) return 'open';
  if (ymd <= HOLIDAY_LIST_COVERS_UNTIL && HOLIDAY_TUESDAYS[ymd]) return 'holiday';
  return 'closed';
}
