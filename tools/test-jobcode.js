'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  ทดสอบตัวออกรหัสงาน — npm run test:jobcode
 *
 *  โจทย์จริง: แอปคีย์ยอดขายเดิมออก B2K2609/003 ซ้ำ 2 แถว (2 ก.ย. 69)
 *  เทสชุดนี้จำลองทุกทางที่ทำให้ของเดิมพัง แล้วพิสูจน์ว่าของใหม่ไม่ซ้ำ
 *
 *  ข้อที่สำคัญที่สุดคือข้อ 3 — ยิงพร้อมกันหลายคน
 *  ของเดิมรอดได้เพราะมี LockService คลุม ถ้าล็อกหมดเวลาก็ซ้ำ
 *  ของใหม่ไม่ต้องใช้ล็อกเลย เพราะ PRIMARY KEY กันให้ที่ชั้นฐานข้อมูล
 * ═══════════════════════════════════════════════════════════════════ */
const { Client, Pool } = require('pg');

const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:55432/postgres';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

(async () => {
  console.log('\n🧪 ทดสอบตัวออกรหัสงาน (กันเลขซ้ำ)\n');

  const pg = new Client({ connectionString: PG });
  await pg.connect();
  const reset = () => pg.query('truncate app.job_code, app.job_code_seq');
  const next = (px, ...a) =>
    pg.query('select app.next_job_code($1,$2,$3,$4,$5) as c',
      [px, a[0] || 'sales', a[1] || 'tester', '/', '2609'])
      .then(r => r.rows[0].c);

  try {
    /* ── 1) ออกเลขเรียงปกติ ── */
    console.log('1) ออกเลขตามลำดับ');
    await reset();
    const first = [];
    for (let i = 0; i < 5; i++) first.push(await next('B2K'));
    ok(first[0] === 'B2K2609/001', 'รหัสแรกของเดือน = B2K2609/001');
    ok(first.join(',') === 'B2K2609/001,B2K2609/002,B2K2609/003,B2K2609/004,B2K2609/005',
       'เรียง 001→005 ไม่ข้าม ไม่ซ้ำ');

    /* ── 2) เคสมิ้งค์: เปลี่ยน prefix กลางเดือน ── */
    console.log('\n2) เปลี่ยน prefix กลางเดือน (เคสที่ทำให้ของเดิมพัง)');
    await reset();
    // ของเก่าในชีตใช้ B2K มาแล้ว 3 ใบ — ย้ายเข้าทะเบียน
    for (const c of ['B2K2609/001', 'B2K2609/002', 'B2K2609/003'])
      await pg.query('select app.claim_job_code($1,$2,$3)', [c, 'sales', 'ย้ายจากชีต']);
    const afterClaim = await next('B2K');
    ok(afterClaim === 'B2K2609/004',
       'ตัวนับเริ่มจากศูนย์ แต่ในทะเบียนมีถึง 003 → ออก 004 ไม่ทับของเก่า');

    /* ── 3) ยิงพร้อมกัน 50 คำขอ ← ข้อสำคัญที่สุด ── */
    console.log('\n3) ยิงพร้อมกัน 50 คำขอ (ไม่มีล็อกภายนอกเลย)');
    await reset();
    const pool = new Pool({ connectionString: PG, max: 20 });
    const N = 50;
    const codes = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        pool.query('select app.next_job_code($1,$2,$3,$4,$5) as c',
          ['QW', 'sales', 'user' + i, '/', '2609']).then(r => r.rows[0].c))
    );
    await pool.end();
    const uniq = new Set(codes);
    ok(uniq.size === N, `ได้ ${uniq.size} รหัสไม่ซ้ำ จาก ${N} คำขอพร้อมกัน`);
    const nums = codes.map(c => parseInt(c.split('/')[1], 10)).sort((a, b) => a - b);
    ok(nums[0] === 1 && nums[N - 1] === N, 'เลขต่อเนื่อง 1–' + N + ' ไม่มีรูโหว่');

    /* ── 4) มีคนคีย์รหัสมือชนไว้ก่อน ── */
    console.log('\n4) มีคนคีย์รหัสมือชนไว้ล่วงหน้า');
    await reset();
    await next('QZ');                                     // QZ2609/001
    await pg.query('select app.claim_job_code($1)', ['QZ2609/002']);  // คีย์มือ
    const skip = await next('QZ');
    ok(skip === 'QZ2609/003', 'ข้ามเลขที่คนคีย์มือไว้ ไปออก 003 แทน');

    /* ── 5) ทะเบียนซ้ำไม่ได้แม้จะพยายาม ── */
    console.log('\n5) ฐานข้อมูลกันซ้ำเอง');
    let blocked = false;
    try {
      await pg.query(`insert into app.job_code (code, head, no) values ('QZ2609/001','QZ2609',1)`);
    } catch (e) { blocked = e.code === '23505'; }
    ok(blocked, 'ใส่รหัสซ้ำตรง ๆ ลงตาราง → ฐานข้อมูลปฏิเสธ (PRIMARY KEY)');

    const dup = await pg.query('select * from app.v_job_code_dup');
    ok(dup.rows.length === 0, 'วิวตรวจรหัสซ้ำว่างเปล่า (ไม่มีทางมีรหัสซ้ำ)');

    /* ── 6) ตัวคั่นและ prefix แยกกันคนละสาย ── */
    console.log('\n6) แยกสายตาม prefix และเดือน');
    await reset();
    await next('B2K');
    const other = await next('QW');
    ok(other === 'QW2609/001', 'prefix คนละตัว = เลขรันคนละสาย ไม่กวนกัน');
    const lastMonth = await pg.query(
      `select app.next_job_code('B2K','sales','tester','/','2608') as c`);
    ok(lastMonth.rows[0].c === 'B2K2608/001', 'คนละเดือน = เริ่มนับใหม่');

    /* ── 7) วิวตรวจสุขภาพ ── */
    console.log('\n7) วิวตรวจสุขภาพเลขรัน');
    const st = await pg.query(`select * from app.v_job_seq_status where head = 'B2K2609'`);
    ok(st.rows.length === 1, 'วิว v_job_seq_status อ่านได้');
    ok(st.rows[0]['ตัวนับต่ำกว่าจริง'] === false, 'ตัวนับตรงกับของจริงในทะเบียน');

    /* ── 8) claim ซ้ำไม่พัง ── */
    console.log('\n8) กันงานซ้ำตอนย้ายข้อมูล');
    const a1 = await pg.query(`select app.claim_job_code('B2K2609/090') as r`);
    const a2 = await pg.query(`select app.claim_job_code('B2K2609/090') as r`);
    ok(a1.rows[0].r === true && a2.rows[0].r === false,
       'จดรหัสเดิมซ้ำ → คืน false ไม่ error (รันสคริปต์ย้ายข้อมูลซ้ำได้)');
    const afterHigh = await next('B2K');
    ok(afterHigh === 'B2K2609/091', 'จดเลข 090 แล้ว ตัวนับกระโดดตาม → ออก 091');

  } catch (e) {
    fail++; console.error('\n💥 ' + e.stack);
  } finally {
    await pg.query('truncate app.job_code, app.job_code_seq').catch(() => {});
    await pg.end();
  }

  console.log('\n' + '═'.repeat(52));
  console.log(`ผ่าน ${pass} · ไม่ผ่าน ${fail}`);
  console.log('═'.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})();
