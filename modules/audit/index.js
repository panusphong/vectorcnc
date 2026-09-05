'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  โมดูล "บันทึกการใช้งาน" (audit log)
 *
 *  แอปเดิมทั้ง 12 ตัวไม่มีอันนี้เลยสักตัว — เวลามีปัญหาจึงตอบไม่ได้ว่า
 *  ใครแก้ ใครลบ ใครเข้าตอนไหน ระบบใหม่บังคับเขียนทุกเหตุการณ์สำคัญ
 *
 *  โมดูลนี้อ่านอย่างเดียว ไม่มี endpoint แก้/ลบ — log ต้องแก้ไม่ได้
 *  ถึงจะเชื่อถือได้
 * ═══════════════════════════════════════════════════════════════════ */
const T = 'auth_audit';

/** คำอธิบายภาษาไทยของแต่ละ action */
const LABEL = {
  login_ok:          'เข้าสู่ระบบสำเร็จ',
  login_fail:        'เข้าสู่ระบบไม่สำเร็จ',
  login_blocked:     'ถูกปฏิเสธ (บัญชีปิดอยู่)',
  logout:            'ออกจากระบบ',
  open_module:       'เปิดโมดูล',
  change_password:   'เปลี่ยนรหัสผ่านตัวเอง',
  reload_module:     'สั่งโหลดโมดูลใหม่',
  user_create:       'เพิ่มผู้ใช้',
  user_update:       'แก้ข้อมูลผู้ใช้',
  user_disable:      'ปิดบัญชีผู้ใช้',
  user_enable:       'เปิดบัญชีผู้ใช้',
  user_set_password: 'ตั้งรหัสผ่านให้ผู้ใช้',
};

/** action ที่ถือว่า "ต้องจับตา" — โชว์เป็นสีเตือนในหน้าเว็บ */
const ALERT = new Set(['login_fail', 'login_blocked']);

const clean = s => String(s == null ? '' : s).trim();

async function mount(router, ctx) {
  const { db } = ctx;

  /* ─── รายการเหตุการณ์ ─────────────────────────────────────────── */
  router.get('/api/list', async (req, res) => {
    try {
      const days  = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
      const since = new Date(Date.now() - days * 86400000).toISOString();

      const params = { select: '*', order: 'at.desc', limit, at: 'gte.' + since };
      if (clean(req.query.action))   params.action   = 'eq.' + clean(req.query.action);
      if (clean(req.query.module))   params.module   = 'eq.' + clean(req.query.module);
      if (clean(req.query.username)) params.username = 'ilike.' + clean(req.query.username);

      const rows = await db.select(T, params) || [];

      // ค้นหาข้อความอิสระทำฝั่งนี้ — ข้อมูลถูกจำกัดด้วย limit อยู่แล้ว
      const q = clean(req.query.q).toLowerCase();
      const list = (q
        ? rows.filter(r => [r.username, r.action, r.module, r.target, r.detail, r.ip]
            .join(' ').toLowerCase().includes(q))
        : rows
      ).map(r => ({
        id:       r._id,
        at:       r.at,
        username: clean(r.username),
        role:     clean(r.role),
        action:   clean(r.action),
        label:    LABEL[clean(r.action)] || clean(r.action),
        alert:    ALERT.has(clean(r.action)),
        module:   clean(r.module),
        target:   clean(r.target),
        detail:   clean(r.detail),
        ip:       clean(r.ip),
      }));

      res.json({ ok: true, events: list, days, limit, truncated: rows.length >= limit });
    } catch (e) {
      ctx.warn('list ล้มเหลว:', e.message);
      res.status(500).json({ ok: false, error: 'อ่านบันทึกไม่สำเร็จ: ' + e.message });
    }
  });

  /* ─── สรุปภาพรวม ──────────────────────────────────────────────── */
  router.get('/api/stats', async (req, res) => {
    try {
      const days  = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const rows = await db.select(T, {
        select: 'username,action,module,at',
        at: 'gte.' + since, order: 'at.desc', limit: 1000,
      }) || [];

      const tally = (arr, keyFn) => {
        const m = new Map();
        for (const r of arr) {
          const k = keyFn(r);
          if (!k) continue;
          m.set(k, (m.get(k) || 0) + 1);
        }
        return [...m.entries()].sort((a, b) => b[1] - a[1]);
      };

      const fails = rows.filter(r => r.action === 'login_fail');

      res.json({
        ok: true, days,
        total:      rows.length,
        logins:     rows.filter(r => r.action === 'login_ok').length,
        fails:      fails.length,
        blocked:    rows.filter(r => r.action === 'login_blocked').length,
        // ผู้ใช้ที่ล็อกอินพลาดบ่อย = สัญญาณว่ามีคนเดารหัส หรือคนนั้นลืมรหัส
        failTop:    tally(fails, r => r.username).slice(0, 5)
                      .map(([k, v]) => ({ username: k, count: v })),
        topUsers:   tally(rows.filter(r => r.action === 'login_ok'), r => r.username)
                      .slice(0, 8).map(([k, v]) => ({ username: k, count: v })),
        topModules: tally(rows.filter(r => r.action === 'open_module'), r => r.module)
                      .slice(0, 8).map(([k, v]) => ({ module: k, count: v })),
        actions:    tally(rows, r => r.action)
                      .map(([k, v]) => ({ action: k, label: LABEL[k] || k, count: v })),
      });
    } catch (e) {
      ctx.warn('stats ล้มเหลว:', e.message);
      res.status(500).json({ ok: false, error: 'สรุปข้อมูลไม่สำเร็จ: ' + e.message });
    }
  });

  ctx.log('พร้อมใช้งาน — อ่านอย่างเดียว ไม่มี endpoint แก้/ลบ');
}

module.exports = { mount };
