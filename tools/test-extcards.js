'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  🏬💡 ยาม: การ์ด "ระบบจัดตารางสาขา" + "ระบบจองคิว LED" — npm run test:extcards   (รอบ 234 · 4 ต.ค. 69)
 *
 *  พี่เอ: "ระบบจัดตารางสาขา
 *          https://script.google.com/macros/s/AKfycbytnB-T17Jix7Vj2okUxBWdMe6f_SuHzkDB9H-bUgC7C4ZmwD4CgRNWDpJR3E2QsIBviQ/exec
 *          ระบบจองคิว LED
 *          https://script.google.com/macros/s/AKfycbxJVR10P5UwGYSPIeuSvzHsK0FtFNZKds-WUbd4vEJpYScEOfBJo3N-JZvfe8_D3dKT/exec
 *          เพิ่ม app card หน้า CRM Hub ให้ด้วยนะ"
 *
 *  ① ทะเบียนแอป: อยู่ใน KNOWN_APPS · "ไม่" ล็อกเฉพาะ Administrator (พี่เอไม่ได้สั่งจำกัด)
 *  ② โมดูล: ชื่อ · ที่อยู่ปลายทางตรงกับที่พี่เอให้ทุกตัวอักษร · เปลี่ยนที่อยู่ได้ทาง Railway (เฉพาะ script.google.com)
 *  ③ ตัวกลาง core/ext-link.js: ส่งต่อ 302 · ไม่เก็บแคช · ไม่ส่งตั๋วให้ปลายทาง · จดบันทึกการใช้งาน
 *  ④ sql/112: รันซ้ำได้ ไม่ลบอะไร ติ๊กให้ 3 กลุ่ม (administrator · sales · sale support) กลุ่มอื่นไม่ถูกแตะ
 *  ⑤ เซิร์ฟเวอร์จริง: Administrator + เซลส์ เห็นและเปิดได้ · กลุ่มที่ไม่ได้ติ๊ก (Planning) ไม่เห็น เปิดไม่ได้
 *  ⑥ หน้าจอจริง (Chromium)   SHOT=<ไฟล์> เก็บภาพหมวด "ระบบสนับสนุน"
 *  🔒 ไม่เปิดแอปบน Google จริง (เบราว์เซอร์ของยามต่อ script.google.com ไม่ได้) — ยามนี้พิสูจน์เฉพาะฝั่ง CRM Hub
 *  ‼ พอร์ต 55995 / 55996 — ไล่เช็ค tools/*.js แล้วว่าไม่ชนกับใคร
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 55995, APP_PORT = 55996;
const APP_DIR = process.env.APP_DIR || ROOT;
const ONLY_SHOT = !!process.env.ONLY_SHOT;
process.env.SUPABASE_URL = `http://127.0.0.1:${REST_PORT}`;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
delete process.env.BRANCHPLAN_URL; delete process.env.LEDQUEUE_URL;

const CARDS = [
  { key: 'branchplan', title: 'ระบบจัดตารางสาขา', env: 'BRANCHPLAN_URL',
    url: 'https://script.google.com/macros/s/AKfycbytnB-T17Jix7Vj2okUxBWdMe6f_SuHzkDB9H-bUgC7C4ZmwD4CgRNWDpJR3E2QsIBviQ/exec' },
  { key: 'ledqueue', title: 'ระบบจองคิว LED', env: 'LEDQUEUE_URL',
    url: 'https://script.google.com/macros/s/AKfycbxJVR10P5UwGYSPIeuSvzHsK0FtFNZKds-WUbd4vEJpYScEOfBJo3N-JZvfe8_D3dKT/exec' },
];
const GROUPS = ['administrator', 'sales', 'sale support'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  console.log('\n🏬💡 การ์ดระบบจัดตารางสาขา + ระบบจองคิว LED\n');
  const { Client } = require('pg');
  const pg = new Client({ connectionString: PG });
  await pg.connect();
  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  let app = null, browser = null, adminWas;
  try {
    if (!ONLY_SHOT) {
      head('① ทะเบียนแอป + ด่านกลุ่มสิทธิ์');
      const perms = require('../core/app-perms');
      for (const c of CARDS) {
        ok(perms.KNOWN_APPS.indexOf(c.key) >= 0, `'${c.key}' อยู่ในทะเบียนแอป (KNOWN_APPS)`);
        ok(!perms.isAdminOnlyApp(c.key), `   '${c.key}' ไม่ได้ล็อกเฉพาะ Administrator (พี่เอไม่ได้สั่งจำกัด — คุมด้วยตารางสิทธิ์เข้าแอป)`);
      }
      ok(perms.ADMIN_PERM_ONLY_APPS.join() === 'bom,mgmt,assetreg', '‼ แอปเฉพาะ Administrator ชุดเดิม (bom · mgmt · assetreg) ไม่ถูกแตะ');
      ok(new Set(perms.KNOWN_APPS).size === perms.KNOWN_APPS.length, '   ทะเบียนแอปไม่มีชื่อซ้ำ');

      head('② โมดูล');
      const colors = fs.readdirSync(path.join(ROOT, 'modules')).filter(k => fs.existsSync(path.join(ROOT, 'modules', k, 'module.json')))
        .map(k => { const j = JSON.parse(read('modules/' + k + '/module.json')); return { k, color: String(j.color || '').toLowerCase(), order: j.order }; });
      const REG = require('../core/registry');
      const all = REG.loadAll(true);
      for (const c of CARDS) {
        const mj = JSON.parse(read('modules/' + c.key + '/module.json'));
        ok(mj.key === c.key && mj.title === c.title, `ชื่อการ์ด = "${mj.title}" ตรงตามที่พี่เอสั่ง`);
        ok(mj.status === 'ready' && !mj.publicPaths && !mj.hideInHub && !mj.allowUsers, '   module.json: พร้อมใช้ · ไม่มีเส้นทางสาธารณะ · มีการ์ดในหน้ารวมแอป · ไม่ผูกกับชื่อผู้ใช้');
        ok(colors.filter(x => x.color === String(mj.color).toLowerCase()).length === 1 && colors.filter(x => x.order === mj.order).length === 1,
           `   สี (${mj.color}) และลำดับ (${mj.order}) ไม่ซ้ำกับแอปอื่น`);
        const M = require('../modules/' + c.key + '/index');
        ok(M.DEFAULT_URL === c.url && M.targetUrl() === c.url, '   ที่อยู่ปลายทาง = ลิงก์ที่พี่เอให้ ตรงทุกตัวอักษร');
        process.env[c.env] = 'https://script.google.com/macros/s/NEWID_abc-123/exec';
        ok(M.targetUrl() === process.env[c.env], `   ตั้ง ${c.env} ใน Railway ⇒ เปลี่ยนที่อยู่ได้โดยไม่แก้โค้ด`);
        let safe = 0;
        const BAD = ['http://script.google.com/macros/s/x/exec', 'https://evil.example.com/x', 'https://script.google.com.evil.com/x', 'javascript:alert(1)', 'https://script.google.com/x?next=https://evil.com', '//script.google.com/x'];
        for (const bad of BAD) { process.env[c.env] = bad; if (M.targetUrl() === c.url) safe++; }
        ok(safe === BAD.length, `   🔒 ${c.env} ที่ไม่ใช่ที่อยู่ของ Google Apps Script ถูกมองข้าม (${safe}/${BAD.length})`);
        delete process.env[c.env];
        const V = require('../modules/' + c.key + '/version');
        ok(/^\d+\.\d+\.\d+$/.test(V.VERSION) && V.CHANGELOG[0][0] === V.VERSION, '   version.js: เลข ' + V.VERSION + ' ตรงกับประวัติบรรทัดบน');
        const rm = all.find(m => m.key === c.key);
        ok(rm && rm.basePath === '/m/' + c.key && rm.hasServer && !rm.hasPublic, `   ทะเบียนโมดูลเห็นแอปนี้ (/m/${c.key} · มีฝั่งเซิร์ฟเวอร์ · ไม่มีไฟล์หน้าเว็บให้เปิดตรง)`);
        ok(read('public/hub.html').indexOf(c.key) < 0 && read('server.js').indexOf(c.key) < 0, '   ไม่ต้องแก้ public/hub.html และ server.js (การ์ดมาจากทะเบียนโมดูล)');
      }
      ok(CARDS[0].url !== CARDS[1].url && require('../modules/assetreg/index').DEFAULT_URL !== CARDS[0].url && require('../modules/assetreg/index').DEFAULT_URL !== CARDS[1].url,
         '‼ 3 การ์ดแอปภายนอกชี้คนละที่อยู่ (ไม่สลับกัน)');

      head('③ ตัวกลาง core/ext-link.js');
      const XL = require('../core/ext-link');
      const xsrc = read('core/ext-link.js').replace(/\/\*[\s\S]*?\*\//g, '');
      ok(!/require\(['"][^'"]*db['"]\)/.test(xsrc) && !/fetch\s*\(/.test(xsrc), 'ไม่อ่าน/เขียนฐานข้อมูล และไม่ยิงเน็ตเอง — ทำอย่างเดียวคือส่งต่อ');
      let threw = 0;
      for (const o of [{ key: '', title: 'x', url: CARDS[0].url }, { key: 'x', title: '', url: CARDS[0].url }, { key: 'x', title: 'x', url: 'https://evil.example.com/' }, { key: 'x', title: 'x', url: '' }])
        try { XL.make(o); } catch (e) { threw++; }
      ok(threw === 4, '🔒 สร้างการ์ดด้วยที่อยู่ที่ไม่ใช่ Google Apps Script / ไม่มีชื่อ ⇒ ไม่ยอมเริ่ม (4/4)');
      const express = require('express');
      const audits = [];
      const mk = (c, user) => { const a = express(); const r = express.Router(); a.use((q, _s, n) => { q.user = user; n(); });
        a.use('/m/' + c.key, r); return require('../modules/' + c.key + '/index').mount(r, { log() {}, warn() {}, audit: (u, act) => audits.push(u.username + ':' + act), auth: {} })
          .then(() => new Promise(res => { const s = a.listen(0, () => res(s)); })); };
      for (const c of CARDS) {
        const s = await mk(c, { username: 'zsale', permission: 'Sale', role: 'OFFICER' });
        const b = 'http://127.0.0.1:' + s.address().port + '/m/' + c.key;
        const r = await fetch(b + '/?t=ticket123', { redirect: 'manual' });
        ok(r.status === 302 && r.headers.get('location') === c.url, `${c.title}: ส่งต่อ (302) ไปที่แอปบน Google Apps Script`);
        ok(/no-store/.test(r.headers.get('cache-control') || '') && r.headers.get('referrer-policy') === 'no-referrer' && (r.headers.get('location') || '').indexOf('ticket123') < 0,
           '   🔒 ไม่เก็บแคช · ไม่ส่งที่อยู่/ตั๋วของหน้านี้ให้ปลายทาง · ตั๋วไม่ติดไปใน URL');
        const d = await fetch(b + '/api/_diag'), dj = await d.json();
        ok(d.status === 200 && dj.ok && dj.app === c.key && dj.adminOnly === false && JSON.stringify(dj).indexOf('AKfycb') < 0, '   /api/_diag บอกสถานะ ไม่พิมพ์ที่อยู่ของแอป');
        const n = await fetch(b + '/nope', { redirect: 'manual' });
        ok(n.status === 404, '   เส้นทางอื่นไม่มี ⇒ 404');
        s.close();
      }
      ok(audits.join() === 'zsale:branchplan_open,zsale:ledqueue_open', 'จดบันทึกการใช้งานว่าใครเปิดแอปไหน (เฉพาะตอนเปิดจริง)');
      /* ตัวเลือก adminOnly ของตัวกลาง (ยังไม่มีการ์ดไหนใช้ — กันไว้ให้การ์ดที่จะล็อกในอนาคต) */
      const lock = XL.make({ key: 'xlock', title: 'ทดสอบล็อก', url: CARDS[0].url, adminOnly: true });
      const la = express(), lr = express.Router(); let who = { username: 'z', permission: 'xadmin', role: 'ADMIN' };
      la.use((q, _s, n) => { q.user = who; n(); }); la.use('/m/xlock', lr);
      await lock.mount(lr, { log() {}, warn() {}, audit() {}, auth: {} });
      const ls = await new Promise(res => { const s = la.listen(0, () => res(s)); });
      const l1 = await fetch('http://127.0.0.1:' + ls.address().port + '/m/xlock/', { redirect: 'manual' }), t1 = await l1.text();
      who = { username: 'b', permission: 'Administrator', role: 'ADMIN' };
      const l2 = await fetch('http://127.0.0.1:' + ls.address().port + '/m/xlock/', { redirect: 'manual' });
      ls.close();
      ok(l1.status === 403 && !l1.headers.get('location') && t1.indexOf('script.google.com') < 0 && l2.status === 302, '🔒 ตัวเลือก adminOnly: ไม่ใช่ Administrator ⇒ 403 ไม่มีที่อยู่หลุด · Administrator ⇒ ส่งต่อ');

      head('④ sql/112');
      const sql = read('sql/112-ext-cards-branchplan-ledqueue.sql'), sqlCode = sql.replace(/--[^\n]*/g, '');
      ok(/array_append\(apps, k\)/.test(sqlCode) && /array\['branchplan', 'ledqueue'\]/.test(sqlCode) && /perm_key in \('administrator', 'sales', 'sale support'\)/.test(sqlCode),
         'ติ๊ก 2 แอป ให้ 3 กลุ่ม: administrator · sales · sale support');
      ok(!/\bdrop\b|\bdelete\b|\btruncate\b|create table|alter table|array_remove/i.test(sqlCode), '🔒 ไม่ลบ ไม่สร้าง/แก้ตาราง ไม่เอาแอปออกจากกลุ่มไหน');
    }
    /* ของจริง = รัน sql/112 ใน Supabase — รันซ้ำได้ */
    const before = (await pg.query('select perm_key, apps from app.app_access_group order by perm_key')).rows;
    if (fs.existsSync(path.join(APP_DIR, 'sql', '112-ext-cards-branchplan-ledqueue.sql'))) {
      const q = fs.readFileSync(path.join(APP_DIR, 'sql', '112-ext-cards-branchplan-ledqueue.sql'), 'utf8');
      await pg.query(q); await pg.query(q);
    }
    if (!ONLY_SHOT) {
      const g = (await pg.query('select perm_key, apps from app.app_access_group order by perm_key')).rows;
      const cnt = (row, k) => row.apps.filter(a => a === k).length;
      ok(GROUPS.every(p => { const r = g.find(x => x.perm_key === p); return r && cnt(r, 'branchplan') === 1 && cnt(r, 'ledqueue') === 1; }),
         'รัน 2 รอบ: 3 กลุ่มมีแอปละ 1 ครั้ง (ไม่ซ้ำ)');
      const others = g.filter(x => GROUPS.indexOf(x.perm_key) < 0);
      ok(others.length > 0 && others.every(x => cnt(x, 'branchplan') === 0 && cnt(x, 'ledqueue') === 0), `กลุ่มอื่น ${others.length} กลุ่มไม่ถูกติ๊ก (ติ๊กเพิ่มเองได้ที่ ทะเบียนกลาง → สิทธิ์เข้าแอป)`);
      const strip = a => a.filter(k => k !== 'branchplan' && k !== 'ledqueue').join();
      ok(g.length === before.length && g.every(x => { const b = before.find(y => y.perm_key === x.perm_key); return b && strip(x.apps) === strip(b.apps); }),
         '🔒 แอปเดิมของทุกกลุ่มอยู่ครบ ลำดับเดิม (ไม่มีอะไรหาย)');
    }

    head('⑤ เซิร์ฟเวอร์จริง');
    const hash = require('bcryptjs').hashSync('test1234', 10);
    /* ผู้ใช้ admin (ผู้ดูแลตารางสิทธิ์) — ถ้ามีอยู่แล้วจำรหัสเดิมไว้คืนตอนจบ */
    adminWas = (await pg.query(`select "PasswordHash" h, "Status" st, "Permission" p from app.app_users where lower("Username") = 'admin'`)).rows[0] || null;
    await pg.query(`insert into app.app_users ("Username","Nickname","Name","Permission","PasswordHash","Status") values ('admin','แอดมิน','ผู้ดูแลระบบ','Administrator',$1,'Login')
       on conflict (lower("Username")) do update set "PasswordHash" = excluded."PasswordHash", "Permission" = 'Administrator', "Status" = 'Login'`, [hash]);
    await pg.query(`insert into app.app_users ("Username","Nickname","Name","Permission","PasswordHash","Status")
       values ('xcboss','พี่เอ','Panusphong','Administrator',$1,'Login'), ('xcsale','ส้ม','(ส้ม) สมหญิง','Sale',$1,'Login'),
              ('xcsup','ฝ้าย','(ฝ้าย) สมศรี','Sale support',$1,'Login'), ('xcplan','เก่ง','(เก่ง) สมเก่ง','Planning',$1,'Login')
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
    const boss = await login('xcboss'), sale = await login('xcsale'), sup = await login('xcsup'), plan = await login('xcplan');
    const owner = await login('admin');
    if (!ONLY_SHOT) {
      const get = async (u, c) => { const r = await fetch(base + u, { headers: c ? { cookie: c } : {}, redirect: 'manual' }); let t = ''; try { t = await r.text(); } catch (e) {} let j = null; try { j = JSON.parse(t); } catch (e) {} return { s: r.status, j, t, loc: r.headers.get('location') || '' }; };
      for (const [who, ck] of [['Administrator', boss], ['เซลส์ (Sale)', sale], ['Sale support', sup]]) {
        const m = await get('/api/modules', ck);
        const found = CARDS.map(c => (m.j.modules || []).find(x => x.key === c.key));
        ok(found.every((x, i) => x && x.title === CARDS[i].title && x.canUse === true && x.path === '/m/' + CARDS[i].key && x.version), `${who}: /api/modules มีการ์ดครบ 2 ใบ กดได้`);
        ok(m.t.indexOf('script.google.com') < 0 && m.t.indexOf('AKfycb') < 0, '   รายการการ์ดไม่ได้พิมพ์ที่อยู่ของแอปภายนอกไว้');
        for (const c of CARDS) {
          const o = await get('/api/open/' + c.key, ck);
          const go = o.j && o.j.ticket ? await get(o.j.url + '?t=' + encodeURIComponent(o.j.ticket), ck) : { s: 0, loc: '' };
          ok(o.s === 200 && o.j.ok && o.j.url === '/m/' + c.key + '/' && go.s === 302 && go.loc === c.url, `   ${who} เปิด ${c.title} ⇒ ได้ตั๋ว → ถูกส่งต่อไป Google Apps Script (ที่อยู่ตรงกับที่พี่เอให้)`);
        }
      }
      const mp = await get('/api/modules', plan);
      ok(mp.s === 200 && !(mp.j.modules || []).some(m => m.key === 'branchplan' || m.key === 'ledqueue') && mp.t.indexOf('จัดตารางสาขา') < 0 && mp.t.indexOf('จองคิว LED') < 0,
         '🔴 กลุ่มที่ไม่ได้ติ๊ก (Planning): ไม่มี 2 การ์ดนี้ใน /api/modules');
      for (const c of CARDS) {
        const o = await get('/api/open/' + c.key, plan), d = await get('/m/' + c.key + '/', plan), n = await get('/m/' + c.key + '/', '');
        ok(o.s === 403 && !(o.j && o.j.ticket) && d.s === 403 && !d.loc && (o.t + d.t).indexOf('script.google.com') < 0, `🔴 Planning ขอเปิด/พิมพ์ /m/${c.key}/ เอง ⇒ 403 ไม่ได้ตั๋ว ไม่ได้ที่อยู่`);
        ok(n.s !== 200 && n.loc.indexOf('script.google.com') < 0 && n.t.indexOf('script.google.com') < 0, `   ไม่ได้ล็อกอิน ⇒ เข้า /m/${c.key}/ ไม่ได้ (${n.s})`);
      }
      /* ติ๊กเพิ่มให้ Planning ผ่านหน้า "ทะเบียนกลาง → สิทธิ์เข้าแอป" (เส้นทางเดียวกับที่หน้าจอใช้) ⇒ เห็นทันทีโดยไม่แก้โค้ด */
      const post = async (u, c, body) => { const r = await fetch(base + u, { method: 'POST', headers: { cookie: c, 'content-type': 'application/json' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };
      const bs = await get('/m/registry/api/access/bootstrap', owner);
      const listed = CARDS.map(c => ((bs.j && bs.j.apps) || []).find(a => a.key === c.key));
      ok(bs.s === 200 && listed.every((a, i) => a && a.title === CARDS[i].title && a.isModule), 'หน้า ทะเบียนกลาง → สิทธิ์เข้าแอป มี 2 แอปนี้ให้ติ๊ก (ชื่อไทยครบ)');
      const planApps = (await pg.query("select apps from app.app_access_group where perm_key = 'planning'")).rows[0].apps;
      const sv = await post('/m/registry/api/access/group', owner, { key: 'planning', apps: planApps.concat(['ledqueue']) });
      const mp2 = await get('/api/modules', plan);
      ok(sv.s === 200 && sv.j.ok && (mp2.j.modules || []).some(x => x.key === 'ledqueue' && x.canUse) && !(mp2.j.modules || []).some(x => x.key === 'branchplan'),
         'ติ๊ก "ระบบจองคิว LED" ให้กลุ่ม Planning ⇒ เห็นเฉพาะการ์ดนั้นทันที โดยไม่ต้องแก้โค้ด/รัน SQL');
      const sv2 = await post('/m/registry/api/access/group', owner, { key: 'planning', apps: planApps });
      const mp3 = await get('/api/modules', plan);
      ok(sv2.s === 200 && !(mp3.j.modules || []).some(x => x.key === 'ledqueue'), '   เอาติ๊กออก ⇒ การ์ดหายทันที');
      const sv3 = await post('/m/registry/api/access/group', sale, { key: 'planning', apps: planApps.concat(['ledqueue']) });
      ok(sv3.s === 403, '   🔒 คนที่ไม่ใช่ admin/namna แก้ตารางสิทธิ์ไม่ได้ (' + sv3.s + ')');
      const ma = await get('/api/modules', boss);
      ok((ma.j.modules || []).some(m => m.key === 'assetreg') && !((await get('/api/modules', sale)).j.modules || []).some(m => m.key === 'assetreg'),
         '‼ การ์ดรอบ 233 (ทะเบียนเบอร์โทร และทรัพย์สิน) ยังเฉพาะ Administrator เหมือนเดิม');
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
    const sel = k => `.card[data-k="${k}"]`;
    if (ONLY_SHOT) {
      const A = await open(process.env.SHOT_AS === 'sale' ? sale : boss);
      if (process.env.SHOT) await A.p.locator('#grid .stage.sup').screenshot({ path: process.env.SHOT });
      await A.ctx.close();
    } else {
      for (const [who, ck, shot] of [['Administrator', boss, process.env.SHOT], ['เซลส์', sale, process.env.SHOT_SALE]]) {
        const A = await open(ck);
        for (const c of CARDS) {
          ok(await A.p.locator('.stage.sup ' + sel(c.key)).count() === 1 && !(await A.p.locator(sel(c.key)).isDisabled()), `${who}: มีการ์ด "${c.title}" ในหมวด "ระบบสนับสนุน" · กดได้`);
          const ct = await A.p.locator(sel(c.key)).innerText();
          ok(ct.indexOf(c.title) >= 0 && /Google Apps Script/.test(ct) && /v1\.0\.0/.test(ct), '   การ์ดแสดงชื่อ · บอกว่าเป็นแอปภายนอก · มีป้ายเวอร์ชัน');
        }
        const html = await A.p.content();
        ok(html.indexOf('script.google.com') < 0 && html.indexOf('AKfycb') < 0, '   🔒 หน้ารวมแอปไม่มีที่อยู่ของแอปภายนอกฝังอยู่');
        if (shot) await A.p.locator('#grid .stage.sup').screenshot({ path: shot });
        for (const c of CARDS) {
          const n0 = A.hits.length;
          const [tab] = await Promise.all([A.ctx.waitForEvent('page', { timeout: 20000 }), A.p.click(sel(c.key))]);
          for (let i = 0; i < 100 && A.hits.length === n0; i++) await sleep(200);
          const h = A.hits.slice(n0);
          ok(!!tab && h.length >= 1 && h[0].u === c.url, `   กด "${c.title}" ⇒ เปิดแท็บใหม่ แล้วถูกส่งต่อไปที่แอปบน Google Apps Script (ที่อยู่ตรง)`);
          ok(h.every(x => x.ref.indexOf('t=') < 0 && x.ref.indexOf('/m/' + c.key) < 0), '   🔒 ปลายทางไม่ได้รับที่อยู่/ตั๋วของ CRM Hub');
          await tab.close().catch(() => {});
        }
        ok(A.errs.length === 0, '   ไม่มี error ในหน้า' + (A.errs.length ? ' — ' + A.errs[0] : ''));
        await A.ctx.close();
      }
      const P = await open(plan);
      ok(await P.p.locator(sel('branchplan')).count() === 0 && await P.p.locator(sel('ledqueue')).count() === 0, '🔴 Planning (ไม่ได้ติ๊ก): ไม่มี 2 การ์ดนี้ในหน้ารวมแอป');
      await P.p.fill('#q', 'จองคิว LED');
      await P.p.waitForTimeout(300);
      ok(await P.p.locator(sel('ledqueue')).count() === 0, '   ค้นหาชื่อก็ไม่เจอ');
      await P.ctx.close();
    }
  } catch (e) {
    fail++; console.log('  ❌ ล้มกลางทาง: ' + (e && e.stack || e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (app) app.kill();
    try {
      await pg.query(`delete from app.app_users where lower("Username") in ('xcboss','xcsale','xcsup','xcplan')`);
      if (adminWas) await pg.query(`update app.app_users set "PasswordHash" = $1, "Status" = $2, "Permission" = $3 where lower("Username") = 'admin'`, [adminWas.h, adminWas.st, adminWas.p]);
      else if (adminWas === null) await pg.query(`delete from app.app_users where lower("Username") = 'admin'`);
    } catch (e) { /* เก็บกวาดไม่ได้ไม่ใช่เหตุให้ยามตก */ }
    try { await rest.close(); } catch (e) { /* ยามจบด้วย process.exit */ }
    await pg.end().catch(() => {});
  }
  console.log(`\n${fail ? '❌' : '✅'} ผ่าน ${pass} · ไม่ผ่าน ${fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
