'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  tools/test-mgmt.js — รอบ 220 · แอป Management Report (สุขภาพองค์กรหน้าเดียว)
 *
 *  พี่เอสั่ง 3 ต.ค. 69:
 *    "มาทำ app Management Report … Dash board ที่มีสรุปจบทุกอย่างในหน้าเดียว เพื่อตรวจสอบสุขภาพองค์กร"
 *    "คนที่เปิดดูได้มีแค่ permission : administrator เท่านั้น"
 *    "เกณฑ์ เขียว เหลือง แดง ดูที่ Cash flow และแนวโน้มยอดขายที่เพิ่มขึ้น หรือลดลงเป็นหลัก"
 *
 *   ① เกณฑ์สี: สีรวม = ตัวที่แย่กว่าระหว่าง Cashflow กับ แนวโน้มยอดขาย · ด้านอื่นเปลี่ยนสีรวมไม่ได้
 *   ② ช่วงเวลา: เดือนที่ยังไม่จบเทียบ "ช่วงวันเดียวกัน" ของเดือนก่อน · ต้นเดือนไม่ตัดสินจากตัวเลขที่ยังน้อย
 *   ③ ค่าตั้ง: รับเฉพาะคีย์ที่รู้จัก ค่าผิดรูปถอยไปค่าตั้งต้น
 *   ④ 🔒 สิทธิ์: administrator เท่านั้น ทั้งที่ตารางสิทธิ์และที่เส้น /api ของแอปเอง
 *   ⑤ 🔴 อ่านอย่างเดียว: ตัวรวบรวมไม่มีคำสั่งเขียนฐาน · ไม่เรียก PEAK · ไม่ require index.js ของแอปอื่น
 *   ⑥ หน้าเว็บ: ฟอนต์กลาง · โลโก้กลาง · ปุ่มกลับหน้ารวมแอป · ไม่ฝังเลขเวอร์ชัน/ตัวเลขตัวอย่าง
 *   ⑦ ตัวเลขจากฐานจริง (ถ้าต่อฐานเทสต์ได้): ยอดขาย/งานเข้า/ลูกค้าใหม่ ตรงกับ SQL ที่คิดแยกอีกทาง
 * ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const noComment = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1 ');

(async () => {
  console.log('\n🧪 แอป Management Report\n');
  const H = require('../modules/mgmt/health');
  const C = require('../modules/mgmt/config');
  const perms = require('../core/app-perms');

  /* ─────────────────────────────────────────────────────────────── */
  console.log('━━ ① เกณฑ์ เขียว/เหลือง/แดง — Cashflow และแนวโน้มยอดขายเป็นหลัก');
  const win = { full: true, days: 30, daysInMonth: 30 };
  const cashOf = (net3, lastNet, fNet, firstNeg) => ({ ok: true, hasExp: true, dso: 20,
    done3: { months: ['ก.ค. 69', 'ส.ค. 69', 'ก.ย. 69'], net: net3, cashIn: 1000, cashOut: 1000 - net3, last: { net: lastNet } },
    fc15: { net: fNet, firstNeg: firstNeg || null }, ap: { overdue: 0 } });
  const salesOf = (trendPct, pacePct, w) => ({ ok: true, win: w || win, total: { lead: 100, cnt: 30, rate: 30, prevRate: 28, amt: 1000, nw: 10, days: 5 }, newAmtPct: 40,
    trend: { trendPct, pacePct, avg3: 100, prev3: 90, m3: ['ก.ค. 69', 'ส.ค. 69', 'ก.ย. 69'] }, ch: [], ads: { rows: [{ key: 'fb', name: 'Facebook', used: 100, nwAmt: 500, roas: 5 }], roas: { good: 4, warn: 3 } } });
  const good = { ar: { ok: true, total: 100, overduePct: 10, over90: 0 },
    ops: { ok: true, projects: { ok: true, active: 100, overdue: 2, urgent: 1 }, production: { ok: true, onTimePct: 95, whOverdue: 0, open: 5, waiting: [] },
           install: { ok: true, total: 10, finished: 10, finishRate: 100, lossJobs: 0 }, delivery: { ok: true, total: 10, delivered: 10, overdue: 0, successPct: 100 }, aftersale: { ok: true, open: 3, overdue: 0 }, lead: { ok: true, avg: 7 } },
    stock: { ok: true, counts: { ok: true, value: 1000, lowStock: 0 }, analytics: { ok: true, slowValue: 10, slowN: 1 } } };
  const bad = { ar: { ok: true, total: 100, overduePct: 90, over90: 50, topOld: [] },
    ops: { ok: true, projects: { ok: true, active: 100, overdue: 90, urgent: 9 }, production: { ok: true, onTimePct: 10, whOverdue: 9, open: 5, waiting: [] },
           install: { ok: true, total: 10, finished: 1, finishRate: 10, lossJobs: 5 }, delivery: { ok: true, total: 10, delivered: 1, overdue: 9, successPct: 10 }, aftersale: { ok: true, open: 3, overdue: 3 }, lead: { ok: true, avg: 7 } },
    stock: { ok: true, counts: { ok: true, value: 1000, lowStock: 9 }, analytics: { ok: true, slowValue: 900, slowN: 9 } } };
  const cfg = C.merge(null);
  const B = (cash, sales, rest) => H.build(Object.assign({ cash, sales }, rest || good), cfg);

  let h = B(cashOf(500, 100, 50), salesOf(8, 5));
  ok(h.color === 'good' && h.score === 100, 'Cashflow เขียว + ยอดขายโต + ด้านอื่นเขียวหมด ⇒ สีรวมเขียว คะแนน 100 (ได้ ' + h.color + ' ' + h.score + ')');
  ok(h.tiles[0].key === 'cash' && h.tiles[0].primary && h.tiles[1].key === 'trend' && h.tiles[1].primary && h.tiles.filter(t => t.primary).length === 2,
     '‼ ตัวหลักมี 2 ตัวเท่านั้น: Cashflow · แนวโน้มยอดขาย (เรียงเป็นสองช่องแรก)');
  ok(h.tiles.length === 12, 'รวม 12 ด้าน (ตัวหลัก 2 + ตัวประกอบ 10) — ได้ ' + h.tiles.length);

  h = B(cashOf(500, 100, 50), salesOf(8, 5), bad);
  ok(h.color === 'good', '‼ ด้านอื่นแดงทุกด้าน แต่ Cashflow + ยอดขายเขียว ⇒ สีรวมยัง "เขียว" (ด้านอื่นเป็นตัวประกอบ)');
  {
    const sup = h.tiles.filter(t => !t.primary && t.s !== 'na'), avg = sup.reduce((a, t) => a + H.PT[t.s], 0) / sup.length;
    ok(h.score === Math.round(40 + 40 + 0.2 * avg) && h.score < 100 && h.score >= 80, '   แต่คะแนนลดลง = 40 + 40 + 20% ของค่าเฉลี่ยด้านอื่น (ได้ ' + h.score + ' · ไม่ต่ำกว่า 80 เพราะตัวหลักเขียวทั้งคู่)');
  }
  ok(h.count.crit >= 5, '   และไฟแดงของด้านอื่นยังขึ้นให้เห็นครบ (' + h.count.crit + ' ช่อง)');

  h = B(cashOf(-300, -100, -50), salesOf(8, 5));
  ok(h.color === 'crit' && h.tiles[0].s === 'crit', '‼ เงินสดสุทธิ 3 เดือนติดลบ ⇒ Cashflow แดง ⇒ สีรวมแดง แม้ยอดขายโตและด้านอื่นเขียว');
  h = B(cashOf(500, -100, 50), salesOf(8, 5));
  ok(h.color === 'warn' && h.tiles[0].s === 'warn', 'Cashflow ไม่ผ่าน 1 ข้อ (เดือนล่าสุดติดลบ) ⇒ เหลือง ⇒ สีรวมเหลือง');
  h = B(cashOf(500, 100, -50, '2026-10-09'), salesOf(8, 5));
  ok(h.tiles[0].s === 'warn', 'Cashflow: 15 วันข้างหน้าจะติดลบ ⇒ เหลือง');
  h = B(cashOf(500, -100, -50), salesOf(8, 5));
  ok(h.tiles[0].s === 'crit', 'Cashflow ไม่ผ่าน 2 ข้อ ⇒ แดง');

  h = B(cashOf(500, 100, 50), salesOf(-12, 5));
  ok(h.color === 'crit' && h.tiles[1].s === 'crit', '‼ ยอดขายเฉลี่ย 3 เดือนลดถึง −10% ⇒ แนวโน้มยอดขายแดง ⇒ สีรวมแดง');
  h = B(cashOf(500, 100, 50), salesOf(-4, 5));
  ok(h.color === 'warn' && h.tiles[1].s === 'warn', 'ยอดขายเฉลี่ยลดเล็กน้อย (−4%) แต่เดือนนี้ไม่ตก ⇒ เหลือง');
  h = B(cashOf(500, 100, 50), salesOf(-4, -15));
  ok(h.tiles[1].s === 'crit', 'ยอดขายลดต่อเนื่อง (เฉลี่ย −4% และเดือนนี้ −15%) ⇒ แดง');
  h = B(cashOf(500, 100, 50), salesOf(3, -15));
  ok(h.tiles[1].s === 'warn', 'เฉลี่ย 3 เดือนยังโต แต่เดือนนี้ตก −15% ⇒ เหลือง (ยังไม่แดง)');
  h = B(cashOf(500, 100, 50), salesOf(0, 0));
  ok(h.tiles[1].s === 'good', 'ยอดขายทรงตัว (0%) ⇒ เขียว ตามเกณฑ์ "ไม่ลดลง"');

  console.log('\n━━ ② ต้นเดือน / ข้อมูลไม่มี — ไม่เดาสี');
  const early = { full: false, days: 3, daysInMonth: 31 };
  h = B(cashOf(500, 100, 50), salesOf(3, -60, early));
  ok(h.tiles[1].s === 'good' && /ยังไม่นำมาคิด/.test(h.tiles[1].w), '‼ เดือนเพิ่งเริ่ม 3 วัน: ยอด −60% เทียบช่วงเดียวกัน "ไม่ถูกนำมาตัดสิน" แนวโน้มยอดขาย');
  ok(h.tiles.find(t => t.key === 'close').s === 'na' && h.tiles.find(t => t.key === 'ads').s === 'na', '   ปิดการขาย · โฆษณา = "ประเมินไม่ได้" จนกว่าจะผ่าน 7 วัน');
  h = B(cashOf(500, 100, 50), salesOf(3, -60, { full: false, days: 9, daysInMonth: 31 }));
  ok(h.tiles[1].s === 'warn', '   ผ่านไป 9 วันแล้ว ⇒ เริ่มนำเดือนนี้มาคิด (เหลือง)');
  h = B({ ok: false, err: 'ฐานล่ม' }, salesOf(8, 5));
  ok(h.tiles[0].s === 'na' && h.color === 'good' && /ฐานล่ม/.test(h.tiles[0].w), 'อ่าน Cash Flow ไม่ได้ ⇒ ช่อง Cashflow = "ประเมินไม่ได้" พร้อมเหตุ (สีรวมมาจากตัวที่ประเมินได้)');
  h = B({ ok: false, err: 'x' }, { ok: false, err: 'y' }, { ar: { ok: false }, ops: { ok: false }, stock: { ok: false } });
  ok(h.color === 'na' && h.score === null && h.count.na === 12, '‼ อ่านอะไรไม่ได้เลย ⇒ สีรวม "ประเมินไม่ได้" คะแนนว่าง — ไม่ขึ้นเขียวหลอก');
  h = B(Object.assign(cashOf(500, 100, 50), { hasExp: false }), salesOf(8, 5));
  ok(h.tiles[0].s === 'na' && /รายจ่าย/.test(h.tiles[0].w), 'ยังไม่มีข้อมูลรายจ่ายจาก PEAK ⇒ Cashflow ประเมินไม่ได้ (ไม่ถือว่าจ่ายออก 0)');
  h = B(cashOf(500, 100, 50), Object.assign(salesOf(8, 5), { trend: { trendPct: null } }));
  ok(h.tiles[1].s === 'na', 'ยอดขายย้อนหลังไม่ครบ 6 เดือน ⇒ แนวโน้มประเมินไม่ได้');

  /* ─────────────────────────────────────────────────────────────── */
  console.log('\n━━ ③ ช่วงเวลา');
  const D = require('../modules/mgmt/data');
  let w = D.winOf('2026-09', '2026-10-03');
  ok(w.full && w.from === '2026-09-01' && w.to === '2026-09-30' && w.prevFrom === '2026-08-01' && w.prevTo === '2026-08-31', 'เดือนที่จบแล้ว: ทั้งเดือน เทียบ ทั้งเดือนก่อน');
  w = D.winOf('2026-10', '2026-10-03');
  ok(!w.full && w.to === '2026-10-03' && w.prevTo === '2026-09-03' && w.days === 3, '‼ เดือนที่ยังไม่จบ: 1–3 ต.ค. เทียบ 1–3 ก.ย. (ช่วงเดียวกัน ไม่ใช่ทั้งเดือน)');
  w = D.winOf('2026-03', '2026-03-31');
  ok(w.prevTo === '2026-02-28', 'วันที่ 31 มี.ค. เทียบ 28 ก.พ. (เดือนก่อนสั้นกว่า ไม่ล้นไปเดือนถัดไป)');
  w = D.winOf('2099-01', '2026-10-03');
  ok(w.ym === '2026-10', 'ขอเดือนอนาคต ⇒ ได้เดือนปัจจุบัน');
  w = D.winOf("2026-09'; drop table x;--", '2026-10-03');
  ok(w.ym === '2026-10', 'ค่าเดือนผิดรูปแบบ ⇒ ได้เดือนปัจจุบัน (ไม่ส่งต่อค่าดิบ)');
  w = D.winOf('2020-01', '2026-10-03');
  ok(w.ym === '2025-11', 'ย้อนได้ไม่เกิน 12 เดือน');
  const mo = D.monthOptions('2026-10-03');
  ok(mo.length === 12 && mo[0].ym === '2026-10' && mo[11].ym === '2025-11', 'ตัวเลือกเดือน 12 เดือนล่าสุด ใหม่สุดอยู่บน');
  const t = D._t;
  ok(t.ymd('2026-10-03') === '2026-10-03' && t.ymd('3/10/2569') === '2026-10-03' && t.ymd('2569-10-03') === '2026-10-03' && t.ymd('') === '' && t.ymd('abc') === '',
     'อ่านวันที่: ค.ศ. · d/m/พ.ศ. · พ.ศ. แบบ ISO · ค่าว่าง/ขยะ = ว่าง (ไม่เดา)');
  ok(t.thDay('2026-09-30T18:30:00Z') === '2026-10-01', '‼ เวลา 01:30 น. ไทย นับเป็นวันของไทย (ไม่ตกไปวันก่อนหน้าแบบ UTC)');
  const b = t.blank(), W = D.winOf('2026-09', '2026-10-03');
  t.addRow(b, { c: '2026-09-02', d: '2026-09-10', st: 'won', amt: 1000, isNew: true }, W);
  t.addRow(b, { c: '2026-08-25', d: '2026-09-05', st: 'won', amt: 500, isNew: false }, W);
  t.addRow(b, { c: '2026-09-20', d: '', st: 'lost', amt: 0 }, W);
  t.addRow(b, { c: '2026-09-21', d: '', st: 'open', amt: 0 }, W);
  t.addRow(b, { c: '2026-08-03', d: '2026-08-09', st: 'won', amt: 700, isNew: true }, W);
  const f = t.fin(b);
  ok(f.lead === 3 && f.cnt === 2 && f.amt === 1500 && f.won === 1 && f.lost === 1 && f.open === 1, 'นับงานเข้าตาม "วันที่ติดต่อ" · ยอดขายตาม "วันที่ปิด" (งานติดต่อ ส.ค. ปิด ก.ย. = ยอดของ ก.ย.)');
  ok(f.nw === 1 && f.nwAmt === 1000 && f.prevAmt === 700 && f.prevCnt === 1 && f.prevLead === 2, 'ลูกค้าใหม่ · ช่วงก่อน แยกถูก');
  ok(f.rate === 66.7 && f.diffPct === 114.3 && f.days === 9.5, 'อัตราปิด = ปิดได้ ÷ งานเข้า · % เทียบช่วงก่อน · วันปิดเฉลี่ย');

  /* ─────────────────────────────────────────────────────────────── */
  console.log('\n━━ ④ ค่าตั้ง (งบโฆษณา / เกณฑ์)');
  const d0 = C.merge(null);
  ok(d0.ads.length === 4 && d0.ads.map(a => a.budget).join(',') === '75000,75000,150000,50000',
     '‼ งบตั้งต้นตามที่พี่เอให้: 101printhouse 75,000 · the101 75,000 · Facebook 150,000 · TikTok 50,000');
  ok(d0.ads.reduce((s, a) => s + a.budget, 0) === 350000, '   รวม 350,000 บาทต่อเดือน');
  const m1 = C.merge({ ads: [{ key: 'fb', budget: '200000', name: '<b>FB</b>' }, { key: 'hack', budget: 1, group: 'web' }, { key: 'tiktok', budget: -5 }], roas: { good: '5', warn: 'x' }, evil: { a: 1 } });
  ok(m1.ads.length === 4 && m1.ads[2].budget === 200000 && m1.ads[3].budget === 50000, 'แก้งบได้ · คีย์แปลก/งบติดลบไม่ถูกรับ (ถอยไปค่าตั้งต้น)');
  ok(m1.ads[2].name === 'bFB/b' && m1.ads[2].group === 'fb', 'ชื่อถูกล้างเครื่องหมาย < > · กลุ่มช่องทางแก้จากข้างนอกไม่ได้');
  ok(m1.roas.good === 5 && m1.roas.warn === 3 && m1.evil === undefined, 'เกณฑ์รับเฉพาะตัวเลข · คีย์ที่ไม่รู้จักถูกทิ้ง');
  ok(C.merge({ ads: [{ key: 'web101print', match: [' LINE@ 101 Print ', '', 'x'.repeat(99)] }] }).ads[0].match.join('|') === 'line@101print|' + 'x'.repeat(40), 'คำที่ใช้จับชื่อช่อง: ตัดเว้นวรรค ตัวพิมพ์เล็ก จำกัดความยาว');

  /* ─────────────────────────────────────────────────────────────── */
  console.log('\n━━ ⑤ 🔒 สิทธิ์ — administrator เท่านั้น');
  ok(perms.KNOWN_APPS.indexOf('mgmt') >= 0, "'mgmt' อยู่ในทะเบียนแอป (KNOWN_APPS)");
  ok(perms.isAdminOnlyApp('mgmt'), "‼ 'mgmt' อยู่ใน ADMIN_PERM_ONLY_APPS");
  for (const p of ['Administrator', 'administrator', ' ADMIN ', 'ผู้ดูแลระบบ'])
    ok(perms.allows(p, 'mgmt') === true, `  permission "${p}" เปิดได้`);
  for (const p of ['Sale', 'Sale support', 'Accounting', 'Planning', 'กราฟิค', 'xadmin', 'adminx', '*', '', null])
    ok(perms.allows(p, 'mgmt') === false, `🔴 permission "${p}" เปิดไม่ได้`);
  ok(perms.appsFor('Sale') === perms.ALL_APPS ? true : perms.appsFor('Sale').indexOf('mgmt') < 0, '   กลุ่มที่เคยได้ "ทุกแอป" ไม่ได้แอปนี้ไปด้วย');
  const mj = JSON.parse(read('modules/mgmt/module.json'));
  ok(mj.status === 'ready' && mj.minRoleSee === 'ADMIN' && mj.minRoleUse === 'ADMIN', 'module.json: พร้อมใช้ · ต้องเป็นผู้ดูแลทั้งเห็นและใช้');
  ok(!mj.publicPaths && !mj.hideInHub, '‼ ไม่มีเส้นทางสาธารณะ · มีการ์ดในหน้ารวมแอป');
  ok(['#c026d3', '#eab308'].indexOf(String(mj.color).toLowerCase()) < 0, 'สีการ์ดไม่ชนกับแอปแชท/ลางาน');
  const M = require('../modules/mgmt/index');
  ok(M.isAdminPerm({ permission: 'Administrator', role: 'ADMIN' }) === true, 'ด่านของแอปเอง: Administrator ผ่าน');
  ok(M.isAdminPerm({ permission: 'xadmin', role: 'ADMIN' }) === false, "🔴 ด่านของแอปเอง: permission 'xadmin' (role ถูกเดาเป็น ADMIN) ไม่ผ่าน — ไม่เทียบจาก role");
  ok(M.isAdminPerm({ permission: 'Sale', role: 'OFFICER' }) === false && M.isAdminPerm(null) === false, '   Sale / ไม่มีผู้ใช้ ไม่ผ่าน');
  /* เส้น /api ทุกเส้นอยู่หลังด่าน */
  {
    const express = require('express');
    const mk = user => { const app = express(); app.use(express.json()); const r = express.Router(); app.use((q, _s, n) => { q.user = user; n(); });
      app.use('/m/mgmt', r); return M.mount(r, { log() {}, warn() {}, audit() {}, auth: {} }).then(() => new Promise(res => { const s = app.listen(0, () => res(s)); })); };
    const s1 = await mk({ username: 'zsale', permission: 'Sale', role: 'OFFICER' });
    const base = 'http://127.0.0.1:' + s1.address().port + '/m/mgmt/api';
    for (const u of ['/meta', '/part/sales', '/part/cash', '/part/ar', '/part/ops', '/part/stock', '/part/health', '/config', '/_diag', '/ledger/last']) {
      const r = await fetch(base + u); const j = await r.json();
      ok(r.status === 403 && j.code === 'ADMIN_ONLY' && Object.keys(j).length === 3, `🔴 Sale ยิง ${u} ⇒ 403 ไม่มีตัวเลขติดไป`);
    }
    const r2 = await fetch(base + '/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"config":{}}' });
    ok(r2.status === 403, '🔴 Sale บันทึกค่าตั้งไม่ได้ (403)');
    s1.close();
    const s2 = await mk({ username: 'boss', permission: 'Administrator', role: 'ADMIN', nickname: 'บอส' });
    const b2 = 'http://127.0.0.1:' + s2.address().port + '/m/mgmt/api';
    const r3 = await fetch(b2 + '/meta'), j3 = await r3.json();
    ok(r3.status === 200 && j3.ok && j3.version === require('../modules/mgmt/version').VERSION && j3.months.length === 12, 'Administrator เปิด /meta ได้ · เลขเวอร์ชันมาจาก version.js');
    ok(/no-store/.test(r3.headers.get('cache-control') || ''), '‼ คำตอบห้ามถูกเก็บในแคชของเบราว์เซอร์/ตัวกลาง (no-store)');
    const r4 = await fetch(b2 + '/part/nope');
    ok(r4.status === 404, 'ขอก้อนที่ไม่มี ⇒ 404');
    s2.close();
  }

  /* ─────────────────────────────────────────────────────────────── */
  console.log('\n━━ ⑥ 🔴 อ่านอย่างเดียว');
  const dataSrc = noComment(read('modules/mgmt/data.js'));
  ok(!/\.(insert|update|upsert|remove)\s*\(/.test(dataSrc) && !/db\.rest\s*\(/.test(dataSrc), '‼ data.js ไม่มีคำสั่งเขียนฐานข้อมูลสักคำ (insert/update/upsert/remove/rest)');
  ok(!/require\(['"][^'"]*core\/peak['"]\)/.test(dataSrc) && !/peak-sync|peakpo|checkRow|\.walk\(|\.tick\(|\.start\(|\.ensure\(|\.restore\(/.test(dataSrc),
     '‼ ไม่เรียก PEAK และไม่ปลุกตัวซิงก์ใด ๆ (อ่านเฉพาะตารางที่ซิงก์มาแล้ว)');
  const reqs = (dataSrc.match(/require\(['"][^'"]+['"]\)/g) || []).map(x => x.slice(9, -2));
  ok(reqs.every(r => !/^\.\.\/[a-z0-9]+$/.test(r) && !/\/index(\.js)?$/.test(r)), '‼ ไม่ require index.js ของแอปอื่น (ที่ลงทะเบียนเส้นทาง/ตั้งเวลาอัตโนมัติตอนโหลด) — ' + reqs.filter(r => r.startsWith('../') && !r.startsWith('../../')).length + ' ไฟล์ย่อย');
  ok(!/getDeliveryPlans|logFollowUp|getClaimCosts\b|verifyStockBalance|recalculateAll/.test(dataSrc), '‼ ไม่เรียกฟังก์ชันของแอปอื่นที่มีผลเขียนฐาน (getDeliveryPlans · logFollowUp · getClaimCosts · verifyStockBalance)');
  const hSrc = noComment(read('modules/mgmt/health.js'));
  ok(!/require\(/.test(hSrc), 'health.js เป็นฟังก์ชันล้วน ไม่ require อะไรเลย');
  const cSrc = noComment(read('modules/mgmt/config.js'));
  ok((cSrc.match(/\.upsert\(/g) || []).length === 1 && /upsert\('settings'/.test(cSrc) && !/\.(insert|update|remove)\s*\(/.test(cSrc), 'จุดเขียนฐานเดียวของทั้งแอป = บันทึกค่าตั้งลง app.settings');
  ok(/MGMT_CACHE_MS \|\| 600000/.test(read('modules/mgmt/data.js')), 'จำผล 10 นาที (ไม่ยิงฐานทุกครั้งที่เปิดหน้า)');

  /* ─────────────────────────────────────────────────────────────── */
  console.log('\n━━ ⑦ หน้าเว็บ');
  const html = read('modules/mgmt/public/index.html');
  ok(/<link[^>]+brand\/font\.css/.test(html) && html.indexOf('logo-badge.js') > 0 && html.indexOf('logo-badge.js') < html.indexOf('</head>'), 'ฟอนต์กลาง + โลโก้กลาง อยู่ใน <head>');
  ok(/href\s*=\s*["']\/["']/.test(html) && /หน้ารวมแอป/.test(html), 'มีปุ่มกลับหน้ารวมแอป');
  ok(![...html.matchAll(/font-family\s*:\s*([^;}]+)/g)].some(m => !/var\(--font-|inherit/.test(m[1])), 'ไม่พิมพ์ชื่อฟอนต์เอง (ใช้ var(--font-app) ทั้งหน้า)');
  ok(!/>\s*v\d+\.\d+\.\d+\s*</.test(html) && !/['"]v?\d+\.\d+\.\d+['"]/.test(html.replace(/viewBox="[^"]*"/g, '')), '‼ ไม่ฝังเลขเวอร์ชันในหน้า — มาจาก /api/meta');
  ok(!/const D\s*=\s*\{/.test(html) && !/ตัวเลขตัวอย่าง|ลูกค้าตัวอย่าง/.test(html), '‼ ไม่มีชุดข้อมูลตัวอย่างฝังอยู่ในหน้า (ของภาพตัวอย่างรอบ 219)');
  ok(!/localStorage|sessionStorage/.test(html), 'ไม่เก็บตัวเลขไว้ในเบราว์เซอร์');
  ok(/const esc\s*=/.test(html) && !/innerHTML\s*=\s*[^;]*\b(d|x|r|c|p)\.name\b(?![^;]*esc)/.test(html), 'ชื่อจากฐาน (ลูกค้า · ผู้ขาย · ช่องทาง) ผ่านตัวกันอักขระก่อนขึ้นจอ');
  const V = require('../modules/mgmt/version');
  ok(/^\d+\.\d+\.\d+$/.test(V.VERSION) && V.CHANGELOG.length >= 1 && V.CHANGELOG[0][0] === V.VERSION, 'version.js: เลข ' + V.VERSION + ' ตรงกับประวัติบรรทัดบน');
  const sql = read('sql/109-mgmt-report.sql');
  ok(/array_append\(apps, 'mgmt'\)/.test(sql) && /perm_key = 'administrator'/.test(sql) && /on conflict \(key\) do nothing/.test(sql) && !/drop |delete /i.test(sql.replace(/--[^\n]*/g, '')),
     'sql/109: ติ๊กแอปให้กลุ่ม administrator + ค่าตั้งต้น · รันซ้ำได้ · ไม่ลบอะไร');

  /* ─────────────────────────────────────────────────────────────── */
  console.log('\n━━ ⑧ ตัวเลขจากฐานจริง เทียบกับ SQL ที่คิดแยกอีกทาง');
  const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:55432/postgres';
  let pg = null;
  try { const { Client } = require('pg'); pg = new Client({ connectionString: PG, connectionTimeoutMillis: 2500 }); await pg.connect(); await pg.query('select 1 from app.total_sales limit 1'); }
  catch (e) { pg = null; console.log('  ⏭  ข้าม — ต่อฐานเทสต์ไม่ได้หรือยังไม่มีตาราง (' + String(e.message).slice(0, 80) + ')'); }
  if (pg) {
    const fake = await require('./fake-postgrest').start(PG, 0).catch(() => null);
    const port = fake && fake.srv && fake.srv.address() ? fake.srv.address().port : 0;
    if (!port) console.log('  ⏭  ข้าม — เปิดตัวจำลอง PostgREST ไม่ได้');
    else {
      process.env.SUPABASE_URL = 'http://127.0.0.1:' + port; process.env.SUPABASE_KEY = 'test-key'; process.env.SUPABASE_SCHEMA = 'app';
      const TD = require('../core/thai-date');
      const cur = TD.todayTH().slice(0, 7), ym = D._t.addMonth(cur, -1), from = ym + '-01', to = ym + '-' + String(D._t.lastDay(ym)).padStart(2, '0');
      const base = (await pg.query('select coalesce(max(_row), 0) m from app.total_sales')).rows[0].m + 900000;
      const rows = [
        [1, from, ym + '-05', 'ปิดการขาย', 12000, 'ลูกค้าใหม่', 'Online', 'LINE@101printhouse'],
        [2, from, ym + '-07', 'ปิดการขาย', 8000, 'ลูกค้าเก่า', 'Online', 'FB/ทดสอบ'],
        [3, ym + '-03', null, 'ไม่ซื้อ', null, 'ลูกค้าใหม่', 'Online', 'TIKTOK ทดสอบ'],
        [4, ym + '-04', ym + '-09', 'ปิดการขาย', 50000, 'ลูกค้าเก่า', 'B2B', 'B2B ทดสอบ'],
        [5, ym + '-06', null, 'Onprocess', null, 'ลูกค้าใหม่', 'สาขา', 'สาขาทดสอบ'],
      ];
      try {
        for (const r of rows)
          await pg.query('insert into app.total_sales (_row,"วันที่ติดต่อ","วันที่ปิดการขาย","Lead Status","ยอดขาย (บาท)","ประเภทลูกค้า","ลูกค้ามาจากไหน","ชื่อช่อง / Platform","รหัสงาน") values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [base + r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], 'ZZMGMT' + r[0]]);
        D.dropAll();
        const S = await D.salesPart(ym, C.merge(null));
        const q = async s => (await pg.query(s, [from, to])).rows[0];
        const e1 = await q(`select coalesce(sum("ยอดขาย (บาท)"),0)::float8 amt, count(*)::int cnt, count(*) filter (where "ประเภทลูกค้า" like '%ใหม่%')::int nw from app.total_sales where "Lead Status" like '%ปิดการขาย%' and coalesce("วันที่ปิดการขาย","วันที่ติดต่อ") between $1 and $2`);
        const e2 = await q(`select count(*)::int lead, count(*) filter (where "Lead Status" like '%ไม่ซื้อ%')::int lost from app.total_sales where "วันที่ติดต่อ" between $1 and $2`);
        ok(S.ok && Math.abs(S.total.amt - e1.amt) < 0.01 && S.total.cnt === e1.cnt, `ยอดขายที่ปิดได้ของ ${ym} ตรงกับ SQL (${S.total.amt} = ${e1.amt} · ${S.total.cnt} งาน)`);
        ok(S.total.lead === e2.lead && S.total.lost === e2.lost && S.total.nw === e1.nw, `งานเข้า ${S.total.lead} · ไม่ซื้อ ${S.total.lost} · ลูกค้าใหม่ ${S.total.nw} ตรงกับ SQL`);
        const sum = k => S.ch.reduce((a, c) => a + c[k], 0);
        ok(Math.abs(sum('amt') - S.total.amt) < 0.01 && sum('lead') === S.total.lead && sum('cnt') === S.total.cnt, '‼ 5 ช่องทางรวมกัน = ยอดรวมเป๊ะ (ไม่มีแถวตกหล่นหรือนับซ้ำ)');
        const onl = S.ch.find(c => c.n === 'Online'), og = k => S.onl.reduce((a, c) => a + c[k], 0);
        ok(Math.abs(og('amt') - onl.amt) < 0.01 && og('lead') === onl.lead, '‼ กลุ่ม Online 6 กลุ่มรวมกัน = ช่องทาง Online เป๊ะ');
        ok(S.sales[S.sales.length - 1] === S.total.amt && S.ms[S.ms.length - 1] === ym && S.sales.length === 12, 'กราฟ 12 เดือน: แท่งสุดท้าย = ยอดของเดือนที่ดู');
        const a101 = S.ads.rows.find(a => a.key === 'web101print'), afb = S.ads.rows.find(a => a.key === 'fb');
        ok(a101.lead >= 1 && a101.nwAmt >= 12000 && afb.lead >= 1 && afb.nwAmt === S.onl.find(g => g.key === 'fb').nwAmt, 'งบโฆษณา: LINE@101printhouse เข้าเว็บ 101printhouse · Facebook = ยอดลูกค้าใหม่ของกลุ่ม fb');
        ok(a101.used === 75000 && S.ads.prorated === false, 'เดือนที่จบแล้วเทียบกับงบเต็มเดือน');
        const S2 = await D.salesPart(cur, C.merge(null));
        ok(S2.ads.prorated === true && S2.ads.rows[0].used === Math.round(75000 * S2.win.days / S2.win.daysInMonth), '‼ เดือนที่ยังไม่จบเทียบกับงบตามจำนวนวันที่ผ่านมา (ไม่เอางบเต็มเดือนไปหารยอด 3 วัน)');
      } finally {
        await pg.query("delete from app.total_sales where \"รหัสงาน\" like 'ZZMGMT%'");
        D.dropAll();
      }
    }
    if (fake && fake.close) await fake.close().catch(() => {});
    await pg.end();
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log((fail ? '❌' : '✅') + ' ผ่าน ' + pass + ' · ไม่ผ่าน ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('❌ เทสต์ล้ม:', e); process.exit(1); });
