'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/jobcard/rpc.js — ทางเข้าหลังบ้านทางเดียวของหน้าเว็บ Job Card
 *
 *  ‼ พี่เอสั่ง 10 ก.ย. 69:
 *    "ให้อ่านตาม Code เดิม 100% ไง ไม่ต้องปรับเปลี่ยนแก้ไขใดๆ ทั้งสิ้น"
 *
 *  ⇒ หน้าเว็บยกมาทั้งดุ้น 19,655 บรรทัด ไม่แก้ตรรกะแม้แต่บรรทัดเดียว
 *    หน้าเว็บเรียกหลังบ้านด้วย "ชื่อฟังก์ชัน" 95 ชื่อ ใน 153 จุด
 *    (ผ่าน SRUN() ที่ index.html:3104 — ตัวห่อ google.script.run ของเดิม)
 *    ไฟล์นี้คือทะเบียนที่จับคู่ 95 ชื่อนั้นกับตรรกะที่ยกมาแล้ว
 *
 *  ── กติกาที่ห้ามผิด ────────────────────────────────────────────────
 *   ① ทะเบียนแบบ allow-list เท่านั้น
 *      ห้าม eval · ห้าม require ตามชื่อที่ผู้ใช้ส่งมา
 *      ชื่อที่ไม่อยู่ในทะเบียน = ปฏิเสธ ไม่ใช่ "ลองเรียกดูก่อน"
 *   ② 🔒 ตัวตนมาจาก session เท่านั้น — ไม่เคยอ่าน payload.user
 *      ของเดิมเชื่อ ?u=<username> ตรง ๆ ใครแก้ URL ก็เป็นแอดมินได้
 *      หน้าเว็บยังส่ง payload.user มาเหมือนเดิม (ไม่ได้แก้หน้าเว็บ)
 *      แต่ตรงนี้ทับด้วยตัวจริงจาก session ก่อนส่งเข้าตรรกะเสมอ
 *   ③ ตัวไหนยังไม่ได้ย้าย ต้องตอบเป็นข้อความบอกตรง ๆ
 *      ห้ามเงียบ · ห้ามตอบว่าสำเร็จ — บทเรียน: ❌ ที่ไม่จริง แพงกว่าบั๊กจริง
 *
 *  ── ลำดับพารามิเตอร์ ───────────────────────────────────────────────
 *   ตรรกะที่ยกมาใช้รูปแบบเดียวกันหมด: (db, payload[, me])
 *   หน้าเว็บส่งอาร์กิวเมนต์มาตามลำดับเดิมของ Apps Script อยู่แล้ว
 *   ⇒ ส่งต่อตรง ๆ (db, ...args) แล้วเติม me ให้ตัวที่ต้องการเป็นตัวท้าย
 *     ‼ ไม่ได้ "ออกแบบใหม่" — เป็นลำดับเดียวกับที่ REST route เดิมใช้ทุกเส้น
 * ═══════════════════════════════════════════════════════════════════ */

const express = require('express');

const clean = s => String(s == null ? '' : s).trim();

/* ═══════════════════════════════════════════════════════════════════
 *  ทะเบียนโมดูล — ชื่อฟังก์ชันตัวไหนอยู่ที่ไหน
 *
 *  ‼ 4 เมนู (ซ่อมบำรุง · แชท · ลางาน · จัดส่ง) พี่เอสั่งแยกเป็นแอปของตัวเอง
 *    ตรรกะย้ายไปอยู่โมดูลนั้นแล้ว — ตรงนี้ "เรียกใช้ของเดิมที่ย้ายไปแล้ว"
 *    ไม่ได้ยกโค้ดมาซ้ำ (ยกซ้ำ = วันหนึ่งสองที่ไม่ตรงกันแบบเงียบ ๆ)
 * ═══════════════════════════════════════════════════════════════════ */
const SOURCES = [
  'jobcard/lib', 'jobcard/create', 'jobcard/board', 'jobcard/files',
  'jobcard/reports', 'jobcard/delivery', 'jobcard/purchase', 'jobcard/edit',
  'jobcard/sync', 'jobcard/repair', 'jobcard/crew', 'jobcard/drivefiles',
  'jobcard/delivery2',
  /* 📅 ปิด Job รายวัน แยกพิมพ์/ป้าย — พี่เอสั่ง 21 ก.ย. 69 (ไฟล์เดียว ฟังก์ชันเดียว) */
  'jobcard/closeddaily',
  /* 👤 รูปพนักงานแบบแอปจองคิวติดตั้ง — พี่เอสั่ง 25 ก.ย. 69 (รอบ 127 · ฟังก์ชันเดียว getJobcardPhotos) */
  'jobcard/avphotos',
  /* 🔥 แผนงานเชื่อมขอบ ST02 จบวันต่อวัน + % ความคืบหน้า — พี่เอสั่ง 28 ก.ย. 69 (รอบ 170 · getWeldPlan · saveWeldProgress) */
  'jobcard/weldplan',
  /* 🔧 แผนงานประกอบ ST09 จบวันต่อวัน + % ความคืบหน้า — พี่เอสั่ง 29 ก.ย. 69 (รอบ 182 · getAssemblyPlan · saveAssemblyProgress)
   *   ‼ ตรรกะอยู่ stationplan.js ตัวเดียวกับเชื่อมขอบ (stationplan.js ไม่ลงทะเบียน — make ห้ามเป็นชื่อ RPC) */
  'jobcard/assemblyplan',
  /* 💸 ต้นทุนการ์ดเคลม: ประเมินจาก BOM งานเดิม + ต้นทุนจริงตามมา — พี่เอสั่ง 29 ก.ย. 69 (รอบ 186 · getClaimCosts)
   *   ‼ เห็นเฉพาะคนที่สร้างใบเคลมได้ (suntorn · namna · admin) · ตัวช่วยอยู่ใน _t (ไม่ถูกลงทะเบียน) */
  'jobcard/claimcost',
  /* 🔧 คิวติดตั้ง ทีมช่าง วัน-เวลานัด บนการ์ด — พี่เอสั่ง 30 ก.ย. 69 (รอบ 197 · getJobInstallInfo · อ่านอย่างเดียว ไม่มีช่องเงิน) */
  'jobcard/installinfo',
  /* 📋 Picking list เช็คของก่อนแพ็ก/ขึ้นรถ + ยืนยันในการ์ด — พี่เอสั่ง 11 ต.ค. 69 (v1.23.0 · ตาราง sql/118) */
  'jobcard/picking',
  /* ⚠️ เตือนบนการ์ด: งานย่อยของ Project ยังเข้ามาไม่ครบ — พี่เอสั่ง 5 พ.ย. 69 (v1.29.0 · getJobSubReqAlerts · อ่านอย่างเดียว) */
  'jobcard/subreqs',
  'maintenance/machines', 'maintenance/requests', 'maintenance/parts',
  'maintenance/pm', 'maintenance/knowledge', 'maintenance/dashboard',
  'maintenance/gemini',
  'chat/chat', 'chat/presence',
  'leave/leave',
];

/** ชื่อฟังก์ชัน → { fn, from } — สแกนครั้งเดียวตอนโหลด */
const FOUND = {};
const loadErrors = [];
for (const src of SOURCES) {
  try {
    const api = require('../' + src);
    for (const name of Object.keys(api))
      if (typeof api[name] === 'function' && !FOUND[name])
        FOUND[name] = { fn: api[name], from: src };
  } catch (err) {
    loadErrors.push({ src, error: String((err && err.message) || err) });
    console.error(`[jobcard/rpc] โหลด ${src} ไม่สำเร็จ: ${(err && err.message) || err}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════
 *  ชื่อที่หน้าเว็บเรียก แต่ตรรกะเดิมเป็นของ Apps Script โดยเฉพาะ
 *
 *  ‼ พวกนี้ "ไม่มีของให้ยก" — ของเดิมเรียก SpreadsheetApp / ScriptApp
 *    ซึ่งไม่มีตัวตนบนเซิร์ฟเวอร์ ⇒ ทำให้ได้ผลเท่าเดิมในบริบทใหม่
 *    และบอกตรง ๆ ในคำตอบว่าตัวไหนเปลี่ยนที่อยู่ไปแล้ว
 * ═══════════════════════════════════════════════════════════════════ */
function bridged(ctx) {
  const { db, VERSION } = ctx;

  return {
    /* Code.gs:1140 — ปุ่ม 🔍 Probe บน toolbar
     *   ของเดิมรายงาน: เวอร์ชัน · ชื่อไฟล์ชีต · ผู้ใช้ · จำนวนแถว ProductionJobs
     *   ระบบใหม่รายงานของเดียวกัน แต่นับจากฐานข้อมูลแทนชีต */
    async probe(me) {
      /* ‼ เดิม new Date().toString() = เวลาของเครื่อง (UTC บน Railway)
       *   ปุ่ม 🔍 Probe มีไว้ให้ดูว่า "ตอนนี้กี่โมง" ⇒ ต้องเป็นเวลาไทย */
      const r = { ok: true, version: VERSION,
        time: require('../../core/thai-date').dateTimeTH(), user: me.username || 'n/a' };
      try {
        const t0 = Date.now();
        r.jobsRows = await db.count('production_jobs');
        r.dbMs = Date.now() - t0;
        r.store = 'Supabase · app.production_jobs';
      } catch (e) { r.jobsErr = String((e && e.message) || e); r.ok = false; }

      /* 🖼️ เพิ่มเข้ามา 10 ก.ย. 69 — พี่เอ: "Job card รุปไม่มานะ"
       *   ‼ ไม่ได้แก้ของเดิมสักบรรทัด แค่ "แนบผลตรวจ" มากับคำตอบ
       *     เพราะ Probe คือปุ่มเดียวที่กดแล้วเห็นของจริงได้ทันทีอยู่แล้ว
       *   ‼ ตรวจอย่างเดียว ไม่แก้ข้อมูล — ดู modules/jobcard/imgdoctor.js */
      try { r['รูปในการ์ด'] = await require('./imgdoctor').run(db); }
      catch (e) { r['รูปในการ์ด'] = { 'ตรวจไม่ได้': String((e && e.message) || e) }; }

      /* 👤 เพิ่ม 11 ก.ย. 69 — พี่เอ: "รูปพนักงานของ app job card สั่งผลิตก็ยังไม่ขึ้นนะ"
       *   เส้นทางรูปพนักงานพังได้ 2 ที่ (ต้นทางว่าง / คีย์ไม่ตรง) และหน้าตาเหมือนกัน
       *   ⇒ เอาของจริงมาเทียบให้เห็น ดีกว่าเดากันอีกรอบ */
      try { r['รูปพนักงาน'] = await require('./imgdoctor').runAvatars(db); }
      catch (e) { r['รูปพนักงาน'] = { 'ตรวจไม่ได้': String((e && e.message) || e) }; }

      /* ═══════════════════════════════════════════════════════════
       *  🔴 พี่เอส่งภาพมา 11 ก.ย. 69: ผลตรวจโดนตัดท้ายด้วย "…"
       *
       *  ต้นเหตุ: หน้าเว็บโชว์ด้วย alert() ซึ่งตัดข้อความยาวทิ้ง
       *  ⇒ ผลตรวจที่หนูอุตส่าห์ทำ "อยู่ในส่วนที่ถูกตัดพอดี" = เปล่าประโยชน์
       *
       *  ‼ บทเรียน: รายงานที่ดีแค่ไหน ถ้าคนอ่านไม่เห็น ก็เท่ากับไม่มี
       *  ⇒ ย้ายบทสรุป "บรรทัดเดียว" ขึ้นมาไว้บนสุด เห็นได้โดยไม่ต้องเลื่อน
       *    รายละเอียดยังอยู่ครบข้างล่างเหมือนเดิม
       * ═══════════════════════════════════════════════════════════ */
      try {
        const im = r['รูปในการ์ด'] || {}, av = r['รูปพนักงาน'] || {};
        const line = [];
        if (im['การ์ดที่เปิดอยู่'] !== undefined) line.push('การ์ด ' + im['การ์ดที่เปิดอยู่'] + ' ใบ');
        if (im['ช่องรูปว่าง'] !== undefined)      line.push('ช่องรูปว่าง ' + im['ช่องรูปว่าง']);
        if (im['ทดลองแปลงเป็นไอดีไฟล์'])          line.push('แปลงรูป: ' + im['ทดลองแปลงเป็นไอดีไฟล์']);
        if (av['รูปพนักงานในแผนที่'])              line.push('รูปพนักงาน ' + av['รูปพนักงานในแผนที่']);
        if (av['ชื่อบนการ์ด (60 ใบล่าสุด)'])        line.push('จับคู่ชื่อ: ' + av['ชื่อบนการ์ด (60 ใบล่าสุด)']);
        /* ‼ วางไว้เป็นคีย์แรกสุด — JSON.stringify เรียงตามลำดับที่ใส่ */
        const head = { ok: r.ok, 'สรุป': line.join(' · ') || 'ไม่มีข้อมูลให้สรุป' };
        if (im['สรุป'])          head['สรุปรูปในการ์ด'] = im['สรุป'];
        if (av['สรุปรูปพนักงาน']) head['สรุปรูปพนักงาน'] = av['สรุปรูปพนักงาน'];
        return Object.assign(head, r);
      } catch (e) { /* สรุปไม่ได้ก็ไม่เป็นไร ของเต็มยังอยู่ */ }

      return r;
    },

    /* Code.gs:1054 — ของเดิมคืน ScriptApp.getService().getUrl()
     *   ระบบใหม่คือหน้านี้เอง
     *
     *  🔴 17 ก.ย. 69 — เดิมบรรทัดนี้คืน '/m/jobcard/' เฉย ๆ
     *    ค่านี้ถูกเอาไปฝังใน QR ของสติกเกอร์จัดส่ง (index.html · _doPrintStickers)
     *    เป็น "ทางสัมพัทธ์" ไม่มีโดเมน ⇒ สแกนด้วยมือถือแล้วเปิดไม่ได้
     *    (อาการเดียวกับที่พี่เอเจอในแอปคลังวันนี้)
     *  ⇒ คืน URL เต็มจากคำขอจริง — ดู L._webAppUrl / L._publicOrigin
     *    ‼ ไม่ hardcode โดเมน · ไม่ require ข้ามไปเอาของแอปคลัง */
    async getWebAppUrl(_me, _payload, req) {
      return { success: true, url: require('./lib')._webAppUrl(req), version: VERSION };
    },

    /* Code.gs:1157 — ของเดิมสร้าง "แท็บในชีต" ให้ครบ
     *   ระบบใหม่ตารางมาจากไฟล์ SQL ⇒ ตอบตรง ๆ ว่าที่อยู่เปลี่ยนไปแล้ว */
    async setupDatabase() {
      const t = {};
      for (const name of ['production_jobs', 'job_stations', 'production_logs'])
        try { t[name] = await db.count(name); } catch (e) { t[name] = 'ยังไม่มีตาราง'; }
      return {
        success: true, version: VERSION, tables: t,
        note: 'ระบบใหม่ไม่สร้างแท็บในชีตแล้ว — ตารางมาจากไฟล์ sql/ ' +
              'ตัวเลขข้างบนคือจำนวนแถวจริงในฐานข้อมูลตอนนี้',
      };
    },

    /* Code.gs:15202 — เครื่องมือไล่แก้ชื่อผู้ใช้ "ในชีต" ให้เป็นชื่อเล่น
     *   🔴 กฎเหล็กของพี่เอ: ระบบใหม่ห้ามเขียนกลับชีตเด็ดขาด
     *     ⇒ ทำไม่ได้ และต้องบอกว่าทำไม ไม่ใช่เงียบหรือแกล้งสำเร็จ */
    async migrateUsernamesToNicknames() {
      return {
        success: false,
        error: 'เครื่องมือนี้เป็นการ "เขียนทับชื่อในไฟล์ชีต" ของแอปเดิม\n' +
               'ระบบใหม่ไม่เขียนกลับชีตแม้แต่ช่องเดียว (กฎเหล็กที่พี่เอสั่งไว้ 6 ก.ย. 69)\n' +
               'ชื่อเล่นในระบบใหม่มาจากตาราง app_users อยู่แล้ว — ไม่ต้องไล่แก้',
        version: VERSION,
      };
    },

    /* Code.gs:4977 / 4928 / 4956 — ของเดิมใช้ time-based trigger ของ Apps Script
     *   ระบบใหม่ใช้ตัวตั้งเวลาของเซิร์ฟเวอร์ เก็บค่าไว้ที่ app.settings
     *   ‼ ตรรกะเดียวกับ REST เส้น /api/auto-create/settings ที่ใช้อยู่แล้ว */
    async getAutoCreateTriggerStatus() {
      let row = null;
      try { row = await db.one('settings', { key: 'eq.jobcard_auto' }); } catch (e) {}
      const v = (row && row.value) || {};
      return {
        success: true,
        enabled: v.enabled !== false,
        intervalMinutes: Number(v.intervalMinutes) || 15,
        daysBack: v.daysBack !== undefined ? Number(v.daysBack) : 2,
        daysAhead: v.daysAhead !== undefined ? Number(v.daysAhead) : 2,
        lastRunAt: v.lastRunAt || '', lastCreated: v.lastCreated || 0,
        note: 'ของเดิมเป็น time-based trigger ของ Apps Script — ' +
              'ระบบใหม่ใช้ตัวตั้งเวลาของเซิร์ฟเวอร์',
        version: VERSION,
      };
    },

    /* ═══════════════════════════════════════════════════════════════
     *  🔗 getJobCardByNumber — "ขอการ์ดใบเดียว ตามเลขงานที่ลิงก์ส่งมา"
     *
     *  🔴 กฎเหล็กพี่เอ 18 ก.ย. 69: "ต้องไม่ให้ load ช้า หรือ load ข้อมูล
     *    ที่ไม่จำเป็นมาทำเด็ดขาดนะ … app ต้องเร็ว มีประสิทธิภาพ และทำงานได้จริง"
     *
     *  ของเดิม (เมื่อวาน): หน้าเว็บโหลดบอร์ด "ทุกสถานะทั้งฐาน" มาก่อน
     *    แล้วค่อยไล่หาใบเดียวในเครื่อง = 172 คำขอ / 6,808 แถว (วัดจริง)
     *  ของใหม่: ถามฐานว่า "เลขนี้คือ JobID อะไร" แล้วประกอบการ์ดเฉพาะใบนั้น
     *
     *  ① หาเลขงาน — ถามทีละช่อง หยุดทันทีที่เจอ (ลิงก์จากแผนจัดส่งส่ง JobID
     *    มาเป็นหลัก ⇒ ปกติจบใน 1 คำขอ) และ select เฉพาะช่อง JobID ช่องเดียว
     *    ‼ ไม่ใช้ select=* เพราะที่นี่ต้องการแค่ "รหัส" ไปต่อ
     *  ② ประกอบการ์ดด้วย board.getBoardData ตัวเดิม แต่ล็อกขอบเขตด้วย
     *    onlyJobIDs ⇒ ตารางลูกทั้ง 10 ตารางถูกอ่านเฉพาะใบนั้นโดยปริยาย
     *    ‼ ใช้ตัวประกอบการ์ดตัวเดียวกับบอร์ด — ไม่เขียนใหม่ ไม่งั้นการ์ดจะขาดช่อง
     *
     *  ‼ ไม่มีเพดาน: db.select ที่นี่จำกัดด้วย limit:1 "โดยตั้งใจ" เพราะถาม
     *    หาแถวเดียวจริง ๆ (เลขงานไม่ซ้ำ) ไม่ใช่การตัดรายการทิ้งเงียบ ๆ
     * ═══════════════════════════════════════════════════════════════ */
    async getJobCardByNumber(me, payload) {
      const want = clean(payload && payload.job);
      if (!want) return { success: false, error: 'ไม่ได้ส่งเลขงานมา', version: VERSION };

      let jobID = '';
      for (const col of ['JobID', 'JobOrderNo', 'JobNumber']) {
        let row = null;
        try {
          row = await db.one('production_jobs',
            { select: '"JobID"', order: '_id.desc', [col]: 'eq.' + want });
        } catch (e) { row = null; }
        if (row && clean(row.JobID)) { jobID = clean(row.JobID); break; }
      }
      if (!jobID)
        return { success: true, cards: [], summary: {}, notFound: true,
                 job: want, version: VERSION };

      const B = require('./board');
      const out = await B.getBoardData(db, { onlyJobIDs: [jobID] });
      const shaped = await shapeBoard(db, out, me);
      shaped.job = want;
      shaped.onlyJob = true;
      return shaped;
    },

    async setupAutoCreateTrigger(me, payload) {
      const B = require('./board');
      if (!B._isAdminLike(me.username))
        throw new Error('🔒 เฉพาะ admin / namna / suntorn เท่านั้นที่ตั้งค่ารอบ Auto ได้');
      const b = payload || {};
      const value = {
        enabled: true,
        intervalMinutes: Math.max(1, Number(b.intervalMinutes) || 15),
        daysBack: b.daysBack !== undefined ? Number(b.daysBack) : 2,
        daysAhead: b.daysAhead !== undefined ? Number(b.daysAhead) : 2,
      };
      await db.upsert('settings', [{ key: 'jobcard_auto', value }], 'key');
      return { success: true, settings: value, version: VERSION };
    },

    async removeAutoCreateTrigger(me) {
      const B = require('./board');
      if (!B._isAdminLike(me.username))
        throw new Error('🔒 เฉพาะ admin / namna / suntorn เท่านั้นที่ปิดรอบ Auto ได้');
      let row = null;
      try { row = await db.one('settings', { key: 'eq.jobcard_auto' }); } catch (e) {}
      const value = Object.assign({}, (row && row.value) || {}, { enabled: false });
      await db.upsert('settings', [{ key: 'jobcard_auto', value }], 'key');
      return { success: true, removed: true, settings: value, version: VERSION };
    },

    /* ═══════════════════════════════════════════════════════════
     *  🛠️ ประวัติการเคลม(ติดตั้ง) ของงานหลัก 1 ใบ — พี่เอสั่ง 12 ก.ย. 69
     *    "ต้องเก็บประวัติของโปรเจคนี้ ว่ามีการเคลมจากการติดตั้งไปแล้วกี่ครั้ง
     *     ช่างคนไหน วันที่เท่าไหร่ ฯลฯ ให้กับพี่ด้วย"
     *
     *  ‼ ตรรกะอยู่ที่ claiminstall.js ทั้งก้อน — ตรงนี้ "แค่ต่อสาย" ให้หน้าเว็บ
     *    เรียกด้วยชื่อฟังก์ชันได้เหมือนเมนูอื่นทุกเมนู (ผ่าน SRUN)
     *    ‼ ไม่ยกโค้ดมาซ้ำ · ไม่มีตรรกะใหม่แม้แต่บรรทัดเดียวที่นี่
     *  ‼ claimHistory(db, projectId) รับ "สตริง" เป็นตัวที่สอง ไม่ใช่ payload
     *    ⇒ ผ่านทะเบียน FOUND ตรง ๆ ไม่ได้ (สะพานส่ง payload ทั้งก้อน)
     *      จึงต้องอยู่ตรงนี้ ไม่ใช่ใน SOURCES
     *  ‼ ไม่มี projectId = ปฏิเสธทันที ห้ามเผลอกลายเป็น "อ่านทั้งตาราง"
     *    (กฎเหล็ก · บทเรียนบอร์ดค้าง 64.7 วินาที) */
    async claimHistory(me, payload) {
      const projectId = clean(payload && (payload.projectId || payload.projectID));
      if (!projectId) throw new Error('ใส่ projectId มาด้วย');
      return await require('./claiminstall').claimHistory(db, projectId);
    },

    /* Code.gs:13922 — เปิดแผนจัดส่งของงานนี้ ถ้ายังไม่มีให้เตรียมใบเปล่าให้
     *   ‼ ด่านสิทธิ์ของเดิม (_canEditDelivery) ต้องคงไว้ทุกประการ
     *     ต่างกันแค่ "ใครเป็นผู้ใช้" มาจาก session ไม่ใช่ payload */
    async getDeliveryForJobOrCreate(me, payload) {
      const DLV = require('./delivery');
      const B = require('./board');
      const jobID = clean(payload && payload.jobID);
      if (!jobID) throw new Error('no jobID');

      const job = await db.one('production_jobs', { 'JobID': 'eq.' + jobID });
      if (!job) throw new Error('ไม่พบ Job');

      const salesPerson = clean(job.SalesPerson);
      if (!DLV.canEditDelivery(me.username, me.nickname, salesPerson))
        throw new Error('🔒 ไม่มีสิทธิ์แก้แผนจัดส่ง\nเฉพาะ Sales เจ้าของงาน "' +
                        salesPerson + '" หรือ admin');

      const plans = await DLV.getDeliveryPlans(db, { jobID });
      const existing = ((plans && plans.plans) || []).find(p => clean(p.JobID) === jobID) || null;
      return {
        success: true, existing: existing, isNew: !existing,
        job: {
          jobID, projectID: clean(job.ProjectID), jobOrderNo: clean(job.JobOrderNo),
          customerName: clean(job.CustomerName), salesPerson,
          customerDeliveryDate: clean(job.CustomerDeliveryDate),
          jobFulfillType: clean(job.JobFulfillType),
          overallStatus: clean(job.OverallStatus),
        },
        canManage: true,
        isAdmin: B._isAdminLike(me.username),
        version: VERSION,
      };
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════
 *  🔴 ตัวแปลงคำตอบของบอร์ด — จำเป็น ไม่ใช่ของแถม
 *
 *  ตรรกะที่ยกมาคืนกลับเป็น  { jobs, counters, stationsDef }
 *  แต่หน้าเว็บต้นฉบับอ่าน   state.data.cards (66 ที่) · .summary (9 ที่)
 *                          .stations · .isDeliveryStaff · .userAvatars
 *                          .todayLeaves · .idleWorkers · .lineUsers
 *
 *  ‼ ไม่แปลง = บอร์ดว่างเปล่าทั้งจอ "โดยไม่มี error" — เปิดมาเจอหน้าโล่ง
 *    ทั้งที่ข้อมูลมาถึงเบราว์เซอร์ครบแล้ว
 *  ‼ แก้ที่สะพาน ไม่ใช่ที่หน้าเว็บ — พี่เอสั่ง "ห้ามปรับเปลี่ยนแก้ไขใดๆ ทั้งสิ้น"
 *
 *  ‼ ของที่ต้องเติม ดึงจากฟังก์ชันที่ยกมาแล้วทั้งหมด ไม่ได้เขียนตรรกะใหม่
 * ═══════════════════════════════════════════════════════════════════ */
async function shapeBoard(db, out, me) {
  if (!out || out.success === false) return out;

  const DLV = require('./delivery');
  const c = out.counters || {};

  /* ① jobs → cards   ② counters → summary (หน้าจออ่าน summary.closedToday) */
  const shaped = Object.assign({}, out, {
    cards: out.jobs || [],
    summary: Object.assign({}, c),
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🔴 แก้ 10 ก.ย. 69 — ตรงนี้เคยเป็นต้นเหตุที่บอร์ดกลายเป็น 64.7 วินาที
   *
   *  รอบก่อนหนูให้สะพานเรียก 3 อย่างเพิ่มทุกครั้งที่โหลดบอร์ด:
   *    · core/photo.map()            — รูปพนักงานทั้งหมด
   *    · อ่าน app_users ทั้งตาราง     — แผนที่ชื่อเล่น
   *    · CR.getIdleWorkersRefresh()  — 🔴 อ่าน job_stations ทั้งตาราง 58,345 แถว
   *  บนชีต 3 อย่างนี้คือ 3 คำขอ · บน Supabase คือ 60+ คำขอ
   *
   *  ‼ ทั้งสามอย่างต้นฉบับแนบมากับ getBoardData อยู่แล้ว (Code.gs:2065-2095)
   *    โดยใช้ของที่โหลดมาแล้วในตัวมันเอง ไม่เคยอ่านซ้ำ
   *  ⇒ ย้ายไปทำที่ board.js ตามต้นฉบับ · ตรงนี้เหลือแค่ "เปลี่ยนชื่อช่อง"
   *    ให้ตรงกับที่หน้าเว็บอ่าน ซึ่งเป็นงานเดียวที่สะพานควรทำ
   * ═══════════════════════════════════════════════════════════════ */

  /* 🖼️ รูปพนักงาน — board.js แนบมาแล้ว (Code.gs:2063) ตรงนี้แค่ส่งต่อ
   *   ‼ 11 ก.ย. 69 — บรรทัดนี้เคยเป็น "ปล่อยว่างไว้" ซึ่งผิด
   *     ต้นฉบับแนบ userAvatars มากับบอร์ดจริง ๆ ไม่ได้ให้หน้าจอไปดึงเอง
   *     ⇒ วงกลมหน้าชื่อกลายเป็นตัวอักษรย่อทุกใบ จนพี่เอทักว่า
   *       "แสดงรูปพนักงานด้วยนะ" */
  shaped.userAvatars = out.userAvatars || {};
  /* ต้นฉบับเรียกช่องนี้ว่า userNickMap — หน้าเว็บอ่านชื่อนั้น */
  if (out.userNickMap) shaped.userNickMap = out.userNickMap;

  /* ④ "พนักงานจัดส่ง" — หน้าจอใช้เปิดโหมดดูอย่างเดียว (body.dsv-mode) */
  try {
    shaped.isDeliveryStaff = !DLV.canEditDelivery(me.username, me.nickname, '') &&
                             DLV.canEditDelivery(me.username, me.nickname, me.username);
  } catch (e) { shaped.isDeliveryStaff = false; }

  return shaped;
}

/* ═══════════════════════════════════════════════════════════════════
 *  🔴 ตัวประทับตัวตนลง payload — ต้นเหตุของบั๊ก "ชื่อคนลาเป็นชื่อคนกด"
 *
 *  พี่เอแจ้ง 12 ก.ย. 69:
 *    "เมื่อกดลางาน … ใน หน้าพนักงานลา การแสดงผลชื่อกลับขึ้นเป็นชื่อของคนกด
 *     (User ที่ทำรายการ) แทนที่จะเป็นชื่อของพนักงานที่ลาจริง
 *     (แต่ User ID อ้างอิงคนลาถูกต้อง)"
 *
 *  ── ต้นเหตุ (อยู่ในไฟล์นี้ ไม่ใช่ที่โมดูลลางาน) ────────────────────
 *   บรรทัดนี้เคยทับ "ทั้งสามช่อง" ทุกคำขอเหมือนกันหมด:
 *     { user, username, nickname } ← ของคนที่ล็อกอิน
 *   ‼ user/username = "ใครเป็นคนกด" → ทับถูกแล้ว (กันสวมสิทธิ์)
 *   ‼ แต่ nickname ในบางฟังก์ชัน "ไม่ได้แปลว่าคนกด" — addLeave ใช้ช่องนี้
 *     เป็น "ชื่อเล่นของพนักงานที่ลา" (leave.js:214)
 *     หน้าเว็บส่ง data-nick ของพนักงานมาถูกแล้ว (index.html:17698)
 *     แต่โดนทับทิ้งตั้งแต่ก่อนถึงเซิร์ฟเวอร์ ⇒ ชื่อคนกดไปโผล่แทน
 *
 *  ── ผลการไล่ตรวจ "ทุกตัวที่อ่าน payload.nickname" (12 ก.ย. 69) ────
 *   อ่านเป็น "ชื่อของผู้ทำรายการ" (ทับต่อไปเหมือนเดิม ไม่กระทบ):
 *     create.js:582 autoCreateJobsFromCompleteProjects (ตัวกรอง Owner)
 *     board.js:994 · :1055 · :1102      (ช่อง CreatedBy/UpdatedBy)
 *     edit.js:195 · :202 · :249 · :279 · :367 · :372 · :452 · :674
 *     sync.js:499 · crew.js:265 (updateStationHelpers) · crew.js:1030
 *   อ่านเป็น "ชื่อของคนอื่น" — มีตัวเดียวในทั้งสายนี้:
 *     leave/leave.js:214 addLeave  ⇒ ใส่ไว้ใน NOT_IDENTITY
 *
 *  ── ทำไมปล่อย nickname ของ addLeave ผ่านได้โดยไม่เสียความปลอดภัย ──
 *   ① user/username ยังถูกทับด้วยคนที่ล็อกอินเสมอ ⇒ ด่านสิทธิ์ของ addLeave
 *      (admin/namna/suntorn เท่านั้น) ยังตัดสินจากตัวจริง ปลอมไม่ได้
 *   ② ค่าที่ปล่อยผ่านไม่ได้ถูกเชื่อทันที — addLeave พิสูจน์ก่อนว่าเป็น
 *      "ชื่อของพนักงานคนนั้นจริง" ด้วย _isOwnName() ไม่ผ่าน = ทิ้ง (leave.js:215)
 *   ⇒ แย่ที่สุดคือช่อง Nickname ว่าง แล้ว _leaveDisplayName เติมจากทะเบียนให้
 *     ไม่มีทางกลายเป็นชื่อคนกดอีกเลย
 *
 *  ‼ actorNickname = ชื่อเล่นของ "คนกด" ที่แยกออกมาเป็นช่องของตัวเอง
 *    ⇒ ต่อไปฟังก์ชันไหนอยากได้ชื่อคนกด ให้อ่านช่องนี้ ไม่ต้องไปแย่ง nickname
 * ═══════════════════════════════════════════════════════════════════ */
/* ── ช่องที่ "ไม่ใช่คำกล่าวอ้างตัวตน" ของแต่ละฟังก์ชัน — ห้ามทับ ──────
 *  ‼ เป็นรายชื่อแบบ allow-list ที่ต้องพิสูจน์ได้ทีละตัวว่าปลอดภัย
 *    ห้ามเติมชื่อเข้ามาลอย ๆ เพราะ "มันไม่ทำงาน" — ต้องอธิบายได้ว่าช่องนั้น
 *    ไม่ได้ถูกใช้ตัดสินสิทธิ์ หรือถูกพิสูจน์ซ้ำที่ปลายทางแล้ว
 *
 *  · addLeave.nickname  = ชื่อเล่นของ "พนักงานที่ลา" (leave/leave.js:214)
 *      ปลายทางพิสูจน์เองด้วย _isOwnName() พิสูจน์ไม่ได้ = ทิ้ง (leave.js:215)
 *      ‼ สิทธิ์ของ addLeave ตัดสินจาก actorUsername ซึ่งยังถูกทับอยู่
 *  · getLeaves.username = "คำค้นในช่องค้นหา" ไม่ใช่ตัวตน (leave/leave.js:82
 *      ใช้เป็น substring บน Username+Nickname · เส้น REST ก็ส่งค่าจาก
 *      req.query.username ตรง ๆ — leave/index.js:139)
 *      🔴 เจอ 12 ก.ย. 69 ตอนเขียนยาม test:jcui: ทับช่องนี้ = ตาราง
 *        "จัดการวันลา" ในหน้า Job Card กรองเหลือแต่ชื่อของคนที่ล็อกอิน
 *        ⇒ แอดมินเปิดมาเจอตารางว่างเปล่าทุกครั้ง โดยไม่มี error สักตัว
 *      ‼ getLeaves เป็นการอ่านล้วน ไม่มีด่านสิทธิ์ผูกกับช่องนี้เลย
 *        ปล่อยผ่าน = ไม่ได้ทำให้ด่านไหนอ่อนลงแม้แต่ด่านเดียว */
const NOT_IDENTITY = {
  addLeave:  { nickname: true },
  getLeaves: { username: true },
};
const notIdentity = (fn, field) => {
  /* ‼ hasOwnProperty — ชื่อ fn มาจากผู้ใช้ ถ้าอ่านตรง ๆ แล้วส่ง 'constructor'
   *   มา จะได้ค่าจริงจาก prototype แล้วหลุดด่านไปเงียบ ๆ */
  if (!Object.prototype.hasOwnProperty.call(NOT_IDENTITY, fn)) return false;
  return Object.prototype.hasOwnProperty.call(NOT_IDENTITY[fn], field);
};

function stampIdentity(fn, a, me) {
  const out = Object.assign({}, a, {
    /* 🔒 ตัวตนของ "ผู้ทำรายการ" — ทับเสมอ ทุกฟังก์ชัน ไม่มีข้อยกเว้น */
    user: me.username,
    username: me.username,
    /* 🔒 ‼ 12 ก.ย. 69 — เจอตอนเขียนยาม test:jcui: addLeave/deleteLeave ตัดสิน
     *   สิทธิ์จาก payload.actorUsername (leave/leave.js:166) ไม่ใช่ payload.username
     *   ⇒ ตอนนั้นสะพานทับแต่ username ช่อง actorUsername จึงเป็นของที่หน้าเว็บ
     *     ส่งมาดิบ ๆ · ใครก็ยิง { actorUsername:'admin' } มาเองแล้วยื่นลา/ลบวันลา
     *     แทนใครก็ได้ (เส้น REST ของแอปลางานปิดช่องนี้ไว้แล้วที่ leave/index.js:90
     *     — เหลือรูอยู่ทางเดียวคือทางสะพานนี้)
     *   ‼ ทับทั้งสองชื่อพร้อมกัน ไม่งั้นยังเหลือทางอ้อม (กติกาเดียวกับ asMe) */
    actorUsername: me.username,
    actor: me.username,
    /* ชื่อเล่นของผู้ทำรายการ อยู่ช่องของตัวเองเสมอ (ไม่แย่งช่อง nickname) */
    actorNickname: me.nickname,
  });
  /* ฟังก์ชันทั่วไป: nickname = ชื่อผู้ทำรายการ (พฤติกรรมเดิมทุกประการ) */
  if (!notIdentity(fn, 'nickname')) out.nickname = me.nickname;
  /* ‼ ช่องที่ปลายทางใช้เป็น "คำค้น" ไม่ใช่ตัวตน — คืนค่าที่หน้าเว็บส่งมา
   *   (ไม่ส่งมา = ไม่ต้องมีช่องนั้น ห้ามยัดชื่อคนล็อกอินลงไปแทน) */
  for (const f of ['username', 'user']) {
    if (!notIdentity(fn, f)) continue;
    if (a && Object.prototype.hasOwnProperty.call(a, f)) out[f] = a[f];
    else delete out[f];
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════
 *  ตัวจ่ายงาน
 * ═══════════════════════════════════════════════════════════════════ */
function makeRouter(ctx) {
  const router = express.Router();
  /* รูป QC ส่งมาเป็น data URL — 8 รูปต่อสถานี · ไฟล์ผลิตใหญ่กว่านั้น */
  router.use(express.json({ limit: '25mb' }));

  const BRIDGED = bridged(ctx);
  const { db } = ctx;

  router.post('/', async (req, res) => {
    const fn = clean(req.body && req.body.fn);
    const args = Array.isArray(req.body && req.body.args) ? req.body.args : [];

    /* 🔒 ตัวตนจาก session เท่านั้น */
    const u = req.user || {};
    const me = {
      username: clean(u.username).toLowerCase(),
      nickname: clean(u.nickname || u.name),
    };
    if (!me.username)
      return res.status(401).json({ success: false, error: 'ยังไม่ได้เข้าสู่ระบบ' });

    try {
      /* ① ตัวเชื่อมที่เขียนไว้เอง (ของเดิมเป็นของ Apps Script ล้วน)
       *  ‼ ส่ง req เป็นตัวที่สาม — ตัวที่ต้องรู้ "ที่อยู่จริงของแอป" ใช้
       *    (getWebAppUrl → QR สติกเกอร์จัดส่ง) ตัวอื่นไม่รับก็ไม่กระทบ */
      if (Object.prototype.hasOwnProperty.call(BRIDGED, fn))
        return res.json(await BRIDGED[fn](me, args[0] || {}, req));

      /* ② ตรรกะที่ยกมาแล้ว */
      const hit = FOUND[fn];
      if (!hit)
        return res.json({
          success: false,
          error: 'เมนูนี้ยังย้ายมาไม่เสร็จ (' + fn + ')\n' +
                 'ยังไม่ได้ทำ ไม่ใช่พัง — ระบบจะไม่แกล้งบอกว่าสำเร็จ',
          notWired: true, fn,
        });

      /* 🔒 ทับ user/username ใน payload ด้วยตัวจริงจาก session เสมอ
       *   หน้าเว็บยังส่งของเดิมมาทุกประการ — แต่เราไม่เชื่อค่านั้น
       *   ‼ ด่านนี้คือ "คุณสมบัติด้านความปลอดภัย" ห้ามอ่อนลงไม่ว่ากรณีใด
       *     (ของเดิมเชื่อ ?u=<username> ดิบ ๆ ใครแก้ URL ก็เป็นแอดมินได้)
       *   ‼ nickname จัดการแยก — ดู NICK_IS_THIRD_PARTY ข้างล่าง */
      const call = args.map(a =>
        (a && typeof a === 'object' && !Array.isArray(a))
          ? stampIdentity(fn, a, me)
          : a);

      /* ═══════════════════════════════════════════════════════════
       *  🔴 แปลงชื่อช่องให้ตรงกัน — ห้ามแก้หน้าเว็บ
       *
       *  หน้าเว็บต้นฉบับส่ง { includeClosed: … } (Index.html:4023)
       *  แต่ board.getBoardData ที่ยกมาอ่าน opt.showClosed
       *  ⇒ ไม่แปลงตรงนี้ = ติ๊ก "แสดงงานที่ปิดแล้ว" แล้วไม่มีอะไรเกิดขึ้น
       *    พังแบบเงียบ ๆ ไม่มี error ให้เห็น
       *
       *  ‼ แก้ที่สะพาน ไม่ใช่ที่หน้าเว็บ — พี่เอสั่ง "ห้ามปรับเปลี่ยนใดๆ"
       *  ‼ pendingOnly: ต้นฉบับไม่มีแนวคิดนี้ ⇒ ตั้งเป็น false
       *    (เส้น REST /api/board ตั้งต้นเป็น true ตามที่พี่เอสั่งไว้ 10 ก.ย. 69
       *     — คนละทางเข้ากัน ของใครของมัน ไม่ทับกัน) */
      /* 🔴 19 ต.ค. 69 พี่เอ: "check ด่วนนะ ว่ารูปที่จบงานในแต่ละ station มันลบไม่ได้นะ"
       *   หน้าเว็บต้นฉบับเรียก deleteStationImage(imageID) — ส่ง "ไอดีเปล่า ๆ" (Index.html delImg)
       *   แต่ files.deleteStationImage ที่ยกมาอ่าน payload.imageID ⇒ ได้ "payload ไม่ครบ" ทุกครั้ง
       *   และหน้าเว็บไม่มี withFailureHandler ⇒ กด × แล้วเงียบ รูปไม่หาย
       *   ⇒ ห่อเป็น { imageID } ที่สะพาน (ไม่แตะหน้าเว็บ) */
      if (fn === 'deleteStationImage' && (typeof call[0] === 'string' || typeof call[0] === 'number'))
        call[0] = { imageID: String(call[0]) };
      if (fn === 'getBoardData' && call[0] && typeof call[0] === 'object') {
        const p = call[0];
        if (p.showClosed === undefined && p.includeClosed !== undefined)
          p.showClosed = p.includeClosed;
        /* 🔴 18 ก.ย. 69 — พี่เอ: "เวลาที่กด link Job card No. มันแค่เปิด app job card
         *   แต่ไม่ได้ค้นหา job นั้นขึ้นมาเลย"
         *   หนึ่งในชั้นที่พัง: งานที่ "ถูกยกเลิก" ไม่เคยถูกโหลดมาที่หน้าเว็บเลย
         *     board.getBoardData รองรับ showCancelled อยู่แล้ว (board.js:367)
         *     แต่ไม่มีใครส่งมาสักที ⇒ กดลิงก์งานที่ยกเลิกแล้ว ค้นยังไงก็ไม่เจอ
         *   ⇒ แปลงชื่อช่องให้ตรงกัน แบบเดียวกับ includeClosed บรรทัดบน
         *   ‼ ตั้งต้นยังเป็น "ไม่เอา Cancelled" เหมือนเดิมทุกประการ
         *     หน้าเว็บต้องขอมาเองเท่านั้น (ทางเดียวที่ขอคือ "มาจากลิงก์") */
        if (p.showCancelled === undefined && p.includeCancelled !== undefined)
          p.showCancelled = p.includeCancelled;
        /* ‼ พี่เอเลือกไว้ 10 ก.ย. 69: เก็บ "เปิดมาโหลดเฉพาะงานค้าง" ไว้
         *   (ตอบตอนหนูถามว่าจะเอาของที่สั่งเพิ่มรอบก่อนไว้ไหม)
         *   ⇒ ตั้งต้นเป็น true · ติ๊ก "แสดงงานที่ปิดแล้ว" เมื่อไหร่ก็ปลดให้
         *   ‼ ขอ Cancelled มาก็ต้องปลด pendingOnly ด้วย — งานที่ยกเลิกแล้ว
         *     ไม่มีสถานีค้างสักใบ ถ้าไม่ปลด _keep จะตัดทิ้งหมดเหมือนเดิม */
        if (p.pendingOnly === undefined) p.pendingOnly = !(p.showClosed || p.showCancelled);
      }

      /* ═══════════════════════════════════════════════════════════
       *  🔴 อ่านหน้าตาพารามิเตอร์จริงของฟังก์ชัน แล้วส่งให้ตรง
       *
       *  ‼ พี่เอทัก 10 ก.ย. 69: "รูปที่ card ก็ไม่ขึ้น"
       *    ต้นเหตุอยู่ตรงนี้: สะพานยัด db เป็นตัวแรกให้ "ทุกตัว"
       *    แต่ 3 ตัวไม่ได้รับ db เลย — getImageFileIds(paths) ·
       *    getImageDataUrl(path) · setGeminiApiKey(payload, me)
       *    ⇒ paths กลายเป็น db · Array.isArray(db) เป็น false
       *      → คืนอาเรย์ว่าง → ช่องรูปว่างทั้งกระดาน "โดยไม่มี error สักตัว"
       *
       *  ⇒ อ่านชื่อพารามิเตอร์ตัวแรกจากตัวฟังก์ชันเอง แล้วตัดสินจากของจริง
       *    ไม่ใช่เดาว่าทุกตัวต้องรับ db (เดาแบบนั้นคือที่มาของบั๊กนี้)
       * ═══════════════════════════════════════════════════════════ */
      const params = String(hit.fn);
      const head = params.slice(params.indexOf('(') + 1, params.indexOf(')'));
      const first = (head.split(',')[0] || '').trim();
      const wantsDb = first === 'db';
      const wantsMe = /\bme\s*$/.test(head.trim()) || /,\s*me\s*[,)]/.test(head + ')');

      let out;
      if (fn === 'setJobFulfillType') {
        /* Code.gs — พารามิเตอร์ตัวที่ 3 คือ "ตัวตัดสินสิทธิ์" ไม่ใช่ me
         *
         *  🔴 พี่เอแจ้ง: "เปลี่ยนประเภทงานเป็นจัดส่ง แล้วเด้ง
         *     canEditDelivery is not a function"
         *  ต้นเหตุอยู่บรรทัดนี้: เดิมส่ง "ผลการเรียก" (true/false) เข้าไป
         *    แต่ setJobFulfillType (edit.js:361) รับ "ตัวฟังก์ชัน" แล้วเรียกเอง
         *    ที่ edit.js:372 — canEditDelivery(payload.username, payload.nickname, salesPerson)
         *  ⇒ boolean ถูกเรียกเป็นฟังก์ชัน = พังทุกครั้งที่กดเปลี่ยนประเภทงาน
         *  ‼ ผิดซ้ำอีกชั้น: p.salesPerson ไม่เคยมีใน payload ที่หน้าเว็บส่งมา
         *    (index.html:7732 ส่งแค่ jobID · fulfillType · username)
         *    ชื่อเซลส์ตัวจริงอยู่ที่การ์ด ซึ่ง edit.js อ่านเองอยู่แล้ว
         *  ⇒ ส่ง "ตัวฟังก์ชัน" ตรง ๆ เหมือนเส้น REST พี่น้องของมัน
         *    (index.js:479 — E.setJobFulfillType(db, …, DLV.canEditDelivery)) */
        const DLV = require('./delivery');
        const p = call[0] || {};
        out = await hit.fn(db, p, DLV.canEditDelivery);
      } else {
        /* ตัวที่ไม่รับ db (เช่น getImageFileIds(paths)) ต้องไม่ยัด db ให้ */
        const head2 = wantsDb ? [db] : [];
        if (wantsMe) out = await hit.fn(...head2, ...(call.length ? call : [{}]), me);
        else         out = await hit.fn(...head2, ...call);
      }

      /* ‼ แปลงชื่อช่างในคำตอบให้ตรงกับที่หน้าเว็บต้นฉบับอ่าน */
      if (fn === 'getBoardData') out = await shapeBoard(db, out, me);

      return res.json(out);
    } catch (e) {
      /* ‼ ของเดิมคืน { success:false, error } เสมอ ไม่เคยโยน HTTP error
       *   หน้าเว็บจึงแสดงข้อความให้คนอ่านได้ ไม่ใช่ค้างเงียบ */
      return res.json({ success: false, error: String((e && e.message) || e), fn });
    }
  });

  return router;
}

/** ชื่อทั้งหมดที่ต่อสายแล้ว — ใช้ในหน้าตรวจระบบและในเทสต์ */
function listNames() {
  return [...new Set([...Object.keys(FOUND), ...Object.keys(bridged({ db: null, VERSION: '' }))])].sort();
}
const has = name => Object.prototype.hasOwnProperty.call(FOUND, name) ||
                    Object.prototype.hasOwnProperty.call(bridged({ db: null, VERSION: '' }), name);

module.exports = { makeRouter, listNames, has, loadErrors, FOUND };
