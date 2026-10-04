'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  📒 core/peak-ledger.js — "ลองถาม PEAK ตามรหัสผังบัญชี" (รอบ 233 · 4 ต.ค. 69)
 *
 *  พี่เอ (คำต่อคำ):
 *    "management report เรายังดึงค่าใช้จ่ายมาไม่หมดนะ พี่เพิ่งรู้ว่า เค้าไม่ได้คีย์ใน EXP 100%
 *     มันจะมีคีย์ไปที่รหัสผังบัญชีโดยตรง ส่วนนี้ไปเอามาได้มั้ย อลิซ"
 *    "ทำเลย แล้วให้มันเป็นข้อมูลชุดเดียวกันกับ เมนูงาน Cash flow ด้วยนะ"
 *
 *  ── ทำไมไฟล์นี้อยู่ใน core ─────────────────────────────────────────
 *   เงินออกของ "เมนูงาน Cash Flow" (คีย์ยอดขาย) และของ Management Report มาจากที่เดียวกัน
 *   คือ core/peak-expenses.js → app.peak_expenses → modules/sales/cashflow.js
 *   ⇒ ของที่จะมาเติมส่วนที่ขาด (รายการที่ลงตรงรหัสผังบัญชี) ต้องอยู่ชั้นเดียวกัน
 *     ทั้ง 2 หน้าจะได้อ่าน "ชุดเดียวกัน" เสมอ ไม่มีตัวเลขคนละที่มา
 *
 *  ── หลักฐาน (ไม่ใช่การเดา) — developers.peakaccount.com ───────────
 *   GET /api/v1/DailyJournals/accountcode          ผังบัญชี (ไม่มีพารามิเตอร์)
 *   GET /api/v1/FinancialReports/trialbalance      fromMonth · toMonth (yyyyMM) · isShowSubAccount
 *   GET /api/v1/FinancialReports/generalledger     fromDate · toDate (yyyyMMdd · ช่วงสั้นกว่า 1 ปี)
 *                                                  · accountCode (บังคับ) · isShowSubAccount
 *   GET /api/v1/DailyJournals                      code · id · limit · page (หน้าละ 10) · getResult
 *
 *  🔴 สิ่งที่ "ยังไม่รู้" และไฟล์นี้มีไว้เพื่อหาคำตอบ
 *   ① กุญแจ PEAK ของเรามีสิทธิ์เรียก 4 เส้นนี้ไหม (เครื่องที่เขียนโค้ดยิง PEAK ไม่ได้)
 *   ② PEAK ตอบกลับมาหน้าตาอย่างไร — เอกสารไม่ได้แสดงตัวอย่างคำตอบไว้เลยสักเส้น
 *   ⇒ รอบนี้ **ไม่ตีความตัวเลขใด ๆ** และ **ไม่นำไปคิดในรายงาน**
 *     แค่ถาม แล้วกางให้เห็นว่า PEAK ส่งกล่องอะไร ช่องชื่ออะไร ค่าอะไร (ของจริงตามที่ส่งมา)
 *     รอบถัดไปจึงค่อยต่อเข้า Cash Flow ด้วยชื่อช่องจริง ไม่ใช่ชื่อที่เดา
 *
 *  🔒 กฎเหล็กของพี่เอ
 *   · "ในส่วนของ peak ดึงข้อมูลมาใช้อย่างเดียว ห้ามให้ peak update data ใดๆ"
 *     ⇒ ทุกคำขอออกทาง peak.get() / peak.getOnce() ซึ่งฝัง GET ไว้ตายตัว + ผ่านด่าน ALLOW
 *   · ไม่เขียนตารางข้อมูลใด ๆ — จดแค่ "สรุปผลทดสอบล่าสุด" ลง app.peak_state (ไม่มีตัวเลขเงิน)
 *   · ผลที่ส่งออกนอกเซิร์ฟเวอร์ผ่าน peak.redactDeep ทุกครั้ง
 * ═══════════════════════════════════════════════════════════════════ */
const peak = require('./peak');
const { todayTH } = require('./thai-date');

const clean = s => String(s == null ? '' : s).trim();
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

/* ชื่อเส้นทางตามเอกสาร PEAK (ตัวพิมพ์ตามเอกสาร · ด่าน ALLOW ของ core/peak.js รู้จักครบทุกตัว) */
const EP = {
  coa: 'DailyJournals/accountcode',
  tb: 'FinancialReports/trialbalance',
  gl: 'FinancialReports/generalledger',
  dj: 'DailyJournals',
};
const STATE_KEY = 'ledger_probe';
/* จำนวนแถวตัวอย่างสูงสุดต่อกล่องที่ส่งกลับไปหน้าจอ (ของจริงอาจมากกว่า — บอกจำนวนจริงไว้เสมอ) */
const CAP = { conn: 0, coa: 800, tb: 800, gl: 80, dj: 10 };
const KEEP_MS = 6 * 3600 * 1000;
const RAW_HEAD = 3000;

/* ── เดือนที่จะถาม ───────────────────────────────────────────────── */
function lastDoneYm(now) {
  const t = todayTH(now || new Date());
  let y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7)) - 1;
  if (m < 1) { m = 12; y--; }
  return y + '-' + String(m).padStart(2, '0');
}
/** รับ 'YYYY-MM' หรือ 'YYYYMM' (พ.ศ. ก็ได้) → รูปที่ PEAK ต้องการ · ไม่ส่งมา = เดือนล่าสุดที่จบแล้ว */
function monthArg(v, now) {
  const m = clean(v).match(/^(\d{4})-?(\d{2})$/);
  let y = 0, mo = 0, given = false;
  if (m) { y = Number(m[1]); mo = Number(m[2]); if (y > 2400) y -= 543; given = true; }
  if (!(mo >= 1 && mo <= 12) || y < 2015 || y > 2100) {
    const d = lastDoneYm(now); y = Number(d.slice(0, 4)); mo = Number(d.slice(5, 7)); given = false;
  }
  const p = String(mo).padStart(2, '0');
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { ym: y + '-' + p, peak: '' + y + p, from: '' + y + p + '01',
           to: '' + y + p + String(lastDay).padStart(2, '0'), given };
}
/** รหัสบัญชีที่ผู้ใช้กรอก — คั่นด้วยจุลภาค/เว้นวรรค · รับไม่เกิน 3 รหัส · ตัวอักษรที่ปลอดภัยเท่านั้น */
function acctArg(v) {
  const out = [];
  for (const x of String(v == null ? '' : v).split(/[\s,;]+/).map(clean)) {
    if (!/^[0-9A-Za-z][0-9A-Za-z.\-]{0,19}$/.test(x)) continue;
    if (out.indexOf(x) < 0) out.push(x);
    if (out.length >= 3) break;
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════
 *  กางโครงคำตอบ — "PEAK ส่งกล่องอะไรมาบ้าง" โดยไม่เดาชื่อกล่อง
 *
 *  กล่อง = อาเรย์ของอ็อบเจกต์ · ชื่อกล่องคือทางเดินจากราก โดยแทนเลขลำดับด้วย []
 *  เช่น  PeakGeneralLedger.accounts[]  และ  PeakGeneralLedger.accounts[].transactions[]
 *  กล่องที่ซ้อนอยู่ในหลายแถวของกล่องแม่ ถูกนับรวมเป็นกล่องเดียว (จำนวนแถว = ทุกแถวรวมกัน)
 * ═══════════════════════════════════════════════════════════════════ */
function boxesOf(j) {
  const map = new Map();
  let budget = 40000;
  (function walk(v, p, d) {
    if (!v || typeof v !== 'object' || d > 9 || budget-- <= 0) return;
    if (Array.isArray(v)) {
      const objs = v.filter(isObj);
      if (!objs.length) return;
      const pp = (p || '(ราก)') + '[]';
      let b = map.get(pp);
      if (!b) { b = { path: pp, n: 0, rows: [] }; map.set(pp, b); }
      b.n += objs.length;
      for (const o of objs) { if (b.rows.length < 2000) b.rows.push(o); walk(o, pp, d + 1); }
      return;
    }
    for (const k of Object.keys(v)) walk(v[k], p ? p + '.' + k : k, d + 1);
  })(j, '', 0);
  return [...map.values()];
}

const SECRET_RE = /token|key|secret|signature|password|passwd|credential/i;
const short = v => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v;
  return v;
};
/** ค่าที่อยู่นอกกล่อง (หัวคำตอบ) — ชื่อช่อง + ค่า · อาเรย์บอกแค่จำนวนแถว */
function headOf(j) {
  const out = [];
  (function walk(v, p, d) {
    if (out.length >= 40 || d > 5) return;
    if (v === null || typeof v !== 'object') {
      /* 🔒 ช่องที่ชื่อบอกว่าเป็นความลับ ไม่ส่งค่าออกไป (กติกาเดียวกับ peak.redactDeep) */
      out.push({ k: p || '(ค่า)', v: SECRET_RE.test(p.split('.').pop() || '') ? '«ซ่อนไว้»' : short(v) });
      return;
    }
    if (Array.isArray(v)) {
      out.push({ k: p + '[]', v: v.some(isObj) ? (v.length + ' แถว') : short(JSON.stringify(v)) });
      return;
    }
    for (const k of Object.keys(v)) walk(v[k], p ? p + '.' + k : k, d + 1);
  })(j, '', 0);
  return out;
}
/** 1 แถว → ช่องแบน ๆ (อ็อบเจกต์ซ้อนกลายเป็น a.b · อาเรย์ซ้อนบอกแค่จำนวน เพราะถูกกางเป็นกล่องแยกแล้ว) */
function flatRow(o) {
  const out = {};
  let n = 0;
  (function walk(v, p, d) {
    if (n >= 60) return;
    if (v === null || typeof v !== 'object') { out[p] = short(v); n++; return; }
    if (Array.isArray(v)) {
      out[p + '[]'] = v.some(isObj) ? (v.length + ' แถว') : short(JSON.stringify(v)); n++;
      return;
    }
    if (d >= 3) { out[p + '{}'] = '…'; n++; return; }
    for (const k of Object.keys(v)) walk(v[k], p ? p + '.' + k : k, d + 1);
  })(o, '', 0);
  return out;
}
/** ช่องทั้งหมดที่พบในแถวตัวอย่าง + ชนิดของค่า (ไว้อ่านโครง ไม่ได้ใช้คิดเลข) */
function fieldsOf(flatRows) {
  const order = [], st = {};
  for (const r of flatRows) for (const k of Object.keys(r)) {
    if (!st[k]) { st[k] = { num: 0, txt: 0, bool: 0, empty: 0 }; order.push(k); }
    const v = r[k];
    if (v === '' || v === null || v === undefined) st[k].empty++;
    else if (typeof v === 'number') st[k].num++;
    else if (typeof v === 'boolean') st[k].bool++;
    else st[k].txt++;
  }
  return order.map(k => {
    const s = st[k], kinds = [s.num && 'ตัวเลข', s.txt && 'ข้อความ', s.bool && 'จริง/เท็จ'].filter(Boolean);
    return { k, type: kinds.length ? kinds.join('+') : 'ว่างทุกแถว', filled: s.num + s.txt + s.bool };
  });
}

/* ── หา "ช่องที่น่าจะเป็นรหัสบัญชี / ชื่อบัญชี" ───────────────────────
 *  🔴 ใช้เพื่อ ① เลือกรหัสตัวอย่างไปถามบัญชีแยกประเภท ② ชี้ให้คนดูว่าช่องไหน
 *     **ไม่ได้ใช้คิดตัวเลขใด ๆ** และหน้าจอเขียนกำกับไว้ว่า "ระบบเดาเพื่อเลือกตัวอย่าง" */
const CODE_RE = /^\d{4,10}([.\-]\d{1,6})?$/;
/* ค่า 8 หลักที่อ่านเป็นวันที่ได้ (yyyyMMdd) ไม่ใช่รหัสบัญชี — PEAK ส่งวันที่มาในรูปนี้ */
const isYmd = v => { const m = String(v).match(/^(19|20)\d\d(\d\d)(\d\d)$/); return !!m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31; };
function codeCol(flatRows) {
  const cnt = {};
  for (const r of flatRows) for (const k of Object.keys(r)) {
    const v = r[k];
    if (/date|time/i.test(k)) continue;
    if ((typeof v === 'string' || typeof v === 'number') && CODE_RE.test(String(v)) && !isYmd(v)) cnt[k] = (cnt[k] || 0) + 1;
  }
  let best = '', bn = 0;
  for (const k of Object.keys(cnt)) {
    const n = cnt[k] + (/code/i.test(k) ? flatRows.length : 0);      /* ชื่อช่องมีคำว่า code ได้เปรียบ */
    if (n > bn) { bn = n; best = k; }
  }
  return best && cnt[best] >= Math.max(1, Math.ceil(flatRows.length * 0.5)) ? best : '';
}
function nameCol(flatRows, skip) {
  const cnt = {};
  for (const r of flatRows) for (const k of Object.keys(r)) {
    if (k === skip) continue;
    const v = r[k];
    if (typeof v === 'string' && v.length >= 3 && /[฀-๿a-zA-Z]/.test(v) && !CODE_RE.test(v)) cnt[k] = (cnt[k] || 0) + 1;
  }
  let best = '', bn = 0;
  for (const k of Object.keys(cnt)) {
    const n = cnt[k] + (/name/i.test(k) ? flatRows.length : 0);
    if (n > bn) { bn = n; best = k; }
  }
  return best;
}
const BANK_RE = /ธนาคาร|เงินฝาก|ออมทรัพย์|กระแสรายวัน|bank|saving/i;
/**
 * เลือกรหัสตัวอย่างไปถามบัญชีแยกประเภท จากงบทดลอง (ถ้าไม่มีใช้ผังบัญชี)
 *   · หมวดค่าใช้จ่าย (ผังบัญชีมาตรฐานไทย: รหัสขึ้นต้นด้วย 5) ไม่เกิน 2 รหัส — เอาตัวที่ตัวเลขมากที่สุดก่อน
 *   · บัญชีธนาคาร/เงินฝาก (รหัสขึ้นต้นด้วย 1 และชื่อบอกว่าเป็นธนาคาร) 1 รหัส
 * @return {Array<{code, kind:'exp'|'bank', why}>}
 */
function pickGl(tbRows, coaRows) {
  const src = (tbRows && tbRows.length) ? tbRows : (coaRows || []);
  if (!src.length) return [];
  const cc = codeCol(src);
  if (!cc) return [];
  const nc = nameCol(src, cc);
  const from = (tbRows && tbRows.length) ? 'งบทดลอง' : 'ผังบัญชี';
  /* "ความเคลื่อนไหว" = ผลรวมค่าสัมบูรณ์ของช่องตัวเลขในแถว — ใช้เรียงว่ารหัสไหนน่าจะมีรายการให้ดูมากที่สุด
   *  (ไม่ได้ตีความว่าช่องไหนคือเดบิต/เครดิต และไม่ได้เอาไปคิดเลขอะไรต่อ) */
  const act = r => Object.keys(r).reduce((t, k) => t + (k !== cc && typeof r[k] === 'number' ? Math.abs(r[k]) : 0), 0);
  const seen = new Set(), exp = [], bank = [];
  const sorted = src.map((r, i) => ({ r, i, a: act(r) })).sort((x, y) => (y.a - x.a) || (x.i - y.i)).map(x => x.r);
  for (const r of sorted) {
    const c = String(r[cc] == null ? '' : r[cc]);
    if (!CODE_RE.test(c) || seen.has(c)) continue;
    seen.add(c);
    const nm = nc ? clean(r[nc]) : '';
    if (c.charAt(0) === '5' && exp.length < 2)
      exp.push({ code: c, kind: 'exp', why: 'รหัสหมวดค่าใช้จ่าย (ขึ้นต้นด้วย 5) จาก' + from + (nm ? ' — ' + nm : '') });
    else if (c.charAt(0) === '1' && BANK_RE.test(nm) && bank.length < 1)
      bank.push({ code: c, kind: 'bank', why: 'บัญชีธนาคาร/เงินฝาก จาก' + from + (nm ? ' — ' + nm : '') });
  }
  return exp.concat(bank);
}

/** PEAK ตอบว่าอย่างไร (resCode · resDesc) — ไว้โชว์เวลาตอบสำเร็จแต่ไม่มีแถว */
function saidOf(j) {
  const c = clean(peak.dig(j, ['resCode', 'responseCode', 'resultCode', 'statusCode']));
  const d = clean(peak.dig(j, ['resDesc', 'responseDesc', 'resultDesc', 'message', 'errorMessage']));
  return [c, d].filter(Boolean).join(' · ').slice(0, 200);
}

function boxView(b, cap, tag) {
  const flat = b.rows.map(flatRow);
  /* ป้าย "น่าจะเป็นรหัสบัญชี" ติดเฉพาะผังบัญชี/งบทดลอง (ที่ใช้เลือกรหัสตัวอย่าง) — กล่องอื่นไม่ติด กันชี้ผิดช่อง */
  const cc = tag ? codeCol(flat) : '';
  return { path: b.path, n: b.n, fields: fieldsOf(flat), codeCol: cc, nameCol: cc ? nameCol(flat, cc) : '',
           rows: flat.slice(0, cap), more: Math.max(0, b.n - Math.min(flat.length, cap)), _flat: flat };
}

const isBudgetErr = m => /เกิน \d+ คำขอในหนึ่งนาที/.test(m);
/* คำที่แปลว่า "PEAK ไม่ให้/ทำไม่ได้" ในข้อความตอบ — ชุดเดียวกับ core/peak.js resBad() + คำว่า permission */
const BAD_RE = /invalid|error|fail|denied|not allow|expired|unauthor|forbidden|exceed|permission/i;

/* ── ถาม PEAK 1 เส้น — ไม่โยน error ออกไป (ทุกผลกลายเป็นแถวในตารางให้พี่เอเห็น) ── */
async function one(ctx, step, title, ep, params, extra) {
  const S = Object.assign({ step, title, ep, params: params || {}, ok: false, err: '', said: '',
                            ms: 0, n: 0, boxes: [], head: [] }, extra || {});
  const t0 = Date.now();
  /* 🔴 เบรกคำขอ/นาที ตัวเดียวกับตัวดึงรายจ่าย — ปุ่มนี้ไม่มีสิทธิ์แซงคิวใคร */
  let gate = true;
  try { gate = await require('./peak-expenses').rateGate(15000); } catch (e) { gate = true; }
  if (!gate) {
    S.err = 'โควตาคำขอ PEAK ต่อนาทีเต็ม (ตัวดึงรายจ่ายกำลังใช้อยู่) — รอ 1 นาทีแล้วกดใหม่';
    S.paused = true; ctx.paused = true;
    return S;
  }
  ctx.sent++;
  try {
    let j;
    if (step === 'conn') j = await peak.get(ep, params || {}, ctx.biz);     /* ทางปกติ — กุญแจเก่าก็ต่ออายุให้ตามกติกาเดิม */
    else {
      /* 🔴 เส้นทางที่ "อาจไม่มีสิทธิ์" ต้องถามด้วย getOnce — ห้ามให้คำตอบ 401/403 ไปสั่งขอกุญแจใหม่
       *   (PEAK ให้ขอ 1 ครั้ง/65 วิ ⇒ ตัวซิงก์ทั้งระบบสะดุด และข้อความจริงของ PEAK หาย) */
      const a = await peak.getOnce(ep, params || {}, ctx.biz);
      S.http = a.status;
      const said = a.json ? saidOf(a.json) : '';
      if (a.status >= 300)
        throw new Error('PEAK ตอบ HTTP ' + a.status + (said ? ' — ' + said : (a.text ? ' — ' + a.text.slice(0, 300) : '')));
      if (!a.json) throw new Error('PEAK ตอบ HTTP ' + a.status + ' แต่อ่านเป็นข้อมูลไม่ได้ — ' + String(a.text || '').slice(0, 200));
      if (BAD_RE.test(said)) throw new Error('PEAK ตอบว่า "' + said + '"');
      j = a.json;
    }
    ctx.okN++;
    S.ok = true;
    S.said = saidOf(j);
    const cap = CAP[step] === undefined ? 50 : CAP[step];
    if (cap > 0) {
      const B = boxesOf(j).sort((a, b) => b.n - a.n).slice(0, 4).map(b => boxView(b, cap, step === 'coa' || step === 'tb'));
      S.n = B.length ? B[0].n : 0;
      S.boxes = B;
      S.head = headOf(j);
      /* ต้นคำตอบดิบ (ตัดสั้น) — ไว้ยืนยันโครงจริง เผื่อ PEAK ส่งรูปที่ตัวกางกล่องอ่านไม่ออก */
      const raw = JSON.stringify(j);
      S.size = raw.length;
      S.rawHead = raw.slice(0, RAW_HEAD);
    } else S.n = peak.listOf(j).length;
  } catch (e) {
    const m = String((e && e.message) || e);
    if (isBudgetErr(m)) { S.paused = true; ctx.paused = true; } else ctx.errN++;
    S.err = m.slice(0, 600);                       /* 🔒 core/peak.js ลบความลับให้แล้วก่อนถึงมือเรา */
  }
  S.ms = Date.now() - t0;
  return S;
}
const mainRows = S => (S && S.ok && S.boxes && S.boxes[0] && S.boxes[0]._flat) || [];

async function probeBiz(BZ, M, codes) {
  const ctx = { biz: BZ, sent: 0, okN: 0, errN: 0, paused: false };
  const R = { biz: BZ, verdict: 'no', verdictTh: '', steps: [], glNote: '', sent: 0, okN: 0, errN: 0 };
  const done = () => { R.sent = ctx.sent; R.okN = ctx.okN; R.errN = ctx.errN; return R; };

  /* ⓪ การเชื่อมต่อปกติไหม — แยก "กุญแจ/การเชื่อมต่อเสีย" ออกจาก "PEAK ไม่เปิดสิทธิ์ส่วนนี้"
   *   ถามด้วยเส้นที่ระบบใช้อยู่ทุกวัน (ใบเสร็จ 1 ใบ) · ไม่เก็บ ไม่ส่งข้อมูลใบเสร็จกลับไปหน้าจอ */
  const c0 = await one(ctx, 'conn', 'การเชื่อมต่อ PEAK ของกิจการนี้ (ถามใบเสร็จ 1 ใบ)', 'Receipts', { limit: 1, page: 1 });
  R.steps.push(c0);
  if (!c0.ok) {
    R.verdict = c0.paused ? 'wait' : 'conn';
    R.verdictTh = c0.paused ? '⏳ โควตาคำขอ PEAK เต็ม — รอ 1 นาทีแล้วกดใหม่'
      : '🔴 เชื่อมต่อ PEAK ของกิจการนี้ไม่ได้ตั้งแต่ขั้นแรก — ยังบอกไม่ได้ว่าดึงงบทดลองได้ไหม (ไม่เกี่ยวกับสิทธิ์งบทดลอง)';
    return done();
  }

  const coa = await one(ctx, 'coa', 'ผังบัญชี — รายชื่อรหัสบัญชีทั้งหมด', EP.coa, {});
  R.steps.push(coa);
  const tb = await one(ctx, 'tb', 'งบทดลอง เดือน ' + M.ym, EP.tb, { fromMonth: M.peak, toMonth: M.peak });
  R.steps.push(tb);

  /* ③ บัญชีแยกประเภท — ต้องระบุรหัสบัญชี (PEAK บังคับ) */
  const picks = codes.length
    ? codes.map(c => ({ code: c, kind: 'user', why: 'รหัสที่กรอกมา' }))
    : pickGl(mainRows(tb), mainRows(coa));
  if (!picks.length)
    R.glNote = 'ระบบยังเลือกรหัสบัญชีตัวอย่างเองไม่ได้ (ไม่พบช่องที่เป็นรหัสบัญชีในคำตอบของผังบัญชี/งบทดลอง) — ' +
               'กรอกรหัสบัญชีในช่อง "รหัสบัญชี" แล้วกดทดสอบอีกครั้ง';
  let gotExp = false;
  const gls = [];
  for (const p of picks) {
    if (ctx.paused) break;
    if (p.kind === 'exp' && gotExp) continue;       /* รหัสค่าใช้จ่ายตัวแรกได้แถวแล้ว ไม่ต้องถามตัวที่สอง */
    const g = await one(ctx, 'gl', 'บัญชีแยกประเภท รหัส ' + p.code + ' · ' + M.from + '–' + M.to, EP.gl,
      { fromDate: M.from, toDate: M.to, accountCode: p.code }, { acct: p.code, kind: p.kind, why: p.why });
    if (g.ok && g.n > 0 && p.kind === 'exp') gotExp = true;
    gls.push(g); R.steps.push(g);
  }

  if (!ctx.paused) R.steps.push(await one(ctx, 'dj', 'สมุดรายวัน — 10 ใบแรก', EP.dj, { page: 1, limit: 10 }));

  const glOk = gls.some(g => g.ok && g.n > 0);
  if (ctx.paused) { R.verdict = 'wait'; R.verdictTh = '⏳ โควตาคำขอ PEAK เต็มระหว่างทดสอบ — ผลยังไม่ครบ รอ 1 นาทีแล้วกดใหม่'; }
  else if (tb.ok && tb.n > 0 && glOk) { R.verdict = 'yes'; R.verdictTh = '✅ PEAK ให้ดึงงบทดลอง และบัญชีแยกประเภทตามรหัสบัญชีได้'; }
  else if (tb.ok && tb.n > 0) {
    R.verdict = 'tb';
    R.verdictTh = '🟡 PEAK ให้ดึงงบทดลองได้ · บัญชีแยกประเภท' +
      (gls.length ? (gls.some(g => g.ok) ? 'ตอบสำเร็จแต่ไม่มีแถวของรหัสที่ลอง' : 'ยังดึงไม่ได้') : 'ยังไม่ได้ลอง (ไม่มีรหัสบัญชีตัวอย่าง)');
  } else if (glOk) { R.verdict = 'gl'; R.verdictTh = '🟡 PEAK ให้ดึงบัญชีแยกประเภทได้ · งบทดลอง' + (tb.ok ? 'ตอบสำเร็จแต่ไม่มีแถว' : 'ยังดึงไม่ได้'); }
  else if (tb.ok) { R.verdict = 'empty'; R.verdictTh = '🟡 PEAK ตอบงบทดลองสำเร็จแต่ไม่มีแถว — ดูโครงคำตอบและข้อความจาก PEAK ด้านล่าง'; }
  else { R.verdict = 'no'; R.verdictTh = '🔴 การเชื่อมต่อปกติ แต่ PEAK ไม่ให้ดึงงบทดลอง — ดูข้อความจาก PEAK ด้านล่าง'; }
  return done();
}

/* ── ตัดของที่ใช้ภายในออกก่อนส่งกลับ ── */
function strip(R) {
  for (const b of R.biz) for (const s of b.steps) for (const x of (s.boxes || [])) delete x._flat;
  return R;
}
/** สรุปสั้น ๆ ที่จดลง app.peak_state — ไม่มีแถวข้อมูล ไม่มีตัวเลขเงิน */
function summaryOf(R) {
  return { at: R.at, by: R.by, month: R.month, anyYes: R.anyYes,
    biz: R.biz.map(b => ({ biz: b.biz, verdict: b.verdict, verdictTh: b.verdictTh,
      steps: b.steps.map(s => ({ step: s.step, title: s.title, ok: s.ok, n: s.n, acct: s.acct || '',
        err: String(s.err || '').slice(0, 200) })) })) };
}

let _busy = false;
let _last = null;

/**
 * ลองถาม PEAK — กดจากเมนู Cash Flow (ผู้ดูแลระบบ)
 * @param {{biz?:string, month?:string, acct?:string, by?:string}} o
 */
async function probe(o) {
  const a = o || {};
  const want = clean(a.biz);
  if (want && peak.bizAll().indexOf(want) < 0) return { ok: false, msg: 'ไม่รู้จักกิจการ "' + want + '"' };
  const LIST = (want ? [want] : peak.configuredList()).filter(b => peak.isConfigured(b));
  if (!LIST.length) return { ok: false, msg: 'ยังไม่มีกิจการไหนตั้งค่าเชื่อมต่อ PEAK ครบ' };
  if (_busy) return { ok: false, msg: 'กำลังทดสอบอยู่ — รอให้จบก่อนแล้วค่อยกดใหม่' };
  _busy = true;
  try {
    const M = monthArg(a.month);
    const codes = acctArg(a.acct);
    const out = [];
    for (const BZ of LIST) out.push(await probeBiz(BZ, M, codes));
    const R = peak.redactDeep(strip({ ok: true, full: true, at: new Date().toISOString(), by: clean(a.by).slice(0, 60),
      month: M.ym, from: M.from, to: M.to, acct: codes, readOnly: true, used: false,
      endpoints: EP, biz: out, anyYes: out.some(b => b.verdict === 'yes') }));
    _last = { at: Date.now(), R };
    try { await require('./peak-queue').state(STATE_KEY, JSON.stringify(summaryOf(R))); }
    catch (e) { /* จดไม่ได้ไม่ใช่เหตุให้ผลทดสอบหาย — หน้าจอยังได้ผลเต็มจากคำตอบนี้ */ }
    return R;
  } finally { _busy = false; }
}

/**
 * ผลทดสอบครั้งล่าสุด — **ไม่ยิง PEAK**
 *   full:true  = ยังจำผลเต็มไว้ (ภายใน 6 ชม. และเซิร์ฟเวอร์ยังไม่ถูกเริ่มใหม่)
 *   full:false = เหลือแต่สรุป (อ่านจาก app.peak_state) · never:true = ยังไม่เคยทดสอบ
 */
async function last() {
  if (_last && Date.now() - _last.at < KEEP_MS) return _last.R;
  let raw = '';
  try { raw = await require('./peak-queue').state(STATE_KEY); } catch (e) { raw = ''; }
  if (!raw) return { ok: true, never: true };
  try { return Object.assign({ ok: true, full: false }, JSON.parse(raw)); }
  catch (e) { return { ok: true, never: true }; }
}

module.exports = {
  probe, last, EP, STATE_KEY, CAP,
  _t: { lastDoneYm, monthArg, acctArg, boxesOf, headOf, flatRow, fieldsOf, codeCol, nameCol, pickGl,
        saidOf, summaryOf, reset: () => { _last = null; _busy = false; } },
};
