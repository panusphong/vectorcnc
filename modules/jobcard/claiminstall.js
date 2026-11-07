'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/jobcard/claiminstall.js
 *  งานเคลม(ติดตั้ง) → โปรเจคย่อยของงานหลัก + ประวัติการเคลม
 *
 *  ‼ พี่เอสั่ง 12 ก.ย. 69:
 *    "ในส่วนที่สร้าง job เคลม จากการติดตั้ง ที่หน้า Job card สั่งผลิต
 *     ให้ทำการ update ไปยัง Projects หลักของงานนี้ ให้ด้วยนะ
 *     และต้องให้ ระบบจองคิวติดตั้งเห็นงานนี้ ดึงไปสร้างแผนจองคิวแบบ auto
 *     ได้เหมือนกัน ลดขั้นตอนในการสร้าง project ใหม่ให้กับ user
 *     และต้องเก็บประวัติของ โปรเจคนี้ ว่ามีการเคลมจากการติดตั้งไปแล้วกี่ครั้ง
 *     ช่างคนไหน วันที่เท่าไหร่ ฯลฯ"
 *
 *  ‼ พี่เอเลือกทางเอง: "ให้ไปสร้างเป็น โปรเจคย่อย (Requirements)
 *    ที่ผูกกับงาน projects หลักนะ" · และ "เข้าคิวได้ทันที"
 *
 *  ── ทำไมแยกไฟล์ ────────────────────────────────────────────────
 *  createClaimCard (edit.js) เป็นของที่ยกมาจาก Code.gs 100%
 *  ของใหม่ที่พี่เอสั่งเพิ่มจึงอยู่แยกไฟล์ แล้วให้ตัวเดิม "เรียกออกมา"
 *  ⇒ อ่านง่ายว่าบรรทัดไหนคือของเดิม บรรทัดไหนคือของที่สั่งเพิ่ม
 *  ⇒ และถ้าวันหนึ่งพี่เอสั่งถอด ก็ถอดได้ทั้งก้อนโดยไม่แตะของเดิม
 *
 *  ── 🔴 กฎที่ห้ามละเมิด ─────────────────────────────────────────
 *   ① ห้ามแตะแถวงานหลักใน app.projects แม้แต่ช่องเดียว
 *      (Status/วันที่ของงานหลักคือของจริงในสายงาน — แตะแล้วรายงานเพี้ยน)
 *      งานหลัก "เห็นการเคลม" ผ่านโปรเจคย่อยที่ผูกอยู่แล้ว
 *   ② ต้องตั้ง "Updated At" ทุกครั้งที่เขียน
 *      ตัวซิงก์ชีตตั้ง keepNewerBy: 'Updated At' (core/sync-jobs.js:944)
 *      ไม่ตั้ง = รอบซิงก์ถัดไปชีตทับแถวนี้หาย
 *   ③ สร้างโปรเจคย่อยไม่สำเร็จ "ห้ามทำให้ Card เคลมล้ม"
 *      Card เคลมคือของหลักที่ user กด — รายงานว่าต่อไม่ติด ดีกว่าล้มทั้งงาน
 *   ④ ห้ามเขียนกลับ Google Sheet (กฎเหล็กของทั้งระบบ)
 * ═══════════════════════════════════════════════════════════════════ */

const clean = s => String(s == null ? '' : s).trim();
/* ‼ เวลาปัจจุบันสำหรับบันทึกลง timestamptz — ติดเขตเวลาไทย (+07:00) มาด้วย
 *   พี่เอสั่ง 13 ก.ย. 69: "บันทึกเวลา วันที่ ให้ถูกต้องตามเวลาของไทย 100%"
 *   เดิม new Date().toISOString() = ตัวอักษร UTC — จุดเวลาเดียวกันก็จริง แต่ใครก็ตาม
 *   ที่อ่านค่าดิบแล้วตัดสตริงเอาชั่วโมง จะได้ชั่วโมง UTC (ช้ากว่าไทย 7 ชม.)
 *   ⇒ ใช้ฟังก์ชันกลางที่เดียวของทั้งระบบ: core/thai-date.js */
const nowISO = () => require('../../core/thai-date').isoTH();

/* 🔴 วัน/เวลาที่ "คนอ่าน" ต้องเป็นเวลาไทยเสมอ — เซิร์ฟเวอร์รันเป็น UTC
 *   ห้ามตัดสตริง ISO เอาเอง และห้าม toLocale*String ที่ไม่ระบุโซน
 *   (บทเรียนจริง: claude/บั๊กเขตเวลา-วันนี้ต้องเป็นเวลาไทย.md)
 *   ‼ ที่เก็บลงฐานข้อมูลยังเป็น ISO/UTC เหมือนเดิม — แปลงเฉพาะ "ตอนส่งออกไปแสดง" */
const { stampTH, todayTH } = require('../../core/thai-date');
/** เวลาไทยแบบอ่านง่าย 'DD/MM/YYYY HH:mm' — ค่าว่างต้องได้ค่าว่าง ไม่ใช่ 01/01/1970 */
const showTH = v => (clean(v) ? stampTH(new Date(v)) : '');
/** วันที่ไทย 'YYYY-MM-DD' — กุญแจวันเดียวกับที่แอปจองคิวใช้ (plan.js dateKey) */
const ymdTH = v => (clean(v) ? todayTH(new Date(v)) : '');

/** ‼ ชื่อประเภทงานต้องตรงกับที่ Projects ใช้เป๊ะ (modules/projects/lib.js:107)
 *    พิมพ์ต่างแม้แต่ตัวเดียว = หน้า Projects มองไม่เห็นว่านี่คืองานเคลม */
const CLAIM_JOB_TYPE = 'งานเคลม(ติดตั้ง) = เสียจากติดตั้ง';

/** เพดานการอ่านประวัติเคลมของงานหลัก 1 ใบ — ‼ ทุกคำขอต้องมีลิมิต (กฎเหล็ก) */
const HISTORY_LIMIT = 200;

/** id 8 ตัว hex ตัวแรกเป็นตัวอักษรเสมอ — กติกาเดียวกับ modules/projects/lib.js:287
 *  ‼ ห้ามเปลี่ยนรูปแบบ ไม่งั้น ID ใหม่หน้าตาไม่เหมือนของเดิม
 *    แล้วแอปที่จับคู่ด้วย ID จะงง */
function genId8() {
  const hex = '0123456789abcdef', letters = 'abcdef';
  let s = letters.charAt(Math.floor(Math.random() * 6));
  for (let i = 1; i < 8; i++) s += hex.charAt(Math.floor(Math.random() * 16));
  return s;
}

/** แถวถัดไปของตาราง — กติกาเดียวกับ modules/projects/index.js:167 */
async function nextRow(db, table) {
  const r = await db.select(table, { select: '_row', order: '_row.desc', limit: 1 });
  return (Array.isArray(r) && r[0] ? Number(r[0]._row) : 0) + 1;
}

/* ═══════════════════════════════════════════════════════════════════
 *  เคลมครั้งที่เท่าไหร่ของโปรเจคนี้
 *  ‼ นับที่ฐานข้อมูล ไม่ดึงแถวมานับ (กฎเหล็ก "ถามฐานข้อมูลให้แคบ")
 * ═══════════════════════════════════════════════════════════════════ */
async function claimCount(db, projectId) {
  const pid = clean(projectId);
  if (!pid) return 0;
  /* 🔴 ห้ามกลืน error แล้วคืน 0 (ของเดิมเขียนไว้แบบนั้น — แก้แล้ว 12 ก.ย. 69)
   *   นับไม่ได้แล้วคืน 0 = "เคลมครั้งที่ 1" ซ้ำกับใบเดิมเงียบ ๆ ทั้งที่มีมาแล้ว 3 ครั้ง
   *   ⇒ ปล่อยให้โยนขึ้นไป แล้ว addClaimRequirement รายงานเหตุผลกลับหน้าจอ
   *     (กฎพี่เอ: เขียนไม่สำเร็จต้องบอกเสมอว่าทำไม) */
  return await db.count('requirements', {
    project_id: 'eq.' + pid,
    claim_seq: 'not.is.null',
  });
}

/* ═══════════════════════════════════════════════════════════════════
 *  สร้างโปรเจคย่อย "งานเคลม(ติดตั้ง)" ผูกกับงานหลัก
 *
 *  คืนค่าเสมอ ไม่โยน error — ตัวเรียก (createClaimCard) ต้องไม่ล้ม
 *  { ok, requirementId, seq, reason }
 * ═══════════════════════════════════════════════════════════════════ */
async function addClaimRequirement(db, opt) {
  opt = opt || {};
  const projectId = clean(opt.projectId);
  if (!projectId) return { ok: false, reason: 'ใบต้นทางไม่มี ProjectID — ต่อเข้างานหลักไม่ได้' };

  const claimJobId = clean(opt.claimJobId);
  const fromJobId  = clean(opt.fromJobId);
  const by         = clean(opt.by);
  const reasonTxt  = clean(opt.reason);
  const imgs       = Array.isArray(opt.images) ? opt.images : [];

  try {
    /* ‼ งานหลักต้องมีอยู่จริง — ไม่งั้นโปรเจคย่อยจะลอยไม่มีพ่อแม่
     *   (ถามแคบ: เอาเฉพาะช่องที่ใช้ ไม่ select *) */
    const proj = await db.one('projects', {
      select: '"ID","Project","ประเภทงาน"',
      'ID': 'eq.' + projectId,
    });
    if (!proj) return { ok: false, reason: 'ไม่พบงานหลัก ' + projectId + ' ในตาราง Projects' };

    const seq = (await claimCount(db, projectId)) + 1;
    const rid = genId8();

    /* ชื่อโปรเจคย่อย — ต้องอ่านแล้วรู้ทันทีว่าเคลมครั้งที่เท่าไหร่ จากใบไหน */
    const name = 'เคลมติดตั้ง ครั้งที่ ' + seq +
                 (fromJobId ? ' — จาก ' + fromJobId : '') +
                 (reasonTxt ? ' · ' + reasonTxt : '');

    const brief = [
      '🛠️ งานเคลม(ติดตั้ง) ครั้งที่ ' + seq + ' ของงานนี้',
      fromJobId  ? 'เคลมจากใบงาน: ' + fromJobId : '',
      claimJobId ? 'Card เคลมที่สร้าง: ' + claimJobId : '',
      reasonTxt  ? 'สาเหตุ: ' + reasonTxt : '',
      by ? 'ผู้สร้าง: ' + by : '',
    ].filter(Boolean).join('\n');

    const row = {
      requirement_id: rid,
      project_id: projectId,
      requirement_name: name,
      job_type: CLAIM_JOB_TYPE,
      /* ‼ "Not started" คือค่าเดียวกับที่หน้า Projects ใช้ตอนเปิดงานย่อยใหม่
       *   (modules/projects/index.js:239) — ห้ามคิดค่าใหม่เอง */
      status: 'Not started',
      brief_detail: brief,
      work_group: clean(opt.workGroup),
      quantity: 1,
      /* ── ประวัติการเคลม (sql/59) ── */
      claim_seq: seq,
      claim_job_id: claimJobId,
      claim_from_job_id: fromJobId,
      claim_reason: reasonTxt,
      claim_by: by,
      claim_at: nowISO(),
      claim_img1: clean(imgs[0]),
      claim_img2: clean(imgs[1]),
      claim_img3: clean(imgs[2]),
      /* รูปของงานย่อย = รูปความเสียหายใบแรก (ช่างเปิดดูได้จากแผนจองคิว) */
      image: clean(imgs[0]),
      /* 🔴 ห้ามลืม — ตัวซิงก์ชีตตั้ง keepNewerBy: 'Updated At'
       *   ไม่ตั้ง = รอบซิงก์ถัดไปชีตทับแถวนี้หายเงียบ ๆ */
      'Updated At': nowISO(),
      _row: await nextRow(db, 'requirements'),
      _synced_at: nowISO(),
    };

    await db.insert('requirements', [row]);
    return { ok: true, requirementId: rid, seq, projectId, jobType: CLAIM_JOB_TYPE };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/* ═══════════════════════════════════════════════════════════════════
 *  🎨 v1.29.1 (7 พ.ย. 69) เคลม "กราฟิค-ขาย" → โปรเจคย่อยของงานหลัก
 *  พี่เอ: "เช็คด้วยว่ากดปุ่มเคลมจากกราฟิค และเซลล์ ทำไมไม่สร้าง project เคลมให้"
 *   ต้นเหตุ: ตั้งแต่ 12 ก.ย. เปิดโปรเจคย่อยให้เฉพาะเคลมติดตั้ง · v1.28.0 เพิ่มเคลมกราฟิค-ขาย แต่ไม่ได้ต่อสายนี้
 *   ⇒ เปิดโปรเจคย่อย "งานเคลม(กราฟิค-ขาย)" ผูกงานหลัก (เห็นใน Projects · มีประวัติ · รูปความเสียหาย)
 *   ‼ ไม่ใส่ claim_seq — ระบบจองคิวดึงแถวที่มี claim_seq เข้าคิวติดตั้งอัตโนมัติ (booking/autoimport.js)
 *     เคลมกราฟิค-ขาย = ผลิต/แก้ไฟล์ใหม่ ไม่ได้เข้าคิวช่างเอง (ต้องติดตั้งซ้ำ ⇒ จองคิวตามปกติ)
 *   ‼ กฎเดิมครบ: ไม่แตะงานหลัก · ตั้ง Updated At · ไม่โยน error (การ์ดเคลมต้องไม่ล้ม)
 * ═══════════════════════════════════════════════════════════════════ */
const CLAIM_GS_JOB_TYPE = 'งานเคลม(กราฟิค-ขาย) = เสียจากกราฟิก/ขาย';
async function addGsClaimRequirement(db, opt) {
  opt = opt || {};
  const projectId = clean(opt.projectId);
  if (!projectId) return { ok: false, reason: 'ใบต้นทางไม่มี ProjectID — ต่อเข้างานหลักไม่ได้' };
  const claimJobId = clean(opt.claimJobId), fromJobId = clean(opt.fromJobId), by = clean(opt.by), reasonTxt = clean(opt.reason);
  const imgs = Array.isArray(opt.images) ? opt.images : [];
  try {
    const proj = await db.one('projects', { select: '"ID","Project"', 'ID': 'eq.' + projectId });
    if (!proj) return { ok: false, reason: 'ไม่พบงานหลัก ' + projectId + ' ในตาราง Projects' };
    /* กันซ้ำ: การ์ดเคลมใบเดียวกัน = โปรเจคย่อยเดียว */
    if (claimJobId) {
      const dup = await db.one('requirements', { select: 'requirement_id', project_id: 'eq.' + projectId, claim_job_id: 'eq.' + claimJobId });
      if (dup) return { ok: true, requirementId: clean(dup.requirement_id), existed: true, projectId, jobType: CLAIM_GS_JOB_TYPE };
    }
    const seq = (await db.count('requirements', { project_id: 'eq.' + projectId, job_type: 'eq.' + CLAIM_GS_JOB_TYPE })) + 1;
    const rid = genId8();
    const name = 'เคลมกราฟิค-ขาย ครั้งที่ ' + seq + (fromJobId ? ' — จาก ' + fromJobId : '') + (reasonTxt ? ' · ' + reasonTxt : '');
    const brief = [
      '🎨 งานเคลม(กราฟิค-ขาย) ครั้งที่ ' + seq + ' ของงานนี้ — ไฟล์/ข้อมูลผิดจากกราฟิกหรือเซลส์',
      fromJobId ? 'เคลมจากใบงาน: ' + fromJobId : '',
      claimJobId ? 'Card เคลมที่สร้าง: ' + claimJobId : '',
      reasonTxt ? 'สาเหตุ: ' + reasonTxt : '',
      by ? 'ผู้สร้าง: ' + by : '',
    ].filter(Boolean).join('\n');
    const row = {
      requirement_id: rid, project_id: projectId, requirement_name: name, job_type: CLAIM_GS_JOB_TYPE,
      status: 'Not started', brief_detail: brief, work_group: clean(opt.workGroup), quantity: 1,
      claim_job_id: claimJobId, claim_from_job_id: fromJobId, claim_reason: reasonTxt, claim_by: by, claim_at: nowISO(),
      claim_img1: clean(imgs[0]), claim_img2: clean(imgs[1]), claim_img3: clean(imgs[2]), image: clean(imgs[0]),
      'Updated At': nowISO(), _row: await nextRow(db, 'requirements'), _synced_at: nowISO(),
    };
    await db.insert('requirements', [row]);
    return { ok: true, requirementId: rid, seq, projectId, jobType: CLAIM_GS_JOB_TYPE };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/* ═══════════════════════════════════════════════════════════════════
 *  🎨 v1.29.1 เติมย้อนหลัง — ใบเคลมกราฟิค-ขายที่สร้างก่อนแก้ (31 ต.ค.–7 พ.ย. 69) ยังไม่มีงานย่อยเคลม
 *  ‼ รันครั้งเดียวหลังเปิดเครื่อง · อ่าน 2 คำขอทั้งกอง (มีลิมิต) · เติมเฉพาะใบที่ยังไม่มี · ไม่โยน error
 * ═══════════════════════════════════════════════════════════════════ */
async function backfillGsClaimRequirements(db, opt) {
  opt = opt || {};
  const out = { ok: true, checked: 0, created: 0, skipped: 0, errors: [] };
  try {
    const cards = await db.select('production_jobs', {
      select: '"JobID","ProjectID","ClaimFromJobID","ClaimReason","CreatedBy","ClaimImg1","ClaimImg2","ClaimImg3","WorkGroup"',
      ClaimType: 'eq.กราฟิค-ขาย', order: '"CreatedAt".asc', limit: opt.limit || 300,
    }) || [];
    out.checked = cards.length;
    if (!cards.length) return out;
    const have = await db.select('requirements', { select: 'claim_job_id', job_type: 'eq.' + CLAIM_GS_JOB_TYPE, limit: 2000 }) || [];
    const done = new Set(have.map(r => clean(r.claim_job_id)).filter(Boolean));
    for (const c of cards) {
      const jid = clean(c.JobID);
      if (!jid || done.has(jid) || !clean(c.ProjectID)) { out.skipped++; continue; }
      const r = await addGsClaimRequirement(db, {
        projectId: c.ProjectID, claimJobId: jid, fromJobId: c.ClaimFromJobID, reason: c.ClaimReason, by: c.CreatedBy,
        images: [c.ClaimImg1, c.ClaimImg2, c.ClaimImg3].filter(Boolean), workGroup: c.WorkGroup,
      });
      if (r.ok && !r.existed) out.created++; else if (!r.ok) out.errors.push(jid + ': ' + r.reason); else out.skipped++;
      done.add(jid);
    }
  } catch (e) { out.ok = false; out.errors.push(String((e && e.message) || e)); }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════
 *  ประวัติการเคลม(ติดตั้ง) ของงานหลักหนึ่งใบ
 *
 *  พี่เอสั่ง: "เก็บประวัติของโปรเจคนี้ ว่ามีการเคลมจากการติดตั้งไปแล้วกี่ครั้ง
 *             ช่างคนไหน วันที่เท่าไหร่ ฯลฯ"
 *
 *  ‼ "ช่างคนไหน · วันที่เท่าไหร่" อยู่ที่แผนจองคิว ไม่ได้อยู่ที่โปรเจคย่อย
 *    ⇒ ต่อสองที่เข้าด้วยกันด้วย SourceProjectID = requirement_id
 *      (ตัวเดียวกับที่ระบบจองคิวใช้กันซ้ำ — ดู modules/booking/autoimport.js)
 *
 *  ‼ อ่านแผนจองคิว "ครั้งเดียวทั้งกอง" ไม่ยิงทีละใบ
 *    (กฎเหล็ก — บทเรียนบอร์ด 64.7 วินาที)
 *  ‼ แผนจองคิวอ่านไม่ได้ ต้องไม่ทำให้ประวัติทั้งก้อนพัง — คืนเท่าที่มี
 * ═══════════════════════════════════════════════════════════════════ */
async function claimHistory(db, projectId) {
  const pid = clean(projectId);
  if (!pid) return { success: false, ok: false, error: 'ไม่ได้ระบุ ProjectID' };

  let reqs = [];
  try {
    reqs = await db.select('requirements', {
      select: 'requirement_id,requirement_name,job_type,status,claim_seq,claim_job_id,' +
              'claim_from_job_id,claim_reason,claim_by,claim_at,claim_img1,claim_img2,claim_img3,' +
              'started_at,completed_at',
      project_id: 'eq.' + pid,
      claim_seq: 'not.is.null',
      order: 'claim_seq.asc',
      /* ‼ ทุกคำขอต้องมี "ตัวกรอง + ลิมิต" เสมอ (กฎเหล็ก · บทเรียนบอร์ดค้าง)
       *   งานหลักใบเดียวเคลมเกิน 200 ครั้งคือเรื่องผิดปกติที่ต้องไปดูด้วยตา
       *   ไม่ใช่เรื่องที่หน้าจอควรลากมาทั้งกองเงียบ ๆ */
      limit: HISTORY_LIMIT,
    }) || [];
  } catch (e) {
    return { success: false, ok: false, error: 'อ่านประวัติเคลมไม่ได้: ' + ((e && e.message) || e) };
  }

  /* ── ต่อกับแผนจองคิว เพื่อรู้ "ช่างคนไหน · วันที่เท่าไหร่" ── */
  const byReq = {};
  let planError = '';
  if (reqs.length) {
    const ids = reqs.map(r => clean(r.requirement_id)).filter(Boolean);
    try {
      /* 🔴 COL ของแผนจองคิวอยู่ที่ modules/booking/db ไม่ใช่ config
       *   (db.js:‘firstAlias’ แปลง alias หลายชื่อ → ชื่อคอลัมน์จริงตัวเดียว
       *    และแก้ข้อยกเว้น COL.inspector = 'ช่างติดตั้ง' ที่ PostgreSQL ตัดชื่อ 63 ไบต์)
       *   ‼ ของเดิมในไฟล์นี้เขียน require('../booking/config').COL ซึ่ง "ไม่มีจริง"
       *     ⇒ undefined ทั้งก้อน ⇒ ประวัติไม่เคยมีช่าง/วันที่เลยสักใบ แบบไม่มี error */
      const BK = require('../booking/db');
      const COL = BK.COL;
      /* ‼ นี่คือรอยต่อที่พี่เอเลือกทาง Requirements เพื่อให้ได้:
       *   แผนจองคิวกันซ้ำด้วย SourceProjectID ⇒ แถวเคลมใช้ requirement_id เป็นรหัส
       *   ⇒ join กลับมาที่นี่ด้วยกุญแจตัวเดียวกันเป๊ะ */
      const plans = await BK.byIds(BK.T.PLAN, COL.sourceProjectId, ids, {
        /* ถามเฉพาะช่องที่ใช้ ไม่ select '*' — แถวคิวมีเป็นร้อยคอลัมน์ */
        select: [COL.id, COL.sourceProjectId, COL.inspector, COL.inspectorNickname,
                 COL.date, COL.status].map(c => '"' + c + '"').join(','),
      }) || [];
      for (const p of plans) {
        const k = clean(p[COL.sourceProjectId]);
        if (!k) continue;
        byReq[k] = {
          planId:     clean(p[COL.id]),
          ช่างติดตั้ง: clean(p[COL.inspectorNickname]) || clean(p[COL.inspector]),
          /* 🔴 "แผนวันที่ติดตั้ง" เป็น timestamptz — ส่ง ISO ดิบออกหน้าจอ = เวลา UTC
           *   งานเย็นวันที่ 12 จะกลายเป็นวันที่ 11 ให้คนอ่าน ⇒ แปลงเป็นวันไทยก่อนเสมอ */
          วันที่ติดตั้ง: ymdTH(p[COL.date]),
          สถานะคิว:   clean(p[COL.status]),
        };
      }
    } catch (e) {
      /* แผนจองคิวอ่านไม่ได้ = ยังคืนประวัติส่วนที่มีให้ครบ
       * ‼ แต่ต้องบอกว่าทำไมช่อง "ช่าง/วันที่" ว่าง ห้ามเงียบให้คนเดาเอง */
      planError = 'อ่านแผนจองคิวไม่ได้: ' + String((e && e.message) || e);
    }
  }

  const items = reqs.map(r => ({
    ครั้งที่:      Number(r.claim_seq) || 0,
    requirementId: clean(r.requirement_id),
    ชื่องานย่อย:   clean(r.requirement_name),
    เคลมจากใบงาน:  clean(r.claim_from_job_id),
    Cardเคลมที่สร้าง: clean(r.claim_job_id),
    สาเหตุ:        clean(r.claim_reason),
    ผู้สร้าง:       clean(r.claim_by),
    /* 🔴 เวลาไทยเท่านั้นสำหรับคนอ่าน · ISO ดิบแนบไว้ให้หน้าจอเรียงลำดับ */
    วันที่สร้าง:    showTH(r.claim_at),
    claimAtISO:    clean(r.claim_at),
    สถานะงานย่อย:  clean(r.status),
    รูปความเสียหาย: [r.claim_img1, r.claim_img2, r.claim_img3].map(clean).filter(Boolean),
    คิวช่าง: byReq[clean(r.requirement_id)] || null,
  }));

  return {
    /* success = ธรรมเนียม JSON ของทุก endpoint ในแอปนี้ · ok = ของเดิมในไฟล์นี้
     *   คงไว้ทั้งคู่ หน้าจอเช็คตัวไหนก็ได้ */
    success: true,
    ok: true,
    projectId: pid,
    เคลมติดตั้งทั้งหมด: items.length,
    รายการ: items,
    /* ‼ ว่าง = ต่อกับแผนจองคิวได้ครบ · มีข้อความ = ช่อง "ช่าง/วันที่" ว่างเพราะอ่านไม่ได้
     *   (ไม่ใช่เพราะยังไม่ได้จองช่าง) — หน้าจอต้องแยกสองกรณีนี้ให้ user เห็น */
    planError,
  };
}

module.exports = { addClaimRequirement, addGsClaimRequirement, backfillGsClaimRequirements, claimHistory, claimCount, CLAIM_JOB_TYPE, CLAIM_GS_JOB_TYPE, genId8 };
