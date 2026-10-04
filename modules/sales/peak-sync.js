'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  ซิงก์ข้อมูลจาก PEAK มาเติมคอลัมน์ PEAK ในตารางขาย (ฐานข้อมูลใหม่)
 *
 *  ‼‼ ทิศทางเดียว: PEAK ──▶ ฐานข้อมูลใหม่  ห้ามย้อนกลับเด็ดขาด
 *      ไฟล์นี้ไม่มีคำสั่งเขียนไปที่ PEAK เลยแม้แต่บรรทัดเดียว
 *      core/peak.js ยิงได้แค่ GET กับ POST /ClientToken (ขอกุญแจ)
 *
 *  ทำงาน 2 จังหวะ — ของเดิมก็แยกแบบนี้ (peakPreviewSync / peakApplySync)
 *      ตรวจก่อน (preview) : ดึงมาเทียบให้ดู ไม่แตะชีตเลย
 *      ตัดยอดจริง (apply) : เขียนลงชีต เฉพาะแถวที่กด
 *
 *  ── บทเรียนจากโค้ดเดิมที่ยกมาทั้งหมด ──────────────────────────
 *   · v25.2 บิล PEAK มี 2 ยอด "จำนวนเงินทั้งสิ้น" กับ "จำนวนเงินที่ต้องชำระ"
 *           ลูกค้าโอนตามยอดหลัง ต้องเทียบยอดนั้น ไม่งั้นขึ้น "ต่าง" ทั้งที่สลิปถูก
 *   · v25.6 ภาษีหัก ณ ที่จ่ายอ่านจาก paidPayments ของใบเสร็จ ไม่ใช่คำนวณย้อนจากอัตรา
 *   · v27.2 🚫 ห้ามเฉลี่ยภาษีรายงวดตามสัดส่วน — ได้ตัวเลขที่ไม่มีอยู่ที่ไหนเลย
 *   · v30.1 🚫 ถอดตัวคำนวณย้อนภาษีจากอัตรา 3/5/2/1/10% ออกทั้งก้อน
 *   · v31.6 PEAK ยกเลิกใบแล้วเอาเลขเดิมไปใช้ใหม่ได้ → เลขเดียวได้หลายใบ
 *   · v32.0 เลขซ้ำ = ห้ามเดา ห้ามเขียนทับ
 *   · v32.7 "อนุมัติแล้ว" ชนะ "ใบร่าง"
 * ═══════════════════════════════════════════════════════════════════ */
const peak = require('../../core/peak');
const db = require('../../core/db');

/* ‼ ไม่มี require ของตัวคุยชีตในไฟล์นี้แล้ว — และห้ามใส่กลับมา
 *   ปลายทางของตัวเลขจาก PEAK คือฐานข้อมูลใหม่ที่เดียว (ดูหมายเหตุข้างล่าง) */

/* ═══════════════════════════════════════════════════════════════════
 *  ‼ ปลายทางเดียว = ฐานข้อมูลใหม่ · ไม่แตะชีตเดิมเลย
 *
 *  พี่เอสั่ง 6 ก.ย. 69 (คำต่อคำ):
 *    "ไม่ต้องไปบันทึกอะไรใน sheet เดิมนะ เรากำลังขึ้นระบบใหม่
 *     สนใจแค่ database ใหม่อย่างเดียวพอ
 *     ของเดิม app เก่ามันทำงานของมันอยู่แล้ว
 *     ถึงเวลา พี่ก็แค่ sync data เข้ามาให้ update ก็แค่นั้น"
 *
 *  ‼ แอปเก่ามีวงจรของมันเอง ไม่ได้รอให้ระบบใหม่ป้อนข้อมูลให้
 *    เราจึงไม่มีหน้าที่เขียนอะไรกลับไปที่ชีตอีกต่อไป
 *    เวลาพี่เอต้องการให้ตรงกัน ก็กดซิงก์ดึงชีตเข้ามาเอง (งาน "คีย์ยอดขาย" แบบกดเอง)
 *
 *  🔴 บทเรียนของอลิซในไฟล์นี้ — พลาด 2 รอบซ้อนเพราะ "เดาเจตนา" แทนที่จะถาม
 *     รอบแรก: เปลี่ยนเองเป็นเขียนฐานข้อมูลอย่างเดียว โดยไม่ได้สั่ง
 *     รอบสอง: พี่เอบอก "ไม่ต้องยุ่ง" แล้วอลิซแปลว่า "ให้เขียนชีตต่อ" — ผิดอีก
 *     ที่ถูกคือ "ไม่ต้องไปสนใจชีต" = ไม่เขียน ไม่อ่าน ไม่ห่วง
 *
 *  🔒 ทิศทาง PEAK ไม่เปลี่ยน: PEAK ──▶ เรา เท่านั้น
 *     ไฟล์นี้ไม่มีคำสั่งเขียนไปที่ PEAK เลยแม้แต่บรรทัดเดียว
 * ═══════════════════════════════════════════════════════════════════ */

/* ‼ หัวชีตบางช่องยาวเกิน 63 ไบต์ ชื่อคอลัมน์จริงในฐานข้อมูลจึงสั้นกว่า
 *   ถ้าเขียนด้วยชื่อหัวชีตตรง ๆ PostgREST จะไม่รู้จักคอลัมน์แล้วพังทั้งแถว
 *   แผนที่นี้เอามาจากที่เดียวกับตัวซิงก์ใหญ่ใช้ จะได้ไม่มีวันหลุดจากกัน */
let _dbColMap = null;
function dbCol(sheetHeader) {
  if (!_dbColMap) {
    _dbColMap = {};
    try {
      const alias = require('../../core/sync-jobs').SALES_HEADER_ALIAS || {};
      for (const [short, long] of Object.entries(alias)) _dbColMap[long] = short;
    } catch { /* ไม่มีก็ใช้ชื่อตรง ๆ */ }
  }
  return _dbColMap[sheetHeader] || sheetHeader;
}

/** แปลงชุดค่าที่จะเขียน ให้เป็นเรคคอร์ดของตาราง total_sales */
function toRec(set) {
  const rec = { _synced_at: new Date().toISOString() };
  for (const [col, v] of Object.entries(set)) {
    /* ‼ ค่าว่างต้องเป็น null ไม่ใช่ '' — คอลัมน์ตัวเลขรับ '' ไม่ได้
     *   เคยพลาดตรงนี้แล้วทั้งแถวไม่เข้า โดยที่ error ไม่ได้บอกว่าช่องไหน */
    rec[dbCol(col)] = (v === '' || v === undefined) ? null : v;
  }
  return rec;
}

const clean = s => String(s == null ? '' : s).trim();
const money = v => {
  const n = Number(String(v == null ? '' : v).replace(/,/g, ''));
  /* v20.7: ค่าเพี้ยนระดับล้านล้าน = ข้อมูลขยะ ตัดทิ้ง อย่าเอาไปคิดต่อ */
  return (Number.isFinite(n) && Math.abs(n) < 1e11) ? n : 0;
};
const r2 = n => Math.round(n * 100) / 100;

/* สถานะซิงก์ (SS code.gs:9420) — ข้อความยกมาคำต่อคำ */
const SS = {
  OK:      '✅ ซิงก์แล้ว',
  QUO:     '📄 พบใบเสนอราคา',
  MISS:    '❓ ไม่พบใน PEAK',
  NODOC:   '📝 ยังไม่ออกเอกสารใน PEAK',
  VOID:    '🚫 เอกสารถูกยกเลิกใน PEAK',
  DUP:     '🚫 เลขซ้ำใน PEAK — ต้องตรวจ',
  DRAFT:   '📝 ใบร่างใน PEAK (ยังไม่อนุมัติ)',
  FLOW:    '🧾 อยู่ใน FlowAccount',
  WAIT:    '⏳ รอค่าเชื่อมต่อ',
  PEND:    '⏳ รอ API อีกบริษัทถึงจะสรุปได้',
  LOST:    '⚠️ เคยเจอ แต่รอบนี้หาไม่เจอ',
  NOTCLOSED: '⛔ ไม่ใช่ปิดการขายแล้ว',
  /* ‼ "ถาม PEAK ไม่สำเร็จ" ≠ "ไม่พบใน PEAK" — ของเดิมแยกไว้ชัด (code.gs:16500 'error')
   *   รวมสองอย่างนี้เข้าด้วยกันเมื่อไหร่ = PEAK ล่มแล้วรายงานว่า "ลูกค้าไม่ได้ออกบิล"
   *   ซึ่งพาคนไปไล่ผิดทางทั้งวัน */
  ERR:     '⚠️ ถาม PEAK ไม่สำเร็จ — ยังสรุปไม่ได้',
};

/* คอลัมน์ PEAK ในชีต (PEAK_COLS code.gs:9394) */
const COL = {
  AMT: 'ยอดขาย PEAK', CHK: 'ตรวจยอด', CNAME: 'ชื่อลูกค้า PEAK', CCODE: 'รหัสลูกค้า PEAK',
  PSTAT: 'สถานะชำระ PEAK', PPAID: 'รับชำระแล้ว PEAK', RCPTN: 'PEAK เก็บมาแล้ว (งวด)',
  VERDICT: 'ผลตรวจ PEAK', PAT: 'อัปเดต PEAK เมื่อ',
  QUO: 'เลขที่ใบเสนอราคา PEAK', QSTAT: 'สถานะใบเสนอราคา PEAK', QAMT: 'ยอดใบเสนอราคา PEAK',
  TERMS: 'เงื่อนไขชำระ PEAK', CRDAY: 'วันเครดิต PEAK', SSTAT: 'สถานะซิงก์ PEAK',
  /* v18.9 · ลิงก์เปิดเอกสารจริงใน PEAK — กดจากรายงานได้เลย ไม่ต้องไปค้นเอง
   *  ‼ ช่องนี้มีในชีตและในตารางมาตลอด แต่ระบบใหม่ไม่เคยเติมให้เลย
   *    ทั้งที่ตอนถาม PEAK เราถือ uuid อยู่ในมือแล้ว = ของหายไปเปล่า ๆ */
  URL: 'ลิงก์เอกสาร PEAK',
  /* ‼ ชื่อเต็ม 'ใบเสนอราคา → ใบแจ้งหนี้' ยาวเกิน 63 ไบต์
   *   คอลัมน์จริงในฐานข้อมูลชื่อ 'QO→IV' — dbCol() แปลงให้ตอนเขียน */
  QLINK: 'ใบเสนอราคา → ใบแจ้งหนี้',
};

/* ลิงก์เปิดเอกสารใน PEAK (pkDocUrl code.gs:9807) — ยกมาทั้งรูปแบบ */
const PEAK_WEB = 'https://secure.peakaccount.com';
function docUrl(kind, id) {
  const g = clean(id);
  if (!g) return '';
  const path = (kind === 'qt') ? '/income/quotationDetail?uuid='
                               : '/income/invoiceDetail?uuid=';
  return PEAK_WEB + path + encodeURIComponent(g);
}

/* ═══════════════════════════════════════════════════════════════════
 *  แกะเลขเอกสารจากช่อง "เลขที่ QO / IV" — ยกมาจาก pkRefs() code.gs:9729
 *
 *  ‼ v27.0 ของเดิม: ต้นเหตุตัวใหญ่ของ "ไม่พบใน PEAK"
 *    ตัวอ่านเก่า split('/') แล้วลบช่องว่าง → "QO-xxx IV-yyy" กลายเป็นก้อนเดียว
 *    → ถาม PEAK ไม่มีทางเจอ → ยิ่งคีย์ครบยิ่งพัง
 *    ของใหม่ "กวาดหาเลขเอกสารทุกตัวในช่อง" คั่นด้วยอะไรก็ได้ มีข้อความปนก็ยังเจอ
 *
 *  🔒 v22.8 ห้ามแปลงตัวเลขแม้แต่หลักเดียว — พี่เอยืนยันว่าเลขที่คีย์คือเลขจริงบนเอกสาร
 *    ‼ ตัวเดิมของระบบใหม่เขียน `${kind}-${num}` = "เติมขีดให้เอง" ซึ่งผิดกฎข้อนี้
 *    ที่ถูกคือใช้ตามที่คีย์มา แล้วเก็บแบบมีขีดไว้เป็น "ตัวสำรอง" (alts) เท่านั้น
 *
 *  ‼ v27.4 IV ต้องขึ้นก่อน QT เสมอ — ใบแจ้งหนี้คือเอกสารที่มียอดเงิน สถานะชำระ
 *    และภาษีหัก ณ ที่จ่ายของจริง ถาม QO ก่อนคือเสียเที่ยวเปล่า
 * ═══════════════════════════════════════════════════════════════════ */
function refsOf(raw) {
  const out = [];
  const s = String(raw == null ? '' : raw).toUpperCase();
  const RE = /(IV|QO|QT)\s*(-?)\s*(\d[\d-]*)/g;
  let m;
  while ((m = RE.exec(s)) !== null) {
    const num = String(m[3]).replace(/-+$/, '');
    if (!/\d/.test(num)) continue;
    const ref = m[1] + m[2] + num;                 /* ตามที่คีย์มา ไม่แตะตัวเลข */
    if (out.some(x => x.ref === ref)) continue;
    /* ข้อยกเว้นเดียว: คีย์มาไม่มีขีด → เตรียมแบบมีขีดไว้ลองสำรอง
     *   เป็นแค่การใส่ "ตัวคั่น" ให้ตรงรูปแบบที่ PEAK เขียน ตัวเลขไม่ถูกแตะเลย */
    const alts = [];
    const dashed = m[1] + '-' + num.replace(/^-+/, '');
    if (dashed !== ref) alts.push(dashed);
    out.push({ kind: m[1] === 'IV' ? 'IV' : 'QT', ref, num, alts });
  }
  /* IV ก่อน QT เสมอ (ในกลุ่มเดียวกันคงลำดับที่คีย์มา) */
  return out.filter(x => x.kind === 'IV').concat(out.filter(x => x.kind !== 'IV'));
}

/* ═══════════════════════════════════════════════════════════════════
 *  🔑 PEAK รับพารามิเตอร์ตัวไหน — ถอดจาก PK_PARAM (code.gs:9843)
 *
 *  ‼ นี่คือช่องว่างที่ใหญ่ที่สุดของระบบใหม่ก่อนหน้านี้
 *    ระบบใหม่ยิงด้วย code= ตายตัว · ถ้า PEAK ต้องการ reference=
 *    ทุกใบจะกลับมาเป็น "❓ ไม่พบใน PEAK" ทั้งที่เอกสารมีอยู่จริงครบทุกใบ
 *
 *  กฎธุรกิจของพี่เอ (29/08 · code.gs:9891):
 *    "ถ้าคีย์เลขลงช่อง QO/IV แล้ว ต้องเจอเสมอ
 *     ถ้าไม่เจอ = ไม่ได้ใส่ข้อมูลในช่องนี้เท่านั้น"
 *  แปลว่า "มีเลขแต่ไม่เจอ" = วิธีค้นหาผิด ไม่ใช่ข้อมูลไม่มี
 *
 *  วิธีทำงาน: ลองทีละท่าจนเจอ แล้วจำไว้ · ท่าที่จำไว้ใช้ไม่ได้เมื่อไหร่
 *  ลองท่าอื่นต่อเองแล้วเปลี่ยนท่าให้อัตโนมัติ (v28.2 self-heal)
 * ═══════════════════════════════════════════════════════════════════ */
const PK_PARAM = { TRY: ['code', 'reference'], KEY: { IV: 'pk_param_iv', QT: 'pk_param_qt' } };
const qState = () => require('../../core/peak-queue');
async function paramGet(kind) {
  try { return clean(await qState().state(PK_PARAM.KEY[kind])); } catch { return ''; }
}
async function paramSet(kind, key) {
  try { await qState().state(PK_PARAM.KEY[kind], key); } catch { /* จำไม่ได้ก็ยังใช้ได้รอบนี้ */ }
}
/* ‼ มี IV อยู่ด้วย = ยังต้องถาม PEAK ห้ามตีตรา FlowAccount
 *   ของเดิมแก้ข้อนี้ไปแล้วใน v27.4 เพราะตีตราผิดแล้ว "ข้อมูลหายไปทั้งใบ"
 *   ใช้ตัวเดียวกับคิว จะได้ไม่มีวันคิดคนละอย่างกันอีก */
const isFlow = raw => require('../../core/peak-queue').isFlowRef(raw);

/* ── ใบถูกยกเลิกไหม (v31.6 _pkDocVoid) ───────────────────────── */
function isVoid(d) {
  const s = JSON.stringify(d || {}).toLowerCase();
  if (/"(is)?void(ed)?"\s*:\s*true|"cancel(l)?ed"\s*:\s*true/.test(s)) return true;
  const st = clean(peak.dig(d, ['status', 'documentStatus', 'docStatus'])).toLowerCase();
  return /void|cancel|ยกเลิก/.test(st);
}
function isDraft(d) {
  const st = clean(peak.dig(d, ['status', 'documentStatus', 'docStatus'])).toLowerCase();
  return /draft|ร่าง/.test(st);
}

/* ── แยกภาษีหัก ณ ที่จ่ายออกจากใบเสร็จ (_rcptSplit code.gs:2421) ──
 *
 *  ‼ อ่านจากที่ PEAK ส่งมาเท่านั้น แยกไม่ออกให้เป็น 0 — ห้ามแต่งตัวเลข
 *    ตัวคำนวณย้อนจากอัตราภาษีถูกถอดออกไปแล้วตั้งแต่ v30.1 ห้ามเอากลับมา */
const WHT_RE = /หัก ณ ที่จ่าย|ภาษีหัก|ภ\.ง\.ด|withhold|w\/h|wht/i;
const WHT_FIELDS = ['withholdingTax', 'withHoldingTax', 'whtAmount', 'taxWithheld',
                    'withholdingAmount', 'whtTotal'];

function isWhtPayment(p) {
  const txt = [p.paymentMethod, p.paymentMethodName, p.method, p.name,
               p.description, p.journalName, p.accountName]
    .map(x => clean(x)).join(' ');
  return WHT_RE.test(txt);
}

function splitReceipt(rc) {
  const gross = money(peak.dig(rc, ['totalAmount', 'total', 'grandTotal', 'amount', 'paymentTotal']));
  const pays = (rc.paidPayments || rc.payments || rc.paymentList || []);
  const date = peak.ymd(peak.dig(rc, ['paymentDate', 'issueDate', 'documentDate', 'date']));
  const ref  = clean(peak.dig(rc, ['code', 'documentCode', 'receiptCode', 'number']));

  let wht = 0, cash = 0, src = 'none';
  if (Array.isArray(pays) && pays.length) {
    for (const p of pays) {
      const amt = money(p.paymentTotal ?? p.amount ?? p.total);
      /* ① ฟิลด์ภาษีอยู่ในรายการนั้นเอง */
      const own = WHT_FIELDS.map(f => money(p[f])).find(x => x > 0) || 0;
      if (own > 0) { wht += own; cash += amt - own; src = 'field'; continue; }
      /* ② ทั้งรายการคือภาษีหัก ณ ที่จ่าย (บันทึกเป็นช่องทางรับเงินช่องหนึ่ง) */
      if (isWhtPayment(p)) { wht += amt; src = src === 'none' ? 'pay' : src; continue; }
      cash += amt;
    }
  } else {
    /* ③ หัวใบมียอดภาษีรวม */
    const hw = WHT_FIELDS.map(f => money(rc[f])).find(x => x > 0) || 0;
    if (hw > 0 && hw < gross) { wht = hw; cash = gross - hw; src = 'head'; }
    else cash = gross;
  }
  /* ‼ ไม่มีเพดานตรงนี้ — ของเดิมก็ไม่มี (_rcptSplit code.gs:2413)
   *   เพดาน 25% อยู่ที่ระดับ "ใบแจ้งหนี้" ไม่ใช่ระดับ "ใบเสร็จ"
   *   ใบเสร็จที่บันทึกภาษีทั้งก้อนเป็นช่องทางรับเงินช่องเดียว จะมี wht = gross พอดี
   *   ถ้าเอาเพดานมาไว้ตรงนี้ ภาษีจริงก้อนนั้นจะถูกล้างเป็นศูนย์เงียบ ๆ */
  return { gross: r2(gross), cash: r2(cash || gross - wht), wht: r2(wht), src, date, ref };
}

/* ── แปลงใบแจ้งหนี้ให้อยู่ในรูปที่ใช้งานได้ (_peakInvNormalize) ─── */
function normInvoice(inv) {
  const net = money(peak.dig(inv, ['netAmount', 'totalAmount', 'grandTotal', 'total']));
  const ppSum = (inv.paidPayments || []).reduce((a, p) => a + money(p.paymentTotal ?? p.amount), 0);
  const remainRaw = peak.dig(inv, ['remainAmount', 'balanceAmount', 'outstanding']);
  const paid = ppSum > 0 ? ppSum
             : money(peak.dig(inv, ['paymentAmount', 'paidAmount']))
               || (remainRaw !== null ? r2(net - money(remainRaw)) : 0);
  const remain = (remainRaw !== null && ppSum === 0) ? money(remainRaw) : r2(net - paid);

  /* v25.2 · "จำนวนเงินที่ต้องชำระ" — ยอดที่ลูกค้าโอนจริง (หลังหักภาษี ณ ที่จ่าย)
   *
   * ‼ อ่านภาษีจาก "หัวใบ" เท่านั้น ห้ามไล่ลงไปในรายการย่อย
   *   peak.dig ไล่ลงไป 4 ชั้นแล้วคืนตัวแรกที่ชื่อตรง — ภาษีของรายการย่อยบรรทัดเดียว
   *   จะถูกหยิบมาเป็นภาษีของทั้งใบ แล้วยอดที่ต้องชำระผิดทันที
   *
   * ‼ เพดาน 25% ของยอดบิล (WHT_MAXPCT code.gs:9200) — เกินนี้ไม่ใช่ภาษีแน่ ๆ
   *   เกินเมื่อไหร่ถือว่าอ่านผิด ให้เป็น 0 ดีกว่าเอาเลขมั่วไปลบยอด */
  const whtRaw = WHT_FIELDS.map(f => money(inv && inv[f])).find(x => x > 0) || 0;
  const wht = (net > 0 && whtRaw > net * 0.25) ? 0 : whtRaw;
  const payableRaw = money(peak.dig(inv, ['payableAmount', 'amountDue', 'netPayable']));
  const payable = payableRaw > 0 ? payableRaw : (wht > 0 ? r2(net - wht) : net);

  const st = clean(peak.dig(inv, ['status', 'documentStatus'])).toLowerCase();
  let payStatus, payKey;
  if (/void|cancel/.test(st))       { payStatus = 'ยกเลิก';      payKey = 'void'; }
  else if (net > 0 && remain <= 0.005) { payStatus = 'ชำระครบแล้ว'; payKey = 'paid'; }
  else if (paid > 0.005)            { payStatus = 'ชำระบางส่วน';  payKey = 'part'; }
  else                              { payStatus = 'ยังไม่ชำระ';   payKey = 'none'; }

  /* ‼ งวดรับเงิน + วันรับล่าสุด — ขาดสองตัวนี้ไม่ได้เด็ดขาด
   *   ลายเซ็นข้อมูลใช้ทั้งคู่ ถ้าไม่มี ลายเซ็นจะเหมือนเดิมตลอด
   *   แล้วการเปลี่ยนงวด/เปลี่ยนวันรับเงินจะถูกรายงานว่า "ไม่มีอะไรเปลี่ยน"
   *   = ข้อมูลค้างเก่าแบบเงียบสนิท ซึ่งแย่กว่าพังให้เห็น */
  const pays = (inv.paidPayments || inv.payments || []).map(p => ({
    ymd: peak.ymd(peak.dig(p, ['paymentDate', 'paidDate', 'date', 'documentDate'])),
    amt: money(p.paymentTotal ?? p.amount ?? p.total),
  })).filter(x => x.amt > 0);
  const lastPayAt = pays.map(x => x.ymd).filter(Boolean).sort().pop() || '';

  /* ‼ อ่านชื่อ/รหัสลูกค้าด้วยตัวอ่านกลางตัวเดียว (core/peak.js pickName) */
  const _nm = peak.pickName(inv);

  return {
    code:   clean(peak.dig(inv, ['code', 'documentCode', 'number'])),
    /* ‼ uuid ของเอกสาร — ใช้ทำลิงก์เปิดใบจริงใน PEAK
     *   อ่านจาก "หัวใบ" เท่านั้น ห้ามให้ dig ไล่ลงไปในรายการย่อย
     *   ไม่งั้นจะได้ id ของบรรทัดสินค้ามาแทน แล้วลิงก์พาไปผิดใบ */
    id:     clean(inv && (inv.id || inv.uuid || inv.documentId || inv.invoiceId)),
    net: r2(net), paid: r2(paid), remain: r2(remain), wht: r2(wht), payable: r2(payable),
    pays, lastPayAt,
    payStatus, payKey,
    /* ═══════════════════════════════════════════════════════════════
     *  🔴 ชื่อลูกค้า PEAK — ต้นเหตุที่ช่องนี้ว่างเกือบทั้งกระดาน
     *
     *  พี่เอสั่ง 12 ก.ย. 69 (คำต่อคำ):
     *    "จัด new agent มาแก้ เรื่อง sync กับ peak ให้จบด้วยนะ
     *     ไม่มีทางที่ peak จะไม่ส่งชื่อมาให้ ทำให้ถูกต้อง 100%"
     *
     *  บรรทัดเดิมตรงนี้คือ
     *      cName: clean(peak.dig(inv, ['contactName','customerName','name']))
     *  ผิด 2 ชั้นพร้อมกัน:
     *   ① ขาดชื่อฟิลด์ที่ PEAK ใช้จริงบนหัวบิล — businessName / companyName
     *      แอปเก่ารู้เรื่องนี้ตั้งแต่ v17.49 (Code.gs:9621-9632) แต่ตอนพอร์ตตกหล่น
     *      "ของเดิมอ่าน name ก่อน เลยได้ ชวง (ชื่อคน) แทน เกียรติไพบูลย์บรรจุภัณฑ์"
     *   ② dig() มุดลงไป 4 ชั้น ⇒ เจอ name ในรายการสินค้าก่อนเมื่อไหร่
     *      จะได้ชื่อสินค้ามานั่งในช่องชื่อลูกค้า — v17.49 เลิกใช้วิธีมุดไปแล้ว
     *
     *  ‼ ใช้ peak.pickName() ที่เดียวทั้งระบบ — อ่านชั้นเดียว ชื่อนิติบุคคลมาก่อน
     *    และเก็บ "ได้มาจากฟิลด์ไหน" (cVia) ไว้ให้ตรวจย้อนได้ ไม่ต้องเชื่อลอย ๆ
     *  ‼ ยังไม่ได้ชื่อจากหัวบิล ≠ PEAK ไม่มีชื่อ — ชั้นต่อไปคือทะเบียนลูกค้า
     *    (ดู fillName_ ข้างล่าง · Code.gs:9409 v18.3)
     * ═══════════════════════════════════════════════════════════════ */
    cName:   clean(_nm.name),
    cPerson: clean(_nm.person),
    cVia:    _nm.name ? 'ใบแจ้งหนี้ · ' + _nm.via : '',
    cCode:   clean(_nm.code),
    terms:  clean(peak.dig(inv, ['paymentTerm', 'paymentTermName', 'creditTerm'])),
    credit: clean(peak.dig(inv, ['creditDay', 'creditDays', 'creditTermDay'])),
    issued: peak.ymd(peak.dig(inv, ['issueDate', 'documentDate'])),
    due:    peak.ymd(peak.dig(inv, ['dueDate'])),
    /* ‼ ชื่อ dueAt ต้องมีด้วย — ตัวคำนวณ "ตรวจอีกทีเมื่อไหร่" อ่านชื่อนี้
     *   ขาดไปแล้วสาขา "เลยกำหนด → ตามทุกวัน" ไม่มีวันทำงาน
     *   ใบที่ค้างชำระจะถูกตรวจทุก 3 วันแทนที่จะเป็นทุกวัน */
    dueAt:  peak.ymd(peak.dig(inv, ['dueDate'])),
  };
}

/* ═══════════════════════════════════════════════════════════════════
 *  🔴 ชั้นที่ ② ของชื่อลูกค้า — ทะเบียนลูกค้าของ PEAK (Code.gs:9409 v18.3)
 *
 *  "ใบแจ้งหนี้ของ PEAK บางกิจการไม่ส่งชื่อลูกค้ามาบนหัวบิลเลย
 *   ส่งมาแค่รหัสลูกค้า → ไปเปิดทะเบียนลูกค้าด้วยรหัสนั้นแล้วเอาชื่อกลับมา"
 *
 *  ‼ นี่คือชั้นที่ระบบใหม่ไม่เคยพอร์ตมา และเป็นเหตุผลที่ช่องชื่อว่างทั้งกระดาน
 *    ทั้งที่ PEAK ส่งชื่อมาให้จริงตามที่พี่เอยืนยัน — แค่ส่งมาคนละที่
 *
 *  ‼ ถามทะเบียนไม่สำเร็จ ≠ ลูกค้ารายนี้ไม่มีชื่อ
 *    ยังเขียนตัวเลขเงินต่อได้ (เงินไม่ได้อยู่ในทะเบียนลูกค้า) แต่ต้องจดเหตุไว้
 *    ห้ามปล่อยให้กลายเป็น "PEAK ไม่มีชื่อลูกค้า" ซึ่งเป็นคำโกหก
 * ═══════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════
 *  🔴 3 สถานะที่ห้ามยุบรวมกันเด็ดขาด — พี่เอโกรธเรื่อง "ข้อความที่โกหก"
 *     มาแล้ว 2 รอบ ห้ามมีรอบที่ 3
 *
 *  ข้อความ 2 ก้อนนี้ถูก "ต่อท้าย" ช่อง ผลตรวจ PEAK แล้วหน้าเว็บอ่านกลับไป
 *  เลือกป้ายให้ถูกใบ  ‼ ต้องตรงกับที่ modules/sales/public/index.html
 *  (ฟังก์ชัน pkWhyChip) อ่าน เป๊ะทุกตัวอักษร — มีเทสต์ผูกสองที่นี้ไว้ด้วยกัน
 *
 *  ‼ ทำไมต่อท้ายช่อง "ผลตรวจ PEAK" ไม่ใช่เพิ่มคอลัมน์ใหม่:
 *    ช่องนี้เป็นช่อง "คำอธิบายผลตรวจของแถวนี้" อยู่แล้ว และมีของเดิมเขียน
 *    ประโยคยาว ๆ ลงไปอยู่ก่อนแล้ว (core/peak-auto.js:317 · modules/sales/index.js:849)
 *    ⇒ ต่อท้ายจึงไม่ได้เปลี่ยนความหมายของช่อง และไม่ต้องแตะผังตาราง
 *  ‼ ห้ามใช้คำว่า "ชื่อลูกค้าไม่ตรง" ในสองก้อนนี้เด็ดขาด —
 *    ตัวนับของคิวนับด้วยคำนั้น (core/peak-queue.js:440) จะเพี้ยนทันที
 * ═══════════════════════════════════════════════════════════════════ */
const NAME_NOTE = {
  /* ถามสำเร็จ ทะเบียนโหลดครบแล้ว แต่ไม่มีรหัสนี้จริง ๆ */
  ABSENT:  '🔎 รหัสลูกค้านี้ไม่มีในทะเบียน PEAK',
  /* ยังถามทะเบียนไม่สำเร็จ — คนละเรื่องกับ "ไม่มี" ‼ */
  ASKFAIL: '🔌 ยังถามทะเบียนลูกค้า PEAK ไม่สำเร็จ',
  /* 🔴 ทะเบียนโหลดมาไม่ครบ — ห้ามสรุปว่า "ไม่มี" เด็ดขาด
   *   พี่เอสั่ง 12 ก.ย. 69: "ต้องไม่มีเพดานสิ ขายของเพิ่มขึ้นทุกวัน"
   *   ลูกค้าที่เพิ่งเพิ่มเข้ามาอาจอยู่ในส่วนที่ยังโหลดไม่ถึง */
  PARTIAL: '📚 ทะเบียนลูกค้าโหลดมาไม่ครบ',
};

/* ต่อท้ายผลตรวจด้วยเหตุผลว่าทำไมชื่อยังว่าง (ถ้ามีเหตุให้บอก)
 * ‼ กรณี partial ต่อท้ายจำนวนที่โหลดมาได้ด้วย — คนอ่านจะได้รู้ว่าขาดไปแค่ไหน */
function nameNote_(d) {
  if (!d || d.cName) return '';
  if (d.nameState === 'error')   return ' · ' + NAME_NOTE.ASKFAIL;
  if (d.nameState === 'partial')
    return ' · ' + NAME_NOTE.PARTIAL + (d.nameRows ? ` (โหลดมาแล้ว ${d.nameRows} ราย)` : '');
  if (d.nameState === 'absent')  return ' · ' + NAME_NOTE.ABSENT;
  return '';
}

async function fillName_(inv, biz, say) {
  if (!inv || inv.cName || !inv.cCode) return inv;
  const log = typeof say === 'function' ? say : () => {};
  const r = await peak.contactName(inv.cCode, biz);
  inv.nameState = r.state;
  if (r.state === 'hit') {
    inv.cName = r.name;
    inv.cVia = 'ทะเบียนลูกค้า · ' + r.via;
    if (!inv.cPerson) inv.cPerson = r.person;
    inv.nameErr = '';
    log(`ชื่อลูกค้าได้จากทะเบียน PEAK (รหัส ${inv.cCode}): ${r.name} [${r.source}]`);
  } else if (r.state === 'error') {
    /* ‼ ยังถามไม่สำเร็จ — ปล่อยชื่อว่างไว้ก่อน แล้วบอกตรง ๆ ว่าเป็นเพราะอะไร
     *   ห้ามแปลว่า "PEAK ไม่มีชื่อลูกค้ารายนี้" เด็ดขาด */
    inv.nameErr = r.err;
    log(`‼ ถามทะเบียนลูกค้ารหัส ${inv.cCode} ไม่สำเร็จ — ชื่อยังว่างไว้ก่อน · ${r.err}`);
  } else if (r.state === 'partial') {
    /* 🔴 ทะเบียนโหลดมาไม่ครบ — ลูกค้ารายนี้อาจอยู่ในส่วนที่ยังโหลดไม่ถึง
     *   ‼ ห้ามสรุปว่า "ไม่มีในทะเบียน" เด็ดขาด นั่นคือคำตอบที่มั่นใจแต่ผิด */
    inv.nameErr = r.err;
    inv.nameRows = r.rows || 0;
    log(`‼ ${r.err} — ยังสรุปไม่ได้ว่ารหัส ${inv.cCode} มีหรือไม่มีในทะเบียน`);
  } else {
    inv.nameErr = '';
    log(`ทะเบียนลูกค้าของ PEAK ไม่มีรหัส ${inv.cCode} จริง ๆ (ถามสำเร็จแล้ว) [${r.source}]`);
  }
  return inv;
}

/* ═══════════════════════════════════════════════════════════════════
 *  เทียบชื่อนิติบุคคล — ตัวเดียวของทั้งระบบ (pkNameKey + _peakNameSame)
 *
 *  🔴 บทเรียนวันนี้ (12 ก.ย. 69) ซึ่งเจอซ้ำกับที่โมดูล Projects เจอมาก่อน:
 *    ชื่อที่มาจาก Google Sheet และจากระบบภายนอกมี "อักขระที่มองไม่เห็น" ปนมา
 *    NBSP (U+00A0) · ช่องว่างซ้อนสองตัว · ZWSP (U+200B) ฯลฯ
 *    ⇒ เทียบด้วย trim().toLowerCase() เฉย ๆ จะไม่ตรงแบบเงียบสนิท
 *
 *  ‼ ใช้ nrm_() ของ modules/projects/lib.js — ตัวเดียวกับที่ทั้ง repo ใช้
 *    ห้ามเขียนตัวล้างอักขระซ้ำขึ้นมาใหม่อีกตัว (จะหลุดจากกันวันใดวันหนึ่ง)
 *    แล้วจึง "ตัดช่องว่างทิ้งทั้งหมด" ก่อนเทียบ ตามกติกาที่ตกลงกันทั้ง repo
 *
 *  ‼ และต้องเทียบแบบ "ครอบกัน" ไม่ใช่เท่ากันเป๊ะ (Code.gs:7924 _peakNameSame)
 *    "บริษัท คอมไบเนอรี่ จำกัด" ที่เซลส์คีย์ กับ "คอมไบเนอรี่" บนใบจริง
 *    คือเจ้าเดียวกัน — ของเดิมรู้ แต่ระบบใหม่เทียบ !== เฉย ๆ
 *    ⇒ ตัวเลข "ชื่อไม่ตรง" บนหน้าจอจึงพองเกินจริงมาตลอด
 * ═══════════════════════════════════════════════════════════════════ */
const { nrm_ } = require('../projects/lib');

const nameKey = s => nrm_(s).toLowerCase()
  .replace(/\(.*?\)/g, ' ')
  .replace(/บริษัท|บจก\.?|บมจ\.?|หจก\.?|ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ|จำกัด|มหาชน|ร้าน|คุณ|company|limited|co\.?,?\s*ltd\.?|ltd\.?|inc\.?|part\.?/g, ' ')
  /* ‼ ตัดทุกอย่างที่ไม่ใช่ตัวอักษร/ตัวเลข = ตัดช่องว่างทุกชนิดทิ้งไปด้วยในตัว
   *   (รวม NBSP · ช่องว่างซ้อน · ZWSP ที่ nrm_ ปัดมาเป็นช่องว่างแล้ว) */
  .replace(/[^a-z0-9ก-๙]/g, '');

/**
 * ชื่อสองอันนี้คือลูกค้ารายเดียวกันไหม — ยกจาก _peakNameSame (Code.gs:7924)
 * @return {boolean|null} null = ตัดสินไม่ได้ (ข้างใดข้างหนึ่งว่าง) ‼ ไม่ใช่ "ไม่ตรง"
 */
function nameSame(a, b) {
  const x = nameKey(a), y = nameKey(b);
  if (!x || !y) return null;
  if (x === y) return true;
  /* ‼ ครอบกันได้ก็ถือว่าเจ้าเดียวกัน — แต่ฝั่งสั้นต้องยาวพอจะมีความหมาย
   *   ไม่งั้นชื่อ 1 ตัวอักษรจะไปตรงกับทุกคนในระบบ (ของเดิมไม่มีด่านนี้) */
  const short = x.length <= y.length ? x : y;
  if (short.length < 2) return false;
  return x.includes(y) || y.includes(x);
}

/** เลือกใบที่ใช้ได้จากผลที่ PEAK คืนมา (v31.6 · v32.0 · v32.7) */
/**
 * เลือกใบที่ใช่จากผลที่ PEAK คืนมา
 *
 * ‼ ต้องเทียบเลขที่ได้กับเลขที่ถามเสมอ (code.gs:10036)
 *   PEAK คืนได้ถึง 20 ใบต่อคำขอ และเคยคืนใบที่เลขไม่ตรงมาด้วย
 *   ถ้าไม่เทียบ = เอายอดของลูกค้าคนอื่นมาเขียนทับ ซึ่งเป็นความผิดพลาดที่ร้ายที่สุด
 *   ที่ระบบนี้ทำได้ — เงินผิดคน แล้วไหลต่อไปทั้งรายงานและการ์ดลูกหนี้
 */
function sameRef(doc, want) {
  const w = String(want || '').replace(/\s+/g, '').toUpperCase();
  if (!w) return true;
  for (const k of ['code', 'documentCode', 'reference', 'documentReference'])
    if (String(doc && doc[k] || '').replace(/\s+/g, '').toUpperCase() === w) return true;
  return false;
}

function pickDoc(list, want) {
  let arr = Array.isArray(list) ? list : [];
  /* ‼ กรองให้เหลือเฉพาะใบที่เลขตรงกับที่ถาม
   *   PEAK คืนได้ถึง 20 ใบต่อคำขอ ถ้าไม่กรองแล้วหยิบใบแรก
   *   = เอายอดของลูกค้าคนอื่นมาเขียนทับ ความผิดพลาดที่ร้ายที่สุดที่ระบบนี้ทำได้
   *   คืนมาใบเดียวไม่ตรงเลข → ยอมรับได้ (ของเดิมก็ยอม code.gs:10041)
   *   คืนมาหลายใบไม่ตรงสักใบ → ไม่เอาเลย */
  if (want && arr.length) {
    const exact = arr.filter(d => sameRef(d, want));
    if (exact.length) arr = exact;
    else if (arr.length > 1) return { doc: null, state: 'miss' };
  }
  const live = arr.filter(d => !isVoid(d));
  if (!live.length) return { doc: null, state: arr.length ? 'void' : 'miss' };
  const approved = live.filter(d => !isDraft(d));
  /* v32.7 "อนุมัติแล้ว" ชนะ "ใบร่าง" */
  if (approved.length === 1) return { doc: approved[0], state: 'ok' };
  if (approved.length > 1)   return { doc: null, state: 'dup' };
  return { doc: null, state: 'draft' };
}

/* ═══════════════════════════════════════════════════════════════════
 *  ถามเอกสาร 1 ใบด้วยท่าเดียว — ถอดจาก pkAsk() code.gs:10003
 *
 *  ลำดับการเลือกใบ (v31.6 · v32.0 · v32.7) — ห้ามสลับ:
 *    ① เลขตรง + ยัง active
 *    ② PEAK คืนมาใบเดียว = ถือว่า PEAK กรองให้แล้ว (ยอมรับ)
 *    ③ มีแต่ใบที่ยกเลิก → ไม่ใช้ แต่แยกจาก "ไม่มีใบนี้เลย" ให้ชัด
 *    ④ อนุมัติแล้วใบเดียว + มีใบร่างด้วย → ใช้ใบที่อนุมัติ
 *    ⑤ ใบร่างล้วน → ไม่เขียน ตีตรา "ใบร่าง"
 *    ⑥ active หลายใบ → ‼ ไม่เดา ส่งผู้เข้าชิงกลับไปให้ชั้นบนตัดสิน
 * ═══════════════════════════════════════════════════════════════════ */
async function askDoc(kind, pkey, ref, biz) {
  const ep = kind === 'QT' ? 'Quotations' : 'Invoices';
  let arr = null, err = '';
  try { arr = peak.listOf(await peak.get(ep, { [pkey]: ref, limit: 20 }, biz)); }
  catch (e) { err = String(e && e.message ? e.message : e).slice(0, 180); }
  if (err) return { ok: false, doc: null, err, n: 0, pkey };
  arr = arr || [];
  if (!arr.length) return { ok: true, doc: null, err: '', n: 0, pkey };

  const up = String(ref).replace(/\s+/g, '').toUpperCase();
  const act = [], voids = [];
  for (const d of arr) {
    const c = String(d.code || d.documentCode || '').replace(/\s+/g, '').toUpperCase();
    const r = String(d.reference || d.referenceCode || '').replace(/\s+/g, '').toUpperCase();
    if (!(c === up || r === up)) continue;
    (isVoid(d) ? voids : act).push(d);
  }
  /* PEAK กรองให้แล้ว คืนมาใบเดียว = ถือว่าใช่ (ของเดิมก็ยอม code.gs:10041) */
  if (!act.length && !voids.length && arr.length === 1)
    (isVoid(arr[0]) ? voids : act).push(arr[0]);

  const brief = x => ({
    code: clean(x.code || x.documentCode),
    /* ‼ ใช้ตัวอ่านชื่อกลาง — ไม่งั้นรายชื่อ "ผู้เข้าชิง" ตอนเลขซ้ำจะว่างเปล่า
     *   แล้วคนที่ต้องตัดสินใจว่าใบไหนใช่ ก็ไม่มีอะไรให้ดูเลย */
    name: clean(peak.pickName(x).name),
    cCode: clean(peak.pickName(x).code),      /* 🔴 รอบ 226 — หัวใบไม่มีชื่อ ก็ยังเปิดทะเบียนลูกค้าด้วยรหัสได้ */
    net: money(peak.dig(x, ['netAmount', 'grandTotal', 'totalAmount', 'total'])),
    status: clean(x.status), statusName: clean(x.statusName || x.documentStatus),
  });
  /* 🔴 รอบ 226 — "เลขนี้เคยมีใบที่ถูกยกเลิก" ต้องบอกชั้นบนเสมอ แม้จะมีใบที่ยังใช้ได้อยู่ด้วย
   *   (เดิมบอกเฉพาะตอนไม่มีใบที่ใช้ได้เลย ⇒ ชั้นบนไม่มีทางรู้ว่าเลขนี้ถูกยกเลิกแล้วเอาไปออกใหม่ให้ลูกค้ารายอื่น) */
  const voidInfo = voids.length ? { voidN: voids.length, voidCands: voids.slice(0, 5).map(brief) } : {};

  /* v32.7 "อนุมัติแล้ว" ชนะ "ใบร่าง" */
  const drafts = act.filter(isDraft), appr = act.filter(d => !isDraft(d));
  let use = act;
  if (appr.length === 1 && drafts.length) use = appr;
  else if (!appr.length && drafts.length)
    return { ok: true, doc: null, err: '', n: arr.length, pkey,
             draft: true, draftN: drafts.length, draftCands: drafts.slice(0, 5).map(brief),
             voidN: voids.length };

  if (use.length > 1)
    return { ok: true, doc: null, err: '', n: arr.length, pkey,
             dup: true, dupN: use.length,
             cands: use.slice(0, 5).map(brief), candRaw: use.slice(0, 5),
             voidN: voids.length, voidCands: voidInfo.voidCands || [] };

  if (!use.length)
    return { ok: true, doc: null, err: '', n: arr.length, pkey,
             voided: !!voids.length, voidN: voids.length,
             voidCands: voids.slice(0, 5).map(brief),
             voidCode: voids.length ? clean(voids[0].code || voids[0].documentCode) || ref : '' };

  return { ok: true, doc: use[0], raw: use[0], err: '', n: arr.length, pkey, ...voidInfo };
}

/* ═══════════════════════════════════════════════════════════════════
 *  ถามเอกสาร 1 ใบ ครบทุกท่า — ถอดจาก pkFetchDoc() code.gs:9861
 *
 *  ล็อกท่าแล้ว   : 1 คำขอ (+รูปแบบเลขสำรองไม่เกิน 2)
 *  ยังไม่ล็อกท่า : ลองทีละท่ากับเลขหลัก เจอเมื่อไหร่ล็อกทันที
 *
 *  ‼ v28.2 ท่าที่ล็อกไว้อาจผิด — ของเดิมยอมแพ้ตรงนี้ ไม่เคยลองท่าอื่นอีก
 *    "มีเลขแต่ไม่เจอ" = วิธีค้นหาผิด ไม่ใช่ข้อมูลไม่มี → ต้องลองท่าอื่นก่อนสรุป
 *    เจอด้วยท่าอื่น = เปลี่ยนท่าให้เองทันที ใบถัด ๆ ไปได้ประโยชน์
 *    ต้นทุน +1 คำขอเฉพาะใบที่หาไม่เจอ · ใบที่เจอปกติไม่เสียเพิ่มเลย
 *
 *  ‼ ระหว่างลองหลายท่า ถ้าเคยเจอ "ยกเลิก" หรือ "เลขซ้ำ" ต้องจำไว้บอกข้างบน
 *    ไม่งั้นจะกลายเป็น "ไม่พบใน PEAK" ซึ่งคนละเรื่องกันและทำให้ตามหาผิดทาง
 * ═══════════════════════════════════════════════════════════════════ */
async function fetchDoc(kind, ref, alts, biz) {
  const lock = await paramGet(kind);
  let last = { ok: true, doc: null, err: '', n: 0 };
  let sawVoid = null, sawDup = null, sawDraft = null;
  const keep = R => {
    if (R && R.voided && !sawVoid) sawVoid = R;
    if (R && R.dup && !sawDup) sawDup = R;
    /* ‼ ของเดิมจำไว้แค่ "ยกเลิก" กับ "เลขซ้ำ" — ลืม "ใบร่าง" ไว้ข้อหนึ่ง
     *   (v32.7 มาทีหลัง เลยไม่ได้ใส่ในตัวจำของ pkFetchDoc)
     *   ผลคือ: ท่าแรกเจอใบร่าง ท่าที่สองได้ 0 แถว → คำตอบสุดท้ายกลายเป็น
     *   "ไม่พบใน PEAK" ทั้งที่เพิ่งเห็นใบร่างของมันมากับตา
     *   เติมให้ตรงนี้ด้วยเหตุผลเดียวกับอีกสองอย่าง — ไม่กระทบเรื่องเงินเลย
     *   เพราะใบร่างไม่เคยถูกเอามาเขียนตัวเลขอยู่แล้ว */
    if (R && R.draft && !sawDraft) sawDraft = R;
    return R;
  };
  const fin = R => {
    if (R && !R.doc && sawDup) Object.assign(R, {
      dup: true, dupN: sawDup.dupN, cands: sawDup.cands, candRaw: sawDup.candRaw });
    if (R && !R.doc && sawVoid) Object.assign(R, {
      voided: true, voidN: sawVoid.voidN, voidCode: sawVoid.voidCode, voidCands: sawVoid.voidCands });
    if (R && !R.doc && sawDraft) Object.assign(R, {
      draft: true, draftN: sawDraft.draftN, draftCands: sawDraft.draftCands });
    return R;
  };

  if (lock) {
    for (const one of [ref].concat(alts || []).slice(0, 3)) {
      if (!one) continue;
      const R = keep(await askDoc(kind, lock, one, biz));
      if (R.doc || !R.ok) return R;
      last = R;
    }
    for (const alt of PK_PARAM.TRY) {
      if (alt === lock) continue;
      const R3 = keep(await askDoc(kind, alt, ref, biz));
      if (!R3.ok) return R3;
      if (R3.doc) { await paramSet(kind, alt); R3.healed = { from: lock, to: alt }; return R3; }
      last = R3;
    }
    return fin(last);
  }

  for (const t of PK_PARAM.TRY) {
    const R2 = keep(await askDoc(kind, t, ref, biz));
    if (!R2.ok) return R2;
    if (R2.doc) { await paramSet(kind, t); return R2; }
    last = R2;
  }
  return fin(last);
}

/* ═══════════════════════════════════════════════════════════════════
 *  เลขเดียวได้หลายใบ — ตัดสินด้วยชื่อลูกค้า + ชื่อเซลส์
 *  ถอดจาก _pkPickByRow() code.gs:10102 (พี่เอสั่งเอง v32.1)
 *
 *  เกิดได้จริงเมื่อ "คนอื่นเอาเลขเดิมไปเปิดออเดอร์ใหม่"
 *  ‼ เข้าเงื่อนไข "เหลือใบเดียว" เท่านั้นถึงจะใช้
 *    ยังเหลือหลายใบ = คงกฎ "ไม่เดา" เหมือนเดิม เรื่องเงินพลาดไม่ได้
 * ═══════════════════════════════════════════════════════════════════ */
function pickByRow(cands, rowCompany, rowSale) {
  if (!cands || cands.length < 2) return null;
  const ck = nameKey(rowCompany || '');
  const sk = nrm_(rowSale).toLowerCase();
  const nameHit = [], saleHit = [];
  for (const it of cands) {
    /* ‼ ตัวอ่านชื่อกลางตัวเดียวกับที่ใช้เขียนลงฐานข้อมูล
     *   ถ้าอ่านคนละวิธี ใบที่ "เลขซ้ำ" จะตัดสินด้วยข้อมูลคนละชุดกับที่แสดงบนจอ */
    const nm = nameKey(peak.pickName(it).name);
    if (ck && nm && (nm === ck || nm.includes(ck) || ck.includes(nm))) nameHit.push(it);
    const sl = nrm_(peak.dig(it, ['salesPerson', 'salesperson', 'salesPersonName',
                                  'seller', 'employeeName'])).toLowerCase();
    if (sk && sl && (sl === sk || sl.includes(sk) || sk.includes(sl))) saleHit.push(it);
  }
  /* ตรงทั้งชื่อลูกค้าและชื่อเซลส์ = มั่นใจที่สุด — แต่ต้องเหลือใบเดียว
   * มี 2 ใบที่ตรงทั้งคู่ = แยกไม่ออกจริง ๆ ห้ามเดาเด็ดขาด */
  const both = nameHit.filter(x => saleHit.includes(x));
  if (both.length === 1) return { doc: both[0], why: 'ตรงทั้งชื่อลูกค้าและชื่อเซลส์' };
  if (both.length > 1) return null;
  if (nameHit.length === 1) return { doc: nameHit[0], why: 'ชื่อลูกค้าตรงกับที่คีย์ไว้' };
  if (saleHit.length === 1) return { doc: saleHit[0], why: 'ชื่อพนักงานขายบนใบตรงกับเจ้าของงาน' };
  return null;
}


/* ═══════════════════════════════════════════════════════════════════
 *  🔴 เขียน "ใบเสร็จจริงรายงวด" ลง app.cash_flow — ชั้น ① ของหน้า Cash Flow
 *
 *  พี่เอทัก 9 ก.ย. 69 พร้อมหลักฐานจาก PEAK:
 *    "ก.กนก มีรับชำระ 3 งวดนะ ไม่ใช่แค่งวดเดียว แล้วสรุปออกมาว่า
 *     ชำระครบได้ยังงัย มันมั่วนะ"
 *    (PEAK: RT-2026073100008 · RT-2026062900021 · RT-2026051900024)
 *
 *  🔴 ต้นเหตุ: ตาราง app.cash_flow "ไม่มีใครเขียนลงไปเลยสักที่"
 *     เราถาม PEAK ได้ใบเสร็จมาครบทุกงวดจริง (rcpts) — แล้วทิ้งไป
 *     เก็บไว้แค่ข้อความสรุป "N งวด · รับจริง X" ในช่องเดียว
 *     ⇒ หน้า Cash Flow หาชั้น ① ไม่เจอ ต้องถอยไปชั้น ② "ยอดที่ PEAK ยืนยัน"
 *       ซึ่งเป็นยอดรวมก้อนเดียว แล้ว "เกลี่ยตามวันที่เซลส์คีย์"
 *     ⇒ 3 งวดจริงจึงกลายเป็น "1 งวด · 1 ใบบิล" และวันที่ก็ไม่ใช่วันรับเงินจริง
 *
 *  ‼ เขียนทีละงวด 1 แถว = 1 ใบ RT — ไม่ยุบรวม
 *    key = เลขบิล|วันที่|ยอด×100 (กติกาเดิม Code.gs:11359) กันนับซ้ำ
 *  ‼ ใบเสร็จที่ไม่มีวันที่หรือยอด 0 ไม่เขียน — ชั้น ① ต้องเชื่อได้ 100%
 *    ไม่ได้เขียน = ถอยไปชั้น ② เหมือนเดิม ไม่ใช่ตัวเลขหาย
 * ═══════════════════════════════════════════════════════════════════ */
async function saveCashFlow_(rcpts, inv, row, out, log) {
  if (!Array.isArray(rcpts) || !rcpts.length) return 0;
  const say = typeof log === 'function' ? log : () => {};
  const g = n => clean(row[n]);

  const rows = [];
  for (const rc of rcpts) {
    const amt = r2(rc.gross || (rc.cash + rc.wht));
    if (!(amt > 0) || !rc.date) continue;
    const iv = clean(inv.code) || out.iv;
    rows.push({
      key: `${iv}|${rc.date}|${Math.round(amt * 100)}`,
      paid_at: rc.date,
      ym: String(rc.date).slice(0, 7),
      iv,
      job_code: out.job || null,
      customer: clean(inv.cName) || out.company || null,
      sale: clean(row['Create By']) || clean(row['Created By']) || null,
      amount: amt,
      receipt_no: rc.ref || null,          /* ← เลข RT ตัวจริง */
      wht: r2(rc.wht || 0),
      cash: r2(rc.cash || 0),
      issued_at: inv.issued || null,
      due_at: inv.due || null,
      bill_amt: r2(inv.payable || inv.net || 0) || null,
      slot: rcpts.length > 1 ? `งวด ${rcpts.indexOf(rc) + 1}/${rcpts.length}` : 'งวดเดียว',
      terms: clean(inv.terms) || null,
      days: (inv.issued && rc.date)
        ? Math.max(0, Math.round((Date.parse(rc.date) - Date.parse(inv.issued)) / 86400000))
        : null,
    });
  }
  if (!rows.length) return 0;

  try {
    /* ‼ upsert ตาม key — ซิงก์ซ้ำกี่รอบก็ไม่เกิดแถวซ้ำ และแก้ยอดย้อนหลังได้ */
    await db.upsert('cash_flow', rows, 'key');
    say(`เขียนใบเสร็จจริงลง cash_flow ${rows.length} งวด (${rows.map(r => r.receipt_no || '-').join(', ')})`);
    return rows.length;
  } catch (e) {
    /* ‼ เขียนไม่ได้ ต้องไม่ล้มการตรวจทั้งใบ — ชั้น ② ยังทำงานได้อยู่
     *   แต่ต้องดังพอให้รู้ ไม่ใช่เงียบแบบที่ผ่านมา */
    say('‼ เขียน cash_flow ไม่สำเร็จ (หน้า Cash Flow จะถอยไปใช้ชั้น ②): ' + e.message);
    return 0;
  }
}

/* ── ตรวจ 1 แถว ───────────────────────────────────────────────── */
async function checkRow(row) {
  const g = n => clean(row[n]);
  const out = { row: row._row, job: g('รหัสงาน'), company: g('ชื่อบริษัท'),
                iv: g('เลขที่ QO / IV'), sale: money(row['ยอดขาย (บาท)']),
                set: {}, note: '', ss: '' };

  if (!/ปิดการขาย/.test(g('Lead Status'))) { out.ss = SS.NOTCLOSED; out.skip = true; return out; }
  if (!out.iv)        { out.ss = SS.NODOC; out.skip = true; return out; }
  if (isFlow(out.iv)) { out.ss = SS.FLOW;  out.skip = true; return out; }

  const ivRefs = refsOf(out.iv).filter(x => x.kind === 'IV');
  const qtRefs = refsOf(out.iv).filter(x => x.kind === 'QT');
  if (!ivRefs.length && !qtRefs.length) { out.ss = SS.NODOC; out.skip = true; return out; }

  /* ── เลือกบริษัทที่จะถาม ────────────────────────────────────────
   *  ‼ เดาจากความยาวเลขเอกสารได้ แต่เดาผิดได้เหมือนกัน
   *    เดาผิดแล้วต้องถอยไปถามกิจการที่เหลือ ห้ามสรุปว่า "ไม่พบ" ทันที
   *    (กฎเดิม code.gs:16469 — เคยตอบ "ไม่พบ" ทั้งที่ใบอยู่ในอีกกิจการ) */
  const ready = peak.configuredList();
  if (!ready.length) {
    out.ss = SS.WAIT; out.skip = true;
    out.note = 'ยังไม่ได้ตั้งกุญแจ PEAK ของกิจการไหนเลย';
    return out;
  }
  const guess = ivRefs.length ? peak.bizOfDoc(ivRefs[0].ref) : '';
  const bizHint = (guess && peak.isConfigured(guess)) ? guess
                : (peak.isConfigured(g('บริษัทที่ขาย')) ? g('บริษัทที่ขาย') : '');
  const tryBiz = bizHint ? [bizHint].concat(ready.filter(b => b !== bizHint)) : ready.slice();

  /* ═══════════════════════════════════════════════════════════════
   *  ไล่ถามทีละกิจการ ทีละเลข — ถอดจากขั้น ③ ของ crmqRun() code.gs:16434
   *
   *  ‼ ถาม IV กับ QT "ในรอบเดียวกัน" ไม่ใช่ไล่ IV ให้ครบทุกกิจการก่อน
   *    แล้วค่อยเริ่มไล่ QT ใหม่ทั้งหมด — แบบหลังเสียคำขอเป็นเท่าตัวฟรี ๆ
   *
   *  ‼ ของที่ต้องจำระหว่างทาง (v31.6 · v32.0 · v32.7):
   *    เจอ "ใบถูกยกเลิก" / "เลขซ้ำ" / "ใบร่าง" ที่กิจการไหนก็ต้องจำไว้
   *    ไม่งั้นสุดท้ายจะสรุปว่า "ไม่พบใน PEAK" ซึ่งคนละเรื่องกันโดยสิ้นเชิง
   * ═══════════════════════════════════════════════════════════════ */
  const saleName = clean(row['Create By']) || clean(row['Created By']);
  const allRefs = ivRefs.concat(qtRefs);
  let ivDoc = null, quDoc = null, foundBiz = '';
  let voidHit = null, dupHit = null, draftHit = null;
  let apiErr = '', healed = null, pickedBy = '';
  let ivVoids = [];           /* 🔴 รอบ 226 — ใบที่ถูกยกเลิกของ "เลขเดียวกับใบแจ้งหนี้ที่ได้มา" */

  for (const b of tryBiz) {
    for (const r of allRefs) {
      if (r.kind === 'IV' && ivDoc) continue;
      if (r.kind === 'QT' && quDoc) continue;

      let R = await fetchDoc(r.kind, r.ref, r.alts, b);

      /* v32.1 · เลขเดียวได้หลายใบ → ตัดสินด้วยชื่อลูกค้า + ชื่อเซลส์ของแถวนี้
       *   ก่อนจะยอมแพ้ (พี่เอสั่งเอง) — เหลือใบเดียวเท่านั้นถึงจะใช้ */
      if (R.dup && R.candRaw && R.candRaw.length) {
        const pick = pickByRow(R.candRaw, out.company, saleName);
        if (pick) R = { ok: true, doc: pick.doc, n: R.n, pickedBy: pick.why,
                        voidN: R.voidN || 0, voidCands: R.voidCands || [] };
      }

      /* ‼ ถามไม่สำเร็จ ≠ ไม่พบเอกสาร — จำ error ไว้ แล้วไปลองกิจการอื่นต่อ */
      if (!R.ok) { apiErr = apiErr || R.err; continue; }

      if (R.healed && !healed)   healed   = R.healed;
      if (R.voided && !voidHit)  voidHit  = { code: R.voidCode || r.ref, n: R.voidN || 1 };
      if (R.dup    && !dupHit)   dupHit   = { code: r.ref, n: R.dupN || 2, cands: R.cands || [] };
      if (R.draft  && !draftHit) draftHit = { code: r.ref, n: R.draftN || 1, cands: R.draftCands || [] };

      if (R.doc) {
        if (r.kind === 'IV') { ivDoc = R.doc; ivVoids = R.voidCands || []; } else quDoc = R.doc;
        if (R.pickedBy && !pickedBy) pickedBy = R.pickedBy;
        if (!foundBiz) foundBiz = b;
      }
    }
    /* ‼ เดากิจการจากรูปแบบเลขผิดได้ — ยังไม่ได้ของที่ต้องการต้องถอยไปถามที่เหลือ
     *   (กฎเดิม code.gs:16469 — เคยตอบ "ไม่พบ" ทั้งที่ใบอยู่ในอีกกิจการ) */
    if (ivRefs.length ? ivDoc : quDoc) break;
  }
  let biz = foundBiz || tryBiz[0];
  out.biz = biz;
  if (healed)   out.healed = healed;      /* เปลี่ยนท่าค้นหาให้เองแล้ว */
  if (pickedBy) out.pickedBy = pickedBy;  /* เลขซ้ำแต่ตัดสินได้ ด้วยเหตุผลอะไร */

  /* ═══════════════════════════════════════════════════════════════
   *  v32.8 · คีย์มาแต่ใบเสนอราคา → ตามหาใบแจ้งหนี้ที่ออกจากใบนั้นให้เอง
   *  (คำสั่งพี่เอ 01/09 · ถอดจาก pkIvFromQuo() code.gs:10555)
   *
   *  ‼ ถ้าไม่ทำข้อนี้ แถวพวกนี้จะค้างเป็น "📄 พบใบเสนอราคา" ตลอดกาล
   *    ไม่มียอดค้างชำระ ไม่ขึ้นการ์ดลูกหนี้ ทั้งที่ออกบิลไปแล้วจริง
   * ═══════════════════════════════════════════════════════════════ */
  if (quDoc && !ivDoc) {
    const q = normQuo(quDoc);
    if (q.toIv) {
      const R = await fetchDoc('IV', q.toIv, [], biz);
      if (R.doc) { ivDoc = R.doc;
        out.ivFromQuo = { qo: q.code, iv: q.toIv, via: 'PEAK บอกเลขใบแจ้งหนี้มาเอง' }; }
    }
    if (!ivDoc && q.code) {
      const QI = await ivFromQuo(q.code, biz);
      if (QI.doc) { ivDoc = QI.doc;
        out.ivFromQuo = { qo: q.code,
                          iv: clean(peak.dig(QI.doc, ['code', 'documentCode'])), via: QI.via }; }
      else if (QI.dup && !dupHit)
        dupHit = { code: q.code, n: QI.dupN || 2, cands: QI.cands || [], viaQuo: true };
      else if (QI.draft && !draftHit)
        draftHit = { code: q.code, n: QI.draftN || 1, cands: QI.draftCands || [], viaQuo: true };
    }
  }

  /* ── ไม่ได้เอกสารเลย → ตัดสินว่าเป็นเพราะอะไรกันแน่ ───────────
   *  ‼ ลำดับนี้สำคัญ: สามอย่างแรกคือ "เจอของจริงแล้วแต่ใช้ไม่ได้"
   *    ซึ่งสรุปได้เลยไม่ต้องรอกิจการอื่น ต่างจาก "ไม่พบ" ที่ยังสรุปไม่ได้ */
  if (!ivDoc && !quDoc) {
    if (dupHit) {
      out.ss = SS.DUP;
      out.cands = dupHit.cands;
      out.note = `PEAK คืนใบที่อนุมัติแล้ว ${dupHit.n} ใบสำหรับเลข ${dupHit.code} — ` +
                 'ชื่อลูกค้ากับชื่อเซลส์ก็ยังแยกไม่ออก ระบบไม่เดาให้';
      return out;
    }
    if (voidHit) {
      out.ss = SS.VOID;
      out.note = `เลข ${voidHit.code} มีใน PEAK จริง แต่ใบถูกยกเลิก ` +
                 `(${voidHit.n} ใบ) — ไม่ใช่ "ไม่พบ" และห้ามเอายอดมาเขียน`;
      return out;
    }
    if (draftHit) {
      out.ss = SS.DRAFT;
      out.cands = draftHit.cands;
      out.note = `เลข ${draftHit.code} เป็นใบร่าง ยังไม่อนุมัติ (${draftHit.n} ใบ)`;
      return out;
    }
    /* ‼ ถาม PEAK ไม่สำเร็จ = ยังไม่รู้ว่ามีหรือไม่มี ห้ามตีตราว่า "ไม่พบ" */
    if (apiErr) { out.ss = SS.ERR; out.note = 'ถาม PEAK ไม่สำเร็จ · ' + apiErr; return out; }
    /* ‼ ยังตั้งกุญแจไม่ครบทุกกิจการ = ยังสรุปไม่ได้ว่า "ไม่พบ"
     *   เทียบกับ "จำนวนกิจการที่ระบบรู้จัก" ไม่ใช่เลข 2 ตายตัว
     *   (เปิดกิจการที่ 3 เมื่อไหร่ เลขตายตัวจะเงียบ ๆ กลายเป็นคำตอบผิด) */
    const bizN = (typeof peak.bizAll === 'function') ? peak.bizAll().length : 2;
    if (ready.length < bizN) {
      out.ss = SS.PEND;
      out.note = 'ถาม ' + ready.join(' · ') + ' แล้วไม่พบ · ยังไม่ได้ถามอีกกิจการ ' +
                 '(แต่ละกิจการใช้รูปแบบเลขเอกสารคนละแบบ)';
      return out;
    }
    /* ‼ เคยซิงก์เจอมาก่อนแล้วรอบนี้หาย = คนละเรื่องกับ "ไม่เคยเจอ"
     *   ของเดิมแยกไว้เพราะห้ามทับของเดิมทิ้ง (code.gs:16513) */
    const wasFound = clean(row[COL.SSTAT] || row[dbCol(COL.SSTAT)]) === SS.OK
                  || money(row[COL.AMT] || row[dbCol(COL.AMT)]) > 0;
    out.ss = wasFound ? SS.LOST : SS.MISS;
    if (wasFound) out.note = 'รอบก่อนเคยเจอใบนี้ใน PEAK — รอบนี้หาไม่เจอ ยังไม่ลบของเดิมทิ้ง';
    return out;
  }

  /* ── มีแต่ใบเสนอราคา ยังไม่ออกใบแจ้งหนี้ ───────────────────── */
  if (!ivDoc) {
    const q = normQuo(quDoc);
    /* 🔴 ใบเสนอราคาก็มีชื่อลูกค้าบนหัวใบเหมือนกัน (Code.gs:13345 v17.49)
     *   ของเดิมเขียนช่อง "ชื่อลูกค้า PEAK" ให้แถวพวกนี้ด้วย — ระบบใหม่ลืมไป
     *   ⇒ แถวที่ยังไม่ออกใบแจ้งหนี้จึงชื่อว่างตลอดกาล ทั้งที่ PEAK ส่งมาแล้ว */
    try { await fillName_(q, biz, row._log); }
    catch (e) { q.nameErr = String(e && e.message ? e.message : e).slice(0, 180); }
    out.quo = q;
    out.ss = SS.QUO;
    out.set = {
      [COL.QUO]:   q.code,
      [COL.QSTAT]: q.status,
      [COL.QAMT]:  q.net,
      [COL.CNAME]: q.cName,
      [COL.CCODE]: q.cCode,
      /* v17.37 · ใบเสนอราคาถูกแปลงเป็นใบแจ้งหนี้ใบไหนแล้ว
       *   PEAK บอกมาเองในช่อง invoiceCode — ไม่ได้เดาจากเลข */
      [COL.QLINK]: q.toIv,
      [COL.URL]:   docUrl('qt', q.id),
      /* ‼ ต่อท้ายเหตุผลว่าทำไมชื่อลูกค้ายังว่าง — หน้าเว็บอ่านตรงนี้เลือกป้าย */
      [COL.VERDICT]: 'ℹ️ มีใบเสนอราคาแล้ว · ยังไม่ออกใบแจ้งหนี้' + nameNote_(q),
      [COL.PAT]:   nowStamp(),
      [COL.SSTAT]: SS.QUO,
    };
    return out;
  }

  const inv = normInvoice(ivDoc);
  if (quDoc) out.quo = normQuo(quDoc);

  /* 🔴 ชื่อลูกค้ายังว่าง แต่มีรหัสลูกค้า → เปิดทะเบียนลูกค้าของ PEAK ต่อ (v18.3)
   *   ‼ ขั้นนี้ห้ามล้มทั้งใบ — เงินไม่ได้อยู่ในทะเบียนลูกค้า
   *     ถามไม่ได้ก็ยังเขียนยอดต่อได้ แค่จดไว้ว่าทำไมชื่อยังว่าง */
  try { await fillName_(inv, biz, row._log); }
  catch (e) { inv.nameErr = String(e && e.message ? e.message : e).slice(0, 180); }

  /* ═══════════════════════════════════════════════════════════════
   *  🔴 รอบ 226 · ใบของลูกค้ารายนี้ถูกยกเลิก แล้ว "เลขเดียวกัน" ถูกออกใหม่ให้ลูกค้ารายอื่น
   *
   *  พี่เอ 3 ต.ค. 69 (คำต่อคำ):
   *    "ส่วนที่ error ใน card ลูกหนี้เวลาไปดึง IV มา น่าจะมาจาก เราไม่ได้ sync กับ peak ก่อนว่า
   *     IV ใบนั้น ของลูกค้ารายนั้น มีการยกเลิกไปก่อนแล้วหรือเปล่า ถ้าถูกยกเลิก IV เลขเดียวกัน
   *     จะถูก รายอื่นนำไปใช้ได้นะ ต้องเช็ค ตรงนี้ก่อน"
   *
   *  ช่องโหว่เดิม: เลขเดียวมี "ใบยกเลิก 1 + ใบที่ยังใช้ได้ 1" ⇒ ระบบหยิบใบที่ยังใช้ได้เสมอ
   *    ไม่ดูว่าใบนั้นเป็นของลูกค้าของแถวนี้ไหม ⇒ แถวของลูกค้าที่ใบถูกยกเลิก
   *    ได้ยอด · ชื่อ · ใบเสร็จ ของลูกค้ารายใหม่ที่มาใช้เลขต่อ = เงินผิดคน ไหลไปการ์ดลูกหนี้และ Cash Flow
   *
   *  กติกา (ต้องครบทั้ง 3 ข้อ — เรื่องเงินไม่เดา):
   *    ① เลขนี้มีใบที่ถูกยกเลิกอยู่ใน PEAK
   *    ② ใบที่ยังใช้ได้ "ชื่อลูกค้าไม่ตรง" กับชื่อบริษัทของแถวนี้ (ตัดสินได้ ไม่ใช่ชื่อว่าง)
   *    ③ ใบที่ถูกยกเลิก "ชื่อลูกค้าตรง" กับชื่อบริษัทของแถวนี้
   *    ⇒ ตีตรา 🚫 เอกสารถูกยกเลิกใน PEAK · ไม่เขียนยอด/ใบเสร็จของลูกค้ารายอื่น
   *      ล้างชื่อลูกค้า/ลิงก์ของลูกค้ารายอื่นที่อาจค้างจากรอบก่อน · การ์ดลูกหนี้ถอยไปใช้ยอดที่เซลส์คีย์ (กติกา v32.1)
   *    ไม่ครบ 3 ข้อ ⇒ ทำเหมือนเดิมทุกอย่าง (ผลตรวจยังขึ้น "ชื่อลูกค้าไม่ตรง" ตามเดิม)
   *  ‼ ต้องอยู่ "ก่อน" ถามใบเสร็จ/เขียน cash_flow — ไม่งั้นใบเสร็จของลูกค้ารายอื่นถูกจดใต้รหัสงานนี้
   * ═══════════════════════════════════════════════════════════════ */
  if (ivVoids.length && out.company && nameSame(inv.cName, out.company) === false) {
    let mine = null;
    for (const v of ivVoids) {
      let nm = clean(v.name);
      if (!nm && v.cCode) {
        try { const cr = await peak.contactName(v.cCode, biz); if (cr && cr.state === 'hit') nm = clean(cr.name); }
        catch (e) { /* เปิดทะเบียนไม่ได้ = ตัดสินไม่ได้ ⇒ ไม่เข้าเงื่อนไข (ทำเหมือนเดิม) */ }
      }
      if (nameSame(nm, out.company) === true) { mine = { code: v.code, name: nm }; break; }
    }
    if (mine) {
      const code = clean(inv.code) || (ivRefs[0] ? ivRefs[0].ref : '');
      out.ss = SS.VOID;
      out.reuse = { code, voidName: mine.name, liveName: clean(inv.cName), voidN: ivVoids.length };
      out.note = `เลข ${code} ของ "${out.company}" ถูกยกเลิกใน PEAK แล้ว · เลขเดียวกันถูกออกใหม่ให้ "${clean(inv.cName)}" ` +
                 '— ไม่เอายอด/ใบเสร็จของลูกค้ารายอื่นมาเขียน';
      out.keepSet = true;
      out.set = {
        [COL.SSTAT]: SS.VOID,
        [COL.VERDICT]: `🚫 ใบของลูกค้ารายนี้ถูกยกเลิกใน PEAK · เลข ${code} ถูกออกใหม่ให้ "${clean(inv.cName)}"`,
        [COL.CNAME]: '', [COL.CCODE]: '', [COL.URL]: '',
        [COL.PAT]: nowStamp(),
      };
      return out;
    }
  }

  /* ใบเสร็จของบิลนี้ — ใช้บอกว่าเก็บมาแล้วกี่งวด และเงินเข้าจริงเท่าไหร่ */
  /* ═══════════════════════════════════════════════════════════════
   *  🔴 ถามใบเสร็จไม่สำเร็จ = ห้ามเขียนตัวเลขเงินลงไปเด็ดขาด
   *
   *  ‼ ของเดิมตรงนี้ `catch {}` เงียบ ๆ แล้วเดินต่อ ซึ่งผิดร้ายแรง
   *    เพราะ "ภาษีหัก ณ ที่จ่าย" ส่วนใหญ่อยู่ในใบเสร็จ ไม่ได้อยู่หัวใบแจ้งหนี้
   *    ถามใบเสร็จพลาดเมื่อไหร่ ยอดที่ต้องชำระจะสูงไปเท่ากับภาษีทันที
   *
   *  พิสูจน์แล้วด้วยใบจริงของพี่เอ (IV ยอด 20,223 · ภาษี 567):
   *    ถามใบเสร็จสำเร็จ → ยอดขาย PEAK 19,656 · ✅ ตรง
   *    ถามใบเสร็จพัง    → ยอดขาย PEAK 20,223 · ⚠️ ต่าง +567 · ผลตรวจ "ยอดขายไม่ตรง"
   *
   *  ‼ อันตรายที่สุดคือแบบหลัง "ดูเหมือนข้อมูลจริง" — ไม่มีอะไรบอกว่า PEAK ล่ม
   *    คนอ่านจะไปไล่หาส่วนต่าง 567 ที่ไม่มีอยู่จริง
   *
   *  กติกาเดียวกับที่ core/peak.js เขียนไว้ตั้งแต่หัวไฟล์:
   *    "ถามไม่สำเร็จ ≠ ไม่มีเอกสารนี้ — เจอ error ต้องโยนออกไป"
   *  โยนออกไปแล้วคิวจะปล่อยใบนี้ค้างไว้ลองใหม่รอบหน้า ซึ่งถูกต้องกว่าเขียนเลขผิด
   *
   *  ‼ "ไม่มีใบเสร็จ" (ยังไม่จ่าย) ต่างจาก "ถามไม่สำเร็จ" — กรณีแรก PEAK
   *    คืนอาเรย์ว่างโดยไม่ error จึงไม่เข้าทางนี้ ไม่กระทบใบที่ยังไม่ชำระ
   * ═══════════════════════════════════════════════════════════════ */
  let rcpts = [];
  /* ‼ ถามใบเสร็จด้วย "เลขใบจริงที่ PEAK คืนมา" ไม่ใช่เลขที่คีย์ไว้
   *   ① เลขที่คีย์อาจเป็นรูปแบบสำรอง (มีขีด/ไม่มีขีด) ที่ใบเสร็จหาไม่เจอ
   *   ② กรณีตามจากใบเสนอราคามา (v32.8) จะไม่มีเลข IV ที่คีย์ไว้เลย
   *      บรรทัดเดิม ivRefs[0].ref พังทันทีเมื่อ ivRefs ว่าง */
  const ref = inv.code || (ivRefs[0] ? ivRefs[0].ref : '');
  if (!ref)
    throw new Error('ได้ใบแจ้งหนี้จาก PEAK แต่ไม่มีเลขเอกสาร — ยังไม่เขียนตัวเลขใด ๆ');
  try {
    rcpts = (await peak.receipts(ref, biz)).map(splitReceipt);
  } catch (e) {
    throw new Error(
      `ถามใบเสร็จของ ${ref} ไม่สำเร็จ — ยังไม่เขียนตัวเลขใด ๆ ลงฐานข้อมูล ` +
      `(ภาษีหัก ณ ที่จ่ายอยู่ในใบเสร็จ ขาดไปแล้วยอดจะผิด) · ${e.message}`);
  }
  const cash = r2(rcpts.reduce((a, r) => a + r.cash, 0));
  const whtSum = r2(rcpts.reduce((a, r) => a + r.wht, 0));

  /* ‼ เก็บใบเสร็จ "ทุกงวด" ลงตารางจริง — ไม่ใช่ยุบเป็นข้อความสรุปช่องเดียว
   *   (พี่เอทัก 9 ก.ย. 69: ก.กนก มี 3 งวด แต่หน้า Cash Flow ขึ้นงวดเดียว) */
  out.cfSaved = await saveCashFlow_(rcpts, inv, row, out, row._log);

  /* ‼ ภาษีที่เจอในใบเสร็จต้องย้อนกลับไปแก้ "ยอดที่ต้องชำระ" ด้วย (code.gs:2489)
   *   บ่อยครั้ง PEAK ไม่ใส่ภาษีไว้ที่หัวใบแจ้งหนี้ มีแต่ในใบเสร็จ
   *   ถ้าไม่ย้อนกลับ ยอดขาย PEAK จะสูงไปเท่ากับภาษี แล้ว "ตรวจยอด" ขึ้นต่างทุกใบ
   *   ‼ เพดาน 25% คุมตรงนี้ด้วย — เกินแปลว่าอ่านผิด ไม่ใช่ภาษีจริง */
  if (whtSum > 0 && inv.wht <= 0 && inv.net > 0 && whtSum <= inv.net * 0.25) {
    inv.wht = whtSum;
    inv.payable = r2(inv.net - whtSum);
  }

  /* ── ตรวจยอด: เทียบ "ยอดที่ต้องชำระ" กับยอดขายที่คีย์ (v25.2) ── */
  const d = r2(inv.payable - out.sale);
  const chk = out.sale === 0 ? '—'
            : (Math.abs(d) < 0.005 ? '✅ ตรง'
                                   : `⚠️ ต่าง ${d > 0 ? '+' : ''}${d.toLocaleString('en-US')}`);

  /* ── ผลตรวจรวม (PEAK_ISSUE code.gs:12520) — เรียงตามความร้ายแรง ── */
  const sheetPaid = money(row['รับจริง (บาท)']);
  const eq = (a, b) => Math.abs(a - b) < 1;
  let verdict = '✅ ถูกต้อง';
  if (inv.payKey === 'paid' && money(row['ยอดเรียกเก็บ (บาท)']) - sheetPaid > 1)
    verdict = '🚨 PEAK ชำระครบแต่ชีตยังค้าง';
  else if (inv.payKey === 'none' && sheetPaid > 1) verdict = '🚨 ชีตรับแล้วแต่ PEAK ยังไม่ชำระ';
  else if (!eq(inv.payable, out.sale) && out.sale > 0) verdict = '⚠️ ยอดขายไม่ตรง';
  else if (!eq(inv.paid, sheetPaid))                   verdict = '⚠️ ยอดรับชำระไม่ตรง';
  /* ‼ nameSame คืน null เมื่อ "ตัดสินไม่ได้" (ข้างใดข้างหนึ่งว่าง)
   *   null ≠ ไม่ตรง — ห้ามตีตราว่าชื่อไม่ตรงทั้งที่ยังไม่มีชื่อให้เทียบ */
  else if (nameSame(inv.cName, out.company) === false)
    verdict = '⚠️ ชื่อลูกค้าไม่ตรง';

  out.ss = SS.OK;
  out.inv = inv;
  out.cash = cash;
  out.whtSum = whtSum;
  out.rcptN = rcpts.length;
  out.set = {
    [COL.AMT]:   inv.payable,
    [COL.CHK]:   chk,
    [COL.CNAME]: inv.cName,
    [COL.CCODE]: inv.cCode,
    [COL.PSTAT]: inv.payStatus,
    [COL.PPAID]: inv.paid,
    [COL.RCPTN]: rcpts.length ? `${rcpts.length} งวด · รับจริง ${cash.toLocaleString('en-US')}` +
                                (whtSum ? ` · หัก ณ ที่จ่าย ${whtSum.toLocaleString('en-US')}` : '') : '',
    /* ‼ ต่อท้ายเหตุผลว่าทำไมชื่อลูกค้ายังว่าง (ถ้ามี) — ไม่แตะผลตรวจเรื่องเงิน */
    [COL.VERDICT]: verdict + nameNote_(inv),
    [COL.TERMS]: inv.terms,
    [COL.CRDAY]: inv.credit,
    /* v18.9 · ลิงก์เปิดใบจริงใน PEAK — ไม่มี uuid ก็ไม่ต้องเดา ปล่อยว่างไว้ */
    [COL.URL]:   docUrl('iv', inv.id),
    [COL.PAT]:   nowStamp(),
    [COL.SSTAT]: SS.OK,
  };
  /* ‼ เจอใบเสนอราคาด้วยก็ต้องเติมช่องของมันให้ครบ (ของเดิมเขียนทั้งคู่)
   *   ไม่เติม = ใบที่มีทั้ง QO และ IV จะไม่มีข้อมูลใบเสนอราคาเลย ทั้งที่ถามมาแล้ว */
  if (out.quo) {
    out.set[COL.QUO]   = out.quo.code;
    out.set[COL.QSTAT] = out.quo.status;
    out.set[COL.QAMT]  = out.quo.net;
    if (out.quo.toIv) out.set[COL.QLINK] = out.quo.toIv;
  }
  /* v32.8 · ตามใบแจ้งหนี้จากใบเสนอราคามาได้ → เติมสายเอกสารให้ด้วย */
  if (out.ivFromQuo) out.set[COL.QLINK] = out.ivFromQuo.iv || out.set[COL.QLINK] || '';
  return out;
}

/* แปลงใบเสนอราคาให้อยู่ในรูปที่ใช้ต่อได้ (_peakQuoNormalize code.gs) */
function normQuo(qd) {
  /* ‼ ตัวอ่านชื่อกลางตัวเดียวกับใบแจ้งหนี้ — ช่องชื่อลูกค้ามีที่มาเดียวเสมอ */
  const nm = peak.pickName(qd);
  return {
    code:   clean(peak.dig(qd, ['code', 'documentCode', 'number'])),
    cName:   clean(nm.name),
    cPerson: clean(nm.person),
    cVia:    nm.name ? 'ใบเสนอราคา · ' + nm.via : '',
    cCode:   clean(nm.code),
    net:    money(peak.dig(qd, ['netAmount', 'totalAmount', 'grandTotal', 'total'])),
    status: clean(peak.dig(qd, ['status', 'documentStatus'])),
    /* PEAK บอกเองว่าใบนี้ถูกแปลงเป็นใบแจ้งหนี้ใบไหน — ไม่ได้เดาจากเลข */
    toIv:   clean(peak.dig(qd, ['invoiceCode', 'toInvoiceCode', 'referenceCode'])),
    /* ‼ uuid อ่านจากหัวใบเท่านั้น ไม่งั้นได้ id ของบรรทัดสินค้ามาแทน */
    id:     clean(qd && (qd.id || qd.uuid || qd.documentId)),
  };
}

/* ═══════════════════════════════════════════════════════════════════
 *  หาใบแจ้งหนี้จาก "เลขใบเสนอราคา" — ถอดจาก pkIvFromQuo() code.gs:10555
 *
 *  ‼ PEAK เก็บเลขใบเสนอราคาต้นทางไว้ในช่อง reference ของใบแจ้งหนี้
 *    ฉะนั้น Invoices?reference=<เลข QO> = ได้ใบแจ้งหนี้ที่ออกจากใบนั้น
 *    (เอกสารเก่าของเราเข้าใจผิดว่า reference= ใช้ไม่ได้ — จริง ๆ มันคือ
 *     ช่องค้น "เอกสารต้นทาง" พอดี แค่เคยเอาไปค้นเลขของใบเองเลยได้ 0 แถวทุกครั้ง)
 *
 *  🔒 กฎเดิมทุกข้อยังอยู่: ใบยกเลิกไม่เอา · ใบร่างไม่เอา · หลายใบแยกไม่ออก = ไม่เดา
 *
 *  ‼ ยังไม่ได้พอร์ตทางสำรอง _ivFromIndexByRef() (ค้นจากดัชนี PeakInvoices ของเราเอง)
 *    ระบบใหม่ยังไม่มีดัชนีนั้น — ถ้าซิงก์ชีต PeakInvoices เข้ามาแล้วค่อยเติมทีหลัง
 * ═══════════════════════════════════════════════════════════════════ */
async function ivFromQuo(quoCode, biz) {
  const qo = clean(quoCode).replace(/\s+/g, '').toUpperCase();
  if (!qo) return { doc: null, via: '' };
  const via = 'Invoices?reference=' + qo;
  const R = await askDoc('IV', 'reference', qo, biz);
  if (!R.ok)   return { doc: null, via, err: R.err };
  if (R.doc)   return { doc: R.doc, via };
  if (R.dup)   return { doc: null, via, dup: true, dupN: R.dupN,
                        cands: R.cands, candRaw: R.candRaw };
  if (R.draft) return { doc: null, via, draft: true, draftN: R.draftN,
                        draftCands: R.draftCands };
  return { doc: null, via };
}

/* ═══════════════════════════════════════════════════════════════════
 *  🔴 รอบ 226 · ประวัติของ "เลขใบแจ้งหนี้" ใน PEAK — ใบที่ยังใช้ได้ + ใบที่ถูกยกเลิก
 *
 *  ใช้ที่การ์ดลูกหนี้ (ar-complete.pickChecked): ก่อนเชื่อว่าใบงานที่มีเลข IV นี้ติดอยู่เป็นงานของใบขายนี้
 *  ต้องรู้ก่อนว่า "เลขนี้เคยถูกยกเลิกแล้วเอาไปออกใหม่ไหม" (พี่เอ 3 ต.ค. 69 — ดูหัวข้อรอบ 226 ใน checkRow)
 *  ‼ GET อย่างเดียว (ทางเดียวกับ checkRow: fetchDoc → peak.get) · ไม่เขียนอะไรที่ไหนเลย
 *  ‼ ถามไม่สำเร็จ = ok:false — ผู้เรียกต้องถือว่า "ยังไม่รู้" ห้ามแปลว่า "ไม่เคยยกเลิก"
 *  → { ok, live:{code,name}|null, voids:[{code,name}], reused:boolean, biz, err }
 * ═══════════════════════════════════════════════════════════════════ */
const _ivHistMem = new Map();          /* เลข → { at, v } จำ 10 นาที (เฉพาะคำตอบที่ถามสำเร็จ) */
const IV_HIST_MS = 10 * 60 * 1000;
async function ivHistory(raw, bizHint) {
  const ref0 = refsOf(raw).filter(x => x.kind === 'IV')[0];
  if (!ref0) return { ok: false, live: null, voids: [], reused: false, biz: '', err: 'ไม่มีเลข IV' };
  const mk = ref0.ref.replace(/[^A-Z0-9]/g, '');
  const m = _ivHistMem.get(mk);
  if (m && Date.now() - m.at < IV_HIST_MS) return { ...m.v };
  const ready = peak.configuredList();
  if (!ready.length) return { ok: false, live: null, voids: [], reused: false, biz: '', err: 'ยังไม่ได้ตั้งกุญแจ PEAK' };
  const guess = peak.bizOfDoc(ref0.ref);
  const hint = (guess && peak.isConfigured(guess)) ? guess : (peak.isConfigured(bizHint) ? bizHint : '');
  const tryBiz = hint ? [hint].concat(ready.filter(b => b !== hint)) : ready.slice();
  let err = '', out = null;
  for (const b of tryBiz) {
    const R = await fetchDoc('IV', ref0.ref, ref0.alts, b);
    if (!R.ok) { err = err || R.err; continue; }
    const vc = (R.voidCands || []).slice();
    if (!R.doc && !R.dup && !vc.length) continue;          /* กิจการนี้ไม่มีเลขนี้ — ลองกิจการถัดไป */
    const name1 = async (nm, cc) => {
      let n = clean(nm);
      if (!n && cc) { try { const cr = await peak.contactName(cc, b); if (cr && cr.state === 'hit') n = clean(cr.name); } catch (e) { /* ไม่มีชื่อก็ส่งว่าง */ } }
      return n;
    };
    let live = null;
    if (R.doc) { const pn = peak.pickName(R.doc); live = { code: clean(R.doc.code || R.doc.documentCode), name: await name1(pn.name, pn.code) }; }
    const voids = [];
    for (const v of vc) voids.push({ code: v.code, name: await name1(v.name, v.cCode) });
    out = { ok: true, live, voids, reused: voids.length > 0 && (!!live || !!R.dup), biz: b, err: '' };
    break;
  }
  if (!out) out = err ? { ok: false, live: null, voids: [], reused: false, biz: '', err }
                      : { ok: true, live: null, voids: [], reused: false, biz: '', err: '' };
  if (out.ok) { if (_ivHistMem.size > 2000) _ivHistMem.clear(); _ivHistMem.set(mk, { at: Date.now(), v: out }); }
  return { ...out };
}

function nowStamp() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = k => (p.find(x => x.type === k) || {}).value || '';
  return `${g('day')}/${g('month')}/${g('year')} ${g('hour')}:${g('minute')}`;
}

/* ═══════════════════════════════════════════════════════════════════
 *  ตรวจก่อน — ดึงจาก PEAK มาเทียบให้ดู ‼ ไม่แตะชีตเลย
 * ═══════════════════════════════════════════════════════════════════ */
async function preview({ rows, limit = 40 }) {
  const t0 = Date.now();
  const cap = Math.min(Math.max(Number(limit) || 40, 1), 120);
  const list = (rows || []).slice(0, cap);
  const out = [], errs = [];

  for (const r of list) {
    try {
      const c = await checkRow(r);
      out.push({
        row: c.row, job: c.job, company: c.company, iv: c.iv, biz: c.biz || '',
        sale: c.sale, ss: c.ss, skip: !!c.skip, note: c.note,
        peakAmt: c.inv ? c.inv.payable : null,
        peakPaid: c.inv ? c.inv.paid : null,
        /* ‼ ชื่อจากใบเสนอราคาก็ต้องขึ้นให้เห็นด้วย ไม่ใช่เฉพาะใบแจ้งหนี้ */
        peakName: (c.inv && c.inv.cName) || (c.quo && c.quo.cName) || '',
        /* ‼ ได้ชื่อมาจากไหน — หัวบิล หรือทะเบียนลูกค้า · ตรวจย้อนได้ ไม่ต้องเชื่อลอย ๆ */
        peakNameVia: (c.inv && c.inv.cVia) || (c.quo && c.quo.cVia) || '',
        peakNameErr: (c.inv && c.inv.nameErr) || (c.quo && c.quo.nameErr) || '',
        /* ‼ 3 สถานะที่ห้ามยุบรวม — hit / absent / error (ดู NAME_NOTE) */
        peakNameState: (c.inv && c.inv.nameState) || (c.quo && c.quo.nameState) || '',
        peakCode: (c.inv && c.inv.cCode) || (c.quo && c.quo.cCode) || '',
        payStatus: c.inv ? c.inv.payStatus : '',
        chk: c.set[COL.CHK] || '', verdict: c.set[COL.VERDICT] || '',
        rcptN: c.rcptN || 0, cash: c.cash || 0, wht: c.whtSum || 0,
        willWrite: !c.skip && c.ss === SS.OK,
        /* ‼ เหตุผลเบื้องหลังต้องขึ้นหน้าจอด้วย ไม่ใช่ซ่อนไว้ในโค้ด
         *   "ทำไมใบนี้ถึงได้ / ทำไมใบนี้ถึงไม่ได้" คือคำถามแรกทุกครั้ง */
        pickedBy:  c.pickedBy || '',      /* เลขซ้ำแต่ตัดสินได้ ด้วยอะไร */
        healed:    c.healed ? `${c.healed.from} → ${c.healed.to}` : '',  /* เปลี่ยนท่าค้นหาให้เอง */
        ivFromQuo: c.ivFromQuo || null,   /* ตามใบแจ้งหนี้จากใบเสนอราคามาได้ */
        cands:     c.cands || [],         /* ผู้เข้าชิงตอนเลขซ้ำ / ใบร่าง */
      });
    } catch (e) {
      errs.push({ row: r._row, job: clean(r['รหัสงาน']), error: e.message });
    }
    await peak.sleep(120);          /* เว้นจังหวะ ไม่ยิงถล่ม PEAK */
  }
  return { ok: true, checked: out.length, rows: out, errors: errs,
           ms: Date.now() - t0, capped: (rows || []).length > cap };
}

/* ═══════════════════════════════════════════════════════════════════
 *  ตัดยอดจริง — เขียนผลลง "ฐานข้อมูลใหม่" ที่เดียว (ไม่ใช่ PEAK ไม่ใช่ชีต)
 * ═══════════════════════════════════════════════════════════════════ */
async function apply({ rows, limit = 40, user }) {
  const t0 = Date.now();
  const cap = Math.min(Math.max(Number(limit) || 40, 1), 120);
  const list = (rows || []).slice(0, cap);

  const done = [], errs = [];
  for (const r of list) {
    try {
      const c = await checkRow(r);
      if ((c.skip || c.ss !== SS.OK) && !c.keepSet) {   /* 🔴 รอบ 226 — keepSet = ชุดค่าที่ตั้งใจเขียน (ล้างชื่อ/ลิงก์ของลูกค้ารายอื่น) */
        /* เขียนแค่สถานะซิงก์ ให้รู้ว่าตรวจแล้วแต่ยังใช้ไม่ได้ */
        c.set = { [COL.SSTAT]: c.ss, [COL.PAT]: nowStamp() };
      }
      /* ‼ ใช้ทางเขียนเส้นเดียวกับคิวหลังบ้าน (writeSet)
       *   ของเดิมตรงนี้เขียนชีตเองอีกชุด → พฤติกรรม 2 เส้นทางไม่เหมือนกัน
       *   แก้ที่เดียวแล้วอีกที่ตกหล่นทุกครั้ง เป็นบ่อเกิดของบั๊กที่หายาก */
      const w = await writeSet(c.row, c.set);

      done.push({ row: c.row, job: c.job, ss: c.ss, fields: w.fields,
                  chk: c.set[COL.CHK] || '', verdict: c.set[COL.VERDICT] || '' });
    } catch (e) {
      errs.push({ row: r._row, job: clean(r['รหัสงาน']), error: e.message });
    }
    await peak.sleep(120);
  }

  /* จดไว้ว่าใครสั่งซิงก์เมื่อไหร่ ได้ผลยังไง */
  try {
    await db.insert('sync_run', [{
      source: 'peak-apply', started_at: new Date(t0).toISOString(),
      finished_at: new Date().toISOString(), ok: errs.length === 0,
      rows_read: list.length, rows_upd: done.length, ms: Date.now() - t0,
      note: 'สั่งโดย ' + clean(user && user.username),
      error: errs.length ? errs.slice(0, 3).map(e => e.job + ': ' + e.error).join(' · ') : null,
    }]);
  } catch { /* ไม่เป็นไร */ }

  return { ok: true, updated: done.length, rows: done, errors: errs, ms: Date.now() - t0 };
}

/* ═══════════════════════════════════════════════════════════════════
 *  เขียนผล 1 แถว — ลงฐานข้อมูลใหม่ที่เดียว
 *
 *  ‼ ไม่แตะชีตเดิมแล้ว (คำสั่งพี่เอ 6 ก.ย. 69) และไม่แตะ PEAK ตลอดกาล
 *    ‼ คอมเมนต์เดิมตรงนี้ยังเขียนว่า "ลงชีตก่อน" ทั้งที่โค้ดเลิกทำไปแล้ว
 *      คอมเมนต์ที่ไม่ตรงกับโค้ดอันตรายกว่าไม่มีคอมเมนต์ — คนอ่านเชื่อผิด
 */
async function writeSet(rowNo, set) {
  if (!rowNo || !set || !Object.keys(set).length) return { ok: true, fields: 0 };

  /* ‼ ต้องยืนยันว่าเขียนติดจริง ไม่ใช่ยิงแล้วเชื่อว่าสำเร็จ
   *   PostgREST ตอบ 200 พร้อมอาเรย์ว่าง เมื่อ "ไม่เจอแถวที่ตรงเงื่อนไข"
   *   ซึ่งไม่ใช่ error — แต่แปลว่าไม่มีอะไรถูกเขียนเลยสักช่อง
   *   ไม่ตรวจตรงนี้ = หน้าจอขึ้นว่าซิงก์แล้ว ทั้งที่ตัวเลขไม่ขยับ
   *
   *   toRec แปลงชื่อคอลัมน์ที่ยาวเกิน 63 ไบต์ให้ตรงกับตารางจริง
   *   (ภาษาไทยตัวละ 3 ไบต์ PostgreSQL ตัดหางทิ้งเงียบ ๆ ตอนสร้างตาราง) */
  const rec = toRec(set);
  const back = await db.update('total_sales', { _row: 'eq.' + rowNo }, rec);
  const hit = Array.isArray(back) ? back.length : (back ? 1 : 0);
  if (!hit)
    throw new Error(`ไม่พบแถว ${rowNo} ในฐานข้อมูล — ยังไม่ได้เขียนอะไรลงไป ` +
                    '(ใบนี้อาจถูกลบไปแล้ว หรือเลขแถวไม่ตรง)');

  return { ok: true, fields: Object.keys(rec).length - 1 };
}

module.exports = { preview, apply, checkRow, writeSet, splitReceipt, normInvoice, normQuo,
                   refsOf, isFlow, nameKey, nameSame, fillName_, nameNote_, NAME_NOTE,
                   pickDoc, pickByRow, fetchDoc, askDoc, ivFromQuo, ivHistory, _ivHistMem,
                   SS, COL, dbCol };
