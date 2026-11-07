'use strict';
process.env.TZ = process.env.TZ || 'UTC';
/* ═══════════════════════════════════════════════════════════════════
 *  🧪 tools/test-jc-subreq.js — ⚠️ เตือนบนการ์ด: งานย่อยของ Project ยังเข้ามาไม่ครบ (Job Card v1.29.0)
 *  พี่เอ 5 พ.ย. 69: "กรณี Job card ที่เป็นงานหลัก complete แต่งานย่อยยังไม่ complete ช่วยแจ้งเตือน ในหน้า card หลัก ด้วยนะ …
 *    การแจ้งเตือนที่ card หลักจะต้องอยู่จนกว่า job งานย่อยจะเข้ามาจนครบทุกใบให้ด้วย"
 *  SHOT=<dir> ⇒ เก็บภาพ
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path'), fs = require('fs'), http = require('http'), express = require('express');
const { Client } = require('pg');
const ROOT = path.join(__dirname, '..');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 55891;
process.env.SUPABASE_URL = 'http://127.0.0.1:' + REST_PORT;
process.env.SUPABASE_KEY = 'test';
process.env.SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA || 'app';
process.env.SHEET_SYNC = 'off';
process.env.BOOKING_AUTO_IMPORT = 'off';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const PFX = 'ZZSR-';

async function wipe(pg) {
  await pg.query(`delete from app.job_stations where "JobID" like $1`, [PFX + '%']);
  await pg.query(`delete from app.production_jobs where "JobID" like $1`, [PFX + '%']);
  await pg.query(`delete from app.requirements where project_id like $1`, [PFX + '%']);
}
async function job(pg, id, pid, rid, status, rname) {
  await pg.query(`insert into app.production_jobs ("JobID","ProjectID","RequirementID","RequirementName","JobOrderNo","JobNumber","CustomerName","WorkGroup","OverallStatus","JobType","MainJobImage","CreatedAt","UpdatedAt","SalesPerson","Graphic","Project")
     values ($1,$2,$3,$4,$5,$6,'ร้านทดสอบงานย่อย','กลุ่มงานป้าย',$7,'ติดตั้งใหม่','',now(),now(),'(แว่น) ทดสอบ','(แก้ม) ทดสอบ','ป้ายร้าน Unlimited')`,
    [PFX + id, pid, rid || '', rname || '', 'JOB-' + id, 'JN-' + id, status]);
  await pg.query(`insert into app.job_stations ("JobStationID","JobID","StationID","StationName","StationOrder","CurrentStep","IsActive") values ($1,$2,'ST06','เลเซอร์',6,$3,true)`,
    [PFX + id + '-ST06', PFX + id, status === 'Closed' ? 4 : 1]);
}
let rr = 99800;
const req = (pg, pid, rid, name, status, jt) => pg.query(`insert into app.requirements (_row, requirement_id, project_id, requirement_name, job_type, status) values ($1,$2,$3,$4,$5,$6)`, [rr++, rid, pid, name, jt || 'ป้ายไม่มีไฟ', status]);

(async () => {
  console.log('\n⚠️ Job Card — เตือนงานย่อยยังเข้ามาไม่ครบ\n');
  const pg = new Client({ connectionString: PG }); await pg.connect();
  await wipe(pg);
  /* Project A: งานย่อย 4 รายการ (1 ใบเป็น "เช็คพื้นที่" ไม่เข้าผลิต) · การ์ด R1 Closed · R2 กำลังผลิต · R3 ยังไม่มีการ์ด (Project ย่อยยังไม่ Complete) */
  const PA = PFX + 'PA';
  await req(pg, PA, PFX + 'R1', 'ป้ายอะคริลิค Unlimited', 'Complete'); await req(pg, PA, PFX + 'R2', 'กล่องไฟหน้าร้าน', 'Complete');
  await req(pg, PA, PFX + 'R3', 'ตัวอักษรโลหะ 3 เมตร', 'In Progress'); await req(pg, PA, PFX + 'R4', 'เช็คพื้นที่หน้างาน', 'Not started', 'เช็คพื้นที่ / วางไกด์');
  await job(pg, 'A1', PA, PFX + 'R1', 'Closed', 'ป้ายอะคริลิค Unlimited');
  await job(pg, 'A2', PA, PFX + 'R2', 'Active', 'กล่องไฟหน้าร้าน');
  /* Project B: งานย่อยครบทุกใบ ⇒ ไม่เตือน · Project C: ไม่มีงานย่อย ⇒ ไม่เตือน */
  const PB = PFX + 'PB', PC = PFX + 'PC';
  await req(pg, PB, PFX + 'R5', 'ป้ายชื่อ', 'Complete'); await job(pg, 'B1', PB, PFX + 'R5', 'Closed', 'ป้ายชื่อ');
  await job(pg, 'C1', PC, '', 'Closed');
  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  const DB = require(path.join(ROOT, 'core/db.js'));
  const SR = require(path.join(ROOT, 'modules/jobcard/subreqs.js'));
  const RPC = require(path.join(ROOT, 'modules/jobcard/rpc.js'));
  let browser, srv;
  try {
    console.log('① เซิร์ฟเวอร์');
    let r = await SR.getJobSubReqAlerts(DB, { jobIDs: [PFX + 'A1', PFX + 'A2', PFX + 'B1', PFX + 'C1', ''] });
    const a1 = r.map[PFX + 'A1'];
    ok(r.success && Object.keys(r.map).sort().join(',') === [PFX + 'A1', PFX + 'A2'].join(','), 'เตือนเฉพาะการ์ดของ Project ที่งานย่อยยังเข้ามาไม่ครบ (A1, A2) · B ครบแล้ว · C ไม่มีงานย่อย ⇒ ไม่เตือน');
    ok(a1 && a1.thisDone && a1.missing.length === 1 && a1.missing[0].name === 'ตัวอักษรโลหะ 3 เมตร' && a1.missing[0].status === 'In Progress' && a1.subTotal === 3 && a1.subCards === 2,
      'การ์ด A1 (Complete แล้ว): ยังไม่มี Card 1 รายการ "ตัวอักษรโลหะ 3 เมตร" (In Progress) · เข้ามาแล้ว 2/3 · ไม่นับ "เช็คพื้นที่" ที่ไม่เข้าผลิต');
    ok(a1.open.length === 1 && a1.open[0].jobID === PFX + 'A2' && r.map[PFX + 'A2'].open.length === 0 && !r.map[PFX + 'A2'].thisDone, '   + บอกการ์ดงานย่อยที่ยังผลิตไม่จบ (A2) · การ์ด A2 ไม่นับตัวเอง');
    ok(RPC.has('getJobSubReqAlerts') && !RPC.has('subsOf'), 'ต่อสาย SRUN().getJobSubReqAlerts · ตัวช่วยไม่หลุดเป็นทางเข้า');
    ok((await SR.getJobSubReqAlerts(DB, {})).success, 'ไม่ส่งการ์ดมา ⇒ ว่าง ไม่พัง');

    console.log('\n② หน้าเว็บ');
    require(path.join(ROOT, 'modules/jobcard/avatars.js')).userAvatarMap = async () => ({});
    const JCV = require(path.join(ROOT, 'modules/jobcard/version.js'));
    const HTML_VARS = require(path.join(ROOT, 'modules/jobcard/html-vars.js'));
    const PUB = path.join(ROOT, 'modules/jobcard/public');
    const app = express();
    app.use((q, _r, next) => { q.user = { username: 'admin', nickname: 'เอ', name: 'เอ ทดสอบ', permission: 'Administrator', role: 'ADMIN' }; next(); });
    app.get(['/m/jobcard/', '/m/jobcard/index.html'], (q, res) => {
      let html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
      const vars = HTML_VARS(q) || {};
      for (const [k, v] of Object.entries(vars)) html = html.split('__' + k + '__').join(String(v == null ? '' : v).replace(/["<>&]/g, c => ({ '"': '&quot;', '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])));
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(html);
    });
    const fns = [];
    app.use('/m/jobcard/api/rpc', express.json({ limit: '25mb' }), (q, _r, next) => { fns.push(q.body && q.body.fn); next(); });
    app.use('/m/jobcard/api/rpc', RPC.makeRouter({ db: DB, VERSION: JCV.VERSION }));
    app.use('/m/jobcard', express.static(PUB));
    srv = await new Promise(rs => { const x = http.createServer(app); x.listen(0, '127.0.0.1', () => rs(x)); });
    const { chromium } = require('playwright');
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    for (const vp of [{ n: 'desk', w: 1440, h: 1400 }, { n: 'mobile', w: 430, h: 1600 }]) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      const page = await ctx.newPage();
      await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = '#jaaPop,#jwaPop{display:none!important}'; document.head.appendChild(st); }));
      page.on('dialog', dl => dl.dismiss());
      const errs = []; page.on('pageerror', e => errs.push(String((e && e.message) || e)));
      await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, x => x.request().resourceType() === 'script' ? x.fulfill({ status: 200, contentType: 'application/javascript', body: '' }) : x.fulfill({ status: 204, body: '' }));
      await page.goto('http://127.0.0.1:' + srv.address().port + '/m/jobcard/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.state && state.data && state.data.cards, null, { timeout: 30000 });
      await page.evaluate(() => { try { if (window.state) { state.showClosed = true; } } catch (e) {} });
      const found = await page.waitForFunction(id => document.querySelector('[data-jobid="' + id + '"] .jsra, [data-jobid="' + id + '"] .jsra-chip'), PFX + 'A2', { timeout: 20000 }).then(() => true).catch(() => false);
      const t = await page.evaluate(p => {
        const g = id => { const c = document.querySelector('[data-jobid="' + id + '"][data-projid]'); if (!c) return null; const a = c.querySelector('.jsra, .jsra-chip'); return a ? { t: a.textContent, red: a.classList.contains('red'), full: a.classList.contains('jsra') } : ''; };
        return { A1: g(p + 'A1'), A2: g(p + 'A2'), B1: g(p + 'B1'), C1: g(p + 'C1') };
      }, PFX);
      ok(found && t.A2 && /งานย่อย/.test(t.A2.t), vp.n + ': การ์ด A2 มีแถบ/ป้ายเตือนงานย่อย — ' + (t.A2 && t.A2.t.slice(0, 90)));
      ok(t.B1 !== null ? t.B1 === '' : true, vp.n + ': การ์ด Project ที่งานย่อยครบแล้ว ไม่มีแถบ');
      if (t.A1) ok(t.A1.red, vp.n + ': การ์ด A1 ที่ Complete แล้ว = แถบแดง');
      if (vp.n === 'desk') ok(fns.filter(f => f === 'getJobSubReqAlerts').length === 1, 'บอร์ดถามเรื่องงานย่อยครั้งเดียวทั้งจอ');
      if (process.env.SHOT) {
        const el = page.locator('[data-jobid="' + PFX + 'A2"][data-projid]').first();
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.screenshot({ path: path.join(process.env.SHOT, 'sr-' + vp.n + '.png') }).catch(e => console.log('    shot:', e.message));
        if (t.A1) await page.locator('[data-jobid="' + PFX + 'A1"][data-projid]').first().screenshot({ path: path.join(process.env.SHOT, 'sr-' + vp.n + '-done.png') }).catch(() => {});
      }
      ok(errs.length === 0, vp.n + ': ไม่มี JavaScript error' + (errs.length ? ' — ' + errs.join(' | ') : ''));
      await ctx.close();
    }
    console.log('\n③ งานย่อยเข้ามาครบ ⇒ แถบหายเอง');
    await job(pg, 'A3', PA, PFX + 'R3', 'Pending', 'ตัวอักษรโลหะ 3 เมตร');
    r = await SR.getJobSubReqAlerts(DB, { jobIDs: [PFX + 'A1', PFX + 'A2', PFX + 'A3'] });
    ok(r.success && Object.keys(r.map).length === 0, 'Card งานย่อยครบทุกใบแล้ว ⇒ ไม่มีแถบเตือนบนการ์ดไหนเลย');
    ok(JCV.VERSION === '1.29.1', 'Job Card เวอร์ชัน 1.29.1');
  } catch (e) { fail++; console.log('  ❌ ล้ม: ' + (e.stack || e)); }
  finally {
    if (browser) await browser.close();
    if (srv) await new Promise(rs => srv.close(rs));
    if (rest && rest.stop) await rest.stop(); else if (rest && rest.close) rest.close();
    await wipe(pg); await pg.end();
  }
  console.log('\n' + (fail ? '❌' : '✅') + ' ผ่าน ' + pass + ' · ไม่ผ่าน ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('💥', e); process.exit(1); });
