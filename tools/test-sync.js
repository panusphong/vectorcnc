'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  ทดสอบการซิงค์ ชีต → ฐานข้อมูล — npm run test:sync
 *
 *  จำลอง Google Sheets API ด้วยข้อมูลปลอม แล้วพิสูจน์ว่า:
 *    · แถวใหม่เข้า · แถวแก้ไขอัปเดต · แถวไม่เปลี่ยนถูกข้าม
 *    · แถวที่ถูกลบในชีต หายจากฐานข้อมูลตาม
 *    · รันซ้ำได้ผลเท่าเดิม (idempotent)
 *    · แปลงวันที่/ตัวเลขไทยถูกต้อง — รวม พ.ศ. → ค.ศ.
 *    · รหัสงานจากชีตถูกจดเข้าทะเบียน แล้วตัวออกเลขไม่แจกทับ
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const { Client } = require('pg');

const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:55432/postgres';
const REST_PORT = 55453;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

/* ── ชีตปลอม: แทนที่ core/sheets.js ก่อนที่ใครจะ require ── */
const FAKE = { header: [], rows: [] };
require.cache[require.resolve('../core/sheets.js')] = {
  id: require.resolve('../core/sheets.js'),
  filename: require.resolve('../core/sheets.js'),
  loaded: true,
  exports: {
    isConfigured: () => true,
    listTabs: async () => [{ title: 'ทดสอบ' }],
    readTab: async () => ({ header: FAKE.header.slice(), rows: FAKE.rows.map(r => r.slice()) }),
  },
};

process.env.SUPABASE_URL = `http://127.0.0.1:${REST_PORT}`;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = 'c'.repeat(64);

const sync = require('../core/sync');
const db = require('../core/db');

/** วันที่ → เลขซีเรียลแบบ Google Sheets */
const toSerial = (y, m, d) =>
  Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);

const COLUMNS = {
  'รหัสงาน':          'text',
  'ชื่อบริษัท':        'text',
  'วันที่ปิดการขาย':   'date',
  'ยอดขาย (บาท)':     'numeric',
  'Lead Status':      'text',
};

(async () => {
  console.log('\n🧪 ทดสอบการซิงค์ Google Sheets → PostgreSQL\n');

  const pg = new Client({ connectionString: PG });
  await pg.connect();
  await pg.query('truncate app.total_sales, app.sync_run, app.job_code, app.job_code_seq');

  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  const quiet = () => {};
  const run = () => sync.syncSheet({
    name: 'sales', sheetId: 'fake', tab: 'ทดสอบ', table: 'total_sales',
    columns: COLUMNS, log: quiet,
    afterRows: require('../core/sync-jobs').claimJobCodes,
  });
  const rows = async () => (await pg.query(
    'select * from app.total_sales order by _row')).rows;

  try {
    /* ── 1) ซิงค์ครั้งแรก ── */
    console.log('1) ซิงค์ครั้งแรก');
    FAKE.header = Object.keys(COLUMNS);
    FAKE.rows = [
      ['B2K2609/001', 'บริษัท ก',  toSerial(2026, 9, 1), 15000,   'ปิดการขาย'],
      ['B2K2609/002', 'บริษัท ข',  toSerial(2026, 9, 2), '25,500', 'ปิดการขาย'],
      ['',            'บริษัท ค',  '',                   '',       'กำลังคุย'],
    ];
    let r = await run();
    ok(r.ok, 'ซิงค์สำเร็จ');
    ok(r.rows_new === 3 && r.rows_upd === 0, 'เพิ่มใหม่ 3 แถว');

    let d = await rows();
    ok(d.length === 3, 'ฐานข้อมูลมี 3 แถว');
    ok(d[0]['ชื่อบริษัท'] === 'บริษัท ก', 'ข้อความไทยเข้าถูกต้อง');
    ok(String(d[0]['วันที่ปิดการขาย'].toISOString().slice(0, 10)) === '2026-09-01',
       'เลขซีเรียลของชีต → วันที่จริง');
    ok(Number(d[1]['ยอดขาย (บาท)']) === 25500, 'ตัวเลขมีคอมมา "25,500" → 25500');
    ok(d[2]['วันที่ปิดการขาย'] === null && d[2]['ยอดขาย (บาท)'] === null,
       'ช่องว่าง → null (ไม่ใช่ค่าว่างที่ทำให้ทั้งแถวตก)');
    ok(d.every(x => x._row >= 2), 'เก็บเลขแถวของชีตไว้ (_row เริ่มที่ 2)');

    /* ── 2) รันซ้ำโดยไม่แก้อะไร ── */
    console.log('\n2) รันซ้ำโดยชีตไม่เปลี่ยน');
    r = await run();
    ok(r.rows_same === 3 && r.rows_new === 0 && r.rows_upd === 0,
       'ข้ามทั้ง 3 แถว ไม่เขียนซ้ำโดยเปล่าประโยชน์');
    ok((await rows()).length === 3, 'จำนวนแถวเท่าเดิม (idempotent)');

    /* ── 3) แก้ 1 แถว เพิ่ม 1 แถว ── */
    console.log('\n3) แก้ไขในชีตแล้วซิงค์ใหม่');
    FAKE.rows[1][3] = 30000;                                   // แก้ยอดขาย
    FAKE.rows.push(['B2K2609/003', 'บริษัท ง', toSerial(2026, 9, 4), 8000, 'ปิดการขาย']);
    r = await run();
    ok(r.rows_upd === 1 && r.rows_new === 1 && r.rows_same === 2,
       'แก้ 1 · เพิ่ม 1 · เท่าเดิม 2 — แยกออกถูกต้อง');
    d = await rows();
    ok(Number(d[1]['ยอดขาย (บาท)']) === 30000, 'ค่าที่แก้ถูกอัปเดตจริง');

    /* ── 4) ลบแถวในชีต ── */
    console.log('\n4) ลบแถวท้ายในชีต');
    FAKE.rows.pop();
    r = await run();
    ok(r.rows_del === 1, 'ตรวจพบแถวที่หายไป 1 แถว');
    ok((await rows()).length === 3, 'ฐานข้อมูลลบตาม — กระจกตรงกับชีต');

    /* ── 5) รหัสงานถูกจดเข้าทะเบียนกันซ้ำ ── */
    console.log('\n5) รหัสงานจากชีตเข้าทะเบียนกันซ้ำ');
    const jc = await pg.query(`select code from app.job_code order by code`);
    ok(jc.rows.every(x => x.code.trim() !== ''), 'แถวที่ไม่มีรหัสงาน ไม่ถูกจด');
    ok(jc.rows.map(x => x.code).join(',') === 'B2K2609/001,B2K2609/002,B2K2609/003',
       'จดครบทุกรหัสที่เคยปรากฏในชีต — รวม 003 ที่ถูกลบไปแล้วในข้อ 4');

    const nxt = await pg.query(
      `select app.next_job_code('B2K','sales','tester','/','2609') as c`);
    ok(nxt.rows[0].c === 'B2K2609/004',
       'ออกรหัสถัดไป = 004 ← หัวใจของการกันซ้ำ');
    /* ‼ จุดสำคัญ: 003 ถูกลบออกจากชีตไปแล้ว แต่ระบบ "ไม่เอาเลขกลับมาใช้ซ้ำ"
     *   ถ้าเอากลับมาใช้ จะกลายเป็นว่ามีเอกสาร/สลิป/ใบสั่งผลิตเก่าที่อ้างถึง 003
     *   แล้วชี้ไปหางานคนละใบ — เจ็บกว่าเลขข้ามมาก
     *   นี่คือพฤติกรรมที่ตั้งใจ ไม่ใช่บั๊ก */
    ok(true, 'เลขที่เคยใช้แล้วไม่ถูกนำกลับมาใช้ซ้ำ แม้แถวจะถูกลบจากชีต');

    /* ── 6) บันทึกผลการซิงค์ ── */
    console.log('\n6) บันทึกผลการซิงค์');
    const runs = await pg.query(`select * from app.sync_run order by _id`);
    ok(runs.rows.length === 4, 'จดผลครบทั้ง 4 รอบ');
    ok(runs.rows.every(x => x.ok === true), 'ทุกรอบสำเร็จ');
    ok(runs.rows.every(x => x.finished_at && x.ms >= 0), 'มีเวลาเริ่ม-จบ และระยะเวลาครบ');
    const st = await pg.query(`select * from app.v_sync_status where source='sales'`);
    ok(st.rows.length === 1 && st.rows[0].ok === true, 'วิวสถานะล่าสุดอ่านได้');

    /* ── 7) ชีตพัง ต้องไม่ทำลายข้อมูลเดิม ── */
    console.log('\n7) ชีตพัง — ข้อมูลเดิมต้องปลอดภัย');
    const before = await rows();
    FAKE.header = ['อะไรไม่รู้', 'มั่วมาก'];
    FAKE.rows = [['x', 'y']];
    r = await run();
    ok(!r.ok, 'หัวตารางไม่ตรง → ปฏิเสธทั้งรอบ');
    const after = await rows();
    ok(after.length === before.length, 'ข้อมูลเดิมยังอยู่ครบ ไม่ถูกลบทิ้ง');
    const bad = await pg.query(`select * from app.sync_run where ok = false`);
    ok(bad.rows.length === 1 && /หัวตาราง/.test(bad.rows[0].error || ''),
       'บันทึกสาเหตุที่พังไว้ให้ไล่ย้อนได้');

    /* ── 8) แปลงวันที่แบบไทย ── */
    console.log('\n8) แปลงวันที่แบบไทย');
    ok(sync.coerce('01/09/2569', 'date') === '2026-09-01', 'พ.ศ. 2569 → ค.ศ. 2026');
    ok(sync.coerce('2026-09-01', 'date') === '2026-09-01', 'รูปแบบ ISO ผ่านตรง ๆ');
    ok(sync.coerce('อ่านไม่ออก', 'date') === null, 'อ่านไม่ออก → null (ไม่เดามั่ว)');
    ok(sync.coerce('  ', 'numeric') === null, 'ช่องว่าง → null');
    ok(sync.coerce('฿1,234.50', 'numeric') === 1234.5, 'ตัด ฿ และคอมมาออก');
    ok(sync.coerce(3.7, 'integer') === 4, 'ปัดเป็นจำนวนเต็ม');

    /* ── 8.1) กันค่าที่ไม่ใช่วันที่ หลุดเข้าคอลัมน์วันที่ ──
     *
     *  บั๊กจริงจากการซิงค์รอบแรก (4 ก.ย. 2569):
     *  ช่องหนึ่งในชีตเก็บตัวเลขที่ไม่ใช่วันที่ไว้ในคอลัมน์ที่ประกาศเป็นวันที่
     *  แปลงแล้วได้ปี ค.ศ. 20266 → JavaScript เขียนเป็นรูปแบบปีขยาย
     *  "+020266-04-01T…" → PostgreSQL อ่านท่อนหลังเป็นเขตเวลา → 22009
     *  ผลคือยอดขายเข้าไปได้แค่ 800 จาก 5,700 แถว
     *
     *  บทเรียน: 1 ช่องที่เพี้ยน ต้องเสียแค่ช่องนั้น ห้ามล้มทั้งรอบ */
    console.log('\n8.1) กันค่าเพี้ยนในคอลัมน์วันที่ (บั๊กจริงจากรอบแรก)');
    ok(sync.coerce(6708000, 'timestamptz') === null,
       'เลขมหาศาล (ปี 20266) → null ไม่ส่งรูปแบบปีขยายไปให้ PostgreSQL');
    ok(sync.coerce(6708000, 'date') === null, 'เลขมหาศาลในคอลัมน์ date → null');
    ok(!/^\+/.test(String(sync.coerce(46000, 'timestamptz'))),
       'วันที่ปกติยังแปลงได้ และไม่มีเครื่องหมาย + นำหน้า');
    ok(sync.coerce(46000, 'date') === '2025-12-09', 'ซีเรียลปกติ → วันที่ถูกต้อง');
    ok(sync.coerce('01/09/9999', 'date') === null, 'ปีอนาคตเกินจริง (9999) → null');
    ok(sync.coerce('01/09/2469', 'date') === '1926-09-01',
       'ปีเก่าแต่ยังสมเหตุผล (พ.ศ. 2469) ยังแปลงให้ ไม่ทิ้ง');
    ok(sync.coerce(-999999, 'date') === null, 'เลขติดลบ → null');

    /* ── 8.2) ชีตเกิน 1,000 แถว ──
     *
     *  บั๊กจริงจากการซิงค์รอบสอง: Supabase คืนได้สูงสุด 1,000 แถวต่อคำขอ
     *  และไม่บอกว่าตัดให้ ตอนอ่านลายนิ้วมือของแถวที่มีอยู่แล้วจึงได้มาแค่
     *  1,000 แถวแรก แถวที่ 1,001 ขึ้นไปถูกนับว่า "ใหม่" แล้ว insert ทับ
     *  → 23505 duplicate key (_row)=(1038) ล้มทั้งงาน Projects
     *
     *  เทสต์นี้จะจับได้ทันทีถ้าใครเผลอเปลี่ยน selectAll กลับไปเป็น select
     *  (ตัวจำลอง PostgREST ในโฟลเดอร์นี้ตัดที่ 1,000 แถวเหมือนของจริงแล้ว) */
    console.log('\n8.2) ชีตใหญ่เกิน 1,000 แถว (บั๊กจริงจากรอบสอง)');
    await pg.query('truncate app.total_sales, app.sync_run');
    const BIG = 2500;
    FAKE.header = Object.keys(COLUMNS);
    FAKE.rows = Array.from({ length: BIG }, (_, i) => [
      'BIG' + String(i + 1).padStart(5, '0'), 'บริษัทที่ ' + (i + 1),
      toSerial(2026, 9, 1), 1000 + i, 'ปิดการขาย',
    ]);

    let big = await sync.syncSheet({
      name: 'ใหญ่', sheetId: 'fake', tab: 'ทดสอบ', table: 'total_sales',
      columns: COLUMNS, log: quiet,
    });
    ok(big.ok, 'รอบแรกของชีตใหญ่สำเร็จ');
    ok(big.rows_new === BIG, `เข้าครบ ${BIG} แถว (ได้ ${big.rows_new})`);

    const cnt = await pg.query('select count(*)::int n from app.total_sales');
    ok(cnt.rows[0].n === BIG, `ในฐานข้อมูลมี ${BIG} แถวจริง (ได้ ${cnt.rows[0].n})`);

    /* รอบสอง — ข้อมูลเดิมทั้งหมด ต้องเห็นว่า "เท่าเดิม" ครบทุกแถว
     * ถ้าอ่านมาแค่ 1,000 แถว จะพยายาม insert อีก 1,500 แถว แล้วพังตรงนี้ */
    big = await sync.syncSheet({
      name: 'ใหญ่', sheetId: 'fake', tab: 'ทดสอบ', table: 'total_sales',
      columns: COLUMNS, log: quiet,
    });
    ok(big.ok, '‼ รอบสองไม่พัง — อ่านของเดิมครบทุกแถว ไม่ใช่แค่ 1,000 แถวแรก');
    ok(big.rows_same === BIG, `รู้ว่าเท่าเดิมครบ ${BIG} แถว (ได้ ${big.rows_same})`);
    ok(big.rows_new === 0, 'ไม่มีแถวไหนถูกนับเป็นของใหม่ซ้ำ');

    const cnt2 = await pg.query('select count(*)::int n from app.total_sales');
    ok(cnt2.rows[0].n === BIG, 'จำนวนแถวไม่บวมขึ้นหลังรันซ้ำ');

    /* selectAll ต้องบังคับให้สั่งเรียงเสมอ ไม่งั้นแบ่งหน้าแล้วได้แถวซ้ำ/ตกหล่น */
    let threw = false;
    try { await db.selectAll('total_sales', { select: '_row' }); } catch { threw = true; }
    ok(threw, 'selectAll ปฏิเสธถ้าไม่สั่งเรียง (กันแบ่งหน้าแล้วข้อมูลเพี้ยน)');

    /* ── 9) ไม่มีทางเขียนกลับชีต ── */
    console.log('\n9) กันเขียนกลับชีต');
    const sheetsSrc = require('fs').readFileSync(
      path.join(__dirname, '..', 'core', 'sheets.js'), 'utf8');
    ok(!/method:\s*['"]P(OST|UT)['"]|batchUpdate|values:append|:update\b/.test(
        sheetsSrc.replace(/TOKEN_URL[\s\S]{0,400}?\}\);/, '')),
       'core/sheets.js ไม่มีคำสั่งเขียนชีตเลยสักตัว');
    ok(/spreadsheets\.readonly/.test(sheetsSrc),
       'ขอสิทธิ์จาก Google แบบอ่านอย่างเดียว (readonly)');
    const syncSrc = require('fs').readFileSync(
      path.join(__dirname, '..', 'core', 'sync.js'), 'utf8');
    ok(!/sheets\.(write|append|update|set)/.test(syncSrc),
       'core/sync.js ไม่เรียกฟังก์ชันเขียนชีตเลย');

    /* ── 9.1) ‼ ห้ามเขียนอะไรกลับไปที่ PEAK เด็ดขาด ──
     *
     *  พี่เอสั่งไว้ชัด (4 ก.ย. 69): "ดึงข้อมูลมาใช้อย่างเดียว
     *  ห้ามไปอัปเดตอะไรใด ๆ ในฝั่งของ PEAK"
     *
     *  PEAK คือระบบบัญชีตัวจริงของบริษัท เขียนพลาดครั้งเดียว = เอกสารภาษีเพี้ยน
     *  และของเดิมก็ไม่เคยเขียนกลับเลยสักครั้ง (createPeakPOFromPR ยัง comment ไว้ทั้งบล็อก)
     *
     *  เทสต์นี้เป็นสายสะดุด: วันไหนมีใครเผลอเพิ่มคำสั่งเขียน PEAK เข้ามา
     *  เทสต์จะแดงทันทีตั้งแต่ก่อน deploy ไม่ต้องรอให้ไปพังที่บัญชีจริง */
    console.log('\n9.1) ‼ ห้ามเขียนกลับ PEAK');
    const fs = require('fs');
    const coreDir = path.join(__dirname, '..', 'core');
    const peakWrites = [];
    for (const f of fs.readdirSync(coreDir).filter(n => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(coreDir, f), 'utf8');
      if (!/peak/i.test(src)) continue;
      // มีคำว่า peak แล้วยังมีคำสั่งส่งข้อมูลออก = ต้องมาดูด้วยตา
      const lines = src.split('\n');
      lines.forEach((ln, i) => {
        if (!/peak/i.test(ln)) return;
        if (/method:\s*['"]?(POST|PUT|PATCH|DELETE)|\.post\(|\.put\(|\.patch\(|\.delete\(/i.test(ln))
          peakWrites.push(`${f}:${i + 1}`);
      });
    }
    ok(peakWrites.length === 0,
       peakWrites.length
         ? '‼ พบคำสั่งที่อาจเขียนกลับ PEAK: ' + peakWrites.join(', ')
         : 'ไม่มีคำสั่งเขียนกลับ PEAK ในโค้ดเลยสักบรรทัด (อ่านอย่างเดียวตามที่ตกลง)');

    /* ── 10) ซิงค์ผู้ใช้ — ห้ามทับรหัสผ่าน ── */
    console.log('\n10) ซิงค์ผู้ใช้ (กฎเฉพาะ)');
    const bcrypt = require('bcryptjs');
    await pg.query('truncate app.app_users');
    const keepHash = await bcrypt.hash('รหัสที่ตั้งในระบบใหม่', 10);
    await pg.query(`insert into app.app_users ("Name","Username","PasswordHash","Status","Permission")
                    values ('คนเก่า','somchai',$1,'Login','Sale')`, [keepHash]);

    FAKE.header = ['Name', 'Nickname', 'Username', 'Password', 'Status', 'Permission'];
    FAKE.rows = [
      ['สมชาย แก้ไขชื่อแล้ว', 'ชาย', 'somchai', 'รหัสเก่าในชีต', 'Login', 'Administrator'],
      ['คนใหม่',            'ใหม่', 'somsri',  '1389',          'Login', 'Sale'],
      ['',                  '',    '',        '',              '',      ''],
    ];
    const ru = await require('../core/sync-users').syncUsers(
      { sheetId: 'fake', tab: 'User', log: quiet });
    ok(ru.ok, 'ซิงค์ผู้ใช้สำเร็จ');
    ok(ru.rows_new === 1 && ru.rows_upd === 1, 'เพิ่มคนใหม่ 1 · อัปเดตคนเดิม 1');

    const us = await pg.query(`select * from app.app_users order by "Username"`);
    const somchai = us.rows.find(x => x.Username === 'somchai');
    const somsri  = us.rows.find(x => x.Username === 'somsri');

    ok(somchai.PasswordHash === keepHash,
       '‼ รหัสผ่านของคนเดิมไม่ถูกทับ — รหัสที่ตั้งในระบบใหม่ยังอยู่');
    ok(somchai.Name === 'สมชาย แก้ไขชื่อแล้ว' && somchai.Permission === 'Administrator',
       'ชื่อและสิทธิ์อัปเดตตามชีต');
    ok(/^\$2[aby]\$/.test(somsri.PasswordHash || '') && !somsri.Password,
       'คนใหม่ได้ bcrypt ทันที ไม่มีรหัสข้อความล้วนหลุดลงฐานข้อมูล');
    ok(await bcrypt.compare('1389', somsri.PasswordHash),
       'รหัส 4 หลักจากชีตใช้ล็อกอินได้จริง');
    ok(us.rows.length === 2, 'แถวว่างในชีตไม่ถูกสร้างเป็นผู้ใช้');

    /* คนหายจากชีต = ต้องไม่ถูกลบ */
    FAKE.rows = [['คนใหม่', 'ใหม่', 'somsri', '1389', 'Login', 'Sale']];
    const ru2 = await require('../core/sync-users').syncUsers(
      { sheetId: 'fake', tab: 'User', log: quiet });
    ok(ru2.ok && /somchai/.test(ru2.note || ''), 'รายงานคนที่หายจากชีต');
    const still = await pg.query(`select count(*)::int n from app.app_users where "Username"='somchai'`);
    ok(still.rows[0].n === 1,
       'คนที่หายจากชีต "ไม่ถูกลบ" — กันเคสเผลอลบแถวแล้วบัญชีหายทั้งคน');

  } catch (e) {
    fail++; console.error('\n💥 ' + e.stack);
  } finally {
    await pg.query('truncate app.app_users').catch(() => {});
    await rest.close();
    await pg.query('truncate app.total_sales, app.sync_run, app.job_code, app.job_code_seq').catch(() => {});
    await pg.end();
  }

  console.log('\n' + '═'.repeat(52));
  console.log(`ผ่าน ${pass} · ไม่ผ่าน ${fail}`);
  console.log('═'.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})();
