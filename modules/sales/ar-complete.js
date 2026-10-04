'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/sales/ar-complete.js — 📷 รูปงานเสร็จ (Projects · Status Complete) บนการ์ดลูกหนี้ (รอบ 189)
 *
 *  ‼ พี่เอสั่ง 30 ก.ย. 69 (คำต่อคำ):
 *    "ในหน้า Card ลูกหนี้ … เพิ่มรูป project status complete ไปดึงรูปภาพที่จบงาน image complete
 *     จาก app project มานะ link กันด้วย รหัสงาน หรือ มีจุดที่ link อื่นทีดีกว่าก็ดูและแจ้งมา"
 *
 *  ── ใช้รูปไหน ────────────────────────────────────────────────────
 *   projects."Image Complete" = ช่อง "งานเสร็จ" ของแอป Projects (ภาพอัปเดตงานจากกราฟิก)
 *   ‼ เฉพาะใบงาน Status = Complete ตามที่สั่ง · หลายใบ = เอาที่ Complete ล่าสุดก่อน
 *   ‼ ไม่ถอยไปหยิบรูปช่องอื่นมาแทน (รูปตั้งต้น/ใบงาน ≠ รูปงานเสร็จ — ใส่แทนแล้วคนดูเข้าใจผิด)
 *     จบงานแล้วแต่ยังไม่มีรูป = บอกตรง ๆ ว่า "ยังไม่มีรูปงานเสร็จ"
 *
 *  ── link ด้วยอะไร (ตรวจแล้ว · ใช้กติกาเดียวกับรอบ 173 ตรวจรับเงิน) ──────
 *   · รหัสงานอย่างเดียวไม่พอ: projects.job_code เติมเฉพาะแถวยุคชีตเดิม · งานเปิดในแอปใหม่ช่องนี้ว่าง
 *     รหัสงานจริงอยู่ใน "ชื่อ Project" / "เลขที่ Slip ชำระเงิน" (เช่น "B2G2609/014 ป้าย…")
 *   · ดีกว่า = เลขเอกสาร IV/QO — ไม่ซ้ำกันเลย และใบงานส่วนใหญ่มีเลข IV ใน Slip/ชื่อ Project
 *   ⇒ ① เลข IV/QO (ใบแจ้งหนี้ PEAK · เลขที่ QO/IV · ใบเสนอราคา PEAK) ตรงกัน = แม่นสุด
 *     ② รหัสงาน (job_code + รหัสในชื่อ/Slip · รหัสย่อย X-1 = งานเดียวกับ X)
 *     IV ชี้ใบงานชัดแล้ว ใบงานอื่นที่ตรงแค่รหัสงานไม่เอามาปน
 *   ‼ ตัวแกะรหัส/เลข IV = ของกลางตัวเดิม (payment/saleslink → booking/paydoc) ไม่เขียนกติกาที่สอง
 *
 *  ── สิทธิ์ ──  ด่านเดียวกับการ์ดลูกหนี้ (ar-aging._arCanEdit) · ใบที่ไม่ใช่ของคนนี้ = ไม่ตอบ
 *  ‼ อ่านอย่างเดียว (total_sales · projects) — ไม่เขียนอะไรเลย
 * ═══════════════════════════════════════════════════════════════════ */
const db = require('../../core/db');
const AR = require('./ar-aging');
const SL = require('../payment/saleslink')._t;          /* keysOf · docsIn · codeVariants */
const PD = require('../booking/paydoc');
const { _pdKeyCode } = PD.HELPERS || PD;

const clean = s => String(s == null ? '' : s).trim();
const MAX_ROWS = 400;
const MAX_IMG = 4;                   /* รูปต่อใบงานสูงสุด */
const MEMO_MS = 10 * 60 * 1000;      /* รูปงานเสร็จไม่ค่อยเปลี่ยน — จำ 10 นาที */
const _memo = new Map();             /* key → { at, v } */

const qc = c => '"' + c + '"';
const orVal = v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const SALE_COLS = ['_row', 'Sales Code', 'Create By', 'รหัสงาน', 'เลขที่ QO / IV', 'เลขใบแจ้งหนี้ Peak', 'เลขที่ใบเสนอราคา PEAK', 'ชื่อบริษัท',
  'ชื่อลูกค้า PEAK', 'สถานะซิงก์ PEAK', 'บริษัทที่ขาย'];   /* 🔴 รอบ 226 — ชื่อเจ้าของใบใน PEAK · ใบถูกยกเลิกไหม · กิจการ (ไว้ถาม PEAK) */
const SS_VOID = '🚫 เอกสารถูกยกเลิกใน PEAK';             /* = peak-sync SS.VOID (ยามเทียบให้ตรงกัน) */
const PROJ_COLS = ['ID', 'job_code', 'Project', 'Status', 'Complete', 'Image Complete', 'เลขที่ Slip ชำระเงิน', 'แสดงชื่อลูกค้า'];

/** "2026-09-28…" → "28/09/2026" */
function dmy(v) { const m = clean(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : clean(v); }
/** ช่องรูปมีได้หลายรูป (ขึ้นบรรทัด / จุลภาค) */
function rawsOf(v) { return clean(v).split(/[\n,]+/).map(clean).filter(Boolean).slice(0, MAX_IMG); }
/** ใบขาย 1 ใบ → คีย์ที่ใช้ค้น */
function saleKeys(r) {
  const docs = SL.docsIn([r['เลขใบแจ้งหนี้ Peak'], r['เลขที่ QO / IV'], r['เลขที่ใบเสนอราคา PEAK']].map(clean).join(' '));
  const code = _pdKeyCode(r['รหัสงาน']);
  return { docs, code, codes: code ? SL.codeVariants(code) : [], name: nameKey(r['ชื่อบริษัท']),   /* 🔴 รอบ 225 — name = ชื่อลูกค้าของใบขาย (ไว้ตรวจทาน) */
           /* 🔴 รอบ 226 — ชื่อเจ้าของใบแจ้งหนี้ตามที่ซิงก์จาก PEAK · ใบแจ้งหนี้ของใบขายนี้ถูกยกเลิกใน PEAK ไหม · ข้อความเลขเอกสารดิบ + กิจการ (ไว้ถาม PEAK) */
           peakName: nameKey(r['ชื่อลูกค้า PEAK']), ivVoid: clean(r['สถานะซิงก์ PEAK']) === SS_VOID,
           ivRaw: [r['เลขใบแจ้งหนี้ Peak'], r['เลขที่ QO / IV']].map(clean).join(' '), biz: clean(r['บริษัทที่ขาย']) };
}
/** รหัสใบงานกับรหัสขายเป็นงานเดียวกันไหม (X-1 = X) */
function sameJob(pc, sk) {
  if (!pc || !sk.code) return false;
  const pv = SL.codeVariants(pc);
  return sk.codes.some(c => pv.indexOf(c) >= 0) || pc.indexOf(sk.code + '-') === 0;
}

/* ═══ 🔴 รอบ 225 — ด่านตรวจทานชื่อลูกค้า (พี่เอ 3 ต.ค. 69 · คำต่อคำ):
 *   "Card ลูกหนี้ใบนี้ไม่มีการจองคิวช่างนะ แล้วไปเอาช่างที่ไหนมาใส่ ทำไมมั่วแบบนี้ ตรวจสอบความถูกต้องด่วนเลย
 *    Projectid : c54f6bb4 ที่ดึงมาเป็นของลูกค้าคนอื่น"
 *   เคสจริง: การ์ด บริษัท ดี ทรี จำกัด (B2E2609/019 · IV-2026092900011) ได้นัดดูหน้างานของใบงาน c54f6bb4
 *     ซึ่งเป็นของ บริษัท รมัย คอร์ป (ลูกค้าอีกราย)
 *   ต้นเหตุในโค้ด: การจับคู่ใบขาย → ใบงาน เชื่อ "ตัวหนังสือที่คนพิมพ์" อย่างเดียว (รหัสงาน / เลข IV ในชื่อ Project หรือช่อง Slip)
 *     ไม่เคยตรวจทานว่าใบงานนั้นเป็นของลูกค้ารายเดียวกันไหม ⇒ ใบงานไหนมีรหัส/เลขนี้ติดอยู่ (พิมพ์ผิด · เลือกผิดใบ · เลขซ้ำ)
 *     คิว/ช่าง/รูปของลูกค้าอีกรายขึ้นการ์ดทันที
 *   แก้: ใบงานที่จับคู่ได้ ต้อง "ไม่ขัดชื่อลูกค้า" กับใบขาย
 *     ใบขายมีชื่อ (ชื่อบริษัท) + ใบงานมีชื่อ (แสดงชื่อลูกค้า) + สองชื่อเป็นคนละรายชัดเจน ⇒ ไม่ใช้ใบงานนั้น ทั้งทางเลข IV และทางรหัสงาน
 *     ฝั่งไหนไม่มีชื่อ = ตรวจทานไม่ได้ ⇒ กติกาเดิม (ไม่ทำให้ของที่เคยขึ้นถูกหายไป)
 *   ‼ ชื่อใช้ "ค้าน" อย่างเดียว — ไม่ใช้ชื่อไปหาใบงาน (ห้ามเดาจากชื่อ · กติกาเดิมของ payment/saleslink)
 *   ‼ ไม่แสดง ดีกว่าแสดงของลูกค้าอีกราย — แต่ต้องบอกเหตุผลบนการ์ด (ar-install ส่ง clash ให้หน้าเว็บ) ไม่หายเงียบ */
const NAME_NOISE = /คอร์ปอเรชั่น|คอร์เปอเรชั่น|เอ็นจิเนียริ่ง|เอนจิเนียริ่ง|อินเตอร์เนชั่นแนล|เซอร์วิสเซส|เซอร์วิส|โฮลดิ้งส์|โฮลดิ้ง|เทรดดิ้ง|ประเทศไทย|ไทยแลนด์|กรุ๊ป|คอร์ป|สาขา|ร้าน|คุณ|corporation|international|engineering|holdings?|services?|trading|thailand|group/g;
/** ชื่อลูกค้า → คีย์เทียบ (ตัวพิมพ์เล็ก · ตัดคำว่า บริษัท/จำกัด/หจก. · ตัดเว้นวรรค วงเล็บ เครื่องหมาย · ตัดคำกลาง ๆ ที่หลายบริษัทใช้ร่วมกัน) */
function nameKey(v) {
  let s = clean(v).toLowerCase();
  if (!s) return '';
  s = s.replace(/ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ|บริษัท|จำกัด|มหาชน|หจก\.?|บจก\.?|บมจ\.?|หสน\.?|หสม\.?/g, ' ');
  s = s.replace(/\b(co\.?|company|ltd\.?|limited|inc\.?|corp\.?|plc\.?|part\.?)(?![a-z])/g, ' ');
  s = s.replace(/[^0-9a-z\u0E00-\u0E7F]+/g, '');
  const t = s.replace(NAME_NOISE, '');
  return t.length >= 2 ? t : s;
}
/** ตัวอักษรที่ตรงกันต่อเนื่องยาวสุด */
function lcsLen(a, b) {
  let best = 0, prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    prev = cur;
  }
  return best;
}
/** สองชื่อเป็นลูกค้ารายเดียวกันไหม → true | false | null (ฝั่งใดฝั่งหนึ่งไม่มีชื่อ = บอกไม่ได้)
 *  ตรงกัน · ชื่อหนึ่งอยู่ในอีกชื่อ · ตรงกันต่อเนื่อง ≥ ครึ่งของชื่อที่สั้นกว่า (อย่างน้อย 3 ตัว — ทนพิมพ์ตก/สะกดต่างเล็กน้อย) */
function sameCustomer(a, b) {
  if (!a || !b) return null;
  if (a === b) return true;
  const sh = a.length <= b.length ? a : b, lg = sh === a ? b : a;
  if (sh.length >= 2 && lg.indexOf(sh) >= 0) return true;
  return lcsLen(a, b) >= Math.max(3, Math.ceil(0.5 * sh.length));
}
/** ใบงานนี้ "ขัดชื่อลูกค้า" กับใบขายไหม (true = เป็นของลูกค้าอีกรายชัดเจน) */
function custClash(k, x) {
  const names = k ? [k.name, k.peakName].filter(Boolean) : [];   /* 🔴 รอบ 226 — ชื่อที่เซลส์คีย์ + ชื่อเจ้าของใบใน PEAK (ตรงตัวใดตัวหนึ่งก็ไม่ขัด) */
  if (!names.length) return false;
  const pn = nameKey(x.p['แสดงชื่อลูกค้า']);
  if (!pn) return false;                                   /* ใบงานไม่มีชื่อลูกค้า = ตรวจทานไม่ได้ ⇒ กติกาเดิม */
  if (names.some(n => sameCustomer(n, pn) !== false)) return false;
  const pj = nameKey(x.p.Project);
  if (names.some(n => n.length >= 3 && pj.indexOf(n) >= 0)) return false;   /* ชื่อลูกค้าของใบขายอยู่ในชื่อ Project */
  return true;
}

/**
 * 🔴 รอบ 203 — เลือกใบงานของใบขาย 1 ใบ (ใช้ร่วมกับ ar-install.js — กติกาเดียวทั้งสองกล่อง)
 *   พี่เอ 1 ต.ค. 69: "ตรวจสอบด่วนเลย ภาพหน้างานที่เอามาลง ส่วนงานติดตั้ง ที่ถูกต้องคือของ บริษัท มีคลาส นะ ไม่ใช่ pet club"
 *   ต้นเหตุ: ใบงาน c9725fc7 มีเลข IV ของบริษัท มีคลาส อยู่ใน Slip (มีคลาสจับด้วย IV ถูกแล้ว)
 *     แต่ใบขาย Pet Club ไม่มีเลขเอกสารตรงกับใบงานนี้ ⇒ ตกไปทางสำรอง "ตรงรหัสงาน" แล้วไปเจอใบงานเดียวกัน
 *     ⇒ รูปงานเสร็จ + คิวติดตั้ง + ภาพหน้างานของมีคลาส ไปโผล่บนการ์ด Pet Club ด้วย
 *   แก้: ทางสำรองรหัสงานใช้ได้เฉพาะใบงานที่ "ไม่มีเลข IV/QO ขัดกัน"
 *     ใบงานมีเลขเอกสาร และใบขายก็มีเลขเอกสาร แต่ไม่ตรงกันสักเลข = เป็นใบงานของเอกสารใบอื่น ⇒ ห้ามใช้
 *     (ไม่เจอ = ไม่แสดง ดีกว่าแสดงรูป/คิวของลูกค้าอีกราย)
 *   → { by:'iv'|'code', cand:[{p,pk}] } | null
 */
function pickProjects(projs, k) { return pickInfo(projs, k).pick; }
/** 🔴 รอบ 225 — ตัวเดียวกับ pickProjects แต่บอกด้วยว่า "ตัดใบงานไหนทิ้งเพราะชื่อลูกค้าขัดกัน"
 *   → { pick: {by,cand}|null, clash: [{ id, name, by }] } */
function pickInfo(projs, k, opt) {
  const clash = [];
  const trust = (opt && opt.trustIv) || null;     /* 🔴 รอบ 226 — เลข IV ที่ PEAK ยืนยันแล้วว่าไม่เคยถูกยกเลิก/ออกใหม่ ⇒ เชื่อเลข IV เป็นหลัก */
  const keep = (list, by) => list.filter(x => {
    const doc = by === 'iv' ? (x.pk.invs.find(d => k.docs.indexOf(d) >= 0) || '') : '';
    if (doc && trust && trust.has(doc)) return true;
    if (!custClash(k, x)) return true;
    clash.push({ id: clean(x.p.ID), name: clean(x.p['แสดงชื่อลูกค้า']).slice(0, 80), by, doc });
    return false;
  });
  const byIv = keep(projs.filter(x => x.pk.invs.some(d => k.docs.indexOf(d) >= 0)), 'iv');
  if (byIv.length) return { pick: { by: 'iv', cand: byIv }, clash };
  const byCode = keep(projs.filter(x => x.pk.codes.some(c => sameJob(c, k)) && !(k.docs.length && x.pk.invs.length)), 'code');
  return { pick: byCode.length ? { by: 'code', cand: byCode } : null, clash };
}

/* ═══ 🔴 รอบ 226 — เช็ค PEAK ก่อนเชื่อ/ไม่เชื่อ "เลข IV" ที่ติดอยู่บนใบงาน (พี่เอ 3 ต.ค. 69 · คำต่อคำ):
 *   "ส่วนที่ error ใน card ลูกหนี้เวลาไปดึง IV มา น่าจะมาจาก เราไม่ได้ sync กับ peak ก่อนว่า IV ใบนั้น ของลูกค้ารายนั้น
 *    มีการยกเลิกไปก่อนแล้วหรือเปล่า ถ้าถูกยกเลิก IV เลขเดียวกันจะถูก รายอื่นนำไปใช้ได้นะ ต้องเช็ค ตรงนี้ก่อน"
 *   เลข IV ตรงกัน แต่ชื่อลูกค้าของใบงานกับใบขายเป็นคนละราย ⇒ ถาม PEAK ว่าเลขนี้เคยถูกยกเลิกแล้วออกใหม่ไหม
 *     · ใบแจ้งหนี้ของใบขายเองถูกยกเลิก (ตราซิงก์ 🚫)            ⇒ ไม่ใช้ใบงานนั้น · เหตุผล void (ไม่ต้องถาม PEAK ซ้ำ)
 *     · PEAK: เลขนี้มีใบที่ถูกยกเลิก (ถูกออกใหม่ให้รายอื่น)      ⇒ ไม่ใช้ใบงานนั้น · เหตุผล void + ชื่อเจ้าของใบที่ยกเลิก/ใบปัจจุบัน
 *     · PEAK: เลขนี้มีใบเดียว ไม่เคยถูกยกเลิก                    ⇒ เลข IV เป็นหลัก (กติกาพี่เอ 20 ก.ย. 69) — ใช้ใบงานนั้นได้แม้ชื่อเขียนต่างกัน
 *     · ถาม PEAK ไม่สำเร็จ / ยังไม่ได้ตั้งกุญแจ / เป็นเลข QO     ⇒ ยังไม่รู้ ⇒ ไม่แสดง (ด่านชื่อของรอบ 225)
 *   ‼ ถามเฉพาะใบที่ "เลข IV ตรงแต่ชื่อขัด" เท่านั้น (ปกติไม่มี) · จำคำตอบ 10 นาทีใน peak-sync · รอไม่เกิน 6 วินาที
 *   ‼ GET อย่างเดียว ผ่าน peak-sync.ivHistory — ไม่มีการเขียนกลับ PEAK
 *   → รูปเดียวกับ pickInfo: { pick, clash:[{id,name,by:'iv'|'code'|'void', doc, why?, live?, voidNames?}] } */
const PEAK_WAIT_MS = 6000;
async function _ivHist(doc, k) {
  if (!/^IV/.test(doc)) return null;                       /* เลข QO/QT ไม่ถาม — กติกานี้เป็นเรื่องใบแจ้งหนี้ */
  try {
    const PS = require('./peak-sync');
    const ref = (PS.refsOf(k.ivRaw || '') || []).find(r => r.kind === 'IV' && r.ref.replace(/[^A-Z0-9]/g, '') === doc);
    const ask = PS.ivHistory(ref ? ref.ref : doc, k.biz);
    const late = new Promise(res => { const t = setTimeout(() => res(null), PEAK_WAIT_MS); if (t.unref) t.unref(); });
    return await Promise.race([ask, late]);
  } catch (e) { return null; }
}
async function pickChecked(projs, k) {
  let pi = pickInfo(projs, k);
  const ivDocs = [...new Set(pi.clash.filter(c => c.by === 'iv' && c.doc).map(c => c.doc))];
  if (!ivDocs.length) return pi;
  const note = {};                                         /* doc → ข้อมูลประกอบเหตุผล */
  const trust = new Set();
  for (const doc of ivDocs) {
    if (k.ivVoid) { note[doc] = { by: 'void', why: 'sale' }; continue; }
    const H = await _ivHist(doc, k);
    if (!H || !H.ok) { note[doc] = { ask: 'fail' }; continue; }
    if (H.reused) note[doc] = { by: 'void', why: 'reuse', live: H.live ? clean(H.live.name).slice(0, 80) : '',
                                voidNames: (H.voids || []).map(v => clean(v.name)).filter(Boolean).slice(0, 3) };
    else if (H.live && !(H.voids || []).length) trust.add(doc);
    else note[doc] = { ask: 'none' };                      /* PEAK ไม่รู้จักเลขนี้ / มีแต่ใบยกเลิก — ยืนยันไม่ได้ */
  }
  if (trust.size) pi = pickInfo(projs, k, { trustIv: trust });
  for (const c of pi.clash) { const n = c.doc && note[c.doc]; if (n) Object.assign(c, n); }
  return pi;
}

/* ═══ ⚡ รอบ 204 — พี่เอ 1 ต.ค. 69: "แก้ไข เรื่องการ sync data ภาพหน้างาน ช่างติดตั้ง วันที่ติดตั้ง มันช้ามาก
 *     ทำไมช้าแบบนี้ ไปดู code ใหม่เลย"
 *   ต้นเหตุ (วัดด้วย tools/test-ar-install-speed.js · 150 ใบ · ฐาน 120 ms · Drive 400 ms): 190 วินาที
 *   ① resolveAll เดิมแบ่งรูปชุดละ 12 แล้ว "ถาม Drive ทีละไฟล์ต่อกัน" ทุกรูปที่ยังไม่อยู่ในสารบัญ (img_index)
 *      ภาพหน้างาน/จบงาน 3–8 รูปต่อใบ × 150 ใบ = ถาม Drive 500 ครั้งเรียงคิว ⇒ ช้าที่สุด
 *   ② ค้นใบงานด้วย ilike ทีละก้อน "ต่อกัน" (ก้อนละ 24 เงื่อนไข) · สองกล่อง (รูปงานเสร็จ + งานติดตั้ง) ค้นซ้ำชุดเดียวกัน
 *   ③ ar-install อ่านตารางทีละขั้น ทั้งที่หลายขั้นไม่ต้องรอกัน
 *   แก้: ① สารบัญก่อนครั้งเดียว · ถาม Drive เฉพาะที่ยังไม่เจอ ≤ 12 ไฟล์ต่อคำขอ แบบขนาน · จำไฟล์ที่หาไม่เจอ 30 นาที
 *        ② ก้อนค้นใบงานยิงขนาน 6 ก้อน + ใช้ผลร่วมกันทั้งสองกล่อง (จำ 3 นาที · ยิงพร้อมกัน = ยิงครั้งเดียว)
 *        ③ ขั้นที่ไม่ต้องรอกันยิงพร้อมกัน · หน้าเว็บขอเป็นชุดละ 60 ใบ (การ์ดบนสุดขึ้นก่อน) */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return out;
}

async function readSales(rows) {
  const parts = [];
  for (let i = 0; i < rows.length; i += 100) parts.push(rows.slice(i, i + 100));
  const res = await pool(parts, 4, part => db.select('total_sales', {
    select: SALE_COLS.map(qc).join(','), _row: 'in.(' + part.join(',') + ')' }));
  return [].concat(...res.map(r => r || []));
}

/* ⚡ รอบ 204 — ก้อนค้นใบงาน: จำผล 3 นาที + ยิงพร้อมกันได้คำตอบเดียว (สองกล่องบนการ์ดใช้ร่วมกัน) */
const PROJ_MEMO_MS = 3 * 60 * 1000;
const _projMemo = new Map();          /* ก้อนเงื่อนไข → { at, p:Promise<rows> } */
/* ลืมก้อนที่ล้ม/เก่า — ‼ เขียนแบบนี้เพราะยาม test-ar-seeall กวาดหา ".delete(" (คำสั่งลบฐาน) ทั้งไฟล์ ไฟล์นี้อ่านอย่างเดียว */
const _forget = k => Map.prototype.delete.call(_projMemo, k);
function _projChunk(terms) {
  const key = terms.join(',');
  const m = _projMemo.get(key);
  if (m && Date.now() - m.at < PROJ_MEMO_MS) return m.p;
  const p = Promise.resolve(db.select('projects', { select: PROJ_COLS.map(qc).join(','), or: '(' + key + ')', limit: 2000 }))
    .then(r => r || [])
    .catch(e => { _forget(key); throw e; });
  _projMemo.set(key, { at: Date.now(), p });
  if (_projMemo.size > 400) { for (const k of _projMemo.keys()) { _forget(k); if (_projMemo.size <= 300) break; } }
  return p;
}

/* 🔧 รอบ 202 — ar-install.js ใช้ตัวค้นนี้ด้วย แต่ต้องได้ใบงานทุกสถานะ (anyStatus) · ค่าเดิม = Complete เท่านั้นเหมือนเดิม */
async function readProjects(keys, anyStatus) {
  const codes = new Set(), digits = new Set();
  for (const k of keys) {
    k.codes.forEach(c => codes.add(c));
    k.docs.forEach(d => { const dg = d.replace(/^\D+/, ''); if (dg.length >= 6) digits.add(dg); });
  }
  const terms = [];
  const ca = [...codes];
  for (let i = 0; i < ca.length; i += 30) terms.push('job_code.in.(' + ca.slice(i, i + 30).map(orVal).join(',') + ')');
  ca.forEach(c => { terms.push('Project.ilike.' + orVal('*' + c + '*')); terms.push(qc('เลขที่ Slip ชำระเงิน') + '.ilike.' + orVal('*' + c + '*')); });
  [...digits].forEach(d => { terms.push('Project.ilike.' + orVal('*' + d + '*')); terms.push(qc('เลขที่ Slip ชำระเงิน') + '.ilike.' + orVal('*' + d + '*')); });
  const seen = new Map();
  const chunks = [];
  for (let i = 0; i < terms.length; i += 24) chunks.push(terms.slice(i, i + 24));
  /* ⚡ รอบ 204 — ขนาน 6 ก้อน · ถามทุกสถานะครั้งเดียวแล้วคัด Complete เอง (ทั้งสองกล่องใช้ก้อนเดียวกัน) */
  const res = await pool(chunks, 6, _projChunk);
  for (const rows of res) for (const r of rows) {
    if (!anyStatus && clean(r.Status) !== 'Complete') continue;
    const id = clean(r.ID) || JSON.stringify(r); if (!seen.has(id)) seen.set(id, r);
  }
  return [...seen.values()];
}

/** รูปทั้งหมด → ลิงก์ (ตัวแปลงรูปของแอป Projects เอง)
 *  ⚡ รอบ 204: ① เปิดสารบัญ img_index ทีเดียวทุกรูป (ไม่ถาม Drive)
 *             ② ที่ยังไม่เจอ ถาม Drive ≤ FALLBACK_MAX (12) ไฟล์ต่อคำขอ แบ่ง 6 สายขนาน (เจอแล้วสารบัญจดให้เอง ครั้งหน้าเร็ว)
 *             ③ ไฟล์ที่ Drive หาไม่เจอ จำไว้ 30 นาที ไม่ถามซ้ำทุกครั้งที่เปิดหน้า
 *  ‼ เดิมถาม Drive ทีละไฟล์ต่อกันทุกรูปที่ไม่อยู่ในสารบัญ ⇒ 150 ใบ = 500 ครั้ง ≈ 3 นาที */
const MISS_MS = 30 * 60 * 1000;
const _imgMiss = new Map();
async function resolveAll(raws) {
  const IM = require('../projects/images');
  const per = Number(IM.FALLBACK_MAX) || 12;
  const list = [...new Set((raws || []).map(clean).filter(Boolean))];
  const out = {};
  if (!list.length) return out;
  let m = {};
  try { m = await IM.urlMap(list, { noFallback: true }) || {}; } catch (e) { m = {}; }
  for (const k of list) if (m[k]) out[k] = m[k];
  const now = Date.now();
  const ask = list.filter(r => !out[r] && !(_imgMiss.has(r) && now - _imgMiss.get(r) < MISS_MS)).slice(0, per);
  if (ask.length) {
    const lanes = Array.from({ length: Math.min(6, ask.length) }, () => []);
    ask.forEach((r, i) => lanes[i % lanes.length].push(r));
    await Promise.all(lanes.map(g => Promise.resolve(IM.urlMap(g)).then(mm => {
      for (const k of g) { if (mm && mm[k]) out[k] = mm[k]; else _imgMiss.set(k, now); }
    }).catch(() => {})));
    if (_imgMiss.size > 20000) _imgMiss.clear();
  }
  return out;
}
const small = u => String(u || '').replace(/([?&]sz=)w\d+/, '$1w480');

/**
 * 📷 arCompleteImages(user, rows) — แถว total_sales[] → { ok, map:{ row: {...} }, summary }
 *   map[row] = { by:'iv'|'code', projectId, project, complete, imgs:[{thumb,url}], nImg, more }
 *            | { by, projectId, project, complete, imgs:[], noImg:true }     (จบแล้วแต่ยังไม่มีรูป)
 *   ไม่พบใบงานที่ Complete = ไม่มีคีย์ของแถวนั้น
 */
async function arCompleteImages(user, rowsIn) {
  const t0 = Date.now();
  const rows = Array.from(new Set((Array.isArray(rowsIn) ? rowsIn : []).map(Number).filter(n => Number.isInteger(n) && n > 0))).slice(0, MAX_ROWS);
  const out = { ok: true, map: {}, summary: { asked: rows.length, iv: 0, code: 0, noImg: 0, none: 0, denied: 0 }, ms: 0 };
  if (!rows.length) return out;

  const prefix = await AR.prefixList();
  const sales = (await readSales(rows)).filter(r => {
    if (AR._arCanEdit(user, r, prefix)) return true;
    out.summary.denied++; return false;                 /* ไม่ใช่ใบของคนนี้ = ไม่ตอบ */
  });

  const now = Date.now();
  const need = [];
  for (const r of sales) {
    const k = saleKeys(r);
    const mk = r._row + '|' + k.code + '|' + k.docs.join(',') + '|' + k.name;
    const m = _memo.get(mk);
    if (m && now - m.at < MEMO_MS) { if (m.v) out.map[r._row] = m.v; continue; }
    need.push({ r, k, mk });
  }

  if (need.length) {
    const projs = (await readProjects(need.map(n => n.k))).map(p => ({ p, pk: SL.keysOf(p) }));
    projs.sort((a, b) => (clean(a.p.Complete) < clean(b.p.Complete) ? 1 : clean(a.p.Complete) > clean(b.p.Complete) ? -1 : 0));
    const pick = [];
    for (const n of need) {
      const pk = (await pickChecked(projs, n.k)).pick;   /* 🔴 รอบ 203 — ทางรหัสงานห้ามหยิบใบงานที่เลข IV/QO ขัดกัน · รอบ 225 ด่านชื่อ · รอบ 226 เช็ค PEAK ว่าเลข IV ถูกยกเลิก/ออกใหม่ไหม */
      if (!pk) { _memo.set(n.mk, { at: now, v: null }); continue; }
      const cand = pk.cand;
      const withImg = cand.find(x => rawsOf(x.p['Image Complete']).length);
      const x = withImg || cand[0];
      pick.push({ n, x, by: pk.by, raws: withImg ? rawsOf(x.p['Image Complete']) : [],
                  total: withImg ? clean(x.p['Image Complete']).split(/[\n,]+/).map(clean).filter(Boolean).length : 0 });
    }
    /* ⚡ รอบ 205 — ยกวิธีของ Job Card สั่งผลิต (loadImgs → getImageFileIds → CDN ของ Google)
     *   พี่เอ: "ไปดูวิธีดึงข้อมูลภาพจาก app Job card สั่งผลิตสิ ทำไมเค้าเร็ว"
     *   ⇒ ข้อมูลการ์ดตอบ "ค่าดิบของรูป" ทันที ไม่รอแปลงรูป · หน้าเว็บขอไอดีไฟล์แยกอีกคำขอ (GET /api/ar-aging/img-ids)
     *     แล้วโหลดรูปจาก lh3.googleusercontent.com/d/<id>=w400 เอง (เหมือนบอร์ด Job Card) */
    for (const q of pick) {
      const imgs = q.raws.map(r => ({ raw: r }));
      const v = { by: q.by, projectId: clean(q.x.p.ID), project: clean(q.x.p.Project).slice(0, 140),
                  complete: dmy(q.x.p.Complete), imgs, nImg: q.total, more: Math.max(0, q.total - imgs.length) };
      if (!imgs.length) v.noImg = true;
      _memo.set(q.n.mk, { at: now, v });
      out.map[q.n.r._row] = v;
    }
    for (const n of need) if (!out.map[n.r._row] && _memo.get(n.mk) && _memo.get(n.mk).v) out.map[n.r._row] = _memo.get(n.mk).v;
  }

  for (const r of sales) {
    const v = out.map[r._row];
    if (!v) out.summary.none++;
    else if (v.noImg) out.summary.noImg++;
    else out.summary[v.by]++;
  }
  out.ms = Date.now() - t0;
  return out;
}

module.exports = { arCompleteImages, _t: { saleKeys, sameJob, rawsOf, dmy, _memo, readSales, readProjects, resolveAll, small, pickProjects, pickInfo, pickChecked, nameKey, sameCustomer, custClash, SS_VOID, pool, _projMemo, _imgMiss } };
