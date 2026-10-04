'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  🏭🔗 modules/sales/rfqpeak.js — การ์ด Outsource × คีย์ยอดขาย × PEAK × ภาพใบงาน
 *  รอบ 128 · 26 ก.ย. 69
 *
 *  พี่เอสั่ง (คำต่อคำ):
 *   ① "Card Outsource ต้องการเพิ่มข้อมูล เลขที่ inv / QO เข้ามาใน Card และทำการ Sync data
 *      กับ Peak ในส่วนของ การเปิด PO สั่งซื้อไปยัง Outsource คือ เลขที่ PO ยอดเงินใน PO
 *      ที่ต้องจ่าย ชื่อ Supplier ที่อยู่ใน Peak งวดการชำระเงิน วันที่ชำระเงิน แบ่งเป็น
 *      เอกสาร DP-2026 / DP - 69 หรือ เป็นการเปิดเอกสารเพื่อจ่ายเงินมัดจำ และดึงเอกสาร EXP
 *      เป็นเอกสารสำคัญจ่ายตอนที่ปิดยอดครบ 100% พร้อมระบุสถานะ ใบ PO ที่ได้รับการอนุมัติแล้ว
 *      ดึงรูปภาพของพนักงาน มาแสดงใน Card Outsource ด้วยนะ"
 *   ② "ข้อมูลในส่วนนี้ไม่ต้องให้ เซลล์ เพิ่มเองแล้ว โดยดึงมาจากฐานข้อมูลที่เซลล์คีย์ยอดขาย
 *      รหัสงานขาย filter ที่ ผู้ผลิตที่ไม่ใช่ The101 ทั้งหมดมาสร้าง new card outsource ด้วย"
 *      + เลือก "ปิดการขายตั้งแต่ 1 ม.ค. 69"
 *   ③ PO หาไม่เจอ: "ทางบัญชีจะมีการ เปิด PO ที่ ref. กับเลขที่ iv ไว้ให้ ถ้าไม่มีก็ให้คีย์เองได้"
 *   ④ "ใน Card Outsource ไปดึงภาพใบงานผลิต มาจาก app project ด้วยนะ โดย link กันที่
 *      รหัสงานของเซลล์ที่คีย์ไปได้นะ" · "เอาภาพมาแสดงใน card outsource นะ"
 *   ⑤ "ในส่วนของการเชื่อมต่อ peak ให้เข้าไปดูในส่วนของ เมนูงาน ลูกหนี้ค้างชำระ กับ Cashflow"
 *
 *  ── ใช้ของที่มีอยู่แล้วทั้งหมด (ไม่มีตัวดึงตัวที่สอง) ──────────────
 *   · ใบสั่งซื้อ PO     : modules/inventory/peakpo.js loadAll (แคช 5 นาที · ตัวเดียวกับหน้ารับของเข้าคลัง)
 *                         + poStatusGroup (อนุมัติแล้ว/ออกบางส่วน/ออกครบ = อนุมัติ)
 *   · ใบจ่าย EXP/DP     : core/peak-expenses.js normalize + ตาราง app.peak_expenses (ตัวเดียวกับ Cashflow)
 *                         + เบรกคำขอ rateGate ตัวเดียวกัน
 *   · บริษัทที่ขาย       : cashflow._bizResolve (ตัวเดียวกับหน้าลูกหนี้ — เลขเอกสารเป็นหลัก)
 *   · ชื่อเซลส์           : ar-aging._rankNick + prefixList (ตัวเดียวกับการ์ดลูกหนี้)
 *   · ภาพใบงาน          : app.projects (job_code) + app.production_jobs.MainJobImage
 *                         → booking/images.resolveMany (ลิงก์ thumbnail แบบแอปจองคิว)
 *
 *  🔒 PEAK: GET อย่างเดียว — ทุกคำขอออกทาง core/peak.js get() (ฝัง method:'GET' ไว้ตายตัว)
 *  🔴 ห้ามเดา: จับคู่ PO ด้วยหลักฐานเท่านั้น (เลข PO ที่คีย์ · เลข IV/QO/รหัสงานอยู่ในใบ ·
 *     ชื่อผู้ขาย+ยอดตรงกัน "ใบเดียว") — ไม่เข้าเกณฑ์ = บอกว่าหาไม่เจอ ไม่หยิบใบใกล้เคียง
 * ═══════════════════════════════════════════════════════════════════ */
const db = require('../../core/db');
const peak = require('../../core/peak');
const { todayTH, isoTH } = require('../../core/thai-date');

const clean = s => String(s == null ? '' : s).trim();
const num = v => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const r2 = n => Math.round(n * 100) / 100;
const lo = s => clean(s).toLowerCase();
/* เลขเอกสาร/รหัสงาน → ตัดช่องว่าง ตัวพิมพ์ใหญ่ (ยังเป็นการเทียบตรงตัว) */
const key = s => clean(s).replace(/\s+/g, '').toUpperCase();
const _err = m => { const e = new Error(m); e.userError = true; return e; };

/* ── ② ตัวสร้างการ์ดอัตโนมัติ ─────────────────────────────────────── */
const AUTO_FROM = process.env.RFQ_AUTO_FROM || '2026-01-01';   /* พี่เอเลือก: ปิดการขายตั้งแต่ 1 ม.ค. 69 */
const AUTO_BY = 'AUTO:คีย์ยอดขาย';
const AUTO_TTL = Number(process.env.RFQ_AUTO_TTL_MS || 5 * 60 * 1000);
/* 🔴 รอบ 130 (26 ก.ย. 69) — พี่เอ: "การสร้าง new card outsource ให้ดูที่ ฟิลด์ ผู้ผลิต ที่ไม่ใช่
 *   ผลิตเอง-The101 เข้าใจมั้ย" ⇒ ตัดออก "ค่าเดียว" คือ ผลิตเอง-The101 (ไม่สนเว้นวรรค/ขีด/ตัวพิมพ์)
 *   ‼ รอบ 128 ตัดทุกค่าที่มีคำว่า "ผลิตเอง" หรือ "The 101" = กว้างเกินคำสั่ง (เช่น "ผลิตเอง-มดงาน" หายไป) */
/*   + ถามพี่เอเพิ่ม "ผลิตเอง-มดงาน" เอาไหม → ตอบ "ไม่เอา — ตัดทุก ผลิตเอง"
 *   ⇒ ตัด: ทุกค่าที่มีคำว่า "ผลิตเอง" (ผลิตเอง-The101 · ผลิตเอง-มดงาน · ผลิตเอง) + "The101" ล้วน
 *   ‼ ตัดสินจากช่อง "ผู้ผลิต" ช่องเดียว — ไม่ดูช่อง "บริษัทที่ขาย" เด็ดขาด */
const makerKey = p => clean(p).toLowerCase().replace(/[\s\-_–—.]+/g, '');
const isInHouse = p => { const k = makerKey(p); return k.indexOf('ผลิตเอง') >= 0 || k === 'the101'; };

/**
 * เอางาน "ผลิตเอง" ออกจากบอร์ด Outsource (พี่เอ: "เคลียร์ data ที่ดึงมาผิดออกจาก list card outsource")
 * ‼ ซ่อนจากบอร์ด ไม่ลบแถวที่คนคีย์ไว้ (การ์ดเก่าจากชีตที่เลือก "ผลิตเอง-The101") — เปลี่ยนผู้ผลิตแล้วกลับมาเอง
 * ‼ นับยอดบนหัวบอร์ดใหม่ให้ตรงกับการ์ดที่เหลือ
 */
function dropInHouse(R) {
  const R2 = R || {};
  let hid = 0;
  R2.totalOpen = 0; R2.totalMargin = 0; R2.overdue = 0;
  const OPEN = require('./rfq').RFQ_OPEN;
  for (const s of (R2.statuses || [])) {
    const keep = [];
    for (const it of (R2.groups[s] || [])) {
      if (isInHouse(it.outsource)) { hid++; continue; }
      keep.push(it);
      if (OPEN.includes(it.status)) {
        R2.totalOpen++; R2.totalMargin += num(it.margin);
        if (it.overdue) R2.overdue++;
      }
    }
    R2.groups[s] = keep;
  }
  R2.totalMargin = r2(R2.totalMargin);
  R2.outsources = (R2.outsources || []).filter(o => !isInHouse(o));
  R2.hiddenInHouse = hid;
  return R2;
}
const isClosed = ls => /ปิดการขาย/.test(clean(ls)) && !/ไม่ปิด/.test(clean(ls));

const SALE_COLS = ['_row', 'รหัสงาน', 'ชื่อบริษัท', 'ชื่อผู้ติดต่อ', 'เบอร์ติดต่อ', 'Lead Status',
  'วันที่ปิดการขาย', 'ผู้ผลิต', 'ยอดสั่งซื้อ (Outsource)', 'ยอดขาย (บาท)', 'เลขที่ QO / IV',
  'เลขใบแจ้งหนี้ Peak', 'เลขที่ใบเสนอราคา PEAK', 'ลิงก์เอกสาร PEAK', 'Create By', 'บริษัทที่ขาย', 'หมายเหตุ'];
const selOf = cols => cols.map(c => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c) ? c : '"' + c + '"').join(',');
const inList = arr => 'in.(' + arr.map(v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + ')';

const ymd = v => {
  if (!v) return '';
  const s = clean(v instanceof Date ? v.toISOString() : v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
};

let _autoAt = 0, _autoFly = null, _autoLast = null;

/**
 * สร้าง/อัปเดตการ์ด Outsource จากตารางคีย์ยอดขาย
 * ‼ การ์ดที่คนสร้างเอง (created_by ไม่ใช่ AUTO) ไม่ถูกแตะเลยแม้แต่ช่องเดียว
 * ‼ การ์ด AUTO: ชื่อลูกค้า/ผู้ผลิต/ทุน/ขาย ตามตารางคีย์ยอดขายเสมอ (ต้นทางคือเซลส์คีย์) · สถานะไม่แตะ
 * ‼ การ์ด AUTO ที่มีคนลบทิ้ง → จดใน app.rfq_auto_skip แล้วไม่สร้างซ้ำ
 */
async function ensureAuto(opt) {
  opt = opt || {};
  if (!opt.force && _autoLast && Date.now() - _autoAt < AUTO_TTL) return { ..._autoLast, cached: true };
  if (_autoFly) return _autoFly;
  _autoFly = (async () => {
    const AR = require('./ar-aging');
    const out = { from: AUTO_FROM, scanned: 0, eligible: 0, created: 0, updated: 0, skipped: 0, warn: [] };
    const leads = await db.selectAll('total_sales', {
      select: selOf(SALE_COLS), 'วันที่ปิดการขาย': 'gte.' + AUTO_FROM,
      'ผู้ผลิต': 'not.is.null', order: '_row.asc' }) || [];
    out.scanned = leads.length;
    const cards = await db.selectAll('rfq', {
      select: 'rfq_id,job_code,created_by,company,outsource,cost_quoted,sell_offered,sale,contact,phone',
      order: 'id.asc' }) || [];
    const byJob = new Map();
    for (const c of cards) { const k = lo(c.job_code); if (k && !byJob.has(k)) byJob.set(k, c); }
    let skip = new Set();
    try {
      const s = await db.selectAll('rfq_auto_skip', { select: 'job_code', order: 'job_code.asc' }) || [];
      skip = new Set(s.map(x => lo(x.job_code)));
    } catch (e) {
      out.warn.push('ยังไม่ได้รัน sql/98-rfq-peak.sql — การ์ดอัตโนมัติที่ลบทิ้งจะถูกสร้างกลับมาใหม่');
    }
    let prefix = [];
    try { prefix = await AR.prefixList(); } catch (e) { /* ไม่มีทะเบียนคำนำหน้าก็ใช้ Create By อย่างเดียว */ }
    /* 💰 รอบ 132 — พี่เอสั่ง "ให้ราคาสั่งซื้อใน PO มาใส่เป็นราคาทุนใน card นะ"
     *   ⇒ การ์ดที่ซิงก์เจอ PO แล้ว ทุน = ยอดใน PO (ไม่เอายอดสั่งซื้อที่เซลส์คีย์มาทับกลับ) */
    let keyed = new Set();
    const poCost = new Map();
    try {
      const pk = await db.selectAll('rfq_peak', { select: 'rfq_id,po_no,snap', order: 'rfq_id.asc' }) || [];
      keyed = new Set(pk.filter(r => clean(r.po_no)).map(r => clean(r.rfq_id)));
      for (const r of pk) { const t = num(r.snap && r.snap.poTotal); if (t > 0) poCost.set(clean(r.rfq_id), t); }
    } catch (e) { /* ยังไม่รัน sql/98 = ยังไม่มี PO */ }
    const now = new Date().toISOString();
    const ins = [];
    const okJobs = new Set();
    for (const L of leads) {
      const job = clean(L['รหัสงาน']);
      const maker = clean(L['ผู้ผลิต']);
      if (!job || !maker || isInHouse(maker) || !isClosed(L['Lead Status'])) continue;
      out.eligible++;
      okJobs.add(lo(job));
      const cost = num(L['ยอดสั่งซื้อ (Outsource)']), sell = num(L['ยอดขาย (บาท)']);
      const fields = {
        company: clean(L['ชื่อบริษัท']), outsource: maker,
        cost_quoted: cost, sell_offered: sell, margin: r2(sell - cost),
        contact: clean(L['ชื่อผู้ติดต่อ']), phone: clean(L['เบอร์ติดต่อ']),
        sale: AR._rankNick(L['Create By'], job, prefix) || clean(L['Create By']),
      };
      const cur = byJob.get(lo(job));
      if (cur) {
        if (clean(cur.created_by) !== AUTO_BY) { out.skipped++; continue; }   /* ‼ การ์ดที่คนสร้างเอง ไม่แตะ */
        if (poCost.has(clean(cur.rfq_id))) {                                  /* 💰 ทุน = ยอดใน PO */
          fields.cost_quoted = poCost.get(clean(cur.rfq_id));
          fields.margin = r2(sell - fields.cost_quoted);
        }
        const diff = Object.keys(fields).some(k => (typeof fields[k] === 'number')
          ? Math.abs(num(cur[k]) - fields[k]) > 0.005 : clean(cur[k]) !== fields[k]);
        if (diff) {
          await db.update('rfq', { rfq_id: 'eq.' + clean(cur.rfq_id) }, { ...fields, updated_at: isoTH() });
          out.updated++;
        }
        continue;
      }
      if (skip.has(lo(job))) { out.skipped++; continue; }
      ins.push({
        rfq_id: 'RS' + L._row, job_code: job, ...fields,
        detail: clean(L['หมายเหตุ']).slice(0, 500), status: 'ปิดการขาย',
        sent_at: ymd(L['วันที่ปิดการขาย']) || todayTH(), quoted_at: null, due_expect: null,
        note: '', files: '[]', boq: '[]',
        created_at: now, created_by: AUTO_BY, updated_at: isoTH(),
      });
      byJob.set(lo(job), { rfq_id: 'RS' + L._row, created_by: AUTO_BY });
    }
    for (let i = 0; i < ins.length; i += 200) await db.insert('rfq', ins.slice(i, i + 200));
    out.created = ins.length;
    /* การ์ดอัตโนมัติที่ "ไม่เข้าเกณฑ์แล้ว" (เซลส์แก้ผู้ผลิตเป็น ผลิตเอง-The101 · ยังไม่ปิดการขาย ฯลฯ)
     *   ⇒ เอาออก — ‼ เฉพาะการ์ดที่ระบบสร้างเอง ไม่มีไฟล์แนบ และไม่มีเลข PO ที่คนคีย์ไว้ */
    out.removed = 0;
    const auto = await db.selectAll('rfq', { select: 'rfq_id,job_code,created_by,files',
      created_by: 'eq.' + AUTO_BY, order: 'id.asc' }) || [];
    for (const c of auto) {
      if (okJobs.has(lo(c.job_code)) || keyed.has(clean(c.rfq_id))) continue;
      let files = [];
      try { files = JSON.parse(c.files || '[]') || []; } catch (e) { files = []; }
      if (files.length) continue;
      await db.remove('rfq', { rfq_id: 'eq.' + clean(c.rfq_id) });
      out.removed++;
    }
    out.at = isoTH();
    _autoLast = out; _autoAt = Date.now();
    return out;
  })();
  try { return await _autoFly; }
  finally { _autoFly = null; }
}
function autoForget() { _autoLast = null; _autoAt = 0; }

/** การ์ดนี้เป็นการ์ดอัตโนมัติไหม — คืนรหัสงาน (ไว้จดว่า "ลบแล้ว ห้ามสร้างซ้ำ") */
async function autoJobOf(id) {
  const r = await db.one('rfq', { select: 'job_code,created_by', rfq_id: 'eq.' + clean(id) }).catch(() => null);
  return (r && clean(r.created_by) === AUTO_BY) ? clean(r.job_code) : '';
}
async function skipAdd(job, user) {
  const k = lo(job);
  if (!k) return;
  const had = await db.one('rfq_auto_skip', { select: 'job_code', job_code: 'eq.' + k }).catch(() => null);
  if (!had) await db.insert('rfq_auto_skip', [{ job_code: k, by_user: clean(user && (user.username || user.name)) }])
    .catch(e => console.log('[rfqpeak] จดรหัสงานที่ลบทิ้งไม่ได้:', (e && e.message) || e));
  _autoLast = null;
}

/* ═══════════════════════════════════════════════════════════════════
 *  ข้อมูลเสริมของบอร์ด — เลข QO/IV · ภาพใบงาน · ผลซิงก์ PEAK ล่าสุด
 *  ‼ ถามเฉพาะรหัสงานที่อยู่บนบอร์ด (in.(…)) ไม่โหลดทั้งตาราง
 * ═══════════════════════════════════════════════════════════════════ */
async function leadsOf(jobs) {
  const out = new Map();
  const want = [...new Set(jobs.map(clean).filter(Boolean))];
  for (let i = 0; i < want.length; i += 100) {
    const part = want.slice(i, i + 100);
    const rows = await db.select('total_sales', { select: selOf(SALE_COLS), 'รหัสงาน': inList(part) })
      .catch(() => []) || [];
    for (const r of rows) { const k = lo(r['รหัสงาน']); if (k && !out.has(k)) out.set(k, r); }
  }
  return out;
}
function bizOf(L) {
  try {
    const f = require('./cashflow')._bizResolve;
    if (typeof f === 'function') { const b = f(L, null); if (b && clean(b.biz)) return clean(b.biz); }
  } catch (e) { /* ตกไปทางเลขเอกสาร */ }
  return peak.bizOfDoc(clean(L['เลขใบแจ้งหนี้ Peak']) || clean(L['เลขที่ QO / IV'])) || '';
}
/* เลขเอกสารทุกใบในช่อง (ช่อง "เลขที่ QO / IV" มีทั้ง QO และ IV ในช่องเดียวได้ — ภาพพี่เอ) */
const DOC_RE = /((?:IV|QO|QT)[-\s]?\d{6,})/gi;
function docsIn(...vals) {
  const out = [];
  for (const v of vals) {
    const s = String(v == null ? '' : v); let m; DOC_RE.lastIndex = 0;
    while ((m = DOC_RE.exec(s)) !== null) { const d = key(m[1]); if (out.indexOf(d) < 0) out.push(d); }
  }
  return out;
}
function leadInfo(L) {
  if (!L) return null;
  const url = clean(L['ลิงก์เอกสาร PEAK']);
  const docs = docsIn(L['เลขใบแจ้งหนี้ Peak'], L['เลขที่ QO / IV'], L['เลขที่ใบเสนอราคา PEAK']);
  return {
    job: clean(L['รหัสงาน']),
    iv: docs.find(d => /^IV/.test(d)) || '',
    qo: docs.find(d => /^(QO|QT)/.test(d)) || '',
    docs,
    url, urlKind: /quotationDetail/i.test(url) ? 'qt' : (url ? 'iv' : ''),
    biz: bizOf(L),
  };
}

/* ═══════════════════════════════════════════════════════════════════
 *  ภาพใบงานผลิต — ④ link ที่ "รหัสงานขายที่เซลส์คีย์"
 *  🔴 รอบ 128.1 (26 ก.ย. 69) — พี่เอส่งภาพ: การ์ดทุกใบไม่มีภาพเลย + สั่ง
 *     "ให้แสดงรหัสงานขาย ที่เซลล์คีย์ด้วยนะ พร้อมนำไปดึงภาพใบงานผลิต ใน app projects มาใส่
 *      ที่ status complete แล้ว"
 *   ต้นเหตุ: รอบแรกค้นแค่ projects.job_code = รหัสงาน · แต่ช่อง job_code เติมเฉพาะแถวที่มาจาก
 *     ชีตเดิม — รหัสงานจริงของโปรเจกต์อยู่ใน "ชื่อ Project" (เช่น "B2E2607/006 ป้ายไฟ…")
 *     ⇒ ใช้กติกาแกะรหัสงานจากชื่อ Project ของแอปจองคิว (booking/paydoc.js _pdCodesFromProjectName)
 *       · รหัสย่อย "B2E2607/006-1" นับเป็นงานเดียวกัน
 *   ‼ เอาเฉพาะโปรเจกต์ Status = Complete ตามคำสั่ง · หลายใบเอาที่ Complete ล่าสุดที่มีภาพ
 *   ลำดับภาพ: "Image Complete" (ภาพใบงานที่ Job Card ดึงไปเป็นภาพใบสั่งผลิต) → "ภาพใบงานหลัก"
 *            → production_jobs.MainJobImage → "Image"
 * ═══════════════════════════════════════════════════════════════════ */
const JOB_RE = /([A-Z][A-Z0-9]{0,9}[\/-]\d{1,5}(?!\d)(?:-\d{1,3}(?!\d))?)/gi;
function codesInName(name) {
  const out = [];
  const s = String(name == null ? '' : name);
  let m; JOB_RE.lastIndex = 0;
  while ((m = JOB_RE.exec(s)) !== null) {
    const c = key(m[1]);
    if (/^(IV|QO|QT)[-\/]/.test(c)) continue;
    if (out.indexOf(c) < 0) out.push(c);
  }
  return out;
}
const sameJob = (have, want) => have === want || have.indexOf(want + '-') === 0;
const orVal = v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

async function imagesOf(jobs) {
  const out = new Map();
  const want = [...new Set(jobs.map(key).filter(Boolean))];
  if (!want.length) return out;
  const projs = [];
  const seen = new Set();
  for (let i = 0; i < want.length; i += 20) {
    const part = want.slice(i, i + 20);
    const ors = ['job_code.in.(' + part.map(orVal).join(',') + ')']
      .concat(part.map(c => 'Project.ilike.' + orVal('*' + c + '*')));
    const rows = await db.select('projects', {
      select: selOf(['ID', 'job_code', 'Project', 'Status', 'Complete', 'Image Complete', 'ภาพใบงานหลัก', 'Image']),
      Status: 'eq.Complete', or: '(' + ors.join(',') + ')', limit: 2000 }).catch(() => []) || [];
    for (const r of rows) { const k = clean(r.ID) || JSON.stringify(r); if (!seen.has(k)) { seen.add(k); projs.push(r); } }
  }
  const pids = [...new Set(projs.map(p => clean(p.ID)).filter(Boolean))];
  const mainImg = new Map();
  for (let i = 0; i < pids.length; i += 100) {
    const rows = await db.select('production_jobs', { select: 'ProjectID,MainJobImage',
      ProjectID: inList(pids.slice(i, i + 100)) }).catch(() => []) || [];
    for (const r of rows) if (clean(r.MainJobImage) && !mainImg.has(clean(r.ProjectID)))
      mainImg.set(clean(r.ProjectID), clean(r.MainJobImage));
  }
  /* Complete ล่าสุดก่อน */
  projs.sort((a, b) => (clean(a.Complete) < clean(b.Complete) ? 1 : clean(a.Complete) > clean(b.Complete) ? -1 : 0));
  const pick = new Map();
  for (const w of want) {
    for (const p of projs) {
      const codes = [key(p.job_code)].filter(Boolean).concat(codesInName(p.Project));
      if (!codes.some(c => sameJob(c, w))) continue;
      const cands = [[p['Image Complete'], 'ภาพใบงานผลิต'], [p['ภาพใบงานหลัก'], 'ภาพใบงานผลิต'],
                     [mainImg.get(clean(p.ID)), 'ภาพใบสั่งผลิต (Job Card)'], [p.Image, 'ภาพงาน (Projects)']];
      const hit = cands.find(c => clean(c[0]));
      if (!hit) continue;
      pick.set(w, { raw: clean(hit[0]).split(/[\n,]+/)[0].trim(), from: hit[1], projectId: clean(p.ID),
                    project: clean(p.Project).slice(0, 120) });
      break;
    }
  }
  const raws = [...new Set([...pick.values()].map(x => x.raw))];
  let url = {};
  try { url = await resolveChunked(raws); } catch (e) { url = {}; }
  for (const [k, v] of pick) if (url[v.raw]) out.set(k, { url: url[v.raw], from: v.from, projectId: v.projectId, project: v.project });
  return out;
}
/* booking/images.resolveMany (แอปจองคิว) — แบ่งชุดละ 12 ให้ทุกรูปได้ถาม Drive (ไม่มีเพดานเงียบ) */
async function resolveChunked(raws) {
  const IMG = require('../booking/images');
  const per = Number(require('../projects/images').FALLBACK_MAX) || 12;
  const out = {};
  const maps = [];
  for (let i = 0; i < raws.length; i += per) maps.push(await IMG.resolveMany(raws.slice(i, i + per)));
  for (const m of maps) {
    if (m && typeof m.forEach === 'function' && typeof m.get === 'function') m.forEach((v, k) => { if (v) out[k] = v; });
    else if (m) for (const k of Object.keys(m)) if (m[k]) out[k] = m[k];
  }
  return out;
}

async function peakRowsOf(ids) {
  const out = new Map();
  let ready = true;
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const rows = await db.select('rfq_peak', { select: 'rfq_id,po_no,snap,synced_at', rfq_id: inList(ids.slice(i, i + 100)) }) || [];
      for (const r of rows) out.set(clean(r.rfq_id), r);
    } catch (e) { ready = false; break; }
  }
  return { map: out, ready };
}

/** เติมของเสริมให้ทุกใบบนบอร์ด (เรียกหลัง getRfqBoard) */
async function decorate(R, user) {
  const items = [];
  for (const s of (R.statuses || [])) for (const it of (R.groups[s] || [])) items.push(it);
  if (!items.length) return R;
  const jobs = items.map(x => x.job).filter(Boolean);
  const [leads, imgs, pk] = await Promise.all([
    leadsOf(jobs).catch(() => new Map()), imagesOf(jobs).catch(() => new Map()),
    peakRowsOf(items.map(x => x.id)).catch(() => ({ map: new Map(), ready: false })),
  ]);
  for (const it of items) {
    const k = lo(it.job);
    it.lead = leadInfo(leads.get(k));
    it.img = imgs.get(key(it.job)) || null;
    const p = pk.map.get(it.id);
    it.poNo = p ? clean(p.po_no) : '';
    it.peak = p && p.snap && p.snap.at ? p.snap : null;
    it.auto = /^RS\d+$/.test(it.id);
    /* 💰 รอบ 132 — ทุนบนการ์ด = ยอดใน PO ทันทีที่ซิงก์เจอ (แม้แถวในฐานยังไม่อัปเดต) */
    const poT = it.peak ? num(it.peak.poTotal) : 0;
    if (poT > 0) {
      it.costKeyed = it.peak.costKeyed != null ? num(it.peak.costKeyed) : num(it.cost);
      it.cost = poT; it.costFromPo = true;
      it.margin = r2(num(it.sell) - poT);
      it.marginPct = num(it.sell) > 0 ? Math.round((num(it.sell) - poT) / num(it.sell) * 1000) / 10 : 0;
    }
  }
  /* ยอดหัวบอร์ดคิดจากทุนชุดเดียวกับที่การ์ดแสดง */
  const OPEN = require('./rfq').RFQ_OPEN;
  let tm = 0;
  for (const it of items) if (OPEN.includes(it.status)) tm += num(it.margin);
  R.totalMargin = r2(tm);
  R.peakReady = pk.ready;
  if (!pk.ready) R.peakWarn = 'ยังไม่ได้รัน sql/98-rfq-peak.sql — ซิงก์ PEAK ยังเก็บผลไม่ได้';
  return R;
}

/* ═══════════════════════════════════════════════════════════════════
 *  ①③ ซิงก์ PEAK ของการ์ด 1 ใบ
 * ═══════════════════════════════════════════════════════════════════ */
const PO_TOL = 1;                       /* ยอดต่างไม่เกิน 1 บาท = ตรง */
const kindOf = code => /^DP/i.test(clean(code)) ? 'DP' : (/^EXP/i.test(clean(code)) ? 'EXP' : 'OTHER');
/* ข้อความทุกช่องชั้นบนของใบ (ไว้ค้นเลข IV/QO/รหัสงาน) — ‼ ชั้นเดียว ไม่มุดเข้ารายการสินค้า */
function textsOf(o) {
  const out = [];
  for (const k of Object.keys(o || {})) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) out.push(key(v));
    else if (typeof v === 'number') out.push(String(v));
  }
  return out;
}
/* ═══════════════════════════════════════════════════════════════════
 *  🔗 รอบ 223 (3 ต.ค. 69) — พี่เอ: "ตอนนี้ต้องการ sync PO จาก Peak ซึ่งตอนนี้ใน peak จะเปิด PO
 *     สั่งซื้อไปยัง outsource โดย link กับ เลขที่ QO ที่เสนอลูกค้านะ ตรวจสอบ code และแก้ไขด้วย"
 *
 *  ที่ตรวจเจอในโค้ดเดิม (รอบ 128):
 *   ① ค้นเลขอ้างอิงเฉพาะ "ช่องชั้นบนสุด" ของหัวใบในรายการ PO (PurchaseOrders/list)
 *      — ถ้ารายการของ PEAK ไม่ส่งช่องอ้างอิงมา หรือส่งมาในกล่องซ้อน = ไม่มีวันเจอ
 *   ② เทียบเลขแบบตรงตัวอักษร — "QO-2026031800010" กับ "QO2026031800010" / "QO 2026031800010" ไม่ตรงกัน
 *   ③ ไม่เคยถาม PEAK ตรง ๆ ด้วยเลขอ้างอิง ทั้งที่เอกสาร PEAK มีพารามิเตอร์นี้:
 *        GET /api/v1/PurchaseOrders?reference=<เลข>  ("search for documents by their reference value")
 *      (ท่าเดียวกับที่ไฟล์นี้ใช้ถามใบจ่าย: GET Expenses?reference=<เลข PO>)
 *   ④ ข้อความบนการ์ดบอกให้ "ref. เลข IV" อย่างเดียว ทั้งที่ตอนนี้บัญชีผูกกับเลข QO
 *  แก้: ค้นทุกชั้นของใบ (deepTexts) · เทียบเลขเอกสารแบบไม่สนขีด/เว้นวรรค (hasTok) ·
 *       ไม่เจอในรายการ ⇒ ถาม PEAK ด้วยเลขอ้างอิง (QO ก่อน แล้ว IV) · เลข QO ขึ้นก่อนในลำดับค้น
 *  🔒 ยัง GET อย่างเดียว · 🔴 ยังห้ามเดา: ใบที่ PEAK ตอบมาต้อง "มีเลขนั้นอยู่ในใบจริง" ถึงจะนับ
 * ═══════════════════════════════════════════════════════════════════ */
/** ข้อความทุกช่อง "ทุกชั้น" ของใบ (ลึกไม่เกิน 4 ชั้น · ไม่เกิน 800 ข้อความ) */
function deepTexts(o, depth, out) {
  out = out || []; depth = depth || 0;
  if (o == null || depth > 4 || out.length >= 800) return out;
  if (typeof o === 'string') { if (o.trim()) out.push(key(o)); return out; }
  if (typeof o === 'number') { out.push(String(o)); return out; }
  if (Array.isArray(o)) { for (const v of o) deepTexts(v, depth + 1, out); return out; }
  if (typeof o === 'object') for (const k of Object.keys(o)) deepTexts(o[k], depth + 1, out);
  return out;
}
const isDocTok = t => /^(IV|QO|QT)[-\s]?\d{6,}$/i.test(clean(t));
const plainDoc = s => clean(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
/**
 * ในข้อความพวกนี้ "มีเลข tok อยู่จริงไหม"
 *  · เลขเอกสาร (IV/QO/QT) เทียบแบบไม่สนขีด/เว้นวรรค — คนพิมพ์ในช่องอ้างอิงไม่เหมือนกันทุกคน
 *  · ตัวถัดไปต้องไม่ใช่ตัวเลข — QO-…00010 ต้องไม่ไปตรงกับ QO-…000101 · B2E2607/006 ไม่ตรงกับ /0061
 */
function hasTok(texts, tok) {
  const doc = isDocTok(tok);
  const want = doc ? plainDoc(tok) : key(tok);
  if (!want) return false;
  for (const v of (texts || [])) {
    const hay = doc ? plainDoc(v) : String(v);
    let i = hay.indexOf(want);
    while (i >= 0) {
      if (!/\d/.test(hay.charAt(i + want.length))) return true;
      i = hay.indexOf(want, i + 1);
    }
  }
  return false;
}
/**
 * ใบ PO ในคำตอบของ PEAK — ตอบเป็นรายการ หรือเป็นใบเดียว หรือห่อกี่ชั้นก็รับ
 * ‼ ไม่ใช้ peak.listOf: ใบรายตัวมีกล่อง "รายการสินค้า" ซ้อนอยู่ listOf จะคว้ากล่องนั้นมาเป็นใบได้
 * ‼ เจอใบแล้วไม่มุดต่อ (รายการสินค้าในใบก็มี code/ยอด หน้าตาคล้ายใบ)
 * ‼ เลขที่ใบต้องยาว ≥ 6 ตัว — กันซองคำตอบที่มีช่อง code: 200 / status: success
 */
function poDocsOf(json, PF) {
  const out = [];
  const looks = x => clean(peak.flat(x, PF.F_DOCNO).v).length >= 6 &&
    (clean(peak.flat(x, PF.F_STATUS).v) || peak.flat(x, PF.F_TOTAL).v !== '');
  const walk = (x, d) => {
    if (!x || typeof x !== 'object' || d > 4 || out.length >= 200) return;
    if (Array.isArray(x)) { for (const v of x) walk(v, d + 1); return; }
    if (looks(x)) { out.push(x); return; }
    for (const k of Object.keys(x)) walk(x[k], d + 1);
  };
  walk(json, 0);
  return out;
}
const notFoundMsg = m => /\b404\b|not\s*found|ไม่พบ|no\s*data/i.test(String(m || ''));

const nameKey = s => clean(s).toLowerCase().replace(/บริษัท|จำกัด|\(มหาชน\)|หจก\.?|ห้างหุ้นส่วน|คุณ|ร้าน|[\s.()\-]/g, '');

function poHead(po, PF, PP) {
  const f = n => peak.flat(po, PF[n]).v;
  const st = clean(f('F_STATUS'));
  const sup = peak.pickName(po);
  const totalRaw = peak.flat(po, PF.F_TOTAL).v;
  return {
    no: clean(f('F_DOCNO')), id: clean(f('F_ID')), status: st, group: PP.poStatusGroup(st),
    total: totalRaw === '' ? null : num(totalRaw),
    supplier: sup.name, supplierCode: sup.code,
    issue: PP.poDay(f('F_ISSUE')) || PP.poDay(f('F_ORDER')), due: PP.poDay(f('F_DUE')),
  };
}

async function canKey(user, rfqRow) {
  const AR = require('./ar-aging');
  const R = require('./rfq');
  return AR._isAdministrator(user) || AR._isAccounting(user) || R._rfqIsOwner(user, rfqRow || {});
}

async function peakRow(id) {
  return db.one('rfq_peak', { select: '*', rfq_id: 'eq.' + clean(id) });
}
async function peakSave(id, patch) {
  const cur = await peakRow(id);
  if (cur) await db.update('rfq_peak', { rfq_id: 'eq.' + clean(id) }, patch);
  else await db.insert('rfq_peak', [{ rfq_id: clean(id), ...patch }]);
}

/** ③ แอดมิน/บัญชี/เจ้าของงาน คีย์เลข PO เอง (เฉพาะใบที่ระบบหาไม่เจอ) แล้วซิงก์ทันที */
async function savePo(user, id, poNo) {
  const card = await db.one('rfq', { select: '*', rfq_id: 'eq.' + clean(id) });
  if (!card) throw _err('ไม่พบการ์ด Outsource');
  if (!(await canKey(user, card))) throw _err('คีย์เลข PO ได้เฉพาะแอดมิน · บัญชี · เจ้าของงาน');
  const list = clean(poNo).split(/[\s,;]+/).map(key).filter(Boolean);
  if (list.some(p => !/^[A-Z0-9][A-Z0-9\-/.]{3,40}$/.test(p))) throw _err('เลข PO ไม่ถูกรูปแบบ (เช่น PO-69092100003)');
  try {
    await peakSave(id, { po_no: list.join(','), job_code: clean(card.job_code),
      updated_at: new Date().toISOString(), updated_by: clean(user && (user.username || user.name)) });
  } catch (e) { throw _err('ยังไม่ได้รัน sql/98-rfq-peak.sql — เก็บเลข PO ไม่ได้'); }
  return syncCard(user, id);
}

/**
 * ดึงใบ PO + ใบจ่าย (DP มัดจำ / EXP) ของการ์ด 1 ใบจาก PEAK แล้วเก็บภาพถ่ายลง app.rfq_peak
 * 🔒 GET อย่างเดียว · ใช้ตัวอ่าน PO ของคลัง (แคช) + คำขอ Expenses ไม่เกิน 1 ใบต่อ PO
 */
async function syncCard(user, id, opt) {
  opt = opt || {};
  const PE = require('../../core/peak-expenses');
  const PP = require('../inventory/peakpo');
  const PF = PP.PO_FIELDS;
  const card = await db.one('rfq', { select: '*', rfq_id: 'eq.' + clean(id) });
  if (!card) throw _err('ไม่พบการ์ด Outsource');
  let saved = null;
  try { saved = await peakRow(id); } catch (e) { saved = null; }
  const manual = clean(saved && saved.po_no).split(',').map(key).filter(Boolean);
  const L = clean(card.job_code) ? (await leadsOf([card.job_code])).get(lo(card.job_code)) : null;
  const lead = leadInfo(L);
  const snap = { at: isoTH(), biz: '', match: 'none', matchWhy: '', tokens: [], pos: [], docs: [],
                 poTotal: 0, paid: 0, remain: 0, paidPct: 0, closed: false, calls: 0, warn: [],
                 poKeys: [], lead };

  /* เลขที่ใช้ค้นในใบ PO: IV/QO ของงาน + รหัสงาน (บัญชีเปิด PO ที่ ref. กับเลขที่ IV) */
  /* ‼ แยกเลขทีละใบ — ช่องเดียวมี "QO-… / IV-…" ได้ (ถ้าเอาทั้งก้อนไปค้นจะไม่เจอสักใบ) */
  /* 🔗 รอบ 223 — เลข QO ขึ้นก่อน (ตอนนี้บัญชีเปิด PO โดยผูกกับเลข QO ที่เสนอลูกค้า) แล้วค่อย IV · รหัสงาน */
  const docsQoFirst = ((lead && lead.docs) || []).slice()
    .sort((a, b) => (/^(QO|QT)/.test(a) ? 0 : 1) - (/^(QO|QT)/.test(b) ? 0 : 1));
  const toks = docsQoFirst.concat([key(card.job_code)]).filter(t => t.length >= 5);
  snap.tokens = [...new Set(toks)];
  snap.refAsk = [];

  const bizes = [];
  if (lead && lead.biz && peak.isConfigured(lead.biz)) bizes.push(lead.biz);
  for (const b of peak.configuredList()) if (bizes.indexOf(b) < 0) bizes.push(b);
  if (!bizes.length) { snap.warn.push('ยังไม่ได้ตั้งกุญแจ PEAK สักกิจการ'); return finish(); }

  const found = [];   /* { head, biz, by } */
  const guesses = [];
  for (const biz of bizes) {
    let bulk;
    try { bulk = await PP.loadAll(biz); snap.calls += (bulk.fromCache ? 0 : bulk.calls || 0); }
    catch (e) { snap.warn.push('อ่านใบ PO ของ ' + biz + ' ไม่ได้ — ' + String((e && e.message) || e).slice(0, 160)); continue; }
    if (!bulk.complete) snap.warn.push('ใบ PO ของ ' + biz + ' โหลดไม่ครบ (' + (bulk.why || '') + ') — อาจหาไม่เจอเพราะเหตุนี้');
    for (const po of (bulk.rows || [])) {
      const h = poHead(po, PF, PP);
      if (!h.no) continue;
      if (!snap.poKeys.length) snap.poKeys = Object.keys(po).slice(0, 60);
      const noK = key(h.no);
      if (manual.indexOf(noK) >= 0) { found.push({ head: h, biz, by: 'manual' }); continue; }
      if (manual.length) continue;                         /* ‼ คีย์เองแล้ว = ยึดตามที่คีย์ ไม่หาเพิ่ม */
      const tx = deepTexts(po);
      const hit = snap.tokens.find(t => t !== noK && hasTok(tx, t));
      if (hit) { found.push({ head: h, biz, by: 'ref', tok: hit }); continue; }
      /* ทางสุดท้าย: ผู้ขายใน PEAK ตรงกับผู้ผลิตที่เซลส์คีย์ + ยอด PO เท่าทุน (หรือทุน+VAT 7%) */
      const cost = num(card.cost_quoted);
      const sn = nameKey(h.supplier), on = nameKey(card.outsource);
      const nameOk = sn.length >= 3 && on.length >= 3 && (sn.indexOf(on) >= 0 || on.indexOf(sn) >= 0);
      const amtOk = h.total != null && cost > 0 &&
        (Math.abs(h.total - cost) <= PO_TOL || Math.abs(h.total - r2(cost * 1.07)) <= PO_TOL);
      /* 🔗 รอบ 223 — ใบ PO ที่ "อ้างอิงเลข QO/IV ของงานอื่น" อยู่แล้ว ห้ามเอามาเดาให้การ์ดนี้
       *   (ตอนนี้บัญชีผูก PO กับเลข QO ⇒ ใบที่มีเลข QO ของงานอื่น = ของงานนั้นแน่ ๆ) */
      const mine = snap.tokens.filter(isDocTok).map(plainDoc);
      const refOther = docsIn(...tx).some(d => plainDoc(d) !== plainDoc(noK) && mine.indexOf(plainDoc(d)) < 0);
      if (nameOk && amtOk && h.group !== 'cancelled' && !refOther) guesses.push({ head: h, biz, by: 'guess' });
    }
    if (found.length) { snap.biz = biz; break; }
  }
  /* ── 🔗 รอบ 223 — ไม่เจอในรายการ ⇒ ถาม PEAK ตรง ๆ ด้วยเลขอ้างอิง ────────────
   *   GET PurchaseOrders?reference=<เลข QO / IV>   (พารามิเตอร์ตามเอกสาร PEAK)
   *   · ถามเฉพาะเลขเอกสาร (ไม่ถามด้วยรหัสงาน) · QO ก่อน IV · ไม่เกิน 3 เลข
   *   · รู้กิจการจากเลขเอกสารแล้ว = ถามกิจการนั้นกิจการเดียว
   *   🔴 นับเฉพาะใบที่ "มีเลขนั้นอยู่ในใบจริง" — กัน PEAK ไม่กรองแล้วส่งหน้าแรกของทุกใบมา
   *   ‼ เจอในรายการแล้ว / มีเลข PO ที่คีย์ไว้ = ไม่ถาม (ไม่เปลืองคำขอ) */
  if (!found.length && !manual.length) {
    const askToks = snap.tokens.filter(isDocTok).slice(0, 3);
    const askBiz = (lead && lead.biz && bizes.indexOf(lead.biz) >= 0) ? [lead.biz] : bizes;
    outer:
    for (const biz of askBiz) {
      for (const tok of askToks) {
        if (!(await PE.rateGate(20000))) {
          snap.warn.push('โควตาคำขอ PEAK ต่อนาทีเต็ม — ยังไม่ได้ถาม PEAK ด้วยเลขอ้างอิง ' + tok + ' (จะถามรอบหน้า)');
          break outer;
        }
        snap.calls++;
        const rec = { biz, tok, got: 0, kept: 0 };
        try {
          const j = await peak.get('PurchaseOrders', { reference: tok, limit: 50 }, biz);
          const arr = poDocsOf(j, PF);
          rec.got = arr.length;
          for (const po of arr) {
            const h = poHead(po, PF, PP);
            if (!h.no || key(h.no) === key(tok)) continue;
            if (!hasTok(deepTexts(po), tok)) continue;
            rec.kept++;
            if (!found.some(f => key(f.head.no) === key(h.no))) found.push({ head: h, biz, by: 'ref', tok, via: 'ask' });
          }
          if (arr.length && !rec.kept) {
            rec.keys = Object.keys(arr[0] || {}).slice(0, 40);
            snap.warn.push('ถาม PEAK ด้วยเลขอ้างอิง ' + tok + ' ได้ใบ PO ' + arr.length + ' ใบ แต่ไม่มีใบไหนมีเลขนี้อยู่ในใบ — ไม่นับ');
          }
        } catch (e) {
          rec.error = String((e && e.message) || e).slice(0, 140);
          if (!notFoundMsg(rec.error)) snap.warn.push('ถาม PEAK ด้วยเลขอ้างอิง ' + tok + ' ไม่ได้ — ' + rec.error);
        }
        snap.refAsk.push(rec);
        if (found.length) { snap.biz = biz; break outer; }
      }
    }
  }
  if (!found.length && guesses.length === 1) { found.push(guesses[0]); snap.biz = guesses[0].biz; }
  if (!found.length && guesses.length > 1)
    snap.warn.push('เจอใบ PO ที่ผู้ขาย+ยอดตรงกัน ' + guesses.length + ' ใบ (' +
      guesses.map(g => g.head.no).join(', ') + ') — ระบบไม่เลือกให้เอง ให้บัญชีคีย์เลข PO');
  if (manual.length) {
    const miss = manual.filter(m => !found.some(f => key(f.head.no) === m));
    if (miss.length) snap.warn.push('ไม่พบใบ PO ' + miss.join(', ') + ' ใน PEAK (ถามครบ ' + bizes.join(' / ') + ')');
  }
  snap.match = found.length ? found[0].by : 'none';
  const refNos = snap.tokens.filter(isDocTok);
  snap.matchWhy = !found.length
      ? (refNos.length
          ? 'ยังไม่พบใบ PO ใน PEAK ที่อ้างอิงเลข ' + refNos.join(' / ') +
            ' — ให้บัญชีใส่เลข QO ในช่อง "อ้างอิง" ของใบ PO หรือคีย์เลข PO เอง'
          : 'ยังไม่พบใบ PO ใน PEAK — งานนี้ยังไม่มีเลข QO / IV ให้ค้น · คีย์เลข PO เองได้')
    : found[0].by === 'manual' ? 'ตามเลข PO ที่คีย์ไว้'
    : found[0].by === 'ref' ? 'ใบ PO อ้างอิงเลข ' + found[0].tok
    : '⚠️ จับคู่จากชื่อผู้ขาย + ยอดตรงกัน (ไม่มีเลขอ้างอิงในใบ) — ตรวจอีกครั้ง';
  snap.pos = found.map(f => ({ ...f.head, biz: f.biz, by: f.by, refTok: f.tok || '', via: f.via || '' }));

  /* ── ใบจ่าย DP (มัดจำ) / EXP (จ่ายครบ) ของแต่ละ PO ────────────── */
  const docs = new Map();
  const add = (d, from) => { if (d && d.code && !docs.has(key(d.code))) docs.set(key(d.code), { ...d, from }); };
  for (const f of found.slice(0, 5)) {
    const poNo = f.head.no;
    /* ① PEAK เอง: GET Expenses?reference=<เลข PO> (พารามิเตอร์ตามเอกสาร PEAK)
     *   🔴 ยอมรับเฉพาะใบที่ "มีเลข PO อยู่ในใบจริง" — กัน PEAK ไม่กรองแล้วส่งหน้าแรกของทุกใบมา */
    let ep = 'Expenses';
    try { ep = clean(await require('../../core/peak-queue').state('exp_ep|' + f.biz)) || 'Expenses'; } catch (e) { /* ใช้ชื่อตามเอกสาร */ }
    if (await PE.rateGate(20000)) {
      snap.calls++;
      try {
        const j = await peak.get(ep, { reference: poNo, limit: 50 }, f.biz);
        const arr = peak.listOf(j);
        let kept = 0;
        for (const it of arr) {
          if (!textsOf(it).some(v => v.indexOf(key(poNo)) >= 0)) continue;
          const x = PE.normalize(it);
          if (x) { kept++; add(docOf(x), 'PEAK อ้างอิง ' + poNo); }
        }
        if (arr.length && !kept) snap.warn.push('PEAK ตอบรายการจ่าย ' + arr.length + ' ใบ แต่ไม่มีใบไหนอ้างอิง ' + poNo + ' — ไม่นับ');
      } catch (e) { snap.warn.push('ถามใบจ่ายของ ' + poNo + ' จาก PEAK ไม่ได้ — ' + String((e && e.message) || e).slice(0, 140)); }
    } else snap.warn.push('โควตาคำขอ PEAK ต่อนาทีเต็ม — ใบจ่ายของ ' + poNo + ' จะดึงรอบหน้า');
    /* ② ตาราง app.peak_expenses (ตัวเดียวกับ Cashflow) — ใบที่หมายเหตุมีเลข PO */
    try {
      const rows = await db.select('peak_expenses', { select: 'code,doc_date,due_at,vendor,net,paid,remain,status,url,paid_at,note,biz',
        note: 'ilike.*' + clean(poNo) + '*', limit: 50 }) || [];
      for (const r of rows) add({ code: clean(r.code), kind: kindOf(r.code), net: num(r.net), paid: num(r.paid),
        remain: num(r.remain), payDate: clean(r.paid_at), issued: clean(r.doc_date), due: clean(r.due_at),
        status: clean(r.status), stKind: PE.statusKind(r.status), url: clean(r.url), vendor: clean(r.vendor) },
        'Cashflow (หมายเหตุมี ' + poNo + ')');
    } catch (e) { /* ตารางยังว่างก็ไม่เป็นไร */ }
  }
  const list = [...docs.values()].sort((a, b) => ((a.payDate || a.issued || '') < (b.payDate || b.issued || '') ? -1 : 1));
  list.forEach((d, i) => { d.n = i + 1; });
  snap.docs = list;

  snap.poTotal = r2(snap.pos.filter(p => p.group !== 'cancelled').reduce((s, p) => s + num(p.total), 0));
  snap.paid = r2(list.filter(d => d.stKind !== 'void')
    .reduce((s, d) => s + (d.paid > 0 ? d.paid : (d.stKind === 'paid' ? d.net : 0)), 0));
  snap.remain = r2(Math.max(0, snap.poTotal - snap.paid));
  snap.paidPct = snap.poTotal > 0 ? Math.min(100, Math.round(snap.paid / snap.poTotal * 1000) / 10) : 0;
  snap.closed = snap.poTotal > 0 && snap.paid >= snap.poTotal - PO_TOL;
  if (snap.pos.length && !list.length)
    snap.warn.push('ยังไม่พบใบจ่าย (DP มัดจำ / EXP) ที่อ้างอิงใบ PO นี้ใน PEAK');
  return finish();

  async function finish() {
    /* 💰 รอบ 132 — "ให้ราคาสั่งซื้อใน PO มาใส่เป็นราคาทุนใน card" ⇒ เจอ PO แล้ว ทุนของการ์ด = ยอดใน PO
     *   (รวมทุกใบที่ไม่ยกเลิก) · กำไร = ขาย − ทุน คิดใหม่ · เขียนเฉพาะฐานเรา ไม่แตะ PEAK */
    if (snap.poTotal > 0) {
      const sell = num(card.sell_offered);
      snap.costKeyed = num(card.cost_quoted);
      snap.costFromPo = true;
      if (Math.abs(num(card.cost_quoted) - snap.poTotal) > 0.005) {
        try {
          await db.update('rfq', { rfq_id: 'eq.' + clean(id) },
            { cost_quoted: snap.poTotal, margin: r2(sell - snap.poTotal), updated_at: isoTH() });
        } catch (e) { snap.warn.push('เขียนทุนตาม PO ลงการ์ดไม่ได้ — ' + String((e && e.message) || e).slice(0, 120)); }
      }
    }
    try {
      await peakSave(id, { snap, synced_at: new Date().toISOString(), job_code: clean(card.job_code) });
    } catch (e) { snap.warn.push('ยังไม่ได้รัน sql/98-rfq-peak.sql — ผลซิงก์ไม่ถูกเก็บ'); }
    return { ok: true, id: clean(id), peak: snap, poNo: manual.join(',') };
  }
}
/* ใบจ่าย 1 ใบ → รูปที่การ์ดใช้ (จาก peak-expenses.normalize) */
function docOf(x) {
  return { code: x.code, kind: kindOf(x.code), net: num(x.net), paid: num(x.paid), remain: num(x.remain),
           payDate: x.payDate || '', issued: x.issued || '', due: x.due || '', status: x.status || '',
           stKind: x.stKind || '', url: kindOf(x.code) === 'EXP' ? (x.url || '') : '', vendor: x.vendor || '' };
}

/* ซิงก์หลายใบ (ปุ่ม "ซิงก์ PEAK ทั้งบอร์ด") — ทีละใบ · ใบไหนพังไม่ล้มทั้งชุด */
let _manyBusy = false;
async function syncMany(user, ids, opt) {
  opt = opt || {};
  if (_manyBusy) return { ok: false, busy: true, msg: 'กำลังซิงก์ชุดก่อนหน้าอยู่' };
  _manyBusy = true;
  const res = { ok: true, done: 0, fail: [], results: {} };
  try {
    for (const id of ids) {
      try { const r = await syncCard(user, id); res.results[id] = r.peak; res.done++; }
      catch (e) { res.fail.push({ id, error: String((e && e.message) || e).slice(0, 200) }); }
    }
  } finally { _manyBusy = false; }
  return res;
}

/** ใบที่ควรซิงก์ใหม่ (ไม่เคยซิงก์ / เก่ากว่า maxAgeMs) — เรียกหลังโหลดบอร์ดแบบไม่บล็อก */
function staleIds(R, maxAgeMs, max) {
  const out = [];
  const now = Date.now();
  for (const s of (R.statuses || [])) for (const it of (R.groups[s] || [])) {
    if (!/ปิดการขาย|ต่อรองราคากับ Partner|สั่งผลิต|ส่งมอบ/.test(it.status)) continue;
    const at = it.peak && it.peak.at ? Date.parse(it.peak.at) : 0;
    if (!at || now - at > maxAgeMs) out.push(it.id);
    if (out.length >= max) return out;
  }
  return out;
}

module.exports = {
  ensureAuto, autoForget, autoJobOf, skipAdd, decorate, syncCard, syncMany, savePo, staleIds,
  AUTO_FROM, AUTO_BY, isInHouse, isClosed, kindOf, makerKey, dropInHouse,
  _t: { textsOf, nameKey, poHead, leadInfo, key, codesInName, docsIn, deepTexts, hasTok, isDocTok, poDocsOf },
};
