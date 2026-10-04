'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/sales/affiliate-api.js — เส้นทางของหน้า "Lead จาก Affiliate"  (รอบ 222)
 *  (เมนูงาน → เฉพาะแอดมิน → 🤝 Lead จาก Affiliate)
 *
 *  ‼ เฉพาะผู้ดูแลระบบ — ด่านเดียวกับเครื่องมือแอดมินอื่นของแอปนี้ (index.js isAdmin)
 *  ‼ ไม่มีเส้นไหนส่ง key / รหัสลับออกไปหน้าเว็บ — บอกได้แค่ "ตั้งแล้ว / ยังไม่ได้ตั้ง"
 * ═══════════════════════════════════════════════════════════════════ */
const AFF = require('./affiliate');
const HOOK = require('./affiliate-hook');

const clean = s => String(s == null ? '' : s).trim();
const isAdmin = req => /administrator|ผู้ดูแล|admin/i
  .test(clean(req.user && (req.user.permission || req.user.role)));

async function mount(router, ctx) {
  const gate = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'เฉพาะผู้ดูแลระบบ' });
    next();
  };
  const fail = (res, e) => res.status(e && e.userError ? 400 : 500)
    .json({ ok: false, error: clean(e && e.message) || 'ทำไม่สำเร็จ' });

  router.get('/api/affiliate/status', gate, async (_req, res) => {
    try { res.json({ ...(await AFF.status()), hookPath: HOOK.PATH }); }
    catch (e) { fail(res, e); }
  });

  /* บันทึกตั้งค่า → คิดเจ้าของใหม่ให้ใบที่ยังไม่มีใครแตะช่องเจ้าของ */
  router.post('/api/affiliate/config', gate, async (req, res) => {
    try {
      const b = req.body || {};
      const cur = await AFF.loadConfig(true);
      const next = { ...cur };
      if (b.enabled !== undefined) next.enabled = !!b.enabled;
      if (b.poolUser !== undefined) next.poolUser = clean(b.poolUser);
      if (b.jobPrefix !== undefined) {
        const p = clean(b.jobPrefix).toUpperCase();
        if (p && !/^[A-Z][A-Z0-9]{0,5}$/.test(p)) {
          const e = new Error('คำนำหน้ารหัสงานต้องขึ้นต้นด้วยตัวอักษรอังกฤษ ตามด้วยอักษร/ตัวเลข รวมไม่เกิน 6 ตัว (เว้นว่าง = ใช้คำนำหน้าของเจ้าของ)');
          e.userError = true; throw e;
        }
        next.jobPrefix = p;
      }
      if (b.claimers && typeof b.claimers === 'object') next.claimers = b.claimers;
      const cfg = await AFF.saveConfig(next, req.user && req.user.username);
      let remap = null;
      try { remap = await AFF.remap(); } catch (e) { remap = { error: e.message }; }
      try { await ctx.audit(req.user, 'affiliate_config', { target: 'affiliate_sync' }); } catch { /* audit ล้มไม่หยุดงาน */ }
      res.json({ ok: true, cfg, remap });
    } catch (e) { fail(res, e); }
  });

  router.post('/api/affiliate/pull', gate, async (_req, res) => {
    try { res.json({ ok: true, result: await AFF.pollOnce() }); }
    catch (e) { fail(res, e); }
  });

  router.post('/api/affiliate/backfill', gate, async (req, res) => {
    try {
      const r = await AFF.backfill();
      try { await ctx.audit(req.user, 'affiliate_backfill', { target: 'leads' }); } catch { /* ไม่เป็นไร */ }
      res.json({ ok: true, result: r });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, isAdmin };
