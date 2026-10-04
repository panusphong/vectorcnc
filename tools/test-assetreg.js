'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  📱 ยาม: การ์ด "ระบบทะเบียนเบอร์โทร และทรัพย์สิน" — npm run test:assetreg   (รอบ 233 · 4 ต.ค. 69)
 *
 *  พี่เอ: "เพิ่ม app card อีกในหน้า CRM HUB ให้หน่อยนะ
 *          https://script.google.com/macros/s/AKfycbxOZ60ME28OHf9daxcDs-gcIJkajITI2QZQZjkEw8uRouqC3fkkWwFRSnrGO4rYmgKQkA/exec
 *          ชื่อ app ระบบทะเบียนเบอร์โทร และทรัพย์สิน"
 *         "ให้เฉพาะ permission : administrator เปิดดูได้เท่านั้นนะ"
 *
 *  ① ทะเบียนแอป + ด่านกลุ่มสิทธิ์ (core/app-perms.js)
 *  ② โมดูล: ชื่อ · ไม่มีเส้นทางสาธารณะ · ที่อยู่ปลายทางตรงกับที่พี่เอให้ทุกตัวอักษร
 *  ③ ด่านของโมดูลเอง: ไม่ใช่ Administrator ⇒ 403 และ "ไม่มีที่อยู่ของแอปหลุดออกไป"
 *  ④ sql/111: รันซ้ำได้ ไม่ลบอะไร ติ๊กให้เฉพาะกลุ่ม administrator
 *  ⑤ เซิร์ฟเวอร์จริง: การ์ดในหน้ารวมแอป · กดแล้วถูกส่งต่อไป Google Apps Script
 *  ⑥ หน้าจอจริง (Chromium): Administrator เห็นการ์ด · เซลส์ไม่เห็น   SHOT=<ไฟล์> เก็บภาพ
 *  🔒 ไม่เปิดแอปบน Google จริง (เบราว์เซอร์ของยามต่อ script.google.com ไม่ได้) — ยามนี้พิสูจน์เฉพาะฝั่ง CRM Hub
 *  ‼ พอร์ต 55989 / 55990 — ไล่เช็ค tools/*.js แล้วว่าไม่ชนกับใคร
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 55989, APP_PORT = 55990;
const APP_DIR = process.env.APP_DIR || ROOT;
const ONLY_SHOT = !!process.env.ONLY_SHOT;
process.env.SUPABASE_URL = `http://127.0.0.1:${REST_PORT}`;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
delete process.env.ASSETREG_URL;

const URL_A = 'https://script.google.com/macros/s/AKfycbxOZ60ME28OHf9daxcDs-gcIJkajITI2QZQZjkEw8uRouqC3fkkWwFRSnrGO4rYmgKQkA/exec';
const TITLE = 'ระบบทะเบียนเบอร์โทร และทรัพย์สิน';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  console.log('\n📱 การ์ดระบบทะเบียนเบอร์โทร และทรัพย์สิน\n');
  const { Client } = require('pg');
  const pg = new Client({ connectionString: PG });
  await pg.connect();
  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  let app = null, browser = null;
  try {
    if (!ONLY_SHOT) {
      head('① ทะเบียนแอป + ด่านกลุ่มสิทธิ์');
      const perms = require('../core/app-perms');
      ok(perms.KNOWN_APPS.indexOf('assetreg') >= 0, "'assetreg' อยู่ในทะเบียนแอป (KNOWN_APPS)");
      ok(perms.isAdminOnlyApp('assetreg'), "‼ 'assetreg' อยู่ใน ADMIN_PERM_ONLY_APPS");
      for (const p of ['Administrator', 'administrator', ' ADMIN ', 'ผู้ดูแลระบบ'])
        ok(perms.allows(p, 'assetreg') === true, `  permission "${p}" เปิดได้`);
      for (const p of ['Sale', 'Sales', 'Sale support', 'Accounting', 'บัญชี', 'Planning', 'Graphic', 'xadmin', 'adminx', '*', '', null])
        ok(perms.allows(p, 'assetreg') === false, `🔴 permission "${p}" เปิดไม่ได้`);
      ok(perms.isAdminOnlyApp('mgmt') && perms.isAdminOnlyApp('bom') && perms.ADMIN_PERM_ONLY_APPS.length === 3, '   แอปเฉพาะ Administrator ตัวเดิม (bom · mgmt) ยังอยู่ครบ');

      head('② โมดูล');
      const mj = JSON.parse(read('modules/assetreg/module.json'));
      ok(mj.key === 'assetreg' && mj.title === TITLE, 'ชื่อการ์ด = "' + mj.title + '" ตรงตามที่พี่เอสั่ง');
      ok(mj.status === 'ready' && mj.minRoleSee === 'ADMIN' && mj.minRoleUse === 'ADMIN', 'module.json: พร้อมใช้ · ต้องเป็นผู้ดูแลทั้งเห็นและใช้');
      ok(!mj.publicPaths && !mj.hideInHub && !mj.allowUsers, '‼ ไม่มีเส้นทางสาธารณะ · มีการ์ดในหน้ารวมแอป · ไม่ผูกกับชื่อผู้ใช้ (ผูกกับกลุ่มสิทธิ์)');
      const used = fs.readdirSync(path.join(ROOT, 'modules')).filter(k => k !== 'assetreg' && fs.existsSync(path.join(ROOT, 'modules', k, 'module.json')))
        .map(k => String(JSON.parse(read('modules/' + k + '/module.json')).color || '').toLowerCase());
      ok(used.indexOf(String(mj.color).toLowerCase()) < 0, 'สีการ์ดไม่ซ้ำกับแอปอื่น (' + mj.color + ')');
      const M = require('../modules/assetreg/index');
      ok(M.DEFAULT_URL === URL_A && M.targetUrl() === URL_A, 'ที่อยู่ปลายทาง = ลิงก์ที่พี่เอให้ ตรงทุกตัวอักษร');
      process.env.ASSETREG_URL = 'https://script.google.com/macros/s/NEWID_abc-123/exec';
      ok(M.targetUrl() === process.env.ASSETREG_URL, 'ตั้ง ASSETREG_URL ใน Railway ⇒ เปลี่ยนที่อยู่ได้โดยไม่แก้โค้ด');
      for (const bad of ['http://script.google.com/macros/s/x/exec', 'https://evil.example.com/x', 'https://script.google.com.evil.com/x', 'javascript:alert(1)', 'https://script.google.com/x?next=https://evil.com'])
        { process.env.ASSETREG_URL = bad; ok(M.targetUrl() === URL_A, '🔒 ASSETREG_URL ที่ไม่ใช่ที่อยู่ของ Google Apps Script ถูกมองข้าม (' + bad.slice(0, 44) + ')'); }
      delete process.env.ASSETREG_URL;
      const src = read('modules/assetreg/index.js');
      ok(!/require\(['"][^'"]*core\/db['"]\)/.test(src) && !/fetch\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'โมดูลนี้ไม่อ่าน/เขียนฐานข้อมูล และไม่ยิงเน็ตเอง — ทำอย่างเดียวคือส่งต่อ');
      const V = require('../modules/assetreg/version');
      ok(/^\d+\.\d+\.\d+$/.test(V.VERSION) && V.CHANGELOG[0][0] === V.VERSION, 'version.js: เลข ' + V.VERSION + ' ตรงกับประวัติบรรทัดบน');
      const REG = require('../core/registry');
      const rm = REG.loadAll(true).find(m => m.key === 'assetreg');
      ok(rm && rm.basePath === '/m/assetreg' && rm.hasServer && !rm.hasPublic, 'ทะเบียนโมดูลเห็นแอปนี้ (/m/assetreg · มีฝั่งเซิร์ฟเวอร์ · ไม่มีไฟล์หน้าเว็บให้เปิดตรง)');
      ok(!/assetreg/.test(read('public/hub.html')) && !/assetreg/.test(read('server.js')), 'ไม่ต้องแก้ public/hub.html และ server.js (การ์ดมาจากทะเบียนโมดูล)');

      head('③ ด่านของโมดูลเอง');
      ok(M.isAdminPerm({ permission: 'Administrator', role: 'ADMIN' }) === true, 'Administrator ผ่าน');
      ok(M.isAdminPerm({ permission: 'xadmin', role: 'ADMIN' }) === false && M.isAdminPerm({ permission: 'Sale' }) === false && M.isAdminPerm(null) === false,
         "🔴 permission 'xadmin' (role ถูกเดาเป็น ADMIN) · Sale · ไม่มีผู้ใช้ ไม่ผ่าน — ไม่เทียบจาก role");
      const express = require('express');
      const audits = [];
      const mk = user => { const a = express(); const r = express.Router(); a.use((q, _s, n) => { q.user = user; n(); });
        a.use('/m/assetreg', r); return M.mount(r, { log() {}, warn() {}, audit: (u, act) => audits.push(act), auth: {} }).then(() => new Promise(res => { const s = a.listen(0, () => res(s)); })); };
      const s1 = await mk({ username: 'zsale', permission: 'Sale', role: 'OFFICER' });
      for (const u of ['/', '/index.html', '/?t=abc', '/api/_diag', '/anything']) {
        const r = await fetch('http://127.0.0.1:' + s1.address().port + '/m/assetreg' + u, { redirect: 'manual' });
        const t = await r.text();
        ok(r.status === 403 && !r.headers.get('location') && t.indexOf('script.google.com') < 0 && t.indexOf('AKfycb') < 0, `🔴 Sale เปิด ${u} ⇒ 403 · ไม่มีที่อยู่ของแอปหลุด`);
      }
      s1.close();
      ok(audits.length === 0, '   คนที่ถูกปฏิเสธไม่ถูกจดว่า "เปิดแอป"');
      const s2 = await mk({ username: 'boss', permission: 'Administrator', role: 'ADMIN' });
      const b2 = 'http://127.0.0.1:' + s2.address().port + '/m/assetreg';
      const r2 = await fetch(b2 + '/?t=ticket123', { redirect: 'manual' });
      ok(r2.status === 302 && r2.headers.get('location') === URL_A, 'Administrator ⇒ ส่งต่อ (302) ไปที่แอปบน Google Apps Script');
      ok(/no-store/.test(r2.headers.get('cache-control') || '') && r2.headers.get('referrer-policy') === 'no-referrer' && (r2.headers.get('location') || '').indexOf('ticket123') < 0,
         '🔒 ไม่เก็บแคช · ไม่ส่งที่อยู่/ตั๋วของหน้านี้ให้ปลายทาง (Referrer-Policy: no-referrer) · ตั๋วไม่ติดไปใน URL');
      ok(audits.join() === 'assetreg_open', 'จดบันทึกการใช้งานว่าเปิดแอป');
      const r3 = await fetch(b2 + '/api/_diag'), j3 = await r3.json();
      ok(r3.status === 200 && j3.ok && j3.version === V.VERSION && JSON.stringify(j3).indexOf('AKfycb') < 0, '/api/_diag บอกสถานะ ไม่พิมพ์ที่อยู่ของแอป');
      const r4 = await fetch(b2 + '/nope', { redirect: 'manual' });
      ok(r4.status === 404, 'เส้นทางอื่นไม่มี ⇒ 404');
      s2.close();

      head('④ sql/111');
      const sql = read('sql/111-assetreg-app.sql');
      ok(/array_append\(apps, 'assetreg'\)/.test(sql) && /perm_key = 'administrator'/.test(sql) && !/drop |delete |truncate |create table/i.test(sql.replace(/--[^\n]*/g, '')),
         'ติ๊กให้เฉพาะกลุ่ม administrator · ไม่ลบ ไม่สร้างตาราง');
    }
    /* ของจริง = รัน sql/111 (และ 109) ใน Supabase — รันซ้ำได้ */
    await pg.query(read('sql/109-mgmt-report.sql'));
    if (fs.existsSync(path.join(APP_DIR, 'sql', '111-assetreg-app.sql'))) {
      await pg.query(fs.readFileSync(path.join(APP_DIR, 'sql', '111-assetreg-app.sql'), 'utf8'));
      await pg.query(fs.readFileSync(path.join(APP_DIR, 'sql', '111-assetreg-app.sql'), 'utf8'));
    }
    if (!ONLY_SHOT) {
      const g = (await pg.query("select perm_key, (select count(*) from unnest(apps) a where a = 'assetreg')::int n from app.app_access_group")).rows;
      ok(g.find(x => x.perm_key === 'administrator').n === 1 && g.filter(x => x.perm_key !== 'administrator').every(x => x.n === 0),
         'รัน 2 รอบ: กลุ่ม administrator มี assetreg 1 ครั้ง (ไม่ซ้ำ) · กลุ่มอื่น ' + (g.length - 1) + ' กลุ่มไม่มี');
    }

    head('⑤ เซิร์ฟเวอร์จริง');
    const hash = require('bcryptjs').hashSync('test1234', 10);
    await pg.query(`insert into app.app_users ("Username","Nickname","Name","Permission","PasswordHash","Status")
       values ('crboss','พี่เอ','Panusphong','Administrator',$1,'Login'), ('crsale','ส้ม','(ส้ม) สมหญิง','Sale',$1,'Login')
       on conflict (lower("Username")) do update set "PasswordHash" = excluded."PasswordHash",
         "Permission" = excluded."Permission", "Nickname" = excluded."Nickname", "Name" = excluded."Name", "Status" = 'Login'`, [hash]);
    const env = Object.assign({}, process.env, { SUPABASE_URL: `http://127.0.0.1:${REST_PORT}`, SUPABASE_KEY: 'test-key',
      SESSION_SECRET: 'a'.repeat(64), NODE_ENV: 'development', PORT: String(APP_PORT), SYNC_ON_BOOT: '0', SYNC_EVERY_MIN: '0' });
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
    const boss = await login('crboss'), sale = await login('crsale');
    if (!ONLY_SHOT) {
      const get = async (u, c) => { const r = await fetch(base + u, { headers: c ? { cookie: c } : {}, redirect: 'manual' }); let t = ''; try { t = await r.text(); } catch (e) {} let j = null; try { j = JSON.parse(t); } catch (e) {} return { s: r.status, j, t, loc: r.headers.get('location') || '' }; };
      const mb = await get('/api/modules', boss), ms = await get('/api/modules', sale);
      const cb = (mb.j.modules || []).find(m => m.key === 'assetreg');
      ok(cb && cb.title === TITLE && cb.canUse === true && cb.path === '/m/assetreg' && cb.version, 'Administrator: /api/modules มีการ์ด "' + TITLE + '" กดได้');
      ok(JSON.stringify(mb.j).indexOf('script.google.com') < 0, '   รายการการ์ดไม่ได้พิมพ์ที่อยู่ของแอปภายนอกไว้');
      ok(ms.s === 200 && !(ms.j.modules || []).some(m => m.key === 'assetreg') && ms.t.indexOf('ทะเบียนเบอร์โทร') < 0, '🔴 เซลส์: ไม่มีการ์ดนี้ใน /api/modules เลย');
      const os = await get('/api/open/assetreg', sale);
      ok(os.s === 403 && !os.j.ticket && os.t.indexOf('script.google.com') < 0, '🔴 เซลส์ขอเปิดแอป ⇒ 403 ไม่ได้ตั๋ว ไม่ได้ที่อยู่');
      const ds = await get('/m/assetreg/', sale);
      ok(ds.s === 403 && !ds.loc && ds.t.indexOf('script.google.com') < 0, '🔴 เซลส์พิมพ์ /m/assetreg/ เอง ⇒ 403 ไม่ถูกส่งต่อ');
      const dn = await get('/m/assetreg/', '');
      ok(dn.s !== 200 && dn.loc.indexOf('script.google.com') < 0 && dn.t.indexOf('script.google.com') < 0, 'ไม่ได้ล็อกอิน ⇒ เข้าไม่ได้ (' + dn.s + ')');
      const ob = await get('/api/open/assetreg', boss);
      ok(ob.s === 200 && ob.j.ok && ob.j.url === '/m/assetreg/' && ob.j.ticket, 'Administrator ขอเปิดแอป ⇒ ได้ตั๋ว');
      const go = await get(ob.j.url + '?t=' + encodeURIComponent(ob.j.ticket), boss);
      ok(go.s === 302 && go.loc === URL_A, 'Administrator เปิด /m/assetreg/?t=… ⇒ ถูกส่งต่อไป Google Apps Script (ที่อยู่ตรงกับที่พี่เอให้)');
    }

    head('⑥ หน้าจอจริง (Chromium)');
    const { chromium } = require('playwright');
    /* 🔒 ไม่ออกไป Google จริง — ชี้ชื่อ script.google.com ไปที่ที่อยู่ที่ต่อไม่ได้ (คำขอยังถูกจดไว้ให้ตรวจ) */
    browser = await chromium.launch({ args: ['--no-sandbox', '--host-resolver-rules=MAP script.google.com 0.0.0.0'] });
    const FD = '/root/fonts-prompt/package/files/';
    let css = '';
    if (fs.existsSync(FD)) for (const wt of [400, 500, 600, 700, 800]) for (const [sub, rng] of [['thai', 'U+0E01-0E5B,U+200C-200D,U+25CC'], ['latin', 'U+0000-00FF,U+2000-206F,U+20AC,U+2212']]) {
      const f = FD + `prompt-${sub}-${wt}-normal.woff2`;
      if (fs.existsSync(f)) css += `@font-face{font-family:'Prompt';font-weight:${wt};src:url(data:font/woff2;base64,${fs.readFileSync(f).toString('base64')}) format('woff2');unicode-range:${rng}}\n`;
    }
    const open = async cookie => {
      const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
      await ctx.addCookies(cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: base }; }));
      await ctx.route('**/fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: css }));
      await ctx.route('**/fonts.gstatic.com/**', r => r.abort());
      /* จดคำขอที่เบราว์เซอร์พยายามยิงไป Google Apps Script (หลังถูกเซิร์ฟเวอร์ส่งต่อ) — ที่อยู่ + referer */
      const hits = [];
      ctx.on('request', r => { if (r.url().indexOf('https://script.google.com/') === 0) hits.push({ u: r.url(), ref: r.headers().referer || '' }); });
      const p = await ctx.newPage();
      const errs = [];
      p.on('pageerror', e => errs.push(String(e)));
      await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('#grid .card', { timeout: 30000 });
      await p.waitForTimeout(700);
      return { p, ctx, errs, hits };
    };
    const A = await open(boss);
    const cardSel = '.card[data-k="assetreg"]';
    if (ONLY_SHOT) {
      if (process.env.SHOT) await A.p.locator('#grid .stage.sup').screenshot({ path: process.env.SHOT });
    } else {
      ok(await A.p.locator(cardSel).count() === 1, 'Administrator: มีการ์ดในหน้ารวมแอป');
      const ct = await A.p.locator(cardSel).innerText();
      ok(ct.indexOf(TITLE) >= 0 && /Google Apps Script/.test(ct) && /v1\.0\.0/.test(ct), 'การ์ดแสดงชื่อ · บอกว่าเป็นแอปภายนอก · มีป้ายเวอร์ชัน');
      ok(await A.p.locator('.stage.sup ' + cardSel).count() === 1 && !(await A.p.locator(cardSel).isDisabled()), 'อยู่ในหมวด "ระบบสนับสนุน" · กดได้');
      const html = await A.p.content();
      ok(html.indexOf('script.google.com') < 0 && html.indexOf('AKfycb') < 0, '🔒 หน้ารวมแอปไม่มีที่อยู่ของแอปภายนอกฝังอยู่ (ต้องผ่านด่านเซิร์ฟเวอร์ก่อนถึงจะได้)');
      const [tab] = await Promise.all([A.ctx.waitForEvent('page', { timeout: 20000 }), A.p.click(cardSel)]);
      for (let i = 0; i < 100 && !A.hits.length; i++) await sleep(200);
      ok(!!tab && A.hits.length >= 1 && A.hits[0].u === URL_A, 'กดการ์ด ⇒ เปิดแท็บใหม่ แล้วเบราว์เซอร์ถูกส่งต่อไปที่แอปบน Google Apps Script (ที่อยู่ตรง)');
      ok(A.hits.every(h => h.ref.indexOf('t=') < 0 && h.ref.indexOf('/m/assetreg') < 0), '🔒 ปลายทางไม่ได้รับที่อยู่/ตั๋วของ CRM Hub (referer: ' + (A.hits[0].ref || 'ไม่มี') + ')');
      ok(A.errs.length === 0, 'ไม่มี error ในหน้า' + (A.errs.length ? ' — ' + A.errs[0] : ''));
      if (process.env.SHOT) await A.p.locator('#grid .stage.sup').screenshot({ path: process.env.SHOT });
      const Sx = await open(sale);
      ok(await Sx.p.locator(cardSel).count() === 0 && (await Sx.p.locator('#grid').innerText()).indexOf('ทะเบียนเบอร์โทร') < 0, '🔴 เซลส์: ไม่มีการ์ดนี้ในหน้ารวมแอป');
      await Sx.p.fill('#q', 'ทะเบียนเบอร์โทร');
      await Sx.p.waitForTimeout(300);
      ok(await Sx.p.locator(cardSel).count() === 0, '   ค้นหาชื่อก็ไม่เจอ');
      await Sx.ctx.close();
    }
    await A.ctx.close();
  } catch (e) {
    fail++; console.log('  ❌ ล้มกลางทาง: ' + (e && e.stack || e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (app) app.kill();
    try { await rest.close(); } catch (e) { /* ยามจบด้วย process.exit */ }
    await pg.end().catch(() => {});
  }
  console.log(`\n${fail ? '❌' : '✅'} ผ่าน ${pass} · ไม่ผ่าน ${fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
