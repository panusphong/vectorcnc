'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/sales/affiliate-hook.js — ⚡ จุดรับ lead "ทันที" จากฐาน Affiliate  (รอบ 222)
 *
 *  ฐาน Supabase ของ Affiliate ตั้ง Database Webhook ที่ตาราง public.leads
 *  (Insert + Update) ให้ยิงมาที่   POST /hook/affiliate/lead
 *
 *  ── 🔒 ด่านของเส้นนี้ ────────────────────────────────────────────────
 *   ‼ อยู่นอกด่านล็อกอิน "โดยตั้งใจ" ท่าเดียวกับ /api/sso/verify
 *     เพราะคนยิงเข้ามาคือ "ฐานข้อมูลของ Affiliate" ไม่ใช่เบราว์เซอร์ของคน
 *   ⇒ ด่านคือ "รหัสลับร่วม" AFFILIATE_WEBHOOK_SECRET (ยาวอย่างน้อย 16 ตัว)
 *     ส่งมาในหัวคำขอ  x-affiliate-secret: <รหัสลับ>   (หรือ Authorization: Bearer <รหัสลับ>)
 *   🔴 ไม่ตั้งรหัสลับ = ปฏิเสธทุกคำขอ (fail-closed) ไม่ใช่เปิดประตูทิ้งไว้
 *   🔴 รหัสลับอยู่ใน Railway > Variables เท่านั้น — ห้ามใส่ในโค้ด · ห้ามขึ้น log · ห้ามสะท้อนกลับ
 *   🔴 คำตอบที่ส่งกลับไม่มีข้อมูลลูกค้า (ฐาน Affiliate เก็บคำตอบของ webhook ไว้ในตารางของมัน)
 * ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const AFF = require('./affiliate');

const clean = s => String(s == null ? '' : s).trim();
const PATH = '/hook/affiliate/lead';
const MIN_SECRET = 16;

const digest = s => crypto.createHash('sha256').update(String(s)).digest();
function secretOk(req) {
  const want = clean(process.env.AFFILIATE_WEBHOOK_SECRET);
  if (want.length < MIN_SECRET) return false;
  const h = (req && req.headers) || {};
  let got = clean(h['x-affiliate-secret']);
  if (!got) { const m = clean(h.authorization).match(/^Bearer\s+(.+)$/i); if (m) got = clean(m[1]); }
  if (!got) return false;
  return crypto.timingSafeEqual(digest(got), digest(want));
}

/* กันเดารหัสลับ: IP เดียวส่งรหัสผิดเกิน 20 ครั้งใน 1 นาที ⇒ พักรับจาก IP นั้นจนครบนาที */
const _bad = new Map();
function tooManyBad(ip, add) {
  const now = Date.now();
  let o = _bad.get(ip);
  if (!o || now - o.t > 60000) { o = { t: now, n: 0 }; _bad.set(ip, o); }
  if (add) o.n++;
  if (_bad.size > 2000) for (const [k, v] of _bad) if (now - v.t > 60000) _bad.delete(k);
  return o.n > 20;
}

/** ติดตั้งเส้นทางลง express app + เปิดตัวเก็บตก */
function install(app, opt) {
  /* ‼ มีเส้น POST เส้นเดียว — ไม่มีเส้น GET ไว้ "เช็คว่าพร้อมไหม" โดยตั้งใจ
   *   (เส้นสาธารณะทุกเส้นคือภาระที่ต้องเฝ้า · สถานะดูได้ในหน้า เมนูงาน → Lead จาก Affiliate ซึ่งอยู่หลังด่านล็อกอิน) */
  app.post(PATH, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const ip = clean(req.ip) || '-';
    if (tooManyBad(ip, false)) return res.status(429).json({ ok: false });
    if (!secretOk(req)) { tooManyBad(ip, true); return res.status(401).json({ ok: false }); }
    try {
      const b = (req.body && typeof req.body === 'object') ? req.body : {};
      if (clean(b.schema) !== 'public' || clean(b.table) !== 'leads')
        return res.json({ ok: true, action: 'ignored' });
      AFF.noteHook();
      const type = clean(b.type).toUpperCase();
      if (type === 'DELETE') {
        const r = await AFF.markSourceDeleted(b.old_record && b.old_record.id);
        return res.json({ ok: true, action: r.action });
      }
      if (!b.record || typeof b.record !== 'object') return res.json({ ok: true, action: 'ignored' });
      const r = await AFF.ingest(b.record, 'webhook');
      return res.json({ ok: true, action: r.action });
    } catch (e) {
      /* ‼ log ได้แค่ข้อความ — ห้ามมีรหัสลับ / เนื้อหา lead ติดไป · ตัวเก็บตกจะมาเก็บใบนี้ซ้ำเอง */
      console.warn('[affiliate] รับ webhook แล้วทำไม่สำเร็จ:', clean(e && e.message).slice(0, 200));
      return res.status(500).json({ ok: false });
    }
  });

  if (!(opt && opt.noPoll)) AFF.start();
}

module.exports = { install, secretOk, PATH, MIN_SECRET };
