'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/sync-jobs.js — รายการงานซิงค์ ชีต → ฐานข้อมูล
 *
 *  ID ของชีตทั้งหมดอ่านมาจาก CONFIG ในโค้ดแอปเดิมโดยตรง
 *  ไม่ได้ถามใครหรือเดาเอา — ใส่เป็นค่าเริ่มต้นไว้เลย
 *  ถ้าวันไหนย้ายไฟล์ ตั้งตัวแปรใน Railway ทับได้โดยไม่ต้องแก้โค้ด
 *
 *  แผนที่คอลัมน์สร้างจากไฟล์ SQL จริง (sql/03,04,05) ไม่ได้พิมพ์มือ
 *  ชนิด: text · date · timestamptz · numeric · integer
 * ═══════════════════════════════════════════════════════════════════ */
const { CFG } = require('./config');
const db = require('./db');

/* ─── ไฟล์ชีตทั้ง 5 ที่ระบบเดิมใช้ (จาก CONFIG ในโค้ดเดิม) ───────── */
const SS = {
  //  แอปคีย์ยอดขาย · CFG.SALES_SS_ID
  SALES:     CFG.SHEET_SALES_ID     || '1jWTrSzwMKwj78xVA9gMj3cxizFxs18Pr-q0MJ8CjQ_M',
  //  แอป Projects Management · CONFIG.PROJECTS_SSID
  PROJECTS:  CFG.SHEET_PROJECTS_ID  || '1Fyr8sxgqjPPSFpteYzgvw5isffxmOH0sRroPyNPNl1s',
  //  ฐานลูกค้ากลาง · CFG.CONTACTS_SS_ID
  CONTACTS:  CFG.SHEET_CONTACTS_ID  || '1oiN3wzd33fu4rwWlFZHm6a9fBzDI59sudFGqoBAY3mY',
  //  รายชื่อผู้ผลิต · CFG.CALPRICE_SS_ID
  CALPRICE:  CFG.SHEET_CALPRICE_ID  || '1r0sV6o_AzUQh5N4bSyEy-3Cdl8MionfmDAt1-FrEhP8',
  //  Login CRM · CFG.LOGIN_SS_ID — ซิงค์ด้วยกฎพิเศษ (core/sync-users.js)
  LOGIN:     CFG.SHEET_LOGIN_ID    || '10NgAH66TDVrDBKW5s8uugBeKUi3-UozeEN7iO1-61n4',
};

/* ─── แผนที่คอลัมน์ ─────────────────────────────────────────────── */
const SALES_COLUMNS = {
  "Alert": "text",
  "รหัสงาน": "text",
  "วันที่ติดต่อ": "date",
  "ชื่อบริษัท": "text",
  "ชื่อผู้ติดต่อ": "text",
  "เบอร์ติดต่อ": "text",
  "ประเภทลูกค้า": "text",
  "ลูกค้ามาจากไหน": "text",
  "วิธีติดต่อ": "text",
  "ชื่อช่อง / Platform": "text",
  "Lead Status": "text",
  "วันที่อัพเดต": "date",
  "หมายเหตุ": "text",
  "วันที่ปิดการขาย": "date",
  "ผู้ผลิต": "text",
  "ยอดสั่งซื้อ (Outsource)": "numeric",
  "ยอดประเมินราคา": "numeric",
  "เลขที่ QO / IV": "text",
  "ยอดขาย (บาท)": "numeric",
  "หมายเหตุชำระเงิน": "text",
  "ยอดเรียกเก็บ (บาท)": "numeric",
  "รับจริง (บาท)": "numeric",
  "รับขาด (บาท)": "numeric",
  "วันที่โอน": "date",
  "เลขสลิป": "text",
  "ยอด (บาท)": "numeric",
  "วันที่โอน งวด 1": "date",
  "เลขสลิป งวด 1": "text",
  "ยอด งวด 1 (บาท)": "numeric",
  "วันที่โอน งวด 2": "date",
  "เลขสลิป งวด 2": "text",
  "ยอด งวด 2 (บาท)": "numeric",
  "วันที่โอน งวด 3": "date",
  "เลขสลิป งวด 3": "text",
  "ยอด งวด 3 (บาท)": "numeric",
  "Sales Code": "text",
  "Sales Name": "text",
  "Contact ID": "text",
  "Created At": "timestamptz",
  "Updated At": "timestamptz",
  "Created By": "text",
  "Create By": "text",
  "บริษัทที่ขาย": "text",
  "ยอดขายก่อน VAT": "numeric",

  /* ── คอลัมน์ที่ชีตจริงเพิ่มมาทีหลัง (PEAK_COLS code.gs:9394) ──
   *    ต้องประกาศไว้ ไม่งั้นตกไปอยู่ใน _extra แบบไร้ชนิด
   *    แล้ววันที่/ตัวเลขจะกลายเป็นเลข serial ดิบ ๆ ตอนเอาไปแสดง */
  "ยอดขาย PEAK": "numeric",
  "ตรวจยอด": "text",
  "ชื่อลูกค้า PEAK": "text",
  "รหัสลูกค้า PEAK": "text",
  "สถานะชำระ PEAK": "text",
  "รับชำระแล้ว PEAK": "numeric",
  "PEAK เก็บมาแล้ว (งวด)": "text",
  "ผลตรวจ PEAK": "text",
  "อัปเดต PEAK เมื่อ": "text",
  "เลขที่ใบเสนอราคา PEAK": "text",
  "สถานะใบเสนอราคา PEAK": "text",
  "ยอดใบเสนอราคา PEAK": "numeric",
  "ใบเสนอราคา → ใบแจ้งหนี้": "text",
  "สถานะซิงก์ PEAK": "text",
  "ลิงก์เอกสาร PEAK": "text",
  "เงื่อนไขชำระ PEAK": "text",
  "วันเครดิต PEAK": "text",

  /* ── ติดตามเก็บเงิน (COLLECTION_HEADERS code.gs:6932) ── */
  "สถานะเก็บเงิน": "text",
  "วันส่งมอบ/ติดตั้ง": "date",
  "วันนัดวางบิล": "date",
  "วันวางบิลจริง": "date",
  "วันครบกำหนดชำระ": "date",
  "เลขใบแจ้งหนี้ Peak": "text",
  "ผู้ติดตามเก็บเงิน": "text",
  "วันติดตามล่าสุด": "date",
  "หมายเหตุติดตาม": "text",
  "วันเตือนล่าสุด": "date",
  "เหตุผลที่ยังไม่ได้เงิน": "text",
  "นัดติดตามครั้งถัดไป": "date",
  "ยอดที่ลูกค้ารับปาก": "numeric",
  "จำนวนครั้งที่ติดตาม": "integer",

  /* ── สำรองค่าเดิมก่อนแก้ตาม PEAK (PEAK_FIX.COLS code.gs:17866) ──
   *
   *  ‼ 2 ช่องแรกชื่อยาวเกิน 63 ไบต์ (ภาษาไทยตัวละ 3 ไบต์)
   *    PostgreSQL จะตัดหางทิ้งเงียบ ๆ ชื่อคอลัมน์จริงจึงไม่ตรงกับหัวชีต
   *    ต้องประกาศชื่อสั้นไว้ที่นี่ แล้วผูกกับหัวชีตเต็มใน SALES_HEADER_ALIAS */
  "ยอดขายเดิม": "numeric",
  "ยอดเรียกเก็บเดิม": "numeric",
  "รับจริงเดิม (ก่อนแก้)": "numeric",
  "รับขาดเดิม (ก่อนแก้)": "numeric",
  "แก้ยอดตาม PEAK เมื่อ": "text",

  /* ── ตรวจการเปลี่ยนแปลง (PEAK_DELTA.COLS code.gs:18471) ── */
  "ลายเซ็นข้อมูล PEAK": "text",
  "ตรวจครั้งถัดไป": "text",
  "จำนวนครั้งที่ตรวจ": "integer",
};

const PROJECT_COLUMNS = {
  "ID": "text",
  "ชื่อลูกค้า": "text",
  "แสดงชื่อลูกค้า": "text",
  "พนักงานขาย": "text",
  "Project": "text",
  "กลุ่มงาน": "text",
  "จำนวนงานพิมพ์": "integer",
  "จำนวนงานป้าย": "integer",
  "ประเภทงาน": "text",
  "Owner": "text",
  "Status": "text",
  "ประเภทการจัดส่ง": "text",
  "ที่อยู่จัดส่ง": "text",
  "Location maps": "text",
  "Description": "text",
  "Started": "date",
  "Due": "date",
  "วันที่ส่งมอบให้ลูกค้า": "date",
  "Complete": "date",
  "Status JobOrder": "text",
  "เลขที่ Slip ชำระเงิน": "text",
  "PDF File": "text",
  "acc_result": "text",
  "acc_confirm_date": "date",
  "ผู้ยืนยันรับเงิน": "text",
  "ชื่อผู้รับ": "text",
  "เบอร์ติดต่อ": "text",
  "ค่าติดตั้งงาน": "numeric",
  "Outsource": "text",
  "cover_sheet_url": "text",
  "cover_sheet_date": "date",
  "ภาพ CheckList 1": "text",
  "ภาพ CheckList 2": "text",
  "ภาพ CheckList 3": "text",
  "ภาพหน้างาน 1": "text",
  "ภาพหน้างาน 2": "text",
  "ภาพหน้างาน 3": "text",
  "Image": "text",
  "Image In Progress": "text",
  "Image Complete": "text",
  "จำนวนงานย่อยทั้งหมด": "integer",
  "จำนวนตรวจบัญชีแล้ว": "integer",
  "จำนวนเข้าแผนผลิตแล้ว": "integer",
  "ปิดงานย้อนหลัง": "text",
  "job_code": "text",
};

const REQUIREMENT_COLUMNS = {
  "requirement_id": "text",
  "project_id": "text",
  "requirement_name": "text",
  "job_type": "text",
  "status": "text",
  "designer": "text",
  "size_w": "numeric",
  "size_h": "numeric",
  "quantity": "numeric",
  "brief_detail": "text",
  "work_group": "text",
  "Status JobOrder": "text",
  "site_check_date": "date",
  "meeting_date": "date",
  "started_at": "date",
  "completed_at": "date",
  "cover_sheet_date": "date",
  "image": "text",
  "acc_result": "text",
  "acc_confirm_date": "date",
  "ผู้ยืนยันรับเงิน": "text",
};

const CONTACT_COLUMNS = {
  "ID": "text",
  "First Name": "text",
  "Last Name": "text",
  "Title": "text",
  "Email": "text",
  "Company": "text",
  "แสดงชื่อบริษัท": "text",
  "Phone": "text",
  "Address": "text",
  "TaxID": "text",
  "เงื่อนไขการชำระเงิน": "text",
  "Business Group": "text",
  "From Channel": "text",
  "Status": "text",
  "Create By": "text",
  "Created At": "timestamptz",
};

/* หัวตารางจริงของแท็บ Channel คือ  No | Channel | …
 * (เดิมเดาไว้เป็น Group | Channel | Handle | Active — ผิด)
 * ที่เหลือปล่อยลง _extra ไว้ก่อน ยังไม่รู้ว่ามีคอลัมน์อะไรอีก */
const CHANNEL_COLUMNS = {
  "No": "integer",
  "Channel": "text",
};

/* ‼ แท็บ ActivityLog ไม่ใช่ "บันทึกการเข้าพบลูกค้า" อย่างที่ชื่อชวนคิด
 *   ของจริงคือ "บันทึกการใช้งานแอป" — ใครกดอะไร เมื่อไหร่ งานไหน
 *   หัวตารางจริง: Time | Username | Nickname | Action | รหัสงาน | Company | Contact | Phone */
const ACTIVITY_COLUMNS = {
  "Time":     "timestamptz",
  "Username": "text",
  "Nickname": "text",
  "Action":   "text",
  "รหัสงาน":  "text",
  "Company":  "text",
  "Contact":  "text",
  "Phone":    "text",
};

const IMGINDEX_COLUMNS = {
  "path": "text",
  "fid": "text",
};

/* ─── หัวคอลัมน์ในชีตที่ชื่อไม่ตรงกับชื่อคอลัมน์ในตาราง ────────────
 *  ชื่อไทยพวกนี้ยาวเกิน 63 ไบต์ที่ PostgreSQL รับได้ (ไทย 1 ตัว = 3 ไบต์)
 *  ถ้าใช้ชื่อเดิม PostgreSQL จะตัดทิ้งเงียบ ๆ แล้วหาคอลัมน์ไม่เจอ */
/* หัวชีตที่ยาวเกินขีดจำกัดชื่อคอลัมน์ของ PostgreSQL (63 ไบต์)
 * ซ้าย = ชื่อคอลัมน์ในตาราง · ขวา = หัวคอลัมน์จริงในชีต */
const SALES_HEADER_ALIAS = {
  'ยอดขายเดิม':       'ยอดขายเดิม (ก่อนแก้ตาม PEAK)',
  'ยอดเรียกเก็บเดิม': 'ยอดเรียกเก็บเดิม (ก่อนแก้)',
};

const THAI_LONG_HEADERS = {
  acc_result:       'ได้รับเงินแล้ว / ลูกค้าเครดิต',
  acc_confirm_date: 'วันที่ confirm ตรวจสอบการรับเงิน',
};

/* ══════════════════════════════════════════════════════════════════
 *  หลังซิงค์ยอดขาย: จดรหัสงานที่มีอยู่จริงเข้าทะเบียน app.job_code
 *
 *  ถ้าไม่จด ตัวออกรหัสของระบบใหม่จะเริ่มนับจาก 001 แล้วทับงานจริงทันที
 *  (นี่คือรากของบั๊ก B2K2609/003 ซ้ำ ในเวอร์ชัน Apps Script)
 * ══════════════════════════════════════════════════════════════════ */
async function claimJobCodes(shaped, log) {
  const codes = new Set();
  for (const { rec } of shaped) {
    const c = String(rec['รหัสงาน'] || '').trim();
    if (c) codes.add(c.toUpperCase());
  }
  if (!codes.size) return;

  let claimed = 0;
  for (const code of codes) {
    try {
      const r = await db.rpc('claim_job_code', { p_code: code, p_module: 'sales', p_note: 'ซิงค์จากชีต' });
      if (r === true || (Array.isArray(r) && r[0] === true)) claimed++;
    } catch (e) {
      log('จดรหัส ' + code + ' ไม่สำเร็จ: ' + e.message);
      break;                                   // พังตัวแรกก็จะพังทุกตัว ไม่ต้องยิงรัว
    }
  }
  if (claimed) log('จดรหัสงานใหม่เข้าทะเบียนกันซ้ำ ' + claimed + ' รหัส');
}

/** โปรเจกต์ก็มีรหัสงานฝังอยู่ในคอลัมน์ Project — จดเข้าทะเบียนด้วย */
async function claimProjectCodes(shaped, log) {
  const codes = new Set();
  for (const { rec } of shaped) {
    const c = String(rec.job_code || '').trim();
    if (c) codes.add(c.toUpperCase());
  }
  let claimed = 0;
  for (const code of codes) {
    try {
      const r = await db.rpc('claim_job_code', { p_code: code, p_module: 'projects', p_note: 'ซิงค์จากชีต Projects' });
      if (r === true || (Array.isArray(r) && r[0] === true)) claimed++;
    } catch (e) { log('จดรหัส ' + code + ' ไม่สำเร็จ: ' + e.message); break; }
  }
  if (claimed) log('จดรหัสงานจากโปรเจกต์ ' + claimed + ' รหัส');
}

/* ─── รายการงานซิงค์ทั้งหมด ─────────────────────────────────────── */
function jobs() {
  return [
    { name: 'sales',        title: 'คีย์ยอดขาย',            sheetId: SS.SALES,
      tab: CFG.SHEET_SALES_TAB || 'TotalSales',
      table: 'total_sales',  columns: SALES_COLUMNS,
      headers: SALES_HEADER_ALIAS, afterRows: claimJobCodes },

    { name: 'projects',     title: 'Projects',              sheetId: SS.PROJECTS,
      tab: CFG.SHEET_PROJECTS_TAB || 'Projects',
      table: 'projects',     columns: PROJECT_COLUMNS,
      headers: THAI_LONG_HEADERS, afterRows: claimProjectCodes },

    { name: 'requirements', title: 'งานย่อย (Requirements)', sheetId: SS.PROJECTS,
      tab: CFG.SHEET_REQ_TAB || 'Requirements',
      table: 'requirements', columns: REQUIREMENT_COLUMNS, headers: THAI_LONG_HEADERS },

    { name: 'imgindex',     title: 'ดัชนีรูป (_ImgIndex)',   sheetId: SS.PROJECTS,
      tab: '_ImgIndex',      table: 'img_index',           columns: IMGINDEX_COLUMNS },

    { name: 'contacts',     title: 'ฐานลูกค้า (Contacts)',   sheetId: SS.CONTACTS,
      tab: CFG.SHEET_CONTACTS_TAB || 'Contacts',
      table: 'contacts',     columns: CONTACT_COLUMNS },

    { name: 'channels',     title: 'ช่องทางการขาย',          sheetId: SS.SALES,
      tab: 'Channel',        table: 'channels',            columns: CHANNEL_COLUMNS },

    { name: 'activity',     title: 'บันทึกการใช้งานแอป',      sheetId: SS.SALES,
      tab: 'ActivityLog',    table: 'activity_log',        columns: ACTIVITY_COLUMNS },

    /* รายชื่อ Outsource — หัวตารางไม่ได้ประกาศในโค้ดเดิม
     * จับคู่ไม่ได้ จึงเก็บทั้งแถวลง _extra ไว้ก่อน ไม่ให้ข้อมูลหาย */
    /* ผู้ใช้ — ใช้ตัวซิงค์เฉพาะ ไม่ใช่ตัวเดียวกับตารางกระจก
     * เพราะห้ามทับรหัสผ่านที่ระบบใหม่เก็บเป็น bcrypt ไว้ */
    { name: 'users',        title: 'ผู้ใช้ (Login CRM)',     sheetId: SS.LOGIN,
      tab: CFG.SHEET_LOGIN_TAB || 'User', table: 'app_users', columns: {},
      run: require('./sync-users').syncUsers },

    { name: 'outsource',    title: 'รายชื่อ Outsource',      sheetId: SS.CALPRICE,
      tab: 'รายชื่อ Outsource', table: 'outsource',         columns: {} },
  ].filter(j => j.sheetId);
}

/**
 * แท็บที่มี "ตารางจริง" รองรับแล้ว — ใช้บอกตัวสำรวจว่าอย่าดึงซ้ำเข้ากระจก
 * คีย์เป็น 'ชื่อไฟล์/ชื่อแท็บ' ตามที่ core/sheet-files.js ตั้งไว้
 */
function typedTabs() {
  const fileOf = {};
  for (const f of require('./sheet-files').files()) fileOf[f.id] = f.key;
  const m = new Map();
  for (const j of jobs()) {
    const key = fileOf[j.sheetId];
    if (key && j.tab) m.set(`${key}/${j.tab}`, j.title || j.name);
  }
  return m;
}

module.exports = {
  jobs, typedTabs, SS,
  SALES_COLUMNS, SALES_HEADER_ALIAS, PROJECT_COLUMNS, REQUIREMENT_COLUMNS,
  CONTACT_COLUMNS, CHANNEL_COLUMNS, ACTIVITY_COLUMNS, IMGINDEX_COLUMNS,
  THAI_LONG_HEADERS, claimJobCodes, claimProjectCodes,
};
