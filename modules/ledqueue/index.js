'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  โมดูล "ระบบจองคิว LED 💡" — การ์ดทางเข้าแอปภายนอก (Google Apps Script)
 *
 *  ‼ พี่เอสั่ง 4 ต.ค. 69 (คำต่อคำ):
 *    "ระบบจองคิว LED
 *     https://script.google.com/macros/s/AKfycbxJVR10P5UwGYSPIeuSvzHsK0FtFNZKds-WUbd4vEJpYScEOfBJo3N-JZvfe8_D3dKT/exec
 *     … เพิ่ม app card หน้า CRM Hub ให้ด้วยนะ"
 *
 *  ทำงานผ่านตัวกลาง core/ext-link.js — ผ่านด่านล็อกอิน + สิทธิ์เข้าแอปของ CRM Hub ก่อน แล้วส่งต่อ (302)
 *  ‼ ใครเห็นการ์ดนี้: กำหนดที่ "ทะเบียนกลาง → สิทธิ์เข้าแอป" (ตาราง app.app_access_group)
 *    sql/112 ติ๊กให้กลุ่ม administrator · sales · sale support ไว้ก่อน — กลุ่มอื่นติ๊กเพิ่ม/เอาออกได้เองโดยไม่ต้องแก้โค้ด
 *  ‼ เปลี่ยนที่อยู่ภายหลังได้โดยไม่แก้โค้ด: ตั้ง Railway Variables ชื่อ LEDQUEUE_URL
 * ═══════════════════════════════════════════════════════════════════ */
module.exports = require('../../core/ext-link').make({
  key: 'ledqueue',
  title: 'ระบบจองคิว LED',
  url: 'https://script.google.com/macros/s/AKfycbxJVR10P5UwGYSPIeuSvzHsK0FtFNZKds-WUbd4vEJpYScEOfBJo3N-JZvfe8_D3dKT/exec',
  envVar: 'LEDQUEUE_URL',
});
