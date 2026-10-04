'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  💵 Cash Flow ใหม่ — ตัวจัดข้อมูลให้หน้าจอ (รอบ 235 · 4 ต.ค. 69)
 *
 *  🔴 พี่เอสั่ง (คำต่อคำ):
 *    "เดี๋ยวรื้อ code cash flow ใหม่หมดเลยนะ เขียนขึ้นมาใหม่ ทำให้ดูง่าย เห็นสรุปภาพรวม
 *     เจาะลงรายละเอียดได้ ไม่ใช่มาอะไรเยอะแยะไปหมดแบบนี้ไม่ดู เสียเวลา"
 *    "พี่ต้องการเห็นยอดเงินในบัญชี ทุกบัญชี ที่เข้าและออกด้วยนะ"
 *   ที่พี่เอเลือกไว้: หน้าแรก = เข้า·ออก·สุทธิรายเดือน + ยอดเงินในบัญชี + ลูกหนี้/คาดว่าจะเข้า + แยกตามบริษัท
 *                  เจาะลง = เดือน → หมวด → เอกสาร · ตัวเลขยึด PEAK อย่างเดียว · เครื่องมือเดิมย้ายไปหน้าผู้ดูแล
 *
 *  ── ที่มาของตัวเลข ────────────────────────────────────────────────
 *   สมุดเงินสดที่ตัวดึงเบื้องหลังเก็บไว้ในฐาน (core/peak-cashbook.js · sql/113) — ไฟล์นี้ "ไม่ยิง PEAK" และ "ไม่คิดเงินใหม่"
 *   ทำแค่ 3 อย่าง: ① รวมเดือน/รวมบริษัท ② จัดรหัสบัญชีเข้า "หมวด" ที่อ่านง่าย ③ แยกเงินรับจากลูกค้าตามช่องทางขาย
 *   ‼ ยอดรวมทุกบริษัท "ตัดรายการที่ 2 บริษัทจ่ายกันเอง" ออก (ไม่งั้นเงินก้อนเดียวถูกนับทั้งเข้าและออก) — บอกยอดที่ตัดไว้บนจอเสมอ
 *
 *  🔒 อ่านอย่างเดียว · สิทธิ์ = ผู้ดูแลระบบ (ด่านเดียวกับเมนู Cash Flow เดิม — ตรวจที่ modules/sales/index.js)
 *  ยาม: tools/test-cashbook.js
 * ═══════════════════════════════════════════════════════════════════ */
const CB = require('../../core/peak-cashbook');
const peak = require('../../core/peak');
const db = require('../../core/db');

const clean = s => String(s == null ? '' : s).trim();
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const TH_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const ymLabel = ym => TH_M[+ym.slice(5, 7) - 1] + ' ' + String((+ym.slice(0, 4) + 543) % 100).padStart(2, '0');

/* ═══════════════════════════════════════════════════════════════════
 *  หมวด — จัดจาก "รหัสบัญชีคู่" ตามผังบัญชีของ PEAK (2 หลักแรก: 11/12 สินทรัพย์ · 21/22 หนี้สิน · 3 ทุน · 4 รายได้ · 5 ค่าใช้จ่าย)
 *   ลำดับในรายการ = กฎที่เจาะจงกว่ามาก่อน
 * ═══════════════════════════════════════════════════════════════════ */
const OUT_GROUPS = [
  ['cogs',   'ต้นทุนขาย / ผลิต',                          /^(51|114)/],
  ['sell',   'ค่าใช้จ่ายในการขาย',                        /^52/],
  ['admin',  'ค่าใช้จ่ายในการบริหาร',                     /^53/],
  ['fin',    'ดอกเบี้ย / ค่าธรรมเนียมกู้ยืม',              /^58/],
  ['oexp',   'ค่าใช้จ่ายอื่น',                             /^54/],
  ['adv',    'คืนเงินสำรองจ่าย (พนักงาน/กรรมการออกเงินไปก่อน)', /^212203/],
  ['loan',   'ชำระเงินกู้ / เช่าซื้อ',                      /^(211|213|2122|212307|212308|22)/],
  ['ap',     'จ่ายเจ้าหนี้การค้า (ไม่พบบิลต้นทาง)',        /^(212101|212102)/],
  ['refund', 'คืนเงิน / ลดหนี้ให้ลูกค้า',                  /^(4|1131|21210[3-6])/],
  ['accr',   'จ่ายค่าใช้จ่ายค้างจ่าย / เจ้าหนี้อื่น',       /^(2123|2124|216|2141)/],
  ['tax',    'ภาษี / ประกันสังคม',                         /^(215|59|1154)/],
  ['pre',    'จ่ายล่วงหน้า / มัดจำ / เงินประกัน',          /^(1151|1152|1153)/],
  ['asset',  'ซื้อทรัพย์สิน / ลงทุน',                       /^(12|1122)/],
  ['lend',   'ให้กู้ยืม / ลูกหนี้อื่น',                     /^(1132|1133)/],
  ['equity', 'จ่ายคืนทุน / เงินปันผล',                     /^3/],
];
const IN_GROUPS = [
  ['cust',   'รับชำระจากลูกค้า',                           /^(1131|41|21210[3-6])/],
  ['oinc',   'รายได้อื่น / ดอกเบี้ยรับ',                    /^42/],
  ['loan',   'เงินกู้ / เงินจากกรรมการ',                    /^(211|213|2122|22)/],
  ['equity', 'เงินทุน',                                    /^3/],
  ['tax',    'คืนภาษี',                                    /^(215|1154)/],
  ['back',   'รับคืน / ลดค่าใช้จ่าย',                       /^(5|115|1132|1133|12|212|216)/],
];
const UNK = ['unk', 'ยังจัดหมวดไม่ได้'];
function groupOf(side, code) {
  const c = String(code || '');
  const L = side === 'in' ? IN_GROUPS : OUT_GROUPS;
  for (const g of L) if (c && g[2].test(c)) return g;
  return UNK;
}
const GROUP_ORDER = side => (side === 'in' ? IN_GROUPS : OUT_GROUPS).map(g => g[0]).concat(['unk']);

/* ═══════════════════════════════════════════════════════════════════
 *  ช่องทางขายของเงินรับจากลูกค้า — เลขบิล (#IV-…) บนบรรทัดธนาคาร → แถวในตารางขาย → ช่องทาง
 *   สูตรช่องทาง + ตัวอ่านเลขบิลในช่อง "เลขที่ QO / IV" = ตัวเดียวกับการ์ดรับเงินจริง (cash-received.js) ไม่เขียนซ้ำ
 *   หาไม่เจอ = "ไม่พบเลขบิลในตารางขาย" (ไม่เดา) · จำไว้ 5 นาที แล้วคิดใหม่เบื้องหลัง (หน้าไม่ต้องรอ)
 * ═══════════════════════════════════════════════════════════════════ */
const CH_NONE = 'ไม่พบเลขบิลในตารางขาย';
const IX_FRESH = 5 * 60000, IX_STALE = 60 * 60000;
let _ix = { at: 0, map: null, p: null, n: 0 };
async function buildIvIndex() {
  const CR = require('./cash-received');
  const rows = await db.selectAll('total_sales', { select: '"_row","เลขที่ QO / IV","ลูกค้ามาจากไหน","ชื่อช่อง / Platform"', order: '_row.asc' });
  const map = new Map();
  (rows || []).forEach(r => {
    const refs = CR._t.ivRefsOf(r['เลขที่ QO / IV']);
    if (!refs.length) return;
    const ch = CR._t.channelOf(r['ลูกค้ามาจากไหน'], r['ชื่อช่อง / Platform']);
    refs.forEach(k => { if (!map.has(k)) map.set(k, ch); });
  });
  _ix = { at: Date.now(), map, p: null, n: map.size };
  return map;
}
async function ivIndex() {
  const age = Date.now() - _ix.at;
  if (_ix.map && age < IX_FRESH) return _ix.map;
  if (_ix.map && age < IX_STALE) {
    if (!_ix.p) _ix.p = buildIvIndex().catch(() => { _ix.p = null; });
    return _ix.map;
  }
  if (!_ix.p) _ix.p = buildIvIndex().catch(e => { _ix.p = null; throw e; });
  try { return (await _ix.p) || _ix.map || new Map(); } catch (e) { return _ix.map || new Map(); }
}
const normRef = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
function channelOfDoc(d, ix) {
  if (!d.ref || !/^IV/i.test(d.ref)) return CH_NONE;
  return ix.get(normRef(d.ref)) || CH_NONE;
}

/* ═══════════════════════════════════════════════════════════════════
 *  หมวดของเดือน — คิดจากเอกสาร (เพื่อให้ "หมวด" กับ "เอกสารในหมวด" มาจากตัวคิดเดียวกันเสมอ)
 *   combined = true ⇒ ไม่นับเอกสารระหว่าง 2 บริษัท (ic)
 * ═══════════════════════════════════════════════════════════════════ */
function catKeyOf(side, d, c, ix) {
  const g = groupOf(side, c.a);
  if (side === 'in' && g[0] === 'cust') { const ch = channelOfDoc(d, ix); return { k: 'ch:' + ch, name: ch === CH_NONE ? 'ลูกค้า — ' + CH_NONE : 'ลูกค้า — ช่องทาง ' + ch, g: 'cust', ch }; }
  return { k: g[0], name: g[1], g: g[0] };
}
function catsOf(side, books, ix, combined) {
  const bag = {};
  let total = 0, ic = 0, icN = 0;
  books.forEach(B => (B.docs || []).forEach(d => {
    if (d.k !== side) return;
    if (combined && d.ic) { ic += d.amt; icN++; return; }
    total += d.amt;
    (d.cats || []).forEach(c => {
      const K = catKeyOf(side, d, c, ix);
      const x = (bag[K.k] = bag[K.k] || { k: K.k, name: K.name, g: K.g, amt: 0, n: 0, _docs: new Set() });
      x.amt += c.amt; x._docs.add(B.biz + '|' + d.j);
    });
  }));
  const order = GROUP_ORDER(side);
  const list = Object.keys(bag).map(k => ({ k, name: bag[k].name, g: bag[k].g, amt: r2(bag[k].amt), n: bag[k]._docs.size,
    pct: total > 0 ? Math.round(bag[k].amt / total * 1000) / 10 : 0 }))
    .sort((a, b) => b.amt - a.amt || order.indexOf(a.g) - order.indexOf(b.g));
  return { list, total: r2(total), ic: r2(ic), icN };
}

/* เอกสารของ 1 กิจการ 1 เดือน — จำไว้ในหน่วยความจำ (ไม่เกิน 12 ก้อน) · กุญแจมีเวลาที่คิดสรุป ⇒ ตัวดึงคิดใหม่เมื่อไหร่ อ่านใหม่เอง */
const _bk = new Map();
async function bookCached(biz, ym, builtAt) {
  const k = biz + '|' + ym, hit = _bk.get(k);
  /* รู้เวลาที่คิดสรุปล่าสุด (หน้าแรกรู้จากหัวตาราง) ⇒ เทียบตรง ๆ · ไม่รู้ (ตอนกดดูเอกสารต่อจากหน้าแรก) ⇒ ใช้ของที่เพิ่งอ่านไม่เกิน 1 นาที */
  if (hit && ((builtAt && hit.at === builtAt) || (!builtAt && Date.now() - hit.t < 60000))) { _bk.delete(k); _bk.set(k, hit); return hit.B; }
  const B = await CB.book(biz, ym);
  if (B) { _bk.delete(k); _bk.set(k, { at: B.built_at, t: Date.now(), B }); while (_bk.size > 12) _bk.delete(_bk.keys().next().value); }
  return B;
}

/* ═══════════════════════════════════════════════════════════════════
 *  หน้าแรก + เดือนที่เลือก (คำขอเดียว)
 *   q.biz   ''=รวมทุกบริษัท | ชื่อกิจการ      q.ym  เดือนที่เลือก (ไม่ส่ง = เดือนล่าสุดที่มีข้อมูล)      q.months 3–24 (ตั้งต้น 12)
 * ═══════════════════════════════════════════════════════════════════ */
async function overview(user, q) {
  const o = q || {};
  const all = peak.bizAll();
  const biz = all.indexOf(clean(o.biz)) >= 0 ? clean(o.biz) : '';
  const N = Math.max(3, Math.min(24, parseInt(o.months, 10) || 12));
  const cur = CB.ymNow(), from = CB.ymAdd(cur, -(N - 1));
  let st;
  try { st = await CB.status(); } catch (e) { st = { ok: false, err: String(e.message || e), biz: [] }; }
  if (st.needSql) return { ok: true, needSql: true, sqlFile: CB.SQL_FILE, bizList: all, biz, months: [], sync: st };

  const H = await CB.heads({ from, to: cur });
  const mine = H.filter(h => !biz || h.biz === biz);
  const combined = !biz;
  const want = biz ? [biz] : all;
  const months = CB.ymList(from, cur).map(ym => {
    const rows = mine.filter(h => h.ym === ym && h.head && h.head.v === CB.HEAD_V);
    const S = k => rows.reduce((s, h) => s + (Number(h.head[k]) || 0), 0);
    const icIn = combined ? S('icIn') : 0, icOut = combined ? S('icOut') : 0;
    const inn = r2(S('in') - icIn), out = r2(S('out') - icOut);
    return { ym, label: ymLabel(ym), has: rows.length, need: want.length, missing: want.filter(b => !rows.some(h => h.biz === b)),
             in: inn, out, net: r2(inn - out), beg: r2(S('beg')), end: r2(S('end')),
             ok: rows.length === want.length && rows.every(h => h.ok), cats: rows.length === want.length && rows.every(h => h.head.verify && h.head.verify.cats),
             cur: ym === cur };
  });
  const withData = months.filter(m => m.has);
  let ym = CB.ymOk(o.ym) && months.some(m => m.ym === o.ym) ? o.ym : '';
  if (!ym) ym = withData.length ? withData[withData.length - 1].ym : cur;

  /* เดือนที่เลือก — บัญชี + หมวด (อ่านเอกสารของเดือนนั้น 1–2 แถว · จำไว้ตามเวลาที่คิดสรุป ⇒ สลับแท็บ/เดือนไปมาไม่อ่านซ้ำ) */
  const books = [];
  for (const b of want) {
    const hd = H.find(h => h.biz === b && h.ym === ym);
    const B = hd ? await bookCached(b, ym, hd.built_at).catch(() => null) : null;
    if (B && B.head && B.head.v === CB.HEAD_V) books.push(B);
  }
  const ix = books.length ? await ivIndex() : new Map();
  const IN = catsOf('in', books, ix, combined), OUT = catsOf('out', books, ix, combined);
  const accounts = [];
  books.forEach(B => (B.head.accounts || []).forEach(a => accounts.push(Object.assign({ biz: B.biz }, a))));
  const m = months.find(x => x.ym === ym) || {};
  const issues = [];
  books.forEach(B => ((B.head.verify && B.head.verify.issues) || []).forEach(t => issues.push(B.biz + ': ' + t)));
  const sel = {
    ym, label: ymLabel(ym), cur: ym === cur,
    in: IN.total, out: OUT.total, net: r2(IN.total - OUT.total),
    beg: r2(books.reduce((s, B) => s + B.head.beg, 0)), end: r2(books.reduce((s, B) => s + B.head.end, 0)),
    xfer: r2(books.reduce((s, B) => s + B.head.xfer, 0)),
    ic: combined ? { in: IN.ic, out: OUT.ic, nIn: IN.icN, nOut: OUT.icN } : null,
    n: { in: books.reduce((s, B) => s + B.head.n.in, 0) - IN.icN, out: books.reduce((s, B) => s + B.head.n.out, 0) - OUT.icN },
    accounts, inCats: IN.list, outCats: OUT.list,
    ok: !!m.ok, catsOk: !!m.cats, missing: m.missing || [], issues,
    builtAt: books.map(B => B.built_at).sort()[0] || null,
  };
  return { ok: true, biz, bizList: all, ym, from, to: cur, months, sel, sync: st };
}

/* ═══════════════════════════════════════════════════════════════════
 *  เอกสาร (ชั้นล่างสุดของการเจาะลง)
 *   แบบหมวด:  q.side = in|out + q.cat (คีย์หมวดจาก overview)      แบบบัญชี: q.acct (+ q.sub) + q.abiz
 *   แบบพิเศษ: q.side = x (โอนระหว่างบัญชี) · q.cat = ic (ระหว่าง 2 บริษัท)
 * ═══════════════════════════════════════════════════════════════════ */
const DOC_MAX = 3000;
async function docs(user, q) {
  const o = q || {};
  const all = peak.bizAll();
  const biz = all.indexOf(clean(o.biz)) >= 0 ? clean(o.biz) : '';
  const ym = clean(o.ym);
  if (!CB.ymOk(ym)) return { ok: false, error: 'ไม่ได้ระบุเดือน' };
  const side = ['in', 'out', 'x'].indexOf(clean(o.side)) >= 0 ? clean(o.side) : '';
  const cat = clean(o.cat), acct = clean(o.acct), sub = clean(o.sub), abiz = clean(o.abiz);
  const combined = !biz;
  const want = acct && abiz ? [abiz].filter(b => all.indexOf(b) >= 0) : (biz ? [biz] : all);
  const books = [];
  for (const b of want) { const B = await bookCached(b, ym, '').catch(() => null); if (B && B.head) books.push(B); }
  const ix = await ivIndex();
  const rows = [];
  const nameBy = {};
  books.forEach(B => {
    const acctName = {}; (B.head.accounts || []).forEach(a => { acctName[a.code] = a.name; (a.subs || []).forEach(s => { acctName[a.code + '|' + s.code] = s.name || a.name; }); });
    const catName = {}; (B.head.inCats || []).concat(B.head.outCats || []).forEach(c => { catName[c.a] = c.name; });
    Object.assign(nameBy, catName);
    (B.docs || []).forEach(d => {
      const accTxt = (d.acc || []).map(a => acctName[a.c + '|' + a.s] || acctName[a.c] || a.c).filter((v, i, A) => A.indexOf(v) === i).join(' · ');
      const base = { biz: B.biz, d: d.d, j: d.j, cp: d.cp || '', ref: d.ref || '', k: d.k, full: d.amt, ic: d.ic ? 1 : 0, via: d.via || '', q: d.q ? 1 : 0, acct: accTxt };
      if (acct) {                                   /* สมุดของบัญชีนั้น: ทุกบรรทัด เข้า/ออก (รวมโอนระหว่างบัญชี) */
        (d.acc || []).forEach(a => {
          if (a.c !== acct || (sub && a.s !== sub)) return;
          rows.push(Object.assign({}, base, { in: a.dr, out: a.cr, amt: r2(a.dr - a.cr),
            cat: d.k === 'x' ? 'โอนระหว่างบัญชีของบริษัท' : (d.cats || []).map(c => catName[c.a] || c.a).join(' · ') }));
        });
        return;
      }
      if (side === 'x') { if (d.k === 'x') rows.push(Object.assign({}, base, { amt: d.amt, cat: 'โอนระหว่างบัญชีของบริษัท' })); return; }
      if (d.k !== side) return;
      if (cat === 'ic') { if (d.ic) rows.push(Object.assign({}, base, { amt: d.amt, cat: (d.cats || []).map(c => catName[c.a] || c.a).join(' · ') })); return; }
      if (combined && d.ic) return;
      let amt = 0; const part = [];
      (d.cats || []).forEach(c => {
        const K = catKeyOf(side, d, c, ix);
        if (!cat || K.k === cat) { amt += c.amt; part.push(catName[c.a] || c.a || 'ยังไม่พบบัญชีคู่'); }
      });
      if (!part.length) return;
      rows.push(Object.assign({}, base, { amt: r2(amt), cat: part.filter((v, i, A) => A.indexOf(v) === i).join(' · ') }));
    });
  });
  rows.sort((a, b) => a.d < b.d ? -1 : (a.d > b.d ? 1 : (a.j < b.j ? -1 : (a.j > b.j ? 1 : 0))));
  const total = r2(rows.reduce((s, r) => s + (acct ? 0 : r.amt), 0));
  const tin = r2(rows.reduce((s, r) => s + (r.in || 0), 0)), tout = r2(rows.reduce((s, r) => s + (r.out || 0), 0));
  return { ok: true, biz, ym, label: ymLabel(ym), side, cat, acct, sub, n: rows.length, total, in: tin, out: tout,
           more: Math.max(0, rows.length - DOC_MAX), rows: rows.slice(0, DOC_MAX) };
}

/* ═══════════════════════════════════════════════════════════════════
 *  ลูกหนี้คงค้าง + เงินที่คาดว่าจะเข้า — ใช้ตัวคิดลูกหนี้ตัวเดิม (cashflow.js) ไม่เขียนกติกาชุดที่สอง
 *   เรียกแยกจากหน้าแรก ⇒ หน้าแรกขึ้นก่อน การ์ดลูกหนี้ตามมา (ตัวคิดเดิมอ่านตารางขายทั้งก้อน)
 * ═══════════════════════════════════════════════════════════════════ */
async function arSummary(user, q) {
  const all = peak.bizAll();
  const biz = all.indexOf(clean(q && q.biz)) >= 0 ? clean(q.biz) : '';
  const R = await require('./cashflow').cashFlowReport(user, { months: 1, biz });
  if (!R || R.ok === false) return { ok: false, error: (R && (R.msg || R.error)) || 'อ่านข้อมูลลูกหนี้ไม่ได้' };
  const ar = R.ar || {};
  return { ok: true, biz,
    total: r2(ar.total), n: ar.n || 0, overdue: r2(ar.overdue), overdueN: ar.overdueN || 0, notDue: r2(ar.notDue), notDueN: ar.notDueN || 0,
    fc30: r2(R.forecast30), forecast: (R.forecast || []).map(x => ({ k: x.k, t: x.t, amt: r2(x.amt), n: x.n })),
    aging: (R.aging || []).map(x => ({ k: x.k, t: x.t || x.label || x.k, amt: r2(x.amt), n: x.n })) };
}

/** ยอดรายเดือนรวมทุกบริษัท (ตัดรายการระหว่างกันแล้ว) — Management Report ใช้ชุดเดียวกันนี้ */
async function monthTotals(from, to) {
  const all = peak.bizAll();
  const H = await CB.heads({ from, to });
  const out = {};
  H.forEach(h => {
    if (!h.head || h.head.v !== CB.HEAD_V) return;
    const m = (out[h.ym] = out[h.ym] || { ym: h.ym, in: 0, out: 0, end: 0, biz: {}, ok: true, n: 0 });
    m.in += h.head.in - h.head.icIn; m.out += h.head.out - h.head.icOut; m.end += h.head.end; m.n++;
    m.biz[h.biz] = { in: r2(h.head.in), out: r2(h.head.out), end: r2(h.head.end), ok: !!h.ok };
    if (!h.ok) m.ok = false;
  });
  Object.keys(out).forEach(k => { const m = out[k]; m.in = r2(m.in); m.out = r2(m.out); m.end = r2(m.end); m.full = m.n === all.length; });
  return out;
}

module.exports = { overview, docs, arSummary, monthTotals, groupOf, OUT_GROUPS, IN_GROUPS, CH_NONE,
  _t: { catsOf, catKeyOf, channelOfDoc, ivIndex, normRef, ymLabel, resetIx: () => { _ix = { at: 0, map: null, p: null, n: 0 }; _bk.clear(); } } };
