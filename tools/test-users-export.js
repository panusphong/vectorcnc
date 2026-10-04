'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  📊 ยาม: ปุ่ม "Export Google Sheet" ของหน้าจัดการผู้ใช้ — npm run test:usersexport  (รอบ 234 · 4 ต.ค. 69)
 *
 *  พี่เอ: "สร้างปุ่ม export เป็น google sheet ให้ด้วยนะ"
 *
 *  🔴 เครื่องนี้ต่อ Google Drive จริงไม่ได้ ⇒ ยามใช้ Drive ปลอม (tools/fake-drive.js) ที่จดทุกคำขอไว้
 *    พิสูจน์ได้ว่า "เราส่งอะไรออกไป" — ไม่ได้พิสูจน์ว่า Google แปลงไฟล์ออกมาหน้าตาอย่างไร
 *    (ทางเดียวกับปุ่มส่งออกของแอปคลังที่ใช้งานจริงอยู่: ส่ง CSV แล้วให้ Google แปลงเป็น Google Sheets)
 *
 *  ① ตัวช่วย: กันสูตรแฝง · กันเลข 0 หาย · เบอร์โทร · วันที่เวลาไทย · CSV
 *  ② 🔒 ไม่มีรหัสผ่าน/แฮชในไฟล์ · ไม่แชร์ด้วยลิงก์เอง · ไม่ลบ/ไม่ทับไฟล์บน Drive
 *  ③ ส่งออก "ตามตัวกรอง" — ลำดับและรายชื่อตรงกับ /api/list ทุกชุดตัวกรอง
 *  ④ 🔒 เฉพาะ admin · namna (ด่านเดียวกับทั้งแอป) · ปุ่มแชร์ใช้ได้เฉพาะไฟล์ที่ส่งออกจากหน้านี้
 *  ⑤ Drive ล้ม ⇒ บอกเหตุผล ไม่เงียบ · ทุกครั้งที่ส่งออก/แชร์ถูกจดในบันทึกการใช้งาน
 *  ⑥ หน้าจอจริง (Chromium)    SHOT=<ไฟล์> กล่องหลังส่งออก · SHOT_TOP=<ไฟล์> หัวหน้าเว็บ · SHOT_ASK=<ไฟล์> กล่องยืนยัน · CSV_OUT=<ไฟล์> เนื้อไฟล์ที่ส่งขึ้น Drive
 *     APP_DIR=<โฟลเดอร์รุ่นก่อน> + ONLY_SHOT=1 ⇒ เก็บภาพรุ่นก่อน
 *  ‼ พอร์ต 55881 / 55882 — ไล่เช็ค tools/*.js แล้วว่าไม่ชนกับใคร
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 55881, APP_PORT = 55882;
const APP_DIR = process.env.APP_DIR || ROOT;
const ONLY_SHOT = !!process.env.ONLY_SHOT;
process.env.SUPABASE_URL = `http://127.0.0.1:${REST_PORT}`;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const LOG = path.join(os.tmpdir(), 'fake-drive-' + process.pid + '.log');
const MODE = path.join(os.tmpdir(), 'fake-drive-' + process.pid + '.mode');
const driveLog = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x)); } catch (e) { return []; } };
const resetLog = () => { try { fs.writeFileSync(LOG, ''); } catch (e) { /* ไม่มีก็ไม่เป็นไร */ } };
const setMode = v => fs.writeFileSync(MODE, v || '');

/* แกะ CSV ที่ถูกส่งขึ้น Drive ออกจากคำขอ multipart */
const csvOf = rec => { const m = String(rec.body).match(/Content-Type: text\/csv\r\n\r\n([\s\S]*)\r\n--===/); return m ? m[1] : ''; };
const metaOf = rec => { try { return JSON.parse((String(rec.body).match(/\r\n\r\n(\{[\s\S]*?\})\r\n--/) || [])[1]); } catch (e) { return {}; } };
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  const t = String(text).replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\r') { /* ข้าม */ }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  row.push(cur); rows.push(row);
  return rows;
}

(async () => {
  console.log('\n📊 ส่งออกรายชื่อผู้ใช้เป็น Google Sheet (Drive ปลอม)\n');
  const { Client } = require('pg');
  const pg = new Client({ connectionString: PG });
  await pg.connect();
  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  let app = null, browser = null;
  const mine = ['admin', 'bossx', 'xp.sale', 'xp.plan', 'xp.evil', 'xp.plain', 'xp.nopw', '0077'];
  let had = [];
  try {
    const XS = require('../modules/users/export-sheet');
    const T = XS._t;
    if (!ONLY_SHOT) {
      head('① ตัวช่วย');
      ok(T.safeCell('=SUM(A1)') === "'=SUM(A1)" && T.safeCell('+66812') === "'+66812" && T.safeCell('-1') === "'-1" && T.safeCell('@x') === "'@x" && T.safeCell('\t=1') === "'\t=1",
         '🔴 ค่าที่ขึ้นต้นด้วย = + - @ (และแท็บ) ถูกเติม \' นำหน้า — ไม่ถูกรันเป็นสูตร');
      ok(T.safeCell('0077') === "'0077" && T.safeCell('077a') === '077a' && T.safeCell(77) === 77 && T.safeCell('') === '' && T.safeCell(null) === '',
         'ตัวเลขล้วนที่ขึ้นต้นด้วย 0 เติม \' (เลข 0 ไม่หาย) · ค่าปกติ/ตัวเลขจริงไม่ถูกแตะ');
      ok(T.phoneText('0812345678') === '081-234-5678' && T.phoneText('021234567') === '02-123-4567' && T.phoneText('081-234-5678') === '081-234-5678' && T.phoneText('ต่อ 12') === 'ต่อ 12' && T.phoneText('') === '',
         'เบอร์โทรตัวเลขล้วนใส่ขีดคั่น (081-234-5678 · 02-123-4567) · รูปอื่นคงเดิม');
      ok(T.whenTH('2026-10-03T17:31:00Z') === '2026-10-04 00:31' && T.whenTH('2026-10-04T03:31:00+00:00') === '2026-10-04 10:31' && T.whenTH('') === '' && T.whenTH('ไม่ใช่วันที่') === 'ไม่ใช่วันที่',
         'วันที่ = เวลาไทย รูป ปี-เดือน-วัน ชั่วโมง:นาที (ไม่กำกวมเดือน/วัน) · อ่านไม่ออกคืนค่าเดิม ไม่เดา');
      ok(T.csvCell('a,b') === '"a,b"' && T.csvCell('เขาว่า "ดี"') === '"เขาว่า ""ดี"""' && T.csvCell('x\ny') === '"x\ny"' && T.csvCell('ปกติ') === 'ปกติ', 'CSV: ครอบจุลภาค · เครื่องหมายคำพูด · ขึ้นบรรทัด');
      const buf = T.csvBuffer([['ก', 'ข'], ['1', '2']]);
      ok(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF && buf.toString('utf8').slice(1) === 'ก,ข\r\n1,2', 'ไฟล์ขึ้นต้นด้วย BOM (ภาษาไทยไม่เพี้ยน) · คั่นบรรทัดด้วย CRLF');
      const u = { name: 'สมชาย', nickname: 'ชาย', username: 'som', permission: 'Sale', role: 'OFFICER', branch: 'The 101', position: 'เซลส์', mobile: '0812345678',
        email: 'a@b.co', active: false, hasPassword: true, plainLeft: false, appAccess: 'sales', fromApp: true, createdAt: '2026-09-01T02:00:00Z', createdBy: 'admin',
        updatedAt: '', updatedBy: '', disabledAt: '2026-10-01T03:00:00Z', disabledBy: 'namna', PasswordHash: '$2a$10$SECRET', Password: 'PLAIN' };
      const r = T.rowOf(u, 4);
      ok(r.length === XS.HEADERS.length && XS.HEADERS.length === 20 && r[0] === 5 && r[3] === 'som' && r[8] === '081-234-5678' && r[10] === 'ปิดใช้งาน' && r[11] === 'ตั้งแล้ว' && r[13] === 'เพิ่มในแอป' && r[14] === '2026-09-01 09:00' && r[18] === '2026-10-01 10:00',
         '1 คน = 1 แถว 20 ช่อง ตรงกับหัวตาราง');
      ok(JSON.stringify(r).indexOf('SECRET') < 0 && JSON.stringify(r).indexOf('PLAIN') < 0, '🔴 ต่อให้ข้อมูลต้นทางมีรหัสผ่านติดมา ก็ไม่ลงแถวที่ส่งออก');
      ok(T.rowOf(Object.assign({}, u, { hasPassword: false }), 0)[11] === 'ยังไม่มีรหัสผ่าน' && T.rowOf(Object.assign({}, u, { plainLeft: true }), 0)[11] === 'ตั้งแล้ว (ยังไม่เข้ารหัส)', 'ช่อง "รหัสผ่าน" บอกแค่สถานะ');
      ok(T.filterText({}) === 'ทั้งหมด (ไม่กรอง)' && T.filterText({ q: 'ส้ม', status: 'inactive', permission: 'Sale', branch: 'The 101' }) === 'ค้นหา "ส้ม" · สถานะ ปิดใช้งาน · สิทธิ์ Sale · สาขา/กิจการ The 101', 'ข้อความบอกตัวกรอง');
      ok(/^รายชื่อผู้ใช้-CRM-Hub-\d{8}-\d{4}$/.test(T.fileName()) && T.fileName(new Date('2026-10-04T03:31:00Z')) === 'รายชื่อผู้ใช้-CRM-Hub-20261004-1031', 'ชื่อไฟล์มีวันเวลาไทย (สร้างใหม่ทุกครั้ง ไม่ทับกัน)');

      head('② โค้ด — กติกาที่ห้ามพัง');
      const src = read('modules/users/export-sheet.js'), code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      ok(!/PasswordHash|\.Password\b/.test(code), '🔴 ไฟล์ส่งออกไม่อ้างถึงช่องรหัสผ่านเลย');
      ok(!/shareAnyoneWrite/.test(code) && /shareAnyoneReadEx/.test(code), '🔒 แชร์ได้อย่างมาก "ดูอย่างเดียว" — ไม่มีการแชร์แบบแก้ไขได้');
      ok(!/\bfetch\s*\(/.test(code) && /DW\.upload\(/.test(code) && /DW\.folderIdByName\(/.test(code), '🔒 ไม่ยิง Google เอง — ออกทาง core/drive-write.js ทางเดียว');
      const dwCode = read('core/drive-write.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      ok(!/method:\s*['"]DELETE['"]|files\.delete|\/trash\b/i.test(dwCode), '🔒 core/drive-write.js ยังไม่มีคำสั่งลบ');
      const exFn = code.slice(code.indexOf('async function exportList'), code.indexOf('async function shareLink'));
      ok(exFn.length > 200 && !/DW\.share|shareAnyone|permissions/i.test(exFn) && /shared:\s*false/.test(exFn), '🔴 ตอนสร้างไฟล์ไม่มีการแชร์ใด ๆ (แชร์ต้องสั่งแยก)');
      ok(!/core\/sheets/.test(code), '‼ ไม่แตะไฟล์ชีตเดิมของระบบ');
      const ix = read('modules/users/index.js');
      ok(/router\.post\('\/api\/export\/sheet'/.test(ix) && /router\.post\('\/api\/export\/sheet\/share'/.test(ix) && /'users_export_sheet'/.test(ix) && /'users_export_share'/.test(ix), 'เส้นทาง 2 เส้น + จดบันทึกการใช้งานทั้งคู่');
    }

    /* ── ผู้ใช้ตัวอย่าง (หว่านเอง · เก็บกวาดเองตอนจบ) ── */
    await pg.query(read('sql/82-app-users-manage.sql'));
    had = (await pg.query('select lower("Username") u from app.app_users where lower("Username") = any($1)', [mine])).rows.map(r => r.u);
    const hash = require('bcryptjs').hashSync('test1234', 4);
    const up = async (un, name, nick, perm, o) => {
      const x = Object.assign({ status: 'Login', hash, plain: null, branch: '', position: '', mobile: '', email: '' }, o || {});
      await pg.query(`insert into app.app_users ("Username","Name","Nickname","Permission","Status","PasswordHash","Password","Branch","Position","Mobile","email")
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        on conflict (lower("Username")) do update set "Name"=excluded."Name","Nickname"=excluded."Nickname","Permission"=excluded."Permission","Status"=excluded."Status",
          "PasswordHash"=excluded."PasswordHash","Password"=excluded."Password","Branch"=excluded."Branch","Position"=excluded."Position","Mobile"=excluded."Mobile","email"=excluded."email"`,
        [un, name, nick, perm, x.status, x.hash, x.plain, x.branch, x.position, x.mobile, x.email]);
    };
    await up('admin', '(เอ) พนัสพงษ์', 'เอ', 'Administrator', { branch: 'มดงานการป้าย', position: 'ผู้บริหาร', mobile: '0891112222', email: 'boss@example.com' });
    await up('bossx', '(เอ็กซ์) หัวหน้า', 'เอ็กซ์', 'Administrator', { branch: 'The 101' });
    await up('xp.sale', '(ส้ม) สมหญิง ใจดี', 'ส้ม', 'Sale', { branch: 'The 101', position: 'เซลส์', mobile: '0812345678', email: 'som@example.com' });
    await up('xp.plan', '(แพน) แพนเค้ก', 'แพน', 'Planning', { status: 'Logout', branch: 'มดงานการป้าย', position: 'วางแผน', mobile: '021234567' });
    await up('xp.evil', '=HYPERLINK("http://evil.example","กดเลย")', '+ส้ม', 'Sale support', { branch: 'The 101', position: '@hack, "x"' });
    await up('xp.plain', '(เพลน) รหัสล้วน', 'เพลน', 'Sale', { hash: null, plain: 'PLAINSECRET99', branch: 'The 101' });
    await up('xp.nopw', '(โน) ยังไม่มีรหัส', 'โน', 'Graphic', { hash: null });
    await up('0077', '(เจมส์) เลขศูนย์นำ', 'เจมส์', 'Planning', { branch: 'มดงานการป้าย' });

    fs.writeFileSync(LOG, ''); setMode('');
    const t0 = new Date(Date.now() - 2000).toISOString();
    const env = Object.assign({}, process.env, { SUPABASE_URL: `http://127.0.0.1:${REST_PORT}`, SUPABASE_KEY: 'test-key',
      SESSION_SECRET: 'a'.repeat(64), NODE_ENV: 'development', PORT: String(APP_PORT), SYNC_ON_BOOT: '0', SYNC_EVERY_MIN: '0', PHOTO_IMPORT: 'off',
      FAKE_DRIVE_LOG: LOG, FAKE_DRIVE_MODE_FILE: MODE, DRIVE_ROOT_FOLDER_ID: 'FAKEROOT', DRIVE_SHARED_DRIVE_ID: '',
      NODE_OPTIONS: '--require ' + path.join(__dirname, 'fake-drive.js') });
    app = spawn('node', [path.join(APP_DIR, 'server.js')], { env, stdio: 'pipe', cwd: APP_DIR });
    let booted = false;
    app.stdout.on('data', d => { if (String(d).includes('พอร์ต')) booted = true; });
    app.stderr.on('data', () => {});
    for (let i = 0; i < 100 && !booted; i++) await sleep(200);
    const base = `http://127.0.0.1:${APP_PORT}`;
    const login = async who => {
      const r = await fetch(base + '/api/login', { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: who, password: 'test1234' }) });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      return sc.map(s => s.split(';')[0]).join('; ');
    };
    const admin = await login('admin'), bossx = await login('bossx'), sale = await login('xp.sale');
    const req = async (m, u, c, body) => {
      const r = await fetch(base + u, { method: m, redirect: 'manual', headers: Object.assign({ 'content-type': 'application/json' }, c ? { cookie: c } : {}), body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { j = null; }
      return { s: r.status, j, t };
    };
    const audits = async () => (await pg.query("select username, action, detail from app.auth_audit where action like 'users_export%' and at >= $1 order by _id", [t0])).rows;

    if (!ONLY_SHOT) {
      head('③ 🔒 สิทธิ์ — เฉพาะ admin · namna');
      for (const [who, c] of [['เซลส์ (xp.sale)', sale], ['Administrator ที่ไม่ใช่ admin/namna (bossx)', bossx], ['ไม่ได้ล็อกอิน', '']]) {
        const a = await req('POST', '/m/users/api/export/sheet', c, {});
        const b = await req('POST', '/m/users/api/export/sheet/share', c, { fileId: 'X' });
        ok(a.s !== 200 && b.s !== 200 && a.t.indexOf('docs.google.com') < 0, `🔴 ${who}: ส่งออก/แชร์ไม่ได้ (${a.s} · ${b.s})`);
      }
      ok(driveLog().length === 0 && (await audits()).length === 0, '   คนที่ถูกปฏิเสธไม่ทำให้เกิดคำขอไป Drive และไม่ถูกจดว่าส่งออก');

      head('④ ส่งออกทั้งหมด');
      const L0 = await req('GET', '/m/users/api/list', admin);
      const E = await req('POST', '/m/users/api/export/sheet', admin, {});
      ok(E.s === 200 && E.j.ok && E.j.rows === L0.j.users.length && E.j.of === L0.j.summary.allTotal && E.j.columns === 20 && E.j.shared === false,
         `ส่งออกได้ ${E.j && E.j.rows} คน = จำนวนในตาราง (${L0.j.users.length}) · ยังไม่ได้แชร์`);
      ok(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/FAKESHEET[^/]+\/edit$/.test(E.j.url) && E.j.url.indexOf(E.j.fileId) > 0 && E.j.folder === 'Export-จัดการผู้ใช้', 'ได้ลิงก์เปิดชีต: ' + E.j.url.slice(0, 60) + '…');
      const D = driveLog();
      const find = D.find(x => x.m === 'GET'), mk = D.find(x => x.m === 'POST' && /\/drive\/v3\/files\?/.test(x.u)), upRec = D.find(x => /\/upload\/drive\/v3\/files/.test(x.u));
      ok(D.length === 3 && !!find && !!mk && !!upRec, 'คำขอไป Drive 3 ครั้ง: หาโฟลเดอร์ → สร้างโฟลเดอร์ → อัปไฟล์ (ได้ ' + D.length + ')');
      ok(JSON.parse(mk.body).name === 'Export-จัดการผู้ใช้' && JSON.parse(mk.body).parents[0] === 'FAKEROOT', 'โฟลเดอร์ "Export-จัดการผู้ใช้" อยู่ใต้โฟลเดอร์ Drive ของบริษัท');
      const meta = metaOf(upRec);
      ok(meta.mimeType === 'application/vnd.google-apps.spreadsheet' && /^FAKEFOLDER/.test(meta.parents[0]) && /^รายชื่อผู้ใช้-CRM-Hub-\d{8}-\d{4}$/.test(meta.name) && /uploadType=multipart/.test(upRec.u) && /supportsAllDrives=true/.test(upRec.u),
         'อัปเป็น CSV แล้วขอให้ Google แปลงเป็น Google Sheets · ชื่อไฟล์ ' + meta.name);
      ok(D.every(x => x.auth === 'Bearer fake-drive-token') && !D.some(x => /permissions/.test(x.u)) && !D.some(x => x.m === 'DELETE' || x.m === 'PATCH' || x.m === 'PUT'),
         '🔴 ไม่มีคำขอแชร์ · ไม่มีคำขอลบ/แก้ไฟล์เดิม');
      const csv = csvOf(upRec), rows = parseCsv(csv);
      ok(csv.charCodeAt(0) === 0xFEFF && rows[0][0] === 'รายชื่อผู้ใช้ระบบ CRM Hub' && /ส่งออกเมื่อ \d{4}-\d{2}-\d{2} \d{2}:\d{2} น\. โดย admin · \d+ คน/.test(rows[1][0]) && /ไฟล์นี้ไม่มีรหัสผ่าน/.test(rows[1][0]) && rows[2].join('') === '',
         'หัวไฟล์: ชื่อรายงาน · ส่งออกเมื่อไหร่ โดยใคร กี่คน ตัวกรองอะไร');
      ok(rows[3].join('|') === XS.HEADERS.join('|') && rows.length === 4 + E.j.rows && rows.slice(4).every(r => r.length === 20), 'หัวตาราง 20 ช่อง + ' + E.j.rows + ' แถว (ครบทุกคน ทุกแถว 20 ช่อง)');
      ok(rows.slice(4).map(r => r[3].replace(/^'/, '')).join('|') === L0.j.users.map(u => u.username).join('|') && rows.slice(4).every((r, i) => r[0] === String(i + 1)),
         'ลำดับคน = ลำดับเดียวกับตารางบนหน้าจอ (เรียงตามสิทธิ์) · เลขลำดับ 1…N');
      ok(csv.indexOf('$2a$') < 0 && csv.indexOf('$2b$') < 0 && csv.indexOf('PLAINSECRET99') < 0 && csv.indexOf(hash) < 0 && !/PasswordHash/i.test(csv), '🔴🔴 ไม่มีรหัสผ่านและแฮชรหัสผ่านในไฟล์ (ทั้งแบบเข้ารหัสและข้อความล้วน)');
      const by = un => rows.slice(4).find(r => r[3].replace(/^'/, '') === un);
      ok(by('xp.plain')[11] === 'ตั้งแล้ว (ยังไม่เข้ารหัส)' && by('xp.nopw')[11] === 'ยังไม่มีรหัสผ่าน' && by('xp.sale')[11] === 'ตั้งแล้ว', 'ช่องรหัสผ่านบอกแค่สถานะ: ตั้งแล้ว / ยังไม่เข้ารหัส / ยังไม่มี');
      const ev = by('xp.evil');
      ok(ev[1] === '\'=HYPERLINK("http://evil.example","กดเลย")' && ev[2] === "'+ส้ม" && ev[7] === '\'@hack, "x"', '🔴 ชื่อที่แฝงสูตร (=HYPERLINK… · +… · @…) ถูกเติม \' — เปิดในชีตแล้วไม่ถูกรัน');
      ok(by('xp.sale')[8] === '081-234-5678' && by('xp.plan')[8] === '02-123-4567' && by('0077')[3] === "'0077", 'เบอร์โทร/ชื่อผู้ใช้ที่ขึ้นต้นด้วย 0 ไม่เสียเลข 0');
      ok(by('xp.plan')[10] === 'ปิดใช้งาน' && by('xp.sale')[10] === 'เปิดใช้งาน' && by('xp.sale')[4] === 'Sale' && by('xp.sale')[6] === 'The 101' && by('xp.sale')[9] === 'som@example.com' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(by('xp.sale')[14]),
         'ค่าในแถวตรงกับฐาน: สถานะ · สิทธิ์ · สาขา · อีเมล · วันที่สร้าง (เวลาไทย)');
      const A1 = await audits();
      ok(A1.length === 1 && A1[0].username === 'admin' && A1[0].action === 'users_export_sheet' && JSON.parse(A1[0].detail).rows === E.j.rows && JSON.parse(A1[0].detail).fileId === E.j.fileId,
         'จดบันทึกการใช้งาน: ใครส่งออก กี่คน ไฟล์ไหน');

      head('⑤ ส่งออกตามตัวกรอง — ตรงกับ /api/list ทุกชุด');
      const combos = [{ status: 'inactive' }, { status: 'active', permission: 'Sale' }, { permission: 'sale' }, { branch: 'The 101' }, { q: 'xp.' }, { q: 'ส้ม', branch: 'the 101' }, { permission: 'Planning', status: 'active' }];
      for (const f of combos) {
        resetLog();
        const qs = 'q=' + encodeURIComponent(f.q || '') + '&status=' + encodeURIComponent(f.status || '') + '&permission=' + encodeURIComponent(f.permission || '') + '&branch=' + encodeURIComponent(f.branch || '');
        const L = await req('GET', '/m/users/api/list?' + qs, admin);
        const X = await req('POST', '/m/users/api/export/sheet', admin, f);
        const upx = driveLog().find(x => /\/upload\//.test(x.u));
        const got = upx ? parseCsv(csvOf(upx)).slice(4).map(r => r[3].replace(/^'/, '')) : [];
        ok(X.s === 200 && L.j.users.length > 0 && got.join('|') === L.j.users.map(u => u.username).join('|') && X.j.rows === L.j.users.length,
           `ตัวกรอง ${JSON.stringify(f)} ⇒ ${got.length} คน ตรงกับหน้าจอ (ลำดับเดียวกัน)`);
      }
      ok(driveLog().length === 1 && /\/upload\//.test(driveLog()[0].u) && !driveLog().some(x => x.m === 'POST' && !/\/upload\//.test(x.u)), 'ส่งออกครั้งต่อ ๆ ไปใช้โฟลเดอร์เดิม ไม่สร้างโฟลเดอร์ซ้ำ');
      resetLog();
      const Z = await req('POST', '/m/users/api/export/sheet', admin, { permission: 'ไม่มีสิทธิ์นี้' });
      ok(Z.s === 400 && /ไม่มีผู้ใช้ตรงตามตัวกรอง/.test(Z.j.error) && driveLog().length === 0, 'ตัวกรองที่ไม่มีใครตรง ⇒ ไม่สร้างไฟล์เปล่า (บอกเหตุผล)');
      const E2 = await req('POST', '/m/users/api/export/sheet', admin, {});
      ok(E2.j.fileId !== E.j.fileId, 'กดส่งออกอีกครั้ง = ไฟล์ใหม่ (ไม่ทับไฟล์เดิม)');

      head('⑥ เปิดให้คนที่มีลิงก์ดูได้ — ต้องสั่งแยก');
      resetLog();
      const S0 = await req('POST', '/m/users/api/export/sheet/share', admin, { fileId: '1AbCdEfRealCompanyFileId' });
      ok(S0.s === 400 && /เฉพาะไฟล์ที่เพิ่งส่งออกจากหน้านี้/.test(S0.j.error) && driveLog().length === 0, '🔴 ส่งไอดีไฟล์อื่นมาให้แชร์ ⇒ ปฏิเสธ ไม่มีคำขอไป Drive');
      const S00 = await req('POST', '/m/users/api/export/sheet/share', admin, {});
      ok(S00.s === 400, '   ไม่ระบุไฟล์ ⇒ ปฏิเสธ');
      const S1 = await req('POST', '/m/users/api/export/sheet/share', admin, { fileId: E.j.fileId });
      const pr = driveLog().filter(x => /permissions/.test(x.u));
      ok(S1.s === 200 && S1.j.shared === true && pr.length === 1 && pr[0].u.indexOf('/files/' + E.j.fileId + '/permissions') > 0 && JSON.stringify(JSON.parse(pr[0].body)) === '{"role":"reader","type":"anyone"}',
         'ไฟล์ที่เพิ่งส่งออก ⇒ แชร์ได้ แบบ "ทุกคนที่มีลิงก์ ดูอย่างเดียว" (ไม่ใช่แก้ไขได้)');
      const A2 = (await audits()).filter(a => a.action === 'users_export_share');
      ok(A2.length === 1 && A2[0].username === 'admin' && JSON.parse(A2[0].detail).fileId === E.j.fileId, 'จดบันทึกการใช้งานว่าใครเปิดแชร์ไฟล์ไหน');

      head('⑦ Drive ล้ม — ต้องบอกเหตุผล');
      const nA = (await audits()).length;
      setMode('quota'); resetLog();
      const Q = await req('POST', '/m/users/api/export/sheet', admin, {});
      ok(Q.s === 500 && /ส่งออกเป็น Google Sheet ไม่สำเร็จ/.test(Q.j.error) && Q.j.error.length > 60 && !Q.j.url && (await audits()).length === nA, 'Drive ไม่มีที่เก็บ ⇒ บอกว่าไม่สำเร็จพร้อมเหตุผลจาก Google · ไม่จดว่าส่งออกสำเร็จ');
      setMode('noshare');
      const N = await req('POST', '/m/users/api/export/sheet/share', admin, { fileId: E2.j.fileId });
      ok(N.s === 502 && /เปิดให้คนที่มีลิงก์ดูไม่สำเร็จ/.test(N.j.error) && (await audits()).filter(a => a.action === 'users_export_share').length === 1, 'Google ไม่ยอมให้แชร์ ⇒ บอกเหตุผล · ไม่จดว่าแชร์แล้ว');
      setMode('');
      const cnt = (await pg.query('select count(*)::int n from app.app_users')).rows[0].n;
      ok(cnt === L0.j.summary.allTotal, '🔴 ตารางผู้ใช้ไม่ถูกแตะ (' + cnt + ' คนเท่าเดิม)');
    }

    /* ═══ หน้าจอจริง ═══ */
    head('⑧ หน้าจอจริง (Chromium)');
    setMode(''); resetLog();
    const { chromium } = require('playwright');
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const FD = '/root/fonts-prompt/package/files/';
    let css = '';
    if (fs.existsSync(FD)) for (const wt of [400, 500, 600, 700, 800]) for (const [sub, rng] of [['thai', 'U+0E01-0E5B,U+200C-200D,U+25CC'], ['latin', 'U+0000-00FF,U+2000-206F,U+20AC,U+2212']]) {
      const f = FD + `prompt-${sub}-${wt}-normal.woff2`;
      if (fs.existsSync(f)) css += `@font-face{font-family:'Prompt';font-weight:${wt};src:url(data:font/woff2;base64,${fs.readFileSync(f).toString('base64')}) format('woff2');unicode-range:${rng}}\n`;
    }
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addCookies(admin.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: base }; }));
    await ctx.route('**/fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: css }));
    await ctx.route('**/fonts.gstatic.com/**', r => r.abort());
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(String(e)));
    await p.goto(base + '/m/users/', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => { const e = document.getElementById('rows'); return e && e.querySelectorAll('tr').length >= 3 && !/กำลังโหลด/.test(e.innerText); }, null, { timeout: 30000 });
    await p.waitForTimeout(500);
    if (process.env.SHOT_TOP) await p.screenshot({ path: process.env.SHOT_TOP, clip: { x: 0, y: 0, width: 1440, height: 520 } });
    if (!ONLY_SHOT) {
      ok(await p.isVisible('#btnExport') && /Export Google Sheet/.test(await p.innerText('#btnExport')), 'มีปุ่ม "📊 Export Google Sheet" บนหัวหน้า จัดการผู้ใช้');
      const total = await p.$$eval('#rows tr', t => t.length);
      await p.click('#btnExport');
      ok(await p.isVisible('#ovExp'), 'กดแล้วเปิดกล่องยืนยัน');
      const w0 = await p.innerText('#ovExp .modal');
      ok(w0.indexOf(total + ' คน') >= 0 && /ทั้งหมด \(ไม่กรอง\)/.test(w0) && /ไม่มีรหัสผ่าน/.test(w0) && /ยังไม่ถูกแชร์ด้วยลิงก์/.test(w0), `กล่องบอก: ${total} คน · ตัวกรอง · ไม่มีรหัสผ่าน · ยังไม่แชร์`);
      if (process.env.SHOT_ASK) await p.locator('#ovExp .modal').screenshot({ path: process.env.SHOT_ASK });
      await p.keyboard.press('Escape');
      ok(!(await p.isVisible('#ovExp')), 'กด Esc ปิดกล่องได้');
      /* กรองแล้วส่งออก */
      await p.selectOption('#fp', 'Sale');
      await p.waitForTimeout(700);
      const nSale = await p.$$eval('#rows tr', t => t.length);
      await p.click('#btnExport');
      ok((await p.innerText('#exWhat')).indexOf(nSale + ' คน') >= 0 && /สิทธิ์ Sale/.test(await p.innerText('#exWhat')), `กรองสิทธิ์ Sale แล้วกดส่งออก ⇒ กล่องบอก ${nSale} คน · สิทธิ์ Sale`);
      await p.click('#exGo');
      await p.waitForSelector('#exOpen', { timeout: 20000 });
      const href = await p.getAttribute('#exOpen', 'href');
      const upx = driveLog().filter(x => /\/upload\//.test(x.u)).pop();
      ok(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/FAKESHEET/.test(href) && (await p.getAttribute('#exOpen', 'target')) === '_blank' && parseCsv(csvOf(upx)).length === 4 + nSale,
         `ส่งออกแล้วได้ปุ่ม "เปิด Google Sheet ↗" (แท็บใหม่) · ไฟล์มี ${nSale} คน ตามตัวกรอง`);
      ok(/🔒/.test(await p.innerText('#exShare')) && /ยังไม่ได้แชร์ด้วยลิงก์/.test(await p.innerText('#exShare')) && await p.isVisible('#exShareBtn'), 'บอกว่ายังไม่ได้แชร์ + มีปุ่มเปิดแชร์แยก');
      if (process.env.SHOT) await p.locator('#ovExp .modal').screenshot({ path: process.env.SHOT });
      if (process.env.CSV_OUT) fs.writeFileSync(process.env.CSV_OUT, csvOf(upx));
      let dlg = '';
      p.once('dialog', d => { dlg = d.message(); d.accept(); });
      await p.click('#exShareBtn');
      await p.waitForFunction(() => /🔓/.test(document.getElementById('exShare').innerText), null, { timeout: 20000 });
      ok(/ทุกคนที่มีลิงก์/.test(dlg) && /เบอร์โทร/.test(dlg) && /ดูอย่างเดียว/.test(await p.innerText('#exShare')) && !(await p.isVisible('#exShareBtn')), 'เปิดแชร์: ถามยืนยันก่อน (เตือนว่ามีข้อมูลพนักงาน) → ขึ้น 🔓 ดูอย่างเดียว');
      if (process.env.SHOT_SHARED) await p.locator('#ovExp .modal').screenshot({ path: process.env.SHOT_SHARED });
      /* Drive ล้ม */
      await p.click('#ovExp .mf .btn.ghost');
      setMode('quota');
      await p.click('#btnExport'); await p.click('#exGo');
      await p.waitForFunction(() => document.getElementById('exErr').classList.contains('show'), null, { timeout: 20000 });
      ok(/ไม่สำเร็จ/.test(await p.innerText('#exErr')) && !(await p.$('#exOpen')) && /ลองใหม่/.test(await p.innerText('#exGo')), 'Drive ล้ม ⇒ กล่องขึ้นข้อความแดงพร้อมเหตุผล + ปุ่ม "ลองใหม่" (ไม่มีลิงก์ปลอม)');
      setMode('');
      ok(errs.length === 0, 'ไม่มี error ในหน้า' + (errs.length ? ' — ' + errs[0] : ''));
    }
    await ctx.close();
  } catch (e) {
    fail++; console.log('  ❌ ล้มกลางทาง: ' + (e && e.stack || e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (app) app.kill();
    const del = mine.filter(u => had.indexOf(u) < 0);
    await pg.query('delete from app.app_users where lower("Username") = any($1)', [del]).catch(() => {});
    await pg.query("delete from app.auth_audit where action like 'users_export%'").catch(() => {});
    try { fs.unlinkSync(LOG); fs.unlinkSync(MODE); } catch (e) { /* ไม่มีก็ไม่เป็นไร */ }
    try { await rest.close(); } catch (e) { /* ยามจบด้วย process.exit */ }
    await pg.end().catch(() => {});
  }
  console.log(`\n${fail ? '❌' : '✅'} ผ่าน ${pass} · ไม่ผ่าน ${fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
