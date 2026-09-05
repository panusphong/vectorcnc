'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  ทดสอบ "ทางเขียน" ตั้งแต่ต้นจนจบ — npm run test:save
 *
 *  สลับ core/sheets.js เป็นตัวปลอมที่จำทุกคำสั่งไว้ แล้วเรียก saveRecord จริง
 *  จะได้เห็นว่าเขียนอะไรลงชีตกี่ช่อง ตำแหน่งไหน และตามลงฐานข้อมูลตรงไหม
 *
 *  ‼ เทสต์ชุดนี้มีไว้จับบั๊กที่ "ตาไม่เห็น" โดยเฉพาะ:
 *      · ค่าไปลงผิดคอลัมน์ (เลื่อนหนึ่งช่อง = ยอดเงินไปอยู่ช่องเบอร์โทร)
 *      · เขียนทับคอลัมน์ PEAK ที่ไม่ควรแตะตอนแก้ไข
 *      · วันที่ลงชีตคนละรูปแบบกับที่ฐานข้อมูลต้องการ
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const { Client } = require('pg');

const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:55432/postgres';
const REST_PORT = 55461;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

process.env.SUPABASE_URL = `http://127.0.0.1:${REST_PORT}`;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = 'd'.repeat(64);

/* ─── ชีตปลอม — จำหัวคอลัมน์จริงของ TotalSales ไว้ตามลำดับ ───────── */
const HEADER = [
  'Alert', 'รหัสงาน', 'เลขที่ QO / IV', 'บริษัทที่ขาย', 'วันที่ติดต่อ', 'ชื่อบริษัท',
  'ชื่อลูกค้า PEAK', 'ชื่อผู้ติดต่อ', 'เบอร์ติดต่อ', 'ประเภทลูกค้า', 'ลูกค้ามาจากไหน',
  'วิธีติดต่อ', 'ชื่อช่อง / Platform', 'Lead Status', 'วันที่อัพเดต', 'หมายเหตุ',
  'วันที่ปิดการขาย', 'ผู้ผลิต', 'ยอดสั่งซื้อ (Outsource)', 'ยอดประเมินราคา',
  'ยอดขาย (บาท)', 'ยอดขาย PEAK', 'ตรวจยอด', 'หมายเหตุชำระเงิน', 'ยอดเรียกเก็บ (บาท)',
  'รับจริง (บาท)', 'รับขาด (บาท)', 'วันที่โอน', 'เลขสลิป', 'ยอด (บาท)',
  'วันที่โอน งวด 1', 'เลขสลิป งวด 1', 'ยอด งวด 1 (บาท)',
  'วันที่โอน งวด 2', 'เลขสลิป งวด 2', 'ยอด งวด 2 (บาท)',
  'วันที่โอน งวด 3', 'เลขสลิป งวด 3', 'ยอด งวด 3 (บาท)',
  'Sales Code', 'Sales Name', 'Contact ID', 'Created At', 'Updated At', 'Create By',
  'สถานะชำระ PEAK', 'รับชำระแล้ว PEAK', 'ลิงก์เอกสาร PEAK', 'สถานะซิงก์ PEAK',
];

const SHEET = { rows: {}, calls: [], nextRow: 100 };
const fakeSheets = {
  isConfigured: () => true,
  async readHead() { SHEET.calls.push('readHead'); return { header: HEADER, rows: [] }; },
  async readRow(_id, _tab, n) { SHEET.calls.push('readRow'); return SHEET.rows[n] || []; },
  async appendRow(_id, _tab, values) {
    SHEET.calls.push('appendRow');
    const r = SHEET.nextRow++;
    SHEET.rows[r] = values.slice();
    return { row: r, range: `TotalSales!A${r}:AW${r}` };
  },
  async updateRow(_id, _tab, n, values) {
    SHEET.calls.push('updateRow');
    SHEET.rows[n] = values.slice();
    return { row: n };
  },
  colName(n) { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s || 'A'; },
};
require.cache[require.resolve('../core/sheets')] = { id: 'sheets', filename: 'sheets', loaded: true, exports: fakeSheets };

const db = require('../core/db');
const save = require('../modules/sales/save.js');

const cell = (row, name) => (SHEET.rows[row] || [])[HEADER.indexOf(name)];

(async () => {
  console.log('\n🧪 ทดสอบทางเขียน (คีย์รายการใหม่ / แก้ไข)\n');

  const pg = new Client({ connectionString: PG });
  await pg.connect();
  await pg.query('truncate app.total_sales');
  await pg.query("delete from app.job_code where module = 'sales'");
  await pg.query("delete from app.job_code_seq");
  await pg.query("delete from app.sheet_headers where source = 'sales'");
  await pg.query(`insert into app.sales_prefix (prefix, username, nickname)
                  values ('QW','papassorn','แว่น') on conflict (prefix) do nothing`);

  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  const user = { username: 'papassorn', name: 'Papassorn', nickname: 'แว่น', role: 'USER' };

  try {
    /* ── 1) เพิ่มรายการใหม่ ── */
    console.log('1) คีย์รายการใหม่');
    const form = {
      contactDate: '2026-09-05', company: 'บริษัท ทดสอบ จำกัด', contact: 'คุณเอ',
      phone: '0812345678', custType: 'ลูกค้าใหม่', source: 'Online', method: 'แชท',
      platform: 'LINE@THE101', biz: 'The 101', leadStatus: 'ปิดการขาย',
      closeDate: '2026-09-05', maker: 'ผลิตเอง-The101', qoiv: 'IV-2026090500001',
      quote: '', outsource: '9999', sale: '50000', billed: '50000',
      payAmt: '20000', payDate: '2026-09-05', slip: '',
      payAmt1: '5000', payDate1: '2026-09-06', slip1: 'SL-1',
      note: 'งานทดสอบ', payNote: '', docUrl: 'https://peak.example/iv/1',
    };
    const r1 = await save.saveRecord(user, form);
    ok(r1.ok, 'บันทึกสำเร็จ');
    ok(!r1.warn, 'ไม่มีคำเตือน (ตามลงฐานข้อมูลได้ด้วย)' + (r1.warn ? ' — ' + r1.warn : ''));
    ok(/^QW\d{4}[-/]\d{3}$/.test(r1.code), 'ได้รหัสงานรูปแบบถูก (ได้ ' + r1.code + ')');
    ok(SHEET.calls.includes('appendRow'), 'เรียก appendRow จริง');

    const R = r1.row;
    ok(SHEET.rows[R].length === HEADER.length,
       'แถวที่เขียนยาวเท่าหัวตารางพอดี ' + HEADER.length + ' ช่อง (ได้ ' + SHEET.rows[R].length + ')');

    /* ค่าต้องลงตรงคอลัมน์ — ข้อนี้คือหัวใจ เลื่อนช่องเดียวคือยอดเงินไปอยู่ช่องเบอร์โทร */
    ok(cell(R, 'รหัสงาน') === r1.code, 'รหัสงานลงช่อง "รหัสงาน"');
    ok(cell(R, 'ชื่อบริษัท') === 'บริษัท ทดสอบ จำกัด', 'ชื่อบริษัทลงถูกช่อง');
    ok(cell(R, 'เบอร์ติดต่อ') === '0812345678', 'เบอร์ติดต่อลงถูกช่อง (ยังเป็นข้อความ ไม่ใช่ตัวเลข)');
    ok(cell(R, 'ยอดขาย (บาท)') === 50000, 'ยอดขายลงเป็น "ตัวเลข" ไม่ใช่ข้อความ (ได้ ' + JSON.stringify(cell(R, 'ยอดขาย (บาท)')) + ')');
    ok(cell(R, 'บริษัทที่ขาย') === 'The 101', 'บริษัทที่ขายลงถูกช่อง');
    ok(cell(R, 'เลขที่ QO / IV') === 'IV-2026090500001', 'เลขที่ QO/IV ลงถูกช่อง');

    /* สูตรเงิน */
    ok(cell(R, 'รับจริง (บาท)') === 25000, 'รับจริง = 20,000 + 5,000 (ได้ ' + cell(R, 'รับจริง (บาท)') + ')');
    ok(cell(R, 'รับขาด (บาท)') === 25000, 'รับขาด = 50,000 − 25,000');
    ok(cell(R, 'ยอดสั่งซื้อ (Outsource)') === 0,
       '‼ ผลิตเอง → Outsource ถูกบังคับเป็น 0 แม้หน้าจอส่ง 9999 มา');

    /* เลขสลิปเว้นว่าง → เติมรหัสงานให้ (code.gs:5488) */
    ok(cell(R, 'เลขสลิป') === r1.code, 'เลขสลิปเว้นว่าง → เติมรหัสงานให้อัตโนมัติ');
    ok(cell(R, 'เลขสลิป งวด 1') === 'SL-1', 'เลขสลิปงวด 1 ที่กรอกมาไม่ถูกทับ');

    /* ค่าที่เซิร์ฟเวอร์เติมเอง */
    ok(/^\d{2}\/\d{2}\/\d{4}$/.test(String(cell(R, 'วันที่อัพเดต'))),
       'วันที่อัพเดตเป็น dd/MM/yyyy (ได้ ' + cell(R, 'วันที่อัพเดต') + ')');
    ok(cell(R, 'Sales Code') === 'papassorn', 'Sales Code = username');
    ok(cell(R, 'Create By') === 'แว่น', 'Create By = ชื่อเล่นผู้บันทึก');
    ok(!!cell(R, 'Created At'), 'มี Created At');

    /* ‼ ห้ามแตะช่อง PEAK */
    for (const c of ['ชื่อลูกค้า PEAK', 'ยอดขาย PEAK', 'ตรวจยอด', 'สถานะชำระ PEAK',
                     'รับชำระแล้ว PEAK', 'สถานะซิงก์ PEAK'])
      ok(cell(R, c) === '', '‼ ไม่แตะช่อง "' + c + '"');
    ok(cell(R, 'ลิงก์เอกสาร PEAK') === 'https://peak.example/iv/1',
       'ลิงก์เอกสาร PEAK เขียนได้ (เซลส์วางเอง ไม่ได้คุยกับ PEAK)');

    /* ── 2) กระจกในฐานข้อมูล ── */
    console.log('\n2) กระจกในฐานข้อมูล');
    const q1 = await pg.query('select * from app.total_sales where _row = $1', [R]);
    ok(q1.rows.length === 1, 'มีแถวในฐานข้อมูล 1 แถว');
    const d = q1.rows[0] || {};
    ok(d['รหัสงาน'] === r1.code, 'รหัสงานตรงกัน');
    ok(Number(d['ยอดขาย (บาท)']) === 50000, 'ยอดขายตรงกัน');
    ok(Number(d['รับจริง (บาท)']) === 25000, 'รับจริงตรงกัน');
    /* pg คืนคอลัมน์ date เป็น Date object — เทียบเป็น yyyy-mm-dd ตามเวลาไทย */
    const ymd = v => (v instanceof Date)
      ? new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(v)
      : String(v || '').slice(0, 10);
    ok(ymd(d['วันที่ติดต่อ']) === '2026-09-05',
       '‼ วันที่ลงฐานข้อมูลเป็นวันเดียวกับที่คีย์ (ได้ ' + ymd(d['วันที่ติดต่อ']) + ')');
    ok(/^\d{4}-\d{2}-\d{2}$/.test(ymd(d['วันที่อัพเดต'])),
       '‼ วันที่อัพเดตที่ลงชีตเป็น dd/MM/yyyy ถูกแปลงเป็นวันที่จริงก่อนลงฐานข้อมูล ' +
       '(ได้ ' + ymd(d['วันที่อัพเดต']) + ')');
    ok(d['เบอร์ติดต่อ'] === '0812345678', 'เบอร์ติดต่อไม่เพี้ยน');

    /* ── 3) รหัสงานห้ามซ้ำ ── */
    console.log('\n3) รหัสงานห้ามซ้ำ');
    const r2 = await save.saveRecord(user, { ...form, contact: 'คุณบี', company: 'บ.สอง' });
    ok(r2.code !== r1.code, 'ใบที่สองได้รหัสใหม่ (' + r1.code + ' → ' + r2.code + ')');
    const seq = await pg.query('select count(*)::int n from app.job_code');
    ok(seq.rows[0].n >= 2, 'ทะเบียนรหัสงานจดครบ ' + seq.rows[0].n + ' รหัส');

    /* ── 4) แก้ไข — ห้ามล้างช่องที่ฟอร์มไม่ได้ส่งมา ── */
    console.log('\n4) แก้ไขรายการเดิม');
    /* จำลองว่ารอบซิงค์ PEAK เติมค่าลงชีตไว้แล้ว */
    SHEET.rows[R][HEADER.indexOf('ยอดขาย PEAK')] = 50000;
    SHEET.rows[R][HEADER.indexOf('ตรวจยอด')] = '✅ ตรง';
    SHEET.rows[R][HEADER.indexOf('ชื่อลูกค้า PEAK')] = 'บริษัท ทดสอบ จำกัด';
    SHEET.rows[R][HEADER.indexOf('สถานะชำระ PEAK')] = 'ชำระบางส่วน';

    const r3 = await save.saveRecord(user, {
      ...form, row: R, jobCodeRef: r1.code,
      sale: '60000', billed: '60000', payAmt2: '10000', payDate2: '2026-09-07',
    });
    ok(r3.ok && r3.row === R, 'แก้ไขแถวเดิม (แถว ' + r3.row + ')');
    ok(SHEET.calls.includes('updateRow'), 'เรียก updateRow ไม่ใช่ appendRow');
    ok(cell(R, 'ยอดขาย (บาท)') === 60000, 'ยอดขายอัปเดตเป็น 60,000');
    ok(cell(R, 'รับจริง (บาท)') === 35000, 'รับจริงคิดใหม่ = 20,000+5,000+10,000');
    ok(cell(R, 'รหัสงาน') === r1.code, 'รหัสงานเดิมไม่ถูกเปลี่ยน');

    /* ‼ ข้อสำคัญที่สุดของโหมดแก้ไข */
    ok(cell(R, 'ยอดขาย PEAK') === 50000, '‼ ค่า PEAK ที่ซิงค์ไว้ยังอยู่ ไม่ถูกล้าง');
    ok(cell(R, 'ตรวจยอด') === '✅ ตรง', '‼ ผลตรวจยอด PEAK ยังอยู่');
    ok(cell(R, 'ชื่อลูกค้า PEAK') === 'บริษัท ทดสอบ จำกัด', '‼ ชื่อลูกค้า PEAK ยังอยู่');
    ok(cell(R, 'สถานะชำระ PEAK') === 'ชำระบางส่วน', '‼ สถานะชำระ PEAK ยังอยู่');
    ok(cell(R, 'Created At') !== '', 'Created At เดิมไม่ถูกล้าง');

    const q2 = await pg.query('select * from app.total_sales where _row = $1', [R]);
    ok(Number(q2.rows[0]['ยอดขาย (บาท)']) === 60000, 'ฐานข้อมูลอัปเดตตามด้วย');
    const cnt = await pg.query('select count(*)::int n from app.total_sales where _row = $1', [R]);
    ok(cnt.rows[0].n === 1, '‼ แก้ไขแล้วไม่เกิดแถวซ้ำในฐานข้อมูล');

    /* ── 5) กันแก้ผิดแถว ── */
    console.log('\n5) กันแก้ผิดแถว');
    let caught = '';
    try {
      await save.saveRecord(user, { ...form, row: R, jobCodeRef: 'QW9999/999' });
    } catch (e) { caught = e.message; }
    ok(/แถวในชีตเปลี่ยนไปแล้ว/.test(caught),
       '‼ รหัสงานอ้างอิงไม่ตรงกับแถวจริง → หยุดทันที ไม่เขียนทับ');

    /* ── 6) ด่านตรวจต้องหยุดก่อนแตะชีต ── */
    console.log('\n6) ฟอร์มไม่ครบ = ห้ามแตะชีตเลย');
    const before = SHEET.calls.length;
    let err2 = '';
    try { await save.saveRecord(user, { ...form, company: '' }); }
    catch (e) { err2 = e.message; }
    ok(/กรอกชื่อผู้ติดต่อ/.test(err2), 'เตือนข้อความเดิม');
    ok(SHEET.calls.length === before, '‼ ไม่มีคำสั่งไปถึงชีตเลยแม้แต่ครั้งเดียว');

  } finally {
    await rest.close().catch(() => {});
    await pg.end();
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log(`ผ่าน ${pass} · ไม่ผ่าน ${fail}`);
  console.log('════════════════════════════════════════════════════\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
