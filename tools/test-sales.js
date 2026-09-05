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
function call(handler, query = {}, params = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    Promise.resolve(handler({ query, params }, res)).catch(reject);
  });
}

(async () => {
  console.log('\n🧪 ทดสอบโมดูลคีย์ยอดขาย\n');

  const pg = new Client({ connectionString: PG });
  await pg.connect();
  await pg.query('truncate app.total_sales');

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
    const writeRoutes = router.routes.filter(r => r.method !== 'GET');
    ok(writeRoutes.length === 1 && writeRoutes[0].path === '/api/save',
       'มีทางเขียนทางเดียวเท่านั้นคือ POST /api/save (ได้ ' +
       (writeRoutes.map(r => r.method + ' ' + r.path).join(', ') || 'ไม่มีเลย') + ')');
    ok(!router.routes.some(r => ['PUT', 'PATCH', 'DELETE'].includes(r.method)),
       '‼ ไม่มี PUT/PATCH/DELETE — ลบข้อมูลผ่านหน้าเว็บไม่ได้');

    const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'sales', 'index.js'), 'utf8');
    const saveSrc = fs.readFileSync(path.join(__dirname, '..', 'modules', 'sales', 'save.js'), 'utf8');
    const html = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'sales', 'public', 'index.html'), 'utf8');

    ok(!/db\.(insert|update|remove|upsert)\s*\(/.test(src),
       'index.js ไม่เขียนฐานข้อมูลเอง — ให้ save.js ทำที่เดียว');
    ok(!/db\.remove\s*\(/.test(saveSrc),
       '‼ save.js ไม่มีคำสั่งลบแถวเลยแม้แต่ตัวเดียว');

    /* ลำดับต้องเป็น: เขียนชีต → แล้วค่อยเขียนฐานข้อมูล */
    const iSheet = Math.min(
      ...['sheets.appendRow', 'sheets.updateRow'].map(k => {
        const i = saveSrc.indexOf(k); return i < 0 ? Infinity : i;
      }));
    const iDb = saveSrc.indexOf('mirrorToDb(');
    ok(iSheet < Infinity, 'save.js เขียนลงชีตจริง (appendRow/updateRow)');
    ok(iDb > iSheet, '‼ ลำดับถูก — เขียนชีตก่อน แล้วค่อยตามลงฐานข้อมูล');

    /* PEAK: ห้ามมีคำสั่งเขียนใด ๆ ที่บรรทัดซึ่งพูดถึง PEAK */
    const peakWrites = [];
    for (const [name, code] of [['index.js', src], ['save.js', saveSrc], ['index.html', html]]) {
      code.split('\n').forEach((ln, i) => {
        if (!/peak/i.test(ln)) return;
        if (/method:\s*['"]?(POST|PUT|PATCH|DELETE)|\.post\(|\.put\(|\.patch\(|\.delete\(/i.test(ln))
          peakWrites.push(`${name}:${i + 1}`);
      });
    }
    ok(peakWrites.length === 0,
       peakWrites.length ? '‼ พบคำสั่งเขียนใกล้ PEAK: ' + peakWrites.join(', ')
                         : '‼ ไม่มีคำสั่งเขียนกลับ PEAK เลยแม้แต่บรรทัดเดียว');

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
    ok(/^https:\/\/lh3\./.test(IM.a), 'ลิงก์ /file/d/ → lh3');
    ok(/^https:\/\/lh3\./.test(IM.b), 'ลิงก์ ?id= → lh3');
    ok(/^https:\/\/lh3\./.test(IM.c), 'ไอดีเปล่า ๆ → lh3');
    ok(IM.d === '', 'ไม่มีรูป → ค่าว่าง (หน้าจอถอยไปใช้อักษรย่อ)');

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

  } finally {
    await rest.close().catch(() => {});
    await pg.end();
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log(`ผ่าน ${pass} · ไม่ผ่าน ${fail}`);
  console.log('════════════════════════════════════════════════════\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
