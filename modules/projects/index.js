'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  โมดูล "Projects Management System" — ยกจากแอป Apps Script เดิม
 *
 *  ‼ พี่เอสั่ง 8 ก.ย. 69:
 *    "ไป copy code เดิม 100% มาทำตอนนี้เลย เอาให้ครบทุกบรรทัดนะ
 *     อย่าคิดเอง อย่าข้าม อย่าเพิ่มอะไรตอนที่สร้าง app"
 *
 *  ต้นฉบับ: _source/projects/Code.gs (2,772 บรรทัด) + Index.html (2,205 บรรทัด)
 *  ทุก endpoint จดชื่อฟังก์ชันเดิม + เลขบรรทัดไว้ ตรวจทีละตัวได้
 *
 *  ── 3 อย่างที่ "ทำต่างจากเดิม" และทำไม (ไม่ใช่ของที่เพิ่มเอง) ──
 *   ① ข้อมูลลง Supabase ไม่ใช่ชีต — กฎเหล็กของพี่เอ (6 ก.ย. 69)
 *      ชีตเดิมยังทำงานของมันต่อไป ระบบใหม่ไม่เขียนกลับแม้แต่ช่องเดียว
 *   ② ตัวตนผู้ใช้มาจากการล็อกอินของ Hub ไม่ใช่ ?u=<username>
 *      ของเดิมเชื่อ ?u= ตรง ๆ ใครแก้ URL ก็เป็นแอดมินได้ (Code.gs:202)
 *      ระบบใหม่มี auth อยู่แล้ว จึงใช้ของที่มี ไม่ได้เพิ่มระบบใหม่ขึ้นมา
 *   ③ ฟังก์ชันที่ผูกกับ "กลไกของ Google Sheets/Apps Script" โดยตรง
 *      (ตั้ง Data validation ในชีต · ตั้ง Trigger · แชร์ไฟล์ใน Drive)
 *      ไม่มีของให้เรียกในระบบใหม่ — ไม่ได้ตัดทิ้งเงียบ ๆ แต่ตอบกลับเป็น
 *      ข้อความบอกเหตุผลที่ /api/maint/* ให้เห็นบนหน้าจอ
 * ═══════════════════════════════════════════════════════════════════ */

const L = require('./lib');
const IMG = require('./images');
const DASH = require('./dashboard');
const MAINT = require('./maintenance');
const { todayTH, stampTH } = require('../../core/thai-date');

/* ‼ ชื่อพนักงานขาย "(ชื่อเล่น) ชื่อจริง นามสกุล" — สูตรอยู่ที่เดียวคือ core/sale-name.js
 *   (ยกมาจาก buildNameLookup_ Code.gs:1096 ซึ่งเดิมซ่อนอยู่ใน maintenance.js ไฟล์เดียว) */
const SN = require('../../core/sale-name');

const {
  CONFIG, ENUMS, IMG_FIELDS, OUTSOURCE_EDITORS, ADMIN_USERS,
  nrm_, validName_, pick_, dbCol, toGregMs_, dispBE_, toBE_, fmtIso_,
  genId8_, isSalesLikePerm_, nameTokens_, wgOf_, countGroups_,
} = L;

const clean = s => String(s == null ? '' : s).trim();
/* ‼ เวลาปัจจุบันสำหรับบันทึกลง timestamptz — ติดเขตเวลาไทย (+07:00) มาด้วย
 *   พี่เอสั่ง 13 ก.ย. 69: "บันทึกเวลา วันที่ ให้ถูกต้องตามเวลาของไทย 100%"
 *   เดิม new Date().toISOString() = ตัวอักษร UTC — จุดเวลาเดียวกันก็จริง แต่ใครก็ตาม
 *   ที่อ่านค่าดิบแล้วตัดสตริงเอาชั่วโมง จะได้ชั่วโมง UTC (ช้ากว่าไทย 7 ชม.)
 *   ⇒ ใช้ฟังก์ชันกลางที่เดียวของทั้งระบบ: core/thai-date.js */
const nowISO = () => require('../../core/thai-date').isoTH();

/** ผู้ใช้ที่ล็อกอินอยู่ → username (แทน ?u= ของเดิม) */
const userOf = req => clean(req.user && req.user.username).toLowerCase();

async function mount(router, ctx) {
  const { db } = ctx;
  const express = require('express');
  /* รูปส่งมาเป็น data URL — ของเดิมย่อให้ไม่เกิน ~150KB ต่อรูปแล้ว
   * แต่ 1 งานมีได้ถึง 9 รูป + งานย่อยอีกหลายใบ จึงเผื่อไว้ 25MB เท่า server.js */
  router.use(express.json({ limit: '25mb' }));

  /* ═══════════════════════════════════════════════════════════════
   *  ผู้ใช้ — userDirectory_ (Code.gs:729) · getGraphicUsers_ (Code.gs:390)
   *          getSalesUsers_ (Code.gs:422) · getContactSalesUsers_ (Code.gs:359)
   * ═══════════════════════════════════════════════════════════════ */
  async function allUsers() {
    return await db.selectAll('app_users',
      { select: '"Name","Nickname","Username","Permission","Status","Impage"', order: '_id.asc' }) || [];
  }

  /** ตัดผู้ใช้ที่ปิดบัญชี — ของเดิมเช็ค 3 ค่านี้เป๊ะ (Code.gs:408) */
  const isOff = st => {
    const s = clean(st).toLowerCase();
    return s === 'inactive' || s === 'disabled' || s === 'ลาออก';
  };

  function graphicUsers_(rows) {
    const want = CONFIG.GRAPHIC_PERMISSION.toLowerCase();
    const out = [], seen = {};
    for (const r of rows) {
      const name = clean(r.Name);
      const perm = clean(r.Permission).toLowerCase();
      if (!name) continue;
      if (perm === want || perm.indexOf('graphic') >= 0 || perm.indexOf('กราฟิก') >= 0) {
        if (isOff(r.Status)) continue;
        const nm = nrm_(name), key = nm.toLowerCase();
        if (seen[key]) continue;
        seen[key] = true;
        out.push({ name: nm, nickname: clean(r.Nickname) });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'th'));
    return out;
  }

  function salesUsers_(rows) {
    const out = [], seen = {};
    for (const r of rows) {
      const name = clean(r.Name);
      const perm = clean(r.Permission).toLowerCase();
      if (!name) continue;
      if (!isSalesLikePerm_(perm)) continue;
      if (isOff(r.Status)) continue;
      /* ‼ ของเดิมใช้ Name ดิบ ๆ เพราะในชีต Name ใส่วงเล็บชื่อเล่นมาแล้ว
       *   แถวที่ยังไม่ได้ใส่ (Name = "จุฬารัตน์ เรืองโชติ" เฉย ๆ) จะหลุดรูปแบบ
       *   ⇒ ให้ของกลางประกอบให้ · ถ้ามีวงเล็บอยู่แล้วจะคืนค่าเดิมทั้งก้อน */
      const nm = SN.compose(r), key = nm.toLowerCase();
      if (!nm || seen[key]) continue;
      seen[key] = true;
      out.push(nm);
    }
    out.sort((a, b) => a.localeCompare(b, 'th'));
    return out;
  }

  /** รายชื่อในป๊อปอัป "เพิ่มลูกค้าใหม่" — sales-like + username 'suntorn' (Code.gs:359) */
  function contactSalesUsers_(rows) {
    const out = [], seen = {};
    for (const r of rows) {
      const name = clean(r.Name);
      if (!name) continue;
      const perm = clean(r.Permission);
      const user = clean(r.Username).toLowerCase();
      if (!isSalesLikePerm_(perm) && user !== 'suntorn') continue;
      if (isOff(r.Status)) continue;
      /* ‼ รูปแบบเดียวกับตัวกรอง — ที่นี่คือ "ค่าที่จะถูกบันทึกลง contacts.Create By"
       *   ถ้าที่นี่เป็นชื่อเล่นเปล่า ๆ ลูกค้าใหม่ทุกรายจะเกิดปัญหาเดิมซ้ำอีก */
      const nm = SN.compose(r), key = nm.toLowerCase();
      if (!nm || seen[key]) continue;
      seen[key] = true;
      out.push(nm);
    }
    out.sort((a, b) => a.localeCompare(b, 'th'));
    return out;
  }

  async function userDirectory_() {
    const dir = {};
    for (const r of await allUsers()) {
      const u = clean(r.Username);
      if (!u) continue;
      dir[u.toLowerCase()] = {
        username: u, name: nrm_(r.Name), nickname: clean(r.Nickname),
        permission: clean(r.Permission), impage: clean(r.Impage),
      };
    }
    return dir;
  }

  /* ═══════════════════════════════════════════════════════════════
   *  สิทธิ์ลบ — canDeleteProject_ (Code.gs:2261) ยกมาทั้งก้อน
   *  แอดมินลบได้ทุกงาน · Sale support ลบได้ทุกงาน · คนอื่นลบได้เฉพาะงานตัวเอง
   * ═══════════════════════════════════════════════════════════════ */
  async function canDeleteProject_(username, salesName) {
    const u = clean(username).toLowerCase();
    if (!u) return { ok: false, reason: 'ไม่พบชื่อผู้ใช้ (username ว่าง)' };
    if (ADMIN_USERS[u]) return { ok: true, reason: 'admin-user' };
    const d = (await userDirectory_())[u];
    if (!d) return { ok: false, reason: 'ไม่พบผู้ใช้ "' + username + '" ในชีต User' };
    const perm = clean(d.permission).toLowerCase().replace(/\s+/g, ' ').trim();
    if (perm.indexOf('admin') >= 0 || perm.indexOf('ผู้ดูแล') >= 0) return { ok: true, reason: 'admin-permission' };
    if (perm.replace(/[_-]/g, ' ').replace(/sales/g, 'sale').indexOf('sale support') >= 0) return { ok: true, reason: 'sale-support' };
    const st = nameTokens_(salesName);
    if (!st.length) return { ok: false, reason: 'งานนี้ไม่มีชื่อพนักงานขาย จึงตรวจเจ้าของไม่ได้ (ต้องให้ผู้ดูแลลบ)' };
    const mine = nameTokens_(d.name || '').concat(nameTokens_(d.nickname || ''));
    for (const a of mine) for (const b of st) {
      if (a === b || b.indexOf(a) >= 0 || a.indexOf(b) >= 0) return { ok: true, reason: 'owner' };
    }
    return { ok: false, reason: 'ลบได้เฉพาะงานของตัวเอง — งานนี้เป็นของ "' + nrm_(salesName) +
      '" แต่คุณคือ "' + (d.nickname || d.name || username) + '" (สิทธิ์: ' + (d.permission || 'ไม่ระบุ') + ')' };
  }

  /** canForceFinish (Code.gs:2493) — เฉพาะ admin, namna, suntorn */
  const canForceFinish = username => {
    const u = clean(username).toLowerCase();
    return (CONFIG.FORCE_FINISH_USERS || []).some(x => String(x).toLowerCase() === u);
  };
  /** canEditOutsource (Code.gs:906) — เฉพาะ admin, namna */
  const canEditOutsource = username => !!OUTSOURCE_EDITORS[clean(username).toLowerCase()];

  /* ═══════════════════════════════════════════════════════════════
   *  แถวถัดไปของตาราง (ระบบใหม่ใช้ _row เป็นคีย์เหมือนตารางขาย)
   *  ‼ เริ่มจาก max(_row)+1 เสมอ ไม่เอาเลขที่เคยถูกลบกลับมาใช้ซ้ำ
   * ═══════════════════════════════════════════════════════════════ */
  async function nextRow(table) {
    const r = await db.select(table, { select: '_row', order: '_row.desc', limit: 1 });
    return (Array.isArray(r) && r[0] ? Number(r[0]._row) : 0) + 1;
  }

  /** ตัดชื่อว่างและชื่อซ้ำออก เก็บตัวแรกที่เจอ ลำดับเดิมไม่ขยับ
   *  ‼ ใช้กับรายชื่อที่อ่านจากตารางกระจก ซึ่ง "ชื่อเดียวกันมีได้หลายแถว" */
  function uniqNames_(arr) {
    const seen = new Set(); const out = [];
    for (const v of arr || []) {
      if (!v || seen.has(v)) continue;
      seen.add(v); out.push(v);
    }
    return out;
  }

  /** หาแถวของงานตาม ID — findProjectRow_ (Code.gs:2530) */
  async function findProjectRow_(id) {
    const t = clean(id);
    if (!t) return 0;
    const r = await db.one('projects', { select: '_row', ID: 'eq.' + t });
    return r ? Number(r._row) : 0;
  }
  /** verifyRow_ (Code.gs:2518) — แถวที่หน้าเว็บส่งมายังเป็นงานใบนี้จริงไหม */
  async function verifyRow_(id, row) {
    row = parseInt(row, 10);
    if (!row || row < 1) return 0;
    const r = await db.one('projects', { select: '"ID"', _row: 'eq.' + row });
    return (r && clean(r.ID).toLowerCase() === clean(id).toLowerCase()) ? row : 0;
  }

  /* ═══════════════════════════════════════════════════════════════
   *  งานย่อย — getRequirements_ (Code.gs:2586) · saveRequirements_ (Code.gs:2624)
   * ═══════════════════════════════════════════════════════════════ */
  async function getRequirements_(projectId) {
    try {
      const rows = await db.selectAll('requirements',
        { select: '*', project_id: 'eq.' + clean(projectId), order: '_row.asc' }) || [];
      const raws = rows.map(r => clean(r.image)).filter(Boolean);
      const umap = await IMG.urlMap(raws);
      return rows.map(r => ({
        requirement_id: clean(r.requirement_id),
        requirement_name: clean(r.requirement_name),
        job_type: clean(r.job_type),
        status: clean(r.status),
        size_w: r.size_w == null ? '' : r.size_w,
        size_h: r.size_h == null ? '' : r.size_h,
        quantity: r.quantity == null ? '' : r.quantity,
        brief_detail: clean(r.brief_detail),
        site_check_date: fmtIso_(r.site_check_date),
        work_group: clean(r.work_group),
        job_order: clean(r['Status JobOrder']) || clean(r.job_order_status),
        image: clean(r.image) ? (umap[clean(r.image)] || '') : '',
        /* 🔴 บอกด้วยว่า "มีค่าในช่องรูป แต่เปิดกลับไม่ได้" — คนละเรื่องกับ "ไม่มีรูป"
         *   (พี่เอสั่ง 9 ก.ย. 69: "อย่าลืมตรวจในส่วนของ project ย่อยด้วยนะ") */
        imageRaw: clean(r.image),
        imageBroken: !!(clean(r.image) && !umap[clean(r.image)]),
      }));
    } catch (e) {
      /* ‼ ห้ามกลืนเงียบ — งานย่อยหายทั้งชุดโดยไม่มีใครรู้ คือบั๊กที่หายากที่สุด */
      ctx.warn('getRequirements_ ล้มเหลว:', e.message);
      return [];
    }
  }

  /** บันทึกงานย่อย: อัปเดตของเดิม / เพิ่มใหม่ / ลบที่ถูกเอาออก (Code.gs:2624) */
  async function saveRequirements_(projectId, reqs, completedAt, projectGroup) {
    reqs = reqs || [];
    /* 🔴 เก็บคำเตือนเรื่องรูปงานย่อย แล้วส่งกลับให้ผู้เรียกไปบอกหน้าจอ
     *   (พี่เอสั่ง 9 ก.ย. 69 — "ไม่รู้ว่าถูกบันทึกได้หรือเปล่า ต้องเช็คให้ 100%") */
    const reqImgWarn = [];
    const cur = await db.selectAll('requirements',
      { select: '_row,requirement_id', project_id: 'eq.' + clean(projectId), order: '_row.asc' }) || [];
    const existing = {};
    for (const r of cur) { const rid = clean(r.requirement_id); if (rid) existing[rid] = Number(r._row); }

    const keep = {};
    let row = await nextRow('requirements');
    for (const req of reqs) {
      if (!req || (!req.requirement_name && !req.job_type)) continue;
      const values = {
        requirement_name: clean(req.requirement_name),
        job_type: clean(req.job_type),
        status: clean(req.status) || 'Not started',
        size_w: (req.size_w !== '' && req.size_w != null) ? Number(req.size_w) : null,
        size_h: (req.size_h !== '' && req.size_h != null) ? Number(req.size_h) : null,
        quantity: (req.quantity !== '' && req.quantity != null) ? Number(req.quantity) : null,
        brief_detail: clean(req.brief_detail),
        work_group: wgOf_(req.work_group, projectGroup),
        'Status JobOrder': clean(req.job_order),
        site_check_date: toBE_(req.site_check_date) || null,
        'Updated At': nowISO(),
      };
      if (completedAt) values.completed_at = completedAt;      /* งานหลัก Complete → ดันวันลงงานย่อย */
      const rid = clean(req.requirement_id);
      if (req.image) {
        if (/^data:/.test(req.image)) {
          /* 🔴 รู้ผลทุกครั้ง ไม่เงียบ (พี่เอสั่ง 9 ก.ย. 69 — "ต้องเช็คให้ 100%") */
          const ri = await IMG.saveImageEx(req.image, 'Requirements_Images', (rid || genId8_()) + '.image');
          values.image = ri.path;
          if (!ri.ok || ri.why) reqImgWarn.push('งานย่อย "' + clean(req.requirement_name) + '": ' + ri.why);
        } else values.image = req.image;
      }
      if (rid && existing[rid]) {
        await db.update('requirements', { _row: 'eq.' + existing[rid] }, values);
        keep[rid] = true;
      } else {
        const nrid = genId8_();
        values.requirement_id = nrid;
        values.project_id = clean(projectId);
        values._row = row++;
        values._synced_at = nowISO();
        await db.insert('requirements', [values]);
      }
    }
    /* ที่หายไปจากฟอร์ม = ถูกลบ — ย้ายเข้าถังขยะก่อนเสมอ (ของเดิม deleteRow ทิ้งเลย
     * แต่ของเดิมมีถังขยะที่ระดับ "ลบทั้งงาน" อยู่แล้ว จึงยกมาตรฐานเดียวกันมาใช้) */
    const gone = Object.keys(existing).filter(rid => !keep[rid]);
    for (const rid of gone) {
      const full = await db.one('requirements', { select: '*', _row: 'eq.' + existing[rid] });
      if (full) {
        await db.insert('requirements_trash', [{
          requirement_id: rid, project_id: clean(projectId), row_no: existing[rid],
          data: full, deleted_by: 'saveRequirements',
        }]).catch(() => {});
      }
      await db.remove('requirements', { _row: 'eq.' + existing[rid] });
    }
    return { imageWarnings: reqImgWarn };
  }

  /* ═══════════════════════════════════════════════════════════════
   *  ⓵ ตัวเลือกฟอร์ม — getFormOptions (Code.gs:330)
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/options', async (req, res) => {
    try {
      const rows = await allUsers();
      /* ‼ 17 ก.ย. 69 — ขอทั้งแถว (*) แทนช่องเดียว เพื่ออ่านธง _app_active ด้วย
       *   ‼ ใช้ * โดยตั้งใจ: _app_active เพิ่งมาจาก sql/83 — ระบุชื่อตรง ๆ แล้วยังไม่ได้
       *     รัน SQL PostgREST ตอบ 400 ทั้งคำขอ ⇒ หน้า Projects ตายทั้งหน้า */
      const chRows = (await db.selectAll('channels', { select: '*', order: '_row.asc' }) || [])
        /* 🔴 ช่องทางที่ถูกปิดที่หน้าทะเบียนกลาง ไม่ต้องขึ้นดรอปดาวน์
         *   null / undefined = เปิดอยู่ — เทียบกับ false ตรง ๆ เท่านั้น */
        .filter(r => r._app_active !== false);
      const osRows = await db.selectAll('outsource', { select: '_row,_extra', order: '_row.asc' }) || [];
      res.json({
        ok: true,
        workGroups: ENUMS.workGroups,
        jobTypes: ENUMS.jobTypes,
        deliveryTypes: ENUMS.deliveryTypes,
        statuses: ENUMS.statuses,
        reqJobTypes: ENUMS.reqJobTypes,
        reqStatuses: ENUMS.reqStatuses,
        jobOrderStatuses: ENUMS.jobOrderStatuses,
        graphics: graphicUsers_(rows),
        /* 🔴 กันชื่อซ้ำ — เติม 17 ก.ย. 69 (เหตุผลเดียวกับ modules/appraisal/db.js)
         *   app.channels มีทั้งแถวจากชีตและแถวที่เพิ่มในระบบใหม่ (_row >= 900000000)
         *   ชื่อเดียวกันโผล่ได้ 2 แถว ⇒ กรองตอนอ่าน ไม่ใช่ตอนเขียนลงฐาน */
        channels: uniqNames_(chRows.map(r => clean(r.Channel))),
        outsources: osRows.map(osName).filter(Boolean),
        contactSales: contactSalesUsers_(rows),
      });
    } catch (e) {
      ctx.warn('options:', e.message);
      res.status(500).json({ ok: false, error: 'อ่านตัวเลือกไม่สำเร็จ: ' + e.message });
    }
  });

  /* ชื่อบริษัทใน _extra ของตาราง outsource (หัวตารางไม่ได้ประกาศไว้ในโค้ดเดิม —
   * ของเดิมอ่านคอลัมน์ "ชื่อบริษัท" ถ้าไม่มีก็ใช้คอลัมน์ A · Code.gs:880) */
  function osName(r) {
    const x = r._extra || {};
    return clean(x['ชื่อบริษัท'] || x['ชื่อ'] || Object.values(x)[0] || '');
  }

  /* ═══ ⓶ รายชื่อ Outsource — listOutsources (Code.gs:890) ═══ */
  router.get('/api/outsource', async (req, res) => {
    try {
      const rows = await db.selectAll('outsource', { select: '_row,_extra', order: '_row.asc' }) || [];
      res.json({
        ok: true,
        canEdit: canEditOutsource(userOf(req)),
        rows: rows.map(r => ({ row: Number(r._row), name: osName(r) })).filter(x => x.name),
      });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  /* saveOutsource (Code.gs:911) — add / edit / delete */
  router.post('/api/outsource/save', async (req, res) => {
    const username = userOf(req);
    if (!canEditOutsource(username))
      return res.status(403).json({ ok: false, error: 'ไม่มีสิทธิ์แก้ไขรายชื่อ Outsource (เฉพาะ admin และ namna เท่านั้น)' });
    try {
      const action = clean(req.body && req.body.action);
      const name = nrm_(req.body && req.body.name);
      const row = Number(req.body && req.body.row) || 0;

      if (action === 'delete') {
        if (!row) return res.status(400).json({ ok: false, error: 'ไม่พบแถวที่จะลบ' });
        const gone = await db.remove('outsource', { _row: 'eq.' + row });
        if (!Array.isArray(gone) || !gone.length)
          return res.status(400).json({ ok: false, error: 'ไม่พบแถวที่จะลบ' });
        ctx.audit(req.user, 'outsource_delete', 'ลบรายชื่อ Outsource แถว ' + row);
        return res.json({ ok: true });
      }

      if (!name) return res.status(400).json({ ok: false, error: 'กรุณากรอกชื่อ' });
      /* กันชื่อซ้ำ — เทียบแบบไม่สนตัวพิมพ์ เหมือนของเดิม (Code.gs:928) */
      const all = await db.selectAll('outsource', { select: '_row,_extra', order: '_row.asc' }) || [];
      for (const r of all) {
        if (nrm_(osName(r)).toLowerCase() === name.toLowerCase() && Number(r._row) !== row)
          return res.status(400).json({ ok: false, error: 'มีชื่อนี้อยู่แล้ว: ' + name });
      }

      if (action === 'edit') {
        if (!row) return res.status(400).json({ ok: false, error: 'ไม่พบแถวที่จะแก้ไข' });
        const cur = await db.one('outsource', { select: '_extra', _row: 'eq.' + row });
        if (!cur) return res.status(400).json({ ok: false, error: 'ไม่พบแถวที่จะแก้ไข' });
        const ex = { ...(cur._extra || {}) }; ex['ชื่อบริษัท'] = name;
        await db.update('outsource', { _row: 'eq.' + row }, { _extra: ex, _synced_at: nowISO() });
        ctx.audit(req.user, 'outsource_edit', 'แก้เป็น ' + name);
        return res.json({ ok: true });
      }

      const rowNo = await nextRow('outsource');
      await db.insert('outsource', [{ _row: rowNo, _extra: { 'ชื่อบริษัท': name }, _synced_at: nowISO() }]);
      ctx.audit(req.user, 'outsource_add', name);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  /* ═══ ⓷ ลูกค้า — getContacts (Code.gs:949) ═══ */
  router.get('/api/contacts', async (req, res) => {
    try {
      const rows = await db.selectAll('contacts',
        { select: '"ID","First Name","Phone","แสดงชื่อบริษัท","Create By"', order: '_row.asc' }) || [];
      /* 🔴 การ์ด "ข้อมูลลูกค้า" ช่องพนักงานขาย (Index.html:493 #cvSales)
       *   ข้อมูลเก่าในตาราง contacts คีย์ไว้เป็นชื่อเล่นเปล่า ๆ ("น้ำ")
       *   แต่ตัวกรองพนักงานขายใช้ชื่อมาตรฐาน "(น้ำ) จุฬารัตน์ เรืองโชติ"
       *   ⇒ สองที่ไม่ตรงกัน (พี่เอส่งภาพมา 14 ก.ย. 69)
       *   ‼ แปลงตอนแสดงผล — ตาราง contacts ไม่ถูกเขียนทับแม้แต่ช่องเดียว
       *   ‼ ทะเบียนขอ "ครั้งเดียวต่อคำขอ" แล้วใช้กับทุกแถว ไม่ใช่ขอรายแถว */
      const dir = await SN.directorySafe();
      const out = [];
      for (const r of rows) {
        const id = clean(r.ID);
        if (!id) continue;
        const company = clean(r['แสดงชื่อบริษัท']);
        const first = clean(r['First Name']);
        if (!company && !first) continue;
        out.push({ id, company, person: first, phone: clean(r.Phone),
                   sales: SN.resolve(dir, r['Create By']) });
      }
      out.reverse();                             /* ใหม่สุดอยู่บน (Code.gs:976) */
      res.json({ ok: true, rows: out });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  /* createContact (Code.gs:1304) */
  router.post('/api/contact/create', async (req, res) => {
    try {
      const p = req.body || {};
      const company = clean(p.company), person = clean(p.person);
      if (!company && !person)
        return res.status(400).json({ ok: false, error: 'กรุณากรอกชื่อบริษัทหรือผู้ติดต่อ' });
      const id = genId8_();
      const phone = clean(p.phone), sales = clean(p.sales), channel = clean(p.channel);
      const row = await nextRow('contacts');
      await db.insert('contacts', [{
        _row: row, _synced_at: nowISO(),
        ID: id, 'First Name': person, 'แสดงชื่อบริษัท': company, Company: company,
        Phone: phone, 'From Channel': channel, 'Create By': sales,
      }]);
      ctx.audit(req.user, 'contact_create', company || person, { target: id });
      res.json({ ok: true, contact: { id, company, person, phone, sales } });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  /* ═══ ⓸ งานล่าสุด · ค้นหา · ตัวเลือกตัวกรอง ═══ */
  router.get('/api/recent', async (req, res) => {
    try { res.json({ ok: true, rows: await DASH.getRecentProjects() }); }
    catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  router.get('/api/search', async (req, res) => {
    try {
      const rows = await DASH.searchProjects({
        q: req.query.q, sales: req.query.sales, owner: req.query.owner,
        status: req.query.status, jobType: req.query.jobType,
        dateFrom: req.query.dateFrom, dateTo: req.query.dateTo,
      });
      res.json({ ok: true, rows });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  router.get('/api/search-options', async (req, res) => {
    try {
      const rows = await allUsers();
      res.json({ ok: true, ...(await DASH.getSearchOptions({
        salesUsers: salesUsers_(rows), graphics: graphicUsers_(rows),
      })) });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  /* ═══ ⓹ Dashboard · กล่องงาน · ปฏิทิน ═══ */
  router.get('/api/dashboard', async (req, res) => {
    try {
      res.json({ ok: true, ...(await DASH.getDashboard({
        period: req.query.period, sales: req.query.sales, owner: req.query.owner,
        group: req.query.group, from: req.query.from, to: req.query.to,
      })) });
    } catch (e) {
      ctx.warn('dashboard:', e.message);
      res.status(500).json({ ok: false, error: 'โหลด Dashboard ไม่สำเร็จ: ' + e.message });
    }
  });

  router.get('/api/box', async (req, res) => {
    try {
      res.json({ ok: true, rows: await DASH.getBoxItems(
        clean(req.query.box), clean(req.query.owner), clean(req.query.period) || 'month') });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  router.get('/api/calendar', async (req, res) => {
    try {
      res.json(await DASH.getGraphicCalendar({
        from: clean(req.query.from), to: clean(req.query.to),
        owner: clean(req.query.owner), group: clean(req.query.group),
        includeDone: String(req.query.includeDone) === '1',
      }));
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  /* ═══ ⓺ อ่านงาน 1 ใบ — getProject (Code.gs:2681) ═══ */
  router.get('/api/project/:id', async (req, res) => {
    try {
      const id = clean(req.params.id);
      const r = await db.one('projects', { select: '*', ID: 'eq.' + id });
      if (!r) return res.json({ ok: true, project: null });
      /* ‼ การ์ดลูกค้าตอน "เปิดงานเดิมมาแก้" ใช้ช่องเดียวกับตอนค้นลูกค้า
       *   (#cvSales · Index.html:1902 sname = c.sales || p.sales)
       *   ⇒ ต้องเป็นรูปแบบเดียวกัน ไม่งั้นเปิดงานเก่ามาแก้แล้วชื่อเปลี่ยนหน้าตา */
      const dirP = await SN.directorySafe();
      const images = {};
      const raws = IMG_FIELDS.map(f => clean(r[f])).filter(Boolean);
      const umap = await IMG.urlMap(raws);
      for (const f of IMG_FIELDS) {
        const v = clean(r[f]);
        if (v && umap[v]) images[f] = umap[v];
      }
      res.json({ ok: true, project: {
        row: Number(r._row) || 0,
        id, project: clean(r.Project),
        contactId: clean(r['ชื่อลูกค้า']), companyName: clean(r['แสดงชื่อลูกค้า']),
        sales: SN.resolve(dirP, r['พนักงานขาย']),
        workGroup: clean(r['กลุ่มงาน']),
        jobType: clean(r['ประเภทงาน']), owner: clean(r.Owner), status: clean(r.Status),
        deliveryType: clean(r['ประเภทการจัดส่ง']), deliveryAddress: clean(r['ที่อยู่จัดส่ง']),
        locationMaps: clean(r['Location maps']),
        started: fmtIso_(r.Started), due: fmtIso_(r.Due), complete: fmtIso_(r.Complete),
        deliveryCust: fmtIso_(r['วันที่ส่งมอบให้ลูกค้า']), description: clean(r.Description),
        outsource: clean(r.Outsource), slip: clean(r['เลขที่ Slip ชำระเงิน']),
        statusJobOrder: clean(r['Status JobOrder']),
        installFee: r['ค่าติดตั้งงาน'] == null ? '' : r['ค่าติดตั้งงาน'],
        pdfFile: clean(r['PDF File']),
        receiver: clean(r['ชื่อผู้รับ']), receiverPhone: clean(r['เบอร์ติดต่อ']),
        requirements: await getRequirements_(id),
        images,
      } });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  /* ═══ ⓻ เปิดงานใหม่ — createProject (Code.gs:1202) ═══ */
  router.post('/api/project/create', async (req, res) => {
    const payload = req.body || {};
    if (!payload.deliveryCust)
      return res.status(400).json({ ok: false, error: 'กรุณาระบุวันที่ส่งมอบให้ลูกค้า ก่อนบันทึก' });
    { const gap = installGap_(payload); if (gap) return res.status(400).json({ ok: false, error: gap }); }
    try {
      /* ใช้รหัสที่ฟอร์มสร้างไว้ (ผู้ใช้เห็นบนจอแล้ว) ถ้าถูกรูปแบบ ไม่งั้นสร้างใหม่ */
      let id = (payload.projectId && /^[0-9a-f]{8}$/i.test(payload.projectId))
        ? String(payload.projectId).toLowerCase() : genId8_();
      /* ‼ ของเดิมไม่เคยตรวจว่า ID ชนไหม — ตรวจให้ที่นี่ ถ้าชนก็สุ่มใหม่
       *   (ไม่ใช่ฟีเจอร์ใหม่ แต่เป็นการปิดรูที่ของเดิมเปิดค้างไว้)
       *
       * 🔴 19 ก.ย. 69 — รูที่ยังเหลืออยู่ในยามตัวนี้เอง (พี่เอสั่ง "ต้องป้องกัน")
       *    ของเดิมเขียนว่า "ลองไม่เกิน 5 ครั้ง" แล้ว **ไหลลงไป insert ต่อเลย**
       *    ไม่ว่าครั้งที่ 5 จะยังชนอยู่หรือไม่ ⇒ ในทางทฤษฎียังออก ID ซ้ำได้
       *    และที่แย่กว่าคือ "ซ้ำแล้วเงียบ" ซึ่งเป็นอาการเดียวกับที่พี่เอเจอ
       *    ⇒ จำคำตอบของการตรวจครั้งสุดท้ายไว้ แล้วถ้ายังชน **ต้องไม่เขียน**
       *      (จำนวนครั้งที่ถามฐานเท่าเดิมเป๊ะ ไม่ได้เพิ่มคำขอสักครั้ง) */
      let dupRow = await findProjectRow_(id);
      for (let i = 0; i < 5 && dupRow; i++) { id = genId8_(); dupRow = await findProjectRow_(id); }
      if (dupRow) {
        ctx.warn('createProject: ออกรหัสงานใหม่ไม่สำเร็จ ชนทุกครั้ง id=' + id);
        return res.status(409).json({ ok: false,
          error: 'ออกรหัสงานใหม่ไม่สำเร็จ — รหัสที่สุ่มได้ชนกับงานที่มีอยู่ทุกครั้ง ' +
                 'กรุณากด "เปิดงานใหม่" เพื่อรับรหัสใหม่แล้วบันทึกอีกครั้ง (ยังไม่มีอะไรถูกบันทึก)' });
      }

      /* 🔴 "วันนี้" ต้องเป็นวันไทย ไม่ใช่วันของเครื่องเซิร์ฟเวอร์ (Railway = UTC)
       *    ตี 0–7 โมงบ้านเรา UTC ยังเป็นเมื่อวาน → วันเปิดงาน/วัน Complete จะเพี้ยน */
      const now = todayTH();
      const started = toBE_(payload.started) || toBE_(now);
      const due = toBE_(payload.due);

      /* ═══════════════════════════════════════════════════════════
       *  🔴 พี่เอสั่ง 9 ก.ย. 69: "ไม่รู้ว่าถูกบันทึกได้หรือเปล่าด้วยนะ
       *     ต้องเช็คให้ 100% นะ"
       *  ⇒ ทุกช่องรูปต้องรู้ผลว่า "ขึ้นสำเร็จ / ไม่สำเร็จเพราะอะไร"
       *    แล้วส่งกลับไปบอกหน้าจอ ไม่ใช่เงียบแล้วปล่อยให้ไปเจอเอาทีหลัง
       * ═══════════════════════════════════════════════════════════ */
      const imgValues = {};
      const imgWarn = [];
      for (const f of IMG_FIELDS) {
        const v = payload.images && payload.images[f];
        if (!v) continue;
        if (!/^data:/.test(v)) { imgValues[f] = v; continue; }   /* ค่าเดิมที่มีอยู่แล้ว */
        const r = await IMG.saveImageEx(v, 'Projects_Images', id + '.' + f);
        imgValues[f] = r.path;
        if (!r.ok) imgWarn.push(f + ': ' + r.why);
        else if (r.why) imgWarn.push(f + ': ' + r.why);          /* ขึ้น Drive แล้วแต่จดดัชนีไม่ติด */
      }

      const gCnt = countGroups_(payload.requirements, payload.workGroup);
      const values = {
        ID: id,
        'ชื่อลูกค้า': clean(payload.contactId),
        'แสดงชื่อลูกค้า': clean(payload.companyName),
        'พนักงานขาย': clean(payload.sales),
        Project: clean(payload.project),
        'กลุ่มงาน': clean(payload.workGroup),
        'จำนวนงานพิมพ์': gCnt.print,
        'จำนวนงานป้าย': gCnt.sign,
        'ประเภทงาน': clean(payload.jobType),
        Owner: clean(payload.owner),
        Status: clean(payload.status) || 'Not Started',
        'ประเภทการจัดส่ง': clean(payload.deliveryType),
        'ที่อยู่จัดส่ง': clean(payload.deliveryAddress),
        'Location maps': clean(payload.locationMaps),
        Description: clean(payload.description),
        Started: started || null,
        Due: due || null,
        'วันที่ส่งมอบให้ลูกค้า': toBE_(payload.deliveryCust) || null,
        Complete: (payload.status === 'Complete') ? (toBE_(payload.completeDate) || toBE_(now)) : null,
        'Status JobOrder': clean(payload.statusJobOrder),
        'เลขที่ Slip ชำระเงิน': clean(payload.slip),
        'PDF File': clean(payload.pdfFile),
        [dbCol('ได้รับเงินแล้ว / ลูกค้าเครดิต')]: clean(payload.paid),
        [dbCol('วันที่ confirm ตรวจสอบการรับเงิน')]: toBE_(payload.confirmDate) || null,
        'ผู้ยืนยันรับเงิน': clean(payload.confirmBy),
        'ชื่อผู้รับ': clean(payload.receiver),
        'เบอร์ติดต่อ': clean(payload.receiverPhone),
        'ค่าติดตั้งงาน': (payload.installFee !== '' && payload.installFee != null && !isNaN(payload.installFee))
          ? Number(payload.installFee) : null,
        Outsource: clean(payload.outsource),
        cover_sheet_url: clean(payload.coverUrl),
        cover_sheet_date: toBE_(payload.coverDate) || null,
        'Updated At': nowISO(),
        _synced_at: nowISO(),
      };
      for (const f of IMG_FIELDS) if (imgValues[f]) values[f] = imgValues[f];
      values._row = await nextRow('projects');
      await db.insert('projects', [values]);

      let reqCount = 0;
      if (payload.requirements && payload.requirements.length) {
        let row = await nextRow('requirements');
        for (const req of payload.requirements) {
          if (!req || (!req.requirement_name && !req.job_type)) continue;
          const rid = genId8_();
          let imgUrl = '';
          if (req.image) {
            if (/^data:/.test(req.image)) {
              const ri = await IMG.saveImageEx(req.image, 'Requirements_Images', rid + '.image');
              imgUrl = ri.path;
              if (!ri.ok || ri.why) imgWarn.push('งานย่อย "' + clean(req.requirement_name) + '": ' + ri.why);
            } else imgUrl = req.image;
          }
          await db.insert('requirements', [{
            _row: row++, _synced_at: nowISO(), 'Updated At': nowISO(),
            requirement_id: rid,
            project_id: id,
            requirement_name: clean(req.requirement_name),
            job_type: clean(req.job_type),
            status: clean(req.status) || 'Not started',
            designer: clean(req.designer) || clean(payload.owner),
            size_w: (req.size_w !== '' && req.size_w != null) ? Number(req.size_w) : null,
            size_h: (req.size_h !== '' && req.size_h != null) ? Number(req.size_h) : null,
            quantity: (req.quantity !== '' && req.quantity != null) ? Number(req.quantity) : null,
            brief_detail: clean(req.brief_detail),
            work_group: wgOf_(req.work_group, payload.workGroup),
            'Status JobOrder': clean(req.job_order),
            site_check_date: toBE_(req.site_check_date) || null,
            meeting_date: started || null,
            completed_at: (payload.status === 'Complete')
              ? (toBE_(payload.completeDate) || toBE_(now)) : null,
            image: imgUrl,
          }]);
          reqCount++;
        }
      }
      ctx.audit(req.user, 'project_create', clean(payload.project), { target: id });
      /* 🤝 27 ต.ค. 69 พี่เอ: Sale support ที่ดูแลลูกค้าเปิดโปรเจกต์ให้เซลส์ได้ — "แจ้งด้วย" ⇒ แถบแจ้งเตือนในแอปคีย์ยอดขายของเซลส์ (ไม่สำเร็จ = เงียบ) */
      let notified = false;
      try { notified = await require('../sales/proxy').projectOpened(req.user, { id, project: clean(payload.project), customer: clean(payload.companyName), sales: clean(payload.sales) }); } catch (e) { notified = false; }
      /* 🔴 บอกผลรูปทุกครั้ง — ไม่ผ่านก็ต้องรู้ ไม่ใช่เงียบ (พี่เอสั่ง 9 ก.ย. 69) */
      res.json({ ok: true, id, requirements: reqCount, notifiedSale: notified || undefined,
                 imageWarnings: imgWarn,
                 imagesSaved: Object.keys(imgValues).filter(k => imgValues[k]).length });
    } catch (e) {
      ctx.warn('createProject:', e.message);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  /* 📍 v1.6.0 · พี่เอ 28 ต.ค. 69: "ล๊อคเงื่อนไข ว่าถ้าประเภทงานติดตั้ง ถ้าไม่ใส่ที่อยู่ กับ ลิงค์โลเคชั่น จะไม่ให้บันทึก"
   *   ประเภทการจัดส่ง = ติดตั้ง ⇒ ต้องมี ที่อยู่จัดส่ง + Location maps (ลิงก์ http/https) ทั้งคู่
   *   ‼ ด่านจริงอยู่ที่นี่ (เซิร์ฟเวอร์) — หน้าเว็บกันไว้ก่อนอีกชั้น ยิง API ตรงก็ผ่านไม่ได้
   *   ‼ ใช้ทั้งเปิดงานใหม่และแก้งานเดิม (งานติดตั้งเก่าที่ยังไม่มีที่อยู่ ต้องเติมก่อนถึงจะบันทึกได้) */
  function installGap_(p) {
    if (clean(p && p.deliveryType) !== 'ติดตั้ง') return '';
    const addr = clean(p.deliveryAddress), maps = clean(p.locationMaps);
    const miss = [];
    if (!addr) miss.push('ที่อยู่จัดส่ง');
    if (!maps) miss.push('Location maps (ลิงก์)');
    else if (!/^https?:\/\/\S+\.\S+/i.test(maps)) return 'งานติดตั้ง: ช่อง Location maps ต้องเป็นลิงก์ที่ขึ้นต้นด้วย https:// (เช่น ลิงก์แชร์จาก Google Maps) — ยังไม่ได้บันทึก';
    return miss.length ? 'งานติดตั้ง ต้องใส่ ' + miss.join(' และ ') + ' ก่อนบันทึก — ยังไม่ได้บันทึก' : '';
  }

  /* ═══ ⓼ แก้ไขงานเดิม — updateProject (Code.gs:2710) ═══ */
  router.post('/api/project/update', async (req, res) => {
    const payload = req.body || {};
    const id = clean(payload.id);
    if (!payload.deliveryCust)
      return res.status(400).json({ ok: false, error: 'กรุณาระบุวันที่ส่งมอบให้ลูกค้า ก่อนบันทึก' });
    { const gap = installGap_(payload); if (gap) return res.status(400).json({ ok: false, error: gap }); }
    try {
      const row = (await verifyRow_(id, payload.row)) || (await findProjectRow_(id));
      if (!row) return res.status(400).json({ ok: false, error: 'ไม่พบงาน ID ' + id });

      const values = {
        'ชื่อลูกค้า': clean(payload.contactId), 'แสดงชื่อลูกค้า': clean(payload.companyName),
        'พนักงานขาย': clean(payload.sales),
        Project: clean(payload.project), 'กลุ่มงาน': clean(payload.workGroup),
        'ประเภทงาน': clean(payload.jobType), Owner: clean(payload.owner), Status: clean(payload.status),
        'ประเภทการจัดส่ง': clean(payload.deliveryType), 'ที่อยู่จัดส่ง': clean(payload.deliveryAddress),
        'Location maps': clean(payload.locationMaps),
        Description: clean(payload.description),
        Started: toBE_(payload.started) || null, Due: toBE_(payload.due) || null,
        'วันที่ส่งมอบให้ลูกค้า': toBE_(payload.deliveryCust) || null,
        'Status JobOrder': clean(payload.statusJobOrder),
        'เลขที่ Slip ชำระเงิน': clean(payload.slip), 'PDF File': clean(payload.pdfFile),
        'ชื่อผู้รับ': clean(payload.receiver), 'เบอร์ติดต่อ': clean(payload.receiverPhone),
        'ค่าติดตั้งงาน': (payload.installFee !== '' && payload.installFee != null && !isNaN(payload.installFee))
          ? Number(payload.installFee) : null,
        Outsource: clean(payload.outsource),
        'Updated At': nowISO(),
      };
      /* 🔴 เช็คผลรูปทุกช่อง แล้วบอกกลับ (พี่เอสั่ง 9 ก.ย. 69 — "ต้องเช็คให้ 100%") */
      const imgWarn = [];
      let imagesSaved = 0;
      for (const f of IMG_FIELDS) {
        const v = payload.images && payload.images[f];
        if (!v) continue;
        if (!/^data:/.test(v)) { values[f] = v; continue; }
        const r = await IMG.saveImageEx(v, 'Projects_Images', id + '.' + f);
        values[f] = r.path;
        if (r.ok && r.path) imagesSaved++;
        if (!r.ok || r.why) imgWarn.push(f + ': ' + r.why);
      }
      /* Status = Complete → เซ็ตวันที่ Complete ให้ ; ไม่ Complete = ไม่แตะวันเดิม */
      if (payload.status === 'Complete')
        values.Complete = toBE_(payload.completeDate) || toBE_(todayTH());
      if (payload.requirements) {
        const gc = countGroups_(payload.requirements, payload.workGroup);
        values['จำนวนงานพิมพ์'] = gc.print; values['จำนวนงานป้าย'] = gc.sign;
      }
      await db.update('projects', { _row: 'eq.' + row }, values);

      if (payload.requirements) {
        const compForReq = (payload.status === 'Complete')
          ? (toBE_(payload.completeDate) || toBE_(todayTH())) : null;
        const rr = await saveRequirements_(id, payload.requirements, compForReq, payload.workGroup);
        if (rr && rr.imageWarnings) for (const w of rr.imageWarnings) imgWarn.push(w);
      }
      ctx.audit(req.user, 'project_update', clean(payload.project), { target: id });
      res.json({ ok: true, id, imageWarnings: imgWarn, imagesSaved });
    } catch (e) {
      ctx.warn('updateProject:', e.message);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  /* ═══ ⓽ ลบงาน (ย้ายไปถังขยะ) — deleteProject (Code.gs:2313) ═══ */
  router.post('/api/project/delete', async (req, res) => {
    try {
      const id = clean(req.body && req.body.id);
      const username = userOf(req);
      const row = (await verifyRow_(id, req.body && req.body.row)) || (await findProjectRow_(id));
      if (!row) return res.status(400).json({ ok: false, error: 'ไม่พบงาน ID ' + id });

      const full = await db.one('projects', { select: '*', _row: 'eq.' + row });
      const chk = await canDeleteProject_(username, full && full['พนักงานขาย']);
      if (!chk.ok) return res.status(403).json({ ok: false, error: chk.reason });

      /* 1) ย้ายแถวงานหลักไปถังขยะ แล้วค่อยลบ */
      await db.insert('projects_trash', [{ project_id: id, row_no: row, data: full, deleted_by: username }]);
      await db.remove('projects', { _row: 'eq.' + row });

      /* 2) งานย่อยทั้งหมดไปถังขยะ แล้วลบ */
      let reqDeleted = 0;
      try {
        const reqs = await db.selectAll('requirements',
          { select: '*', project_id: 'eq.' + id, order: '_row.asc' }) || [];
        if (reqs.length) {
          await db.insert('requirements_trash', reqs.map(r => ({
            requirement_id: clean(r.requirement_id), project_id: id,
            row_no: Number(r._row), data: r, deleted_by: username,
          })));
          await db.remove('requirements', { project_id: 'eq.' + id });
          reqDeleted = reqs.length;
        }
      } catch (e) { ctx.warn('ลบงานย่อยไม่ครบ:', e.message); }

      ctx.audit(req.user, 'project_delete', 'ลบงาน + งานย่อย ' + reqDeleted + ' ใบ', { target: id });
      res.json({ ok: true, id, requirements: reqDeleted });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  /* canDeleteId (Code.gs:2363) — หน้าเว็บใช้ซ่อน/แสดงปุ่มลบ */
  router.get('/api/can-delete/:id', async (req, res) => {
    try {
      const r = await db.one('projects', { select: '"พนักงานขาย"', ID: 'eq.' + clean(req.params.id) });
      if (!r) return res.json({ ok: true, can: false });
      const chk = await canDeleteProject_(userOf(req), r['พนักงานขาย']);
      res.json({ ok: true, can: chk.ok, reason: chk.reason });
    } catch { res.json({ ok: true, can: false }); }
  });

  /* ═══ ⑽ จ่ายงานให้กราฟิก — assignGraphic (Code.gs:2225) ═══ */
  router.post('/api/assign', async (req, res) => {
    try {
      const id = clean(req.body && req.body.id);
      const owner = nrm_(req.body && req.body.owner);
      const row = await findProjectRow_(id);
      if (!row) return res.status(400).json({ ok: false, error: 'ไม่พบงาน ID ' + id });
      await db.update('projects', { _row: 'eq.' + row }, { Owner: owner, 'Updated At': nowISO() });
      ctx.audit(req.user, 'project_assign', 'จ่ายงานให้ ' + owner, { target: id });
      res.json({ ok: true, id, owner });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  /* ═══ ⑾ ปิดงานย้อนหลัง — forceFinishProject (Code.gs:2500) ═══ */
  router.post('/api/finish', async (req, res) => {
    try {
      const username = userOf(req);
      if (!canForceFinish(username))
        return res.status(403).json({ ok: false, error: 'ไม่มีสิทธิ์กดจบงาน (เฉพาะ admin, namna, suntorn)' });
      const id = clean(req.body && req.body.id);
      const row = (await verifyRow_(id, req.body && req.body.row)) || (await findProjectRow_(id));
      if (!row) return res.status(400).json({ ok: false, error: 'ไม่พบงาน ID ' + id });
      const stamp = stampTH().replace(/^(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1') + ' โดย ' + username;
      await db.update('projects', { _row: 'eq.' + row },
        { [CONFIG.FORCE_FINISH_COL]: stamp, 'Updated At': nowISO() });
      ctx.audit(req.user, 'project_force_finish', stamp, { target: id });
      res.json({ ok: true, id, stamp });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });
  router.get('/api/can-finish', (req, res) => res.json({ ok: true, can: canForceFinish(userOf(req)) }));

  /* ═══ ⑿ รูป — uploadImageNow (Code.gs:1039) · resolveImageUrls (Code.gs:2212) ═══ */
  router.post('/api/upload', async (req, res) => {
    try {
      const p = req.body || {};
      /* 🔴 บอกเหตุผลตอนล้มเหลว ไม่ใช่แค่ "อัปโหลดรูปไม่สำเร็จ" ลอย ๆ */
      const r = await IMG.saveImageEx(p.dataUrl, clean(p.folderName) || 'Projects_Images',
        clean(p.baseName) || ('img.' + Date.now()));
      /* 🔴 ‼ ตัวตัดสินว่า "ล้มจริง" คือ onDrive ไม่ใช่ ok
       *   ความหมายใหม่ของ ok คือ "ขึ้น Drive + แชร์ผ่าน + จดดัชนีติด" ครบสามขั้น
       *   (core/drive-write.js:495 uploadEx) ⇒ ถ้าใช้ ok เป็นเกณฑ์
       *   "แชร์ไม่ผ่าน" จะกลายเป็น 400 ทั้งที่ไฟล์อยู่บน Drive แล้วและ path ใช้ได้จริง
       *   ⇒ ผู้ใช้เสียรูปที่อัปสำเร็จไปฟรี ๆ แล้วอัปใหม่ทิ้งไฟล์ซ้ำไว้บน Drive
       * ‼ 400 = ไฟล์ไม่ได้ขึ้น Drive จริง ๆ เท่านั้น
       *   200 + warn = ขึ้นแล้วแต่ยังไม่เรียบร้อย (แชร์ไม่ผ่าน / จดดัชนีไม่ติด)
       *   ทั้งสองทางบอกเหตุผลเสมอ ไม่มีทางไหนเงียบ */
      if (!r.onDrive || !r.path)
        return res.status(400).json({ ok: false, error: 'อัปโหลดรูปไม่สำเร็จ — ' + (r.why || 'ไม่ทราบสาเหตุ') });
      res.json({ ok: true, path: r.path, warn: r.why || '' });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  router.post('/api/img-urls', async (req, res) => {
    try { res.json({ ok: true, map: await IMG.urlMap((req.body && req.body.list) || []) }); }
    catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  /* ═══ ⒀ ผู้ใช้ · รูปพนักงาน · ประวัติการเข้าใช้ ═══ */
  /* getMe (Code.gs:763) */
  router.get('/api/me', async (req, res) => {
    const u = userOf(req);
    if (!u) return res.json({ ok: true, me: null });
    const d = (await userDirectory_())[u];
    if (!d) return res.json({ ok: true, me: { username: u, nickname: u, name: '', permission: '', photo: '' } });
    res.json({ ok: true, me: {
      username: d.username, nickname: d.nickname || d.username, name: d.name,
      permission: d.permission,
      photo: d.impage ? '/img/avatar/' + encodeURIComponent(d.impage) : '',
      /* ‼ พี่เอสั่ง 8 ก.ย. 69: "ให้ขึ้น version ที่ app project management นะ
       *   ไม่ใช่คีย์ยอดขาย เริ่มนับเวอร์ชันใหม่เลย"
       *   ⇒ เวอร์ชันของ "แอปนี้" (modules/projects/version.js) ไม่ใช่ของทั้งระบบ
       *     อ่านจากเซิร์ฟเวอร์ที่รันอยู่จริง ใช้ดูได้ว่าดีพลอยขึ้นแล้วหรือยัง
       *   hub = เวอร์ชันของทั้งระบบ ติดมาด้วยไว้ไล่ปัญหา (ไม่ได้โชว์บนหัวแอป) */
      version: require('./version').VERSION,
      hub: require('../../package.json').version,
    } });
  });

  /* getUserPhotos (Code.gs:659) · getGraphicPhotos (Code.gs:675) */
  router.get('/api/photos', async (req, res) => {
    try { res.json({ ok: true, map: await IMG.userPhotos(false) }); }
    catch { res.json({ ok: true, map: {} }); }
  });
  router.get('/api/graphic-photos', async (req, res) => {
    try { res.json({ ok: true, map: await IMG.userPhotos(true) }); }
    catch { res.json({ ok: true, map: {} }); }
  });

  /* logAccess (Code.gs:773) — ของเดิมเขียนแท็บ AccessLog ในไฟล์ Login CRM
   * ระบบใหม่มีตาราง auth_audit อยู่แล้ว จึงลงที่นั่น พร้อมติดป้ายแอปเหมือนเดิม */
  router.post('/api/log', (req, res) => {
    const b = req.body || {};
    ctx.audit(req.user, 'open_app', [clean(b.device), clean(b.os), clean(b.browser), clean(b.city)]
      .filter(Boolean).join(' · '), { target: CONFIG.APP_TAG });
    res.json({ ok: true });
  });

  /* getAccessLogs (Code.gs:798) — log + ผู้ใช้ออนไลน์ (active ใน 15 นาที) */
  router.get('/api/logs', async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 1), 1000);
      const params = { select: '*', order: 'at.desc', limit, module: 'eq.projects' };
      if (clean(req.query.dateFrom)) params.at = 'gte.' + clean(req.query.dateFrom) + 'T00:00:00+07:00';
      let rows = await db.select('auth_audit', params) || [];
      if (clean(req.query.dateTo)) {
        const end = Date.parse(clean(req.query.dateTo) + 'T23:59:59+07:00');
        rows = rows.filter(r => Date.parse(r.at) <= end);
      }
      const dir = await userDirectory_();
      const photo = un => {
        const d = dir[clean(un).toLowerCase()];
        return d && d.impage ? '/img/avatar/' + encodeURIComponent(d.impage) : '';
      };
      const onlineCut = Date.now() - 15 * 60 * 1000;
      const onlineMap = {};
      const logs = rows.map(r => {
        const ms = Date.parse(r.at) || 0;
        const un = clean(r.username);
        const d = dir[un.toLowerCase()] || {};
        const rec = {
          time: ms ? stampTH(new Date(ms)) : '', ms,
          username: un, nickname: d.nickname || un, permission: clean(r.role) || clean(d.permission),
          device: '', os: '', browser: '', city: clean(r.detail), photo: photo(un),
        };
        if (ms >= onlineCut && !onlineMap[un.toLowerCase()]) onlineMap[un.toLowerCase()] = rec;
        return rec;
      });
      res.json({ ok: true, logs, online: Object.values(onlineMap) });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  /* ═══ ⒁ AI อ่านโน้ตงาน — noteToProject (Code.gs:88) · classifyImages (Code.gs:152) ═══ */
  const ai = require('./ai');
  router.post('/api/note', async (req, res) => {
    res.json(await ai.noteToProject((req.body || {}).dataUrl));
  });
  router.post('/api/classify', async (req, res) => {
    res.json(await ai.classifyImages((req.body || {}).list));
  });

  /* ═══ ⒂ เครื่องมือดูแลระบบ (ของเดิมรันจาก Apps Script editor) ═══ */
  MAINT.mount(router, ctx, { userOf, ADMIN_USERS, userDirectory_, canDeleteProject_ });
  /* 📅 รอบ 178 — คิวติดตั้งที่จองไว้แล้ว บนการ์ด Project (อ่านจากแอปจองคิว · อ่านอย่างเดียว) */
  require('./installq').mount(router, ctx);
  /* 📎 รอบ 179 — กราฟิกอัปไฟล์พิมพ์/ไฟล์ตัด ที่การ์ด Project → ส่งเข้า Job Card สั่งผลิตอัตโนมัติ */
  require('./prodfiles').mount(router, ctx);
  /* 📐 v1.2.0 — "ข้อมูลออกแบบ" จากห้องบรีฟภายในของ Ant-Connect (ข้อสรุปกระดุมเม็ดแรกที่ล็อกแล้ว · อ่านอย่างเดียว) */
  require('./designinfo').mount(router, ctx);
  /* 🏭 v1.3.0 — ผลิตที่ไหน: ช่อง "ผู้ผลิต" + การ์ด Outsource/PO จากแอปคีย์ยอดขาย (อ่านอย่างเดียว · ไม่มียอดเงิน) */
  require('./producer').mount(router, ctx);

  ctx.log('พร้อมใช้งาน — ยกจาก Code.gs 2,772 บรรทัด + Index.html 2,205 บรรทัด');
}

module.exports = { mount };
