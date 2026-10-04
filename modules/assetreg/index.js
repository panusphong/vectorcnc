'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  โมดูล "ระบบทะเบียนเบอร์โทร และทรัพย์สิน 📱" — การ์ดทางเข้าแอปภายนอก (Google Apps Script)
 *
 *  ‼ พี่เอสั่ง 4 ต.ค. 69 (คำต่อคำ):
 *    "เพิ่ม app card อีกในหน้า CRM HUB ให้หน่อยนะ
 *     https://script.google.com/macros/s/AKfycbxOZ60ME28OHf9daxcDs-gcIJkajITI2QZQZjkEw8uRouqC3fkkWwFRSnrGO4rYmgKQkA/exec
 *     ชื่อ app ระบบทะเบียนเบอร์โทร และทรัพย์สิน"
 *    "ให้เฉพาะ permission : administrator เปิดดูได้เท่านั้นนะ"
 *
 *  ── ทำงานอย่างไร ─────────────────────────────────────────────────
 *   หน้ารวมแอปเปิด /m/assetreg/ ในแท็บใหม่ (ทางเดียวกับทุกการ์ด) → ผ่านด่าน 3 ชั้นข้างล่าง
 *   → เซิร์ฟเวอร์ส่งต่อ (302) ไปที่แอปบน Google Apps Script
 *   ⇒ ไม่ต้องแก้ public/hub.html และ server.js เลย (การ์ดมาจาก module.json ตามทะเบียนโมดูล)
 *
 *  ── 🔒 สิทธิ์ 3 ชั้น (แบบเดียวกับ Management Report) ─────────────
 *   ① core/module-host.js ครอบ requireLogin + registry.canUse ให้ทุกเส้นทาง (ไม่มี publicPaths)
 *   ② core/app-perms.js ADMIN_PERM_ONLY_APPS มี 'assetreg' ⇒ กลุ่มอื่นไม่เห็นการ์ด เปิดไม่ได้
 *   ③ ที่นี่: ตรวจซ้ำว่า permission = administrator (เทียบตรงเป๊ะผ่าน canonPerm · ไม่เทียบจาก role)
 *   ⇒ ที่อยู่ของแอปถูกส่งให้เบราว์เซอร์ "หลังผ่านด่านแล้วเท่านั้น" — คนที่ไม่ใช่ Administrator
 *     ไม่เห็นทั้งการ์ดและที่อยู่
 *
 *  🔴 ข้อจำกัดที่ต้องรู้ (แก้จากฝั่งนี้ไม่ได้)
 *   ด่านนี้คุมแค่ "ทางเข้าจาก CRM Hub" — ตัวแอปอยู่บน Google ถ้าตั้ง Deploy ไว้แบบ
 *   "ใครมีลิงก์ก็เปิดได้" คนที่ได้ลิงก์ตรงไปก็ยังเปิดได้โดยไม่ผ่าน CRM Hub
 *   ⇒ ถ้าต้องกันจริง ต้องตั้งสิทธิ์/ล็อกอินที่ฝั่ง Google Apps Script ด้วย
 *
 *  ‼ เปลี่ยนที่อยู่ภายหลังได้โดยไม่แก้โค้ด: ตั้ง Railway Variables ชื่อ ASSETREG_URL
 *    (รับเฉพาะที่อยู่ https://script.google.com/… — อย่างอื่นถูกมองข้าม ใช้ค่าในไฟล์นี้)
 * ═══════════════════════════════════════════════════════════════════ */
const perms = require('../../core/app-perms');

const DEFAULT_URL = 'https://script.google.com/macros/s/AKfycbxOZ60ME28OHf9daxcDs-gcIJkajITI2QZQZjkEw8uRouqC3fkkWwFRSnrGO4rYmgKQkA/exec';
const SAFE_URL = /^https:\/\/script\.google\.com\/[A-Za-z0-9_\-\/.]+$/;

/** ที่อยู่ปลายทาง — ค่าจาก Railway ชนะ ถ้าเป็นที่อยู่ของ Google Apps Script จริง · ไม่งั้นใช้ค่าในไฟล์ */
function targetUrl() {
  const env = String(process.env.ASSETREG_URL || '').trim();
  return SAFE_URL.test(env) ? env : DEFAULT_URL;
}
const isAdminPerm = u => !!u && perms.canonPerm(u.permission) === perms.ADMIN_PERM_KEY;

async function mount(router, ctx) {
  const metaOf = req => ((ctx.auth && typeof ctx.auth.metaOf === 'function') ? ctx.auth.metaOf(req) : undefined);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    /* ไม่ส่งที่อยู่ของหน้านี้ (ซึ่งมีตั๋วเข้าแอปติดอยู่ใน ?t=) ไปให้ปลายทางภายนอก */
    res.set('Referrer-Policy', 'no-referrer');
    if (!isAdminPerm(req.user)) {
      const msg = 'ระบบทะเบียนเบอร์โทร และทรัพย์สิน เปิดได้เฉพาะสิทธิ์ Administrator';
      if (req.path.startsWith('/api/')) return res.status(403).json({ ok: false, code: 'ADMIN_ONLY', error: msg });
      return res.status(403).type('text/plain; charset=utf-8').send('🔒 ' + msg);
    }
    next();
  });

  router.get(['/', '/index.html'], (req, res) => {
    try { ctx.audit(req.user, 'assetreg_open', {}, metaOf(req)); } catch (_) { /* บันทึกไม่ได้ไม่ใช่เหตุให้เปิดไม่ได้ */ }
    res.redirect(302, targetUrl());
  });

  router.get('/api/_diag', (req, res) => {
    res.json({ ok: true, app: 'assetreg', version: require('./version').VERSION, external: 'Google Apps Script',
               urlFrom: targetUrl() === DEFAULT_URL ? 'ค่าในโค้ด' : 'Railway Variables (ASSETREG_URL)' });
  });

  ctx.log('การ์ดระบบทะเบียนเบอร์โทร และทรัพย์สิน พร้อมใช้งาน (ส่งต่อไป Google Apps Script · เฉพาะ Administrator)');
}

module.exports = { mount, isAdminPerm, targetUrl, DEFAULT_URL };
