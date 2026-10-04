'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  ตัวหาใบใน PEAK ต้องทำงานเหมือนแอปเก่าเป๊ะ — npm run test:peakmatch
 *
 *  พี่เอสั่ง 6 ก.ย. 69 (คำต่อคำ):
 *    "พี่ต้องการให้เรา ไปอ่าน code app ตัวเก่าพี่นะ เกี่ยวกับ การ sync peak
 *     ทั้งหมดให้ละเอียด แล้วเอามาใช้เลย ไม่ต้องคิดเอง มันทำไว้ดีแล้ว"
 *
 *  ไฟล์นี้จึงไม่ได้ทดสอบ "ไอเดียของอลิซ" แต่ทดสอบว่า
 *  พฤติกรรมของระบบใหม่ = พฤติกรรมของ Code.gs ทีละข้อ
 *
 *  ‼ ตัวปลอมของ PEAK ในไฟล์นี้ต้อง "ใจร้ายเท่าของจริง"
 *    · ยอมรับท่าค้นหาแค่ท่าเดียว ท่าอื่นคืน 0 แถวเงียบ ๆ (ไม่ error)
 *    · คืนใบที่เลขไม่ตรงปนมาด้วยได้
 *    · มีใบที่ถูกยกเลิก / ใบร่าง / เลขซ้ำ ปนอยู่จริง
 *    ตัวปลอมที่ใจดีกว่าของจริง = การันตีว่าจับบั๊กไม่ได้ (พลาดมาแล้ว 3 รอบ)
 * ═══════════════════════════════════════════════════════════════════ */

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = 'w'.repeat(64);

/* ─── ฐานข้อมูลปลอม — เก็บ "ท่าค้นหาที่ล็อกไว้" ไว้ในหน่วยความจำ ─── */
const STATE = {};
const dbPath = require.resolve('../core/db');
require(dbPath);
const keyOf = w => String(w.key || '').replace(/^eq\./, '');
require.cache[dbPath].exports = {
  one: async (t, p) => {
    if (t !== 'peak_state') return null;
    const k = keyOf(p);
    return STATE[k] === undefined ? null : { value: STATE[k] };
  },
  update: async (t, w, b) => {
    if (t !== 'peak_state') return [{ _row: 1 }];
    const k = keyOf(w);
    if (STATE[k] === undefined) return [];
    STATE[k] = b.value; return [{ key: k }];
  },
  insert: async (t, rows) => {
    if (t === 'peak_state') for (const r of rows) STATE[r.key] = r.value;
    return [{}];
  },
  select: async () => [], rpc: async () => null, remove: async () => [],
};

const peak = require('../core/peak');
const sync = require('../modules/sales/peak-sync');

/* ─── PEAK ปลอม ───────────────────────────────────────────────────
 *  ACCEPT = ท่าเดียวที่ PEAK ยอมรับ · ท่าอื่นได้ 0 แถวโดยไม่ error
 *  (นี่คือพฤติกรรมจริงที่ทำให้ทั้งระบบขึ้น "ไม่พบใน PEAK" ทั้งกระดาน) */
let ACCEPT = 'code', IVS = [], QTS = [], FAIL = '', NOISE = false;
const CALLS = [];
const norm = s => String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase();

peak.get = async (res, prm) => {
  const r = String(res).toLowerCase();
  CALLS.push({ res: r, prm: { ...prm } });
  if (FAIL) throw new Error(FAIL);
  const key = Object.keys(prm).find(k => k !== 'limit');
  if (key !== ACCEPT) return [];
  const want = norm(prm[key]);
  const src = r === 'quotations' ? QTS : r === 'invoices' ? IVS : [];
  const hit = src.filter(d => norm(d.code) === want || norm(d.reference) === want);
  /* PEAK คืนได้ถึง 20 ใบต่อคำขอ และเคยคืนใบที่เลขไม่ตรงมาด้วย */
  const noise = (NOISE && hit.length)
    ? [{ code: 'IV-9999999999999', contactName: 'ลูกค้าคนอื่น', netAmount: 999999,
         status: 'approved' }] : [];
  return hit.concat(noise);
};
peak.receipts = async () => [];
/* ‼ ต้อง "ตั้งกุญแจครบทุกกิจการ" เหมือนของจริง
 *   ถ้าตั้งไม่ครบ ระบบจะตอบ "รอ API อีกบริษัท" ทุกใบที่หาไม่เจอ ซึ่งถูกแล้ว
 *   แต่จะบังตาข้อ ⑭ (แยก "เคยเจอแล้วหาย" ออกจาก "ไม่เคยเจอ") ไปทั้งข้อ */
peak.configuredList = () => ['มดงานการป้าย', 'The 101'];
peak.isConfigured = () => true;
peak.sleep = async () => {};

const IV_OK = { code: 'IV-2026090100001', id: 'uuid-iv', netAmount: 10000,
                remainAmount: 10000, contactName: 'บริษัท ทดสอบ จำกัด',
                status: 'approved' };

const ROW = (over) => Object.assign({
  _row: 5, 'รหัสงาน': 'QW2609/001', 'ชื่อบริษัท': 'บริษัท ทดสอบ จำกัด',
  'เลขที่ QO / IV': 'IV-2026090100001', 'ยอดขาย (บาท)': 10000,
  'Lead Status': 'ปิดการขาย', 'บริษัทที่ขาย': 'มดงานการป้าย',
  'Create By': 'ปุ๊ก',
}, over || {});

const reset = () => {
  for (const k of Object.keys(STATE)) delete STATE[k];
  IVS = []; QTS = []; FAIL = ''; NOISE = false; ACCEPT = 'code'; CALLS.length = 0;
};

(async () => {
  /* ═══════════════════════════════════════════════════════════════
   *  ① ลองท่าค้นหาเองจนเจอ — ช่องว่างที่ใหญ่ที่สุดของระบบใหม่
   *    ระบบใหม่เดิมฝัง code= ตายตัว ถ้า PEAK รับแต่ reference=
   *    ทุกใบจะขึ้น "❓ ไม่พบใน PEAK" ทั้งกระดาน โดยไม่มี error ให้เห็นเลย
   * ═══════════════════════════════════════════════════════════════ */
  head('① PEAK รับแค่ reference= → ต้องลองเองจนเจอ (PK_PARAM.TRY)');
  reset(); ACCEPT = 'reference'; IVS = [IV_OK];
  const a = await sync.checkRow(ROW());
  ok(a.ss === sync.SS.OK, 'เจอใบแจ้งหนี้ ทั้งที่ท่าแรก (code=) ใช้ไม่ได้');
  ok(CALLS.some(c => 'code' in c.prm), '  ลองท่า code= ก่อนตามลำดับเดิม');
  ok(CALLS.some(c => 'reference' in c.prm), '  แล้วลองท่า reference= ต่อ');
  ok(STATE['pk_param_iv'] === 'reference', '‼ ล็อกท่าที่ใช้ได้ไว้ ใบถัดไปไม่ต้องลองใหม่');

  head('② ล็อกท่าไว้แล้ว = ยิงคำขอเดียว ไม่เสียคำขอเปล่า');
  CALLS.length = 0;
  const b = await sync.checkRow(ROW());
  ok(b.ss === sync.SS.OK, 'ยังเจอเหมือนเดิม');
  ok(CALLS.filter(c => c.res === 'invoices').length === 1, 'ถาม PEAK แค่ครั้งเดียว');

  head('③ ท่าที่ล็อกไว้ใช้ไม่ได้แล้ว → เปลี่ยนท่าให้เอง (v28.2 self-heal)');
  /* ‼ กฎของพี่เอ code.gs:9891 — "คีย์เลขลงช่อง QO/IV แล้วต้องเจอเสมอ
   *   ถ้าไม่เจอ = วิธีค้นหาผิด ไม่ใช่ข้อมูลไม่มี" */
  STATE['pk_param_iv'] = 'code';        /* ล็อกท่าผิดไว้ */
  ACCEPT = 'reference';
  const c = await sync.checkRow(ROW());
  ok(c.ss === sync.SS.OK, 'ยังเจอ — ไม่ยอมแพ้ตั้งแต่ท่าที่ล็อกไว้');
  ok(c.healed && c.healed.to === 'reference', '  รายงานว่าเปลี่ยนท่าให้แล้ว');
  ok(STATE['pk_param_iv'] === 'reference', '  และล็อกท่าใหม่ไว้ให้ใบถัดไป');

  /* ═══════════════════════════════════════════════════════════════
   *  ④ 🔒 v22.8 ห้ามแปลงเลขเอกสารแม้แต่หลักเดียว
   *    ระบบใหม่เดิมเติมขีดให้เอง (`${kind}-${num}`) = ถามผิดใบ
   * ═══════════════════════════════════════════════════════════════ */
  head('④ 🔒 ถามด้วยเลขที่คีย์มาเป๊ะ ๆ · แบบมีขีดเป็นแค่ตัวสำรอง');
  const refs = sync.refsOf('IV69082500004');
  ok(refs[0].ref === 'IV69082500004', 'เลขที่ถาม = เลขที่คีย์ ไม่เติมขีดให้เอง');
  ok(refs[0].alts.includes('IV-69082500004'), '  แบบมีขีดเก็บไว้เป็นตัวสำรองเท่านั้น');
  /* ‼ ของเดิมใช้ตัวสำรองเฉพาะตอน "ล็อกท่าไว้แล้ว" เท่านั้น (code.gs:9879)
   *   ซึ่งคือสภาพปกติของระบบที่วิ่งอยู่ — ล็อกตั้งแต่ใบแรกที่เจอ
   *   ตรงนี้จึงตั้งท่าที่ล็อกไว้ให้เหมือนของจริง ไม่ใช่เริ่มจากศูนย์ */
  reset(); ACCEPT = 'code'; STATE['pk_param_iv'] = 'code';
  IVS = [{ ...IV_OK, code: 'IV-69082500004' }];
  const d = await sync.checkRow(ROW({ 'เลขที่ QO / IV': 'IV69082500004' }));
  ok(d.ss === sync.SS.OK, 'คีย์ไม่มีขีด แต่ใบจริงมีขีด → ตัวสำรองช่วยหาเจอ');
  ok(CALLS[0].prm.code === 'IV69082500004', '  ‼ คำขอแรกยังเป็นเลขตามที่คีย์มา');
  ok(CALLS[1] && CALLS[1].prm.code === 'IV-69082500004', '  แบบมีขีดเป็นคำขอที่สอง');

  head('⑤ IV ต้องถามก่อน QT เสมอ (v27.4)');
  const mix = sync.refsOf('QO-2026080400007 IV-2026080400012');
  ok(mix[0].kind === 'IV' && mix[1].kind === 'QT', 'IV ขึ้นก่อน QT');

  /* ═══════════════════════════════════════════════════════════════
   *  ⑥ สามสถานะที่ "ไม่ใช่ไม่พบ" — รวมเข้ากันเมื่อไหร่ตามหาผิดทางทันที
   * ═══════════════════════════════════════════════════════════════ */
  head('⑥ ใบถูกยกเลิก ≠ ไม่พบใน PEAK (v31.6)');
  reset(); IVS = [{ ...IV_OK, status: 'ยกเลิก' }];
  const e = await sync.checkRow(ROW());
  ok(e.ss === sync.SS.VOID, 'ขึ้น "เอกสารถูกยกเลิกใน PEAK"');
  ok(!e.set['ยอดขาย PEAK'], '‼ ไม่เอายอดของใบที่ยกเลิกมาเขียนเด็ดขาด');

  head('⑦ ใบร่าง ≠ ไม่พบ และ ≠ ยกเลิก (v32.7)');
  reset(); IVS = [{ ...IV_OK, status: 'draft' }];
  const f = await sync.checkRow(ROW());
  ok(f.ss === sync.SS.DRAFT, 'ขึ้น "ใบร่างใน PEAK (ยังไม่อนุมัติ)"');

  head('⑧ อนุมัติแล้ว 1 ใบ + ใบร่าง → ใช้ใบที่อนุมัติ (v32.7)');
  reset();
  IVS = [{ ...IV_OK, status: 'draft', netAmount: 1 }, IV_OK];
  const g = await sync.checkRow(ROW());
  ok(g.ss === sync.SS.OK && g.inv.net === 10000, 'ได้ใบที่อนุมัติ ไม่ใช่ใบร่าง');

  /* ═══════════════════════════════════════════════════════════════
   *  ⑨ เลขซ้ำ — PEAK ให้เอาเลขของใบที่ยกเลิกไปใช้ใหม่ได้
   * ═══════════════════════════════════════════════════════════════ */
  head('⑨ เลขเดียวได้ 2 ใบ → ตัดสินด้วยชื่อลูกค้า/ชื่อเซลส์ (v32.1)');
  reset();
  IVS = [{ ...IV_OK, contactName: 'บริษัท คนอื่น จำกัด', salesPerson: 'เอ๋' },
         { ...IV_OK, contactName: 'บริษัท ทดสอบ จำกัด', salesPerson: 'ปุ๊ก', netAmount: 10000 }];
  const h = await sync.checkRow(ROW());
  ok(h.ss === sync.SS.OK, 'ตัดสินได้ ไม่ต้องให้คนมานั่งแกะ');
  ok(/ชื่อลูกค้า/.test(h.pickedBy || ''), '  และบอกด้วยว่าตัดสินด้วยอะไร: ' + (h.pickedBy || '—'));

  head('⑩ ‼ เลขซ้ำที่แยกไม่ออกจริง = ห้ามเดา (v32.0)');
  reset();
  IVS = [{ ...IV_OK, netAmount: 10000 }, { ...IV_OK, id: 'uuid-2', netAmount: 55555 }];
  const i = await sync.checkRow(ROW());
  ok(i.ss === sync.SS.DUP, 'ขึ้น "เลขซ้ำใน PEAK — ต้องตรวจ"');
  ok(!i.set['ยอดขาย PEAK'], '‼ ไม่เขียนตัวเลขสักตัว — เรื่องเงินพลาดไม่ได้');

  /* ═══════════════════════════════════════════════════════════════
   *  ⑪ v32.8 คีย์มาแต่ใบเสนอราคา → ตามหาใบแจ้งหนี้ให้เอง
   *    (คำสั่งพี่เอ 01/09 — ถ้าไม่ทำ แถวพวกนี้ค้าง "พบใบเสนอราคา" ตลอดกาล
   *     ไม่มียอดค้างชำระ ไม่ขึ้นการ์ดลูกหนี้ ทั้งที่ออกบิลไปแล้วจริง) */
  head('⑪ คีย์มาแต่ QO → ตามไปเจอ IV ที่ออกจากใบนั้น (v32.8)');
  reset(); ACCEPT = 'reference';
  QTS = [{ code: 'QO-2026083100021', id: 'uuid-qo', netAmount: 10000, status: 'approved' }];
  IVS = [{ ...IV_OK, reference: 'QO-2026083100021' }];
  const j = await sync.checkRow(ROW({ 'เลขที่ QO / IV': 'QO-2026083100021' }));
  ok(j.ss === sync.SS.OK, 'ได้ใบแจ้งหนี้ ไม่ใช่ค้างที่ "พบใบเสนอราคา"');
  ok(j.ivFromQuo && j.ivFromQuo.iv === 'IV-2026090100001', '  บอกด้วยว่าตามมาจากใบไหน');
  ok(j.set['เลขที่ใบเสนอราคา PEAK'] === 'QO-2026083100021', '  เก็บเลขใบเสนอราคาไว้ด้วย');

  head('⑫ มีแต่ใบเสนอราคาจริง ๆ → "พบใบเสนอราคา" ไม่ใช่ "ไม่พบ"');
  reset();
  QTS = [{ code: 'QO-2026083100022', id: 'uuid-q2', netAmount: 8000, status: 'approved' }];
  const k = await sync.checkRow(ROW({ 'เลขที่ QO / IV': 'QO-2026083100022' }));
  ok(k.ss === sync.SS.QUO, 'ขึ้น "พบใบเสนอราคา"');
  ok(k.set['ยอดใบเสนอราคา PEAK'] === 8000, '  เขียนยอดใบเสนอราคาไว้');
  ok(/quotationDetail/.test(k.set['ลิงก์เอกสาร PEAK'] || ''), '  ลิงก์ชี้ไปที่ใบเสนอราคา');

  /* ═══════════════════════════════════════════════════════════════
   *  ⑬ 🔴 ถามไม่สำเร็จ ≠ ไม่พบ — ข้อที่ทำให้คนไล่ผิดทางทั้งวัน
   * ═══════════════════════════════════════════════════════════════ */
  head('⑬ 🔴 PEAK ล่ม → ต้องบอกว่า "ถามไม่สำเร็จ" ไม่ใช่ "ไม่พบ"');
  reset(); FAIL = 'PEAK ตอบ HTTP 500';
  const l = await sync.checkRow(ROW());
  ok(l.ss === sync.SS.ERR, 'ขึ้น "ถาม PEAK ไม่สำเร็จ" · ได้: ' + l.ss);
  ok(l.ss !== sync.SS.MISS, '‼ ไม่ใช่ "ไม่พบใน PEAK" เด็ดขาด');
  ok(!l.set['ยอดขาย PEAK'], '  และไม่เขียนอะไรลงไป');

  head('⑭ เคยเจอแล้วรอบนี้หาย ≠ ไม่เคยเจอ');
  reset();
  const m = await sync.checkRow(ROW({ 'สถานะซิงก์ PEAK': sync.SS.OK, 'ยอดขาย PEAK': 10000 }));
  ok(m.ss === sync.SS.LOST, 'ขึ้น "เคยเจอ แต่รอบนี้หาไม่เจอ"');
  const n = await sync.checkRow(ROW());
  ok(n.ss === sync.SS.MISS, 'ใบที่ไม่เคยเจอมาก่อน → "ไม่พบใน PEAK"');

  /* ═══════════════════════════════════════════════════════════════
   *  ⑮ ความผิดพลาดที่ร้ายแรงที่สุด: เอายอดของลูกค้าคนอื่นมาเขียนทับ
   * ═══════════════════════════════════════════════════════════════ */
  head('⑮ ‼ PEAK คืนใบที่เลขไม่ตรงปนมา → ห้ามหยิบมาใช้');
  reset(); NOISE = true; IVS = [IV_OK];
  const o = await sync.checkRow(ROW());
  ok(o.ss === sync.SS.OK && o.inv.code === 'IV-2026090100001',
     'ใช้ใบที่เลขตรงเท่านั้น (ยอด 999,999 ของคนอื่นไม่หลุดเข้ามา)');
  ok(o.set['ยอดขาย PEAK'] === 10000, '  ยอดที่เขียนคือยอดของใบเรา');

  head('⑯ ยังไม่ตั้งกุญแจ PEAK เลย → ห้ามสรุปว่าไม่พบ');
  reset();
  const _cl = peak.configuredList;
  peak.configuredList = () => [];
  const p = await sync.checkRow(ROW());
  ok(p.ss === sync.SS.WAIT, 'ขึ้น "รอค่าเชื่อมต่อ"');

  head('⑰ ตั้งกุญแจไม่ครบทุกกิจการ → "รอ API อีกบริษัท" ไม่ใช่ "ไม่พบ"');
  peak.configuredList = () => ['มดงานการป้าย'];
  const q = await sync.checkRow(ROW());
  ok(q.ss === sync.SS.PEND, 'ขึ้น "รอ API อีกบริษัทถึงจะสรุปได้"');
  ok(/ยังไม่ได้ถามอีกกิจการ/.test(q.note || ''), '  และบอกด้วยว่าเหลือกิจการไหน');
  peak.configuredList = _cl;

  /* ═══════════════════════════════════════════════════════════════
   *  ⑱ 🔴 รอบ 226 — พี่เอ 3 ต.ค. 69:
   *    "เราไม่ได้ sync กับ peak ก่อนว่า IV ใบนั้น ของลูกค้ารายนั้น มีการยกเลิกไปก่อนแล้วหรือเปล่า
   *     ถ้าถูกยกเลิก IV เลขเดียวกันจะถูก รายอื่นนำไปใช้ได้นะ ต้องเช็ค ตรงนี้ก่อน"
   *    เลขเดียว = ใบยกเลิกของลูกค้าเดิม + ใบที่ยังใช้ได้ของลูกค้ารายใหม่
   *    ‼ ของเดิมหยิบใบที่ยังใช้ได้ให้ "ทุกแถว" ที่ถือเลขนี้ ⇒ แถวของลูกค้าเดิมได้ยอดของลูกค้ารายใหม่
   * ═══════════════════════════════════════════════════════════════ */
  head('⑱ 🔴 ใบของลูกค้ารายนี้ถูกยกเลิก แล้วเลขเดียวกันถูกออกใหม่ให้ลูกค้ารายอื่น (รอบ 226)');
  let RC = 0;
  peak.receipts = async () => { RC++; return []; };
  const DBX = require.cache[dbPath].exports, WR = [];
  const _upd = DBX.update;
  DBX.update = async (t, w, b) => { if (t === 'total_sales') WR.push({ w, b }); return _upd(t, w, b); };
  const V_OLD = { ...IV_OK, id: 'uuid-old', contactName: 'บริษัท ทดสอบ จำกัด', status: 'ยกเลิก' };
  const V_NEW = { ...IV_OK, id: 'uuid-new', contactName: 'บริษัท ดี ทรี จำกัด', netAmount: 12896, remainAmount: 12896, status: 'approved' };
  reset(); IVS = [V_OLD, V_NEW]; RC = 0;
  const r1 = await sync.checkRow(ROW({ 'ชื่อลูกค้า PEAK': 'บริษัท ดี ทรี จำกัด', 'ยอดขาย PEAK': 12896, 'สถานะซิงก์ PEAK': sync.SS.OK }));
  ok(r1.ss === sync.SS.VOID, 'แถวของลูกค้าเดิม (ใบถูกยกเลิก) ⇒ "เอกสารถูกยกเลิกใน PEAK" · ได้: ' + r1.ss);
  ok(!r1.set['ยอดขาย PEAK'] && !r1.set['รับชำระแล้ว PEAK'] && !r1.inv, '‼ ไม่เอายอดของลูกค้ารายใหม่ (12,896) มาเขียนให้ลูกค้าเดิม');
  ok(RC === 0, '‼ ไม่ถามใบเสร็จ/ไม่จด cash_flow ของลูกค้ารายอื่นใต้รหัสงานนี้ (ถามใบเสร็จ ' + RC + ' ครั้ง)');
  ok(r1.set['ชื่อลูกค้า PEAK'] === '' && r1.set['ลิงก์เอกสาร PEAK'] === '' && r1.set['สถานะซิงก์ PEAK'] === sync.SS.VOID,
     'ล้างชื่อลูกค้า/ลิงก์ของลูกค้ารายอื่นที่ค้างจากรอบก่อน + ตีตรายกเลิก');
  ok(/ถูกยกเลิก/.test(r1.note) && /ออกใหม่ให้ "บริษัท ดี ทรี จำกัด"/.test(r1.note) && /ดี ทรี/.test(r1.set['ผลตรวจ PEAK'] || ''),
     'บอกเหตุผลตรง ๆ: ' + r1.note);
  const r2 = await sync.checkRow(ROW({ 'ชื่อบริษัท': 'บริษัท ดี ทรี จำกัด', 'ยอดขาย (บาท)': 12896 }));
  ok(r2.ss === sync.SS.OK && r2.set['ยอดขาย PEAK'] === 12896 && r2.set['ชื่อลูกค้า PEAK'] === 'บริษัท ดี ทรี จำกัด',
     'แถวของลูกค้ารายใหม่ (เจ้าของใบที่ยังใช้ได้) ⇒ ซิงก์ปกติ ยอด 12,896');
  WR.length = 0;
  const ap = await sync.apply({ rows: [ROW()], user: { username: 'tester' } });
  const wb = (WR[0] || {}).b || {};
  ok(ap.updated === 1 && wb['สถานะซิงก์ PEAK'] === sync.SS.VOID && wb['ชื่อลูกค้า PEAK'] === null && !('ยอดขาย PEAK' in wb),
     'กดตัดยอดเอง (apply) ก็เขียนชุดเดียวกัน: ตีตรายกเลิก + ล้างชื่อ · ไม่มีช่องยอดเงิน — ' + JSON.stringify(Object.keys(wb)));
  DBX.update = _upd;

  head('⑲ ไม่ครบเงื่อนไข = ทำเหมือนเดิมทุกอย่าง (ไม่เดา)');
  reset(); IVS = [{ ...V_OLD, contactName: 'บริษัท ที่สาม จำกัด' }, { ...V_NEW, netAmount: 10000, remainAmount: 10000 }];
  const r3 = await sync.checkRow(ROW());
  ok(r3.ss === sync.SS.OK && /ชื่อลูกค้าไม่ตรง/.test(r3.set['ผลตรวจ PEAK'] || ''),
     'ใบที่ยกเลิกไม่ใช่ชื่อของแถวนี้ ⇒ ยังซิงก์ใบที่ใช้ได้ + ผลตรวจ "ชื่อลูกค้าไม่ตรง" ตามเดิม');
  reset(); IVS = [V_OLD, { ...V_NEW, contactName: 'ทดสอบ', netAmount: 10000, remainAmount: 10000 }];
  const r4 = await sync.checkRow(ROW());
  ok(r4.ss === sync.SS.OK && r4.set['ยอดขาย PEAK'] === 10000, 'ลูกค้ารายเดิมยกเลิกแล้วออกใหม่เลขเดิม (ชื่อตรงทั้งสองใบ) ⇒ ใช้ใบที่ยังใช้ได้ตามเดิม');
  reset(); IVS = [V_OLD, V_NEW];
  const r5 = await sync.checkRow(ROW({ 'ชื่อบริษัท': '' }));
  ok(r5.ss === sync.SS.OK, 'แถวไม่มีชื่อบริษัท = ตัดสินไม่ได้ ⇒ ไม่ตีตรายกเลิกเอง');

  head('⑳ ใบที่ถูกยกเลิกไม่มีชื่อบนหัวใบ มีแต่รหัสลูกค้า → เปิดทะเบียนลูกค้าก่อนตัดสิน');
  const _cn = peak.contactName;
  peak.contactName = async code => (code === 'C-OLD')
    ? { ok: true, state: 'hit', name: 'บริษัท ทดสอบ จำกัด', person: '', code, via: 'test', err: '', source: 'test' }
    : { ok: true, state: 'absent', name: '', person: '', code, via: '', err: '', source: '' };
  reset(); IVS = [{ code: IV_OK.code, id: 'uuid-old', netAmount: 10000, contactCode: 'C-OLD', status: 'ยกเลิก' }, V_NEW];
  const r6 = await sync.checkRow(ROW());
  ok(r6.ss === sync.SS.VOID && r6.reuse && r6.reuse.voidName === 'บริษัท ทดสอบ จำกัด', 'ได้ชื่อจากทะเบียนลูกค้า ⇒ ตีตรายกเลิกได้ถูกแถว');

  head('㉑ ivHistory — ประวัติของเลข IV (ให้การ์ดลูกหนี้ถามก่อนเชื่อเลข IV บนใบงาน)');
  sync._ivHistMem.clear(); reset(); IVS = [V_OLD, V_NEW];
  const h1 = await sync.ivHistory('IV-2026090100001', '');
  ok(h1.ok && h1.reused && h1.live && h1.live.name === 'บริษัท ดี ทรี จำกัด' && h1.voids.length === 1 && h1.voids[0].name === 'บริษัท ทดสอบ จำกัด',
     'เลขถูกยกเลิกแล้วออกใหม่: ใบที่ใช้ได้ = ดี ทรี · ใบที่ยกเลิก = ทดสอบ — ' + JSON.stringify({ live: h1.live, voids: h1.voids }));
  CALLS.length = 0;
  const h1b = await sync.ivHistory('IV2026090100001', '');
  ok(h1b.reused && CALLS.length === 0, 'ถามซ้ำภายใน 10 นาที (เขียนเลขมีขีด/ไม่มีขีด) ไม่ยิง PEAK เพิ่ม');
  sync._ivHistMem.clear(); reset(); IVS = [IV_OK];
  const h2 = await sync.ivHistory('IV-2026090100001', '');
  ok(h2.ok && !h2.reused && h2.voids.length === 0 && h2.live, 'เลขที่ไม่เคยถูกยกเลิก ⇒ reused:false');
  sync._ivHistMem.clear(); reset(); FAIL = 'PEAK ตอบ HTTP 500';
  const h3 = await sync.ivHistory('IV-2026090100001', '');
  ok(h3.ok === false && !h3.reused && !sync._ivHistMem.size, '‼ ถาม PEAK ไม่สำเร็จ = ok:false (ยังไม่รู้) และไม่จำคำตอบนี้ไว้');
  ok(CALLS.every(c => c.res === 'invoices' || c.res === 'contacts'), '‼ ถามได้แค่ GET Invoices / Contacts');
  peak.contactName = _cn;

  console.log(`\n${fail ? '❌' : '✅'} ผ่าน ${pass} · พลาด ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
