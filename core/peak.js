'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/peak.js — คุยกับ PEAK Account
 *
 *  ‼‼ อ่านอย่างเดียวตลอดไป — คำสั่งพี่เอ 4 ก.ย. 69
 *      "ในส่วนของ peak ดึงข้อมูลมาใช้อย่างเดียว ห้ามให้ peak update data ใดๆ"
 *
 *  ไฟล์นี้มี POST อยู่ที่เดียวคือ /ClientToken = "ขอกุญแจเข้าระบบ"
 *  ส่งไปแค่ค่าเชื่อมต่อ ไม่มีข้อมูลธุรกิจติดไปแม้แต่ฟิลด์เดียว
 *  ที่เหลือเป็น GET ทั้งหมด และผ่านด่าน ALLOW ที่ระบุชื่อ endpoint ไว้ตายตัว
 *  มีเทสต์กวาดทั้งไฟล์คุมไว้ว่าห้ามมี PUT/PATCH/DELETE โผล่มา
 *
 *  ── กับดักที่โค้ดเดิมเจ็บมาแล้ว ต้องยกมาให้ครบ ──────────────────
 *   1. Time-Stamp ต้องเป็น UTC — เวลาไทยเร็วกว่า 7 ชม. PEAK ปฏิเสธทันที (v17.23.5)
 *   2. ตัวห่อ JSON ชื่อ "PeakClientToken" — P ใหญ่ (v17.23.4)
 *   3. ลายเซ็น = HMAC-SHA1(Time-Stamp) กุญแจ connectKey → hex ตัวเล็ก (v17.23.6)
 *   4. คำตอบซ้อน 2 ชั้น { PeakReceipts: { receipts: [...] } } (v17.23.7)
 *   5. 🔴 PEAK ตอบ HTTP 200 พร้อมรายการว่าง เวลากุญแจใช้ไม่ได้ —
 *      ซ่อน "Invalid Client Token" ไว้ในเนื้อคำตอบ ต้องอ่าน resCode/resDesc ด้วย
 *      ไม่งั้นจะแปลว่า "ไม่พบเอกสาร" ทั้งที่ใบมีอยู่จริง (v32.6 — ต้นตอตัวจริง)
 *   6. "ถามไม่สำเร็จ" ≠ "ไม่มีเอกสารนี้" — เจอ error ต้องโยนออกไป
 *      ห้ามคืนรายการว่างให้ใครเอาไปแปลผลเด็ดขาด
 * ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const { CFG } = require('./config');

const BASE = 'https://api.peakaccount.com/api/v1';

/* ── ด่านกันเขียน: เรียกได้เฉพาะรายชื่อนี้เท่านั้น (code.gs:8132) ──
 *  คีย์ = ชื่อตัวพิมพ์เล็กที่ใช้ตรวจ · ค่า = ชื่อจริงที่ยิงไป PEAK
 *  ‼ ยิงด้วย "ค่า" ในตารางนี้เสมอ ไม่ใช่สตริงที่ผู้เรียกส่งมา */
const CANON = {
  receipts: 'Receipts', invoices: 'Invoices', contacts: 'Contacts',
  quotations: 'Quotations', expenses: 'Expenses',
  'invoices/list': 'Invoices/list', 'quotations/list': 'Quotations/list',
  'receipts/list': 'Receipts/list', 'contacts/list': 'Contacts/list',
  'invoices/listbycontact': 'Invoices/listbycontact', 'expenses/list': 'Expenses/list',
  /* ── 📦 สินค้า — เพิ่ม 23 ก.ย. 69 (รอบ 90) หลังเปิดเอกสารของ PEAK จริง
   *  เอกสาร developers.peakaccount.com ระบุชุดเดียวกันทุกเอกสาร:
   *    GET /api/v1/<ชื่อ>        = เอกสารรายตัว (มีพารามิเตอร์ id · code · getResult)
   *    GET /api/v1/<ชื่อ>/list   = รายการ
   *  ⇒ "ดึงสินค้าจาก PEAK" ที่เคยขึ้นว่า endpoint ไม่อยู่ในรายชื่อ ใช้ชื่อนี้ได้แล้ว
   *  🔒 GET ล้วนเหมือนทุกชื่อในตารางนี้ — เปิดชื่อไม่ได้เปิดทางเขียน */
  products: 'Products', 'products/list': 'Products/list',
  /* ── 🧾 ใบสั่งซื้อ (Purchase Order) — เพิ่ม 15 ก.ย. 69 ─────────────
   *  พี่เอสั่ง: "ดึงข้อมูลใบ po จาก peak ... เพื่อดึงรายการ po ที่ยังไม่รับของ
   *             มาทำการรับสินค้าเข้าคลังได้"
   *
   *  🔴 ทั้ง 4 ชื่อนี้เป็น GET ล้วน เหมือนทุกชื่อในตารางนี้ — ไม่มีชื่อไหน
   *    ที่ใช้สร้าง/แก้ใบสั่งซื้อได้เลย (ตัวคุยตัวเดียวของระบบคือ get() ข้างล่าง
   *    ซึ่งฝัง method: 'GET' ไว้ตายตัว) ⇒ เปิดชื่อพวกนี้ไม่ได้เปิดทางเขียน
   *
   *  ‼ ทำไมมี 4 ชื่อ ไม่ใช่ชื่อเดียว: เอกสาร PEAK ไม่ได้บอกว่าเส้นทางใบสั่งซื้อ
   *    ชื่ออะไร ของเดิม (_source/purchase/Code.gs:1794) รู้แค่ว่าตัวห่อคำตอบ
   *    ชื่อ "PeakPurchaseOrders" แต่ไม่เคยยิงถามจริงสักครั้ง
   *    ⇒ ห้ามเดาชื่อเดียวแล้วเชื่อ — ใช้วิธีเดียวกับ probeSignature:
   *      "ลองก่อน — โดนปฏิเสธค่อยลองชื่อถัดไป แล้วจำชื่อที่ผ่านไว้"
   *      (ดู PO_TRY / poGet ข้างล่าง) */
  purchaseorders: 'PurchaseOrders', 'purchaseorders/list': 'PurchaseOrders/list',
  purchaseorder: 'PurchaseOrder', 'purchaseorder/list': 'PurchaseOrder/list',

  /* ── 🧾 "ใบสั่งซื้อรายใบ" — เพิ่ม 23 ก.ย. 69 (รอบ 84) ──────────────
   *  พี่เอ: "ในระบบคลังสินค้าที่ดึง po จาก peak ทำไมไม่มีรายการมาให้รับสินค้าเข้าคลัง"
   *
   *  🔴 พิสูจน์แล้วจากหน้าจอจริง: เส้นทาง "รายการใบ" (PurchaseOrders/list)
   *    ส่งมาแต่ "หัวใบ" — ทั้ง 164 ใบไม่มีอาเรย์รายการสินค้าเลยสักกล่อง
   *    (หน้าจอขึ้นว่า "กล่องที่ PEAK ส่งชื่อ: (ไม่มีอาเรย์เลย)")
   *    ⇒ ของที่ต้องรับเข้าคลังจึงว่างเปล่าทุกใบ — ไม่ใช่เพราะเราอ่านชื่อกล่องผิด
   *    แต่เพราะ "ยังไม่เคยถามใบรายตัว" สักครั้ง
   *
   *  ‼ ชื่อเส้นทางใบรายตัวของ PEAK เรายังไม่รู้เหมือนกัน ⇒ ท่าเดียวกับ PO_TRY:
   *    ลองทีละชื่อ ทีละชื่อพารามิเตอร์ แล้วจำคู่ที่ "ได้กล่องรายการสินค้าจริง"
   *    (modules/inventory/peakpo.js · poDocTry) ไม่มีการเดาโครงสร้างแม้แต่ช่องเดียว
   *  🔒 ทุกชื่อเป็น GET ล้วนเหมือนทุกชื่อในตารางนี้ — get() ฝัง method:'GET' ไว้ตายตัว */
  'purchaseorders/get': 'PurchaseOrders/get', 'purchaseorder/get': 'PurchaseOrder/get',
  'purchaseorders/detail': 'PurchaseOrders/detail', 'purchaseorder/detail': 'PurchaseOrder/detail',
  'purchaseorders/view': 'PurchaseOrders/view', 'purchaseorders/getbyid': 'PurchaseOrders/getbyid',

  /* ── 💸 ชื่อ "เอกสารรายจ่าย" แบบอื่นที่ยังไม่เคยลอง — เพิ่ม 16 ก.ย. 69 (รอบ 34)
   *  พี่เอสั่ง: "จัดการแก้ไข เรื่อง Cash flow รายรับ รายจ่าย ให้ได้ 100%
   *            ตามเอกสารของ peak ที่จ่ายออกไปจริงด้วย แก้ให้จบนะ"
   *
   *  🔴 ทำไมต้องมีหลายชื่อ: กิจการ "มดงานการป้าย" ยิงถาม /Expenses ไป 28 ครั้ง
   *    PEAK ตอบ "สำเร็จ" ครบ 28 ครั้ง (โดนปฏิเสธ 0) แต่ได้เอกสาร 0 ใบ
   *    ⇒ แปลว่า "เรียกถูกทางแล้วแต่หาเอกสารไม่เจอ" ซึ่งอธิบายได้ 2 ทาง
   *       ① รูปแบบเลขเอกสารที่เราเดาไว้ผิด
   *       ② เอกสารรายจ่ายของกิจการนี้อยู่ใต้ชื่อ endpoint อื่น
   *    ⇒ ห้ามลองชื่อเดียวแล้วสรุป — ใช้ท่าเดียวกับ PO_TRY: ลองทีละชื่อ จำชื่อที่ผ่าน
   *
   *  🔒 ทุกชื่อในตารางนี้เป็น GET ล้วนเหมือนทุกชื่อข้างบน — ตัวคุยตัวเดียวของระบบ
   *    คือ get() ข้างล่าง ซึ่งฝัง method:'GET' ไว้ตายตัว การเปิดชื่อเพิ่ม
   *    จึงไม่ได้เปิดทางเขียนแม้แต่นิดเดียว (ยามใน test:peakwrite กวาดทั้งไฟล์คุมไว้) */
  expense: 'Expense',
  purchaseinvoices: 'PurchaseInvoices', purchaseinvoice: 'PurchaseInvoice',
  bills: 'Bills', bill: 'Bill',
  payments: 'Payments', payment: 'Payment',
  expensenotes: 'ExpenseNotes', expensenote: 'ExpenseNote',
  purchases: 'Purchases', purchase: 'Purchase',

  /* ── 📒 งบทดลอง · บัญชีแยกประเภท · ผังบัญชี · สมุดรายวัน — เพิ่ม 4 ต.ค. 69 (รอบ 233)
   *  พี่เอ: "management report เรายังดึงค่าใช้จ่ายมาไม่หมดนะ พี่เพิ่งรู้ว่า เค้าไม่ได้คีย์ใน EXP 100%
   *         มันจะมีคีย์ไปที่รหัสผังบัญชีโดยตรง ส่วนนี้ไปเอามาได้มั้ย"
   *  ชื่อเส้นทางตามเอกสาร developers.peakaccount.com (ไม่ได้เดา):
   *    GET /api/v1/FinancialReports/trialbalance     fromMonth · toMonth · isShowSubAccount
   *    GET /api/v1/FinancialReports/generalledger    fromDate · toDate · accountCode · isShowSubAccount
   *    GET /api/v1/DailyJournals                     code · id · limit · page · getResult
   *    GET /api/v1/DailyJournals/accountcode         (ผังบัญชี)
   *  🔒 GET ล้วนเหมือนทุกชื่อในตารางนี้ — get() ฝัง method:'GET' ไว้ตายตัว
   *     (PEAK มี POST /DailyJournals สำหรับ "สร้าง" สมุดรายวันด้วย แต่ระบบนี้ไม่มีทางยิง POST ไปเส้นนั้น)
   *  ผู้เรียกตัวเดียว: core/peak-ledger.js */
  'financialreports/trialbalance': 'FinancialReports/trialbalance',
  'financialreports/generalledger': 'FinancialReports/generalledger',
  dailyjournals: 'DailyJournals', 'dailyjournals/accountcode': 'DailyJournals/accountcode',
};
const ALLOW = new Set(Object.keys(CANON));

/* ── ค่าเชื่อมต่อ 2 กิจการ (code.gs:7958) ──────────────────────────
 *  ‼ ค่าเริ่มต้นในไฟล์มีไว้ให้ระบบเดินได้ตอนย้าย — ของจริงควรตั้งใน Railway
 *    ตัวแปร: PEAK_MODNGAN_KEY / PEAK_THE101_KEY ฯลฯ */
/* ── อ่านกุญแจจากโค้ดเดิมเป็นทางสำรอง ────────────────────────────
 *
 *  ‼ ทำไมถึงทำแบบนี้ (5 ก.ย. 69)
 *    กุญแจ PEAK ครบทั้ง 2 กิจการฝังอยู่ใน modules/sales/_source/Code.gs
 *    ซึ่งเป็นไฟล์ที่อยู่ในโปรเจกต์นี้อยู่แล้ว การอ่านค่าจากตรงนั้นมาใช้
 *    จึงไม่ได้เพิ่มความเสี่ยงอะไรเลยแม้แต่นิดเดียว — ของอยู่ที่เดิม
 *    แต่ทำให้ระบบ "เชื่อมได้ทันทีที่ดีพลอย" ไม่ต้องรอใครไปก๊อปค่ามาวาง
 *
 *  ‼ ลำดับความสำคัญ: Railway Variables ชนะเสมอ
 *    ตั้งที่ Railway เมื่อไหร่ ค่านั้นถูกใช้ทันที ค่าในไฟล์ถูกมองข้าม
 *    วันที่เปลี่ยนกุญแจกับ PEAK จึงแก้ที่เดียวจบ ไม่ต้องแก้โค้ด
 *
 *  ‼ อ่านครั้งเดียวตอนบูต ไม่อ่านซ้ำ และไม่ log ค่าออกมาที่ไหนเลย
 */
function fromLegacy() {
  const out = {};
  try {
    const fs = require('fs'), path = require('path');
    const f = path.join(__dirname, '..', 'modules', 'sales', '_source', 'Code.gs');
    if (!fs.existsSync(f)) return out;
    const src = fs.readFileSync(f, 'utf8');
    const i = src.indexOf('var PEAK_ACCOUNTS');
    if (i < 0) return out;
    const blk = src.slice(i, src.indexOf('};', i));
    for (const name of ['มดงานการป้าย', 'The 101']) {
      const j = blk.indexOf(name);
      if (j < 0) continue;
      const seg = blk.slice(j, j + 900);
      const g = k => (seg.match(new RegExp(k + "\\s*:\\s*'([^']*)'")) || [])[1] || '';
      const c = { connectId: g('connectId'), connectKey: g('connectKey'),
                  applicationCode: g('applicationCode'), userToken: g('userToken') };
      if (c.connectKey && c.userToken) out[name] = c;
    }
  } catch { /* อ่านไม่ได้ก็ไม่เป็นไร ตกไปใช้ค่าจาก Railway */ }
  return out;
}
const LEGACY = fromLegacy();

/* ═══════════════════════════════════════════════════════════════════
 *  ‼ ตัดช่องว่างหัวท้ายของค่าเชื่อมต่อทุกตัว — เพิ่ม 15 ก.ย. 69 (รอบ 26-E)
 *
 *  🔴 ทำไมถึงต้องมี: core/config.js opt() คืนค่าจาก process.env ดิบ ๆ ไม่ตัดอะไรเลย
 *    คนวางค่าลงช่อง Railway Variables ติดช่องว่าง/ขึ้นบรรทัดมาด้วยเป็นเรื่องปกติมาก
 *    (ก๊อปจากไลน์ · ก๊อปจากหน้าเว็บ PEAK · ก๊อปจากไฟล์ .txt)
 *    ⇒ ค่าที่ "ดูเหมือนถูก" แต่ต่างกัน 1 ตัวอักษร ⇒ ลายเซ็นผิด หรือ PEAK ปฏิเสธ
 *      แล้วหน้าจอบอกแค่ว่า "กุญแจใช้ไม่ได้" ซึ่งหาสาเหตุไม่เจอทั้งวัน
 *
 *  ‼ ตัดแค่ "หัวท้าย" เท่านั้น ห้ามแตะข้างใน — ค่าจริงของ PEAK ไม่มีช่องว่าง
 *    หัวท้ายอยู่แล้ว ⇒ การตัดจึงไม่เปลี่ยนค่าที่ถูกต้อง แต่กู้ค่าที่พิมพ์เกินได้
 *  🔒 ไม่มีการ log ค่า ไม่มีการคืนค่าออกไปไหน เหมือนเดิมทุกประการ
 * ═══════════════════════════════════════════════════════════════════ */
const trimCred = v => String(v == null ? '' : v).trim();

/** ค่าจาก Railway ชนะเสมอ · ไม่มีค่อยใช้ของในไฟล์ */
const pick = (env, name, key) =>
  trimCred(env) || trimCred((LEGACY[name] || {})[key]) || '';

const ACCOUNTS = {
  'มดงานการป้าย': {
    connectId:       pick(CFG.PEAK_MODNGAN_ID,   'มดงานการป้าย', 'connectId')
                     || 'modngankarnpai_peakapi',
    connectKey:      pick(CFG.PEAK_MODNGAN_KEY,  'มดงานการป้าย', 'connectKey'),
    applicationCode: pick(CFG.PEAK_MODNGAN_APP,  'มดงานการป้าย', 'applicationCode')
                     || 'M3HGSAAA20',
    userToken:       pick(CFG.PEAK_MODNGAN_USER, 'มดงานการป้าย', 'userToken'),
  },
  'The 101': {
    connectId:       pick(CFG.PEAK_THE101_ID,    'The 101', 'connectId') || 'the101_peakapi',
    connectKey:      pick(CFG.PEAK_THE101_KEY,   'The 101', 'connectKey'),
    applicationCode: pick(CFG.PEAK_THE101_APP,   'The 101', 'applicationCode') || 'T3JGWAAA20',
    userToken:       pick(CFG.PEAK_THE101_USER,  'The 101', 'userToken'),
  },
};

/** กุญแจของกิจการนี้มาจากไหน — ไว้บอกบนหน้าจอ ‼ ไม่เปิดเผยค่าจริง */
function sourceOf(biz) {
  const envKey = biz === 'The 101' ? CFG.PEAK_THE101_KEY : CFG.PEAK_MODNGAN_KEY;
  if (envKey) return 'railway';
  if ((LEGACY[biz] || {}).connectKey) return 'legacy';
  return 'none';
}

/* ═══════════════════════════════════════════════════════════════════
 *  🔴 "ค่าเชื่อมต่อใบนี้ประกอบมาจากที่ไหนบ้าง" — เพิ่ม 15 ก.ย. 69 (รอบ 26-E)
 *
 *  ‼ ทำไมต้องมี: sourceOf() ข้างบนดูแค่ **connectKey ตัวเดียว** แล้วสรุปว่า
 *    "กิจการนี้ใช้กุญแจจาก Railway" ทั้งชุด — ซึ่งไม่จริง
 *    ค่าเชื่อมต่อของ PEAK มี 4 ตัว และแต่ละตัวเดินคนละทางได้:
 *      · ConnectId / ApplicationCode — CFG มี **ค่าเริ่มต้นฝังในโค้ด**
 *        (core/config.js:166-173) ⇒ opt() คืนค่าเริ่มต้นเสมอ ⇒ pick() ไม่เคย
 *        ตกไปอ่านของในไฟล์โค้ดเดิมเลยแม้แต่ครั้งเดียว
 *      · ConnectKey / UserToken    — CFG ตั้งต้นเป็น '' ⇒ ตกไปอ่าน Code.gs
 *    ⇒ วันไหนพี่เอตั้ง PEAK_THE101_KEY ที่ Railway แต่ลืม PEAK_THE101_USER
 *      ระบบจะเอา **กุญแจใหม่ + UserToken เก่า** ยิงไปด้วยกันเงียบ ๆ
 *      หน้าจอก็ยังบอกว่า "railway" เพราะดูแค่ตัวเดียว
 *
 *  🔒 คืนแค่ "ชื่อช่อง · ชื่อตัวแปร Railway · มาจากไหน · ยาวกี่ตัว"
 *     ‼ ไม่เคยคืนค่าจริงออกไปไหนทั้งสิ้น (กติกาเดิมของ missingOf)
 * ═══════════════════════════════════════════════════════════════════ */
const ENV_OF = {
  'มดงานการป้าย': { connectId: 'PEAK_MODNGAN_ID', connectKey: 'PEAK_MODNGAN_KEY',
                    applicationCode: 'PEAK_MODNGAN_APP', userToken: 'PEAK_MODNGAN_USER' },
  'The 101':      { connectId: 'PEAK_THE101_ID', connectKey: 'PEAK_THE101_KEY',
                    applicationCode: 'PEAK_THE101_APP', userToken: 'PEAK_THE101_USER' },
};
/** ชื่อตัวแปร Railway ของช่องหนึ่งในกิจการหนึ่ง ('' = ไม่รู้จักกิจการนี้) */
function envNameOf(biz, field) { return (ENV_OF[biz] || {})[field] || ''; }

/**
 * ค่าเชื่อมต่อของกิจการหนึ่งประกอบมาจากไหนบ้าง — ทีละช่อง
 * @return {{biz, configured, missing:string[], mixed:boolean,
 *           fields:Array<{field,label,envVar,source,len}>}}
 *   source: 'railway' = ตั้งที่ Railway Variables
 *           'legacy'  = อ่านจาก modules/sales/_source/Code.gs
 *           'builtin' = ค่าเริ่มต้นที่ฝังใน core/config.js
 *           'none'    = ยังไม่มีค่า
 */
const CRED_FIELDS = [
  ['connectId', 'ConnectId'], ['connectKey', 'ConnectKey'],
  ['applicationCode', 'ApplicationCode'], ['userToken', 'UserToken'],
];
function credReport(biz) {
  const name = ACCOUNTS[biz] ? biz : 'มดงานการป้าย';
  const c = ACCOUNTS[name];
  const leg = LEGACY[name] || {};
  const fields = CRED_FIELDS.map(([field, label]) => {
    const envVar = envNameOf(name, field);
    const raw = process.env[envVar];
    const val = String(c[field] || '');
    let source = 'none';
    if (!val) source = 'none';
    else if (raw !== undefined && raw !== '' && trimCred(raw) === val) source = 'railway';
    else if (leg[field] && trimCred(leg[field]) === val) source = 'legacy';
    else source = 'builtin';
    /* ‼ บอกด้วยว่า "ค่าที่ตั้งไว้มีช่องว่างหัวท้ายติดมา" — ระบบตัดให้แล้ว
     *   แต่พี่เอควรรู้ เพราะมันแปลว่าตอนวางค่าติดอะไรมาด้วย 🔒 ไม่บอกค่า */
    const padded = source === 'railway' && String(raw) !== trimCred(raw);
    return { field, label, envVar, source, len: val.length, padded };
  });
  const have = fields.filter(f => f.source !== 'none');
  const srcSet = new Set(have.map(f => f.source));
  return {
    biz: name,
    configured: have.length === CRED_FIELDS.length,
    missing: fields.filter(f => f.source === 'none').map(f => f.label),
    /* 🔴 "ประกอบจากหลายที่" — ไม่ได้แปลว่าผิดเสมอไป แต่เป็นจุดแรกที่ต้องสงสัย
     *   เวลากุญแจใช้ไม่ได้เฉพาะกิจการเดียว (ค่าคนละรุ่นมาปนกัน) */
    mixed: srcSet.size > 1,
    fields,
  };
}

/** บรรทัดเดียวไว้ใส่ในข้อความ error — 🔒 ไม่มีค่าจริงติดไปแม้แต่ตัวเดียว */
function credLine(biz) {
  const r = credReport(biz);
  const where = { railway: 'Railway', legacy: 'ไฟล์โค้ดเดิม', builtin: 'ค่าเริ่มต้นในโค้ด', none: '❌ ยังไม่ได้ตั้ง' };
  return r.fields.map(f => `${f.label}=${where[f.source]}` +
    (f.source === 'railway' || f.source === 'none' ? ` (${f.envVar})` : '')).join(' · ');
}

/* กติกาแยกกิจการจากเลขเอกสาร (code.gs:7921 BIZ_DOC_RULE)
 *   มดงานการป้าย : ปี ค.ศ. 4 หลัก → ตัวเลข 13 หลัก  IV-2026082100017
 *   The 101      : ปี พ.ศ. 2 หลัก → ตัวเลข 11 หลัก  IV-69082200003
 * รู้กิจการได้จากเลขเอกสารเลย ไม่ต้องถาม PEAK */
function bizOfDoc(ref) {
  const m = String(ref || '').trim().match(/^(IV|QO|QT|EXP)[-\s]*(\d+)$/i);
  if (!m) return '';
  const n = m[2].length;
  if (n >= 13) return 'มดงานการป้าย';
  if (n >= 11) return 'The 101';
  return '';
}

const clean = s => String(s == null ? '' : s).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cfgOf(biz) {
  const c = ACCOUNTS[biz] || ACCOUNTS['มดงานการป้าย'];
  return { biz: ACCOUNTS[biz] ? biz : 'มดงานการป้าย', ...c };
}

/** ตั้งค่าครบไหม — เช็คก่อนเรียก จะได้บอกคนใช้ได้ว่าขาดอะไร */
function isConfigured(biz) {
  const c = cfgOf(biz);
  return !!(c.connectId && c.connectKey && c.applicationCode && c.userToken);
}
function configuredList() {
  return Object.keys(ACCOUNTS).filter(b => isConfigured(b));
}
/* ‼ รายชื่อกิจการ "ทั้งหมด" ที่ระบบรู้จัก (ตั้งกุญแจแล้วหรือยังไม่ได้ตั้งก็ตาม)
 *   ใช้ตอบคำถามเดียว: "ถามครบทุกกิจการหรือยัง"
 *   ของเดิมในตัวซิงก์เขียนเทียบกับเลข 2 ตายตัว — วันไหนเปิดกิจการที่ 3
 *   มันจะสรุปว่า "ไม่พบใน PEAK" ทั้งที่ยังไม่ได้ถามกิจการนั้นเลย */
function bizAll() { return Object.keys(ACCOUNTS); }

/* ── กิจการนี้ยังขาดค่าเชื่อมต่อตัวไหนบ้าง (peakBizStatus code.gs:8189) ──
 *  🔒 คืนแค่ "ชื่อช่องที่ยังว่าง" ไม่เคยคืนค่าจริงของกุญแจออกไปไหนทั้งสิ้น
 *     (ของเดิมก็ทำแบบนี้ — หน้าจอต้องรู้ว่าขาดอะไร แต่ไม่ต้องเห็นค่า) */
function missingOf(biz) {
  const c = cfgOf(biz);
  return [['ConnectId', c.connectId], ['ConnectKey', c.connectKey],
          ['ApplicationCode', c.applicationCode], ['UserToken', c.userToken]]
    .filter(x => !x[1]).map(x => x[0]);
}

/* ‼ UTC เท่านั้น — ส่งเวลาไทยไป PEAK ปฏิเสธว่า "ล่วงหน้า 7 ชั่วโมง" */
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
         `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/* ═══════════════════════════════════════════════════════════════════
 *  ลายเซ็นเวลา (TimeSignature)
 *
 *  ‼ สูตรลายเซ็น "เดาไม่ได้" — เอกสาร PEAK ไม่ได้บอกว่า
 *    เซ็นด้วยกุญแจตัวไหน · เซ็นข้อความอะไร · ส่งเป็น hex หรือ base64
 *
 *    แอปเดิมจึงมีตัวไล่ยิงทดสอบทีละสูตรจนกว่าจะผ่าน แล้วจำสูตรนั้นไว้
 *    (code.gs:8661 peakProbeSignature) — สูตรที่ใช้ได้จริงถูกเก็บไว้ใน
 *    Script Properties ของแอปเดิม ไม่ได้อยู่ในไฟล์โค้ด เราจึงไม่มีทางรู้
 *    ต้องยกตัวไล่หามาด้วย ไม่ใช่เดาเอาเอง
 *
 *  บทเรียน 5 ก.ย. 69: อลิซใส่สูตรดีฟอลต์ไปตัวเดียว (connectKey · ts เปล่า ·
 *  hex · SHA1) แล้ว PEAK ตอบ "TimeSignature Unauthorized" ทุกครั้ง
 * ═══════════════════════════════════════════════════════════════════ */

/** กุญแจที่ใช้เซ็น — 6 แบบที่เป็นไปได้ */
function secretOf(c, name) {
  switch (name) {
    case 'connectId': return c.connectId;
    case 'appCode':   return c.applicationCode;
    case 'key+id':    return c.connectKey + c.connectId;
    case 'id+key':    return c.connectId + c.connectKey;
    case 'userToken': return c.userToken;
    default:          return c.connectKey;
  }
}

/** ข้อความที่เซ็น — 6 แบบ */
function msgOf(c, name, ts) {
  switch (name) {
    case 'id+ts':     return c.connectId + ts;
    case 'ts+id':     return ts + c.connectId;
    case 'app+ts':    return c.applicationCode + ts;
    case 'ts+app':    return ts + c.applicationCode;
    case 'id+app+ts': return c.connectId + c.applicationCode + ts;
    default:          return ts;
  }
}

/** เข้ารหัสผลลัพธ์ — hex ตัวเล็ก · HEX ตัวใหญ่ · base64 */
function encode(buf, fmt) {
  if (fmt === 'base64') return buf.toString('base64');
  const h = buf.toString('hex');
  return fmt === 'HEX' ? h.toUpperCase() : h;
}

/** เซ็นตามสูตรที่ระบุ */
function signWith(c, ts, f) {
  const algo = f.alg === 'SHA256' ? 'sha256' : 'sha1';
  const mac = crypto.createHmac(algo, secretOf(c, f.secret))
    .update(String(msgOf(c, f.msg, ts)));
  return encode(mac.digest(), f.fmt);
}

/* โครงสร้าง body ของคำขอกุญแจ — 7 แบบ (code.gs:8642) */
function ctBody(c, ts, sig, style) {
  switch (String(style || 'B').toUpperCase()) {
    case 'A': return { PeakClientToken: { connectId: c.connectId, connectKey: c.connectKey,
                                          applicationCode: c.applicationCode, timeStamp: ts } };
    case 'C': return { PeakClientToken: { connectId: c.connectId, connectKey: c.connectKey,
                                          applicationCode: c.applicationCode } };
    case 'D': return { PeakClientToken: { ConnectId: c.connectId, ConnectKey: c.connectKey,
                                          ApplicationCode: c.applicationCode,
                                          TimeStamp: ts, TimeSignature: sig } };
    case 'E': return { PeakClientToken: { ConnectId: c.connectId, ConnectKey: c.connectKey,
                                          ApplicationCode: c.applicationCode, TimeStamp: ts },
                       eventType: 'Create', apiType: 'ApiClientToken' };
    case 'F': return { PeakClientToken: { connectId: c.connectId, connectKey: c.connectKey,
                                          applicationCode: c.applicationCode,
                                          timeStamp: ts, timeSignature: sig } };
    case 'G': return { PeakClientToken: { ConnectId: c.connectId, ConnectKey: c.connectKey,
                                          ApplicationCode: c.applicationCode, TimeStamp: ts,
                                          UserToken: c.userToken } };
    default:  return { PeakClientToken: { ConnectId: c.connectId, ConnectKey: c.connectKey,
                                          ApplicationCode: c.applicationCode, TimeStamp: ts } };
  }
}

/* สูตรที่ค้นเจอแล้ว เก็บไว้ในฐานข้อมูล — ค้นครั้งเดียวใช้ตลอด */
const DEF_FORMULA = { secret: 'connectKey', msg: 'ts', fmt: 'hex', alg: 'SHA1', style: 'B' };
let _formula = null;

async function loadFormula() {
  if (_formula) return _formula;
  try {
    const q = require('./peak-queue');
    const raw = await q.state('peak_sig_formula');
    if (raw) _formula = { ...DEF_FORMULA, ...JSON.parse(raw) };
  } catch { /* ยังไม่มีก็ใช้ค่าตั้งต้น */ }
  return (_formula = _formula || { ...DEF_FORMULA });
}
async function saveFormula(f) {
  _formula = { ...DEF_FORMULA, ...f };
  try { await require('./peak-queue').state('peak_sig_formula', JSON.stringify(_formula)); }
  catch { /* จำไม่ได้ก็ยังใช้ได้ในรอบนี้ */ }
  return _formula;
}

/* ═══════════════════════════════════════════════════════════════════
 *  🔒 ตัวลบความลับออกจากข้อความ — เพิ่ม 15 ก.ย. 69 (รอบ 26-E)
 *
 *  กฎเหล็กของพี่เอ: "ห้ามส่งในไลน์ · ห้ามใส่ในโค้ด · ห้าม commit ขึ้น git"
 *  ⇒ ค่าความลับต้องไม่โผล่ใน error · ไม่โผล่ในบันทึกผลทดสอบ · ไม่โผล่ในปุ่ม
 *    "ดูคำตอบดิบจาก PEAK" ด้วย
 *
 *  🔴 ช่องโหว่จริงที่ปิดด้วยตัวนี้ (core/peak.js เดิม บรรทัด 364):
 *      const desc = (text.match(/"resDesc".../) || [])[1] || text.slice(0, 200)
 *    คำตอบของ /ClientToken คือกล่องที่ "มีกุญแจอยู่ข้างใน" — วันไหน PEAK ตอบ
 *    โดยไม่มี resDesc (หรือ token สั้นกว่า 10 ตัวจน ok=false) ทางสำรองจะหยิบ
 *    **200 ตัวอักษรแรกของคำตอบดิบ** มาเป็น desc แล้ว desc ตัวนั้นเดินต่อไป
 *    ขึ้นหน้าจอ (askTokenOnce_) · ลงฐานข้อมูล (markVerify เก็บ 300 ตัว) ·
 *    และขึ้นการ์ดผลการค้นสูตร (probeSignature.clues)
 *
 *  วิธีปิด: ค่าไหนอยู่หลังคีย์ที่มีคำว่า token/key/secret/signature/password
 *  ให้แทนที่ด้วย «ซ่อนไว้» ตั้งแต่ก่อนที่ข้อความจะออกจากไฟล์นี้
 * ═══════════════════════════════════════════════════════════════════ */
const SECRET_KEY_RE = /token|key|secret|signature|password|passwd|credential/i;
const HIDDEN = '«ซ่อนไว้»';
function redact(s) {
  let t = String(s == null ? '' : s);
  /* "clientToken":"abc..."  →  "clientToken":"«ซ่อนไว้»"   (รวม ' และเว้นวรรค) */
  t = t.replace(/(["']?)([A-Za-z_][A-Za-z0-9_]*)\1(\s*[:=]\s*)(["'])((?:\\.|(?!\4).)*)\4/g,
    (m, q1, k, mid, q2, v) => (SECRET_KEY_RE.test(k) && v ? `${q1}${k}${q1}${mid}${q2}${HIDDEN}${q2}` : m));
  return t;
}
/** ลบความลับออกจากค่าอะไรก็ได้ที่จะถูกส่งออกไปนอกเซิร์ฟเวอร์ (object ก็ได้) */
function redactDeep(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(redactDeep);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = SECRET_KEY_RE.test(k) ? HIDDEN : redactDeep(v[k]);
    return out;
  }
  return typeof v === 'string' ? redact(v) : v;
}

/* ── ขอกุญแจ 1 ครั้งตามสูตรที่ให้ ─────────────────────────────── */
async function askToken(c, f) {
  const ts = stamp();
  const sig = signWith(c, ts, f);
  const res = await fetch(BASE + '/ClientToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json',
               'Time-Stamp': ts, 'Time-Signature': sig },
    body: JSON.stringify(ctBody(c, ts, sig, f.style)),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON */ }
  const token = json ? dig(json, ['clientToken', 'client_token', 'token', 'accessToken']) : null;
  /* 🔒 ทางสำรองต้องผ่าน redact() เสมอ — คำตอบของ /ClientToken มีกุญแจอยู่ข้างใน */
  const desc = (text.match(/"resDesc"\s*:\s*"([^"]*)"/) || [])[1] || redact(text).slice(0, 200);
  /* ‼ คืน text ดิบไว้ให้ตัวเรียกดูโครงสร้าง (เช่นหา retryAfterSeconds) เท่านั้น
   *   🔴 ห้ามเอา r.text ไปใส่ข้อความที่คนเห็น — ใช้ r.desc ซึ่งลบความลับแล้ว */
  return { ok: !!(token && String(token).length > 10), token, status: res.status, desc, text };
}

/**
 * ‼ ค้นหาสูตรลายเซ็นที่ PEAK ยอมรับ แล้วจำไว้ (ถอดจาก peakProbeSignature)
 *
 *  ‼ PEAK จำกัดการขอกุญแจไว้ (429 ClientTokenLimit · รอ 60 วินาที)
 *    จึงต้องเว้นจังหวะระหว่างสูตร และหยุดทันทีที่โดนจำกัด
 *    ไม่งั้นยิงรัวแล้วโดนบล็อกจนทดสอบอะไรไม่ได้เลยทั้งชั่วโมง
 */
async function probeSignature(biz, { gapMs = 1200, max = 40, log = null } = {}) {
  const c = cfgOf(biz);
  const say = log || (() => {});
  if (!isConfigured(c.biz)) return { ok: false, error: 'ยังไม่ได้ตั้งกุญแจของกิจการนี้' };

  const secrets = ['connectKey', 'connectId', 'appCode', 'key+id', 'id+key', 'userToken'];
  const fmts = ['hex', 'HEX', 'base64'];
  const algs = ['SHA1', 'SHA256'];
  const msgs = ['id+ts', 'ts+id', 'app+ts', 'ts+app', 'id+app+ts'];

  const tries = [];
  /* รอบแรก: เซ็น Time-Stamp เปล่า ๆ — เป็นไปได้มากที่สุด */
  for (const secret of secrets) for (const fmt of fmts) for (const alg of algs)
    tries.push({ secret, msg: 'ts', fmt, alg, style: 'B' });
  /* รอบสอง: ข้อความผสม เฉพาะกุญแจที่เป็นไปได้ */
  for (const secret of ['connectKey', 'connectId']) for (const msg of msgs) for (const fmt of fmts)
    tries.push({ secret, msg, fmt, alg: 'SHA1', style: 'B' });
  /* รอบสาม: โครงสร้าง body แบบอื่น */
  for (const style of ['D', 'F', 'E', 'A', 'G'])
    tries.push({ ...DEF_FORMULA, style });

  const tried = [];
  for (let i = 0; i < Math.min(tries.length, max); i++) {
    const f = tries[i];
    const label = `${f.secret} · ${f.msg} · ${f.fmt} · ${f.alg} · body ${f.style}`;
    let r;
    try { r = await askToken(c, f); }
    catch (e) { tried.push({ label, error: e.message }); continue; }

    if (r.ok) {
      await saveFormula(f);
      _tokens.set(c.biz, { value: r.token, exp: Date.now() + TOKEN_TTL, at: Date.now() });
      say('✅ เจอสูตรแล้ว: ' + label);
      return { ok: true, formula: f, label, tried: tried.length + 1,
               msg: `🎉 เจอสูตรลายเซ็นแล้ว — ${label}\nจำไว้ให้แล้ว ใช้ได้เลยทั้งระบบ` };
    }

    /* ‼ โดนจำกัดจำนวนครั้ง = หยุดทันที ยิงต่อไปก็โดนปฏิเสธหมด */
    if (r.status === 429 || /RATE_LIMITED|Too many requests/i.test(r.text)) {
      const wait = (r.text.match(/"retryAfterSeconds"\s*:\s*(\d+)/) || [])[1] || '60';
      return { ok: false, rateLimited: true, tried: tried.length + 1,
               error: `PEAK จำกัดจำนวนครั้งที่ขอกุญแจ — ลองไปแล้ว ${tried.length + 1} สูตร ` +
                      `ต้องรออีก ${wait} วินาทีถึงจะลองต่อได้\n` +
                      `กดปุ่มนี้ใหม่หลังครบเวลา ระบบจะลองสูตรที่เหลือต่อให้เอง` };
    }
    /* คำตอบที่ไม่ใช่ "ลายเซ็นไม่ผ่าน" = เบาะแสใหม่ ต้องเก็บไว้ให้คนอ่าน */
    if (!/TimeSignature\s*Unauthorized/i.test(r.desc))
      tried.push({ label, desc: r.desc.slice(0, 160) });
    await sleep(gapMs);
  }

  return { ok: false, tried: tried.length,
           error: 'ลองครบทุกสูตรแล้วยังไม่ผ่าน', clues: tried.slice(0, 8) };
}

/* ── กุญแจเข้าระบบ — แยกกล่องเก็บตามกิจการ อายุ 6 ชม. ─────────────
 * ของเดิมเคยเก็บ 23 ชม. แล้วเจอว่า PEAK ทำให้ token ตายก่อนหมดอายุได้ (v32.6) */
const _tokens = new Map();
const TOKEN_TTL = 6 * 60 * 60 * 1000;

function dig(o, keys, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 4) return null;
  for (const k of Object.keys(o)) {
    if (keys.some(w => w.toLowerCase() === k.toLowerCase())) {
      const v = o[k];
      if (v !== null && v !== undefined && typeof v !== 'object') return v;
    }
  }
  for (const k of Object.keys(o)) {
    if (o[k] && typeof o[k] === 'object') {
      const r = dig(o[k], keys, depth + 1);
      if (r !== null) return r;
    }
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════
 *  🔴 "ชื่อลูกค้า PEAK" — ยกตัวเลือกชื่อของแอปเก่ามาทั้งดุ้น (v17.49 · v18.3)
 *
 *  คำสั่งพี่เอ 12 ก.ย. 69 (คำต่อคำ):
 *    "จัด new agent มาแก้ เรื่อง sync กับ peak ให้จบด้วยนะ
 *     ไม่มีทางที่ peak จะไม่ส่งชื่อมาให้ ทำให้ถูกต้อง 100%"
 *
 *  ‼ พี่เอพูดถูก และของเดิม (Code.gs:9629 _peakPickName) พิสูจน์ไว้แล้ว 2 ข้อ:
 *
 *   ① ชื่อบนหัวบิลของ PEAK "ไม่ได้ชื่อ contactName" — มันชื่อ businessName
 *      (Code.gs:9621) ของเดิมเคยอ่านเรียง name → contactName → companyName
 *      แล้วได้ "ชวง" (ชื่อคน) มาแทน "เกียรติไพบูลย์บรรจุภัณฑ์" (ชื่อนิติบุคคล)
 *      ⇒ v17.49 สลับให้ชื่อนิติบุคคลมาก่อนเสมอ และเก็บชื่อผู้ติดต่อแยกช่อง
 *
 *   ② 🔴 ใบแจ้งหนี้ของบางกิจการ "ไม่มีชื่อลูกค้าบนหัวบิลเลย มีแต่รหัสลูกค้า"
 *      (Code.gs:9409) ⇒ ต้องไปเปิดทะเบียนลูกค้าด้วยรหัสนั้นต่อ (contactName())
 *      นี่คือเหตุผลที่ "PEAK ส่งชื่อมาเสมอ" จริงตามที่พี่เอบอก — แค่ส่งมาคนละที่
 *
 *  ‼ ห้ามใช้ dig() หาชื่อ — dig มุดลงไป 4 ชั้นแล้วคว้าค่าแรกที่ชื่อคีย์ตรง
 *    ในใบแจ้งหนี้มี "รายการสินค้า" ซ้อนอยู่ด้วย ซึ่งแต่ละบรรทัดมีคำว่า name
 *    ⇒ มีโอกาสได้ "ชื่อป้ายไวนิล" มานั่งในช่องชื่อลูกค้า (ของเดิมเจ็บมาแล้ว)
 *    ตัวอ่านข้างล่างจึงอ่าน "ชั้นเดียว" เท่านั้น + ชั้นย่อย contact ที่ระบุชื่อไว้
 * ═══════════════════════════════════════════════════════════════════ */
const PEAK_NAME = {
  /* ชื่อกิจการ/ชื่อบนหัวบิล — เรียงจาก "ชัดเจนที่สุด" ไป "คลุมเครือที่สุด"
   * ‼ ลำดับนี้ยกมาจาก Code.gs:9631 เป๊ะ ห้ามสลับ (v17.49 แก้มาแล้วรอบหนึ่ง) */
  BIZ: ['businessName', 'companyName', 'organizationName', 'corporateName',
        'contactBusinessName', 'customerBusinessName', 'contactName', 'customerName', 'name'],
  /* ชื่อผู้ติดต่อ — คนละเรื่องกับชื่อลูกค้า เก็บแยก ห้ามเอามาปน */
  PER: ['contactPerson', 'contactPersonName', 'personName', 'attention', 'attn'],
  /* รหัสลูกค้าบนหัวบิล — ใช้เป็นกุญแจไปเปิดทะเบียนลูกค้าต่อ */
  CODE: ['contactCode', 'customerCode', 'contactcode'],
  /* ชั้นย่อยที่ PEAK อาจห่อข้อมูลลูกค้าไว้ (คำตอบบางท่าเป็น { contact: {...} }) */
  SUB: ['contact', 'customer', 'contactInfo'],
};

/** หยิบค่าจาก object "ชั้นเดียว" เท่านั้น — ไม่มุดลึก ไม่คว้ามั่ว (Code.gs:9638 _peakFlat) */
function flat(obj, names) {
  if (!obj || typeof obj !== 'object') return { v: '', k: '' };
  const keys = Object.keys(obj);
  for (const want of names) {
    const w = String(want).toLowerCase();
    for (const k of keys) {
      if (String(k).toLowerCase() !== w) continue;
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return { v: v.trim(), k };
      /* PEAK ส่งรหัสลูกค้ามาเป็นตัวเลขล้วนก็มี — ถือว่าใช้ได้ */
      if (typeof v === 'number' && Number.isFinite(v)) return { v: String(v), k };
    }
  }
  return { v: '', k: '' };
}

/**
 * เลือก "ชื่อลูกค้าที่ใช้เปิดบิล" · "ชื่อผู้ติดต่อ" · "รหัสลูกค้า" จากเอกสาร/ทะเบียนของ PEAK
 * ‼ via = ชื่อฟิลด์ที่ได้ค่ามาจริง — เก็บไว้ให้ตรวจย้อนได้ ไม่ต้องเชื่อลอย ๆ
 * @return {{name:string, person:string, code:string, via:string}}
 */
function pickName(it) {
  if (!it || typeof it !== 'object') return { name: '', person: '', code: '', via: '' };

  const top = flat(it, PEAK_NAME.BIZ);
  let sub = { v: '', k: '' };
  for (const s of PEAK_NAME.SUB) {
    const box = it[s];
    if (!box || typeof box !== 'object' || Array.isArray(box)) continue;
    const hit = flat(box, PEAK_NAME.BIZ);
    if (hit.v) { sub = { v: hit.v, k: s + '.' + hit.k }; break; }
  }

  let per = flat(it, PEAK_NAME.PER);
  if (!per.v) {
    for (const s of PEAK_NAME.SUB) {
      const box = it[s];
      if (!box || typeof box !== 'object' || Array.isArray(box)) continue;
      const p2 = flat(box, PEAK_NAME.PER);
      if (p2.v) { per = { v: p2.v, k: s + '.' + p2.k }; break; }
    }
  }

  let code = flat(it, PEAK_NAME.CODE);
  if (!code.v) {
    for (const s of PEAK_NAME.SUB) {
      const box = it[s];
      if (!box || typeof box !== 'object' || Array.isArray(box)) continue;
      const c2 = flat(box, PEAK_NAME.CODE);
      if (c2.v) { code = { v: c2.v, k: s + '.' + c2.k }; break; }
    }
  }

  /* ชั้นบนสุดมาก่อน ถ้าไม่มีค่อยใช้ของในชั้นย่อย (Code.gs:9673) */
  const pick = top.v ? top : sub;
  return { name: pick.v, person: per.v, code: code.v, via: pick.k };
}

/* ═══════════════════════════════════════════════════════════════════
 *  🔴 ทะเบียนลูกค้าของ PEAK: รหัส → ชื่อ  (Code.gs:9678 _peakContactName
 *     + วิธีทำดัชนีของ v17.36 ซึ่งเป็นรุ่นที่ "ได้ชื่อครบทุกรายการ" จริง)
 *
 *  🔴 พี่เอถาม 12 ก.ย. 69 (คำต่อคำ):
 *    "มันเห็นรหัสลูกค้า แล้วทำไมไม่เอาชื่อมา
 *     แล้วทำไมรายการอื่นๆ มันถึงดึงชื่อมาได้ล่ะ"
 *
 *  ตอบ: รายการที่ได้ชื่อ คือใบที่ PEAK ใส่ชื่อมาบน "หัวบิล" เลย (ชั้น ①)
 *       ส่วนรายการที่ขึ้นแต่รหัส คือใบที่หัวบิลไม่มีชื่อ ต้องไปเปิด
 *       "ทะเบียนลูกค้า" ต่อ (ชั้น ②) — และชั้น ② นี่แหละที่กลับมามือเปล่า
 *
 *  ── ทำไมชั้น ② ถึงกลับมามือเปล่า ──────────────────────────────
 *  ข้อเท็จจริงที่แอปเก่ายืนยันไว้ตั้งแต่ v17.39 และจดไว้ที่ Code.gs:8524 :
 *
 *      "Contacts  ใส่แค่ limit/page ก็คืนข้อมูล 2,000 ราย
 *       Invoices / Quotations / Expenses  ใส่แค่ limit -> คืน 0 ใบ"
 *
 *  แปลว่า endpoint Contacts ของ PEAK "ไม่ได้บังคับให้มีตัวกรอง" และ
 *  Code.gs:9685 เตือนไว้ตรง ๆ ว่า "ถ้า PEAK เพิกเฉยตัวกรอง code" จะได้
 *  รายชื่อคนอื่นกลับมา ⇒ ถาม Contacts?code=C04693&limit=5 แล้วได้
 *  ลูกค้า 5 รายแรกของทะเบียนกลับมาแทน · ด่านตรวจรหัสของเรา (ถูกต้องแล้ว)
 *  ปฏิเสธทั้ง 5 ราย ⇒ ชื่อว่าง ⇒ ขึ้นป้าย "ยังไม่ได้ชื่อ · รหัส C04693"
 *
 *  ‼ และนี่คือเหตุผลที่แอปเก่าเลิกถามทีละใบไปตั้งแต่ v17.36 :
 *    "วิธีเดิมถาม PEAK ทีละใบงาน ... ช่อง ชื่อลูกค้า PEAK จึงว่างเป็นขีดตลอด
 *     ของใหม่ดึงรายชื่อลูกค้าจาก PEAK มาทั้งชุดครั้งเดียว เก็บเป็นดัชนีไว้
 *     แล้วจับคู่ในเครื่อง เร็วกว่าหลายสิบเท่า"   (Index.html:14791)
 *
 *  ── วิธีใหม่ 3 จังหวะ ─────────────────────────────────────────
 *   ① ทางถูก  : ถาม Contacts?code=… ก่อนเสมอ (1 คำขอ) เผื่อ PEAK กรองให้จริง
 *   ② จับโกหก : ถ้าคำตอบ "ไม่มีรหัสที่ถามอยู่ในนั้นเลย" = ตัวกรองถูกเมิน
 *               ‼ รู้ได้จากคำตอบจริง ไม่ใช่เดา — แล้วจำไว้ทั้งกิจการ
 *               ใบถัด ๆ ไปจะไม่เสียคำขอกับทางที่พิสูจน์แล้วว่าไม่ได้ผล
 *   ③ ทางชัวร์ : ไล่อ่านทะเบียนทั้งชุดแบบแบ่งหน้า (contacts/list) ครั้งเดียว
 *               ทำเป็นดัชนี รหัส → ชื่อ เก็บไว้ แล้วจับคู่ในเครื่องตลอดกาล
 *
 *  🔒 ทุกจังหวะเป็น GET ล้วน · ใช้ endpoint ที่อยู่ในด่าน ALLOW เดิมทั้งคู่
 *     ('contacts' กับ 'contacts/list' มีมาตั้งแต่ต้น) · ไม่ขอกุญแจใหม่จาก PEAK
 *
 *  ‼ กฎเหล็กที่ห้ามผ่อนเด็ดขาด: "รหัสต้องตรงเป๊ะ" เท่านั้นถึงจะรับชื่อ
 *    ชื่อลูกค้าผิดคนบนหน้าจอบัญชี ร้ายกว่าช่องว่างหลายเท่า
 *    (ของเดิมก่อน v17.49 หยิบ arr[0] มาใช้ — เกือบเขียนชื่อผิดทั้งแถบ)
 *
 *  ‼ 3 สถานะที่ห้ามยุบรวมกันเด็ดขาด (ต้นเหตุที่พี่เอโกรธตั้งแต่แรกคือ
 *    "ข้อความที่โกหก") — ทุกทางออกของไฟล์นี้ต้องบอกได้ว่าเป็นอันไหน:
 *      hit    = ได้ชื่อมาแล้ว
 *      absent = ถามสำเร็จ แต่ทะเบียนของ PEAK ไม่มีรหัสนี้จริง ๆ
 *      error  = ยังถามไม่สำเร็จ (คนละเรื่องกับ "ไม่มี") ‼ ห้ามแคช
 * ═══════════════════════════════════════════════════════════════════ */

/* อายุของคำตอบที่จำไว้ · เพดานกันหน่วยความจำบวม */
const CONTACT_TTL = 6 * 60 * 60 * 1000;
const CONTACT_MAX = 5000;
const _contactMem = new Map();          /* รหัส → คำตอบ (เก็บเฉพาะ hit/absent) */

/* ── ดัชนีทะเบียนลูกค้าทั้งชุด แยกตามกิจการ ──────────────────────
 *
 *  🔴 พี่เอสั่ง 12 ก.ย. 69 (คำต่อคำ) หลังเห็นว่าหนูใส่เพดานไว้:
 *        "ต้องไม่มีเพดานสิ ขายของเพิ่มขึ้นทุกวัน"
 *
 *  ‼ พี่เอพูดถูก และเพดานแบบเดิมคือ "บั๊กที่ตั้งเวลาไว้":
 *    วันไหนลูกค้าเกิน 8,000 ราย ลูกค้าที่อยู่หลังเส้นตัดจะขึ้นว่า
 *    "🔎 ไม่มีรหัสนี้ในทะเบียนลูกค้า PEAK" — ประโยคที่ฟังดูมั่นใจ แต่ผิด
 *    ซึ่งเป็นความผิดพลาดประเภทเดียวกับที่งานทั้งก้อนนี้ตั้งขึ้นมาเพื่อกำจัด
 *
 *  ‼ กติกาใหม่: "ไล่หน้าจนกว่า PEAK จะบอกว่าหมดแล้ว" — ข้อมูลเป็นคนตัดสิน
 *    ไม่ใช่ค่าคงที่ในโค้ด · หยุดเมื่อหน้าว่าง หรือหน้าที่ได้สั้นกว่าหน้าเต็ม
 *
 *  ‼ ขนาดหน้าเต็ม "เรียนรู้จากหน้าแรก" ไม่ใช่เชื่อค่าที่เราขอไป
 *    ถ้าเราขอ 500 แล้ว PEAK ให้มาแค่ 100 (เพราะเขาจำกัดเอง) การเทียบกับ 500
 *    จะแปลว่า "หน้าสั้น = หน้าสุดท้าย" ตั้งแต่หน้าแรก ⇒ ตัดข้อมูลทิ้งเงียบ ๆ
 *    ⇒ ต้องยึดขนาดของหน้าแรกเป็นตัววัด "หน้าเต็ม" เสมอ
 *
 *  ‼ REG_GUARD_PAGES ไม่ใช่เพดานข้อมูล — เป็นกันวนไม่รู้จบเฉย ๆ
 *    ตั้งไว้ใหญ่เกินความเป็นจริงหลายเท่า (5,000 หน้า × 500 = 2.5 ล้านราย)
 *    และ 🔴 ถ้าชนเมื่อไหร่ ต้อง "ดัง" — ดัชนีถูกตีตราว่าไม่ครบ แล้วทุกคำตอบ
 *    ที่ควรจะเป็น "ไม่มีในทะเบียน" ต้องเปลี่ยนเป็น "โหลดมาไม่ครบ" แทน
 *    ห้ามให้ดัชนีที่ไม่ครบ ตอบปฏิเสธอย่างมั่นใจเด็ดขาด
 * ── */
const REG_TTL = 6 * 60 * 60 * 1000;        /* โหลดครบแล้ว — ใช้ได้ 6 ชั่วโมง */
const REG_TTL_PARTIAL = 30 * 60 * 1000;    /* โหลดไม่ครบ — ลองใหม่เร็วกว่า */
/* ‼ ขอหน้าใหญ่ไว้ก่อน (คำขอน้อยลงเมื่อลูกค้าเยอะขึ้น) — ถ้า PEAK ไม่รับ
 *   ค่อยถอยไปใช้ขนาดที่ระบบนี้ใช้กับ contacts/list อยู่แล้ว
 *   ‼ ไม่ได้ "เดาว่า 500 ใช้ได้" — ถ้าหน้าแรกพัง จะถอยเองอัตโนมัติ */
const REG_PAGE_TRY = [500, 100];
const REG_GUARD_PAGES = 5000;              /* กันวนไม่รู้จบ ‼ ไม่ใช่เพดานข้อมูล */
const REG_FAIL_COOLDOWN = 60 * 1000;       /* สร้างไม่สำเร็จ พักก่อนลองใหม่ */
const REG_BUDGET_WAITS = 5;                /* รอโควตา PEAK คลายได้กี่รอบ */
const _registry = new Map();            /* กิจการ → { exp, byCode, bySquash, rows, complete } */
const _registryJob = new Map();         /* กิจการ → Promise ที่กำลังสร้างดัชนีอยู่ */
const _registryFail = new Map();        /* กิจการ → { until, err } กันยิงรัวตอนพัง */
const _filterIgnored = new Map();       /* กิจการ → true เมื่อพิสูจน์แล้วว่า code= ถูกเมิน */

/** ล้างของที่จำไว้ทั้งหมด — ใช้ในเทสต์ และเวลาต้องการบังคับให้ถามใหม่ */
function contactCacheClear() {
  _contactMem.clear();
  _registry.clear();
  _registryJob.clear();
  _registryFail.clear();
  _filterIgnored.clear();
}

/* ‼ กุญแจเทียบรหัส — ตัดช่องว่าง + ตัวพิมพ์ใหญ่เล็ก เท่านั้น
 *   ยังเป็น "รหัสตรงเป๊ะ" อยู่ ไม่ได้เทียบชื่อแบบหลวม ๆ */
const codeKey = s => clean(s).toUpperCase();
/* ‼ กุญแจสำรอง — ตัดขีด/จุด/ช่องว่างออก เผื่อ "C-04693" กับ "C04693"
 *   เป็นรหัสเดียวกันคนละรูปแบบ · ใช้ได้เฉพาะเมื่อ "ไม่ซ้ำกับใครในทะเบียน"
 *   ถ้าซ้ำเมื่อไหร่ = ทิ้งทั้งคู่ ห้ามเดา (ดู buildIndex ข้างล่าง) */
const codeSquash = s => codeKey(s).replace(/[^A-Z0-9]/g, '');

/** อ่านรหัสลูกค้าออกจากแถวทะเบียน — ชั้นเดียว ไม่มุดลึก */
const rowCode = r => flat(r, ['code', 'contactCode', 'customerCode', 'contactcode']).v;

/** โควตา 300 คำขอ/นาทีของเราเองเต็มหรือเปล่า (ข้อความจาก get()) */
const isBudgetErr = e => /เกิน \d+ คำขอในหนึ่งนาที/.test(String(e && e.message ? e.message : e));

/* ── สร้างดัชนีทะเบียนลูกค้าทั้งชุด (1 ครั้งต่อกิจการต่อ TTL) ────
 *
 *  ‼ ยิงพร้อมกันหลายใบต้องสร้างแค่ครั้งเดียว (single-flight)
 *    ซิงก์ 278 แถวพร้อมกันแล้วต่างคนต่างสร้างดัชนี = ยิง PEAK ถล่มทันที
 *    ⇒ ใครมาทีหลังให้รอ Promise ตัวเดียวกัน
 *
 *  ‼ สร้างไม่สำเร็จ ห้ามแคชเป็นดัชนี — แต่ต้องพักสักครู่ก่อนลองใหม่
 *    ไม่งั้นซิงก์ 278 ใบจะไล่สร้างดัชนีใหม่ทุกใบตอนที่ PEAK ล่มพอดี
 */
/* @param {{guardPages?:number}} [opt]  ‼ guardPages มีไว้ให้เทสต์พิสูจน์พฤติกรรม
 *   "ชนด่านกันวนไม่รู้จบ" ได้โดยไม่ต้องหลอกโหลดลูกค้า 2.5 ล้านรายจริง ๆ
 *   โค้ดที่ใช้งานจริงไม่เคยส่งค่านี้ — ใช้ REG_GUARD_PAGES เสมอ */
async function buildContactIndex(biz, opt) {
  const key = String(biz || '');
  const guard = Math.max(1, Number((opt && opt.guardPages) || REG_GUARD_PAGES));
  const live = _registry.get(key);
  if (live && Date.now() < live.exp) return live;

  const busy = _registryJob.get(key);
  if (busy) return busy;

  const bad = _registryFail.get(key);
  if (bad && Date.now() < bad.until) throw new Error(bad.err);

  const job = (async () => {
    const byCode = new Map();
    const squashSeen = new Map();       /* กุญแจสำรอง → ค่า | null (null = ซ้ำ ห้ามใช้) */
    let rows = 0, pages = 0, waits = 0;
    let full = 0;                       /* ขนาด "หน้าเต็ม" ที่เรียนรู้จากหน้าแรก */
    let want = REG_PAGE_TRY[0];
    let complete = false, why = '';

    for (let page = 1; page <= guard; page++) {
      let arr;
      try {
        arr = listOf(await get('contacts/list', { page, limit: want }, biz));
      } catch (e) {
        /* ① โควตาของเราเองเต็ม — รอให้คลายแล้วขอหน้าเดิมต่อ
         *    ‼ ทะเบียนใหญ่ขึ้นเรื่อย ๆ ตามที่พี่เอบอก การยอมรอดีกว่าตัดข้อมูลทิ้ง */
        if (isBudgetErr(e) && waits < REG_BUDGET_WAITS) {
          waits++; await sleep(61000); page--; continue;
        }
        /* ② หน้าแรกพังเพราะขอหน้าใหญ่เกินไป — ถอยไปขนาดที่ระบบนี้ใช้อยู่แล้ว */
        if (page === 1 && want !== REG_PAGE_TRY[1]) {
          want = REG_PAGE_TRY[1]; page--; continue;
        }
        throw e;
      }
      pages++;
      if (!arr.length) { complete = true; why = 'หน้าว่าง = หมดแล้ว'; break; }
      if (!full) full = arr.length;      /* ‼ เรียนรู้ขนาดหน้าเต็มจากหน้าแรก */

      let fresh = 0;
      for (const r of arr) {
        const raw = rowCode(r);
        if (!raw) continue;             /* ไม่มีรหัส = จับคู่ไม่ได้ ข้ามไป */
        const ck = codeKey(raw);
        if (!byCode.has(ck)) fresh++;
        const n = pickName(r);
        if (!n.name) continue;          /* ไม่มีชื่อ = ไม่มีอะไรให้ใช้ */
        const rec = { name: n.name, person: n.person, code: clean(raw), via: n.via };
        if (!byCode.has(ck)) byCode.set(ck, rec);
        const sq = codeSquash(raw);
        if (sq && sq !== ck) {
          /* ‼ กุญแจสำรองต้องไม่ซ้ำกับใคร ไม่งั้นเสี่ยงหยิบชื่อผิดคน */
          squashSeen.set(sq, squashSeen.has(sq) ? null : rec);
        }
        rows++;
      }

      /* ‼ หน้าสั้นกว่าหน้าเต็ม = หน้าสุดท้ายจริง ๆ (ข้อมูลเป็นคนบอก) */
      if (arr.length < full) { complete = true; why = 'หน้าสุดท้ายสั้นกว่าหน้าเต็ม'; break; }

      /* 🔴 หน้าเต็มแต่ไม่มีรหัสใหม่เลยสักตัว = PEAK ไม่ขยับหน้าให้เรา
       *   (เมินพารามิเตอร์ page) ⇒ ไล่ต่อไปก็ได้ของเดิม ต้องหยุด
       *   ‼ และต้องตีตราว่า "ไม่ครบ" ห้ามถือว่าจบสวย */
      if (fresh === 0) { why = 'PEAK คืนหน้าเดิมซ้ำ (ไม่ขยับหน้าให้)'; break; }
    }

    if (!complete && !why) why = `ชนด่านกันวนไม่รู้จบที่ ${guard} หน้า`;

    const bySquash = new Map();
    for (const [k2, v] of squashSeen) if (v && !byCode.has(k2)) bySquash.set(k2, v);

    const idx = { exp: Date.now() + (complete ? REG_TTL : REG_TTL_PARTIAL),
                  byCode, bySquash, rows, pages, complete, why,
                  at: new Date().toISOString() };
    _registry.set(key, idx);
    _registryFail.delete(key);
    return idx;
  })();

  _registryJob.set(key, job);
  try { return await job; }
  catch (e) {
    /* ‼ พักก่อนลองใหม่ — กันซิงก์ทั้งชุดไล่สร้างดัชนีใหม่ทุกใบตอน PEAK ล่ม
     *   ‼ ยังเป็นสถานะ "ถามไม่สำเร็จ" อยู่ ไม่ใช่ "ไม่มีในทะเบียน" */
    _registryFail.set(key, { until: Date.now() + REG_FAIL_COOLDOWN,
                             err: String(e && e.message ? e.message : e) });
    throw e;
  }
  finally { _registryJob.delete(key); }   /* ‼ ล้มแล้วต้องไม่ค้างเป็น Promise พัง */
}

/** ดัชนีของกิจการนี้มีอะไรอยู่บ้าง — ไว้ตอบหน้าจอ/เทสต์ ‼ ไม่เปิดเผยข้อมูลลูกค้า */
function contactIndexStats(biz) {
  const i = _registry.get(String(biz || ''));
  if (!i) return { built: false, complete: false, rows: 0, pages: 0, at: '', why: '' };
  return { built: true, complete: !!i.complete, rows: i.rows, pages: i.pages,
           at: i.at, why: i.why || '',
           filterIgnored: !!_filterIgnored.get(String(biz || '')) };
}

/**
 * ชื่อลูกค้าจากทะเบียนของ PEAK ตามรหัสลูกค้า
 * @return {{ok:boolean, state:'hit'|'absent'|'error', name:string, person:string,
 *           code:string, via:string, err:string, source:string}}
 *   ‼ state คือหัวใจ — 'absent' (ถามแล้วไม่มี) กับ 'error' (ยังถามไม่สำเร็จ)
 *     เป็นคนละเรื่องกันโดยสิ้นเชิง ห้ามยุบรวมกันที่ชั้นไหนก็ตาม
 */
async function contactName(code, biz) {
  const k = clean(code);
  if (!k) return { ok: true, state: 'absent', name: '', person: '', code: '',
                   via: '', err: '', source: '' };

  const bizKey = String(biz || '');
  const memKey = bizKey + '|' + codeKey(k);
  const memo = _contactMem.get(memKey);
  if (memo && Date.now() < memo.exp) return { ...memo.val };

  const want = codeKey(k);
  const mk = (rec, source) => ({
    ok: true, state: 'hit', name: rec.name, person: rec.person || '',
    code: k, via: source + ' · ' + (rec.via || '?'), err: '', source,
  });
  const remember = val => {
    if (_contactMem.size >= CONTACT_MAX) _contactMem.clear();
    _contactMem.set(memKey, { exp: Date.now() + CONTACT_TTL, val });
    return { ...val };
  };

  /* ── ① ทางถูก: ถามตรงด้วยรหัส (ข้ามไปเลยถ้าพิสูจน์แล้วว่าตัวกรองถูกเมิน) ── */
  if (!_filterIgnored.get(bizKey)) {
    let arr = null;
    try { arr = listOf(await get('Contacts', { code: k, limit: 5 }, biz)); }
    catch (e) {
      /* ‼ ถามไม่สำเร็จ ≠ ไม่มีรหัสนี้ — ห้ามแคช ห้ามกลบ */
      return { ok: false, state: 'error', name: '', person: '', code: k, via: '',
               err: String(e && e.message ? e.message : e).slice(0, 180), source: 'Contacts?code=' };
    }
    for (const r of arr || []) {
      if (codeKey(rowCode(r)) !== want) continue;
      const n = pickName(r);
      if (n.name) return remember(mk({ name: n.name, person: n.person, via: n.via },
                                     'Contacts?code=' + k));
    }
    /* ‼ จับโกหกตรงนี้ — มีแถวกลับมา แต่ไม่มีรหัสที่ถามอยู่ในนั้นเลย
     *   = PEAK เมินตัวกรอง code (ข้อเท็จจริง ไม่ใช่การเดา)
     *   จำไว้ทั้งกิจการ ใบถัด ๆ ไปจะได้ไม่เสียคำขอกับทางนี้อีก */
    if ((arr || []).length) _filterIgnored.set(bizKey, true);
  }

  /* ── ③ ทางชัวร์: จับคู่กับดัชนีทะเบียนทั้งชุด ─────────────────── */
  let idx;
  try { idx = await buildContactIndex(biz); }
  catch (e) {
    return { ok: false, state: 'error', name: '', person: '', code: k, via: '',
             err: String(e && e.message ? e.message : e).slice(0, 180),
             source: 'contacts/list' };
  }

  /* เจอในดัชนี = คำตอบเด็ดขาด ไม่ว่าดัชนีจะโหลดครบหรือไม่ครบก็ตาม */
  const rec = idx.byCode.get(want) || idx.bySquash.get(codeSquash(k));
  if (rec) return remember(mk(rec, 'ดัชนีทะเบียนลูกค้า (contacts/list)'));

  /* ═══════════════════════════════════════════════════════════════
   *  🔴 ดัชนีโหลดมาไม่ครบ → ห้ามตอบว่า "ไม่มีในทะเบียน" เด็ดขาด
   *
   *  พี่เอสั่ง 12 ก.ย. 69: "ต้องไม่มีเพดานสิ ขายของเพิ่มขึ้นทุกวัน"
   *  เพดานถูกถอดออกแล้ว เหลือแค่ด่านกันวนไม่รู้จบซึ่งใหญ่เกินจริงหลายเท่า
   *  แต่ถ้าวันไหนชนขึ้นมาจริง ๆ (หรือ PEAK ไม่ยอมขยับหน้าให้) สิ่งที่ห้ามที่สุด
   *  คือเอาดัชนีที่ไม่ครบไปตอบปฏิเสธอย่างมั่นใจ
   *  — ลูกค้ามีตัวตนอยู่จริง แต่หน้าจอบอกว่าไม่มี
   *  ⇒ ตอบว่า "โหลดมาไม่ครบ" พร้อมจำนวนที่โหลดมาได้ · และ ‼ ห้ามแคชคำตอบนี้
   *    เพราะมันไม่ใช่คำตอบ เป็นแค่รายงานว่าเรายังไม่รู้
   * ═══════════════════════════════════════════════════════════════ */
  if (!idx.complete)
    return { ok: true, state: 'partial', name: '', person: '', code: k, via: '',
             err: `ทะเบียนลูกค้าโหลดมาไม่ครบ — ได้มา ${idx.rows} ราย ` +
                  `จาก ${idx.pages} หน้า (${idx.why})`,
             rows: idx.rows, pages: idx.pages,
             source: 'ดัชนีทะเบียนลูกค้า (contacts/list)' };

  /* ‼ ถามสำเร็จแล้วจริง ๆ ดัชนีก็โหลดครบแล้ว แต่ทะเบียนของ PEAK ไม่มีรหัสนี้
   *   คนละเรื่องกับ "ถามไม่สำเร็จ" — จำไว้ได้ เพราะเป็นคำตอบจริง */
  return remember({ ok: true, state: 'absent', name: '', person: '', code: k,
                    via: '', err: '', rows: idx.rows,
                    source: 'ดัชนีทะเบียนลูกค้า (contacts/list)' });
}

/* ‼ กันโดนจำกัดจำนวนครั้ง (429 ClientTokenLimit · รอ 60 วินาที)
 *   PEAK จำกัดการขอกุญแจไว้ ถ้ายิงรัวจะโดนบล็อกทั้งชั่วโมง
 *   จำเวลาที่ขอครั้งล่าสุดไว้ ห้ามขอถี่กว่านี้ */
const CT_GAP_MS = 65000;
const _lastAsk = new Map();
/* ‼ 🔴 คำขอกุญแจที่ "กำลังบินอยู่" ของแต่ละกิจการ — single-flight
 *
 *  บั๊กจริงที่เจอตอนทำดัชนีทะเบียนลูกค้า 12 ก.ย. 69:
 *    ยิงคำขอพร้อมกันหลายใบตอนที่ยังไม่มีกุญแจในมือ ⇒ ใบแรกตั้ง _lastAsk
 *    แล้วไปรอคำตอบ · ใบที่ 2-50 มาถึงตอนกุญแจยังไม่กลับ เห็นว่า "ยังไม่ถึงเวลา
 *    ขอใหม่" และ "ยังไม่มีกุญแจเก่าให้ใช้" ⇒ โยน "PEAK จำกัดการขอกุญแจ
 *    รออีก 65 วินาที" ทั้ง 49 ใบ ทั้งที่ PEAK ยังไม่ได้ปฏิเสธอะไรเลยสักคำ
 *
 *  ‼ คำตอบที่ถูกคือ "ไปรอคำขอใบเดียวกันนั้น" ไม่ใช่ต่างคนต่างโยน error
 *    วิธีนี้ยังกันการยิงถล่มได้เหมือนเดิม (ดีกว่าเดิมด้วย — ขอครั้งเดียวจริง ๆ)
 *    และไม่ได้เพิ่มคำขอออกไปหา PEAK แม้แต่ครั้งเดียว */
const _tokenJob = new Map();

/** กุญแจของกิจการนี้ "ขอมาเมื่อกี่มิลลิวินาทีที่แล้ว" (Infinity = ไม่มีในมือ)
 *  ‼ ใช้ตอบคำถามเดียว: การขอใบใหม่ตอนนี้มีประโยชน์ไหม
 *  🔒 ไม่เคยคืนตัวกุญแจออกไป คืนแค่ "อายุ" เป็นตัวเลข */
function tokenAgeMs(biz) {
  const hit = _tokens.get(cfgOf(biz).biz);
  if (!hit || !hit.value) return Infinity;
  const born = Number(hit.at || (hit.exp - TOKEN_TTL));
  return Math.max(0, Date.now() - born);
}

/* ═══════════════════════════════════════════════════════════════════
 *  🔴🔴 บั๊กจริงที่พี่เอเจอ 15 ก.ย. 69 — "ขอกุญแจใหม่แล้วยังไม่ผ่าน" เป็นคำโกหก
 *
 *  อาการ: กล่อง "จาก PO ของ PEAK" กิจการ The 101 ขึ้นแถบแดง
 *    ❌ PEAK ปฏิเสธกุญแจเข้าระบบของกิจการ "The 101" (Invalid Client Token)
 *       — ขอกุญแจใหม่แล้วยังไม่ผ่าน
 *
 *  ‼ ความจริงคือ **ไม่เคยขอกุญแจใหม่เลยสักครั้ง** เส้นทางเป็นแบบนี้เป๊ะ ๆ:
 *    ① get() ไม่มีกุญแจในมือ → clientToken(biz,false) → ขอจาก PEAK สำเร็จ
 *       ⇒ ตั้ง _lastAsk = เวลานี้ · เก็บกุญแจลง _tokens
 *    ② ยิง GET ด้วยกุญแจใบนั้น → PEAK ตอบ 200 แต่ข้างในเขียน Invalid Client Token
 *    ③ get() เห็น authBad → clientToken(biz, **true**) = "ขอใบใหม่"
 *    ④ ‼ askTokenOnce_ เช็คก่อนว่า "เพิ่งขอไปเมื่อกี้ ยังไม่ถึง 65 วินาที"
 *       แล้วบรรทัด `if (hit && hit.value) return hit.value;` **คืนกุญแจใบเดิม**
 *       ที่ PEAK เพิ่งปฏิเสธไปหมาด ๆ กลับมาให้ โดยไม่ยิงหา PEAK เลย
 *    ⑤ get() ยิงซ้ำด้วยกุญแจใบเดิม → โดนปฏิเสธเหมือนเดิม → โยนข้อความข้างบน
 *
 *  ⇒ ทุกครั้งที่ความล้มเหลวเกิดขึ้น "ภายใน 65 วินาทีหลังได้กุญแจมา"
 *    (ซึ่งคือทุกครั้งที่เปิดกล่องแล้วกดดึง เพราะสองจังหวะนี้ห่างกันไม่ถึงวินาที)
 *    การ "ขอใหม่" จะเป็นการหลอกตัวเอง 100% — และข้อความบนจอก็หลอกพี่เอต่อ
 *    ว่ากุญแจตายแล้ว ทั้งที่ระบบยังไม่เคยลองขอใบใหม่ด้วยซ้ำ
 *
 *  🔴 ทางแก้ 2 ข้อ — และ **ไม่เพิ่มคำขอไปหา PEAK แม้แต่คำขอเดียว**
 *   ① force = PEAK เพิ่งปฏิเสธใบนี้ ⇒ ทิ้งใบนั้นจาก _tokens ทันที
 *      และห้ามส่งมันเข้า askTokenOnce_ เป็น "กุญแจเก่าที่ยังใช้ได้" อีก
 *      (กุญแจที่โดนปฏิเสธไม่ใช่ "ของเก่าที่ยังดีกว่าไม่มี" — มันคือของเสีย)
 *   ② ถ้าติดกติกา 65 วินาทีจนขอใหม่ไม่ได้จริง ๆ ⇒ **พูดตรง ๆ ว่ายังไม่ได้ขอ**
 *      พร้อมบอกว่าอีกกี่วินาทีถึงขอได้ ไม่ใช่รายงานว่า "ขอแล้วไม่ผ่าน"
 *
 *  ‼ ห้ามแก้ด้วยการลดค่า CT_GAP_MS หรือข้ามด่านนี้เด็ดขาด — 60 วินาทีเป็น
 *    กติกาของ PEAK (429 ClientTokenLimit) ไม่ใช่ของเรา ยิงถี่กว่านี้โดนบล็อกยาว
 * ═══════════════════════════════════════════════════════════════════ */
async function clientToken(biz, force) {
  const c = cfgOf(biz);
  if (!isConfigured(c.biz))
    throw new Error(`ยังไม่ได้ตั้งค่า PEAK ของกิจการ "${c.biz}"`);

  const hit = _tokens.get(c.biz);
  if (!force && hit && Date.now() < hit.exp) return hit.value;

  /* 🔴 ① กุญแจใบที่ PEAK เพิ่งปฏิเสธ = ของเสีย ทิ้งทันที ห้ามเสิร์ฟซ้ำ */
  if (force && hit) _tokens.delete(c.biz);

  /* ‼ มีคนกำลังขอกุญแจของกิจการนี้อยู่แล้ว → ไปรอใบเดียวกัน ห้ามขอซ้อน */
  const busy = _tokenJob.get(c.biz);
  if (busy) return busy;

  const job = askTokenOnce_(c, force ? null : hit, !!force);
  _tokenJob.set(c.biz, job);
  try { return await job; }
  finally { _tokenJob.delete(c.biz); }
}

async function askTokenOnce_(c, hit, force) {
  /* ยังไม่ถึงเวลาขอใหม่ แต่มีกุญแจเก่าอยู่ → ใช้ของเก่าไปก่อน ดีกว่าโดนบล็อก
   * 🔴 ยกเว้นตอน force — ตอนนั้น hit ถูกตั้งเป็น null มาแล้วจาก clientToken()
   *   เพราะกุญแจใบนั้นคือใบที่ PEAK เพิ่งปฏิเสธ */
  const last = _lastAsk.get(c.biz) || 0;
  const wait = CT_GAP_MS - (Date.now() - last);
  if (wait > 0) {
    if (hit && hit.value) return hit.value;
    /* 🔴 ② พูดความจริง: "ยังไม่ได้ขอใบใหม่" ≠ "ขอแล้วไม่ผ่าน" */
    if (force)
      throw new Error(
        `PEAK ปฏิเสธกุญแจของกิจการ "${c.biz}" และ**ยังขอใบใหม่ไม่ได้ในตอนนี้** — ` +
        `PEAK ให้ขอกุญแจได้ 1 ครั้งต่อ ${Math.round(CT_GAP_MS / 1000)} วินาที ` +
        `เหลืออีก ${Math.ceil(wait / 1000)} วินาที\n` +
        '▸ รอครบเวลาแล้วกดใหม่อีกครั้ง — รอบนั้นระบบจะขอกุญแจใบใหม่จริง ๆ ' +
        'ถ้ายังไม่ผ่านอีก แปลว่าค่าเชื่อมต่อของกิจการนี้ใช้ไม่ได้แล้วจริง\n' +
        'ค่าที่ใช้อยู่: ' + credLine(c.biz));
    throw new Error(`PEAK จำกัดการขอกุญแจ — รออีก ${Math.ceil(wait / 1000)} วินาที ` +
                    'แล้วลองใหม่ (นี่คือกติกาของ PEAK ไม่ใช่ของเรา)');
  }
  _lastAsk.set(c.biz, Date.now());

  const f = await loadFormula();
  const r = await askToken(c, f);

  if (r.ok) {
    _tokens.set(c.biz, { value: r.token, exp: Date.now() + TOKEN_TTL, at: Date.now() });
    return r.token;
  }

  if (r.status === 429 || /RATE_LIMITED|Too many requests/i.test(r.text)) {
    const s = (r.text.match(/"retryAfterSeconds"\s*:\s*(\d+)/) || [])[1] || '60';
    throw new Error(`PEAK จำกัดจำนวนครั้งที่ขอกุญแจ — รออีก ${s} วินาทีแล้วลองใหม่`);
  }

  /* ‼ ลายเซ็นไม่ผ่าน = สูตรที่จำไว้ใช้ไม่ได้แล้ว (หรือยังไม่เคยค้น)
   *   บอกให้ตรงจุดว่าต้องกดปุ่มไหน อย่าปล่อยให้ไปเดาเอง */
  if (/TimeSignature\s*Unauthorized/i.test(r.desc))
    throw new Error(
      'PEAK ปฏิเสธลายเซ็นเวลา (TimeSignature Unauthorized)\n\n' +
      'สูตรลายเซ็นของ PEAK ไม่มีในเอกสาร ต้องค้นหาก่อนใช้ครั้งแรก\n' +
      '▸ กดปุ่ม "🔑 ค้นหาสูตรลายเซ็น" ที่การ์ดของกิจการนี้ — ระบบจะไล่ลองให้เอง ' +
      'แล้วจำไว้ใช้ตลอด ไม่ต้องทำอีก');

  throw new Error(`ขอกุญแจ PEAK ไม่สำเร็จ (HTTP ${r.status}): ${String(r.desc).slice(0, 250)}`);
}

function resInfo(j) {
  return {
    code: clean(dig(j, ['resCode', 'responseCode', 'resultCode', 'statusCode'])),
    desc: clean(dig(j, ['resDesc', 'responseDesc', 'resultDesc', 'message', 'errorMessage'])),
  };
}
function authBad(j) {
  const r = resInfo(j);
  if (/invalid\s*client\s*token|invalid\s*token|token\s*expired|unauthor/i.test(r.desc)) return true;
  return ['600', '601', '401', '403'].includes(r.code);
}
function resBad(j) {
  const r = resInfo(j);
  if (!r.desc) return '';
  /* ‼ ใช้ "รายการคำที่แปลว่าพัง" ไม่ใช่ "อะไรที่ไม่ใช่ success ถือว่าพัง"
   *   PEAK ตอบ resDesc ว่า Success/OK/ว่าง ในกรณีปกติ ซึ่งไม่เหมือนกันทุกครั้ง */
  if (/invalid|error|fail|denied|not allow|expired|unauthor|forbidden|exceed/i.test(r.desc))
    return `PEAK ตอบว่า "${r.desc}"${r.code ? ' (code ' + r.code + ')' : ''}`;
  return '';
}

/* ── แกะรายการออกจากตัวห่อ 2 ชั้น ─────────────────────────────── */
const WANT = new Set(['receipts', 'invoices', 'data', 'items', 'result',
                      'results', 'list', 'records', 'contacts', 'quotations',
                      /* ‼ ชื่อกล่องของใบสั่งซื้อ — ใส่ไว้ให้ตรงชื่อ ไม่ต้องพึ่ง
                       *   ทางสำรอง "อาเรย์ตัวแรกที่เจอ" ซึ่งหยิบผิดกล่องได้ */
                      'purchaseorders', 'purchaseorder']);
function listOf(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 3) return [];
  if (Array.isArray(data)) return data;
  for (const k of Object.keys(data))
    if (Array.isArray(data[k]) && WANT.has(k.toLowerCase())) return data[k];
  for (const k of Object.keys(data)) {
    if (data[k] && typeof data[k] === 'object') {
      const r = listOf(data[k], depth + 1);
      if (r.length) return r;
    }
  }
  for (const k of Object.keys(data))
    if (Array.isArray(data[k]) && data[k].length) return data[k];
  return [];
}

/** PEAK ส่งวันที่มาเป็นข้อความ "20251128" */
function ymd(v) {
  const t = clean(v);
  let m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/* ── ตัวนับคำขอ กันยิงถล่ม PEAK (v17.23.8) ───────────────────────
 *  ของเดิมเคยยิง 120 คำขอรวดจนแอปค้างทั้งระบบ */
const BUDGET = { calls: 0, until: 0 };
const MAX_CALLS = 300;

/**
 * ‼ GET เท่านั้น — ทางเดียวที่ไฟล์นี้อ่านข้อมูลจาก PEAK
 */
async function get(resource, params, biz, _retry) {
  const r = clean(resource).toLowerCase().replace(/^\/+|\/+$/g, '');
  if (r.includes('?') || r.includes('..'))
    throw new Error('READ-ONLY: ชื่อ endpoint ไม่ถูกต้อง');
  if (!ALLOW.has(r))
    throw new Error(`READ-ONLY: ไม่อนุญาตให้เรียก "${resource}" — ` +
                    'อนุญาตเฉพาะ ' + [...ALLOW].join(' / ') + ' (อ่านอย่างเดียว)');

  if (Date.now() > BUDGET.until) { BUDGET.calls = 0; BUDGET.until = Date.now() + 60000; }
  if (++BUDGET.calls > MAX_CALLS)
    throw new Error(`ยิง PEAK เกิน ${MAX_CALLS} คำขอในหนึ่งนาที — หยุดไว้ก่อน ` +
                    'รออีกสักครู่แล้วค่อยกดใหม่');

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {}))
    if (v !== '' && v !== null && v !== undefined) qs.set(k, String(v));

  const c = cfgOf(biz);
  const ts = stamp();

  /* ‼ ต้องเซ็นด้วย "สูตรเดียวกับที่ขอกุญแจสำเร็จ" เท่านั้น
   *   บทเรียน 5 ก.ย. 69: อลิซลบ sign() ตัวเก่าทิ้งตอนพอร์ต signWith
   *   แต่ลืมจุดนี้ไป → ทุกคำขอพังด้วย "sign is not defined"
   *   (ไม่ใช่ PEAK ปฏิเสธ แต่โค้ดเราเองพังก่อนจะยิงออกไปด้วยซ้ำ) */
  const f = await loadFormula();
  /* ‼ ยิงด้วยชื่อที่ "ผ่านด่านแล้ว" เท่านั้น ห้ามใช้สตริงดิบที่ผู้เรียกส่งมา
   *
   *   ของเดิมตรวจ r (ตัวพิมพ์เล็ก/ตัดช่องว่าง) แต่เอา resource ตัวเดิมไปต่อ URL
   *   = ตรวจสตริงหนึ่ง แล้วใช้อีกสตริงหนึ่ง
   *
   *   วันนี้ยังไม่มีช่องโหว่จริง (resource เป็นค่าคงที่ในโค้ดทุกจุด และ ? .. ถูกกันไว้)
   *   แต่มันปลอดภัยด้วย "ความบังเอิญ" ไม่ใช่ด้วยดีไซน์ — วันไหนมีคนเปิดให้
   *   resource มาจากคำขอของผู้ใช้ ช่องนี้จะกลายเป็นของจริงทันที
   *   ปิดตรงนี้ให้ขาดไปเลย: ค่าที่ยิงออกไป = ค่าที่ผ่าน ALLOW มาแล้วเป๊ะ ๆ */
  /* ‼ จำกุญแจ "ใบที่ยิงไปจริงรอบนี้" ไว้ — ไว้พิสูจน์ตอนล้มว่าใบใหม่จริงหรือเปล่า
   *   🔒 เก็บแค่ในตัวแปรท้องถิ่น ไม่เคยถูกใส่ในข้อความหรือคืนออกไป */
  const usedTok = await clientToken(c.biz, false);
  const res = await fetch(`${BASE}/${CANON[r]}${qs.toString() ? '?' + qs : ''}`, {
    method: 'GET',
    headers: {
      'Time-Stamp': ts, 'Time-Signature': signWith(c, ts, f),
      'Client-Token': usedTok,
      'User-Token': c.userToken, Accept: 'application/json',
    },
  });
  const txt = await res.text();

  if ((res.status === 401 || res.status === 403) && !_retry) {
    await clientToken(c.biz, true);
    return get(resource, params, biz, usedTok || true);
  }
  if (res.status >= 300)
    throw new Error(`PEAK ตอบกลับ HTTP ${res.status} — ${redact(txt).slice(0, 300)}`);

  let j;
  try { j = JSON.parse(txt); }
  catch { throw new Error('อ่าน JSON จาก PEAK ไม่ได้ — ' + redact(txt).slice(0, 200)); }

  /* 🔴 กุญแจเสียแต่ตอบ 200 — ต้องดักตรงนี้ ไม่งั้นได้ 0 แถวเงียบ ๆ */
  if (authBad(j)) {
    /* ═══════════════════════════════════════════════════════════════
     *  🔴 "ขอกุญแจใบใหม่" มีประโยชน์ก็ต่อเมื่อใบที่ใช้อยู่ **เก่าแล้ว**
     *
     *  ถ้าใบที่เพิ่งโดนปฏิเสธ เป็นใบที่ PEAK ออกให้เองเมื่อไม่กี่วินาทีก่อน
     *  การไปขอใหม่ไม่ได้ช่วยอะไรเลยสักนิด — PEAK จะออกใบที่ "ใหม่พอ ๆ กัน"
     *  มาให้ แล้วปฏิเสธเหมือนเดิม (และเสียคำขอฟรี 1 ใบจากโควตา 1 ครั้ง/60 วิ)
     *  ⇒ กรณีนี้ต้องเด้งไป "บอกสาเหตุที่แท้จริง" ทันที ไม่ใช่ไปวนขอกุญแจ
     *
     *  ‼ กลับกัน ถ้าใบในมือเก่าเกิน 65 วินาที (มาจากแคชรอบก่อน) การขอใหม่
     *    คือสิ่งที่ถูกต้อง เพราะ PEAK ทำให้ token ตายก่อนหมดอายุได้ (v32.6)
     * ═══════════════════════════════════════════════════════════════ */
    const ageMs = tokenAgeMs(c.biz);
    if (!_retry && ageMs >= CT_GAP_MS) {
      await clientToken(c.biz, true);
      /* ‼ ส่งกุญแจใบที่เพิ่งโดนปฏิเสธไปกับรอบสอง เพื่อให้รอบสองรู้ว่า
       *   ใบที่ได้มาใหม่ "เป็นคนละใบจริงหรือเปล่า" — ห้ามเดา ต้องเทียบ */
      return get(resource, params, biz, usedTok || true);
    }
    const brandNew = !_retry;   /* ยังไม่เคยยิงซ้ำ = ตกมาที่นี่เพราะกุญแจยังใหม่ */
    /* ═══════════════════════════════════════════════════════════════
     *  🔴 ข้อความนี้คือสิ่งเดียวที่พี่เอเห็นตอนระบบพัง — ต้องบอกให้พอทำต่อได้
     *
     *  ของเดิมเขียนว่า "ขอกุญแจใหม่แล้วยังไม่ผ่าน" ลอย ๆ ซึ่ง
     *   ① ไม่จริงเสมอไป (ดูกับดักที่ clientToken ข้างบน) และ
     *   ② ไม่บอกว่าค่าตัวไหนพัง · ตั้งอยู่ที่ไหน · ต้องไปแก้ตรงไหน
     *
     *  ‼ สิ่งที่ "พิสูจน์แล้ว" ณ จุดนี้ และต้องเขียนออกไปให้ครบ:
     *    · /ClientToken **ผ่าน** — PEAK ออกกุญแจให้เราสำเร็จ
     *      ⇒ ConnectId · ConnectKey · ApplicationCode · ลายเซ็นเวลา ใช้ได้หมด
     *        (ถ้าตัวใดตัวหนึ่งพัง จะตายตั้งแต่ขั้นขอกุญแจ ไม่มาถึงบรรทัดนี้)
     *    · ตัวที่ **ยังไม่เคยถูกพิสูจน์** เหลือแค่ 2 อย่างที่ติดไปกับ GET นี้:
     *        ① User-Token ของกิจการนี้ (ไม่ได้ใช้ตอนขอกุญแจเลยแม้แต่นิดเดียว)
     *        ② ตัวกุญแจที่เพิ่งได้มา (ถ้า PEAK ออกให้แล้วปฏิเสธเองทันที)
     *      ⇒ ตัวที่ต้องสงสัยเป็นอันดับหนึ่งคือ **User-Token** เสมอ
     *
     *  🔒 บอก "ชื่อช่อง + ชื่อตัวแปร Railway + ค่ามาจากไหน" เท่านั้น
     *     ห้ามพิมพ์ค่าจริงลงไปแม้แต่ตัวเดียว (กฎเหล็กของพี่เอ)
     * ═══════════════════════════════════════════════════════════════ */
    const fresh = (typeof _retry === 'string' && _retry) ? (usedTok !== _retry) : false;
    const rep = credReport(c.biz);
    const ut = rep.fields.find(x => x.field === 'userToken') || {};
    throw new Error(
      `PEAK ปฏิเสธกุญแจเข้าระบบของกิจการ "${c.biz}" (Invalid Client Token)\n` +
      (fresh ? '▸ ขอกุญแจใบใหม่มาแล้วจริง และยังโดนปฏิเสธเหมือนเดิม\n'
        : brandNew
          ? `▸ กุญแจใบนี้ PEAK เพิ่งออกให้เองเมื่อ ${Math.round(ageMs / 1000)} วินาทีก่อน ` +
            'แล้วปฏิเสธมันเอง — ขอใบใหม่ซ้ำไม่ช่วยอะไร จึงไม่ขอให้เสียโควตาฟรี ๆ\n'
          : '▸ ยิงซ้ำอีกครั้งแล้วยังโดนปฏิเสธเหมือนเดิม\n') +
      '\n‼ ที่พิสูจน์ได้แล้ว: PEAK **ออกกุญแจให้สำเร็จ** ⇒ ConnectId · ConnectKey · ' +
      'ApplicationCode · ลายเซ็นเวลา ของกิจการนี้ยังใช้ได้ทั้งหมด\n' +
      `⇒ ตัวที่ต้องสงสัยคือ **User-Token ของกิจการ "${c.biz}"** ` +
      `— ตั้งที่ Railway > Variables ชื่อ ${ut.envVar || '-'} ` +
      `(ตอนนี้ค่ามาจาก: ${ut.source === 'railway' ? 'Railway' :
        ut.source === 'legacy' ? 'ไฟล์โค้ดเดิม modules/sales/_source/Code.gs' :
        ut.source === 'builtin' ? 'ค่าเริ่มต้นในโค้ด' : '❌ ยังไม่ได้ตั้ง'})\n` +
      '   ค่าใหม่เอามาจากหน้า PEAK > ตั้งค่า > รายการเชื่อมต่อ > แอปของกิจการนี้\n' +
      (rep.mixed ? '\n⚠️ ค่าเชื่อมต่อชุดนี้ประกอบมาจากหลายที่ปนกัน — ' +
                   'ถ้าเพิ่งเปลี่ยนค่าบางตัว ให้เปลี่ยนให้ครบชุดจากที่เดียวกัน\n' : '') +
      (rep.fields.some(x => x.padded)
        ? '⚠️ ค่าที่ตั้งไว้ใน Railway มีช่องว่าง/ขึ้นบรรทัดติดมาด้วย: ' +
          rep.fields.filter(x => x.padded).map(x => x.envVar).join(', ') +
          ' — ระบบตัดให้แล้ว แต่ควรวางใหม่ให้สะอาด\n' : '') +
      'ค่าที่ใช้อยู่: ' + credLine(c.biz) + '\n' +
      `คำขอที่โดนปฏิเสธ: ${CANON[r]}`);
  }
  const bad = resBad(j);
  if (bad) throw new Error(bad + ' — ห้ามแปลว่า "ไม่พบเอกสาร" · คำขอ: ' + resource);

  return j;
}

/* ═══════════════════════════════════════════════════════════════════
 *  📒 getOnce() — ถาม 1 ครั้ง แล้วคืน "ตามที่ PEAK ตอบจริง" (รอบ 233 · 4 ต.ค. 69)
 *     ผู้เรียกตัวเดียว: core/peak-ledger.js (ปุ่ม "ลองถาม PEAK ตามรหัสผังบัญชี")
 *
 *  ‼ ทำไมไม่ใช้ get(): เส้นทางที่กุญแจของเรา "ไม่มีสิทธิ์" PEAK อาจตอบ 401/403
 *    get() จะเข้าใจว่า "กุญแจหมดอายุ" แล้วทิ้งกุญแจใบที่ยังดีอยู่ไปขอใบใหม่ — ซึ่ง PEAK ให้ขอได้
 *    1 ครั้ง/65 วินาที ⇒ ① ตัวซิงก์ PEAK ทั้งระบบสะดุดไป 1 นาที ② ข้อความจริงของ PEAK หาย
 *    กลายเป็น "PEAK จำกัดการขอกุญแจ" (พิสูจน์แล้วในยาม test:peakledger)
 *  ⇒ ตัวนี้ไม่แตะกุญแจเลย (ใช้ใบที่มีอยู่ · ไม่บังคับขอใหม่) และไม่แปลผล — คืน { status, json, text }
 *    ให้ผู้เรียกอ่านเอง · ผู้เรียกต้องยืนยันการเชื่อมต่อด้วย get() ปกติมาก่อนแล้ว
 *  🔒 GET เท่านั้น · ผ่านด่าน ALLOW และตัวนับคำขอ/นาที ตัวเดียวกับ get() · ยิงด้วยชื่อที่ผ่านด่านแล้ว
 * ═══════════════════════════════════════════════════════════════════ */
async function getOnce(resource, params, biz) {
  const r = clean(resource).toLowerCase().replace(/^\/+|\/+$/g, '');
  if (r.includes('?') || r.includes('..'))
    throw new Error('READ-ONLY: ชื่อ endpoint ไม่ถูกต้อง');
  if (!ALLOW.has(r))
    throw new Error(`READ-ONLY: ไม่อนุญาตให้เรียก "${resource}" (อ่านอย่างเดียว)`);
  if (Date.now() > BUDGET.until) { BUDGET.calls = 0; BUDGET.until = Date.now() + 60000; }
  if (++BUDGET.calls > MAX_CALLS)
    throw new Error(`ยิง PEAK เกิน ${MAX_CALLS} คำขอในหนึ่งนาที — หยุดไว้ก่อน ` +
                    'รออีกสักครู่แล้วค่อยกดใหม่');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {}))
    if (v !== '' && v !== null && v !== undefined) qs.set(k, String(v));
  const c = cfgOf(biz);
  const ts = stamp();
  const f = await loadFormula();
  const tok = await clientToken(c.biz, false);
  const res = await fetch(`${BASE}/${CANON[r]}${qs.toString() ? '?' + qs : ''}`, {
    method: 'GET',
    headers: {
      'Time-Stamp': ts, 'Time-Signature': signWith(c, ts, f),
      'Client-Token': tok,
      'User-Token': c.userToken, Accept: 'application/json',
    },
  });
  const txt = await res.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { j = null; }
  return { status: res.status, json: j, text: redact(txt).slice(0, 600) };
}

/** ใบแจ้งหนี้ตามเลขที่ (คืน [] เมื่อ "ไม่มีจริง" เท่านั้น) */
const invoices = (code, biz) => get('Invoices', { code, limit: 20 }, biz).then(listOf);
/** ใบเสนอราคาตามเลขที่ */
const quotations = (code, biz) => get('Quotations', { code, limit: 20 }, biz).then(listOf);
/** ใบเสร็จของใบแจ้งหนี้ใบหนึ่ง */
const receipts = (reference, biz) => get('Receipts', { reference, limit: 50 }, biz).then(listOf);

/* ═══════════════════════════════════════════════════════════════════
 *  🧾 ใบสั่งซื้อของ PEAK — "ลองก่อน โดนปฏิเสธค่อยลองชื่ออื่น แล้วจำไว้"
 *
 *  พี่เอสั่ง 15 ก.ย. 69 (คำต่อคำ):
 *    "ปรับแก้ระบบคลังสินค้า ในส่วนการดึงข้อมูลใบ po จาก peak
 *     เปิดให้ค้นหา เลือกข้อมูล supplier ในช่วงเวลาที่สั่งของ หรือเปิด po ได้
 *     เพื่อดึงรายการ po ที่ยังไม่รับของมาทำการรับสินค้าเข้าคลังได้"
 *
 *  ‼ เรารู้แค่ว่า "ตัวห่อคำตอบชื่อ PeakPurchaseOrders" (_source/purchase/Code.gs:1794)
 *    ไม่รู้ว่าเส้นทางชื่ออะไร ⇒ ห้ามเดาชื่อเดียวแล้วเชื่อ
 *    วิธีเดียวกับ probeSignature: ไล่ลองตามลำดับ แล้วจำชื่อที่ผ่านไว้ในฐานข้อมูล
 *    ครั้งต่อไปยิงชื่อนั้นชื่อเดียว — ไม่เสียคำขอกับทางที่รู้แล้วว่าไม่ได้ผล
 *
 *  🔴 เงื่อนไขที่ยอมให้ "ลองชื่อถัดไป" มีอย่างเดียว: PEAK บอกว่าไม่รู้จักเส้นทางนี้
 *    ปัญหาอื่น (กุญแจไม่ผ่าน · โควตาเต็ม · เน็ตล่ม) ต้องโยนออกไปตรง ๆ
 *    ไม่งั้นกุญแจเสียครั้งเดียวจะกลายเป็นยิง PEAK รวด 4 ครั้งทุกคำขอ
 *    — และที่แย่กว่าคือรายงานผิดว่า "PEAK ไม่มีเส้นทางใบสั่งซื้อ"
 * ═══════════════════════════════════════════════════════════════════ */
const PO_TRY = ['purchaseorders/list', 'purchaseorders',
                'purchaseorder/list', 'purchaseorder'];
const PO_STATE_KEY = 'peak_po_endpoint';
let _poRes = null;                       /* ชื่อเส้นทางที่ผ่านแล้ว (จำในโปรเซสนี้) */

/** "ไม่รู้จักเส้นทางนี้" หรือเปล่า — ดูจากคำตอบจริง ไม่ใช่เดา */
function unknownRoute(msg) {
  const m = String(msg || '');
  if (/HTTP\s+(400|403|404|405|410|501)\b/.test(m)) return true;
  return /not\s*found|no\s*such|unknown|invalid\s*(api|url|resource|request|method)|not\s*allow/i.test(m);
}

async function loadPoRes() {
  if (_poRes) return _poRes;
  try {
    const raw = await require('./peak-queue').state(PO_STATE_KEY);
    if (raw && PO_TRY.includes(String(raw))) _poRes = String(raw);
  } catch { /* ยังไม่มีที่จำก็ไล่ลองใหม่ ไม่เป็นไร */ }
  return _poRes;
}
async function savePoRes(r) {
  _poRes = r;
  try { await require('./peak-queue').state(PO_STATE_KEY, r); }
  catch { /* จำลงฐานไม่ได้ก็ยังใช้ได้ในโปรเซสนี้ */ }
  return r;
}
/** ลืมชื่อที่จำไว้ — ‼ ใช้ในยามทดสอบ และตอนอยากบังคับให้ไล่หาใหม่ */
function poForget() { _poRes = null; }

/**
 * ถามใบสั่งซื้อจาก PEAK 1 คำขอ (GET เท่านั้น)
 * @return {{res:string, name:string, json:object, calls:number, tried:Array}}
 *   calls = จำนวนคำขอที่ยิงออกไปจริงในครั้งนี้ ‼ ตัวเลขเป๊ะ ไม่ใช่ประมาณ
 */
async function poGet(params, biz) {
  const known = await loadPoRes();
  const order = known ? [known, ...PO_TRY.filter(r => r !== known)] : PO_TRY.slice();
  const tried = [];
  let calls = 0;
  for (const r of order) {
    let j;
    calls++;
    try { j = await get(r, params, biz); }
    catch (e) {
      const msg = String((e && e.message) || e);
      tried.push({ name: CANON[r], error: msg.slice(0, 200) });
      if (!unknownRoute(msg)) throw e;          /* 🔴 ไม่ใช่เรื่องชื่อเส้นทาง = โยนออกไป */
      if (known === r) _poRes = null;           /* ชื่อที่เคยผ่าน ใช้ไม่ได้แล้ว ลืมทิ้ง */
      continue;
    }
    if (r !== known) await savePoRes(r);
    return { res: r, name: CANON[r], json: j, calls, tried };
  }
  throw new Error(
    'PEAK ไม่รับชื่อเส้นทางใบสั่งซื้อที่ลองไปทั้งหมด — ลองแล้ว ' +
    order.map(r => CANON[r]).join(' / ') + '\n' +
    '‼ นี่ไม่ได้แปลว่า "ไม่มีใบสั่งซื้อ" แปลว่าเรายังไม่รู้ว่า PEAK เรียกเส้นทางนี้ว่าอะไร\n' +
    'เหตุผลที่ PEAK ตอบกลับมาแต่ละชื่อ: ' +
    tried.map(t => t.name + ' → ' + t.error).join(' · '));
}

/* ═══════════════════════════════════════════════════════════════════
 *  🔴 23 ก.ย. 69 (รอบ 87) — เอกสารรายใบแบบ "รหัสอยู่ในที่อยู่" (path)
 *
 *  พี่เอส่งภาพ: ลองเส้นทางใบรายตัวแบบ ?id=… ไป 6 คู่ PEAK ตอบ HTTP 404 ทุกคู่
 *  ⇒ หลาย API เรียกใบรายตัวว่า ".../PurchaseOrders/<รหัส>" ไม่ใช่ "?id=<รหัส>"
 *    ซึ่ง get() เดิมต่อไม่ได้เลย เพราะมันต่อได้แค่ "?พารามิเตอร์"
 *
 *  ‼ ยังเป็น GET ล้วนและยังผ่านด่าน ALLOW ตัวเดิมทุกตัวอักษร —
 *    ชื่อเส้นทางต้องอยู่ในทะเบียน และรหัสที่ต่อท้าย "ล้างแล้ว" เท่านั้น
 *  🔒 รหัสที่ยอมให้ต่อท้าย: ตัวอักษร-ตัวเลข-ขีด-ขีดล่าง-จุด เท่านั้น
 *    ห้ามมี / ? # .. หรือช่องว่าง (กันเดินออกนอกเส้นทางที่ผ่านด่านมาแล้ว)
 * ═══════════════════════════════════════════════════════════════════ */
function safeSeg(v) {
  const t = clean(v);
  if (!t) return '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(t)) return '';
  if (t === '.' || t === '..') return '';
  return t;
}
/** GET เอกสารรายใบแบบรหัสอยู่ใน path — คืน JSON เหมือน get() ทุกประการ */
async function getPath(resource, id, params, biz) {
  const seg = safeSeg(id);
  if (!seg) throw new Error('รหัสเอกสารไม่อยู่ในรูปแบบที่ปลอดภัยพอจะต่อท้ายที่อยู่ได้');
  const r = clean(resource).toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!ALLOW.has(r))
    throw new Error(`READ-ONLY: ไม่อนุญาตให้เรียก "${resource}" — ` +
                    'อนุญาตเฉพาะ ' + [...ALLOW].join(' / ') + ' (อ่านอย่างเดียว)');
  /* ‼ เดินผ่าน get() ตัวเดิมไม่ได้ (มันไม่รับ path) — แต่ต้องได้ของเหมือนกันทุกอย่าง
   *   ⇒ ใช้วิธีเดียวกับที่ CANON ทำ: สร้าง "ชื่อชั่วคราว" ที่ประกอบจากชื่อที่ผ่านด่านแล้ว
   *     บวกรหัสที่ล้างแล้ว แล้วส่งให้ get() ผ่านทะเบียนชั่วคราวตัวนี้ */
  const tmp = r + '/#' + seg.toLowerCase();
  const had = CANON[tmp];
  CANON[tmp] = CANON[r] + '/' + seg;
  ALLOW.add(tmp);
  try { return await get(tmp, params || {}, biz); }
  finally { if (had === undefined) { delete CANON[tmp]; ALLOW.delete(tmp); } }
}

/** ชื่อเส้นทางใบสั่งซื้อที่ระบบจำไว้แล้ว ('' = ยังไม่เคยเจอ) — ไว้โชว์บนหน้าจอ */
async function poResource() { return (await loadPoRes()) || ''; }

/* ═══════════════════════════════════════════════════════════════════
 *  ‼ "มีกุญแจ" ≠ "เชื่อมต่อได้"
 *
 *  บทเรียน 5 ก.ย. 69 (พี่เอจับได้): การ์ดขึ้นว่า "เชื่อมแล้ว 2 จาก 2"
 *  ทั้งที่ยังไม่เคยยิงถาม PEAK เลยสักครั้ง — มันแค่เห็นว่ามีค่ากุญแจ 4 ตัว
 *  พอกดทดสอบจริงถึงพัง หน้าจอจึงโกหกคนใช้
 *
 *  กติกาใหม่: บอกได้แค่สิ่งที่ "พิสูจน์แล้ว" เท่านั้น
 *    ไม่มีกุญแจ        → ⚠️ ยังไม่ได้ตั้งกุญแจ
 *    มีกุญแจ ยังไม่ทดสอบ → 🔑 มีกุญแจแล้ว · ยังไม่ได้ทดสอบ
 *    ทดสอบผ่าน          → ✅ เชื่อมต่อได้ (พร้อมเวลาที่ผ่านล่าสุด)
 *    ทดสอบแล้วพัง       → ❌ เชื่อมต่อไม่ได้ (พร้อมสาเหตุจริง)
 * ═══════════════════════════════════════════════════════════════════ */
const VKEY = biz => 'peak_verify_' + String(biz);

/** จำผลทดสอบล่าสุดของกิจการหนึ่ง */
async function markVerify(biz, ok, error) {
  const rec = { ok: !!ok, at: new Date().toISOString(),
                error: ok ? '' : String(error || '').slice(0, 300) };
  try { await require('./peak-queue').state(VKEY(biz), JSON.stringify(rec)); }
  catch { /* จำไม่ได้ก็ไม่เป็นไร แค่หน้าจอจะบอกว่า "ยังไม่ได้ทดสอบ" */ }
  return rec;
}

/** ผลทดสอบล่าสุดของทุกกิจการ — null = ยังไม่เคยทดสอบ */
async function verifyMap() {
  const out = {};
  for (const biz of Object.keys(ACCOUNTS)) {
    out[biz] = null;
    try {
      const raw = await require('./peak-queue').state(VKEY(biz));
      if (raw) out[biz] = JSON.parse(raw);
    } catch { /* อ่านไม่ได้ = ยังไม่เคยทดสอบ */ }
  }
  return out;
}

/** ทดสอบการเชื่อมต่อ — ไม่แตะข้อมูลจริง */
async function ping(biz) {
  const t0 = Date.now();
  const name = cfgOf(biz).biz;
  try {
    const j = await get('Receipts', { limit: 3, page: 1 }, biz);
    await markVerify(name, true);
    return { ok: true, biz: name, rows: listOf(j).length, ms: Date.now() - t0 };
  } catch (e) {
    await markVerify(name, false, e.message);
    throw e;
  }
}

module.exports = {
  sourceOf, probeSignature, loadFormula, saveFormula,
  /* 🔒 รายงานว่า "ค่าเชื่อมต่อมาจากไหน" + ตัวลบความลับ — ไม่มีค่าจริงหลุดออกไป */
  credReport, credLine, envNameOf, redact, redactDeep,
  BASE, ALLOW, CANON, get, getOnce, invoices, quotations, receipts, ping,
  /* ═══════════════════════════════════════════════════════════════
   *  ⏱ ล้าง "หน้าต่างนับคำขอ 1 นาที" — มีไว้ให้ยามจำลองว่าเวลาเดินไปแล้ว 1 นาที
   *
   *  ‼ ยามชุด test:cfexp ยิงคำขอปลอมหลายร้อยครั้งภายในไม่กี่วินาที ซึ่งในโลกจริง
   *    กินเวลาหลายนาที ⇒ ถ้าไม่มีทางนี้ ยามจะไปชนเพดาน 300 คำขอ/นาที ของตัวเอง
   *    แล้วรายงานว่า "พัก" ทั้งที่กำลังทดสอบเรื่องอื่นอยู่ (ยามโกหกโดยไม่ตั้งใจ)
   *  🔒 ตัวนี้ไม่ได้ปิดเพดาน และไม่เปิดทางเขียนอะไรทั้งสิ้น — มันแค่ "เลื่อนนาฬิกา"
   *    ของตัวนับ เพดานยังทำงานเหมือนเดิมทุกประการหลังเรียก
   * ═══════════════════════════════════════════════════════════════ */
  rateWindowReset: () => { BUDGET.calls = 0; BUDGET.until = Date.now() + 60000; },
  rateWindowUsed: () => BUDGET.calls,
  MAX_CALLS,
  /* 🧾 ใบสั่งซื้อ — อ่านอย่างเดียว ผ่านด่าน ALLOW เดียวกับทุกตัว */
  PO_TRY, poGet, poResource, poForget, unknownRoute, getPath, safeSeg,
  isConfigured, configuredList, bizAll, bizOfDoc, listOf, ymd, dig, stamp, sleep, missingOf,
  /* ‼ ตัวอ่านชื่อลูกค้า — ทางเดียวของทั้งระบบ ห้ามเขียนตัวที่สองที่ไหนอีก */
  PEAK_NAME, flat, pickName, contactName, contactCacheClear,
  buildContactIndex, contactIndexStats,
  verifyMap, markVerify,
  signWith, secretOf, msgOf, encode, ctBody,
};
