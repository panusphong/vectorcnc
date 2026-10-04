'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  โมดูล "Management Report 📊" — สุขภาพองค์กรหน้าเดียว
 *
 *  ‼ พี่เอสั่ง 3 ต.ค. 69:
 *    "มาทำ app Management Report ให้พี่ด้วย โดยนำ ทุก app ใน CRM Hub มาสร้างเป็น Dash board
 *     ที่มีสรุปจบทุกอย่างในหน้าเดียว เพื่อตรวจสอบสุขภาพองค์กร …"
 *    "อย่าลืม เพิ่ม ใน app card หน้า crm hub ด้วยนะ และในส่วนนี้ คนที่เปิดดูได้มีแค่
 *     permission : administrator เท่านั้น"
 *    "เกณฑ์ เขียว เหลือง แดง ดูที่ Cash flow และแนวโน้มยอดขายที่เพิ่มขึ้น หรือลดลงเป็นหลัก"
 *
 *  ── โครงไฟล์ ────────────────────────────────────────────────────
 *    data.js    รวบรวมตัวเลขจากทุกแอป (อ่านอย่างเดียว · จำผล 10 นาที)
 *    health.js  ประเมิน เขียว/เหลือง/แดง + คะแนน + ข้อวิเคราะห์ (ฟังก์ชันล้วน)
 *    config.js  งบโฆษณา + เกณฑ์ (app.settings คีย์ mgmt_config)
 *    public/index.html  หน้า Dashboard (คอม + มือถือ)
 *
 *  ── 🔒 สิทธิ์ 3 ชั้น ─────────────────────────────────────────────
 *   ① core/module-host.js ครอบ requireLogin + registry.canUse ให้ทุกเส้นทาง (ไม่มี publicPaths)
 *   ② core/app-perms.js ADMIN_PERM_ONLY_APPS มี 'mgmt' ⇒ กลุ่มอื่นไม่เห็นการ์ด เปิดไม่ได้
 *   ③ ที่นี่: ทุกเส้น /api ตรวจซ้ำว่า permission = administrator (เทียบตรงเป๊ะผ่าน canonPerm)
 *      🔴 ไม่เทียบ role === 'ADMIN' — core/auth.js roleOf เดาแบบหลวม ('xadmin' ก็เป็น ADMIN)
 *      ⇒ ต่อให้เปิดหน้าได้ด้วยทางอื่น ตัวเลขก็ไม่ออกถ้าไม่ใช่ Administrator
 * ═══════════════════════════════════════════════════════════════════ */
const perms = require('../../core/app-perms');
const D = require('./data');
const H = require('./health');
const C = require('./config');
const VERSION = require('./version');

const PARTS = ['sales', 'cash', 'ar', 'ops', 'stock', 'health'];
const errText = e => String((e && e.message) || e || 'ไม่ทราบสาเหตุ').replace(/\s+/g, ' ').slice(0, 220);
const isAdminPerm = u => !!u && perms.canonPerm(u.permission) === perms.ADMIN_PERM_KEY;

function adminOnly(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!isAdminPerm(req.user))
    return res.status(403).json({ ok: false, code: 'ADMIN_ONLY', error: 'Management Report เปิดดูได้เฉพาะสิทธิ์ Administrator' });
  next();
}

async function part(name, ym, user, cfg) {
  if (name === 'sales') return D.salesPart(ym, cfg);
  if (name === 'cash') return D.cashPart(ym, user);
  if (name === 'ar') return D.arPart(user);
  if (name === 'ops') return D.opsPart(ym, user);
  if (name === 'stock') return D.stockPart(ym);
  /* health = รอทุกก้อน (ใช้ผลที่จำไว้ร่วมกับคำขอของก้อนนั้น ๆ — ไม่ยิงฐานซ้ำ) */
  const soft = p => Promise.resolve().then(p).then(v => v, e => ({ ok: false, err: errText(e) }));
  const [sales, cash, ar, ops, stock] = await Promise.all([
    soft(() => D.salesPart(ym, cfg)), soft(() => D.cashPart(ym, user)), soft(() => D.arPart(user)),
    soft(() => D.opsPart(ym, user)), soft(() => D.stockPart(ym)),
  ]);
  return Object.assign({ win: D.winOf(ym) }, H.build({ sales, cash, ar, ops, stock }, cfg));
}

let _lastFresh = 0;

async function mount(router, ctx) {
  const metaOf = req => ((ctx.auth && typeof ctx.auth.metaOf === 'function') ? ctx.auth.metaOf(req) : undefined);
  router.use('/api', adminOnly);

  router.get('/api/meta', (req, res) => {
    try { ctx.audit(req.user, 'mgmt_open', { ym: String(req.query.ym || '') }, metaOf(req)); } catch (_) { /* บันทึกไม่ได้ไม่ใช่เหตุให้เปิดไม่ได้ */ }
    res.json({ ok: true, app: VERSION.APP, version: VERSION.VERSION, months: D.monthOptions(), win: D.winOf(req.query.ym),
               user: { nickname: req.user.nickname || req.user.name || req.user.username } });
  });

  router.get('/api/part/:name', async (req, res) => {
    const name = String(req.params.name || '');
    if (PARTS.indexOf(name) < 0) return res.status(404).json({ ok: false, error: 'ไม่มีก้อนข้อมูลนี้' });
    try {
      /* ปุ่ม "อ่านใหม่" ล้างที่จำไว้ — จำกัด 1 ครั้งต่อ 30 วินาที กันกดรัวจนฐานหนัก */
      if (req.query.fresh === '1' && Date.now() - _lastFresh > 30000) { _lastFresh = Date.now(); D.dropAll(); }
      const cfg = (await C.load()).v;
      const out = await part(name, req.query.ym, req.user, cfg);
      res.json(Object.assign({ at: new Date().toISOString() }, out));
    } catch (e) {
      ctx.warn('ก้อน ' + name + ' อ่านไม่ได้: ' + errText(e));
      res.status(200).json({ ok: false, err: errText(e) });
    }
  });

  router.get('/api/config', async (req, res) => {
    const m = await C.load(true);
    res.json({ ok: true, config: m.v, saved: m.saved, by: m.by, when: m.when, err: m.err, defaults: C.DEFAULTS });
  });

  router.post('/api/config', async (req, res) => {          /* server.js แปลง JSON ให้แล้วทั้งระบบ */
    try {
      const v = await C.save(req.body && req.body.config, req.user.username);
      D.dropAll();
      try { ctx.audit(req.user, 'mgmt_config', { ads: v.ads.map(a => [a.key, a.budget]) }, metaOf(req)); } catch (_) { /* เหมือนกัน */ }
      res.json({ ok: true, config: v });
    } catch (e) {
      res.status(200).json({ ok: false, error: 'บันทึกค่าตั้งไม่ได้: ' + errText(e) });
    }
  });

  /* 📒 รอบ 233 — ผลลองถาม PEAK ตามรหัสผังบัญชีครั้งล่าสุด (ไม่ยิง PEAK)
   *   ตัวเดียวกับที่เมนู Cash Flow ของคีย์ยอดขายใช้ (core/peak-ledger.js) ⇒ สองหน้าเห็นผลชุดเดียวกัน
   *   ส่งเฉพาะ "สรุป" — แถวข้อมูลดูได้ที่เมนู Cash Flow ที่เดียว */
  router.get('/api/ledger/last', async (req, res) => {
    try {
      const L = await require('../../core/peak-ledger').last();
      if (!L || L.never) return res.json({ ok: true, never: true });
      res.json({ ok: true, at: L.at, by: L.by, month: L.month, anyYes: !!L.anyYes,
        biz: (L.biz || []).map(b => ({ biz: b.biz, verdict: b.verdict, verdictTh: b.verdictTh })) });
    } catch (e) { res.status(200).json({ ok: false, err: errText(e) }); }
  });

  router.get('/api/_diag', (req, res) => {
    res.json({ ok: true, app: 'mgmt', version: VERSION.VERSION, parts: PARTS, cacheMs: Number(process.env.MGMT_CACHE_MS || 600000), settingsKey: C.KEY });
  });

  ctx.log('แอป Management Report พร้อมใช้งาน (' + PARTS.length + ' ก้อนข้อมูล · อ่านอย่างเดียว)');
}

module.exports = { mount, part, isAdminPerm, PARTS };
