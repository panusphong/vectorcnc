'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/sheet-files.js — ทะเบียนไฟล์ชีตกลางของทั้งบริษัท
 *
 *  ID ทุกตัวมาจากการอ่าน CONFIG ในซอร์สของแอปเดิม ไม่ได้เดา
 *  (บันทึกที่มาไว้ทุกไฟล์ เผื่อวันหลังต้องไล่ย้อนว่าใครใช้อะไร)
 *
 *  ‼ ไฟล์ที่เพิ่มใหม่ ต้องแชร์ให้ service account เป็น "ผู้อ่าน" ก่อน
 *    ไม่งั้นจะได้ 403 ตอนสำรวจ
 * ═══════════════════════════════════════════════════════════════════ */
const { CFG } = require('./config');

const FILES = [
  {
    key: 'sales', title: 'Sales Report Tracking',
    id: CFG.SHEET_SALES_ID || '1jWTrSzwMKwj78xVA9gMj3cxizFxs18Pr-q0MJ8CjQ_M',
    used_by: 'คีย์ยอดขาย ✍️ · Projects 👁 · จองคิวช่าง 👁',
  },
  {
    key: 'projectplan', title: 'Project Plan',
    id: CFG.SHEET_PROJECTS_ID || '1Fyr8sxgqjPPSFpteYzgvw5isffxmOH0sRroPyNPNl1s',
    used_by: 'Projects ✍️ · Job Card ✍️ (~20 แท็บ) · Purchase Request ✍️',
  },
  {
    key: 'contacts', title: 'Contacts',
    id: CFG.SHEET_CONTACTS_ID || '1oiN3wzd33fu4rwWlFZHm6a9fBzDI59sudFGqoBAY3mY',
    used_by: 'Contacts · จองคิวช่าง ✍️ (InstallationPlan ฯลฯ) · รีวิวช่าง ✍️',
  },
  {
    key: 'calprice', title: 'CalPrice_1',
    id: CFG.SHEET_CALPRICE_ID || '1r0sV6o_AzUQh5N4bSyEy-3Cdl8MionfmDAt1-FrEhP8',
    used_by: 'รายชื่อ Outsource',
  },
  {
    key: 'login', title: 'Login CRM',
    id: CFG.SHEET_LOGIN_ID || '10NgAH66TDVrDBKW5s8uugBeKUi3-UozeEN7iO1-61n4',
    used_by: 'CRM Hub ✍️ · ทุกแอปอ่าน User',
  },

  /* ── ไฟล์ที่ยังต้องแชร์ให้ service account ── */
  {
    key: 'techteam', title: 'รวมทีมช่าง Outsource',
    id: CFG.SHEET_TECHTEAM_ID || '1O7KXe5eiuPOBwDXbJw3E88kXx0gQ3ggc0vRnD28wwS4',
    used_by: 'Profile ช่างติดตั้ง ✍️ · จองคิวช่าง ✍️ · รีวิวช่าง ✍️',
    sensitive: true,     // มีเลขบัตรประชาชน + เลขบัญชีธนาคารของช่าง
  },
  {
    key: 'workflow', title: 'Work Flow',
    id: CFG.SHEET_WORKFLOW_ID || '1duIrB4lXCGMd8K4aVzGcZ58mnBO0IERuYhs83KoVUmg',
    used_by: 'รีวิวช่าง / WorkOrder 👁 (Planning_WorkOrders)',
  },
];

/* ─── แท็บที่ตั้งใจไม่ดึงเข้ากระจก ─────────────────────────────────
 *
 *  ไม่ใช่ทุกแท็บควรถูกก๊อปมา — บางอันเป็นของชั่วคราวของแอปเดิมล้วน ๆ
 *  ดึงมาก็ไม่มีใครใช้ แถมโตเร็วกว่าข้อมูลจริงเสียอีก */
const SKIP_TABS = [
  /^_?presence$/i,          // ใครออนไลน์อยู่ — ข้อมูลชั่วคราว
  /^onlinesessions$/i,
  /^onlineusers$/i,         // 20,175 แถวของ "ใครเปิดแอปอยู่" — ไม่มีคุณค่าย้อนหลัง
  /^chatpresence$/i,
  /^chatread(s|status)?$/i, // read receipt — โตเร็ว ไม่มีคุณค่าย้อนหลัง
  /syncqueue$/i,            // คิวงานที่รอทำ — ของชั่วคราวของแอปเดิมล้วน ๆ
  /^sheet\d*$/i,            // แท็บเปล่าที่ Google สร้างให้ตอนสร้างไฟล์
  /^ทดสอบ|^test|^temp|^สำรอง|^backup|^copy of/i,
];

const shouldSkip = tab => SKIP_TABS.some(re => re.test(String(tab || '').trim()));

/* ─── คอลัมน์อ่อนไหวที่ไม่เก็บลงกระจก ───────────────────────────────
 *
 *  ‼ ไฟล์ "รวมทีมช่าง Outsource" มีเลขบัตรประชาชนและเลขบัญชีธนาคาร
 *    ของช่างทุกคน รวมถึงภาพถ่ายบัตรประชาชน 4 ช่อง
 *
 *  ค่าตั้งต้นคือ "ไม่ก๊อปมา" เพราะการย้ายข้อมูลแบบนี้เข้าระบบใหม่
 *  ควรเป็นการตัดสินใจที่ตั้งใจ ไม่ใช่ผลข้างเคียงของการซิงค์อัตโนมัติ
 *
 *  แต่ก็ไม่ทำเงียบ ๆ — ชื่อคอลัมน์ที่ถูกตัดจะถูกจดไว้ในคอลัมน์ redacted
 *  ของทุกแถว เปิดดูได้ว่าตัดอะไรไปบ้าง
 *
 *  ถ้าวันหลังต้องใช้ (เช่น ทำใบเบิกจ่ายช่าง) ให้ยกขึ้นเป็นตารางแยก
 *  ที่จำกัดสิทธิ์เข้มกว่าตารางอื่น ไม่ใช่ปล่อยรวมอยู่ในกระจก */
const REDACT_PATTERNS = [
  /บัตรประชาชน|บัตร\s*ปชช|เลขประจำตัวประชาชน/i,
  /national\s*id|id\s*card|citizen\s*id/i,
  /เลขที่บัญชี|เลขบัญชี|บัญชีธนาคาร|เลขที่ บช/i,
  /bank\s*(account|acc)/i,
  /passport/i,
];

const isSensitiveColumn = name => REDACT_PATTERNS.some(re => re.test(String(name || '')));

const byKey = key => FILES.find(f => f.key === key);
const files = () => FILES.filter(f => f.id);

module.exports = { FILES, files, byKey, shouldSkip, isSensitiveColumn, SKIP_TABS };
