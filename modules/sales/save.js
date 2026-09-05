'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  บันทึกรายการขาย — ถอดจาก saveRecord() code.gs:5161–5504
 *
 *  ‼ ลำดับการเขียนสำคัญมาก: เขียนลง "ชีต" ก่อนเสมอ แล้วค่อยตามลง Supabase
 *
 *    ช่วงนี้ชีตยังเป็นแหล่งความจริง งานซิงค์ดึงชีต → ฐานข้อมูลทุก 10 นาที
 *    ถ้าเขียนแค่ฐานข้อมูล รอบซิงค์ถัดไปจะทับของที่เพิ่งคีย์หายเงียบ ๆ
 *
 *    ชีตสำเร็จ + ฐานข้อมูลพลาด = ยังไม่หาย รอบซิงค์ถัดไปเก็บให้เอง
 *    ชีตพลาด = หยุดทันที ไม่เขียนฐานข้อมูล (ไม่งั้นสองที่ไม่ตรงกัน)
 *
 *  ‼ ไม่แตะ PEAK แม้แต่บรรทัดเดียว — คอลัมน์ PEAK ทั้ง 17 ช่องไม่ถูกเขียน
 *    ยกเว้น "ลิงก์เอกสาร PEAK" ซึ่งเป็นช่องที่เซลส์วางลิงก์เอง ไม่ได้คุยกับ PEAK
 * ═══════════════════════════════════════════════════════════════════ */
const sheets = require('./../../core/sheets');
const db = require('./../../core/db');
const { CFG } = require('./../../core/config');

const SHEET_ID  = CFG.SHEET_SALES_ID || '1jWTrSzwMKwj78xVA9gMj3cxizFxs18Pr-q0MJ8CjQ_M';
const SHEET_TAB = CFG.SHEET_SALES_TAB || 'TotalSales';

const clean = s => String(s == null ? '' : s).trim();
const num = v => {
  const n = Number(String(v == null ? '' : v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** วันที่แบบไทย dd/MM/yyyy เวลากรุงเทพ — ถอดจาก _ds() code.gs:6782 */
function dsNow() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(new Date());
  const g = k => (p.find(x => x.type === k) || {}).value || '';
  return `${g('day')}/${g('month')}/${g('year')}`;
}
const nowISO = () => new Date().toISOString();

/* ─── บริษัทที่ขาย — ถอดจาก _bizNorm() code.gs:7974 ───────────────── */
function bizNorm(v) {
  const s = clean(v);
  if (!s) return 'ยังไม่ระบุ';
  if (s === 'มดงานการป้าย' || s === 'The 101' || s === 'ยังไม่ระบุ') return s;
  const t = s.replace(/[\s.]/g, '').toLowerCase();
  if (t.includes('101')) return 'The 101';
  if (t.includes('มดงาน')) return 'มดงานการป้าย';
  return s;
}

/* ─── ช่องในฟอร์ม → หัวคอลัมน์ในชีต (SALES_HEADERS code.gs:375) ────
 *  ค่า undefined = "ไม่แตะช่องนี้" (ต่างจาก '' ที่แปลว่า "ล้างให้ว่าง") */
const FIELD_COL = {
  contactDate: 'วันที่ติดต่อ',
  company:     'ชื่อบริษัท',
  contact:     'ชื่อผู้ติดต่อ',
  phone:       'เบอร์ติดต่อ',
  custType:    'ประเภทลูกค้า',
  source:      'ลูกค้ามาจากไหน',
  method:      'วิธีติดต่อ',
  platform:    'ชื่อช่อง / Platform',
  leadStatus:  'Lead Status',
  note:        'หมายเหตุ',
  closeDate:   'วันที่ปิดการขาย',
  maker:       'ผู้ผลิต',
  outsource:   'ยอดสั่งซื้อ (Outsource)',
  quote:       'ยอดประเมินราคา',
  qoiv:        'เลขที่ QO / IV',
  sale:        'ยอดขาย (บาท)',
  payNote:     'หมายเหตุชำระเงิน',
  billed:      'ยอดเรียกเก็บ (บาท)',
  received:    'รับจริง (บาท)',
  shortfall:   'รับขาด (บาท)',
  payDate:     'วันที่โอน',
  slip:        'เลขสลิป',
  payAmt:      'ยอด (บาท)',
  payDate1:    'วันที่โอน งวด 1',
  slip1:       'เลขสลิป งวด 1',
  payAmt1:     'ยอด งวด 1 (บาท)',
  payDate2:    'วันที่โอน งวด 2',
  slip2:       'เลขสลิป งวด 2',
  payAmt2:     'ยอด งวด 2 (บาท)',
  payDate3:    'วันที่โอน งวด 3',
  slip3:       'เลขสลิป งวด 3',
  payAmt3:     'ยอด งวด 3 (บาท)',
  contactId:   'Contact ID',
  docUrl:      'ลิงก์เอกสาร PEAK',
};

/** ช่องที่เป็นตัวเลข — เขียนลงชีตเป็นตัวเลขจริง ไม่ใช่ข้อความ */
const MONEY_FIELDS = new Set(['outsource', 'quote', 'sale', 'billed', 'received', 'shortfall',
  'payAmt', 'payAmt1', 'payAmt2', 'payAmt3']);

/* ─── ด่านตรวจก่อนบันทึก — ถอดจาก saveForm()+saveRecord() ──────────
 *  ข้อความ error ยกมาคำต่อคำ ทีมจะได้เห็นเหมือนเดิมเป๊ะ */
function validate(f) {
  if (!clean(f.company) || !clean(f.contact) || !clean(f.phone))
    return 'กรอกชื่อผู้ติดต่อ / บริษัท / เบอร์ ให้ครบก่อนบันทึก';

  const miss = [];
  if (!clean(f.biz))      miss.push('บริษัทที่ขาย');
  if (!clean(f.source))   miss.push('ลูกค้ามาจากไหน');
  if (!clean(f.platform)) miss.push('ชื่อช่อง / Platform');
  if (!clean(f.maker))    miss.push('ผู้ผลิต');
  if (miss.length) return 'กรุณาเลือก ' + miss.join(' และ ') + ' ก่อนบันทึก';

  /* กันเลือกช่องทางผิด — เคสที่ทำให้ยอดสาขาเพี้ยนมาแล้ว (code.gs:5176) */
  if (/สาขา/.test(clean(f.source)) && !/สาขา/.test(clean(f.platform)))
    return 'เลือกช่องทางผิด: "ลูกค้ามาจากไหน"=สาขา แต่ "ชื่อช่อง/Platform" ไม่ใช่สาขา — ' +
           'กรุณาเลือกช่องทางสาขาให้ถูกต้องก่อนบันทึก';

  if (clean(f.jobCode) && !/^[A-Za-z0-9ก-๙._\-\/]+$/.test(clean(f.jobCode)))
    return `รหัสงาน "${clean(f.jobCode)}" มีอักขระที่ใช้ไม่ได้ ` +
           '(ห้ามเว้นวรรค — ใช้ได้เฉพาะตัวอักษร ตัวเลข และ - _ . /)';
  return null;
}

/* ─── คำนวณซ้ำฝั่งเซิร์ฟเวอร์ — ไม่เชื่อตัวเลขจากหน้าจอ ───────────
 *  recalcMoney() Index.html:14075 · ผลิตเอง→Outsource=0 code.gs:6855 */
function recompute(f) {
  const received = num(f.payAmt) + num(f.payAmt1) + num(f.payAmt2) + num(f.payAmt3);
  const billed = num(f.billed);
  const shortfall = Math.max(0, billed - received);
  const r2 = n => Math.round(n * 100) / 100;
  return {
    ...f,
    received:  received ? r2(received) : '',
    shortfall: (billed || received) ? r2(shortfall) : '',
    outsource: /ผลิตเอง/.test(clean(f.maker)) ? 0 : f.outsource,
    biz: bizNorm(f.biz),
  };
}

/** คำนำหน้ารหัสงานของผู้ใช้คนนี้ (ตาราง app.sales_prefix — ไม่มีก็ใช้ username) */
async function prefixOf(username) {
  const u = clean(username);
  if (!u) return 'XX';
  try {
    const rows = await db.select('sales_prefix',
      { username: 'ilike.' + u, select: 'prefix', limit: 1 });
    if (rows && rows[0] && rows[0].prefix) return rows[0].prefix;
  } catch { /* ทะเบียนยังไม่มี = ใช้ username ต่อไป ไม่บล็อกการบันทึก */ }
  return u.toUpperCase().slice(0, 6);
}

/* ═══════════════════════════════════════════════════════════════════
 *  บันทึก 1 รายการ (เพิ่มใหม่ หรือ แก้ไข)
 *  คืน { ok, row, code, msg }
 * ═══════════════════════════════════════════════════════════════════ */
async function saveRecord(user, form) {
  const err = validate(form);
  if (err) { const e = new Error(err); e.userError = true; throw e; }

  const f = recompute(form);
  const isEdit = Number(f.row) > 1;

  /* 1) อ่านหัวคอลัมน์จริงของชีต — ต้องรู้ลำดับก่อนถึงจะประกอบแถวได้ */
  const { header } = await sheets.readHead(SHEET_ID, SHEET_TAB, 2);
  if (!header.length) throw new Error('อ่านหัวตารางในชีตไม่ได้ — ยังไม่บันทึกอะไรทั้งนั้น');
  const pos = {};
  header.forEach((h, i) => { if (h) pos[h] = i; });
  const at = name => (pos[name] === undefined ? -1 : pos[name]);

  /* 2) ค่าที่จะเขียน — ชื่อคอลัมน์ → ค่า */
  const set = {};
  for (const [k, col] of Object.entries(FIELD_COL)) {
    if (f[k] === undefined) continue;
    set[col] = MONEY_FIELDS.has(k)
      ? (clean(f[k]) === '' ? '' : num(f[k]))
      : clean(f[k]);
  }
  set['บริษัทที่ขาย'] = f.biz;
  set['วันที่อัพเดต']  = dsNow();          // เซิร์ฟเวอร์เติมเอง หน้าจอไม่ส่งมา
  set['Updated At']  = nowISO();

  const who = clean(user && (user.nickname || user.name || user.username)) || 'ไม่ระบุ';
  const uname = clean(user && user.username);

  let jobCode = clean(f.jobCode);
  let rowNo;

  if (!isEdit) {
    /* ── เพิ่มใหม่ ─────────────────────────────────────────────────
     *  รหัสงานออกจากทะเบียนกลาง (app.next_job_code) ไม่ใช่ไล่นับในชีต
     *  ทะเบียนกันเลขซ้ำด้วย PRIMARY KEY — คนละคนกดพร้อมกันก็ไม่ชนกัน */
    if (!jobCode) {
      const pfx = await prefixOf(uname);
      const r = await db.rpc('next_job_code',
        { p_prefix: pfx, p_module: 'sales', p_issued_by: uname || who });
      jobCode = Array.isArray(r) ? r[0] : r;
      if (typeof jobCode === 'object' && jobCode !== null) jobCode = jobCode.next_job_code;
      jobCode = clean(jobCode);
    } else {
      await db.rpc('claim_job_code',
        { p_code: jobCode, p_module: 'sales', p_note: 'คีย์มือจากหน้าเว็บ' }).catch(() => {});
    }
    set['รหัสงาน']    = jobCode;
    set['Created At'] = nowISO();
    set['Sales Code'] = uname;
    set['Sales Name'] = clean(user && user.name);
    if (at('Create By')  > -1) set['Create By']  = who;
    if (at('Created By') > -1) set['Created By'] = who;
    /* เลขสลิปเว้นว่าง → เติมรหัสงานให้ (code.gs:5488) */
    if (!clean(set['เลขสลิป'])) set['เลขสลิป'] = jobCode;

    const values = new Array(header.length).fill('');
    for (const [col, v] of Object.entries(set)) {
      const i = at(col);
      if (i > -1) values[i] = v;
    }
    const res = await sheets.appendRow(SHEET_ID, SHEET_TAB, values);
    rowNo = res.row;

  } else {
    /* ── แก้ไข ────────────────────────────────────────────────────
     *  อ่านแถวเดิมมาก่อน แล้วทับเฉพาะช่องที่ฟอร์มส่งมา
     *  ‼ ห้ามเขียนทับทั้งแถวจากค่าว่าง ไม่งั้นคอลัมน์ PEAK/ติดตามเก็บเงินหายหมด */
    rowNo = Number(f.row);
    const cur = await sheets.readRow(SHEET_ID, SHEET_TAB, rowNo);

    /* ยืนยันว่าแถวนี้คือใบเดิมจริง — ชีตอาจถูกแทรก/ลบแถวระหว่างที่เปิดฟอร์มค้างไว้ */
    const iJob = at('รหัสงาน');
    const curJob = iJob > -1 ? clean(cur[iJob]) : '';
    if (clean(f.jobCodeRef) && curJob && clean(f.jobCodeRef) !== curJob) {
      const e = new Error(`แถวในชีตเปลี่ยนไปแล้ว (แถว ${rowNo} ตอนนี้เป็น "${curJob}" ` +
                          `ไม่ใช่ "${clean(f.jobCodeRef)}") — กรุณารีเฟรชหน้าจอแล้วแก้ใหม่`);
      e.userError = true; throw e;
    }
    jobCode = curJob || jobCode;

    const values = header.map((_, i) => (cur[i] === undefined ? '' : cur[i]));
    for (const [col, v] of Object.entries(set)) {
      const i = at(col);
      if (i > -1) values[i] = v;
    }
    /* ผู้สร้างเดิมต้องไม่ถูกทับ — เติมให้เฉพาะตอนที่ยังว่าง (code.gs:5352) */
    for (const c of ['Create By', 'Created By']) {
      const i = at(c);
      if (i > -1 && !clean(values[i])) values[i] = who;
    }
    await sheets.updateRow(SHEET_ID, SHEET_TAB, rowNo, values);
  }

  /* 3) ตามลงฐานข้อมูลทันที เพื่อให้หน้าจอเห็นผลโดยไม่ต้องรอรอบซิงค์
   *    พลาดตรงนี้ไม่ใช่เรื่องคอขาดบาดตาย — ของอยู่ในชีตแล้ว รอบหน้าเก็บให้เอง */
  let dbWarn = '';
  try {
    await mirrorToDb(rowNo, set, jobCode, isEdit);
  } catch (e) {
    dbWarn = 'บันทึกลงชีตเรียบร้อย แต่ยังไม่ทันขึ้นในฐานข้อมูล (' + e.message + ') — ' +
             'รอบซิงค์ถัดไปจะเก็บให้เอง';
  }

  /* 4) จดกิจกรรม — ล้มก็ช่าง ไม่ให้กระทบการบันทึก */
  try {
    await db.insert('activity_log', [{
      Time: nowISO(), Username: uname, Nickname: who,
      Action: isEdit ? 'แก้ไข' : 'เพิ่ม',
      'รหัสงาน': jobCode, Company: clean(f.company), Contact: clean(f.contact),
      Phone: clean(f.phone),
    }]);
  } catch { /* ไม่เป็นไร */ }

  return {
    ok: true, row: rowNo, code: jobCode,
    msg: isEdit ? 'แก้ไขรายการแล้ว' : 'บันทึกรายการใหม่แล้ว',
    warn: dbWarn || undefined,
  };
}

/** เขียนกระจกลงฐานข้อมูล — ให้ตรงกับที่เพิ่งเขียนลงชีต */
async function mirrorToDb(rowNo, set, jobCode, isEdit) {
  /* วันที่ในชีตเป็น dd/MM/yyyy · ฐานข้อมูลต้องการ yyyy-mm-dd */
  const toISO = v => {
    const s = clean(v); if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
    return m ? `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}` : null;
  };
  const DATE_COLS = new Set(['วันที่ติดต่อ', 'วันที่อัพเดต', 'วันที่ปิดการขาย', 'วันที่โอน',
    'วันที่โอน งวด 1', 'วันที่โอน งวด 2', 'วันที่โอน งวด 3']);

  const rec = { _row: rowNo, _synced_at: nowISO() };
  for (const [col, v] of Object.entries(set)) {
    rec[col] = DATE_COLS.has(col) ? toISO(v) : (v === '' ? null : v);
  }
  if (jobCode) rec['รหัสงาน'] = jobCode;

  const cur = await db.one('total_sales', { _row: 'eq.' + rowNo, select: '_id' });
  if (cur) await db.update('total_sales', { _row: 'eq.' + rowNo }, rec);
  else     await db.insert('total_sales', [rec]);
}

module.exports = { saveRecord, validate, recompute, bizNorm, dsNow, FIELD_COL, prefixOf };
