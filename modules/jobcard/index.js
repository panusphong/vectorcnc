'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  โมดูล "Job Card สั่งผลิต" — ยกจากแอป Apps Script เดิม
 *
 *  ‼ พี่เอสั่ง 9 ก.ย. 69:
 *    "Copy code เก่าของ app เดิมมาเขียน 100% นะ"
 *    "จำไว้นะ ต้อง copy code เหมือนเดิม 100% ห้ามเปลี่ยนอะไร ห้ามแก้อะไรด้วยนะ"
 *
 *  ต้นฉบับ: _source/jobcard/Code.gs  16,598 บรรทัด · 289 ฟังก์ชัน
 *           v13.34-FIX-DLV-PROOF-2026-09-03
 *  ‼ ยืนยัน 9 ก.ย. 69: ตรงกับที่ deploy อยู่ใน Apps Script 100% (diff = 0 บรรทัด)
 *  ทุก endpoint จดชื่อฟังก์ชันเดิม + เลขบรรทัดไว้ ตรวจทีละตัวได้
 *
 *  ── ขอบเขตเฟส 1 (พี่เอเลือกเอง 9 ก.ย. 69) ────────────────────────
 *   ✅ บอร์ดผลิต 16 สถานี · 4 ขั้นงาน · กฎล็อกครบ
 *   ✅ วางแผน + สร้างการ์ด 8 ด่าน + Auto สร้าง Job (ปุ่มที่พี่เอวงไว้)
 *   ✅ รูป QC · ไฟล์ผลิต · PDF · ลิงก์นอก · งานย่อยในการ์ด
 *   ✅ เครื่องมือวินิจฉัย whyNoJobCard / whereIsMyCard
 *   ✅ แผนจัดส่ง 🚚 + จัดซื้อ 🛒 (เฟส 3)
 *   ⏳ ซ่อมบำรุง+PM · แชท · ลางาน · งานเชื่อม (เฟส 4 — แยกเป็นแอปของตัวเอง)
 *      ‼ ไม่ได้ตัดทิ้งเงียบ ๆ — endpoint ตอบกลับเป็นข้อความบอกว่ายังไม่ย้าย
 *        และหน้าจอขึ้นปุ่มจาง ๆ ให้เห็น (พี่เอจะได้ไม่นึกว่าหาย)
 *
 *  ── 3 อย่างที่ทำต่างจากเดิม และทำไม (ไม่ใช่ของที่คิดเพิ่มเอง) ────
 *   ① ข้อมูลลง Supabase ไม่ใช่ชีต — กฎเหล็กของพี่เอ (6 ก.ย. 69)
 *      ชีตเดิมยังทำงานของมันต่อไป ระบบใหม่ไม่เขียนกลับแม้แต่ช่องเดียว
 *   ② ตัวตนผู้ใช้มาจากการล็อกอินของ Hub ไม่ใช่ ?u=<username>
 *      ของเดิมเชื่อ ?u= ตรง ๆ ใครแก้ URL ก็เป็นแอดมินได้
 *   ③ ตัวตั้งเวลา (ScriptApp trigger) ไม่มีในระบบใหม่ — ใช้ตัวตั้งเวลาของ
 *      เซิร์ฟเวอร์แทน ผ่าน POST /api/auto-create (server.js เรียกตามรอบ)
 * ═══════════════════════════════════════════════════════════════════ */

const L = require('./lib');
const C = require('./create');
const B = require('./board');
const F = require('./files');
const RP = require('./reports');
const DLV = require('./delivery');
const PUR = require('./purchase');
/* ── เฟส 4 (9 ก.ย. 69) — โมดูลตรรกะเขียน+ทดสอบไว้ครบแล้ว รอบนี้แค่ "ต่อสาย" ──
 *  ‼ ไม่มีการยกโค้ดซ้ำ ไม่มีการแก้ตรรกะแม้แต่บรรทัดเดียว
 *    ทุก endpoint เรียกฟังก์ชันเดิมตรง ๆ ด้วยชื่อและลำดับพารามิเตอร์เดิม */
const E = require('./edit');
const SY = require('./sync');
const RPR = require('./repair');
const CR = require('./crew');
const DF = require('./drivefiles');
const DLV2 = require('./delivery2');
/* 🆕 12 ก.ย. 69 — ประวัติการเคลม(ติดตั้ง) ของงานหลัก
 *   พี่เอสั่ง: "ต้องเก็บประวัติของโปรเจคนี้ ว่ามีการเคลมจากการติดตั้งไปแล้วกี่ครั้ง
 *              ช่างคนไหน วันที่เท่าไหร่ ฯลฯ ให้กับพี่ด้วย" */
const CLM = require('./claiminstall');
/* ── ทางเข้าแบบ "ชื่อฟังก์ชัน" ให้หน้าเว็บต้นฉบับ (10 ก.ย. 69) ──────────
 *  หน้าเว็บที่ยกมาทั้งดุ้นเรียกหลังบ้านด้วยชื่อฟังก์ชัน ไม่ใช่ path
 *  ‼ ไม่ได้ยกตรรกะซ้ำ — rpc.js ชี้กลับมาที่โมดูลชุดเดียวกันข้างบนนี้ */
const rpc = require('./rpc');
const PAGE_FUNCTIONS = require('./page-functions');

const clean = s => String(s == null ? '' : s).trim();
/** ผู้ใช้ที่ล็อกอินอยู่ → username (แทน ?u= ของเดิม) */
const userOf = req => clean(req.user && req.user.username).toLowerCase();
const nickOf = req => clean(req.user && (req.user.nickname || req.user.name));

/** ห่อ handler ให้ error กลายเป็น JSON เสมอ — ของเดิมคืน JSON string ทุกกรณีเหมือนกัน */
const wrap = fn => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (e) { res.status(400).json({ success: false, error: String(e.message || e), version: L.SOURCE_VERSION }); }
};

/** เมนูที่แยกออกไปเป็นแอปของตัวเองแล้ว — บอกทางไปแอปนั้น ไม่ใช่ 404 เงียบ ๆ
 *  ‼ ห้ามลบบรรทัดพวกนี้: ของเก่าที่ยังยิงมาที่ Job Card ต้องได้คำตอบที่อ่านรู้เรื่อง */
const movedTo = (name, path) => (_req, res) => res.status(501).json({
  success: false, notMigrated: true, movedTo: path, feature: name,
  error: `เมนู "${name}" แยกออกไปเป็นแอปของตัวเองแล้ว — ไม่ได้อยู่ใน Job Card`,
  hint: `ไปที่ ${path}`,
});


async function mount(router, ctx) {
  const { db } = ctx;
  const express = require('express');
  /* รูป QC ส่งมาเป็น data URL — 8 รูปต่อสถานี · ไฟล์ผลิตใหญ่กว่านั้น */
  router.use(express.json({ limit: '25mb' }));

  /* ═══════════════════════════════════════════════════════════════
   *  ⑴ บอร์ดผลิต — getBoardData (Code.gs:1353)
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/board', wrap(async req => {
    const r = await B.getBoardData(db, {
      showClosed: req.query.showClosed,
      showCancelled: req.query.showCancelled,
      /* 🆕 พี่เอสั่ง 10 ก.ย. 69 — เปิดหน้ามาให้โหลดเฉพาะ "งานค้าง" (ยังไม่จบทุกสถานี)
       *  ‼ ตั้งต้นเป็น "เอาเฉพาะงานค้าง" — ต้องส่ง pendingOnly=false มาเท่านั้น
       *    ถึงจะได้งานที่จบครบทุกสถานีติดมาด้วย (หน้าจอมีตัวเลือกให้เลือกอยู่) */
      pendingOnly: req.query.pendingOnly === undefined ? true
                 : !(req.query.pendingOnly === 'false' || req.query.pendingOnly === false),
    });
    /* ── ‼ เก็บตกรอบสาม 10 ก.ย. 69 — สิทธิ์ "รายการ์ด" ติดมากับการ์ดเลย ────
     *  ของเดิมหน้าจอตัดสินเองด้วย _canEditDateFE / _canManageDeliveryFE
     *  (Index.html:3156 · 3174) ซึ่ง "ฝังรายชื่อคน 9 คนไว้ในหน้าเว็บ"
     *  ‼ ระบบใหม่ห้ามทำแบบนั้นเด็ดขาด (test-jc-wire ⑪ คุมไว้ และของเดิมก็เคย
     *    เพี้ยนจนกลายเป็น "เห็นปุ่มแต่กดไม่ได้")
     *  ⇒ ให้เซิร์ฟเวอร์ตัดสินด้วย "ตัวตัดสินตัวจริงตัวเดียวกับที่บังคับ"
     *    แล้วส่งเป็น true/false มาให้หน้าจอใช้ซ่อน/เปิดปุ่มแทน
     *    _canEditCustomerDate (edit.js) · canEditDelivery (delivery.js) */
    for (const j of (r.jobs || [])) {
      j.canEditCustomerDate = E._canEditCustomerDate(userOf(req), nickOf(req), j.salesPerson);
      j.canSetFulfillType   = DLV.canEditDelivery(userOf(req), nickOf(req), j.salesPerson);
    }
    return r;
  }));

  /* ═══════════════════════════════════════════════════════════════
   *  ⑵ กดสถานี 4 ขั้น — clickStation (Code.gs:2835)
   *     rollbackStation (Code.gs:2946) · toggleStationActive (Code.gs:3133)
   * ═══════════════════════════════════════════════════════════════ */
  router.post('/api/station/click', wrap(async req =>
    await B.clickStation(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));

  router.post('/api/station/rollback', wrap(async req =>
    await B.rollbackStation(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));

  router.post('/api/station/toggle', wrap(async req =>
    await B.toggleStationActive(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));

  /* ═══════════════════════════════════════════════════════════════
   *  ⑶ วางแผน + สร้างการ์ด — getProjectsForPlanning (Code.gs:4128)
   *     createJobsFromProjects (Code.gs:4311)
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/planning', wrap(async req =>
    await C.getProjectsForPlanning(db, {
      from: req.query.from, to: req.query.to,
      daysBack: req.query.daysBack, daysAhead: req.query.daysAhead,
      salesPerson: req.query.salesPerson,
    })));

  router.post('/api/create', wrap(async req =>
    await C.createJobsFromProjects(db, Object.assign({}, req.body, {
      username: nickOf(req) || userOf(req),
    }))));

  /* 🆕 ปุ่ม "Auto สร้าง Job" (สีม่วง) ที่พี่เอวงไว้ในภาพ
   *    autoCreateJobsFromCompleteProjects (Code.gs:4693)
   *    ‼ ช่วงวันที่แคบกว่าหน้าวางแผน: ±2 วัน จากวัน Complete */
  router.post('/api/auto-create', wrap(async req =>
    await C.autoCreateJobsFromCompleteProjects(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));

  /* 🆕 1.25.0 ด่านบรีฟ (กระดุมเม็ดแรกต้องอนุมัติครบทุกคนก่อนสั่งผลิต) — ตัวตัดสินอยู่ใน create.js (เซิร์ฟเวอร์)
   *   เส้นข้างล่างนี้ให้หน้าจอ: ติดป้าย 🔒 บนการ์ดโปรเจกต์ในหน้าวางแผน (คำขอเดียวต่อชุด) · ขอ/อนุมัติข้ามด่าน · ตั้งค่า
   *   ‼ อนุมัติข้ามด่าน/ตั้งค่า = admin · namna · suntorn เท่านั้น (briefgate.canDecide — ไม่ใช่สิทธิ์ Administrator) */
  const BG = require('../omnichat/briefgate');
  if (ctx.audit) BG.setAudit((me, action, detail) => ctx.audit({ username: me.username, role: me.role || '' }, action, detail));
  const bgMe = req => ({ username: userOf(req), name: nickOf(req) || userOf(req), role: clean(req.user && req.user.role) });
  router.post('/api/brief-gate', wrap(async req => {
    const ps = (Array.isArray((req.body || {}).projects) ? req.body.projects : []).slice(0, 300);
    const g = await BG.check(db, ps);
    return { success: g.ok !== false, error: g.error || '', byProject: g.byProject, settings: g.settings, canDecide: BG.canDecide(bgMe(req)),
      pending: await BG.pendingCount(db, bgMe(req)), version: L.SOURCE_VERSION };
  }));
  router.get('/api/brief-overrides', wrap(async req => Object.assign({ success: true }, await BG.list(db, bgMe(req), req.query || {}))));
  router.post('/api/brief-override/request', wrap(async req => Object.assign({ success: true }, await BG.request(db, bgMe(req), req.body || {}))));
  router.post('/api/brief-override/decide', async (req, res) => {
    try { res.json(Object.assign({ success: true }, await BG.decide(db, bgMe(req), (req.body || {}).id, (req.body || {}).approve === true, (req.body || {}).note))); }
    catch (e) { res.status(e.status || 400).json({ success: false, error: String(e.message || e), code: e.code || '' }); }
  });
  router.post('/api/brief-override/cancel', wrap(async req => Object.assign({ success: true }, await BG.cancel(db, bgMe(req), (req.body || {}).id))));
  router.get('/api/brief-gate/settings', wrap(async req => ({ success: true, settings: await BG.getSettings(db, true), canEdit: BG.canDecide(bgMe(req)), approvers: BG.overrideUsers() })));
  router.post('/api/brief-gate/settings', async (req, res) => {
    try { res.json({ success: true, settings: await BG.saveSettings(db, bgMe(req), req.body || {}) }); }
    catch (e) { res.status(e.status || 400).json({ success: false, error: String(e.message || e), code: e.code || '' }); }
  });

  /* ⚙️ ปุ่มเฟืองข้างปุ่ม Auto — ตั้งค่ารอบเวลา
   *    ‼ ของเดิมใช้ ScriptApp trigger (setupAutoCreateTrigger Code.gs:4928)
   *      ระบบใหม่ไม่มีของแบบนั้น — ใช้ตัวตั้งเวลาของเซิร์ฟเวอร์แทน
   *      เก็บค่าไว้ที่ app.settings ให้ server.js อ่านไปตั้งรอบ */
  router.get('/api/auto-create/settings', wrap(async () => {
    let row = null;
    try { row = await db.one('settings', { 'key': 'eq.jobcard_auto' }); } catch (e) {}
    const v = (row && row.value) || {};
    return {
      success: true,
      enabled: v.enabled !== false,
      intervalMinutes: Number(v.intervalMinutes) || 15,
      daysBack: v.daysBack !== undefined ? Number(v.daysBack) : 2,
      daysAhead: v.daysAhead !== undefined ? Number(v.daysAhead) : 2,
      lastRunAt: v.lastRunAt || '', lastCreated: v.lastCreated || 0,
      note: 'ของเดิมเป็น time-based trigger ของ Apps Script — ระบบใหม่ใช้ตัวตั้งเวลาของเซิร์ฟเวอร์',
    };
  }));

  router.post('/api/auto-create/settings', wrap(async req => {
    if (!B._isAdminLike(userOf(req)))
      throw new Error('🔒 เฉพาะ admin / namna / suntorn เท่านั้นที่ตั้งค่ารอบ Auto ได้');
    const b = req.body || {};
    const value = {
      enabled: b.enabled !== false,
      intervalMinutes: Math.max(1, Number(b.intervalMinutes) || 15),
      daysBack: b.daysBack !== undefined ? Number(b.daysBack) : 2,
      daysAhead: b.daysAhead !== undefined ? Number(b.daysAhead) : 2,
    };
    await db.upsert('settings', [{ key: 'jobcard_auto', value }], 'key');
    return { success: true, settings: value };
  }));

  /* ═══════════════════════════════════════════════════════════════
   *  ⑷ ยกเลิก / ลบการ์ด — cancelJobProduction · forceDeleteJob
   * ═══════════════════════════════════════════════════════════════ */
  router.post('/api/job/cancel', wrap(async req =>
    await B.cancelJobProduction(db, Object.assign({}, req.body, { username: userOf(req) }))));

  router.post('/api/job/delete', wrap(async req =>
    await B.forceDeleteJob(db, Object.assign({}, req.body, { username: userOf(req) }))));

  /* ═══════════════════════════════════════════════════════════════
   *  ⑸ รูป QC ต่อสถานี (สูงสุด 8) — v10.75 · MAX_IMG
   *     ‼ รูปชนิด 'complete' คือตัวปลดล็อกการกดจบสถานี ห้ามเปลี่ยนชื่อชนิด
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/images', wrap(async req =>
    ({ success: true, images: await F.getStationImages(db, req.query.jobID, req.query.stationID) })));

  router.post('/api/images/upload', wrap(async req =>
    await F.uploadStationImage(db, Object.assign({}, req.body, { username: nickOf(req) || userOf(req) }))));

  router.post('/api/images/delete', wrap(async req =>
    await F.deleteStationImage(db, req.body)));

  /* ═══════════════════════════════════════════════════════════════
   *  ⑹ ไฟล์ผลิต (พิมพ์/ตัด/อื่นๆ · สูงสุด 3) · PDF หลัก · ลิงก์นอก · งานย่อย
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/files', wrap(async req => ({
    success: true,
    files: await F.getJobFiles(db, req.query.jobID),
    mainPdf: await F.getMainPdf(db, req.query.jobID),
    links: await F.getJobLinks(db, req.query.jobID),
    subCards: await F.getSubCards(db, req.query.jobID),
    fileTypes: L.FILE_TYPES,
  })));

  router.post('/api/files/upload', wrap(async req =>
    await F.uploadJobFile(db, Object.assign({}, req.body, { username: nickOf(req) || userOf(req) }))));
  router.post('/api/files/delete', wrap(async req => await F.deleteJobFile(db, req.body)));
  router.post('/api/pdf/upload', wrap(async req =>
    await F.uploadMainPdf(db, Object.assign({}, req.body, { username: nickOf(req) || userOf(req) }))));
  router.post('/api/pdf/delete', wrap(async req => await F.deleteMainPdf(db, req.body)));
  router.post('/api/links/add', wrap(async req =>
    await F.addJobLink(db, Object.assign({}, req.body, { username: nickOf(req) || userOf(req) }))));
  router.post('/api/links/delete', wrap(async req => await F.deleteJobLink(db, req.body)));
  router.post('/api/subcards/add', wrap(async req =>
    await F.addSubCard(db, Object.assign({}, req.body, { username: nickOf(req) || userOf(req) }))));
  router.post('/api/subcards/delete', wrap(async req => await F.deleteSubCard(db, req.body)));

  /* ═══════════════════════════════════════════════════════════════
   *  ⑺ 🔍 เครื่องมือวินิจฉัย — ของเดิมต้องเปิด Apps Script Editor กด Run
   *     ที่นี่เรียกจากหน้าจอได้เลย
   *       whyNoJobCard   Diag_WhyNoJobCard.gs:17
   *       whereIsMyCard  Diag_WhyNoJobCard.gs:258
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/why-no-card', wrap(async req => {
    const q = clean(req.query.q);
    if (!q) throw new Error('ใส่ ProjectID / ชื่อลูกค้า / เลขบิล มาด้วย (?q=)');
    return await C.whyNoJobCard(db, q);
  }));

  router.get('/api/where-is-my-card', wrap(async req => {
    const q = clean(req.query.q);
    if (!q) throw new Error('ใส่ JobID / ชื่อลูกค้า / ProjectID มาด้วย (?q=)');
    return await B.whereIsMyCard(db, q);
  }));

  /* ═══════════════════════════════════════════════════════════════
   *  ⑻ ข้อมูลตั้งต้นของหน้าจอ — 16 สถานี · 4 ขั้น · ชุดสถานีตามประเภทป้าย
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/meta', wrap(async req => ({
    success: true,
    version: require('./version').VERSION,
    sourceVersion: L.SOURCE_VERSION,
    stations: L.STATIONS_DEF.map((s, i) => ({ id: s[0], name: s[1], order: i + 1 })),
    steps: L.STEPS_DEF,
    presets: L.STATION_PRESETS,
    fulfillTypes: L.FULFILL_TYPES,
    fileTypes: L.FILE_TYPES,
    imageTypes: F.IMAGE_TYPES,
    maxImg: L.MAX_IMG,
    maxFiles: L.MAX_FILES_PER_JOB,
    me: {
      username: userOf(req), nickname: nickOf(req),
      canToggleStation: L._canToggleStation(userOf(req)),
      canRollback: B._canRollback(userOf(req)),
      canCancelJob: B._canCancelJob(userOf(req)),
      isAdminLike: B._isAdminLike(userOf(req)),
      /* ── เฟส 4 — สิทธิ์ที่หน้าจอต้องใช้ซ่อน/ปิดปุ่ม ────────────────
       * ‼ ทุกตัวเรียก "ตัวตัดสินสิทธิ์ตัวเดียวกับที่เซิร์ฟเวอร์บังคับจริง"
       *   ห้ามเขียนรายชื่อคนซ้ำไว้ที่หน้าจอเด็ดขาด
       *   (ของเดิมเคยเพี้ยน → "เห็นปุ่มแต่กดไม่ได้" — edit.js:52-54) */
      canSyncData: E._canSyncData(userOf(req)),        // edit.js Code.gs:726
      canSync: E._canSync(userOf(req)),                // edit.js Code.gs:739 (admin เดียว)
      canManageHelpers: CR._canCancelJob(userOf(req)), // crew.js Code.gs:14836 (v11.52)
      canManageLeaves: CR._canManageLeaves(userOf(req)),
      canReset: L._canReset(userOf(req)),              // lib.js Code.gs:599 (admin เดียว)
      /* createClaimCard ตรวจด้วย CLAIM_CREATE_ALLOWED.indexOf(rawU) — edit.js:434 */
      canCreateClaim: E.CLAIM_CREATE_ALLOWED.indexOf(userOf(req)) >= 0,
      /* cleanupEmptyJobCards ตรวจตรง ๆ 3 ชื่อ (ไม่ใช่ ADMIN_LIKE ที่กว้างกว่า) — edit.js:550 */
      canCleanupEmpty: ['admin', 'namna', 'suntorn'].indexOf(userOf(req)) >= 0,
      claimAllowed: E.CLAIM_CREATE_ALLOWED.slice(),
      /* ‼ รายชื่อผู้มีสิทธิ์ ส่งจากเซิร์ฟเวอร์เสมอ — ห้ามพิมพ์ชื่อคนไว้ในหน้าเว็บ
       *   ของเดิมพิมพ์ไว้ในข้อความ alert (Index.html:7484-7490 · 7193 · 7398)
       *   ที่นี่หน้าจอเอา 3 ชุดนี้ไปประกอบข้อความเดิมคำต่อคำ */
      helperApprovers: CR.CANCEL_JOB_ALLOWED.slice(),   // crew.js:189 (v11.52)
      rollbackAllowed: B.ROLLBACK_ALLOWED.slice(),      // board.js:46  (v9.9)
      cancelAllowed: B.CANCEL_JOB_ALLOWED.slice(),      // board.js:54  (v10.80)
      resetConfirm1: CR.RESET_CONFIRM_1,
      resetConfirm2: CR.RESET_CONFIRM_2,
      /* ── ‼ เก็บตกรอบสาม 10 ก.ย. 69 — CAN_CLICK_STATION ของเดิม ──────
       *  ต้นฉบับหน้าจอ Index.html:3379 (_recomputeCanClickStation)
       *  ของเดิมใช้ตัวนี้ตัดสินว่าปุ่ม รับ/ผลิต/เสร็จ จะเป็น "เลขขั้น" หรือ "🔒"
       *  ‼ ที่นี่ถามด้วยตัวตัดสินตัวจริงที่เซิร์ฟเวอร์บังคับ (Code.gs:6177-6230)
       *    ไม่ให้หน้าจอไล่รายชื่อคนเอง — ของเดิมทำแบบนั้นแล้วเพี้ยน
       *    (พนักงานไลน์ผลิตเห็น 🔒 ทั้งกระดานตอน lineUsers ยังมาไม่ถึง — 🐛 v13.26) */
      canClickStation: (await B._canClickStation(db, userOf(req))).allowed === true,
    },
  })));

  /* ═══════════════════════════════════════════════════════════════
   *  ⑻.1 👤 รูปพนักงาน + ชื่อเล่น — ‼ เก็บตกรอบสาม 10 ก.ย. 69
   *
   *  พี่เอทัก: "รูปภาพพนักงานในแต่ละสถานีงาน … หายไปไหนหมด"
   *  ต้นฉบับ: getBoardData แนบ userAvatars + userNickMap มากับบอร์ดเลย
   *           (Code.gs:2063-2072) แล้วหน้าจอเก็บใส่ window.USER_AVATARS
   *           / window.USER_NICK_MAP ให้ _avatar() กับ _nick() ใช้
   *           (Index.html:3827-3829 · 11087-11110)
   *  ที่นี่แยกเป็นเส้นทางของตัวเอง เพราะบอร์ดโหลดถี่กว่ารูปมาก
   *  ‼ ใช้คลังรูปกลางของระบบ (core/photo) ตัวเดียวกับแอปคีย์ยอดขาย
   *    — ห้ามยิงหา Drive หรือชีตตรง ๆ จากตรงนี้ (กฎเหล็กพี่เอ 5 ก.ย. 69)
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/avatars', wrap(async () => {
    /* ‼ 11 ก.ย. 69 — ใช้ตัวเดียวกับที่บอร์ดใช้ (modules/jobcard/avatars.js)
     *   ของเดิมตรงนี้เรียก core/photo.map() ตรง ๆ ซึ่งเป็น "คนละตัว" กับบอร์ด
     *   ⇒ สองที่ตอบไม่ตรงกัน = ไล่บั๊กกันผิดทาง
     *   ‼ ตอนนี้ยังไม่มีใครเรียกเส้นนี้ แต่ปล่อยไว้ = กับดักรอคนหลง */
    let map = {};
    try { map = await require('./avatars').userAvatarMap(); } catch (e) { map = {}; }
    /* ชื่อเล่นไทยแทน username — ต้นฉบับ getUserNicknameMap (Code.gs) + nick() Index.html:3205 */
    const nick = {};
    try {
      for (const u of (await db.selectAll('app_users',
        { select: '"Username","Nickname"', order: '_id.asc' }) || [])) {
        const un = clean(u.Username).toLowerCase(), nk = clean(u.Nickname);
        if (un && nk) nick[un] = nk;
      }
    } catch (e) { /* ไม่มีชื่อเล่นก็แสดง username ตามเดิม — ของเดิม fallback แบบนี้ */ }
    return { success: true, map, nick, count: Object.keys(map).length };
  }));

  /* ═══════════════════════════════════════════════════════════════
   *  🩺 หน้าตรวจ "รูปพนักงาน" แบบเปิดลิงก์เดียวจบ
   *
   *  ‼ พี่เอสั่ง 11 ก.ย. 69 (รอบสี่): "ทุกอย่างยังเหมือนเดิม"
   *    เวลาที่เสียไปมากที่สุดของรอบนี้ คือการเดากันไปมาว่าติดตรงไหน
   *    ปุ่ม 🔍 Probe มีอยู่แล้วก็จริง แต่ต้องกดแล้วอ่านในกล่องแจ้งเตือน
   *    ⇒ ทำเป็นลิงก์ GET ให้เปิดแล้วถ่ายจอส่งมาได้เลย
   *
   *  ‼ ตรวจอย่างเดียว ไม่แก้อะไรให้ · ไม่เขียนอะไรทั้งสิ้น
   *    และตอบ "เวอร์ชันที่รันอยู่จริง" มาด้วยเสมอ — จะได้เลิกเดาว่า
   *    ดีพลอยขึ้นหรือยัง (บทเรียนเดิมของทั้งโปรเจกต์)
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/_diag', wrap(async () => {
    const V = require('./version');
    let report = {};
    try { report = await require('./imgdoctor').runAvatars(db); }
    catch (e) { report = { 'ตรวจไม่ได้': String((e && e.message) || e) }; }
    return {
      ok: true,
      แอป: 'Job Card สั่งผลิต',
      เวอร์ชันที่รันอยู่จริง: V.VERSION,
      รูปพนักงาน: report,
    };
  }));

  /* ═══════════════════════════════════════════════════════════════
   *  ⑼ เมนูที่ยังไม่ย้าย — บอกให้รู้ ไม่ใช่หายไปเฉย ๆ
   * ═══════════════════════════════════════════════════════════════ */
  /* ═══════════════════════════════════════════════════════════════
   *  ⑾ 🚚 แผนจัดส่ง (เฟส 3) — ยกจาก Code.gs §DELIVERY PLANS 13345+
   *  ‼ สิทธิ์ 3 ระดับ: ผู้จัดการจัดส่ง · พนักงานจัดส่ง (สถานะ+หลักฐาน) · บัญชี (ดูอย่างเดียว)
   *    คนอื่นเห็นเฉพาะงานที่ตัวเองเป็นเซลส์
   * ═══════════════════════════════════════════════════════════════ */
  const meOf = req => ({ username: userOf(req), nickname: nickOf(req) });

  router.get('/api/delivery', wrap(async req => await DLV.getDeliveryPlans(db, {
    mode: clean(req.query.mode), from: clean(req.query.from), to: clean(req.query.to),
    status: clean(req.query.status), deliveryType: clean(req.query.deliveryType),
    salesPerson: clean(req.query.salesPerson), q: clean(req.query.q),
  }, meOf(req))));

  router.post('/api/delivery/save',    wrap(async req => await DLV.upsertDeliveryPlan(db, req.body, meOf(req))));
  router.post('/api/delivery/status',  wrap(async req => await DLV.updateDeliveryStatus(db, req.body, meOf(req))));
  router.post('/api/delivery/confirm', wrap(async req => await DLV.confirmDelivery(db, req.body, meOf(req))));
  router.post('/api/delivery/group',   wrap(async req => await DLV.setDeliveryGroup(db, req.body, meOf(req))));
  router.post('/api/delivery/ungroup', wrap(async req => await DLV.clearDeliveryGroup(db, req.body, meOf(req))));
  router.post('/api/delivery/proof',   wrap(async req => await DLV.uploadDeliveryProof(db, req.body, meOf(req))));

  /* ═══════════════════════════════════════════════════════════════
   *  ⑿ 🛒 จัดซื้อวัตถุดิบพิเศษ (เฟส 3) — ยกจาก Code.gs 12738+ · 13168+
   *  ‼ v12.50 — งานที่แพ็คจบแล้วซ่อนจากหน้าจัดซื้อ (เปิดดูได้ด้วย ?includePackingDone=1)
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/purchase', wrap(async req =>
    await PUR.getPurchases(db, clean(req.query.jobID))));

  router.get('/api/purchase/hub', wrap(async req => await PUR.listAllPurchases(db, {
    status: clean(req.query.status), q: clean(req.query.q),
    includePackingDone: String(req.query.includePackingDone) === '1',
  })));

  router.post('/api/purchase/add',        wrap(async req => await PUR.addPurchase(db, req.body, meOf(req))));
  router.post('/api/purchase/update',     wrap(async req => await PUR.updatePurchase(db, req.body, meOf(req))));
  router.post('/api/purchase/status',     wrap(async req => await PUR.markPurchaseStatus(db, req.body, meOf(req))));
  router.post('/api/purchase/arrived',    wrap(async req => await PUR.markPurchaseArrived(db, req.body, meOf(req))));
  router.post('/api/purchase/procurement',wrap(async req => await PUR.setPurchaseProcurementInfo(db, req.body, meOf(req))));
  router.post('/api/purchase/delete',     wrap(async req => await PUR.deletePurchase(db, req.body, meOf(req))));
  /* ‼ 10 ก.ย. 69 — 4 เมนูนี้ "ย้ายเสร็จแล้ว" ทั้งหมด แต่ละตัวเป็นแอปของตัวเอง
   *   ✅ มาตรฐานงานเชื่อม 🔩 อยู่ใน Job Card เอง (crew.js หัวข้อ ⑾) — ไม่มีสตับ
   *   ทางเข้าเดิมที่ยิงมาที่ Job Card ต้องตอบ "ไปทางนั้น" ไม่ใช่ 404 เปล่า ๆ
   *   ‼ ห้ามลบบรรทัดพวกนี้ (tools/test-maint.js คุมไว้ว่าห้ามไปแตะของเดิม) */
  router.all('/api/maintenance*', movedTo('ซ่อมบำรุง + PM 🔧', '/m/maintenance/'));
  router.all('/api/chat*',        movedTo('แชทในระบบ 💬', '/m/chat/'));
  router.all('/api/leave*',       movedTo('ลางาน 🏖️', '/m/leave/'));
  router.all('/api/kb*',          movedTo('Knowledge Base 📚', '/m/maintenance/#kb'));
  /* ═══════════════════════════════════════════════════════════════
   *  ⑽ 📊 รายงาน 6 แบบ (เฟส 2) — ยกจาก Code.gs 100%
   *     getReports 7236 · getUserReport 7418 · getStationWorkforceReport 10741
   *     getQCReport 11017 · getDailyCreatedReport 11188 · getDailyProductionReport
   *
   *  ‼ ตัวกรองเหมือนกันหมด: ?from=&to=&all=1&dateBy=created|event
   *    dateBy ค่าเริ่มต้น = 'created' (ของเดิมเปลี่ยนไว้ตั้งแต่ v10.2)
   * ═══════════════════════════════════════════════════════════════ */
  const rf = req => ({
    from: clean(req.query.from), to: clean(req.query.to),
    all: String(req.query.all) === '1' || String(req.query.all) === 'true',
    dateBy: clean(req.query.dateBy),
    username: clean(req.query.username),
    stationID: clean(req.query.stationID),
    imgType: clean(req.query.imgType),
  });
  router.get('/api/reports',            wrap(async req => await RP.getReports(db, rf(req))));
  router.get('/api/reports/users',      wrap(async req => await RP.getUserReport(db, rf(req))));
  router.get('/api/reports/workforce',  wrap(async req => await RP.getStationWorkforceReport(db, rf(req))));
  router.get('/api/reports/qc',         wrap(async req => await RP.getQCReport(db, rf(req))));
  router.get('/api/reports/daily',      wrap(async req => await RP.getDailyCreatedReport(db, rf(req))));
  router.get('/api/reports/production', wrap(async req => await RP.getDailyProductionReport(db, rf(req))));

  /* ═══════════════════════════════════════════════════════════════
   *  ‼ ตั้งแต่บรรทัดนี้ลงไปคือ "เฟส 4" — นับหมายเลขหัวข้อชุดใหม่ ⑻–⑿
   *    (คนละชุดกับ ⑴–⑿ ของเฟส 1–3 ด้านบน ซึ่งเรียงสลับกันมาแต่เดิมแล้ว)
   *
   *  ‼ โมดูลตรรกะเขียนเสร็จ + มีเทสต์คุมครบตั้งแต่ก่อนหน้านี้ แต่ "ยังไม่มีเส้นทาง"
   *    ⇒ ของดีนอนอยู่เฉย ๆ ไม่มีใครเรียกถึงได้ — รอบนี้ต่อสายให้ครบ
   *    ห้ามยกโค้ดซ้ำ ห้ามแก้ตรรกะ ทุกเส้นเรียกฟังก์ชันเดิมตรง ๆ
   *
   *  ‼ ด่านสิทธิ์ที่ "อยู่ที่ชั้นเส้นทาง" (ไม่ได้อยู่ในโมดูล) มี 2 กลุ่มเท่านั้น
   *    ① ⑼ สองตัวเรียกลัดของ sync (recover-images · delivery-address)
   *    ② ⑽ เครื่องมือซ่อม/เติมย้อนหลังที่ของเดิมเป็น "เมนูใน editor"
   *    เหตุผล: repair.js:156-158 เขียนสั่งไว้เองว่า
   *      "ห้ามใส่เพิ่มเอง ถ้าจะปิดต้องปิดที่ชั้นเส้นทาง ให้พี่เอตัดสิน"
   *    ⇒ ปิดที่นี่ ใช้ตัวตัดสินตัวเดียวกับที่พี่น้องของมันใช้ ไม่ได้คิดรายชื่อใหม่
   * ═══════════════════════════════════════════════════════════════ */

  /* ═══════════════════════════════════════════════════════════════
   *  ⑻ แก้ไข/อนุมัติ/เคลม — ยกจาก edit.js (เขียนไว้ครบแล้ว)
   *     updateJobDetails        Code.gs:3179   · approveJobForProduction Code.gs:5005
   *     cancelApproval          Code.gs:5033   · setJobFulfillType       Code.gs:5093
   *     createClaimCard         Code.gs:11554  · cleanupEmptyJobCards    Code.gs:2422
   * ═══════════════════════════════════════════════════════════════ */
  router.post('/api/job/update', wrap(async req =>
    await E.updateJobDetails(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));

  router.post('/api/job/approve', wrap(async req =>
    await E.approveJobForProduction(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));

  /* ‼ ไม่ส่ง force มา + มีสถานีเริ่มผลิตแล้ว = โยน error (Code.gs:5054)
   *   หน้าจอต้องถาม "แน่ใจไหม" ก่อนส่ง force:true เสมอ */
  router.post('/api/job/cancel-approval', wrap(async req =>
    await E.cancelApproval(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));

  /* ‼ พารามิเตอร์ที่ 3 คือ "ตัวตัดสินสิทธิ์" ที่ setJobFulfillType เรียกใช้
   *   ยืมของ delivery.js มาตรง ๆ (v11.36) ห้ามเขียนตัวใหม่ */
  router.post('/api/job/fulfill-type', wrap(async req =>
    await E.setJobFulfillType(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }), DLV.canEditDelivery)));

  /* 🛠️ การ์ดเคลม — เฉพาะ suntorn / namna / admin · ต้องมีรูปความเสียหาย 1–3 รูป */
  router.post('/api/job/claim', wrap(async req =>
    await E.createClaimCard(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));

  /* ═══════════════════════════════════════════════════════════════
   *  🆕 🛠️ ประวัติการเคลม(ติดตั้ง) ของงานหลัก 1 ใบ — พี่เอสั่ง 12 ก.ย. 69
   *    "ต้องเก็บประวัติของโปรเจคนี้ ว่ามีการเคลมจากการติดตั้งไปแล้วกี่ครั้ง
   *     ช่างคนไหน วันที่เท่าไหร่ ฯลฯ ให้กับพี่ด้วย"
   *
   *  GET /api/claim/history?projectId=<ProjectID ของงานหลัก>
   *  ‼ ไม่มี projectId = ปฏิเสธทันที ห้ามเผลอกลายเป็น "อ่านทั้งตาราง"
   *    (กฎเหล็ก · บทเรียนบอร์ดค้าง 64.7 วินาที)
   *  ‼ อ่านอย่างเดียว ไม่มีข้อมูลส่วนตัวของช่าง (ชื่อเล่น/ชื่อทีมเท่านั้น)
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/claim/history', wrap(async req => {
    const projectId = clean(req.query.projectId);
    if (!projectId) throw new Error('ใส่ projectId มาด้วย (?projectId=)');
    return await CLM.claimHistory(db, projectId);
  }));

  /* 🗑️ ล้างการ์ดผี — dryRun:true = ดูอย่างเดียว (v12.72) */
  router.post('/api/job/cleanup-empty', wrap(async req =>
    await E.cleanupEmptyJobCards(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));

  /* 🔒 สิทธิ์ "รายการ์ด" — ของสองอย่างนี้ขึ้นกับชื่อเซลส์ของการ์ดใบนั้น
   *    ⇒ ตอบจากเซิร์ฟเวอร์เท่านั้น ห้ามให้หน้าจอเดาเอง
   *    _canEditCustomerDate Code.gs:612 (v10.73) · canEditDelivery Code.gs:13351 */
  router.get('/api/job/perm', wrap(async req => {
    const jobID = clean(req.query.jobID);
    if (!jobID) throw new Error('ใส่ jobID มาด้วย (?jobID=)');
    const job = await db.one('production_jobs', { select: '*', 'JobID': 'eq.' + jobID });
    const salesPerson = clean(job && job.SalesPerson);
    return {
      success: true, jobID, salesPerson, found: !!job,
      canEditCustomerDate: E._canEditCustomerDate(userOf(req), nickOf(req), salesPerson),
      canSetFulfillType: DLV.canEditDelivery(userOf(req), nickOf(req), salesPerson),
      /* ‼ ค่าปัจจุบันของ 4 ช่องที่หน้าจอต้องเอาไปเติมในฟอร์มแก้ไข
       *   (บอร์ดไม่ได้ส่งวันเริ่มผลิต/วันส่งของมาให้ — ไม่ไปแก้ board.js เพื่อการนี้) */
      job: job ? {
        jobOrderNo: clean(job.JobOrderNo),
        productionStartDate: L._ymd(job.ProductionStartDate) || '',
        deliveryDate: L._ymd(job.DeliveryDate) || '',
        customerDeliveryDate: L._ymd(job.CustomerDeliveryDate) || '',
        productionDays: job.ProductionDays == null ? '' : job.ProductionDays,
        approvalStatus: clean(job.ApprovalStatus),
        approvedBy: clean(job.ApprovedBy),
        approvedAt: L._dt(job.ApprovedAt),
        fulfillType: clean(job.JobFulfillType),
      } : null,
    };
  }));

  /* ═══════════════════════════════════════════════════════════════
   *  ⑼ ซิงก์ Projects↔การ์ด — ยกจาก sync.js
   *     autoSyncOpenCardsFromProjects Code.gs:5668 · recoverCardImagesNow  Code.gs:5980
   *     syncDeliveryAddressesNow      Code.gs:5991 · autoSyncFromProjectsNow Code.gs:6001
   *     diffProjectsVsJobs            Code.gs:6295 · syncProjectsToJobs     Code.gs:6508
   *     getSyncFilterOptions          Code.gs:6662
   * ═══════════════════════════════════════════════════════════════ */
  /** ‼ ด่านของสองตัวเรียกลัด — ใช้ชุดเดียวกับ autoSyncFromProjectsNow (sync.js:332) */
  const needAdminLike = req => {
    if (!B._isAdminLike(userOf(req)))
      throw new Error('🔒 เฉพาะ admin / namna / suntorn');
    return true;
  };

  router.post('/api/sync/auto', wrap(async req =>
    await SY.autoSyncFromProjectsNow(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));

  /* กู้ภาพการ์ด — ไม่แตะแผนจัดส่งเลย (updateDeliveries:false) */
  router.post('/api/sync/recover-images', wrap(async req => {
    needAdminLike(req);
    return { success: true, summary: await SY.recoverCardImagesNow(db), version: L.SOURCE_VERSION };
  }));

  /* ซิงก์ที่อยู่จัดส่ง — กวาดทุกใบ (todayOnly:false) ใช้ตอนไล่แก้ย้อนหลัง */
  router.post('/api/sync/delivery-address', wrap(async req => {
    needAdminLike(req);
    return { success: true, summary: await SY.syncDeliveryAddressesNow(db), version: L.SOURCE_VERSION };
  }));

  /* 🔄 หน้าเทียบข้อมูล — ดูอย่างเดียว ยังไม่เขียนอะไร (ด่านสิทธิ์อยู่ในโมดูลแล้ว) */
  router.get('/api/sync/diff', wrap(async req =>
    await SY.diffProjectsVsJobs(db, {
      username: userOf(req), nickname: nickOf(req),
      salesPerson: clean(req.query.salesPerson), graphic: clean(req.query.graphic),
      customer: clean(req.query.customer),
      from: clean(req.query.from), to: clean(req.query.to),
    })));

  /* ✍️ สั่งเขียนทับตามช่องที่ติ๊กเลือกไว้ — updates: [{jobID, field, ...}] */
  router.post('/api/sync/apply', wrap(async req =>
    await SY.syncProjectsToJobs(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));

  /* รายชื่อ Sales / กราฟิค ของช่องกรอง — เฉพาะโปรเจกต์ที่มีการ์ดจริง */
  router.get('/api/sync/options', wrap(async req =>
    await SY.getSyncFilterOptions(db, { username: userOf(req), nickname: nickOf(req) })));

  /* ═══════════════════════════════════════════════════════════════
   *  ⑽ ซ่อม / เติมย้อนหลัง / วินิจฉัย — ยกจาก repair.js
   *     backfillRequirementDataToCards Code.gs:3359 · syncWorkGroupForProject   Code.gs:3474
   *     backfillWorkGroupFromProjects  Code.gs:3640 · backfillAddressFromProjects Code.gs:3718
   *     backfillFulfillTypeToProjects  Code.gs:3884 · syncMainImagesFromProjects Code.gs:15925
   *     repairProjectsCustomerDateAll  Code.gs:3990 · clearProjectsStatusJobOrder Code.gs:6852
   *     cleanupPaymentStatusColumn     Code.gs:6952 · forceSyncAllFulfillTypes   Code.gs:7033
   *     enforceCancelledProjectStatus  Code.gs:7121
   *     วินิจฉัย (อ่านอย่างเดียว): whyProjectNotInPlan Code.gs:6742 ·
   *       diagnoseProjectJobStatus Code.gs:7185 · diagnoseFulfillTypeColumn Code.gs:6132 ·
   *       diagCustomerDate Code.gs:3239
   *
   *  ‼ ของเดิมหลายตัว "ไม่มีด่านตรวจสิทธิ์" เพราะเป็นเมนูที่รันจาก Apps Script editor
   *    (ใครเปิด editor ได้ = เป็นเจ้าของสคริปต์อยู่แล้ว) พอย้ายมาเป็นเว็บ
   *    ใครล็อกอินก็ยิงได้ ⇒ ปิดที่ชั้นเส้นทางตามที่ repair.js:156-158 สั่งไว้เอง
   *    ใช้ _canSyncData ตัวเดียวกับที่พี่น้องในไฟล์เดียวกันใช้ ไม่ได้คิดรายชื่อใหม่
   * ═══════════════════════════════════════════════════════════════ */
  const needSyncData = req => {
    if (!E._canSyncData(userOf(req)))
      throw new Error('🔒 ไม่มีสิทธิ์ — เฉพาะ admin เท่านั้น');
    return true;
  };
  /** payload มาตรฐานของกลุ่มนี้ — ปิดด่านก่อน แล้วค่อยส่งของเดิมเข้าไป */
  const repairBody = req => {
    needSyncData(req);
    return Object.assign({}, req.body, { username: userOf(req), nickname: nickOf(req) });
  };

  /* ── เติมข้อมูลย้อนหลัง ── (ทุกตัวรับ dryRun:true = ดูอย่างเดียว) */
  router.post('/api/repair/backfill-requirement', wrap(async req =>
    await RPR.backfillRequirementDataToCards(db, repairBody(req))));
  router.post('/api/repair/workgroup-project', wrap(async req =>
    await RPR.syncWorkGroupForProject(db, repairBody(req))));
  router.post('/api/repair/backfill-workgroup', wrap(async req =>
    await RPR.backfillWorkGroupFromProjects(db, repairBody(req))));
  router.post('/api/repair/backfill-address', wrap(async req =>
    await RPR.backfillAddressFromProjects(db, repairBody(req))));
  router.post('/api/repair/backfill-fulfill', wrap(async req =>
    await RPR.backfillFulfillTypeToProjects(db, repairBody(req))));
  router.post('/api/repair/main-images', wrap(async req =>
    await RPR.syncMainImagesFromProjects(db, repairBody(req))));

  /* ── ซ่อม / บังคับให้ตรง ──
   *  ‼ repairProjectsCustomerDateAll = ซ่อม "วันส่งลูกค้า พ.ศ." ที่ Projects
   *    ตัวที่เหลือรับแค่ db ตัวเดียวตามของเดิม — ห้ามยัดพารามิเตอร์เพิ่มเอง */
  router.post('/api/repair/customer-date', wrap(async req =>
    await RPR.repairProjectsCustomerDateAll(db, repairBody(req))));
  router.post('/api/repair/clear-joborder', wrap(async req => {
    needSyncData(req); return await RPR.clearProjectsStatusJobOrder(db);
  }));
  router.post('/api/repair/cleanup-payment', wrap(async req => {
    needSyncData(req); return await RPR.cleanupPaymentStatusColumn(db);
  }));
  router.post('/api/repair/force-fulfill', wrap(async req => {
    needSyncData(req); return await RPR.forceSyncAllFulfillTypes(db);
  }));
  router.post('/api/repair/enforce-cancelled', wrap(async req => {
    needSyncData(req); return await RPR.enforceCancelledProjectStatus(db);
  }));

  /* ── วินิจฉัย — อ่านอย่างเดียว ไม่เขียนอะไรสักช่อง ──
   *  ‼ whyProjectNotInPlan ฝัง ProjectID ไว้ในโค้ดตายตัว (WHY_TARGET_PID)
   *    ของเดิมตั้งใจให้ไปแก้ในโค้ดเอง — ห้ามเปลี่ยนเป็นรับพารามิเตอร์ */
  router.get('/api/diag/why-not-in-plan', wrap(async () => await RPR.whyProjectNotInPlan(db)));
  router.get('/api/diag/project-job-status', wrap(async req => {
    const pid = clean(req.query.pid) || clean(req.query.q);
    if (!pid) throw new Error('ใส่ ProjectID มาด้วย (?pid=)');
    return await RPR.diagnoseProjectJobStatus(db, pid);
  }));
  router.get('/api/diag/fulfill-column', wrap(async () => await RPR.diagnoseFulfillTypeColumn(db)));
  router.get('/api/diag/customer-date', wrap(async req =>
    await RPR.diagCustomerDate(db, {
      username: userOf(req), nickname: nickOf(req), query: clean(req.query.q),
    })));

  /* ═══════════════════════════════════════════════════════════════
   *  ⑾ สถานี / คน / งานเชื่อม / ประวัติ — ยกจาก crew.js
   *     updateStationHelpers Code.gs:14832 · syncStations       Code.gs:14888
   *     getProductionLineUsers Code.gs:15063 · getIdleWorkersRefresh Code.gs:10311
   *     getWeldingStandards Code.gs:7876 · getJobWeldingInfo    Code.gs:7946
   *     upsertJobWeldingInfo Code.gs:7983 · deleteJobWeldingInfo Code.gs:8054
   *     getUpdateHistoryByDay Code.gs:15449 · getLastUpdate     Code.gs:15551
   *     diagnosticPayment Code.gs:14985 · resetAllProductionData Code.gs:14962
   * ═══════════════════════════════════════════════════════════════ */
  /* 👷 ผู้ช่วยประจำสถานี — v11.52 เฉพาะ admin/suntorn/namna (ด่านอยู่ในโมดูล) */
  router.post('/api/station/helpers', wrap(async req =>
    await CR.updateStationHelpers(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));

  /* 🔧 เติมสถานีให้ครบ 16 ตัวทุกการ์ด — v10.31 เฉพาะ admin (ด่านอยู่ในโมดูล) */
  router.post('/api/station/sync', wrap(async req =>
    await CR.syncStations(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));

  /* 📋 คนในไลน์ผลิต + คนว่าง (อ่านอย่างเดียว) */
  router.get('/api/crew/line-users', wrap(async () => await CR.getProductionLineUsers(db)));
  router.get('/api/crew/idle', wrap(async () => await CR.getIdleWorkersRefresh(db)));

  /* 🔩 งานเชื่อม — ตารางมาตรฐาน + ข้อมูลของการ์ดใบเดียว
   *  🐛 ของเดิม "ใครก็ลบได้" ไม่มีด่านสิทธิ์เลยสักชั้น (crew.js:1095) — ยกมาเหมือนเดิม */
  router.get('/api/welding/standards', wrap(async req =>
    await CR.getWeldingStandards(db, { username: userOf(req), nickname: nickOf(req) })));
  router.get('/api/welding/job', wrap(async req =>
    await CR.getJobWeldingInfo(db, { jobID: clean(req.query.jobID) })));
  router.post('/api/welding/save', wrap(async req =>
    await CR.upsertJobWeldingInfo(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));
  router.post('/api/welding/delete', wrap(async req =>
    await CR.deleteJobWeldingInfo(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));

  /* 🕘 ประวัติการอัปเดต — รายวัน + ตัวเช็คว่ามีอะไรใหม่ตั้งแต่เวลาที่ส่งมา */
  router.get('/api/history/day', wrap(async req =>
    await CR.getUpdateHistoryByDay(db, { dateISO: clean(req.query.dateISO) })));
  router.get('/api/history/last', wrap(async req =>
    await CR.getLastUpdate(db, Number(req.query.ts || 0))));

  /* 🔍 วินิจฉัยช่องสถานะรับเงิน (อ่านอย่างเดียว — v10.19) */
  router.get('/api/diag/payment', wrap(async () => await CR.diagnosticPayment(db)));

  /* ‼‼ ล้างข้อมูลผลิตทั้งหมด — ตัวทำลายล้างตัวเดียวของทั้งแอป ‼‼
   *   ① เฉพาะ user "admin" คนเดียว (_canReset — lib.js RESET_ALLOWED)
   *   ② ต้องส่ง confirm1:true และ confirm2:true มาพร้อมกันทั้งคู่ ไม่งั้น throw
   *      (ของเดิมถามสองชั้นที่หน้าจอ — โมดูลย้ายมาบังคับที่เซิร์ฟเวอร์ด้วยอีกชั้น)
   *   ③ ล้างได้แค่ 4 ตาราง (RESET_TABLES) และเป็นการ "ล้างแถว" ไม่ใช่ drop table
   *   ‼ ห้ามผ่อนเงื่อนไข ห้ามใส่ค่าเริ่มต้นให้ confirm ทั้งสองตัวเด็ดขาด
   *     ส่งต่อ req.body ตรง ๆ เท่านั้น — ธงยืนยันต้องมาจากคนกดจริง */
  router.post('/api/admin/reset-all', wrap(async req =>
    await CR.resetAllProductionData(db, Object.assign({}, req.body, {
      username: userOf(req), nickname: nickOf(req),
    }))));

  /* ═══════════════════════════════════════════════════════════════
   *  ⑿ ไฟล์บน Drive + โน้ตเซลส์ — ยกจาก drivefiles.js
   *     getJobDriveFolderUrl Code.gs:11971 · syncJobFilesFromFolder  Code.gs:12064
   *     repairAllJobFilesSharing Code.gs:12161 · bulkSyncAllJobFiles Code.gs:12207
   *     getImageDataUrl Code.gs:11368 · getImageFileIds Code.gs:11408
   *     getStationImagesWithData Code.gs:11439
   *     getSalesNotes Code.gs:12477 · addSalesNote Code.gs:12504 · deleteSalesNote Code.gs:12628
   *
   *  ‼ getJobDriveFolderUrl / repairAllJobFilesSharing ไม่แตะฐานข้อมูล ⇒ ไม่รับ db
   *    (ตรงกับของเดิม) — ห้ามยัด db เข้าไปให้ "ดูเข้าชุดกัน"
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/drive/folder', wrap(async req =>
    await DF.getJobDriveFolderUrl({
      jobID: clean(req.query.jobID),
      sessionEmail: clean(req.query.sessionEmail),
      email: clean(req.query.email),
      username: userOf(req), nickname: nickOf(req),
    })));

  router.post('/api/drive/sync-job-files', wrap(async req =>
    await DF.syncJobFilesFromFolder(db, Object.assign({}, req.body, { username: userOf(req) }), meOf(req))));

  /* 🔒 สองตัวนี้มีด่าน _canSyncData อยู่ในโมดูลแล้ว (drivefiles.js:630 · 687) */
  router.post('/api/drive/repair-sharing', wrap(async req =>
    await DF.repairAllJobFilesSharing(Object.assign({}, req.body, { username: userOf(req) }), meOf(req))));
  router.post('/api/drive/bulk-sync', wrap(async req =>
    await DF.bulkSyncAllJobFiles(db, Object.assign({}, req.body, { username: userOf(req) }), meOf(req))));

  /* รูป: แปลงลิงก์ Drive → data URL (เพดาน 5MB) · หา FileID จากลิงก์ · รูป QC พร้อมเนื้อรูป (เพดาน 2MB) */
  router.get('/api/drive/image-data', wrap(async req =>
    await DF.getImageDataUrl(clean(req.query.path))));
  router.post('/api/drive/image-ids', wrap(async req =>
    ({ success: true, files: await DF.getImageFileIds((req.body && req.body.paths) || []) })));
  /* 📉 23 ต.ค. 69 รูปสถานี (QC/จบงาน) สำรองเมื่อรูปย่อของ Google เปิดไม่ได้ — ส่งเฉพาะไฟล์ที่อยู่ในตาราง station_images · แคช 7 วัน + ETag */
  router.get('/api/images/file/:fid', async (req, res) => {
    const fid = clean(req.params.fid);
    try {
      if (!/^[\w-]{10,200}$/.test(fid)) return res.status(400).end();
      const etag = '"si-' + fid + '"';
      if (String(req.headers['if-none-match'] || '') === etag) return res.status(304).set('ETag', etag).end();
      const rows = await db.select('station_images', { FileID: 'eq.' + fid, select: 'FileID', limit: 1 }) || [];
      if (!rows.length) return res.status(404).end();
      const blob = await DF.blobOf(fid);
      res.set({ 'Content-Type': /^image\//.test(blob.contentType || '') ? blob.contentType : 'application/octet-stream', 'Cache-Control': 'private, max-age=604800, immutable', ETag: etag, 'X-Content-Type-Options': 'nosniff' });
      res.end(blob.bytes);
    } catch (e) { res.status(502).end(); }
  });
  router.get('/api/images/data', wrap(async req =>
    ({ success: true, images: await DF.getStationImagesWithData(db,
      clean(req.query.jobID), clean(req.query.stationID), clean(req.query.imgType)) })));

  /* 📝 โน้ตเซลส์ในการ์ด — ดู / เพิ่ม (ข้อความ + รูปสูงสุด 4) / ลบ (เจ้าของหรือ admin) */
  router.get('/api/notes', wrap(async req =>
    await DF.getSalesNotes(db, clean(req.query.jobID))));
  router.post('/api/notes/add', wrap(async req =>
    await DF.addSalesNote(db, Object.assign({}, req.body, { username: userOf(req) }), meOf(req))));
  router.post('/api/notes/delete', wrap(async req =>
    await DF.deleteSalesNote(db, Object.assign({}, req.body, { username: userOf(req) }), meOf(req))));

  /* 📷 รูปแพ็คกิ้ง ST10 ของการ์ด — delivery2.js:_getPackingPhotoForJob (Code.gs:13487)
   *  ‼ ที่เหลือของ delivery2.js ย้ายไปอยู่แอป "แผนจัดส่ง" แล้ว
   *    ที่นี่เปิดเฉพาะตัวนี้ตัวเดียว เพราะป๊อปอัปรายละเอียดการ์ดต้องใช้ */
  router.get('/api/delivery/packing-photo', wrap(async req => ({
    success: true,
    photo: await DLV2._getPackingPhotoForJob(db, clean(req.query.jobID)),
    version: L.SOURCE_VERSION,
  })));

  /* ═══════════════════════════════════════════════════════════════
   *  🔴 ทางเข้าหลังบ้านของ "หน้าเว็บต้นฉบับ" — เพิ่ม 10 ก.ย. 69
   *
   *  ‼ พี่เอทัก: "เมนู สรุปวันนี้ หายและ card สั่งผลิต ชุด ใหม่ ที่อยู่ทางซ้ายก็หาย
   *     บอกว่าให้อ่านตาม Code เดิม 100% ไง ไม่ต้องปรับเปลี่ยนแก้ไขใดๆ ทั้งสิ้น"
   *
   *  ต้นเหตุ: รอบก่อนหน้าเว็บถูก "เขียนใหม่" 4,185 บรรทัด แทนที่จะก๊อป
   *    ⇒ ของหาย 863 ชิ้น · ปุ่มบน toolbar หาย 6 จาก 17 ปุ่ม
   *  รอบนี้ยกหน้าเว็บต้นฉบับมาทั้งดุ้น 19,655 บรรทัด (ต่างจากต้นฉบับ 8 บรรทัด
   *  และไม่มีบรรทัดไหนเป็นตรรกะของแอป) หน้านั้นเรียกหลังบ้านด้วย "ชื่อฟังก์ชัน"
   *  ⇒ เปิดทางเข้าแบบชื่อฟังก์ชันให้มัน โดยชี้กลับมาที่ตรรกะชุดเดียวกันนี้
   *
   *  ‼ REST เส้นเดิมทั้ง 98 เส้นข้างบน "ยังอยู่ครบ ไม่ได้ถอดแม้แต่เส้นเดียว"
   *    ตรรกะมีชุดเดียว ไม่ได้ยกซ้ำ — สองทางเข้าเรียกฟังก์ชันตัวเดียวกัน
   * ═══════════════════════════════════════════════════════════════ */
  router.use('/api/rpc', rpc.makeRouter({ db, VERSION: L.SOURCE_VERSION }));

  /* 🎨 v1.29.1 เติมงานย่อยเคลมกราฟิค-ขายย้อนหลัง — ครั้งเดียว 45 วิหลังเปิดเครื่อง (ไม่ขวางการเปิดแอป · ปิดได้ด้วย JOBCARD_NO_GS_BACKFILL) */
  if (!process.env.JOBCARD_NO_GS_BACKFILL) {
    const t = setTimeout(() => {
      require('./claiminstall').backfillGsClaimRequirements(db)
        .then(r => { if (r.created || r.errors.length) ctx.log('🎨 เติมงานย่อยเคลมกราฟิค-ขายย้อนหลัง: สร้าง ' + r.created + ' · ตรวจ ' + r.checked + (r.errors.length ? ' · ผิดพลาด ' + r.errors.slice(0, 3).join(' | ') : '')); })
        .catch(() => {});
    }, 45000);
    if (t.unref) t.unref();
  }

  const missing = PAGE_FUNCTIONS.filter(f => !rpc.has(f));
  ctx.log('พร้อมใช้งาน — เฟส 1–4 ยกจาก Code.gs 16,598 บรรทัด (v13.34) · 16 สถานี · 8 ด่านสร้างการ์ด · ' +
          'แก้ไข/อนุมัติ/เคลม · ซิงก์ Projects↔การ์ด · ซ่อม/เติมย้อนหลัง/วินิจฉัย · สถานี/คน/งานเชื่อม · ไฟล์+โน้ตเซลส์');
  ctx.log(`หน้าเว็บต้นฉบับ 19,655 บรรทัด · ต่อสาย ${PAGE_FUNCTIONS.length - missing.length}/` +
          `${PAGE_FUNCTIONS.length} ฟังก์ชันที่หน้าเว็บเรียก` +
          (missing.length ? ' · ‼ ยังเหลือ: ' + missing.join(', ') : ' — ครบทุกตัว'));
}

module.exports = { mount, PAGE_FUNCTIONS };
