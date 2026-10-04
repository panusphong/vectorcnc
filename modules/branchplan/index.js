'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  โมดูล "ระบบจัดตารางสาขา 🏬" — การ์ดทางเข้าแอปภายนอก (Google Apps Script)
 *
 *  ‼ พี่เอสั่ง 4 ต.ค. 69 (คำต่อคำ):
 *    "ระบบจัดตารางสาขา
 *     https://script.google.com/macros/s/AKfycbytnB-T17Jix7Vj2okUxBWdMe6f_SuHzkDB9H-bUgC7C4ZmwD4CgRNWDpJR3E2QsIBviQ/exec
 *     … เพิ่ม app card หน้า CRM Hub ให้ด้วยนะ"
 *
 *  ทำงานผ่านตัวกลาง core/ext-link.js — ผ่านด่านล็อกอิน + สิทธิ์เข้าแอปของ CRM Hub ก่อน แล้วส่งต่อ (302)
 *  ‼ ใครเห็นการ์ดนี้: กำหนดที่ "ทะเบียนกลาง → สิทธิ์เข้าแอป" (ตาราง app.app_access_group)
 *    sql/112 ติ๊กให้กลุ่ม administrator · sales · sale support ไว้ก่อน — กลุ่มอื่นติ๊กเพิ่ม/เอาออกได้เองโดยไม่ต้องแก้โค้ด
 *  ‼ เปลี่ยนที่อยู่ภายหลังได้โดยไม่แก้โค้ด: ตั้ง Railway Variables ชื่อ BRANCHPLAN_URL
 * ═══════════════════════════════════════════════════════════════════ */
module.exports = require('../../core/ext-link').make({
  key: 'branchplan',
  title: 'ระบบจัดตารางสาขา',
  url: 'https://script.google.com/macros/s/AKfycbytnB-T17Jix7Vj2okUxBWdMe6f_SuHzkDB9H-bUgC7C4ZmwD4CgRNWDpJR3E2QsIBviQ/exec',
  envVar: 'BRANCHPLAN_URL',
});
