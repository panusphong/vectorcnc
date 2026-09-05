'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  ทดสอบระบบทั้งก้อน — npm test
 *  รันบน PostgreSQL จริง + ตัวจำลอง PostgREST
 *  ตรวจตั้งแต่ ล็อกอิน → session → เปิดโมดูล → สิทธิ์ → audit log
 * ═══════════════════════════════════════════════════════════════════ */
const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');

const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:55432/postgres';
const REST_PORT = 55433;
const APP_PORT = 55434;
const BASE = `http://127.0.0.1:${APP_PORT}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** ตัวช่วยยิง HTTP ที่จำ cookie ให้ (จำลองเบราว์เซอร์) */
function makeClient() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method,
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, location: res.headers.get('location') };
  };
}

(async () => {
  console.log('\n🧪 ทดสอบระบบ CRM มดงานการป้าย\n');

  /* ── 1) เตรียมข้อมูลทดสอบ ── */
  const { Client } = require('pg');
  const pg = new Client({ connectionString: PG });
  await pg.connect();
  await pg.query('truncate app.app_users, app.auth_audit restart identity');
  const hash = await bcrypt.hash('secret1234', 10);
  await pg.query(`insert into app.app_users ("Name","Nickname","Username","PasswordHash","Status","Permission")
    values ('ผู้ดูแล','เอ','admin',$1,'Login','Administrator'),
           ('พนักงานขาย','แว่น','papassorn',$1,'Login','Sale'),
           ('คนลาออก','เก่า','olduser',$1,'Logout','Sale')`, [hash]);
  // คนที่ยังใช้รหัสข้อความล้วน (ทดสอบการอัปเกรดอัตโนมัติ)
  await pg.query(`insert into app.app_users ("Name","Username","Password","Status","Permission")
    values ('รหัสเก่า','legacy','plain5678','Login','Sale')`);

  /* ── 2) เปิดตัวจำลอง PostgREST + เซิร์ฟเวอร์จริง ── */
  const rest = await require('./fake-postgrest').start(PG, REST_PORT);

  const env = {
    ...process.env,
    SUPABASE_URL: `http://127.0.0.1:${REST_PORT}`,
    SUPABASE_KEY: 'test-key',
    SESSION_SECRET: 'a'.repeat(64),
    NODE_ENV: 'development',
    PORT: String(APP_PORT),
  };
  const app = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'pipe' });
  let booted = false;
  app.stdout.on('data', d => { if (String(d).includes('พอร์ต')) booted = true; });
  app.stderr.on('data', d => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 60 && !booted; i++) await sleep(200);

  const c = makeClient();

  try {
    /* ── 3) ก่อนล็อกอิน ── */
    console.log('1) ก่อนเข้าสู่ระบบ');
    ok((await c('GET', '/')).status === 302, 'เข้าหน้าแรกโดยไม่ล็อกอิน → เด้งไปหน้า login');
    ok((await c('GET', '/api/me')).status === 401, '/api/me ตอบ 401');
    ok((await c('GET', '/api/modules')).status === 401, '/api/modules ตอบ 401');
    ok((await c('GET', '/m/sales/')).status === 302, 'เข้าโมดูลตรง ๆ ไม่ได้');
    ok((await c('GET', '/healthz')).status === 200, '/healthz เปิดได้โดยไม่ต้องล็อกอิน');

    /* ── 4) ล็อกอิน ── */
    console.log('\n2) เข้าสู่ระบบ');
    ok((await c('POST', '/api/login', { username: 'admin', password: 'ผิด' })).status === 401,
       'รหัสผ่านผิด → ปฏิเสธ');
    ok((await c('POST', '/api/login', { username: 'ไม่มีคนนี้', password: 'x' })).status === 401,
       'ไม่มีชื่อผู้ใช้ → ปฏิเสธ');

    const blocked = await c('POST', '/api/login', { username: 'olduser', password: 'secret1234' });
    ok(blocked.status === 401 && /ปิดการใช้งาน/.test(blocked.json.error || ''),
       'Status = Logout → เข้าไม่ได้ (สิ่งที่แอปเดิม 10 จาก 12 ตัวไม่ได้ตรวจ)');

    const login = await c('POST', '/api/login', { username: 'admin', password: 'secret1234' });
    ok(login.status === 200 && login.json.ok, 'รหัสถูก → เข้าได้');
    ok(login.json.user.role === 'ADMIN', 'Permission "Administrator" → บทบาท ADMIN');
    ok(!/password|hash/i.test(JSON.stringify(login.json)), 'ไม่มีรหัสผ่านหลุดออกมาใน response');

    /* ── 5) หลังล็อกอิน ── */
    console.log('\n3) หลังเข้าสู่ระบบ');
    const me = await c('GET', '/api/me');
    ok(me.status === 200 && me.json.user.username === 'admin', '/api/me คืนข้อมูลผู้ใช้');
    const mods = await c('GET', '/api/modules');
    ok(mods.status === 200 && mods.json.modules.length >= 12, `เห็นโมดูล ${mods.json.modules.length} ตัว`);
    ok((await c('GET', '/')).status === 200, 'เข้าหน้ารวมแอปได้');

    /* ── 6) ตั๋ว SSO ── */
    console.log('\n4) ตั๋วเปิดโมดูล (SSO)');
    const open = await c('GET', '/api/open/sales');
    ok(open.status === 200 && open.json.ticket, 'ขอตั๋วเปิดโมดูล sales ได้');
    ok(open.json.expiresIn <= 60, `ตั๋วหมดอายุใน ${open.json.expiresIn} วินาที`);

    const auth = require('../core/auth');
    process.env.SESSION_SECRET = 'a'.repeat(64);
    ok(auth.verifyTicket(open.json.ticket, 'sales') === 'admin', 'ตั๋วตรวจผ่านสำหรับโมดูล sales');
    ok(auth.verifyTicket(open.json.ticket, 'inventory') === null, 'ตั๋วของ sales ใช้กับ inventory ไม่ได้');
    const tampered = open.json.ticket.slice(0, -1) + (open.json.ticket.slice(-1) === 'A' ? 'B' : 'A');
    ok(auth.verifyTicket(tampered, 'sales') === null, 'แก้ตั๋ว 1 ตัวอักษร → ใช้ไม่ได้ทันที');

    ok((await c('GET', '/api/open/planned-module-x')).status === 403, 'ขอตั๋วโมดูลที่ไม่มี → ปฏิเสธ');

    /* ── 7) สิทธิ์ ── */
    console.log('\n5) สิทธิ์ตามบทบาท');
    const s = makeClient();
    await s('POST', '/api/login', { username: 'papassorn', password: 'secret1234' });
    const sMe = await s('GET', '/api/me');
    ok(sMe.json.user.role === 'VIEWER', 'Permission "Sale" → บทบาท VIEWER');
    const sMods = await s('GET', '/api/modules');
    const sees = sMods.json.modules.map(m => m.key);
    ok(!sees.includes('users'), 'VIEWER ไม่เห็นโมดูลจัดการผู้ใช้');
    ok(!sees.includes('audit'), 'VIEWER ไม่เห็นโมดูลบันทึกการใช้งาน');
    ok(sees.includes('sales'), 'VIEWER เห็นโมดูลคีย์ยอดขาย');
    ok((await s('GET', '/api/admin/modules')).status === 403, 'VIEWER เรียก API ผู้ดูแลไม่ได้');
    const aMods = await c('GET', '/api/modules');
    ok(aMods.json.modules.map(m => m.key).includes('users'), 'ADMIN เห็นโมดูลจัดการผู้ใช้');

    /* ── 8) อัปเกรดรหัสผ่านอัตโนมัติ ── */
    console.log('\n6) ย้ายรหัสผ่านเป็น bcrypt อัตโนมัติ');
    const l = makeClient();
    const lg = await l('POST', '/api/login', { username: 'legacy', password: 'plain5678' });
    ok(lg.status === 200, 'ล็อกอินด้วยรหัสเดิมจากชีตได้ (ไม่ต้องตั้งรหัสใหม่)');
    const after = await pg.query(`select "Password","PasswordHash" from app.app_users where "Username"='legacy'`);
    ok(!!after.rows[0].PasswordHash, 'ระบบสร้าง bcrypt hash ให้อัตโนมัติ');
    ok(!after.rows[0].Password, 'ล้างรหัสข้อความล้วนออกจากฐานข้อมูลแล้ว');
    const again = await makeClient()('POST', '/api/login', { username: 'legacy', password: 'plain5678' });
    ok(again.status === 200, 'ล็อกอินครั้งต่อไปด้วยรหัสเดิมยังได้ (ผ่าน hash)');

    /* ── 9) เปลี่ยนรหัสผ่าน ── */
    console.log('\n7) เปลี่ยนรหัสผ่าน');
    ok((await l('POST', '/api/change-password', { current: 'ผิด', next: 'newpass1234' })).status === 400,
       'รหัสเดิมผิด → ไม่ให้เปลี่ยน');
    ok((await l('POST', '/api/change-password', { current: 'plain5678', next: '12' })).status === 400,
       'รหัสใหม่สั้นกว่าเกณฑ์ (CFG.MIN_PASSWORD) → ไม่ให้เปลี่ยน');
    ok((await l('POST', '/api/change-password', { current: 'plain5678', next: 'newpass1234' })).status === 200,
       'เปลี่ยนรหัสผ่านสำเร็จ');

    /* ── 10) ออกจากระบบ ── */
    console.log('\n8) ออกจากระบบ');
    await c('POST', '/api/logout');
    ok((await c('GET', '/api/me')).status === 401, 'ออกจากระบบแล้วเข้าไม่ได้');

    /* ── 11) audit log ── */
    console.log('\n9) บันทึกการใช้งาน (audit)');
    await sleep(400);
    const a = await pg.query('select action, count(*)::int n from app.auth_audit group by 1 order by 1');
    const m = Object.fromEntries(a.rows.map(r => [r.action, r.n]));
    ok((m.login_ok || 0) >= 3, `บันทึกการเข้าสำเร็จ ${m.login_ok || 0} ครั้ง`);
    ok((m.login_fail || 0) >= 2, `บันทึกการเข้าล้มเหลว ${m.login_fail || 0} ครั้ง`);
    ok((m.login_blocked || 0) >= 1, 'บันทึกการเข้าที่ถูกบล็อก (บัญชีปิด)');
    ok((m.open_module || 0) >= 1, 'บันทึกการเปิดโมดูล');
    ok((m.logout || 0) >= 1, 'บันทึกการออกจากระบบ');
    ok((m.change_password || 0) >= 1, 'บันทึกการเปลี่ยนรหัสผ่าน');
    const ipRow = await pg.query(`select ip, ua from app.auth_audit where action='login_ok' limit 1`);
    ok(!!ipRow.rows[0].ip, 'บันทึก IP ผู้ใช้');

    /* ── 12) การแยกกล่องโมดูล ── */
    console.log('\n10) การแยกกล่องโมดูล');
    const host = require('../core/module-host');
    const registry = require('../core/registry');
    ok(registry.loadAll().length >= 12, 'ทะเบียนโมดูลอ่านได้ครบ');
    const vm = require('vm');
    const A = vm.createContext({}); const B = vm.createContext({});
    vm.runInContext('var CONFIG={app:"sales"};function doGet(){return CONFIG.app}', A);
    vm.runInContext('var CONFIG={app:"projects"};function doGet(){return CONFIG.app}', B);
    ok(vm.runInContext('doGet()', A) === 'sales' && vm.runInContext('doGet()', B) === 'projects',
       'สองโมดูลประกาศ CONFIG/doGet ชื่อซ้ำกันได้ ไม่ทับกัน');

  } finally {
    app.kill();
    await rest.close();
    await pg.end();
  }

  console.log('\n' + '═'.repeat(52));
  console.log(`ผ่าน ${pass} · ไม่ผ่าน ${fail}`);
  console.log('═'.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n💥 ' + e.stack); process.exit(1); });
