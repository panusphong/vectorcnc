'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  ทดสอบโมดูลคีย์ยอดขาย — npm run test:sales
 *
 *  โมดูลนี้เป็น "อ่านอย่างเดียว" ในเฟสนี้ เทสต์จึงต้องพิสูจน์ 2 เรื่องคู่กัน:
 *    1) อ่านได้ถูกต้องจริง — ค้นหา · กรอง · แบ่งหน้า · ยอดรวม
 *    2) ‼ เขียนไม่ได้จริง — ไม่มี endpoint ไหนแก้ข้อมูลได้เลยแม้แต่ตัวเดียว
 *
 *  ข้อ 2 สำคัญกว่าข้อ 1 ในเฟสนี้ เพราะทีมยังคีย์งานในแอปเดิมอยู่
 *  ถ้าระบบใหม่เขียนได้ = ข้อมูลสองที่ขัดกัน แล้วรอบซิงค์ถัดไปทับของที่เพิ่งคีย์หาย
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');

const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:55432/postgres';
const REST_PORT = 55457;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

process.env.SUPABASE_URL = `http://127.0.0.1:${REST_PORT}`;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = 'c'.repeat(64);

const db = require('../core/db');
const salesMod = require('../modules/sales/index.js');

/** เก็บ route ที่โมดูลลงทะเบียน โดยไม่ต้องยก express มาทั้งตัว */
function fakeRouter() {
  const routes = [];
  const mk = method => (p, ...h) => routes.push({ method, path: p, handler: h[h.length - 1] });
  return {
    routes,
    use: () => {},
    get: mk('GET'), post: mk('POST'), put: mk('PUT'),
    patch: mk('PATCH'), delete: mk('DELETE'),
  };
}

/** เรียก handler แล้วคืนสิ่งที่มันตอบ */
/* ‼ ผู้ใช้ตั้งต้นของเทสต์ = แอดมิน เพื่อให้ข้อ 2-3 ทดสอบ "ข้อมูล" ไม่ใช่ "สิทธิ์"
 *   ข้อที่ทดสอบสิทธิ์จริง ๆ จะส่ง user ของตัวเองเข้ามาเอง */
const ADMIN_USER = { username: 'admin', name: 'ผู้ดูแลระบบ', permission: 'Administrator' };

function call(handler, query = {}, params = {}, user = ADMIN_USER) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    Promise.resolve(handler({ query, params, user }, res)).catch(reject);
  });
}

(async () => {
  console.log('\n🧪 ทดสอบโมดูลคีย์ยอดขาย\n');

  const pg = new Client({ connectionString: PG });
  await pg.connect();
  await pg.query('truncate app.total_sales');

  /* ‼ ทะเบียนคำนำหน้ารหัสงาน — ชุดนี้ต้องหว่านเองทุกครั้ง ห้ามพึ่งของที่ค้างอยู่ในฐาน
   *   บทเรียน 8 ก.ย. 69: เทสต์อีกตัวเผลอ `delete from app.sales_prefix` ทั้งตาราง
   *   ชุดนี้เลยพังยกแถบ (Create By ว่าง → เดาจาก prefix ไม่ได้) ทั้งที่โค้ดไม่ผิดเลย
   *   ⇒ เทสต์ต้องรันสลับลำดับกันได้ ใครใช้อะไรคนนั้นหว่านเอง (แบบเดียวกับ test-save.js) */
  /* ‼ ตัวนับรหัสงานของคำนำหน้าที่ชุดนี้ใช้ ต้องเริ่มจาก 0 ทุกรอบ
   *   ไม่งั้นรันซ้ำครั้งที่ 2 จะได้ /004 แทน /001 แล้วฟ้องว่าโค้ดพัง ทั้งที่แค่ของค้าง */
  await pg.query(`delete from app.job_code where code like 'ZQ%' or code like 'ZM%'`);
  await pg.query(`delete from app.job_code_seq where head like 'ZQ%' or head like 'ZM%'`);
  await pg.query(`insert into app.sales_prefix (prefix, username, nickname) values
      ('B2','b2sale','บีทู'), ('B2E','b2esale','อีฟ'),
      ('B2G','kungking','กุ๊งกิ๊ง'), ('B2K','mink','มิ้งค์')
    on conflict (prefix) do update set username = excluded.username,
      nickname = excluded.nickname`);

  /* ข้อมูลตัวอย่าง — จำลองของจริงให้ครบทุกเคสที่หน้าจอต้องรับมือ */
  const rows = [
    ['B2K2609/001', '2026-09-01', 'บริษัท ก จำกัด', 'ปิดการขาย',  'IV-2026090100001', 15000, 15000, 'มิ้งค์'],
    ['B2K2609/002', '2026-09-02', 'บริษัท ข จำกัด', 'ปิดการขาย',  'IV-2026090200002', 25500, 10000, 'มิ้งค์'],
    ['QP2604/031',  '2026-04-22', 'สยามออริจินัลฟู้ด', 'กำลังคุย', 'QT202604220008',  8000,      0, 'ต้าร์'],
    [null,          '2026-08-15', 'ลูกค้าไม่มีรหัส',  'ยกเลิก',    null,               5000,      0, 'ต้าร์'],
  ];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    await pg.query(
      /* ‼ ใส่ชื่อคนที่คอลัมน์ "Create By" ไม่ใช่ "Sales Name"
       *   เพราะของจริงในชีต "Sales Name" ว่างเกือบทั้งหมด (บทเรียน 4 ก.ย. 69) */
      `insert into app.total_sales
         (_row,"รหัสงาน","วันที่ปิดการขาย","ชื่อบริษัท","Lead Status","เลขที่ QO / IV",
          "ยอดขาย (บาท)","รับจริง (บาท)","Create By","เบอร์ติดต่อ")
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [i + 2, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], '08' + (11111111 + i)]);
  }

  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  const router = fakeRouter();
  await salesMod.mount(router, { db, auth: {} });
  const route = (m, p) => (router.routes.find(r => r.method === m && r.path === p) || {}).handler;

  try {
    /* ── 1) กติกาของฝั่งเขียน ──
     *
     *  5 ก.ย. 69 พี่เอสั่งเปิดให้คีย์ได้จริง เทสต์ชุดนี้จึงเปลี่ยนจาก
     *  "ห้ามเขียนอะไรเลย" เป็น "เขียนได้ แต่ต้องเขียนตามลำดับที่ปลอดภัย"
     *
     *    1. ลงชีตก่อนเสมอ แล้วค่อยตามลงฐานข้อมูล
     *       (ชีตยังเป็นแหล่งความจริง รอบซิงค์ถัดไปจะได้ไม่ทับของที่เพิ่งคีย์)
     *    2. ห้ามแตะ PEAK เด็ดขาด — ข้อนี้ไม่มีวันเปลี่ยน */
    console.log('1) ‼ กติกาของฝั่งเขียน');
    /* endpoint ที่ไม่ใช่ GET มีได้เท่าที่อยู่ในรายชื่อนี้เท่านั้น
     *   /api/save   → เขียนลงชีตขาย
     *   /api/peak/* → สั่งงาน "อ่านจาก PEAK" (เป็น POST เพราะรับพารามิเตอร์ยาว
     *                  ไม่ใช่เพราะไปเขียนอะไรที่ PEAK)
     *   /api/avatars/refresh → ดึงรูปจาก Drive มาเก็บที่ Storage ของเราเอง
     *                  เป็น POST เพราะเป็นคำสั่งที่ทำให้เกิดผล ไม่ใช่การอ่านเฉย ๆ
     *                  ‼ ไม่แตะไฟล์ต้นทางใน Drive — ขอ scope drive.readonly เท่านั้น
     *
     *   /api/avatars/upload · delete · import (5 ก.ย. 69)
     *                  ทางใส่รูปพนักงานที่ "ไม่พึ่งชีต" — พี่เอกำลังจะปิดชีต
     *                  ถ้าไม่มีทางนี้ พนักงานใหม่จะไม่มีทางมีรูปได้เลย
     *                  ‼ เขียนลง Storage + app.user_photo ของเราเอง
     *                    ไม่แตะชีตและไม่แตะ Drive แม้แต่ครั้งเดียว */
    const ALLOW_WRITE = ['/api/save', '/api/peak/ping', '/api/peak/preview',
                         '/api/peak/apply', '/api/avatars/refresh',
                         '/api/avatars/upload', '/api/avatars/delete',
                         '/api/avatars/import',
                         /* คิวซิงก์หลังบ้าน — สั่งงานฝั่งเรา ไม่ได้เขียนอะไรที่ PEAK */
                         '/api/peak/queue/build', '/api/peak/queue/run',
                         '/api/peak/auto/start', '/api/peak/auto/stop',
                         '/api/peak/daily/on', '/api/peak/daily/off',
                         '/api/peak/clear-nonclosed', '/api/peak/probe',
                         /* ‼ แคมเปญ "สลิปรวยไม่อั้น" ย้ายมาเป็นเมนูงานในแอปนี้แล้ว
                          *   (พี่เอสั่ง 6 ก.ย. 69 — ไม่ใช่แอปแยกอีกต่อไป)
                          *   4 ตัวนี้เขียนลงตารางของแคมเปญเอง ไม่แตะข้อมูลขาย
                          *   และทุกตัวมีด่าน Permission Administrator คุมอยู่ที่เซิร์ฟเวอร์
                          *   🔒 ไม่มีตัวไหนเขียนกลับไปที่ PEAK */
                         '/api/camp/settings', '/api/camp/settings/reset',
                         '/api/camp/approve', '/api/camp/pay',
                         /* ‼ ลบรายการขาย (พี่เอสั่ง 6 ก.ย. 69)
                          *   สิทธิ์คุมที่เซิร์ฟเวอร์: เจ้าของงาน · admin · Namna
                          *   มีเทสต์ครบใน tools/test-save.js หัวข้อ 8 */
                         '/api/delete',
                         /* ‼ ตั้งค่าคำนำหน้ารหัสงาน — เฉพาะ user admin + namna
                          *   (พี่เอสั่ง 6 ก.ย. 69 เจาะจง "ชื่อผู้ใช้" ไม่ใช่แค่สิทธิ์แอดมิน) */
                         '/api/prefix/save', '/api/prefix/delete',
                         /* ‼ บันทึกการติดตามเก็บเงิน — เมนู "ลูกหนี้ค้างชำระ"
                          *   (พี่เอสั่ง 7 ก.ย. 69 · ยกจาก logFollowUp Code.gs:7054)
                          *   เขียนเฉพาะช่องติดตามในแถวนั้น + จดประวัติลง collect_log
                          *   สิทธิ์คุมรายใบที่เซิร์ฟเวอร์ (_arCanEdit): เจ้าของงาน ·
                          *   งานที่ยังไม่ระบุเซลส์ · Administrator · Accounting · ทีมเก็บเงิน
                          *   มีเทสต์ครบใน tools/test-ar-aging.js หัวข้อ ⑦⑧
                          *   🔒 ไม่เขียนกลับไปที่ PEAK และไม่แตะยอดเงินในใบงาน */
                         '/api/ar-aging/follow',
                         /* ‼ โอนลูกค้าไปเซลส์คนใหม่ — เมนูงาน (พี่เอสั่ง 8 ก.ย. 69)
                          *   ยกจาก transferCustomers (Code.gs:5045) ทั้งกติกา
                          *   เขียนเฉพาะ "ช่องเจ้าของ": Contacts → Create By ·
                          *   ใบงานที่ยังไม่ปิดการขาย → Create By / Sales Code / Sales Name
                          *   🔴 ใบที่ปิดการขายแล้วไม่แตะเด็ดขาด — ประวัติยอดขายคงเดิม
                          *   สิทธิ์คุมที่เซิร์ฟเวอร์ (_requireTransfer): admin หรือชื่อใน
                          *   TRANSFER_USERS (admin · Namna · Kunlakarn.c) ตามของเดิมเป๊ะ
                          *   มีเทสต์ครบใน tools/test-transfer.js
                          *   🔒 ไม่เขียนกลับชีต ไม่แตะยอดเงิน ไม่เรียก PEAK */
                         '/api/transfer',
                         /* ‼ รายชื่อซ้ำ — เมนูงาน (พี่เอสั่ง 8 ก.ย. 69) ยกจาก Code.gs:6765–6846
                          *   แก้/ลบ/รวม เฉพาะ CONTACT_ADMINS = admin · Namna (กันที่เซิร์ฟเวอร์)
                          *   ‼ ลบไม่ได้ถ้ายังมีงานขายผูกอยู่ — ต้องรวมรายชื่อเท่านั้น
                          *   🔒 จดลง contact_gone เพื่อไม่ให้ตัวซิงก์ชีตเอากลับมา
                          *   มีเทสต์ครบใน tools/test-dup-contacts.js */
                         '/api/dup-contacts/save', '/api/dup-contacts/delete', '/api/dup-contacts/merge',
                         /* ‼ เติม Create By จากรหัสงาน — ยกจาก Code.gs:5865
                          *   สิทธิ์ตามของเดิม: ผู้ดูแลระบบ (admin) เท่านั้น
                          *   เขียนช่องเดียวคือ Create By · แถวที่เดาเจ้าของไม่ได้คงค่าเดิม */
                         '/api/create-by',
                         /* ‼ นัดหมาย / กิจกรรมลูกค้า — เมนูงาน (พี่เอสั่ง 8 ก.ย. 69)
                          *   ยกจาก saveActivity/setActivityDone/deleteActivity (Code.gs:19138–19180)
                          *   เขียนลง app.activities ของตัวเอง ไม่แตะใบงานและไม่แตะยอดเงิน
                          *   ลบ/แก้ ได้เฉพาะรายการของตัวเอง (หรือผู้ดูแล) — กันที่เซิร์ฟเวอร์
                          *   🔒 รูปขึ้น Google Drive · ไม่เขียนกลับชีตเดิม · ไม่เรียก PEAK
                          *   มีเทสต์ครบใน tools/test-activity.js */
                         '/api/cust-act/save', '/api/cust-act/done', '/api/cust-act/delete',
                         /* ‼ ตามลูกค้าเก่า Online — เมนูงาน (ยกจาก saveWinbackContact Code.gs:10304)
                          *   ต่อท้ายอย่างเดียวลง app.winback_log ("แสดงทุกครั้ง" คำสั่งพี่เอในของเดิม)
                          *   ไม่แก้ ไม่ลบ ไม่แตะใบงาน · เห็นได้ทุกคน แย่งกันตามได้ตามของเดิม
                          *   มีเทสต์ครบใน tools/test-winback.js */
                         '/api/winback/save',
                         /* ‼ ติดตามงาน Outsource (RFQ) — เมนูงาน (ยกจาก Code.gs:19344–19427)
                          *   save/status/delete เขียนลง app.rfq ของตัวเอง
                          *   🔴 sync = เขียนราคากลับเข้าใบงาน 3 ช่อง (ทุน · ยอดขาย · ผู้ผลิต)
                          *      เฉพาะช่องที่มีค่า ห้ามล้างของเดิมเป็น 0 — ตามของเดิมเป๊ะ
                          *   สิทธิ์: เจ้าของงาน (คนสร้าง/เซลส์) หรือผู้ดูแล — กันที่เซิร์ฟเวอร์
                          *   มีเทสต์ครบใน tools/test-rfq.js
                          *   🔒 ไฟล์แนบขึ้น Drive · ไม่เขียนกลับชีตเดิม · ไม่เรียก PEAK */
                         '/api/rfq/save', '/api/rfq/status', '/api/rfq/delete', '/api/rfq/sync',
                         /* 🔗 รอบ 128 (26 ก.ย. 69) — พี่เอสั่ง "Sync data กับ Peak ในส่วนของ การเปิด PO …"
                          *   sync = อ่านใบ PO / ใบจ่าย DP · EXP จาก PEAK (GET ล้วน) แล้วเก็บภาพถ่ายลง app.rfq_peak
                          *   po   = "ถ้าไม่มีก็ให้คีย์เองได้" — แอดมิน · บัญชี · เจ้าของงาน คีย์เลข PO
                          *   ยามอยู่ที่ tools/test-rfq-peak.js · 🔒 ไม่มีคำขอเขียนไป PEAK */
                         '/api/rfq/peak/sync', '/api/rfq/peak/po',
                         /* ‼ 💸 ตัวดึงรายจ่ายของหน้า Cash Flow (16 ก.ย. 69)
                          *   พี่เอสั่ง: "ในส่วนของ Cash flow ยังดึงข้อมูลค่าใช้จ่ายไม่ได้เลยนะ
                          *   ทำมาหลายรอบแล้ว อย่ามั่วงานนะ เรื่องนี้สำคัญ ติดอะไร แจ้งมาให้ชัดๆ"
                          *
                          *   🔴 3 เส้นนี้เป็น POST เพราะ "สั่งงาน" (เริ่ม/หยุด/เดิน 1 รอบ)
                          *     สิ่งที่มันเขียนคือ app.peak_expenses + app.peak_state ของเราเอง
                          *   🔒 ไม่เขียนกลับชีตเดิม · ไม่แตะใบงาน · ไม่แตะยอดเงินของใคร
                          *   🔒 และ "ไม่เขียนอะไรกลับไปที่ PEAK เลย" ตามกฎเหล็กของพี่เอ
                          *      (ทุกคำขอออกทาง peak.get() ซึ่งฝัง method:'GET' ไว้ตายตัว
                          *       ยามนับ method ที่ยิงออกไว้ใน tools/test-cashflow-expense.js)
                          *   สิทธิ์: ผู้ดูแลระบบเท่านั้น (denyAdmin) — กันที่เซิร์ฟเวอร์ */
                         '/api/cashflow/expenses/start', '/api/cashflow/expenses/stop',
                         '/api/cashflow/expenses/run',
                         /* ‼ 🔑⚖️ เพิ่ม 16 ก.ย. 69 รอบ 34
                          *   พี่เอสั่ง: "จัดการแก้ไข เรื่อง Cash flow รายรับ รายจ่าย ให้ได้ 100%
                          *     ตามเอกสารของ peak ที่จ่ายออกไปจริงด้วย แก้ให้จบนะ"
                          *
                          *   learn     = พี่เอป้อน "เลขเอกสารจริงจาก PEAK 1 ใบ" ให้ระบบถอดรูปแบบเอง
                          *               เป็น POST เพราะเลขเอกสารเป็นข้อมูลที่ผู้ใช้ส่งเข้ามา
                          *               (ไม่ควรไปโผล่ใน URL/log) และมันจดกติกาลง app.peak_state
                          *   reconcile = กระทบยอดกับรายการที่ export จาก PEAK มาวาง (ข้อความยาว
                          *               หลักแสนตัวอักษร ⇒ ใส่ใน query string ไม่ได้)
                          *               🔒 อ่านอย่างเดียว ไม่เขียนอะไรลงฐานเลยสักแถว
                          *   🔒 ทั้งคู่ยิง PEAK ด้วย GET เท่านั้น ผ่าน peak.get() เหมือนเส้นอื่น
                          *   สิทธิ์: ผู้ดูแลระบบเท่านั้น (ยามข้อ ㉙ ใน test-cashflow-expense.js คุมไว้) */
                         '/api/cashflow/expenses/learn', '/api/cashflow/expenses/reconcile',
                         /* ‼ 🎯 เพิ่ม 21 ก.ย. 69 รอบ 67 — "ไล่เก็บใบที่ข้าม"
                          *   พี่เอตัดสิน: "ไม่ยุ่งกับ peak เราต้องหาวิธีดึงข้อมูลที่ถูกต้องเอาเองนะ"
                          *   refetch = ยิงถามเฉพาะเลขเอกสารที่สำมะโนบอกว่าขาดกลางวัน
                          *   เป็น POST เพราะ "สั่งงานที่ยิง PEAK จริง" — และ **ยิงเฉพาะเมื่อ
                          *   confirm = 1 ที่พี่เอกดยืนยันบนจอเท่านั้น** (GET = ดูแผนอย่างเดียว ไม่ยิง)
                          *   🔒 เขียนเพิ่มลง app.peak_expenses อย่างเดียว **ไม่ลบอะไรเลย**
                          *   🔒 รายการเลขคิดที่เซิร์ฟเวอร์จากตารางจริง ไม่รับรายการเลขจากหน้าเว็บ
                          *   🔒 ยิง PEAK ด้วย GET เท่านั้น ผ่าน ask() → peak.get() เหมือนเส้นอื่น
                          *   สิทธิ์: ผู้ดูแลระบบเท่านั้น (denyAdmin) · ยามอยู่ใน tools/test-exp-census.js */
                         '/api/cashflow/expenses/refetch',
                         /* 🔁 รอบ 73 — ดึงย้อนหลัง 45 วันเดี๋ยวนี้ (GET ไป PEAK · ไม่ลบอะไร) */
                         '/api/cashflow/expenses/recent',
                         /* ‼ 🔎 เพิ่ม 21 ก.ย. 69 รอบ 68 — "ลองดึงแบบรายการอีกครั้ง"
                          *   พี่เอ: "Peak เค้าเปิดให้ api มาแล้วอยู่ที่เราดึงได้หรือเปล่านะ"
                          *   probe = ไล่ลองท่าขอเป็นรายการ (ท่าเลขหน้าจากเอกสาร PEAK อยู่บนสุด)
                          *   แล้ววัดหน้าละกี่แถว · PEAK เคารพเลขหน้าไหม · ชื่อช่องของแถวแรก
                          *   เป็น POST เพราะยิง PEAK จริงและจำท่าที่ชนะลง app.peak_state
                          *   🔒 ไม่เขียนรายจ่ายลงตาราง · ไม่ลบอะไร · GET ล้วนผ่าน ask()
                          *   สิทธิ์: ผู้ดูแลระบบเท่านั้น (denyAdmin) · ยามอยู่ใน tools/test-peak-list68.js */
                         '/api/cashflow/expenses/probe',
                         /* ‼ 🤝 เพิ่ม 3 ต.ค. 69 รอบ 222 — หน้า "Lead จาก Affiliate" (เมนูงาน → เฉพาะแอดมิน)
                          *   พี่เอสั่ง: "ดึงข้อมูล เข้ามาสร้าง leads ใน app คีย์ยอดขาย แบบ auto
                          *     ทันทีที่มีรายการใหม่ หรือมีการแก้ไขจาก database ก้อนนี้"
                          *   config   = บันทึกบัญชีกลาง · คำนำหน้ารหัสงาน · จับคู่คนรับ lead ↔ ผู้ใช้ (ลง app.settings)
                          *   pull     = สั่งตัวเก็บตกทำงานเดี๋ยวนี้ · backfill = ดึง lead ย้อนหลังทั้งหมด
                          *   🔒 อ่านฐาน Affiliate ด้วย GET เท่านั้น (affiliate-src.js) · ไม่แตะ PEAK · ไม่ลบอะไร
                          *   🔒 เขียนเฉพาะช่องข้อมูล lead/เจ้าของ — ไม่มีช่องเงิน · ปิดการขาย · PEAK
                          *   สิทธิ์: ผู้ดูแลระบบเท่านั้น (gate) · ยามอยู่ใน tools/test-affiliate.js */
                         '/api/affiliate/config', '/api/affiliate/pull', '/api/affiliate/backfill',
                         /* ‼ 📒 เพิ่ม 4 ต.ค. 69 รอบ 233 — "ลองถาม PEAK ตามรหัสผังบัญชี"
                          *   พี่เอ: "เค้าไม่ได้คีย์ใน EXP 100% มันจะมีคีย์ไปที่รหัสผังบัญชีโดยตรง ส่วนนี้ไปเอามาได้มั้ย"
                          *   probe = ถามผังบัญชี · งบทดลอง · บัญชีแยกประเภท · สมุดรายวัน แล้วกางโครงคำตอบ
                          *   เป็น POST เพราะยิง PEAK จริง (~7 คำขอ/กิจการ) และจดสรุปผลลง app.peak_state
                          *   🔒 GET ล้วนไป PEAK · ไม่เขียนตารางข้อมูล · ไม่ลบอะไร · ยังไม่นำไปคิดในรายงาน
                          *   สิทธิ์: ผู้ดูแลระบบเท่านั้น (denyAdmin) · ยามอยู่ใน tools/test-peak-ledger.js */
                         '/api/cashflow/ledger/probe',
                         /* รอบ 235 — สั่งดึงสมุดเงินสดจาก PEAK (GET ล้วนไปที่ PEAK · เขียนเฉพาะตารางสมุดเงินสดของเรา) */
                         '/api/cashbook/sync'];
    const writeRoutes = router.routes.filter(r => r.method !== 'GET');
    const stray = writeRoutes.filter(r => !ALLOW_WRITE.includes(r.path));
    ok(stray.length === 0,
       stray.length ? '‼ พบ endpoint เขียนที่ไม่ได้อยู่ในรายชื่อ: ' +
                      stray.map(r => r.method + ' ' + r.path).join(', ')
                    : 'endpoint ที่ไม่ใช่ GET มีเท่าที่อนุญาตไว้ (' + writeRoutes.length + ' ตัว)');
    ok(writeRoutes.every(r => r.method === 'POST'), 'ทุกตัวเป็น POST ไม่มี PUT/PATCH/DELETE');
    ok(!router.routes.some(r => ['PUT', 'PATCH', 'DELETE'].includes(r.method)),
       '‼ ไม่มี PUT/PATCH/DELETE — ลบข้อมูลผ่านหน้าเว็บไม่ได้');

    const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'sales', 'index.js'), 'utf8');
    const saveSrc = fs.readFileSync(path.join(__dirname, '..', 'modules', 'sales', 'save.js'), 'utf8');
    const html = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'sales', 'public', 'index.html'), 'utf8');

    ok(!/db\.(insert|update|remove|upsert)\s*\(/.test(src),
       'index.js ไม่เขียนฐานข้อมูลเอง — ให้ save.js ทำที่เดียว');

    /* ═══════════════════════════════════════════════════════════
     *  🎨 ปุ่ม .act พื้นม่วงเข้ม — ตัวอักษรต้องขาว
     *
     *  ‼ พี่เอวงมาให้ดู 6 ก.ย. 69: "เปลี่ยนสีอักษรเป็นสีขาวให้ด้วย"
     *    ต้นเหตุ: ใส่ style="color:#047857" ทับปุ่ม .act
     *    กลายเป็นเขียวเข้มบนม่วงเข้ม = อ่านแทบไม่ออก
     *
     *  กติกา: ทับสีตัวอักษรของ .act ได้ก็ต่อเมื่อทับ "พื้นหลัง" ด้วย
     *    ไม่งั้นตัวอักษรสีเข้มจะไปนั่งบนพื้นม่วงเข้มเหมือนเดิม
     * ═══════════════════════════════════════════════════════════ */
    const actBtns = html.match(/<button[^>]*class="act"[^>]*>/g) || [];
    const badColor = actBtns.filter(b => {
      const st = (b.match(/style="([^"]*)"/) || [])[1] || '';
      const col = (st.match(/(?:^|;)\s*color\s*:\s*([^;]+)/) || [])[1];
      if (!col) return false;                                   /* ไม่ทับ = ใช้ขาวตาม CSS */
      if (/#fff|white/i.test(col)) return false;                /* ขาว = ถูกต้อง */
      return !/background\s*:/.test(st);                        /* ทับสีเข้มโดยไม่เปลี่ยนพื้น = ผิด */
    });
    ok(badColor.length === 0,
       badColor.length ? '‼ ปุ่ม .act ตัวอักษรสีเข้มบนพื้นม่วง อ่านไม่ออก: ' +
                         badColor.map(b => b.slice(0, 70)).join(' | ')
                       : '🎨 ปุ่ม .act ทุกตัวอ่านออก — ตัวอักษรขาว หรือเปลี่ยนพื้นหลังคู่กัน (' +
                         actBtns.length + ' ปุ่ม)');
    /* ═══════════════════════════════════════════════════════════
     *  ‼ กติกาใหม่ 6 ก.ย. 69 — พี่เอสั่ง:
     *    "ให้บันทึก ลง Supabase อย่างเดียว ไม่ต้องไปที่ sheet แล้วนะ"
     *    "ยกเว้น ไฟล์ภาพ และไฟล์งานพิมพ์ ไฟล์งานตัด ที่บันทึกไปยัง google drive"
     *    "ยกเว้นรูปพนักงาน ให้บันทึกไว้ที่ supabase"
     *
     *  เทสต์ชุดนี้เคยบังคับตรงกันข้าม (ต้องเขียนชีตก่อน) — กลับด้านแล้ว
     *  ‼ เทสต์ที่ยังบังคับกติกาเก่า อันตรายกว่าไม่มีเทสต์
     *    เพราะมันจะดึงระบบกลับไปทางเดิมโดยที่ไม่มีใครทันสังเกต
     * ═══════════════════════════════════════════════════════════ */
    ok(!/sheets\.(appendRow|updateRow|updateCells)\s*\(/.test(saveSrc),
       '‼ save.js ไม่เขียนลงชีตอีกแล้ว — ลง Supabase ที่เดียว');
    ok(/db\.(insert|update)\s*\(/.test(saveSrc),
       'save.js เขียนลงฐานข้อมูลจริง');

    /* ‼ คำสั่งลบในไฟล์นี้มีได้แค่ 2 แบบเท่านั้น:
     *    ① ลบแถวทดสอบของตัวเอง (probeRow — เลขแถวติดลบ ไม่ใช่ข้อมูลจริง)
     *    ② deleteRecord() ที่ผู้ใช้สั่งเอง ซึ่งผ่านด่านสิทธิ์ canDelete แล้ว
     *  ‼ เจอ db.remove ที่ไม่เข้าข่ายทั้งสองแบบ = มีทางลบข้อมูลจริงโดยไม่ตรวจสิทธิ์ */
    const removes = saveSrc.match(/db\.remove\s*\([^;]*/g) || [];
    ok(removes.every(r => /probeRow|found\.row/.test(r)),
       '‼ คำสั่งลบมีได้เฉพาะแถวทดสอบ + ใบที่ผ่านด่านสิทธิ์ (' + removes.length + ' จุด)');
    /* ‼ ทางลบข้อมูลจริงต้องผ่าน canDelete เสมอ — ไม่มีทางลัด
     *   v1.17.0 เพิ่มอาร์กิวเมนต์ที่ 3 (เจ้าของที่เดาจากคำนำหน้ารหัสงาน — กฎ v22.5)
     *   จึงรับได้ทั้งมีและไม่มี แต่ต้องเรียก canDelete อยู่ดี */
    ok(/canDelete\(user, row(, owner)?\)/.test(saveSrc) && /e\.userError = true/.test(saveSrc),
       '‼ deleteRecord ตรวจสิทธิ์ก่อนลบเสมอ');
    ok(/SUPER_USERS = \['admin', 'namna'\]/.test(saveSrc),
       '‼ คนที่ลบใบคนอื่นได้ = admin + Namna เท่านั้น (คำสั่งพี่เอ 6 ก.ย. 69)');

    /* ═══════════════════════════════════════════════════════════
     *  ‼ งานซิงค์ยอดขาย: วิ่งเองได้ แต่ต้องมีตัวกันครบ
     *
     *  ประวัติของกติกาข้อนี้ — เปลี่ยนมาแล้ว 3 รอบ อ่านให้ครบก่อนแก้:
     *    รอบ 1  ตัดงานนี้ทิ้งไปเลย
     *    รอบ 2  (พี่เอสั่ง 6 ก.ย.) "ให้เปิดเป็น manual ไว้ให้พี่กดเองได้นะ
     *           อย่าตัดออก" → เอากลับมาเป็น "กดเองเท่านั้น"
     *    รอบ 3  (พี่เอสั่ง 7 ก.ย.) "ปรับ การ sync data จาก google sheets
     *           ให้เป็น แบบ auto ทั้งหมดนะ" → วิ่งเองได้
     *
     *  ‼ แต่ "วิ่งเองได้" ไม่ได้แปลว่าถอดตัวกันออก
     *    เหตุผลที่เคยห้ามวิ่งเองยังอยู่ครบทุกข้อ แค่ย้ายไปกันที่ตัวซิงก์แทน:
     *      ① noDelete    — ไม่มีในชีต ≠ ถูกลบ (อาจเป็นงานที่คีย์ในระบบใหม่)
     *      ② keepNewerBy — ระบบใหม่แก้ทีหลัง = ของจริง ห้ามเอาชีตมาทับ
     *    ‼ ขาดข้อใดข้อหนึ่ง = กลับไปเป็น "ใบที่เพิ่งคีย์หายทุก 10 นาที"
     *      ซึ่งคือเหตุผลทั้งหมดที่มันเคยถูกล็อกไว้ตั้งแต่แรก
     * ═══════════════════════════════════════════════════════════ */
    const salesJob = require('../core/sync-jobs').jobs().find(j => j.name === 'sales');
    ok(!!salesJob, '‼ งานซิงค์ยอดขายยังอยู่ (ห้ามตัดทิ้ง)');
    ok(salesJob && salesJob.noDelete === true,
       '‼ วิ่งเองได้ แต่ต้องไม่ลบแถวที่ไม่มีในชีต (งานที่คีย์ในระบบใหม่)');
    ok(salesJob && salesJob.keepNewerBy === 'Updated At',
       '‼ และต้องไม่เอาชีตมาทับของที่ระบบใหม่แก้ทีหลัง');
    const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    ok(/job\.manualOnly\s*&&\s*!manual/.test(srvSrc),
       '‼ รอบซิงค์อ่านธง manualOnly จริง ไม่ใช่ติดป้ายไว้เฉย ๆ');
    ok(/runAllSync\('ตามเวลา'\)/.test(srvSrc) && /runAllSync\([^)]*\{\s*manual:\s*true/.test(srvSrc),
       '‼ รอบตามเวลาไม่ส่ง manual · ปุ่มกดเองส่ง manual:true');

    /* ‼ ห้ามมี "คำขอที่ยิงออกไปหา PEAK" แบบเขียน อยู่ในไฟล์ไหนเลย
     *
     *   ต้องแยกให้ออกระหว่าง 2 อย่างที่หน้าตาคล้ายกัน:
     *     · router.post('/api/peak/...')  = endpoint ของเราเอง ไม่ได้ยิงไป PEAK
     *     · fetch(PEAK…, {method:'POST'}) = ยิงไป PEAK จริง — ต้องไม่มี ยกเว้น ClientToken
     *   รอบก่อนเทสต์จับผิดตัว เพราะดูแค่ว่าบรรทัดนั้นมีคำว่า peak ไหม */
    const pkSyncSrc = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'sales', 'peak-sync.js'), 'utf8');
    const peakWrites = [];
    for (const [name, code] of [['index.js', src], ['save.js', saveSrc],
                                ['index.html', html], ['peak-sync.js', pkSyncSrc]]) {
      code.split('\n').forEach((ln, i) => {
        if (/router\.(post|put|patch|delete)\s*\(/.test(ln)) return;   // endpoint ของเราเอง
        if (/API\('\/api\/peak/.test(ln)) return;                      // หน้าเว็บเรียก endpoint เรา
        if (!/peak/i.test(ln)) return;
        if (/method:\s*['"]?(POST|PUT|PATCH|DELETE)|UrlFetch|\.put\(|\.patch\(|\.delete\(/i.test(ln))
          peakWrites.push(`${name}:${i + 1}`);
      });
    }
    ok(peakWrites.length === 0,
       peakWrites.length ? '‼ พบคำสั่งเขียนที่ยิงไป PEAK: ' + peakWrites.join(', ')
                         : '‼ ไม่มีคำขอเขียนที่ยิงไป PEAK เลยแม้แต่บรรทัดเดียว');

    ok(!/api\.peakaccount\.com/.test(html),
       '‼ หน้าเว็บไม่มี URL ของ PEAK อยู่เลย — คุยผ่านเซิร์ฟเวอร์ทางเดียว');

    /* ── 1.0) ‼ PEAK อ่านอย่างเดียว — ข้อที่ไม่มีวันเปลี่ยน ──
     *
     *  5 ก.ย. 69 เปิดปุ่มซิงก์ PEAK แล้ว เทสต์ชุดนี้จึงต้องแน่นกว่าเดิม
     *  ไม่ใช่แค่ "ไม่มีคำสั่งเขียน" แต่ต้องพิสูจน์ว่า "เขียนไม่ได้ต่อให้พยายาม" */
    const peakSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'peak.js'), 'utf8');

    /* POST ไป PEAK ได้ที่เดียวคือ /ClientToken = ขอกุญแจ ไม่มีข้อมูลธุรกิจติดไป */
    const posts = (peakSrc.match(/method:\s*'POST'/g) || []).length;
    ok(posts === 1, '‼ core/peak.js มี POST อยู่จุดเดียว (ได้ ' + posts + ')');
    ok(/BASE \+ '\/ClientToken'/.test(peakSrc),
       '‼ POST จุดเดียวนั้นคือ /ClientToken = ขอกุญแจเข้าระบบ');
    ok(!/method:\s*'(PUT|PATCH|DELETE)'/.test(peakSrc),
       '‼ ไม่มี PUT/PATCH/DELETE ใน core/peak.js เลย');
    ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(pkSyncSrc),
       '‼ peak-sync.js ไม่ยิงคำขอเขียนเองเลย — ผ่าน core/peak.js ทางเดียว');

    const peak = require('../core/peak.js');
    /* ด่าน ALLOW ต้องปฏิเสธ endpoint ที่ไม่ได้อยู่ในรายชื่อ */
    for (const bad of ['Invoices/create', 'receipts/void', '../admin', 'Invoices?x=1']) {
      let msg = '';
      try { await peak.get(bad, {}, 'The 101'); } catch (e) { msg = e.message; }
      ok(/READ-ONLY/.test(msg), '‼ ปฏิเสธ endpoint "' + bad + '" ที่ด่าน READ-ONLY');
    }
    ok(![...peak.ALLOW].some(x => /create|update|delete|void|cancel|post/i.test(x)),
       '‼ รายชื่อ endpoint ที่อนุญาต ไม่มีตัวไหนเป็นคำสั่งเขียนเลย');

    /* แยกกิจการจากเลขเอกสาร (BIZ_DOC_RULE code.gs:7921) */
    ok(peak.bizOfDoc('IV-2026082100017') === 'มดงานการป้าย',
       'เลข 13 หลัก (ปี ค.ศ.) → มดงานการป้าย');
    ok(peak.bizOfDoc('IV-69082200003') === 'The 101',
       'เลข 11 หลัก (ปี พ.ศ.) → The 101');

    /* ตัวแยกภาษีหัก ณ ที่จ่าย — ห้ามแต่งตัวเลข (v27.2 · v30.1) */
    const pks = require('../modules/sales/peak-sync.js');
    let sp = pks.splitReceipt({ totalAmount: 20000, paidPayments: [
      { paymentTotal: 19439.25, paymentMethod: 'เงินโอน' },
      { paymentTotal: 560.75,  paymentMethod: 'ภาษีหัก ณ ที่จ่าย 3%' }] });
    ok(sp.cash === 19439.25 && sp.wht === 560.75,
       '‼ แยกภาษีจาก paidPayments ได้ตรงตัว (เงินเข้า ' + sp.cash + ' ภาษี ' + sp.wht + ')');
    sp = pks.splitReceipt({ totalAmount: 20000, paidPayments: [{ paymentTotal: 20000, paymentMethod: 'เงินโอน' }] });
    ok(sp.wht === 0 && sp.cash === 20000, 'ไม่มีภาษี → ไม่แต่งตัวเลขให้');
    /* ‼ เพดาน 25% อยู่ที่ "ใบแจ้งหนี้" ไม่ใช่ "ใบเสร็จ" — ของเดิมก็วางไว้ตรงนั้น
     *
     *   ใบเสร็จ 1 ใบอาจบันทึกภาษีทั้งก้อนเป็นช่องทางรับเงินช่องเดียว
     *   (ผู้จ่ายหักภาษีทั้งก้อนที่งวดนี้ — เคสจริงที่พี่เอเจอ IV-2026080300010)
     *   ถ้าเอาเพดานมาไว้ที่ใบเสร็จ ภาษีจริงก้อนนั้นจะถูกล้างเป็นศูนย์เงียบ ๆ
     *   แล้วยอดรับจริงจะผิดโดยไม่มีใครรู้ */
    sp = pks.splitReceipt({ totalAmount: 20000, paidPayments: [
      { paymentTotal: 12000, paymentMethod: 'ภาษีหัก ณ ที่จ่าย' }] });
    ok(sp.wht === 12000,
       '‼ ใบเสร็จไม่มีเพดาน — บันทึกภาษีทั้งก้อนในงวดเดียวได้จริง ห้ามล้างทิ้ง');

    /* เพดานทำงานที่ระดับใบแจ้งหนี้ */
    const inv1 = pks.normInvoice({ netAmount: 20000, withholdingTax: 12000 });
    ok(inv1.wht === 0 && inv1.payable === 20000,
       '‼ ภาษีเกิน 25% ของยอดบิล = อ่านผิดแน่ ๆ ตัดทิ้ง ไม่เอาไปลบยอด');
    const inv2 = pks.normInvoice({ netAmount: 20000, withholdingTax: 600 });
    ok(inv2.wht === 600 && inv2.payable === 19400,
       'ภาษีในเกณฑ์ → หักออกจากยอดที่ต้องชำระถูกต้อง');

    /* ‼ ห้ามไล่เก็บภาษีจากรายการย่อย — จะได้ภาษีของบรรทัดเดียวมาเป็นของทั้งใบ */
    const inv3 = pks.normInvoice({ netAmount: 20000,
      lineItems: [{ withholdingTax: 300 }, { withholdingTax: 200 }] });
    ok(inv3.wht === 0,
       '‼ อ่านภาษีจากหัวใบเท่านั้น ไม่ไล่ลงไปในรายการย่อย');

    /* ‼ งวดรับเงิน + วันรับล่าสุด ต้องมี ไม่งั้นลายเซ็นข้อมูลจับความเปลี่ยนแปลงไม่ได้ */
    const inv4 = pks.normInvoice({ netAmount: 10000, paidPayments: [
      { paymentTotal: 4000, paymentDate: '2026-08-01' },
      { paymentTotal: 6000, paymentDate: '2026-09-02' }] });
    ok(inv4.pays.length === 2, 'คืนงวดรับเงินมาครบ');
    ok(inv4.lastPayAt === '2026-09-02', 'คืนวันรับเงินล่าสุดถูกต้อง');
    ok(inv4.dueAt !== undefined, '‼ มีช่อง dueAt (ตัวคำนวณตารางตรวจซ้ำอ่านชื่อนี้)');

    /* ลายเซ็นต้องเปลี่ยนเมื่อจำนวนงวดเปลี่ยน แม้ยอดรวมเท่าเดิม */
    const pq = require('../core/peak-queue');
    const inv5 = pks.normInvoice({ netAmount: 10000, paidPayments: [
      { paymentTotal: 10000, paymentDate: '2026-09-02' }] });
    ok(pq.fingerprint(inv4, null) !== pq.fingerprint(inv5, null),
       '‼ ยอดรวมเท่ากันแต่จำนวนงวดต่าง → ลายเซ็นต้องต่าง ไม่งั้นข้อมูลค้างเก่าแบบเงียบ');

    /* เลือกใบที่ใช้ได้ (v31.6 · v32.0 · v32.7) */
    ok(pks.pickDoc([]).state === 'miss', 'ไม่มีใบเลย → ไม่พบใน PEAK');
    ok(pks.pickDoc([{ status: 'Void' }]).state === 'void', 'มีแต่ใบที่ถูกยกเลิก → ใบถูกยกเลิก');
    ok(pks.pickDoc([{ status: 'Draft' }]).state === 'draft', 'มีแต่ใบร่าง → ใบร่าง');
    ok(pks.pickDoc([{ status: 'Draft' }, { status: 'Approve' }]).state === 'ok',
       '‼ อนุมัติแล้วชนะใบร่าง (v32.7)');
    ok(pks.pickDoc([{ status: 'Approve' }, { status: 'Approve' }]).state === 'dup',
       '‼ เลขเดียวได้ 2 ใบที่อนุมัติแล้ว → ห้ามเดา ห้ามเขียนทับ (v32.0)');

    /* งาน QT = FlowAccount ไม่มีทางเจอใน PEAK (v21.6) */
    ok(pks.isFlow('QT202604220008'), 'เลขขึ้นต้น QT → อยู่ใน FlowAccount');
    ok(!pks.isFlow('IV-2026090400026'), 'เลข IV ปกติ → ไม่ใช่ FlowAccount');

    /* คอลัมน์ PEAK ต้องไม่อยู่ในแผนที่ช่องที่ระบบเขียน (ยกเว้นลิงก์ที่เซลส์วางเอง) */
    const save = require('../modules/sales/save.js');
    const peakCols = Object.values(save.FIELD_COL).filter(c => /PEAK/.test(c));
    ok(peakCols.length === 1 && peakCols[0] === 'ลิงก์เอกสาร PEAK',
       '‼ ช่อง PEAK ที่ระบบเขียนได้มีช่องเดียว คือ "ลิงก์เอกสาร PEAK" ที่เซลส์วางลิงก์เอง ' +
       '(ได้ ' + (peakCols.join(', ') || 'ไม่มี') + ')');

    /* ── 1.1) ด่านตรวจก่อนบันทึก ── */
    console.log('\n1.1) ด่านตรวจก่อนบันทึก');
    const base = { company: 'บ.ทดสอบ', contact: 'คุณเอ', phone: '0812345678',
                   biz: 'The 101', source: 'Online', platform: 'LINE@THE101',
                   maker: 'ผลิตเอง-The101' };
    ok(save.validate({ ...base, company: '' }) === 'กรอกชื่อผู้ติดต่อ / บริษัท / เบอร์ ให้ครบก่อนบันทึก',
       'ขาดชื่อบริษัท → เตือนข้อความเดิมเป๊ะ');
    ok(save.validate({ ...base, biz: '', maker: '' }) === 'กรุณาเลือก บริษัทที่ขาย และ ผู้ผลิต ก่อนบันทึก',
       'ขาด 2 ดรอปดาวน์ → บอกชื่อครบทั้งคู่ตามลำดับเดิม');
    ok(/เลือกช่องทางผิด/.test(save.validate({ ...base, source: 'สาขา' }) || ''),
       '‼ ลูกค้ามาจากไหน=สาขา แต่ Platform ไม่ใช่สาขา → บล็อกไว้');
    ok(save.validate({ ...base, source: 'สาขา', platform: 'สาขา_ไท-บางใหญ่' }) === null,
       'เลือกสาขาให้ตรงกันแล้ว → ผ่าน');
    ok(save.validate(base) === null, 'กรอกครบ → ผ่าน');

    /* ── 1.2) สูตรเงิน — คำนวณซ้ำที่เซิร์ฟเวอร์ ไม่เชื่อหน้าจอ ── */
    console.log('\n1.2) สูตรเงิน (คำนวณซ้ำฝั่งเซิร์ฟเวอร์)');
    let mm = save.recompute({ ...base, billed: 50000, payAmt: 20000, payAmt1: 5000,
                             payAmt2: '', payAmt3: '', received: 999999, shortfall: -1 });
    ok(mm.received === 25000, 'รับจริง = โอน100% + งวด1+2+3 = 25,000 (ได้ ' + mm.received + ')');
    ok(mm.shortfall === 25000, 'รับขาด = 50,000 − 25,000 (ได้ ' + mm.shortfall + ')');
    ok(mm.outsource === 0, '‼ ผู้ผลิต=ผลิตเอง → ยอดสั่งซื้อ Outsource ถูกบังคับเป็น 0');

    mm = save.recompute({ ...base, billed: 10000, payAmt: 15000 });
    ok(mm.shortfall === 0, '‼ จ่ายเกินยอดเรียกเก็บ → รับขาดเป็น 0 ไม่ใช่ติดลบ');

    mm = save.recompute({ ...base, billed: '', payAmt: '' });
    ok(mm.received === '' && mm.shortfall === '', 'ไม่มีเงินเลย → ปล่อยช่องว่าง ไม่ใช่เลข 0');

    mm = save.recompute({ ...base, maker: 'บ.ผู้ผลิตภายนอก', outsource: 3000 });
    ok(Number(mm.outsource) === 3000, 'ส่งผลิตนอก → ยอดสั่งซื้อคงไว้ตามที่คีย์');

    ok(save.bizNorm('101') === 'The 101' && save.bizNorm('มดงาน') === 'มดงานการป้าย' &&
       save.bizNorm('') === 'ยังไม่ระบุ',
       'ชื่อบริษัทที่ขายถูก normalize เหมือน _bizNorm() ของเดิม');
    ok(/^\d{2}\/\d{2}\/(19|20)\d{2}$/.test(save.dsNow()),
       'วันที่อัพเดตเป็น dd/MM/yyyy ค.ศ. เวลากรุงเทพ (ได้ ' + save.dsNow() + ')');

    /* ── 2) รายการทั้งหมด + ยอดรวม ── */
    console.log('\n2) รายการและยอดรวม');
    let r = await call(route('GET', '/api/list'), {});
    ok(r.body.ok, 'เรียกรายการสำเร็จ');
    ok(r.body.total === 4, 'นับได้ครบ 4 รายการ (ได้ ' + r.body.total + ')');
    ok(r.body.sum.amount === 53500, 'ยอดขายรวม 53,500 (ได้ ' + r.body.sum.amount + ')');
    ok(r.body.sum.received === 25000, 'รับจริงรวม 25,000 (ได้ ' + r.body.sum.received + ')');
    ok(r.body.sum.due === 28500, 'ค้างรับ 28,500 — คำนวณสด ไม่ได้เก็บไว้ (ได้ ' + r.body.sum.due + ')');
    ok(r.body.rows.length === 4, 'คืนแถวมาครบ');
    ok(r.body.rows[0].job_code === 'B2K2609/002',
       'เรียงวันที่ล่าสุดขึ้นก่อน (ได้ ' + r.body.rows[0].job_code + ')');

    /* ── 3) ค้นหา ── */
    console.log('\n3) ค้นหา');
    r = await call(route('GET', '/api/list'), { q: 'B2K2609' });
    ok(r.body.total === 2, 'ค้นด้วยรหัสงานได้ 2 รายการ');
    r = await call(route('GET', '/api/list'), { q: 'สยามออริจินัล' });
    ok(r.body.total === 1, 'ค้นด้วยชื่อบริษัทภาษาไทยได้');
    r = await call(route('GET', '/api/list'), { q: 'IV-2026090100001' });
    ok(r.body.total === 1, 'ค้นด้วยเลขที่ IV ได้');
    r = await call(route('GET', '/api/list'), { q: '0811111111' });
    ok(r.body.total === 1, 'ค้นด้วยเบอร์โทรได้');
    r = await call(route('GET', '/api/list'), { q: 'ไม่มีทางเจอคำนี้' });
    ok(r.body.total === 0 && r.body.rows.length === 0, 'ไม่เจอ → คืนรายการว่าง ไม่พัง');

    /* ── 4) กรอง ── */
    console.log('\n4) กรอง');
    r = await call(route('GET', '/api/list'), { status: 'ปิดการขาย' });
    ok(r.body.total === 2, 'กรองตามสถานะได้');
    ok(r.body.sum.amount === 40500, 'ยอดรวมคิดเฉพาะที่กรองแล้ว (ได้ ' + r.body.sum.amount + ')');
    r = await call(route('GET', '/api/list'), { sale: 'ต้าร์' });
    ok(r.body.total === 2, 'กรองตามพนักงานขายได้');
    r = await call(route('GET', '/api/list'), { from: '2026-09-01' });
    ok(r.body.total === 2, 'กรองตั้งแต่วันที่ได้');
    r = await call(route('GET', '/api/list'), { to: '2026-04-30' });
    ok(r.body.total === 1, 'กรองถึงวันที่ได้');
    r = await call(route('GET', '/api/list'), { q: 'บริษัท', status: 'ปิดการขาย', sale: 'มิ้งค์' });
    ok(r.body.total === 2, 'ใช้หลายตัวกรองพร้อมกันได้');

    /* ── 5) แบ่งหน้า ── */
    console.log('\n5) แบ่งหน้า');
    r = await call(route('GET', '/api/list'), { limit: 2, page: 1 });
    ok(r.body.rows.length === 2 && r.body.pages === 2, 'หน้าละ 2 → ได้ 2 หน้า');
    const p1 = r.body.rows.map(x => x._id).join();
    r = await call(route('GET', '/api/list'), { limit: 2, page: 2 });
    ok(r.body.rows.length === 2, 'หน้า 2 มีข้อมูล');
    ok(r.body.rows.map(x => x._id).join() !== p1, 'หน้า 2 ไม่ซ้ำกับหน้า 1');
    ok(r.body.total === 4, 'ยอดรวมยังเป็นของทั้งชุด ไม่ใช่แค่หน้านี้');

    /* ── 6) ตัวเลือกในช่องกรอง ── */
    console.log('\n6) ตัวเลือกในช่องกรอง');
    r = await call(route('GET', '/api/filters'), {});
    ok(r.body.ok && r.body.status.length === 3, 'ได้รายการสถานะจากข้อมูลจริง 3 แบบ');
    ok(r.body.sales.includes('มิ้งค์') && r.body.sales.includes('ต้าร์'),
       'ได้รายชื่อพนักงานขายจากข้อมูลจริง');

    /* ── 7) รายละเอียดรายตัว ── */
    console.log('\n7) รายละเอียดรายตัว');
    const one = (await pg.query(`select _id from app.total_sales where "รหัสงาน"='B2K2609/001'`)).rows[0];
    r = await call(route('GET', '/api/row/:id'), {}, { id: String(one._id) });
    ok(r.body.ok, 'เปิดรายละเอียดได้');
    ok(r.body.data['ชื่อบริษัท'] === 'บริษัท ก จำกัด', 'ได้ข้อมูลถูกแถว');
    ok(r.body.meta._row === 2, 'บอกที่มาว่าเป็นแถวไหนในชีต');
    ok(!Object.keys(r.body.data).some(k => k.startsWith('_')),
       'ช่องระบบถูกแยกออกจากข้อมูลจริง อ่านง่าย');
    r = await call(route('GET', '/api/row/:id'), {}, { id: '999999' });
    ok(r.status === 404, 'ไม่พบ → 404 ไม่ใช่พัง');

    /* ── 8) แถวที่ข้อมูลไม่ครบ ── */
    console.log('\n8) แถวที่ข้อมูลไม่ครบ (ของจริงมีเยอะ)');
    r = await call(route('GET', '/api/list'), { q: 'ลูกค้าไม่มีรหัส' });
    ok(r.body.total === 1, 'แถวที่ไม่มีรหัสงานยังค้นเจอ');
    ok(r.body.rows[0].job_code === null, 'รหัสงานว่างคืน null ไม่ใช่พัง');
    ok(r.body.rows[0].amount === 5000, 'ยอดยังอ่านได้ปกติ');

    /* ── 8.1) ‼ ชื่อพนักงานขาย — Create By ก่อน แล้วค่อยเดาจาก prefix ──
     *
     *  บั๊กจริง (4 ก.ย. 69): อลิซใช้คอลัมน์ "Sales Name" ซึ่งว่างเกือบทั้งชีต
     *  คอลัมน์พนักงานขายเลยขึ้น "–" ทั้งตาราง ทั้งที่ข้อมูลมีอยู่
     *  ของจริงแอปเดิมใช้ "Create By" แล้วถ้าว่างค่อยแกะจาก prefix รหัสงาน
     *  (Code.gs:4059–4097 getSalesRanking + CODE_PREFIX 221–232) */
    console.log('\n8.1) ‼ ชื่อพนักงานขายต้องมาจาก Create By / prefix');
    await pg.query(
      `insert into app.total_sales (_row,"รหัสงาน","วันที่ปิดการขาย","ชื่อบริษัท",
         "Lead Status","ยอดขาย (บาท)","รับจริง (บาท)")
       values (99,'B2K2609/999','2026-09-03','ลูกค้าไม่มี Create By','ปิดการขาย',1000,0)`);
    r = await call(route('GET', '/api/list'), { q: 'B2K2609/999' });
    ok(r.body.rows[0].owner === 'มิ้งค์',
       'Create By ว่าง → เดาจาก prefix B2K ได้ "มิ้งค์" (ได้ ' + r.body.rows[0].owner + ')');

    const pf = (await pg.query(
      `select app.sales_owner('', 'B2G2609/006') a,
              app.sales_owner('กุ๊งกิ๊ง', 'B2K2609/001') b,
              app.sales_owner('', 'XX9999/001') c`)).rows[0];
    ok(pf.a === 'กุ๊งกิ๊ง', 'prefix B2G → กุ๊งกิ๊ง');
    ok(pf.b === 'กุ๊งกิ๊ง', '‼ ถ้ามี Create By ต้องชนะ prefix เสมอ');
    ok(pf.c === '(ไม่ระบุ)', 'prefix ไม่รู้จัก → (ไม่ระบุ) ไม่ใช่ค่าว่าง');

    const long = (await pg.query(`select app.sales_owner('', 'B2K2609/001') o`)).rows[0].o;
    ok(long === 'มิ้งค์', '‼ prefix ยาวชนะสั้น — B2K ต้องไม่ถูก B2E/B2G แย่งไปก่อน');
    await pg.query(`delete from app.total_sales where _row = 99`);

    /* ── 9) สรุป ── */
    console.log('\n9) สรุปรายเดือน / รายคน');
    r = await call(route('GET', '/api/summary'), {});
    ok(r.body.ok, 'เรียกสรุปได้');
    ok(r.body.byMonth.length === 3, 'สรุปรายเดือนได้ 3 เดือน');
    const sep = r.body.byMonth.find(m => m['เดือน'] === '2026-09');
    ok(sep && Number(sep['ยอดขาย']) === 40500, 'ยอดเดือน ก.ย. ถูกต้อง');
    ok(sep && Number(sep['ค้างรับ']) === 15500, 'ค้างรับเดือน ก.ย. ถูกต้อง');
    const mink = r.body.byPerson.find(p => p['พนักงานขาย'] === 'มิ้งค์');
    ok(mink && Number(mink['ยอดขาย']) === 40500, 'สรุปรายคนถูกต้อง');

    /* ── 10) Dashboard — สูตรต้องตรงกับแอปเดิม ──
     *
     *  ทุกสูตรถอดจาก Code.gs v34.3 ถ้าตัวเลขไม่ตรง แปลว่าเราอ่านโค้ดเดิมผิด
     *  ไม่ใช่ "ของใหม่ดีกว่า" — หน้าจอนี้ต้องให้เลขเดียวกับที่ทีมเห็นทุกวัน */
    console.log('\n10) Dashboard — สูตรตรงกับแอปเดิม');
    await pg.query('truncate app.total_sales');
    const D = '2026-09-10';
    const mk = (row, code, date, status, amt, src, plat, cust, maker, by) =>
      pg.query(`insert into app.total_sales (_row,"รหัสงาน","วันที่ปิดการขาย","วันที่ติดต่อ",
          "Lead Status","ยอดขาย (บาท)","ลูกค้ามาจากไหน","ชื่อช่อง / Platform",
          "ประเภทลูกค้า","ผู้ผลิต","Create By","ชื่อบริษัท")
        values ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,'ทดสอบ')`,
        [row, code, date, status, amt, src, plat, cust, maker, by]);

    await mk(2, 'B2G2609/001', D, 'ปิดการขาย', 100, 'B2B',        '',        'ลูกค้าใหม่', 'ผลิตเอง',   'กุ๊งกิ๊ง');
    await mk(3, 'B2G2609/002', D, 'ปิดการขาย', 300, 'สาขา',        'สาขาบางใหญ่', 'ลูกค้าเก่า', 'ผลิตเอง',  'กุ๊งกิ๊ง');
    await mk(4, 'QZ2609/003',  D, 'ปิดการขาย', 600, 'ผู้บริหาร',    '',        'ลูกค้าเก่า', 'โรงงาน ก', 'ส้ม');
    await mk(5, 'QZ2609/004',  D, 'ปิดการขาย',   0, 'Facebook',   'FB เพจ',  'ลูกค้าใหม่', '',        'ส้ม');
    await mk(6, 'QZ2609/005',  D, 'กำลังคุย',    999, 'B2B',        '',        'ลูกค้าใหม่', 'ผลิตเอง',   'ส้ม');

    const dash = route('GET', '/api/dashboard');
    r = await call(dash, { win: 'custom', from: '2026-09-01', to: '2026-09-30', day: D });
    ok(r.body.ok, 'เรียก Dashboard ได้');

    const c = r.body.channel;
    ok(c.total === 1000, '‼ นับเฉพาะ "ปิดการขาย" — 999 ที่ยังคุยอยู่ไม่ถูกนับ (ได้ ' + c.total + ')');
    const byKey = Object.fromEntries((c.channels || []).map(x => [x.key, x]));
    ok(byKey['B2B'].amt === 100, 'B2B แยกถูก');
    ok(byKey['สาขา'].amt === 300, '‼ สาขา ต้องเข้าเงื่อนไข 2 ชั้น (ลูกค้ามาจากไหน + Platform)');
    ok(byKey['ผู้บริหาร'].amt === 600, 'ผู้บริหาร แยกถูก');
    ok(byKey['Online'].amt === 0, 'ที่เหลือตกเป็น Online');
    ok(byKey['Partner'].amt === 0, 'Partner ไม่มียอด');
    ok(byKey['ผู้บริหาร'].share === 60, 'ส่วนแบ่ง % คิดถูก (ได้ ' + byKey['ผู้บริหาร'].share + ')');
    ok(c.newPct === 10 && c.oldPct === 90, 'สัดส่วนลูกค้าใหม่/เก่า ถูก');

    const m = r.body.mix;
    const mk2 = Object.fromEntries((m.cards || []).map(x => [x.key, x]));
    ok(mk2.self.amt === 400, 'ผลิตเอง = 400 (จับคำว่า "ผลิตเอง")');
    ok(mk2.out.amt === 600, 'ส่งออกนอก = 600');
    ok(mk2.unknown.amt === 0, 'ยังไม่ระบุผู้ผลิต = 0 (จะถูกซ่อนบนจอ)');
    ok(mk2.cNew.amt === 100 && mk2.cOld.amt === 900, 'ลูกค้าใหม่/เก่า แยกถูก');
    ok(m.count === 4, 'นับจำนวนงานที่ปิดการขายได้ 4 (ได้ ' + m.count + ')');
    ok((m.outMakers || []).length === 1 && m.outMakers[0].maker === 'โรงงาน ก',
       'สรุปผู้ผลิตภายนอกรายชื่อได้');

    const rk = r.body.rank;
    ok(rk.day.length === 2, 'อันดับวันนี้มี 2 คน (ตัดคนที่ยอด 0 ออก)');
    ok(rk.day[0].nick === 'ส้ม' && Number(rk.day[0].amt) === 600, 'อันดับ 1 คือส้ม 600');
    ok(Number(rk.dayTotal) === 1000, 'ยอดรวมวันนี้ 1,000');
    ok(rk.month.length === 2, 'อันดับสะสมเดือนมี 2 คน');

    const k = r.body.kpi;
    ok(k.todayClosed === 4, 'ปิดการขายวันนี้ 4 ราย');
    ok(Number(k.todaySales) === 1000, 'ยอดขายวันนี้ 1,000');
    ok(k.leadsTotal === 5, 'Leads เดือนนี้นับทุกสถานะ = 5 (ได้ ' + k.leadsTotal + ')');
    ok(Number(k.avgPerDeal) === 250, 'เฉลี่ย/ราย = 1000/4 = 250');
    ok(Number(k.avgDayThis) === 100, 'เฉลี่ย/วัน = 1000/10 (วันที่ 10) = 100 (ได้ ' + k.avgDayThis + ')');
    ok(k.topChannel === 'สาขาบางใหญ่', 'ช่องทางเด่นวันนี้มาจากคอลัมน์ Platform');

    /* ช่วงเวลา — เดือนนี้เทียบเดือนก่อนช่วงวันเดียวกัน */
    r = await call(dash, { win: 'prev' });
    ok(r.body.ok && r.body.win.label === 'เดือนที่แล้ว', 'เลือกช่วง "เดือนที่แล้ว" ได้');
    r = await call(dash, { win: '3m' });
    ok(r.body.win.label === '3 เดือนล่าสุด', 'เลือกช่วง 3 เดือนล่าสุดได้');

    /* ── 11) ตาราง "ทุกคอลัมน์" — ข้อที่แอปเดิมทำ แล้วเราเคยทำหาย ──
     *
     *  บทเรียน 5 ก.ย. 69: หน้าตารางเคยโชว์แค่ 9 คอลัมน์ที่เราเลือกเอง
     *  ทั้งที่ของเดิมคืนหัวชีตทั้งแถวแล้วให้หน้าจอวาดตาม
     *  เทสต์ชุดนี้กันไม่ให้ย้อนกลับไปเลือกคอลัมน์เองอีก */
    console.log('\n11) ตารางทุกคอลัมน์ (records)');
    /* ชุดทดสอบก่อนหน้าเขียนทับข้อมูลไปแล้ว — ตั้งต้นใหม่ให้รู้แน่ว่ามีอะไรอยู่
     * และล้างทะเบียนหัวคอลัมน์ที่เทสต์ซิงค์ทิ้งไว้ (ไม่งั้นตารางจะวาดตามของชุดนั้น) */
    await pg.query('truncate app.total_sales');
    await pg.query("delete from app.sheet_headers where source = 'sales'");
    for (let i = 0; i < rows.length; i++) {
      const q = rows[i];
      await pg.query(
        `insert into app.total_sales
           (_row,"รหัสงาน","วันที่ปิดการขาย","วันที่ติดต่อ","ชื่อบริษัท","Lead Status",
            "เลขที่ QO / IV","ยอดขาย (บาท)","รับจริง (บาท)","Create By","เบอร์ติดต่อ")
         values ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [i + 2, q[0], q[1], q[2], q[3], q[4], q[5], q[6], q[7], '08' + (11111111 + i)]);
    }

    const records = route('GET', '/api/records');
    ok(!!records, 'มี endpoint /api/records');

    r = await call(records, { from: '2026-01-01', to: '2026-12-31' });
    ok(r.body.ok, 'เรียกตารางได้');
    const nCol = await pg.query(`select count(*)::int n from information_schema.columns
      where table_schema='app' and table_name='total_sales' and column_name not like '\\_%'`);
    ok(r.body.headers.length === nCol.rows[0].n,
       '‼ คืนหัวคอลัมน์ครบทุกช่องตามชีต ' + nCol.rows[0].n + ' ช่อง (ได้ ' + r.body.headers.length + ')');
    ok(r.body.headers.length > 40, '‼ ต้องมากกว่า 40 คอลัมน์ — กันการถอยกลับไปเลือกเอง 9 ช่อง');
    ok(r.body.rows.length === rows.length,
       'ได้ครบ ' + rows.length + ' แถว (ได้ ' + r.body.rows.length + ')');
    ok(r.body.rows[0].cells.length === r.body.headers.length,
       'จำนวนช่องในแถว = จำนวนหัวคอลัมน์ (ไม่เหลื่อม)');
    ok(r.body.statusCol === r.body.headers.indexOf('Lead Status'),
       'statusCol ชี้ตรงคอลัมน์ Lead Status');
    ok(r.body.rows.every(x => typeof x.row === 'number'),
       'ทุกแถวมีเลขแถวในชีต (_row) ไว้เปิดรายละเอียด');

    /* วันที่ต้องเป็น dd/MM/yyyy แบบ ค.ศ. — ไม่ใช่ พ.ศ. และไม่ใช่ ISO
     * (บทเรียน: เคยบวก 543 จนกลายเป็น 04/09/3112) */
    const iDate = r.body.headers.indexOf('วันที่ปิดการขาย');
    const dates = r.body.rows.map(x => x.cells[iDate]).filter(Boolean);
    ok(dates.length > 0 && dates.every(d => /^\d{2}\/\d{2}\/(19|20)\d{2}$/.test(d)),
       '‼ วันที่เป็น dd/MM/yyyy ค.ศ. ไม่ใช่ พ.ศ. (ได้ ' + dates[0] + ')');

    /* เบอร์โทรห้ามถูกจับเป็นตัวเลขแล้วใส่จุลภาค */
    const iPhone = r.body.headers.indexOf('เบอร์ติดต่อ');
    ok(r.body.rows.every(x => !String(x.cells[iPhone] || '').includes(',')),
       '‼ เบอร์โทรไม่ถูกคั่นหลักพัน (081… ต้องไม่กลายเป็น 81,111,111)');

    ok(r.body.rows.some(x => x.saleNick === 'มิ้งค์'),
       'ชื่อเล่นบนตารางมาจาก Create By');

    /* ช่วงเริ่มต้น = 10 วันล่าสุด เหมือนแอปเดิม */
    r = await call(records, {});
    ok(r.body.range && r.body.range.mode === 'days', 'ไม่ระบุช่วง → โหมด 10 วันล่าสุด');

    /* เลือกทั้งเดือน */
    r = await call(records, { ym: '2026-09' });
    ok(r.body.range.mode === 'month' && r.body.rows.length === 2, 'เลือกทั้งเดือนได้ (ก.ย. 2 รายการ)');

    /* ── ทะเบียนหัวคอลัมน์ต้องชนะลำดับคอลัมน์ในตารางเสมอ ──
     *  นี่คือหัวใจของ "เพิ่มคอลัมน์ในชีตแล้วขึ้นเอง":
     *  ตัวซิงค์จดลำดับจริงไว้ ตารางวาดตามนั้น ไม่ใช่ตามลำดับที่เราสร้างตาราง */
    await pg.query(`insert into app.sheet_headers (source, ord, name) values
      ('sales', 1, 'รหัสงาน'), ('sales', 2, 'Lead Status'),
      ('sales', 3, 'ชื่อบริษัท'), ('sales', 4, 'คอลัมน์ใหม่ที่ยังไม่มีในตาราง')`);
    r = await call(records, { from: '2026-01-01', to: '2026-12-31' });
    ok(r.body.headers.join('|') === 'รหัสงาน|Lead Status|ชื่อบริษัท|คอลัมน์ใหม่ที่ยังไม่มีในตาราง',
       '‼ วาดตามลำดับหัวชีตที่ซิงค์จดไว้ ไม่ใช่ลำดับคอลัมน์ในตาราง');
    ok(r.body.rows[0].cells.length === 4, 'คอลัมน์ที่ยังไม่มีช่องจริงก็ยังมีที่ในแถว (ค่าว่าง)');
    ok(r.body.statusCol === 1, 'statusCol ขยับตามลำดับใหม่');
    await pg.query("delete from app.sheet_headers where source = 'sales'");

    console.log('\n12) ค้นทั้งชีต + รูปพนักงาน');
    const findEp = route('GET', '/api/find');
    ok(!!findEp, 'มี endpoint /api/find');
    r = await call(findEp, { q: 'B2K' });
    ok(r.body.ok && r.body.rows.length === 2, 'ค้นรหัสงานทั้งชีตได้ 2 รายการ');
    r = await call(findEp, { q: 'ก' });
    ok(r.body.rows.length === 0, 'คำค้นสั้นกว่า 2 ตัว → ไม่ค้น (กันโหลดทั้งชีต)');
    r = await call(findEp, { q: 'IV-2026090100001' });
    ok(r.body.rows.length === 1, 'ค้นด้วยเลขที่ IV เต็มได้');

    /* ═══════════════════════════════════════════════════════════
     *  ‼ มาตรฐานไฟล์ใหม่ — พี่เอสั่งกลับทิศ 5 ก.ย. 69 (ตอนเย็น)
     *
     *    "จะไม่เก็บ ไฟล์ภาพ ไฟล์ตัด ไฟล์พิมพ์ ใน database นี้แน่นอน
     *     มันใหญ่มาก ... ให้ทำ ID เก็บไว้เลย แล้วไป copy link URL
     *     file ภาพเปิดตรงที่ google drive"
     *
     *  ของเดิม (ที่เทสต์นี้เคยบังคับไว้) คือก๊อปไฟล์เข้า Supabase Storage
     *  ซึ่งใช้กับไฟล์ตัด/ไฟล์พิมพ์ระดับ GB ไม่ได้เลย
     *
     *  ของใหม่: ฐานข้อมูลเก็บ "ไอดีไฟล์" · URL สร้างสดตอนอ่าน ·
     *  เบราว์เซอร์โหลดตรงจาก Drive · ไฟล์อยู่ที่ Drive ที่เดียวตลอดไป
     * ═══════════════════════════════════════════════════════════ */
    await pg.query("delete from app.file_cache where kind='avatar'");
    await pg.query(`insert into app.app_users ("Username","Nickname","Impage")
      values ('avtest','(รูป) Test User','User_Images/x.jpg')
      on conflict (lower("Username")) do update
        set "Impage"=excluded."Impage", "Nickname"=excluded."Nickname"`);
    await pg.query(`insert into app.file_cache (drive_id,path,url,owner_key,kind,bytes,mime)
      values ('drvTEST','avatar/drvTEST.jpg',
              'https://demo.supabase.co/storage/v1/object/public/crm-files/avatar/drvTEST.jpg',
              'avtest','avatar',4096,'image/jpeg')
      on conflict (drive_id) do update set url=excluded.url`);

    /* ตรึงไอดีไว้ในทะเบียนกลาง — เหมือนที่ระบบจริงทำครั้งเดียวจบ */
    await pg.query("delete from app.file_ref where owner_key='avtest'");
    await pg.query(`insert into app.file_ref
      (drive_id, owner_kind, owner_key, role, name, mime, bytes, source)
      values ('drvTEST','user','avtest','avatar','x.jpg','image/jpeg',4096,'index')
      on conflict do nothing`);

    const avmap = (await pg.query('select app.sales_avatars() m')).rows[0].m;
    ok(/drive\.google\.com\/thumbnail\?id=drvTEST/.test(avmap['รูป'] || ''),
       '‼ ชี้ไปที่ Drive โดยตรงด้วยไอดีที่ตรึงไว้ (' +
       String(avmap['รูป'] || '(ไม่มี)').slice(0, 58) + '…)');
    ok(avmap['avtest'] === avmap['รูป'], 'Username ชี้ไปรูปเดียวกัน');
    ok(avmap['(รูป) Test User'] === avmap['รูป'], 'ชื่อเล่นเต็มก็ชี้ไปรูปเดียวกัน');

    /* ‼ กฎเหล็กข้อใหม่: ห้ามมีไฟล์จริงถูกก๊อปเข้าฐานข้อมูล
     *   ทะเบียนต้องเก็บแค่ไอดี ไม่มีคอลัมน์ไหนเก็บตัวไฟล์เลย */
    const cols = (await pg.query(`select column_name from information_schema.columns
      where table_schema='app' and table_name='file_ref'`)).rows.map(r => r.column_name);
    ok(!cols.some(c => /bytea|blob|content|data/i.test(c)),
       '‼ ทะเบียนไฟล์ไม่มีช่องเก็บตัวไฟล์เลย — ไฟล์อยู่ที่ Drive ที่เดียว');
    ok(cols.includes('drive_id'), 'เก็บไอดีไฟล์ไว้ถาวร');

    /* ‼ เปลี่ยนชื่อไฟล์ใน Drive แล้วต้องยังใช้ได้ — นี่คือเหตุผลที่เก็บไอดีไม่เก็บ URL */
    await pg.query(`update app.app_users set "Impage"='User_Images/เปลี่ยนชื่อแล้ว.jpg'
                    where "Username"='avtest'`);
    const avmap2 = (await pg.query('select app.sales_avatars() m')).rows[0].m;
    ok(avmap2['รูป'] === avmap['รูป'],
       '‼ เปลี่ยนชื่อ/ย้ายไฟล์ใน Drive แล้วรูปยังขึ้นเหมือนเดิม (ผูกกับไอดี ไม่ใช่ชื่อ)');

    const avst = (await pg.query(
      "select * from app.v_avatar_status where username = 'avtest'")).rows[0] || {};
    ok(!!avst['ลิงก์รูป'], 'วิวสถานะคลังรูปบอกลิงก์ได้');

    /* คนที่ยังไม่มีรูปในคลัง ต้องบอกได้ว่าติดอะไร ไม่ใช่เงียบ */
    await pg.query(`insert into app.app_users ("Username","Nickname","Impage")
      values ('avnopic','ไม่มีรูป','') on conflict (lower("Username")) do update
        set "Impage"='', "Nickname"=excluded."Nickname"`);
    const avbad = (await pg.query(
      "select * from app.v_avatar_status where username = 'avnopic'")).rows[0] || {};
    ok(/Impage ว่าง/.test(avbad['ปัญหา'] || ''),
       'ช่อง Impage ว่าง → บอกเหตุผลตรง ๆ (' + (avbad['ปัญหา'] || '').slice(0, 40) + ')');

    /* ตัวแปลงชื่อไฟล์ → path ในถัง ต้องไม่ชนกันและไล่ย้อนได้ */
    const avmod = require('../core/avatars.js');
    ok(avmod.pathOf('avatar', 'ABC123', 'image/png') === 'avatar/ABC123.png',
       'ชื่อไฟล์ในถังใช้ไอดี Drive เป็นชื่อ — ไม่ซ้ำและไล่ย้อนได้');
    ok(avmod.pathOf('job', 'XYZ', 'image/jpeg') === 'job/XYZ.jpg',
       'รูปชนิดอื่น (งาน/CheckList) ใช้ทางเดียวกันได้ แค่เปลี่ยน kind');

    await pg.query("delete from app.app_users where \"Username\" in ('avtest','avnopic')");
    await pg.query("delete from app.file_cache where drive_id = 'drvTEST'");

    const av = route('GET', '/api/avatars');
    ok(!!av, 'มี endpoint /api/avatars (รูปพนักงาน)');
    r = await call(av, {});
    ok(r.body.ok && typeof r.body.map === 'object', 'คืนแผนที่ ชื่อเล่น → URL รูป');

    /* ตัวแปลงลิงก์รูป Drive — ต้องได้ URL ที่ <img> โหลดได้จริง */
    const im = await pg.query(`select
        app.drive_img('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz01234/view') a,
        app.drive_img('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz01234') b,
        app.drive_img('1AbCdEfGhIjKlMnOpQrStUvWxYz01234') c,
        app.drive_img('') d`);
    const IM = im.rows[0];
    /* ‼ ต้องเป็น thumbnail แบบเดียวกับ _imgUrlOf() ของเดิม (code.gs:3771)
     *   ไม่ใช่ lh3.googleusercontent.com — คนละปลายทาง รูปไม่ขึ้น */
    const TH = /^https:\/\/drive\.google\.com\/thumbnail\?id=[-\w]{20,}&sz=w200$/;
    ok(TH.test(IM.a), 'ลิงก์ /file/d/ → drive thumbnail (ได้ ' + IM.a + ')');
    ok(TH.test(IM.b), 'ลิงก์ ?id= → drive thumbnail');
    ok(TH.test(IM.c), 'ไอดีเปล่า ๆ → drive thumbnail');
    ok(IM.d === '', 'ไม่มีรูป → ค่าว่าง (หน้าจอถอยไปใช้อักษรย่อ)');

    /* ‼ ครึ่งหนึ่งของบั๊ก "รูปไม่ขึ้น" อยู่ฝั่งหน้าเว็บ ไม่ใช่ URL */
    ok(/referrerpolicy="no-referrer"/.test(html),
       '‼ แท็ก <img> ของรูปพนักงานมี referrerpolicy="no-referrer" ' +
       '(ขาดข้อนี้ Google ตอบ 403 รูปไม่ขึ้นทั้งที่ URL ถูก)');
    ok(/onerror=/.test(html), 'โหลดรูปไม่ขึ้น → สลับเป็นอักษรย่อ ไม่ปล่อยกรอบว่าง');

    /* อันดับ 1-3: ชื่อกับยอดขายต้องขนาดเท่ากันและสีเดียวกัน (Index.html:384–387) */
    for (const [k, sz, col] of [['rk1', '19.5px', '#c8951a'], ['rk2', '17.5px', '#6b7682'],
                                ['rk3', '16px', '#b5723a']]) {
      const re = new RegExp('\\.rank-item\\.' + k + ' \\.rank-nm,\\.rank-item\\.' + k +
                            ' \\.rank-amt\\{font-size:' + sz.replace('.', '\\.') +
                            ';font-weight:800;color:' + col);
      ok(re.test(html), 'อันดับ ' + k.slice(2) + ': ชื่อ+ยอดขาย ' + sz + ' สี ' + col);
    }

    /* ชื่อเล่นในวงเล็บหน้าชื่อเต็ม — แบบเดียวกับ _rankNick ของเดิม */
    const nk = await pg.query(`select
        app.sales_nick('(แว่น) Papassorn', null) a,
        app.sales_nick('ต้น', null) b,
        app.sales_nick('', 'B2K2609/001') c,
        app.sales_nick('', 'ZZZ9999/001') d`);
    ok(nk.rows[0].a === 'แว่น', '"(แว่น) Papassorn" → แว่น');
    ok(nk.rows[0].b === 'ต้น', 'ไม่มีวงเล็บ → ใช้ทั้งก้อน');
    ok(nk.rows[0].c === 'มิ้งค์', 'Create By ว่าง → เดาจากคำนำหน้ารหัสงาน');
    ok(nk.rows[0].d === '(ไม่ระบุ)', 'prefix ไม่รู้จัก → (ไม่ระบุ)');

    /* ═══════════════════════════════════════════════════════════════
     *  🔤 ตั้งค่าคำนำหน้ารหัสงาน — เฉพาะ admin + namna
     *
     *  พี่เอสั่ง 6 ก.ย. 69: "คนที่ตั้งค่า prefix ได้มีแค่ user : admin , namna เท่านั้น"
     *
     *  ‼ ด่านนี้เจาะจง "ชื่อผู้ใช้" ไม่ใช่แค่สิทธิ์ Administrator
     *    คำนำหน้าคือตัวชี้เจ้าของงานของใบเก่าทั้งหมด ตั้งมั่ว = ยอดรายคนเพี้ยนย้อนหลัง
     * ═══════════════════════════════════════════════════════════════ */
    console.log('\n🔤 ตั้งค่าคำนำหน้ารหัสงาน');
    const pfxSave = route('POST', '/api/prefix/save');
    const pfxList = route('GET', '/api/prefix');

    const callBody = (handler, body, user) => new Promise((resolve, reject) => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; },
                    json(b) { resolve({ status: this.statusCode, body: b }); } };
      Promise.resolve(handler({ query: {}, params: {}, body, user }, res)).catch(reject);
    });

    /* ① เซลส์ธรรมดา → ห้ามตั้ง */
    let px = await callBody(pfxSave, { prefix: 'ZZ', username: 'x', nickname: 'x' },
                            { username: 'papassorn', role: 'USER' });
    ok(px.status === 403, '‼ เซลส์ธรรมดา → ตั้งคำนำหน้าไม่ได้ (403)');

    /* ② ‼ มีสิทธิ์ Administrator แต่ไม่ใช่ admin/namna → ก็ยังห้าม
     *    ตรงนี้คือจุดที่พี่เอสั่งเจาะจง ต่างจากด่านแอดมินที่อื่นในระบบ */
    px = await callBody(pfxSave, { prefix: 'ZZ', username: 'x', nickname: 'x' },
                        { username: 'someboss', permission: 'Administrator' });
    ok(px.status === 403,
       '🔑 มีสิทธิ์ Administrator แต่ไม่ใช่ admin/namna → ยังตั้งไม่ได้');

    /* ‼ พนักงานต้องมีอยู่จริงในทะเบียนผู้ใช้ก่อน — ดรอปดาวน์ดึงจากที่นี่ */
    await pg.query(`insert into app.app_users ("Username","Name","Nickname","Status","Permission")
                    values ('newsale','พนักงานใหม่','ใหม่','ใช้งาน','USER'),
                           ('newsale2','พนักงานใหม่2','ใหม่2','ใช้งาน','USER')
                    on conflict do nothing`);

    /* ③ admin ตั้งได้ */
    px = await callBody(pfxSave, { prefix: 'zq', username: 'newsale' },
                        { username: 'admin', permission: 'Administrator' });
    ok(px.body.ok && px.body.prefix === 'ZQ',
       '🔑 admin → ตั้งได้ และแปลงเป็นตัวพิมพ์ใหญ่ให้เอง (ได้ ' + px.body.prefix + ')');

    /* ④ namna ตั้งได้ */
    px = await callBody(pfxSave, { prefix: 'ZN', username: 'newsale2' },
                        { username: 'namna', role: 'USER' });
    ok(px.body.ok, '🔑 Namna → ตั้งได้');

    /* ⑤ ‼ ชื่อเล่นต้องมาจากทะเบียนผู้ใช้ ไม่ใช่จากฟอร์ม
     *    พี่เอสั่ง: "ช่องอื่น อ้างอิงข้อมูลมาจากระบบที่ user ใช้ login มาเลย"
     *    ส่งชื่อเล่นมั่ว ๆ มาก็ต้องไม่ถูกใช้ — ไม่งั้นรูป/อันดับ/ยอดรายคนจับคู่ไม่เจอ */
    px = await callBody(pfxSave, { prefix: 'ZQ', username: 'newsale', nickname: 'พิมพ์มั่ว' },
                        { username: 'admin' });
    const zqRow = (await pg.query(
      `select nickname from app.sales_prefix where prefix='ZQ'`)).rows[0];
    ok(px.body.ok && zqRow.nickname === 'ใหม่',
       '🔑 ส่งชื่อเล่นมั่วมาจากฟอร์ม → ไม่ถูกใช้ ยึดตามทะเบียนผู้ใช้ (ได้ "' +
       zqRow.nickname + '")');

    /* ‼ เลือกคนที่ไม่มีในระบบไม่ได้ */
    px = await callBody(pfxSave, { prefix: 'ZK', username: 'ผีไม่มีตัวตน' },
                        { username: 'admin' });
    ok(px.status === 400 && /ไม่พบผู้ใช้/.test(px.body.error || ''),
       '‼ username ที่ไม่มีในทะเบียนผู้ใช้ → ปฏิเสธ');

    /* ⑥ ดรอปดาวน์ต้องมีรายชื่อจริง + บอกว่าใครมีคำนำหน้าแล้ว */
    const ul = await call(pfxList, {}, {}, { username: 'admin' });
    const nu = (ul.body.users || []).find(x => x.username === 'newsale');
    ok(nu && nu.nickname === 'ใหม่' && nu.hasPrefix === true && nu.prefix === 'ZQ',
       '🔑 ดรอปดาวน์ดึงชื่อเล่นจากทะเบียนผู้ใช้ + บอกคำนำหน้าที่มีอยู่');
    ok((ul.body.users || []).length >= 2, '  มีรายชื่อให้เลือกจริง (' +
       (ul.body.users || []).length + ' คน)');

    /* ⑦ กติกาที่ต้องกัน */
    px = await callBody(pfxSave, { prefix: 'Z#', username: 'newsale' },
                        { username: 'admin' });
    ok(px.status === 400 && /A-Z/.test(px.body.error || ''),
       '‼ คำนำหน้ามีอักขระแปลก → ปฏิเสธ พร้อมบอกเหตุผลที่คนอ่านรู้เรื่อง');
    px = await callBody(pfxSave, { prefix: 'ZM', username: 'newsale' },
                        { username: 'admin' });
    ok(px.status === 400 && /1 คนตั้งได้คำนำหน้าเดียว/.test(px.body.error || ''),
       '‼ 1 คนตั้งได้คำนำหน้าเดียว → ปฏิเสธตัวที่ 2');

    /* ⑥ รายการต้องบอก "รหัสถัดไป" ให้เห็นก่อนใช้จริง */
    const pl = await call(pfxList, {}, {}, { username: 'admin' });
    const zq = (pl.body.rows || []).find(x => x.prefix === 'ZQ');
    const ym = new Date().toISOString().slice(2, 7).replace('-', '');
    ok(zq && zq.nextCode === 'ZQ' + ym + '/001',
       '🔑 บอกรหัสถัดไปที่จะได้ (' + (zq && zq.nextCode) + ')');
    ok(zq && zq.issued === 0 && zq.lastNo === 0, '  ตัวใหม่ยังไม่เคยออกรหัสเลย');

    /* ⑦ ‼ ออกรหัสจริงแล้วต้อง running ต่อ ไม่ใช่เริ่มใหม่ */
    const c1 = await pg.query("select app.next_job_code('ZQ','sales','admin') c");
    const c2 = await pg.query("select app.next_job_code('ZQ','sales','admin') c");
    ok(c1.rows[0].c === 'ZQ' + ym + '/001' && c2.rows[0].c === 'ZQ' + ym + '/002',
       '🔑 ออกรหัสจริง → วิ่งต่อเป็น 001, 002 (' + c1.rows[0].c + ', ' + c2.rows[0].c + ')');

    /* ⑧ ‼ ออกรหัสไปแล้ว = ลบไม่ได้ ต้องปิดใช้งานแทน
     *    ลบทิ้งเมื่อไหร่ ใบเก่าของคนนั้นจะหาเจ้าของไม่เจอทั้งหมด */
    px = await callBody(route('POST', '/api/prefix/delete'), { prefix: 'ZQ' },
                        { username: 'admin' });
    ok(px.status === 400 && /ลบไม่ได้/.test(px.body.error || ''),
       '‼ ออกรหัสไปแล้ว → ลบไม่ได้ ให้ปิดใช้งานแทน');
    px = await callBody(route('POST', '/api/prefix/delete'), { prefix: 'ZN' },
                        { username: 'admin' });
    ok(px.body.ok, '  ตัวที่ยังไม่เคยออกรหัส → ลบได้ปกติ');

    /* ═══════════════════════════════════════════════════════════════
     *  👁️ ใครเห็นอะไร — พี่เอสั่ง 6 ก.ย. 69
     *
     *    "เซลล์จะเห็นแค่งานของตัวเอง ในรายการรหัสงาน
     *     แต่ card dashboard ทุกใบ ทุกคนเห็นเหมือนกันหมดนะ"
     *
     *  ‼ 2 ข้อนี้ต้องแยกกันให้ขาด — เผลอเอาไปกรองการ์ดด้วยเมื่อไหร่
     *    ยอดทีมจะเพี้ยนทั้งกระดาน ซึ่งตรงข้ามกับที่สั่งเลย
     *
     *  ‼ ต้องบังคับที่เซิร์ฟเวอร์ ไม่ใช่ซ่อนแถวในหน้าเว็บ
     *    ?sale= ที่หน้าเว็บส่งมา ผู้ใช้แก้เองได้ใน 10 วินาที
     * ═══════════════════════════════════════════════════════════════ */
    console.log('\n👁️ เซลส์เห็นแค่งานตัวเอง · การ์ดสรุปทุกคนเห็นเท่ากัน');
    await pg.query('truncate app.total_sales');
    await pg.query(`insert into app.total_sales (_row,"รหัสงาน","วันที่ปิดการขาย","ชื่อบริษัท",
                      "Lead Status","ยอดขาย (บาท)","รับจริง (บาท)","Sales Code","Create By")
                    values (2,'QW2609/001','2026-09-03','ของแว่น','ปิดการขาย',10000,10000,'papassorn','แว่น'),
                           (3,'QN2609/001','2026-09-03','ของนวล','ปิดการขาย',20000,20000,'nuan','นวล')`);

    const saleUser = { username: 'papassorn', name: 'Papassorn', nickname: 'แว่น', role: 'USER' };

    /* ① รายการรหัสงาน — เซลส์เห็นแค่ของตัวเอง */
    let v = await call(route('GET', '/api/list'), {}, {}, saleUser);
    ok(v.body.total === 1 && v.body.rows[0].job_code === 'QW2609/001',
       '🔑 เซลส์เปิดรายการ → เห็นแค่ใบตัวเอง 1 ใบ (ได้ ' + v.body.total + ')');

    /* ‼ ส่ง ?sale= ของคนอื่นมาเอง ต้องยังเห็นแค่ของตัวเอง — ห้ามแอบดูข้ามคน */
    v = await call(route('GET', '/api/list'), { sale: 'nuan' }, {}, saleUser);
    ok(v.body.total === 1 && v.body.rows[0].job_code === 'QW2609/001',
       '‼ ยิง ?sale=nuan เข้ามาเอง → ยังเห็นแค่ของตัวเอง (กันแอบดูข้ามคน)');

    /* ② ค้นทั้งชีตก็ต้องไม่หลุด */
    v = await call(route('GET', '/api/find'), { q: '2609' }, {}, saleUser);
    const found = v.body.rows || [];
    const codes = found.map(x => JSON.stringify(x)).join(' ');
    ok(found.length > 0 && !/QN2609/.test(codes),
       '‼ ค้นทั้งชีต → เจอของตัวเอง แต่ไม่มีใบของคนอื่นหลุดออกมา (' +
       found.length + ' แถว)');

    /* ③ แอดมิน / Namna เห็นครบ */
    v = await call(route('GET', '/api/list'), {}, {}, ADMIN_USER);
    ok(v.body.total === 2, '🔑 แอดมิน → เห็นครบทุกใบ (ได้ ' + v.body.total + ')');
    v = await call(route('GET', '/api/list'), {}, {},
                   { username: 'namna', name: 'Namna', role: 'USER' });
    ok(v.body.total === 2, '🔑 Namna → เห็นครบทุกใบเหมือนแอดมิน');

    /* ④ ‼ การ์ดสรุป — ทุกคนต้องได้ตัวเลข "เท่ากันเป๊ะ" */
    const dashSale  = await call(route('GET', '/api/dashboard'), {}, {}, saleUser);
    const dashAdmin = await call(route('GET', '/api/dashboard'), {}, {}, ADMIN_USER);
    ok(JSON.stringify(dashSale.body) === JSON.stringify(dashAdmin.body),
       '🔑 การ์ด Dashboard — เซลส์กับแอดมินเห็นตัวเลขเท่ากันเป๊ะ (ไม่กรองรายคน)');

    /* ═══════════════════════════════════════════════════════════════
     *  🔴 เพดาน 1,000 แถวของ Supabase — บั๊กที่พี่เอจับได้ 6 ก.ย. 69
     *
     *    แอปเก่า ตรวจ 3,602 สลิป → เข้าเงื่อนไข 14 · จ่าย ฿12,500
     *    แอปใหม่ ตรวจ   794 สลิป → เข้าเงื่อนไข  0 · จ่าย ฿0
     *    ช่วงวันที่เดียวกันเป๊ะ ข้อมูลชุดเดียวกัน แต่ตัวเลขคนละเรื่อง
     *
     *  ต้นเหตุ: Supabase ตัดผลลัพธ์ RPC ที่ 1,000 แถว "เงียบ ๆ"
     *    ไม่มี error ไม่มีคำเตือน — คืนมา 1,000 แถวเหมือนมีอยู่แค่นั้นจริง ๆ
     *
     *  ‼ บั๊กชนิดที่แย่ที่สุด: ตัวเลขออกมา "ดูสมเหตุสมผล" แต่ผิด
     *    ถ้าไม่มีแอปเก่าไว้เทียบ ก็จ่ายเงินผิดทั้งเดือนโดยไม่มีใครเอะใจ
     * ═══════════════════════════════════════════════════════════════ */
    console.log('\n🔴 เพดาน 1,000 แถว — แคมเปญต้องอ่านครบทุกแถว');
    await pg.query('truncate app.total_sales');
    const N = 2350;                       /* มากกว่า 2 หน้า เพื่อพิสูจน์ว่าไล่หน้าจริง */
    await pg.query(`insert into app.total_sales (_row, "รหัสงาน", "วันที่โอน", "ยอด (บาท)",
                      "ประเภทลูกค้า", "ลูกค้ามาจากไหน", "ผู้ผลิต", "Lead Status", "Create By")
                    select g, 'CAP-'||g, date '2026-09-02', 25000,
                           'ลูกค้าใหม่', 'Online', 'ผลิตเอง-The101', 'ปิดการขาย', '(ส้ม) สมหญิง'
                    from generate_series(2, $1) g`, [N + 1]);

    const capped = await db.rpc('camp_sales_rows', { p_from: '2026-09-01' });
    ok(Array.isArray(capped) && capped.length === 1000,
       '‼ db.rpc ธรรมดา → โดนตัดเหลือ 1,000 แถว เงียบ ๆ (ได้ ' + (capped || []).length + ')');

    const full = await db.rpcAll('camp_sales_rows', { p_from: '2026-09-01' });
    ok(Array.isArray(full) && full.length === N,
       '🔑 db.rpcAll → ได้ครบทั้ง ' + N + ' แถว (ได้ ' + (full || []).length + ')');

    /* ‼ ข้อที่สำคัญที่สุด — เงินรางวัลต้องคิดจากข้อมูลครบ ไม่ใช่แค่ 1,000 แถวแรก */
    const CAMP = require('../modules/sales/campaign.js');
    const CC = { ...CAMP.applyCfg(null), FROM: '2026-09-01', TO: '2026-09-30' };
    /* ═══════════════════════════════════════════════════════════════
     *  🔴 ต้องส่ง hist:true — ยามนี้เคยแดงเองตามปฏิทิน (เจอ 16 ก.ย. 69)
     *
     *  campaign.visible() คืน false เมื่อวันนี้เลย C.SHOW_TO ของแคมเปญไปแล้ว
     *  (ค่าตั้งต้นตอนนี้ SHOW_TO = 2026-09-15 ⇒ ตั้งแต่ 16 ก.ย. เป็นต้นไป
     *   summary() จะ return ออกตั้งแต่บรรทัดแรก ได้ slips = 0 ทุกกรณี)
     *  ⇒ ยามข้อนี้จึงแดง "เพราะวันนี้วันที่เท่าไหร่" ไม่ใช่เพราะเพดาน 1,000 แถว
     *    ซึ่งเป็นคนละเรื่องกับสิ่งที่มันตั้งใจเฝ้าโดยสิ้นเชิง
     *
     *  hist:true = โหมดดูย้อนหลัง (v33.4) ซึ่งเปิดได้เสมอ — ตรงกับเจตนาของยามนี้
     *  ‼ ไม่ได้แก้ให้ผ่านเฉย ๆ: สิ่งที่พิสูจน์ยังเหมือนเดิมทุกตัวอักษร คือ
     *    "อ่าน 1,000 แถว = นับสลิปขาด = เซลส์ได้เงินรางวัลน้อยกว่าที่ควรได้"
     *  (บทเรียนเดียวกับเรื่อง toISOString ที่หัวไฟล์ test-cashflow.js:
     *   เทสต์ที่ผลลัพธ์ขึ้นกับนาฬิกา = เทสต์ที่จะโกหกในวันใดวันหนึ่งแน่นอน)
     * ═══════════════════════════════════════════════════════════════ */
    const sCap  = CAMP.summary(CC, capped, { hist: true });
    const sFull = CAMP.summary(CC, full, { hist: true });
    ok(sCap.totals.slips === 1000 && sFull.totals.slips === N,
       '‼ อ่านไม่ครบ = นับสลิปขาด (' + sCap.totals.slips + ' แทนที่จะเป็น ' + N + ')');
    ok(sFull.totals.reward === N * 1000 && sCap.totals.reward < sFull.totals.reward,
       '🔴 เงินรางวัลต่างกัน ฿' + (sFull.totals.reward - sCap.totals.reward).toLocaleString() +
       ' — นี่คือเงินที่เซลส์จะไม่ได้รับถ้าอ่านไม่ครบ');

    /* ‼ กันไม่ให้ใครเผลอเปลี่ยนกลับไปใช้ db.rpc กับตัวอ่านแถวแคมเปญ */
    const capiSrc = require('fs').readFileSync(
      path.join(__dirname, '..', 'modules', 'sales', 'campaign-api.js'), 'utf8');
    for (const fn of ['camp_sales_rows', 'camp_peak_cashflow', 'camp_peak_invoices'])
      ok(!new RegExp("db\\.rpc\\(\\s*'" + fn + "'").test(capiSrc),
         `‼ ${fn} ต้องเรียกผ่าน rpcAll เท่านั้น (ห้ามกลับไปใช้ db.rpc)`);

  } finally {
    await rest.close().catch(() => {});
    await pg.end();
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log(`ผ่าน ${pass} · ไม่ผ่าน ${fail}`);
  console.log('════════════════════════════════════════════════════\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
