'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  ทดสอบโมดูล "จัดการผู้ใช้" + "บันทึกการใช้งาน" — npm run test:modules
 *
 *  เน้นข้อที่แอปเดิมพลาด:
 *    · แอดมินเท่านั้นที่เข้าได้ (เดิมใครยิง URL ถูกก็เข้าได้)
 *    · ไม่มีรหัสผ่าน/hash หลุดออก response ไหนเลย
 *    · ปิดบัญชีตัวเอง / ลดสิทธิ์แอดมินคนสุดท้ายไม่ได้ (กันล็อกตัวเองออก)
 *    · ปิดบัญชีแล้วเด้งออกทันที ไม่ต้องรอ session หมดอายุ
 *    · ทุกการเปลี่ยนแปลงถูกบันทึกลง audit
 * ═══════════════════════════════════════════════════════════════════ */
const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');

const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:55432/postgres';
const REST_PORT = 55443;
const APP_PORT = 55444;
const BASE = `http://127.0.0.1:${APP_PORT}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeClient() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON */ }
    return { status: res.status, json, text };
  };
}

(async () => {
  console.log('\n🧪 ทดสอบโมดูล จัดการผู้ใช้ + บันทึกการใช้งาน\n');

  const { Client } = require('pg');
  const pg = new Client({ connectionString: PG });
  await pg.connect();
  await pg.query('truncate app.app_users, app.auth_audit restart identity');
  const hash = await bcrypt.hash('secret1234', 10);
  await pg.query(`insert into app.app_users ("Name","Nickname","Username","PasswordHash","Status","Permission")
    values ('ผู้ดูแล','เอ','admin',$1,'Login','Administrator'),
           ('ผู้ดูแลสอง','บี','admin2',$1,'Login','Administrator'),
           ('พนักงานขาย','แว่น','papassorn',$1,'Login','Sale')`, [hash]);

  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  const env = {
    ...process.env,
    SUPABASE_URL: `http://127.0.0.1:${REST_PORT}`,
    SUPABASE_KEY: 'test-key',
    SESSION_SECRET: 'b'.repeat(64),
    NODE_ENV: 'development',
    PORT: String(APP_PORT),
  };
  const app = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'pipe' });
  let booted = false;
  app.stdout.on('data', d => { if (String(d).includes('พอร์ต')) booted = true; });
  app.stderr.on('data', d => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 60 && !booted; i++) await sleep(200);

  const U = '/m/users', A = '/m/audit';
  const admin = makeClient();
  const sale = makeClient();

  try {
    await admin('POST', '/api/login', { username: 'admin', password: 'secret1234' });
    await sale('POST', '/api/login', { username: 'papassorn', password: 'secret1234' });

    /* ── 1) ด่านสิทธิ์ ── */
    console.log('1) ด่านสิทธิ์');
    ok((await sale('GET', U + '/api/list')).status === 403,
       'พนักงานขายเปิด "จัดการผู้ใช้" ไม่ได้ (403)');
    ok((await sale('GET', A + '/api/list')).status === 403,
       'พนักงานขายเปิด "บันทึกการใช้งาน" ไม่ได้ (403)');
    ok((await sale('POST', U + '/api/create',
        { username: 'hacker', password: 'abcd1234' })).status === 403,
       'พนักงานขายสร้างผู้ใช้ไม่ได้ แม้ยิง API ตรง');

    const mods = await sale('GET', '/api/modules');
    const keys = (mods.json.modules || []).map(m => m.key);
    ok(!keys.includes('users') && !keys.includes('audit'),
       'พนักงานขายไม่เห็นการ์ด 2 โมดูลนี้ในหน้ารวมแอป');

    const list = await admin('GET', U + '/api/list');
    ok(list.status === 200 && list.json.users.length === 3, 'แอดมินอ่านรายชื่อได้ครบ 3 คน');
    ok(list.json.minPassword === 4, 'ส่งเกณฑ์ความยาวรหัสผ่าน (4) ไปให้หน้าเว็บ');

    /* ── 2) ไม่มีรหัสผ่านหลุด ── */
    console.log('\n2) ความปลอดภัยของรหัสผ่าน');
    ok(!/\$2[aby]\$/.test(JSON.stringify(list.json)), 'ไม่มี bcrypt hash หลุดออกมาใน response');
    ok(!/"Password"|"PasswordHash"|secret1234/.test(JSON.stringify(list.json)),
       'ไม่มีช่องรหัสผ่านหรือรหัสจริงหลุดออกมา');
    ok(list.json.users.every(u => typeof u.hasPassword === 'boolean'),
       'บอกได้แค่ว่า "มีรหัสผ่านแล้วหรือยัง" ไม่บอกตัวรหัส');

    /* ── 3) เพิ่มผู้ใช้ ── */
    console.log('\n3) เพิ่มผู้ใช้');
    ok((await admin('POST', U + '/api/create',
        { username: 'newbie', password: '12' })).status === 400,
       'รหัสผ่านสั้นกว่าเกณฑ์ → ปฏิเสธ');
    // เกณฑ์ตอนนี้คือ 4 ตัว — รหัสเลข 4 หลักแบบที่ทีมใช้กันต้องผ่าน
    ok((await admin('POST', U + '/api/create',
        { username: 'pintest', password: '1389' })).status === 200,
       'รหัสเลข 4 หลัก (แบบที่ทีมใช้อยู่) → ตั้งได้');
    ok((await admin('POST', U + '/api/create',
        { username: 'ชื่อไทย', password: 'abcd1234' })).status === 400,
       'ชื่อผู้ใช้ผิดรูปแบบ → ปฏิเสธ');

    const created = await admin('POST', U + '/api/create',
      { username: 'newbie', name: 'พนักงานใหม่', nickname: 'ใหม่',
        password: 'abcd1234', permission: 'Sale' });
    ok(created.status === 200, 'เพิ่มผู้ใช้ใหม่สำเร็จ');
    ok((await admin('POST', U + '/api/create',
        { username: 'NEWBIE', password: 'abcd1234' })).status === 409,
       'ชื่อซ้ำ (ต่างแค่ตัวพิมพ์) → ปฏิเสธ');

    const dbRow = await pg.query(`select "Password","PasswordHash" from app.app_users where "Username"='newbie'`);
    ok(!dbRow.rows[0].Password && /^\$2[aby]\$/.test(dbRow.rows[0].PasswordHash || ''),
       'ฐานข้อมูลเก็บ bcrypt เท่านั้น ไม่มีรหัสข้อความล้วน');

    const newbie = makeClient();
    ok((await newbie('POST', '/api/login',
        { username: 'newbie', password: 'abcd1234' })).status === 200,
       'ผู้ใช้ใหม่ล็อกอินได้ทันที');

    /* ── 4) กันล็อกตัวเองออก ── */
    console.log('\n4) กันล็อกตัวเองออก');
    ok((await admin('POST', U + '/api/admin/status', { status: 'Logout' })).status === 400,
       'ปิดบัญชีตัวเองไม่ได้');
    ok((await admin('PATCH', U + '/api/admin', { permission: 'Sale' })).status === 400,
       'ลดสิทธิ์ตัวเองไม่ได้');

    ok((await admin('POST', U + '/api/admin2/status', { status: 'Logout' })).status === 200,
       'ปิดบัญชีแอดมินคนอื่นได้ (ยังเหลือแอดมินอยู่)');
    ok((await admin('PATCH', U + '/api/admin', { permission: 'Sale' })).status === 400,
       'เหลือแอดมินคนเดียว → ลดสิทธิ์ไม่ได้');
    await admin('POST', U + '/api/admin2/status', { status: 'Login' });

    /* ── 5) ปิดบัญชีแล้วเด้งออกทันที ── */
    console.log('\n5) ปิดบัญชีแล้วเด้งออกทันที');
    ok((await newbie('GET', '/api/me')).status === 200, 'ก่อนปิด — ผู้ใช้ยังใช้งานได้');
    await admin('POST', U + '/api/newbie/status', { status: 'Logout' });
    ok((await newbie('GET', '/api/me')).status === 401,
       'ปิดบัญชีแล้ว session เดิมใช้ต่อไม่ได้ทันที (ไม่ต้องรอหมดอายุ)');
    await admin('POST', U + '/api/newbie/status', { status: 'Login' });

    /* ── 6) ตั้งรหัสผ่านใหม่ ── */
    console.log('\n6) ตั้งรหัสผ่านใหม่');
    ok((await admin('POST', U + '/api/newbie/password', { password: '123' })).status === 400,
       'รหัสใหม่สั้นเกินไป → ปฏิเสธ');
    ok((await admin('POST', U + '/api/pintest/password', { password: '2222' })).status === 200,
       'ตั้งรหัส 4 หลักให้คนอื่นได้');
    ok((await admin('POST', U + '/api/newbie/password',
        { password: 'brandnew99' })).status === 200, 'ตั้งรหัสผ่านใหม่สำเร็จ');

    const n2 = makeClient();
    ok((await n2('POST', '/api/login', { username: 'newbie', password: 'abcd1234' })).status === 401,
       'รหัสเดิมใช้ไม่ได้แล้ว');
    ok((await n2('POST', '/api/login', { username: 'newbie', password: 'brandnew99' })).status === 200,
       'รหัสใหม่ใช้ได้');

    ok((await admin('POST', U + '/api/ไม่มีคนนี้/password',
        { password: 'abcd1234' })).status === 404, 'ตั้งรหัสให้คนที่ไม่มีอยู่ → 404');

    /* ── 7) แก้ข้อมูล ── */
    console.log('\n7) แก้ข้อมูลผู้ใช้');
    ok((await admin('PATCH', U + '/api/newbie',
        { name: 'ชื่อใหม่', nickname: 'นิว' })).status === 200, 'แก้ชื่อสำเร็จ');
    const after = await admin('GET', U + '/api/list?q=newbie');
    ok(after.json.users[0].name === 'ชื่อใหม่', 'ชื่อถูกบันทึกจริง');
    ok((await admin('PATCH', U + '/api/newbie', {})).status === 400, 'ส่งของว่างมา → ปฏิเสธ');

    /* ── 8) บันทึกการใช้งาน ── */
    console.log('\n8) บันทึกการใช้งาน (audit)');
    const ev = await admin('GET', A + '/api/list?days=1&limit=500');
    ok(ev.status === 200, 'อ่านบันทึกได้');
    const actions = ev.json.events.map(e => e.action);
    for (const [a, label] of [
      ['user_create', 'เพิ่มผู้ใช้'],
      ['user_disable', 'ปิดบัญชี'],
      ['user_enable', 'เปิดบัญชี'],
      ['user_set_password', 'ตั้งรหัสผ่าน'],
      ['user_update', 'แก้ข้อมูล'],
    ]) ok(actions.includes(a), 'บันทึก "' + label + '" ไว้แล้ว');

    ok(!/brandnew99|abcd1234/.test(JSON.stringify(ev.json)),
       'ไม่มีรหัสผ่านโผล่ในบันทึกการใช้งาน');
    ok(ev.json.events.every(e => e.label && e.label !== e.action || !/^user_/.test(e.action)),
       'ทุกเหตุการณ์มีคำอธิบายภาษาไทย');

    // จงใจใส่รหัสผิด 2 ครั้ง เพื่อดูว่าระบบนับและจับคนที่เดารหัสได้จริง
    const guesser = makeClient();
    await guesser('POST', '/api/login', { username: 'papassorn', password: 'เดามั่ว1' });
    await guesser('POST', '/api/login', { username: 'papassorn', password: 'เดามั่ว2' });

    const stats = await admin('GET', A + '/api/stats?days=1');
    ok(stats.status === 200 && stats.json.logins >= 3, 'สรุปยอดล็อกอินได้');
    ok(stats.json.fails >= 3, 'นับครั้งที่ล็อกอินพลาดได้');
    ok((stats.json.failTop[0] || {}).username === 'papassorn',
       'ชี้ตัวคนที่ถูกเดารหัสบ่อยที่สุดได้ (สัญญาณว่ามีคนพยายามเดา)');
    ok(Array.isArray(stats.json.failTop), 'มีรายชื่อคนที่ล็อกอินพลาดบ่อย');

    const filtered = await admin('GET', A + '/api/list?days=1&action=user_create');
    ok(filtered.json.events.length > 0 &&
       filtered.json.events.every(e => e.action === 'user_create'), 'กรองตามเหตุการณ์ได้');

    /* ── 9) log ต้องแก้ไม่ได้ ── */
    console.log('\n9) บันทึกต้องแก้ไม่ได้');
    for (const [m, p] of [['POST', '/api/list'], ['PATCH', '/api/1'], ['DELETE', '/api/1']])
      ok((await admin(m, A + p)).status === 404, `ไม่มี endpoint ${m} ${p} ให้แก้บันทึก`);

  } catch (e) {
    fail++; console.error('\n💥 ' + e.stack);
  } finally {
    app.kill();
    await rest.close();
    await pg.end();
  }

  console.log('\n' + '═'.repeat(52));
  console.log(`ผ่าน ${pass} · ไม่ผ่าน ${fail}`);
  console.log('═'.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})();
