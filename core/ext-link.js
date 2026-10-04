'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/ext-link.js — "การ์ดทางเข้าแอปภายนอก" (แอปที่อยู่บน Google Apps Script ฯลฯ)
 *
 *  ‼ พี่เอสั่ง 4 ต.ค. 69: "เพิ่ม app card หน้า CRM Hub ให้ด้วยนะ" (ระบบจัดตารางสาขา · ระบบจองคิว LED)
 *    ต่อจากการ์ด "ระบบทะเบียนเบอร์โทร และทรัพย์สิน" ในรอบ 233 — ทำตัวกลางไว้ให้การ์ดแบบนี้ใช้ร่วมกัน
 *
 *  ── ทำงานอย่างไร ─────────────────────────────────────────────────
 *   หน้ารวมแอปเปิด /m/<คีย์>/ ในแท็บใหม่ (ทางเดียวกับทุกการ์ด) → core/module-host.js ตรวจ
 *   "ล็อกอินแล้ว + มีสิทธิ์แอปนี้" → โมดูลส่งต่อ (302) ไปที่แอปภายนอก
 *   ⇒ ที่อยู่ของแอปภายนอกไม่ได้ฝังอยู่ในหน้าเว็บ — ถูกส่งให้เบราว์เซอร์หลังผ่านด่านแล้วเท่านั้น
 *   ⇒ ไม่ต้องแก้ public/hub.html และ server.js (การ์ดมาจาก module.json ตามทะเบียนโมดูล)
 *
 *  🔒 ไม่อ่าน/เขียนฐานข้อมูล · ไม่ยิงเน็ตเอง · ทำอย่างเดียวคือส่งต่อ + จดบันทึกการใช้งาน
 *  🔒 รับเฉพาะที่อยู่ https://script.google.com/… (ทั้งค่าในโค้ดและค่าจาก Railway Variables)
 *
 *  🔴 ข้อจำกัดที่แก้จากฝั่งนี้ไม่ได้: ด่านนี้คุมแค่ "ทางเข้าจาก CRM Hub"
 *    ถ้าแอปบน Google ตั้งให้ "ทุกคน" เปิดได้ คนที่ได้ลิงก์ตรงก็ยังเปิดได้โดยไม่ผ่าน CRM Hub
 * ═══════════════════════════════════════════════════════════════════ */
const perms = require('./app-perms');

const SAFE_URL = /^https:\/\/script\.google\.com\/[A-Za-z0-9_\-\/.]+$/;
const isAdminPerm = u => !!u && perms.canonPerm(u.permission) === perms.ADMIN_PERM_KEY;

/**
 * สร้างตัวต่อสาย (mount) ของการ์ดแอปภายนอก 1 ใบ
 * @param {{key:string, title:string, url:string, envVar?:string, adminOnly?:boolean}} o
 *   envVar    ชื่อตัวแปร Railway ที่ใช้เปลี่ยนที่อยู่ภายหลังได้โดยไม่แก้โค้ด (ไม่ตั้ง = ใช้ url)
 *   adminOnly ตรวจซ้ำในโมดูลว่าเป็นสิทธิ์ Administrator (ชั้นที่ 3 — สำหรับแอปใน ADMIN_PERM_ONLY_APPS)
 */
function make(o) {
  const key = String(o.key || '').trim(), title = String(o.title || '').trim();
  const DEFAULT_URL = String(o.url || '').trim();
  if (!key || !title) throw new Error('ext-link: ต้องระบุ key และ title');
  if (!SAFE_URL.test(DEFAULT_URL)) throw new Error('ext-link: ที่อยู่ของ ' + key + ' ไม่ใช่ที่อยู่ของ Google Apps Script');

  /** ที่อยู่ปลายทาง — ค่าจาก Railway ชนะ ถ้าเป็นที่อยู่ของ Google Apps Script จริง · ไม่งั้นใช้ค่าในไฟล์ */
  function targetUrl() {
    const env = o.envVar ? String(process.env[o.envVar] || '').trim() : '';
    return SAFE_URL.test(env) ? env : DEFAULT_URL;
  }

  async function mount(router, ctx) {
    const metaOf = req => ((ctx.auth && typeof ctx.auth.metaOf === 'function') ? ctx.auth.metaOf(req) : undefined);

    router.use((req, res, next) => {
      res.set('Cache-Control', 'no-store');
      /* ไม่ส่งที่อยู่ของหน้านี้ (ซึ่งมีตั๋วเข้าแอปติดอยู่ใน ?t=) ไปให้ปลายทางภายนอก */
      res.set('Referrer-Policy', 'no-referrer');
      if (o.adminOnly && !isAdminPerm(req.user)) {
        const msg = title + ' เปิดได้เฉพาะสิทธิ์ Administrator';
        if (req.path.startsWith('/api/')) return res.status(403).json({ ok: false, code: 'ADMIN_ONLY', error: msg });
        return res.status(403).type('text/plain; charset=utf-8').send('🔒 ' + msg);
      }
      next();
    });

    router.get(['/', '/index.html'], (req, res) => {
      try { ctx.audit(req.user, key + '_open', {}, metaOf(req)); } catch (_) { /* บันทึกไม่ได้ไม่ใช่เหตุให้เปิดไม่ได้ */ }
      res.redirect(302, targetUrl());
    });

    router.get('/api/_diag', (req, res) => {
      res.json({ ok: true, app: key, external: 'Google Apps Script', adminOnly: !!o.adminOnly,
                 urlFrom: targetUrl() === DEFAULT_URL ? 'ค่าในโค้ด' : 'Railway Variables (' + o.envVar + ')' });
    });

    ctx.log('การ์ด' + title + ' พร้อมใช้งาน (ส่งต่อไป Google Apps Script' + (o.adminOnly ? ' · เฉพาะ Administrator' : '') + ')');
  }

  return { mount, targetUrl, DEFAULT_URL, isAdminPerm };
}

module.exports = { make, SAFE_URL, isAdminPerm };
