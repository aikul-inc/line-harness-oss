-- Migration 073 (konkatsucafe fork, L-08): 予約ごとの「お客様情報」
--
-- LIFF の予約画面で聞いた項目（姓・名・性別・年齢・電話・LINE名・来店希望日・時間・人数・
-- 同意・婚活の経験・ご相談内容）を、その予約 1 件にまとめて JSON で残す。
-- 形は {"version": "...", "values": {"sei": "...", ...}}。キーは konkatsucafe の
-- src/data/yoyaku.ts の fields の name。お客様情報を聞かない予約（代理作成など）は NULL。
ALTER TABLE bookings ADD COLUMN intake_json TEXT CHECK (intake_json IS NULL OR json_valid(intake_json));
