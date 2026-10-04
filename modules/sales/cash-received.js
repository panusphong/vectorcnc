'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  💵 ยอดรับเงินจริงสะสม — บนการ์ด "ยอดขายสะสม" + การ์ดช่องทาง หน้าแรกแอปคีย์ยอดขาย
 *
 *  รอบ 228 · พี่เอ 3 ต.ค. 69:
 *    "เพิ่มยอดรับเงินจริงสะสมที่ sync data จาก peak ตามช่วงเวลาเดียวกันของยอดขายสะสมด้วย
 *     เพราะต้องการดูว่า ยอดขายที่ปิดได้มา กับยอดเงินรับจริงสัดส่วนเป็นอย่างไร"
 *    + "ตอนโหลดต้องรวดเร็ว ไม่ช้าด้วยนะ"
 *  รอบ 229 · พี่เอ 3 ต.ค. 69 (หลังเห็นของจริง):
 *    ① "ควรเห็น" — ทุกสิทธิ์ที่เข้าแอปคีย์ยอดขายได้ เห็นยอดนี้ (เดิมเฉพาะผู้ดูแลระบบ)
 *    ② "เพิ่มการรับเงินจริงในแต่ละช่องทางด้านบนด้วยนะ"
 *    ③ "ยอดรับเงินให้ดู Status ที่มีการตัดยอดรับชำระเหมือนกับ Cash flow เลยนะ"
 *
 *  ── นับอะไร (รอบ 229 = เกณฑ์เดียวกับ "เงินเข้า" ของหน้า Cash Flow ทุกประการ) ────────────
 *   เดินทีละแถวขายที่ "ปิดการขาย" แล้วถามตัวเดียวกับหน้า Cash Flow ว่างวดรับเงินของใบนี้คืออะไร
 *   (cashflow.js _payEvents — ลำดับความน่าเชื่อถือ 3 ชั้น ห้ามสลับ)
 *     ① ใบเสร็จจริงของ PEAK (ใบ RT)            → วัน + ยอดรายงวดจากใบเสร็จ
 *     ② PEAK ตัดยอดรับชำระแล้ว แต่ไม่มีใบเสร็จรายงวด → เชื่อยอด PEAK เกลี่ยลงวันที่ที่เซลส์คีย์
 *     ③ ยังไม่มีอะไรจาก PEAK                    → ยอดโอนรายงวดที่เซลส์คีย์ (สลิป)
 *   + รอบสอง: ใบเสร็จ PEAK ที่ไม่มีแถวคู่ในตารางขาย (เงินเข้าจริงแต่ไม่มีใครคีย์งาน) ก็นับ
 *   ‼ รอบ 228 นับแค่ชั้น ① — ตัวเลขจึงน้อยกว่าหน้า Cash Flow · รอบนี้เท่ากันแล้ว (มียามเทียบกับ cashFlowReport)
 *   ‼ ไม่เขียนสูตรคิดเงินขึ้นใหม่ที่นี่ — เรียก _payEvents ของ cashflow.js ตรง ๆ
 *     ส่วน "ดัชนีใบเสร็จ" (payIndex ข้างล่าง) ยกวิธีอ่าน + กุญแจกันนับซ้ำของ cashflow.js _cfPayRows มาทีละบรรทัด
 *     (ตัวนั้นไม่ได้ส่งออกจากไฟล์ และรอบนี้ไม่แตะ cashflow.js เลยแม้แต่บรรทัดเดียว) — ยามเทียบผลกับ cashFlowReport ทุกครั้ง
 *
 *  ── แยกช่องทาง ──────────────────────────────────────────────────────
 *   งวดรับเงินมาจากแถวขายแถวไหน ก็เป็นของช่องทางของแถวนั้น — สูตรช่องทางเดียวกับการ์ดยอดขาย
 *   (ฟังก์ชัน app.sales_channel ใน sql/11 · channelOf ข้างล่างยกมาทีละบรรทัด มียามเทียบกับฐานจริง)
 *   ใบเสร็จที่ไม่มีแถวคู่ในตารางขาย = "ไม่ระบุช่องทาง" (ไม่เดา)
 *
 *  ── ความเร็ว ────────────────────────────────────────────────────────
 *   · หน้าเว็บเรียกเส้นนี้ "แยก" หลังการ์ดยอดขายขึ้นแล้ว — ไม่ถ่วง /api/dashboard
 *   · ตารางขายขอเฉพาะ 15 ช่องที่ตัวคิดอ่านจริง (ไม่ใช่ select *) — มียามจดทุกช่องที่ถูกอ่าน
 *   · งวดรับเงินทั้งหมดคิดครั้งเดียวแล้วจำไว้ใช้ร่วมกันทุกคน ทุกช่วง (เดือนนี้/เดือนที่แล้ว/3/6 เดือน)
 *       สด 60 วินาที · เกินนั้น (ถึง 15 นาที) ตอบของที่จำไว้ทันที แล้วคิดใหม่เบื้องหลัง
 *     ⇒ คำขอปกติไม่แตะฐานเลย ตอบเป็นมิลลิวินาที
 *
 *  ── 🔴 รอบ 230 · พี่เอ 3 ต.ค. 69 (หลังเห็นของจริง v1.50.0: สาขา ยอดขาย ฿68,309 = รับเงินจริง ฿68,309 = 100%) ──
 *    "check ให้ถูกต้องอีกทีนะ ว่าทำไมสาขาถึงเก็บเงินได้เท่ากับที่ขายเป๊ะเลย น่าจะต้องมีการเก็บมัดจำกันบ้างนะ"
 *    "แน่ใจนะ ว่าดึงยอดรับเงินมาถูกช่องทาง เช็คให้หน่อย ว่าดึงด้วยหลักการอะไร อ้างอิงจากอะไร"
 *    "ส่วนเงินมัดจำ ต้องวิ่งเข้าแต่ละช่องทางให้ถูกต้องด้วยนะ"
 *    "ต้องมีอะไรผิดแน่นอน ไม่มีทางที่ยอด สาขา ที่ขาย กับเก็บเงินจะเท่ากัน 100% แบบนี้เป็นไปไม่ได้"
 *   ‼ ดูข้อมูลจริงแล้ว (พี่เอเปิดแอปจริงให้อ่าน 3 ต.ค. 69): งานสาขา 8 งาน เซลส์คีย์ "ยอดโอน 100%" = ยอดขายเต็มทุกงาน
 *     แต่ PEAK ตอบ "ยังไม่ชำระ" (รับชำระ = 0) 5 งาน ฿63,675 · ตัดยอดแล้วจริงแค่ 3 งาน ฿4,634
 *     ⇒ ต้นเหตุ = ชั้น ③ ของ _payEvents: PEAK ยังไม่ตัดยอด ก็ถอยไปเชื่อยอดที่เซลส์คีย์ (และรอบ 229 ติดป้ายกองนั้นผิดว่า "PEAK ตัดยอดแล้ว")
 *
 *   แก้ 3 เรื่อง (ยังเรียก _payEvents ตัวเดิมหางวด — เปลี่ยนแค่ว่า "งวดไหนนับ งวดไหนแยกไว้ งวดไหนเข้าช่องทางไหน")
 *   ① "รับเงินจริง" นับเฉพาะที่ PEAK ตัดยอดรับชำระแล้ว = ใบเสร็จ PEAK (ชั้น ①) + ยอด "รับชำระแล้ว PEAK" > 0 (ชั้น ②)
 *      สลิปที่เซลส์คีย์โดย PEAK ยังไม่ตัดยอด (PEAK ตอบ 0 หรือยังไม่มีข้อมูล) ⇒ แยกเป็น wait "รอ PEAK ตัดยอด" ไม่บวกเข้ายอด
 *      (คำสั่งรอบ 229 "ให้ดู Status ที่มีการตัดยอดรับชำระ" ตีความใหม่ตามของจริง: ยึดสถานะตัดยอดของ PEAK ไม่ใช่ยอดที่คีย์)
 *   ② มัดจำเข้าช่องทาง: ใบเสร็จ PEAK ที่ Cash Flow ถือว่า "ไม่มีแถวคู่" ตามรอยกลับไปหางานด้วยเลขบิล (ตัดตัวคั่น) / รหัสงานบนใบเสร็จ
 *      งานยังไม่ปิดการขาย (มัดจำ) · งานที่แถวขายยังไม่ถูกนับ · ใบแจ้งหนี้อีกใบของงานเดียวกัน ⇒ เข้าช่องทางของงานนั้น
 *   ③ ใบเสร็จที่ถูกนับ 2 ครั้ง ⇒ ตัดออก 1 ครั้ง (dup): แถวขายนับเงินของใบแจ้งหนี้ใบนี้ไปแล้ว แต่เลขบิลในช่อง "เลขที่ QO / IV"
 *      ไม่ตรงกับเลขบนใบเสร็จแบบตัวต่อตัว (เช่น "QO-… / IV-…" · "IV…" ไม่มีขีด) หน้า Cash Flow จึงนับใบเสร็จซ้ำในรอบสอง
 *      ของจริง ส.ค.–ต.ค. 69 มีงานที่ช่องเลขบิลคีย์ 2 เลขคู่กันราว 95 งาน
 *   ⇒ ยอดบนการ์ด + รอ PEAK ตัดยอด + ที่ตัดซ้ำออก = "เงินเข้า" ของหน้า Cash Flow ทุกบาท (ยามเทียบไว้) — cashflow.js ไม่ถูกแตะ
 *   + "ดูรายการ" (cashReceivedDetail · เฉพาะผู้ดูแลระบบ): ทีละงวด งานไหน เลขบิลไหน ที่มาชั้นไหน อยู่ช่องทางนี้เพราะ 2 ช่องของแถวขายเขียนว่าอะไร
 *     · งานที่ปิดการขายในช่วงนี้ รับครบ / รับบางส่วน / ยังไม่รับ · สลิปที่รอ PEAK · ใบเสร็จที่ตัดซ้ำออก
 *
 *  ── 🔴 รอบ 231 · พี่เอ 4 ต.ค. 69 (หลังเห็น v1.51.0: สาขารับเงินจริง ฿4,634 = 6.8%) ─────────────────────
 *    "เอาใหม่นะ บอกว่า ให้นับยอดรับเงินจริงไง ยอดที่รับเป็นมัดจำเข้ามาก็ต้องนับด้วยนะ เห็นยอดสาขาแล้วมันก็ผิดแล้ว
 *     ส่วนใหญ่สาขา รับอย่างน้อย 50% ของยอดขายขึ้นไปอยู่แล้วทุกบิลขาย"
 *   ⇒ ข้อ ① ของรอบ 230 ผิดทาง: เงินมัดจำ/เงินที่เพิ่งรับ ถูกจดไว้ที่เดียวคือช่องยอดโอนที่เซลส์คีย์ — PEAK ตามมาตัดยอดทีหลัง
 *     การรอ PEAK จึงทำให้เงินที่รับแล้วหายจากการ์ด
 *   ⇒ รับเงินจริง = ทุกงวดที่มีบันทึกว่ารับแล้ว: ใบเสร็จ PEAK → ยอดรับชำระ PEAK → ยอดโอนที่เซลส์คีย์ (เมื่อ PEAK ยังไม่ตัดยอด)
 *     (ลำดับเดียวกับ _payEvents) · กอง "เซลส์คีย์ รอ PEAK ยืนยัน" (wait) ตอนนี้ "นับรวม" แล้วบอกยอดแยกไว้ให้เห็น
 *   ⇒ ข้อ ② มัดจำเข้าช่องทาง และข้อ ③ ตัดของที่นับ 2 ครั้ง ยังอยู่ครบ + เพิ่ม: งานที่มีทั้งยอดโอนที่เซลส์คีย์ และใบเสร็จ PEAK
 *     ที่ตามรอยมาเจอ (เลขบิลเขียนไม่ตรง) = เงินก้อนเดียวกัน ⇒ ใช้ใบเสร็จ PEAK ตัดยอดที่คีย์ออก (sup) ไม่นับซ้อน
 *   ⇒ ยอดบนการ์ด + ที่ตัดซ้ำออก = "เงินเข้า" ของหน้า Cash Flow ทุกบาท
 *   · สลิปของงานที่ "ยังไม่ปิดการขาย" ยังไม่นับ (เหมือนหน้า Cash Flow) แต่บอกยอดไว้บนการ์ดรวม (open)
 *
 *  ── 🔴🔴 รอบ 232 · พี่เอ 4 ต.ค. 69 (หลังเห็น v1.52.0: สาขากลับไป 100%) — กติกาสุดท้าย ห้ามเปลี่ยนเองอีก ──────
 *    "นี่ไง ปัญหา มันผิด ถ้ารอ peak ยืนยัน ก้อคือเงินยังไม่ได้เข้า เพราะเค้าจะรับชำระตามยอดที่ลูกค้าจ่ายจริงเท่านั้นสิ
 *     ไปเอายอดที่เหลือมาบวกทำไม เค้ายังไม่จ่ายเลย"
 *   ⇒ รับเงินจริง = เฉพาะเงินที่บัญชี "รับชำระใน PEAK แล้ว" (ใบเสร็จ PEAK / ยอดรับชำระแล้ว PEAK) — มัดจำที่ PEAK รับชำระแล้วนับตามยอดที่รับจริง
 *     ยอดโอนที่เซลส์คีย์เอง โดย PEAK ยังไม่มีรายการรับชำระ = เงินยังไม่เข้า ⇒ **ไม่นับ** (wait) แสดงแยกไว้ให้บัญชีตามเท่านั้น
 *   ‼ รอบ 231 หนูเข้าใจคำว่า "มัดจำต้องนับ" ผิด ไปนับยอดที่เซลส์คีย์ — ผิด · ที่ถูกคือ "มัดจำที่ PEAK รับชำระแล้ว"
 *   ⇒ ยอดบนการ์ด + ยอดที่เซลส์คีย์แต่ PEAK ยังไม่รับชำระ + ที่ตัดซ้ำออก = "เงินเข้า" ของหน้า Cash Flow ทุกบาท
 *   ข้อ ② มัดจำเข้าช่องทาง · ข้อ ③ ตัดของที่นับ 2 ครั้ง · sup (งานที่มีใบเสร็จ PEAK แล้ว ไม่เอายอดที่คีย์มาแสดงเป็น "รอ") ยังอยู่ครบ
 *
 *  🔒 อ่านอย่างเดียวทั้งไฟล์ — ไม่ถาม PEAK สด ไม่เขียนกลับตารางไหน
 * ═══════════════════════════════════════════════════════════════════ */
const db = require('./../../core/db');
const { COL, refsOf } = require('./peak-sync');
const { _money } = require('./peak-audit');
const { _toDateObj } = require('./coll-report');

const clean = s => String(s == null ? '' : s).trim();
const r2 = n => Math.round(n * 100) / 100;
const num = v => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const _ivKey = v => String(v || '').replace(/\s+/g, '').toUpperCase();      /* ตัวเดียวกับ cashflow.js:146 */
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const p2 = n => (n < 10 ? '0' + n : String(n));
/* วันที่ในรูป yyyy-MM-dd จากค่าอะไรก็ได้ที่ระบบเก็บไว้ — สูตรเดียวกับ cashflow.js _ymd (บรรทัด 67) */
const _ymd = v => {
  const d = _toDateObj(v);
  return d ? d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) : '';
};

/* ช่องของตารางขายที่ตัวคิดอ่านจริง: _payEvents (ยอด PEAK · เลขเอกสาร · 4 ช่องสลิป × 2 · วันปิดการขาย)
 * + ตัวกรองปิดการขาย + 2 ช่องของสูตรช่องทาง + 4 ช่องของหน้าดูรายการ (รอบ 230: รหัสงาน · ชื่อบริษัท · ยอดขาย · สถานะชำระ PEAK) + Create By (เจ้าของงาน สำหรับยอดรับเงินบนอันดับเซลส์)
 * ‼ เพิ่มโค้ดที่อ่านช่องใหม่ = ต้องเติมที่นี่ (ยามจะแดงเตือน) · 5 ช่องใหม่เป็นช่องที่หน้า Cash Flow ขออยู่แล้วทุกวัน */
const CR_SALES_COLS = ['_row', 'รหัสงาน', 'ชื่อบริษัท', 'ยอดขาย (บาท)', 'Create By', 'Lead Status', 'เลขที่ QO / IV', 'วันที่ปิดการขาย',
  'ลูกค้ามาจากไหน', 'ชื่อช่อง / Platform', COL.PPAID, COL.PSTAT,
  'ยอด (บาท)', 'วันที่โอน', 'ยอด งวด 1 (บาท)', 'วันที่โอน งวด 1',
  'ยอด งวด 2 (บาท)', 'วันที่โอน งวด 2', 'ยอด งวด 3 (บาท)', 'วันที่โอน งวด 3'];

const CHANNELS = ['B2B', 'สาขา', 'ผู้บริหาร', 'Online', 'Partner'];
/** ช่องทางของแถวขาย — ยกจาก app.sales_channel (sql/11-sales-dashboard.sql:55) ทีละบรรทัด */
function channelOf(source, platform) {
  const s = source == null ? '' : String(source);
  const p = (platform == null ? '' : String(platform)).replace(/^ +| +$/g, '');     /* btrim */
  if (s.indexOf('สาขา') >= 0 && p.indexOf('สาขา') === 0) return 'สาขา';
  if (/b2b/i.test(s)) return 'B2B';
  if (s.indexOf('ผู้บริหาร') >= 0) return 'ผู้บริหาร';
  if (/พาร์ทเนอร์|partner/i.test(s)) return 'Partner';
  return 'Online';
}

/** เจ้าของงาน (ชื่อบนอันดับเซลส์) — ยกจาก app.sales_owner (sql/15-sales-nick-fix.sql) ทีละชั้น
 *   1) "(กุ๊งกิ๊ง) กุลกานต์ …" → กุ๊งกิ๊ง · 2) ไม่มีวงเล็บ → Create By ทั้งก้อน
 *   3) ว่าง → คำนำหน้ารหัสงาน (ตาราง sales_prefix · ยาวชนะสั้น) · 4) "(ไม่ระบุ)"
 *   PX = [{ prefix, nickname }] เรียงยาว → สั้น */
const btrim = v => String(v == null ? '' : v).replace(/^ +| +$/g, '');
function ownerOf(createBy, job, PX) {
  const s = createBy == null ? '' : String(createBy);
  const m = /^\(([\s\S]+?)\)/.exec(s);
  if (m && btrim(m[1])) return btrim(m[1]);
  if (btrim(s)) return btrim(s);
  const j = String(job == null ? '' : job).toUpperCase();
  for (const p of (PX || [])) if (p.prefix && j.indexOf(p.prefix) === 0) return p.nickname;
  return '(ไม่ระบุ)';
}
async function prefixRows() {
  try {
    const r = await db.selectAll('sales_prefix', { select: 'prefix,nickname' });
    return (r || []).filter(x => x && x.prefix && x.nickname)
      .map(x => ({ prefix: String(x.prefix), nickname: String(x.nickname) }))
      .sort((a, b) => b.prefix.length - a.prefix.length);
  } catch (e) { return []; }          /* ไม่มีทะเบียนคำนำหน้า = ใช้ได้แค่ชั้น 1–2 (ตัวหลัก) */
}

const FRESH_MS = 60 * 1000;           /* สดพอ — ตอบจากความจำ */
const STALE_MS = 15 * 60 * 1000;      /* ยังใช้ตอบได้ระหว่างคิดใหม่เบื้องหลัง */
let _ev = { at: 0, list: null, info: null, open: null, p: null };

async function salesRows() {
  try {
    return await db.selectAll('total_sales',
      { select: CR_SALES_COLS.map(c => '"' + c + '"').join(','), order: '_row.asc' });
  } catch (e) {            /* ฐานขาดช่องใดช่องหนึ่ง ⇒ ถอยไปอ่านทั้งแถว (ช้ากว่า แต่ตัวเลขไม่หาย) */
    return db.selectAll('total_sales', { select: '*', order: '_row.asc' });
  }
}

/* ดัชนีใบเสร็จจริงของ PEAK : เลขบิล → [{ymd, amt, ref, wht, cash, real}]
 * ‼ ยกจาก cashflow.js _cfPayRows (บรรทัด 270–327) ทีละบรรทัด: ตารางก่อน กระจกทีหลัง · กุญแจกันนับซ้ำตัวเดียวกัน
 *   (ใบเดียวกันอาจอยู่ทั้งตารางใหม่และกระจกแท็บเดิม — ซ้ำ 1 รายการ = เงินเข้าเกินจริงทั้งเดือน) */
async function payIndex() {
  const ix = {}, seen = {};
  const put = o => {
    if (!o.iv || !(o.amt > 0) || !o.ymd) return 0;
    const k = o.iv + '|' + o.ymd + '|' + r2(o.amt) + '|' + (o.ref || '');
    if (seen[k]) return 0;
    seen[k] = 1;
    (ix[o.iv] = ix[o.iv] || []).push(o);
    return 1;
  };
  const [cfRows, tabRows] = await Promise.all([
    db.selectAll('cash_flow', { select: 'iv,paid_at,amount,receipt_no,wht,cash,customer,job_code', order: 'id.asc' })
      .catch(() => db.selectAll('cash_flow', { select: '*', order: 'id.asc' }))
      .catch(() => null),          /* ยังไม่ได้รันไฟล์ SQL = ไม่มีตาราง ไม่ใช่ข้อผิดพลาด */
    db.selectAll('sheet_rows', { select: 'data,_row', source: 'eq.sales/PeakCashFlow', order: '_row.asc' })
      .then(r => (r || []).map(x => x.data || {}).filter(d => d && typeof d === 'object'))
      .catch(() => []),
  ]);
  for (const r of (cfRows || [])) {
    put({ iv: _ivKey(r.iv), ymd: _ymd(r.paid_at), amt: _money(r.amount),
          ref: clean(r.receipt_no), wht: num(r.wht), cash: num(r.cash), real: num(r.cash) > 0 ? 1 : 0,
          cust: clean(r.customer), job: clean(r.job_code) });
  }
  for (const v of tabRows) {
    put({ iv: _ivKey(v['เลขที่ Invoice']), ymd: _ymd(v['วันที่รับเงิน']),
          amt: _money(v['ยอดรับ (บาท)']), ref: clean(v['เลขที่ใบเสร็จ']),
          wht: _money(v['ภาษีหัก ณ ที่จ่าย (งวดนี้)']),
          cash: _money(v['รับจริงหลังหักภาษี (งวดนี้)']),
          real: _money(v['รับจริงหลังหักภาษี (งวดนี้)']) > 0 ? 1 : 0,
          cust: clean(v['ชื่อลูกค้า']), job: clean(v['รหัสงาน']) });
  }
  return ix;
}

/* เลขเอกสารแบบตัดตัวคั่นทิ้ง — ใช้ "ตามรอย" ใบเสร็จกลับไปหางานในหน้าดูรายการเท่านั้น (IV-6810001 = IV6810001)
 * ‼ ไม่ใช้จับคู่เพื่อนับเงิน — การนับเงินใช้กุญแจตัวเดิมของ cashflow.js ทุกตัวอักษร */
const normRef = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
/* เลข IV ทุกตัวที่เขียนอยู่ในช่อง "เลขที่ QO / IV" (ตัดตัวคั่นแล้ว) — ตัวกวาดเดียวกับตัวซิงก์ PEAK (refsOf)
 * + คำที่ขึ้นต้นด้วย IV ทั้งคำ (เลขบิลที่มี / ในตัว เช่น IV6808/001) */
function ivRefsOf(cell) {
  const s = String(cell == null ? '' : cell).toUpperCase();
  if (!s.trim()) return [];
  const out = new Set();
  for (const f of refsOf(s)) if (f.kind === 'IV') out.add(normRef(f.ref));
  for (const t of s.split(/[\s,;]+/)) if (/^IV/.test(t) && /\d/.test(t)) out.add(normRef(t));
  return [...out];
}
/* ชั้นที่มาของงวด
 *   'peak'      ใบเสร็จจริงของ PEAK                                   → PEAK ตัดยอดแล้ว
 *   'peak-amt'  ยอด "รับชำระแล้ว PEAK" > 0 (ไม่มีใบเสร็จรายงวด)         → PEAK ตัดยอดแล้ว
 *   'sheet'     ยอดโอนที่เซลส์คีย์ โดย PEAK ตอบ 0 หรือยังไม่มีข้อมูล    → ไม่นับ (รอบ 232) = เงินยังไม่เข้า แสดงแยกเป็น wait
 * ‼ _payEvents ติดป้ายแถวที่ PEAK ตอบ "รับชำระแล้ว = 0" ว่า 'peak-amt' (เพราะ PEAK "มีคำตอบ") ทั้งที่เงินก้อนนั้นคือสลิปล้วน ๆ
 *   — นี่คือต้นเหตุของสาขา 100% (รอบ 230) จึงต้องดูค่า peakPaid เอง */
const srcOf = PE => (PE.src === 'peak-amt' && !(PE.peakPaid > 0.5)) ? 'sheet' : PE.src;

/* งวดทั้งหมด — เดินลำดับเดียวกับ cashFlowReport (cashflow.js:2848–2912)
 *   list : [{ ymd, amt, wht, cash, ch, src, ri, ref, slot, kind? }]
 *            src 'peak' | 'peak-amt'      นับ
 *            src 'sheet'                  ไม่นับ → wait (PEAK ยังไม่รับชำระ) · ถ้างานนั้นมีใบเสร็จ PEAK ที่ตามรอยมาแทน → kind 'dup'
 *            src 'orphan' + kind          ใบเสร็จ PEAK ที่ Cash Flow ถือว่าไม่มีแถวคู่ — kind 'dup' ไม่นับ (นับซ้ำ) ที่เหลือนับ
 *   info : ข้อมูลแถวขายเท่าที่หน้าดูรายการใช้ (ri ชี้มาที่นี่) — ไม่ออกไปกับเส้นยอดรวม
 *   open : สลิป / ยอด PEAK ของงานที่ "ยังไม่ปิดการขาย" = หน้า Cash Flow ไม่นับ ที่นี่ก็ไม่นับ (บอกในหน้าดูรายการเท่านั้น) */
async function build() {
  const CF = require('./cashflow');
  const [rows, IX, PX] = await Promise.all([salesRows(), payIndex(), prefixRows()]);
  const out = [], usedIv = {}, info = [], open = [];
  const riOf = new Map(), byJob = {}, byIv = {};
  const infoOf = (row, closed) => {
    let ri = riOf.get(row);
    if (ri === undefined) {
      const pv = row[COL.PPAID];
      ri = info.push({
        row: num(row._row), job: clean(row['รหัสงาน']), co: clean(row['ชื่อบริษัท']),
        sale: r2(_money(row['ยอดขาย (บาท)'])), close: _ymd(row['วันที่ปิดการขาย']),
        ch: channelOf(row['ลูกค้ามาจากไหน'], row['ชื่อช่อง / Platform']),
        owner: ownerOf(row['Create By'], row['รหัสงาน'], PX),
        from: clean(row['ลูกค้ามาจากไหน']), plat: clean(row['ชื่อช่อง / Platform']),
        iv: clean(row['เลขที่ QO / IV']), st: clean(row['Lead Status']),
        ivs: ivRefsOf(row['เลขที่ QO / IV']),
        pstat: clean(row[COL.PSTAT]),
        ppaid: (pv === '' || pv === null || pv === undefined) ? null : r2(_money(pv)),
        closed: closed ? 1 : 0, paid: 0, tr: 0, wait: 0, src: '',
      }) - 1;
      riOf.set(row, ri);
    }
    return ri;
  };
  /* ป้ายบอกทาง: งานที่ปิดการขายแล้วมาก่อนงานที่ยังไม่ปิด · แถวแรกที่เจอมาก่อน */
  const mark = (ix, k, row, closed) => { if (k && (!ix[k] || (closed && !ix[k].c))) ix[k] = { row, c: closed }; };
  for (const row of (rows || [])) {
    const closed = /ปิดการขาย/.test(clean(row['Lead Status']));
    mark(byJob, clean(row['รหัสงาน']), row, closed);
    for (const k of ivRefsOf(row['เลขที่ QO / IV'])) mark(byIv, k, row, closed);
    const PE = CF._payEvents(row, IX);
    if (!closed) {
      /* ใบเสร็จ PEAK ของงานแบบนี้ไม่มีแถว "ปิดการขาย" คู่ ⇒ ไปโผล่ในรอบสองข้างล่าง (แล้วถูกตามรอยกลับมาเข้าช่องทาง) */
      if (PE.src !== 'peak') {
        for (const x of PE.list) {
          const amt = r2(num(x.amt));
          if (!(amt > 0)) continue;
          open.push({ ymd: clean(x.ymd), amt, ri: infoOf(row, false), slot: clean(x.slot), src: srcOf(PE) });
        }
      }
      continue;
    }
    const kIv = _ivKey(row['เลขที่ QO / IV']);
    if (kIv) usedIv[kIv] = 1;
    const ri = infoOf(row, true), I = info[ri], src = srcOf(PE);
    for (const x of PE.list) {
      const amt = r2(num(x.amt));
      if (!(amt > 0)) continue;
      if (src === 'sheet') I.wait += amt; else { I.paid += amt; I.src = src; }
      out.push({ ymd: clean(x.ymd), amt, wht: num(x.wht), cash: num(x.cash), ch: I.ch, src,
                 ri, ref: clean(x.ref), slot: clean(x.slot) });
    }
  }
  /* รอบสอง — ใบเสร็จ PEAK ที่ Cash Flow ถือว่า "ไม่มีแถวคู่ในตารางขาย"
   * ‼ เงื่อนไข "มีแถวคู่" ของ Cash Flow = ช่อง "เลขที่ QO / IV" ทั้งช่อง (ตัดช่องว่าง) ของงานที่ปิดการขายแล้ว
   *   ตรงกับเลขบิลบนใบเสร็จเป๊ะ — เขียนต่างกันแม้ขีดเดียว / ช่องมี 2 เลขคู่กัน / งานยังไม่ปิดการขาย = มาอยู่ตรงนี้
   * ตามรอยกลับไปหางาน: เลขบิล (ตัดตัวคั่น) ตรงกับเลข IV ในช่องของแถวขาย → รหัสงานที่ตัวซิงก์ PEAK จดไว้บนใบเสร็จ
   *   openJob   งานยังไม่ปิดการขาย (มัดจำ)                         → นับ เข้าช่องทางของงาน
   *   closedJob งานปิดการขายแล้ว แต่แถวขายยังไม่มีเงินที่ PEAK ตัดยอด  → นับ เข้าช่องทางของงาน
   *   otherIv   แถวขายนับเงินของใบแจ้งหนี้ "อีกใบ" ไปแล้ว              → นับ เข้าช่องทางของงาน (ใบมัดจำ + ใบงวดสุดท้าย)
   *   dup       แถวขายนับเงินของ "ใบเดียวกันนี้" ไปแล้ว               → ไม่นับ (ใบเสร็จใบเดียวถูกนับ 2 ครั้ง)
   *   noRow     ตามรอยไม่ได้                                      → นับ ไม่ระบุช่องทาง (ไม่เดา) */
  for (const ivk of Object.keys(IX || {})) {
    if (usedIv[ivk]) continue;
    const nk = normRef(ivk), viaIv = byIv[nk];
    for (const x of IX[ivk]) {
      const amt = r2(num(x.amt));
      if (!(amt > 0)) continue;
      const L = viaIv || (x.job && byJob[x.job]) || null;
      let ri = -1, kind = 'noRow';
      if (L) {
        ri = infoOf(L.row, L.c);
        const I = info[ri];
        kind = !I.closed ? 'openJob'
             : !(I.paid > 0.5) ? 'closedJob'
             : I.ivs.indexOf(nk) >= 0 ? 'dup'
             : I.ivs.length ? 'otherIv' : 'dup';
        /* เงินที่ตามรอยมาเข้างานนี้ — เก็บแยก (tr) ไว้ก่อน ‼ ห้ามบวกเข้า paid ตรงนี้
         * เพราะ paid ใช้ตัดสินใบเสร็จใบถัดไปของงานเดียวกัน (งวด 2 จะถูกมองว่านับซ้ำกับงวด 1) */
        if (kind !== 'dup') I.tr += amt;
        /* รอบ 231 — งานนี้แถวขายมีแต่ยอดโอนที่เซลส์คีย์ (PEAK บนแถวยังว่าง) แต่ตามรอยเจอใบเสร็จ PEAK ของงานเดียวกัน
         * = เงินก้อนเดียวกัน ⇒ เชื่อใบเสร็จ PEAK (ลำดับเดียวกับ _payEvents: ใบเสร็จชนะสลิป) แล้วตัดยอดที่คีย์ออก */
        if (kind === 'closedJob' && I.wait > 0.5) I.sup = 1;
      }
      out.push({ ymd: clean(x.ymd), amt, wht: num(x.wht), cash: num(x.cash),
                 ch: (kind === 'noRow' || kind === 'dup') ? '' : info[ri].ch, src: 'orphan',
                 ri, kind, how: L ? (viaIv ? 'iv' : 'job') : '',
                 ref: clean(x.ref), iv: ivk, cust: clean(x.cust), job: clean(x.job) });
    }
  }
  for (const x of out) if (x.src === 'sheet' && info[x.ri].sup) { x.kind = 'dup'; x.sup = 1; }
  /* paid = ที่ PEAK รับชำระแล้ว (รวมใบเสร็จที่ตามรอยมา) = นับ · wait = ยอดโอนที่เซลส์คีย์ PEAK ยังไม่รับชำระ = ไม่นับ */
  for (const I of info) {
    I.paid = r2(I.paid + I.tr); I.wait = I.sup ? 0 : r2(I.wait);
    if (I.tr > 0 && (!I.src || I.sup)) I.src = 'peak';
    if (!I.src && I.wait > 0) I.src = 'sheet';
    delete I.tr;
  }
  return { list: out, info, open };
}

function refresh() {
  if (_ev.p) return _ev.p;
  _ev.p = build().then(B => { _ev = { at: Date.now(), list: B.list, info: B.info, open: B.open, p: null }; return _ev; })
                 .catch(e => { _ev.p = null; throw e; });
  return _ev.p;
}
async function events() {
  const age = Date.now() - _ev.at;
  if (_ev.list && age < FRESH_MS) return { list: _ev.list, info: _ev.info, open: _ev.open, stale: false };
  if (_ev.list && age < STALE_MS) { refresh().catch(() => {}); return { list: _ev.list, info: _ev.info, open: _ev.open, stale: true }; }
  const E = await refresh();
  return { list: E.list, info: E.info, open: E.open, stale: false };
}

/* amount/n = รับเงินจริง = เฉพาะที่ PEAK รับชำระแล้ว (รอบ 232)
 * wait = ยอดโอนที่เซลส์คีย์ แต่ PEAK ยังไม่มีรายการรับชำระ (ไม่นับ) · dup = ที่ตัดออกเพราะนับซ้ำ
 * open = สลิปของงานที่ยังไม่ปิดการขาย (ไม่นับ)
 * ‼ amount + wait + dup = "เงินเข้า" ของหน้า Cash Flow ช่วงเดียวกัน */
const blank = () => ({ amount: 0, cash: 0, wht: 0, n: 0, last: '', wait: 0, waitN: 0, dup: 0, dupN: 0, open: 0, openN: 0 });
function add(o, x) {
  if (x.kind === 'dup') { o.dup += x.amt; o.dupN++; return; }
  if (x.src === 'sheet') { o.wait += x.amt; o.waitN++; return; }
  o.amount += x.amt; o.n++;
  const w = x.wht > 0 ? x.wht : 0;
  o.wht += w;
  o.cash += x.cash > 0 ? x.cash : Math.max(0, x.amt - w);
  if (x.ymd > o.last) o.last = x.ymd;
}
const fin = o => { for (const k of ['amount', 'cash', 'wht', 'wait', 'dup', 'open']) o[k] = r2(o[k]); return o; };

/** รวมยอดของช่วง [from, to] ทั้งก้อน + แยกช่องทาง · E = { list, open, info } */
function sumRange(E, from, to) {
  const tot = blank(), by = {}, other = blank();
  CHANNELS.forEach(k => { by[k] = blank(); });
  for (const x of E.list) {
    if (!x.ymd || x.ymd < from || x.ymd > to) continue;
    add(tot, x);
    add(by[x.ch] || other, x);
  }
  for (const x of (E.open || [])) {
    if (!x.ymd || x.ymd < from || x.ymd > to) continue;
    const c = by[E.info[x.ri].ch] || other;
    tot.open += x.amt; tot.openN++; c.open += x.amt; c.openN++;
  }
  CHANNELS.forEach(k => fin(by[k]));
  return { tot: fin(tot), by, other: fin(other) };
}

/** w = { from, to, pFrom, pTo } (ตัวเดียวกับที่การ์ดยอดขายใช้) → ยอดรับเงินจริงของช่วงนี้ + ช่วงเทียบ + แยกช่องทาง */
async function cashReceived(w) {
  const t0 = Date.now();
  if (!w || !isYmd(w.from) || !isYmd(w.to) || !isYmd(w.pFrom) || !isYmd(w.pTo))
    throw new Error('ช่วงวันที่ไม่ถูกต้อง');
  const E = await events();
  const C = sumRange(E, w.from, w.to), P = sumRange(E, w.pFrom, w.pTo);
  const channels = {};
  CHANNELS.forEach(k => { channels[k] = { cur: C.by[k], prev: P.by[k] }; });
  return { ok: true, from: w.from, to: w.to, pFrom: w.pFrom, pTo: w.pTo,
           cur: C.tot, prev: P.tot, channels, other: { cur: C.other, prev: P.other },
           asOf: _ev.at, stale: E.stale, ms: Date.now() - t0 };
}

/* ═══════════════════════════════════════════════════════════════════
 *  🏆 รอบ 230 — ยอดรับเงินของแต่ละคนบนอันดับเซลส์ (วันนี้ / เดือนนี้ / 3 เดือนล่าสุด)
 *  พี่เอ 3 ต.ค. 69: "ในส่วนของ Dashboard sale ranking ให้ใส่ยอดรับเงินของแต่ละคนในช่วงเวลานั้นๆ มาด้วยนะ อย่าให้โหลดช้านะ"
 *  ‼ งวดชุดเดียวกับการ์ดรับเงินจริง (ความจำก้อนเดียวกัน ไม่อ่านฐานเพิ่ม) · เกณฑ์เดียวกัน = เฉพาะที่ PEAK รับชำระแล้ว (รอบ 232)
 *    เงินเป็นของ "เจ้าของงาน" ของงานที่รับเงิน (สูตรเดียวกับชื่อบนอันดับ) — นับตามวันที่รับเงิน ไม่ใช่วันที่ปิดการขาย
 *    ใบเสร็จที่หางานไม่เจอ ไม่มีเจ้าของ จึงไม่อยู่ในนี้
 *  R = { ชื่อช่วง: [from, to] } → { ชื่อช่วง: { ชื่อคน: ยอด } }
 * ═══════════════════════════════════════════════════════════════════ */
async function receivedByOwner(R) {
  const t0 = Date.now();
  const keys = Object.keys(R || {});
  for (const k of keys) if (!Array.isArray(R[k]) || !isYmd(R[k][0]) || !isYmd(R[k][1])) throw new Error('ช่วงวันที่ไม่ถูกต้อง');
  const E = await events(), info = E.info || [], by = {};
  for (const k of keys) by[k] = {};
  for (const x of E.list) {
    if (x.kind === 'dup' || x.src === 'sheet' || !(x.ri >= 0) || !x.ymd) continue;
    const ow = info[x.ri].owner;
    for (const k of keys) if (x.ymd >= R[k][0] && x.ymd <= R[k][1]) by[k][ow] = (by[k][ow] || 0) + x.amt;
  }
  for (const k of keys) for (const n of Object.keys(by[k])) by[k][n] = r2(by[k][n]);
  return { ok: true, by, asOf: _ev.at, stale: E.stale, ms: Date.now() - t0 };
}

/* ═══════════════════════════════════════════════════════════════════
 *  🔎 รอบ 230 — "ดูรายการ" ของบล็อกรับเงินจริง (เฉพาะผู้ดูแลระบบ · เส้นแยก เรียกตอนกดเท่านั้น)
 *  ‼ ใช้งวดชุดเดียวกับที่การ์ดบวก (ความจำก้อนเดียวกัน) ⇒ ผลรวมรายการ = ตัวเลขบนการ์ดทุกบาท ไม่อ่านฐานเพิ่ม
 *  ch : '' | 'all' = ทุกช่องทาง · ชื่อช่องทาง · 'other' = ไม่ระบุช่องทาง
 * ═══════════════════════════════════════════════════════════════════ */
const DETAIL_MAX = 600;
/* สถานะรับเงินของงาน — นับจากเงินที่ PEAK รับชำระแล้วของงานนั้น ทุกช่วงเวลา (รอบ 232)
 * ‼ เกณฑ์ ±1 บาท = เกณฑ์เดียวกับหน้าตรวจ PEAK */
const payStatus = I => { const g = I.paid; return !(g > 0.5) ? 'none'
  : !(I.sale > 0) ? 'over'
  : g < I.sale - 1 ? 'part'
  : g > I.sale + 1 ? 'over' : 'full'; };
const pot = () => ({ amount: 0, n: 0 });
const put = (o, amt) => { o.amount += amt; o.n++; };
const byDate = (a, b) => (a.ymd < b.ymd ? 1 : a.ymd > b.ymd ? -1 : b.amt - a.amt);
const cut = rows => ({ rows: rows.slice(0, DETAIL_MAX), more: Math.max(0, rows.length - DETAIL_MAX) });

async function cashReceivedDetail(w, ch) {
  const t0 = Date.now();
  if (!w || !isYmd(w.from) || !isYmd(w.to)) throw new Error('ช่วงวันที่ไม่ถูกต้อง');
  const key = clean(ch) === 'all' ? '' : clean(ch);
  if (key && key !== 'other' && CHANNELS.indexOf(key) < 0) throw new Error('ไม่รู้จักช่องทาง "' + key + '"');
  const E = await events(), info = E.info || [];
  const hit = c => !key || (key === 'other' ? CHANNELS.indexOf(c) < 0 : c === key);
  const inWin = d => !!d && d >= w.from && d <= w.to;
  const relOf = I => !I ? '' : !I.closed ? 'openJob' : !I.close ? 'noClose' : I.close < w.from ? 'before' : I.close > w.to ? 'after' : 'same';

  const sum = { amount: 0, n: 0,
    peak: pot(), peakAmt: pot(), trace: pot(),                         /* ที่มา: ใบเสร็จ PEAK / ยอดรับชำระ PEAK / ใบเสร็จที่ตามรอยมา */
    same: pot(), before: pot(), after: pot(), noClose: pot(), openJob: pot(),   /* ของงานที่ปิดการขาย ในช่วงนี้ / ก่อน / หลัง / ไม่มีวันปิด / ยังไม่ปิด (มัดจำ) */
    noRow: pot() };                                                    /* ไม่ระบุช่องทาง (ตามรอยไม่ได้) */
  const items = [], dupRows = [], waitRows = [], paidWin = {};
  const dup = pot(), wait = pot();
  for (const x of E.list) {
    if (!inWin(x.ymd) || !hit(x.ch)) continue;
    const I = x.ri >= 0 ? info[x.ri] : null, rel = relOf(I);
    if (x.kind === 'dup') {                        /* นับไปแล้วอีกทางหนึ่ง ⇒ ตัดออก */
      put(dup, x.amt);
      dupRows.push({ ymd: x.ymd, amt: x.amt, ref: x.ref || '', how: x.how || '', sup: x.sup ? 1 : 0, slot: x.slot || '',
                     rcIv: x.iv || '', rcCo: x.cust || '', rcJob: x.job || '',
                     job: I.job, co: I.co, iv: I.iv, linkCh: I.ch, close: I.close, sale: I.sale, paid: I.paid, rowSrc: I.src });
      continue;
    }
    if (x.src === 'sheet') {                       /* เซลส์คีย์ยอดโอน แต่ PEAK ยังไม่มีรายการรับชำระ ⇒ ไม่นับ */
      put(wait, x.amt);
      waitRows.push({ ymd: x.ymd, amt: x.amt, slot: x.slot, job: I.job, co: I.co, iv: I.iv, ch: I.ch, from: I.from, plat: I.plat,
                      close: I.close, rel, sale: I.sale, paid: I.paid, pstat: I.pstat, ppaid: I.ppaid });
      continue;
    }
    put(sum, x.amt);
    if (x.src !== 'orphan') {
      put(x.src === 'peak' ? sum.peak : sum.peakAmt, x.amt);
      put(sum[rel], x.amt);
      paidWin[x.ri] = (paidWin[x.ri] || 0) + x.amt;
      items.push({ ymd: x.ymd, amt: x.amt, src: x.src, ref: x.ref, slot: x.slot, wht: x.wht > 0 ? r2(x.wht) : 0,
                   job: I.job, co: I.co, iv: I.iv, ch: I.ch, from: I.from, plat: I.plat,
                   close: I.close, rel, sale: I.sale, paid: I.paid, wait: I.wait, st: payStatus(I),
                   pstat: I.pstat, ppaid: I.ppaid });
      continue;
    }
    if (x.kind === 'noRow') put(sum.noRow, x.amt);
    else { put(sum.trace, x.amt); put(sum[rel], x.amt); if (I.closed) paidWin[x.ri] = (paidWin[x.ri] || 0) + x.amt; }
    items.push({ ymd: x.ymd, amt: x.amt, src: 'orphan', kind: x.kind, how: x.how, ref: x.ref, slot: '',
                 wht: x.wht > 0 ? r2(x.wht) : 0, rcIv: x.iv, rcCo: x.cust, rcJob: x.job,
                 job: I ? I.job : x.job, co: I ? I.co : x.cust, iv: I ? I.iv : '', ch: x.ch,
                 from: I ? I.from : '', plat: I ? I.plat : '', close: I ? I.close : '', lead: I ? I.st : '', rel,
                 sale: I ? I.sale : 0, paid: I ? I.paid : 0, wait: I ? I.wait : 0, st: I && I.closed ? payStatus(I) : '' });
  }
  items.sort(byDate); dupRows.sort(byDate); waitRows.sort(byDate);
  for (const k of Object.keys(sum)) { if (sum[k] && typeof sum[k] === 'object') sum[k].amount = r2(sum[k].amount); }
  sum.amount = r2(sum.amount); dup.amount = r2(dup.amount); wait.amount = r2(wait.amount);

  /* ── งานที่ปิดการขายในช่วงนี้ (กลุ่มเดียวกับที่การ์ดยอดขายบวก) PEAK รับชำระไปแล้วเท่าไร ── */
  const cohort = { n: 0, sale: 0, paid: 0, wait: 0, remain: 0, full: 0, part: 0, none: 0, over: 0, rows: [], more: 0 };
  if (key !== 'other') {
    const rows = [];
    for (let i = 0; i < info.length; i++) {
      const I = info[i];
      if (!I.closed || !inWin(I.close) || !hit(I.ch)) continue;
      const st = payStatus(I);
      cohort.n++; cohort.sale += I.sale; cohort.paid += I.paid; cohort.wait += I.wait; cohort[st]++;
      cohort.remain += Math.max(0, I.sale - I.paid);
      rows.push({ ymd: I.close, close: I.close, amt: I.sale, job: I.job, co: I.co, iv: I.iv, ch: I.ch, sale: I.sale,
                  paid: I.paid, wait: I.wait, remain: r2(Math.max(0, I.sale - I.paid)), st, src: I.src === 'sheet' ? '' : I.src,
                  pstat: I.pstat, ppaid: I.ppaid });
    }
    rows.sort(byDate);
    Object.assign(cohort, cut(rows));
    for (const k of ['sale', 'paid', 'wait', 'remain']) cohort[k] = r2(cohort[k]);
  }

  /* ── สลิปของงานที่ยังไม่ปิดการขาย (หน้า Cash Flow ก็ไม่นับ) ── */
  const open = { amount: 0, n: 0, rows: [], more: 0 };
  if (key !== 'other') {
    const rows = [];
    for (const x of (E.open || [])) {
      if (!inWin(x.ymd)) continue;
      const I = info[x.ri];
      if (!hit(I.ch)) continue;
      put(open, x.amt);
      rows.push({ ymd: x.ymd, amt: x.amt, slot: x.slot, src: x.src, job: I.job, co: I.co, iv: I.iv,
                  ch: I.ch, from: I.from, plat: I.plat, lead: I.st, sale: I.sale, pstat: I.pstat });
    }
    rows.sort(byDate);
    Object.assign(open, cut(rows));
    open.amount = r2(open.amount);
  }

  return { ok: true, from: w.from, to: w.to, ch: key || 'all', sum,
           items: items.slice(0, DETAIL_MAX), more: Math.max(0, items.length - DETAIL_MAX),
           wait: Object.assign(wait, cut(waitRows)), dup: Object.assign(dup, cut(dupRows)),
           cohort, open, asOf: _ev.at, stale: E.stale, ms: Date.now() - t0 };
}

module.exports = { cashReceived, cashReceivedDetail, receivedByOwner, CHANNELS, CR_SALES_COLS,
  _t: { sumRange, channelOf, ownerOf, build, events, payIndex, normRef, ivRefsOf, srcOf, payStatus,
        reset: () => { _ev = { at: 0, list: null, info: null, open: null, p: null }; },
        age: ms => { _ev.at = Date.now() - ms; } } };
