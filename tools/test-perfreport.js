'use strict';
process.env.TZ = process.env.TZ || 'UTC';
/* ═══════════════════════════════════════════════════════════════════
 *  ยาม Report & Ranking 1.0.0 (3 พ.ย. 69)
 *   ① สูตรคะแนน (score.js) · ช่วงเวลา · เวลาตอบแชท
 *   ② ตัวเลขจากแอปจริง (ฐานจริงผ่าน fake-postgrest): Ant-Connect · คีย์ยอดขาย · เงิน · Visit · คิวช่าง · Projects
 *   ③ ส่ง report: เฉพาะของตัวเอง วันนี้ · ตัวเลขแก้ไม่ได้ · สรุปเขียนเองได้ · ส่งซ้ำ = แก้สรุป (เวลาส่งครั้งแรกคงเดิม)
 *   ④ Administrator ตรวจสอบ report ของคนอื่นได้ (ไม่บันทึก) · คนอื่นดูของคนอื่นไม่ได้
 *   ⑤ Ranking วัน/สัปดาห์/เดือน/ไตรมาส/ครึ่งปี/ปี แยก Sale / Sale Support
 *   ⑥ หน้าเว็บจริง (Chromium): desktop + มือถือ · JPG / PDF · การ์ดในหน้ารวมแอป
 *  รัน: node tools/test-perfreport.js   (SHOTS=<โฟลเดอร์> เก็บภาพหน้าจอ)
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path'), fs = require('fs'), http = require('http');
const express = require('express');
const ROOT = path.join(__dirname, '..');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 56335;
process.env.SUPABASE_URL = 'http://127.0.0.1:' + REST_PORT;
process.env.SUPABASE_KEY = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'd'.repeat(64);
const SHOTS = process.env.SHOTS || '';
const LIBS = process.env.LIBS || '';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);

(async () => {
  const S = require('../modules/perfreport/score');
  const M = require('../modules/perfreport/metrics');
  const I = require('../modules/perfreport/index');
  head('① สูตรคะแนน · ช่วงเวลา');
  let d = S.daily('sale', { chat: { replies: 5, avgReplyMin: 4, slaBreaches: 0, leads: 1 }, sales: { quotes: 1, jobCodes: 1 }, money: { followups: 1 }, customer: { visits: 2, prospects: 1 } }, { submitted: true, onTime: true });
  ok(d.score === 100 && d.breakdown.length === 8, 'Sale ทำครบทุกหัวข้อ ส่งตรงเวลา ⇒ 100');
  d = S.daily('sale', { chat: { replies: 3, avgReplyMin: 20, slaBreaches: 2 } }, { submitted: false });
  ok(d.score === 5 && d.breakdown.find(x => x.key === 'neglect').got === 5, 'Sale ไม่ทำอะไร · ลูกค้ารอ 2 ครั้ง · ตอบช้า · ยังไม่ส่ง ⇒ 5');
  d = S.daily('sale', {}, { submitted: true, onTime: false });
  ok(d.breakdown.find(x => x.key === 'speed').got === 10 && d.breakdown.find(x => x.key === 'report').got === 5, 'ไม่มีแชทให้ตอบ = เวลาตอบเต็ม (ไม่ลงโทษ) · ส่งช้า = 5');
  d = S.daily('support', { chat: { replies: 12, avgReplyMin: 10, slaBreaches: 1 }, sales: { quotes: 1 }, work: { bookings: 1 }, money: { followups: 1 }, customer: { tasks: 1 } }, { submitted: true, onTime: true });
  ok(d.score === 15 + 7 + 15 + 15 + 10 + 10 + 5 + 10, 'Sale Support ⇒ ' + d.score);
  {
    const M = require('../modules/perfreport/metrics');
    const P = nk => M.profileOf({ Nickname: nk, Permission: 'Sale' });
    ok(['ส้ม', 'แว่น', 'นวล', 'หนู', 'ภา', 'ใบเตย', 'นี', 'ต้าร์', 'แนน', 'มินท์', 'แก้ม'].every(n => P(n).role === 'support' && P(n).chatScored), 'ส้ม แว่น นวล หนู ภา ใบเตย นี ต้าร์ แนน มินท์ แก้ม = Sale Support วัดการตอบแชท');
    ok(['เปตอง', 'มิ้งค์'].every(n => P(n).role === 'support' && !P(n).chatScored), 'เปตอง มิ้งค์ = Sale Support ไม่วัดแชท');
    ok(['กุ๊งกิ๊ง', 'พลอย'].every(n => M.profileOf({ Nickname: n, Permission: 'Sale Support' }).role === 'sale' && !P(n).chatScored), 'กุ๊งกิ๊ง พลอย = Sale (แม้สิทธิ์ตั้งเป็น Support) ไม่วัดแชท');
    ok(M.profileOf({ Name: '(แก้ม) ทดสอบ', Permission: 'Sale' }).role === 'support' && P('คนอื่น').role === 'sale', 'อ่านชื่อเล่นจาก "(ชื่อเล่น) ชื่อ" ได้ · คนนอกรายชื่อใช้สิทธิ์เดิม');
    ok(['Sale', 'Sales', 'Sale Support'].every(M.isSaleTeam) && !['Sale Freelance', 'After Sale Service', 'ช่างติดตั้ง', 'ช่างนอก', 'Administrator', 'Planning', 'Graphic'].some(M.isSaleTeam), 'รายชื่อเอาแค่ Sale / Sale Support · ไม่เอาช่าง · After Sale Service · Admin');
    ok(M.profileOf({ Nickname: 'ปัท', Name: 'ปัท (Sale Freelance)', Permission: 'Sale' }).team === false && M.profileOf({ Nickname: 'วันวา', Name: 'วันวา', Permission: 'Sale Freelance' }).team === false, 'ตัด Sale Freelance (ปัท · วันวา) ออกจากรายชื่อ');
    ok(M.profileOf({ Nickname: 'ต้าร์', Permission: 'ช่างติดตั้ง' }).team === false, 'ชื่อเล่นซ้ำกับช่าง (ต้าร์) ไม่ถูกดึงเข้ารายชื่อ');
    ok(['Graphic สาขามดงาน', 'กราฟิค สาขามดงาน'].every(p => { const x = M.profileOf({ Nickname: 'ก', Permission: p }); return x.role === 'branch' && x.team && x.chatScored; }) && !M.profileOf({ Permission: 'Graphic' }).team, 'สิทธิ์ "กราฟิค สาขามดงาน" เข้าระบบ report เป็นกลุ่มของตัวเอง (วัดแชท) · Graphic ทั่วไปไม่เข้า');
    { const b = S.daily('branch', { chat: { replies: 12, avgReplyMin: 3 }, sales: { quotes: 1, jobCodes: 1, won: 1 }, money: { receipts: 1 }, work: { projectsDone: 2, jobCards: 3, graphicClaims: 0 } }, { submitted: true, onTime: true });
      ok(b.score === 100 && b.breakdown.reduce((a, x) => a + x.max, 0) === 100 && !b.breakdown.some(x => /visit|prospect/.test(x.key)) && ['projdone', 'jobcard', 'gclaim'].every(k => b.breakdown.some(x => x.key === k)), 'คะแนนกราฟิก สาขา: แชท · ใบเสนอ · ปิดการขาย · จบงาน Projects · Job card ผลิต · ไม่มีเคลมจากกราฟิค = 100');
      const b2 = S.daily('branch', { work: { projectsDone: 1, jobCards: 1, graphicClaims: 1 } }, { submitted: true, onTime: true });
      const g = k => b2.breakdown.find(x => x.key === k).got;
      ok(g('projdone') === 10 && g('jobcard') === 5 && g('gclaim') === 5, 'จบงาน 1 = 10/15 · Job card 1 = 5/10 · เคลมจากกราฟิค 1 งาน หัก 5'); }
    ok(S.result('branch', { closed: 1 }, 1).score === null && S.combine('month', null, 70) === 70, 'กราฟิก สาขา ยังไม่มีเป้ายอด ⇒ ranking ช่วงยาวใช้คะแนนรายวันเฉลี่ย');
    const bad = { chat: { slaBreaches: 9, replies: 3, avgReplyMin: 90 } };
    const sn = S.daily('sale', bad, { submitted: true, onTime: true }, { noChat: true }), pn = S.daily('support', bad, { submitted: true, onTime: true }, { noChat: true });
    ok(!sn.breakdown.some(x => /neglect|speed/.test(x.key)) && sn.breakdown.reduce((a, x) => a + x.max, 0) === 100, 'Sale ไม่วัดแชท: ไม่มีหัวข้อแชท · คะแนนเต็มยัง 100');
    ok(!pn.breakdown.some(x => /neglect|speed|care/.test(x.key)) && pn.breakdown.reduce((a, x) => a + x.max, 0) === 100 && pn.score === 20, 'Support ไม่วัดแชท: ทิ้งแชท/ตอบช้า ไม่หักคะแนน · เต็ม 100');
  }
  ok(S.result('sale', { closed: 1000000 }, 1).score === 50 && S.result('sale', { closed: 2500000 }, 1).score === 100 && S.result('support', { supported: 750000 }, 1).score === 50, 'คะแนนผลลัพธ์เทียบเป้า Sale 2,000,000 / Support 1.5 ล้าน ต่อเดือน (เพดาน 100)');
  ok(S.combine('month', 80, 50) === 68 && S.combine('day', 80, 50) === 50, 'ranking เดือน = 60% ผลลัพธ์ + 40% รายวัน · รายวัน = คะแนนรายวัน');
  const R = I._t.rangeOf;
  ok(JSON.stringify(R('week', '2026-11-04')) === '{"from":"2026-11-02","to":"2026-11-08"}' && JSON.stringify(R('quarter', '2026-11-04')) === '{"from":"2026-10-01","to":"2026-12-31"}'
    && JSON.stringify(R('half', '2026-03-10')) === '{"from":"2026-01-01","to":"2026-06-30"}' && R('month', '2026-02-10').to === '2026-02-28', 'ช่วง สัปดาห์ (จ.–อา.) · เดือน · ไตรมาส · ครึ่งปี');
  const lat = M.latencies([{ conv_id: 'a', at: '2026-11-03T02:00:00Z', sender: 'customer' }, { conv_id: 'a', at: '2026-11-03T02:01:00Z', sender: 'customer' }, { conv_id: 'a', at: '2026-11-03T02:04:00Z', sender: 'agent', username: 'Ann' },
    { conv_id: 'a', at: '2026-11-03T03:00:00Z', sender: 'customer' }, { conv_id: 'a', at: '2026-11-03T03:05:00Z', sender: 'agent', username: 'bob' }], 'ann');
  ok(lat.length === 1 && lat[0] === 4, 'เวลาตอบ: นับจากข้อความลูกค้าแรกที่ยังไม่ได้ตอบ · ไม่นับที่คนอื่นตอบ');

  /* ── ฐานจริง ── */
  const { Client } = require('pg');
  const pg = new Client({ connectionString: PG }); await pg.connect();
  const files = fs.readdirSync(path.join(ROOT, 'sql')).filter(f => /^(01|03|20|23|37|38|49|55|117|120|126|131|132|133|134|135)-/.test(f)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  for (const f of files) { try { await pg.query(fs.readFileSync(path.join(ROOT, 'sql', f), 'utf8')); } catch (e) { /* ลงแล้ว */ } }
  await pg.query(fs.readFileSync(path.join(ROOT, 'sql/135-perf-report.sql'), 'utf8'));
  const wipe = async () => {
    await pg.query(`delete from app.app_users where "Username" like 'zzpr%'`);
    await pg.query(`delete from app.perf_reports where username like 'zzpr%'`);
    for (const [t, c] of [['omni_msg', 'conv_id'], ['omni_event', 'conv_id'], ['omni_conv', 'id'], ['omni_lead_link', 'conv_id'], ['omni_slip', 'sales_user']]) await pg.query(`delete from app.${t} where ${c} like 'zzpr%'`).catch(() => {});
    await pg.query(`delete from app.total_sales where "Sales Code" like 'zzpr%'`).catch(() => {});
    await pg.query(`delete from app.cash_flow where key like 'zzpr%'`).catch(() => {});
    await pg.query(`delete from app.collect_log where job_code like 'zzpr%'`).catch(() => {});
    await pg.query(`delete from app.visit_prospects where id like 'zzpr%'`).catch(() => {});
    await pg.query(`delete from app.visit_events where id like 'zzpr%'`).catch(() => {});
    await pg.query(`delete from app.installation_plan where "ผู้ที่จอง" like 'zzpr%'`).catch(() => {});
    await pg.query(`delete from app.auth_audit where username like 'zzpr%'`).catch(() => {});
    await pg.query(`delete from app.sales_support where support_user like 'zzpr%'`).catch(() => {});
    await pg.query(`delete from app.job_leaves where "Username" like 'zzpr%'`).catch(() => {});
    await pg.query(`delete from app.projects where "ID" like 'zzpr%'`).catch(() => {});
    await pg.query(`delete from app.user_photo where username like 'zzpr%'`).catch(() => {});
    await pg.query(`delete from app.production_jobs where "JobID" like 'zzpr%'`).catch(() => {});
  };
  await wipe();
  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  let srv, br;
  try {
    const now = Date.now(), ago = min => new Date(now - min * 60000).toISOString();
    const today = M.todayTH();
    const U = [['zzpradmin', '(บอส) ผู้ดูแล', 'บอส', 'Administrator'], ['zzprsale1', '(นุ่น) เซลส์หนึ่ง', 'นุ่น', 'Sale'], ['zzprsale2', '(ต้น) เซลส์สอง', 'ต้น', 'Sale'], ['zzprsup1', '(ฝน) ซัพพอร์ตหนึ่ง', 'ฝน', 'Sale support'], ['zzprgr1', '(ฟ้า) กราฟิกสาขา', 'ฟ้าใส', 'Graphic สาขามดงาน']];
    for (const u of U) await pg.query(`insert into app.app_users ("Username","Name","Nickname","Permission","Status") values ($1,$2,$3,$4,'Login')`, u);
    const disp = '(นุ่น) เซลส์หนึ่ง';
    /* Ant-Connect */
    await pg.query(`insert into app.omni_conv (id, account_id, channel, contact_id, status, owner, assigned_to, doc) values ('zzprc1','br1','line','x','open','human','zzprsale1','{}'),('zzprc2','fbpage','facebook','y','open','human','zzprsale1','{}')`);
    const msg = (id, conv, at, sender, un) => pg.query(`insert into app.omni_msg (id, conv_id, at, sender, username, body) values ($1,$2,$3,$4,$5,'x')`, [id, conv, at, sender, un || '']);
    await msg('zzprm1', 'zzprc1', ago(40), 'customer'); await msg('zzprm2', 'zzprc1', ago(36), 'agent', 'zzprsale1');
    await msg('zzprm3', 'zzprc2', ago(30), 'customer'); await msg('zzprm4', 'zzprc2', ago(20), 'agent', 'zzprsale1'); await msg('zzprm5', 'zzprc2', ago(19), 'agent', 'zzprsale1');
    const ev = (id, conv, type, actor, detail) => pg.query(`insert into app.omni_event (id, at, conv_id, type, actor, detail) values ($1, now() - interval '30 minutes', $2,$3,$4,$5)`, [id, conv, type, actor, detail]);
    await ev('zzpre1', 'zzprc1', 'assigned', 'ระบบจ่ายแชท', 'จ่ายให้ ' + disp + ' — รับช่วงต่อเอง');
    await ev('zzpre2', 'zzprc2', 'assigned', disp, 'จ่ายให้ ' + disp);
    await ev('zzpre3', 'zzprc1', 'sla_breach', 'ระบบ', 'ลูกค้ารอเกิน 3 นาที');
    await ev('zzpre4', 'zzprc2', 'closed', disp, 'ปิดการขาย');
    await ev('zzpre5', 'zzprc9', 'assigned', 'ระบบ', 'จ่ายให้ (ต้น) เซลส์สอง');
    await pg.query(`insert into app.omni_lead_link (conv_id, owner, job_code, state) values ('zzprc1','zzprsale1','QW2611/001','linked')`);
    await pg.query(`insert into app.omni_slip (id, conv_id, sales_user, amount, sent_at) values ('zzprs1','zzprc1','zzprsale1',5000, now())`).catch(e => console.log('    slip:', e.message));
    /* คีย์ยอดขาย */
    const ts = (row, created, est, closeDay, pre, src) => pg.query(`insert into app.total_sales (_row, "Sales Code", "Created At", "ยอดประเมินราคา", "วันที่ปิดการขาย", "ยอดขายก่อน VAT", "ลูกค้ามาจากไหน") values ($1,$2,$3,$4,$5,$6,$7)`, [row, 'zzprsale1', created, est, closeDay, pre, src]);
    await ts(990001, ago(60), 50000, null, null, 'Facebook'); await ts(990002, ago(50), null, null, null, 'LINE'); await ts(990003, ago(60 * 24 * 10), 0, today, 120000, 'Facebook');
    await pg.query(`insert into app.total_sales (_row, "Sales Code", "วันที่ปิดการขาย", "ยอดขาย (บาท)") values (990004,'zzprsale2',$1, 107000)`, [today]);
    await pg.query(`insert into app.sales_support (row_no, support_user) values (990003,'zzprsup1')`);
    /* เงิน */
    await pg.query(`insert into app.cash_flow (key, paid_at, sale, amount, cash, days) values ('zzpr1',$1,'นุ่น',30000,29100,25),('zzpr2',$1,'นุ่น',10000,null,15)`, [today]);
    await pg.query(`insert into app.collect_log (at, job_code, by_user, promise) values (now(), 'zzpr1', 'นุ่น', 20000)`);
    /* Visit */
    await pg.query(`insert into app.visit_prospects (id, name, owner, created_by, value) values ('zzprp1','บริษัท ทดสอบ','zzprsale1','zzprsale1',300000)`).catch(async e => { console.log('    prospect:', e.message); });
    for (const [id, k] of [['zzprv1', 'visit'], ['zzprv2', 'visit'], ['zzprv3', 'task']]) await pg.query(`insert into app.visit_events (id, prospect_id, kind, owner, by_user) values ($1,'zzprp1',$2,'zzprsale1','zzprsale1')`, [id, k]);
    /* คิวช่าง · Projects */
    await pg.query(`insert into app.installation_plan (_row, "ผู้ที่จอง", "วันที่จอง") values (990001,'zzprsup1', now())`);
    await pg.query(`insert into app.auth_audit (username, action, target) values ('zzprsup1','project_create','P-zz1')`);
    /* กราฟิก สาขามดงาน: จบงาน Projects 2 · Job card ผลิต 1 · เคลมจากกราฟิค 1 */
    for (const [r, id, d] of [[990101, 'zzprpj1', today], [990102, 'zzprpj2', today], [990103, 'zzprpj3', '2026-01-05']]) await pg.query(`insert into app.projects (_row,"ID","Owner","Status","Complete") values ($1,$2,'ฟ้าใส','Complete',$3)`, [r, id, d]);
    await pg.query(`insert into app.production_jobs ("JobID","CreatedBy","Graphic","JobType") values ('zzprjc1','ฟ้าใส','ฟ้าใส','ติดตั้งใหม่')`);
    await pg.query(`insert into app.production_jobs ("JobID","CreatedBy","Graphic","JobType","ClaimType","ClaimFromJobID") values ('zzprjc2','namna','ฟ้าใส','งานเคลม(กราฟิค-ขาย) = เสียจากกราฟิก/ขาย','กราฟิค-ขาย','zzprjc1')`);

    /* ── แอปทดสอบ ── */
    const auth = require('../core/auth');
    const users = {};
    for (const u of U) users[u[0]] = { username: u[0], name: u[1], nickname: u[2], permission: u[3], role: auth.roleOf(u[3]) };
    const app = express();
    const router = express.Router();
    app.use('/m/perfreport', (req, res, next) => { const u = users[req.get('x-test-user') || (req.headers.cookie || '').replace(/.*tu=([^;]+).*/, '$1')]; if (!u) return res.status(401).json({ ok: false }); req.user = u; next(); }, router);
    router.use(express.static(path.join(ROOT, 'modules/perfreport/public')));
    const audits = [];
    await I.mount(router, { db: require('../core/db'), log: () => {}, warn: m => console.log('    [warn]', m), audit: (u, a, t) => audits.push([u.username, a, t]) });
    app.use('/brand', express.static(path.join(ROOT, 'public/brand')));
    const facePng = await require('sharp')({ create: { width: 200, height: 200, channels: 3, background: { r: 230, g: 40, b: 120 } } }).png().toBuffer();
    app.get('/zz-face.png', (q, s2) => s2.type('png').send(facePng));
    srv = await new Promise(rs => { const x = http.createServer(app); x.listen(0, '127.0.0.1', () => rs(x)); });
    const BASE = 'http://127.0.0.1:' + srv.address().port + '/m/perfreport';
    /* ⏱ Ant-Connect › ลูกค้ารอได้ไม่เกิน 5 นาที (เหมือนที่พี่เอตั้ง) */
    await pg.query(`insert into app.settings (key, value) values ('omnichat_config', $1) on conflict (key) do update set value = jsonb_set(coalesce(app.settings.value, '{}'::jsonb), '{routing,slaFirstResponseSec}', '300')`, [JSON.stringify({ routing: { slaFirstResponseSec: 300 } })]).catch(e => console.log('    sla:', e.message));
    await pg.query(`delete from app.user_photo where username like 'zzpr%'`).catch(() => {});
    await pg.query(`insert into app.user_photo (username, path, url) values ('zzprsale1','avatars/zz.png',$1)`, ['http://127.0.0.1:' + srv.address().port + '/zz-face.png']).catch(e => console.log('    photo:', e.message));
    const call = async (un, p, body) => { const r = await fetch(BASE + '/api/' + p, { method: body ? 'POST' : 'GET', headers: { 'x-test-user': un, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { st: r.status, j: await r.json() }; };

    head('② ตัวเลขจากแอปจริง');
    let r = await call('zzprsale1', 'report?kind=daily&date=' + today);
    const m = r.j.live || {};
    ok(r.st === 200 && r.j.user.role === 'sale' && !r.j.saved, 'เปิด report วันนี้ได้ · บทบาท Sale · ยังไม่ส่ง ' + (r.j.errors || []).join(' | '));
    ok(m.chat.replies === 3 && m.chat.chats === 2 && m.chat.avgReplyMin === 7 && m.chat.replyPairs === 2, 'Ant-Connect: ตอบ 3 ข้อความ 2 แชท · ตอบเฉลี่ย 7 นาที (4 + 10)');
    ok(m.chat.received === 2 && m.chat.closed === 1 && m.chat.slaBreaches === 1 && m.chat.leads === 1, 'รับแชท 2 (ไม่นับของคนอื่น) · ปิดเคส 1 · ลูกค้ารอเกินเวลา 1 · lead 1');
    ok(m.money.slips === 1 && m.money.slipAmount === 5000, 'สลิปในแชท 1 ใบ ฿5,000');
    ok(m.sales.jobCodes === 2 && m.sales.quotes === 1 && m.sales.quoteValue === 50000 && m.sales.won === 1 && m.sales.wonValue === 120000, 'คีย์ยอดขาย: รหัสงานใหม่ 2 · ใบเสนอ 1 (฿50,000) · ปิดการขาย 1 (฿120,000 ก่อน VAT)');
    ok(m.channels.Facebook && m.channels.Facebook.won === 1 && m.channels.Facebook.value === 120000 && m.channels['line · br1'].chats === 1, 'แยกช่องทาง: ปิดการขาย Facebook · แชท LINE สาขา br1');
    ok(m.money.collected === 39100 && m.money.receipts === 2 && m.money.avgCollectDays === 20 && m.money.followups === 1 && m.money.promised === 20000, 'เงินเข้า ฿39,100 (ใช้ยอดรับจริงหลังหักภาษี) · วันเก็บเฉลี่ย 20 · ติดตามหนี้ 1 (จับชื่อเล่น)');
    ok(m.customer.prospects === 1 && m.customer.visits === 2 && m.customer.tasks === 1, 'B2B Visit: ลูกค้าใหม่ 1 · visit 2 · งานติดตาม 1');
    ok(r.j.score === 80 && r.j.breakdown.find(x => x.key === 'neglect').got === 10 && r.j.breakdown.find(x => x.key === 'speed').got === 5, 'คะแนนก่อนส่ง = 80 (ลูกค้ารอ −5 · ตอบเฉลี่ย 7 นาที ได้ 5/10 · ยังไม่ได้ 10 ของการส่ง)');
    let s = await call('zzprsup1', 'report?kind=daily&date=' + today);
    ok(s.j.user.role === 'support' && s.j.live.work.bookings === 1 && s.j.live.work.projects === 1 && s.j.live.sales.supportedWon === 1 && s.j.live.sales.supportedValue === 120000, 'Sale Support: จองคิวช่าง 1 · เปิด Project 1 · งานที่ดูแลปิดแล้ว ฿120,000');

    const gr = await call('zzprgr1', 'report?kind=daily&date=' + today);
    const gw = (gr.j.live || {}).work || {};
    ok(gr.st === 200 && gr.j.user.role === 'branch' && gw.projectsDone === 2 && gw.jobCards === 1 && gw.graphicClaims === 1 && gr.j.breakdown.find(x => x.key === 'gclaim').got === 5, 'กราฟิก สาขามดงาน: จบงาน Projects 2 · Job card ผลิต 1 (ไม่นับการ์ดเคลม) · เคลมจากกราฟิค 1 (หัก 5) ' + (gr.j.errors || []).join(' | '));
    ok(!('projectsDone' in (m.work || {})), 'คนกลุ่มอื่นไม่ยิงฐานส่วนนี้เพิ่ม');

    ok((await fetch(BASE + '/api/photo?user=zzprsale1', { headers: { 'x-test-user': 'zzprsale2' } })).status === 403 && (await fetch(BASE + '/api/photo?user=zzprsale1', { headers: { 'x-test-user': 'zzpradmin' } })).status === 200 && (await fetch(BASE + '/api/photo?user=zzprsale2', { headers: { 'x-test-user': 'zzprsale2' } })).status === 404, 'รูปพนักงาน: ของตัวเอง / Administrator ขอได้ · คนอื่นขอไม่ได้ · ไม่มีรูป = 404');

    { const rs = await call('zzprsale1', 'report?kind=daily&date=' + today);
      const ng = (rs.j.breakdown || []).find(x => x.key === 'neglect'), sp = (rs.j.breakdown || []).find(x => x.key === 'speed');
      ok(rs.j.live.chat.slaMin === 5 && rs.j.live.chat.replyGoalMin === 5 && /ลูกค้ารอได้ไม่เกิน 5 นาที/.test(ng.why) && /เต็มเมื่อ ≤ 5 นาที · ครึ่งเมื่อ ≤ 15 นาที/.test(sp.why),
        '⏱ บอกเกณฑ์: Ant-Connect ตั้ง 5 นาที (300 วินาที) ⇒ ลูกค้ารอได้ไม่เกิน 5 นาที · ตอบเฉลี่ย เต็ม ≤ 5 / ครึ่ง ≤ 15 นาที — ' + ng.why); }

    head('③ ส่ง report');
    r = await call('zzprsale1', 'report/submit', { kind: 'daily', notes: { summary: 'visit ลูกค้า 2 ราย ปิด Facebook ได้ 1 งาน', blockers: 'รอแบบจากกราฟิก', hack: 'x' } });
    const row = (await pg.query(`select * from app.perf_reports where id = $1`, ['zzprsale1|daily|' + today])).rows[0];
    ok(r.st === 200 && row && Number(row.score) >= 85 && row.notes.summary.indexOf('ปิด Facebook') > 0 && !('hack' in row.notes) && row.metrics.chat.replies === 3, 'ส่งแล้ว: บันทึกตัวเลข ณ ตอนส่ง + สรุปที่เขียน (ช่องแปลกไม่รับ) · คะแนน ' + (row && row.score));
    ok(audits.some(a => a[1] === 'perf_report_submit'), 'จดบันทึกระบบว่าใครส่ง');
    const t1 = row.submitted_at;
    await new Promise(z => setTimeout(z, 300));
    r = await call('zzprsale1', 'report/submit', { kind: 'daily', notes: { summary: 'แก้สรุปแล้ว' } });
    const row2 = (await pg.query(`select * from app.perf_reports where id = $1`, ['zzprsale1|daily|' + today])).rows[0];
    ok(row2.notes.summary === 'แก้สรุปแล้ว' && String(row2.submitted_at) === String(t1) && r.j.saved && r.j.saved.notes.summary === 'แก้สรุปแล้ว', 'ส่งซ้ำ = แก้สรุป · เวลาส่งครั้งแรกคงเดิม (เลื่อนเวลาเพื่อให้ "ตรงเวลา" ไม่ได้)');
    r = await call('zzprsale1', 'report/submit', { kind: 'daily', date: '2026-01-01', metrics: { sales: { wonValue: 999999 } }, notes: { summary: 'แก้สรุปแล้ว' } });
    const rows = (await pg.query(`select id, metrics from app.perf_reports where username = 'zzprsale1'`)).rows;
    ok(rows.length === 1 && rows[0].metrics.sales.wonValue === 120000, 'ส่งย้อนวัน / แก้ตัวเลขเอง ไม่ได้ (เซิร์ฟเวอร์ใช้วันนี้ + ตัวเลขจากระบบเสมอ)');
    r = await call('zzprsale1', 'report?kind=daily&date=2099-01-01');
    ok(r.st === 400, 'เปิดวันในอนาคตไม่ได้');
    await call('zzprsup1', 'report/submit', { kind: 'daily', notes: {} });
    r = await call('zzprsale2', 'report/submit', { kind: 'weekly', notes: { plan: 'สัปดาห์หน้า visit 8 ราย' } });
    ok(r.st === 200 && r.j.kind === 'weekly' && r.j.period === M.mondayOf(today) && r.j.saved, 'Weekly report: งวด = วันจันทร์ของสัปดาห์นี้');

    { /* ⏰ v1.0.9 ส่งได้ถึง 24:00 */
      const T = require('../modules/perfreport/index')._t;
      ok(T.dueOk(Date.parse('2026-11-05T23:59:00+07:00'), '2026-11-05') && T.dueOk(Date.parse('2026-11-05T20:51:00+07:00'), '2026-11-05') && !T.dueOk(Date.parse('2026-11-06T00:01:00+07:00'), '2026-11-05'), '⏰ ส่ง 20:51 / 23:59 = ตรงเวลา · 00:01 วันถัดไป = ส่งช้า');
      const bdL = [{ key: 'x', label: 'x', got: 70, max: 90, why: '' }, { key: 'report', label: 'ส่ง Daily report', got: 5, max: 10, why: 'ส่งหลัง 18:00' }];
      await pg.query(`insert into app.perf_reports (id, username, role, kind, period, metrics, score, breakdown, notes, status, submitted_at, on_time, created_by) values
        ('zzprsale2|daily|2026-10-01','zzprsale2','sale','daily','2026-10-01','{}',75,$1,'{}','submitted','2026-10-01T13:51:00Z',false,'zzprsale2'),
        ('zzprsale2|daily|2026-10-02','zzprsale2','sale','daily','2026-10-02','{}',75,$1,'{}','submitted','2026-10-03T03:00:00Z',false,'zzpradmin')`, [JSON.stringify(bdL)]);
      const nFix = await router._repairLate();
      const fx = (await pg.query(`select id, on_time, score::float s from app.perf_reports where id like 'zzprsale2|daily|2026-10-0%' order by id`)).rows;
      ok(nFix >= 1 && fx[0].on_time === true && fx[0].s === 80 && fx[1].on_time === false && fx[1].s === 75, '⏰ report เก่าที่ขึ้น "ส่งช้า" แต่ส่ง 20:51 วันเดียวกัน ⇒ แก้เป็นตรงเวลา คะแนน 75 → 80 · ส่งข้ามวันยังส่งช้า');
      await pg.query(`delete from app.perf_reports where id like 'zzprsale2|daily|2026-10-0%'`);
    }

    head('④ Administrator ตรวจสอบ');
    r = await call('zzpradmin', 'report?kind=daily&date=' + today + '&user=zzprsale1');
    ok(r.st === 200 && r.j.audit === true && r.j.canSubmit === true && r.j.adminCreate === true && r.j.user.username === 'zzprsale1' && r.j.live.chat.replies === 3 && r.j.saved, 'Administrator เปิด report ของเซลส์ได้ · มีปุ่มสร้าง report แทน');
    const n0 = (await pg.query(`select count(*)::int n from app.perf_reports where username like 'zzpr%'`)).rows[0].n;
    await call('zzpradmin', 'report?kind=weekly&date=' + today + '&user=zzprsup1');
    ok((await pg.query(`select count(*)::int n from app.perf_reports where username like 'zzpr%'`)).rows[0].n === n0, 'การตรวจสอบไม่บันทึกอะไร ไม่นับคะแนน');
    r = await call('zzprsale2', 'report?kind=daily&date=' + today + '&user=zzprsale1');
    ok(r.st === 403, 'เซลส์ดู report ของคนอื่นไม่ได้ (403)');
    r = await call('zzpradmin', 'admin/status');
    const st = r.j.users || [];
    ok(r.st === 200 && st.find(u => u.username === 'zzprsale1').submitted && !st.find(u => u.username === 'zzprsale2').submitted && !st.find(u => u.username === 'zzpradmin'), 'หน้าตรวจสอบ: ใครส่ง Daily วันนี้แล้ว (ไม่รวม Administrator)');
    ok((await call('zzprsale1', 'admin/status')).st === 403, 'เซลส์เปิดหน้าตรวจสอบไม่ได้');
    r = await call('zzpradmin', 'report/submit', { kind: 'daily', user: 'zzprsup1', date: '2026-10-15', notes: { summary: 'admin สร้างให้' } });
    const ar = (await pg.query(`select * from app.perf_reports where id = 'zzprsup1|daily|2026-10-15'`)).rows[0];
    ok(r.st === 200 && ar && ar.created_by === 'zzpradmin' && ar.on_time === false && ar.notes.summary === 'admin สร้างให้' && r.j.saved && r.j.audit === true, 'Administrator กดสร้าง report ของ Sale Support ย้อนวันได้ (บันทึกว่าใครสร้าง · ย้อนวัน = ส่งช้า)');
    ok(audits.some(a => a[1] === 'perf_report_admin_create'), 'จดบันทึกระบบว่า admin สร้าง report แทน');
    r = await call('zzpradmin', 'report/submit', { kind: 'daily', user: 'zzprsale1', date: today, notes: { summary: 'แก้สรุปแล้ว', plan: 'admin เติม' } });
    const ar2 = (await pg.query(`select * from app.perf_reports where id = $1`, ['zzprsale1|daily|' + today])).rows[0];
    ok(r.st === 200 && ar2.created_by === 'zzprsale1' && ar2.notes.plan === 'admin เติม' && String(ar2.submitted_at) === String(t1), 'admin แก้ report ที่เจ้าตัวส่งแล้ว: เวลาส่ง/ผู้ส่งเดิมคงไว้');
    ok((await call('zzprsale2', 'report/submit', { kind: 'daily', user: 'zzprsale1', notes: {} })).st === 403 && (await call('zzpradmin', 'report/submit', { kind: 'daily', user: 'zzprsale1', date: '2099-01-01', notes: {} })).st === 400, 'เซลส์สร้างแทนคนอื่นไม่ได้ · admin สร้างวันในอนาคตไม่ได้');

    head('⑤ Ranking');
    r = await call('zzprsale2', 'ranking?period=day');
    const day = r.j.rows || [];
    const a1 = day.find(x => x.username === 'zzprsale1'), a2 = day.find(x => x.username === 'zzprsale2'), a3 = day.find(x => x.username === 'zzprsup1');
    ok(r.st === 200 && a1 && a1.rank === 1 && a2.rank > 1 && a2.score === 0 && a2.submitted === 0 && a3.role === 'support' && a3.rank === 1, 'รายวัน: แยก Sale / Sale Support · คนไม่ส่ง = 0');
    for (const p of ['week', 'month', 'quarter', 'half', 'year']) {
      r = await call('zzprsale1', 'ranking?period=' + p);
      const x = (r.j.rows || []).find(y => y.username === 'zzprsale1'), y2 = (r.j.rows || []).find(y => y.username === 'zzprsale2'), y3 = (r.j.rows || []).find(y => y.username === 'zzprsup1');
      const long = p !== 'week';
      ok(r.st === 200 && x && (long ? x.result > 0 && y2.result > 0 && y3.result > 0 && x.score === S.combine(p, x.result, x.daily) : x.result === null), p + ': ' + (long ? 'ผลลัพธ์ ' + x.result + ' · รายวันเฉลี่ย ' + x.daily + ' ⇒ ' + x.score + ' (ซัพพอร์ตได้ยอดจากงานที่ดูแล)' : 'คะแนนรายวันเฉลี่ย ' + x.daily));
    }

    head('⑥ หน้าเว็บจริง');
    const { chromium } = require('playwright');
    br = await chromium.launch();
    const ctxB = async (vp, un) => { const c = await br.newContext({ viewport: vp, acceptDownloads: true }); await c.addCookies([{ name: 'tu', value: un, url: BASE }]);
      await c.route(/cdnjs\.cloudflare\.com/, route => { const u = route.request().url(); const f = /html2canvas/.test(u) ? path.join(LIBS, 'h2c/package/dist/html2canvas.min.js') : path.join(LIBS, 'jsp/package/dist/jspdf.umd.min.js');
        if (!LIBS || !fs.existsSync(f)) return route.abort(); route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(f) }); });
      return c; };
    const c1 = await ctxB({ width: 1360, height: 900 }, 'zzprsale1');
    const p1 = await c1.newPage(); const errs = []; p1.on('pageerror', e => errs.push(e.message));
    await p1.goto(BASE + '/'); await p1.waitForSelector('.ring');
    ok(await p1.locator('.stat').count() >= 15 && /7/.test(await p1.locator('.stat', { hasText: 'เวลาตอบเฉลี่ย' }).innerText()), 'desktop: report ของฉัน — ตัวเลขทุกหมวด');
    ok(/แก้สรุปแล้ว/.test(await p1.locator('#n-summary').inputValue()) && await p1.locator('[data-act=submit]').count() === 1, 'สรุปที่เขียนไว้กลับมา · ปุ่มบันทึกการแก้ไข');
    if (SHOTS) await p1.screenshot({ path: path.join(SHOTS, 'pr-desktop-report.png'), fullPage: true });
    { const vt = await p1.locator('#view-mine').innerText(); ok(/ลูกค้ารอได้ไม่เกิน 5 นาที/.test(vt) && /เป้า ≤ 5 นาที/.test(vt), '⏱ หน้าจอ: ช่องลูกค้ารอเกินเวลา ขึ้น "ลูกค้ารอได้ไม่เกิน 5 นาที" · ช่องเวลาตอบเฉลี่ย ขึ้น "เป้า ≤ 5 นาที"'); }
    if (LIBS) {
      await p1.click('[data-act=jpg]');
      await p1.waitForSelector('#shOv #shText', { timeout: 10000 });
      const shTxt = await p1.locator('#sheetHost .sheet').innerText({ timeout: 10000 });
      ok(/^data:image\/png/.test(await p1.locator('#sheetHost .sheet img.ph').getAttribute('src')), 'JPG / PDF มีรูปพนักงาน (ส่งผ่านเซิร์ฟเวอร์เดียวกัน วาดลงภาพได้)');
      ok(['คะแนนแยกหัวข้อ', 'visit / นัดลูกค้าใหม่', 'ส่ง Daily report', 'แชท', 'Ant-Connect', 'สร้าง lead จากแชท', 'การขาย', 'คีย์ยอดขาย', 'เงิน', 'วันเก็บเงินเฉลี่ย', 'สลิปในแชท', 'ลูกค้าใหม่', 'B2B Visit', 'งานติดตาม', 'งานต่อ', 'จองคิวช่าง', 'แยกช่องทาง', 'Facebook', 'สรุปวันนี้', 'แผนพรุ่งนี้'].every(t => shTxt.indexOf(t) >= 0), 'JPG / PDF ใส่ครบทุกหัวข้อ: คะแนนแยกหัวข้อ · แชท · การขาย · เงิน · ลูกค้าใหม่ · งานต่อ · ช่องทาง · สรุป 5 ช่อง');
      /* 💬 ข้อความส่ง LINE */
      const stx = await p1.locator('#shText').inputValue();
      ok(/^📊 Daily Report/.test(stx) && /👤 เซลส์หนึ่ง \(นุ่น\)/.test(stx) && /🏷 Permission: Sale/.test(stx) && /⭐ คะแนน \d+ \/ 100/.test(stx) && /🤖 อลิซวิเคราะห์/.test(stx) && /💡 แนะนำการปรับวิธีทำงาน\n1\. /.test(stx),
        '💬 ข้อความ LINE: ชื่อ-นามสกุล (ชื่อเล่น) · Permission · คะแนน · อลิซวิเคราะห์ · คำแนะนำ');
      ok(/🎯 (ทำอย่างไรให้ได้ 100 คะแนน \(ขาดอีก [\d.]+ คะแนน\)\n• \+[\d.]+ คะแนน — |ได้คะแนนเต็ม 100 แล้ว)/.test(stx) && stx.indexOf('🎯') < stx.indexOf('📅'), '🎯 บอกวิธีให้ได้ 100: ขาดกี่คะแนน · ทำอะไรเพิ่มทีละหัวข้อ — ' + (stx.split('🎯')[1] || '').split('\n').slice(0, 3).join(' | '));
      ok(/📅 แผนการทำงานพรุ่งนี้\nadmin เติม/.test(stx) && stx.indexOf('📅') < stx.indexOf('(ภาพ Report'), '📅 ดึงแผนพรุ่งนี้มาต่อท้ายข้อความ ก่อนภาพ');
      if (SHOTS) await p1.locator('.sh-box').screenshot({ path: path.join(SHOTS, 'pr-share.png') });
      await p1.waitForSelector('#shSend:not([disabled])', { timeout: 20000 });
      await p1.waitForSelector('#shCimg:not([disabled])', { timeout: 20000 });
      ok(await p1.locator('.sh-box [data-act=sh-line]').count() === 0 && !/แชร์ภาพเข้า LINE|เปิด LINE/.test(await p1.locator('.sh-box').innerText()) && /คัดลอกภาพ/.test(await p1.locator('#shCimg').innerText()),
        '🖥 คอม: ตัดปุ่ม "แชร์ภาพเข้า LINE" + "เปิด LINE เลือกกลุ่ม" แล้ว · เหลือ ① คัดลอกข้อความ ② คัดลอกภาพ');
      await p1.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
      await p1.click('#shCimg'); await p1.waitForTimeout(400);
      const clipT = await p1.evaluate(async () => { try { const it = await navigator.clipboard.read(); return it.map(x => x.types.join(',')).join('|'); } catch (e) { return 'ERR ' + e.message; } });
      ok(/image\/png/.test(clipT), '🖼 กด "คัดลอกภาพ" ⇒ ภาพอยู่ในคลิปบอร์ด (วางใน LINE ด้วย Ctrl+V) — ' + clipT);
      if (SHOTS) await p1.locator('.sh-box').screenshot({ path: path.join(SHOTS, 'pr-share.png') });
      const [dl] = await Promise.all([p1.waitForEvent('download', { timeout: 20000 }), p1.click('#shSend')]);
      await p1.click('[data-act=sh-close]');
      const fp = path.join(require('os').tmpdir(), 'pr-test.jpg'); await dl.saveAs(fp);
      const md = await require('sharp')(fp).metadata();
      ok(/\.jpg$/.test(dl.suggestedFilename()) && md.format === 'jpeg' && md.width === 1080, 'ดาวน์โหลด JPG กว้าง 1080 px (' + dl.suggestedFilename() + ')');
      if (SHOTS) fs.copyFileSync(fp, path.join(SHOTS, 'pr-sheet.jpg'));
      const [dl2] = await Promise.all([p1.waitForEvent('download', { timeout: 20000 }), p1.click('[data-act=pdf]')]);
      ok(/\.pdf$/.test(dl2.suggestedFilename()), 'ดาวน์โหลด PDF');
    }
    await p1.click('[data-tab=rank]'); await p1.waitForSelector('.podium');
    ok(await p1.locator('.list li').count() >= 2 && await p1.locator('.list li.me').count() === 1, 'Ranking: กระดานอันดับ · แถวของฉันเน้นสี');
    await p1.click('[data-period=month]'); await p1.waitForSelector('.list .bars');
    if (SHOTS) await p1.screenshot({ path: path.join(SHOTS, 'pr-desktop-rank.png'), fullPage: true });
    ok(await p1.locator('#tabAudit').isHidden(), 'เซลส์ไม่เห็นแท็บตรวจสอบ');
    const c2 = await ctxB({ width: 390, height: 844 }, 'zzpradmin');
    const p2 = await c2.newPage(); p2.on('pageerror', e => errs.push(e.message));
    await p2.goto(BASE + '/'); await p2.waitForSelector('.ring');
    await p2.click('[data-tab=audit]'); await p2.waitForSelector('.who-item');
    await p2.click('.who-item[data-pick=zzprsale1]'); await p2.waitForSelector('#view-audit .audit');
    ok(/Administrator/.test(await p2.locator('#view-audit .audit').innerText()) && await p2.locator('#auditHead [data-act=asubmit]').count() === 1 && /สร้าง/.test(await p2.locator('.who-item:not(.on) .chip.make').first().innerText()) && await p2.locator('.who-item.on').count() === 1, 'มือถือ · Administrator: ปุ่ม "＋ สร้าง" บนการ์ดรายชื่อ · ปุ่มสร้าง Report อยู่ด้านบน report');
    const sw = await p2.evaluate(() => document.documentElement.scrollWidth);
    ok(sw <= 390, 'มือถือไม่ล้นจอด้านข้าง (' + sw + ' px)');
    if (SHOTS) await p2.screenshot({ path: path.join(SHOTS, 'pr-mobile-audit.png'), fullPage: false });
    if (SHOTS) { const c3 = await ctxB({ width: 1400, height: 900 }, 'zzpradmin'); const p3 = await c3.newPage(); await p3.goto(BASE + '/'); await p3.waitForSelector('.ring'); await p3.click('[data-tab=audit]'); await p3.waitForSelector('.who-item');
      await p3.screenshot({ path: path.join(SHOTS, 'pr-desk-audit-list.png') }); await p3.click('.who-item[data-pick=zzprsale2]'); await p3.waitForSelector('#auditHead'); await p3.waitForTimeout(700);
      await p3.screenshot({ path: path.join(SHOTS, 'pr-desk-audit-open.png') }); await c3.close(); }
    if (SHOTS) { await p2.waitForTimeout(600); await p2.screenshot({ path: path.join(SHOTS, 'pr-audit-head.png') }); await p2.locator('#view-audit .actions').screenshot({ path: path.join(SHOTS, 'pr-audit-btn.png') }); }
    await p2.click('[data-tab=rank]'); await p2.waitForSelector('.podium');
    if (SHOTS) await p2.screenshot({ path: path.join(SHOTS, 'pr-mobile-rank.png'), fullPage: false });
    await p2.click('[data-role=branch]'); await p2.waitForTimeout(200);
    ok(await p2.locator('[data-role=branch].on').count() === 1, 'มือถือ · Ranking มีกลุ่ม "กราฟิก สาขา"');
    if (SHOTS) await p2.screenshot({ path: path.join(SHOTS, 'pr-mobile-branch.png'), fullPage: false });
    ok(!errs.length, 'ไม่มี error ในหน้าเว็บ ' + errs.join(' | '));

    head('การ์ดในหน้ารวมแอป · ไฟล์');
    const mj = JSON.parse(fs.readFileSync(path.join(ROOT, 'modules/perfreport/module.json'), 'utf8'));
    ok(mj.key === 'perfreport' && !mj.hideInHub && mj.status === 'ready' && mj.minRoleSee === 'VIEWER', 'module.json: การ์ดขึ้นหน้ารวมแอป (CRM Hub)');
    const reg = require('../core/registry');
    const list = (reg.list ? reg.list() : reg.all ? reg.all() : []) || [];
    ok(!list.length || list.some(x => x.key === 'perfreport'), 'registry เห็นโมดูลใหม่');
    const pubSrc = fs.readFileSync(path.join(ROOT, 'modules/perfreport/public/app.css'), 'utf8') + fs.readFileSync(path.join(ROOT, 'modules/perfreport/public/index.html'), 'utf8');
    ok(!/font-family/.test(pubSrc) && /\/brand\/font\.css/.test(pubSrc), 'ใช้ฟอนต์กลาง /brand/font.css (ไม่พิมพ์ font-family เอง)');
    const V = require('../modules/perfreport/version');
    ok(V.VERSION === '1.0.13', 'เวอร์ชัน 1.0.13');
    ok(require('../modules/perfreport/module.json').order > require('../modules/sales/module.json').order && require('../modules/perfreport/module.json').order < 1.5, 'การ์ดอยู่ถัดจากคีย์ยอดขาย');
  } catch (e) { fail++; console.log('  ❌ ล้ม: ' + (e && e.stack || e)); }
  finally {
    try { br && await br.close(); } catch (e) { /* ข้าม */ }
    try { srv && srv.close(); } catch (e) { /* ข้าม */ }
    try { await wipe(); } catch (e) { /* ข้าม */ }
    try { await rest.close(); } catch (e) { /* ข้าม */ }
    await pg.end().catch(() => {});
  }
  console.log('\n' + (fail ? '❌' : '✅') + ' ผ่าน ' + pass + ' · ไม่ผ่าน ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
