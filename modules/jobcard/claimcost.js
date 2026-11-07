'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/jobcard/claimcost.js — 💸 ต้นทุนการ์ดเคลม (รอบ 186)
 *
 *  ‼ พี่เอสั่ง 29 ก.ย. 69 (คำต่อคำ):
 *    "ในหน้า Job card สั่งผลิต จะมี job card ที่เป็นใบเคลม พี่ต้องการให้หลังจากที่สร้างใบเคลมผลิตแล้ว
 *     ให้ระบบทำการคำนวณต้นทุนหลังบ้าน แล้ว update มาที่หน้า card ทุกใบที่เป็นใบเคลมให้พี่ด้วย
 *     เพราะต้องประเมินค่าใช้จ่ายที่เกิดขึ้น"
 *  พี่เอเลือก:
 *    · "ประเมินก่อน + ต้นทุนจริงตามมา"
 *    · "เฉพาะคนที่สร้างใบเคลมได้" (CLAIM_CREATE_ALLOWED = suntorn · namna · admin) — ช่างไม่เห็นตัวเลขเงิน
 *
 *  ── ① ยอดประเมิน (ถ่ายภาพนิ่งตอนสร้างใบเคลม · เก็บที่ app.job_claim_cost) ─────────
 *    = ต้นทุน BOM ของ "งานเดิม" (Project เดียวกัน) — ใบเคลมคือทำงานเดิมซ้ำ
 *      ก. ต้นทุนที่บันทึกล่าสุดในแอป BOM (app.bom_cost ของ Project นั้น)
 *      ข. ไม่มี ⇒ คิดสดจากสูตร BOM ที่บันทึกไว้ของ Project (bom/api.calcCost · ไม่บันทึกอะไรลงแอป BOM)
 *      ค. ไม่มีสูตรเลย ⇒ บอกตรง ๆ ว่าประเมินไม่ได้ + ต้องทำอะไร (ไม่เดาเลข)
 *    ⇒ Project มีหลายงานย่อย + ใบเคลมผูกงานย่อย + ขนาดครบทุกงานย่อย ⇒ คิดตามสัดส่วนพื้นที่ป้าย
 *       ขนาดไม่ครบ ⇒ คิดเต็มทั้ง Project และบอกว่าอาจสูงเกินจริง
 *  ── ② ต้นทุนจริง (คิดสดทุกครั้งที่เปิดดู แล้วอัปเดตลงตารางเดียวกัน) ─────────────
 *    วัสดุเบิกจากคลัง   app.inv_stock_moves ของการ์ดเคลม (เบิก − คืน · ต้นทุนถัวเฉลี่ย ณ ตอนเบิก)
 *    ของซื้อเฉพาะงาน    app.job_purchases ของการ์ดเคลม ("ราคารวม" ที่จัดซื้อคีย์)
 *    ค่าแรง            job_stations ของการ์ดเคลม: เวลางาน (จ.–ส. 08–17 พักเที่ยง) × (คนกด + คนช่วย) × ค่าแรง/ชม.
 *                      ค่าแรง/ชม. = ค่าตั้งต้นของแอป BOM (400 บ./วัน ÷ 8 ชม.) · สถานีที่ยังไม่จบนับถึงตอนนี้
 *    งานติดตั้งเคลม     ค่ารถเครน/กระเช้า/ขนส่ง ในแผนติดตั้งของงานย่อยเคลม (ค่าจ้างช่างนอกของงานเคลมไม่ถูกจ่าย — ไม่นับ)
 *    ค่าขนส่ง          ค่าส่งในแผนจัดส่งของการ์ดเคลม (job_deliveries.ShippingCost)
 *  ── ③ 🔄 Sync BOM (ปุ่มบนการ์ดเคลม · พี่เอสั่ง 29 ก.ย. 69) ─────────────────────────
 *    "ถ้าไม่มี BOM ก็ให้สร้างใบเคลมได้ปกตินะ แล้วทำปุ่ม sync data BOM ในแต่ละ job card ได้ภายหลัง"
 *    ⇒ สร้างใบเคลมไม่เคยรอ/ไม่เคยล้มเพราะ BOM (ไม่มี BOM = เก็บว่า "ยังไม่มี BOM" แล้วไปต่อ)
 *    ⇒ syncClaimBom: อ่าน BOM ของงานเดิมใหม่ → ทับยอดประเมินของใบนั้น (จดยอดเดิม/คนกด/เวลาไว้ใน EstDetail)
 *  ── ④ ✍️ คีย์ค่าใช้จ่ายเอง (รอบ 193 · พี่เอสั่ง 30 ก.ย. 69) ────────────────────────────
 *    "ในระบบ Job card สั่งผลิต ในส่วนของใบเคลม ที่มีการ sync data กับ BOM เรื่องค่าใช้จ่าย
 *     เปิดให้คีย์ ตัวเลขค่าใช้จ่ายได้เองด้วยนะ ถ้าไม่มีการ sync BOM"
 *    + (พี่เอสั่งเพิ่มทันที) "หรือ sync data BOM มาแล้วก็ต้องเปิดให้ใส่ค่าใช้จ่ายเองได้ด้วย"
 *    ⇒ setClaimManualCost: ทุกใบเคลม (ไม่มี BOM · Sync BOM แล้ว · เคยคีย์เอง) คีย์ วัสดุ · ค่าแรง · โสหุ้ย · อื่น ๆ
 *       + หมายเหตุ ได้เอง → เก็บเป็นยอดประเมิน (EstSource = manual · จดคนคีย์/เวลา/ยอดเดิม — ยอด BOM เดิมอยู่ใน prev)
 *    ⇒ ใบที่มียอด BOM: หน้าเว็บตั้งต้นฟอร์มด้วยตัวเลข BOM ให้แก้ต่อ
 *    ⇒ 🗑 ล้างยอดที่คีย์ = กลับไปใช้ BOM (มี) / "ยังไม่มี BOM"
 *    ⇒ กด Sync BOM ทีหลังแล้วงานเดิมมี BOM ⇒ BOM ทับยอดที่คีย์ (จดยอดคีย์ไว้ใน prev) · ยังไม่มี BOM ⇒ คงยอดที่คีย์ไว้
 *    ⇒ ต้องรัน sql/105 แล้ว (ที่เก็บยอด) — ยังไม่รัน ⇒ บอกตรง ๆ ไม่ทำเป็นบันทึกได้
 *  ── ⑤ 👤 ผู้ทำเสียหาย + 📊 ค่าใช้จ่ายเคลมในรายงานประจำวัน (รอบ 194 · พี่เอสั่ง 30 ก.ย. 69) ─────────
 *    "เพิ่ม ค่าใช้จ่ายการเคลม ในรายงานประจำวันให้ด้วยนะ ว่าในแต่ละวัน มีค่าใช้จ่ายในการเคลมเท่าไหร่
 *     ในแต่ละคนที่ทำเสียหาย และในภาพรวมที่เกิดขึ้นทั้งหมดให้ด้วย"
 *    พี่เอเลือก: เพิ่มช่องเลือกเอง (ระบบเสนอชื่อจากงานเดิม) · รายงานไม่ต้องแยกรายคน · ใช้ต้นทุนจริง ไม่มีใช้ประเมิน
 *    ⇒ getClaimCulpritOptions / setClaimCulprits = ช่อง "ผู้ทำเสียหาย" ในกล่อง 💸 (เก็บ app.job_claim_cost.Culprits · sql/106)
 *    ⇒ getDailyClaimCosts = ค่าใช้จ่ายเคลมต่อวัน + รวมช่วง + สะสมเดือน (นับเข้าวันที่สร้างใบเคลม)
 *       ‼ getDailyReportStats ของเดิม (reports.js) ไม่แตะ — หน้าจอขอก้อนนี้แยกแล้วต่อท้ายรายงาน
 *  ── ⑥ 🔁 Sync BOM อัตโนมัติหลังบ้าน (รอบ 208 · พี่เอสั่ง 1 ต.ค. 69) ─────────────────────────
 *    "เวลามี่มีการเคลม พี่ต้องการให้ sync ต้นทุนมาแบบ auto หลังบ้านได้ หากมีการทำ BOM ไว้แล้ว
 *     หรือให้เปิดคำนวณ BOM ที่ link Job card นี้ไปได้เลย"
 *    ⇒ autoSyncProject: แอป BOM บันทึกสูตร/ต้นทุนของ Project ไหน ⇒ ใบเคลมทุกใบของ Project นั้นได้ยอดประเมินใหม่ทันที
 *       (เหมือนมีคนกด 🔄 Sync BOM ให้ · ‼ ยอดที่คนคีย์เอง (manual) ไม่ทับเด็ดขาด · ใบยกเลิกไม่แตะ)
 *    ⇒ getClaimCosts: ใบที่ยังขึ้น "ยังไม่มี BOM" ลองอ่าน BOM ใหม่ให้เองทุก 10 นาที (ครั้งละไม่เกิน 3 ใบ)
 *       เจอ BOM แล้ว = บันทึกเป็นยอดประเมินทันที (กันกรณี BOM ทำไว้ก่อนแล้ว/ทำจากทางอื่น)
 *    ⇒ หน้าเว็บมีปุ่ม "🧮 ทำ BOM งานนี้" เปิดแอป BOM ที่งานเดิมของใบเคลมให้เลย (?project=&job=)
 *  ‼ อ่านอย่างเดียวทุกตาราง ยกเว้น app.job_claim_cost (ของรอบนี้)
 *  ‼ ยังไม่รัน sql/105 ⇒ ยังเห็นต้นทุน (คิดสด) แค่ไม่ถูกถ่ายภาพนิ่ง
 * ═══════════════════════════════════════════════════════════════════ */

const L = require('./lib');
const E = require('./edit');

const clean = s => String(s == null ? '' : s).trim();
const num = v => { const n = Number(String(v == null ? '' : v).replace(/[^\d.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const r2 = v => Math.round(v * 100) / 100;
/* ตัวเลขเงินแบบไทย (1,234.5) — ใช้ Intl.NumberFormat ตรง ๆ (ยาม tz-apps ห้าม toLocaleString ไม่ระบุโซน แม้เป็นตัวเลข) */
const fmtN = v => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 }).format(Number(v) || 0);
const TBL = 'job_claim_cost';
const MAX_IDS = 300;
const EST_PER_CALL = 6;           /* ประเมินใหม่ได้ครั้งละกี่ใบ — แต่ละใบอาจต้องคิด BOM สด ⇒ กันจอค้าง */
const MEMO_MS = 45 * 1000;
const noTable = e => /PGRST205|Could not find the table|42P01/i.test(String((e && e.message) || e));
const missingCol = e => /42703|PGRST204|does not exist/i.test(String((e && e.message) || e));

/** การ์ดนี้เป็นใบเคลมไหม — กติกาเดียวกับ reports.js claimOf / หน้าเว็บ _claimInfo */
function isClaim(j) {
  if (!j) return false;
  if (clean(j.ClaimType)) return true;
  return String(j.JobType || '').replace(/\s+/g, '').indexOf('เคลม') >= 0;
}
function kindOf(j) {
  const t = clean(j.ClaimType);
  if (t) return t;
  const jt = String(j.JobType || '');
  return /ติดตั้ง/.test(jt) ? 'ติดตั้ง' : (/ผลิต/.test(jt) ? 'ผลิต' : (/กราฟ|ขาย/.test(jt) ? 'กราฟิค-ขาย' : ''));
}
/** ใครเห็นตัวเลข — ชุดเดียวกับคนที่สร้างใบเคลมได้ (edit.js CLAIM_CREATE_ALLOWED) */
function canSee(user) { return E.CLAIM_CREATE_ALLOWED.indexOf(L._userKey(user)) >= 0; }

async function _byIds(db, table, col, ids, params) {
  const uniq = Array.from(new Set((ids || []).map(clean).filter(Boolean)));
  const out = [];
  for (let i = 0; i < uniq.length; i += 80) {
    const part = uniq.slice(i, i + 80).map(x => '"' + x.replace(/"/g, '') + '"').join(',');
    const rows = await db.selectAll(table, Object.assign({ order: '_id.asc' }, params || {}, { [col]: 'in.(' + part + ')' })) || [];
    for (const r of rows) out.push(r);
  }
  return out;
}
async function _safe(fn, fallback) { try { return await fn(); } catch (e) { return fallback; } }

/* ═══════════════════════════════ ① ยอดประเมิน ═══════════════════════════════ */
async function estimateFor(db, job) {
  const pid = clean(job.ProjectID);
  if (!pid) return { ok: false, noBom: true, why: 'การ์ดเคลมนี้ไม่มี Project ID — ไม่มี BOM ของงานเดิมให้อ้างอิง' };

  let base = null;
  /* ก. ต้นทุนที่บันทึกล่าสุดในแอป BOM */
  const saved = await _safe(() => db.select('bom_cost', {
    select: 'cost_id,at,mode,qty,material_cost,labor_cost,overhead_cost,other_cost,total_cost,missing_price,detail',
    project_id: 'eq.' + pid, order: 'at.desc', limit: 1,
  }), []);
  const s0 = (saved || [])[0];
  if (s0 && s0.total_cost != null && num(s0.total_cost) > 0) {
    const dmg = s0.detail && s0.detail.damageCost != null ? num(s0.detail.damageCost) : 0;
    base = { source: 'bom_cost', sourceText: 'ต้นทุนที่บันทึกในแอป BOM ของงานเดิม',
             total: num(s0.total_cost), material: num(s0.material_cost), labor: num(s0.labor_cost),
             overhead: num(s0.overhead_cost), other: num(s0.other_cost) + dmg,
             missing: Number(s0.missing_price) || 0, costAt: s0.at || '', costID: clean(s0.cost_id), qty: num(s0.qty) || 1 };
  }
  /* ข. คิดสดจากสูตร BOM ของ Project (ไม่บันทึกอะไรลงแอป BOM · dryRun) */
  if (!base) {
    const r = await _safe(() => require('../bom/api').calcCost({ projectID: pid, dryRun: true }, { role: 'ADMIN', username: 'claimcost' }), null);
    if (r && !r.error && num(r.totalCost) > 0) {
      base = { source: 'bom_live', sourceText: 'คิดสดจากสูตร BOM ของงานเดิม (ยังไม่เคยบันทึกต้นทุน)',
               total: num(r.totalCost), material: num(r.materialCost), labor: num(r.laborCost),
               overhead: num(r.overheadCost), other: num(r.otherCost) + num(r.damageCost),
               missing: Number(r.missingPrice) || 0, costAt: '', costID: '', qty: num(r.qty) || 1 };
    }
  }
  if (!base) return { ok: false, noBom: true, why: 'งานเดิม (Project ' + pid + ') ยังไม่มี BOM — กด "🧮 ทำ BOM งานนี้" ไปบันทึกสูตร/ต้นทุนในแอป BOM แล้วการ์ดนี้จะอัปเดตยอดประเมินให้เอง (หรือกด "🔄 Sync BOM")' };

  /* สัดส่วนงานย่อย */
  let share = 1, shareNote = 'ทั้ง Project';
  const rid = clean(job.RequirementID);
  const reqs = (await _safe(() => db.selectAll('requirements', {
    select: 'requirement_id,size_w,size_h,quantity,claim_seq,job_type', project_id: 'eq.' + pid, order: '_id.asc',
  }), [])).filter(r => !(r.claim_seq != null && String(r.claim_seq) !== '') && !/เคลม/.test(String(r.job_type || '')));   /* แถวเคลมไม่ใช่ป้ายจริงของงาน (🎨 v1.29.1 เคลมกราฟิค-ขาย ไม่มี claim_seq ⇒ ดูจาก job_type) */
  if (rid && reqs.length > 1) {
    const area = r => num(r.size_w) * num(r.size_h) * (num(r.quantity) || 1);
    const all = reqs.every(r => area(r) > 0);
    const mine = reqs.find(r => clean(r.requirement_id) === rid);
    if (all && mine) {
      const sum = reqs.reduce((a, r) => a + area(r), 0);
      share = sum > 0 ? area(mine) / sum : 1;
      shareNote = 'งานย่อย ' + rid + ' = ' + Math.round(share * 100) + '% ของพื้นที่ป้ายทั้ง Project (' + reqs.length + ' งานย่อย)';
    } else {
      shareNote = 'Project มี ' + reqs.length + ' งานย่อย แต่ขนาดไม่ครบ — ประเมินเต็มทั้ง Project (อาจสูงเกินจริง)';
    }
  }
  const k = x => r2(x * share);
  return {
    ok: true, projectID: pid, source: base.source, sourceText: base.sourceText,
    total: k(base.total), material: k(base.material), labor: k(base.labor), overhead: k(base.overhead), other: k(base.other),
    missing: base.missing, share: r2(share), shareNote, costAt: base.costAt, costID: base.costID,
    note: 'ประเมินเท่ากับทำงานเดิมซ้ำ' + (share < 1 ? 'ตามสัดส่วน' : '') + (base.missing ? ' · ⚠ สูตรเดิมมี ' + base.missing + ' รายการที่ยังไม่มีราคา' : ''),
  };
}

/* ═══════════════════════════════ ② ต้นทุนจริง ═══════════════════════════════ */
function helpersOf(s) {
  const main = clean(s.ProducingBy || s.CompletedBy || s.AcceptedBy).toLowerCase();
  return new Set(clean(s.HelperUsers).split(',').map(x => clean(x).toLowerCase()).filter(x => x && x !== main)).size;
}
async function actualMany(db, jobs, now) {
  now = now || Date.now();
  const LB = require('../bom/labor');
  const wagePerH = LB.DEFAULTS.wagePerDay / LB.DEFAULTS.hoursPerDay;
  const ids = jobs.map(j => clean(j.JobID));
  const keyOf = {};                                  /* JobID / เลขการ์ด → JobID */
  for (const j of jobs) { keyOf[clean(j.JobID)] = clean(j.JobID); if (clean(j.JobOrderNo)) keyOf[clean(j.JobOrderNo)] = clean(j.JobID); }
  const out = {};
  for (const id of ids) out[id] = { material: 0, purchase: 0, labor: 0, install: 0, delivery: 0, laborOngoing: false,
                                    lines: { material: [], purchase: [], labor: [], install: [], delivery: [] } };
  const warn = [];

  /* วัสดุเบิกจากคลัง */
  const moves = await _safe(() => _byIds(db, 'inv_stock_moves', 'JobID', Object.keys(keyOf),
    { select: '"JobID","MoveType","ItemName","QtyIn","QtyOut","UnitCost","TotalCost","Timestamp"' }), null);
  if (moves === null) warn.push('อ่านการเบิกของจากคลังไม่ได้');
  const matAgg = {};
  for (const m of moves || []) {
    const id = keyOf[clean(m.JobID)]; if (!id) continue;
    const t = clean(m.MoveType).toLowerCase();
    const sign = t === 'issue' ? 1 : (t === 'return' ? -1 : 0);
    if (!sign) continue;
    const q = sign > 0 ? num(m.QtyOut) : num(m.QtyIn);
    const amt = m.TotalCost != null && String(m.TotalCost) !== '' ? num(m.TotalCost) : q * num(m.UnitCost);
    out[id].material += sign * amt;
    const k = id + '|' + clean(m.ItemName);
    matAgg[k] = matAgg[k] || { id, name: clean(m.ItemName) || '(ไม่มีชื่อ)', qty: 0, amount: 0 };
    matAgg[k].qty += sign * q; matAgg[k].amount += sign * amt;
  }
  for (const k of Object.keys(matAgg)) { const a = matAgg[k]; out[a.id].lines.material.push({ name: a.name, qty: r2(a.qty), amount: r2(a.amount) }); }

  /* ของซื้อเฉพาะงาน */
  const pur = await _safe(() => _byIds(db, 'job_purchases', 'JobID', ids,
    { select: '"JobID","ItemName","Quantity","Unit","PurchasePrice","Status","SupplierName"' }), null);
  if (pur === null) warn.push('อ่านรายการสั่งซื้อไม่ได้');
  for (const p of pur || []) {
    const id = clean(p.JobID); if (!out[id]) continue;
    if (/cancel|ยกเลิก/i.test(clean(p.Status))) continue;
    const price = p.PurchasePrice == null || String(p.PurchasePrice) === '' ? null : num(p.PurchasePrice);
    if (price) out[id].purchase += price;
    out[id].lines.purchase.push({ name: clean(p.ItemName), qty: num(p.Quantity), unit: clean(p.Unit), amount: price,
                                  supplier: clean(p.SupplierName), noPrice: price == null });
  }

  /* ค่าแรงจากเวลาที่สถานี */
  const st = await _safe(() => _byIds(db, 'job_stations', 'JobID', ids,
    { select: '"JobID","StationID","StationName","IsActive","CurrentStep","AcceptedAt","AcceptedBy","ProducingAt","ProducingBy","CompletedAt","CompletedBy","HelperUsers"' }), null);
  if (st === null) warn.push('อ่านเวลาที่สถานีไม่ได้');
  for (const s of st || []) {
    const id = clean(s.JobID); if (!out[id]) continue;
    if (s.IsActive === false || String(s.IsActive) === 'false') continue;
    const start = s.ProducingAt || s.AcceptedAt;
    if (!start || Number(s.CurrentStep || 0) < 2) continue;
    const done = !!s.CompletedAt && Number(s.CurrentStep || 0) >= 4;
    const end = done ? s.CompletedAt : new Date(now).toISOString();
    const h = LB.workHours(start, end);
    const ppl = 1 + helpersOf(s);
    const amt = h * ppl * wagePerH;
    out[id].labor += amt;
    if (!done) out[id].laborOngoing = true;
    out[id].lines.labor.push({ station: clean(s.StationName) || clean(s.StationID), hours: r2(h), people: ppl, amount: r2(amt), ongoing: !done });
  }

  /* งานติดตั้งเคลม: ค่ารถในแผนติดตั้งของงานย่อยเคลม */
  const reqs = await _safe(() => _byIds(db, 'requirements', 'claim_job_id', ids, { select: 'requirement_id,claim_job_id' }), []);
  const ridTo = {};
  for (const r of reqs) if (clean(r.requirement_id)) ridTo[clean(r.requirement_id)] = clean(r.claim_job_id);
  const rids = Object.keys(ridTo);
  if (rids.length) {
    const VEH = ['ค่ารถเครน', 'ค่ากระเช้า', 'ค่ารถขนส่ง'];
    let plan = null;
    try {
      plan = await _byIds(db, 'installation_plan', 'SourceProjectID', rids,
        { select: '"ID","SourceProjectID","ปิดงานเมื่อ",' + VEH.map(v => '"' + v + '"').join(','), order: '_row.asc' });
    } catch (e) {
      if (!missingCol(e)) warn.push('อ่านแผนติดตั้งไม่ได้');
      plan = [];                                          /* ยังไม่รัน sql/103 (ค่ารถ) หรือ sql/78 = ไม่มีค่ารถให้คิด */
    }
    for (const p of plan) {
      if (clean(p['ปิดงานเมื่อ'])) continue;             /* ปิด/ยกเลิกคิวแล้ว ไม่ได้ไปจริง */
      const id = ridTo[clean(p.SourceProjectID)]; if (!out[id]) continue;
      VEH.forEach(v => {
        const a = num(p[v]); if (!a) return;
        out[id].install += a; out[id].lines.install.push({ name: v + ' (แผนติดตั้ง ' + clean(p.ID) + ')', amount: a });
      });
    }
  }

  /* ค่าขนส่งในแผนจัดส่ง */
  const dl = await _safe(() => _byIds(db, 'job_deliveries', 'JobID', ids, { select: '"JobID","ShippingCost"' }), []);
  for (const d of dl) {
    const id = clean(d.JobID); if (!out[id]) continue;
    const a = num(d.ShippingCost); if (!a) continue;
    out[id].delivery += a; out[id].lines.delivery.push({ name: 'ค่าขนส่ง (แผนจัดส่ง)', amount: a });
  }

  for (const id of ids) {
    const o = out[id];
    ['material', 'purchase', 'labor', 'install', 'delivery'].forEach(k => { o[k] = r2(o[k]); });
    o.total = r2(o.material + o.purchase + o.labor + o.install + o.delivery);
    o.noPriceCount = o.lines.purchase.filter(x => x.noPrice).length;
    o.lines.material.sort((a, b) => b.amount - a.amount);
    o.at = new Date(now).toISOString();
  }
  return { byJob: out, warn, wagePerH };
}

/* ═══════════════════════════════ ③ ที่เก็บ ═══════════════════════════════ */
async function _readStore(db, ids) {
  try { return { ready: true, rows: await _byIds(db, TBL, 'JobID', ids, {}) }; }
  catch (e) { return { ready: false, why: noTable(e) ? 'ยังไม่ได้รัน sql/105-jobcard-claim-cost.sql' : String((e && e.message) || e), rows: [] }; }
}
async function _saveEst(db, job, est) {
  const row = { JobID: clean(job.JobID), ProjectID: clean(job.ProjectID),
    EstTotal: est.ok ? est.total : null, EstSource: est.ok ? est.source : 'none',
    EstDetail: est, EstAt: new Date().toISOString(), UpdatedAt: new Date().toISOString() };
  const cur = await db.select(TBL, { select: '_id', JobID: 'eq.' + row.JobID, limit: 1 }) || [];
  if (cur.length) await db.update(TBL, { _id: 'eq.' + cur[0]._id }, row);
  else await db.insert(TBL, [row]);
}
async function _saveAct(db, jobID, act) {
  const patch = { ActTotal: act.total, ActDetail: act, ActAt: act.at, UpdatedAt: new Date().toISOString() };
  const cur = await db.select(TBL, { select: '_id', JobID: 'eq.' + jobID, limit: 1 }) || [];
  if (cur.length) await db.update(TBL, { _id: 'eq.' + cur[0]._id }, patch);
  else await db.insert(TBL, [Object.assign({ JobID: jobID, EstDetail: {} }, patch)]);
}

/**
 * ⓪ เรียกตอนสร้างใบเคลม (edit.js createClaimCard) — ถ่ายภาพนิ่งยอดประเมิน
 *  ‼ พังห้ามล้มการสร้างใบเคลม (คนเรียกห่อ try ไว้แล้ว · ที่นี่ก็ไม่โยน)
 */
async function snapshotEstimate(db, jobID) {
  try {
    const job = (await db.select('production_jobs', {
      select: '"JobID","JobOrderNo","ProjectID","RequirementID","JobType","ClaimType"', JobID: 'eq.' + clean(jobID), limit: 1 }) || [])[0];
    if (!job || !isClaim(job)) return null;
    const est = await estimateFor(db, job);
    try { await _saveEst(db, job, est); } catch (e) { /* ยังไม่รัน sql/105 */ }
    _memo.delete(clean(jobID));
    return est;
  } catch (e) { return null; }
}

/* ═══════════════════════════════ ④ RPC ═══════════════════════════════ */
const JOB_COLS = '"JobID","JobOrderNo","ProjectID","RequirementID","JobType","ClaimType","ClaimFromJobID","OverallStatus"';
const _memo = new Map();   /* jobID → { at, v } */
/* 🔁 รอบ 208 — ลองอ่าน BOM ใหม่ให้ใบที่ "ยังไม่มี BOM" เอง: ใบละไม่ถี่กว่า 10 นาที · ครั้งละไม่เกิน 3 ใบ (กันจอค้าง) */
const AUTO_RETRY_MS = 10 * 60 * 1000;
const AUTO_PER_CALL = 3;
const AUTO_BY = 'ระบบ (อัตโนมัติ)';
const _autoTry = new Map();   /* jobID → เวลาที่ลองล่าสุด */
function _prevOf(prevEst, prevRow) {
  return prevEst ? { ok: !!prevEst.ok, total: prevEst.ok ? prevEst.total : null, source: prevEst.source || '', at: (prevRow && prevRow.EstAt) || '' } : null;
}

/**
 * 💸 getClaimCosts — SRUN().getClaimCosts({ jobIDs })
 *  ‼ ตัวตนมาจาก session (rpc.js stampIdentity ทับ username) — คนนอกรายชื่อได้คำตอบว่าไม่มีสิทธิ์ ไม่มีตัวเลข
 */
async function getClaimCosts(db, payload) {
  payload = payload || {};
  if (!canSee(payload.username))
    return { success: false, denied: true, error: '🔒 ต้นทุนใบเคลมดูได้เฉพาะ ' + E.CLAIM_CREATE_ALLOWED.join(' / ') };
  const want = Array.from(new Set((Array.isArray(payload.jobIDs) ? payload.jobIDs : []).map(clean).filter(Boolean))).slice(0, MAX_IDS);
  /* 🧮 รอบ 208 — ปุ่ม "ทำ BOM งานนี้" ขึ้นเฉพาะคนที่เปิดแอป BOM ได้ (admin · namna · พี่เอสั่ง 1 ต.ค. 69)
   *   ‼ ไม่ผูกกับตัวเลขในกล่อง (แคชร่วมทุกคน) — ส่งแยกเป็นค่าของคำขอนี้ */
  const canBom = require('../../core/app-access').isToolAdmin({ username: payload.username });
  if (!want.length) return { success: true, costs: {}, storeReady: true, canBom };

  const now = Date.now();
  const fresh = !!payload.fresh;
  const costs = {};
  const need = [];
  for (const id of want) {
    const m = _memo.get(id);
    if (!fresh && m && now - m.at < MEMO_MS) costs[id] = m.v; else need.push(id);
  }
  if (!need.length) return { success: true, costs, storeReady: true, cached: true, canBom };

  const jobs = (await _byIds(db, 'production_jobs', 'JobID', need, { select: JOB_COLS })).filter(isClaim);
  const store = await _readStore(db, jobs.map(j => j.JobID));
  const byId = {};
  for (const r of store.rows) byId[clean(r.JobID)] = r;

  /* ① ยอดประเมิน: มีภาพนิ่งแล้วใช้ภาพนิ่ง · ยังไม่มี (ใบเก่า/ใบที่มาจาก Projects) ⇒ ประเมินให้ครั้งละไม่เกิน EST_PER_CALL ใบ */
  let budget = EST_PER_CALL;
  let autoBudget = AUTO_PER_CALL;
  const estOf = {};
  const estAtNew = {};                                /* ประเมินรอบนี้ = เวลาตอนนี้ (แถวเก่ายังไม่มี EstAt) */
  for (const j of jobs) {
    const r = byId[clean(j.JobID)];
    if (r && r.EstAt && r.EstDetail && Object.keys(r.EstDetail).length) {
      estOf[j.JobID] = r.EstDetail;
      /* 🔁 รอบ 208 — ยังไม่มี BOM (ไม่ใช่ยอดที่คีย์เอง) ⇒ ลองอ่าน BOM ของงานเดิมใหม่ให้เอง (ใบละไม่ถี่กว่า 10 นาที)
       *   เจอแล้ว = บันทึกเป็นยอดประเมินทันที · ยังไม่เจอ = คงของเดิมไว้ ไม่เขียนอะไร */
      const se = r.EstDetail;
      const id0 = clean(j.JobID);
      if (!se.ok && se.source !== 'manual' && autoBudget > 0 && now - (_autoTry.get(id0) || 0) >= AUTO_RETRY_MS) {
        autoBudget--;
        _autoTry.set(id0, now);
        const est = await _safe(() => estimateFor(db, j), null);
        if (est && est.ok) {
          est.syncedBy = AUTO_BY; est.syncedAt = new Date(now).toISOString(); est.auto = true;
          est.autoWhy = 'อ่าน BOM ของงานเดิมใหม่ตอนเปิดดู — เจอ BOM แล้ว';
          est.prev = _prevOf(se, r);
          estOf[j.JobID] = est;
          estAtNew[j.JobID] = est.syncedAt;
          if (store.ready) { try { await _saveEst(db, j, est); } catch (e) { /* ไม่เป็นไร */ } }
        }
      }
      continue;
    }
    if (budget <= 0) { estOf[j.JobID] = { ok: false, pending: true, why: 'กำลังประเมิน — เปิดใหม่อีกครั้งในไม่กี่วินาที' }; continue; }
    budget--;
    const est = await estimateFor(db, j);
    estOf[j.JobID] = est;
    estAtNew[j.JobID] = new Date(now).toISOString();
    if (store.ready) { try { await _saveEst(db, j, est); } catch (e) { /* ไม่เป็นไร */ } }
  }

  /* ② ต้นทุนจริง (คิดสด) → อัปเดตลงที่เก็บเมื่อเปลี่ยน */
  const act = await actualMany(db, jobs, now);
  for (const j of jobs) {
    const id = clean(j.JobID), a = act.byJob[id];
    const prev = byId[id];
    if (store.ready && (!prev || num(prev.ActTotal) !== a.total || prev.ActTotal == null)) {
      try { await _saveAct(db, id, a); } catch (e) { /* ไม่เป็นไร */ }
    }
    const est = estOf[id] || { ok: false, why: 'ประเมินไม่ได้' };
    const v = {
      jobID: id, kind: kindOf(j), from: clean(j.ClaimFromJobID), status: clean(j.OverallStatus),
      /* 🧮 รอบ 208 — ปุ่ม "ทำ BOM งานนี้" ต้องรู้ Project ของงานเดิม + เลข Job Card ใบนี้ */
      projectID: clean(j.ProjectID), orderNo: clean(j.JobOrderNo),
      est, act: a, pct: est.ok && est.total > 0 ? Math.round(a.total * 100 / est.total) : null,
      estAt: estAtNew[id] || (prev && prev.EstAt ? prev.EstAt : ''), wagePerH: act.wagePerH,
      /* 👤 ผู้ทำเสียหาย (รอบ 194 · sql/106) — ยังไม่รัน SQL = ไม่มีช่องนี้ในแถว ⇒ culpritReady:false */
      culprits: _culpritNames(prev), culpritBy: prev ? clean(prev.CulpritBy) : '', culpritAt: prev && prev.CulpritAt ? prev.CulpritAt : '',
      culpritReady: store.ready && (!prev || Object.prototype.hasOwnProperty.call(prev, 'Culprits')),
    };
    costs[id] = v;
    if (!est.pending) _memo.set(id, { at: now, v });
  }
  return { success: true, costs, storeReady: store.ready, storeWhy: store.why || '', warn: act.warn, canBom };
}

/**
 * 🔄 syncClaimBom — SRUN().syncClaimBom({ jobID })  (ปุ่ม "🔄 Sync BOM" บนการ์ดเคลม)
 *  พี่เอ 29 ก.ย. 69: "ถ้าไม่มี BOM ก็ให้สร้างใบเคลมได้ปกตินะ แล้วทำปุ่ม sync data BOM ในแต่ละ job card ได้ภายหลัง"
 *  · อ่าน BOM ของงานเดิมใหม่ (bom_cost ล่าสุด → ไม่มีคิดสดจากสูตร) แล้วทับยอดประเมินของใบเคลมนี้
 *  · จดยอดเดิม + คนกด + เวลา ไว้ใน EstDetail (ย้อนดูได้ว่าเลขเปลี่ยนเพราะใครกด)
 *  · ยังไม่มี BOM ⇒ ตอบว่ายังไม่มี (success:true · synced:false) ไม่ทับยอดเดิมที่ประเมินได้แล้ว
 *  ‼ สิทธิ์ชุดเดียวกับการดูตัวเลข (suntorn · namna · admin) · ไม่แตะแอป BOM (อ่านอย่างเดียว)
 */
async function syncClaimBom(db, payload) {
  payload = payload || {};
  if (!canSee(payload.username))
    return { success: false, denied: true, error: '🔒 Sync BOM ของใบเคลมทำได้เฉพาะ ' + E.CLAIM_CREATE_ALLOWED.join(' / ') };
  const id = clean(payload.jobID);
  if (!id) return { success: false, error: 'ไม่พบ JobID' };
  const job = (await db.select('production_jobs', { select: JOB_COLS, JobID: 'eq.' + id, limit: 1 }) || [])[0];
  if (!job) return { success: false, error: 'ไม่พบการ์ด ' + id };
  if (!isClaim(job)) return { success: false, error: 'การ์ด ' + id + ' ไม่ใช่ใบเคลม' };

  const est = await estimateFor(db, job);
  const store = await _readStore(db, [id]);
  const prev = store.rows[0];
  const prevEst = prev && prev.EstDetail && Object.keys(prev.EstDetail).length ? prev.EstDetail : null;
  const who = clean(payload.actorNickname) || clean(payload.nickname) || clean(payload.username);
  let saved = false;
  /* ยังไม่มี BOM แต่ก่อนหน้าเคยประเมินได้แล้ว ⇒ ห้ามทับเลขดีด้วย "ไม่มี" */
  const keepOld = !est.ok && prevEst && prevEst.ok;
  if (!keepOld) {
    est.syncedBy = who;
    est.syncedAt = new Date().toISOString();
    est.prev = prevEst ? { ok: !!prevEst.ok, total: prevEst.ok ? prevEst.total : null, source: prevEst.source || '', at: prev.EstAt || '' } : null;
    if (store.ready) { try { await _saveEst(db, job, est); saved = true; } catch (e) { /* แจ้งผ่าน storeWhy */ } }
  }
  _memo.delete(id);
  const r = await getClaimCosts(db, { username: payload.username, jobIDs: [id], fresh: true });
  const cost = (r.costs || {})[id] || null;
  /* ยังไม่รัน sql/105 ⇒ getClaimCosts คิดประเมินเองอยู่แล้ว (เลขเดียวกัน) */
  const msg = est.ok
    ? ('✅ Sync BOM แล้ว — ประเมิน ' + fmtN(est.total) + ' บาท'
       + (est.prev && est.prev.ok && est.prev.total !== est.total ? ' (เดิม ' + fmtN(est.prev.total) + ')' : ''))
    : (keepOld ? (prevEst.source === 'manual' ? '⚠️ งานเดิมยังไม่มี BOM — คงยอดที่คีย์เองไว้' : '⚠️ ตอนนี้อ่าน BOM ของงานเดิมไม่ได้ — คงยอดประเมินเดิมไว้') : '⚠️ ' + est.why);
  return { success: true, synced: !!est.ok && !keepOld, saved, keptOld: !!keepOld, message: msg, est, cost,
           storeReady: store.ready, storeWhy: store.why || '' };
}

/* ═══════════════════════════════ ⑤b 🔁 Sync BOM อัตโนมัติ (รอบ 208) ═══════════════════════════════ */
/**
 * 🔁 autoSyncProject(db, projectID, { by, why }) — แอป BOM เรียกหลังบันทึกสูตร/ต้นทุนของ Project สำเร็จ
 *  · ใบเคลมทุกใบของ Project นั้น (ไม่นับใบยกเลิก · ไม่เกิน 30 ใบ) ⇒ อ่าน BOM ใหม่ แล้วทับยอดประเมิน (เหมือนกด 🔄 Sync BOM)
 *  · ‼ ยอดที่คนคีย์เอง (source = manual) ไม่ทับเด็ดขาด · ยอดเท่าเดิม = ไม่เขียนซ้ำ · ยังไม่มี BOM = ไม่ทับเลขดี
 *  · ไม่โยน error (คนเรียกคือการบันทึก BOM — ห้ามล้มเพราะใบเคลม)
 *  ‼ ไม่ใช่ RPC (อยู่ใน _t) — ไม่มีใครยิงจากหน้าเว็บได้
 */
async function autoSyncProject(db, projectID, opt) {
  opt = opt || {};
  const pid = clean(projectID);
  const res = { projectID: pid, synced: [], kept: [], ready: true };
  if (!pid) return res;
  try {
    const jobs = ((await db.selectAll('production_jobs', { select: JOB_COLS, ProjectID: 'eq.' + pid, order: '_id.asc' })) || [])
      .filter(isClaim).filter(j => clean(j.OverallStatus) !== 'Cancelled').slice(0, 30);
    if (!jobs.length) return res;
    const store = await _readStore(db, jobs.map(j => j.JobID));
    if (!store.ready) { res.ready = false; res.why = store.why || ''; return res; }
    const byId = {};
    for (const r of store.rows) byId[clean(r.JobID)] = r;
    for (const j of jobs) {
      const id = clean(j.JobID), no = clean(j.JobOrderNo) || id, prev = byId[id];
      const prevEst = prev && prev.EstDetail && Object.keys(prev.EstDetail).length ? prev.EstDetail : null;
      if (prevEst && prevEst.ok && prevEst.source === 'manual') { res.kept.push({ jobID: id, orderNo: no, why: 'คีย์ค่าใช้จ่ายเองไว้ — ไม่ทับ' }); continue; }
      const est = await _safe(() => estimateFor(db, j), null);
      if (!est || !est.ok) { res.kept.push({ jobID: id, orderNo: no, why: (est && est.why) || 'อ่าน BOM ไม่ได้' }); continue; }
      if (prevEst && prevEst.ok && prevEst.total === est.total && prevEst.source === est.source && clean(prevEst.costID) === clean(est.costID)) {
        res.kept.push({ jobID: id, orderNo: no, why: 'ยอดเท่าเดิม' }); continue;
      }
      est.syncedBy = clean(opt.by) || AUTO_BY; est.syncedAt = new Date().toISOString(); est.auto = true;
      est.autoWhy = clean(opt.why) || 'บันทึก BOM ของงานเดิมในแอป BOM';
      est.prev = _prevOf(prevEst, prev);
      try { await _saveEst(db, j, est); } catch (e) { res.kept.push({ jobID: id, orderNo: no, why: 'บันทึกไม่สำเร็จ' }); continue; }
      _memo.delete(id); _autoTry.delete(id);
      res.synced.push({ jobID: id, orderNo: no, total: est.total, prevTotal: est.prev && est.prev.ok ? est.prev.total : null });
    }
  } catch (e) { res.error = String((e && e.message) || e).slice(0, 200); }
  return res;
}

/* ═══════════════════════════════ ⑤ ✍️ คีย์ค่าใช้จ่ายเอง (รอบ 193) ═══════════════════════════════ */
const MANUAL_FIELDS = [['material', 'วัสดุ'], ['labor', 'ค่าแรง'], ['overhead', 'โสหุ้ย'], ['other', 'อื่น ๆ']];
const MANUAL_MAX = 50000000;                         /* กันพิมพ์เกิน (ห้าสิบล้านต่อช่อง) */
/** "12,500.50" / 12500.5 / "" → ตัวเลข · null = ว่าง · NaN = รูปแบบผิด */
function parseAmount(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const t = String(v).replace(/[\s฿]/g, '').replace(/,/g, '');
  if (t === '') return null;
  return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : NaN;
}

/**
 * ✍️ setClaimManualCost — SRUN().setClaimManualCost({ jobID, material, labor, overhead, other, note })
 *    ล้างยอดที่คีย์: SRUN().setClaimManualCost({ jobID, clear: true }) ⇒ กลับไปประเมินจาก BOM ตามเดิม (ไม่มี = "ยังไม่มี BOM")
 *  พี่เอ 30 ก.ย. 69: "…ใบเคลม ที่มีการ sync data กับ BOM เรื่องค่าใช้จ่าย เปิดให้คีย์ ตัวเลขค่าใช้จ่ายได้เองด้วยนะ ถ้าไม่มีการ sync BOM"
 *                    + "หรือ sync data BOM มาแล้วก็ต้องเปิดให้ใส่ค่าใช้จ่ายเองได้ด้วย" ⇒ ทุกใบเคลม
 *  ‼ สิทธิ์ชุดเดียวกับการดูตัวเลข (suntorn · namna · admin) · เขียนแค่ app.job_claim_cost
 */
async function setClaimManualCost(db, payload) {
  payload = payload || {};
  if (!canSee(payload.username))
    return { success: false, denied: true, error: '🔒 คีย์ค่าใช้จ่ายใบเคลมทำได้เฉพาะ ' + E.CLAIM_CREATE_ALLOWED.join(' / ') };
  const id = clean(payload.jobID);
  if (!id) return { success: false, error: 'ไม่พบ JobID' };
  const job = (await db.select('production_jobs', { select: JOB_COLS, JobID: 'eq.' + id, limit: 1 }) || [])[0];
  if (!job) return { success: false, error: 'ไม่พบการ์ด ' + id };
  if (!isClaim(job)) return { success: false, error: 'การ์ด ' + id + ' ไม่ใช่ใบเคลม' };

  const store = await _readStore(db, [id]);
  if (!store.ready) return { success: false, error: '⚠️ ยังบันทึกยอดที่คีย์ไม่ได้ — ' + (store.why || 'ที่เก็บต้นทุนใบเคลมยังไม่พร้อม') };
  const prev = store.rows[0];
  const prevEst = prev && prev.EstDetail && Object.keys(prev.EstDetail).length ? prev.EstDetail : null;
  const who = clean(payload.actorNickname) || clean(payload.nickname) || clean(payload.username);

  let est;
  if (payload.clear) {
    est = await estimateFor(db, job);                   /* กลับไปใช้ BOM (ถ้าตอนนี้มีแล้ว) หรือ "ยังไม่มี BOM" */
    est.clearedBy = who; est.clearedAt = new Date().toISOString();
  } else {
    const v = {}, bad = [];
    for (const [k, label] of MANUAL_FIELDS) {
      const n = parseAmount(payload[k]);
      if (Number.isNaN(n) || (n != null && (n < 0 || n > MANUAL_MAX))) bad.push(label);
      v[k] = n == null || Number.isNaN(n) ? 0 : r2(n);
    }
    if (bad.length) return { success: false, error: 'ตัวเลขไม่ถูกต้อง: ' + bad.join(' · ') + ' (ใส่ตัวเลข 0 ขึ้นไป ทศนิยมไม่เกิน 2 ตำแหน่ง)' };
    const total = r2(v.material + v.labor + v.overhead + v.other);
    if (!(total > 0)) return { success: false, error: 'ใส่ค่าใช้จ่ายอย่างน้อย 1 ช่อง' };
    const note = clean(payload.note).replace(/\s+/g, ' ').slice(0, 300);
    const now = new Date().toISOString();
    est = {
      ok: true, projectID: clean(job.ProjectID), source: 'manual',
      sourceText: 'คีย์ค่าใช้จ่ายเอง' + (prevEst && prevEst.ok && /^bom/.test(String(prevEst.source || '')) ? ' (ปรับจากยอด BOM)' : ''),
      total, material: v.material, labor: v.labor, overhead: v.overhead, other: v.other,
      missing: 0, share: 1, shareNote: '', costAt: '', costID: '',
      note: 'คีย์เองโดย ' + (who || '-'), manualNote: note, manualBy: who, manualAt: now,
    };
  }
  est.prev = prevEst ? { ok: !!prevEst.ok, total: prevEst.ok ? prevEst.total : null, source: prevEst.source || '', at: prev.EstAt || '' } : null;
  await _saveEst(db, job, est);
  _memo.delete(id);
  const r = await getClaimCosts(db, { username: payload.username, jobIDs: [id], fresh: true });
  const cost = (r.costs || {})[id] || null;
  const msg = payload.clear
    ? (est.ok ? '✅ ล้างยอดที่คีย์แล้ว — ใช้ยอดจาก BOM ' + fmtN(est.total) + ' บาท' : '✅ ล้างยอดที่คีย์แล้ว')
    : '✅ บันทึกค่าใช้จ่ายที่คีย์แล้ว — ประเมิน ' + fmtN(est.total) + ' บาท';
  return { success: true, message: msg, est, cost };
}

/* ═══════════════════════════════ ⑥ 👤 ผู้ทำเสียหาย (รอบ 194) ═══════════════════════════════ */
const MAX_CULPRITS = 10;
const cleanName = s => clean(s).replace(/\s+/g, ' ').slice(0, 60);
function _culpritNames(row) {
  const c = row && row.Culprits;
  const arr = Array.isArray(c) ? c : (typeof c === 'string' ? (() => { try { return JSON.parse(c); } catch (e) { return []; } })() : []);
  return (arr || []).map(x => cleanName(x && typeof x === 'object' ? x.name : x)).filter(Boolean);
}
/** ชื่อผู้ใช้ทุกคน (ชื่อเล่น › ชื่อ) — ‼ ขอเฉพาะช่องชื่อ ไม่แตะรหัสผ่าน/เบอร์ */
async function _userNames(db) {
  const rows = await _safe(() => db.selectAll('app_users', { select: '"Username","Nickname","Name","Status","DisabledAt"', order: '_id.asc' }), []);
  const byUser = {}, list = [];
  for (const u of rows || []) {
    const nm = cleanName(u.Nickname) || cleanName(u.Name);
    if (!nm) continue;
    if (clean(u.Username)) byUser[clean(u.Username).toLowerCase()] = nm;
    if (u.DisabledAt || /resign|ลาออก|disable/i.test(clean(u.Status))) continue;
    list.push(nm);
  }
  return { byUser, list };
}

/**
 * 👤 getClaimCulpritOptions — SRUN().getClaimCulpritOptions({ jobID })
 *  → { success, current:[ชื่อ], suggested:[{name, why}], all:[ชื่อ] }
 *  เสนอชื่อจากงานเดิม: เคลมผลิต = คนรับ/ผลิต/ปิด/ช่วย ที่สถานีของงานเดิม · เคลมติดตั้ง = ทีมช่างที่จองคิวงานเดิม
 */
async function getClaimCulpritOptions(db, payload) {
  payload = payload || {};
  if (!canSee(payload.username))
    return { success: false, denied: true, error: '🔒 ระบุผู้ทำเสียหายได้เฉพาะ ' + E.CLAIM_CREATE_ALLOWED.join(' / ') };
  const id = clean(payload.jobID);
  const job = id ? (await db.select('production_jobs', { select: JOB_COLS, JobID: 'eq.' + id, limit: 1 }) || [])[0] : null;
  if (!job || !isClaim(job)) return { success: false, error: 'ไม่พบใบเคลม ' + id };
  const U = await _userNames(db);
  const nameOf = raw => { const r = cleanName(raw); return r ? (U.byUser[r.toLowerCase()] || r) : ''; };
  const sug = new Map();
  const add = (raw, why) => { const n = nameOf(raw); if (!n) return; const k = n.toLowerCase(); if (!sug.has(k)) sug.set(k, { name: n, why: [] }); if (why && sug.get(k).why.indexOf(why) < 0) sug.get(k).why.push(why); };
  const kind = kindOf(job);
  const srcID = clean(job.ClaimFromJobID);
  const src = srcID ? (await _safe(() => db.select('production_jobs', { select: '"JobID","RequirementID","Graphic","SalesPerson"', JobID: 'eq.' + srcID, limit: 1 }), []) || [])[0] : null;
  /* 🎨 v1.28.0 เคลมจากกราฟิค-ขาย ⇒ เสนอชื่อกราฟิก + เซลส์ของงานเดิม (ไม่ดึงคนผลิต/ทีมช่าง) */
  const GS = kind === 'กราฟิค-ขาย';
  if (src && GS) { add(src.Graphic, 'กราฟิก'); add(src.SalesPerson, 'เซลส์'); }
  if (src && !GS && kind !== 'ติดตั้ง') {
    const st = await _safe(() => db.selectAll('job_stations', { select: '"StationName","StationID","AcceptedBy","ProducingBy","CompletedBy","HelperUsers","IsActive","CurrentStep"',
      JobID: 'eq.' + srcID, order: '_id.asc' }), []);
    for (const s of st || []) {
      if (s.IsActive === false || String(s.IsActive) === 'false') continue;
      const w = clean(s.StationName) || clean(s.StationID);
      [s.AcceptedBy, s.ProducingBy, s.CompletedBy].forEach(x => add(x, w));
      clean(s.HelperUsers).split(',').forEach(x => add(x, w + ' (ช่วย)'));
    }
  }
  if (src && !GS && kind !== 'ผลิต' && clean(src.RequirementID)) {
    const TEAM = ['ช่างติดตั้ง', 'ช่างติดตั้ง2', 'ช่างติดตั้ง3', 'ช่างติดตั้ง4'];
    const plan = await _safe(() => db.selectAll('installation_plan', { select: TEAM.map(c => '"' + c + '"').join(',') + ',"ชื่อเล่นช่าง"',
      SourceProjectID: 'eq.' + clean(src.RequirementID), order: '_row.asc' }), []);
    if ((plan || []).length) {
      const insp = await _safe(() => require('../booking/plan')._getInspectorMapAsync(), {}) || {};
      for (const p of plan) {
        const nicks = clean(p['ชื่อเล่นช่าง']).split(/\s*[,/|]\s*|\s+และ\s+/).map(clean).filter(Boolean);
        TEAM.forEach((c, i) => {
          const raw = clean(p[c]); if (!raw) return;
          const o = insp[raw] || insp[raw.toLowerCase()];
          add((o && (clean(o.nickname) || clean(o.name))) || nicks[i] || (/^[A-Za-z]{2,}\d+$/.test(raw) ? '' : raw), 'ทีมช่างติดตั้ง');
        });
      }
    }
  }
  const store = await _readStore(db, [id]);
  const current = _culpritNames(store.rows[0]);
  const all = Array.from(new Set(U.list.concat([...sug.values()].map(x => x.name)))).sort((a, b) => a.localeCompare(b, 'th'));
  return { success: true, current, suggested: [...sug.values()].map(x => ({ name: x.name, why: x.why.join(' · ') })), all,
           ready: store.ready, why: store.why || '' };
}

/**
 * 👤 setClaimCulprits — SRUN().setClaimCulprits({ jobID, names:[...] })   ([] = ล้าง)
 *  ‼ สิทธิ์ชุดเดียวกับการดูตัวเลข · เขียนแค่ app.job_claim_cost (Culprits · CulpritBy · CulpritAt)
 */
async function setClaimCulprits(db, payload) {
  payload = payload || {};
  if (!canSee(payload.username))
    return { success: false, denied: true, error: '🔒 ระบุผู้ทำเสียหายได้เฉพาะ ' + E.CLAIM_CREATE_ALLOWED.join(' / ') };
  const id = clean(payload.jobID);
  const job = id ? (await db.select('production_jobs', { select: JOB_COLS, JobID: 'eq.' + id, limit: 1 }) || [])[0] : null;
  if (!job) return { success: false, error: 'ไม่พบการ์ด ' + id };
  if (!isClaim(job)) return { success: false, error: 'การ์ด ' + id + ' ไม่ใช่ใบเคลม' };
  const seen = {}, names = [];
  for (const n of (Array.isArray(payload.names) ? payload.names : [])) {
    const x = cleanName(n); if (!x || seen[x.toLowerCase()]) continue;
    seen[x.toLowerCase()] = 1; names.push(x);
  }
  if (names.length > MAX_CULPRITS) return { success: false, error: 'ระบุได้ไม่เกิน ' + MAX_CULPRITS + ' คน' };
  const store = await _readStore(db, [id]);
  if (!store.ready) return { success: false, error: '⚠️ ยังบันทึกไม่ได้ — ' + (store.why || 'ที่เก็บต้นทุนใบเคลมยังไม่พร้อม') };
  const who = clean(payload.actorNickname) || clean(payload.nickname) || clean(payload.username);
  const patch = { Culprits: names.map(n => ({ name: n })), CulpritBy: who, CulpritAt: new Date().toISOString(), UpdatedAt: new Date().toISOString() };
  try {
    const cur = store.rows[0];
    if (cur) await db.update(TBL, { _id: 'eq.' + cur._id }, patch);
    else await db.insert(TBL, [Object.assign({ JobID: id, ProjectID: clean(job.ProjectID), EstDetail: {} }, patch)]);
  } catch (e) {
    if (missingCol(e)) return { success: false, error: '⚠️ ยังไม่ได้รัน sql/106-jobcard-claim-culprit.sql — รันแล้วกดบันทึกอีกครั้ง' };
    throw e;
  }
  _memo.delete(id);
  const r = await getClaimCosts(db, { username: payload.username, jobIDs: [id], fresh: true });
  return { success: true, names, cost: (r.costs || {})[id] || null,
           message: names.length ? '✅ บันทึกผู้ทำเสียหาย: ' + names.join(', ') : '✅ ล้างรายชื่อผู้ทำเสียหายแล้ว' };
}

/* ═══════════════════════════════ ⑦ 📊 ค่าใช้จ่ายเคลมในรายงานประจำวัน (รอบ 194) ═══════════════════════════════ */
/**
 * 📊 getDailyClaimCosts — SRUN().getDailyClaimCosts({ from, to })   (ช่วงเดียวกับรายงานประจำวัน)
 *  · ค่าใช้จ่ายของใบเคลม = ต้นทุนจริง (เบิก + ซื้อ + ค่าแรง + ค่ารถ + ขนส่ง) · ยังเป็น 0 ⇒ ยอดประเมิน (BOM / คีย์เอง)
 *  · นับเข้า "วันที่สร้างใบเคลม" (วันไทย · กติกาเดียวกับกล่องงานเคลมของรายงาน) · ไม่นับใบที่ยกเลิก
 *  · คืน: ต่อวันในช่วง · รวมช่วง (แยกผลิต/ติดตั้ง) · สะสมเดือนของวันสิ้นสุดช่วง · รายการใบเคลมในช่วง
 *  ‼ พี่เอ: รายงานไม่ต้องแยกรายคน ⇒ ไม่มีตารางรายคน (ชื่อผู้ทำเสียหายติดไปกับแต่ละใบเท่านั้น)
 */
/** วันไทยของเวลาสร้าง — ‼ ค่าที่มีเวลา ("2026-09-29T18:00:00+00:00") ต้องแปลงเป็นจุดเวลาก่อน
 *  (L._ymd อ่านแค่ตัวหน้าวันของสตริง ⇒ ใบที่สร้าง 00:00–06:59 น. ไทย จะตกไปวันก่อน) */
function thDay(v) {
  if (v instanceof Date) return L._ymd(v) || '';
  const s0 = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s0)) {
    let t = s0.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(t)) t += 'Z';                       /* ไม่มีโซน = UTC (แบบ PostgREST) */
    const d = new Date(t);
    if (isFinite(d.getTime())) return L._ymd(d) || '';
  }
  return L._ymd(s0) || '';
}
async function getDailyClaimCosts(db, payload) {
  payload = payload || {};
  if (!canSee(payload.username))
    return { success: false, denied: true, error: '🔒 ค่าใช้จ่ายเคลมดูได้เฉพาะ ' + E.CLAIM_CREATE_ALLOWED.join(' / ') };
  const today = L._todayISO();
  let rFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.from || '')) ? String(payload.from) : today;
  let rTo = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.to || '')) ? String(payload.to) : today;
  if (rFrom > rTo) { const t = rFrom; rFrom = rTo; rTo = t; }
  if (L._isoDiff && Math.abs(L._isoDiff(rFrom, rTo)) > 400) return { success: false, error: 'ช่วงวันยาวเกินไป (ไม่เกิน 400 วัน)' };
  const monthPfx = rTo.substring(0, 7);
  const lo = rFrom < monthPfx + '-01' ? rFrom : monthPfx + '-01';
  /* ขอแค่การ์ดที่สร้างตั้งแต่ (lo − 1 วัน) เวลา UTC — เผื่อขอบวันไทย แล้วตัดด้วยวันไทยอีกชั้น */
  const rows = await db.selectAll('production_jobs', {
    select: JOB_COLS + ',"CustomerName","ClaimReason","CreatedAt"', CreatedAt: 'gte.' + L._isoAdd(lo, -1), order: 'CreatedAt.asc' }) || [];
  const claims = rows.filter(j => isClaim(j) && clean(j.OverallStatus) !== 'Cancelled')
    .map(j => Object.assign(j, { _day: thDay(j.CreatedAt) }))
    .filter(j => j._day && j._day >= lo && j._day <= rTo);
  const act = claims.length ? await actualMany(db, claims, Date.now()) : { byJob: {}, warn: [] };
  const store = claims.length ? await _readStore(db, claims.map(j => j.JobID)) : { ready: true, rows: [] };
  const byId = {};
  for (const r of store.rows) byId[clean(r.JobID)] = r;

  const blank = () => ({ total: 0, count: 0, P: 0, I: 0, G: 0, O: 0, act: 0, est: 0, none: 0 });
  const range = blank(), month = blank(), days = {};
  const list = [], monthList = [];
  for (const j of claims) {
    const id = clean(j.JobID), a = (act.byJob[id] || {}).total || 0, r = byId[id];
    const e = r && r.EstTotal != null && clean(r.EstSource) !== 'none' ? num(r.EstTotal) : 0;
    const cost = a > 0 ? a : (e > 0 ? e : 0);
    const src = a > 0 ? 'act' : (e > 0 ? 'est' : 'none');
    const k = kindOf(j), bucket = k === 'ผลิต' ? 'P' : (k === 'ติดตั้ง' ? 'I' : (k === 'กราฟิค-ขาย' ? 'G' : 'O'));
    const put = g => { g.total += cost; g.count++; g[bucket] += cost; g[src]++; };
    if (j._day.substring(0, 7) === monthPfx) {
      put(month);
      /* 📋 รอบ 199 — พี่เอ 1 ต.ค. 69: "…สรุปค่าใช้จ่ายงานเคลมสะสมทั้งเดือนด้วยสิ" ⇒ รายใบทั้งเดือน (ยอดเดียวกับช่องสะสมเดือนนี้) */
      monthList.push({ jobID: id, orderNo: clean(j.JobOrderNo), cust: clean(j.CustomerName), kind: k, day: j._day,
                       reason: clean(j.ClaimReason).slice(0, 80), cost: r2(cost), src, closed: clean(j.OverallStatus) === 'Closed',
                       culprits: _culpritNames(r) });
    }
    if (j._day >= rFrom && j._day <= rTo) {
      put(range);
      days[j._day] = days[j._day] || blank(); put(days[j._day]);
      list.push({ jobID: id, orderNo: clean(j.JobOrderNo), cust: clean(j.CustomerName), kind: k, day: j._day,
                  reason: clean(j.ClaimReason).slice(0, 80), cost: r2(cost), src, act: r2(a), est: e ? r2(e) : null,
                  culprits: _culpritNames(r) });
    }
  }
  const fix = g => { ['total', 'P', 'I', 'G', 'O'].forEach(x => { g[x] = r2(g[x]); }); return g; };
  list.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : y.cost - x.cost));
  return {
    success: true, from: rFrom, to: rTo, today, monthPfx,
    range: fix(range), month: fix(month),
    byDay: Object.keys(days).sort().map(d => Object.assign({ day: d }, fix(days[d]))),
    list: list.slice(0, 80), more: Math.max(0, list.length - 80),
    /* 📋 รอบ 199 — ทั้งเดือน ใหม่สุดก่อน (วันเดียวกันแพงก่อน) */
    monthList: monthList.sort((x, y) => (x.day < y.day ? 1 : x.day > y.day ? -1 : y.cost - x.cost)).slice(0, 300),
    monthMore: Math.max(0, monthList.length - 300),
    storeReady: store.ready, storeWhy: store.why || '', warn: act.warn || [],
  };
}

/* ‼ rpc.js ลงทะเบียน "ทุกฟังก์ชันที่ export" ⇒ ตัวช่วยห่อไว้ใน _t (ไม่ใช่ฟังก์ชัน) */
module.exports = {
  getClaimCosts,
  syncClaimBom,
  setClaimManualCost,
  getClaimCulpritOptions,
  setClaimCulprits,
  getDailyClaimCosts,
  _t: { isClaim, kindOf, canSee, estimateFor, actualMany, snapshotEstimate, _memo, parseAmount, thDay,
        /* 🔁 รอบ 208 */ autoSyncProject, _autoTry, AUTO_BY },
};
