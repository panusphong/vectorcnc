'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  🧪 tools/test-cash-received-detail.js — รอบ 230–232 · "ดูรายการ" ของยอดรับเงินจริง + มัดจำเข้าช่องทาง
 *
 *  พี่เอ 3 ต.ค. 69 (หลังเห็นของจริง v1.50.0 — สาขารับเงิน = ยอดขายเป๊ะ 100%)
 *    "check ให้ถูกต้องอีกทีนะ ว่าทำไมสาขาถึงเก็บเงินได้เท่ากับที่ขายเป๊ะเลย น่าจะต้องมีการเก็บมัดจำกันบ้างนะ"
 *    "แน่ใจนะ ว่าดึงยอดรับเงินมาถูกช่องทาง เช็คให้หน่อย ว่าดึงด้วยหลักการอะไร อ้างอิงจากอะไร"
 *    "ส่วนเงินมัดจำ ต้องวิ่งเข้าแต่ละช่องทางให้ถูกต้องด้วยนะ"
 *
 *    "ต้องมีอะไรผิดแน่นอน ไม่มีทางที่ยอด สาขา ที่ขาย กับเก็บเงินจะเท่ากัน 100% แบบนี้เป็นไปไม่ได้"
 *  ของจริง (พี่เอเปิดแอปจริงให้อ่าน 3 ต.ค. 69): งานสาขา 8 งาน เซลส์คีย์ "ยอดโอน 100%" = ยอดขายเต็มทุกงาน
 *    แต่ PEAK ตอบ "ยังไม่ชำระ" 5 งาน ฿63,675 ⇒ ระบบถอยไปเชื่อยอดที่คีย์ จึงขึ้น 100% (แถว 11 ข้างล่างจำลองเคสนี้)
 *
 *  รอบ 231 · พี่เอ 4 ต.ค. 69 (หลังเห็น v1.51.0: สาขา ฿4,634 = 6.8%):
 *    "เอาใหม่นะ บอกว่า ให้นับยอดรับเงินจริงไง ยอดที่รับเป็นมัดจำเข้ามาก็ต้องนับด้วยนะ เห็นยอดสาขาแล้วมันก็ผิดแล้ว
 *     ส่วนใหญ่สาขา รับอย่างน้อย 50% ของยอดขายขึ้นไปอยู่แล้วทุกบิลขาย"
 *
 *  รอบ 232 · พี่เอ 4 ต.ค. 69 (หลังเห็น v1.52.0: สาขากลับไป 100%) — กติกาสุดท้าย:
 *    "ถ้ารอ peak ยืนยัน ก้อคือเงินยังไม่ได้เข้า เพราะเค้าจะรับชำระตามยอดที่ลูกค้าจ่ายจริงเท่านั้นสิ ไปเอายอดที่เหลือมาบวกทำไม เค้ายังไม่จ่ายเลย"
 *    "ถ้าเค้าคีย์โอน 100% ก็ต้องเช็คที่ peak เป็นหลักว่า มีการรับชำระจริงตามที่คีย์ไว้มั้ยนะ" · "พี่ดูยอดรับชำระใน peak เป็นหลักนะ"
 *
 *  ① นับเฉพาะที่ PEAK รับชำระแล้ว · ยอดโอนที่เซลส์คีย์แต่ PEAK ยังไม่รับชำระ = ไม่นับ (แสดงแยก)
 *  ② ช่องทาง: มัดจำ (ใบเสร็จ PEAK ของงานที่ยังไม่ปิดการขาย) + ใบเสร็จที่ตามรอยได้ เข้าช่องทางของงาน
 *  ③ ใบเสร็จที่นับซ้ำ: ตัดออก — และพิสูจน์ว่าหน้า Cash Flow ยังนับ 2 ครั้ง (กระทบยอดกันได้ทุกบาท)
 *  ④ ดูรายการ: ผลรวม = ตัวเลขบนการ์ดทุกบาท · งานที่ปิดในช่วงนี้ รับครบ/รับบางส่วน/PEAK ยังไม่ตัดยอด
 *  ⑤ สิทธิ์: รายการ (มีชื่อลูกค้า) เฉพาะผู้ดูแลระบบ · ยอดรวมยังเปิดทุกสิทธิ์
 *  ⑥ หน้าจอจริง (Chromium)   SHOT=<file> ⇒ เก็บภาพหน้าต่างดูรายการ · SHOT_CARDS=<file> ⇒ ภาพแถวการ์ด
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 55695, APP_PORT = 55696;
process.env.SUPABASE_URL = `http://127.0.0.1:${REST_PORT}`;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const APP_DIR = process.env.APP_DIR || path.join(__dirname, '..');      /* SHOT ของรุ่นก่อน: ชี้ไปโฟลเดอร์รุ่นก่อน */
const ONLY_SHOT = !!process.env.ONLY_SHOT;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);
const { todayTH } = require('../core/thai-date');

(async () => {
  console.log('\n🧪 รอบ 230–232 — ยึดยอดรับชำระใน PEAK · มัดจำเข้าช่องทาง · ตัดของที่นับซ้ำ · ดูรายการ\n');
  const T = todayTH();
  const d0 = new Date(T + 'T00:00:00Z');
  const ymd = x => x.toISOString().slice(0, 10);
  const Y = d0.getUTCFullYear(), M = d0.getUTCMonth();
  const mStart = ymd(new Date(Date.UTC(Y, M, 1)));
  const mEnd = ymd(new Date(Date.UTC(Y, M + 1, 0)));
  const pStart = ymd(new Date(Date.UTC(Y, M - 1, 1)));
  const { PPAID, PSTAT } = require('../modules/sales/peak-sync').COL;

  const { Client } = require('pg');
  const pg = new Client({ connectionString: PG });
  await pg.connect();
  await pg.query('truncate app.total_sales');
  await pg.query('delete from app.cash_flow');
  await pg.query("delete from app.sheet_rows where source like 'sales/Peak%'");
  await pg.query('delete from app.peak_expenses').catch(() => {});
  const hash = require('bcryptjs').hashSync('test1234', 10);
  await pg.query(`insert into app.app_users ("Username","Nickname","Name","Permission","PasswordHash","Status")
     values ('crboss','พี่เอ','Panusphong','Administrator',$1,'Login'),
            ('crsale','ส้ม','(ส้ม) สมหญิง','Sale',$1,'Login')
     on conflict (lower("Username")) do update set "PasswordHash" = excluded."PasswordHash",
       "Permission" = excluded."Permission", "Nickname" = excluded."Nickname", "Name" = excluded."Name", "Status" = 'Login'`, [hash]);

  /* ── ตารางขาย ─────────────────────────────────────────────────────────────────────────────
   *  1 สาขา      ปิดวันนี้    10,000  IV-2610001             ใบเสร็จ 10,000                → รับครบ
   *  2 สาขา      ปิดวันนี้    20,000  IV-2610002             ใบเสร็จ 8,000 (มัดจำ)          → รับบางส่วน
   *  3 สาขา      ปิดเดือนก่อน 30,000  IV-2609003             ใบเสร็จ 15,000 เดือนก่อน + 15,000 วันนี้
   *  4 สาขา      ยังไม่ปิด    40,000  IV-2610004             ใบเสร็จ 12,000 วันนี้ = มัดจำ   → ต้องเข้าช่องทางสาขา
   *  5 Online    ปิดวันนี้    50,000  IV2610005 (ไม่มีขีด)    PEAK ตัดยอด 50,000 + ใบเสร็จใต้เลข IV-2610005 50,000 → น่าจะนับซ้ำ
   *  6 B2B       ปิดวันนี้    60,000  QO-2610066 / IV-2610066 ใบเสร็จ IV-2610066 25,000      → แถวนับแล้ว + รอบสองนับอีก = น่าจะนับซ้ำ
   *  7 Partner   ปิดวันนี้    70,000  IV-2610077             ใบเสร็จ 40,000 + ใบมัดจำอีกใบ IV-2610070 30,000 (รหัสงานเดียวกัน)
   *  8 ผู้บริหาร  ปิดวันนี้     5,000  QO-2610088             ไม่มีอะไรบนแถวขาย · ใบเสร็จ IV-2610088 5,000 (รหัสงานนี้)
   *  9 Online    ยังไม่ปิด    90,000  (ว่าง)                 สลิป 7,000 วันนี้              → ไม่ถูกนับ
   * 10 Online    ปิดวันนี้    15,000  IV-2610010             PEAK ตอบรับชำระ = 0 · สลิป 9,000 → ไม่นับ (PEAK ยังไม่รับชำระ)
   * 11 สาขา      ปิดวันนี้    54,570  IV-2610011             PEAK "ยังไม่ชำระ" · เซลส์คีย์ยอดโอน 100% = 54,570 → ไม่นับ (เคสจริงของพี่เอ)
   * 12 B2B       ปิดวันนี้    40,000  IV2610012 (ไม่มีขีด)    เซลส์คีย์มัดจำงวด 1 = 20,000 + ใบเสร็จ PEAK ใต้เลข IV-2610012 20,000 = เงินก้อนเดียวกัน → นับครั้งเดียว (ใช้ใบเสร็จ) */
  const S = (row, code, close, co, st, src, plat, sale, iv, more) => {
    const cols = Object.assign({ _row: row, 'รหัสงาน': code, 'วันที่ติดต่อ': close, 'วันที่ปิดการขาย': close, 'ชื่อบริษัท': co,
      'Create By': 'crsale', 'Lead Status': st, 'ประเภทลูกค้า': 'ลูกค้าใหม่', 'ลูกค้ามาจากไหน': src, 'ชื่อช่อง / Platform': plat,
      'ยอดขาย (บาท)': sale, 'เลขที่ QO / IV': iv }, more || {});
    const k = Object.keys(cols);
    return pg.query(`insert into app.total_sales (${k.map(c => '"' + c + '"').join(',')}) values (${k.map((_, i) => '$' + (i + 1)).join(',')})`, k.map(c => cols[c]));
  };
  await S(1, 'DT2610/001', T, 'ร้านหนึ่ง', 'ปิดการขาย', 'สาขามดงาน', 'สาขา_ไท-บางใหญ่', 10000, 'IV-2610001');
  await S(2, 'DT2610/002', T, 'ร้านสอง', 'ปิดการขาย', 'สาขามดงาน', 'สาขา_บางนา', 20000, 'IV-2610002');
  await S(3, 'DT2609/003', pStart, 'ร้านสาม', 'ปิดการขาย', 'สาขามดงาน', 'สาขา_บางนา', 30000, 'IV-2609003');
  await S(4, 'DT2610/004', null, 'ร้านสี่', 'Onprocess', 'สาขามดงาน', 'สาขา_ไท-บางใหญ่', 40000, 'IV-2610004');
  await S(5, 'DT2610/005', T, 'บ.ห้า', 'ปิดการขาย', 'Facebook', 'เพจ', 50000, 'IV2610005', { [PPAID]: 50000, [PSTAT]: 'ชำระครบแล้ว' });
  await S(6, 'DT2610/006', T, 'บ.หก', 'ปิดการขาย', 'B2B', 'LINE OA', 60000, 'QO-2610066 / IV-2610066');
  await S(7, 'DT2610/007', T, 'บ.เจ็ด', 'ปิดการขาย', 'Partner ร้านป้าย', '', 70000, 'IV-2610077');
  await S(8, 'DT2610/008', T, 'บ.แปด', 'ปิดการขาย', 'ผู้บริหารแนะนำ', '', 5000, 'QO-2610088');
  await S(9, 'DT2610/009', null, 'บ.เก้า', 'เสนอราคา', 'Facebook', 'เพจ', 90000, '', { 'ยอด งวด 1 (บาท)': 7000, 'วันที่โอน งวด 1': T });
  await S(10, 'DT2610/010', T, 'บ.สิบ', 'ปิดการขาย', 'Facebook', 'เพจ', 15000, 'IV-2610010', { [PPAID]: 0, [PSTAT]: 'ยังไม่ชำระ', 'ยอด (บาท)': 9000, 'วันที่โอน': T });
  await S(11, 'DT2610/011', T, 'ร้านสิบเอ็ด', 'ปิดการขาย', 'สาขามดงาน', 'สาขา_ไท-บางใหญ่', 54570, 'IV-2610011', { [PPAID]: 0, [PSTAT]: 'ยังไม่ชำระ', 'ยอด (บาท)': 54570, 'วันที่โอน': T });
  await S(12, 'DT2610/012', T, 'บ.สิบสอง', 'ปิดการขาย', 'B2B', 'LINE OA', 40000, 'IV2610012', { 'ยอด งวด 1 (บาท)': 20000, 'วันที่โอน งวด 1': T });

  const cf = (iv, dt, amt, rt, job, cust) => pg.query(
    `insert into app.cash_flow (key,paid_at,ym,iv,amount,wht,cash,receipt_no,customer,job_code,sale) values ($1,$2,$3,$4,$5,0,$5,$6,$7,$8,'crsale')`,
    [`${iv}|${dt}|${Math.round(amt * 100)}`, dt, dt.slice(0, 7), iv, amt, rt, cust || null, job || null]);
  await cf('IV-2610001', T, 10000, 'RT-01', 'DT2610/001', 'ร้านหนึ่ง');
  await cf('IV-2610002', T, 8000, 'RT-02', 'DT2610/002', 'ร้านสอง');
  await cf('IV-2609003', pStart, 15000, 'RT-03A', 'DT2609/003', 'ร้านสาม');
  await cf('IV-2609003', T, 15000, 'RT-03B', 'DT2609/003', 'ร้านสาม');
  await cf('IV-2610004', T, 12000, 'RT-04', 'DT2610/004', 'ร้านสี่');
  await cf('IV-2610005', T, 50000, 'RT-05', 'DT2610/005', 'บ.ห้า');
  await cf('IV-2610066', T, 25000, 'RT-06', 'DT2610/006', 'บ.หก');
  await cf('IV-2610077', T, 40000, 'RT-07B', 'DT2610/007', 'บ.เจ็ด');
  await cf('IV-2610070', T, 30000, 'RT-07A', 'DT2610/007', 'บ.เจ็ด');
  await cf('IV-2610088', T, 3000, 'RT-08A', 'DT2610/008', 'บ.แปด');
  await cf('IV-2610088', T, 2000, 'RT-08B', 'DT2610/008', 'บ.แปด');       /* 2 งวดของใบเดียวกัน — งวดหลังต้องไม่ถูกมองว่าซ้ำกับงวดแรก */
  await cf('IV-2610012', T, 20000, 'RT-12', 'DT2610/012', 'บ.สิบสอง');
  await cf('IV-2619999', T, 1234, 'RT-99', '', 'ใครไม่รู้');

  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  let app = null, browser = null;
  try {
    const CR = require('../modules/sales/cash-received');
    const w = { from: mStart, to: T, pFrom: pStart, pTo: pStart };

    if (!ONLY_SHOT) {
      head('① รับเงินจริง = เฉพาะที่ PEAK รับชำระแล้ว — "พี่ดูยอดรับชำระใน peak เป็นหลักนะ"');
      const R = await CR.cashReceived(w);
      const ch = k => R.channels[k].cur;
      ok(ch('สาขา').amount === 45000 && ch('สาขา').wait === 54570 && ch('สาขา').waitN === 1 && ch('สาขา').n === 4,
         `สาขา: รับเงินจริง 45,000 — งานที่เซลส์คีย์ "โอน 100%" 54,570 แต่ PEAK ยัง "ยังไม่ชำระ" ⇒ ไม่นับ แสดงแยก (ได้ ${ch('สาขา').amount} / ไม่นับ ${ch('สาขา').wait})`);
      ok(ch('Online').amount === 50000 && ch('Online').wait === 9000 && ch('Online').open === 7000,
         `Online: 50,000 จากยอดรับชำระ PEAK · ยอดโอน 9,000 ที่ PEAK ตอบ 0 ไม่นับ · สลิป 7,000 ของงานที่ยังไม่ปิดการขายไม่นับ`);
      ok(R.cur.wait === 63570 && R.cur.waitN === 2 && R.cur.open === 7000, `การ์ดรวม: ไม่นับ 63,570 (2 งวด) ที่เซลส์คีย์แต่ PEAK ยังไม่รับชำระ`);

      head('② ช่องทาง — มัดจำที่ PEAK รับชำระแล้ว เข้าช่องทางของงาน');
      ok(ch('สาขา').amount === 45000,
         `สาขา 45,000 = รับครบ 10,000 + มัดจำงานที่ปิดแล้ว 8,000 (PEAK รับชำระ 40% ของ 20,000) + งวดหลังของงานเดือนก่อน 15,000 + มัดจำงานที่ยังไม่ปิดการขาย 12,000`);
      ok(ch('Partner').amount === 70000, `Partner 70,000 = ใบแจ้งหนี้ในช่องเลขบิล 40,000 + ใบมัดจำอีกใบของงานเดียวกัน 30,000 (ได้ ${ch('Partner').amount})`);
      ok(ch('ผู้บริหาร').amount === 5000 && ch('ผู้บริหาร').n === 2, `ผู้บริหาร 5,000 (2 งวด 3,000 + 2,000) — ช่องเลขบิลมีแต่ QO · ใบเสร็จตามรอยด้วยรหัสงาน งวดหลังไม่ถูกตัดเป็นนับซ้ำ (ได้ ${ch('ผู้บริหาร').amount})`);
      ok(R.other.cur.amount === 1234 && R.other.cur.n === 1, `ไม่ระบุช่องทาง เหลือ 1,234 = ใบเสร็จที่หางานไม่เจอจริง ๆ (ได้ ${R.other.cur.amount})`);

      head('③ เงินก้อนเดียวกันนับครั้งเดียว');
      ok(ch('B2B').amount === 45000 && ch('B2B').wait === 0,
         `B2B 45,000 = 25,000 + มัดจำ 20,000 ที่ PEAK ออกใบเสร็จแล้ว (เลขบิลเขียนต่างกัน) · ยอดงวด 1 ที่เซลส์คีย์ไว้ 20,000 ไม่ไปโผล่เป็น "PEAK ยังไม่รับชำระ" เพราะ PEAK รับแล้ว (ได้ ${ch('B2B').amount})`);
      ok(R.cur.dup === 95000 && R.cur.dupN === 3 && R.other.cur.dup === 75000 && ch('B2B').dup === 20000,
         `ตัดของที่นับซ้ำออก 3 รายการ 95,000 = ใบเสร็จ 2 ใบ 75,000 + ยอดโอนที่คีย์ซ้อนกับใบเสร็จ 20,000`);
      const sumCh = CR.CHANNELS.reduce((a, k) => a + ch(k).amount, 0) + R.other.cur.amount;
      ok(R.cur.amount === 216234 && Math.abs(sumCh - R.cur.amount) < 0.01, `ยอดรวม 216,234 = ทุกช่องทาง + ไม่ระบุ พอดี (ได้ ${R.cur.amount})`);
      ok(JSON.stringify(R).indexOf('ร้านหนึ่ง') < 0 && JSON.stringify(R).indexOf('DT2610') < 0, 'เส้นยอดรวมยังไม่มีชื่อลูกค้า / รหัสงาน');

      head('④ ดูรายการ — สาขา');
      const D = await CR.cashReceivedDetail(w, 'สาขา');
      ok(D.ok && D.sum.amount === ch('สาขา').amount && D.sum.n === 4 && D.items.length === 4,
         `ผลรวมรายการ ${D.sum.amount} = ตัวเลขบนการ์ดสาขาทุกบาท · 4 งวด`);
      ok(D.sum.same.amount === 18000 && D.sum.before.amount === 15000 && D.sum.openJob.amount === 12000,
         `แยกให้เห็น: ของงานที่ปิดในช่วงนี้ 18,000 · ของงานที่ปิดก่อนหน้า 15,000 · มัดจำงานที่ยังไม่ปิดการขาย 12,000`);
      const C = D.cohort;
      ok(C.n === 3 && C.sale === 84570 && C.paid === 18000 && C.wait === 54570 && C.remain === 66570 && C.full === 1 && C.part === 1 && C.none === 1,
         `งานที่ปิดการขายในช่วงนี้ 3 งาน ยอดขาย 84,570 · PEAK รับชำระแล้ว 18,000 · PEAK ยังไม่รับชำระ 66,570 (ในนั้นเซลส์คีย์ว่าโอนแล้ว 54,570) · รับครบ 1 / รับบางส่วน 1 / PEAK ยังไม่รับชำระ 1`);
      const r2 = C.rows.find(x => x.job === 'DT2610/002');
      ok(r2 && r2.st === 'part' && r2.paid === 8000 && r2.remain === 12000 && r2.src === 'peak', 'งานที่เก็บมัดจำ 8,000 จาก 20,000 ขึ้น "รับบางส่วน" 40% (ที่มา: ใบเสร็จ PEAK)');
      const r11 = C.rows.find(x => x.job === 'DT2610/011');
      ok(r11 && r11.st === 'none' && r11.paid === 0 && r11.wait === 54570 && r11.pstat === 'ยังไม่ชำระ', 'งาน 011 ที่เซลส์คีย์โอน 100%: PEAK ยังไม่รับชำระ ⇒ รับแล้ว 0 · บอกว่าเซลส์คีย์ไว้ 54,570');
      ok(D.wait.n === 1 && D.wait.amount === 54570 && D.wait.rows[0].job === 'DT2610/011' && D.wait.rows[0].pstat === 'ยังไม่ชำระ' && D.wait.rows[0].ppaid === 0 && D.wait.rows[0].slot === 'เต็มจำนวน',
         'ตาราง "ไม่นับ": บอกงาน · ช่องที่เซลส์คีย์ (เต็มจำนวน) · สถานะใน PEAK ("ยังไม่ชำระ" รับชำระ 0) ให้บัญชีตาม');
      const it4 = D.items.find(x => x.job === 'DT2610/004');
      ok(it4 && it4.src === 'orphan' && it4.kind === 'openJob' && it4.how === 'iv' && it4.ch === 'สาขา' && it4.lead === 'Onprocess',
         'มัดจำของงานที่ยังไม่ปิดการขาย: ตามรอยด้วยเลขบิล → ช่องทางสาขา · บอกสถานะงาน (Onprocess)');
      const it1 = D.items.find(x => x.job === 'DT2610/001');
      ok(it1 && it1.from === 'สาขามดงาน' && it1.plat === 'สาขา_ไท-บางใหญ่' && it1.ref === 'RT-01' && it1.iv === 'IV-2610001' && it1.st === 'full',
         'ทุกงวดบอกอ้างอิง: ลูกค้ามาจากไหน + ชื่อช่อง ของแถวขาย · เลขบิล · เลขใบเสร็จ · สถานะรับเงินของงาน');
      ok(D.items.every(x => x.ch === 'สาขา' && x.src !== 'sheet'), 'ทุกงวดในรายการที่นับเป็นของช่องทางสาขา และไม่มียอดที่เซลส์คีย์เองปนอยู่');

      head('④ ดูรายการ — ไม่ระบุช่องทาง / ทุกช่องทาง / B2B');
      const O = await CR.cashReceivedDetail(w, 'other');
      ok(O.sum.amount === 1234 && O.sum.noRow.amount === 1234 && O.dup.n === 2 && O.dup.amount === 75000,
         `ไม่ระบุช่องทาง: นับ 1,234 (หางานไม่เจอ) · ตัดออกเพราะนับซ้ำ 2 ใบ 75,000`);
      const d5 = O.dup.rows.find(x => x.rcIv === 'IV-2610005'), d6 = O.dup.rows.find(x => x.rcIv === 'IV-2610066');
      ok(d5 && d5.job === 'DT2610/005' && d5.iv === 'IV2610005' && d5.paid === 50000 && d5.rowSrc === 'peak-amt' && d5.linkCh === 'Online',
         'ใบเสร็จ IV-2610005: ช่องเลขบิลของงานเขียน "IV2610005" (ไม่มีขีด) · แถวขายนับยอดรับชำระ PEAK 50,000 ไปแล้ว ⇒ ตัดออก');
      ok(d6 && d6.job === 'DT2610/006' && d6.rowSrc === 'peak' && d6.linkCh === 'B2B',
         'ใบเสร็จ IV-2610066: ช่องเลขบิลเขียน "QO… / IV…" · แถวขายนับใบเสร็จใบนี้ไปแล้ว ⇒ ตัดออก');
      const A = await CR.cashReceivedDetail(w, '');
      ok(A.sum.amount === 216234 && A.sum.n === R.cur.n && A.wait.amount === 63570 && A.wait.n === 2 && A.dup.amount === 95000 && A.dup.n === 3,
         `ทุกช่องทาง: ผลรวมรายการ ${A.sum.amount} = การ์ดรวม · ${A.sum.n} งวด · ไม่นับ (PEAK ยังไม่รับชำระ) 63,570 · ตัดซ้ำ 95,000`);
      ok(A.open.n === 1 && A.open.amount === 7000 && A.open.rows[0].job === 'DT2610/009' && A.open.rows[0].lead === 'เสนอราคา',
         'สลิป 7,000 ของงานที่ยังไม่ปิดการขาย (ไม่มีใบเสร็จ PEAK) — บอกไว้ ไม่บวกเข้ายอด');
      const B = await CR.cashReceivedDetail(w, 'B2B');
      const b12 = B.items.find(x => x.job === 'DT2610/012'), s12 = B.dup.rows.find(x => x.job === 'DT2610/012'), c12 = B.cohort.rows.find(x => x.job === 'DT2610/012');
      ok(b12 && b12.src === 'orphan' && b12.kind === 'closedJob' && b12.how === 'iv' && b12.amt === 20000 && s12 && s12.sup === 1 && s12.slot === 'งวด 1' && s12.amt === 20000 && B.wait.n === 0,
         'B2B งาน 012: นับใบเสร็จ PEAK 20,000 (ตามรอยด้วยเลขบิล) · ยอดงวด 1 ที่เซลส์คีย์ไม่ขึ้นเป็น "PEAK ยังไม่รับชำระ"');
      ok(c12 && c12.paid === 20000 && c12.wait === 0 && c12.st === 'part' && c12.src === 'peak', 'งาน 012: PEAK รับชำระแล้ว 20,000 จาก 40,000 = รับบางส่วน (มัดจำ 50%)');
      const P = await CR.cashReceivedDetail(w, 'Partner');
      ok(P.items.some(x => x.kind === 'otherIv' && x.rcIv === 'IV-2610070' && x.how === 'job') && P.cohort.rows[0].st === 'full' && P.cohort.rows[0].paid === 70000,
         'Partner: ใบมัดจำ IV-2610070 ตามรอยด้วยรหัสงาน (คนละใบกับช่องเลขบิล) เข้าช่องทาง Partner · งานรับครบ 70,000');
      let bad = null; try { await CR.cashReceivedDetail(w, 'ช่องทางมั่ว'); } catch (e) { bad = e; }
      ok(!!bad, 'ช่องทางที่ไม่รู้จัก ⇒ ปฏิเสธ');
    }

    head('⑤ เส้นทางจริง — สิทธิ์ + กระทบยอดกับหน้า Cash Flow');
    const env = { ...process.env, SUPABASE_URL: `http://127.0.0.1:${REST_PORT}`, SUPABASE_KEY: 'test-key',
      SESSION_SECRET: 'a'.repeat(64), NODE_ENV: 'development', PORT: String(APP_PORT), SYNC_ON_BOOT: '0', SYNC_EVERY_MIN: '0' };
    app = spawn('node', [path.join(APP_DIR, 'server.js')], { env, stdio: 'pipe', cwd: APP_DIR });
    let booted = false;
    app.stdout.on('data', d => { if (String(d).includes('พอร์ต')) booted = true; });
    app.stderr.on('data', () => {});
    for (let i = 0; i < 100 && !booted; i++) await sleep(200);
    const base = `http://127.0.0.1:${APP_PORT}`;
    const login = async who => {
      const r = await fetch(base + '/api/login', { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: who, password: 'test1234' }) });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      return sc.map(s => s.split(';')[0]).join('; ');
    };
    const boss = await login('crboss'), sale = await login('crsale');
    if (!ONLY_SHOT) {
      const get = async (u, c) => { const r = await fetch(base + u, { headers: { cookie: c }, redirect: 'manual' }); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };
      const jb = await get('/m/sales/api/dashboard/received?win=this', boss), js = await get('/m/sales/api/dashboard/received?win=this', sale);
      ok(jb.j.detail === true && js.j.detail === false && js.j.cur.amount === 216234, 'ยอดรวม: ทุกสิทธิ์เห็นเท่ากัน · เซิร์ฟเวอร์บอกว่าใครกด "ดูรายการ" ได้ (ผู้ดูแลระบบเท่านั้น)');
      const db_ = await get('/m/sales/api/dashboard/received/detail?win=this&ch=' + encodeURIComponent('สาขา'), boss);
      const ds = await get('/m/sales/api/dashboard/received/detail?win=this&ch=' + encodeURIComponent('สาขา'), sale);
      ok(db_.s === 200 && db_.j.ok && db_.j.sum.amount === 45000 && db_.j.wait.amount === 54570, 'ผู้ดูแลระบบ: เปิดรายการของสาขาได้ 45,000 (ไม่นับ 54,570 ที่ PEAK ยังไม่รับชำระ)');
      ok(ds.s === 403 && ds.j && ds.j.ok === false && JSON.stringify(ds.j).indexOf('ร้าน') < 0, 'เซลส์: เปิดรายการไม่ได้ (403) — ไม่มีชื่อลูกค้าหลุดออกไป');
      const dn = await fetch(base + '/m/sales/api/dashboard/received/detail?win=this', { redirect: 'manual' });
      ok(dn.status !== 200, 'ไม่ได้ล็อกอิน ⇒ เข้าไม่ได้');
      const dash = await get('/m/sales/api/dashboard?win=this', boss);
      const brSale = (dash.j.channel.channels || []).find(x => x.key === 'สาขา');
      ok(brSale && Number(brSale.amt) === db_.j.cohort.sale, `ยอดขายของงานที่ปิดในช่วงนี้ในหน้าดูรายการ (${db_.j.cohort.sale}) = ตัวเลขบนการ์ดยอดขายสาขา (${brSale && brSale.amt})`);
      /* 🔴 พิสูจน์: ยอดรวมยังเท่า "เงินเข้า" ของหน้า Cash Flow ⇒ ใบเสร็จ 2 ใบที่ชี้ว่าน่าจะนับซ้ำ หน้า Cash Flow ก็นับ 2 ครั้งเหมือนกัน */
      const CFR = await get('/m/sales/api/cashflow?months=2', boss);
      const mo = ym => ((CFR.j && CFR.j.months) || []).find(m => m.ym === ym) || {};
      const full = await get(`/m/sales/api/dashboard/received?win=custom&from=${mStart}&to=${mEnd}`, boss);
      const fc = full.j.cur, cashIn = mo(mStart.slice(0, 7)).cashIn;
      ok(CFR.j && CFR.j.ok && fc.amount === 216234 && Math.abs(cashIn - (fc.amount + fc.wait + fc.dup)) < 0.01,
         `ทั้งเดือนนี้กระทบยอดได้ทุกบาท: การ์ด ${fc.amount} + PEAK ยังไม่รับชำระ ${fc.wait} + ตัดซ้ำ ${fc.dup} = "เงินเข้า" ของหน้า Cash Flow ${cashIn}`);
      ok(cashIn === 374804,
         '🔴 หน้า Cash Flow ยังรายงานเงินเข้า 374,804 = รวมยอดที่ PEAK ยังไม่รับชำระ 63,570 + ของที่นับ 2 ครั้ง 95,000 (ไฟล์ cashflow.js ไม่ถูกแตะ)');
    }

    head('⑥ หน้าจอจริง — ปุ่ม "ดูรายการ"');
    const { chromium } = require('playwright');
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const FD = '/root/fonts-prompt/package/files/';
    let css = '';
    if (fs.existsSync(FD)) for (const wt of [400, 500, 600, 700, 800]) for (const [sub, rng] of [['thai', 'U+0E01-0E5B,U+200C-200D,U+25CC'], ['latin', 'U+0000-00FF,U+2000-206F,U+20AC,U+2212']]) {
      const f = FD + `prompt-${sub}-${wt}-normal.woff2`;
      if (fs.existsSync(f)) css += `@font-face{font-family:'Prompt';font-weight:${wt};src:url(data:font/woff2;base64,${fs.readFileSync(f).toString('base64')}) format('woff2');unicode-range:${rng}}\n`;
    }
    const open = async cookie => {
      const ctx = await browser.newContext({ viewport: { width: 1860, height: +process.env.SHOT_H || 1100 } });
      await ctx.addCookies(cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: base }; }));
      await ctx.route('**/fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: css }));
      await ctx.route('**/fonts.gstatic.com/**', r => r.abort());
      const p = await ctx.newPage();
      const errs = [];
      p.on('pageerror', e => errs.push(String(e)));
      await p.goto(base + '/m/sales/', { waitUntil: 'domcontentloaded' });
      await p.waitForFunction(() => { const e = document.getElementById('chdRecv'); return e && /(279,804|216,234)/.test(e.innerText); }, null, { timeout: 30000 });
      return { p, ctx, errs };
    };
    const A = await open(boss);
    if (process.env.SHOT_CARDS) await A.p.locator('#chDash').screenshot({ path: process.env.SHOT_CARDS });
    if (!ONLY_SHOT) {
      const cards = await A.p.evaluate(() => { const o = {}; document.querySelectorAll('#chDash .chd-recv').forEach(e => { o[e.getAttribute('data-rk') || 'รวม'] = e.innerText; }); return o; });
      ok(/45,000\.00/.test(cards['สาขา']) && /53\.2% ของยอดขาย/.test(cards['สาขา']) && /ไม่นับ: เซลส์คีย์ยอดโอนไว้ ฿54,570 \(1 งวด\) แต่ PEAK ยังไม่รับชำระ/.test(cards['สาขา']),
         'การ์ดสาขา: รับเงินจริง ฿45,000.00 = 53.2% · "ไม่นับ: เซลส์คีย์ยอดโอนไว้ ฿54,570 (1 งวด) แต่ PEAK ยังไม่รับชำระ"');
      ok(/216,234\.00/.test(cards['รวม']) && /ตามยอดรับชำระใน PEAK/.test(cards['รวม']) && /ไม่นับ: เซลส์คีย์ยอดโอนไว้ ฿63,570 \(2 งวด\)/.test(cards['รวม']) && /ไม่ระบุช่องทาง ฿1,234/.test(cards['รวม']),
         'การ์ดรวม: ฿216,234.00 · ตามยอดรับชำระใน PEAK · ไม่นับ ฿63,570 (2 งวด) · ไม่ระบุช่องทาง ฿1,234');
      ok(!/ไม่นับ/.test(cards['Partner']) && /70,000\.00/.test(cards['Partner']) && !/ไม่นับ/.test(cards['B2B']) && /45,000\.00/.test(cards['B2B']), 'ช่องทางที่ PEAK รับชำระครบตามที่คีย์ ไม่มีบรรทัด "ไม่นับ" (Partner ฿70,000.00 · B2B ฿45,000.00)');
      const nLink = await A.p.evaluate(() => document.querySelectorAll('#chDash .chd-recv-more a').length);
      ok(nLink === 6, `ผู้ดูแลระบบ: มีปุ่ม "ดูรายการ" ครบ 6 ใบ (ได้ ${nLink})`);
      const flt0 = await A.p.evaluate(() => document.getElementById('fltSource').value);
      await A.p.click('#chDash .chd-recv[data-rk="สาขา"] .chd-recv-more a');
      await A.p.waitForFunction(() => document.querySelector('#rcvItems tbody tr td b'), null, { timeout: 15000 });
      const mt = await A.p.evaluate(() => ({ title: document.getElementById('rcvTitle').innerText, body: document.getElementById('rcvBody').innerText,
        shown: !document.getElementById('rcvOv').classList.contains('hidden'), flt: document.getElementById('fltSource').value,
        nIt: document.querySelectorAll('#rcvItems tbody tr').length, nCo: document.querySelectorAll('#rcvCohort tbody tr').length, nW: document.querySelectorAll('#rcvWait tbody tr').length }));
      ok(mt.shown && /สาขามดงาน/.test(mt.title) && mt.nIt === 4 && mt.nCo === 3 && mt.nW === 1, `กดแล้วขึ้นหน้าต่าง "รับเงินจริง · สาขามดงาน" — งานที่ปิดในช่วงนี้ 3 งาน · นับ 4 งวด · ไม่นับ 1 งวด`);
      ok(mt.flt === flt0, 'กดปุ่มดูรายการ ไม่ไปกระตุ้นตัวกรองตารางของการ์ดช่องทาง');
      ok(/45,000\.00/.test(mt.body) && /ไม่นับ — เซลส์คีย์ไว้ แต่ PEAK ยังไม่รับชำระ\s*฿54,570\.00/.test(mt.body) && /มัดจำของงานที่ยังไม่ปิดการขาย/.test(mt.body),
         'หัวสรุป: รับเงินจริง ฿45,000.00 · ไม่นับ — เซลส์คีย์ไว้ แต่ PEAK ยังไม่รับชำระ ฿54,570.00 · มัดจำของงานที่ยังไม่ปิดการขาย');
      ok(/ยึดยอดรับชำระใน PEAK เป็นหลัก/.test(mt.body) && /ลูกค้ามาจากไหน: สาขามดงาน/.test(mt.body) && /ชื่อช่อง: สาขา_บางนา/.test(mt.body), 'บอกหลักการ (ยึดยอดรับชำระใน PEAK) + อ้างอิงของช่องทางทีละงวด');
      ok(/รับบางส่วน/.test(mt.body) && /รับครบ/.test(mt.body) && /1 \/ 1 \/ 1/.test(mt.body) && /40%/.test(mt.body), 'งานที่ปิดในช่วงนี้: รับครบ 1 / รับบางส่วน 1 / PEAK ยังไม่รับชำระ 1 · บอก % ที่ PEAK รับชำระของแต่ละงาน (มัดจำ 40%)');
      ok(/PEAK: ยังไม่ชำระ · รับชำระแล้ว ฿0/.test(mt.body) && /เต็มจำนวน/.test(mt.body), 'ตาราง "ไม่นับ": งาน 54,570 คีย์ช่องเต็มจำนวน · PEAK: ยังไม่ชำระ · รับชำระแล้ว ฿0');
      if (process.env.SHOT) await A.p.locator('#rcvOv .modal-box').screenshot({ path: process.env.SHOT });
      await A.p.click('#rcvOv .modal-x');
      await A.p.click('#chdRecv a.chd-recv-oth');                 /* "ดู ›" ของไม่ระบุช่องทางบนการ์ดรวม */
      await A.p.waitForFunction(() => /ไม่ระบุช่องทาง/.test(document.getElementById('rcvTitle').innerText) && document.querySelector('#rcvDup tbody tr.dup'), null, { timeout: 15000 });
      const ot = await A.p.evaluate(() => document.getElementById('rcvBody').innerText);
      ok(/ตัดออก — นับซ้ำ 2 รายการ ฿75,000\.00/.test(ot) && /IV2610005/.test(ot) && /IV-2610005/.test(ot), 'ไม่ระบุช่องทาง: ตาราง "ตัดออก — นับซ้ำ" 2 รายการ ฿75,000.00 พร้อมเลขบิลสองแบบให้เทียบ');
      if (process.env.SHOT_OTHER) await A.p.locator('#rcvOv .modal-box').screenshot({ path: process.env.SHOT_OTHER });
      ok(A.errs.length === 0, 'หน้าเว็บไม่มีข้อผิดพลาด JavaScript' + (A.errs.length ? ' — ' + A.errs[0] : ''));
      await A.ctx.close();
      const B = await open(sale);
      const sl = await B.p.evaluate(() => ({ n: document.querySelectorAll('#chDash .chd-recv-more a').length, a: document.querySelectorAll('#chdRecv a').length,
        t: document.querySelector('#chDash .chd-recv[data-rk="สาขา"]').innerText }));
      ok(sl.n === 0 && sl.a === 0 && /45,000/.test(sl.t) && /ไม่นับ: เซลส์คีย์ยอดโอนไว้/.test(sl.t), 'เซลส์: เห็นยอด + บรรทัด "ไม่นับ" เหมือนกัน แต่ไม่มีปุ่มดูรายการ');
      await B.ctx.close();
    } else {
      await A.ctx.close();
    }

    if (!ONLY_SHOT) {
      head('⑦ 🔒 อ่านอย่างเดียว');
      const cfNow = fs.readFileSync(path.join(__dirname, '..', 'modules', 'sales', 'cashflow.js'), 'utf8');
      ok(!/cash-received|รอบ 230|รอบ 231|รอบ 232/.test(cfNow), 'cashflow.js ไม่ถูกแตะ');
      const n1 = (await pg.query('select count(*)::int n from app.cash_flow')).rows[0].n;
      ok(n1 === 13, 'ตาราง app.cash_flow ยังมี 13 แถวเท่าเดิม');
    }
  } catch (e) {
    fail++; console.log('  ❌ ชุดทดสอบล้ม: ' + (e && e.stack || e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (app) app.kill();
    await rest.close();
    await pg.end();
  }
  console.log(`\n${fail ? '❌' : '✅'} ผ่าน ${pass} · ไม่ผ่าน ${fail}\n`);
  process.exit(fail ? 1 : 0);
})();
