'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  👥 หน้าจัดการพนักงาน — npm run test:usersmanage
 *
 *  🗣 พี่เอสั่ง 17 ก.ย. 69:
 *    "ห้ามไป sync data ใดๆ ใน google sheet เข้ามาอีกแล้วนะ ทำบน supabase 100%"
 *    แล้วเลือกลำดับงานเองว่า "ทำหน้าจัดการพนักงานก่อน แล้วค่อยปิดชีต User"
 *
 *  🔴 เหตุผลที่งานนี้ต้องมาก่อนปิดชีต:
 *    ทางเดียวที่ "เพิ่มพนักงานใหม่" ได้คือพิมพ์ในชีต Login CRM > User แล้วรอซิงก์
 *    ⇒ ปิดชีตวันนี้โดยยังไม่มีหน้านี้ = พนักงานใหม่ล็อกอินไม่ได้เลยสักคน
 *
 *  ── ยามตัวนี้เฝ้า 12 เรื่อง ───────────────────────────────────────
 *    ① sql/82 เป็น "add column if not exists" ล้วน · รันซ้ำได้ · ไม่แตะข้อมูลเดิม
 *    ② 🔴 หน้านี้เปิดได้เฉพาะ admin · namna — ทั้งหน้าเว็บและ "ยิง URL ตรง"
 *       (ADMIN คนอื่น · ชื่อที่เกือบตรง · ไม่ได้ล็อกอิน ⇒ ต้องโดนปฏิเสธหมด)
 *    ③ เพิ่มพนักงานใหม่ในแอปแล้ว "ล็อกอินได้จริง" ด้วยรหัสที่ตั้งให้
 *    ④ ชื่อผู้ใช้ซ้ำถูกปฏิเสธ (ต่างตัวพิมพ์ก็ถือว่าซ้ำ)
 *    ⑤ ชื่อผู้ใช้ที่มีช่องว่างหน้า-หลัง ถูกตัดก่อนเทียบและก่อนเก็บ
 *    ⑥ 🔴 _row ของแถวที่แอปสร้าง ≥ 900,000,000 (APP_ROW_BASE) เสมอ
 *    ⑦ ปิดการใช้งาน = ล็อกอินไม่ได้ แต่ "ข้อมูลเก่ายังอยู่ครบ" (ไม่ใช่ลบทิ้ง)
 *    ⑧ 🔴 รหัสผ่านไม่โผล่ทั้งใน JSON ที่ส่งออกหน้าจอ และใน log
 *    ⑨ 🔴 ไม่มีเพดาน 1,000 แถว (หว่านพนักงาน 1,100 คนแล้วต้องเห็นครบ)
 *    ⑩ กรองตามสิทธิ์ / สาขา ได้จริง และเทียบแบบตรงเป๊ะ (ไม่ใช่ includes)
 *    ⑪ ทุกการเปลี่ยนแปลงถูกจดว่า "ใครทำ เมื่อไหร่" ลง app.auth_audit ของเดิม
 *    ⑫ 🔴 ยิงชื่อผู้ใช้ว่า "ดอกจัน" เข้า endpoint แก้ไข/ตั้งรหัส/ปิดบัญชี
 *       ต้องไม่แตะใครเลยสักแถว (ช่องโหว่ ilike ชุดเดียวกับ 13 ก.ย. 69)
 *
 *  ── red-team 6 รอบ ───────────────────────────────────────────────
 *    ถอดสิ่งที่เพิ่งแก้ออกทีละอย่าง แล้วพิสูจน์ว่า "อาการเดิมกลับมาจริง"
 *    ยามที่เขียวโดยไม่เคยแดง = ยามที่ไม่ได้เฝ้าอะไรเลย
 *
 *  ‼ ใช้ของจริงทั้งเส้น: server.js ตัวจริง + PostgREST จำลอง + Postgres 16 จริง
 *    ไม่มีการ mock ฐานข้อมูล และไม่มีการปลอม req.user
 *  ‼ ตั้งฐาน: pg_ctlcluster 16 main start
 *            export TEST_PG='postgresql://postgres@localhost:5432/postgres'
 *  🔴 ห้ามหยุดเวลาด้วย Date.now = () => … — ถ้าต้องหยุดเวลาใช้ tools/fake-clock.js
 * ═══════════════════════════════════════════════════════════════════ */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PG   = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = Number(process.env.TEST_REST_PORT_USERSMANAGE || 55621);

/* 🔴 ค่ากลางของโปรเจกต์ — เขียนไว้ที่เดียวในยามนี้ แล้วเทียบกับโค้ดจริงข้อ ⑥ */
const APP_ROW_BASE = 900000000;

let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); }
                       else { fail++; fails.push(m); console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);

/* ═══════════════════════════════════════════════════════════════════
 *  ตัวดักข้อความที่ระบบพิมพ์ออกหน้าจอ — ใช้พิสูจน์ว่า "รหัสผ่านไม่โผล่ใน log"
 *  ‼ ดักที่ process.stdout/stderr ไม่ใช่ที่ console.log
 *    เพราะ ctx.warn · console.warn · อะไรก็ตามสุดท้ายลงท่อเดียวกันหมด
 * ═══════════════════════════════════════════════════════════════════ */
let _tap = null;
const _realOut = process.stdout.write.bind(process.stdout);
const _realErr = process.stderr.write.bind(process.stderr);
process.stdout.write = (c, ...a) => { if (_tap) { _tap.push(String(c)); return true; } return _realOut(c, ...a); };
process.stderr.write = (c, ...a) => { if (_tap) { _tap.push(String(c)); return true; } return _realErr(c, ...a); };
/** รันงานโดยกลืน log ไว้ดูทีหลัง — คืน { out, value } */
async function capture(fn) {
  const buf = []; _tap = buf;
  try { const value = await fn(); return { out: buf.join(''), value }; }
  finally { _tap = null; }
}

/* ═══════════════════════════════════════════════════════════════════
 *  ยกเซิร์ฟเวอร์ตัวจริงขึ้นมา (server.js ทั้งไฟล์ ไม่ใช่ router จำลอง)
 *  ‼ ท่าเดียวกับ tools/test-appgate.js — ดัก express() ตัวแรก
 *    แล้วดัก app.listen ให้เปิดพอร์ตสุ่ม โค้ดที่ทดสอบไม่ถูกแตะสักบรรทัด
 * ═══════════════════════════════════════════════════════════════════ */
function bootRealServer() {
  return new Promise(resolve => {
    const em = require(path.join(ROOT, 'node_modules', 'express'));
    let first = null;
    const wrapped = function (...a) {
      const app = em(...a);
      if (!first) {
        first = app;
        const origListen = app.listen.bind(app);
        app.listen = (...args) => {
          const cb = args[args.length - 1];
          const srv = origListen(0, () => {});
          if (typeof cb === 'function') setTimeout(cb, 0);
          resolve({ app, srv });
          return srv;
        };
      }
      return app;
    };
    Object.setPrototypeOf(wrapped, em);
    for (const k of Object.keys(em)) wrapped[k] = em[k];
    require.cache[require.resolve(path.join(ROOT, 'node_modules', 'express'))].exports = wrapped;
    process.chdir(ROOT);
    require(path.join(ROOT, 'server.js'));
  });
}

/** โดนปฏิเสธไหม — 401 · 403 · เด้งไปหน้าล็อกอิน ถือว่า "ปฏิเสธ" */
const isDenied = (st, txt) => st === 401 || st === 403 || (st === 302 && /\/login/.test(String(txt)));

/* พนักงานตั้งต้น — ค่า Permission ทุกตัวสะกดตามที่มีจริงใน core/auth.js */
const SEED = [
  { u: 'admin',  n: 'พนัสพงษ์',       p: 'Administrator',    b: 'มดงานการป้าย' },
  { u: 'namna',  n: 'น้ำหนา',          p: 'Administrator',    b: 'มดงานการป้าย' },
  /* 🔴 ADMIN คนที่สาม — ต้องเข้าหน้านี้ไม่ได้ (กันด้วย "ชื่อ" ไม่ใช่ "บทบาท") */
  { u: 'bossx',  n: 'หัวหน้าเอ็กซ์',    p: 'Administrator',    b: 'The 101' },
  /* 🔴 ชื่อที่ "เกือบตรง" — ต้องไม่ผ่านเด็ดขาด */
  { u: 'admin2', n: 'แอดมินสอง',       p: 'Administrator',    b: 'The 101' },
  { u: 'namnax', n: 'น้ำหนาเอ็กซ์',     p: 'Administrator',    b: 'The 101' },
  /* พนักงานทั่วไป */
  { u: 'plan1',  n: 'ปราณี',           p: 'Planning',         b: 'มดงานการป้าย' },
  { u: 'ploy',   n: 'พลอยไพลิน',       p: 'Sale',             b: 'The 101' },
  { u: 'pu.s',   n: 'ปุณณภา',          p: 'Sale support',     b: 'มดงานการป้าย' },
];

(async () => {
  /* ‼ env ต้องตั้งก่อน require core/* ทุกตัว — ไม่งั้น CFG จำค่าเก่าไปแล้ว */
  process.env.SUPABASE_URL   = 'http://127.0.0.1:' + REST_PORT;
  process.env.SUPABASE_KEY   = 'test-key';
  process.env.SESSION_SECRET = 'u'.repeat(64);
  process.env.PORT           = '0';
  process.env.PHOTO_IMPORT   = 'off';
  process.env.SYNC_EVERY_MIN = '0';
  process.env.DB_TIMEOUT_MS  = '8000';

  console.log('\n🧪 หน้าจัดการพนักงาน (พี่เอสั่ง 17 ก.ย. 69 — "ทำบน supabase 100%")');

  const { Client } = require(path.join(ROOT, 'node_modules', 'pg'));
  const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
  const H = pw => bcrypt.hashSync(pw, 4);     /* cost ต่ำ = ยามเร็ว (ใช้ในยามเท่านั้น) */

  const pg = new Client({ connectionString: PG });
  await pg.connect();

  const SQL82 = fs.readFileSync(path.join(ROOT, 'sql/82-app-users-manage.sql'), 'utf8');
  const runSql82 = () => pg.query(SQL82);
  const rowOf = async u => (await pg.query(
    'select * from app.app_users where lower("Username") = lower($1)', [u])).rows[0] || null;
  const countAll = async () => Number((await pg.query('select count(*)::int n from app.app_users')).rows[0].n);

  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  let srv = null;

  try {
    /* ═══════════════════════════════════════════════════════════════
     *  ① sql/82 — "add column if not exists" ล้วน · รันซ้ำได้
     * ═══════════════════════════════════════════════════════════════ */
    head('① sql/82-app-users-manage.sql — เพิ่มคอลัมน์อย่างเดียว รันซ้ำได้');

    const body82 = SQL82.replace(/\/\*[\s\S]*?\*\//g, '');   /* ตัดคอมเมนต์ทิ้งก่อนตรวจ */
    ok(!/\bdrop\s+(table|column|index)\b/i.test(body82), 'ไม่มีคำสั่ง drop ใด ๆ เลย');
    ok(!/\bdelete\s+from\b/i.test(body82),               'ไม่มีคำสั่ง delete ใด ๆ เลย');
    ok(!/\bupdate\s+app\.app_users\b/i.test(body82),     '🔴 ไม่แก้ค่าเดิมของใครแม้แต่ช่องเดียว');
    ok(!/\balter\s+table[\s\S]*?\bdrop\b/i.test(body82), 'ไม่มี alter … drop');
    const adds = body82.match(/add column if not exists/gi) || [];
    const alters = body82.match(/alter table app\.app_users/gi) || [];
    ok(adds.length === alters.length && adds.length >= 7,
       `alter table ทุกบรรทัดเป็น "add column if not exists" (${adds.length}/${alters.length} บรรทัด)`);
    ok(/notify pgrst/i.test(body82), 'สั่ง reload schema ให้ PostgREST เห็นคอลัมน์ใหม่');

    /* เตรียมข้อมูลตั้งต้น แล้วรัน SQL ซ้ำ 3 รอบ ดูว่าข้อมูลเปลี่ยนไหม
     * ‼ รันรอบแรกก่อนหว่านข้อมูล เพราะแถวตั้งต้นมีช่อง "Branch" ซึ่งเพิ่งมาจากไฟล์นี้ */
    await runSql82();
    await pg.query('delete from app.app_users');
    await pg.query('delete from app.auth_audit');
    for (const s of SEED) {
      await pg.query(
        'insert into app.app_users ("Username","Name","Nickname","Permission","Status","PasswordHash") ' +
        'values ($1,$2,$3,$4,$5,$6)',
        [s.u, s.n, s.n.slice(0, 3), s.p, 'Login', H('pw-' + s.u)]);
      /* ‼ สาขาใส่ทีหลังด้วย update — คอลัมน์ "Branch" เพิ่งมีจาก sql/82
       *   เขียนแยกไว้เพื่อให้เห็นชัดว่าแถวตั้งต้น "มาจากชีต" (ไม่มี _row) */
      await pg.query('update app.app_users set "Branch"=$1 where "Username"=$2', [s.b, s.u]);
    }
    const before = (await pg.query('select "Username","Name","Permission","Status","PasswordHash" ' +
                                   'from app.app_users order by "Username"')).rows;
    await runSql82(); await runSql82(); await runSql82();
    const after = (await pg.query('select "Username","Name","Permission","Status","PasswordHash" ' +
                                  'from app.app_users order by "Username"')).rows;
    ok(JSON.stringify(before) === JSON.stringify(after),
       `รัน sql/82 ซ้ำ 3 รอบ ข้อมูลเดิมทั้ง ${before.length} แถวเหมือนเดิมเป๊ะทุกช่อง`);

    const cols = (await pg.query(
      `select column_name, is_nullable from information_schema.columns
        where table_schema='app' and table_name='app_users'`)).rows;
    for (const c of ['_row', 'Branch', 'Position', 'CreatedBy', 'UpdatedBy', 'DisabledAt', 'DisabledBy']) {
      const hit = cols.find(x => x.column_name === c);
      ok(!!hit && hit.is_nullable === 'YES',
         `    คอลัมน์ "${c}" มีแล้วและเป็น null ได้ (แถวเก่าไม่กระทบ)`);
    }
    ok(cols.some(c => c.column_name === 'PasswordHash') &&
       cols.some(c => c.column_name === 'Username'),
       'คอลัมน์เดิมยังอยู่ครบ ไม่ได้ถูกแตะ');

    /* ═══════════════════════════════════════════════════════════════
     *  ยกเซิร์ฟเวอร์จริง + ล็อกอินทุกคน
     * ═══════════════════════════════════════════════════════════════ */
    head('🚀 ยก server.js ตัวจริงขึ้นมา (ไม่ได้จำลอง router)');
    const booted = await capture(async () => {
      const b = await bootRealServer();
      await new Promise(r => setTimeout(r, 1200));   /* รอ mountAll ต่อสายครบทุกโมดูล */
      return b;
    });
    srv = booted.value.srv;
    const BASE = 'http://127.0.0.1:' + srv.address().port;
    ok(!!srv, 'เซิร์ฟเวอร์ขึ้นแล้วที่ ' + BASE);
    ok(/\[users\] พร้อมใช้งาน/.test(booted.out), 'โมดูล "จัดการผู้ใช้" ต่อสายสำเร็จ (อ่านจาก log ตอนบูตจริง)');

    const auth      = require(path.join(ROOT, 'core', 'auth.js'));
    const db        = require(path.join(ROOT, 'core', 'db.js'));
    const appAccess = require(path.join(ROOT, 'core', 'app-access.js'));
    const registry  = require(path.join(ROOT, 'core', 'registry.js'));

    async function hit(p, method, cookie, body) {
      const init = {
        method: String(method || 'GET').toUpperCase(), redirect: 'manual',
        headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { cookie } : {}),
      };
      if (['POST', 'PUT', 'PATCH'].includes(init.method)) init.body = JSON.stringify(body || {});
      const res = await fetch(BASE + p, init);
      const txt = await res.text();
      let j = null; try { j = JSON.parse(txt); } catch { /* ไม่ใช่ JSON */ }
      return { st: res.status, txt, j };
    }
    const login = async (username, password) => {
      const res = await fetch(BASE + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      let j = null; try { j = JSON.parse(await res.text()); } catch { /* ไม่ใช่ JSON */ }
      return { st: res.status, j, cookie: (res.headers.get('set-cookie') || '').split(';')[0] || '' };
    };

    const C = {};
    for (const s of SEED) {
      const r = await login(s.u, 'pw-' + s.u);
      if (r.st !== 200) { console.log('  ❌ ล็อกอิน ' + s.u + ' ไม่ผ่าน (' + r.st + ')'); fail++; }
      C[s.u] = r.cookie;
    }
    ok(Object.values(C).every(Boolean), 'ล็อกอินพนักงานตั้งต้นครบ ' + SEED.length + ' คน');

    /* ═══════════════════════════════════════════════════════════════
     *  ② 🔴 เข้าหน้านี้ได้เฉพาะ admin · namna — ทั้งเมนูและ "ยิง URL ตรง"
     * ═══════════════════════════════════════════════════════════════ */
    head('② 🔴 สิทธิ์เข้าหน้าจัดการพนักงาน — admin · namna เท่านั้น');
    ok(JSON.stringify(appAccess.TOOL_ADMIN_USERS) === JSON.stringify(['admin', 'namna']),
       'รายชื่อที่เปิดแอปเครื่องมือระบบได้ ยังเป็น [admin, namna] เป๊ะ (core/app-access.js:52)');
    ok(appAccess.TOOL_APPS.indexOf('users') >= 0,
       '"users" อยู่ในกลุ่มแอปเครื่องมือระบบ ⇒ ใช้ด่านเดิม ไม่ได้สร้างด่านใหม่ซ้อน');

    const modJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'modules/users/module.json'), 'utf8'));
    ok(!modJson.publicPaths || !modJson.publicPaths.length,
       'modules/users/module.json ไม่ได้เปิดเส้นทางสาธารณะไว้สักเส้น (ไม่มีทางลัดข้ามด่าน)');

    /* ทุกเส้นทางของโมดูลที่ต้องถูกกัน — หน้าเว็บ + API ทุกตัวที่แก้ข้อมูลได้ */
    const ROUTES = [
      ['/m/users/',                    'GET'],
      ['/m/users/index.html',          'GET'],
      ['/m/users/api/list',            'GET'],
      ['/m/users/api/perm-matrix',     'GET'],
      ['/m/users/api/photos',          'GET'],
      ['/m/users/api/admin/history',   'GET'],
      ['/m/users/api/create',          'POST'],
      ['/m/users/api/ploy',            'PATCH'],
      ['/m/users/api/ploy/status',     'POST'],
      ['/m/users/api/ploy/password',   'POST'],
      ['/m/users/api/ploy/photo',      'POST'],
      ['/m/users/api/export/sheet',       'POST'],   /* รอบ 234 — ส่งออกรายชื่อเป็น Google Sheet */
      ['/m/users/api/export/sheet/share', 'POST'],
    ];
    for (const who of ['bossx', 'admin2', 'namnax', 'plan1', 'ploy', 'pu.s']) {
      let denied = 0;
      for (const [p, m] of ROUTES) {
        const r = await hit(p, m, C[who]);
        if (isDenied(r.st, r.txt)) denied++;
        else console.log(`     ⚠ ${who} เข้า ${m} ${p} ได้ (${r.st})`);
      }
      ok(denied === ROUTES.length,
         `    🔴 ${who} ถูกปฏิเสธครบทุกเส้นทาง ${denied}/${ROUTES.length} (ยิง URL ตรงก็ไม่ผ่าน)`);
    }
    /* ไม่ได้ล็อกอินเลย */
    let anon = 0;
    for (const [p, m] of ROUTES) { const r = await hit(p, m, ''); if (isDenied(r.st, r.txt)) anon++; }
    ok(anon === ROUTES.length, `    ไม่ได้ล็อกอิน ถูกปฏิเสธครบ ${anon}/${ROUTES.length} (fail-closed)`);

    for (const who of ['admin', 'namna']) {
      const page = await hit('/m/users/', 'GET', C[who]);
      const list = await hit('/m/users/api/list', 'GET', C[who]);
      ok(page.st === 200 && /จัดการผู้ใช้/.test(page.txt), `    ${who} เปิดหน้าเว็บได้`);
      ok(list.st === 200 && list.j && list.j.ok === true, `    ${who} เรียก API รายชื่อได้`);
    }
    /* ข้อความปฏิเสธต้องบอกเหตุผล ห้ามหน้าขาว ห้าม error ดิบ */
    const denyPage = await hit('/m/users/', 'GET', C['bossx']);
    ok(/เฉพาะ/.test(denyPage.txt) && /admin/.test(denyPage.txt) && !/stack|at Object/i.test(denyPage.txt),
       '    หน้าปฏิเสธบอกเหตุผล + บอกว่าไปถามใครได้ (ไม่ใช่หน้าขาว ไม่ใช่ error ดิบ)');

    /* ═══════════════════════════════════════════════════════════════
     *  ③ เพิ่มพนักงานใหม่ → ล็อกอินได้จริง
     * ═══════════════════════════════════════════════════════════════ */
    head('③ เพิ่มพนักงานใหม่ในแอป แล้วล็อกอินได้จริงด้วยรหัสที่ตั้งให้');
    const NEW_PW = 'Somchai#2569!';       /* 🔴 คำนี้ห้ามโผล่ใน log / JSON */
    const created = await capture(() => hit('/m/users/api/create', 'POST', C['admin'], {
      username: 'somchai', name: 'สมชาย ใจดี', nickname: 'ชาย',
      password: NEW_PW, permission: 'Planning',
      branch: 'มดงานการป้าย', position: 'ช่างติดตั้ง',
      mobile: '0812345678', email: 'somchai@example.com',
    }));
    ok(created.value.st === 200 && created.value.j && created.value.j.ok,
       'เพิ่มพนักงาน @somchai สำเร็จผ่านหน้าจอ (ไม่ได้แตะชีตเลย)');

    const som = await rowOf('somchai');
    ok(!!som, '    แถวเข้าไปอยู่ใน app.app_users จริง');
    ok(som && String(som.Name) === 'สมชาย ใจดี' && String(som.Permission) === 'Planning',
       '    ชื่อ-สกุล · สิทธิ์ ถูกบันทึกตรงตามที่กรอก');
    ok(som && String(som.Branch) === 'มดงานการป้าย' && String(som.Position) === 'ช่างติดตั้ง',
       '    สาขา/กิจการ · ตำแหน่ง ถูกบันทึก');
    ok(som && String(som.Mobile) === '0812345678' && String(som.email) === 'somchai@example.com',
       '    เบอร์โทร · อีเมล ถูกบันทึก');
    ok(som && String(som.CreatedBy) === 'admin', '    จดว่าใครเป็นคนเพิ่ม (CreatedBy = admin)');
    ok(som && som.created_at, '    จดว่าเพิ่มเมื่อไหร่ (created_at)');
    ok(som && som.Password === null, '    🔴 ไม่เก็บรหัสผ่านเป็นข้อความล้วน (Password = null)');
    ok(som && /^\$2[aby]\$/.test(String(som.PasswordHash || '')),
       '    🔴 เก็บเป็น bcrypt ด้วยวิธีเดียวกับของเดิม (ไม่ได้เปลี่ยนวิธี hash)');
    ok(som && String(som.PasswordHash).indexOf(NEW_PW) < 0,
       '    รหัสจริงไม่ได้ปนอยู่ในค่าที่เก็บ');

    const somLogin = await login('somchai', NEW_PW);
    ok(somLogin.st === 200 && somLogin.j && somLogin.j.ok,
       '🔴 พนักงานใหม่ล็อกอินเข้าระบบได้จริงทันที (ไม่ต้องรอรอบซิงก์)');
    ok(somLogin.cookie, '    ได้คุกกี้ session กลับมา');
    const somBad = await login('somchai', NEW_PW + 'x');
    ok(somBad.st !== 200, '    ใส่รหัสผิดยังเข้าไม่ได้ตามเดิม');

    /* ═══════════════════════════════════════════════════════════════
     *  ④ ชื่อผู้ใช้ซ้ำ
     * ═══════════════════════════════════════════════════════════════ */
    head('④ ชื่อผู้ใช้ซ้ำถูกปฏิเสธ (ต่างตัวพิมพ์ก็ถือว่าซ้ำ)');
    for (const name of ['somchai', 'SomChai', 'SOMCHAI', '  somchai  ']) {
      const r = await hit('/m/users/api/create', 'POST', C['admin'],
        { username: name, password: NEW_PW, name: 'ซ้ำ' });
      ok(r.st === 409, `    "${name}" ถูกปฏิเสธด้วย 409 (ได้ ${r.st})`);
    }
    ok(await countAll() === SEED.length + 1,
       `    ไม่มีแถวซ้ำเกิดขึ้นเลย (ยังมี ${SEED.length + 1} แถวเท่าเดิม)`);

    /* ═══════════════════════════════════════════════════════════════
     *  ⑤ ช่องว่างหน้า-หลัง
     * ═══════════════════════════════════════════════════════════════ */
    head('⑤ ชื่อผู้ใช้ที่มีช่องว่างหน้า-หลัง ถูกตัดก่อนเทียบและก่อนเก็บ');
    const sp = await hit('/m/users/api/create', 'POST', C['admin'],
      { username: '   nid.s   ', name: 'นิดหน่อย', password: NEW_PW, permission: 'Sale' });
    ok(sp.st === 200 && sp.j && sp.j.ok, 'เพิ่ม "   nid.s   " สำเร็จ');
    const nid = await rowOf('nid.s');
    ok(!!nid && nid.Username === 'nid.s',
       `    เก็บลงฐานเป็น "nid.s" ไม่มีช่องว่างติดไปด้วย (ได้ "${nid && nid.Username}")`);
    ok((await login('nid.s', NEW_PW)).st === 200, '    ล็อกอินด้วย "nid.s" ได้');
    ok((await login('  nid.s  ', NEW_PW)).st === 200, '    ล็อกอินด้วย "  nid.s  " ก็ได้ (ตัดช่องว่างก่อนเทียบ)');
    ok((await hit('/m/users/api/create', 'POST', C['admin'],
        { username: ' nid.s', password: NEW_PW })).st === 409,
       '    เพิ่ม " nid.s" ซ้ำ ถูกปฏิเสธ (ตัดช่องว่างก่อนเทียบชื่อซ้ำ)');

    /* ═══════════════════════════════════════════════════════════════
     *  ⑥ 🔴 _row ของแถวที่แอปสร้าง ≥ APP_ROW_BASE
     * ═══════════════════════════════════════════════════════════════ */
    head('⑥ 🔴 เลขแถวของคนที่เพิ่มในแอป ต้อง ≥ ' + APP_ROW_BASE);
    const srcUsers = fs.readFileSync(path.join(ROOT, 'modules/users/index.js'), 'utf8');
    /* ‼ ตัดคอมเมนต์ทิ้งก่อนตรวจ — ในคอมเมนต์มีคำว่า limit: 1000 อยู่ (อธิบายของเดิม)
     *   ถ้าไม่ตัด ยามจะแดงเพราะ "คำอธิบาย" ไม่ใช่เพราะ "โค้ด" ซึ่งคือยามที่โกหก */
    const codeUsers = srcUsers.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(/const APP_ROW_BASE = 900000000/.test(srcUsers),
       'modules/users/index.js ใช้ค่ากลาง 900000000 (ไม่ได้คิดเลขเอง)');
    const SJP = require(path.join(ROOT, 'core', 'sync-jobs-purchase.js'));
    ok(SJP.APP_ROW_BASE === APP_ROW_BASE,
       'ค่าเดียวกับของกลางที่ core/sync-jobs-purchase.js ใช้ (ถ้าวันหนึ่งเลขไม่ตรง ยามแดงทันที)');

    const appRows = (await pg.query(
      'select "Username", _row from app.app_users where _row is not null order by _row')).rows;
    ok(appRows.length === 2, `มีแถวที่แอปสร้าง 2 แถว (somchai · nid.s) — ได้ ${appRows.length}`);
    ok(appRows.every(r => Number(r._row) >= APP_ROW_BASE),
       `🔴 ทุกแถวที่แอปสร้างมี _row ≥ ${APP_ROW_BASE} (${appRows.map(r => r._row).join(' · ')})`);
    ok(new Set(appRows.map(r => Number(r._row))).size === appRows.length, '    _row ไม่ชนกันเอง');
    ok(Number(appRows[1]._row) === Number(appRows[0]._row) + 1, '    เลขเดินต่อกันทีละหนึ่ง');
    const sheetRows = (await pg.query(
      'select count(*)::int n from app.app_users where _row is null')).rows[0].n;
    ok(Number(sheetRows) === SEED.length,
       `    แถวที่มาจากชีตยังเป็น null เหมือนเดิมครบ ${sheetRows} แถว (sql/82 ไม่ได้ไปเติมให้)`);

    /* ═══════════════════════════════════════════════════════════════
     *  ⑦ ปิดการใช้งาน ≠ ลบทิ้ง
     * ═══════════════════════════════════════════════════════════════ */
    head('⑦ ปิดการใช้งาน = ล็อกอินไม่ได้ แต่ข้อมูลเก่ายังอยู่ครบ (ไม่ใช่ลบทิ้ง)');
    ok(!/router\.delete/.test(srcUsers),
       '🔴 โมดูลนี้ไม่มี endpoint ลบผู้ใช้เลยสักตัว (ลาออก = ปิดการใช้งาน)');

    const beforeOff = await rowOf('somchai');
    const off = await hit('/m/users/api/somchai/status', 'POST', C['admin'], { status: 'Logout' });
    ok(off.st === 200 && off.j && off.j.status === 'Logout', 'กดปิดการใช้งาน @somchai สำเร็จ');

    const afterOff = await rowOf('somchai');
    ok(!!afterOff, '    🔴 แถวยังอยู่ ไม่ได้ถูกลบทิ้ง');
    ok(afterOff && String(afterOff.Status) === 'Logout', '    Status = Logout');
    ok(afterOff && String(afterOff.DisabledBy) === 'admin', '    จดว่าใครปิด (DisabledBy = admin)');
    ok(afterOff && afterOff.DisabledAt, '    จดว่าปิดเมื่อไหร่ (DisabledAt)');
    for (const k of ['Name', 'Nickname', 'Permission', 'Branch', 'Position', 'Mobile', 'email', '_row', 'created_at']) {
      ok(String(afterOff[k]) === String(beforeOff[k]), `    ช่อง "${k}" ยังเป็นค่าเดิมเป๊ะ`);
    }
    ok(String(afterOff.PasswordHash) === String(beforeOff.PasswordHash),
       '    รหัสผ่านเดิมยังอยู่ (เปิดกลับมาแล้วใช้รหัสเดิมได้ทันที)');

    const offLogin = await login('somchai', NEW_PW);
    ok(offLogin.st !== 200 && /ปิดการใช้งาน/.test(JSON.stringify(offLogin.j || {})),
       '🔴 ปิดแล้วล็อกอินไม่ได้ และข้อความบอกเหตุผลชัดเจน');

    const on = await hit('/m/users/api/somchai/status', 'POST', C['admin'], { status: 'Login' });
    ok(on.st === 200, 'เปิดกลับได้');
    const afterOn = await rowOf('somchai');
    ok(afterOn && afterOn.DisabledAt === null && afterOn.DisabledBy === null,
       '    เปิดกลับแล้วล้าง DisabledAt/DisabledBy ให้ว่าง');
    ok((await login('somchai', NEW_PW)).st === 200, '    เปิดกลับแล้วล็อกอินได้ด้วยรหัสเดิม');

    /* แอดมินคนสุดท้ายต้องปิดตัวเองไม่ได้ (ของเดิม — ต้องไม่หายไป) */
    ok((await hit('/m/users/api/admin/status', 'POST', C['admin'], { status: 'Logout' })).st === 400,
       '    ปิดบัญชีตัวเองไม่ได้ (กติกาเดิมยังอยู่)');

    /* ═══════════════════════════════════════════════════════════════
     *  ⑧ 🔴 รหัสผ่านไม่โผล่ใน JSON และไม่โผล่ใน log
     * ═══════════════════════════════════════════════════════════════ */
    head('⑧ 🔴 รหัสผ่านไม่โผล่ทั้งใน JSON ที่ส่งออกหน้าจอ และใน log');
    const SET_PW = 'Reset#Pass#2569';
    const setRes = await capture(() => hit('/m/users/api/somchai/password', 'POST', C['admin'],
      { password: SET_PW }));
    ok(setRes.value.st === 200, 'ผู้ดูแลตั้งรหัสผ่านใหม่ให้พนักงานได้');
    ok(setRes.out.indexOf(SET_PW) < 0,
       '🔴 รหัสที่ตั้งไม่โผล่ใน log สักตัวอักษร (ดักที่ stdout/stderr ทั้งท่อ)');
    ok((await login('somchai', SET_PW)).st === 200, '    รหัสใหม่ใช้ล็อกอินได้จริง');
    ok((await login('somchai', NEW_PW)).st !== 200, '    รหัสเก่าใช้ไม่ได้แล้ว');

    const listRes = await hit('/m/users/api/list', 'GET', C['admin']);
    const listTxt = listRes.txt;
    ok(listTxt.indexOf(SET_PW) < 0 && listTxt.indexOf(NEW_PW) < 0,
       '🔴 JSON รายชื่อพนักงานไม่มีรหัสผ่านจริงปนอยู่');
    ok(!/"PasswordHash"|"Password"|"passwordHash"/.test(listTxt),
       '🔴 ไม่มีคีย์ Password / PasswordHash ใน JSON ที่ส่งออกหน้าจอ');
    ok(listTxt.indexOf('$2a$') < 0 && listTxt.indexOf('$2b$') < 0,
       '🔴 ค่า bcrypt ก็ไม่หลุดออกไป (ห้ามแสดงรหัสเดิมในทุกรูปแบบ)');
    const somShape = (listRes.j.users || []).find(u => u.username === 'somchai');
    ok(somShape && somShape.hasPassword === true,
       '    หน้าจอยังรู้ว่า "คนนี้มีรหัสผ่านแล้ว" ได้ โดยไม่ต้องเห็นตัวรหัส');

    const histRes = await hit('/m/users/api/somchai/history', 'GET', C['admin']);
    ok(histRes.st === 200 && histRes.txt.indexOf(SET_PW) < 0 && histRes.txt.indexOf(NEW_PW) < 0,
       '🔴 ประวัติ (auth_audit) ก็ไม่มีตัวรหัสผ่านปนอยู่');

    /* ═══════════════════════════════════════════════════════════════
     *  ⑨ 🔴 ไม่มีเพดาน 1,000 แถว
     * ═══════════════════════════════════════════════════════════════ */
    head('⑨ 🔴 ไม่มีเพดาน 1,000 แถว — หว่านพนักงาน 1,100 คนแล้วต้องเห็นครบ');
    ok(!/limit:\s*1000/.test(codeUsers) && !/limit:\s*2000/.test(codeUsers),
       'ในโค้ด (ไม่นับคอมเมนต์) ไม่มี limit: 1000 / 2000 ค้างอยู่อีกแล้ว');
    ok(/db\.selectAll\(T, \{[\s\S]{0,120}order: 'Username\.asc'/.test(codeUsers),
       'หน้ารายชื่อใช้ db.selectAll (ไล่ทีละหน้าจนหมด) พร้อม order ตามที่ core/db.js บังคับ');

    const BULK = 1100;
    await pg.query(
      `insert into app.app_users ("Username","Name","Permission","Status","Branch")
       select 'bulk' || lpad(g::text, 5, '0'), 'พนักงานหมู่ ' || g, 'Sale', 'Login', 'สาขาทดสอบ'
         from generate_series(1, $1) g`, [BULK]);
    const total = await countAll();
    const big = await hit('/m/users/api/list', 'GET', C['admin']);
    ok(big.st === 200 && big.j && big.j.ok, 'อ่านรายชื่อตอนมี ' + total + ' คน ได้ปกติ');
    ok(big.j.users.length === total,
       `🔴 เห็นครบ ${total} คน ไม่ถูกตัดที่ 1,000 (ได้ ${big.j.users.length})`);
    ok(big.j.summary.allTotal === total, '    ตัวเลขสรุป "พนักงานทั้งระบบ" ตรงกับของจริง');
    ok(big.j.users.some(u => u.username === 'bulk01100'),
       '    คนที่ชื่อเรียงท้ายสุด (bulk01100) ยังอยู่ — คนกลุ่มที่เคยหายเงียบ');

    /* ตารางสิทธิ์ก็ต้องอ่านครบเหมือนกัน */
    const pm = await hit('/m/users/api/perm-matrix', 'GET', C['admin']);
    const sumCount = (pm.j.dbPermissions || []).reduce((s, x) => s + Number(x.count || 0), 0);
    ok(pm.st === 200 && sumCount === total,
       `🔴 หน้าตารางสิทธิ์นับ Permission ครบทั้ง ${total} แถว (ได้ ${sumCount})`);

    /* ═══════════════════════════════════════════════════════════════
     *  ⑩ กรองตามสิทธิ์ / สาขา
     * ═══════════════════════════════════════════════════════════════ */
    head('⑩ ค้นหา + กรองตามสิทธิ์ / สาขา');
    const byPerm = await hit('/m/users/api/list?permission=' + encodeURIComponent('Sale'), 'GET', C['admin']);
    ok(byPerm.j.users.every(u => u.permission === 'Sale'), 'กรอง "Sale" ได้เฉพาะ Sale จริง ๆ');
    ok(!byPerm.j.users.some(u => u.permission === 'Sale support'),
       '🔴 "Sale support" ไม่ติดมาด้วย (เทียบตรงเป๊ะ ไม่ใช่ includes)');
    ok(byPerm.j.users.length === BULK + 2,
       `    ได้ครบ ${BULK + 2} คน (bulk ${BULK} + ploy + nid.s) — ได้ ${byPerm.j.users.length}`);

    const wantBranch = SEED.filter(s => s.b === 'The 101').map(s => s.u).sort();
    const byBranch = await hit('/m/users/api/list?branch=' + encodeURIComponent('The 101'), 'GET', C['admin']);
    ok(byBranch.j.users.every(u => u.branch === 'The 101') &&
       JSON.stringify(byBranch.j.users.map(u => u.username).sort()) === JSON.stringify(wantBranch),
       `กรองสาขา "The 101" ได้ตรงตัวครบ ${wantBranch.length} คน (${wantBranch.join(' · ')})`);
    ok((big.j.branches || []).indexOf('The 101') >= 0 &&
       (big.j.branches || []).indexOf('สาขาทดสอบ') >= 0,
       'ตัวเลือกสาขาบนหน้าจอมาจากค่าที่มีอยู่จริงในฐาน (ไม่ได้ฝังรายชื่อไว้ในโค้ด)');
    ok((big.j.permissionsInUse || []).indexOf('Sale support') >= 0,
       'ตัวเลือกสิทธิ์ก็มาจากค่าที่มีอยู่จริงเช่นกัน');

    const bySearch = await hit('/m/users/api/list?q=' + encodeURIComponent('ช่างติดตั้ง'), 'GET', C['admin']);
    ok(bySearch.j.users.length === 1 && bySearch.j.users[0].username === 'somchai',
       'ค้นหาด้วย "ตำแหน่ง" ก็เจอ (ค้นชื่อ · username · สิทธิ์ · สาขา · ตำแหน่ง · เบอร์ · อีเมล)');
    const both = await hit('/m/users/api/list?permission=Sale&branch=' +
                           encodeURIComponent('สาขาทดสอบ'), 'GET', C['admin']);
    ok(both.j.users.length === BULK, `กรองสองชั้นพร้อมกันได้ (${both.j.users.length} คน)`);
    ok(both.j.summary.allTotal === total, '    ตัวเลข "ทั้งระบบ" ไม่เปลี่ยนตามตัวกรอง');

    /* เก็บกวาดพนักงานหมู่ออกก่อนทดสอบข้ออื่น */
    await pg.query(`delete from app.app_users where "Username" like 'bulk%'`);

    /* ═══════════════════════════════════════════════════════════════
     *  ⑪ ใครทำ เมื่อไหร่ — ใช้ตาราง audit ของเดิม
     * ═══════════════════════════════════════════════════════════════ */
    head('⑪ ทุกการเปลี่ยนแปลงถูกจดว่า "ใครทำ เมื่อไหร่" ลง app.auth_audit (ตารางเดิม)');
    const aud = (await pg.query(
      `select action, username, target, at from app.auth_audit
        where lower(target) = 'somchai' order by at`)).rows;
    for (const act of ['user_create', 'user_disable', 'user_enable', 'user_set_password']) {
      const hitRow = aud.find(r => r.action === act);
      ok(!!hitRow, `    มีรายการ "${act}" ในตาราง audit`);
      ok(hitRow && hitRow.username === 'admin', `      · จดว่าใครทำ = admin`);
      ok(hitRow && !!hitRow.at, `      · จดว่าเมื่อไหร่`);
    }
    /* แก้ข้อมูลแล้วต้องจด UpdatedBy ด้วย */
    const upd = await hit('/m/users/api/somchai', 'PATCH', C['namna'],
      { position: 'หัวหน้าช่างติดตั้ง', branch: 'The 101' });
    ok(upd.st === 200, 'namna แก้ข้อมูล @somchai ได้');
    const somUpd = await rowOf('somchai');
    ok(somUpd && somUpd.UpdatedBy === 'namna', '    จดว่าใครแก้ล่าสุด (UpdatedBy = namna)');
    ok(somUpd && String(somUpd.Position) === 'หัวหน้าช่างติดตั้ง' && String(somUpd.Branch) === 'The 101',
       '    ค่าใหม่ถูกบันทึกจริง');
    ok(somUpd && new Date(somUpd.updated_at) >= new Date(somUpd.created_at),
       '    updated_at ขยับให้เอง (trigger เดิม app_users_touch)');

    const hist = await hit('/m/users/api/somchai/history', 'GET', C['admin']);
    ok(hist.st === 200 && (hist.j.rows || []).length >= 5,
       `    เปิดดูประวัติจากหน้าจอได้ ${(hist.j.rows || []).length} รายการ`);
    ok((hist.j.rows || []).some(r => r.action === 'user_create' && r.by === 'admin'),
       '    ประวัติบอกได้ว่า "ใครเพิ่มบัญชีนี้"');
    ok((hist.j.rows || []).some(r => r.action === 'user_update' && r.by === 'namna'),
       '    ประวัติบอกได้ว่า "ใครแก้ล่าสุด"');
    ok((hist.j.rows || []).every(r => r.at), '    ทุกรายการมีเวลากำกับ');

    /* ═══════════════════════════════════════════════════════════════
     *  ⑫ 🔴 ช่องโหว่ ilike — ยิงชื่อผู้ใช้ว่า "ดอกจัน" ต้องไม่แตะใครเลย
     * ═══════════════════════════════════════════════════════════════ */
    head('⑫ 🔴 ยิงชื่อผู้ใช้ว่า * / % / _ ต้องไม่แตะใครเลยสักแถว');
    const snapshot = async () => (await pg.query(
      'select "Username","Name","Permission","Status","PasswordHash" from app.app_users order by "Username"')).rows;
    const snapBefore = await snapshot();

    for (const evil of ['*', '%', 'som_hai', 'som*', '%a%']) {
      const p = encodeURIComponent(evil);
      const r1 = await hit('/m/users/api/' + p, 'PATCH', C['admin'], { name: 'โดนยึด' });
      const r2 = await hit('/m/users/api/' + p + '/password', 'POST', C['admin'], { password: 'HACKED#2569' });
      const r3 = await hit('/m/users/api/' + p + '/status', 'POST', C['admin'], { status: 'Logout' });
      ok(r1.st === 404 && r2.st === 404 && r3.st === 404,
         `    "${evil}" → 404 ทั้งสาม endpoint (${r1.st}/${r2.st}/${r3.st})`);
    }
    const snapAfter = await snapshot();
    ok(JSON.stringify(snapBefore) === JSON.stringify(snapAfter),
       '🔴 ข้อมูลทุกแถวเหมือนเดิมเป๊ะหลังยิงชุดนี้ (ไม่มีใครถูกแก้ ถูกปิด หรือถูกตั้งรหัสใหม่)');
    ok((await login('somchai', SET_PW)).st === 200,
       '    @somchai ยังล็อกอินด้วยรหัสเดิมได้ (ไม่ได้โดนตั้งรหัสทับ)');

    /* 'pu_s' ต้องไม่ไปจับแถวของ 'pu.s' */
    ok((await hit('/m/users/api/pu_s', 'PATCH', C['admin'], { name: 'x' })).st === 404,
       '    "pu_s" ไม่ไปจับแถวของ "pu.s" (ขีดล่างไม่ใช่ตัวแทนอักขระอีกแล้ว)');
    ok((await rowOf('pu.s')).Name === 'ปุณณภา', '    แถวของ "pu.s" ไม่ถูกแตะ');

    /* ═══════════════════════════════════════════════════════════════
     *  🧨 red-team — ถอดสิ่งที่เพิ่งแก้ออกทีละอย่าง แล้วดูว่ายามแดงจริงไหม
     * ═══════════════════════════════════════════════════════════════ */
    head('🧨 red-team ① ถอดการ "คัดชื่อตรงตัว" ออก → ยิง * แก้ทับได้ทุกแถวจริงไหม');
    await pg.query(`update app.app_users set "Name" = 'ก่อนโดน'`);
    /* นี่คือ "โค้ดแบบเดิม" เป๊ะ ๆ: ส่งชื่อที่ผู้ใช้พิมพ์ลงตัวกรอง ilike ตรง ๆ */
    await db.update('app_users', { Username: 'ilike.*' }, { Name: 'โดนยึดทั้งบริษัท' });
    const wrecked = (await pg.query(
      `select count(*)::int n from app.app_users where "Name" = 'โดนยึดทั้งบริษัท'`)).rows[0].n;
    ok(Number(wrecked) === (await countAll()),
       `🔴 แดงจริง — วิธีเดิมแก้ทับทุกแถวในคำสั่งเดียว (${wrecked} แถว) นี่คืออาการถ้าถอดตัวคัดชื่อออก`);
    /* คืนค่าเดิม */
    for (const s of SEED) await pg.query('update app.app_users set "Name"=$1 where "Username"=$2', [s.n, s.u]);
    await pg.query(`update app.app_users set "Name"='สมชาย ใจดี' where "Username"='somchai'`);
    await pg.query(`update app.app_users set "Name"='นิดหน่อย'   where "Username"='nid.s'`);
    ok((await rowOf('ploy')).Name === 'พลอยไพลิน', '    คืนข้อมูลกลับเรียบร้อย ทดสอบข้ออื่นต่อได้');

    head('🧨 red-team ② ถอด selectAll กลับไปเป็น select(limit 1000) → ข้อมูลขาดจริงไหม');
    await pg.query(
      `insert into app.app_users ("Username","Name","Permission","Status")
       select 'bulk' || lpad(g::text, 5, '0'), 'หมู่ ' || g, 'Sale', 'Login'
         from generate_series(1, 1100) g`);
    const capped = await db.select('app_users', { select: 'Username', order: 'Username.asc', limit: 1000 });
    const uncapped = await db.selectAll('app_users', { select: 'Username', order: 'Username.asc' });
    ok(capped.length === 1000,
       `🔴 แดงจริง — วิธีเดิมได้ 1,000 แถวพอดีเป๊ะ (เลขกลม ๆ = โดนตัด ไม่ใช่ของครบ)`);
    ok(uncapped.length === await countAll(),
       `    ส่วน selectAll ได้ครบ ${uncapped.length} แถว — ต่างกัน ${uncapped.length - capped.length} คน`);
    await pg.query(`delete from app.app_users where "Username" like 'bulk%'`);

    head('🧨 red-team ③ ถอด APP_ROW_BASE ไปใช้ db.nextRow() → เลขตกลงไปชนช่วงของชีตจริงไหม');
    const naive = await db.nextRow('app_users');
    ok(Number(naive) < APP_ROW_BASE,
       `🔴 แดงจริง — db.nextRow('app_users') ให้เลข ${naive} ซึ่งต่ำกว่า ${APP_ROW_BASE} ` +
       '(อยู่ในช่วงเลขแถวของชีต ⇒ ตัวซิงก์มองเห็นและทับได้)');
    /* ‼ db.nextRow อ่าน max(_row) ของทั้งตาราง ซึ่งตอนนี้มีแถวของแอปอยู่แล้ว */
    ok(Number(naive) === 1 || Number(naive) >= APP_ROW_BASE + 1,
       `    (ค่าที่ได้จริง = ${naive} — อธิบายไว้ในรายงานว่าทำไมถึงเป็นเลขนี้)`);

    head('🧨 red-team ④ ถอดด่านชื่อผู้ใช้ออก → คนอื่นเข้าหน้านี้ได้จริงไหม');
    /* ‼ ใช้ bossx (Permission = Administrator ⇒ role ADMIN) ไม่ใช่ plan1
     *   เพราะโมดูลนี้ตั้ง minRoleUse = ADMIN ไว้ใน module.json ด้วย
     *   ⇒ plan1 ถูกกัน 2 ชั้น ถอดชั้นเดียวก็ยังเข้าไม่ได้ (ดีแล้ว แต่พิสูจน์ชั้นนี้ไม่ได้)
     *   bossx ผ่านชั้น role อยู่แล้ว เหลือถูกกันด้วย "ชื่อผู้ใช้" ชั้นเดียว
     *   ⇒ ถอดชั้นนั้นออกแล้วต้องเข้าได้ทันที = พิสูจน์ได้ว่าชั้นนี้ทำงานจริง */
    const beforeGate = await hit('/m/users/api/list', 'GET', C['bossx']);
    appAccess.TOOL_ADMIN_USERS.push('bossx');          /* ← ถอดด่าน (ชั่วคราว) */
    const duringGate = await hit('/m/users/api/list', 'GET', C['bossx']);
    appAccess.TOOL_ADMIN_USERS.pop();                  /* ← ใส่ด่านกลับ */
    const afterGate = await hit('/m/users/api/list', 'GET', C['bossx']);
    ok(beforeGate.st === 403, '    ก่อนถอด: bossx (ADMIN คนที่สาม) โดน 403');
    ok(duringGate.st === 200,
       '🔴 แดงจริง — พอเติมชื่อ bossx เข้า TOOL_ADMIN_USERS เขาเข้าได้ทันที ' +
       '(พิสูจน์ว่าสิ่งที่กันอยู่คือรายชื่อนี้จริง ๆ ไม่ใช่บังเอิญ)');
    ok(afterGate.st === 403, '    ใส่ด่านกลับแล้ว bossx โดน 403 เหมือนเดิม');
    /* ‼ บันทึกไว้ให้ชัด: plan1 ถูกกันสองชั้น (ชื่อผู้ใช้ + minRoleUse ADMIN) */
    appAccess.TOOL_ADMIN_USERS.push('plan1');
    const planDuring = await hit('/m/users/api/list', 'GET', C['plan1']);
    appAccess.TOOL_ADMIN_USERS.pop();
    ok(planDuring.st === 403,
       '    ℹ plan1 ถูกกัน 2 ชั้น — ต่อให้ชื่ออยู่ในรายชื่อ ก็ยังติด minRoleUse = ADMIN ของ module.json');

    head('🧨 red-team ⑤ ถอดผลของ "ปิดการใช้งาน" ออก → คนที่ถูกปิดกลับเข้าได้จริงไหม');
    await hit('/m/users/api/nid.s/status', 'POST', C['admin'], { status: 'Logout' });
    auth.forgetUser('nid.s');
    ok((await login('nid.s', NEW_PW)).st !== 200, '    ปิดแล้วเข้าไม่ได้');
    await pg.query(`update app.app_users set "Status"='Login' where "Username"='nid.s'`);
    auth.forgetUser('nid.s');
    ok((await login('nid.s', NEW_PW)).st === 200,
       '🔴 แดงจริง — พอแก้ Status กลับเป็น Login เขาเข้าได้ทันที ' +
       '(พิสูจน์ว่าที่เข้าไม่ได้เพราะ Status ไม่ใช่เพราะรหัสผิด)');

    head('🧨 red-team ⑥ ถอดการคัดชื่อออกจาก "ตัวกันชื่อซ้ำ" → ปฏิเสธคนที่ไม่ได้ซ้ำจริงไหม');
    /* วิธีเดิมใช้ db.one(ilike) ตรง ๆ — 'pu_s' จะไปเจอแถวของ 'pu.s' แล้วตอบว่าซ้ำ */
    const oldWay = await db.one('app_users', { Username: 'ilike.pu_s', select: 'Username' });
    ok(!!oldWay && oldWay.Username === 'pu.s',
       `🔴 แดงจริง — วิธีเดิมถาม "pu_s" แล้วได้แถวของ "${oldWay && oldWay.Username}" กลับมา ` +
       '⇒ คนชื่อ pu_s จะถูกปฏิเสธว่า "มีชื่อนี้อยู่แล้ว" ทั้งที่ยังไม่มีใครใช้');
    const newWay = await hit('/m/users/api/create', 'POST', C['admin'],
      { username: 'pu_s', name: 'ทดสอบขีดล่าง', password: NEW_PW, permission: 'Sale' });
    ok(newWay.st === 200, '    วิธีใหม่เพิ่ม "pu_s" ได้ตามปกติ (คัดชื่อตรงตัวก่อนตัดสิน)');
    ok((await rowOf('pu.s')).Name === 'ปุณณภา', '    และไม่ไปแตะแถวของ "pu.s" เลย');
    await pg.query(`delete from app.app_users where "Username"='pu_s'`);

    /* ═══════════════════════════════════════════════════════════════
     *  ⑬ ยังไม่ได้รัน sql/82 ก็ต้องไม่พัง — ต้องตะโกนบอก ไม่ใช่ตายเงียบ
     *    (ทดสอบที่ระดับโมดูล เพราะ drop column บนฐานจริงคือการทำลายข้อมูล)
     * ═══════════════════════════════════════════════════════════════ */
    head('⑬ ยังไม่ได้รัน sql/82 → หน้าจอต้องใช้งานได้ + ตะโกนบอกให้ไปรัน SQL');
    const USERS_MOD = require(path.join(ROOT, 'modules/users/index.js'));
    const routes = [];
    const rt = {
      use: () => {},
      get:   (p, h) => routes.push({ m: 'GET', p, h }),
      post:  (p, h) => routes.push({ m: 'POST', p, h }),
      patch: (p, h) => routes.push({ m: 'PATCH', p, h }),
    };
    const MANAGE_RX = /_row|Branch|Position|CreatedBy|UpdatedBy|DisabledAt|DisabledBy/;
    const oldDb = {
      /* ฐานที่ "ยังไม่ได้รัน sql/82" — ถามคอลัมน์ชุดใหม่แล้วตอบ 400 เหมือนของจริง */
      one: async (t, p) => {
        if (p && MANAGE_RX.test(String(p.select || ''))) {
          const e = new Error('Supabase 400: failed to parse select parameter'); e.status = 400; throw e;
        }
        return null;
      },
      selectAll: async () => [
        { _id: 1, Username: 'admin', Name: 'ผู้ดูแล', Permission: 'Administrator',
          Status: 'Login', PasswordHash: 'x' },
      ],
      select: async () => [],
    };
    await USERS_MOD.mount(rt, {
      db: oldDb, auth, CFG: require(path.join(ROOT, 'core/config')).CFG,
      audit: async () => {}, warn: () => {}, log: () => {},
    });
    const listH = routes.find(r => r.m === 'GET' && r.p === '/api/list');
    const got = await new Promise(res => {
      const fake = { statusCode: 200, status(c) { this.statusCode = c; return this; },
                     json(b) { res({ st: this.statusCode, b }); } };
      listH.h({ query: {}, params: {}, user: { username: 'admin' }, body: {} }, fake);
    });
    ok(got.st === 200 && got.b.ok === true,
       'ยังไม่ได้รัน SQL แต่หน้ารายชื่อยังใช้งานได้ตามปกติ (ไม่ตายทั้งหน้า)');
    ok(got.b.sqlReady === false && /82-app-users-manage/.test(String(got.b.sqlFile)),
       '🔴 ตอบกลับบอกชัดว่า "ยังไม่ได้รัน sql/82" — หน้าจอเอาไปขึ้นแถบแดงให้คนแก้');
    ok((got.b.users || []).length === 1 && got.b.users[0].username === 'admin',
       '    รายชื่อยังอ่านได้ครบ (แค่ไม่มีช่องสาขา/ตำแหน่ง)');
    const htmlSrc = fs.readFileSync(path.join(ROOT, 'modules/users/public/index.html'), 'utf8');
    ok(/sqlWarn/.test(htmlSrc) && /sqlReady/.test(htmlSrc),
       '    หน้าเว็บมีที่สำหรับขึ้นคำเตือนนี้จริง (ไม่ได้ส่งค่าไปแล้วไม่มีใครใช้)');

  } finally {
    /* ‼ เก็บกวาด — ยามตัวอื่นใช้ app_users ร่วมกัน (test-appgate · test-logingate) */
    try {
      await pg.query(`delete from app.app_users where "Username" like 'bulk%'`);
      await pg.query(`delete from app.app_users where "Username" in ('somchai','nid.s','pu_s')`);
      await pg.query('delete from app.app_users');
      await pg.query('delete from app.auth_audit');
    } catch { /* ฐานล่มตอนเก็บกวาดก็ช่าง */ }
    await pg.end().catch(() => {});
    rest && rest.close && rest.close();
    try { srv && srv.close(); } catch { /* ปิดไม่ได้ก็ช่าง */ }
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ผ่าน ${pass} · ตก ${fail}`);
  if (fail) { console.log('\nข้อที่ตก:'); fails.forEach(m => console.log('  · ' + m)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { _tap = null; console.error('\n💥 ' + ((e && e.stack) || e)); process.exit(1); });
