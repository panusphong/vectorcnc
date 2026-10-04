'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  โมดูล "จัดการผู้ใช้"
 *
 *  แทนที่แอป User Manager เดิม — สิ่งที่แก้จากของเดิม:
 *    เดิม  · รหัสผ่านเก็บเป็นข้อความล้วนในชีต ใครเปิดชีตได้ก็เห็นหมด
 *    ใหม่  · bcrypt เท่านั้น ไม่มี endpoint ไหนคืนรหัสหรือ hash ออกไป
 *
 *    เดิม  · ใครยิง URL ถูกก็แก้ผู้ใช้ได้ (ไม่มีตรวจสิทธิ์ฝั่งเซิร์ฟเวอร์)
 *    ใหม่  · module.json บังคับ ADMIN + ตรวจซ้ำทุก endpoint
 *
 *    เดิม  · ปิดบัญชีตัวเอง / ลดสิทธิ์แอดมินคนสุดท้ายได้ → ล็อกตัวเองออก
 *    ใหม่  · กันไว้ทั้งสองกรณี
 *
 *    เดิม  · ไม่รู้ว่าใครแก้อะไรเมื่อไร
 *    ใหม่  · ทุกการเปลี่ยนแปลงลง auth_audit
 * ═══════════════════════════════════════════════════════════════════ */
const bcrypt = require('bcryptjs');
const { CFG } = require('../../core/config');

const T = 'app_users';
const MIN_PASSWORD = CFG.MIN_PASSWORD;   // ตั้งค่าที่ core/config.js (ตัวแปร MIN_PASSWORD)

/* ═══════════════════════════════════════════════════════════════════
 *  🔴 APP_ROW_BASE — เลขแถวของ "ของที่เกิดในระบบใหม่" (ของกลางของโปรเจกต์)
 *
 *  ชีตใช้ _row 1..N · ระบบใหม่เริ่มที่ 900,000,000 ⇒ ไม่มีวันชนกัน
 *  และงานซิงก์จากชีต "มองไม่เห็น" แถวช่วงนี้เลย
 *  ‼ ค่าเดียวกับ core/sync-jobs-purchase.js · core/sync-jobs-aftersale.js
 *    · modules/projects/images.js · sql/81-channels-add.sql
 *  ‼ ตั้งใจ "ไม่ require" ไฟล์ซิงก์มาเอาค่า เพราะโมดูลนี้อยู่บนเส้นทางจัดการ
 *    บัญชีผู้ใช้ ซึ่งต้องไม่ลากชุดโค้ดซิงก์ (ชีต · PEAK · ตัวตั้งเวลา) เข้ามาด้วย
 *    ⇒ ยาม tools/test-users-manage.js เทียบเลขนี้กับของกลางให้ทุกครั้งที่รัน
 *      ถ้าวันหนึ่งมีใครย้ายฐาน เลขไม่ตรงกัน = ยามแดงทันที ไม่หลุดเงียบ
 * ═══════════════════════════════════════════════════════════════════ */
const APP_ROW_BASE = 900000000;

/** ฟิลด์ที่ส่งออกฝั่งเบราว์เซอร์ได้ — ไม่มีรหัสผ่านเด็ดขาด */
const SAFE = '_id,Name,Nickname,Impage,Username,Status,Permission,created_at,updated_at';

/* ═══════════════════════════════════════════════════════════════════
 *  คอลัมน์ชุดที่ sql/82-app-users-manage.sql เพิ่มให้ + ของที่ sql/06 · 54 มี
 *
 *  🔴 ทำไมต้องแยกออกมา ไม่ยัดรวมใน SAFE:
 *    ถ้ายัดรวมแล้วเซิร์ฟเวอร์ถูกดีพลอย "ก่อน" รัน SQL (ซึ่งเกิดขึ้นแน่ ๆ
 *    เพราะคนละขั้นตอนกัน) PostgREST จะตอบ 400 PGRST100 ทุกคำขอ
 *    ⇒ หน้าจัดการผู้ใช้ตายทั้งหน้า ทั้งที่แค่ยังไม่ได้รัน SQL
 *    ⇒ ที่นี่จึง "ถามฐานก่อนหนึ่งครั้ง" ว่ามีคอลัมน์ชุดนี้ไหม แล้วจำคำตอบไว้
 *      ไม่มี = ทำงานเหมือนเวอร์ชันเดิมเป๊ะ + ตะโกนบอกบนหน้าจอว่าให้ไปรัน SQL
 *  ‼ ห้ามเงียบ — คำตอบส่งขึ้นหน้าจอเป็น sqlReady/sqlFile เสมอ
 * ═══════════════════════════════════════════════════════════════════ */
const MANAGE = '_row,Branch,Position,Mobile,email,AppAccess,CreatedBy,UpdatedBy,DisabledAt,DisabledBy';
const SQL_FILE = 'sql/82-app-users-manage.sql';

const clean = s => String(s == null ? '' : s).trim();

/** ผู้ใช้ 1 คนในรูปแบบที่ส่งออกได้ */
function shape(row, roleOf) {
  return {
    id:         row._id,
    name:       clean(row.Name),
    nickname:   clean(row.Nickname),
    image:      clean(row.Impage),
    username:   clean(row.Username),
    status:     clean(row.Status) || 'Login',
    permission: clean(row.Permission),
    role:       roleOf(row.Permission),
    active:     clean(row.Status).toLowerCase() !== 'logout',
    // hasPassword ใช้บอกว่าคนนี้ล็อกอินได้หรือยัง — ไม่ได้ส่งตัวรหัสออกไป
    hasPassword: !!(clean(row.PasswordHash) || clean(row.Password)),
    plainLeft:   !!clean(row.Password),   // ยังมีรหัสข้อความล้วนค้างอยู่ไหม

    /* ── ช่องที่มาจาก sql/82 (และ sql/06 · 54) ────────────────────
     *  ‼ ยังไม่ได้รัน SQL = ได้ undefined แล้วกลายเป็นค่าว่าง
     *    หน้าจอจึงขึ้นเป็นช่องว่าง ไม่ใช่พัง                            */
    branch:     clean(row.Branch),
    position:   clean(row.Position),
    mobile:     clean(row.Mobile),
    email:      clean(row.email),
    appAccess:  clean(row.AppAccess),
    /* 🔴 เกิดในแอป (ไม่ใช่ไหลมาจากชีต) — ดูจากช่วงเลขแถวของกลาง */
    row:        row._row == null ? null : Number(row._row),
    fromApp:    Number(row._row) >= APP_ROW_BASE,
    createdBy:  clean(row.CreatedBy),
    updatedBy:  clean(row.UpdatedBy),
    createdAt:  clean(row.created_at),
    updatedAt:  clean(row.updated_at),
    disabledAt: clean(row.DisabledAt),
    disabledBy: clean(row.DisabledBy),
  };
}

async function mount(router, ctx) {
  const { db, auth } = ctx;
  const express = require('express');
  /* ‼ 8mb เพราะรูปพนักงานส่งมาเป็น data URL
   *   รูป 5MB เข้ารหัส base64 แล้วโตขึ้นราว 1.37 เท่า = ~6.8MB
   *   ถ้าตั้ง 1mb ไว้ อัปรูปปกติก็โดนปฏิเสธตั้งแต่ยังไม่ถึงโค้ดเรา */
  router.use(express.json({ limit: '8mb' }));

  /* ═══════════════════════════════════════════════════════════════
   *  คอลัมน์ชุดจัดการพนักงานมีในฐานหรือยัง — ถามครั้งเดียวแล้วจำไว้
   *
   *  ‼ ถามด้วย "อ่านจริง 1 แถว" ไม่ใช่ถาม information_schema
   *    เพราะสิ่งที่ต้องรู้คือ "PostgREST มองเห็นคอลัมน์ชุดนี้ไหม"
   *    (คอลัมน์มีในฐานแต่ยังไม่ reload schema = PostgREST ยังไม่เห็น)
   *  ‼ ตารางว่างก็ตอบได้ — PostgREST ตรวจชื่อคอลัมน์ก่อนเสมอ ไม่เกี่ยวกับจำนวนแถว
   * ═══════════════════════════════════════════════════════════════ */
  let _manageOK = null;          /* null = ยังไม่เคยถาม · true/false = รู้แล้ว */
  async function manageReady() {
    if (_manageOK !== null) return _manageOK;
    try {
      await db.one(T, { select: MANAGE });
      _manageOK = true;
    } catch (e) {
      _manageOK = false;
      ctx.warn('ยังไม่ได้รัน ' + SQL_FILE + ' — หน้าจัดการพนักงานจะทำงานแบบจำกัด: ' + e.message);
    }
    return _manageOK;
  }

  /** ชุดคอลัมน์ที่ขอจากฐาน — ตัดชุดใหม่ออกให้เองถ้ายังไม่ได้รัน SQL */
  const selectOf = ready => SAFE + ',PasswordHash,Password' + (ready ? ',' + MANAGE : '');

  /* ═══════════════════════════════════════════════════════════════
   *  🔴 อ่านผู้ใช้ตาม username — ต้อง "ตรงตัว" เท่านั้น
   *
   *  ‼ ของเดิมเขียนว่า  db.one(T, { Username: 'ilike.' + username })
   *    แล้วรับแถวแรกที่ได้เลย — เป็นช่องโหว่ตัวเดียวกับที่เจอในเส้นทาง
   *    ล็อกอินเมื่อ 13 ก.ย. 69 (core/auth.js:120-129 จดไว้ทั้งเรื่อง)
   *      · ilike ของ PostgREST ถือว่า * และ % = "อะไรก็ได้" · _ = อักขระใดก็ได้ 1 ตัว
   *      · 'pu_s' จึงไปตรงกับแถวของ 'pu.s' = จับผิดคน
   *      · 🔴 ที่แย่กว่านั้น: endpoint แก้ไข/ตั้งรหัส/ปิดบัญชี ใช้ตัวกรอง
   *        ชุดเดียวกันนี้ไปสั่ง db.update ⇒ ยิงชื่อผู้ใช้ว่า "ดอกจัน"
   *        เข้า endpoint ตั้งรหัสผ่านครั้งเดียว = ตั้งรหัสใหม่ทับ
   *        "ทุกคนทั้งบริษัท" ในคำสั่งเดียว โดยไม่มี error ให้ใครเห็น
   *  ✅ วิธีแก้ใช้ท่าเดียวกับ core/auth.js findUser() เป๊ะ:
   *      ยังถามด้วย ilike (เพื่อให้ไม่สนตัวพิมพ์เหมือนเดิมทุกประการ)
   *      แต่ "ไม่เชื่อผลดิบ" — คัดให้เหลือแถวที่ชื่อตรงตัวก่อนเสมอ
   *  ✅ และทุกคำสั่งเขียนหลังจากนี้ต้องล็อกด้วย _id ของแถวที่คัดได้เท่านั้น
   *    (ดู byId ข้างล่าง) — ไม่ส่งชื่อที่ผู้ใช้พิมพ์ลงไปเป็นตัวกรองอีกแล้ว
   * ═══════════════════════════════════════════════════════════════ */
  async function rawOf(username) {
    const u = clean(username);
    if (!u) return null;
    const ready = await manageReady();
    /* limit 50 พอสำหรับกรณี _ ไปตรงหลายแถว · กรณี * ก็ได้แค่ 50 แถวแล้วตกทั้งหมด */
    const rows = await db.select(T, { Username: 'ilike.' + u, select: selectOf(ready), limit: 50 });
    const want = u.toLowerCase();
    return (Array.isArray(rows) ? rows : [])
      .find(r => clean(r && r.Username).toLowerCase() === want) || null;
  }

  /** ตัวกรอง "แถวนี้แถวเดียว" — ใช้ _id ซึ่งเป็น primary key ปลอมไม่ได้
   *  ‼ ห้ามกลับไปใช้ { Username: 'ilike.' + ชื่อที่ผู้ใช้พิมพ์ } อีกเด็ดขาด */
  const byId = row => ({ _id: 'eq.' + row._id });

  /* ═══════════════════════════════════════════════════════════════
   *  นับจำนวนแอดมินที่ยังเปิดใช้งานอยู่ — กันไม่ให้เหลือศูนย์
   *
   *  🔴 เปลี่ยนจาก db.select(limit: 1000) เป็น db.selectAll
   *    พี่เอสั่งไว้ว่า "ต้องไม่มีเพดานสิ ขายของเพิ่มขึ้นทุกวัน"
   *    ‼ ถ้าพนักงานเกิน 1,000 คนเมื่อไหร่ ของเดิมจะนับแอดมินได้ไม่ครบ
   *      แล้ว "กันแอดมินคนสุดท้าย" จะเริ่มปฏิเสธคนผิด — เงียบสนิท
   *    (Supabase ตัดที่ 1,000 แถวโดยไม่บอก — ดู core/db.js selectAll)
   * ═══════════════════════════════════════════════════════════════ */
  async function activeAdminCount() {
    const rows = await db.selectAll(T, {
      select: 'Username,Status,Permission', order: 'Username.asc',
    });
    return (rows || []).filter(r =>
      auth.roleOf(r.Permission) === 'ADMIN' &&
      clean(r.Status).toLowerCase() !== 'logout'
    ).length;
  }

  /* ═══════════════════════════════════════════════════════════════
   *  🔴 เลขแถวของพนักงานที่ "เพิ่มในแอป" — ต้อง ≥ APP_ROW_BASE เสมอ
   *    ท่าเดียวกับ modules/purchase/db.js:251 และ modules/aftersale/db.js:64
   *    ‼ มองเฉพาะช่วงของระบบใหม่ (gte.APP_ROW_BASE) ไม่ไปแตะเลขของชีต
   * ═══════════════════════════════════════════════════════════════ */
  async function nextAppRow() {
    const top = await db.select(T, {
      select: '_row', _row: 'gte.' + APP_ROW_BASE, order: '_row.desc', limit: 1,
    });
    const last = (Array.isArray(top) && top[0]) ? Number(top[0]._row) : 0;
    return Math.max(APP_ROW_BASE, (Number.isFinite(last) ? last : 0) + 1);
  }

  const isSelf = (req, username) =>
    clean(req.user.username).toLowerCase() === clean(username).toLowerCase();

  const fail = (res, code, error) => res.status(code).json({ ok: false, error });

  /* ─── รายชื่อผู้ใช้ ───────────────────────────────────────────── */
  router.get('/api/list', async (req, res) => {
    try {
      const ready = await manageReady();
      /* ═══════════════════════════════════════════════════════════
       *  🔴 selectAll ไม่ใช่ select — พี่เอสั่ง "ต้องไม่มีเพดานสิ"
       *    ของเดิมตั้ง limit: 1000 ไว้ ซึ่งเท่ากับเพดานของ Supabase พอดี
       *    ⇒ พนักงานคนที่ 1,001 เป็นต้นไป "หายจากหน้าจอเงียบ ๆ"
       *      ไม่มี error ไม่มีคำเตือน และคนที่หายคือคนที่ชื่อเรียงท้ายสุด
       *    ‼ selectAll บังคับให้ระบุ order เสมอ (ไม่งั้นหน้า 2 ซ้ำ/ข้ามแถว)
       * ═══════════════════════════════════════════════════════════ */
      const rows = await db.selectAll(T, {
        select: selectOf(ready),
        order: 'Username.asc',
      });
      const all = (rows || []).map(r => shape(r, auth.roleOf));
      let list = all;

      const q = clean(req.query.q).toLowerCase();
      if (q) list = list.filter(u =>
        [u.username, u.name, u.nickname, u.permission,
         u.branch, u.position, u.mobile, u.email].join(' ').toLowerCase().includes(q));

      const st = clean(req.query.status).toLowerCase();
      if (st === 'active')   list = list.filter(u => u.active);
      if (st === 'inactive') list = list.filter(u => !u.active);

      /* ═══════════════════════════════════════════════════════════
       *  กรองตาม "สิทธิ์" และ "สาขา/กิจการ"
       *  🔴 เทียบแบบ "ตรงเป๊ะทั้งสตริง ไม่สนตัวพิมพ์" เท่านั้น
       *    ห้าม includes/startsWith — บทเรียนช่องโหว่ 13 ก.ย. 69
       *    (เลือก "Sale" แล้วติด "Sale support" มาด้วย = คนละกลุ่มกัน)
       * ═══════════════════════════════════════════════════════════ */
      const fp = clean(req.query.permission).toLowerCase();
      if (fp) list = list.filter(u => u.permission.toLowerCase() === fp);

      const fb = clean(req.query.branch).toLowerCase();
      if (fb) list = list.filter(u => u.branch.toLowerCase() === fb);

      /* ═══════════════════════════════════════════════════════════
       *  ‼ เรียงตามสิทธิ์ ไม่ใช่ตามชื่อ — พี่เอสั่ง 6 ก.ย. 69:
       *    "ให้เรียงจาก permission นะ อย่าเรียงตามชื่อ ดูไม่รู้เรื่อง
       *     เอา admin ขึ้นก่อน"
       *
       *  เรียงตามอำนาจมากไปน้อย: ADMIN → ACCOUNTING → OFFICER → TECH → VIEWER
       *  ‼ ใช้ลำดับเดียวกับที่ระบบใช้ตรวจสิทธิ์จริง (auth.ROLE_RANK)
       *    ถ้าตั้งลำดับใหม่ตรงนี้เอง วันหนึ่งจะเพี้ยนจากของจริงโดยไม่มีใครรู้
       *
       *  ในกลุ่มเดียวกันเรียงตามชื่อสิทธิ์ก่อน แล้วค่อยชื่อคน
       *  จะได้เห็นเป็นกลุ่ม ๆ (Planning อยู่ด้วยกัน · Graphic อยู่ด้วยกัน)
       * ═══════════════════════════════════════════════════════════ */
      const RANK = auth.ROLE_RANK || {};
      list.sort((a, b) =>
        (RANK[b.role] || 0) - (RANK[a.role] || 0) ||
        String(a.permission || '').localeCompare(String(b.permission || ''), 'th') ||
        String(a.nickname || a.name || a.username || '')
          .localeCompare(String(b.nickname || b.name || b.username || ''), 'th'));

      /* ‼ ตัวเลือกของตัวกรองมาจาก "ค่าที่มีอยู่จริงในฐาน" ไม่ใช่รายชื่อที่ฝังในโค้ด
       *   ⇒ เพิ่มสาขาใหม่ในแอปแล้วตัวกรองรู้จักทันที ไม่ต้องดีพลอย
       *   ‼ คิดจาก all (ก่อนกรอง) ไม่ใช่ list — ไม่งั้นพอกรองแล้วตัวเลือกอื่นหายหมด */
      const uniqSorted = pick => [...new Set(all.map(pick).filter(Boolean))]
        .sort((a, b) => String(a).localeCompare(String(b), 'th'));

      res.json({
        ok: true,
        users: list,
        summary: {
          total:    list.length,
          active:   list.filter(u => u.active).length,
          inactive: list.filter(u => !u.active).length,
          noPassword: list.filter(u => !u.hasPassword).length,
          plainLeft:  list.filter(u => u.plainLeft).length,
          /* 🔴 จำนวนทั้งตาราง (ไม่ผ่านตัวกรอง) — ไว้เทียบว่าตัวกรองตัดไปกี่คน
           *   และเป็นตัวเลขที่พิสูจน์ว่า "อ่านครบ ไม่โดนเพดาน 1,000" */
          allTotal: all.length,
          fromApp:  all.filter(u => u.fromApp).length,
        },
        // ส่งไปให้หน้าเว็บทำ dropdown สิทธิ์ — มาจากที่เดียวกับที่ระบบใช้จริง
        permissions: Object.keys(auth.PERMISSION_ROLE),
        /* ตัวเลือกของตัวกรอง — ค่าจริงที่มีในฐานตอนนี้ */
        permissionsInUse: uniqSorted(u => u.permission),
        branches:         uniqSorted(u => u.branch),
        me: req.user.username,
        minPassword: MIN_PASSWORD,
        /* 🔴 ยังไม่ได้รัน SQL ต้องตะโกน ไม่ใช่เงียบแล้วให้ช่องหายไปเฉย ๆ */
        sqlReady: ready,
        sqlFile:  SQL_FILE,
        appRowBase: APP_ROW_BASE,
      });
    } catch (e) {
      ctx.warn('list ล้มเหลว:', e.message);
      fail(res, 500, 'อ่านรายชื่อผู้ใช้ไม่สำเร็จ: ' + e.message);
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🔐 ตารางตรวจสิทธิ์ — "permission ไหน เห็นแอปอะไรบ้าง"
   *
   *  ‼ พี่เอสั่ง 17 ก.ย. 69 (งานกำหนดสิทธิ์การเข้าแอปทั้งหมดใหม่):
   *    ต้องเปิดดูได้ว่า "permission ไหน เห็นแอปอะไรบ้าง" และ
   *    "ตอนนี้มี permission อะไรในระบบบ้างที่ยังไม่มีในตาราง"
   *
   *  🔴 ห้ามคำนวณสิทธิ์ซ้ำที่นี่เด็ดขาด — ถามตัวตัดสินตัวจริง
   *    (core/app-access.js canOpen) ทีละช่อง ⇒ ตารางที่เห็นบนจอ
   *    คือคำตอบเดียวกับที่ด่านจริงใช้เสมอ ไม่มีทางเพี้ยนจากกัน
   *
   *  ‼ อยู่ในแอป "จัดการผู้ใช้" ซึ่งเปิดได้เฉพาะ admin · namna อยู่แล้ว
   *    (core/app-access.js TOOL_APPS) ⇒ ไม่ต้องมีด่านเพิ่มที่นี่
   *  ‼ อ่านฐานแค่ 2 คอลัมน์และมีเพดานเสมอ (ห้ามอ่านทั้งตาราง)
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/perm-matrix', async (_req, res) => {
    try {
      const registry  = require('../../core/registry');
      const appAccess = require('../../core/app-access');
      const P = appAccess.perms;

      /* ① ทะเบียนแอปจริง = โฟลเดอร์ใน modules/ + แอปที่ไม่ใช่โมดูล */
      const mods = registry.loadAll();
      const byKey = new Map(mods.map(m => [m.key, m]));
      const apps = P.KNOWN_APPS.map(key => {
        const m = byKey.get(key);
        return {
          key,
          title:     m ? m.title : (P.EXTRA_APP_TITLES[key] || key),
          status:    m ? m.status : 'ready',
          disabled:  m ? !!m.disabled : false,
          hideInHub: m ? !!m.hideInHub : false,
          isModule:  !!m,
          /* ‼ 17 ก.ย. 69 — ใช้ ADMIN_ONLY_APPS (= TOOL_APPS + registry) ไม่ใช่ TOOL_APPS เปล่า
           *   ไม่งั้นตารางสิทธิ์จะไม่ติดธง 🔑 ให้ "ทะเบียนกลาง" ทั้งที่กันด้วยชื่อผู้ใช้เหมือนกัน */
          isTool:    (appAccess.ADMIN_ONLY_APPS || appAccess.TOOL_APPS).indexOf(key) >= 0,
        };
      });

      /* 🔴 โมดูลที่มีอยู่จริงแต่ยังไม่มีในตาราง = ต้องรู้ทันที ไม่ใช่รู้ทีหลัง */
      const appsMissing = mods.map(m => m.key).filter(k => P.KNOWN_APPS.indexOf(k) < 0);

      /* ② แถวของตาราง = สิทธิ์ที่พี่เอสั่ง + สิทธิ์ที่ยังไม่ได้สั่ง
       *   ‼ ถามผ่าน canOpen() ด้วยผู้ใช้จำลองที่ "ไม่ใช่ admin/namna"
       *     (ชื่อว่าง ⇒ isToolAdmin = false) เพื่อให้ได้คำตอบของ "สิทธิ์" ล้วน ๆ */
      const rowFor = (perm, kind) => {
        const u = { username: '', permission: perm, appAccess: [] };
        return {
          permission: perm,
          kind,                                   /* 'ruled' | 'pending' */
          state: P.permState(perm),
          all: P.appsFor(perm) === P.ALL_APPS,
          apps: apps.filter(a => appAccess.canOpen(u, a.key)).map(a => a.key),
        };
      };
      const rows = Object.keys(P.ROLE_APPS).map(p => rowFor(p, 'ruled'))
        .concat(P.PENDING_PERMISSIONS.map(p => rowFor(p, 'pending')));

      /* ③ ค่า Permission จริงที่มีอยู่ในฐาน — ตัวไหนยังไม่มีในตาราง
       *  🔴 17 ก.ย. 69 — เดิมตั้ง limit: 2000 ไว้ ซึ่งยัง "มีเพดาน" อยู่ดี
       *    และเพดานจริงของ Supabase คือ 1,000 ⇒ ขอ 2,000 ก็ได้แค่ 1,000
       *    ⇒ ค่า Permission ของคนที่ 1,001 เป็นต้นไปจะไม่เคยถูกรายงานเลย
       *      ซึ่งตรงข้ามกับหน้าที่ของหน้านี้ ("มีสิทธิ์อะไรที่ยังไม่มีในตาราง")
       *    ‼ ยังอ่านแค่ 2 คอลัมน์เหมือนเดิม ไม่ได้ดึงทั้งแถว */
      const raw = await db.selectAll(T, { select: 'Permission,Status', order: 'Username.asc' });
      const seen = new Map();
      for (const r of (raw || [])) {
        const v = clean(r && r.Permission);
        const k = P.normPerm(v);
        const hit = seen.get(k) || { value: v, count: 0, active: 0, state: P.permState(v) };
        hit.count++;
        if (clean(r && r.Status).toLowerCase() !== 'logout') hit.active++;
        seen.set(k, hit);
      }
      const dbPerms = [...seen.values()].sort((a, b) => b.count - a.count);

      res.json({
        ok: true,
        apps, rows,
        appsMissingFromTable: appsMissing,
        dbPermissions: dbPerms,
        /* ค่าที่ระบบ "ไม่รู้จักเลย/ว่าง" = ปฏิเสธทุกแอป ⇒ ต้องตะโกนให้เห็น */
        unknownInDb: dbPerms.filter(x => x.state === 'unknown' || x.state === 'empty'),
        pendingInDb: dbPerms.filter(x => x.state === 'pending'),
        toolApps: appAccess.ADMIN_ONLY_APPS || appAccess.TOOL_APPS,
        toolAdminUsers: appAccess.TOOL_ADMIN_USERS,
        unassignedApps: P.UNASSIGNED_APPS,
        jobcardPanels: P.JOBCARD_PANELS,
      });
    } catch (e) {
      ctx.warn('perm-matrix ล้มเหลว:', e.message);
      fail(res, 500, 'อ่านตารางสิทธิ์ไม่สำเร็จ: ' + e.message);
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🕘 ประวัติของพนักงานคนหนึ่ง — "ใครทำอะไรกับบัญชีนี้ เมื่อไหร่"
   *
   *  🔴 ใช้ตาราง audit ของเดิม (app.auth_audit · sql/01-core.sql)
   *    ‼ ไม่สร้างตารางใหม่ ไม่สร้างกติกาใหม่ — ทุก endpoint ในไฟล์นี้
   *      เขียนลง auth_audit ผ่าน ctx.audit อยู่แล้วตั้งแต่ต้น
   *      (user_create · user_update · user_disable · user_enable ·
   *       user_set_password · user_set_photo · user_del_photo)
   *    ⇒ ที่ขาดคือ "ทางเปิดดู" เท่านั้น อันนี้คือทางเปิดดูนั้น
   *
   *  ‼ อ่านสองทาง เพราะคนหนึ่งคนโผล่ใน 2 ช่อง:
   *      target   = ถูกคนอื่นกระทำ (ถูกแก้ · ถูกปิดบัญชี · ถูกตั้งรหัสใหม่)
   *      username = เป็นคนกระทำเอง (ล็อกอิน · ไปแก้คนอื่น)
   *  ‼ จำกัด 200 รายการล่าสุดต่อทาง และ "บอกบนจอว่าถูกจำกัด" (capped)
   *    ไม่ใช่ตัดเงียบ — นี่คือหน้าดูย้อนหลัง ไม่ใช่รายงานที่ต้องครบทุกแถว
   *    (อยากดูครบทั้งหมด มีแอป "บันทึกการใช้งาน" /m/audit อยู่แล้ว)
   * ═══════════════════════════════════════════════════════════════ */
  const AUDIT_LIMIT = 200;
  router.get('/api/:username/history', async (req, res) => {
    const username = clean(req.params.username);
    try {
      const cur = await rawOf(username);
      if (!cur) return fail(res, 404, 'ไม่พบผู้ใช้นี้');
      const who = clean(cur.Username);
      const wantLow = who.toLowerCase();

      const SEL = 'at,username,role,action,module,target,detail,ip';
      /* ‼ ถามด้วย ilike เพื่อไม่สนตัวพิมพ์ แล้วคัดให้เหลือ "ตรงตัว" เหมือนทุกที่ */
      const [asTarget, asActor] = await Promise.all([
        db.select(auth.T_AUDIT, { select: SEL, target: 'ilike.' + who,
                                  order: 'at.desc', limit: AUDIT_LIMIT }),
        db.select(auth.T_AUDIT, { select: SEL, username: 'ilike.' + who,
                                  order: 'at.desc', limit: AUDIT_LIMIT }),
      ]);

      const seen = new Set();
      const rows = [].concat(asTarget || [], asActor || [])
        .filter(r => clean(r.target).toLowerCase() === wantLow ||
                     clean(r.username).toLowerCase() === wantLow)
        .filter(r => {                        /* กันรายการเดียวกันโผล่สองรอบ */
          const k = [r.at, r.action, r.username, r.target].join('|');
          if (seen.has(k)) return false;
          seen.add(k); return true;
        })
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .map(r => ({
          at: clean(r.at), action: clean(r.action), module: clean(r.module),
          by: clean(r.username), role: clean(r.role),
          target: clean(r.target), detail: clean(r.detail),
          /* 🔴 ห้ามส่ง ua/ip เต็ม ๆ ออกไปเกินจำเป็น — ip พอให้ตรวจสอบได้ */
          ip: clean(r.ip),
          /* คนนี้เป็นคนทำ หรือเป็นคนถูกทำ */
          kind: clean(r.target).toLowerCase() === wantLow ? 'ถูกกระทำ' : 'กระทำเอง',
        }));

      res.json({
        ok: true, username: who, rows,
        limit: AUDIT_LIMIT,
        capped: (asTarget || []).length >= AUDIT_LIMIT || (asActor || []).length >= AUDIT_LIMIT,
      });
    } catch (e) {
      ctx.warn('history ล้มเหลว:', e.message);
      fail(res, 500, 'อ่านประวัติไม่สำเร็จ: ' + e.message);
    }
  });

  /* ─── เพิ่มผู้ใช้ใหม่ ─────────────────────────────────────────── */
  router.post('/api/create', async (req, res) => {
    const b = req.body || {};
    const username = clean(b.username);
    const password = String(b.password || '');

    if (!username)                    return fail(res, 400, 'ต้องใส่ชื่อผู้ใช้');
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(username))
      return fail(res, 400, 'ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - ยาว 3–40 ตัว');
    if (password.length < MIN_PASSWORD)
      return fail(res, 400, `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัวอักษร`);

    try {
      /* ‼ rawOf เทียบ "ตรงตัว ไม่สนตัวพิมพ์" ⇒ admin / Admin / ADMIN ถือว่าซ้ำกัน
       *   ตรงกับ unique index app_users_username_uk บน lower("Username") เป๊ะ */
      if (await rawOf(username)) return fail(res, 409, 'มีชื่อผู้ใช้นี้อยู่แล้ว');

      const ready = await manageReady();
      const rec = {
        Name:         clean(b.name),
        Nickname:     clean(b.nickname),
        Impage:       clean(b.image),
        Username:     username,
        PasswordHash: await bcrypt.hash(password, 10),
        Password:     null,
        Status:       'Login',
        Permission:   clean(b.permission),
      };

      /* ═══════════════════════════════════════════════════════════
       *  🔴 แถวที่แอปสร้างต้องอยู่ในช่วง APP_ROW_BASE
       *    งานซิงก์จากชีตจะได้มองไม่เห็น และดูออกจากตัวแถวเลยว่าเกิดที่ไหน
       *  ‼ ยังไม่ได้รัน sql/82 = ไม่มีคอลัมน์พวกนี้ ⇒ ข้ามไป
       *    คนใหม่ยังเพิ่มได้และล็อกอินได้เหมือนเดิม (แค่ไม่มีข้อมูลเสริม)
       * ═══════════════════════════════════════════════════════════ */
      if (ready) {
        rec._row      = await nextAppRow();
        rec.Branch    = clean(b.branch);
        rec.Position  = clean(b.position);
        rec.Mobile    = clean(b.mobile);
        rec.email     = clean(b.email);
        rec.AppAccess = clean(b.appAccess);
        rec.CreatedBy = clean(req.user.username);
        rec.UpdatedBy = clean(req.user.username);
      }

      await db.insert(T, rec);
      /* ‼ ล้างแคชผู้ใช้หลังเขียนเสร็จ — ถ้าเพิ่งมีคนยิงชื่อนี้มาก่อนหน้า
       *   แคช "ไม่พบผู้ใช้" จะค้างอยู่ 30 วิ แล้วคนใหม่ล็อกอินไม่ได้ทันที */
      auth.forgetUser(username);

      /* 🔴 ห้ามใส่รหัสผ่านลง audit เด็ดขาด — จดแค่ว่าใครเพิ่มใครเมื่อไหร่ */
      await ctx.audit(req.user, 'user_create',
        { target: username, permission: clean(b.permission),
          branch: clean(b.branch), position: clean(b.position),
          row: rec._row == null ? null : rec._row }, auth.metaOf(req));
      res.json({ ok: true, row: rec._row == null ? null : rec._row, sqlReady: ready });
    } catch (e) {
      ctx.warn('create ล้มเหลว:', e.message);
      /* ‼ ชนกับ unique index (23505) = มีชื่อนี้อยู่แล้ว — ตอบให้ตรงความจริง
       *   (เกิดได้ถ้ามีคนกดพร้อมกันสองเครื่องระหว่างที่เพิ่งเช็คว่าไม่ซ้ำ) */
      if (/23505|duplicate key/i.test(String(e.message)))
        return fail(res, 409, 'มีชื่อผู้ใช้นี้อยู่แล้ว');
      fail(res, 500, 'เพิ่มผู้ใช้ไม่สำเร็จ: ' + e.message);
    }
  });

  /* ─── แก้ข้อมูลผู้ใช้ (ไม่รวมรหัสผ่าน) ────────────────────────── */
  router.patch('/api/:username', async (req, res) => {
    const username = clean(req.params.username);
    const b = req.body || {};
    try {
      const cur = await rawOf(username);
      if (!cur) return fail(res, 404, 'ไม่พบผู้ใช้นี้');

      const ready = await manageReady();

      const patch = {};
      for (const [field, col] of [['name','Name'],['nickname','Nickname'],['image','Impage']]) {
        if (b[field] !== undefined) patch[col] = clean(b[field]);
      }
      /* ── ช่องที่มาจาก sql/82 · 06 · 54 — แก้ได้เมื่อมีคอลัมน์จริงเท่านั้น ──
       *  ‼ ยังไม่ได้รัน SQL แล้วส่งช่องพวกนี้มา = ข้ามไปเงียบไม่ได้
       *    ต้องบอกให้รู้ว่าทำไมไม่ถูกบันทึก (ดู skipped ในคำตอบ)          */
      const skipped = [];
      for (const [field, col] of [['branch','Branch'],['position','Position'],
                                  ['mobile','Mobile'],['email','email'],
                                  ['appAccess','AppAccess']]) {
        if (b[field] === undefined) continue;
        if (ready) patch[col] = clean(b[field]);
        else skipped.push(field);
      }

      // เปลี่ยนสิทธิ์: ห้ามลดสิทธิ์ตัวเอง และห้ามทำให้ไม่เหลือแอดมิน
      if (b.permission !== undefined) {
        const newPerm = clean(b.permission);
        const wasAdmin = auth.roleOf(cur.Permission) === 'ADMIN';
        const willAdmin = auth.roleOf(newPerm) === 'ADMIN';
        if (wasAdmin && !willAdmin) {
          if (isSelf(req, username))
            return fail(res, 400, 'ลดสิทธิ์ของตัวเองไม่ได้ — ให้แอดมินคนอื่นทำให้');
          if (await activeAdminCount() <= 1)
            return fail(res, 400, 'นี่คือผู้ดูแลระบบคนสุดท้าย ลดสิทธิ์ไม่ได้');
        }
        patch.Permission = newPerm;
      }

      if (!Object.keys(patch).length)
        return fail(res, 400, skipped.length
          ? 'ยังไม่ได้รัน ' + SQL_FILE + ' — ช่อง ' + skipped.join(' · ') + ' จึงยังบันทึกไม่ได้'
          : 'ไม่มีอะไรให้แก้');

      patch.updated_at = new Date().toISOString();
      if (ready) patch.UpdatedBy = clean(req.user.username);   /* ใครแก้ล่าสุด */

      /* 🔴 ล็อกด้วย _id ของแถวที่คัดมาแล้ว ไม่ใช่ชื่อที่ผู้ใช้พิมพ์
       *   (ilike + * = แก้ทุกแถวในคำสั่งเดียว — ดูหมายเหตุที่ rawOf) */
      await db.update(T, byId(cur), patch);
      /* ‼ ล้างแคชผู้ใช้ 'หลัง' เขียนเสร็จเท่านั้น
       *   ถ้าล้างก่อน คำขอที่เข้ามาระหว่างนั้นจะอ่านค่าเก่าแล้วแคชค่าเก่าซ้ำ
       *   กลายเป็นล้างแล้วเหมือนไม่ได้ล้าง (เจอจริงตอนเขียนเทสต์) */
      auth.forgetUser(clean(cur.Username));

      await ctx.audit(req.user, 'user_update',
        { target: clean(cur.Username), fields: Object.keys(patch) }, auth.metaOf(req));
      res.json({ ok: true, skipped, sqlReady: ready });
    } catch (e) {
      ctx.warn('update ล้มเหลว:', e.message);
      fail(res, 500, 'แก้ข้อมูลไม่สำเร็จ: ' + e.message);
    }
  });

  /* ─── เปิด / ปิดบัญชี ─────────────────────────────────────────
   *  ปิดแล้วเด้งออกทุกโมดูลทันที เพราะ attachUser ตรวจ Status ทุก request */
  router.post('/api/:username/status', async (req, res) => {
    const username = clean(req.params.username);
    const want = clean((req.body || {}).status).toLowerCase() === 'logout' ? 'Logout' : 'Login';
    try {
      const cur = await rawOf(username);
      if (!cur) return fail(res, 404, 'ไม่พบผู้ใช้นี้');

      if (want === 'Logout') {
        if (isSelf(req, username))
          return fail(res, 400, 'ปิดบัญชีตัวเองไม่ได้ — จะเข้าระบบไม่ได้อีก');
        if (auth.roleOf(cur.Permission) === 'ADMIN' && await activeAdminCount() <= 1)
          return fail(res, 400, 'นี่คือผู้ดูแลระบบคนสุดท้าย ปิดบัญชีไม่ได้');
      }

      /* ═══════════════════════════════════════════════════════════
       *  🔴 "ปิดการใช้งาน" ไม่ใช่ "ลบทิ้ง" — พี่เอสั่งไว้ตรง ๆ
       *    พนักงานลาออก = Status Logout เท่านั้น แถวยังอยู่ครบทุกช่อง
       *    ⇒ ประวัติงานเก่าที่อ้างชื่อผู้ใช้คนนี้ไม่มีทางกลายเป็นชื่อลอย
       *  ‼ โมดูลนี้ "ไม่มี" endpoint ลบผู้ใช้เลยสักตัว และห้ามมี
       * ═══════════════════════════════════════════════════════════ */
      const ready = await manageReady();
      const patch = { Status: want, updated_at: new Date().toISOString() };
      if (ready) {
        patch.UpdatedBy  = clean(req.user.username);
        /* ปิด = จดว่าใครปิดเมื่อไหร่ · เปิดกลับ = ล้างสองช่องนี้ให้ว่าง */
        patch.DisabledAt = want === 'Logout' ? new Date().toISOString() : null;
        patch.DisabledBy = want === 'Logout' ? clean(req.user.username) : null;
      }

      await db.update(T, byId(cur), patch);        /* 🔴 ล็อกด้วย _id ไม่ใช่ ilike ชื่อ */
      auth.forgetUser(clean(cur.Username));   // ‼ ปิด/เปิดบัญชี ต้องมีผลทันที — ล้างหลังเขียนเสร็จ

      await ctx.audit(req.user, want === 'Logout' ? 'user_disable' : 'user_enable',
        { target: clean(cur.Username) }, auth.metaOf(req));
      res.json({ ok: true, status: want });
    } catch (e) {
      ctx.warn('status ล้มเหลว:', e.message);
      fail(res, 500, 'เปลี่ยนสถานะไม่สำเร็จ: ' + e.message);
    }
  });

  /* ─── ตั้งรหัสผ่านใหม่ ────────────────────────────────────────
   *  เก็บเป็น bcrypt เท่านั้น + ล้างช่อง Password ข้อความล้วนทิ้งด้วย */
  router.post('/api/:username/password', async (req, res) => {
    const username = clean(req.params.username);
    const password = String((req.body || {}).password || '');
    if (password.length < MIN_PASSWORD)
      return fail(res, 400, `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัวอักษร`);
    try {
      const cur = await rawOf(username);
      if (!cur) return fail(res, 404, 'ไม่พบผู้ใช้นี้');

      const ready = await manageReady();
      const patch = {
        PasswordHash: await bcrypt.hash(password, 10),
        Password: null,
        updated_at: new Date().toISOString(),
      };
      if (ready) patch.UpdatedBy = clean(req.user.username);

      /* 🔴 ล็อกด้วย _id — ของเดิมส่งชื่อที่ผู้ใช้พิมพ์ลง ilike ตรง ๆ
       *   ⇒ ยิงชื่อว่า * ครั้งเดียว = ตั้งรหัสใหม่ทับทุกคนทั้งบริษัท
       *     (ไม่มีข้อความ error ให้ใครเห็น และย้อนกลับไม่ได้ด้วย) */
      await db.update(T, byId(cur), patch);
      auth.forgetUser(clean(cur.Username));   // ‼ ตั้งรหัสใหม่แล้วต้องมีผลทันที

      // ตั้งใจไม่บันทึกตัวรหัสลง audit — เก็บแค่ว่าใครตั้งให้ใครเมื่อไร
      await ctx.audit(req.user, 'user_set_password',
        { target: clean(cur.Username) }, auth.metaOf(req));
      res.json({ ok: true });
    } catch (e) {
      ctx.warn('set-password ล้มเหลว:', e.message);
      fail(res, 500, 'ตั้งรหัสผ่านไม่สำเร็จ: ' + e.message);
    }
  });

  /* ═══════════════════════════════════════════════════════════════════
   *  รูปพนักงาน — อยู่ที่นี่เพราะมันคือ "ข้อมูลของผู้ใช้"
   *
   *  ‼ พี่เอสั่ง 5 ก.ย. 69:
   *    "ไป update รูปพนักงานที่ส่วนของ การจัดการผู้ใช้ นะ
   *     ส่วนที่ไปเพิ่มเมนูเกี่ยวกับรูปในแถบเมนูงาน ให้ลบออกตอนนี้เลย"
   *
   *  เดิมอลิซเอาไปแปะไว้ที่หน้าคีย์ยอดขาย ซึ่งผิดที่ — คนคีย์ยอดขาย
   *  ไม่ได้มีหน้าที่ดูแลรูปพนักงาน คนที่ดูแลคือคนจัดการผู้ใช้
   *  ‼ ของอยู่ผิดที่ = หาไม่เจอตอนต้องใช้ และให้สิทธิ์เกินความจำเป็นด้วย
   *
   *  รูปเก็บที่ Supabase Storage ไม่ได้เก็บในชีต — ปิดชีตแล้วยังใช้ได้
   *  (ดู core/photo.js)
   * ═══════════════════════════════════════════════════════════════════ */
  const photo = require('../../core/photo');

  /** ใส่/เปลี่ยนรูปของผู้ใช้คนหนึ่ง — รับ data URL จากหน้าเว็บ */
  router.post('/api/:username/photo', async (req, res) => {
    const username = clean(req.params.username);
    try {
      const cur = await rawOf(username);
      if (!cur) return fail(res, 404, 'ไม่พบผู้ใช้นี้');

      const r = await photo.save(clean(cur.Username), (req.body || {}).image,
        { by: clean(req.user.username), source: 'upload' });
      if (!r.ok) return fail(res, 400, r.error);

      await ctx.audit(req.user, 'user_set_photo',
        { target: username, bytes: r.bytes || 0 }, auth.metaOf(req));
      res.json({ ...r, msg: r.same ? 'รูปเดิมอยู่แล้ว ไม่ต้องอัปใหม่' : 'เปลี่ยนรูปเรียบร้อย' });
    } catch (e) {
      ctx.warn('set-photo ล้มเหลว:', e.message);
      fail(res, 500, 'ใส่รูปไม่สำเร็จ: ' + e.message);
    }
  });

  /** เอารูปออก */
  router.post('/api/:username/photo/remove', async (req, res) => {
    const username = clean(req.params.username);
    try {
      const cur = await rawOf(username);
      if (!cur) return fail(res, 404, 'ไม่พบผู้ใช้นี้');
      const r = await photo.remove(clean(cur.Username));
      await ctx.audit(req.user, 'user_del_photo', { target: username }, auth.metaOf(req));
      res.json(r);
    } catch (e) {
      fail(res, 500, 'ลบรูปไม่สำเร็จ: ' + e.message);
    }
  });

  /** แผนที่ Username → URL รูป (ไว้วาดรูปในตารางรายชื่อ) */
  router.get('/api/photos', async (_req, res) => {
    try { res.json({ ok: true, map: await photo.map() }); }
    catch (e) { fail(res, 500, e.message); }
  });

  /**
   * ‼ ตรวจว่าระบบรูปติดตรงไหน — ไล่ยิงจริงทุกข้อต่อ ไม่กลืน error
   *   ใช้ตอนย้ายรูปชุดเก่าเข้าระบบใหม่ (งานครั้งเดียว)
   */
  router.get('/api/photos/diagnose', async (_req, res) => {
    /* ‼ ธง "คำขอสำเร็จ" (ok) กับ "ระบบรูปพร้อมไหม" (ready) ต้องเป็นคนละฟิลด์
     *   เคยใช้ชื่อ ok ทั้งคู่ แล้ว spread ไม่ทับตอนตรวจไม่ผ่าน
     *   → หน้าจอเข้าใจว่าผ่าน แล้วขึ้นว่า "ย้ายเสร็จแล้ว 0 คน" (5 ก.ย. 69) */
    try { res.json({ ok: true, ...(await photo.diagnose()) }); }
    catch (e) { fail(res, 500, e.message); }
  });

  router.get('/api/photos/status', async (_req, res) => {
    try { res.json({ ok: true, ...(await photo.status()) }); }
    catch (e) { fail(res, 500, e.message); }
  });

  /**
   * ‼ ตรึงไอดีไฟล์ไว้ถาวร (พี่เอสั่ง 5 ก.ย. 69: "ให้ทำ ID เก็บไว้เลย")
   *
   *   ค้นจากสารบัญครั้งเดียว แล้วจดไอดีลง app.file_ref
   *   หลังจากนี้ไม่ต้องค้นอีกเลย และทนต่อการเปลี่ยนชื่อ/ย้ายโฟลเดอร์ใน Drive
   *   ‼ ไม่ได้ก๊อปไฟล์ — จดแค่ "ไอดี" ซึ่งเป็นข้อความ 33 ตัวอักษร
   */
  router.post('/api/photos/freeze', async (req, res) => {
    try {
      const r = await db.rpc('freeze_user_photos', {});
      const row = (Array.isArray(r) ? r[0] : r) || {};
      await ctx.audit(req.user, 'photo_freeze',
        { target: 'ทั้งหมด', added: row['จดใหม่'] || 0 }, auth.metaOf(req));
      res.json({ ok: true, ...row });
    } catch (e) { fail(res, 500, e.message); }
  });

  router.post('/api/photos/import', async (req, res) => {
    try {
      const r = await photo.importFromDrive({
        limit: Number((req.body || {}).limit) || 300 });
      await ctx.audit(req.user, 'photo_import',
        { target: 'ทั้งหมด', moved: r.moved || 0 }, auth.metaOf(req));
      res.json(r);
    } catch (e) { fail(res, 500, e.message); }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  📊 รอบ 234 — ส่งออกรายชื่อผู้ใช้เป็น Google Sheet (modules/users/export-sheet.js)
   *  พี่เอ 4 ต.ค. 69: "สร้างปุ่ม export เป็น google sheet ให้ด้วยนะ"
   *
   *  POST /api/export/sheet        สร้างไฟล์ใหม่บน Google Drive จากรายชื่อ "ตามตัวกรองที่เลือกอยู่"
   *                                (q · status · permission · branch — กติกาเดียวกับ /api/list)
   *                                เป็น POST เพราะสร้างไฟล์จริงทุกครั้งที่กด + จดบันทึกการใช้งาน
   *  POST /api/export/sheet/share  เปิดให้คนที่มีลิงก์ "ดูได้" — เฉพาะไฟล์ที่ส่งออกจากหน้านี้เท่านั้น
   *
   *  🔒 อ่านผู้ใช้จากฐานของเราเองเสมอ — ไม่รับแถวข้อมูลจากหน้าเว็บ (หน้าเว็บส่งมาแค่ตัวกรอง)
   *  🔒 ไม่มีรหัสผ่าน/แฮชในไฟล์ · ไม่แชร์แบบมีลิงก์เองโดยพลการ · ไม่ลบ ไม่ทับไฟล์เดิมบน Drive
   *  🔒 สิทธิ์: แอปนี้เปิดได้เฉพาะ admin · namna อยู่แล้ว (core/app-access.js TOOL_APPS) — ด่านเดียวกับทุกเส้นของแอป
   * ═══════════════════════════════════════════════════════════════ */
  const XS = require('./export-sheet');
  router.post('/api/export/sheet', async (req, res) => {
    try {
      const b = req.body || {};
      const query = { q: clean(b.q), status: clean(b.status), permission: clean(b.permission), branch: clean(b.branch) };
      const ready = await manageReady();
      const rows = await db.selectAll(T, { select: selectOf(ready), order: 'Username.asc' });
      const all = (rows || []).map(r => shape(r, auth.roleOf));
      const list = XS._t.filterSort(all, query, auth.ROLE_RANK || {});
      if (!list.length) return fail(res, 400, 'ไม่มีผู้ใช้ตรงตามตัวกรองที่เลือก — ไม่ได้สร้างไฟล์');
      const filter = XS._t.filterText(query);
      const made = await XS.exportList(list, { by: req.user.username, filter });
      await ctx.audit(req.user, 'users_export_sheet',
        { target: 'Google Sheet', rows: made.rows, of: all.length, filter, file: made.name, fileId: made.fileId },
        auth.metaOf(req));
      res.json({ ok: true, url: made.url, fileId: made.fileId, name: made.name, rows: made.rows,
                 of: all.length, filter, shared: false, folder: made.folder, columns: XS.HEADERS.length });
    } catch (e) {
      ctx.warn('ส่งออก Google Sheet ล้มเหลว:', e.message);
      fail(res, 500, 'ส่งออกเป็น Google Sheet ไม่สำเร็จ: ' + e.message);
    }
  });

  router.post('/api/export/sheet/share', async (req, res) => {
    try {
      const fileId = clean((req.body || {}).fileId);
      if (!fileId) return fail(res, 400, 'ไม่ได้ระบุไฟล์');
      const r = await XS.shareLink(fileId);
      if (r.denied) return fail(res, 400, r.why);
      if (!r.ok) return fail(res, 502, 'เปิดให้คนที่มีลิงก์ดูไม่สำเร็จ: ' + (r.why || 'Google ไม่ได้บอกเหตุผล'));
      await ctx.audit(req.user, 'users_export_share',
        { target: 'Google Sheet', fileId, mode: 'ทุกคนที่มีลิงก์ ดูได้' }, auth.metaOf(req));
      res.json({ ok: true, shared: true, mode: 'reader' });
    } catch (e) {
      ctx.warn('แชร์ Google Sheet ล้มเหลว:', e.message);
      fail(res, 500, 'เปิดให้คนที่มีลิงก์ดูไม่สำเร็จ: ' + e.message);
    }
  });

  ctx.log('พร้อมใช้งาน — 14 endpoint');
}

module.exports = { mount };
