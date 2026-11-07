'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  🆔 Project ID ซ้ำ — npm run test:pjdupid
 *
 *  พี่เอสั่ง 19 ก.ย. 69 คำต่อคำ:
 *    "ตรวจสอบและแก้ไขด่วนนะ จัด agent มาทำเลย ทำไมถึงมี project id ซ้ำกันได้
 *     ต้องป้องกัน และแก้ไข id project อันนี้ให้ด้วยนะ"
 *
 *  ชุดนี้พิสูจน์ด้วยการ "รันจริง" ไม่ใช่การอ่านโค้ดแล้วเดา:
 *    ① ทำซ้ำอาการให้ได้ — เดินทางเดียวกับแอปเดิม (Code.gs:1211) แล้วต้องได้
 *       สองแถว ID เดียวกันเป๊ะ ต่างกันแค่ "ประเภทงาน" (เหมือนภาพที่พี่เอส่งมา)
 *       แล้วเดินทางของระบบใหม่ซ้ำแบบเดียวกัน ต้องไม่ซ้ำ
 *    ② ยิงเปิดงานผ่านเซิร์ฟเวอร์จริง 2 ครั้งด้วยรหัสเดียวกัน — ต้องได้คนละรหัส
 *    ③ ยามกันซ้ำ: สุ่มรหัสจำนวนมาก + คณิตศาสตร์วันเกิดพ้อง
 *    ④ ID เก่าต้องใช้ได้ต่อ (รูปแบบไม่เปลี่ยน · เปิดงานเก่าด้วยรหัสเดิมได้)
 *    ⑤ SQL 86/87/88 บนฐานที่มีข้อมูลอยู่ก่อน — แถวต้องไม่หาย · รันซ้ำได้
 *    ⑥ ตัวตรวจบนหน้าจอ (แถบแดง Dashboard + บรรทัดแดงในผลค้นหา) ต่อสายจริง
 *    ⑦ 🔴 red-team — ถอดยามทีละตัว ต้องแดงทุกตัว
 *
 *  🔴 ฐานที่ใช้: สร้างฐานใหม่ชื่อ pjdup_test ทุกครั้ง แล้วก๊อปโครงจากฐานทดสอบ
 *     ‼ ไม่แตะข้อมูลในฐานทดสอบกลาง เพราะรอบนี้มีหลายทีมทำงานพร้อมกัน
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Client } = require('pg');

const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const DB = 'pjdup_test';
const PG_T = PG.replace(/\/[^/?]*(\?|$)/, '/' + DB + '$1');
const REST_PORT = 55701;
const APP_PORT = 55702;
const SQL_DIR = path.join(__dirname, '..', 'sql');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);

const psql = (conn, args) => execFileSync('psql', ['-v', 'ON_ERROR_STOP=0', conn, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/* ‼ psql ส่งบรรทัด NOTICE/ERROR ออกทาง stderr ไม่ใช่ stdout
 *   ถ้าเก็บแต่ stdout เทสต์จะ "มองไม่เห็นข้อความของไฟล์ SQL" แล้วแดงทั้งที่ของถูก
 *   ⇒ รวมสองสายเป็นสายเดียวก่อนอ่าน */
const runSql = (conn, file) => {
  const cmd = 'psql ' + JSON.stringify(conn) + ' -f ' + JSON.stringify(path.join(SQL_DIR, file)) + ' 2>&1';
  try { return execFileSync('sh', ['-c', cmd], { encoding: 'utf8' }); }
  catch (e) { return String(e.stdout || '') + String(e.stderr || ''); }
};

/* ═══ ตัวจริงจากโค้ดแอป — ไม่ลอกมาเขียนใหม่ ═══ */
const { genId8_ } = require('../modules/projects/lib');
const { dupIdsOf_ } = require('../modules/projects/dashboard');

(async () => {
  console.log('\n🧪 Project ID ซ้ำ — ต้นเหตุ · ยามกันซ้ำ · ทางแก้\n');

  if (!/localhost|127\.0\.0\.1/.test(PG)) {
    console.log('🔴 TEST_PG ไม่ได้ชี้ไปที่เครื่องนี้ — ชุดนี้สร้าง/ลบฐานทดสอบ ห้ามรันกับฐานจริง');
    process.exit(1);
  }

  /* ─── เตรียมฐานทดสอบของชุดนี้เอง (ก๊อปเฉพาะ "โครง" ไม่เอาข้อมูลใคร) ─── */
  psql(PG, ['-q', '-c', 'drop database if exists ' + DB, '-c', 'create database ' + DB]);
  const dump = execFileSync('pg_dump', ['-s', PG], { encoding: 'utf8', maxBuffer: 1 << 28 });
  execFileSync('psql', ['-q', PG_T], { input: dump, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'] });

  const pg = new Client({ connectionString: PG_T });
  await pg.connect();

  /* ═══════════════════════════════════════════════════════════════
   *  ① ทำซ้ำอาการ — เดินโค้ดของ "แอปเดิม" กับ "ระบบใหม่" ด้วยมือ
   *
   *  ‼ ไม่ได้เขียนเลียนแบบเอาเอง — ยกอัลกอริทึมมาตรงจากสองที่:
   *     เดิม : _source/projects/Code.gs:1211
   *     ใหม่ : modules/projects/index.js (บล็อกออกรหัสใน /api/project/create)
   * ═══════════════════════════════════════════════════════════════ */
  head('① ทำซ้ำอาการ — สองแถวที่ต่างกันแค่ "ประเภทงาน" ได้ ID เดียวกันไหม');

  /* ตารางจำลอง: หนึ่งแถว = หนึ่งงานที่ถูกบันทึก */
  const mkStore = () => {
    const rows = [];
    return { rows, find: id => rows.find(r => r.ID === String(id || '').trim()) || null };
  };
  /* แอปเดิม (Code.gs:1211) — รับรหัสจากหน้าเว็บมาใช้ตรง ๆ ไม่ตรวจอะไรเลย */
  const createOld = (st, payload) => {
    const id = (payload.projectId && /^[0-9a-f]{8}$/i.test(payload.projectId))
      ? payload.projectId.toLowerCase() : genId8_();
    st.rows.push({ ID: id, jobType: payload.jobType });
    return id;
  };
  /* ระบบใหม่ — ตรวจก่อน ชนก็สุ่มใหม่ ยังชนอีกก็ "ไม่เขียน" */
  const createNew = (st, payload) => {
    let id = (payload.projectId && /^[0-9a-f]{8}$/i.test(payload.projectId))
      ? String(payload.projectId).toLowerCase() : genId8_();
    let dup = st.find(id);
    for (let i = 0; i < 5 && dup; i++) { id = genId8_(); dup = st.find(id); }
    if (dup) return { ok: false };
    st.rows.push({ ID: id, jobType: payload.jobType });
    return { ok: true, id };
  };

  /* ท่าที่พี่เอเจอ: เปิดงาน → บันทึก → แก้ "ประเภทงาน" → กดบันทึกอีกที
   *   หน้าเว็บไม่ได้สุ่มรหัสใหม่ให้ (currentProjectId ค้างค่าเดิม
   *   — เห็นได้ที่ _source/projects/Index.html:2194 ที่ถูกเรียกเฉพาะตอน resetForm) */
  const SAME = 'eb12d611';
  const oldSt = mkStore();
  createOld(oldSt, { projectId: SAME, jobType: 'วาง scale ตัวอักษร' });
  createOld(oldSt, { projectId: SAME, jobType: 'เริ่มออกแบบใหม่' });
  ok(oldSt.rows.length === 2 && oldSt.rows[0].ID === oldSt.rows[1].ID,
     '🔴 แอปเดิม: บันทึก 2 ครั้งด้วยรหัสเดิม → สองแถว ID เดียวกันเป๊ะ (' + oldSt.rows[0].ID + ')');
  ok(oldSt.rows[0].jobType !== oldSt.rows[1].jobType,
     '🔴 ต่างกันแค่ "ประเภทงาน" — ตรงกับภาพที่พี่เอส่งมาทุกช่อง');

  const newSt = mkStore();
  const n1 = createNew(newSt, { projectId: SAME, jobType: 'วาง scale ตัวอักษร' });
  const n2 = createNew(newSt, { projectId: SAME, jobType: 'เริ่มออกแบบใหม่' });
  ok(n1.ok && n2.ok && n1.id === SAME && n2.id !== SAME,
     'ระบบใหม่: ครั้งที่สองได้รหัสใหม่ (' + n2.id + ') ไม่ทับของเดิม');
  ok(new Set(newSt.rows.map(r => r.ID)).size === newSt.rows.length,
     'ระบบใหม่: ไม่มีรหัสซ้ำเลย');

  /* ‼ ข้อพิสูจน์ว่า "ไม่ใช่การสร้าง ID จากข้อมูลของแถว" (ข้อ ข ที่พี่เอสงสัย)
   *   ถ้าเป็น hash ของข้อมูล สองแถวที่ข้อมูลเหมือนกันต้องได้รหัสเดียวกันเสมอ */
  const sameData = new Set();
  for (let i = 0; i < 1000; i++) sameData.add(genId8_());
  ok(sameData.size === 1000,
     '🔴 ตัวออกรหัสไม่ได้ผูกกับข้อมูลของแถวเลย — เรียก 1,000 ครั้งด้วย "ข้อมูลเดียวกัน" ได้ ' +
     sameData.size + ' ค่าต่างกัน (ตัดข้อสงสัย "hash ของเลข QO/IV + ชื่อลูกค้า" ทิ้งได้)');

  /* ═══════════════════════════════════════════════════════════════
   *  ③ ยามกันซ้ำ + คณิตศาสตร์วันเกิดพ้อง
   * ═══════════════════════════════════════════════════════════════ */
  head('③ ตัวออกรหัส — ช่องว่างมีกี่แบบ และโอกาสชนที่จำนวนแถวจริง');
  const N = 6 * Math.pow(16, 7);          /* ตัวแรก a-f (6 แบบ) + hex อีก 7 ตัว */
  const many = new Set(); let bad = 0;
  for (let i = 0; i < 200000; i++) {
    const s = genId8_();
    if (!/^[a-f][0-9a-f]{7}$/.test(s)) bad++;
    many.add(s);
  }
  ok(bad === 0, 'สุ่ม 200,000 ครั้ง รูปแบบถูกทุกตัว (ตัวแรก a-f + hex 7 ตัว)');
  const collided = 200000 - many.size;
  ok(collided <= 50, 'สุ่มดิบ ๆ 200,000 ครั้ง ชนกันเอง ' + collided + ' คู่ (คาดไว้ ~' +
     (200000 * 200000 / (2 * N)).toFixed(1) + ' คู่ ตามสูตรวันเกิดพ้อง)');
  const pAt = n => 1 - Math.exp(-(n * n) / (2 * N));
  console.log('     ช่องว่างจริง = 6 × 16⁷ = ' + N.toLocaleString() + ' แบบ ' +
              '(ไม่ใช่ 16⁸ = 4,294,967,296 เพราะตัวแรกเป็นตัวอักษร a-f เท่านั้น)');
  for (const n of [5000, 12000, 20000, 30000, 50000]) {
    console.log('     ' + String(n).padStart(6) + ' แถว → โอกาสมีคู่ที่ชนกันอย่างน้อย 1 คู่ = ' +
      (pAt(n) * 100).toFixed(2) + '%  · คู่ที่คาดว่าจะชน ' + (n * n / (2 * N)).toFixed(3) + ' คู่');
  }
  /* ยามจริง: ตรวจก่อนเขียนทุกครั้ง แล้วต้องไม่มีซ้ำเลยแม้แต่ตัวเดียว */
  const guardSt = mkStore();
  for (let i = 0; i < 20000; i++) createNew(guardSt, { jobType: 'x' });
  ok(new Set(guardSt.rows.map(r => r.ID)).size === 20000,
     'เปิดงาน 20,000 ใบผ่านยามตัวจริง — ไม่ซ้ำเลยสักใบ');

  /* ═══════════════════════════════════════════════════════════════
   *  ⑤ SQL 86 / 87 / 88 บนฐานที่มีข้อมูลอยู่ก่อน
   * ═══════════════════════════════════════════════════════════════ */
  head('⑤ SQL — ตรวจ (86) · ออกรหัสใหม่ (87) · ด่านถาวร (88)');
  await pg.query('delete from app.projects');
  await pg.query(`insert into app.projects (_row,_hash,"ID","Project","แสดงชื่อลูกค้า","พนักงานขาย","Owner","ประเภทงาน","Status","Started") values
    (101,'h1','eb12d611','QZ2608/029-1 · IV-2026081100005','บริษัท ซี แอนด์ เอ 2020 จำกัด','(ส้ม) อารยา เกษร','(นุ่มนิ่ม) สุภารัตน์ หาญปัอ','วาง scale ตัวอักษร','Complete','2026-09-09'),
    (102,'h2','eb12d611','QZ2608/029-1 · IV-2026081100005','บริษัท ซี แอนด์ เอ 2020 จำกัด','(ส้ม) อารยา เกษร','(นุ่มนิ่ม) สุภารัตน์ หาญปัอ','เริ่มออกแบบใหม่','Complete','2026-09-09'),
    (103,null,'a1234567','งานปกติ','ลูกค้า ข','(ส้ม) อารยา เกษร','(โย) โย','ติดตั้งใหม่','Complete','2026-09-01'),
    (104,null,'','งานไม่มีรหัส 1','ลูกค้า ค',null,null,null,'Not Started',null),
    (105,null,'','งานไม่มีรหัส 2','ลูกค้า ง',null,null,null,'Not Started',null),
    (106,null,null,'งานรหัส null','ลูกค้า จ',null,null,null,'Not Started',null)`);
  const before = (await pg.query('select count(*)::int c from app.projects')).rows[0].c;

  const o86 = runSql(PG_T, '86-projects-id-dup-check.sql');
  ok(/พบ ID ซ้ำ 1 ชุด รวม 2 แถว/.test(o86), '86 ส่องเจอ "ID ซ้ำ 1 ชุด รวม 2 แถว"');
  ok(/จากชีต 2 \/ จากแอป 0/.test(o86),
     '86 บอกได้ด้วยว่าแถวมาจากไหน (ดูจาก _hash) — ชีต 2 / แอป 0');

  const o88a = runSql(PG_T, '88-projects-id-unique.sql');
  ok(/ยังมี Project ID ซ้ำอยู่ 1 ชุด/.test(o88a) && /ROLLBACK/.test(o88a),
     '🔴 88 หยุดเองเมื่อยังมีของซ้ำ แล้วถอยทั้งก้อน (ไม่ลบแถวทิ้งเอง)');
  const idxAfterStop = (await pg.query(
    `select count(*)::int c from pg_indexes where indexname='projects_id_uk'`)).rows[0].c;
  ok(idxAfterStop === 0, '88 ที่หยุดกลางทาง ไม่ทิ้งด่านครึ่ง ๆ ไว้');

  const o87 = runSql(PG_T, '87-projects-id-dup-fix.sql');
  ok(/eb12d611 → [a-f][0-9a-f]{7}/.test(o87), '87 ออกรหัสใหม่ให้รูปแบบเดิมเป๊ะ (ตัวแรก a-f + hex 7 ตัว)');
  const keep = (await pg.query(`select "ID" from app.projects where _row=101`)).rows[0].ID;
  const moved = (await pg.query(`select "ID" from app.projects where _row=102`)).rows[0].ID;
  ok(keep === 'eb12d611', '🔴 แถวเก่าสุด (_row=101) เก็บรหัสเดิมไว้ — ลิงก์/QR ที่เคยบันทึกไม่พัง');
  ok(moved !== 'eb12d611' && /^[a-f][0-9a-f]{7}$/.test(moved),
     '🔴 แถวที่ใหม่กว่า (_row=102) ได้รหัสใหม่ = ' + moved);
  const after = (await pg.query('select count(*)::int c from app.projects')).rows[0].c;
  ok(before === after, 'จำนวนแถวก่อน/หลังเท่ากัน ' + before + ' = ' + after + ' (ไม่มีแถวหาย)');
  const logged = (await pg.query(
    `select old_id,new_id,project_row from app.projects_id_dup_fix_log order by _id`)).rows;
  ok(logged.length === 1 && logged[0].old_id === 'eb12d611' && logged[0].new_id === moved,
     'จดสมุดไว้ครบ — ย้อนดูได้ว่ารหัสใหม่ใบนี้เมื่อก่อนคือรหัสอะไร');

  const o88b = runSql(PG_T, '88-projects-id-unique.sql');
  ok(/ด่าน projects_id_uk ติดแล้ว/.test(o88b), '88 ใส่ด่านสำเร็จหลังไม่มีของซ้ำแล้ว');

  /* รันซ้ำทั้งชุด — ต้องไม่พังและไม่เปลี่ยนอะไรอีก */
  runSql(PG_T, '86-projects-id-dup-check.sql');
  runSql(PG_T, '87-projects-id-dup-fix.sql');
  runSql(PG_T, '88-projects-id-unique.sql');
  const again = (await pg.query('select count(*)::int c from app.projects')).rows[0].c;
  const keep2 = (await pg.query(`select "ID" from app.projects where _row=101`)).rows[0].ID;
  const log2 = (await pg.query('select count(*)::int c from app.projects_id_dup_fix_log')).rows[0].c;
  ok(again === before && keep2 === 'eb12d611' && log2 === 1,
     '🔒 รัน 86→87→88 ซ้ำอีกรอบ: แถวเท่าเดิม · รหัสไม่ขยับ · ไม่จดซ้ำ (idempotent)');

  /* ด่านจริงต้องกันได้ */
  let blocked = 0, rw = 950;
  for (const v of ['eb12d611', 'EB12D611', ' eb12d611 ']) {
    try { await pg.query(`insert into app.projects (_row,"ID","Project") values ($2,$1,'ลองซ้ำ')`, [v, rw++]); }
    catch (e) { if (e.code === '23505') blocked++; }
  }
  ok(blocked === 3, '🔒 ฐานปฏิเสธรหัสซ้ำทั้ง 3 แบบ (ตรงตัว · ตัวพิมพ์ใหญ่ · มีช่องว่างหน้าหลัง) ด้วย 23505');
  let emptyOk = true;
  try {
    await pg.query(`insert into app.projects (_row,"ID","Project") values (901,'','ยังไม่มีรหัส 1')`);
    await pg.query(`insert into app.projects (_row,"ID","Project") values (902,'','ยังไม่มีรหัส 2')`);
  } catch { emptyOk = false; }
  ok(emptyOk, 'แถวที่ "ยังไม่มีรหัส" (ว่าง) มีได้หลายแถว — ด่านไม่ไปขวางของที่ไม่เกี่ยว');

  /* ═══════════════════════════════════════════════════════════════
   *  ② เซิร์ฟเวอร์จริง — ยิง /api/project/create 2 ครั้งด้วยรหัสเดียวกัน
   * ═══════════════════════════════════════════════════════════════ */
  head('② ยิงผ่านเซิร์ฟเวอร์จริง (ไม่ใช่จำลอง)');
  /* ‼ ช่วงนี้จำลอง "โลกก่อนใส่ด่านที่ฐาน" — เพราะต้องพิสูจน์ว่า **ยามฝั่งแอป**
   *   กันได้ด้วยตัวเอง ไม่ใช่รอดเพราะฐานช่วยไว้ (ถ้าพี่เอยังไม่ได้รัน sql/88
   *   ก็ต้องกันได้อยู่ดี) — ด่านที่ฐานถูกใส่กลับตอน red-team R3 */
  await pg.query('drop index if exists app.projects_id_uk');
  await pg.query('delete from app.projects');
  await pg.query('delete from app.requirements');
  await pg.query('delete from app.contacts');
  const hash = require('bcryptjs').hashSync('test1234', 10);
  await pg.query(`insert into app.app_users ("Username","Nickname","Name","Permission","PasswordHash","Status")
    values ('admin','แอดมิน','Administrator','Administrator',$1,'Login'),
           ('dupsale','ส้ม','(ส้ม) อารยา เกษร','Sale',$1,'Login')
    on conflict (lower("Username")) do update set "PasswordHash"=excluded."PasswordHash",
      "Permission"=excluded."Permission","Name"=excluded."Name","Status"=excluded."Status"`, [hash]);
  await pg.query(`insert into app.contacts (_row,"ID","First Name","แสดงชื่อบริษัท","Company","Create By")
    values (1,'c0000001','คุณเอ','บริษัท ซี แอนด์ เอ 2020 จำกัด','บริษัท ซี แอนด์ เอ 2020 จำกัด','(ส้ม) อารยา เกษร')`);

  const rest = await require('./fake-postgrest').start(PG_T, REST_PORT);
  const env = { ...process.env,
    SUPABASE_URL: `http://127.0.0.1:${REST_PORT}`, SUPABASE_KEY: 'test-key',
    SESSION_SECRET: 'a'.repeat(64), NODE_ENV: 'development', PORT: String(APP_PORT),
    SYNC_ON_BOOT: '0', SYNC_EVERY_MIN: '0' };
  const app = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'pipe' });
  let booted = false;
  app.stdout.on('data', d => { if (String(d).includes('พอร์ต')) booted = true; });
  app.stderr.on('data', d => { if (/Error|error/.test(String(d))) process.stderr.write('[server] ' + d); });
  for (let i = 0; i < 80 && !booted; i++) await sleep(200);

  const base = `http://127.0.0.1:${APP_PORT}`;
  const login = async who => {
    const r = await fetch(base + '/api/login', { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: who, password: 'test1234' }) });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    return sc.map(s => s.split(';')[0]).join('; ');
  };
  const post = async (cookie, p, body) => {
    const r = await fetch(base + '/m/projects' + p, { method: 'POST',
      headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    let j = null; try { j = await r.json(); } catch { j = null; }
    return { status: r.status, body: j || {} };
  };
  const get = async (cookie, p) => (await fetch(base + '/m/projects' + p, { headers: { cookie } })).json();

  try {
    const sale = await login('dupsale');
    const boss = await login('admin');
    ok(!!sale, 'ล็อกอินได้');

    const body = jt => ({
      projectId: SAME, contactId: 'c0000001',
      companyName: 'บริษัท ซี แอนด์ เอ 2020 จำกัด', sales: '(ส้ม) อารยา เกษร',
      project: 'QZ2608/029-1 · IV-2026081100005', workGroup: 'กลุ่มงานป้าย',
      jobType: jt, owner: '(นุ่มนิ่ม) สุภารัตน์ หาญปัอ', status: 'Complete',
      deliveryType: 'ติดตั้ง', deliveryAddress: '99 ถ.ทดสอบ', locationMaps: 'https://maps.app.goo.gl/abc', started: '2026-09-09', due: '2026-09-09',
      deliveryCust: '2026-09-09', completeDate: '2026-09-09', requirements: [],
    });
    const c1 = await post(sale, '/api/project/create', body('วาง scale ตัวอักษร'));
    const c2 = await post(sale, '/api/project/create', body('เริ่มออกแบบใหม่'));
    ok(c1.body.ok === true && c1.body.id === SAME,
       'เปิดงานใบแรกได้รหัสตามที่ฟอร์มสุ่มไว้ (' + c1.body.id + ')');
    ok(c2.body.ok === true && c2.body.id !== SAME,
       '🔴 กดบันทึกซ้ำด้วยรหัสเดิม (ท่าที่ทำให้เกิดปัญหา) → เซิร์ฟเวอร์ออกรหัสใหม่ให้ = ' + c2.body.id);
    const ids = (await pg.query(`select "ID" from app.projects order by _row`)).rows.map(r => r.ID);
    ok(ids.length === 2 && new Set(ids).size === 2,
       'ในตารางมี 2 แถว รหัสไม่ซ้ำกัน (' + ids.join(' · ') + ')');

    /* ④ ID เก่าต้องใช้ได้ต่อ */
    head('④ ID เก่าต้องใช้ได้ต่อ');
    const g1 = await get(sale, '/api/project/' + SAME);
    ok(g1.ok && g1.project && g1.project.id === SAME,
       'เปิดงานเก่าด้วยรหัสเดิม ' + SAME + ' ได้ปกติ (รูปแบบรหัสไม่ถูกเปลี่ยน)');
    ok(/^[a-f][0-9a-f]{7}$/.test(c2.body.id),
       'รหัสที่ออกใหม่หน้าตาเหมือนของเดิมทุกตัวอักษร — แอปผลิต/จองคิวที่จับคู่ด้วย ID ไม่งง');

    /* ⑥ ตัวตรวจบนหน้าจอ */
    head('⑥ ตัวตรวจ "ตอนนี้ซ้ำกี่ชุด" ต้องเห็นได้จริง');
    const d0 = await get(boss, '/api/maint/dup-ids');
    ok(d0.ok === true && d0.duplicateGroups === 0,
       'ตอนไม่มีของซ้ำ /api/maint/dup-ids ตอบ 0 ชุด (สแกน ' + d0.scannedRows + ' แถว)');
    /* ใส่ของซ้ำเข้าไปตรง ๆ ที่ฐาน (เลียนแบบแถวเก่าที่ตกค้างมาจากชีต) */
    await pg.query(`insert into app.projects (_row,"ID","Project","แสดงชื่อลูกค้า") values (777,$1,
      'QZ2608/029-1 · IV-2026081100005','บริษัท ซี แอนด์ เอ 2020 จำกัด')`, [SAME]);
    const d1 = await get(boss, '/api/maint/dup-ids');
    ok(d1.duplicateGroups === 1 && d1.duplicateRows === 2 && d1.groups[0].id === SAME,
       '🔴 มีของซ้ำเมื่อไหร่ ตัวตรวจบอกทันที — ' + d1.duplicateGroups + ' ชุด / ' + d1.duplicateRows + ' แถว');
    ok(/sql\/87/.test(d1.howToFix || ''), 'บอกวิธีแก้มาด้วย ไม่ใช่บอกแค่ว่าซ้ำ');
    const dash = await get(boss, '/api/dashboard?period=all');
    ok(dash && dash.dupIds && dash.dupIds.groups === 1,
       '🔴 แถบเตือนบน Dashboard ได้ตัวเลขจริง (' + (dash.dupIds || {}).groups + ' ชุด) โดยไม่ยิงฐานเพิ่ม');
    const sres = await get(boss, '/api/search?q=QZ2608');
    const sids = (sres.rows || []).map(r => r.id);
    ok(sids.length >= 2 && new Set(sids).size < sids.length,
       'ผลค้นหาคืนการ์ดที่ ID ซ้ำกันจริง (' + sids.join(' · ') + ') — ตรงกับภาพที่พี่เอเจอ');

    /* ═════════════════════════════════════════════════════════════
     *  ⑦ red-team — ถอดยามทีละตัว ต้องแดงทุกตัว
     *    ‼ ต้องบิด "ทางที่โค้ดเดินจริง" ไม่ใช่กิ่งที่ไม่มีวันเดินผ่าน
     * ═════════════════════════════════════════════════════════════ */
    head('⑦ 🔴 red-team — ถอดยามแล้วต้องแดง');

    /* R1 ถอดยามฝั่งแอป (ตรวจก่อนเขียน) → ท่าเดิมของพี่เอต้องได้ ID ซ้ำทันที */
    const r1 = mkStore();
    createOld(r1, { projectId: SAME, jobType: 'a' });
    createOld(r1, { projectId: SAME, jobType: 'b' });
    ok(r1.rows[0].ID === r1.rows[1].ID,
       'R1 ถอดยามฝั่งแอป → ซ้ำทันที (ยามตัวนี้ไม่ใช่ของตกแต่ง)');

    /* R2 ถอดการ "ตรวจครั้งสุดท้าย" ที่เพิ่มรอบนี้ → ของเดิมจะเขียนทับลงไปเลย
     *    จำลองสภาพที่สุ่มใหม่แล้วยังชนทุกครั้ง (ยัดตัวสุ่มให้คืนค่าที่ชนเสมอ) */
    const stuck = mkStore();
    stuck.rows.push({ ID: SAME, jobType: 'ของเดิม' });
    const alwaysDup = st => {                       /* แบบ "ของเดิม" — วนครบแล้วเขียนเลย */
      let id = SAME;
      for (let i = 0; i < 5 && st.find(id); i++) id = SAME;   /* สุ่มแล้วยังชน */
      st.rows.push({ ID: id, jobType: 'ใหม่' });               /* ← ไหลลงมาเขียนทั้งที่ยังชน */
      return id;
    };
    alwaysDup(stuck);
    ok(stuck.rows.length === 2 && stuck.rows[0].ID === stuck.rows[1].ID,
       'R2 ถอด "ตรวจครั้งสุดท้าย" → วนครบ 5 รอบแล้วเขียนทับลงไปเลย = ซ้ำเงียบ ๆ');
    const stuck2 = mkStore();
    stuck2.rows.push({ ID: SAME, jobType: 'ของเดิม' });
    const withFinal = st => {                       /* แบบที่แก้รอบนี้ */
      let id = SAME, dup = st.find(id);
      for (let i = 0; i < 5 && dup; i++) { id = SAME; dup = st.find(id); }
      if (dup) return { ok: false };
      st.rows.push({ ID: id }); return { ok: true };
    };
    ok(withFinal(stuck2).ok === false && stuck2.rows.length === 1,
       'R2 ใส่ยามกลับ → ไม่เขียน และบอกผู้ใช้ว่าไม่สำเร็จ (ไม่มีแถวเพิ่ม)');

    /* R3 ถอดด่านที่ฐาน → ใส่ซ้ำได้อีกทันที แล้วใส่กลับ */
    await pg.query('drop index if exists app.projects_id_uk');
    let sneaked = false;
    try { await pg.query(`insert into app.projects (_row,"ID","Project") values (778,$1,'แอบซ้ำ')`, [SAME]); sneaked = true; }
    catch { sneaked = false; }
    ok(sneaked, 'R3 ถอดด่าน projects_id_uk → ยิง SQL ตรงใส่รหัสซ้ำได้ทันที (ด่านนี้คือของจริง)');
    await pg.query(`delete from app.projects where _row in (777,778)`);   /* ล้างของที่ red-team ใส่เอง */
    runSql(PG_T, '88-projects-id-unique.sql');
    let blockedBack = false;
    try { await pg.query(`insert into app.projects (_row,"ID","Project") values (779,$1,'ซ้ำอีก')`, [SAME]); }
    catch (e) { blockedBack = (e.code === '23505'); }
    ok(blockedBack, 'R3 ใส่ด่านกลับ → กันได้เหมือนเดิม');

    /* R4 ตัวนับของ Dashboard — ป้อนของที่ไม่ซ้ำต้องได้ 0, ซ้ำต้องได้ >0 */
    ok(dupIdsOf_([['aaaaaaa1'], ['aaaaaaa2'], ['aaaaaaa3']]).groups === 0,
       'R4 ตัวนับ: ไม่มีของซ้ำ → 0 ชุด (ไม่ขึ้นแถบแดงมั่ว)');
    const r4 = dupIdsOf_([['aaaaaaa1'], ['AAAAAAA1 '], ['bbbbbbb2'], ['bbbbbbb2'], ['cccccccc']]);
    ok(r4.groups === 2 && r4.rows === 4,
       'R4 ตัวนับ: เจอ 2 ชุด / 4 แถว และมองตัวพิมพ์ใหญ่+ช่องว่างเป็นรหัสเดียวกัน (กุญแจเดียวกับด่านที่ฐาน)');

    /* R5 สายไฟบนหน้าจอ — ถ้าใครลบการเรียกทิ้ง ต้องแดง */
    const fs = require('fs');
    const html = fs.readFileSync(path.join(__dirname, '..', 'modules/projects/public/index.html'), 'utf8');
    const dashJs = fs.readFileSync(path.join(__dirname, '..', 'modules/projects/dashboard.js'), 'utf8');
    const idxJs = fs.readFileSync(path.join(__dirname, '..', 'modules/projects/index.js'), 'utf8');
    ok(/renderDash\(d\)\{[\s\S]{0,200}renderDupWarn\(d\.dupIds\)/.test(html),
       'R5 renderDash เรียก renderDupWarn จริง (ไม่ใช่มีฟังก์ชันลอย ๆ ไม่มีใครเรียก)');
    /* นับเฉพาะ "จุดที่เรียกใช้" ไม่นับบรรทัดที่ประกาศฟังก์ชัน */
    ok((html.match(/dupLine_\(rows\)/g) || []).length - (html.match(/function dupLine_\(rows\)/g) || []).length === 2,
       'R5 บรรทัดแดงถูกแปะในผลค้นหาทั้ง 2 หน้า (กระดาน + หน้าค้นหา/แก้ไข)');
    ok(/dupIds: dupIdsOf_\(idx\)/.test(dashJs), 'R5 getDashboard ส่ง dupIds ออกมาจริง');
    ok(/if \(dupRow\) \{/.test(idxJs) && /409/.test(idxJs),
       'R5 ยาม "ตรวจครั้งสุดท้าย" ยังอยู่ใน /api/project/create');
  } finally {
    app.kill();
    if (rest && rest.close) await rest.close();
  }

  await pg.end();
  psql(PG, ['-q', '-c', 'drop database if exists ' + DB]);

  console.log('\n' + '─'.repeat(60));
  console.log(`ผ่าน ${pass} · ไม่ผ่าน ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('💥', e); process.exit(1); });
