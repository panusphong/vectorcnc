'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  🧪 tools/test-rank3m.js — รอบ 230 · อันดับสะสม 3 เดือนล่าสุด (ช่องขวาสุดของแถวอันดับ)
 *  พี่เอ 3 ต.ค. 69: "ในส่วนของ Ranking sale ให้เพิ่มอีกช่องนึง คือ Ranking สะสม 3 เดือนล่าสุด ให้ด้วยไว้ช่องขวาสุด"
 *          "ในส่วนของ Dashboard sale ranking ให้ใส่ยอดรับเงินของแต่ละคนในช่วงเวลานั้นๆ มาด้วยนะ อย่าให้โหลดช้านะ"
 *  ① เส้น /api/dashboard/rank3m = ผลบวกของ "อันดับสะสมเดือน" 3 เดือน (ตัวคิดเดิม) · เดือนที่ 4 ย้อนหลังไม่นับ
 *  ② เส้น /api/dashboard/rank-received = ยอดรับเงินรายคน (PEAK ตัดยอดแล้ว) ของวัน / เดือน / 3 เดือน
 *  ③ หน้าจอจริง: ช่องที่ 3 อยู่ขวาสุด · ยอดรับเงินใต้ยอดขายทุกแถว · อันดับเดิมไม่เปลี่ยน · ไม่ถ่วงกัน · ทุกสิทธิ์เห็น
 *  SHOT=<file> ⇒ เก็บภาพแถวอันดับ   APP_DIR=<dir> ⇒ ถ่ายจากโค้ดรุ่นอื่น (ภาพ "ก่อน")
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 55697, APP_PORT = 55698;
process.env.SUPABASE_URL = `http://127.0.0.1:${REST_PORT}`;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const APP_DIR = process.env.APP_DIR || path.join(__dirname, '..');
const ONLY_SHOT = !!process.env.ONLY_SHOT;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);
const { todayTH } = require('../core/thai-date');

(async () => {
  console.log('\n🧪 รอบ 230 — อันดับสะสม 3 เดือนล่าสุด\n');
  const T = todayTH();
  const d0 = new Date(T + 'T00:00:00Z');
  const ymd = x => x.toISOString().slice(0, 10);
  const Y = d0.getUTCFullYear(), M = d0.getUTCMonth();
  const mid = k => ymd(new Date(Date.UTC(Y, M - k, 1)));          /* วันที่ 1 ของเดือนย้อนหลัง k เดือน */
  const { Client } = require('pg');
  const pg = new Client({ connectionString: PG });
  await pg.connect();
  await pg.query('truncate app.total_sales');
  await pg.query('delete from app.cash_flow');
  await pg.query("delete from app.sheet_rows where source like 'sales/Peak%'");
  const hash = require('bcryptjs').hashSync('test1234', 10);
  await pg.query(`insert into app.app_users ("Username","Nickname","Name","Permission","PasswordHash","Status")
     values ('crboss','พี่เอ','Panusphong','Administrator',$1,'Login'),
            ('crsale','ส้ม','(ส้ม) สมหญิง','Sale',$1,'Login')
     on conflict (lower("Username")) do update set "PasswordHash" = excluded."PasswordHash",
       "Permission" = excluded."Permission", "Nickname" = excluded."Nickname", "Name" = excluded."Name", "Status" = 'Login'`, [hash]);
  /* ยอดปิดการขายรายคน: เดือนนี้ / เดือนก่อน / 2 เดือนก่อน / 3 เดือนก่อน (เดือนสุดท้ายต้องไม่ถูกนับ)
   *   ส้ม   100,000 /  20,000 /  10,000 / 900,000
   *   แว่น    30,000 / 150,000 /  40,000 /       0
   *   มิ้น         0 /  60,000 / 200,000 /       0     ⇒ 3 เดือน: มิ้น 260,000 · แว่น 220,000 · ส้ม 130,000 (อันดับกลับจากเดือนนี้)
   *   นวล   ยังไม่ปิดการขาย 500,000 เดือนนี้ → ไม่นับ */
  const { PPAID } = require('../modules/sales/peak-sync').COL;
  let row = 0;
  const S = (who, close, sale, st, more) => {
    const cols = Object.assign({ _row: ++row, 'รหัสงาน': 'RK' + row, 'วันที่ติดต่อ': close, 'วันที่ปิดการขาย': close, 'ชื่อบริษัท': 'ลูกค้า',
      'Create By': who, 'Lead Status': st || 'ปิดการขาย', 'ประเภทลูกค้า': 'ลูกค้าใหม่', 'ลูกค้ามาจากไหน': 'Facebook', 'ชื่อช่อง / Platform': 'เพจ', 'ยอดขาย (บาท)': sale }, more || {});
    const k = Object.keys(cols);
    return pg.query(`insert into app.total_sales (${k.map(c => '"' + c + '"').join(',')}) values (${k.map((_, i) => '$' + (i + 1)).join(',')})`, k.map(c => cols[c]));
  };
  /* ยอดรับเงิน (PEAK ตัดยอดแล้ว) — นับตาม "วันที่รับเงิน" ของงานที่คนนั้นเป็นเจ้าของ
   *   ส้ม   วันนี้ 60,000 (ใบเสร็จของงานวันนี้) · เดือนก่อน 20,000 · 3 เดือนก่อน 900,000 (นอกช่วง)   ⇒ วัน 60,000 · เดือน 60,000 · 3 เดือน 80,000
   *   แว่น   วันนี้ 70,000 (ใบเสร็จของงานที่ปิดเดือนก่อน) · ยอดโอน 30,000 วันนี้ที่เซลส์คีย์แต่ PEAK ยังไม่รับชำระ = ไม่นับ (รอบ 232) ⇒ วัน 70,000 · เดือน 70,000 · 3 เดือน 70,000
   *   มิ้น   ยอดรับชำระ PEAK 150,000 ของงาน 2 เดือนก่อน (ลงวันปิดการขาย)                           ⇒ วัน 0 · เดือน 0 · 3 เดือน 150,000 */
  await S('(ส้ม) สมหญิง ใจดี', T, 100000, '', { 'เลขที่ QO / IV': 'IV-9000001' }); await S('ส้ม', mid(1), 20000, '', { 'เลขที่ QO / IV': 'IV-9000002' });
  await S('ส้ม', mid(2), 10000); await S('ส้ม', mid(3), 900000, '', { 'เลขที่ QO / IV': 'IV-9000004' });
  await S('แว่น', T, 30000, '', { 'ยอด (บาท)': 30000, 'วันที่โอน': T }); await S('แว่น', mid(1), 100000, '', { 'เลขที่ QO / IV': 'IV-9000006' });
  await S('แว่น', mid(1), 50000); await S('แว่น', mid(2), 40000);
  await S('มิ้น', mid(1), 60000); await S('มิ้น', mid(2), 200000, '', { [PPAID]: 150000 });
  await S('นวล', T, 500000, 'Onprocess');
  const cf = (iv, dt, amt, rt) => pg.query(
    `insert into app.cash_flow (key,paid_at,ym,iv,amount,wht,cash,receipt_no,customer,sale) values ($1,$2,$3,$4,$5,0,$5,$6,'ลูกค้า','x')`,
    [`${iv}|${dt}|${Math.round(amt * 100)}`, dt, dt.slice(0, 7), iv, amt, rt]);
  await cf('IV-9000001', T, 60000, 'RT-1'); await cf('IV-9000002', mid(1), 20000, 'RT-2');
  await cf('IV-9000004', mid(3), 900000, 'RT-4'); await cf('IV-9000006', T, 70000, 'RT-6');
  await cf('IV-9999999', T, 4321, 'RT-9');                       /* หางานไม่เจอ = ไม่มีเจ้าของ */

  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  let app = null, browser = null;
  try {
    const env = { ...process.env, SUPABASE_URL: `http://127.0.0.1:${REST_PORT}`, SUPABASE_KEY: 'test-key',
      SESSION_SECRET: 'a'.repeat(64), NODE_ENV: 'development', PORT: String(APP_PORT), SYNC_ON_BOOT: '0', SYNC_EVERY_MIN: '0' };
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
    const get = async (u, c) => { const r = await fetch(base + u, { headers: c ? { cookie: c } : {}, redirect: 'manual' }); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };

    if (!ONLY_SHOT) {
      head('① เส้น /api/dashboard/rank3m');
      const R = await get('/m/sales/api/dashboard/rank3m?day=' + T, boss);
      const L = (R.j && R.j.list) || [];
      ok(R.s === 200 && R.j.ok && L.length === 3 && L[0].nick === 'มิ้น' && L[0].amt === 260000 && L[1].nick === 'แว่น' && L[1].amt === 220000 && L[2].nick === 'ส้ม' && L[2].amt === 130000,
         `3 เดือนล่าสุด: มิ้น 260,000 · แว่น 220,000 · ส้ม 130,000 (ได้ ${L.map(x => x.nick + ' ' + x.amt).join(' · ')})`);
      ok(R.j.total === 610000 && L[1].deals === 4, 'รวม 610,000 · จำนวนงานบวกครบ (แว่น 4 งาน) · ยอด 900,000 ของ 3 เดือนก่อนไม่ถูกนับ · งานที่ยังไม่ปิดการขายไม่นับ');
      ok(R.j.from === mid(2) && JSON.stringify(R.j.months) === JSON.stringify([mid(2).slice(0, 7), mid(1).slice(0, 7), mid(0).slice(0, 7)]),
         `ช่วง = เดือนนี้ + 2 เดือนก่อนหน้า (${R.j.months.join(', ')})`);
      /* เท่ากับผลบวกของ "อันดับสะสมเดือน" ตัวเดิม 3 เดือน */
      const sum = {};
      for (const k of [0, 1, 2]) {
        const D = await get('/m/sales/api/dashboard?win=this&day=' + (k === 0 ? T : mid(k)), boss);
        for (const x of (D.j.rank.month || [])) sum[x.nick] = (sum[x.nick] || 0) + Number(x.amt);
      }
      ok(L.every(x => Math.abs(sum[x.nick] - x.amt) < 0.01) && Object.keys(sum).length === L.length, 'เท่ากับผลบวกของ "อันดับสะสมเดือนนี้" (ตัวคิดเดิม) ทั้ง 3 เดือน ทุกคน');
      const Rp = await get('/m/sales/api/dashboard/rank3m?day=' + mid(1), boss);
      ok(Rp.j.list[0].nick === 'ส้ม' && Rp.j.list[0].amt === 930000, 'เลือกวันที่ของเดือนก่อน ⇒ 3 เดือนเลื่อนตาม (ส้ม 930,000 ขึ้นที่ 1)');
      const Rs = await get('/m/sales/api/dashboard/rank3m?day=' + T, sale);
      ok(Rs.s === 200 && Rs.j.list.length === 3, 'เซลส์: เห็นอันดับ 3 เดือนเหมือนอันดับเดิม');
      const Rn = await get('/m/sales/api/dashboard/rank3m?day=' + T, null);
      ok(Rn.s !== 200, 'ไม่ได้ล็อกอิน ⇒ เข้าไม่ได้');
      const Rb = await get('/m/sales/api/dashboard/rank3m?day=xx', boss);
      ok(Rb.s === 200 && Rb.j.day === T, 'วันที่ผิดรูปแบบ ⇒ ใช้วันนี้ (เวลาไทย)');
    }

    if (!ONLY_SHOT) {
      head('② เส้น /api/dashboard/rank-received — ยอดรับเงินของแต่ละคนในช่วงเดียวกับอันดับ');
      const t0 = Date.now();
      const V = await get('/m/sales/api/dashboard/rank-received?day=' + T, boss);
      const ms1 = Date.now() - t0;
      const t1 = Date.now(); const V2 = await get('/m/sales/api/dashboard/rank-received?day=' + T, sale); const ms2 = Date.now() - t1;
      const B = (V.j && V.j.by) || {};
      const sameMonth = mid(0) === T ? 0 : 0;
      ok(V.s === 200 && V.j.ok && B.day['ส้ม'] === 60000 && B.day['แว่น'] === 70000 && !B.day['มิ้น'],
         `วันนี้: ส้ม 60,000 · แว่น 70,000 (เงินของงานที่ปิดเดือนก่อน แต่ PEAK รับชำระวันนี้) · ยอดโอน 30,000 ที่เซลส์คีย์แต่ PEAK ยังไม่รับชำระ ไม่นับ`);
      ok(B.month['ส้ม'] === 60000 && B.month['แว่น'] === 70000 && !B.month['มิ้น'], 'เดือนนี้: ส้ม 60,000 · แว่น 70,000');
      ok(B.m3['ส้ม'] === 80000 && B.m3['แว่น'] === 70000 && B.m3['มิ้น'] === 150000, `3 เดือนล่าสุด: ส้ม 80,000 · แว่น 70,000 · มิ้น 150,000 (เงิน 900,000 ของ 3 เดือนก่อนไม่นับ)`);
      ok(!Object.keys(B.m3).some(k => /ไม่ระบุ/.test(k)) && JSON.stringify(V.j).indexOf('IV-9') < 0 && JSON.stringify(V.j).indexOf('ลูกค้า') < 0,
         'ใบเสร็จที่หางานไม่เจอไม่มีเจ้าของ จึงไม่อยู่ในอันดับ · คำตอบมีแต่ชื่อเล่น + ยอดรวม (ไม่มีเลขบิล ชื่อลูกค้า)');
      ok(B.day['ส้ม'] === 60000 && Object.keys(B.day).indexOf('(ส้ม) สมหญิง ใจดี') < 0, 'ชื่อเจ้าของงานตัดวงเล็บแบบเดียวกับชื่อบนอันดับ ("(ส้ม) สมหญิง ใจดี" → ส้ม)');
      ok(V2.s === 200 && JSON.stringify(V2.j.by) === JSON.stringify(V.j.by) && ms2 < 300, `เซลส์เห็นเท่ากัน · ครั้งถัดไปตอบจากที่จำไว้ ${ms2} ms (ครั้งแรก ${ms1} ms)`);
      const Vn = await get('/m/sales/api/dashboard/rank-received?day=' + T, null);
      ok(Vn.s !== 200, 'ไม่ได้ล็อกอิน ⇒ เข้าไม่ได้');
      /* เกณฑ์เดียวกับการ์ดรับเงินจริง: รวมรายคน + ที่หางานไม่เจอ = ยอดบนการ์ดรวมของช่วงเดียวกัน */
      const mEndD = ymd(new Date(Date.UTC(Y, M + 1, 0)));
      const C = await get(`/m/sales/api/dashboard/received?win=custom&from=${mid(0)}&to=${mEndD}`, boss);
      const sumM = Object.values(B.month).reduce((a, x) => a + x, 0);
      ok(Math.abs(sumM + C.j.other.cur.amount - C.j.cur.amount) < 0.01 && C.j.other.cur.amount === 4321,
         `รวมรายคนของเดือนนี้ ${sumM} + ไม่ระบุช่องทาง ${C.j.other.cur.amount} = การ์ดรับเงินจริงทั้งเดือน ${C.j.cur.amount}`);
    }

    head('③ หน้าจอจริง');
    const { chromium } = require('playwright');
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const FD = '/root/fonts-prompt/package/files/';
    let css = '';
    if (fs.existsSync(FD)) for (const wt of [400, 500, 600, 700, 800]) for (const [sub, rng] of [['thai', 'U+0E01-0E5B,U+200C-200D,U+25CC'], ['latin', 'U+0000-00FF,U+2000-206F,U+20AC,U+2212']]) {
      const f = FD + `prompt-${sub}-${wt}-normal.woff2`;
      if (fs.existsSync(f)) css += `@font-face{font-family:'Prompt';font-weight:${wt};src:url(data:font/woff2;base64,${fs.readFileSync(f).toString('base64')}) format('woff2');unicode-range:${rng}}\n`;
    }
    const open = async (cookie, hang) => {
      const ctx = await browser.newContext({ viewport: { width: 1860, height: 1000 } });
      await ctx.addCookies(cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: base }; }));
      await ctx.route('**/fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: css }));
      await ctx.route('**/fonts.gstatic.com/**', r => r.abort());
      const p = await ctx.newPage();
      const errs = []; p.on('pageerror', e => errs.push(String(e)));
      if (hang) await p.route('**/api/dashboard/rank3m**', async r => { await sleep(2500); r.continue(); });
      if (hang) await p.route('**/api/dashboard/rank-received**', async r => { await sleep(1200); r.continue(); });
      await p.goto(base + '/m/sales/', { waitUntil: 'domcontentloaded' });
      await p.waitForFunction(() => /100,000/.test(document.getElementById('rankMonth').innerText), null, { timeout: 30000 });
      return { p, ctx, errs };
    };
    const A = await open(boss, !ONLY_SHOT);
    if (!ONLY_SHOT) {
      const early = await A.p.evaluate(() => document.getElementById('rank3m').innerText + '|' + document.getElementById('rankMonth').innerText);
      ok(!/260,000/.test(early) && !/รับเงิน/.test(early), 'อันดับวันนี้ / เดือนนี้ขึ้นก่อน ทั้งที่เส้น 3 เดือนและเส้นยอดรับเงินยังไม่ตอบ (ไม่รอกัน)');
      await A.p.waitForFunction(() => /260,000/.test(document.getElementById('rank3m').innerText), null, { timeout: 15000 });
      const g = await A.p.evaluate(() => {
        const c = [...document.querySelectorAll('.rankwrap .rankcard')].map(e => { const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), t: e.querySelector('.rank-h').innerText.trim(), cls: e.className }; });
        return { c, m3: document.getElementById('rank3m').innerText, tot: document.getElementById('rank3mTotal').innerText, mo: document.getElementById('rankMonth').innerText };
      });
      ok(g.c.length === 3 && /3 เดือนล่าสุด/.test(g.c[2].t) && g.c[2].x > g.c[1].x && g.c[1].x > g.c[0].x && g.c[0].y === g.c[2].y,
         `แถวอันดับมี 3 ช่อง แถวเดียวกัน — "อันดับสะสม 3 เดือนล่าสุด" อยู่ขวาสุด (x = ${g.c.map(x => x.x).join(' < ')})`);
      const names = g.m3.split('\n').map(x => x.trim()).filter(x => /^(มิ้น|แว่น|ส้ม)$/.test(x));
      ok(names.join(',') === 'มิ้น,แว่น,ส้ม' && /260,000\.00/.test(g.m3) && /220,000\.00/.test(g.m3) && /130,000\.00/.test(g.m3), 'ลำดับ: มิ้น ฿260,000.00 · แว่น ฿220,000.00 · ส้ม ฿130,000.00');
      ok(/รวม ฿610,000\.00/.test(g.tot) && /–/.test(g.tot), `หัวช่องบอกช่วงเดือน + ยอดรวม (${g.tot})`);
      ok(/ส้ม/.test(g.mo) && /100,000\.00/.test(g.mo) && !/260,000/.test(g.mo), 'ช่อง "อันดับสะสมเดือนนี้" เดิมไม่เปลี่ยน (ส้ม ฿100,000.00 ที่ 1)');
      const rc = await A.p.evaluate(() => { const o = {}; document.querySelectorAll('.rankwrap .rank-rcv').forEach(e => { o[e.getAttribute('data-rk') + ':' + e.getAttribute('data-nick')] = e.innerText.trim() + (e.classList.contains('z') ? ' [z]' : ''); }); return o; });
      ok(/รับเงิน ฿60,000$/.test(rc['day:ส้ม']) && /รับเงิน ฿70,000$/.test(rc['day:แว่น']), `อันดับวันนี้: ส้ม "${rc['day:ส้ม']}" · แว่น "${rc['day:แว่น']}"`);
      ok(/฿60,000$/.test(rc['month:ส้ม']) && /฿70,000$/.test(rc['month:แว่น']), `อันดับเดือนนี้: ส้ม "${rc['month:ส้ม']}" · แว่น "${rc['month:แว่น']}"`);
      ok(/฿150,000$/.test(rc['m3:มิ้น']) && /฿70,000$/.test(rc['m3:แว่น']) && /฿80,000$/.test(rc['m3:ส้ม']), `อันดับ 3 เดือน: มิ้น "${rc['m3:มิ้น']}" · แว่น "${rc['m3:แว่น']}" · ส้ม "${rc['m3:ส้ม']}"`);
      const amtTxt = await A.p.evaluate(() => document.querySelector('#rankMonth .rank-item .rank-amt').innerText);
      ok(/^฿100,000\.00/.test(amtTxt.trim()), 'ยอดขายบนอันดับยังอยู่ที่เดิม ยอดรับเงินเป็นบรรทัดเล็กใต้ยอดขาย');
      await A.p.evaluate(() => loadDash(true));
      await A.p.waitForTimeout(400);
      const again = await A.p.evaluate(() => document.querySelector('#rankMonth .rank-rcv').innerText);
      ok(/รับเงิน/.test(again), 'รอบอัปเดตเอง: ยอดรับเงินขึ้นพร้อมแถวอันดับทันทีจากค่าที่จำไว้ (ไม่กะพริบหาย)');
      ok(A.errs.length === 0, 'หน้าเว็บไม่มีข้อผิดพลาด JavaScript' + (A.errs.length ? ' — ' + A.errs[0] : ''));
    } else {
      await A.p.waitForTimeout(1500);
    }
    if (process.env.SHOT) await A.p.locator('.rankwrap').screenshot({ path: process.env.SHOT });
    await A.ctx.close();
    if (!ONLY_SHOT) {
      const B = await open(sale, false);
      await B.p.waitForFunction(() => /260,000/.test(document.getElementById('rank3m').innerText), null, { timeout: 15000 });
      ok(true, 'เซลส์: เห็นช่องอันดับ 3 เดือนล่าสุด');
      await B.ctx.close();
      /* จอแคบ: ช่องที่ 3 ลงบรรทัดใหม่ ไม่ล้นจอ */
      const ctx = await browser.newContext({ viewport: { width: 700, height: 900 } });
      await ctx.addCookies(boss.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: base }; }));
      const p = await ctx.newPage();
      await p.goto(base + '/m/sales/', { waitUntil: 'domcontentloaded' });
      await p.waitForFunction(() => /260,000/.test(document.getElementById('rank3m').innerText), null, { timeout: 30000 });
      const nar = await p.evaluate(() => [...document.querySelectorAll('.rankwrap .rankcard')].map(e => { const b = e.getBoundingClientRect(); return { r: Math.round(b.right), y: Math.round(b.top) }; }).concat([{ vw: document.documentElement.clientWidth }]));
      ok(nar.slice(0, 3).every(c => c.r <= nar[3].vw + 1) && nar[2].y > nar[0].y, 'จอแคบ 700 px: ช่องที่ 3 ลงบรรทัดใหม่ ไม่ล้นจอ');
      await ctx.close();
    }
  } catch (e) {
    fail++; console.log('  ❌ ชุดทดสอบล้ม: ' + (e && e.stack || e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (app) app.kill();
    await rest.close();
    await pg.end();
  }
  console.log(`\n${fail ? '❌' : '✅'} ผ่าน ${pass} · ไม่ผ่าน ${fail}\n`);
  process.exit(fail ? 1 : 0);
})();
