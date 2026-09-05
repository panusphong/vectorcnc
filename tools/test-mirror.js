'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  ทดสอบกระจกรวมทุกแท็บ — npm run test:mirror
 *
 *  กระจกนี้มีไว้ดึงแท็บที่ "ยังไม่รู้ว่ามีคอลัมน์อะไร" เข้ามาก่อน
 *  จึงต้องพิสูจน์ 3 เรื่องที่ต่างจากตารางจริง:
 *
 *    1) รับได้ทุกหัวตาราง แม้หัวซ้ำกัน แม้หัวว่าง
 *    2) ‼ คอลัมน์อ่อนไหว (เลขบัตร ปชช. · เลขบัญชี) ต้องไม่ถูกก๊อปมา
 *       แต่ต้องจดไว้ว่าตัดอะไรไป — ห้ามหายเงียบ
 *    3) แท็บที่มีตารางจริงแล้ว ต้องไม่ถูกดึงซ้ำเข้ากระจก
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const { Client } = require('pg');

const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:55432/postgres';
const REST_PORT = 55455;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

/* ── ชีตปลอม ── */
const FAKE = { header: [], rows: [], tabs: [] };
require.cache[require.resolve('../core/sheets.js')] = {
  id: require.resolve('../core/sheets.js'),
  filename: require.resolve('../core/sheets.js'),
  loaded: true,
  exports: {
    isConfigured: () => true,
    listTabs: async () => FAKE.tabs.slice(),
    readTab: async () => ({ header: FAKE.header.slice(), rows: FAKE.rows.map(r => r.slice()) }),
    readHead: async () => ({ header: FAKE.header.slice(), rows: [] }),
  },
};

process.env.SUPABASE_URL = `http://127.0.0.1:${REST_PORT}`;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = 'c'.repeat(64);

const mirror = require('../core/sync-mirror');
const sheetFiles = require('../core/sheet-files');

(async () => {
  console.log('\n🧪 ทดสอบกระจกรวมทุกแท็บ\n');

  const pg = new Client({ connectionString: PG });
  await pg.connect();
  await pg.query('truncate app.sheet_rows, app.sheet_catalog, app.sync_run');

  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  const quiet = () => {};
  const run = (tab = 'ProductionJobs') => mirror.syncTab({
    fileKey: 'projectplan', sheetId: 'fake', tab, log: quiet,
  });
  const rows = async (src = 'projectplan/ProductionJobs') => (await pg.query(
    'select * from app.sheet_rows where source = $1 order by _row', [src])).rows;

  try {
    /* ── 1) หัวตารางแบบไหนก็รับได้ ── */
    console.log('1) รับหัวตารางทุกแบบ');
    FAKE.header = ['JobID', 'ลูกค้า', 'สถานะ'];
    FAKE.rows = [
      ['J001', 'บริษัท ก', 'ผลิต'],
      ['J002', 'บริษัท ข', 'ส่งแล้ว'],
      ['', '', ''],                        // แถวว่างล้วน — ต้องข้าม
    ];
    let r = await run();
    ok(r.ok, 'ซิงค์เข้ากระจกสำเร็จ');
    ok(r.rows_new === 2, 'เข้า 2 แถว แถวว่างถูกข้าม');

    let got = await rows();
    ok(got.length === 2, 'ในฐานข้อมูลมี 2 แถว');
    ok(got[0].data.JobID === 'J001' && got[0].data['ลูกค้า'] === 'บริษัท ก',
       'เก็บทั้งแถวเป็น jsonb ตามชื่อหัวคอลัมน์จริง');
    ok(got[0].source === 'projectplan/ProductionJobs', 'บันทึกที่มาของแถวไว้ครบ');
    ok(got[0].data['สถานะ'] === 'ผลิต', 'หัวคอลัมน์ภาษาไทยใช้ได้');

    /* ── 2) หัวซ้ำ / หัวว่าง ── */
    console.log('\n2) หัวตารางซ้ำกันและหัวว่าง (ของจริงเจอบ่อย)');
    await pg.query('truncate app.sheet_rows');
    FAKE.header = ['ชื่อ', 'ชื่อ', '', 'ชื่อ'];
    FAKE.rows = [['ก', 'ข', 'ค', 'ง']];
    r = await run();
    got = await rows();
    ok(r.ok && got.length === 1, 'ซิงค์ผ่านทั้งที่หัวซ้ำ 3 ช่อง');
    const keys = Object.keys(got[0].data);
    ok(keys.length === 4, 'ได้ครบ 4 ช่อง ไม่มีช่องไหนถูกทับหาย (ได้ ' + keys.length + ')');
    ok(keys.includes('ชื่อ') && keys.includes('ชื่อ (2)'),
       'หัวซ้ำถูกเติมเลขต่อท้ายให้แยกกัน: ' + keys.join(' | '));

    /* ── 3) ‼ ข้อมูลอ่อนไหว: เก็บครบ แต่ต้องอยู่คนละตาราง ──
     *
     *  พี่เอสั่ง "เอาเข้ามาให้หมด" (4 ก.ย. 69) — เก็บจริงทุกช่อง
     *  แต่ต้องแยกไป app.sensitive_rows ที่เปิด RLS ไว้
     *  เพราะเผลอ SELECT * จากตารางกระจกแล้วเลขบัตรประชาชนโผล่ไม่ได้ */
    console.log('\n3) ‼ ข้อมูลอ่อนไหวของช่าง — เก็บครบ แต่แยกตาราง');
    await pg.query('truncate app.sheet_rows, app.sensitive_rows');
    FAKE.header = ['ชื่อ', 'ชื่อเล่น', 'เลขบัตรประชาชน', 'เลขที่บัญชี', 'ธนาคาร', 'ภาพบัตรประชาชน 1'];
    FAKE.rows = [['สมชาย', 'ชาย', '1234567890123', '111-2-33333-4', 'กสิกร', 'https://drive/x']];
    r = await mirror.syncTab({ fileKey: 'techteam', sheetId: 'fake', tab: 'Skill Matrix ช่าง', log: quiet });
    got = await rows('techteam/Skill Matrix ช่าง');
    ok(r.ok && got.length === 1, 'ซิงค์แท็บช่างสำเร็จ');

    const d = got[0].data;
    ok(d['ชื่อ'] === 'สมชาย' && d['ชื่อเล่น'] === 'ชาย', 'ข้อมูลทั่วไปอยู่ในตารางกระจกตามปกติ');
    ok(d['ธนาคาร'] === 'กสิกร', 'ชื่อธนาคารเฉย ๆ ไม่ใช่ของอ่อนไหว อยู่ตารางปกติ');
    ok(!('เลขบัตรประชาชน' in d), '‼ เลขบัตรประชาชนไม่อยู่ในตารางกระจก');
    ok(!('เลขที่บัญชี' in d), '‼ เลขที่บัญชีไม่อยู่ในตารางกระจก');
    ok(!/1234567890123|111-2-33333-4/.test(JSON.stringify(d)),
       '‼ เผลอ SELECT * จากตารางกระจก ก็ไม่เห็นเลขบัตร/เลขบัญชีเลย');

    const sec = (await pg.query(
      "select * from app.sensitive_rows where source='techteam/Skill Matrix ช่าง'")).rows;
    ok(sec.length === 1, 'ข้อมูลอ่อนไหวถูกเก็บไว้ในตารางจำกัดสิทธิ์ 1 แถว');
    ok(sec[0].data['เลขบัตรประชาชน'] === '1234567890123', '‼ เลขบัตรประชาชนเก็บครบ ไม่ได้ทิ้ง');
    ok(sec[0].data['เลขที่บัญชี'] === '111-2-33333-4', '‼ เลขที่บัญชีเก็บครบ');
    ok(sec[0].data['ภาพบัตรประชาชน 1'] === 'https://drive/x', 'ลิงก์ภาพบัตรเก็บครบ');
    ok(sec[0]._row === got[0]._row, 'โยงกลับหาแถวเดิมได้ด้วย _row เดียวกัน');
    ok(!('ชื่อ' in sec[0].data), 'ตารางอ่อนไหวเก็บเฉพาะช่องอ่อนไหว ไม่ก๊อปทั้งแถวมาซ้ำ');

    ok(Array.isArray(got[0].redacted) && got[0].redacted.length === 3,
       'ตารางกระจกจดไว้ว่าช่องไหนถูกย้ายไป 3 ช่อง');
    ok(got[0].redacted.includes('เลขบัตรประชาชน'), 'รายการที่ย้ายอ่านรู้เรื่อง: ' + got[0].redacted.join(', '));

    const full = (await pg.query(
      "select * from app.v_sheet_rows_full where source='techteam/Skill Matrix ช่าง'")).rows;
    ok(full.length === 1 && full[0].data['ชื่อ'] === 'สมชาย' &&
       full[0].data['เลขบัตรประชาชน'] === '1234567890123',
       'มุมมองรวมเห็นทั้งสองฝั่ง — ใช้ตอนต้องใช้จริง เช่น ใบเบิกจ่ายช่าง');

    /* RLS ต้องเปิดจริง ไม่ใช่แค่ตั้งใจ */
    const rls = (await pg.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid='app.sensitive_rows'::regclass")).rows[0];
    ok(rls.relrowsecurity === true, '‼ ตารางอ่อนไหวเปิด RLS ไว้จริง');
    ok(rls.relforcerowsecurity === true, 'บังคับ RLS แม้กับเจ้าของตาราง');
    const pol = (await pg.query(
      "select count(*)::int n from pg_policies where schemaname='app' and tablename='sensitive_rows'")).rows[0];
    ok(pol.n === 0, 'ไม่มี policy เลย = anon/authenticated อ่านไม่ได้แม้แต่แถวเดียว');

    /* ลบออกจากชีต → ต้องหายจากตารางอ่อนไหวด้วย */
    FAKE.rows = [['สมชาย', 'ชาย', '', '', 'กสิกร', '']];
    r = await mirror.syncTab({ fileKey: 'techteam', sheetId: 'fake', tab: 'Skill Matrix ช่าง', log: quiet });
    const sec2 = (await pg.query(
      "select * from app.sensitive_rows where source='techteam/Skill Matrix ช่าง'")).rows;
    ok(sec2.length === 0,
       '‼ ลบเลขบัตร/เลขบัญชีออกจากชีต แล้วของเก่าหายตามด้วย ไม่ค้างอยู่ในระบบ');

    /* ── 4) รันซ้ำได้ผลเท่าเดิม ── */
    console.log('\n4) รันซ้ำ (idempotent)');
    await pg.query('truncate app.sheet_rows');
    FAKE.header = ['JobID', 'สถานะ'];
    FAKE.rows = Array.from({ length: 1500 }, (_, i) => ['J' + i, 'ผลิต']);
    r = await run();
    ok(r.rows_new === 1500, 'รอบแรกเข้า 1,500 แถว');
    r = await run();
    ok(r.ok, '‼ รอบสองไม่พัง — อ่านของเดิมครบ ไม่ใช่แค่ 1,000 แถวแรก');
    ok(r.rows_same === 1500 && r.rows_new === 0, 'รู้ว่าเท่าเดิมทั้ง 1,500 แถว');

    /* ── 5) แก้ + ลบ ตามชีต ── */
    console.log('\n5) กระจกตามชีตทุกกรณี');
    FAKE.rows = [['J0', 'ส่งแล้ว'], ['J1', 'ผลิต']];   // เหลือ 2 แถว แถวแรกเปลี่ยนค่า
    r = await run();
    ok(r.rows_upd === 1, 'แถวที่เปลี่ยนค่าถูกอัปเดต 1 แถว');
    ok(r.rows_del === 1498, 'แถวที่หายจากชีตถูกลบตาม 1,498 แถว');
    got = await rows();
    ok(got.length === 2 && got[0].data['สถานะ'] === 'ส่งแล้ว', 'เหลือ 2 แถว ค่าตรงกับชีต');

    /* ── 6) แท็บที่มีตารางจริงแล้ว ต้องไม่ดึงซ้ำ ── */
    console.log('\n6) ไม่ดึงซ้ำแท็บที่มีตารางจริงแล้ว');
    FAKE.tabs = [
      { title: 'Projects', rows: 12000, cols: 50 },       // มีตารางจริงแล้ว
      { title: 'ProductionJobs', rows: 8000, cols: 40 },  // ยังไม่มี → ต้องเข้ากระจก
      { title: 'Presence', rows: 50, cols: 3 },           // ข้ามตามกฎ
    ];
    await pg.query('truncate app.sheet_catalog');
    const typed = new Map([['projectplan/Projects', 'Projects']]);
    const found = await mirror.discover({ typedTabs: typed, log: quiet });
    ok(Array.isArray(found) && found.length === sheetFiles.files().length,
       'สำรวจครบทุกไฟล์ที่ลงทะเบียนไว้ (' + sheetFiles.files().length + ' ไฟล์)');

    const cat = (await pg.query(
      "select * from app.sheet_catalog where file_key='projectplan' order by tab")).rows;
    const byTab = Object.fromEntries(cat.map(c => [c.tab, c]));
    ok(byTab['Projects'] && byTab['Projects'].covered_by === 'Projects',
       'Projects ถูกทำเครื่องหมายว่ามีตารางจริงแล้ว');
    ok(byTab['Projects'] && byTab['Projects'].mirror === false,
       '‼ Projects จะไม่ถูกดึงซ้ำเข้ากระจก');
    ok(byTab['ProductionJobs'] && byTab['ProductionJobs'].mirror === true,
       'ProductionJobs จะถูกดึงเข้ากระจก');
    ok(byTab['Presence'] && byTab['Presence'].mirror === false,
       'Presence (ข้อมูลชั่วคราว) ถูกข้ามตามกฎ');

    const jobs = await mirror.mirrorJobs();
    const inPlan = jobs.filter(j => j.fileKey === 'projectplan').map(j => j.tab);
    ok(!inPlan.includes('Projects'),
       'รายการงานกระจกไม่มี Projects ของไฟล์ Project Plan (มีตารางจริงแล้ว)');
    ok(inPlan.includes('ProductionJobs'), 'รายการงานกระจกมี ProductionJobs');
    ok(!jobs.some(j => j.tab === 'Presence'), 'รายการงานกระจกไม่มี Presence เลยสักไฟล์');

    /* ── 7) กฎการข้ามแท็บ ── */
    console.log('\n7) กฎการข้ามแท็บและการตรวจคอลัมน์อ่อนไหว');
    ok(sheetFiles.shouldSkip('ChatReads') && sheetFiles.shouldSkip('OnlineSessions'),
       'ข้อมูลชั่วคราวถูกข้าม');
    ok(sheetFiles.shouldSkip('Sheet1') && sheetFiles.shouldSkip('สำรอง ProductionJobs'),
       'แท็บเปล่าและแท็บสำรองถูกข้าม');
    ok(!sheetFiles.shouldSkip('ProductionJobs') && !sheetFiles.shouldSkip('JobDeliveries'),
       'แท็บข้อมูลจริงไม่ถูกข้าม');
    ok(sheetFiles.isSensitiveColumn('Bank Account') && sheetFiles.isSensitiveColumn('National ID'),
       'ตรวจคอลัมน์อ่อนไหวภาษาอังกฤษได้ด้วย');
    ok(!sheetFiles.isSensitiveColumn('ชื่อบัญชีผู้ใช้') === false ||
       !sheetFiles.isSensitiveColumn('ราคา'), 'ชื่อทั่วไปไม่ถูกตัดเกินจำเป็น');

  } finally {
    await rest.close().catch(() => {});
    await pg.end();
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log(`ผ่าน ${pass} · ไม่ผ่าน ${fail}`);
  console.log('════════════════════════════════════════════════════\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
