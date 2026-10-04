'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  🧪 tools/test-cash-received.js — รอบ 228–232 · ยอดรับเงินจริงสะสมบนการ์ดยอดขาย (รวม + ทุกช่องทาง)
 *
 *  พี่เอ 3 ต.ค. 69
 *   รอบ 228: "เพิ่มยอดรับเงินจริงสะสมที่ sync data จาก peak ตามช่วงเวลาเดียวกันของยอดขายสะสมด้วย …"
 *            + "ตอนโหลดต้องรวดเร็ว ไม่ช้าด้วยนะ"
 *   รอบ 229: "เพิ่มการรับเงินจริงในแต่ละช่องทางด้านบนด้วยนะ"
 *            "ยอดรับเงินให้ดู Status ที่มีการตัดยอดรับชำระเหมือนกับ Cash flow เลยนะ" · สิทธิ์อื่น "ควรเห็น"
 *   รอบ 230: สาขาขึ้น 100% เพราะนับสลิปที่ PEAK ยังไม่ตัดยอด ⇒ นับเฉพาะที่ PEAK ตัดยอดแล้ว · สลิปแยกเป็น "รอ PEAK ตัดยอด"
 *            (ชุดดูรายการ + มัดจำเข้าช่องทาง + ตัดใบเสร็จนับซ้ำ อยู่ที่ tools/test-cash-received-detail.js)
 *   รอบ 231: (เข้าใจผิด — เอายอดโอนที่เซลส์คีย์มานับรวม)
 *   รอบ 232: "ถ้ารอ peak ยืนยัน ก้อคือเงินยังไม่ได้เข้า … พี่ดูยอดรับชำระใน peak เป็นหลักนะ" ⇒ นับเฉพาะที่ PEAK รับชำระแล้ว (กติกาสุดท้าย)
 *
 *  ① ตัวคิด (Postgres จริง → fake-postgrest → cash-received.js จริง): 3 ชั้นของ Cash Flow + ใบเสร็จกำพร้า + แยกช่องทาง
 *  ② ความเร็ว: อ่านฐานครั้งเดียวใช้ทุกช่วง · ตอบของที่จำไว้ก่อนแล้วคิดใหม่เบื้องหลัง · ขอเฉพาะช่องที่ใช้
 *  ③ เส้นทางจริง: เท่ากับ "เงินเข้า" ของหน้า Cash Flow เป๊ะ · ทุกสิทธิ์เห็น · ไม่มีข้อมูลรายใบ
 *  ④ หน้าจอจริง (Chromium): บล็อกบนการ์ดรวม + การ์ดช่องทาง 5 ใบ · การ์ดยอดขายไม่รอ
 *  ⑤ อ่านอย่างเดียว
 *  SHOT=<file> ⇒ เก็บภาพแถวการ์ด
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 55693, APP_PORT = 55694;
process.env.SUPABASE_URL = `http://127.0.0.1:${REST_PORT}`;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);
const { todayTH } = require('../core/thai-date');

(async () => {
  console.log('\n🧪 รอบ 228–232 — ยอดรับเงินจริงสะสมบนการ์ดยอดขาย (ยึดยอดรับชำระใน PEAK · แยกช่องทาง)\n');
  /* ── วันที่ของชุดทดสอบ (ยึดเวลาไทยตัวเดียวกับเซิร์ฟเวอร์) ── */
  const T = todayTH();
  const d0 = new Date(T + 'T00:00:00Z');
  const ymd = x => x.toISOString().slice(0, 10);
  const Y = d0.getUTCFullYear(), M = d0.getUTCMonth(), D = d0.getUTCDate();
  const mStart = ymd(new Date(Date.UTC(Y, M, 1)));
  const mEnd = ymd(new Date(Date.UTC(Y, M + 1, 0)));
  const tomorrow = ymd(new Date(d0.getTime() + 86400000));
  const pStart = ymd(new Date(Date.UTC(Y, M - 1, 1)));
  const pEndDay = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  const pSame = ymd(new Date(Date.UTC(Y, M - 1, Math.min(D, pEndDay))));
  const pEnd = ymd(new Date(Date.UTC(Y, M, 0)));
  const pOutOk = D < pEndDay;                       /* วันสิ้นเดือนก่อนอยู่ "นอก" ช่วงเทียบไหม */
  const old3 = ymd(new Date(Date.UTC(Y, M - 3, 10)));
  const PPAID = require('../modules/sales/peak-sync').COL.PPAID;

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

  /* ── ตารางขาย: ครบทุกชั้นของ _payEvents + ทุกช่องทาง ──────────────────────────────
   *  1 B2B       IV-A   ใบเสร็จ PEAK 100,000                          → ชั้น ① (สลิปที่คีย์ 90,000 ต้องไม่ถูกนับ)
   *  2 สาขา      IV-B   ใบเสร็จ PEAK 53,500 (หัก ณ ที่จ่าย 1,500) + ใบในกระจก 20,100 → ชั้น ①
   *  3 B2B       IV-C   เดือนก่อน: ใบเสร็จ 80,000 (ต้นเดือน) + 60,000 (สิ้นเดือน)
   *  4 Online    QO-4   ไม่มีใบเสร็จ · PEAK ตัดยอดแล้ว 30,000 · สลิป 20,000 + 20,000    → ชั้น ② เกลี่ยเป็น 15,000 + 15,000
   *  5 Partner   QO-5   ไม่มีอะไรจาก PEAK · สลิป 12,000                               → ชั้น ③
   *  6 ผู้บริหาร  QO-6   ยังไม่ปิดการขาย · สลิป 7,000                                  → ไม่นับ
   *  7 B2B       IV-OLD7 ปิดเมื่อ 3 เดือนก่อน · สลิป 33,000 วันนั้น                     → นอกช่วง */
  const S = (row, code, close, co, st, src, plat, sale, iv, more) => {
    const cols = Object.assign({ _row: row, 'รหัสงาน': code, 'วันที่ติดต่อ': close, 'วันที่ปิดการขาย': close, 'ชื่อบริษัท': co,
      'Create By': 'crsale', 'Lead Status': st, 'ประเภทลูกค้า': 'ลูกค้าใหม่', 'ลูกค้ามาจากไหน': src, 'ชื่อช่อง / Platform': plat,
      'ยอดขาย (บาท)': sale, 'เลขที่ QO / IV': iv }, more || {});
    const k = Object.keys(cols);
    return pg.query(`insert into app.total_sales (${k.map(c => '"' + c + '"').join(',')}) values (${k.map((_, i) => '$' + (i + 1)).join(',')})`, k.map(c => cols[c]));
  };
  await S(1, 'CR2610/001', mStart, 'บ.หนึ่ง', 'ปิดการขาย', 'B2B', 'LINE OA', 300000, 'IV-A', { 'ยอด งวด 1 (บาท)': 90000, 'วันที่โอน งวด 1': mStart });
  await S(2, 'CR2610/002', T, 'บ.สอง', 'ปิดการขาย', 'สาขามดงาน', 'สาขา_ไท-บางใหญ่', 200000, 'IV-B');
  await S(3, 'CR2609/003', pStart, 'บ.สาม', 'ปิดการขาย', 'B2B', '', 400000, 'IV-C');
  await S(4, 'CR2610/004', mStart, 'บ.สี่', 'ปิดการขาย', 'Facebook', 'เพจ', 100000, 'QO-4',
    { [PPAID]: 30000, 'ยอด งวด 1 (บาท)': 20000, 'วันที่โอน งวด 1': mStart, 'ยอด งวด 2 (บาท)': 20000, 'วันที่โอน งวด 2': T });
  await S(5, 'CR2610/005', T, 'บ.ห้า', 'ปิดการขาย', 'Partner ร้านป้าย', '', 50000, 'QO-5', { 'ยอด (บาท)': 12000, 'วันที่โอน': T });
  await S(6, 'CR2610/006', T, 'บ.หก', 'Onprocess', 'ผู้บริหารแนะนำ', '', 70000, 'QO-6', { 'ยอด (บาท)': 7000, 'วันที่โอน': T });
  await S(7, 'CR2607/007', old3, 'บ.เจ็ด', 'ปิดการขาย', 'B2B', '', 99000, 'IV-OLD7', { 'ยอด (บาท)': 33000, 'วันที่โอน': old3 });

  const cf = (iv, dt, amt, wht, cash, rt) => pg.query(
    `insert into app.cash_flow (key,paid_at,ym,iv,amount,wht,cash,receipt_no,customer,sale) values ($1,$2,$3,$4,$5,$6,$7,$8,'ลูกค้า','crsale')`,
    [`${iv}|${dt}|${Math.round(amt * 100)}`, dt, dt.slice(0, 7), iv, amt, wht, cash, rt]);
  await cf('IV-A', mStart, 100000, 0, 100000, 'RT-1');
  await cf('IV-B', T, 53500, 1500, 52000, 'RT-2');
  await cf('IV-B', tomorrow, 9999, 0, 9999, 'RT-X');           /* พรุ่งนี้ = นอกช่วง "ถึงวันนี้" */
  await cf('IV-C', pStart, 80000, 0, 80000, 'RT-3');
  await cf('IV-C', pEnd, 60000, 0, 60000, 'RT-4');
  await cf('IV-ORPH', T, 5000, 0, 5000, 'RT-5');               /* ใบเสร็จที่ไม่มีแถวคู่ในตารางขาย */
  const mir = (n, d) => pg.query(
    `insert into app.sheet_rows (source,file_key,sheet_id,tab,_row,data) values ('sales/PeakCashFlow','sales','SHEET-TEST','PeakCashFlow',$1,$2::jsonb)`,
    [n, JSON.stringify(d)]);
  await mir(2, { 'เลขที่ Invoice': 'IV-A', 'ยอดรับ (บาท)': 100000, 'วันที่รับเงิน': mStart, 'เลขที่ใบเสร็จ': 'RT-1' });   /* ซ้ำกับตาราง */
  await mir(3, { 'เลขที่ Invoice': 'iv-b', 'ยอดรับ (บาท)': '20,100', 'วันที่รับเงิน': T, 'เลขที่ใบเสร็จ': 'RT-M',
                 'ภาษีหัก ณ ที่จ่าย (งวดนี้)': 0, 'รับจริงหลังหักภาษี (งวดนี้)': 20100 });
  await mir(4, { 'เลขที่ Invoice': 'IV-ANCIENT', 'ยอดรับ (บาท)': 5555, 'วันที่รับเงิน': '2025-01-15', 'เลขที่ใบเสร็จ': 'RT-O' });

  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  let app = null, browser = null;
  try {
    const db = require('../core/db');
    const CR = require('../modules/sales/cash-received');
    const w = { from: mStart, to: T, pFrom: pStart, pTo: pSame };

    head('① ตัวคิด — เฉพาะที่ PEAK รับชำระแล้ว + แยกช่องทาง');
    const calls = [];
    const _sa = db.selectAll.bind(db);
    db.selectAll = (t, p, n) => { calls.push({ t, p: Object.assign({}, p) }); return _sa(t, p, n); };
    const R = await CR.cashReceived(w);
    ok(R.ok && R.cur.amount === 208600, `เดือนนี้รับจริงรวม 208,600 = ใบเสร็จ 173,600 + ยอดรับชำระ PEAK 30,000 + ใบเสร็จที่หางานไม่เจอ 5,000 — ยอดโอน 12,000 ที่เซลส์คีย์แต่ PEAK ยังไม่รับชำระ "ไม่นับ" (รอบ 232) (ได้ ${R.cur.amount})`);
    ok(R.cur.n === 6, `6 งวดรับเงิน — ใบที่อยู่ทั้งตารางและกระจกนับครั้งเดียว · สลิป 90,000 ของใบที่มีใบเสร็จแล้วไม่ถูกนับซ้ำ (ได้ ${R.cur.n})`);
    ok(R.channels['B2B'].cur.amount === 100000, 'B2B: 100,000 — ชั้น ① ใบเสร็จ PEAK ชนะสลิปที่เซลส์คีย์ไว้ 90,000');
    ok(R.channels['สาขา'].cur.amount === 73600 && R.channels['สาขา'].cur.n === 2, 'สาขา: 73,600 = ใบเสร็จในตาราง 53,500 + ใบที่มีแต่ในกระจก 20,100');
    ok(R.channels['Online'].cur.amount === 30000 && R.channels['Online'].cur.n === 2, 'Online: 30,000 — ชั้น ② ยอดที่ PEAK ตัดรับชำระแล้ว เกลี่ยลงวันที่ที่คีย์ (ไม่ใช่ 40,000 ตามสลิป)');
    ok(R.channels['Partner'].cur.amount === 0 && R.channels['Partner'].cur.wait === 12000 && R.channels['Partner'].cur.waitN === 1, 'Partner: รับเงินจริง 0 — เซลส์คีย์ยอดโอน 12,000 แต่ PEAK ยังไม่รับชำระ = เงินยังไม่เข้า ไม่นับ (รอบ 232: "พี่ดูยอดรับชำระใน peak เป็นหลักนะ")');
    ok(R.channels['ผู้บริหาร'].cur.amount === 0, 'ผู้บริหาร: 0 — งานที่ยังไม่ปิดการขายไม่ถูกนับ');
    ok(R.other.cur.amount === 5000 && R.other.cur.n === 1, 'ไม่ระบุช่องทาง: 5,000 — ใบเสร็จ PEAK ที่ไม่มีแถวในตารางขาย (ไม่เดาช่องทางให้)');
    const sumCh = CR.CHANNELS.reduce((a, k) => a + R.channels[k].cur.amount, 0) + R.other.cur.amount;
    ok(Math.abs(sumCh - R.cur.amount) < 0.01, `ทุกช่องทาง + ไม่ระบุ รวมกัน = ยอดรวมบนการ์ดรวมพอดี (${sumCh})`);
    ok(R.cur.wht === 1500 && R.cur.cash === 207100, `หัก ณ ที่จ่าย 1,500 ⇒ เข้าบัญชีจริง 207,100 (ได้ ${R.cur.cash})`);
    ok(R.cur.wait === 12000 && R.cur.waitN === 1 && R.cur.dup === 0 && R.channels['ผู้บริหาร'].cur.open === 7000 && R.cur.open === 7000,
       'แยกไว้ต่างหาก (ไม่นับ): เซลส์คีย์แต่ PEAK ยังไม่รับชำระ 12,000 (1 งวด) · สลิป 7,000 ของงานที่ยังไม่ปิดการขาย · ไม่มีของนับซ้ำ');
    ok(R.cur.last === T, 'วันที่รับเงินล่าสุด = วันนี้ (ใบของพรุ่งนี้ไม่นับ)');
    ok(R.prev.amount === (pOutOk ? 80000 : 140000) && R.channels['B2B'].prev.amount === R.prev.amount,
       `ช่วงเทียบ (เดือนก่อน ช่วงวันเดียวกัน) = ${pOutOk ? '80,000' : '140,000'} อยู่ที่ช่องทาง B2B (ได้ ${R.prev.amount})`);
    let bad = null;
    try { await CR.cashReceived({ from: 'x', to: T, pFrom: pStart, pTo: pSame }); } catch (e) { bad = e; }
    ok(!!bad, 'ช่วงวันที่ผิดรูปแบบ ⇒ ปฏิเสธ');
    /* สูตรช่องทาง: ตัวที่ยกมาเป็น JS ต้องตอบเหมือนฟังก์ชันในฐาน (app.sales_channel) ทุกกรณี */
    const cases = [['B2B', ''], ['b2b ลูกค้าองค์กร', 'x'], ['สาขามดงาน', 'สาขา_ไท-บางใหญ่'], ['สาขามดงาน', '  สาขา_บางนา '], ['สาขามดงาน', 'LINE'],
      ['ผู้บริหารแนะนำ', ''], ['Partner ร้านป้าย', ''], ['พาร์ทเนอร์', ''], ['Facebook', 'เพจ'], [null, null], ['', 'สาขา_x'], ['สาขา B2B', 'สาขา_y'], ['PARTNER b2b', '']];
    let same = 0;
    for (const [a, b] of cases) {
      const q = await pg.query('select app.sales_channel($1,$2) c', [a, b]);
      if (q.rows[0].c === CR._t.channelOf(a, b)) same++; else console.log('     ต่าง:', a, b, q.rows[0].c, CR._t.channelOf(a, b));
    }
    ok(same === cases.length, `สูตรช่องทางตรงกับฟังก์ชันในฐาน (app.sales_channel) ครบ ${same}/${cases.length} กรณี`);

    /* สูตรเจ้าของงาน (ชื่อบนอันดับ): ตัวที่ยกมาเป็น JS ต้องตอบเหมือน app.sales_owner ทุกกรณี (รอบ 230) */
    const PX = (await pg.query('select prefix, nickname from app.sales_prefix')).rows.sort((a, b) => b.prefix.length - a.prefix.length);
    const px0 = PX[0] || { prefix: 'ZZZZ', nickname: '' };
    const oc = [['(กุ๊งกิ๊ง) กุลกานต์ จึงวงศ์ไพบูลย์', 'X1'], ['ส้ม', 'X2'], ['  แว่น  ', 'X3'], ['', px0.prefix + '2610/001'], [null, px0.prefix.toLowerCase() + '2610/002'],
      ['', 'ไม่มีคำนำหน้า'], [null, null], ['()', px0.prefix + '1'], ['( ) ชื่อ', 'X'], ['(ก) (ข)', 'X'], ['ชื่อ (ในวงเล็บ)', 'X'], ['   ', '']];
    let sameO = 0;
    for (const [a, b] of oc) {
      const q = await pg.query('select app.sales_owner($1,$2) c', [a, b]);
      if (q.rows[0].c === CR._t.ownerOf(a, b, PX)) sameO++; else console.log('     ต่าง:', JSON.stringify(a), b, q.rows[0].c, CR._t.ownerOf(a, b, PX));
    }
    ok(sameO === oc.length, `สูตรเจ้าของงานตรงกับฟังก์ชันในฐาน (app.sales_owner) ครบ ${sameO}/${oc.length} กรณี`);

    head('② ความเร็ว — "ตอนโหลดต้องรวดเร็ว ไม่ช้าด้วยนะ"');
    const tabs = calls.map(c => c.t).sort().join(',');
    ok(calls.length === 4 && tabs === 'cash_flow,sales_prefix,sheet_rows,total_sales', `คิดครั้งแรกอ่านฐาน 4 ก้อน (ตารางขาย · ใบเสร็จ · กระจกแท็บเดิม · ทะเบียนคำนำหน้ารหัสงาน) — ได้ ${tabs}`);
    const cS = calls.find(c => c.t === 'total_sales');
    ok(String(cS.p.select) === CR.CR_SALES_COLS.map(c => '"' + c + '"').join(',') && CR.CR_SALES_COLS.length === 20,
       'ตารางขาย: ขอเฉพาะ 20 ช่องที่ตัวคิดอ่านจริง ไม่ใช่ select *');
    const R2 = await CR.cashReceived(w);
    const R3 = await CR.cashReceived({ from: pStart, to: pEnd, pFrom: old3, pTo: old3 });
    ok(calls.length === 4 && R2.cur.amount === 208600 && R3.ms < 50, `เรียกซ้ำ / เปลี่ยนช่วง ⇒ ไม่อ่านฐานเพิ่มเลย ตอบจากงวดรับเงินที่จำไว้ (${R3.ms} ms)`);
    ok(R3.cur.amount === 140000 && R3.prev.amount === 0 && R3.prev.wait === 33000, `เดือนที่แล้วทั้งเดือน 140,000 · ช่วงเทียบ: ยอดโอน 33,000 ที่ PEAK ไม่เคยรับชำระ = ไม่นับ (ได้ ${R3.cur.amount} / ${R3.prev.amount} / ไม่นับ ${R3.prev.wait})`);
    /* ของที่จำไว้เก่าเกิน 60 วิ ⇒ ตอบของเดิมทันที แล้วคิดใหม่เบื้องหลัง (คนเปิดหน้าไม่ต้องรอ) */
    await cf('IV-A', T, 1000, 0, 1000, 'RT-NEW');
    CR._t.age(2 * 60 * 1000);
    const t1 = Date.now(); const R4 = await CR.cashReceived(w); const ms4 = Date.now() - t1;
    ok(R4.stale === true && R4.cur.amount === 208600 && ms4 < 50, `ของที่จำไว้อายุ 2 นาที ⇒ ตอบของเดิมทันที (${ms4} ms) ไม่รอฐาน`);
    for (let i = 0; i < 40 && calls.length < 8; i++) await sleep(100);
    await sleep(150);
    const R5 = await CR.cashReceived(w);
    ok(calls.length === 8 && R5.cur.amount === 209600 && R5.stale === false, `แล้วคิดใหม่เบื้องหลัง 1 รอบ ⇒ คำขอถัดไปได้ยอดใหม่ 209,600 (ได้ ${R5.cur.amount})`);
    await pg.query(`delete from app.cash_flow where receipt_no = 'RT-NEW'`);
    /* ยาม: ทุกช่องที่ตัวคิดอ่านจากแถวขาย ต้องอยู่ในรายชื่อที่ขอจากฐาน (ไม่งั้นตัวเลขหายเงียบ ๆ) */
    const read = new Set();
    db.selectAll = async (t, p, n) => {
      const rows = await _sa(t, t === 'total_sales' ? Object.assign({}, p, { select: '*' }) : p, n);
      return t !== 'total_sales' ? rows : rows.map(r => new Proxy(r, { get(o, k) { if (typeof k === 'string') read.add(k); return o[k]; } }));
    };
    CR._t.reset();
    const R6 = await CR.cashReceived(w);
    const miss = [...read].filter(k => !CR.CR_SALES_COLS.includes(k) && k !== 'toJSON');
    ok(miss.length === 0 && read.size >= 10, `ทุกช่องที่ถูกอ่านจากแถวขาย (${read.size} ช่อง) อยู่ในรายชื่อที่ขอจากฐานครบ` + (miss.length ? ' — ขาด: ' + miss.join(', ') : ''));
    ok(JSON.stringify(R6.cur) === JSON.stringify(R.cur) && JSON.stringify(R6.channels) === JSON.stringify(R.channels),
       'อ่านแบบ select * กับแบบเลือก 20 ช่อง ได้ตัวเลขเท่ากันทุกตัว');
    db.selectAll = _sa;
    CR._t.reset();

    head('③ เส้นทางจริงของเซิร์ฟเวอร์ — เท่ากับหน้า Cash Flow · ทุกสิทธิ์เห็น');
    const env = { ...process.env, SUPABASE_URL: `http://127.0.0.1:${REST_PORT}`, SUPABASE_KEY: 'test-key',
      SESSION_SECRET: 'a'.repeat(64), NODE_ENV: 'development', PORT: String(APP_PORT), SYNC_ON_BOOT: '0', SYNC_EVERY_MIN: '0' };
    app = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'pipe' });
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
    ok(!!boss && !!sale, 'ล็อกอินได้ทั้งผู้ดูแลระบบและเซลส์');
    const dash = await (await fetch(base + '/m/sales/api/dashboard?win=this', { headers: { cookie: boss } })).json();
    const t2 = Date.now();
    const rr = await fetch(base + '/m/sales/api/dashboard/received?win=this', { headers: { cookie: boss } });
    const J = await rr.json();
    const msCold = Date.now() - t2;
    const t3 = Date.now();
    await (await fetch(base + '/m/sales/api/dashboard/received?win=3m', { headers: { cookie: boss } })).json();
    const msWarm = Date.now() - t3;
    ok(rr.status === 200 && J.ok && J.cur.amount === 208600, `ผู้ดูแลระบบ: ยอดรับจริง 208,600 (ครั้งแรก ${msCold} ms · ครั้งถัดไป ${msWarm} ms)`);
    ok(J.from === dash.win.from && J.to === dash.win.to && J.pFrom === dash.win.pFrom && J.pTo === dash.win.pTo,
       'ช่วงวันที่ + ช่วงเทียบ ตรงกับการ์ดยอดขาย (/api/dashboard) ทุกตัว');
    ok(Number(dash.channel.total) === 650000 && Math.round(J.cur.amount / dash.channel.total * 1000) / 10 === 32.1,
       'สัดส่วน รับจริง ÷ ยอดขาย = 208,600 ÷ 650,000 = 32.1%');
    /* 🔴 ยามกระทบยอดกับหน้า Cash Flow (รอบ 232): รับเงินจริง + เซลส์คีย์แต่ PEAK ยังไม่รับชำระ + ที่ตัดซ้ำออก = "เงินเข้า" ที่หน้า Cash Flow รายงานของเดือนเดียวกัน ทุกบาท */
    const whole = c => Math.round((c.amount + c.wait + c.dup) * 100) / 100;
    const CFR = await (await fetch(base + '/m/sales/api/cashflow?months=2', { headers: { cookie: boss } })).json();
    const mo = ym => (CFR.months || []).find(m => m.ym === ym) || {};
    const full = await (await fetch(base + `/m/sales/api/dashboard/received?win=custom&from=${mStart}&to=${mEnd}`, { headers: { cookie: boss } })).json();
    const fullP = await (await fetch(base + '/m/sales/api/dashboard/received?win=prev', { headers: { cookie: boss } })).json();
    ok(CFR.ok && Math.abs(mo(mStart.slice(0, 7)).cashIn - whole(full.cur)) < 0.01 && full.cur.amount > 0 && full.cur.wait === 12000,
       `ทั้งเดือนนี้: การ์ด ${full.cur.amount} + PEAK ยังไม่รับชำระ ${full.cur.wait} + ตัดซ้ำ ${full.cur.dup} = "เงินเข้า" ของหน้า Cash Flow ${mo(mStart.slice(0, 7)).cashIn}`);
    ok(Math.abs(mo(pStart.slice(0, 7)).cashIn - whole(fullP.cur)) < 0.01 && fullP.cur.amount === 140000 && fullP.from === pStart && fullP.to === pEnd,
       `ทั้งเดือนที่แล้ว: การ์ด ${fullP.cur.amount} = "เงินเข้า" ของหน้า Cash Flow ${mo(pStart.slice(0, 7)).cashIn}`);
    const rs = await fetch(base + '/m/sales/api/dashboard/received?win=this', { headers: { cookie: sale } });
    const js = await rs.json();
    ok(rs.status === 200 && js.cur.amount === 208600 && js.channels['B2B'].cur.amount === 100000, 'เซลส์: เห็นยอดเดียวกับผู้ดูแลระบบ (พี่เอสั่ง "ควรเห็น")');
    const flat = JSON.stringify(js);
    ok(!/บ\.หนึ่ง|บ\.สอง|IV-A|IV-B|RT-|crsale|CR2610/.test(flat), 'คำตอบมีแต่ยอดรวม — ไม่มีชื่อลูกค้า เลขบิล เลขใบเสร็จ รหัสงาน หรือชื่อเซลส์');
    const rn = await fetch(base + '/m/sales/api/dashboard/received?win=this', { redirect: 'manual' });
    ok(rn.status !== 200, 'ไม่ได้ล็อกอิน ⇒ เข้าไม่ได้');

    head('④ หน้าจอจริง — บล็อกรับเงินจริงบนการ์ดรวม + การ์ดช่องทางทุกใบ');
    const { chromium } = require('playwright');
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const FD = '/root/fonts-prompt/package/files/';
    let css = '';
    if (fs.existsSync(FD)) for (const wt of [400, 500, 600, 700, 800]) for (const [sub, rng] of [['thai', 'U+0E01-0E5B,U+200C-200D,U+25CC'], ['latin', 'U+0000-00FF,U+2000-206F,U+20AC,U+2212']]) {
      const f = FD + `prompt-${sub}-${wt}-normal.woff2`;
      if (fs.existsSync(f)) css += `@font-face{font-family:'Prompt';font-weight:${wt};src:url(data:font/woff2;base64,${fs.readFileSync(f).toString('base64')}) format('woff2');unicode-range:${rng}}\n`;
    }
    const open = async (cookie, hang) => {
      const ctx = await browser.newContext({ viewport: { width: 1860, height: 900 } });
      await ctx.addCookies(cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: base }; }));
      await ctx.route('**/fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: css }));
      await ctx.route('**/fonts.gstatic.com/**', r => r.abort());
      const p = await ctx.newPage();
      const log = [];
      p.on('request', q => { const u = q.url(); if (/\/api\/dashboard/.test(u)) log.push({ u, t: Date.now() }); });
      if (hang) await p.route('**/api/dashboard/received**', async r => { await sleep(2500); r.continue(); });
      await p.goto(base + '/m/sales/', { waitUntil: 'domcontentloaded' });
      return { p, ctx, log };
    };
    const blk = (p, k) => p.evaluate(key => { const e = document.querySelector('#chDash .chd-recv[data-rk="' + key + '"]');
      return e ? { d: getComputedStyle(e).display, t: e.innerText } : null; }, k);
    /* ผู้ดูแลระบบ + หน่วงเส้นรับเงิน 2.5 วิ — การ์ดยอดขายต้องขึ้นก่อนโดยไม่รอ */
    const A = await open(boss, true);
    await A.p.waitForFunction(() => { const e = document.querySelector('#chDash .chd-card.total .chd-amt'); return e && /650,000/.test(e.textContent); }, null, { timeout: 30000 });
    const early = await blk(A.p, '');
    ok(early && early.d === 'none', 'การ์ดยอดขายขึ้นทันที ฿650,000 ทั้งที่เส้นรับเงินยังไม่ตอบ (ไม่รอกัน)');
    await A.p.waitForFunction(() => getComputedStyle(document.getElementById('chdRecv')).display !== 'none', null, { timeout: 15000 });
    const tt = (await blk(A.p, '')).t;
    ok(/รับเงินจริง/.test(tt) && /208,600\.00/.test(tt) && /32\.1% ของยอดขาย/.test(tt), 'การ์ดรวม: 💵 รับเงินจริง ฿208,600.00 = 32.1% ของยอดขาย');
    ok(/ตามยอดรับชำระใน PEAK · 6 งวด/.test(tt), 'บอกเกณฑ์: ตามยอดรับชำระใน PEAK · 6 งวด');
    ok(/หลังหัก ณ ที่จ่าย/.test(tt) && /207,100/.test(tt), 'ยอดเข้าบัญชีหลังหัก ณ ที่จ่าย ฿207,100');
    ok(/ไม่นับ: เซลส์คีย์ยอดโอนไว้ ฿12,000 \(1 งวด\) แต่ PEAK ยังไม่รับชำระ/.test(tt),
       'แยกให้เห็น: "ไม่นับ: เซลส์คีย์ยอดโอนไว้ ฿12,000 (1 งวด) แต่ PEAK ยังไม่รับชำระ"');
    ok(/ไม่ระบุช่องทาง/.test(tt) && /5,000/.test(tt), 'บอกยอดที่ไม่ระบุช่องทาง ฿5,000 (ผลรวมช่องทางจึงกระทบยอดรวมได้)');
    ok(/เทียบเดือนก่อน ช่วงวันเดียวกัน/.test(tt) && (pOutOk ? /80,000/.test(tt) : /140,000/.test(tt)), 'เทียบช่วงเดียวกันของเดือนก่อนแบบเดียวกับยอดขาย');
    const b2b = await blk(A.p, 'B2B'), br = await blk(A.p, 'สาขา'), on = await blk(A.p, 'Online'), pa = await blk(A.p, 'Partner'), ex = await blk(A.p, 'ผู้บริหาร');
    ok(b2b && b2b.d !== 'none' && /100,000\.00/.test(b2b.t) && /33\.3% ของยอดขาย/.test(b2b.t), 'การ์ด B2B: รับจริง ฿100,000.00 = 33.3% ของยอดขายช่องทางนี้');
    ok(br && /73,600\.00/.test(br.t) && /36\.8% ของยอดขาย/.test(br.t), 'การ์ดสาขามดงาน: ฿73,600.00 = 36.8%');
    ok(on && /30,000\.00/.test(on.t) && /30% ของยอดขาย/.test(on.t) && pa && /฿0\.00/.test(pa.t) && /0% ของยอดขาย/.test(pa.t) && /ไม่นับ: เซลส์คีย์ยอดโอนไว้ ฿12,000/.test(pa.t), 'การ์ด Online ฿30,000.00 = 30% · Partner ฿0.00 = 0% + "ไม่นับ: เซลส์คีย์ยอดโอนไว้ ฿12,000"');
    ok(ex && ex.d !== 'none' && /฿0\.00/.test(ex.t) && !/ของยอดขาย/.test(ex.t), 'การ์ดจากผู้บริหาร: ฿0.00 (ไม่มียอดขาย จึงไม่ขึ้น %)');
    ok(/เทียบเดือนก่อน/.test(b2b.t) && /ยังไม่มียอดเทียบ/.test(on.t), 'แต่ละช่องทางเทียบช่วงก่อนหน้าของตัวเอง (B2B มียอดเทียบ · Online ยังไม่มี)');
    const nBlk = await A.p.evaluate(() => document.querySelectorAll('#chDash .chd-recv').length);
    ok(nBlk === 6, `มีบล็อกครบ 6 ใบ = การ์ดรวม 1 + ช่องทาง 5 (ได้ ${nBlk})`);
    const iD = A.log.findIndex(x => /\/api\/dashboard\?/.test(x.u)), iR = A.log.findIndex(x => /\/api\/dashboard\/received/.test(x.u));
    ok(iD >= 0 && iR > iD && A.log.filter(x => /\/api\/dashboard\/received\?/.test(x.u)).length === 1, 'ลำดับคำขอ: /api/dashboard ก่อน แล้วค่อย /api/dashboard/received — คำขอเดียวได้ครบทั้ง 6 ใบ');
    await A.p.evaluate(() => loadDash(true));
    await A.p.waitForTimeout(700);
    const again = await blk(A.p, 'B2B');
    ok(again.d !== 'none' && /100,000/.test(again.t), 'รอบอัปเดตเอง: ตัวเลขขึ้นทันทีจากค่าที่จำไว้ ไม่หายระหว่างรอ');
    await A.p.selectOption('#dashWin', 'prev');
    await A.p.waitForFunction(() => /140,000/.test(document.getElementById('chdRecv').innerText), null, { timeout: 20000 });
    const pb = await blk(A.p, 'B2B');
    ok(/140,000\.00/.test(pb.t) && /35% ของยอดขาย/.test(pb.t), 'เปลี่ยนเป็น "เดือนที่แล้ว" ⇒ B2B 140,000 = 35% ของยอดขาย 400,000');
    await A.p.selectOption('#dashWin', 'this');
    await A.p.waitForFunction(() => /208,600/.test(document.getElementById('chdRecv').innerText), null, { timeout: 20000 });
    if (process.env.SHOT) await A.p.locator('#chDash').screenshot({ path: process.env.SHOT });
    await A.ctx.close();
    /* เซลส์: เห็นเหมือนกัน */
    const B = await open(sale, false);
    await B.p.waitForFunction(() => { const e = document.getElementById('chdRecv'); return e && /208,600/.test(e.innerText); }, null, { timeout: 30000 });
    const sb = await blk(B.p, 'สาขา');
    ok(sb.d !== 'none' && /73,600/.test(sb.t), 'เซลส์: เห็นบล็อกรับเงินจริงทั้งการ์ดรวมและการ์ดช่องทาง');
    await B.ctx.close();

    head('⑤ 🔒 อ่านอย่างเดียว');
    const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'sales', 'cash-received.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    ok(!/\bdb\.(upsert|insert|update|remove|delete|rpc|rest|patch)\s*\(/.test(src) && /\bdb\.selectAll\(/.test(src) && !/core\/peak['"]/.test(src),
       'cash-received.js: ไม่มีคำสั่งเขียนฐาน และไม่เรียก PEAK สด');
    ok(/CF\._payEvents\(/.test(src), 'ใช้ตัวคิดงวดรับเงิน (_payEvents) ตัวเดียวกับหน้า Cash Flow — ไม่เขียนสูตรคิดเงินใหม่');
    const cfNow = fs.readFileSync(path.join(__dirname, '..', 'modules', 'sales', 'cashflow.js'), 'utf8');
    ok(!/cash-received|รอบ 229|รอบ 230|รอบ 231|รอบ 232/.test(cfNow), 'cashflow.js ไม่ถูกแตะในรอบนี้ (หน้า Cash Flow ทำงานด้วยไฟล์เดิมทุกบรรทัด)');
    const n1 = (await pg.query('select count(*)::int n from app.cash_flow')).rows[0].n;
    ok(n1 === 6, 'ตาราง app.cash_flow ยังมี 6 แถวเท่าเดิมหลังใช้งานทั้งหมด');
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
