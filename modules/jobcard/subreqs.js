'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/jobcard/subreqs.js — ⚠️ เตือนบนการ์ด: งานย่อยของ Project เดียวกันยังเข้ามาไม่ครบ (v1.29.0)
 *
 *  ‼ พี่เอสั่ง 5 พ.ย. 69 (คำต่อคำ):
 *    "กรณี Job card ที่เป็นงานหลัก complete แต่งานย่อยยังไม่ complete ช่วยแจ้งเตือน ในหน้า card หลัก ด้วยนะ
 *     ว่ายังมีใบ Job งานย่อย ที่มาจาก project ย่อยที่ยังไม่ complete ถูกสร้าง card ผลิตเข้ามา
 *     เพื่อป้องกันการลืมกด complete การแจ้งเตือนที่ card หลักจะต้องอยู่จนกว่า job งานย่อยจะเข้ามาจนครบทุกใบให้ด้วย"
 *
 *  ── คิดยังไง (อ่านอย่างเดียว · ไม่แก้อะไรในฐาน) ─────────────────────
 *   Project ย่อย = app.requirements ของ ProjectID เดียวกัน (ข้ามประเภทที่ไม่เข้าผลิต — กติกาเดียวกับตอนสร้างการ์ด)
 *   "ยังไม่มีการ์ด" = requirement ที่ยังไม่มีแถวใน production_jobs (ProjectID + RequirementID) เลย
 *      ⇒ ส่วนใหญ่คือ Project ย่อยยังไม่ได้กด Complete ในแอป Projects (ระบบจึงยังไม่ดึงเข้ามาสร้างการ์ด)
 *   ‼ เตือน "จนกว่าการ์ดงานย่อยเข้ามาครบทุกใบ" — มีครบแล้ว = แถบหายเอง
 *   + บอกด้วยว่าการ์ดงานย่อยที่เข้ามาแล้วยังผลิตไม่จบกี่ใบ (ให้เห็นภาพทั้ง Project)
 *   ‼ ถามแคบเฉพาะการ์ดบนจอ (≤ 400 ใบ) · พังตรงไหน = ไม่วางแถบ (บอร์ดไม่ล่ม)
 * ═══════════════════════════════════════════════════════════════════ */
const L = require('./lib');
const clean = s => String(s == null ? '' : s).trim();
const MAX_IDS = 400;
const q = v => '"' + String(v).replace(/"/g, '') + '"';

/** jobRows: [{ JobID, ProjectID, RequirementID, OverallStatus }] → { JobID: { projectID, missing:[…], open:[…], subTotal, thisDone } } (เฉพาะใบที่ต้องเตือน) */
async function subsOf(db, jobRows) {
  const pids = Array.from(new Set((jobRows || []).map(j => clean(j.ProjectID)).filter(Boolean)));
  if (!pids.length) return {};
  const reqs = [], cards = [];
  for (let i = 0; i < pids.length; i += 80) {
    const part = pids.slice(i, i + 80).map(q).join(',');
    reqs.push(...(await db.selectAll('requirements', { select: 'requirement_id,project_id,requirement_name,job_type,status', project_id: 'in.(' + part + ')', order: '_id.asc' }) || []));
    cards.push(...(await db.selectAll('production_jobs', { select: 'JobID,ProjectID,RequirementID,RequirementName,OverallStatus,ClaimType', ProjectID: 'in.(' + part + ')', order: '_id.asc' }) || []));
  }
  const byP = {};
  for (const p of pids) byP[p] = { reqs: [], cards: [] };
  for (const r of reqs) { const p = clean(r.project_id), id = clean(r.requirement_id); if (byP[p] && id && !L._isNonProductionJobType(clean(r.job_type)) && !/เคลม/.test(clean(r.job_type))) byP[p].reqs.push(r); }   /* 🩹 v1.29.1 โปรเจคย่อยงานเคลม = ใช้การ์ดเคลม ไม่ต้องเตือนว่ายังไม่มีการ์ดผลิต */
  for (const c of cards) { const p = clean(c.ProjectID); if (byP[p] && !clean(c.ClaimType)) byP[p].cards.push(c); }   /* การ์ดเคลมไม่ใช่งานย่อย */
  const info = {};
  for (const p of pids) {
    const P = byP[p];
    if (!P.reqs.length) continue;   /* Project ไม่มีงานย่อย = ไม่มีอะไรต้องเตือน */
    const has = new Set(P.cards.map(c => clean(c.RequirementID)).filter(Boolean));
    const missing = P.reqs.filter(r => !has.has(clean(r.requirement_id)))
      .map(r => ({ id: clean(r.requirement_id), name: clean(r.requirement_name) || clean(r.requirement_id), status: clean(r.status) || 'Not started' }));
    const open = P.cards.filter(c => clean(c.RequirementID) && ['Closed', 'Cancelled'].indexOf(clean(c.OverallStatus)) < 0)
      .map(c => ({ jobID: clean(c.JobID), name: clean(c.RequirementName) || clean(c.RequirementID), status: clean(c.OverallStatus) || 'Pending' }));
    info[p] = { missing, open, subTotal: P.reqs.length, subCards: has.size };
  }
  const out = {};
  for (const j of jobRows) {
    const p = clean(j.ProjectID), x = info[p];
    if (!x || !x.missing.length) continue;   /* ‼ เตือนจนกว่าการ์ดงานย่อยเข้ามาครบทุกใบ */
    out[clean(j.JobID)] = { projectID: p, missing: x.missing, open: x.open.filter(o => o.jobID !== clean(j.JobID)),
      subTotal: x.subTotal, subCards: x.subCards, thisDone: clean(j.OverallStatus) === 'Closed', isSub: !!clean(j.RequirementID) };
  }
  return out;
}

/**
 * SRUN().getJobSubReqAlerts({ jobIDs }) → { success, map: { JobID: {...} } }
 */
async function getJobSubReqAlerts(db, payload) {
  const p = payload || {};
  const ids = Array.from(new Set((Array.isArray(p.jobIDs) ? p.jobIDs : []).map(clean).filter(Boolean))).slice(0, MAX_IDS);
  if (!ids.length) return { success: true, map: {} };
  try {
    const rows = [];
    for (let i = 0; i < ids.length; i += 80)
      rows.push(...(await db.selectAll('production_jobs', { select: 'JobID,ProjectID,RequirementID,OverallStatus', JobID: 'in.(' + ids.slice(i, i + 80).map(q).join(',') + ')', order: '_id.asc' }) || []));
    return { success: true, map: await subsOf(db, rows) };
  } catch (e) {
    return { success: false, map: {}, error: 'อ่านงานย่อยไม่ได้: ' + ((e && e.message) || e) };
  }
}

/* ‼ rpc.js ลงทะเบียน "ทุกฟังก์ชันที่ export" ⇒ ตัวช่วยห่อไว้ใน _t */
module.exports = { getJobSubReqAlerts, _t: { subsOf } };
