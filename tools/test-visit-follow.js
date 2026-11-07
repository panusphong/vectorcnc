'use strict';
process.env.TZ = process.env.TZ || 'Asia/Bangkok';
/* ═══════════════════════════════════════════════════════════════════
 *  ยาม Visit v1.5.0 + Report & Ranking v1.0.13 (7 พ.ย. 69) — 💬 บันทึกการติดตามลูกค้าทางแชท / โทร
 *  พี่เอ: "ใน app Leads & Customer visit ให้เพิ่มส่วนการติดตามลูกค้าที่ไม่การ visit ด้วยนะ เช่น แชทติดตาม โทรติดตาม
 *          ให้กับทีม ขาย online ด้วยนะ เพราะเค้าไม่ได้ออกไปหาลูกค้า"
 *        "ถ้าทีมนี้ทำ การ update ติดตามลูกค้าในระบบนี้แล้ว คะแนนของเค้าต้องได้ด้วยนะ"
 *   ① ตรวจข้อมูลเข้า (ช่องทาง · ผล · สรุป · เวลา)  ② บันทึก + ปิดงานติดตาม + ขยับขั้น + นัดครั้งถัดไป
 *   ③ ปิดการขาย/ไม่สนใจ ⇒ ไม่นัดต่อ  ④ สิทธิ์  ⑤ ปฏิทิน/ประวัติ/รายงาน  ⑥ คะแนน Report & Ranking
 *   SHOT=<dir> ⇒ ภาพหน้าจอจริง (ใช้ทำคู่มือ)
 *  รัน: node tools/test-visit-follow.js
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 56321;
process.env.SUPABASE_URL = 'http://127.0.0.1:' + REST_PORT;
process.env.SUPABASE_KEY = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'd'.repeat(64);
process.env.SHEET_SYNC = 'off';
delete process.env.GEMINI_API_KEY; delete process.env.ANTHROPIC_API_KEY;
process.env.VISIT_ROUTE_URL = 'off';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);
const DAY = 864e5;

(async () => {
  head('⑥ คะแนน Report & Ranking (คำนวณล้วน)');
  const S = require('../modules/perfreport/score');
  const itm = (r, k) => r.breakdown.find(x => x.key === k) || {};
  const sup0 = S.daily('support', { customer: {} }, null), sup1 = S.daily('support', { customer: { follows: 1 } }, null);
  ok(itm(sup0, 'follow').got === 0 && itm(sup1, 'follow').got === 10 && /แชท/.test(itm(sup1, 'follow').label), 'Sale support (ตอบแชท): บันทึกการติดตาม 1 ครั้ง ⇒ หัวข้อ "ติดตามลูกค้า" ได้ 10/10');
  const nc1 = S.daily('support', { customer: { follows: 1 } }, null, { noChat: true });
  ok(itm(nc1, 'follow').got === 15, 'Sale support ที่ไม่วัดแชท: ได้ 15/15');
  const sa1 = S.daily('sale', { customer: { follows: 1 } }, null), sa2 = S.daily('sale', { customer: { follows: 1, visits: 1 } }, null);
  ok(itm(sa1, 'visit').got === 10 && itm(sa2, 'visit').got === 20 && /ติดตาม/.test(itm(sa1, 'visit').label), 'เซลส์ที่วัดแชท (ขาย online): ติดตาม 1 ⇒ 10 · visit 1 + ติดตาม 1 ⇒ 20/20');
  const b2b = S.daily('sale', { customer: { follows: 3 } }, null, { noChat: true });
  ok(itm(b2b, 'visit').got === 0, 'Sale B2B ที่ไม่วัดแชท (ออก visit จริง): คงเดิม — ต้อง visit');
  const met = fs.readFileSync(path.join(ROOT, 'modules/perfreport/metrics.js'), 'utf8');
  ok(/kind: 'in\.\(visit,task,plan,follow\)'/.test(met) && /m\.customer\.follows = ev\.filter\(e => e\.kind === 'follow'\)/.test(met), 'metrics อ่าน visit_events ชนิด follow');

  let pg = null, rest = null, srv = null;
  const { Client } = require('pg');
  pg = new Client({ connectionString: PG }); await pg.connect();
  await pg.query(fs.readFileSync(path.join(ROOT, 'sql/126-visit-b2b.sql'), 'utf8'));
  await pg.query(fs.readFileSync(path.join(ROOT, 'sql/129-visit-trip-claims.sql'), 'utf8'));
  const U = { boss: 'zzfboss', s1: 'zzfsale1', s2: 'zzfsale2' };
  const wipe = async () => {
    await pg.query(`delete from app.app_users where "Username" like 'zzf%'`);
    for (const t of ['visit_prospects', 'visit_events', 'visit_reports']) await pg.query('delete from app.' + t).catch(() => {});
  };
  const photos = [];
  const fakeStorage = { upload: async (p, buf, mime) => { photos.push({ p, n: buf.length, mime }); return { path: p, url: 'https://cdn.example/' + p, bytes: buf.length }; } };
  try {
    await wipe();
    rest = await require('./fake-postgrest').start(PG, REST_PORT);
    const mkU = (un, name, nick, perm) => pg.query(`insert into app.app_users ("Username","Name","Nickname","Permission","Branch","Status") values ($1,$2,$3,$4,'','Login')`, [un, name, nick, perm]);
    await mkU(U.boss, 'บอส ติดตาม', 'บอส', 'Administrator'); await mkU(U.s1, 'นี ออนไลน์', 'นี', 'Sale support'); await mkU(U.s2, 'แนน ออนไลน์', 'แนน', 'Sales');
    const auth = require('../core/auth'), express = require('express');
    const users = {};
    for (const r0 of (await pg.query(`select * from app.app_users where "Username" like 'zzf%'`)).rows)
      users[r0.Username] = { username: r0.Username, name: r0.Name, nickname: r0.Nickname, image: '', permission: r0.Permission, role: auth.roleOf(r0.Permission), appAccess: [] };
    const M = require('../modules/visit/index'), AI = require('../modules/visit/ai');
    const app = express(); app.use(express.json({ limit: '25mb' }));
    const router = express.Router();
    app.use('/m/visit', (req, res, next) => { const u = users[req.get('x-test-user') || '']; if (!u) return res.status(401).json({ ok: false }); req.user = u; next(); }, router);
    const audits = [];
    await M.mount(router, { key: 'visit', db: require('../core/db'), auth, audit: (u, k, d) => audits.push([k, d]), warn: () => {}, ai: AI.create({ fetch: async () => new Response('{}', { status: 500 }) }), storage: fakeStorage });
    app.use('/brand', express.static(path.join(ROOT, 'public/brand'))); app.use('/m/visit', express.static(path.join(ROOT, 'modules/visit/public')));
    srv = app.listen(0); const BASE = 'http://127.0.0.1:' + srv.address().port + '/m/visit';
    const call = async (un, method, p2, body) => { const r0 = await fetch(BASE + p2, { method, headers: Object.assign({ 'content-type': 'application/json' }, un ? { 'x-test-user': un } : {}), body: body == null ? undefined : JSON.stringify(body) }); const txt = await r0.text(); let j = null; try { j = JSON.parse(txt); } catch (e) { /* */ } return { st: r0.status, j }; };

    head('① boot + ตรวจข้อมูลเข้า');
    let r = await call(U.s1, 'GET', '/api/boot');
    ok(r.st === 200 && r.j.outcomes.length === 6 && r.j.channels.some(c => c.key === 'fb') && r.j.channels.some(c => c.key === 'ig'), 'boot: ผลการติดตาม 6 แบบ · ช่องทาง Facebook / Instagram');
    r = await call(U.s1, 'POST', '/api/prospect/save', { item: { name: 'ร้านกาแฟ บ้านสวน' } });
    const PID = r.j.id;
    const P2 = (await call(U.s1, 'POST', '/api/prospect/save', { item: { name: 'คลินิกฟัน ยิ้มสวย', phone: '081-234-5678' } })).j.id;
    const P3 = (await call(U.s1, 'POST', '/api/prospect/save', { item: { name: 'หอพัก เดอะลีฟ' } })).j.id;
    const Pother = (await call(U.s2, 'POST', '/api/prospect/save', { item: { name: 'ร้านอาหาร ครัวแนน' } })).j.id;
    r = await call(U.s1, 'POST', '/api/task', { prospectId: PID, channel: 'line', title: 'ทักถามขนาดป้ายหน้าร้าน', at: new Date(Date.now() + 3600e3).toISOString() });
    const TASK = r.j.event.id;
    const bad = async (body, re, m) => { const x = await call(U.s1, 'POST', '/api/follow', Object.assign({ prospectId: PID, channel: 'line', outcome: 'talked', note: 'คุยเรื่องขนาดป้าย' }, body)); ok(x.st === 400 && re.test(x.j.error), m + ' ⇒ ' + x.j.error); };
    await bad({ channel: '' }, /ช่องทาง/, 'ไม่เลือกช่องทาง');
    await bad({ outcome: 'xx' }, /ผล/, 'ไม่เลือกผล');
    await bad({ note: 'ok' }, /สรุป/, 'สรุปสั้นเกิน');
    await bad({ at: new Date(Date.now() + 2 * DAY).toISOString() }, /ไม่เกินตอนนี้/, 'เวลาติดตามในอนาคต');
    await bad({ next: { at: new Date(Date.now() - 3600e3).toISOString() } }, /ข้างหน้า/, 'นัดครั้งถัดไปเป็นเวลาที่ผ่านไปแล้ว');
    r = await call(U.s1, 'POST', '/api/follow', { prospectId: Pother, channel: 'call', outcome: 'talked', note: 'ลองบันทึกลูกค้าคนอื่น' });
    ok(r.st === 403, 'บันทึกการติดตามลูกค้าของเซลส์คนอื่นไม่ได้ (403)');

    head('② บันทึก + ปิดงานติดตาม + ขยับขั้น + นัดครั้งถัดไป');
    const img = fs.existsSync(path.join(ROOT, 'public/brand/logo.png')) ? 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'public/brand/logo.png')).toString('base64') : null;
    const nAt = Date.now() + 2 * DAY;
    r = await call(U.s1, 'POST', '/api/follow', { prospectId: PID, channel: 'line', outcome: 'quote', note: 'ลูกค้าต้องการป้ายไฟหน้าร้าน 3×1 ม. ขอใบเสนอราคา 2 แบบ', taskId: TASK,
      photos: img ? [img] : [], next: { at: new Date(nAt).toISOString(), title: 'ส่งใบเสนอราคา + ถามผล' } });
    ok(r.st === 200 && r.j.event.kind === 'follow' && r.j.event.status === 'done' && r.j.event.doc.channel === 'line' && r.j.event.doc.outcome === 'quote', 'บันทึกการติดตาม: LINE · สนใจ ขอใบเสนอราคา');
    ok(!img || (r.j.event.doc.photos.length === 1 && photos.length === 1), 'ภาพแคปแชทขึ้นที่เก็บรูป');
    ok(r.j.p.stage === 'quoted', 'ขั้นการขายขยับเป็น "เสนอราคาแล้ว"');
    ok(r.j.next && r.j.next.kind === 'task' && Math.abs(r.j.next.at - nAt) < 2000 && r.j.next.doc.channel === 'line' && r.j.next.title === 'ส่งใบเสนอราคา + ถามผล', 'นัดครั้งถัดไปลงเป็นงานติดตามใหม่ (ช่องทางเดียวกัน)');
    let d = (await call(U.s1, 'GET', '/api/prospect/' + PID)).j;
    const t0 = d.events.find(e => e.id === TASK);
    ok(t0.status === 'done' && /ขอใบเสนอราคา/.test(t0.doc.result), 'งานติดตามเดิมถูกปิด พร้อมผล');
    ok(d.p.nextAction && /ส่งใบเสนอราคา/.test(d.p.nextAction), 'แฟ้มลูกค้า: งานถัดไป = นัดใหม่');
    ok(audits.some(a => a[0] === 'visit_follow' && a[1].outcome === 'quote'), 'จด audit');
    r = await call(U.s1, 'POST', '/api/follow', { prospectId: P2, channel: 'call', outcome: 'noreply', note: 'โทร 2 ครั้ง ไม่รับสาย', next: { at: new Date(Date.now() + DAY).toISOString() } });
    ok(r.st === 200 && r.j.p.stage === 'target' && r.j.next, 'ไม่รับสาย ⇒ ขั้นไม่เปลี่ยน · นัดโทรใหม่พรุ่งนี้');

    head('③ ปิดการขาย / ไม่สนใจ ⇒ ไม่นัดต่อ');
    r = await call(U.s1, 'POST', '/api/follow', { prospectId: PID, channel: 'fb', outcome: 'won', note: 'ลูกค้าโอนมัดจำแล้ว ยืนยันแบบ A', next: { at: new Date(Date.now() + DAY).toISOString() } });
    ok(r.st === 200 && r.j.p.stage === 'won' && !r.j.next, 'ปิดการขายได้ ⇒ ขั้น "ปิดการขายได้" · ไม่สร้างนัดต่อ');
    r = await call(U.s1, 'POST', '/api/follow', { prospectId: P3, channel: 'ig', outcome: 'lost', note: 'ลูกค้าได้ร้านอื่นแล้ว ราคาถูกกว่า' });
    ok(r.st === 200 && r.j.p.stage === 'lost', 'ไม่สนใจ ⇒ ขั้น "ไม่ได้งาน"');
    r = await call(U.s1, 'POST', '/api/follow', { prospectId: PID, channel: 'call', outcome: 'quote', note: 'ลูกค้าขอใบเสนอราคาเพิ่มอีกชิ้น' });
    ok(r.st === 200 && r.j.p.stage === 'won', 'ปิดการขายแล้วไม่ถอยขั้น');

    head('⑤ ปฏิทิน · รายงาน · หัวหน้า');
    const from = new Date(Date.now() - 3 * DAY).toISOString(), to = new Date(Date.now() + 5 * DAY).toISOString();
    r = await call(U.s1, 'GET', '/api/calendar?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to));
    ok(r.j.events.filter(e => e.kind === 'follow').length === 5, 'ปฏิทินแสดงการติดตามที่บันทึก 5 รายการ');
    r = await call(U.boss, 'GET', '/api/calendar?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to) + '&owner=' + U.s1);
    ok(r.j.events.filter(e => e.kind === 'follow').length === 5, 'หัวหน้าเห็นการติดตามของเซลส์');
    const ymdTH = t => new Date(t + 7 * 3600e3).toISOString().slice(0, 10);
    r = await call(U.boss, 'POST', '/api/report', { from: ymdTH(Date.now() - DAY), to: ymdTH(Date.now() + DAY), owner: U.s1 });
    ok(r.st === 200 && r.j.doc.kpi.follows === 5, 'รายงาน: ติดตามทางแชท/โทร 5 ครั้ง');
    const n0 = (await pg.query(`select count(*)::int n from app.visit_events where by_user=$1 and kind='follow'`, [U.s1])).rows[0].n;
    ok(n0 === 5, 'ฐาน: visit_events ชนิด follow ของเซลส์ = 5 (Report & Ranking นับจากตรงนี้)');

    head('⑦ หน้าเว็บ');
    const js = fs.readFileSync(path.join(ROOT, 'modules/visit/public/app.js'), 'utf8');
    ok(/data-act="qfollow"/.test(js) && /data-act="follow"/.test(js) && /function followForm/.test(js) && /req\('\/follow'/.test(js), 'ปุ่ม 💬 หน้าแรก/ปฏิทิน/แฟ้มลูกค้า + ฟอร์ม + ส่งบันทึก');
    ok(/✓ บันทึกผล/.test(js) && /taskId: e1\.id/.test(js), 'งานติดตาม "✓ บันทึกผล" ⇒ เปิดฟอร์มบันทึกการติดตาม');
    const man = fs.readFileSync(path.join(ROOT, 'modules/visit/public/manual.html'), 'utf8'), idx = fs.readFileSync(path.join(ROOT, 'modules/visit/public/index.html'), 'utf8');
    const imgs = [...man.matchAll(/src="\.\/(manual\/[^"]+)"/g)].map(x => x[1]);
    ok(/href="\.\/manual\.html"/.test(idx) && imgs.length === 6 && imgs.every(f => fs.existsSync(path.join(ROOT, 'modules/visit/public', f)) && fs.statSync(path.join(ROOT, 'modules/visit/public', f)).size < 120 * 1024) && !/<script/.test(man),
      '📖 คู่มือ: ลิงก์บนหัวแอป · ภาพประกอบ 6 รูปมีครบ (≤120KB/รูป) · หน้าคงที่ไม่มีสคริปต์');
    if (process.env.SHOT) {
      const { chromium } = require('playwright'); const br = await chromium.launch();
      /* ข้อมูลตัวอย่างสำหรับภาพคู่มือ */
      await call(U.s2, 'POST', '/api/task', { prospectId: Pother, channel: 'call', title: 'โทรถามผลใบเสนอราคา', at: new Date(Date.now() + 2 * 3600e3).toISOString() });
      await call(U.s2, 'POST', '/api/follow', { prospectId: Pother, channel: 'line', outcome: 'thinking', note: 'ส่งแบบป้ายไปแล้ว ลูกค้าขอปรึกษาหุ้นส่วนก่อน', next: { at: new Date(Date.now() + 3 * DAY).toISOString(), title: 'ถามผลการตัดสินใจ' } });
      const shot = async (vw, fn, name, opt) => {
        const ctx = await br.newContext(Object.assign({ viewport: opt && opt.tall ? { width: vw.width, height: 1900 } : vw, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-test-user': (opt && opt.user) || U.s2 } }, opt && opt.mobile ? { isMobile: true, hasTouch: true } : {}));
        const pz = await ctx.newPage(); await pz.route(/^https?:\/\/(?!127\.0\.0\.1)/, rr => rr.fulfill({ status: 200, body: '' }));
        await pz.goto(BASE + '/'); await pz.waitForSelector('.hero', { timeout: 15000 }); await pz.waitForTimeout(500);
        const out = await fn(pz); await pz.waitForTimeout(350);
        if (out !== false) await (out && out.screenshot ? out : pz).screenshot({ path: path.join(process.env.SHOT, name) });
        const over = await pz.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); ok(!over, name + ' ไม่ล้นจอ');
        await ctx.close();
      };
      const D = { width: 1280, height: 860 }, Mo = { width: 390, height: 844 };
      await shot(D, async pz => pz.locator('.hero'), 'm1-home-button.png');
      await shot(D, async pz => { await pz.click('[data-act="qfollow"]'); await pz.waitForSelector('.modal'); await pz.fill('[data-mq]', 'ครัว'); await pz.waitForTimeout(200);
        await pz.selectOption('[data-mpick]', Pother); await pz.waitForTimeout(250);
        await pz.click('[data-mch="line"]'); await pz.click('[data-moc="quote"]');
        await pz.fill('[data-mbind="note"]', 'ลูกค้าทักมาทาง LINE ถามราคาป้ายไฟหน้าร้าน 3×1 ม. ขอใบเสนอราคา 2 แบบ งบไม่เกิน 20,000');
        await pz.fill('[data-mbind="nextTitle"]', 'ส่งใบเสนอราคา + ถามผล'); await pz.waitForTimeout(200); return pz.locator('.modal'); }, 'm2-follow-form.png', { tall: true });
      await shot(Mo, async pz => { await pz.click('[data-act="qfollow"]'); await pz.waitForSelector('.modal'); await pz.selectOption('[data-mpick]', Pother); await pz.waitForTimeout(250);
        await pz.click('[data-mch="call"]'); await pz.click('[data-moc="noreply"]'); await pz.fill('[data-mbind="note"]', 'โทร 2 ครั้ง ไม่รับสาย ส่ง LINE ฝากไว้แล้ว'); return null; }, 'm3-follow-mobile.png', { mobile: true });
      await shot(D, async pz => { const b = pz.locator('.ag-it').filter({ hasText: 'โทรถามผลใบเสนอราคา' }).first(); return b; }, 'm4-task-done-btn.png');
      await shot(D, async pz => { await pz.click('[data-go="cal"]'); await pz.waitForSelector('.cal .ev', { timeout: 15000 }); await pz.waitForTimeout(300); const bx = await pz.locator('.cal').boundingBox(); await pz.screenshot({ path: path.join(process.env.SHOT, 'm5-calendar.png'), clip: { x: bx.x, y: bx.y, width: bx.width, height: Math.min(bx.height, 420) } }); return false; }, 'm5-calendar.png', { user: U.s1 });
      await shot(D, async pz => { await pz.click('[data-go="list"]'); await pz.waitForSelector('tr[data-open]'); await pz.click('tr[data-open="' + Pother + '"]'); await pz.waitForTimeout(700);
        await pz.getByText('visit & ติดตาม', { exact: true }).click(); await pz.waitForSelector('.tl-it.follow'); await pz.waitForTimeout(300); return pz.locator('.drawer, .dr, aside').first(); }, 'm6-timeline.png');
      await br.close();
    }
  } catch (e) { fail++; console.log('  ❌ ล้ม: ' + (e.stack || e)); }
  finally { try { srv && srv.close(); } catch (e) { /* */ } await wipe().catch(() => {}); if (rest) await rest.close().catch(() => {}); await pg.end().catch(() => {}); }
  console.log('\n' + (fail ? '❌' : '✅') + ' ผ่าน ' + pass + ' · ไม่ผ่าน ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
