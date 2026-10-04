'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  tools/test-rfq-peak.js — รอบ 128 · การ์ด Outsource × คีย์ยอดขาย × PEAK × ภาพใบงาน
 *
 *  พี่เอสั่ง: การ์ดสร้างเองจากคีย์ยอดขาย (ผู้ผลิตไม่ใช่ The101 · ปิดการขาย ≥ 1 ม.ค. 69)
 *    · เลข QO/IV · ใบ PO (เลข · ยอด · Supplier · สถานะอนุมัติ) · ใบจ่ายมัดจำ DP / EXP (งวด · วันจ่าย)
 *    · รูปพนักงาน · ภาพใบงานผลิตจาก app Projects (link ที่รหัสงาน) · การ์ดแบบลูกหนี้ค้างชำระ
 *
 *  ‼ ส่วน ① รันตรรกะตัวจริง (modules/sales/rfqpeak.js) บนฐานจำลองที่บังคับกติกาเดียวกับ core/db
 *    และ PEAK จำลองที่ "ไม่กรองให้" ถ้าใบไม่ได้อ้างอิงจริง (กับดักเดิมของโครงการนี้)
 *  ‼ ส่วน ② เปิดหน้าเว็บตัวจริงใน Chromium แล้ววัดของบนจอ
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);

/* ── ฐานจำลอง (กติกาเดียวกับ core/db) ── */
function makeDb(T) {
  let seq = 1000;
  for (const k of Object.keys(T)) for (const r of T[k]) if (r._id == null) r._id = ++seq;
  const unq = s => String(s).replace(/^"(.*)"$/, '$1');
  const RES = new Set(['select', 'order', 'limit', 'offset', 'on_conflict']);
  const parseIn = s => { const out = []; const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g; let m;
    while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]); return out; };
  /* or=(job_code.in.("a","b"),Project.ilike."*x*") — เท่าที่โค้ดนี้ใช้ ไม่รู้จักต้องดัง */
  const orMatch = (row, s) => {
    const body = s.replace(/^\(|\)$/g, '');
    const parts = []; let depth = 0, inQ = false, cur = '';
    for (let i = 0; i < body.length; i++) { const ch = body[i];
      if (inQ) { cur += ch; if (ch === '\\') { cur += body[++i]; continue; } if (ch === '"') inQ = false; continue; }
      if (ch === '"') { inQ = true; cur += ch; continue; }
      if (ch === '(') depth++; if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; } cur += ch; }
    if (cur) parts.push(cur);
    return parts.some(pt => {
      const m = pt.match(/^([A-Za-z_]+)\.(in|ilike)\.(.*)$/);
      if (!m) throw new Error('ฐานจำลองไม่รู้จัก or: ' + pt);
      const cur2 = String(row[m[1]] == null ? '' : row[m[1]]);
      if (m[2] === 'in') return parseIn(m[3].slice(1, -1)).indexOf(cur2) >= 0;
      const w = m[3].replace(/^"|"$/g, '').replace(/\*/g, '').toLowerCase();
      return cur2.toLowerCase().indexOf(w) >= 0;
    });
  };
  const match = (row, p) => {
    for (const [k0, v] of Object.entries(p || {})) {
      if (RES.has(k0)) continue;
      if (k0 === 'or') { if (!orMatch(row, String(v))) return false; continue; }
      const col = unq(k0), s = String(v), cur = row[col] == null ? '' : row[col];
      if (s.startsWith('eq.')) { if (String(cur) !== s.slice(3)) return false; continue; }
      if (s.startsWith('in.(')) { if (parseIn(s.slice(4, -1)).indexOf(String(cur)) < 0) return false; continue; }
      if (s === 'not.is.null') { if (row[col] == null || row[col] === '') return false; continue; }
      if (s.startsWith('gte.')) { if (!(String(cur) >= s.slice(4))) return false; continue; }
      if (s.startsWith('ilike.')) { const w = s.slice(6).replace(/\*/g, '').toLowerCase();
        if (String(cur).toLowerCase().indexOf(w) < 0) return false; continue; }
      throw new Error('ฐานจำลองยังไม่รองรับตัวกรอง: ' + k0 + '=' + s);
    }
    return true;
  };
  const need = t => { if (!T[t]) { const e = new Error('relation "app.' + t + '" does not exist'); throw e; } return T[t]; };
  return {
    _T: T,
    async select(t, p) { const l = Number(p && p.limit); const o = need(t).filter(r => match(r, p)); return l > 0 ? o.slice(0, l) : o; },
    async selectAll(t, p) { if (!p || !p.order) throw new Error(`selectAll('${t}') ต้องระบุ order เสมอ`); return need(t).filter(r => match(r, p)); },
    async one(t, p) { const r = need(t).filter(r => match(r, p)); return r.length ? r[0] : null; },
    async insert(t, body) { const out = []; for (const b of [].concat(body)) { const row = Object.assign({ _id: ++seq }, b); need(t).push(row); out.push(row); } return out; },
    async update(t, p, patch) { const h = need(t).filter(r => match(r, p)); for (const r of h) Object.assign(r, patch); return h; },
    async remove(t, p) { const g = need(t).filter(r => match(r, p)); T[t] = need(t).filter(r => !match(r, p)); return g; },
  };
}

const TABLES = { total_sales: [], rfq: [], rfq_peak: [], rfq_auto_skip: [], sales_prefix: [],
  projects: [], production_jobs: [], peak_expenses: [], img_index: [], peak_state: [] };
const S = (row, job, over) => Object.assign({ _row: row, 'รหัสงาน': job, 'ชื่อบริษัท': 'บริษัท ' + job,
  'Lead Status': 'ปิดการขาย', 'วันที่ปิดการขาย': '2026-03-10', 'ผู้ผลิต': 'คุณแจ็ค แอดกูร',
  'ยอดสั่งซื้อ (Outsource)': 78000, 'ยอดขาย (บาท)': 111000, 'Create By': '(พลอย) พลอยไพลิน',
  'บริษัทที่ขาย': 'มดงานการป้าย' }, over || {});
TABLES.total_sales.push(
  S(10, 'B2E2607/006', { 'ชื่อบริษัท': 'บริษัท รอยัล อินเตอร์เทรด จำกัด', 'เลขที่ QO / IV': 'QO-2026021100028 / IV-2026031000012',
    'เลขที่ใบเสนอราคา PEAK': 'QT-2026030100004', 'ลิงก์เอกสาร PEAK': 'https://secure.peakaccount.com/income/invoiceDetail?uuid=abc' }),
  S(11, 'B2P2607/011', { 'ผู้ผลิต': 'ผลิตเอง-The101' }),                                  /* ผลิตเอง → ไม่เอา */
  S(12, 'B2P2512/001', { 'วันที่ปิดการขาย': '2025-12-20' }),                              /* ก่อน 1 ม.ค. 69 → ไม่เอา */
  S(13, 'B2P2607/013', { 'Lead Status': 'เสนอราคา' }),                                    /* ยังไม่ปิดการขาย → ไม่เอา */
  S(14, 'QW2607/010', { 'ผู้ผลิต': 'โรงงาน ข' }),                                          /* มีการ์ดที่คนสร้างเองอยู่แล้ว */
  S(15, 'B2P2607/006', { 'ชื่อบริษัท': 'บริษัท ไตร-สตาร์ ดีไซน์', 'ผู้ผลิต': 'LM มีเดีย',
    'ยอดสั่งซื้อ (Outsource)': 5440, 'ยอดขาย (บาท)': 19000, 'Create By': '(ปีก) ปีกทอง' }),
  S(16, 'B2P2607/020', { 'ผู้ผลิต': 'ร้านสองใบ', 'ยอดสั่งซื้อ (Outsource)': 1000, 'ยอดขาย (บาท)': 3000 }),
  S(17, 'B2P2607/021', { 'ผู้ผลิต': 'The 101', 'ยอดขาย (บาท)': 3000 }),                    /* "The 101" ก็คือผลิตเอง */
  S(19, 'B2P2607/022', { 'ผู้ผลิต': 'ผลิตเอง-มดงาน', 'ยอดขาย (บาท)': 3000 }),               /* 🔴 รอบ 130: ผลิตเองทุกแบบ → ไม่เอา */
  S(20, 'B2P2607/023', { 'ผู้ผลิต': 'ส่งนอก', 'บริษัทที่ขาย': 'มดงานการป้าย', 'ยอดขาย (บาท)': 3531, 'ยอดสั่งซื้อ (Outsource)': 1000 }),
);
/* การ์ดเก่าจากชีตที่คนเลือก "ผลิตเอง-The101" — ต้องไม่ขึ้นบอร์ด Outsource (แต่ไม่ลบแถว) */
TABLES.rfq.push({ id: 2, rfq_id: 'R222', job_code: 'QB2607/002', company: 'บริษัท อมาเดีย กรุ๊ป', outsource: 'ผลิตเอง-The101',
  status: 'เสนอลูกค้า', cost_quoted: 286000, sell_offered: 385000, sale: 'กุ๊กกิ๊ก', created_by: 'กุ๊กกิ๊ก',
  created_at: '2026-07-01T03:00:00Z', sent_at: '2026-07-01', files: '[]', boq: '[]' });
TABLES.rfq.push({ id: 1, rfq_id: 'R111', job_code: 'QW2607/010', company: 'บริษัท รมัย คอร์ป', outsource: 'คุณแจ็ค แอดกูร',
  status: 'เสนอลูกค้า', cost_quoted: 395200, sell_offered: 573040, sale: 'แว่น', created_by: 'แว่นตา',
  created_at: '2026-07-01T03:00:00Z', sent_at: '2026-07-01', files: '[]', boq: '[]' });
/* ภาพใบงานผลิต: projects.job_code → "ภาพใบงานหลัก" · อีกงานมีแต่ MainJobImage ของ Job Card */
/* 🔴 รอบ 128.1 — ของจริง: job_code ว่าง รหัสงานอยู่ใน "ชื่อ Project" · เอาเฉพาะ Status = Complete */
TABLES.projects.push(
  { ID: 'P-A', job_code: '', Project: 'B2E2607/006-1 ป้ายไฟ รอยัล', Status: 'Complete', Complete: '2026-07-20',
    'Image Complete': 'https://drive.google.com/file/d/WOIMGAAAAAAAAAAAAAAAAAAAAAA/view', 'ภาพใบงานหลัก': '', Image: '' },
  { ID: 'P-A0', job_code: 'B2E2607/006', Project: 'B2E2607/006 แบบร่าง', Status: 'In Progress', Complete: '',
    'Image Complete': 'https://drive.google.com/file/d/NOTDONEXXXXXXXXXXXXXXXXXXXXX/view', 'ภาพใบงานหลัก': '', Image: '' },
  { ID: 'P-X', job_code: '', Project: 'B2E2607/0061 งานอื่น', Status: 'Complete', Complete: '2026-08-01',
    'Image Complete': 'https://drive.google.com/file/d/WRONGJOBXXXXXXXXXXXXXXXXXXXX/view', 'ภาพใบงานหลัก': '', Image: '' },
  { ID: 'P-B', job_code: 'B2P2607/006', Project: 'ไตร-สตาร์', Status: 'Complete', Complete: '2026-07-01',
    'ภาพใบงานหลัก': '', 'Image Complete': '', Image: '' },
);
TABLES.production_jobs.push({ ProjectID: 'P-B', MainJobImage: 'https://drive.google.com/open?id=JCIMGBBBBBBBBBBBBBBBBBBBBBBBB' });

const DB = makeDb(TABLES);
const corePath = require.resolve(path.join(ROOT, 'core/db.js'));
require.cache[corePath] = { id: corePath, filename: corePath, loaded: true, exports: DB };

/* ── PEAK จำลอง: 🔒 นับทุกคำขอ + จดชื่อ endpoint ── */
const peak = require(path.join(ROOT, 'core/peak.js'));
const calls = [];
peak.isConfigured = b => b === 'มดงานการป้าย' || b === 'The 101';
peak.configuredList = () => ['มดงานการป้าย', 'The 101'];
const PO_ROWS = {
  'มดงานการป้าย': [
    { id: 'po-1', code: 'PO-2026031500001', reference: 'IV-2026031000012', status: 'อนุมัติแล้ว', netAmount: 83460,
      contactName: 'คุณแจ็ค แอดกูร', issuedDate: '20260315', dueDate: '20260330' },
    { id: 'po-2', code: 'PO-2026031600002', reference: '', status: 'ออกครบแล้ว', netAmount: 5440,
      contactName: 'LM มีเดีย จำกัด', issuedDate: '20260316' },
    { id: 'po-3', code: 'PO-2026031700003', reference: '', status: 'อนุมัติแล้ว', netAmount: 1000, contactName: 'ร้านสองใบ' },
    { id: 'po-4', code: 'PO-2026031700004', reference: '', status: 'อนุมัติแล้ว', netAmount: 1000, contactName: 'ร้านสองใบ' },
    { id: 'po-5', code: 'PO-2026031800005', reference: '', status: 'รออนุมัติ', netAmount: 9999, contactName: 'ใครก็ไม่รู้' },
  ],
  'The 101': [],
};
const PP = require(path.join(ROOT, 'modules/inventory/peakpo.js'));
PP.loadAll = async biz => { calls.push('PO-list:' + biz); return { rows: PO_ROWS[biz] || [], complete: true, calls: 1, fromCache: false }; };
/* Expenses: ‼ จำลองว่า PEAK "ไม่กรองให้" — ส่งทุกใบกลับมา (มีใบที่ไม่เกี่ยวปนด้วย) */
const EXP = [
  { id: 'e1', code: 'DP-2026031600001', reference: 'PO-2026031500001', status: 'รอหักมัดจำ', netAmount: 25038,
    contactName: 'คุณแจ็ค แอดกูร', issuedDate: '20260316', paidPayments: [{ paymentDate: '20260316', paymentTotal: 25038 }] },
  { id: 'e2', code: 'EXP-2026040200003', reference: 'PO-2026031500001', status: 'รับใบเสร็จแล้ว', netAmount: 58422,
    contactName: 'คุณแจ็ค แอดกูร', issuedDate: '20260402', paidPayments: [{ paymentDate: '20260403', paymentTotal: 58422 }] },
  { id: 'e3', code: 'EXP-2026040500009', reference: 'ค่าไฟ', status: 'รอชำระ', netAmount: 3000, contactName: 'การไฟฟ้า' },
];
peak.get = async (ep, params, biz) => {
  calls.push(ep + ':' + JSON.stringify(params) + ':' + biz);
  if (/^expenses$/i.test(ep)) return { data: { expenses: EXP } };
  throw new Error('HTTP 404 ไม่รู้จัก ' + ep);
};

const RP = require(path.join(ROOT, 'modules/sales/rfqpeak.js'));
const RFQ = require(path.join(ROOT, 'modules/sales/rfq.js'));
const ADMIN = { username: 'admin', name: 'แอดมิน', permission: 'Administrator' };
const ACC = { username: 'acc1', name: 'บัญชี', nickname: 'บัญชี', permission: 'Accounting' };
const OTHER = { username: 'x', name: 'คนอื่น', nickname: 'คนอื่น', permission: 'Sale' };

(async () => {
  console.log('\n🧪 รอบ 128 — การ์ด Outsource × คีย์ยอดขาย × PEAK × ภาพใบงาน\n');

  head('① การ์ดอัตโนมัติจากตารางคีย์ยอดขาย');
  const a1 = await RP.ensureAuto({ force: true });
  const autos = TABLES.rfq.filter(r => r.created_by === RP.AUTO_BY);
  ok(a1.created === 4 && autos.length === 4,
     'สร้างการ์ด 3 ใบ (ได้ ' + a1.created + ': ' + autos.map(r => r.job_code).join(', ') + ')');
  ok(!autos.some(r => /2607\/011|2607\/021|2607\/022/.test(r.job_code)), '"ผลิตเอง-The101" / "ผลิตเอง-มดงาน" / "The 101" ไม่ถูกสร้าง');
  const c20 = autos.find(r => r.job_code === 'B2P2607/023');
  ok(c20 && c20.outsource === 'ส่งนอก', '🔴 ผู้ผลิตบนการ์ด = ช่อง "ผู้ผลิต" (ส่งนอก) ไม่ใช่ "บริษัทที่ขาย" (มดงานการป้าย)');
  ok(!autos.some(r => r.job_code === 'B2P2512/001'), 'ปิดการขายก่อน 1 ม.ค. 69 ไม่ถูกสร้าง');
  ok(!autos.some(r => r.job_code === 'B2P2607/013'), 'ยังไม่ปิดการขาย ไม่ถูกสร้าง');
  ok(TABLES.rfq.filter(r => r.job_code === 'QW2607/010').length === 1 && TABLES.rfq.find(r => r.rfq_id === 'R111').cost_quoted === 395200,
     '‼ งานที่มีการ์ดที่คนสร้างเองอยู่แล้ว ไม่สร้างซ้ำ และไม่แตะของเดิม');
  const c1 = TABLES.rfq.find(r => r.job_code === 'B2E2607/006');
  ok(c1 && c1.status === 'ปิดการขาย' && c1.sale === 'พลอย' && c1.outsource === 'คุณแจ็ค แอดกูร' &&
     c1.cost_quoted === 78000 && c1.sell_offered === 111000 && c1.sent_at === '2026-03-10',
     'ข้อมูลการ์ดมาจากที่เซลส์คีย์: ' + JSON.stringify({ st: c1 && c1.status, sale: c1 && c1.sale, cost: c1 && c1.cost_quoted }));
  const a2 = await RP.ensureAuto({ force: true });
  ok(a2.created === 0 && TABLES.rfq.length === 6, 'เปิดบอร์ดซ้ำ ไม่สร้างการ์ดซ้ำ');
  TABLES.total_sales.find(r => r._row === 10)['ยอดสั่งซื้อ (Outsource)'] = 80000;
  const a3 = await RP.ensureAuto({ force: true });
  ok(a3.updated === 1 && c1.cost_quoted === 80000 && c1.margin === 31000, 'เซลส์แก้ยอดในคีย์ยอดขาย → การ์ดอัตโนมัติตามทันที');
  TABLES.total_sales.find(r => r._row === 10)['ยอดสั่งซื้อ (Outsource)'] = 78000;
  await RP.ensureAuto({ force: true });

  const del = TABLES.rfq.find(r => r.job_code === 'B2P2607/020');
  const job = await RP.autoJobOf(del.rfq_id);
  const d = await RFQ.deleteRfq(ADMIN, del.rfq_id);
  if (d.ok && job) await RP.skipAdd(job, ADMIN);
  await RP.ensureAuto({ force: true });
  ok(!TABLES.rfq.some(r => r.job_code === 'B2P2607/020') && TABLES.rfq_auto_skip.length === 1,
     'ลบการ์ดอัตโนมัติแล้ว ไม่ถูกสร้างกลับมา');
  /* เซลส์แก้ผู้ผลิตเป็น ผลิตเอง-The101 → การ์ดอัตโนมัติถูกเอาออกเอง */
  TABLES.total_sales.find(r => r._row === 20)['ผู้ผลิต'] = 'ผลิตเอง-The101';
  const a4 = await RP.ensureAuto({ force: true });
  ok(a4.removed === 1 && !TABLES.rfq.some(r => r.job_code === 'B2P2607/023'), 'เซลส์เปลี่ยนเป็นผลิตเอง → การ์ดอัตโนมัติถูกเคลียร์ออก');
  ok(TABLES.rfq.some(r => r.rfq_id === 'R222'), '‼ การ์ดที่คนสร้างเอง ไม่ถูกลบแถว');

  head('② ซิงก์ PEAK — PO ที่ ref. กับเลข IV + ใบจ่ายมัดจำ DP + EXP');
  calls.length = 0;
  const s1 = (await RP.syncCard(ADMIN, c1.rfq_id)).peak;
  const po = (s1.pos || [])[0] || {};
  ok(po.no === 'PO-2026031500001' && s1.match === 'ref', 'เจอใบ PO ที่ ref. เลข IV-2026031000012 (' + s1.matchWhy + ')');
  ok(po.group === 'approved' && po.total === 83460 && po.supplier === 'คุณแจ็ค แอดกูร' && po.due === '2026-03-30',
     'เลขที่ PO · ยอดใน PO · Supplier ใน PEAK · สถานะอนุมัติแล้ว: ' + JSON.stringify({ g: po.group, t: po.total, s: po.supplier }));
  const docs = s1.docs || [];
  ok(docs.length === 2 && docs[0].code === 'DP-2026031600001' && docs[0].kind === 'DP' && docs[0].n === 1 &&
     docs[1].code === 'EXP-2026040200003' && docs[1].kind === 'EXP' && docs[1].n === 2,
     'งวด 1 = มัดจำ DP · งวด 2 = EXP (' + docs.map(x => x.n + ':' + x.code).join(' · ') + ')');
  ok(docs[0].payDate === '2026-03-16' && docs[1].payDate === '2026-04-03', 'วันที่ชำระเงินของแต่ละงวดมาจาก PEAK');
  ok(!docs.some(x => x.code === 'EXP-2026040500009'), '🔴 PEAK ส่งใบที่ไม่อ้างอิง PO มาปน (ค่าไฟ) — ไม่นับ');
  ok(s1.paid === 83460 && s1.paidPct === 100 && s1.closed === true && s1.remain === 0, 'จ่ายครบ 100% (DP + EXP = ยอด PO)');
  ok(s1.lead && s1.lead.iv === 'IV-2026031000012' && s1.lead.docs.indexOf('QO-2026021100028') >= 0,
     'ช่อง "QO-… / IV-…" ในช่องเดียว → แยกเป็นเลขทีละใบ แล้วค้น PO ด้วยเลข IV ได้');
  ok(calls.every(c => /^PO-list:|^Expenses:/.test(c)), '🔒 คุยกับ PEAK แค่ "อ่านรายการ PO" กับ "อ่านใบจ่าย" (' + calls.length + ' คำขอ)');
  ok(TABLES.rfq_peak.find(r => r.rfq_id === c1.rfq_id).snap.at, 'เก็บผลซิงก์ลง app.rfq_peak');
  ok(c1.cost_quoted === 83460 && c1.margin === 111000 - 83460 && s1.costFromPo && s1.costKeyed === 78000,
     '💰 ทุนของการ์ด = ราคาสั่งซื้อใน PO (฿83,460) แทนยอดที่เซลส์คีย์ (฿78,000) · กำไรคิดใหม่');

  head('③ PO ไม่มีเลขอ้างอิง — ชื่อผู้ขาย + ยอดตรง "ใบเดียว" เท่านั้น');
  const c2 = TABLES.rfq.find(r => r.job_code === 'B2P2607/006');
  const s2 = (await RP.syncCard(ADMIN, c2.rfq_id)).peak;
  ok((s2.pos || [])[0] && s2.pos[0].no === 'PO-2026031600002' && s2.match === 'guess' && /ตรวจอีกครั้ง/.test(s2.matchWhy),
     'LM มีเดีย ฿5,440 → PO-2026031600002 พร้อมป้าย "ตรวจอีกครั้ง"');
  TABLES.total_sales.push(S(18, 'B2P2607/030', { 'ผู้ผลิต': 'ร้านสองใบ', 'ยอดสั่งซื้อ (Outsource)': 1000 }));
  await RP.ensureAuto({ force: true });
  ok(c1.cost_quoted === 83460, '💰 เปิดบอร์ดซ้ำ (ตัวสร้างการ์ดอัปเดตจากคีย์ยอดขาย) ทุนยังเป็นยอด PO ไม่ถูกทับกลับ');
  const c3 = TABLES.rfq.find(r => r.job_code === 'B2P2607/030');
  const s3 = (await RP.syncCard(ADMIN, c3.rfq_id)).peak;
  ok(!(s3.pos || []).length && s3.warn.some(w => /2 ใบ/.test(w)), '🔴 เจอ 2 ใบที่ผู้ขาย+ยอดเท่ากัน → ไม่เลือกให้เอง บอกให้บัญชีคีย์');

  head('④ คีย์เลข PO เอง — แอดมิน · บัญชี · เจ้าของงาน เท่านั้น');
  let denied = false;
  try { await RP.savePo(OTHER, c3.rfq_id, 'PO-2026031700004'); } catch (e) { denied = /เฉพาะแอดมิน/.test(e.message); }
  ok(denied, 'เซลส์คนอื่นคีย์ไม่ได้');
  const s4 = (await RP.savePo(ACC, c3.rfq_id, 'po-2026031700004')).peak;
  ok(s4.pos.length === 1 && s4.pos[0].no === 'PO-2026031700004' && s4.match === 'manual', 'บัญชีคีย์เลข PO → ซิงก์ใบนั้นทันที');
  let bad = false;
  try { await RP.savePo(ACC, c3.rfq_id, 'PO 1; drop'); } catch (e) { bad = /รูปแบบ/.test(e.message); }
  ok(bad, 'เลข PO แปลก ๆ ไม่รับ');

  head('⑤ บอร์ด: เลข QO/IV · ภาพใบงานผลิต (Projects ↔ รหัสงาน) · ผลซิงก์');
  const B = await RFQ.getRfqBoard(ADMIN, {});
  RP.dropInHouse(B);
  await RP.decorate(B, ADMIN);
  ok(B.hiddenInHouse === 1 && !Object.values(B.groups).flat().some(x => x.id === 'R222'),
     '🔴 การ์ดเก่าที่ผู้ผลิต "ผลิตเอง-The101" ไม่ขึ้นบอร์ด Outsource (ซ่อน 1 ใบ)');
  const all = []; for (const s of B.statuses) all.push(...(B.groups[s] || []));
  const i1 = all.find(x => x.job === 'B2E2607/006'), i2 = all.find(x => x.job === 'B2P2607/006');
  ok(i1 && i1.img && /thumbnail\?id=WOIMGAAAA/.test(i1.img.url) && i1.img.from === 'ภาพใบงานผลิต',
     'ภาพใบงานผลิตจาก Projects ที่ Complete — รหัสงานอยู่ใน "ชื่อ Project" (B2E2607/006-1) ก็เจอ');
  ok(!/NOTDONE|WRONGJOB/.test(JSON.stringify(i1 && i1.img)), '🔴 โปรเจกต์ที่ยังไม่ Complete / รหัสคล้าย (B2E2607/0061) ไม่ถูกหยิบ');
  ok(i2 && i2.img && /thumbnail\?id=JCIMGBBBB/.test(i2.img.url), 'ไม่มีภาพใบงานหลัก → ใช้ภาพใบสั่งผลิตของ Job Card แทน');
  ok(i1.lead && i1.lead.urlKind === 'iv' && i1.peak && i1.peak.closed && i1.auto === true, 'การ์ดได้ลิงก์ IV · ผลซิงก์ · ป้ายอัตโนมัติ');
  ok(i1.cost === 83460 && i1.costFromPo === true && i1.costKeyed === 78000 && i1.margin === 27540, '💰 บอร์ด: ทุนตาม PO + ยอดที่คีย์ไว้เก็บให้ดู');
  ok(B.peakReady === true, 'ตาราง rfq_peak พร้อม');

  /* 📅 รอบ 134 — "ตั้งต้นให้ดึงข้อมูลย้อนหลัง 3 เดือนพอนะ ส่วนที่เหลือ ให้ user filter ช่วงเวลา เอาเอง" */
  {
    const RQ = require(path.join(ROOT, 'modules/sales/rfq'));
    ok(RQ.rfqDefaultFrom('2026-09-26') === '2026-06-26' && RQ.rfqDefaultFrom('2026-05-31') === '2026-02-28' &&
       RQ.rfqDefaultFrom('2026-02-15') === '2025-11-15', '📅 ค่าตั้งต้นย้อนหลัง 3 เดือน (ข้ามปี · สิ้นเดือนสั้น ถูก)');
    const Ball = await RFQ.getRfqBoard(ADMIN, {});
    const allC = Object.values(Ball.groups).flat();
    const ds = allC.map(x => x.sentAt).filter(Boolean).sort();
    const mid = ds.find(d => d > ds[0]);            /* วันถัดจากใบเก่าสุด = ต้องตัดอย่างน้อย 1 ใบ */
    const Bf = await RFQ.getRfqBoard(ADMIN, { from: mid });
    const got = Object.values(Bf.groups).flat();
    ok(ds.length >= 2 && got.length > 0 && got.length < allC.length && got.every(x => x.sentAt >= mid),
       '📅 กรองตั้งแต่ ' + mid + ' → เหลือ ' + got.length + '/' + allC.length + ' ใบ ทุกใบวันที่ ≥ ช่วงที่เลือก');
    const Bt = await RFQ.getRfqBoard(ADMIN, { to: ds[0] });
    ok(Object.values(Bt.groups).flat().every(x => x.sentAt && x.sentAt <= ds[0]), '📅 กรองถึงวันที่ (to) ถูก');
    ok(JSON.stringify(Bf.sales) === JSON.stringify(Ball.sales) && Bf.range.from === mid,
       '👤 รายชื่อเซลล์ครบเท่าเดิมแม้กรองช่วงเวลา · บอร์ดบอกช่วงที่ใช้กลับมา');
  }

  const keepPk = TABLES.rfq_peak; delete TABLES.rfq_peak;          /* จำลอง "ยังไม่ได้รัน sql/98" */
  const B2 = await RFQ.getRfqBoard(ADMIN, {});
  RP.dropInHouse(B2);
  await RP.decorate(B2, ADMIN);
  ok(B2.peakReady === false && /sql\/98/.test(B2.peakWarn) && all.length === Object.values(B2.groups).flat().length,
     'ยังไม่ได้รัน SQL → บอร์ดยังขึ้นครบ + บอกบนจอว่าต้องรัน sql/98');
  TABLES.rfq_peak = keepPk;

  /* ═══════════════ ⑥ หน้าเว็บจริง ═══════════════ */
  head('⑥ หน้าเว็บจริงใน Chromium — การ์ดแบบลูกหนี้ค้างชำระ');
  const PUB = path.join(ROOT, 'modules', 'sales', 'public');
  B.auto = await RP.ensureAuto();
  /* 🖼 รอบ 137 — รูปที่เซลล์แนบในการ์ด (ไฟล์แนบแบบ) 2 รูป + PDF 1 ไฟล์ */
  Object.values(B.groups).flat().find(x => x.job === 'B2E2607/006').files =
    [{ name: 'แบบ.pdf', type: 'pdf', id: 'PDFAAAA' }, { name: 'หน้าร้าน.jpg', type: 'image', id: 'SALEIMG1' }, { name: 'มุมข้าง.jpg', type: 'image', id: 'SALEIMG2' }];
  B.range = { from: '2026-06-26', to: '', defaulted: true };
  B.sales = (B.sales || []).concat(['แจน (ไม่มีการ์ดในช่วงนี้)']);
  const asked = [];
  const srv = await new Promise(res => {
    const s = http.createServer((req, rq) => {
      const f = path.join(PUB, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
      fs.readFile(f, (e, b) => { if (e) { rq.writeHead(404); rq.end('no'); return; }
        rq.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); rq.end(b); });
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
  const { chromium } = require('playwright');
  const br = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await br.newPage({ viewport: { width: +(process.env.RFQ_W || 1500), height: +(process.env.RFQ_H || 950) } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e.message || e)));
  p.on('dialog', dd => dd.accept());
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8DwnwEJMOAQBAC9Ag/xBWPGmwAAAABJRU5ErkJggg==', 'base64');
  let synced = null;
  await p.context().route('**/*', route => {
    const u = route.request().url();
    const J = o => route.fulfill({ contentType: 'application/json', body: JSON.stringify(o) });
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (/drive\.google\.com|cdn\.test/.test(u)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (u.includes('/api/rfq/options')) return J({ statuses: B.statuses, outsources: ['ผลิตเอง-The101', 'คุณแจ็ค แอดกูร', 'LM มีเดีย'] });
    if (u.includes('/api/rfq/board')) { asked.push(u); return J(B); }
    if (u.includes('/api/rfq/alert')) return J({ ok: true, n: 0 });
    if (u.includes('/api/rfq/peak/sync')) { synced = JSON.parse(route.request().postData() || '{}');
      return J({ ok: true, id: synced.id, peak: i2.peak }); }
    if (u.includes('/api/avatars')) return J({ ok: true, map: { 'พลอย': 'https://cdn.test/ploy.jpg' }, src: {} });
    if (u.includes('/api/me')) return J({ ok: true, user: { username: 'acc1', name: 'บัญชี', nickname: 'บัญชี', permission: 'Accounting' } });
    if (u.includes('/api/')) return J({ ok: true, rows: [], headers: [], data: {}, map: {}, sales: [], status: [] });
    return route.continue();
  });
  await p.goto('http://127.0.0.1:' + srv.address().port + '/index.html');
  await p.waitForTimeout(1300);
  await p.evaluate(() => openRfq());
  await p.waitForSelector('.rfq-card', { timeout: 10000 });
  await p.waitForTimeout(700);
  const view = await p.evaluate(() => {
    const c = document.querySelector('#rfqc-' + CSS.escape(RFQ_BOARD.groups['ปิดการขาย'].find(x => x.job === 'B2E2607/006').id));
    const im = c && c.querySelector('.rfq-img img');
    const av = c && c.querySelector('.rfq-own img.rfq-av');
    return { ar: c && c.classList.contains('ar-card'), text: c ? c.innerText : '',
      img: im ? { w: im.naturalWidth, src: im.getAttribute('src') } : null,
      av: av ? { w: av.naturalWidth, src: av.getAttribute('src') } : null,
      notes: (document.getElementById('rfqSummary') || {}).innerText || '' };
  });
  if (process.env.RFQ_SHOT) await p.screenshot({ path: process.env.RFQ_SHOT });   /* ภาพไว้ดูด้วยตา */
  ok(view.ar, 'การ์ดใช้หน้าตาเดียวกับการ์ดลูกหนี้ (ar-card)');
  ok(view.av && view.av.w > 0 && /ploy\.jpg/.test(view.av.src), '👤 รูปพนักงานขาย (พลอย) โหลดขึ้นจริงบนการ์ด');
  ok(view.img && view.img.w > 0 && /sz=w480/.test(view.img.src), '🖼 ภาพใบงานผลิตโหลดขึ้นจริง (ย่อ w480 ให้เร็ว)');
  ok(/IV-2026031000012/.test(view.text) && /QO-2026021100028/.test(view.text), 'เลข IV / QO บนการ์ด (แยกเป็นใบ ๆ)');
  ok(/รหัสงานขาย\s*B2E2607\/006/.test(view.text), '🔖 รหัสงานขายที่เซลส์คีย์ขึ้นบนการ์ด');
  ok(/ผู้ผลิต:\s*คุณแจ็ค แอดกูร/.test(view.text) && !/แอดกูร\s*·\s*มดงาน/.test(view.text), '🏭 บรรทัดผู้ผลิตแสดงแค่ช่อง "ผู้ผลิต" ไม่เอาชื่อบริษัทที่ขายมาต่อ');
  ok(/PO-2026031500001/.test(view.text) && /PO อนุมัติแล้ว/.test(view.text) && /คุณแจ็ค แอดกูร/.test(view.text) && /83,460/.test(view.text),
     'เลขที่ PO · สถานะอนุมัติ · Supplier · ยอดใน PO');
  ok(/งวด 1/.test(view.text) && /มัดจำ DP/.test(view.text) && /DP-2026031600001/.test(view.text) &&
     /งวด 2/.test(view.text) && /EXP-2026040200003/.test(view.text) && /16\/03\/69/.test(view.text),
     'งวดการชำระ: งวด 1 มัดจำ DP · งวด 2 EXP · วันที่จ่าย');
  ok(/จ่าย Outsource ครบ 100%/.test(view.text) && /จ่ายครบ/.test(view.text), 'ปิดยอดครบ 100% เห็นชัด');
  ok(/ทุน \(ตาม PO\)\s*฿83,460/.test(view.text), '💰 การ์ดแสดง "ทุน (ตาม PO) ฿83,460"');
  ok(/วันที่เปิด PO\s*15\/03\/69/.test(view.text), '🧾 วันที่เปิด PO (15/03/69)');
  ok(/งวด 1[\s\S]*DP-2026031600001[\s\S]*เปิดเอกสาร 16\/03\/69[\s\S]*จ่ายแล้ว ฿25,038 · 16\/03\/69/.test(view.text),
     '🧾 งวด 1 มัดจำ DP: วันที่เปิดเอกสาร + จ่ายจริง ฿25,038 วันที่ 16/03/69');
  ok(/งวด 2[\s\S]*EXP-2026040200003[\s\S]*เปิดเอกสาร 2\/04\/69[\s\S]*จ่ายแล้ว ฿58,422 · 3\/04\/69/.test(view.text),
     '🧾 งวด 2 EXP: วันที่เปิดเอกสาร 2/04/69 · จ่าย ฿58,422 วันที่ 3/04/69');
  ok(/การ์ดอัตโนมัติจากคีย์ยอดขาย/.test(view.notes) && /ผลิตเอง/.test(view.notes) && /ซ่อนงานผลิตเอง 1 ใบ/.test(view.notes), 'แถบบนบอกว่าการ์ดมาจากคีย์ยอดขายอัตโนมัติ');

  const id2 = await p.evaluate(() => RFQ_BOARD.groups['ปิดการขาย'].find(x => x.job === 'B2P2607/006').id);
  await p.evaluate(id => { document.querySelector('#rfqc-' + CSS.escape(id) + ' .ar-c-foot .ar-c-go').click(); }, id2);
  await p.waitForTimeout(600);
  const after = await p.evaluate(id => (document.querySelector('#rfqc-' + CSS.escape(id)) || {}).innerText || '', id2);
  ok(synced && synced.id === id2 && /PO-2026031600002/.test(after) && /ตรวจอีกครั้ง/.test(after),
     'กด 🔄 ซิงก์ PEAK บนการ์ด → วาดการ์ดใบนั้นใหม่ทันที');

  await p.evaluate(id => rfqOpenForm(id), id2);
  await p.waitForTimeout(500);
  const form = await p.evaluate(() => ({ blk: (document.getElementById('rfqPeakBlk') || {}).innerText || '',
    poDis: (document.getElementById('rfq_poNo') || {}).disabled }));
  ok(/เอกสารใน PEAK/.test(form.blk) && form.poDis === false, 'ฟอร์ม: กล่อง PEAK + ช่องคีย์เลข PO (บัญชีคีย์ได้)');
  /* 📅 รอบ 134 — ช่วงเวลา + เซลล์ */
  const rg = await p.evaluate(() => ({ from: document.getElementById('rfqFltFrom').value,
    on: [].map.call(document.querySelectorAll('.rfq-rq.on'), e => e.textContent),
    sales: [].map.call(document.querySelectorAll('#rfqFltSale option'), o => o.textContent),
    notes: document.getElementById('rfqSummary').innerText }));
  ok(asked.length && !/[?&]from=/.test(asked[0]), '📅 เปิดบอร์ดครั้งแรกไม่ส่ง from → เซิร์ฟเวอร์ใช้ย้อนหลัง 3 เดือน');
  ok(rg.from === '2026-06-26' && /ย้อนหลัง 3 เดือน/.test(rg.notes), '📅 ช่องวันที่เติมค่าตั้งต้นกลับมา + แถบบนบอกช่วงที่แสดง');
  ok(rg.sales.indexOf('แจน (ไม่มีการ์ดในช่วงนี้)') >= 0 && rg.sales.indexOf('พลอย') >= 0, '👤 เลือกชื่อเซลล์ได้ครบ แม้คนที่ไม่มีการ์ดในช่วงที่เลือก');
  const n0 = asked.length;
  await p.evaluate(() => rfqRangeQuick(document.querySelector('.rfq-rq[data-m="0"]')));
  await p.waitForTimeout(400);
  ok(asked.length > n0 && /[?&]from=(&|$)/.test(asked[asked.length - 1]), '📅 กด "ทั้งหมด" → ส่ง from ว่าง = ไม่จำกัดช่วง');
  await p.evaluate(() => { const f = document.getElementById('rfqFltFrom'); f.value = '2026-01-01'; f.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(400);
  ok(/from=2026-01-01/.test(asked[asked.length - 1]), '📅 เลือกวันที่เอง → ส่งช่วงนั้นไปเซิร์ฟเวอร์');
  await p.evaluate(() => { const s = document.getElementById('rfqFltSale'); s.value = 'พลอย'; s.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(400);
  ok(/sale=%E0%B8%9E/.test(asked[asked.length - 1]) && /from=2026-01-01/.test(asked[asked.length - 1]), '👤 เลือกเซลล์ + ช่วงเวลาไปพร้อมกัน');
  /* 🖼 รอบ 137 — "ให้แสดงรูป ที่เซลล์ upload ไว้ด้วยอีก 1 รูปนอกเหนือจาก ภาพใบงานผลิตนะ" */
  {
    const v = await p.evaluate(() => {
      const c = document.querySelector('#rfqc-' + CSS.escape(RFQ_BOARD.groups['ปิดการขาย'].find(x => x.job === 'B2E2607/006').id));
      const imgs = [...c.querySelectorAll('.rfq-imgs .rfq-img img')];
      const c2 = document.querySelector('#rfqc-' + CSS.escape(RFQ_BOARD.groups['ปิดการขาย'].find(x => x.job === 'B2P2607/006').id));
      return { n: imgs.length, loaded: imgs.every(i => i.naturalWidth > 0), srcs: imgs.map(i => i.getAttribute('src')),
               label: (c.querySelector('.rfq-img-sale span') || {}).textContent || '',
               other: c2 ? c2.querySelectorAll('.rfq-img-sale').length : -1 };
    });
    ok(v.n === 2 && v.loaded && /sz=w480/.test(v.srcs[0]) && /id=SALEIMG1&sz=w480/.test(v.srcs[1]),
       '🖼 การ์ดมี 2 รูป: ภาพใบงานผลิต + รูปแรกที่เซลล์แนบ (โหลดขึ้นจริง · ย่อ w480)');
    ok(/รูปที่เซลล์แนบ \+1/.test(v.label) && !v.srcs.some(x => /PDFAAAA/.test(x)), 'ป้าย "รูปที่เซลล์แนบ +1" (อีก 1 รูป) · ไม่เอา PDF มาเป็นรูป');
    ok(v.other === 0, 'การ์ดที่เซลล์ไม่ได้แนบรูป ⇒ ไม่มีช่องรูปเซลล์');
  }
  /* 📌 รอบ 136 — "ล้อคแถวบน … เวลาเลื่อนให้มันอยู่ที่เดิมนะ" */
  {
    const st = await p.evaluate(() => {
      const col = [...document.querySelectorAll('#rfqBoard .rfq-col')].find(c => c.querySelector('.rfq-card'));
      const card = col.querySelector('.rfq-card');
      for (let i = 0; i < 12; i++) col.appendChild(card.cloneNode(true));       /* การ์ดล้นคอลัมน์ */
      const head = col.querySelector('.rfq-col-head');
      const body = document.querySelector('#rfqOv .ov-body');
      const t0 = head.getBoundingClientRect().top;
      col.scrollTop = 900;
      const t1 = head.getBoundingClientRect().top;
      const heads = [...document.querySelectorAll('#rfqBoard .rfq-col-head')].map(h => Math.round(h.getBoundingClientRect().top));
      return { t0, t1, scrolled: col.scrollTop, pos: getComputedStyle(head).position,
               pageScroll: body.scrollHeight - body.clientHeight, sameRow: new Set(heads).size === 1,
               colBottom: col.getBoundingClientRect().bottom, vh: innerHeight };
    });
    ok(st.pos === 'sticky' && st.scrolled > 0 && Math.abs(st.t1 - st.t0) < 1,
       '📌 เลื่อนการ์ดในคอลัมน์ ' + st.scrolled + ' px ⇒ หัวคอลัมน์อยู่ที่เดิม (' + Math.round(st.t0) + ' → ' + Math.round(st.t1) + ')');
    ok(st.pageScroll <= 1 && st.sameRow && st.colBottom <= st.vh,
       '📌 จอกว้าง: บอร์ดสูงพอดีจอ ทั้งหน้าไม่เลื่อน · หัวทุกคอลัมน์อยู่แถวเดียวกัน');
    if (process.env.RFQ_SHOT3) await p.screenshot({ path: process.env.RFQ_SHOT3 });
  }
  ok(errs.length === 0, 'ไม่มี JS error ' + JSON.stringify(errs.slice(0, 3)));
  if (process.env.RFQ_SHOT2) await p.screenshot({ path: process.env.RFQ_SHOT2, clip: { x: 0, y: 0, width: 1500, height: 260 } });
  await br.close(); srv.close();

  head('⑥½ รอบ 223 — ใบ PO ผูกกับ "เลข QO ที่เสนอลูกค้า"');
  /* พี่เอ 3 ต.ค. 69: "ตอนนี้ใน peak จะเปิด PO สั่งซื้อไปยัง outsource โดย link กับ เลขที่ QO ที่เสนอลูกค้านะ" */
  {
    const mk = (row, job, docs, n) => {
      TABLES.total_sales.push(S(row, job, { 'ผู้ผลิต': 'โรงงาน ก', 'เลขที่ QO / IV': docs, 'ยอดสั่งซื้อ (Outsource)': 50000, 'ยอดขาย (บาท)': 80000 }));
      TABLES.rfq.push({ id: 300 + n, rfq_id: 'RQ' + n, job_code: job, company: 'บริษัท ' + job, outsource: 'โรงงาน ก',
        status: 'ปิดการขาย', cost_quoted: 50000, sell_offered: 80000, sale: 'พลอย', created_by: 'tester',
        created_at: '2026-09-01T03:00:00Z', sent_at: '2026-09-01', files: '[]', boq: '[]' });
    };
    mk(30, 'QA2610/001', 'QO-2026090100001', 1);
    mk(31, 'QA2610/002', 'QO-2026090100002', 2);
    mk(32, 'QA2610/003', 'QO-2026090100003 / IV-2026091000003', 3);
    mk(33, 'QA2610/004', 'QO-2026090100004', 4);
    mk(34, 'QA2610/005', 'QO-2026090100005', 5);
    PO_ROWS['มดงานการป้าย'].push(
      /* เลข QO อยู่ใน "กล่องซ้อน" ไม่ใช่ช่องชั้นบน */
      { id: 'po-q1', code: 'PO-2026090500011', status: 'อนุมัติแล้ว', netAmount: 53500, contactName: 'โรงงาน ก จำกัด',
        referenceDocument: { type: 'quotation', code: 'QO-2026090100001' } },
      /* บัญชีพิมพ์เลข QO ไม่มีขีด */
      { id: 'po-q2', code: 'PO-2026090500012', status: 'อนุมัติแล้ว', netAmount: 42800, contactName: 'โรงงาน ก จำกัด',
        reference: 'อ้างอิง QO 2026090100002' },
      /* เลขยาวกว่า 1 หลัก — คนละใบ ต้องไม่หยิบ */
      { id: 'po-q5', code: 'PO-2026090500015', status: 'อนุมัติแล้ว', netAmount: 7777, contactName: 'ร้านอื่น',
        reference: 'QO-20260901000051' });
    const get0 = peak.get;
    const asked = [];
    const FULL = { id: 'po-q3', code: 'PO-2026090600013', reference: 'QO-2026090100003', status: 'อนุมัติแล้ว', netAmount: 21400,
      contactName: 'โรงงาน ก จำกัด', issuedDate: '20260906',
      products: [{ code: 'P-000777', name: 'ป้ายกล่องไฟ', quantity: 1, price: 20000, netAmount: 21400, status: 'x' }] };
    peak.get = async (ep, params, biz) => {
      if (/^purchaseorders$/i.test(ep)) {
        calls.push(ep + ':' + JSON.stringify(params) + ':' + biz);
        asked.push({ ref: params.reference, biz, keys: Object.keys(params).sort().join() });
        if (params.reference === 'QO-2026090100003') return { PeakPurchaseOrders: { resCode: '200', purchaseOrders: [FULL] } };
        /* PEAK "ไม่กรองให้" — ส่งใบที่ไม่เกี่ยวกลับมา */
        if (params.reference === 'QO-2026090100004') return { PeakPurchaseOrders: { resCode: '200', purchaseOrders: PO_ROWS['มดงานการป้าย'].slice(0, 3) } };
        throw new Error('HTTP 404 ไม่พบข้อมูล');
      }
      return get0(ep, params, biz);
    };
    const poCalls = () => calls.filter(c => /^purchaseorders:/i.test(c));
    try {
      calls.length = 0; asked.length = 0;
      const q1 = (await RP.syncCard(ADMIN, 'RQ1')).peak;
      ok(q1.match === 'ref' && q1.pos[0].no === 'PO-2026090500011' && q1.pos[0].refTok === 'QO-2026090100001' && poCalls().length === 0,
         '‼ เลข QO อยู่ในกล่องซ้อนของหัวใบ PO ⇒ เจอ (เดิมดูแค่ช่องชั้นบน) · เจอในรายการแล้วไม่ถาม PEAK เพิ่ม — ' + q1.matchWhy);
      calls.length = 0;
      const q2 = (await RP.syncCard(ADMIN, 'RQ2')).peak;
      ok(q2.match === 'ref' && q2.pos[0].no === 'PO-2026090500012' && poCalls().length === 0,
         '‼ บัญชีพิมพ์ "QO 2026090100002" (ไม่มีขีด) ⇒ ยังจับคู่กับ QO-2026090100002 ได้');
      calls.length = 0; asked.length = 0;
      const q3 = (await RP.syncCard(ADMIN, 'RQ3')).peak;
      ok(q3.match === 'ref' && q3.pos.length === 1 && q3.pos[0].no === 'PO-2026090600013' && q3.pos[0].via === 'ask' && q3.pos[0].total === 21400,
         '‼ ใบ PO ไม่มีเลขอ้างอิงในรายการ ⇒ ถาม PEAK ด้วยเลขอ้างอิง แล้วเจอ ' + (q3.pos[0] || {}).no + ' (' + q3.matchWhy + ')');
      ok(asked.length === 1 && asked[0].ref === 'QO-2026090100003' && asked[0].biz === 'มดงานการป้าย' && asked[0].keys === 'limit,reference',
         '‼ ถามด้วยเลข QO ก่อน IV · เจอแล้วหยุด (ถาม ' + asked.length + ' ครั้ง) · GET PurchaseOrders?reference=…');
      ok(q3.pos[0].supplier === 'โรงงาน ก จำกัด' && !q3.pos.some(x => /^P-000/.test(x.no)),
         'ใบที่ PEAK ตอบมีรายการสินค้าซ้อนอยู่ ⇒ หยิบ "ใบ" ไม่หยิบบรรทัดสินค้า');
      ok(TABLES.rfq.find(r => r.rfq_id === 'RQ3').cost_quoted === 21400, 'ทุนบนการ์ด = ยอดใน PO ที่เจอ (กติการอบ 132 ยังทำงาน)');
      ok(q3.lead.qo === 'QO-2026090100003' && q3.tokens[0] === 'QO-2026090100003' && q3.tokens[1] === 'IV-2026091000003',
         'ลำดับเลขที่ใช้ค้น: QO → IV → รหัสงาน');
      calls.length = 0; asked.length = 0;
      const q4 = (await RP.syncCard(ADMIN, 'RQ4')).peak;
      ok(q4.match === 'none' && !q4.pos.length && q4.warn.some(w => /ไม่มีใบไหนมีเลขนี้/.test(w)) && q4.refAsk[0].got === 3 && q4.refAsk[0].kept === 0,
         '🔴 PEAK ไม่กรองให้ (ส่งใบอื่นมา 3 ใบ) ⇒ ไม่นับสักใบ และบอกบนการ์ด');
      ok(!q4.pos.some(x => x.no === 'PO-2026090500011'),
         '🔴 ใบ PO ที่อ้างอิงเลข QO ของงานอื่นอยู่แล้ว (ผู้ขาย+ยอดบังเอิญตรง) ไม่ถูกเดามาให้การ์ดนี้');
            ok(/QO-2026090100004/.test(q4.matchWhy) && /อ้างอิง/.test(q4.matchWhy) && !/ref\. เลข IV/.test(q4.matchWhy),
         'ข้อความตอนหาไม่เจอบอกเลข QO ที่ใช้ค้น + ให้บัญชีใส่เลข QO ในช่อง "อ้างอิง": ' + q4.matchWhy);
      calls.length = 0; asked.length = 0;
      const q5 = (await RP.syncCard(ADMIN, 'RQ5')).peak;
      ok(q5.match === 'none' && !q5.pos.length, '🔴 ใบ PO อ้างอิง QO-…000051 (ยาวกว่า 1 หลัก) ไม่ถูกหยิบให้ QO-…00005');
      ok(asked.length === 1 && !q5.warn.some(w => /ถาม PEAK/.test(w)), 'PEAK ตอบ "ไม่พบ" ⇒ ไม่ขึ้นคำเตือนรก ๆ (แค่บอกว่ายังไม่พบ)');
      calls.length = 0; asked.length = 0;
      const q6 = (await RP.savePo(ADMIN, 'RQ5', 'PO-2026090500015')).peak;
      ok(q6.match === 'manual' && q6.pos[0].no === 'PO-2026090500015' && asked.length === 0, 'คีย์เลข PO เอง ⇒ ยึดตามที่คีย์ ไม่ถาม PEAK ด้วยเลขอ้างอิง');
      const T = RP._t;
      ok(T.hasTok(['B2E2607/006-1'], 'B2E2607/006') && !T.hasTok(['B2E2607/0061'], 'B2E2607/006') &&
         T.hasTok(['QO20260901-00001'], 'QO-2026090100001') && !T.hasTok(['PO-2026090100001'], 'QO-2026090100001'),
         'ตัวเทียบเลข: งานย่อย -1 นับ · /0061 ไม่นับ · ขีดต่างกันนับ · คำนำหน้าต่างกันไม่นับ');
    } finally { peak.get = get0; }
  }

  head('⑦ ในโค้ด');
  const H = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const M = fs.readFileSync(path.join(ROOT, 'modules/sales/rfqpeak.js'), 'utf8');
  ok(!/method\s*:\s*['"](POST|PUT|PATCH|DELETE)/i.test(M) && !/fetch\(/.test(M), '🔒 rfqpeak.js ไม่มีคำสั่งเขียนไป PEAK');
  ok(/ออกแบบ Card ให้เหมือนลูกหนี้ค้างชำระ/.test(H) && /ไม่ต้องให้ เซลล์ เพิ่มเองแล้ว/.test(M), 'จดคำสั่งพี่เอไว้ในโค้ด');

  console.log('\n' + (fail ? '❌' : '✅') + ' ผ่าน ' + pass + ' · ไม่ผ่าน ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('💥 ' + (e && e.stack || e)); process.exit(1); });
