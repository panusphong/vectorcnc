'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/peak-cashbook.js — "สมุดเงินสด" จาก PEAK (Cash Flow ใหม่ · รอบ 235 · 4 ต.ค. 69)
 *
 *  🔴 พี่เอสั่ง (คำต่อคำ):
 *    "เดี๋ยวรื้อ code cash flow ใหม่หมดเลยนะ เขียนขึ้นมาใหม่ ทำให้ดูง่าย เห็นสรุปภาพรวม
 *     เจาะลงรายละเอียดได้ ไม่ใช่มาอะไรเยอะแยะไปหมดแบบนี้ไม่ดู เสียเวลา"
 *    "พี่ต้องการเห็นยอดเงินในบัญชี ทุกบัญชี ที่เข้าและออกด้วยนะ"
 *    "ดึงจาก peak"   (+ เดิม: "เค้าไม่ได้คีย์ใน EXP 100% มันจะมีคีย์ไปที่รหัสผังบัญชีโดยตรง")
 *
 *  ── หลักคิด (ประโยคเดียว) ─────────────────────────────────────────
 *   เงินเข้า–ออกจริง = ทุกบรรทัดที่เดินผ่าน "บัญชีเงินสด/ธนาคาร" ในสมุดบัญชีของ PEAK
 *     เดบิต = เงินเข้า · เครดิต = เงินออก · โอนระหว่างบัญชีของบริษัทเอง = ไม่นับ
 *   ⇒ รายการที่บัญชีลงตรงรหัสผังบัญชี (ไม่ผ่านเอกสาร EXP) ถูกรวมอยู่แล้วโดยไม่ต้องเดา
 *   ⇒ ตรวจตัวเองได้: ยอดยกมา + เข้า − ออก = ยอดยกไปของงบทดลอง PEAK
 *
 *  ── รูปคำตอบของ PEAK (เห็นจากเครื่องจริง 4 ต.ค. 69 · ทั้ง 2 กิจการ · ไม่ได้เดา) ───────────
 *   GET FinancialReports/trialbalance?fromMonth=yyyyMM&toMonth=yyyyMM
 *     PeakTrialBalance.trialBalanceAccount[] { account{accountCode,accountName,subAccountCode,subAccountName,isSubAccount},
 *                                              beginningBalance{debit,credit}, change{debit,credit}, endingBalance{debit,credit} }
 *   GET FinancialReports/generalledger?fromDate=yyyyMMdd&toDate=yyyyMMdd&accountCode=……
 *     PeakGeneralLedger.generalLedgers[] { account{accountCode,accountName,isSubAccount}, summary{change{debit,credit},…},
 *                                          transactions[]{date,journalNumber,description,debit,credit}, totalTransactions }
 *     (ได้ครบทุกบรรทัดในคำตอบเดียว — บัญชีลูกหนี้ 980 บรรทัดก็มาครบ)
 *   ‼ PEAK ตอบรูปอื่น ⇒ ไฟล์นี้ "ไม่เดา" — จดว่าอ่านไม่ได้แล้วหยุด ตัวเลขเดือนนั้นไม่ถูกสร้าง
 *
 *  ── ทำงานอย่างไร ─────────────────────────────────────────────────
 *   ตัวดึงเบื้องหลัง (tick) → เขียนลงฐานของเรา 3 ตาราง (sql/113) → หน้าจออ่านจากฐานเท่านั้น
 *     ① ถามงบทดลองของเดือน (1 คำขอ) → รู้ว่ารหัสบัญชีไหนมียอดเคลื่อนไหวต่างจากที่เก็บไว้
 *     ② ดึงบัญชีแยกประเภทเฉพาะรหัสที่ต่าง (เดือนที่ปิดแล้วจึงแทบไม่มีคำขอ)
 *     ③ ตรวจ: ผลรวมบรรทัดต้องเท่ายอดเคลื่อนไหวในงบทดลอง · จำนวนบรรทัดต้องครบ
 *     ④ คิดสรุปของเดือน (เข้า · ออก · หมวด · รายบัญชี · เอกสาร) เก็บไว้ ⇒ เปิดหน้าเร็ว
 *
 *  🔒 PEAK อ่านอย่างเดียว — GET ล้วน ผ่าน core/peak.js (ด่าน ALLOW) · ไม่เขียนอะไรกลับ PEAK
 *  🔒 ใช้เบรกคำขอ/นาทีตัวเดียวกับตัวดึงรายจ่าย (peak-expenses.rateGate) + งบคำขอต่อรอบของตัวเอง
 *  🔒 ไม่ลบข้อมูลในฐาน — เขียนทับแถวของ (กิจการ, เดือน, รหัสบัญชี) เดิมเท่านั้น
 *  ยาม: tools/test-cashbook.js
 * ═══════════════════════════════════════════════════════════════════ */
const peak = require('./peak');
const db = require('./db');

const clean = s => String(s == null ? '' : s).trim();
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const near = (a, b, tol) => Math.abs(num(a) - num(b)) <= (tol == null ? 0.011 : tol);

const T_MONTH = 'peak_ledger_month', T_ACCT = 'peak_ledger_acct', T_BOOK = 'peak_cashbook';
const SQL_FILE = 'sql/113-peak-cashbook.sql';
const EP = { tb: 'FinancialReports/trialbalance', gl: 'FinancialReports/generalledger', conn: 'Receipts' };
const HEAD_V = 1;

/* ── เดือน (เวลาไทย) ─────────────────────────────────────────────── */
const TZ_MS = 7 * 3600000;
const ymNow = now => new Date((now || Date.now()) + TZ_MS).toISOString().slice(0, 7);
const ymOk = ym => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym || ''));
function ymAdd(ym, k) {
  let y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + k;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y + '-' + String(m + 1).padStart(2, '0');
}
const ymList = (from, to) => { const out = []; for (let y = from; y <= to && out.length < 240; y = ymAdd(y, 1)) out.push(y); return out; };
const lastDay = ym => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
const ymC = ym => ym.replace('-', '');

/* ── บัญชีไหนคือ "เงินสด/ธนาคาร" ─────────────────────────────────────
 *  ผังบัญชีของทั้ง 2 กิจการ (เห็นจากเครื่องจริง): 111101 เงินสด · 111201 กระแสรายวัน · 111301 ออมทรัพย์
 *  · 111401 เช็ครับที่ครบกำหนดยังไม่ฝาก · 111501 กระเป๋าเงินอิเล็กทรอนิกส์ · 112101 ฝากประจำ
 *  ‼ ฝากประจำนับเป็นเงินของบริษัทด้วย — ไม่งั้นการย้ายเงินไปฝากประจำจะกลายเป็น "เงินออก" */
const isCash = code => /^(111\d|1121)\d{2}$/.test(String(code || ''));
/* บัญชีภาษีที่ "ติดมากับรายการ" (ภาษีซื้อ · ภาษีขาย · หัก ณ ที่จ่าย) — ไม่ใช้เป็นหมวดถ้ามีบัญชีอื่นให้เลือก */
const isTaxRide = code => /^(1154|2151|2152)/.test(String(code || ''));
/* เจ้าหนี้การค้า — จ่ายบิลที่ตั้งค้างไว้ก่อน (UV) ⇒ ตามเลขเอกสารกลับไปหาหมวดค่าใช้จ่ายของบิลนั้น */
const isAp = code => String(code || '') === '212101';

/* รายการระหว่าง 2 กิจการในเครือ (ชื่อคู่ค้าในสมุดของอีกฝั่ง) — ใช้ตัดออกจากยอด "รวมทุกบริษัท" เท่านั้น */
const IC_RE = {
  'มดงานการป้าย': /(เดอะ|the)\s*101|เดอะ\s*วัน\s*โอ\s*วัน/i,
  'The 101': /มดงาน\s*การป้าย/,
};

/* ═══════════════════════════════════════════════════════════════════
 *  อ่านคำตอบของ PEAK — เข้มงวด: รูปไม่ตรง = บอกว่าอ่านไม่ได้ (ไม่เดา)
 * ═══════════════════════════════════════════════════════════════════ */
function saidOf(j) {
  const c = clean(peak.dig(j, ['resCode', 'responseCode', 'resultCode', 'statusCode']));
  const d = clean(peak.dig(j, ['resDesc', 'responseDesc', 'resultDesc', 'message', 'errorMessage']));
  return [c, d].filter(Boolean).join(' · ').slice(0, 200);
}

function parseTb(j) {
  const P = j && j.PeakTrialBalance;
  const arr = P && P.trialBalanceAccount;
  if (!P || !Array.isArray(arr))
    return { ok: false, why: 'PEAK ตอบงบทดลองในรูปที่ไม่รู้จัก (ไม่มี PeakTrialBalance.trialBalanceAccount)' + (saidOf(j) ? ' — ' + saidOf(j) : '') };
  if (P.resCode !== undefined && String(P.resCode) !== '200')
    return { ok: false, why: 'PEAK ตอบงบทดลองว่า "' + saidOf(j) + '"' };
  const g = (o, k) => num(o && o[k]);
  const rows = [];
  for (const x of arr) {
    const a = (x && x.account) || {};
    const code = clean(a.accountCode);
    if (!code || !x.change || !x.endingBalance)
      return { ok: false, why: 'แถวงบทดลองของ PEAK ไม่มีรหัสบัญชี/ยอดเคลื่อนไหว — รูปคำตอบเปลี่ยน' };
    rows.push({ code, name: clean(a.accountName), sub: clean(a.subAccountCode), subName: clean(a.subAccountName),
      isSub: a.isSubAccount === true,
      bd: g(x.beginningBalance, 'debit'), bc: g(x.beginningBalance, 'credit'),
      cd: g(x.change, 'debit'), cc: g(x.change, 'credit'),
      ed: g(x.endingBalance, 'debit'), ec: g(x.endingBalance, 'credit') });
  }
  return { ok: true, rows };
}

/** แถวบัญชีย่อย (ถามแบบ isShowSubAccount) — ใช้ได้ก็ต่อเมื่อ "รวมแล้วเท่าบัญชีแม่" ทั้งยกมา · เคลื่อนไหว · ยกไป
 *  ‼ รูปคำตอบของตัวเลือกนี้ยังไม่เคยเห็นจากเครื่องจริง ⇒ ไม่ผ่านการเทียบ = ไม่ใช้ (ถอยไปแสดงระดับรหัสบัญชี) */
function subsOf(mainRows, subRows) {
  const out = {};
  const main = {}; (mainRows || []).forEach(r => { if (!r.isSub && !r.sub) main[r.code] = r; });
  const bag = {};
  (subRows || []).forEach(r => { if (r.isSub || r.sub) (bag[r.code] = bag[r.code] || []).push(r); });
  Object.keys(bag).forEach(code => {
    const m = main[code], S = bag[code];
    if (!m || S.some(s => !s.sub)) return;
    const sum = k => S.reduce((a, s) => a + s[k], 0);
    if (!near(sum('cd'), m.cd, 0.02) || !near(sum('cc'), m.cc, 0.02)) return;
    if (!near(sum('bd') - sum('bc'), m.bd - m.bc, 0.02) || !near(sum('ed') - sum('ec'), m.ed - m.ec, 0.02)) return;
    out[code] = S.map(s => ({ code: s.sub, name: s.subName, beg: r2(s.bd - s.bc), cd: r2(s.cd), cc: r2(s.cc), end: r2(s.ed - s.ec) }));
  });
  return out;
}

function parseGl(j, code) {
  const P = j && j.PeakGeneralLedger;
  const arr = P && P.generalLedgers;
  if (!P || !Array.isArray(arr))
    return { ok: false, why: 'PEAK ตอบบัญชีแยกประเภทในรูปที่ไม่รู้จัก (ไม่มี PeakGeneralLedger.generalLedgers)' + (saidOf(j) ? ' — ' + saidOf(j) : '') };
  if (P.resCode !== undefined && String(P.resCode) !== '200')
    return { ok: false, why: 'PEAK ตอบบัญชีแยกประเภทว่า "' + saidOf(j) + '"' };
  if (!arr.length) return { ok: true, lines: [], total: 0, cd: 0, cc: 0, name: '' };
  const mine = arr.filter(g => clean(g && g.account && g.account.accountCode) === String(code));
  if (!mine.length) return { ok: false, why: 'คำตอบของ PEAK ไม่มีรหัสบัญชี ' + code + ' ที่ขอไป' };
  const lines = [];
  let total = 0, cd = 0, cc = 0, name = '';
  for (const g of mine) {
    const tx = g.transactions;
    if (!Array.isArray(tx)) return { ok: false, why: 'บัญชีแยกประเภทของ PEAK ไม่มีรายการเดินบัญชี (transactions) — รูปคำตอบเปลี่ยน' };
    name = name || clean(g.account.accountName);
    total += (g.totalTransactions === undefined || g.totalTransactions === null) ? tx.length : num(g.totalTransactions);
    const S = g.summary || {};
    cd += num(S.change && S.change.debit); cc += num(S.change && S.change.credit);
    for (const t of tx) {
      const d = clean(t && t.date);
      if (!/^\d{8}$/.test(d)) return { ok: false, why: 'บรรทัดบัญชีแยกประเภทไม่มีวันที่รูป yyyyMMdd — รูปคำตอบเปลี่ยน' };
      lines.push({ d, j: clean(t.journalNumber), t: clean(t.description), dr: num(t.debit), cr: num(t.credit) });
    }
  }
  return { ok: true, lines, total, cd: r2(cd), cc: r2(cc), name };
}

/* ═══════════════════════════════════════════════════════════════════
 *  แกะคำอธิบายของบรรทัด (description)
 *   บรรทัดธนาคารจากเอกสาร:  "ธนาคาร - บัญชีออมทรัพย์ - <ชื่อบัญชีย่อย> - <เลขบัญชี> - BSV001 - <คู่ค้า> - #IV-2026090100003"
 *   บรรทัดธนาคารจากสมุดรายวัน: "ธนาคาร - บัญชีออมทรัพย์ - BSV001 - ธ.ไทยพาณิชย์ ออมทรัพย์ - 411-227736-9 มดงานการป้าย [- ADV004 - ชื่อ]"
 * ═══════════════════════════════════════════════════════════════════ */
const REF_RE = /#([A-Z]{2,5}-[A-Z0-9][A-Z0-9\-\/]*)/;
const SUB_RE = /^[A-Z]{2,4}\d{2,4}$/;
const refOf = t => { const m = REF_RE.exec(String(t || '')); return m ? m[1] : ''; };
function partsOf(desc, acctName) {
  let s = clean(desc);
  const an = clean(acctName);
  if (an && s.indexOf(an) === 0) s = s.slice(an.length).replace(/^\s*-\s*/, '');
  return s.split(/\s+-\s+/).map(clean).filter(Boolean);
}
function cashLineInfo(desc, acctName, known) {
  const parts = partsOf(desc, acctName);
  const isRef = p => p.charAt(0) === '#';
  let idx = known ? parts.findIndex(p => known.has(p)) : -1;
  if (idx < 0) idx = parts.findIndex(p => SUB_RE.test(p));
  const out = { sub: '', subName: '', cp: '', ref: refOf(desc), fmt: '' };
  if (idx === 0) {            /* สมุดรายวัน: รหัสบัญชีย่อยมาก่อน แล้วตามด้วยชื่อธนาคาร + เลขบัญชี */
    out.sub = parts[0]; out.fmt = 'jv';
    out.subName = parts.slice(1, 3).filter(p => !isRef(p)).join(' · ');
    out.cp = parts.slice(3).filter(p => !isRef(p)).join(' - ');
  } else if (idx > 0) {       /* เอกสาร: ชื่อบัญชีย่อย + เลขบัญชี มาก่อนรหัส แล้วตามด้วยคู่ค้า */
    out.sub = parts[idx]; out.fmt = 'doc';
    out.subName = parts.slice(0, idx).join(' · ');
    out.cp = parts.slice(idx + 1).filter(p => !isRef(p)).join(' - ');
  } else out.cp = parts.filter(p => !isRef(p)).join(' - ');
  return out;
}
const memoOf = (desc, acctName) => partsOf(desc, acctName).filter(p => p.charAt(0) !== '#').join(' - ').slice(0, 160);

/* ═══════════════════════════════════════════════════════════════════
 *  แบ่งเงินของเอกสาร 1 ใบ ลง "หมวด" (รหัสบัญชีคู่) — รวมแล้วเท่ายอดเงินของเอกสารทุกสตางค์
 *   เงินออก: บัญชีคู่ฝั่งเดบิต คือสิ่งที่เงินไปจ่าย · เงินเข้า: บัญชีคู่ฝั่งเครดิต คือที่มาของเงิน
 *   ภาษีที่ติดมากับรายการ (ภาษีซื้อ/ขาย · หัก ณ ที่จ่าย) ไม่ตั้งเป็นหมวด ถ้ามีบัญชีอื่นให้ลง
 * ═══════════════════════════════════════════════════════════════════ */
function allocate(kind, amt, nonCash) {
  const sign = kind === 'out' ? 1 : -1;
  const by = {};
  (nonCash || []).forEach(l => { by[l.code] = (by[l.code] || 0) + (l.dr - l.cr) * sign; });
  const pos = Object.keys(by).filter(c => by[c] > 0.005).map(c => ({ a: c, c: by[c] }));
  const main = pos.filter(x => !isTaxRide(x.a));
  const use = main.length ? main : pos;
  if (!use.length) return [{ a: '', amt: r2(amt) }];
  const tot = use.reduce((s, x) => s + x.c, 0);
  const out = use.map(x => ({ a: x.a, amt: r2(amt * x.c / tot) }));
  const diff = r2(amt - out.reduce((s, x) => s + x.amt, 0));
  if (diff) { let big = out[0]; out.forEach(x => { if (x.amt > big.amt) big = x; }); big.amt = r2(big.amt + diff); }
  return out.filter(x => x.amt !== 0);
}

/* ═══════════════════════════════════════════════════════════════════
 *  คิดสรุปของ 1 กิจการ 1 เดือน — ฟังก์ชันล้วน (ไม่แตะฐาน ไม่แตะ PEAK) ⇒ ยามทดสอบตรงได้
 *   tb    : แถวงบทดลอง (parseTb)         subs : บัญชีย่อยที่ผ่านการเทียบแล้ว (subsOf)
 *   accts : [{code,name,lines,ok}] ของเดือนนี้     prev : บรรทัดของเดือนก่อน ๆ (ไว้ตามเลขเอกสารหาหมวดของบิล)
 * ═══════════════════════════════════════════════════════════════════ */
function buildMonth(o) {
  const biz = o.biz, ym = o.ym, tb = o.tb || [], subs = o.subs || {}, accts = o.accts || [];
  const tbBy = {}; tb.forEach(r => { if (!r.isSub && !r.sub) tbBy[r.code] = r; });
  const nameOf = c => (tbBy[c] && tbBy[c].name) || ((accts.find(a => a.code === c) || {}).name) || c;
  const issues = [];

  /* ดัชนีบรรทัดตามเลขสมุดรายวัน */
  const byJ = {};
  const acctOk = {};
  accts.forEach(a => {
    acctOk[a.code] = a.ok !== false;
    (a.lines || []).forEach(l => {
      if (!l.j) return;
      (byJ[l.j] = byJ[l.j] || []).push({ code: a.code, d: l.d, t: l.t, dr: num(l.dr), cr: num(l.cr) });
    });
  });

  /* ดัชนี "เลขเอกสาร → บรรทัดค่าใช้จ่ายของบิลนั้น" (เดือนนี้ + เดือนก่อน ๆ) — ใช้เมื่อจ่ายผ่านเจ้าหนี้การค้า */
  const byRef = {};
  const feedRef = (code, l) => {
    if (isCash(code) || isAp(code) || isTaxRide(code)) return;
    const ref = refOf(l.t); if (!ref || !(num(l.dr) > 0)) return;
    (byRef[ref] = byRef[ref] || []).push({ code, j: l.j, dr: num(l.dr) });
  };
  accts.forEach(a => (a.lines || []).forEach(l => feedRef(a.code, l)));
  (o.prev || []).forEach(a => (a.lines || []).forEach(l => feedRef(a.code, l)));
  const names = Object.assign({}, o.prevNames || {});

  /* บัญชีเงินสด/ธนาคาร */
  const cashRows = tb.filter(r => !r.isSub && !r.sub && isCash(r.code));
  const A = {};
  cashRows.forEach(r => {
    const known = new Set((subs[r.code] || []).map(s => s.code));
    A[r.code] = { code: r.code, name: r.name, beg: r2(r.bd - r.bc), end: r2(r.ed - r.ec), in: 0, out: 0, xin: 0, xout: 0, n: 0,
                  ok: true, _known: known, _subs: {} };
  });

  const icRe = IC_RE[biz] || null;
  const docs = [];
  let tin = 0, tout = 0, xfer = 0, icIn = 0, icOut = 0, nIn = 0, nOut = 0, nX = 0, loose = 0;
  const catIn = {}, catOut = {};
  const addCat = (bag, a, amt) => { const k = a || ''; (bag[k] = bag[k] || { a: k, amt: 0, n: 0 }); bag[k].amt += amt; bag[k].n++; };

  Object.keys(byJ).forEach(jn => {
    const L = byJ[jn];
    const cashL = L.filter(l => isCash(l.code));
    if (!cashL.length) return;
    const non = L.filter(l => !isCash(l.code));
    const cashD = cashL.reduce((s, l) => s + l.dr, 0), cashC = cashL.reduce((s, l) => s + l.cr, 0);
    const net = r2(cashD - cashC), inner = r2(Math.min(cashD, cashC));
    const kind = net > 0.005 ? 'in' : (net < -0.005 ? 'out' : 'x');
    const amt = kind === 'x' ? inner : Math.abs(net);

    /* รายบัญชี (แบบสมุดธนาคาร: เดบิต = เข้า · เครดิต = ออก · รวมโอนระหว่างบัญชี) */
    const accMap = {};
    let cp = '', ref = '';
    cashL.forEach(l => {
      const a = A[l.code];
      const info = cashLineInfo(l.t, a ? a.name : nameOf(l.code), a ? a._known : null);
      if (a) {
        a.in += l.dr; a.out += l.cr; a.n++;
        const s = (a._subs[info.sub] = a._subs[info.sub] || { code: info.sub, name: '', nameDoc: '', in: 0, out: 0, n: 0 });
        s.in += l.dr; s.out += l.cr; s.n++;
        if (info.fmt === 'jv' && info.subName && !s.name) s.name = info.subName;
        if (info.fmt === 'doc' && info.subName && !s.nameDoc) s.nameDoc = info.subName;
      }
      const k = l.code + '|' + info.sub;
      (accMap[k] = accMap[k] || { c: l.code, s: info.sub, dr: 0, cr: 0 });
      accMap[k].dr += l.dr; accMap[k].cr += l.cr;
      if (!cp && info.cp) cp = info.cp;
      if (!ref && info.ref) ref = info.ref;
    });
    /* ส่วนที่เป็นโอนระหว่างบัญชีของบริษัทเอง — กระจายลงบัญชีตามสัดส่วน (ไว้บอกบนการ์ดบัญชี) */
    if (inner > 0.005) cashL.forEach(l => {
      const a = A[l.code]; if (!a) return;
      if (l.dr > 0 && cashD > 0) a.xin += inner * l.dr / cashD;
      if (l.cr > 0 && cashC > 0) a.xout += inner * l.cr / cashC;
    });

    /* สมดุลไหม (ได้บรรทัดของเอกสารนี้ครบทุกรหัสบัญชีหรือยัง) */
    const sd = L.reduce((s, l) => s + l.dr, 0), sc = L.reduce((s, l) => s + l.cr, 0);
    const balanced = near(sd, sc, 0.02);
    if (!balanced && kind !== 'x') loose++;

    let cats = [];
    let via = '';
    if (kind !== 'x') {
      cats = allocate(kind, amt, non);
      non.forEach(l => { if (!ref) ref = refOf(l.t); });
      /* จ่ายเจ้าหนี้การค้า ⇒ ตามเลขเอกสารกลับไปหาหมวดค่าใช้จ่ายของบิล (บิลอาจตั้งไว้เดือนก่อน) */
      if (kind === 'out' && ref && cats.some(c => isAp(c.a)) && byRef[ref]) {
        const src = byRef[ref].filter(x => x.j !== jn);
        const tot = src.reduce((s, x) => s + x.dr, 0);
        if (tot > 0.005) {
          const next = [];
          cats.forEach(c => {
            if (!isAp(c.a)) { next.push(c); return; }
            const by = {}; src.forEach(x => { by[x.code] = (by[x.code] || 0) + x.dr; });
            const part = Object.keys(by).map(code => ({ a: code, amt: r2(c.amt * by[code] / tot) }));
            const diff = r2(c.amt - part.reduce((s, x) => s + x.amt, 0));
            if (diff && part.length) { let big = part[0]; part.forEach(x => { if (x.amt > big.amt) big = x; }); big.amt = r2(big.amt + diff); }
            part.forEach(p => next.push(p));
          });
          /* รวมหมวดที่ซ้ำกัน */
          const m = {}; next.forEach(x => { m[x.a] = r2((m[x.a] || 0) + x.amt); });
          cats = Object.keys(m).map(a => ({ a, amt: m[a] }));
          via = 'ap';
        }
      }
      /* คู่ค้า/รายละเอียด: จากบรรทัดธนาคารก่อน ไม่มีค่อยใช้บรรทัดของบัญชีคู่ตัวหลัก */
      if (!cp && non.length) {
        const mainCode = (cats.slice().sort((a, b) => b.amt - a.amt)[0] || {}).a;
        const ml = non.filter(l => l.code === mainCode).sort((a, b) => (b.dr + b.cr) - (a.dr + a.cr))[0]
                || non.slice().sort((a, b) => (b.dr + b.cr) - (a.dr + a.cr))[0];
        if (ml) cp = memoOf(ml.t, nameOf(ml.code)) || nameOf(ml.code);     /* คำอธิบายมีแต่ชื่อบัญชี ⇒ ใช้ชื่อบัญชีนั้น */
      }
    }
    const ic = !!(icRe && cp && icRe.test(cp));
    const doc = { j: jn, d: cashL[0].d, k: kind, amt: r2(amt), cp: cp.slice(0, 160), ref,
                  acc: Object.keys(accMap).map(k => ({ c: accMap[k].c, s: accMap[k].s, dr: r2(accMap[k].dr), cr: r2(accMap[k].cr) })),
                  cats };
    if (inner > 0.005 && kind !== 'x') doc.x = inner;
    if (ic) doc.ic = 1;
    if (via) doc.via = via;
    if (!balanced && kind !== 'x') doc.q = 1;
    docs.push(doc);

    if (kind === 'in') { tin += amt; nIn++; if (ic) icIn += amt; cats.forEach(c => addCat(catIn, c.a, c.amt)); }
    else if (kind === 'out') { tout += amt; nOut++; if (ic) icOut += amt; cats.forEach(c => addCat(catOut, c.a, c.amt)); }
    else { xfer += amt; nX++; }
  });

  /* รายบัญชี: เทียบกับงบทดลอง */
  const accounts = cashRows.map(r => {
    const a = A[r.code];
    a.in = r2(a.in); a.out = r2(a.out); a.xin = r2(a.xin); a.xout = r2(a.xout);
    const moved = Math.abs(r.cd) > 0.005 || Math.abs(r.cc) > 0.005;
    const fetched = acctOk[r.code] !== undefined;
    a.ok = !moved ? true : (fetched && acctOk[r.code] && near(a.in, r.cd, 0.02) && near(a.out, r.cc, 0.02) && near(a.beg + a.in - a.out, a.end, 0.02));
    if (!a.ok) issues.push('บัญชี ' + r.code + ' ' + r.name + ': รายการเดินบัญชีที่ดึงได้ยังไม่ตรงกับงบทดลอง');
    /* บัญชีย่อย (บัญชีธนาคารจริงแต่ละเล่ม) */
    const tbSubs = subs[r.code] || [];
    const keys = Object.keys(a._subs);
    let list = keys.map(k => {
      const s = a._subs[k], t = tbSubs.find(x => x.code === k);
      return { code: k, name: (t && t.name) || s.name || s.nameDoc || '', in: r2(s.in), out: r2(s.out), n: s.n,
               beg: t ? t.beg : null, end: t ? t.end : null };
    });
    tbSubs.forEach(t => { if (!list.some(x => x.code === t.code)) list.push({ code: t.code, name: t.name, in: 0, out: 0, n: 0, beg: t.beg, end: t.end }); });
    /* งบทดลองไม่ได้แยกบัญชีย่อยให้ แต่ทั้งรหัสมีบัญชีย่อยเดียว ⇒ ยอดคงเหลือ = ของรหัสนั้น */
    if (!tbSubs.length && list.length === 1 && list[0].code) { list[0].beg = a.beg; list[0].end = a.end; }
    list = list.filter(x => x.code).sort((x, y) => x.code < y.code ? -1 : 1);
    const loosePart = a._subs[''] ? r2(a._subs[''].in + a._subs[''].out) : 0;
    const out = { code: a.code, name: a.name, beg: a.beg, in: a.in, out: a.out, end: a.end, xin: a.xin, xout: a.xout, n: a.n, ok: a.ok,
                  subs: list, subBal: tbSubs.length ? 'tb' : (list.length === 1 && !loosePart ? 'one' : (list.length ? 'none' : '')) };
    return out;
  });

  tin = r2(tin); tout = r2(tout); xfer = r2(xfer);
  const beg = r2(accounts.reduce((s, a) => s + a.beg, 0)), end = r2(accounts.reduce((s, a) => s + a.end, 0));
  const cashOk = accounts.every(a => a.ok) && near(beg + tin - tout, end, 0.05);
  if (accounts.every(a => a.ok) && !near(beg + tin - tout, end, 0.05))
    issues.push('ยอดยกมา + เข้า − ออก ไม่เท่ายอดยกไป (ต่าง ' + r2(beg + tin - tout - end) + ' บาท)');
  /* หมวดครบไหม: ทุกรหัสบัญชีที่มียอดเคลื่อนไหวต้องดึงมาแล้วและตรง */
  const movedCodes = tb.filter(r => !r.isSub && !r.sub && (Math.abs(r.cd) > 0.005 || Math.abs(r.cc) > 0.005)).map(r => r.code);
  const missing = movedCodes.filter(c => acctOk[c] !== true);
  const catsOk = !missing.length && !loose;
  if (missing.length) issues.push('ยังดึงบัญชีแยกประเภทไม่ครบ ' + missing.length + ' รหัส — หมวดของบางเอกสารยังไม่ครบ');
  else if (loose) issues.push('มี ' + loose + ' เอกสารที่ยังหาบัญชีคู่ไม่ครบ');

  const catList = bag => Object.keys(bag).map(k => ({ a: k, name: k ? (nameOf(k) !== k ? nameOf(k) : (names[k] || k)) : '', amt: r2(bag[k].amt), n: bag[k].n }))
    .sort((x, y) => y.amt - x.amt);
  docs.sort((x, y) => x.d < y.d ? -1 : (x.d > y.d ? 1 : (x.j < y.j ? -1 : 1)));

  const head = { v: HEAD_V, biz, ym, in: tin, out: tout, net: r2(tin - tout), xfer, icIn: r2(icIn), icOut: r2(icOut),
                 beg, end, n: { in: nIn, out: nOut, x: nX }, accounts,
                 inCats: catList(catIn), outCats: catList(catOut),
                 verify: { ok: cashOk, cats: catsOk, issues } };
  return { head, docs, ok: cashOk };
}

/* ═══════════════════════════════════════════════════════════════════
 *  ฐานข้อมูล — แก้ก่อน ไม่ได้ค่อยเพิ่ม (ไม่พึ่ง upsert · บทเรียนเดียวกับ peak_state ใน core/peak-queue.js)
 * ═══════════════════════════════════════════════════════════════════ */
async function saveRow(table, keys, row) {
  const f = { select: Object.keys(keys)[0] };
  Object.keys(keys).forEach(k => { f[k] = 'eq.' + keys[k]; });
  const upd = await db.update(table, f, row);
  if (Array.isArray(upd) && upd.length) return 'update';
  await db.rest('POST', '/' + table + db.qs({ select: Object.keys(keys)[0] }),
    { body: [Object.assign({}, keys, row)], prefer: 'return=representation' });
  return 'insert';
}
const tableMissing = e => /PGRST205|42P01|does not exist|Could not find the table|schema cache/i.test(String((e && e.message) || e));

/* ═══════════════════════════════════════════════════════════════════
 *  ถาม PEAK 1 คำขอ — GET ครั้งเดียว (peak.getOnce: ไม่ไปสั่งขอกุญแจใหม่เอง · ดูเหตุผลใน core/peak.js)
 * ═══════════════════════════════════════════════════════════════════ */
const BAD_RE = /invalid|error|fail|denied|not allow|expired|unauthor|forbidden|exceed|permission/i;
const isBudgetMsg = m => /เกิน \d+ คำขอในหนึ่งนาที/.test(m);
function budgetErr(ctx, msg) { ctx.more = true; const e = new Error(msg); e.budget = true; return e; }

async function ask(ctx, ep, params) {
  if (ctx.sent >= ctx.maxCalls) throw budgetErr(ctx, 'ครบจำนวนคำขอของรอบนี้ — รอบถัดไปดึงต่อ');
  if (ctx.endAt && Date.now() > ctx.endAt) throw budgetErr(ctx, 'ครบเวลาของรอบนี้ — รอบถัดไปดึงต่อ');
  let gate = true;
  try { gate = await require('./peak-expenses').rateGate(Math.max(1000, (ctx.endAt || (Date.now() + 15000)) - Date.now())); }
  catch (e) { gate = true; }
  if (!gate) throw budgetErr(ctx, 'โควตาคำขอ PEAK ต่อนาทีเต็ม — รอบถัดไปดึงต่อ');
  ctx.sent++;
  let a;
  try { a = await peak.getOnce(ep, params || {}, ctx.biz); }
  catch (e) {
    const m = String((e && e.message) || e);
    if (isBudgetMsg(m)) throw budgetErr(ctx, m);
    throw e;
  }
  const said = a.json ? saidOf(a.json) : '';
  if (a.status === 401 || a.status === 403) {
    const e = new Error('PEAK ตอบ HTTP ' + a.status + (said ? ' — ' + said : '')); e.auth = true; throw e;
  }
  if (a.status >= 300) throw new Error('PEAK ตอบ HTTP ' + a.status + (said ? ' — ' + said : (a.text ? ' — ' + String(a.text).slice(0, 200) : '')));
  if (!a.json) throw new Error('PEAK ตอบ HTTP ' + a.status + ' แต่อ่านเป็นข้อมูลไม่ได้');
  return a.json;
}
/** กุญแจหมดอายุ ⇒ ต่ออายุด้วยทางปกติ 1 ครั้งต่อรอบต่อกิจการ (peak.get รู้วิธีขอกุญแจใหม่ตามกติกา 65 วินาที) */
async function askAuth(ctx, ep, params) {
  try { return await ask(ctx, ep, params); }
  catch (e) {
    if (!e.auth || ctx.renewed) throw e;
    ctx.renewed = true;
    ctx.sent++;
    await peak.get(EP.conn, { limit: 1, page: 1 }, ctx.biz);
    return ask(ctx, ep, params);
  }
}

/* ═══════════════════════════════════════════════════════════════════
 *  ดึง 1 กิจการ 1 เดือน
 * ═══════════════════════════════════════════════════════════════════ */
async function storedAccts(biz, ym, withLines) {
  return (await db.selectAll(T_ACCT, {
    select: 'account_code,account_name,n,sum_debit,sum_credit,ok' + (withLines ? ',lines' : ''),
    biz: 'eq.' + biz, ym: 'eq.' + ym, order: 'account_code.asc' })) || [];
}

async function syncMonth(ctx, biz, ym, opt) {
  const force = !!(opt && opt.force);
  ctx.biz = biz;
  const stamp = new Date().toISOString();
  const R = { biz, ym, fetched: 0, pending: 0, built: false, err: '' };

  /* ① งบทดลอง */
  const tbJ = await askAuth(ctx, EP.tb, { fromMonth: ymC(ym), toMonth: ymC(ym) });
  const TB = parseTb(tbJ);
  if (!TB.ok) throw new Error(TB.why);
  /* งบทดลองแบบแยกบัญชีย่อย — เสริมเท่านั้น (อ่านไม่ได้/เทียบไม่ผ่าน = ไม่ใช้) */
  let subRows = [];
  try {
    const sj = await ask(ctx, EP.tb, { fromMonth: ymC(ym), toMonth: ymC(ym), isShowSubAccount: 'true' });
    const SB = parseTb(sj);
    if (SB.ok) subRows = SB.rows.filter(r => r.isSub || r.sub);
  } catch (e) { if (e.budget) throw e; subRows = []; }

  const main = TB.rows.filter(r => !r.isSub && !r.sub);
  const old = await db.one(T_MONTH, { biz: 'eq.' + biz, ym: 'eq.' + ym, select: 'tb,full_at' }).catch(() => null);
  const tbChanged = !old || JSON.stringify(old.tb || []) !== JSON.stringify(main);

  /* ② รหัสบัญชีที่ต้องดึงใหม่ = ยอดเคลื่อนไหวในงบทดลองต่างจากที่เก็บไว้ */
  const st = {}; (await storedAccts(biz, ym, false)).forEach(a => { st[a.account_code] = a; });
  const need = [];
  main.forEach(r => {
    const moved = Math.abs(r.cd) > 0.005 || Math.abs(r.cc) > 0.005;
    const s = st[r.code];
    if (!moved) { if (s && s.n > 0) need.push({ r, zero: true }); return; }
    if (force || !s || !s.ok || !near(s.sum_debit, r.cd) || !near(s.sum_credit, r.cc)) need.push({ r });
  });
  /* เงินสด/ธนาคารก่อน — ตัวเลขหลักของหน้าขึ้นก่อน หมวดตามมาทีหลัง */
  need.sort((a, b) => (isCash(b.r.code) ? 1 : 0) - (isCash(a.r.code) ? 1 : 0) || (a.r.code < b.r.code ? -1 : 1));
  R.pending = need.length;
  await saveRow(T_MONTH, { biz, ym }, { tb: main, tb_sub: subRows, tb_at: stamp, pending: need.length, err: null, updated_at: stamp });

  /* ③ บัญชีแยกประเภทของรหัสที่ต้องดึง */
  const from = ymC(ym) + '01', to = ymC(ym) + String(lastDay(ym)).padStart(2, '0');
  let stop = null;
  for (const x of need) {
    const r = x.r;
    try {
      let row;
      if (x.zero) row = { account_name: r.name, n: 0, sum_debit: 0, sum_credit: 0, ok: true, note: null, lines: [], fetched_at: stamp };
      else {
        const G = parseGl(await askAuth(ctx, EP.gl, { fromDate: from, toDate: to, accountCode: r.code }), r.code);
        if (!G.ok) throw new Error(G.why);
        const sd = r2(G.lines.reduce((s, l) => s + l.dr, 0)), sc = r2(G.lines.reduce((s, l) => s + l.cr, 0));
        const full = G.total === G.lines.length;
        const ok = full && near(sd, r.cd, 0.02) && near(sc, r.cc, 0.02);
        row = { account_name: r.name, n: G.lines.length, sum_debit: sd, sum_credit: sc, ok,
                note: ok ? null : (!full ? 'PEAK บอกว่ามี ' + G.total + ' บรรทัด แต่ส่งมา ' + G.lines.length
                                         : 'ผลรวมบรรทัด (เดบิต ' + sd + ' · เครดิต ' + sc + ') ไม่ตรงกับงบทดลอง (' + r.cd + ' · ' + r.cc + ')'),
                lines: G.lines, fetched_at: new Date().toISOString() };
      }
      await saveRow(T_ACCT, { biz, ym, account_code: r.code }, row);
      R.fetched++; R.pending--;
    } catch (e) { stop = e; break; }
  }
  if (stop && !stop.budget) R.err = String(stop.message || stop).slice(0, 300);

  /* ④ คิดสรุปของเดือน — เมื่อดึงครบ หรือเมื่องบทดลองเปลี่ยน/ยังไม่เคยคิด (ดึงไม่ครบก็คิดเท่าที่มี แล้วติดป้ายว่ายังไม่ครบ) */
  const hasBook = await db.one(T_BOOK, { biz: 'eq.' + biz, ym: 'eq.' + ym, select: 'ym' }).catch(() => null);
  if (R.fetched || tbChanged || !hasBook || force) {
    await rebuild(biz, ym, main, subRows);
    R.built = true;
    /* เดือนถัด ๆ ไปใช้บรรทัดของเดือนนี้ตามหาหมวดของบิลที่จ่ายผ่านเจ้าหนี้การค้า ⇒ ได้ข้อมูลเดือนนี้เพิ่ม ต้องคิดเดือนหลังใหม่
     * (ตัวดึงย้อนหลังเดินจากเดือนใหม่ไปเก่า — ไม่ทำข้อนี้ บิลที่ตั้งไว้เดือนก่อนจะค้างอยู่ที่ "ไม่พบบิลต้นทาง") · อ่านจากฐานล้วน ไม่ยิง PEAK */
    if (R.fetched) for (let k = 1; k <= 3; k++) {
      const nx = ymAdd(ym, k);
      if (nx > ymNow()) break;
      const has = await db.one(T_BOOK, { biz: 'eq.' + biz, ym: 'eq.' + nx, select: 'ym' }).catch(() => null);
      if (has) await rebuild(biz, nx).catch(() => {});
    }
  }
  const done = new Date().toISOString();
  const patch = { pending: Math.max(0, R.pending), err: R.err || null, updated_at: done };
  if (force && !R.pending && !R.err) patch.full_at = done;
  if (!old || !old.full_at) { if (!R.pending && !R.err) patch.full_at = done; }
  await saveRow(T_MONTH, { biz, ym }, patch);
  if (stop && stop.budget) R.more = true;
  if (stop && !stop.budget) { const e = new Error(R.err); e.partial = R; if (stop.auth) e.auth = true; throw e; }
  return R;
}

/** บรรทัดของเดือนก่อน ๆ ที่ใช้ตามหาหมวดของบิล (เฉพาะบัญชีต้นทุน/ค่าใช้จ่าย/สินทรัพย์ — ไม่ลากทั้งสมุด) */
async function prevLines(biz, ym, back) {
  const out = [], names = {};
  for (let k = 1; k <= (back || 3); k++) {
    const p = ymAdd(ym, -k);
    let rows = [];
    try {
      rows = await db.selectAll(T_ACCT, { select: 'account_code,account_name,lines', biz: 'eq.' + biz, ym: 'eq.' + p,
        or: '(account_code.like.5*,account_code.like.12*,account_code.like.114*,account_code.like.1151*)', order: 'account_code.asc' });
    } catch (e) { rows = []; }
    (rows || []).forEach(a => { out.push({ code: a.account_code, lines: a.lines || [] }); names[a.account_code] = a.account_name; });
  }
  return { rows: out, names };
}

async function rebuild(biz, ym, tbMain, tbSub) {
  let tb = tbMain, sub = tbSub;
  if (!tb) {
    const m = await db.one(T_MONTH, { biz: 'eq.' + biz, ym: 'eq.' + ym, select: 'tb,tb_sub' });
    if (!m) return null;
    tb = m.tb || []; sub = m.tb_sub || [];
  }
  const accts = (await storedAccts(biz, ym, true)).map(a => ({ code: a.account_code, name: a.account_name, ok: a.ok, lines: a.lines || [] }));
  const P = await prevLines(biz, ym, 3);
  const B = buildMonth({ biz, ym, tb, subs: subsOf(tb, sub), accts, prev: P.rows, prevNames: P.names });
  await saveRow(T_BOOK, { biz, ym }, { ok: B.ok, head: B.head, docs: B.docs, built_at: new Date().toISOString() });
  return B;
}

/* ═══════════════════════════════════════════════════════════════════
 *  ตัวเดินเบื้องหลัง — เปิดตลอด (แนวเดียวกับตัวซิงก์ PEAK ตัวอื่น · พี่เอ: "เปิด auto ไว้เลยไม่ต้องปิด")
 *   เดือนนี้ ถามงบทดลองทุก ~10 นาที · เดือนก่อน ทุก ~1 ชม. · เดือนเก่า วันละครั้ง · ย้อนหลังตั้งต้น 12 เดือน
 *   เดือนนี้ + เดือนก่อน ดึงใหม่ทุกรหัสวันละครั้ง (กันกรณีแก้เอกสารแล้วยอดรวมเท่าเดิม)
 * ═══════════════════════════════════════════════════════════════════ */
const MIN = 60000;
const CUR_EVERY = 10 * MIN, PREV_EVERY = 60 * MIN, OLD_EVERY = 24 * 60 * MIN, FULL_EVERY = 24 * 60 * MIN;
const TICK_MS = 5 * MIN, TICK_CALLS = 140, TICK_BUDGET_MS = 100000;
const BACK_MONTHS = 12;
let _busy = false, _timer = null;
const _run = { at: 0, endAt: 0, sent: 0, note: '', err: {}, last: {} };

function fromYm(now) {
  const env = clean(process.env.CASHBOOK_FROM);
  return ymOk(env) ? env : ymAdd(ymNow(now), -BACK_MONTHS);
}

function plan(rows, now) {
  const cur = ymNow(now), prev = ymAdd(cur, -1), t = now || Date.now();
  const by = {}; (rows || []).forEach(r => { by[r.ym] = r; });
  const jobs = [];
  ymList(fromYm(now), cur).forEach(ym => {
    const S = by[ym];
    const age = S && S.tb_at ? t - new Date(S.tb_at).getTime() : Infinity;
    const hot = ym === cur || ym === prev;
    const force = hot && !!S && !!S.tb_at && (!S.full_at || t - new Date(S.full_at).getTime() > FULL_EVERY) && !(S.pending > 0);
    if (!S || !S.tb_at) jobs.push({ ym, why: 'new', pr: ym === cur ? 0 : (ym === prev ? 1 : 2) });
    else if (S.pending > 0) jobs.push({ ym, why: 'pending', pr: ym === cur ? 0 : 1 });
    else if (ym === cur && age > CUR_EVERY) jobs.push({ ym, why: 'cur', pr: 0, force });
    else if (ym === prev && age > PREV_EVERY) jobs.push({ ym, why: 'prev', pr: 1, force });
    else if (!hot && age > OLD_EVERY) jobs.push({ ym, why: 'old', pr: 3 });
  });
  return jobs.sort((a, b) => a.pr - b.pr || (a.ym < b.ym ? 1 : -1));
}

async function monthRows(biz) {
  return (await db.selectAll(T_MONTH, { select: 'biz,ym,tb_at,full_at,pending,err,updated_at',
    ...(biz ? { biz: 'eq.' + biz } : {}), order: 'ym.asc' })) || [];
}

/**
 * เดิน 1 รอบ
 * @param {{only?:{biz?:string, ym?:string}, force?:boolean, maxCalls?:number, budgetMs?:number, now?:number}} opt
 */
async function tick(opt) {
  const o = opt || {};
  if (_busy) return { ok: false, busy: true, msg: 'กำลังดึงอยู่ — รอรอบนี้จบก่อน' };
  _busy = true;
  const ctx = { sent: 0, maxCalls: o.maxCalls || TICK_CALLS, endAt: Date.now() + (o.budgetMs || TICK_BUDGET_MS), more: false };
  _run.at = Date.now(); _run.note = '';
  const out = { ok: true, sent: 0, months: [], errors: [] };
  try {
    const list = peak.configuredList().filter(b => !o.only || !o.only.biz || o.only.biz === b);
    if (!list.length) { out.ok = false; out.msg = 'ยังไม่ได้ตั้งค่าเชื่อมต่อ PEAK'; return out; }
    for (const biz of list) {
      ctx.renewed = false;
      let jobs;
      try {
        if (o.only && o.only.ym) jobs = [{ ym: o.only.ym, why: 'manual', pr: 0, force: !!o.force }];
        else jobs = plan(await monthRows(biz), o.now);
      } catch (e) {
        const m = tableMissing(e) ? 'ยังไม่ได้สร้างตารางสมุดเงินสด — รัน ' + SQL_FILE + ' ใน Supabase ก่อน' : String(e.message || e);
        _run.err[biz] = m; out.errors.push({ biz, err: m }); out.needSql = tableMissing(e) || out.needSql; continue;
      }
      delete _run.err[biz];
      for (const jb of jobs) {
        if (ctx.sent >= ctx.maxCalls || Date.now() > ctx.endAt) { ctx.more = true; break; }
        try {
          const r = await syncMonth(ctx, biz, jb.ym, { force: !!jb.force || (!!o.force && !!o.only) });
          out.months.push({ biz, ym: jb.ym, why: jb.why, fetched: r.fetched, pending: r.pending, built: r.built });
          if (r.more) break;
        } catch (e) {
          if (e.budget) { ctx.more = true; break; }
          const m = String(e.message || e).slice(0, 300);
          _run.err[biz] = m; out.errors.push({ biz, ym: jb.ym, err: m });
          try { await saveRow(T_MONTH, { biz, ym: jb.ym }, { err: m, updated_at: new Date().toISOString() }); } catch (_) { /* จดไม่ได้ก็ไม่ใช่เหตุให้รอบพัง */ }
          break;      /* กิจการนี้พักรอบนี้ไว้ก่อน — ไม่ยิงซ้ำใส่ PEAK ตอนที่มันปฏิเสธ */
        }
      }
    }
    out.sent = ctx.sent; out.more = ctx.more;
    _run.last = { at: Date.now(), sent: ctx.sent, months: out.months.length, more: ctx.more };
    return out;
  } finally { _run.sent = ctx.sent; _run.endAt = Date.now(); _busy = false; }
}

function start() {
  if (_timer) return true;
  /* เปิดเองเฉพาะเครื่องจริง (NODE_ENV=production) — เครื่องทดลอง/ยามไม่ยิงเบื้องหลังเอง เว้นแต่ตั้ง CASHBOOK_AUTO=1
   * ปิดด้วย CASHBOOK_AUTO=0 ได้ (เช่นตอน PEAK มีปัญหา) — ข้อมูลที่ดึงไว้แล้วยังเปิดดูได้ตามปกติ */
  const flag = clean(process.env.CASHBOOK_AUTO);
  const on = flag === '1' || (flag !== '0' && process.env.NODE_ENV === 'production');
  if (!on) return false;
  const go = () => tick().then(r => {
    if (r && r.errors && r.errors.length) console.warn('[cashbook] ดึงสมุดเงินสดจาก PEAK ไม่ครบ:', r.errors.map(e => e.biz + (e.ym ? ' ' + e.ym : '') + ' — ' + e.err).join(' | '));
    else if (r && r.months && r.months.some(m => m.fetched)) console.log('[cashbook] ดึงสมุดเงินสดจาก PEAK: ' + r.sent + ' คำขอ · ' + r.months.length + ' เดือน' + (r.more ? ' (ยังมีต่อ)' : ''));
    /* ยังมีของค้าง (ดึงย้อนหลัง) ⇒ เดินต่อเร็วขึ้น ไม่ต้องรอครบ 5 นาที */
    if (r && r.more) { const t = setTimeout(go, 20000); if (t.unref) t.unref(); }
  }).catch(e => console.warn('[cashbook] รอบดึงพัง:', e.message));
  _timer = setInterval(go, TICK_MS);
  if (_timer.unref) _timer.unref();
  const first = setTimeout(go, 45000); if (first.unref) first.unref();
  console.log('[cashbook] ตัวดึงสมุดเงินสดจาก PEAK เปิด · ทุก 5 นาที · ย้อนหลังถึง ' + fromYm());
  return true;
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

/* ═══════════════════════════════════════════════════════════════════
 *  อ่านให้หน้าจอ — จากฐานเท่านั้น ไม่ยิง PEAK
 * ═══════════════════════════════════════════════════════════════════ */
async function heads(o) {
  const q = { select: 'biz,ym,ok,head,built_at', order: 'ym.asc' };
  const f = [];
  if (o && o.from) f.push('ym.gte.' + o.from);
  if (o && o.to) f.push('ym.lte.' + o.to);
  if (f.length) q.and = '(' + f.join(',') + ')';
  if (o && o.biz) q.biz = 'eq.' + o.biz;
  return (await db.selectAll(T_BOOK, q)) || [];
}
async function book(biz, ym) {
  return db.one(T_BOOK, { biz: 'eq.' + biz, ym: 'eq.' + ym, select: 'biz,ym,ok,head,docs,built_at' });
}
async function status() {
  let rows = [], needSql = false, err = '';
  try { rows = await monthRows(''); } catch (e) { needSql = tableMissing(e); err = needSql ? '' : String(e.message || e); }
  const cur = ymNow(), from = fromYm();
  const want = ymList(from, cur);
  const biz = peak.configuredList().map(b => {
    const mine = rows.filter(r => r.biz === b);
    const done = want.filter(ym => { const r = mine.find(x => x.ym === ym); return r && r.tb_at && !(r.pending > 0); }).length;
    const c = mine.find(r => r.ym === cur);
    return { biz: b, months: want.length, done, pending: mine.reduce((s, r) => s + (r.pending || 0), 0),
             curAt: c ? c.tb_at : null, err: _run.err[b] || ((mine.filter(r => r.err).pop() || {}).err) || '' };
  });
  return { ok: true, needSql, sqlFile: SQL_FILE, err, from, cur, busy: _busy, auto: !!_timer,
           configured: peak.configuredList(), all: peak.bizAll(), biz, last: _run.last };
}

module.exports = {
  tick, start, stop, status, heads, book, rebuild, syncMonth, SQL_FILE, T_MONTH, T_ACCT, T_BOOK, EP, HEAD_V,
  ymNow, ymAdd, ymOk, ymList, isCash,
  _t: { parseTb, parseGl, subsOf, buildMonth, allocate, cashLineInfo, partsOf, memoOf, refOf, plan, fromYm, lastDay,
        isTaxRide, isAp, IC_RE, near, saveRow, busy: () => _busy },
};
