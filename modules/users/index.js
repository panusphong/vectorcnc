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

/** ฟิลด์ที่ส่งออกฝั่งเบราว์เซอร์ได้ — ไม่มีรหัสผ่านเด็ดขาด */
const SAFE = '_id,Name,Nickname,Impage,Username,Status,Permission,created_at,updated_at';

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
  };
}

async function mount(router, ctx) {
  const { db, auth } = ctx;
  const express = require('express');
  router.use(express.json({ limit: '1mb' }));

  /** อ่านผู้ใช้ตาม username (ไม่สนตัวพิมพ์) — คืน row ดิบ */
  const rawOf = username =>
    db.one(T, { Username: 'ilike.' + clean(username), select: SAFE + ',PasswordHash,Password' });

  /** นับจำนวนแอดมินที่ยังเปิดใช้งานอยู่ — กันไม่ให้เหลือศูนย์ */
  async function activeAdminCount() {
    const rows = await db.select(T, { select: 'Username,Status,Permission', limit: 1000 });
    return (rows || []).filter(r =>
      auth.roleOf(r.Permission) === 'ADMIN' &&
      clean(r.Status).toLowerCase() !== 'logout'
    ).length;
  }

  const isSelf = (req, username) =>
    clean(req.user.username).toLowerCase() === clean(username).toLowerCase();

  const fail = (res, code, error) => res.status(code).json({ ok: false, error });

  /* ─── รายชื่อผู้ใช้ ───────────────────────────────────────────── */
  router.get('/api/list', async (req, res) => {
    try {
      const rows = await db.select(T, {
        select: SAFE + ',PasswordHash,Password',
        order: 'Username.asc',
        limit: 1000,
      });
      let list = (rows || []).map(r => shape(r, auth.roleOf));

      const q = clean(req.query.q).toLowerCase();
      if (q) list = list.filter(u =>
        [u.username, u.name, u.nickname, u.permission].join(' ').toLowerCase().includes(q));

      const st = clean(req.query.status).toLowerCase();
      if (st === 'active')   list = list.filter(u => u.active);
      if (st === 'inactive') list = list.filter(u => !u.active);

      res.json({
        ok: true,
        users: list,
        summary: {
          total:    list.length,
          active:   list.filter(u => u.active).length,
          inactive: list.filter(u => !u.active).length,
          noPassword: list.filter(u => !u.hasPassword).length,
          plainLeft:  list.filter(u => u.plainLeft).length,
        },
        // ส่งไปให้หน้าเว็บทำ dropdown สิทธิ์ — มาจากที่เดียวกับที่ระบบใช้จริง
        permissions: Object.keys(auth.PERMISSION_ROLE),
        me: req.user.username,
        minPassword: MIN_PASSWORD,
      });
    } catch (e) {
      ctx.warn('list ล้มเหลว:', e.message);
      fail(res, 500, 'อ่านรายชื่อผู้ใช้ไม่สำเร็จ: ' + e.message);
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
      if (await rawOf(username)) return fail(res, 409, 'มีชื่อผู้ใช้นี้อยู่แล้ว');

      await db.insert(T, {
        Name:         clean(b.name),
        Nickname:     clean(b.nickname),
        Impage:       clean(b.image),
        Username:     username,
        PasswordHash: await bcrypt.hash(password, 10),
        Password:     null,
        Status:       'Login',
        Permission:   clean(b.permission),
      });

      await ctx.audit(req.user, 'user_create',
        { target: username, permission: clean(b.permission) }, auth.metaOf(req));
      res.json({ ok: true });
    } catch (e) {
      ctx.warn('create ล้มเหลว:', e.message);
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

      const patch = {};
      for (const [field, col] of [['name','Name'],['nickname','Nickname'],['image','Impage']]) {
        if (b[field] !== undefined) patch[col] = clean(b[field]);
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

      if (!Object.keys(patch).length) return fail(res, 400, 'ไม่มีอะไรให้แก้');

      patch.updated_at = new Date().toISOString();
      await db.update(T, { Username: 'ilike.' + username }, patch);

      await ctx.audit(req.user, 'user_update',
        { target: username, fields: Object.keys(patch) }, auth.metaOf(req));
      res.json({ ok: true });
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

      await db.update(T, { Username: 'ilike.' + username },
        { Status: want, updated_at: new Date().toISOString() });

      await ctx.audit(req.user, want === 'Logout' ? 'user_disable' : 'user_enable',
        { target: username }, auth.metaOf(req));
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
      if (!await rawOf(username)) return fail(res, 404, 'ไม่พบผู้ใช้นี้');

      await db.update(T, { Username: 'ilike.' + username }, {
        PasswordHash: await bcrypt.hash(password, 10),
        Password: null,
        updated_at: new Date().toISOString(),
      });

      // ตั้งใจไม่บันทึกตัวรหัสลง audit — เก็บแค่ว่าใครตั้งให้ใครเมื่อไร
      await ctx.audit(req.user, 'user_set_password', { target: username }, auth.metaOf(req));
      res.json({ ok: true });
    } catch (e) {
      ctx.warn('set-password ล้มเหลว:', e.message);
      fail(res, 500, 'ตั้งรหัสผ่านไม่สำเร็จ: ' + e.message);
    }
  });

  ctx.log('พร้อมใช้งาน — 5 endpoint');
}

module.exports = { mount };
