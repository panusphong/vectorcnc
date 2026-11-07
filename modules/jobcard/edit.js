'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/jobcard/edit.js — แก้ไขการ์ด · อนุมัติผลิต · ประเภทส่งมอบ · การ์ดเคลม
 *
 *  ‼ พี่เอสั่ง 9 ก.ย. 69: "ทำให้จบ ตาม code เดิม 100% นะ
 *                          ห้ามปรับเปลี่ยน ตัดออกอะไรทั้งสิ้นนะ"
 *
 *  ต้นฉบับ _source/jobcard/Code.gs (v13.34) — ย้ายมาทีละบรรทัด:
 *    _canEditCustomerDate        Code.gs:612-626
 *    _canDeleteOwn               Code.gs:678-696
 *    _canSyncData                Code.gs:726-737   (v13.12)
 *    _canSync                    Code.gs:739-749   (v10.31)
 *    updateJobDetails            Code.gs:3179-3233
 *    approveJobForProduction     Code.gs:5005-5031
 *    cancelApproval              Code.gs:5033-5085
 *    setJobFulfillType           Code.gs:5093-5217 (v10.99 → v12.48)
 *    _propagateFulfillTypeToBundle Code.gs:5500-5545 (v12.04)
 *    createClaimCard             Code.gs:11554-11691
 *    cleanupEmptyJobCards        Code.gs:2422-2523  (v12.72)
 *    _updateProjectField         Code.gs:4098-4123
 *    _updateProjStatus           Code.gs:6720-6737
 *    _updateProjectJobStatus     Code.gs:6917-6946
 *    _toBuddhistDate             Code.gs:4089-4095
 *
 *  ── ต่างจากของเดิมตรงไหน (เฉพาะ "ที่เก็บ" ไม่ใช่ "กติกา") ────────
 *   · ของเดิมเขียนลงชีต — ที่นี่เขียนลง Supabase ตามกฎเหล็กของพี่เอ
 *     (ชีตเดิม "ห้ามเขียน" เด็ดขาด — core/sheets.js มี SHEETS_ALLOW_WRITE กันไว้)
 *   · ของเดิมแปลง พ.ศ. ก่อนเขียนกลับชีต (_toBuddhistDate) — ฐานข้อมูลใหม่
 *     เก็บเป็น ค.ศ. ล้วน ตัวซิงก์แปลงให้ตอนอ่านเข้ามาแล้ว
 *     ‼ ฟังก์ชัน _toBuddhistDate ยังยกมาครบ + มีเทสต์ เพราะเป็นกติกาของระบบเดิม
 * ═══════════════════════════════════════════════════════════════════ */

const L = require('./lib');
const {
  _ymd, _dt, _userKey, _findCol, FULFILL_TYPES, _fulfillToThai,
  STATIONS_DEF, COL_STATUS_JOBORDER, COL_PAYMENT_STATUS, COL_PAYMENT_DATE, COL_PAYMENT_BY,
  COL_FULFILL_TYPE_PROJ,
} = L;
const { newId, buildStationRows } = require('./create');
const { _appendLog } = require('./board');
const F = require('./files');
/* 🆕 12 ก.ย. 69 — ของที่พี่เอสั่งเพิ่มอยู่แยกไฟล์ ตัวเดิมแค่ "เรียกออกมา"
 *   ⇒ อ่านง่ายว่าบรรทัดไหนคือของที่ยกมาจาก Code.gs บรรทัดไหนคือของที่สั่งเพิ่ม
 *   (เหตุผลเต็มอยู่หัวไฟล์ claiminstall.js) */
const CLM = require('./claiminstall');

const clean = s => String(s == null ? '' : s).trim();
/* ‼ เวลาปัจจุบันสำหรับบันทึกลง timestamptz — ติดเขตเวลาไทย (+07:00) มาด้วย
 *   พี่เอสั่ง 13 ก.ย. 69: "บันทึกเวลา วันที่ ให้ถูกต้องตามเวลาของไทย 100%"
 *   เดิม new Date().toISOString() = ตัวอักษร UTC — จุดเวลาเดียวกันก็จริง แต่ใครก็ตาม
 *   ที่อ่านค่าดิบแล้วตัดสตริงเอาชั่วโมง จะได้ชั่วโมง UTC (ช้ากว่าไทย 7 ชม.)
 *   ⇒ ใช้ฟังก์ชันกลางที่เดียวของทั้งระบบ: core/thai-date.js */
const nowISO = () => require('../../core/thai-date').isoTH();

/** Code.gs:14 */
const JOB_STATUS_OPEN = 'เข้าแผนผลิตแล้ว';

/** ต้นฉบับ Code.gs:11553 */
const CLAIM_CREATE_ALLOWED = ['suntorn', 'namna', 'admin'];

/** ต้นฉบับ Code.gs:726-737 (v13.12)
 *  ‼ รายชื่อนี้ต้องตรงกับ CAN_SYNC_DATA ฝั่งหน้าจอเป๊ะ ๆ
 *    ของเดิมเคยเพี้ยน → "เห็นปุ่มแต่กดไม่ได้" */
const SYNC_DATA_ALLOWED = ['admin', 'namna', 'น้ำ', 'น้ำนา', 'nam', 'na'];

/** ต้นฉบับ Code.gs:739-749 (v10.31) — ซิงก์สถานี/รูป admin เท่านั้น */
const SYNC_ALLOWED = ['admin'];

const inList = (user, list) => {
  if (!user) return false;
  const u = _userKey(user);
  return list.some(a => u === String(a).toLowerCase());
};

/** ต้นฉบับ Code.gs:726 */
function _canSyncData(user) { return inList(user, SYNC_DATA_ALLOWED); }
/** ต้นฉบับ Code.gs:739 */
function _canSync(user) { return inList(user, SYNC_ALLOWED); }

/* ═══════════════════════════════════════════════════════════════════
 *  ① _canEditCustomerDate — ต้นฉบับ Code.gs:612-626 (v10.73)
 *
 *  ‼ ของเดิมเทียบด้วย indexOf ไม่ใช่ === — "นก" อยู่ใน "นกน้อย" ก็ผ่าน
 *    ยกมาเหมือนเดิมเป๊ะ ห้ามเปลี่ยนเป็น === เด็ดขาด (จะล็อกเซลส์ออกจากงานตัวเอง)
 * ═══════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════
 *  🔴 11 ก.ย. 69 — พี่เอส่ง feedback จากผู้ใช้: เซลส์เจ้าของงานเอง
 *    กดแก้วันส่งลูกค้าไม่ได้ ทั้งที่ข้อความเตือนขึ้นชื่อของเธอเอง
 *      "เฉพาะ Sales เจ้าของงาน "(เปตอง) พัชรพร ศรกองแดง" …"
 *    และคนที่กดคือ (เปตอง) พัชรพร ศรกองแดง นั่นแหละ
 *
 *  ต้นเหตุเดียวกับเรื่องรูปไม่ขึ้นและชื่อซ้ำในช่องกรอง:
 *    ชื่อจากชีต ProductionJobs กับชื่อจากตารางผู้ใช้ ต่างกันแค่
 *    "อักขระที่มองไม่เห็น" (NBSP U+00A0 หรือเว้นวรรคซ้อน)
 *    ⇒ sp.indexOf(nick) หาไม่เจอ ⇒ เจ้าของงานโดนปฏิเสธสิทธิ์ของตัวเอง
 *
 *  ‼ นี่อันตรายกว่ารูปไม่ขึ้นมาก เพราะมันบล็อกงานจริงของคน
 *  ⇒ ยุบช่องว่างทั้งสองฝั่งก่อนเทียบเสมอ (ตรรกะการตัดสินเหมือนเดิมทุกบรรทัด)
 * ═══════════════════════════════════════════════════════════════════ */
const _nameKey = v => String(v || '').toLowerCase().trim().replace(/\s+/g, ' ');

function _canEditCustomerDate(user, nickname, salesPerson) {
  let rawU = String(user || '').toLowerCase().trim();
  const atIdx = rawU.indexOf('@'); if (atIdx > 0) rawU = rawU.substring(0, atIdx);
  /* 1) admin/namna/suntorn bypass — Code.gs:616 */
  const bypass = ['admin', 'namna', 'suntorn'];
  for (const b of bypass) if (rawU === b) return true;
  /* 2) เทียบกับ Sales — match raw หรือ nickname — Code.gs:619-625 */
  const sp = _nameKey(salesPerson);
  if (!sp) return false;
  if (rawU && sp.indexOf(rawU) >= 0) return true;
  const nick = _nameKey(nickname);
  if (nick && sp.indexOf(nick) >= 0) return true;
  return false;
}

/* ═══════════════════════════════════════════════════════════════════
 *  ② _canDeleteOwn — ต้นฉบับ Code.gs:678-696 (v10.72)
 *  ‼ ownerStored ว่าง = ให้ลบได้ (legacy) — ห้ามตัดข้อนี้ออก
 * ═══════════════════════════════════════════════════════════════════ */
function _canDeleteOwn(user, nickname, ownerStored) {
  let rawU = String(user || '').toLowerCase().trim();
  const atIdx = rawU.indexOf('@'); if (atIdx > 0) rawU = rawU.substring(0, atIdx);
  if (rawU === 'admin') return true;                       // Code.gs:683
  const os = _nameKey(ownerStored);
  if (!os) return true;                                    // Code.gs:686 legacy
  if (os === rawU) return true;
  const nick = String(nickname || '').toLowerCase().trim();
  if (nick && os === nick) return true;                    // Code.gs:690-693
  return false;
}

/* ═══════════════════════════════════════════════════════════════════
 *  ③ _toBuddhistDate — ต้นฉบับ Code.gs:4089-4095
 *  ปีเกิน 2400 = เป็น พ.ศ. อยู่แล้ว ไม่บวกซ้ำ
 *
 *  ‼ ของเดิมอ่าน/เขียนส่วนประกอบวันด้วยเวลาท้องถิ่นของเครื่อง
 *    ซึ่งใช้ได้เพราะ Apps Script ตั้งโซนเป็น Asia/Bangkok ตายตัว
 *    Railway รันเป็น UTC ⇒ ถ้ายกมาตรง ๆ วันจะเพี้ยนช่วงเที่ยงคืนถึงเจ็ดโมง
 *    ที่นี่จึงอ่าน/เขียนด้วยเวลาไทยตรง ๆ (บวก 7 ชม.ก่อน แล้วใช้ส่วน UTC)
 *    ผลลัพธ์ที่เมืองไทยเหมือนของเดิมเป๊ะ และไม่ขึ้นกับโซนของเครื่องอีกต่อไป
 *    — กฎเดียวกับ _ymd/_dt ใน lib.js (บทเรียนเขตเวลา 3 รอบก่อนหน้านี้)
 * ═══════════════════════════════════════════════════════════════════ */
function _toBuddhistDate(gregDate) {
  if (!(gregDate instanceof Date) || isNaN(gregDate.getTime())) return gregDate;
  const t = new Date(gregDate.getTime() + L._BKK_OFFSET_MS);
  const y = t.getUTCFullYear();
  if (y > 2400) return gregDate;
  return new Date(Date.UTC(y + 543, t.getUTCMonth(), t.getUTCDate(),
    t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds()) - L._BKK_OFFSET_MS);
}

/* ═══════════════════════════════════════════════════════════════════
 *  ④ เขียนกลับ Projects — ต้นฉบับ Code.gs:4098 · 6720 · 6917
 *     ของเดิมเขียนชีต · ที่นี่เขียน app.projects
 * ═══════════════════════════════════════════════════════════════════ */
async function _updateProjectField(db, pid, fieldName, value) {
  if (!pid) return false;
  try {
    const r = await db.update('projects', { 'ID': 'eq.' + pid }, { [fieldName]: value });
    return Array.isArray(r) ? r.length > 0 : !!r;
  } catch (e) { return false; }                            // Code.gs:4122 กลืน error เหมือนเดิม
}

async function _updateProjStatus(db, pid, newStatus) {
  if (!pid) return false;
  try {
    const r = await db.update('projects', { 'ID': 'eq.' + pid }, { 'Status': newStatus });
    return Array.isArray(r) ? r.length > 0 : !!r;
  } catch (e) { return false; }
}

async function _updateProjectJobStatus(db, pid, newJobStatus) {
  if (!pid) return false;
  try {
    const r = await db.update('projects', { 'ID': 'eq.' + pid },
      { [COL_STATUS_JOBORDER]: newJobStatus || '' });
    return Array.isArray(r) ? r.length > 0 : !!r;
  } catch (e) { return false; }
}

/* ═══════════════════════════════════════════════════════════════════
 *  ⑤ updateJobDetails — ต้นฉบับ Code.gs:3179-3233
 *
 *  payload = { jobID, jobOrderNo, productionStartDate, deliveryDate,
 *              customerDeliveryDate, username, nickname }
 *
 *  ‼ กติกาที่ห้ามเพี้ยน:
 *    · แก้ "วันส่งลูกค้า" ต้องผ่าน _canEditCustomerDate (v10.73)
 *    · ProductionDays = (วันส่งงาน − วันเริ่มผลิต) หาร 86,400,000 แล้วปัดใกล้สุด
 *      คิดเฉพาะเมื่อมี "ทั้งสองวัน" ในคำสั่งเดียวกัน — ไม่ไปดึงของเดิมมาคิด
 *    · วันส่งลูกค้าถูกซิงก์กลับ Projects."วันที่ส่งมอบให้ลูกค้า"
 * ═══════════════════════════════════════════════════════════════════ */
async function updateJobDetails(db, payload) {
  if (!payload || !payload.jobID) throw new Error('ไม่พบ JobID');   // Code.gs:3181

  const job = await db.one('production_jobs', { select: '*', 'JobID': 'eq.' + payload.jobID });
  if (!job) return { success: false, version: L.SOURCE_VERSION };   // Code.gs:3229

  const user = clean(payload.nickname) || clean(payload.username) || 'user';
  const pid = clean(job.ProjectID);

  /* ── v10.73 · ตรวจสิทธิ์ก่อนแก้วันส่งลูกค้า — Code.gs:3191-3198 ── */
  if (payload.customerDeliveryDate !== undefined && payload.customerDeliveryDate !== null &&
      String(payload.customerDeliveryDate).trim() !== '') {
    const salesPerson = clean(job.SalesPerson);
    if (!_canEditCustomerDate(payload.username, payload.nickname, salesPerson)) {
      throw new Error('🔒 ไม่มีสิทธิ์แก้วันส่งลูกค้า\nเฉพาะ Sales เจ้าของงาน "' + salesPerson +
        '" หรือ admin/namna/suntorn เท่านั้น');
    }
  }

  const patch = {};
  if (payload.jobOrderNo !== undefined) patch.JobOrderNo = payload.jobOrderNo || '';  // Code.gs:3200

  const ps = _ymd(payload.productionStartDate);
  const de = _ymd(payload.deliveryDate);
  const cd = _ymd(payload.customerDeliveryDate);
  let days = '';

  if (ps) patch.ProductionStartDate = ps;
  if (de) patch.DeliveryDate = de;
  if (cd) patch.CustomerDeliveryDate = cd;
  if (ps && de) {
    days = Math.round((Date.parse(de + 'T00:00:00Z') - Date.parse(ps + 'T00:00:00Z')) / 86400000);
    patch.ProductionDays = days;                                    // Code.gs:3210-3213
  }
  patch.UpdatedAt = nowISO();
  patch.UpdatedBy = user;

  await db.update('production_jobs', { 'JobID': 'eq.' + payload.jobID }, patch);

  /* ── ซิงก์วันส่งมอบกลับ Projects — Code.gs:3218-3220 ── */
  let syncedProject = false;
  if (cd && pid) syncedProject = await _updateProjectField(db, pid, 'วันที่ส่งมอบให้ลูกค้า', cd);

  return {
    success: true,
    productionDays: days,
    syncedToProjects: syncedProject,
    version: L.SOURCE_VERSION,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 *  ⑥ approveJobForProduction — ต้นฉบับ Code.gs:5005-5031
 *  ตั้ง ApprovalStatus='อนุมัติแล้ว' + stamp Projects."Status JobOrder"
 * ═══════════════════════════════════════════════════════════════════ */
async function approveJobForProduction(db, payload) {
  if (!payload || !payload.jobID) throw new Error('ไม่พบ JobID');
  const job = await db.one('production_jobs', { select: '*', 'JobID': 'eq.' + payload.jobID });
  if (!job) return { success: false, version: L.SOURCE_VERSION };

  const user = clean(payload.nickname) || clean(payload.username) || 'user';
  const now = nowISO();

  await db.update('production_jobs', { 'JobID': 'eq.' + payload.jobID }, {
    ApprovalStatus: 'อนุมัติแล้ว',
    ApprovedBy: user, ApprovedAt: now,
    UpdatedAt: now, UpdatedBy: user,
  });
  await _updateProjectJobStatus(db, clean(job.ProjectID), JOB_STATUS_OPEN);   // Code.gs:5021
  await _appendLog(db, payload.jobID, '-', '-', 0, 'อนุมัติสั่งผลิต', user, '');
  return { success: true, version: L.SOURCE_VERSION };
}

/* ═══════════════════════════════════════════════════════════════════
 *  ⑦ cancelApproval — ต้นฉบับ Code.gs:5033-5085
 *
 *  ‼ กติกาที่ห้ามเพี้ยน:
 *    · ไม่ force + มีสถานีขั้น > 1 → โยน error "มี Station เริ่มผลิตแล้ว"
 *    · force → รีเซ็ตทุกสถานีกลับขั้น 1 + ล้าง 6 ช่องคนทำ/เวลา
 *              แล้วตั้งการ์ดกลับเป็น Pending · CurrentStation ว่าง
 *    · ล้าง Status JobOrder ให้ว่าง (Status เดิมของ Projects ไม่แตะ — v9.2)
 * ═══════════════════════════════════════════════════════════════════ */
const CANCEL_RESET_COLS = ['AcceptedBy', 'AcceptedAt', 'ProducingBy', 'ProducingAt',
  'CompletedBy', 'CompletedAt'];                                   // Code.gs:5063

async function cancelApproval(db, payload) {
  if (!payload || !payload.jobID) throw new Error('ไม่พบ JobID');
  const job = await db.one('production_jobs', { select: '*', 'JobID': 'eq.' + payload.jobID });
  if (!job) throw new Error('ไม่พบ Job');                           // Code.gs:5084

  const user = clean(payload.nickname) || clean(payload.username) || 'user';
  const pid = clean(job.ProjectID);
  const sts = await db.selectAll('job_stations',
    { select: '*', 'JobID': 'eq.' + payload.jobID, order: '_row.asc' }) || [];

  if (!payload.force) {
    if (sts.some(s => Number(s.CurrentStep) > 1))
      throw new Error('มี Station เริ่มผลิตแล้ว — ใช้ Force หากจำเป็น');   // Code.gs:5054
  } else {
    const blank = {};
    for (const c of CANCEL_RESET_COLS) blank[c] = null;
    await db.update('job_stations', { 'JobID': 'eq.' + payload.jobID },
      { CurrentStep: 1, ...blank });                                // Code.gs:5060-5066
    await db.update('production_jobs', { 'JobID': 'eq.' + payload.jobID },
      { OverallStatus: 'Pending', CurrentStation: '' });            // Code.gs:5068-5069
  }

  await db.update('production_jobs', { 'JobID': 'eq.' + payload.jobID }, {
    ApprovalStatus: 'รออนุมัติ',
    ApprovedBy: '', ApprovedAt: null,
    UpdatedAt: nowISO(), UpdatedBy: user,
  });
  await _updateProjectJobStatus(db, pid, '');                       // Code.gs:5078 (v9.2)
  await _appendLog(db, payload.jobID, '-', '-', 0,
    payload.force ? 'Force ยกเลิก' : 'ยกเลิกอนุมัติ', user, '');
  return { success: true, version: L.SOURCE_VERSION };
}

/* ═══════════════════════════════════════════════════════════════════
 *  ⑧ _propagateFulfillTypeToBundle — ต้นฉบับ Code.gs:5500-5545 (v12.04)
 *
 *  โปรเจกต์เดียวมีหลายการ์ด → เปลี่ยนประเภทส่งมอบใบเดียว ต้องตามไปให้ครบทุกใบ
 *  ‼ ข้าม Closed/Cancelled (conservative) · ข้ามใบที่ค่าเหมือนกันอยู่แล้ว
 * ═══════════════════════════════════════════════════════════════════ */
async function _propagateFulfillTypeToBundle(db, projectID, newType, user, excludeJobID) {
  if (!projectID || !newType) return { affected: 0 };
  try {
    const rows = await db.selectAll('production_jobs',
      { select: 'JobID,ProjectID,JobFulfillType,OverallStatus', 'ProjectID': 'eq.' + projectID, order: '_row.asc' }) || [];
    const now = nowISO();
    const newTypeLower = String(newType).toLowerCase();
    const affectedJIDs = [];
    for (const r of rows) {
      const jid = clean(r.JobID);
      if (jid === String(excludeJobID || '')) continue;             // Code.gs:5522
      const overall = clean(r.OverallStatus).toLowerCase();
      if (overall === 'closed' || overall === 'cancelled') continue; // Code.gs:5524
      const curFT = clean(r.JobFulfillType).toLowerCase();
      if (curFT === newTypeLower) continue;                          // Code.gs:5526
      await db.update('production_jobs', { 'JobID': 'eq.' + jid },
        { JobFulfillType: newTypeLower, UpdatedAt: now, UpdatedBy: user || 'auto' });
      affectedJIDs.push(jid);
    }
    if (affectedJIDs.length) {
      try {
        await _appendLog(db, String(excludeJobID || '-'), '-', '-', 0,
          '🔗 Bundle Sync FulfillType', user || 'auto',
          'ProjectID=' + projectID + ' · fulfillType=' + newType +
          ' · sync ' + affectedJIDs.length + ' sibling cards (' + affectedJIDs.slice(0, 3).join(',') + ')');
      } catch (_eL) {}
    }
    return { affected: affectedJIDs.length, jobIDs: affectedJIDs };
  } catch (e) {
    return { affected: 0, error: e.message };                        // Code.gs:5543
  }
}

/* ═══════════════════════════════════════════════════════════════════
 *  ⑨ setJobFulfillType — ต้นฉบับ Code.gs:5093-5217
 *
 *  ‼ 4 อย่างที่ต้องเกิดพร้อมกันทุกครั้ง ห้ามตัดอันไหนออก:
 *    ① เขียน JobFulfillType ที่การ์ด
 *    ② ซิงก์กลับ Projects."ประเภทการจัดส่ง" เป็นภาษาไทย (v11.31)
 *    ③ ตามไปแก้การ์ดพี่น้องในโปรเจกต์เดียวกัน (v12.04)
 *    ④ ขยับ PlannedDate ของแผนจัดส่งที่ยัง planned/preparing (v12.48)
 *       delivery_to_installer → วันส่งลูกค้า − 1 วัน · อื่น ๆ → วันส่งลูกค้า
 * ═══════════════════════════════════════════════════════════════════ */
async function setJobFulfillType(db, payload, canEditDelivery) {
  if (!payload || !payload.jobID) throw new Error('ไม่พบ JobID');
  const newType = String(payload.fulfillType || 'delivery').toLowerCase();
  if (!FULFILL_TYPES[newType])
    throw new Error('fulfillType ไม่ถูกต้อง — ต้องเป็น delivery / delivery_to_installer / installation / pickup_factory / pickup_branch');

  const job = await db.one('production_jobs', { select: '*', 'JobID': 'eq.' + payload.jobID });
  if (!job) return { success: false, error: 'ไม่พบ Job', version: L.SOURCE_VERSION };

  const salesPerson = clean(job.SalesPerson);
  /* v11.36 — ใช้ _canEditDelivery (delivery managers + sales เจ้าของงาน) */
  if (!canEditDelivery(payload.username, payload.nickname, salesPerson)) {
    throw new Error('🔒 ไม่มีสิทธิ์เปลี่ยนประเภทการส่งมอบ\nเฉพาะ Sales เจ้าของงาน "' + salesPerson +
      '" หรือ delivery managers (admin/namna/suntorn/annrawin9449/chavisa/jiraporn/pu/chananchida/sopa)');
  }

  const user = clean(payload.nickname) || clean(payload.username) || 'user';
  const nowD = nowISO();
  const pid = clean(job.ProjectID);

  await db.update('production_jobs', { 'JobID': 'eq.' + payload.jobID },
    { JobFulfillType: newType, UpdatedAt: nowD, UpdatedBy: user });

  /* ── ② ซิงก์กลับ Projects (v11.31) — Code.gs:5129-5157 ── */
  let projSyncResult = '';
  try {
    if (pid) {
      const r = await db.update('projects', { 'ID': 'eq.' + pid },
        { [COL_FULFILL_TYPE_PROJ]: _fulfillToThai(newType) });
      projSyncResult = (Array.isArray(r) && r.length) ? 'ok' : '';
    }
  } catch (eProj) { projSyncResult = 'err: ' + eProj.message; }

  /* ── ③ bundle (v12.04) — Code.gs:5160-5167 ── */
  let bundleRes = { affected: 0 };
  try {
    if (pid) bundleRes = await _propagateFulfillTypeToBundle(db, pid, newType, user, payload.jobID);
  } catch (_eBn) {}

  /* ── ④ ขยับ PlannedDate ของแผนจัดส่ง (v12.48) — Code.gs:5172-5199 ── */
  try {
    const custDate = _ymd(job.CustomerDeliveryDate);
    if (custDate) {
      const plans = await db.selectAll('job_deliveries',
        { select: '*', 'JobID': 'eq.' + payload.jobID, order: '_row.asc' }) || [];
      for (const d of plans) {
        const st = clean(d.Status).toLowerCase();
        /* ‼ ปรับเฉพาะที่ยัง planned/preparing — ออกส่งแล้วห้ามขยับ */
        if (st && st !== 'planned' && st !== 'preparing') continue;
        const srcDate = (newType === 'delivery_to_installer')
          ? L._isoAdd(custDate, -1) : custDate;
        await db.update('job_deliveries', { 'DeliveryID': 'eq.' + d.DeliveryID },
          { PlannedDate: srcDate, UpdatedAt: nowD, UpdatedBy: user + ' (FT-change)' });
      }
    }
  } catch (_eAdj) {}

  /* ── log — Code.gs:5202-5210 ── */
  try {
    const ftInfo = FULFILL_TYPES[newType] || {};
    const logLabel = (ftInfo.icon || '🏷️') + ' เปลี่ยนเป็น "' + (ftInfo.thai || newType) + '"';
    await _appendLog(db, payload.jobID, '-', '-', 0, logLabel, user,
      'JobFulfillType → ' + newType + ' · ProjectsSync: ' + (projSyncResult || 'skip') +
      (bundleRes.affected ? ' · BundleSync ' + bundleRes.affected + ' cards' : ''));
  } catch (le) {}

  return {
    success: true, fulfillType: newType, projectsSync: projSyncResult,
    bundleSync: bundleRes.affected, version: L.SOURCE_VERSION,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 *  ⑩ createClaimCard — ต้นฉบับ Code.gs:11554-11691
 *
 *  ‼ กติกาที่ห้ามเพี้ยน:
 *    · เฉพาะ suntorn / namna / admin (CLAIM_CREATE_ALLOWED)
 *    · claimType ต้องเป็น "ผลิต" หรือ "ติดตั้ง" เท่านั้น
 *    · ต้องแนบรูปความเสียหายอย่างน้อย 1 รูป (สูงสุด 3)
 *    · JobID ใหม่ = JOB-yyyyMMdd-HHmmss-CLM
 *    · JobOrderNo = ของเดิม + "-CLAIM" (ถ้าของเดิมว่าง ให้ว่าง)
 *    · JobType = "งานเคลม(ผลิต) = เสียจากผลิต" / "งานเคลม(ติดตั้ง) = เสียจากติดตั้ง" (v13.29)
 *    · การ์ดเคลม "อนุมัติแล้ว" ทันที · OverallStatus = Pending
 *    · สืบทอดสถานะตรวจรับเงินจากใบต้นทาง → สถานีไม่ถูกล็อกรอบัญชี
 *    · สร้างสถานีครบ 16 ใบ "ปิดทั้งหมด" (IsActive=false) ให้คนเปิดเองเฉพาะจุดที่ต้องแก้
 * ═══════════════════════════════════════════════════════════════════ */
function _claimStamp(when) {
  /* ของเดิม Utilities.formatDate(now, TZ='Asia/Bangkok', 'yyyyMMdd-HHmmss')
   * ‼ เดิมที่นี่บวก 7 ชั่วโมงเองแล้วอ่าน getUTC* — ผลถูก แต่พี่เอสั่ง 13 ก.ย. 69
   *   ให้ทุกแอปใช้ "ฟังก์ชันกลางตัวเดียวกัน" ⇒ ย้ายมาเรียก core/thai-date.js */
  const t = require('../../core/thai-date').partsTH(when);
  return t.y + t.m + t.d + '-' + t.hh + t.mm + t.ss;
}

/* 🎨 v1.28.0 เคลมจากกราฟิค-ขาย — ค่าใน ClaimType + ชื่อประเภทงาน (มีคำว่า "เคลม" + "กราฟิค" ⇒ ตัวตรวจทุกจุดจับได้แม้ ClaimType ว่าง) */
const CLAIM_GS = 'กราฟิค-ขาย';
const CLAIM_GS_JOBTYPE = 'งานเคลม(กราฟิค-ขาย) = เสียจากกราฟิก/ขาย';

async function createClaimCard(db, payload) {
  payload = payload || {};
  const user = clean(payload.nickname) || clean(payload.username) || 'user';
  const rawU = String(payload.username || '').toLowerCase().trim();
  if (CLAIM_CREATE_ALLOWED.indexOf(rawU) < 0)
    throw new Error('ไม่มีสิทธิ์สร้าง Card เคลม (เฉพาะฝ่ายผลิต: suntorn / namna / admin)');

  const srcID = clean(payload.jobID);
  if (!srcID) throw new Error('ไม่พบ JobID ของ Card ต้นทาง');
  const claimType = clean(payload.claimType);
  /* 🎨 v1.28.0 พี่เอ: "เพิ่ม Card งานเครมจากกราฟิค-ขาย ให้ด้วยนะ" ⇒ ประเภทที่ 3 = กราฟิค-ขาย (ไฟล์/ข้อมูลผิดจากกราฟิกหรือเซลส์) */
  if (claimType !== 'ผลิต' && claimType !== 'ติดตั้ง' && claimType !== CLAIM_GS)
    throw new Error('ประเภทเคลมต้องเป็น "ผลิต" "ติดตั้ง" หรือ "' + CLAIM_GS + '"');
  const reason = clean(payload.reason);
  const imgs = (payload.images && payload.images.length) ? payload.images.slice(0, 3) : [];
  if (!imgs.length) throw new Error('ต้องแนบรูปความเสียหายอย่างน้อย 1 รูป ก่อนสร้าง Card เคลม');

  const src = await db.one('production_jobs', { select: '*', 'JobID': 'eq.' + srcID });
  if (!src) throw new Error('ไม่พบ Card ต้นทาง: ' + srcID);

  const now = nowISO();
  const newID = 'JOB-' + _claimStamp(now) + '-CLM';

  /* ── อัปรูปความเสียหายขึ้น Drive — Code.gs:11588-11602 ── */
  const claimUrls = [];
  /* 🔴 12 ก.ย. 69 — Drive ของจริงกำลังตอบ 403 (service account ไม่มีโควตาที่เก็บ)
   *   ของเดิมปล่อย error ดิบลอยขึ้นไป ⇒ user เห็นข้อความที่ไม่บอกว่าล้มที่ "ขั้นอัปรูป"
   *   ‼ กติกาพี่เอ: เขียนไม่สำเร็จต้องบอกเสมอว่า "ทำไม" ห้ามกลืน ห้ามทำเหมือนสำเร็จ
   *   ‼ เงื่อนไขการล้มยังเท่าเดิมทุกกรณี (อัปไม่ผ่าน = ไม่สร้างการ์ด) แค่ติดเหตุผลไปด้วย
   *     — ห้ามเปลี่ยนเป็น "ข้ามรูปที่ล้มแล้วไปต่อ" เพราะนั่นคือการเปลี่ยนกติกาของเดิม */
  let upErr = '';
  /* 🔴 12 ก.ย. 69 — ขั้น "อัปไม่ผ่าน" บอกเหตุผลแล้ว (throw ข้างล่าง)
   *   แต่ขั้น "อัปขึ้นแล้วแชร์ไม่ผ่าน" ยังถูกทิ้งเงียบ ๆ อยู่
   *   ‼ รูปความเสียหายถูกส่งต่อเป็น URL ไปโผล่ที่งานหลัก (addClaimRequirement)
   *     ถ้าแชร์ไม่ผ่าน คนที่เปิดงานหลักจะเห็นกรอบแตก ทั้งที่คนสร้างเคลมเห็นว่าสำเร็จ
   *   ‼ ไม่เปลี่ยนกติกาการล้ม — แชร์ไม่ผ่านยังสร้างการ์ดเคลมต่อเหมือนเดิม */
  const shareWhy = [];
  for (let im = 0; im < imgs.length; im++) {
    const b64 = String(imgs[im] || '').replace(/^data:.*?;base64,/, '');
    if (b64.length < 100) continue;                                  // Code.gs:11591
    /* ‼ ของเดิมทิ้งไฟล์ที่เล็กกว่า 50 ไบต์ (setTrashed) — ที่นี่กันตั้งแต่ก่อนอัป */
    let up = null;
    try {
      up = await F.putOnDrive(F.FOLDER.images,
        newID + '_claim_damage_' + (im + 1) + '.jpg', 'image/jpeg', b64);
    } catch (eUp) {
      upErr = String((eUp && eUp.message) || eUp);
      throw new Error('อัปโหลดรูปความเสียหายไม่สำเร็จ (รูปที่ ' + (im + 1) + ') — ' + upErr);
    }
    if (up && up.shareWarning) shareWhy.push('รูปที่ ' + (im + 1) + ': ' + up.shareWarning);
    if (up && up.size >= 50 && up.url) claimUrls.push(up.url);
  }
  if (!claimUrls.length)
    throw new Error('อัปโหลดรูปความเสียหายไม่สำเร็จ — ลองใหม่อีกครั้ง' +
      (upErr ? ' (' + upErr + ')' : ' (ไฟล์ที่ส่งมาเล็กเกินไปหรือเสียหาย)'));

  const noteTxt = '🛠️ งานเคลม(' + claimType + ') จาก ' + srcID + (reason ? ' — สาเหตุ: ' + reason : '');

  const nj = {
    JobID: newID,
    ProjectID: clean(src.ProjectID),
    JobOrderNo: (clean(src.JobOrderNo) ? clean(src.JobOrderNo) + '-CLAIM' : ''),
    JobNumber: clean(src.JobNumber),
    CustomerName: clean(src.CustomerName),
    /* v13.29 — ชื่อประเภทงานต้องตรงกับฝั่ง Projects เป๊ะ ๆ */
    JobType: (claimType === 'ผลิต' ? 'งานเคลม(ผลิต) = เสียจากผลิต' : claimType === CLAIM_GS ? CLAIM_GS_JOBTYPE : 'งานเคลม(ติดตั้ง) = เสียจากติดตั้ง'),
    Project: clean(src.Project),
    SalesPerson: clean(src.SalesPerson),
    Graphic: clean(src.Graphic),
    PaymentSlipNo: clean(src.PaymentSlipNo),
    CustomerDeliveryDate: _ymd(src.CustomerDeliveryDate) || null,
    Description: clean(src.Description),
    MainJobImage: clean(src.MainJobImage),
    ChecklistImg1: clean(src.ChecklistImg1), ChecklistImg2: clean(src.ChecklistImg2), ChecklistImg3: clean(src.ChecklistImg3),
    SiteImg1: clean(src.SiteImg1), SiteImg2: clean(src.SiteImg2), SiteImg3: clean(src.SiteImg3),
    ProductionStartDate: null, DeliveryDate: null, ProductionDays: null,
    ApprovalStatus: 'อนุมัติแล้ว', ApprovedBy: user, ApprovedAt: now,
    OverallStatus: 'Pending', CurrentStation: '', Note: noteTxt,
    CreatedAt: now, CreatedBy: user, UpdatedAt: now, UpdatedBy: user,
    JobFulfillType: clean(src.JobFulfillType),
    DeliveryAddress: clean(src.DeliveryAddress),
    LocationMaps: clean(src.LocationMaps),
    RequirementID: clean(src.RequirementID),
    RequirementName: clean(src.RequirementName),
    RecipientName: clean(src.RecipientName),
    RecipientPhone: clean(src.RecipientPhone),
    WorkGroup: clean(src.WorkGroup),
    ClaimType: claimType,
    ClaimFromJobID: srcID,
    ClaimReason: reason,
    ClaimImg1: claimUrls[0] || '',
    ClaimImg2: claimUrls[1] || '',
    ClaimImg3: claimUrls[2] || '',
    /* สืบทอดสถานะตรวจรับเงิน — Code.gs:11651-11653 */
    [COL_PAYMENT_STATUS]: src[COL_PAYMENT_STATUS] || '',
    [COL_PAYMENT_DATE]: _ymd(src[COL_PAYMENT_DATE]) || null,
    [COL_PAYMENT_BY]: clean(src[COL_PAYMENT_BY]),
  };

  await db.insert('production_jobs', [nj]);

  /* ── สถานีครบ 16 ใบ ปิดทั้งหมด — Code.gs:11665-11671 ──
   *  ‼ ส่ง [] เข้า buildStationRows = "ไม่มี hint" ⇒ IsActive=false ทั้ง 16 ตัว
   *    ตรงกับของเดิมที่ hardcode false ไว้ท้ายแถวเป๊ะ */
  const newStns = buildStationRows(newID, []);
  try {
    await db.insert('job_stations', newStns);
  } catch (e) {
    try { await db.remove('production_jobs', { 'JobID': 'eq.' + newID }); } catch (e2) {}
    throw e;
  }

  /* ── log — Code.gs:11674-11683 ── */
  try {
    await _appendLog(db, newID, '', '🛠️ Card เคลม', 0,
      'สร้าง Card เคลม(' + claimType + ')', user,
      '[' + clean(src.CustomerName) + '] เคลมจาก ' + srcID + (reason ? ' — ' + reason : ''));
  } catch (eLog) {}

  /* 📎 รอบ 180 — พี่เอสั่ง 29 ก.ย. 69: "ตอนที่สร้าง job card แบบ auto หรือ สร้าง job card เอง
   *   ต้องเอา link file งานนี้ ไปใส่ใน job card แต่ละใบ auto เลย"
   *   ⇒ การ์ดเคลมเกิดใหม่ = ส่งไฟล์พิมพ์/ไฟล์ตัดที่กราฟิกอัปไว้ที่การ์ด Project เข้าการ์ดนี้ด้วย (ผลิตซ้ำต้องใช้ไฟล์ชุดเดิม)
   *   ‼ ต่อท้ายหลังสร้างการ์ดเสร็จแล้ว · พังห้ามล้มการสร้างการ์ดเคลม · ตรรกะเดิมไม่แตะ */
  try { await require('../projects/prodfiles').syncProjects(db, [clean(src.ProjectID)], user); }
  catch (ePf) { /* ส่งไฟล์ไม่ติด = การ์ดเคลมยังอยู่ครบ */ }

  /* ═══════════════════════════════════════════════════════════════════
   *  🆕 เคลม "ติดตั้ง" → เปิดโปรเจคย่อยผูกกับงานหลัก — พี่เอสั่ง 12 ก.ย. 69
   *
   *    "ในส่วนที่สร้าง job เคลม จากการติดตั้ง … ให้ทำการ update ไปยัง Projects
   *     หลักของงานนี้ให้ด้วย และต้องให้ระบบจองคิวติดตั้งเห็นงานนี้ ดึงไปสร้าง
   *     แผนจองคิวแบบ auto ได้ … ลดขั้นตอนในการสร้าง project ใหม่ให้กับ user"
   *
   *  ‼ พี่เอเลือกทางเอง: "ให้ไปสร้างเป็น โปรเจคย่อย (Requirements)
   *    ที่ผูกกับงาน projects หลักนะ" · และ "เข้าคิวได้ทันที"
   *
   *  🔴 กติกาสามข้อของจุดนี้:
   *   ① เฉพาะ claimType === 'ติดตั้ง' — เคลมผลิตไม่ต้องมีคิวช่าง จึงไม่ยิง
   *   ② ต่อไม่ติด "ห้ามทำให้ Card เคลมล้ม" — Card คือของหลักที่ user กด
   *      และตอนนี้มันถูกบันทึกลงฐานข้อมูลไปเรียบร้อยแล้วด้วย
   *   ③ ‼ แต่ต้อง "บอกเหตุผล" กลับไปที่หน้าจอเสมอ ห้ามเงียบแล้วขึ้นว่าสำเร็จ
   *      (addClaimRequirement ออกแบบให้ไม่โยน error อยู่แล้ว — try/catch นี้
   *       คือกันเหนียวชั้นสุดท้ายเผื่อ require/ตัวโมดูลพังเอง)
   * ═══════════════════════════════════════════════════════════════════ */
  let claimProject = null;
  if (claimType === 'ติดตั้ง') {
    try {
      claimProject = await CLM.addClaimRequirement(db, {
        projectId:  clean(src.ProjectID),
        claimJobId: newID,
        fromJobId:  srcID,
        reason,
        by:         user,
        images:     claimUrls,
        workGroup:  clean(src.WorkGroup),
      });
    } catch (eReq) {
      claimProject = { ok: false, reason: String((eReq && eReq.message) || eReq) };
    }
  } else if (claimType === CLAIM_GS) {
    /* 🎨 v1.29.1 พี่เอ: "เช็คด้วยว่ากดปุ่มเคลมจากกราฟิค และเซลล์ ทำไมไม่สร้าง project เคลมให้"
     *   ⇒ เปิดโปรเจคย่อย "งานเคลม(กราฟิค-ขาย)" ผูกงานหลัก (ไม่เข้าคิวช่างเอง — ดู claiminstall.js) */
    try {
      claimProject = await CLM.addGsClaimRequirement(db, {
        projectId: clean(src.ProjectID), claimJobId: newID, fromJobId: srcID, reason, by: user, images: claimUrls, workGroup: clean(src.WorkGroup),
      });
    } catch (eReq) {
      claimProject = { ok: false, reason: String((eReq && eReq.message) || eReq) };
    }
  }

  /* 💸 รอบ 186 — พี่เอสั่ง 29 ก.ย. 69: "หลังจากที่สร้างใบเคลมผลิตแล้ว ให้ระบบทำการคำนวณต้นทุนหลังบ้าน
   *   แล้ว update มาที่หน้า card ทุกใบที่เป็นใบเคลม" ⇒ ถ่ายภาพนิ่ง "ยอดประเมิน" (BOM งานเดิม) ทันทีที่ใบเคลมเกิด
   *   ‼ ต่อท้ายหลังสร้างการ์ดเสร็จแล้ว · snapshotEstimate ไม่โยน error · พังห้ามล้มการสร้างการ์ดเคลม · ตรรกะเดิมไม่แตะ
   *   ‼ พี่เอ: "ถ้าไม่มี BOM ก็ให้สร้างใบเคลมได้ปกตินะ แล้วทำปุ่ม sync data BOM ในแต่ละ job card ได้ภายหลัง"
   *     ⇒ ไม่มี BOM = จดว่า "ยังไม่มี BOM" แล้วสร้างการ์ดต่อตามปกติ (ไม่เตือน ไม่ล้ม) · ประเมินทีหลังด้วยปุ่ม 🔄 Sync BOM บนการ์ด */
  try { await require('./claimcost')._t.snapshotEstimate(db, newID); }
  catch (eCc) { /* ประเมินไม่ติด = การ์ดเคลมยังอยู่ครบ · หน้าการ์ดจะประเมินให้อีกรอบตอนเปิดดู */ }

  /* ‼ เหตุผลเรื่องแชร์รูป — เก็บมาจากลูปอัปข้างบน ห้ามทิ้ง */
  const shareWarning = shareWhy.length
    ? ('⚠️ สร้าง Card เคลมสำเร็จ และรูปขึ้น Drive ครบ แต่แชร์ "ทุกคนที่มีลิงก์ดูได้" '
       + 'ไม่สำเร็จ — รูปความเสียหายอาจเปิดไม่ขึ้นให้คนอื่นเห็น · ' + shareWhy.join(' · '))
    : '';

  const out = {
    success: true, jobID: newID, claimType, claimFrom: srcID,
    images: claimUrls.length, customer: clean(src.CustomerName),
    /* null = ไม่ใช่เคลมติดตั้ง (ไม่ต้องมีโปรเจคย่อย) */
    claimProject,
    /* ‼ ช่องนี้คือสิ่งที่หน้าจอต้องเอาขึ้นให้ user เห็น ถ้าต่อเข้างานหลักไม่ได้
     *   ‼ ถ้ามีเรื่องแชร์รูปด้วย ต้องขึ้นทั้งสองเรื่อง ห้ามให้เรื่องหนึ่งกลบอีกเรื่อง */
    warning: [
      (claimProject && !claimProject.ok)
        ? ('⚠️ สร้าง Card เคลมสำเร็จแล้ว แต่เปิดโปรเจคย่อยที่งานหลักไม่ได้ — ' + claimProject.reason)
        : '',
      shareWarning,
    ].filter(Boolean).join(' · '),
    version: L.SOURCE_VERSION,
  };
  /* สองช่องตามกติกาของบ้านนี้ (modules/jobcard/files.js:89) — หน้าจออ่านช่องไหนก็เจอ */
  if (shareWarning) { out.shareWarning = shareWarning; out.warn = shareWarning; }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════
 *  ⑪ cleanupEmptyJobCards — ต้นฉบับ Code.gs:2422-2523 (v12.72)
 *
 *  ‼ กติกาที่ห้ามเพี้ยน:
 *    · เฉพาะ admin / namna / suntorn
 *    · การ์ด Closed ข้ามเสมอ (เก็บประวัติ) — เช็คเฉพาะแถวที่มี JobID
 *    · แถวไม่มี JobID + ทุกช่องว่าง = orphan → ลบ
 *    · แถวมี JobID แต่ 8 ช่องสำคัญว่างหมด = การ์ดผี → ลบ (พร้อมสถานีของมัน)
 *      8 ช่อง: CustomerName · PaymentSlipNo · SalesPerson · JobNumber ·
 *              JobOrderNo · Description · RequirementID · RequirementName
 *      ‼ ProjectID ไม่ได้อยู่ในเงื่อนไขนี้ (ของเดิมอ่านมาแต่ไม่ได้ใช้เช็ค) — ห้ามเพิ่มเอง
 *    · dryRun = ดูอย่างเดียว ไม่ลบ
 * ═══════════════════════════════════════════════════════════════════ */
async function cleanupEmptyJobCards(db, payload) {
  payload = payload || {};
  const u = String(payload.username || '').toLowerCase().trim();
  if (u !== 'admin' && u !== 'namna' && u !== 'suntorn')
    throw new Error('🔒 เฉพาะ admin/namna/suntorn เท่านั้น');

  const dryRun = !!payload.dryRun;
  const rows = await db.selectAll('production_jobs', { select: '*', order: '_row.asc' }) || [];
  const emptyRows = [];
  let orphanRows = 0;

  for (const r of rows) {
    const jid = clean(r.JobID);
    if (jid && clean(r.OverallStatus) === 'Closed') continue;        // Code.gs:2452

    const cust = clean(r.CustomerName), slip = clean(r.PaymentSlipNo);
    const sales = clean(r.SalesPerson), jobNo = clean(r.JobNumber);
    const jobOrd = clean(r.JobOrderNo), desc = clean(r.Description);
    const reqID = clean(r.RequirementID), reqName = clean(r.RequirementName);
    const projID = clean(r.ProjectID);

    if (!jid) {                                                     // Code.gs:2467
      const hasAnyData = !!(cust || slip || sales || jobNo || jobOrd || desc || reqID || reqName || projID);
      if (!hasAnyData) {
        emptyRows.push({
          row: r._row, jobID: '(no-JobID)', _id: r._id,
          createdAt: _dt(r.CreatedAt),
          reason: 'orphan row (JobID + all fields empty)',
        });
        orphanRows++;
      }
      continue;
    }
    /* Code.gs:2483 — ‼ ไม่มี projID ในเงื่อนไข ยกมาตามเดิม */
    if (!cust && !slip && !sales && !jobNo && !jobOrd && !desc && !reqID && !reqName) {
      emptyRows.push({
        row: r._row, jobID: jid, _id: r._id,
        createdAt: _dt(r.CreatedAt),
        reason: 'empty Card (มี JobID แต่ data ว่างทุก field)',
      });
    }
  }

  if (!dryRun && emptyRows.length) {
    for (let d = emptyRows.length - 1; d >= 0; d--) {                // Code.gs:2492 ลบจากล่างขึ้นบน
      const e = emptyRows[d];
      await db.remove('production_jobs', { '_id': 'eq.' + e._id });
      if (e.jobID && e.jobID !== '(no-JobID)') {
        try { await db.remove('job_stations', { 'JobID': 'eq.' + e.jobID }); } catch (_eS) {}
      }
    }
    await _appendLog(db, '-', '-', '-', 0, '🗑️ Cleanup Empty Cards',
      clean(payload.nickname) || clean(payload.username) || 'user',
      'ลบ ' + emptyRows.length + ' rows (orphan=' + orphanRows + ')');
  }

  return {
    success: true, dryRun,
    foundEmpty: emptyRows.length,
    orphanRows,
    withJobIDRows: emptyRows.length - orphanRows,
    deleted: dryRun ? 0 : emptyRows.length,
    details: emptyRows.slice(0, 30),
    version: L.SOURCE_VERSION,
  };
}


module.exports = {
  updateJobDetails, approveJobForProduction, cancelApproval,
  setJobFulfillType, _propagateFulfillTypeToBundle,
  createClaimCard, cleanupEmptyJobCards,
  _canEditCustomerDate, _canDeleteOwn, _canSyncData, _canSync,
  _toBuddhistDate, _updateProjectField, _updateProjStatus, _updateProjectJobStatus,
  _claimStamp,
  CLAIM_CREATE_ALLOWED, SYNC_DATA_ALLOWED, SYNC_ALLOWED, CANCEL_RESET_COLS,
  JOB_STATUS_OPEN,
};
