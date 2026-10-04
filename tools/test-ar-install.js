'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  🧪 tools/test-ar-install.js — รอบ 202 · การ์ดลูกหนี้: รูปเซลส์ + งานติดตั้ง (ช่าง · วันเวลา · สถานะจบงาน · ภาพจบงาน/หน้างาน)
 *
 *  พี่เอ 1 ต.ค. 69: "ในหน้าลูกหนี้ค้างชำระ เพิ่มการแสดงรูปพนักงานขาย , ชื่อ รูปช่างติดตั้ง วันที่ เวลาที่เข้าติดตั้ง
 *    และสถานะการจบงาน เพื่อตรวจสอบติดตามการเก็บเงิน" + "รูปการจบงาน หรือภาพหน้างานด้วย"
 *
 *  ① เซิร์ฟเวอร์ (Postgres จริง → fake-postgrest → ar-install.js จริง)
 *     · ใบขาย → ใบงาน (IV ก่อน · รหัสงาน) → คิว (SourceProjectID = ProjectID หรือ requirement_id งานย่อย)
 *     · สถานะ: จบงาน (Status/ช่างจบงานเมื่อ/เซ็นรับ) · เลยวันนัด · รอติดตั้ง · ยังไม่ได้คิว · ปิด/ยกเลิก
 *     · ชื่อช่าง (หัวหน้า + ผู้ช่วย) · วัน+เวลาเวลาไทย · รูปช่าง · ภาพจบงาน · ภาพหน้างาน · รูปเซลส์ (user_photo)
 *     · ‼ ไม่มีช่องเงินของคิวในคำตอบ · สิทธิ์รายใบ · อ่านอย่างเดียว
 *  ② หน้าจอ (Chromium · index.html จริง · API จำลอง)
 *  SHOT=<file> ⇒ เก็บภาพการ์ด
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const fs = require('fs');
const http = require('http');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 55593;
process.env.SUPABASE_URL = `http://127.0.0.1:${REST_PORT}`;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const D = n => 'https://drive.google.com/file/d/ZZAIIMG' + String(n).padStart(26, '0') + '/view';

(async () => {
  console.log('\n🧪 รอบ 202 — การ์ดลูกหนี้: รูปเซลส์ + งานติดตั้ง\n');
  const { Client } = require('pg');
  const pg = new Client({ connectionString: PG });
  await pg.connect();
  await pg.query('truncate app.total_sales');
  await pg.query(`delete from app.projects where "ID" like 'ZZAI-%'`);
  await pg.query(`delete from app.requirements where requirement_id like 'ZZAI-%'`);
  await pg.query(`truncate app.installation_plan, app.inspectors`);
  await pg.query(`delete from app.job_deliveries where "ProjectID" like 'ZZAI-%'`);
  await pg.query(`delete from app.user_photo where username in ('kukkik','kaem')`);
  await pg.query(`insert into app.total_sales (_row,"รหัสงาน","ชื่อบริษัท","Create By","Sales Code","Lead Status","เลขที่ QO / IV","เลขใบแจ้งหนี้ Peak") values
     (1,'B2G2609/014','บริษัท โรบินสัน จำกัด','kukkik','kukkik','ปิดการขาย','QO-69091700002',null),
     (2,'B2G2608/022','บริษัท เอสคิวไอ จำกัด','kukkik','kukkik','ปิดการขาย','IV-2026082500011','IV-2026082500011'),
     (3,'B2G2607/002','บริษัท รอติดตั้ง จำกัด','kukkik','kukkik','ปิดการขาย','QO-69070300001',null),
     (4,'B2G2607/016','บริษัท ยังไม่จอง จำกัด','kukkik','kukkik','ปิดการขาย','QO-69071600001',null),
     (5,'B2G2606/099','บริษัท ไม่มีใบงาน จำกัด','kukkik','kukkik','ปิดการขาย','QO-69069900001',null),
     (6,'QE2609/040','บริษัท ของแก้ม จำกัด','kaem','kaem','ปิดการขาย','IV-2026092900040',null),
     (7,'B2G2605/005','บริษัท ยกเลิกคิว จำกัด','kukkik','kukkik','ปิดการขาย','QO-69050500001',null),
     (8,'B2E2609/018','Pet Club','kukkik','kukkik','ปิดการขาย','QO-2026092200007',null),
     (9,'B2E2609/018','บริษัท มีคลาส จำกัด','kukkik','kukkik','ปิดการขาย','IV-2026092100014','IV-2026092100014')`);
  /* 💰 เงินเข้า (มัดจำ) — โรบินสัน: งวด 1 · 17 ส.ค. 69 · ไม่มีใบงาน: รับเงินก้อนเดียว 1 ก.ย. */
  await pg.query(`update app.total_sales set "วันที่โอน งวด 1"='2026-08-17', "ยอด งวด 1 (บาท)"=50000, "วันที่โอน งวด 2"='2026-09-30', "ยอด งวด 2 (บาท)"=20000 where _row=1`);
  await pg.query(`update app.total_sales set "วันที่โอน"='2026-09-01', "ยอด (บาท)"=12000 where _row=5`);
  /* 🚚 แผนจัดส่ง — P1: ยกเลิก 1 ใบ (ไม่นับ) + ตามแผน 24 ก.ย. · P4: ส่งจริง 20 ก.ย. */
  await pg.query(`insert into app.job_deliveries (_row,"DeliveryID","ProjectID","PlannedDate","Status","DeliveredAt","ShippingCost") values
     (990301,'DLV-ZZ1','ZZAI-P1','2026-09-28','ยกเลิก',null,999),
     (990302,'DLV-ZZ2','ZZAI-P1','2026-09-24','รอจัดส่ง',null,999),
     (990303,'DLV-ZZ4','ZZAI-P4','2026-09-19','ส่งแล้ว','2026-09-20T03:00:00Z',999)`);
  await pg.query(`insert into app.user_photo (username,url,path) values ('kukkik','https://cdn.test/kukkik.jpg','u/kukkik.jpg')`).catch(async () => {
    await pg.query(`insert into app.user_photo (username,url) values ('kukkik','https://cdn.test/kukkik.jpg')`);
  });
  const P = (row, id, name, status, slip) => pg.query(
    `insert into app.projects (_row,"ID","Project","Status","เลขที่ Slip ชำระเงิน") values ($1,$2,$3,$4,$5)`, [row, id, name, status, slip || null]);
  await P(990201, 'ZZAI-P1', 'B2G2609/014 ป้ายโรบินสัน', 'Complete');
  await P(990202, 'ZZAI-P2', 'งานเอสคิวไอ หน้าร้าน', 'In Progress', 'IV-2026082500011');
  await P(990203, 'ZZAI-P2B', 'B2G2608/022 งานอื่นรหัสเดียวกัน', 'Complete');
  await P(990204, 'ZZAI-P3', 'B2G2607/002 ป้ายรอติดตั้ง', 'In Progress');
  await P(990205, 'ZZAI-P4', 'B2G2607/016 ป้ายยังไม่จอง', 'In Progress');
  await P(990206, 'ZZAI-P6', 'QE2609/040 งานของแก้ม', 'Complete');
  await P(990207, 'ZZAI-P7', 'B2G2605/005 งานยกเลิกคิว', 'In Progress');
  /* 🔴 รอบ 203 — เคสจริง: ใบงานของมีคลาส (Slip มี IV ของมีคลาส) · Pet Club รหัสงานชนกัน แต่เลขเอกสารคนละใบ */
  await P(990209, 'ZZAI-P9', 'B2E2609/018 ป้ายมีคลาส VIENUS', 'Complete', 'IV-2026092100014');
  await pg.query(`insert into app.requirements (_row,requirement_id,project_id) values (990291,'ZZAI-R2','ZZAI-P2'),(990292,'ZZAI-R2B','ZZAI-P2B')`);
  await pg.query(`insert into app.inspectors (_row,"ID","ชื่อ","ชื่อเล่น","เบอร์โทร") values
     (1,'T1','ช่างต้น','ต้น','080'),(2,'T2','ช่างเอก','เอก','081'),(3,'T3','ช่างนัท','นัท','082')`);
  const Q = (row, id, src, date, team, extra) => {
    const e = extra || {};
    const cols = ['_row', 'ID', 'SourceProjectID', 'แผนวันที่ติดตั้ง', 'ช่างติดตั้ง', 'Status', 'ค่าติดตั้งงาน', 'ค่าจ้างช่างนอก', 'กำไร/ขาดทุน'];
    const vals = [row, id, src, date, team, e.status || 'จองคิวช่างรอยืนยัน', 7777, 5555, 2222];
    for (const k of Object.keys(e)) if (k !== 'status') { cols.push(k); vals.push(e[k]); }
    return pg.query(`insert into app.installation_plan (${cols.map(c => '"' + c + '"').join(',')}) values (${vals.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
  };
  /* ① โรบินสัน: จบงานแล้ว · ทีม ต้น + เอก · เซ็นรับ · ภาพจบงาน 2 + ภาพหน้างาน 1 · มีนัดดูหน้างานก่อนหน้า */
  await Q(1, 'IP-001', 'ZZAI-P1', '2026-09-26T02:00:00Z', 'T1', { status: 'จบงาน', 'ช่างติดตั้ง2': 'T2', 'เวลาจบงาน': '16:00',
    'ช่างจบงานเมื่อ': '2026-09-26T09:30:00Z', 'ผู้เซ็นรับงาน': 'คุณสมชาย', 'ภาพจบงาน': D(1), 'ภาพจบงาน 2': D(2), 'ภาพหน้างาน 1': D(3) });
  await Q(2, 'IP-001_SV', 'ZZAI-P1', '2026-09-10T03:00:00Z', 'T3', { 'ประเภทงาน': 'เช็คหน้างาน/วางไกด์' });
  /* ② เอสคิวไอ: คิวของงานย่อย (requirement_id) · วันผ่านไปแล้วยังไม่จบ = เลยวันนัด · คิวของใบงานที่ตรงแค่รหัสงานต้องไม่ปน */
  await Q(3, 'IP-002', 'ZZAI-R2', '2026-09-20T01:30:00Z', 'T2', {});
  await Q(4, 'IP-002B', 'ZZAI-R2B', '2026-09-21T01:30:00Z', 'T3', {});
  /* ③ รอติดตั้ง (อนาคต) */
  await Q(5, 'IP-003', 'ZZAI-P3', '2026-10-05T02:00:00Z', 'T3', { 'ช่างติดตั้ง2': 'T1', 'เวลาจบงาน': '15:00' });
  /* ④ ยังไม่ได้วัน/ช่าง */
  await Q(6, 'IP-004', 'ZZAI-P4', null, null, {});
  /* ⑥ ของแก้ม */
  await Q(7, 'IP-006', 'ZZAI-P6', '2026-09-27T02:00:00Z', 'T1', { status: 'จบงาน' });
  /* ⑨ มีคลาส — รอติดตั้ง + ภาพหน้างาน */
  await Q(9, 'IP-009', 'ZZAI-P9', '2026-10-02T03:00:00Z', 'T3', { 'ภาพหน้างาน 1': D(9) });
  /* ⑦ ยกเลิกคิว */
  await Q(8, 'IP-007', 'ZZAI-P7', '2026-09-15T02:00:00Z', 'T1', { 'ปิดงานเมื่อ': '2026-09-14T02:00:00Z', 'เหตุผลปิดงาน': 'ลูกค้าเลื่อนไม่มีกำหนด' });

  /* 🔴 รอบ 225 — เคสจริง 3 ต.ค. 69: การ์ด "ดี ทรี" (B2E2609/019 · IV-2026092900011) ได้นัดดูหน้างานของใบงาน c54f6bb4 ซึ่งเป็นของ "รมัย คอร์ป" */
  await pg.query(`insert into app.total_sales (_row,"รหัสงาน","ชื่อบริษัท","Create By","Sales Code","Lead Status","เลขที่ QO / IV","เลขใบแจ้งหนี้ Peak") values
     (10,'B2E2609/019','บริษัท ดี ทรี จำกัด','kukkik','kukkik','ปิดการขาย','IV-2026092900011','IV-2026092900011'),
     (11,'B2E2609/021','บริษัท ดี ทรี จำกัด','kukkik','kukkik','ปิดการขาย','IV-2026092900021','IV-2026092900021'),
     (12,'B2E2609/022','บริษัท ซีทรู จำกัด','kukkik','kukkik','ปิดการขาย','QO-2026092900022',null),
     (13,'B2E2609/023','บริษัท เดลต้า จำกัด','kukkik','kukkik','ปิดการขาย','QO-2026092900023',null),
     (14,'B2E2609/024','บริษัท อัลฟ่า จำกัด','kukkik','kukkik','ปิดการขาย','QO-2026092900024',null),
     (15,'B2E2609/025','บริษัท ดี ทรี จำกัด','kukkik','kukkik','ปิดการขาย','IV-2026092900025','IV-2026092900025')`);
  const PC = (row, id, name, status, slip, cust, img) => pg.query(
    `insert into app.projects (_row,"ID","Project","Status","เลขที่ Slip ชำระเงิน","แสดงชื่อลูกค้า","Image Complete","Complete") values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [row, id, name, status, slip || null, cust || null, img || null, status === 'Complete' ? '2026-09-30' : null]);
  await PC(990210, 'ZZAI-C54', 'B2E2609/019 ดูหน้างาน ป้ายหน้าอาคาร', 'In Progress', null, 'บริษัท รมัย คอร์ป จำกัด');            /* ⑩ รหัสงานของ ดี ทรี ไปติดอยู่บนใบงานของ รมัย */
  await PC(990211, 'ZZAI-P11', 'งานป้ายชั้น 2', 'Complete', 'IV-2026092900021', 'บริษัท รมัย คอร์ป จำกัด', D(11));                 /* ⑪ เลข IV ของ ดี ทรี ไปติดอยู่ในช่อง Slip ของใบงาน รมัย */
  await PC(990212, 'ZZAI-P12', 'B2E2609/022 ป้ายซีทรู', 'Complete', null, 'บจก. ซีทรู (สาขา 2)', D(12));                          /* ⑫ ลูกค้ารายเดียวกัน เขียนชื่อต่างกัน */
  await PC(990213, 'ZZAI-P13', 'B2E2609/023 ป้ายหน้าร้าน', 'In Progress', null, null);                                          /* ⑬ ใบงานไม่มีชื่อลูกค้า แต่คิวเป็นของรายอื่น */
  await PC(990214, 'ZZAI-P14', 'B2E2609/024 ป้ายหน้าร้าน', 'In Progress', null, null);                                          /* ⑭ ไม่มีชื่อทั้งใบงานและคิว = กติกาเดิม */
  await PC(990215, 'ZZAI-P15A', 'งานของรมัย', 'In Progress', 'IV-2026092900025', 'บริษัท รมัย คอร์ป จำกัด');                      /* ⑮ ใบงานผิดราย (ทาง IV) + ใบงานถูกราย (ทางรหัสงาน) */
  await PC(990216, 'ZZAI-P15B', 'B2E2609/025 ป้ายดีทรี', 'In Progress', null, 'บริษัท ดี ทรี จำกัด');
  await Q(10, 'AUTO_ZZAI-C54_SV', 'ZZAI-C54', '2026-10-01T03:00:00Z', 'T3', { 'ประเภทงาน': 'เช็คหน้างาน/วางไกด์', 'ช่างติดตั้ง2': 'T2', 'เวลาจบงาน': '11:30', 'แสดงชื่อลูกค้า': 'บริษัท รมัย คอร์ป จำกัด' });
  await Q(11, 'IP-011', 'ZZAI-P11', '2026-10-02T02:00:00Z', 'T1', { 'แสดงชื่อลูกค้า': 'บริษัท รมัย คอร์ป จำกัด' });
  await Q(12, 'IP-012', 'ZZAI-P12', '2026-10-06T02:00:00Z', 'T1', { 'แสดงชื่อลูกค้า': 'บจก. ซีทรู (สาขา 2)' });
  await Q(13, 'IP-013', 'ZZAI-P13', '2026-10-07T02:00:00Z', 'T2', { 'แสดงชื่อลูกค้า': 'บริษัท รมัย คอร์ป จำกัด' });
  await Q(14, 'IP-014', 'ZZAI-P14', '2026-10-08T02:00:00Z', 'T2', {});
  await Q(15, 'IP-015A', 'ZZAI-P15A', '2026-10-09T02:00:00Z', 'T1', { 'แสดงชื่อลูกค้า': 'บริษัท รมัย คอร์ป จำกัด' });
  await Q(16, 'IP-015B', 'ZZAI-P15B', '2026-10-10T02:00:00Z', 'T3', { 'แสดงชื่อลูกค้า': 'บริษัท ดี ทรี จำกัด' });
  /* 🔴 รอบ 226 — เช็ค PEAK ก่อนเชื่อเลข IV บนใบงาน: ⑯ ชื่อเขียนคนละแบบแต่เลข IV ไม่เคยถูกยกเลิก · ⑰ ใบแจ้งหนี้ของใบขายเองถูกยกเลิก */
  await pg.query(`insert into app.total_sales (_row,"รหัสงาน","ชื่อบริษัท","Create By","Sales Code","Lead Status","เลขที่ QO / IV","เลขใบแจ้งหนี้ Peak","สถานะซิงก์ PEAK","บริษัทที่ขาย") values
     (16,'B2E2609/026','บริษัท สยามเทรด จำกัด','kukkik','kukkik','ปิดการขาย','IV-2026092900026','IV-2026092900026','✅ ซิงก์แล้ว','มดงานการป้าย'),
     (17,'B2E2609/027','บริษัท เดิมยกเลิก จำกัด','kukkik','kukkik','ปิดการขาย','IV-2026092900027','IV-2026092900027','🚫 เอกสารถูกยกเลิกใน PEAK','มดงานการป้าย')`);
  await PC(990217, 'ZZAI-P16', 'งานป้ายหน้าร้าน', 'In Progress', 'IV-2026092900026', 'ร้านกาแฟสุขใจ');
  await PC(990218, 'ZZAI-P17', 'งานป้ายตึก', 'In Progress', 'IV-2026092900027', 'บริษัท รายใหม่ จำกัด');
  await Q(17, 'IP-016', 'ZZAI-P16', '2026-10-11T02:00:00Z', 'T1', { 'แสดงชื่อลูกค้า': 'ร้านกาแฟสุขใจ' });
  await Q(18, 'IP-017', 'ZZAI-P17', '2026-10-12T02:00:00Z', 'T2', { 'แสดงชื่อลูกค้า': 'บริษัท รายใหม่ จำกัด' });

  const snap = async () => {
    const q = async t => (await pg.query(`select md5(coalesce(string_agg(x::text, '|' order by x::text),'')) m from ${t} x`)).rows[0].m;
    return [await q('app.total_sales'), await q('app.installation_plan'), await q(`(select * from app.projects where "ID" like 'ZZAI-%') `),
            await q(`(select * from app.requirements where requirement_id like 'ZZAI-%')`), await q(`(select * from app.job_deliveries where "ProjectID" like 'ZZAI-%')`)].join('');
  };
  const before = await snap();

  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  /* รูปช่าง = ของกลางแอปจองคิว — จำลองตัวหารูป (ไม่ออกไป Drive/Sheet) */
  const DSP = require('../modules/booking/dispatch');
  const techCalls = [];
  DSP.getDispatchTechPhotos = async (_u, items) => { techCalls.push(items.length); const m = {}; items.forEach(i => { if (i.nickname === 'ต้น') m[i.id] = 'https://cdn.test/ton.jpg'; }); return m; };
  const AI = require('../modules/sales/ar-install');
  const BOSS = { username: 'arboss', permission: 'Administrator', nickname: 'พี่เอ', name: 'Panusphong' };
  const SALE = { username: 'kukkik', permission: 'Sale', nickname: 'กุ๊กกิ๊ก', name: '(กุ๊กกิ๊ก) กุลกานต์' };
  let browser, srv, R;
  try {
    console.log('① ใบขาย → ใบงาน → คิวติดตั้ง');
    R = await AI.arInstallInfo(BOSS, [1, 2, 3, 4, 5, 6, 7], { now: '2026-10-01T01:00:00Z' });   /* ปักวัน 1 ต.ค. 69 */
    const techN = techCalls.length;
    const m = R.map || {};
    const a = m[1] || {}, q1 = (a.queues || [])[0] || {};
    ok(R.ok && a.state === 'done' && q1.id === 'IP-001' && q1.state === 'done', 'โรบินสัน: สถานะ ✅ จบงานแล้ว · คิวติดตั้งจริงขึ้นก่อนนัดดูหน้างาน — ' + JSON.stringify({ s: a.state, q: q1.id }));
    ok(q1.date === '2026-09-26' && q1.start === '09:00' && q1.end === '16:00', 'วัน + เวลาเข้าติดตั้ง (เวลาไทย) 26 ก.ย. 09:00–16:00 — ' + q1.date + ' ' + q1.start + '–' + q1.end);
    ok(q1.team === 'ต้น' && JSON.stringify(q1.helpers) === '["เอก"]', 'ทีมช่าง: หัวหน้า ต้น + ผู้ช่วย เอก');
    ok(q1.doneAt === '26/09/69 16:30' && q1.signBy === 'คุณสมชาย', 'เวลาจบงาน (ช่างจบงานเมื่อ เวลาไทย) + ผู้เซ็นรับ — ' + q1.doneAt);
    ok(a.queues.length === 2 && a.queues[1].siteVisit && a.queues[1].team === 'นัท' && a.queues[1].state === 'sv',
       'นัดดูหน้างานยังอยู่เป็นคิวที่ 2 (ทีมนัท) · ผ่านวันแล้ว = "ดูหน้างานแล้ว" ไม่ใช่ "เลยวันนัด"');
    ok(a.photos && a.photos['ต้น'] === 'https://cdn.test/ton.jpg' && !a.photos['เอก'], 'รูปช่าง (ต้น) จากของกลางแอปจองคิว · คนไม่มีรูป = ไม่ส่ง (อักษรย่อ)');
    ok(a.finish.length === 2 && a.nFinish === 2 && a.finish[0].raw === D(1) && !a.finish[0].url,
       'ภาพจบงาน 2 รูป · ⚡ รอบ 205 ส่งค่าดิบ (หน้าเว็บขอไอดีแล้วโหลดจาก CDN ของ Google แบบบอร์ด Job Card)');
    ok(a.site.length === 1 && a.nSite === 1, 'ภาพหน้างาน 1 รูป');
    const b = m[2] || {};
    ok(b.by === 'iv' && b.queues && b.queues.length === 1 && b.queues[0].id === 'IP-002' && b.state === 'late',
       '‼ เอสคิวไอ: ตรงเลข IV ⇒ คิวของงานย่อย (requirement_id) · ไม่ปนคิวของใบงานที่ตรงแค่รหัสงาน · เลยวันนัด — ' + JSON.stringify(b.queues && b.queues.map(q => q.id)));
    ok(m[3] && m[3].state === 'wait' && m[3].queues[0].team === 'นัท' && m[3].queues[0].helpers[0] === 'ต้น', 'รอติดตั้ง (คิวในอนาคต) · ทีมนัท + ต้น');
    ok(m[4] && m[4].state === 'none' && m[4].queues[0].date === '', 'มีใบงานแต่ยังไม่ได้วัน/ช่าง ⇒ ⏳ ยังไม่ได้คิวติดตั้ง');
    ok(!m[5], 'ไม่พบใบงาน ⇒ ไม่มีคีย์ (หน้าเว็บบอก "ไม่พบคิว")');
    ok(m[7] && m[7].state === 'closed' && /เลื่อน/.test(m[7].queues[0].reason), 'คิวถูกปิด/ยกเลิก ⇒ บอกพร้อมเหตุผล');
    console.log('\n①.4 🔴 รอบ 203 — ภาพหน้างาน/คิวของมีคลาส ไปโผล่บนการ์ด Pet Club');
    const R9 = await AI.arInstallInfo(BOSS, [8, 9], { now: '2026-10-01T01:00:00Z' });
    ok(R9.map[9] && R9.map[9].by === 'iv' && R9.map[9].queues[0].id === 'IP-009' && R9.map[9].site.length === 1,
       'มีคลาส: จับด้วยเลข IV ⇒ ได้คิว IP-009 + ภาพหน้างานของตัวเอง');
    ok(!R9.map[8], '‼ Pet Club: รหัสงานชนกันแต่ใบงานมีเลข IV ของใบอื่น ⇒ ไม่หยิบคิว/ภาพของมีคลาสมาแสดง — ' + JSON.stringify(R9.map[8] && R9.map[8].queues.map(q => q.id)));
    ok(!(R9.dates[8] && R9.dates[8].inst), 'Pet Club ไม่มีวันติดตั้งของมีคลาสปน');
    const ARC = require('../modules/sales/ar-complete');
    ARC._t._memo.clear();
    const C9 = await ARC.arCompleteImages(BOSS, [8, 9]);
    ok(C9.map[9] && C9.map[9].projectId === 'ZZAI-P9' && !C9.map[8], '‼ รูปงานเสร็จ (รอบ 189) ใช้กติกาเดียวกัน: มีคลาสได้รูป · Pet Club ไม่ได้รูปของมีคลาส');
    AI._t._memo.clear();

    console.log('\n①.45 🔴 รอบ 225 — การ์ด "ดี ทรี" ได้ช่าง/นัดดูหน้างานของใบงาน c54f6bb4 ซึ่งเป็นของ "รมัย คอร์ป"');
    const R10 = await AI.arInstallInfo(BOSS, [10, 11, 12, 13, 14, 15], { now: '2026-10-03T01:00:00Z' });
    const CL = R10.clash || {}, c10 = (CL[10] || [])[0] || {}, c11 = (CL[11] || [])[0] || {}, c13 = (CL[13] || [])[0] || {};
    ok(!R10.map[10], '‼ ดี ทรี (B2E2609/019): ใบงานที่รหัสงานตรงเป็นของ รมัย คอร์ป ⇒ ไม่เอาช่าง/นัดดูหน้างานมาแสดง — ' + JSON.stringify((R10.map[10] || {}).queues || null));
    ok(c10.id === 'ZZAI-C54' && /รมัย/.test(c10.name || '') && c10.by === 'code', 'บอกเหตุผล: ใบงาน ZZAI-C54 · "รมัย คอร์ป" · ตรงรหัสงาน แต่ชื่อลูกค้าคนละราย — ' + JSON.stringify(CL[10] || null));
    ok(!(R10.dates[10] && R10.dates[10].inst), 'ดี ทรี ไม่มีวันติดตั้ง/ดูหน้างานของรมัยไปนับอายุหนี้');
    ok(!R10.map[11] && c11.id === 'ZZAI-P11' && c11.by === 'iv', '‼ เลข IV ของ ดี ทรี ไปอยู่ในช่อง Slip ของใบงาน รมัย ⇒ ไม่แสดงเหมือนกัน (ทางเลข IV ก็ต้องผ่านด่านชื่อ) — ' + JSON.stringify(CL[11] || null));
    ok(R10.map[12] && R10.map[12].queues[0].id === 'IP-012' && !CL[12], 'ลูกค้ารายเดียวกันเขียนชื่อต่างกัน ("บริษัท ซีทรู จำกัด" / "บจก. ซีทรู (สาขา 2)") ⇒ ยังแสดงตามเดิม');
    ok(!R10.map[13] && c13.id === 'IP-013' && c13.by === 'queue', 'ใบงานไม่มีชื่อลูกค้า แต่ชื่อบนคิวเป็นคนละราย ⇒ ไม่แสดง (ด่านที่สองที่ตัวคิว) — ' + JSON.stringify(CL[13] || null));
    ok(R10.map[14] && R10.map[14].queues[0].id === 'IP-014' && !CL[14], 'ไม่มีชื่อลูกค้าทั้งใบงานและคิว = ตรวจทานไม่ได้ ⇒ กติกาเดิม (ของที่เคยขึ้นไม่หาย)');
    ok(R10.map[15] && R10.map[15].by === 'code' && R10.map[15].queues.length === 1 && R10.map[15].queues[0].id === 'IP-015B' && !CL[15],
       'ใบงานผิดราย (ทาง IV) ถูกตัด แล้วใช้ใบงานของลูกค้ารายเดียวกันที่ตรงรหัสงานแทน — ' + JSON.stringify(((R10.map[15] || {}).queues || []).map(q => q.id)));
    ok(!/รมัย|_cust/.test(JSON.stringify(R10.map)) && R10.summary.clash === 3, 'ชื่อลูกค้ารายอื่นไม่หลุดไปในข้อมูลคิว · สรุป: ตัดทิ้งเพราะชื่อไม่ตรง 3 ใบ — ' + R10.summary.clash);
    ARC._t._memo.clear();
    const C10 = await ARC.arCompleteImages(BOSS, [11, 12]);
    ok(!C10.map[11] && C10.map[12] && C10.map[12].projectId === 'ZZAI-P12', '‼ รูปงานเสร็จใช้ด่านเดียวกัน: รูปของ รมัย ไม่ขึ้นการ์ด ดี ทรี · ซีทรูได้รูปของตัวเอง');
    const R10b = await AI.arInstallInfo(BOSS, [10], { now: '2026-10-03T01:00:00Z' });
    ok(!R10b.map[10] && ((R10b.clash || {})[10] || []).length === 1, 'เรียกซ้ำ (ผลที่จำไว้ 3 นาที) ได้คำตอบเดิม ไม่กลับไปแสดงของผิดราย');
    console.log('\n①.46 🔴 รอบ 226 — เช็ค PEAK ก่อน: เลข IV ถูกยกเลิกแล้วเอาไปออกใหม่ให้ลูกค้ารายอื่นไหม');
    const PS = require('../modules/sales/peak-sync');
    const _ivh = PS.ivHistory; const ASK = [];
    ok(ARC._t.SS_VOID === PS.SS.VOID, 'ตรา "เอกสารถูกยกเลิกใน PEAK" ที่การ์ดลูกหนี้ใช้ = ตัวเดียวกับตัวซิงก์ PEAK');
    /* ก) PEAK: เลขของใบ 11 เคยเป็นของ รมัย (ยกเลิกแล้ว) ปัจจุบันเป็นของ ดี ทรี */
    PS.ivHistory = async (ref, biz) => { ASK.push(ref); return { ok: true, reused: true, biz: 'มดงานการป้าย', err: '',
      live: { code: 'IV-2026092900021', name: 'บริษัท ดี ทรี จำกัด' }, voids: [{ code: 'IV-2026092900021', name: 'บริษัท รมัย คอร์ป จำกัด' }] }; };
    AI._t._memo.clear();
    const RV = await AI.arInstallInfo(BOSS, [11, 12, 10], { now: '2026-10-03T01:00:00Z' });
    const v11 = ((RV.clash || {})[11] || [])[0] || {};
    ok(!RV.map[11] && v11.by === 'void' && v11.why === 'reuse' && /รมัย/.test((v11.voidNames || []).join()) && /ดี ทรี/.test(v11.live || ''),
       '‼ PEAK: เลข IV ถูกยกเลิก (ของ รมัย) แล้วออกใหม่ให้ ดี ทรี ⇒ ไม่ใช้ใบงานของรมัย + บอกเหตุผล void — ' + JSON.stringify(v11));
    ok(ASK.length === 1 && /2026092900021/.test(ASK[0]), 'ถาม PEAK เฉพาะใบที่ "เลข IV ตรงแต่ชื่อขัด" (1 ครั้ง · ใบที่ชื่อตรง/ทางรหัสงานไม่ถาม) — ' + JSON.stringify(ASK));
    ok(RV.map[12] && ((RV.clash || {})[10] || [])[0].by === 'code', 'ใบอื่นได้ผลเดิม (ซีทรูแสดง · ดี ทรี B2E2609/019 ถูกตัดที่ด่านชื่อทางรหัสงาน)');
    /* ข) PEAK: เลขไม่เคยถูกยกเลิก ⇒ เลข IV เป็นหลัก แม้ชื่อเขียนคนละแบบ */
    ASK.length = 0;
    PS.ivHistory = async (ref) => { ASK.push(ref); return { ok: true, reused: false, biz: 'มดงานการป้าย', err: '', live: { code: ref, name: 'บริษัท สยามเทรด จำกัด' }, voids: [] }; };
    AI._t._memo.clear();
    const RT = await AI.arInstallInfo(BOSS, [16], { now: '2026-10-03T01:00:00Z' });
    ok(RT.map[16] && RT.map[16].by === 'iv' && RT.map[16].queues[0].id === 'IP-016' && !(RT.clash || {})[16] && ASK.length === 1,
       'PEAK: เลข IV นี้มีใบเดียว ไม่เคยถูกยกเลิก ⇒ เชื่อเลข IV เป็นหลัก แสดงคิวได้แม้ชื่อเขียนคนละแบบ (สยามเทรด / ร้านกาแฟสุขใจ)');
    /* ค) ถาม PEAK ไม่สำเร็จ ⇒ ยังไม่รู้ ⇒ ไม่แสดง */
    PS.ivHistory = async () => ({ ok: false, reused: false, live: null, voids: [], biz: '', err: 'PEAK ตอบ HTTP 500' });
    AI._t._memo.clear();
    const RF = await AI.arInstallInfo(BOSS, [16], { now: '2026-10-03T01:00:00Z' });
    const f16 = ((RF.clash || {})[16] || [])[0] || {};
    ok(!RF.map[16] && f16.by === 'iv' && f16.ask === 'fail', '‼ ถาม PEAK ไม่สำเร็จ = ยังไม่รู้ ⇒ ไม่แสดง (ไม่เดาว่าเลขไม่เคยถูกยกเลิก) — ' + JSON.stringify(f16));
    /* ง) ใบแจ้งหนี้ของใบขายเองถูกยกเลิกใน PEAK (ตราซิงก์ 🚫) ⇒ ไม่ต้องถาม PEAK ซ้ำ */
    ASK.length = 0;
    PS.ivHistory = async (ref) => { ASK.push(ref); return { ok: true, reused: false, live: { code: ref, name: 'x' }, voids: [], biz: '', err: '' }; };
    AI._t._memo.clear();
    const RS = await AI.arInstallInfo(BOSS, [17], { now: '2026-10-03T01:00:00Z' });
    const s17 = ((RS.clash || {})[17] || [])[0] || {};
    ok(!RS.map[17] && s17.by === 'void' && s17.why === 'sale' && ASK.length === 0,
       'ใบแจ้งหนี้ของใบขายถูกยกเลิกใน PEAK + ใบงานที่ถือเลขเดียวกันเป็นของลูกค้ารายอื่น ⇒ ไม่แสดง (ไม่ถาม PEAK ซ้ำ) — ' + JSON.stringify(s17));
    /* จ) รูปงานเสร็จใช้ทางเดียวกัน */
    PS.ivHistory = async () => ({ ok: true, reused: true, live: { code: 'x', name: 'บริษัท ดี ทรี จำกัด' }, voids: [{ code: 'x', name: 'บริษัท รมัย คอร์ป จำกัด' }], biz: '', err: '' });
    ARC._t._memo.clear();
    const CV = await ARC.arCompleteImages(BOSS, [11]);
    ok(!CV.map[11], 'รูปงานเสร็จของใบงานที่ถือเลข IV เก่า (ถูกยกเลิก/ออกใหม่) ไม่ขึ้นการ์ดเหมือนกัน');
    PS.ivHistory = _ivh; AI._t._memo.clear(); ARC._t._memo.clear();

    const NK = ARC._t.nameKey, SC = ARC._t.sameCustomer;
    ok(SC(NK('บริษัท ดี ทรี จำกัด'), NK('บริษัท รมัย คอร์ป จำกัด')) === false && SC(NK('บริษัท ดี ทรี จำกัด'), NK('บจก.ดี ทรี (สำนักงานใหญ่)')) === true
       && SC(NK('คุณ ศิขรินทร์'), NK('ศิขรินทร์ ใจดี')) === true && SC(NK('บริษัท มีคลาส จำกัด'), NK('มีคราส')) === true
       && SC(NK('บริษัท เอสซีจี จำกัด'), NK('บริษัท เอสคิวไอ จำกัด')) === false && SC(NK(''), NK('อะไรก็ได้')) === null,
       'ตัวเทียบชื่อ: คนละราย = ค้าน · รายเดียวกันเขียนต่าง/พิมพ์ตกเล็กน้อย = ผ่าน · ไม่มีชื่อ = ไม่ตัดสิน');
    AI._t._memo.clear();

    console.log('\n①.5 วันสำคัญ · ตัวนับ "ค้างมาแล้ว N วัน" (ปักวัน 1 ต.ค. 69)');
    const d1 = R.dates[1] || {};
    ok(d1.dep && d1.dep.date === '2026-08-17' && d1.dep.amt === 50000 && d1.dep.label === 'งวด 1', 'มัดจำงวดแรก = เงินเข้าที่เก่าสุด (งวด 1 · 17/08/69 · ฿50,000) ไม่ใช่งวด 2');
    ok(d1.base && d1.base.k === 'dep' && d1.days === 45, '‼ นับจากรับมัดจำงวดแรก ⇒ ค้างมาแล้ว 45 วัน — ' + JSON.stringify(d1.base) + ' ' + d1.days);
    ok(d1.inst && d1.inst.date === '2026-09-26' && d1.inst.done, 'วันติดตั้ง 26/09/69 (จบแล้ว) ไม่ใช่วันนัดดูหน้างาน');
    ok(d1.dlv && d1.dlv.date === '2026-09-24' && !d1.dlv.actual, 'วันส่งของตามแผน 24/09/69 · ใบที่ยกเลิกไม่นับ');
    const d2 = R.dates[2] || {};
    ok(!d2.dep && d2.base && d2.base.k === 'inst' && d2.base.date === '2026-09-20' && d2.days === 11, 'ไม่มีเงินเข้า ⇒ นับจากวันติดตั้ง (ถึงวันแล้ว) 20/09 = 11 วัน');
    const d3 = R.dates[3] || {};
    ok(d3.inst && !d3.inst.done && d3.base === null && d3.days === null, 'ไม่มีเงินเข้า · ติดตั้งยังไม่ถึงวัน ⇒ ยังไม่เริ่มนับ');
    const d4 = R.dates[4] || {};
    ok(d4.dlv && d4.dlv.actual && d4.dlv.date === '2026-09-20' && d4.base && d4.base.k === 'dlv' && d4.days === 11, 'ไม่มีเงินเข้า · ไม่มีวันติดตั้ง ⇒ นับจากวันส่งของจริง (แผนจัดส่ง) 20/09 = 11 วัน');
    const d5 = R.dates[5] || {};
    ok(!R.map[5] && d5.dep && d5.dep.label === 'รับเงิน' && d5.days === 30, 'ไม่มีใบงาน/คิว แต่มีเงินเข้า ⇒ ยังนับได้ (รับเงิน 01/09 = 30 วัน)');
    ok(!/999/.test(JSON.stringify(R.dates)), '‼ ไม่ขนค่าจัดส่งมา');
    ok(R.sp[1] === 'https://cdn.test/kukkik.jpg', 'รูปพนักงานขายจาก app.user_photo ตาม Username ผู้คีย์ (Create By)');
    ok(techN === 1, 'รูปช่างขอครั้งเดียวทั้งจอ (' + techN + ' คำขอ)');
    const J = JSON.stringify(R);
    ok(!/7777|5555|2222|ค่าติดตั้ง|ค่าจ้าง|กำไร/.test(J), '‼ คำตอบไม่มีช่องเงินของคิวเลย (ค่าติดตั้ง/ค่าช่างนอก/กำไร)');

    console.log('\n② สิทธิ์ · อ่านอย่างเดียว');
    AI._t._memo.clear();
    const S = await AI.arInstallInfo(SALE, [1, 6], { now: '2026-10-01T01:00:00Z' });
    ok(S.map[1] && !S.map[6] && S.summary.denied === 1, 'เซลส์ (กุ๊กกิ๊ก) เห็นคิวของใบตัวเอง · ใบของแก้มไม่ตอบ');
    const E = await AI.arInstallInfo(BOSS, ['x', -1, 0]);
    ok(E.ok && E.summary.asked === 0, 'ส่งแถวเพี้ยน ⇒ ไม่พัง');
    ok((await snap()) === before, 'total_sales · installation_plan · projects · requirements ไม่ถูกแก้แม้แต่ช่องเดียว');
    const IDX = fs.readFileSync(path.join(__dirname, '..', 'modules/sales/index.js'), 'utf8');
    ok(/router\.get\('\/api\/ar-aging\/install'[\s\S]{0,200}arInstallInfo\(req\.user/.test(IDX), 'เส้นทาง GET /api/ar-aging/install (อ่านอย่างเดียว) · ตัวตนจาก session');
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'modules/sales/ar-install.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    ok(!/C\.(value|outsourceCost|profit|craneCost|liftCost|transportCost)\b/.test(SRC), '‼ โค้ดไม่ขอช่องเงินของคิว (value/outsourceCost/profit/ค่ารถ)');
    ok(!/\.(insert|update|upsert|remove|del)\(/.test(SRC), 'โค้ดไม่มีคำสั่งเขียนฐาน');

    console.log('\n③ หน้าจอ');
    const PUB = path.join(__dirname, '..', 'modules', 'sales', 'public');
    srv = await new Promise(res => { const s = http.createServer((req, rq) => {
      const f = path.join(PUB, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
      fs.readFile(f, (e, b2) => { if (e) { rq.writeHead(404); rq.end('no'); return; }
        rq.writeHead(200, { 'content-type': /\.html$/.test(f) ? 'text/html; charset=utf-8' : 'text/plain' }); rq.end(b2); });
    }); s.listen(0, '127.0.0.1', () => res(s)); });
    const mk = o => Object.assign({ row: 1, sale: '(กุ๊กกิ๊ก) กุลกานต์', job: 'B2G2609/014', company: 'บริษัท โรบินสัน จำกัด', peakName: '',
      biz: 'The 101', iv: 'QO-69091700002', total: 149760, paid: 0, outstanding: 149760, src: 'peak', srcWhy: '', syncStat: '',
      noIv: null, dueIso: '2026-10-17', dueDate: '17/10/2026', od: 0, bk: 'd0', bkT: 'ยังไม่ครบกำหนด', bkC: '#64748b',
      status: '', reason: 'รอเอกสารจากลูกค้า', note: '', last: '', nextIso: '', promise: 0, times: 3,
      payKind: 'credit', payTerms: 'เครดิต 30 วัน', crDay: 30, peakTerms: '', sheetTerms: '', ss: 'ซิงก์แล้ว', synced: true,
      peakAmt: 149760, peakPaid: 0, peakAt: '', qoNo: 'QO-69091700002', docUrl: '', urlKind: '' }, o);
    const ITEMS = [mk({}), mk({ row: 2, job: 'B2G2608/022', company: 'บริษัท เอสคิวไอ จำกัด', od: 36, bkC: '#65a30d' }),
      mk({ row: 3, company: 'บริษัท รอติดตั้ง จำกัด' }), mk({ row: 4, company: 'บริษัท ยังไม่จอง จำกัด' }), mk({ row: 5, company: 'บริษัท ไม่มีใบงาน จำกัด' })];
    const ARD = { ok: true, at: '01/10/2026 08:00', today: '2026-10-01', buckets: [], sales: [{ name: '(กุ๊กกิ๊ก) กุลกานต์', n: 5, amt: 1, oldest: 36, byBk: {}, items: ITEMS }],
      total: { n: 5, amt: 1, credit: 1, cash: 0, na: 0, naBlank: 0, naBlankN: 0, naUnknown: 0, naUnknownN: 0 },
      noDue: 0, naWords: [], saleNames: ['(กุ๊กกิ๊ก) กุลกานต์'], bizList: ['The 101'], filt: {}, srcTot: { peak: { n: 5, amt: 1 }, sheet: { n: 0, amt: 0 } },
      srcWhy: [], scope: { seeAll: true, me: '', unknown: '(ไม่ระบุ)' }, reasons: [], statuses: [] };
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNgYPgPAAEDAQDMq3yQAAAAAElFTkSuQmCC', 'base64');
    const shotPng = process.env.SHOT_IMG ? fs.readFileSync(process.env.SHOT_IMG) : null;
    const shotSign = process.env.SHOT_SIGN ? fs.readFileSync(process.env.SHOT_SIGN) : null;
    const ins = [];
    const idCalls = [];
    /* ⚡ รอบ 205 — ภาพหน้างานแบบ path (ไม่ใช่ลิงก์ Drive) ต้องขอไอดีจากเซิร์ฟเวอร์ (img-ids) */
    R.map[3].site = [{ raw: 'InstallationPlan_Images/site9.jpg' }, { raw: 'InstallationPlan_Images/ghost.jpg' }]; R.map[3].nSite = 2;
    const { chromium } = require('playwright');
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const p = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    const errs = [];
    p.on('pageerror', e => errs.push(String(e.message || e)));
    await p.context().route('**/*', route => {
      const u = route.request().url();
      const Jr = o => route.fulfill({ contentType: 'application/json', body: JSON.stringify(o) });
      if (/drive\.google\.com\/thumbnail|lh3\.googleusercontent\.com|cdn\.test/.test(u)) return route.fulfill({ status: 200, contentType: 'image/png', body: (shotPng && /cdn\.test/.test(u)) ? shotPng : (shotSign && /thumbnail|lh3/.test(u)) ? shotSign : PNG });
      if (u.includes('/api/ar-aging/img-ids')) { const b = { paths: JSON.parse(decodeURIComponent((u.match(/[?&]paths=([^&]*)/) || [, '%5B%5D'])[1])) }; idCalls.push(b.paths || []);
        return Jr({ ok: true, files: (b.paths || []).map(p => ({ p, id: /site9/.test(p) ? 'ZZPATHID0000000000000000001' : '' })) }); }
      if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      if (u.includes('/api/ar-aging/install')) { ins.push(decodeURIComponent((u.match(/[?&]rows=([^&]*)/) || [, ''])[1])); return Jr(R); }
      if (u.includes('/api/ar-aging/complete-img')) return Jr({ ok: true, map: {}, summary: {} });
      if (u.includes('/api/ar-aging')) return Jr(ARD);
      if (u.includes('/api/')) return Jr({ ok: true, rows: [], headers: [], data: {}, map: {}, sales: [], status: [] });
      if (/^https?:\/\/127\.0\.0\.1/.test(u)) return route.continue();
      return route.fulfill({ status: 204, body: '' });
    });
    await p.goto('http://127.0.0.1:' + srv.address().port + '/index.html');
    await p.waitForTimeout(1300);
    await p.evaluate(() => openAging());
    await p.waitForFunction(() => document.querySelectorAll('#arBody .ar-ins-q').length >= 3, null, { timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(500);
    const U = await p.evaluate(() => {
      const c = id => document.getElementById('arc-' + id);
      const t = (id, s) => ((c(id) && c(id).querySelector(s)) || {}).innerText || '';
      return { own: !!c(1).querySelector('.ar-own i.ph img'), ownOk: (() => { const i = c(1).querySelector('.ar-own i.ph img'); return !!i && i.complete && i.naturalWidth > 0; })(),
        own3: !!c(3).querySelector('.ar-own i.ph img'),
        h1: t(1, '.ar-ins-h'), q1: t(1, '.ar-ins-q'), av1: c(1).querySelectorAll('.ar-ins-q .ar-ins-av img').length,
        ini1: [...c(1).querySelectorAll('.ar-ins-q .ar-ins-av')].map(e => e.textContent).join(','),
        fin: c(1).querySelectorAll('.ar-ins-ph .th').length, ph: t(1, '.ar-ins'),
        h2: t(2, '.ar-ins-h'), h3: t(3, '.ar-ins-h'), q3: t(3, '.ar-ins-q'), h4: t(4, '.ar-ins-h'), h5: t(5, '.ar-ins'),
        cls2: c(2).querySelector('.ar-ins').className, order: [...c(1).children].map(e => e.className.split(' ')[0]).join('>'),
        money: /7,?777|5,?555|2,?222/.test(document.getElementById('arBody').innerText) };
    });
    ok(ins.length === 1 && ins[0] === '1,2,3,4,5', 'ขอข้อมูลติดตั้งครั้งเดียวรวมทุกใบบนจอ — ' + JSON.stringify(ins));
    ok(U.own && U.ownOk, '👤 รูปพนักงานขายขึ้นบนป้ายเซลส์ (แทนอักษรย่อ)');
    const ini = await p.evaluate(() => arSaleChip('(ทดสอบ) ไม่มีรูป', ''));
    ok(/<i>ท<\/i>/.test(ini) && !/<img/.test(ini), 'เซลส์ที่ไม่มีรูป = อักษรย่อเดิม');
    ok(/จบงานติดตั้งแล้ว/.test(U.h1) && /26\/09\/69 16:30/.test(U.h1) && /เซ็นรับ: คุณสมชาย/.test(U.h1), 'หัวกล่อง: ✅ จบงานติดตั้งแล้ว 26/09/69 16:30 · เซ็นรับ — "' + U.h1.replace(/\s+/g, ' ') + '"');
    ok(/ส\. 26 ก\.ย\. 69/.test(U.q1) && /09:00–16:00/.test(U.q1) && /ต้น/.test(U.q1) && /เอก/.test(U.q1), 'วันที่ · เวลาเข้าติดตั้ง · ชื่อช่าง ต้น + เอก — "' + U.q1.replace(/\s+/g, ' ') + '"');
    ok(U.av1 === 1 && /เ/.test(U.ini1), 'รูปช่าง (ต้น) ขึ้นจริง · ช่างที่ไม่มีรูป (เอก) = อักษรย่อ');
    ok(U.fin === 3 && /ภาพจบงาน/.test(U.ph) && /ภาพหน้างาน/.test(U.ph), 'ภาพจบงาน 2 + ภาพหน้างาน 1 บนการ์ด');
    ok(/เลยวันนัด/.test(U.h2) && /st-late/.test(U.cls2), 'เอสคิวไอ: ⚠️ เลยวันนัด ยังไม่ปิดงาน (กล่องสีส้ม)');
    ok(/รอติดตั้ง/.test(U.h3) && /⏰/.test(U.q3), 'รอติดตั้ง + เวลานัด');
    ok(/ยังไม่ได้คิวติดตั้ง/.test(U.h4), 'ยังไม่ได้คิว ⇒ ⏳ ยังไม่ได้คิวติดตั้ง');
    ok(/ไม่พบคิวติดตั้ง/.test(U.h5), 'ไม่พบใบงาน/คิว ⇒ บอกตรง ๆ');
    ok(/ar-c-sub>ar-dates>ar-cimg>ar-ins>ar-c-row/.test(U.order), 'ตัวนับ + วันสำคัญอยู่ใต้รหัสงาน · กล่องติดตั้งอยู่ใต้รูปงานเสร็จ เหนือป้ายอายุหนี้ — ' + U.order);
    const DT = await p.evaluate(() => { const t = id => ((document.querySelector('#arc-' + id + ' .ar-dates') || {}).innerText || '').replace(/\s+/g, ' ');
      return { 1: t(1), 2: t(2), 3: t(3), 4: t(4), 5: t(5), pill: (document.querySelector('#arc-2 .ar-pill') || {}).textContent }; });
    ok(/ค้างมาแล้ว 45 วัน/.test(DT[1]) && /นับจากรับมัดจำงวดแรก 17\/08\/69/.test(DT[1]), 'การ์ด: ⏱ ค้างมาแล้ว 45 วัน · นับจากรับมัดจำงวดแรก 17/08/69 — "' + DT[1] + '"');
    ok(/มัดจำงวดแรก 17\/08\/69/.test(DT[1]) && /ติดตั้ง 26\/09\/69 จบแล้ว/.test(DT[1]) && /ส่งของ 24\/09\/69 ตามแผน/.test(DT[1]), 'การ์ดบอกวันมัดจำงวดแรก · วันติดตั้ง · วันส่งของ ชัดเจน');
    ok(/นับจากวันติดตั้ง 20\/09\/69/.test(DT[2]) && /ยังไม่มีเงินเข้า/.test(DT[2]), 'ไม่มีมัดจำ ⇒ นับจากวันติดตั้ง · ชิปมัดจำบอก "ยังไม่มีเงินเข้า"');
    ok(/ยังไม่เริ่มนับ/.test(DT[3]) && /นับจากวันส่งของ 20\/09\/69/.test(DT[4]) && /ส่งจริง/.test(DT[4]), 'ยังไม่ถึงวันติดตั้ง = ยังไม่เริ่มนับ · ส่งของจริง = นับจากวันส่งของ');
    ok(/ค้างมาแล้ว 30 วัน/.test(DT[5]), 'ใบที่ไม่พบคิว/ใบงานก็ยังมีตัวนับจากเงินเข้า');
    ok(DT.pill === 'เกิน 36 วัน', '‼ ป้ายเดิม "เกิน N วัน" (จากวันครบกำหนด) ไม่ถูกแตะ — ' + DT.pill);
    ok(!U.money, '‼ หน้าการ์ดไม่มีตัวเลขเงินของคิว');
    const pop = p.waitForEvent('popup', { timeout: 4000 }).catch(() => null);
    await p.click('#arc-1 .ar-ins-ph .th >> nth=0');
    const pw = await pop;
    const fgOpen = await p.evaluate(() => { const o = document.getElementById('fgOv'); return !!o && !o.classList.contains('hidden'); });
    ok(pw && /lh3\.googleusercontent\.com\/d\/ZZAIIMG\d+=w1600/.test(pw.url()) && !fgOpen, 'กดภาพจบงาน ⇒ เปิดรูปเต็ม (CDN ของ Google · =w1600) แท็บใหม่ · ไม่เปิดฟอร์มติดตาม');
    const P5 = await p.evaluate(() => { const c = document.getElementById('arc-3');
      return { srcs: [...c.querySelectorAll('.ar-ins-ph img')].map(i => i.getAttribute('src') || ''),
               hidden: [...c.querySelectorAll('.ar-ins-ph a.th')].map(a => a.style.display) }; });
    ok(idCalls.length === 1 && idCalls[0].length === 2 && idCalls[0].every(x => /InstallationPlan_Images/.test(x)),
       '⚡ ค่าที่เป็นลิงก์ Drive แกะไอดีเองในเครื่อง · ขอไอดีจากเซิร์ฟเวอร์เฉพาะ path (คำขอเดียวรวมทั้งจอ) — ' + JSON.stringify(idCalls));
    ok(/lh3\.googleusercontent\.com\/d\/ZZPATHID0000000000000000001=w400/.test(P5.srcs[0]) && P5.hidden[1] === 'none',
       'path ที่ได้ไอดี ⇒ โหลดจาก CDN ของ Google (=w400) · path ที่หาไม่เจอ ⇒ ซ่อนช่อง (ไม่ขึ้นรูปแตก)');
    if (pw) await pw.close();
    /* 🔴 รอบ 225 — การ์ดบอกเหตุผลเมื่อใบงานที่จับคู่ได้เป็นของลูกค้าอีกราย (ไม่หายเงียบ · ไม่มีชื่อช่าง) */
    const CH = await p.evaluate(() => {
      AR_INS[77] = null; AR_CLASH[77] = [{ id: 'c54f6bb4', name: 'บริษัท รมัย คอร์ป จำกัด', by: 'code' }];
      AR_INS[78] = null; AR_CLASH[78] = null;
      return { clash: arInsHtml({ row: 77 }), none: arInsHtml({ row: 78 }) };
    });
    ok(/ไม่แสดงคิวติดตั้ง/.test(CH.clash) && /c54f6bb4/.test(CH.clash) && /รมัย คอร์ป/.test(CH.clash) && /รหัสงานตรงกัน/.test(CH.clash) && !/ar-ins-q/.test(CH.clash),
       '🔴 รอบ 225 การ์ด: "🚫 ไม่แสดงคิวติดตั้ง — ใบงานที่จับคู่ได้เป็นของลูกค้าอีกราย" + เลขใบงาน + ชื่อ · ไม่มีกล่องช่าง/วัน');
    ok(/ไม่พบคิวติดตั้ง/.test(CH.none), 'ใบที่ไม่พบใบงานเลย ยังขึ้น "ไม่พบคิวติดตั้ง" ตามเดิม');
    const CH2 = await p.evaluate(() => {
      AR_INS[79] = null; AR_CLASH[79] = [{ id: 'c54f6bb4', name: 'บริษัท รมัย คอร์ป จำกัด', by: 'void', why: 'reuse', live: 'บริษัท ดี ทรี จำกัด', voidNames: ['บริษัท รมัย คอร์ป จำกัด'] }];
      AR_INS[80] = null; AR_CLASH[80] = [{ id: 'P17', name: 'บริษัท รายใหม่ จำกัด', by: 'void', why: 'sale' }];
      AR_INS[81] = null; AR_CLASH[81] = [{ id: 'P16', name: 'ร้านกาแฟสุขใจ', by: 'iv', ask: 'fail' }];
      return { v: arInsHtml({ row: 79 }), s: arInsHtml({ row: 80 }), f: arInsHtml({ row: 81 }) };
    });
    ok(/ถูกยกเลิกใน PEAK แล้วถูกใช้ซ้ำ/.test(CH2.v) && /ใบที่ยกเลิกเป็นของ “บริษัท รมัย คอร์ป จำกัด”/.test(CH2.v) && /ปัจจุบันเลขนี้เป็นของ “บริษัท ดี ทรี จำกัด”/.test(CH2.v) && !/ar-ins-q/.test(CH2.v),
       '🔴 รอบ 226 การ์ด: บอกว่าเลข IV ถูกยกเลิกใน PEAK แล้วถูกใช้ซ้ำ + ใบที่ยกเลิกเป็นของใคร + ปัจจุบันเป็นของใคร');
    ok(/ใบแจ้งหนี้ของใบขายนี้ถูกยกเลิกใน PEAK/.test(CH2.s) && /ยังถาม PEAK ไม่ได้/.test(CH2.f), 'ข้อความกรณีใบขายเองถูกยกเลิก · กรณียังถาม PEAK ไม่ได้');
    const HT = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
    ok(/AR_CLASH\[r\]=\(R\.clash&&R\.clash\[r\]\)\|\|null/.test(HT), 'หน้าเว็บเก็บ clash จากคำตอบของเซิร์ฟเวอร์ทุกครั้งที่โหลดคิว');
    if (process.env.SHOT) await p.locator('#arBody').screenshot({ path: process.env.SHOT });
    await p.click('#arDenseBtn'); await p.waitForTimeout(300);
    const mini = await p.evaluate(() => { const c = document.getElementById('arc-1'), vis = e => !!e && getComputedStyle(e).display !== 'none';
      return { ph: vis(c.querySelector('.ar-ins-ph')), q: [...c.querySelectorAll('.ar-ins-q')].filter(vis).length, h: vis(c.querySelector('.ar-ins-h')) }; });
    ok(!mini.ph && mini.q === 1 && mini.h, 'แบบย่อ: เหลือสถานะ + คิวแรก (ซ่อนภาพ/คิวอื่น)');
    await p.click('#arDenseBtn'); await p.waitForTimeout(200);
    await p.click('#arViewBtn'); await p.waitForTimeout(300);
    const L = await p.evaluate(() => [...document.querySelectorAll('#arr-1 .ar-ins-l')].map(e => e.innerText).join(' | '));
    ok(/จบงานติดตั้งแล้ว/.test(L) && /ต้น, เอก/.test(L) && /ค้างมาแล้ว 45 วัน/.test(L), 'แบบรายการ: บรรทัดสถานะ · วัน · ทีม — "' + L.replace(/\s+/g, ' ') + '"');
    ok(ins.length === 1 && idCalls.length === 1, 'สลับมุมมอง/วาดการ์ดใหม่ ไม่ยิงเซิร์ฟเวอร์เพิ่ม (ไอดีรูปจำไว้ในหน้า)');
    ok(errs.length === 0, 'ไม่มี JavaScript error' + (errs.length ? ' — ' + errs.join(' | ') : ''));
  } finally {
    if (browser) await browser.close();
    if (srv) await new Promise(r => srv.close(r));
    if (rest && rest.close) await rest.close();
    await pg.query(`delete from app.projects where "ID" like 'ZZAI-%'`);
    await pg.query(`delete from app.job_deliveries where "ProjectID" like 'ZZAI-%'`);
    await pg.query(`delete from app.requirements where requirement_id like 'ZZAI-%'`);
    await pg.query(`delete from app.user_photo where username in ('kukkik','kaem')`);
    await pg.query('truncate app.total_sales, app.installation_plan, app.inspectors');
    await pg.end();
  }
  console.log('\n' + (fail ? '❌' : '✅') + ' ผ่าน ' + pass + ' · ไม่ผ่าน ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('💥', e); process.exit(1); });
