'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  Projects Management — ตัวช่วยพื้นฐาน (ยกจาก Code.gs ของแอปเดิม)
 *
 *  ‼ พี่เอสั่ง 8 ก.ย. 69:
 *    "copy code เดิม 100% ... เอาให้ครบทุกบรรทัดนะ อย่าคิดเอง อย่าข้าม
 *     อย่าเพิ่มอะไรตอนที่สร้าง app"
 *
 *  ทุกฟังก์ชันในไฟล์นี้จดเลขบรรทัดของต้นฉบับไว้ ตรวจย้อนได้ทีละตัว
 *  ต้นฉบับ: _source/projects/Code.gs (2,772 บรรทัด)
 *
 *  ‼ เขตเวลา: ของเดิมรันบน Apps Script ที่ตั้งโซน Asia/Bangkok
 *    ฟังก์ชันวันที่ทุกตัวในไฟล์นี้จึงต้องคิดตาม "เวลาไทย" เสมอ
 *    ห้ามใช้ getFullYear/getMonth/getDate ดิบ ๆ (= โซนของเครื่องที่รัน)
 *    ที่เดียวของทั้งระบบคือ core/thai-date.js
 * ═══════════════════════════════════════════════════════════════════ */
const { partsTH } = require('../../core/thai-date');

/* ═══ dateParts_ — อ่าน "วัน" ออกจากค่าที่เป็น Date ให้ได้วันเดียวกันทุกโซน ═══
 *
 *  พี่เอสั่ง 8 ก.ย. 69: "อย่าลืม เช็ค Date time , Time zone ให้ถูกต้องด้วยนะ"
 *
 *  ปัญหา: ค่าวันที่เดินทางมาถึงเราได้ 3 หน้าตา และแต่ละหน้าตาต้องอ่านคนละวิธี
 *    1) Date ที่เป็นเที่ยงคืน UTC        ← โค้ดเราสร้างเองด้วย Date.UTC()
 *    2) Date ที่เป็นเที่ยงคืนตามโซนเครื่อง ← ไลบรารี pg แปลงคอลัมน์ date ให้แบบนี้
 *    3) จุดเวลาจริง (มีชั่วโมง/นาที)     ← new Date() ตอนกดบันทึก
 *
 *  ‼ 1 กับ 2 คือ "วันที่ล้วน ๆ ไม่มีเวลา" — ต้องอ่านตามโซนที่มันถูกสร้าง
 *    ส่วน 3 เป็นจุดเวลาจริง — ต้องอ่านเป็น "วันตามเวลาไทย" เพราะของเดิม
 *    รันบน Apps Script ที่ตั้งโซน Asia/Bangkok (Railway ตั้งเป็น UTC)
 *
 *  ถ้าอ่านผิดจะเพี้ยนไป 1 วันแบบเงียบ ๆ และวัน Complete คือด่านที่ 2
 *  ของ 3 กล่องขวาพอดี ⇒ ต้นเดือนงานจะไปนับอยู่ในเดือนก่อน
 *  มีเทสต์คุมไว้ที่ tools/test-pj-tz.js (รันจริง 5 โซนเวลา) */
/* 🔴 พี่เอสั่ง 12 ก.ย. 69: "เช็ค วันเวลา Time zone ต้องเป็นของประเทศไทยเท่านั้น
 *    อย่ามั่วไป time zone อื่น"
 *
 *  ของเดิมมีทางออก 3 ทาง และทางที่ 2 "คืนค่าดิบจาก getFullYear/getMonth/getDate"
 *  = วันตามโซนของเครื่องที่รัน ตรง ๆ ⇒ ถ้าวันหนึ่งย้ายเซิร์ฟเวอร์ไปโซนอื่น
 *  ค่าที่คืนจะเพี้ยนเงียบ ๆ โดยไม่มีใครรู้ (ระเบิดเวลา)
 *
 *  ตอนนี้เหลือ 2 ทางเท่านั้น และไม่มีทางไหนคืน "วันตามโซนเครื่อง" อีกแล้ว:
 *    ① ค่าที่เป็น "วันล้วน ๆ ไม่มีเวลา" (เที่ยงคืนพอดี) — เลื่อนให้เป็น
 *       เที่ยงคืน UTC ของวันเดียวกันก่อน แล้วอ่านด้วย getUTC* เสมอ
 *    ② จุดเวลาจริง (มีชั่วโมง/นาที) — อ่านเป็น "วันตามเวลาไทย" ผ่าน partsTH
 *
 *  ‼ ทำไมไม่ลบทางที่ ① ครึ่งหลังทิ้งไปเลย: tools/test-pj-tz.js ข้อ ④ กรณี c
 *    บังคับไว้ว่า Date ที่เป็น "เที่ยงคืนตามโซนเครื่อง" (หน้าตาที่ pg คืนมา
 *    ถ้าไม่ได้ตั้ง type parser) ต้องอ่านได้วันเดิมทุกโซน รวม Sydney/Kiritimati
 *    ที่เร็วกว่าไทย — ถ้าโยนเข้า partsTH ตรง ๆ จะได้ "เมื่อวาน" ทันที
 *    ⇒ ต้องแปลงหน้ากากโซนก่อน ห้ามลบขั้นตอนนี้ */
function dateParts_(d) {
  const isUTCMidnight   = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
  const isLocalMidnight = d.getHours()    === 0 && d.getMinutes()    === 0 && d.getSeconds()    === 0; // tz:ok
  /* เที่ยงคืนตามโซนเครื่อง → บวก offset ของเครื่องกลับเข้าไป = เที่ยงคืน UTC ของวันเดียวกัน
     (เลขที่ใช้คือ offset ของเครื่องเอง ไม่ได้เดาโซนใด ๆ ทั้งสิ้น) */
  const u = isUTCMidnight ? d
          : isLocalMidnight ? new Date(d.getTime() - d.getTimezoneOffset() * 60000) // tz:ok
          : null;
  if (u) return { y: u.getUTCFullYear(), mo: u.getUTCMonth(), da: u.getUTCDate() };
  const t = partsTH(d);
  return { y: +t.y, mo: +t.m - 1, da: +t.d };
}

/* ═══ CONFIG (Code.gs:13–62) ═══
 *  ‼ ยกมาทั้งชุด รวมค่าที่ระบบใหม่ไม่ได้ใช้แล้ว (SSID ของชีต) — เก็บไว้ให้
 *    อ่านแล้วรู้ว่าของเดิมชี้ไปไฟล์ไหน เวลาไล่ปัญหาย้อนหลังจะได้ไม่ต้องเดา */
const CONFIG = {
  /* ── ที่อยู่ชีตเดิม (ระบบใหม่ไม่เปิดอ่าน/เขียน — ไว้อ้างอิงเฉย ๆ) ── */
  PROJECTS_SSID:  '1Fyr8sxgqjPPSFpteYzgvw5isffxmOH0sRroPyNPNl1s', // Project Plan
  USER_SSID:      '10NgAH66TDVrDBKW5s8uugBeKUi3-UozeEN7iO1-61n4', // Login CRM
  CONTACTS_SSID:  '1oiN3wzd33fu4rwWlFZHm6a9fBzDI59sudFGqoBAY3mY', // Contacts
  CHANNEL_SSID:   '1jWTrSzwMKwj78xVA9gMj3cxizFxs18Pr-q0MJ8CjQ_M', // Sales Report Tracking
  OUTSOURCE_SSID: '1r0sV6o_AzUQh5N4bSyEy-3Cdl8MionfmDAt1-FrEhP8', // CalPrice_1

  SHEET_PROJECTS: 'Projects',
  SHEET_REQUIREMENTS: 'Requirements',
  SHEET_USER: 'User',
  SHEET_CONTACTS: 'Contacts',
  SHEET_CHANNEL: 'Channel',
  SHEET_OUTSOURCE: 'รายชื่อ Outsource',

  DRIVE_UPLOAD_FOLDER: 'ProjectsManagement_Uploads',
  USER_IMAGE_FOLDER: 'User_Images',
  SALES_LIKE_PERMISSIONS: ['graphic สาขา'],
  FORCE_FINISH_USERS: ['admin', 'namna', 'suntorn'],
  FORCE_FINISH_COL: 'ปิดงานย้อนหลัง',
  GRAPHIC_PERMISSION: 'Graphic',
  APP_TAG: 'ProjectsMgmt',
  RECENT_LIMIT: 25,
  INDEX_ROWS_LIMIT: 1200,
  REQ_ROWS_LIMIT: 3000,
  FRESH_COOLDOWN_SEC: 60,
  DASH_BACK_DAYS: 45,
  CLAUDE_MODEL: 'claude-sonnet-5',
  ACCOUNT_CHECK_COLS: ['วันที่ confirm ตรวจสอบการรับเงิน', 'ผู้ยืนยันรับเงิน'],
  ACCOUNT_RESULT_COL: ['ได้รับเงินแล้ว / ลูกค้าเครดิต', 'ได้รับเงินแล้ว', 'ได้รับเงินแล้ว/ลูกค้าเครดิต'],
  ACCOUNT_RESULT_OK: 'ได้รับเงินแล้ว',
  JOBORDER_COL: 'Status JobOrder',
  JOBORDER_DONE: 'เข้าแผนผลิตแล้ว',
  JOBDONE_MODE: 'any',
  ACCDONE_MODE: 'any',
  REQ_ACC_RESULT_COL: ['ได้รับเงินแล้ว / ลูกค้าเครดิต', 'ได้รับเงินแล้ว', 'acc_result'],
  REQ_ACC_DATE_COL: ['วันที่ confirm ตรวจสอบการรับเงิน', 'วันที่ confirm', 'acc_date'],
  REQ_ACC_BY_COL: ['ผู้ยืนยันรับเงิน', 'ผู้ยืนยัน', 'acc_by'],
  REQ_JOBORDER_COL: 'Status JobOrder',
  LOGO_URL: '',
};

/* ═══ ชื่อคอลัมน์จริงในฐานข้อมูล ═══
 *  ‼ PostgreSQL ตัดชื่อคอลัมน์ที่ยาวเกิน 63 ไบต์ (ไทยตัวละ 3 ไบต์)
 *    หัวชีต 2 ช่องนี้จึงถูกตั้งชื่อสั้นไว้ตั้งแต่ sql/04-projects.sql
 *    ต้องแปลงตรงนี้ที่เดียว ไม่งั้นอ่าน/เขียนไม่เจอแล้วเงียบ */
const DB_COL = {
  'ได้รับเงินแล้ว / ลูกค้าเครดิต': 'acc_result',
  'ได้รับเงินแล้ว': 'acc_result',
  'ได้รับเงินแล้ว/ลูกค้าเครดิต': 'acc_result',
  'วันที่ confirm ตรวจสอบการรับเงิน': 'acc_confirm_date',
  'วันที่ confirm': 'acc_confirm_date',
};
const dbCol = name => DB_COL[name] || name;

/* ═══ ตัวเลือก dropdown (ENUMS Code.gs:65–80) — ยกมาทั้งชุด ห้ามแก้ลำดับ ═══ */
const ENUMS = {
  workGroups: ['กลุ่มงานพิมพ์', 'กลุ่มงานป้าย'],
  jobTypes: [
    'เริ่มออกแบบใหม่', 'ติดตั้งใหม่', 'งานสาขามดงานการป้าย',
    'งานเคลม(ผลิต) = เสียจากผลิต', 'งานเคลม(ติดตั้ง) = เสียจากติดตั้ง',
    'งานเคลม(กราฟิค-ขาย) = เสียจากกราฟิก/ขาย',   /* v1.6.1 พี่เอ 7 พ.ย. 69 — เคลมจากกราฟิค/ฝ่ายขาย (ค่าตรงกับ Job Card CLAIM_GS_JOB_TYPE) */
    'งานส่งเสริมการขาย', 'ลูกค้าขอแก้ไข = ลูกค้าจ่ายเพิ่ม',
    'ซ่อมบำรุง = ลูกค้าจ่ายจากแจ้งซ่อมที่หมดประกัน',
    'เช็คหน้างาน = ดูหน้างาน/วางไกด์', 'ติดตั้งใหม่ รอบ 2 (ไม่เสร็จ)', 'รื้อถอนอย่างเดียว', 'งานส่งออกนอก',
    'วาง scale ตัวอักษร',
  ],
  deliveryTypes: ['จัดส่ง', 'ติดตั้ง', 'มารับเองที่สาขา', 'มารับเองที่โรงงาน', 'จัดส่งให้ช่างติดตั้ง'],
  statuses: ['Not Started', 'Meeting กระดุมเม็ดแรก', 'งานด่วน', 'In Progress', 'จองคิวติดตั้งก่อน Complete', 'Complete'],
  reqJobTypes: ['งานกราฟิก', 'ป้ายไฟออกหน้า', 'ป้ายไฟออกหลัง', 'ป้ายไม่มีไฟ', 'ป้ายรายละเอียดพิเศษ', 'neon-flex', 'เช็คพื้นที่ / วางไกด์', 'วาง scale ตัวอักษร'],
  reqStatuses: ['Not started', 'In Progress', 'จองคิวติดตั้งก่อน Complete', 'Complete', 'เข้าแผนผลิตแล้ว'],
  jobOrderStatuses: ['เข้าแผนผลิตแล้ว'],
};

/** ช่องรูปทั้ง 9 ช่อง (Index.html:739 IMG_FIELDS · Code.gs:1216) — ลำดับต้องตรงกับหน้าเว็บ */
const IMG_FIELDS = ['ภาพ CheckList 1', 'ภาพ CheckList 2', 'ภาพ CheckList 3',
  'ภาพหน้างาน 1', 'ภาพหน้างาน 2', 'ภาพหน้างาน 3', 'Image', 'Image In Progress', 'Image Complete'];

/** username ที่แก้ไขรายชื่อ Outsource ได้ (OUTSOURCE_EDITORS Code.gs:904) */
const OUTSOURCE_EDITORS = { admin: 1, namna: 1 };

/** ผู้ดูแลระบบเสมอ นอกเหนือจาก Permission = Administrator (ADMIN_USERS Code.gs:2249) */
const ADMIN_USERS = { suntorn: 1 };

/** รายชื่อพนักงานขายที่ต้องขึ้นในตัวกรองเสมอ (EXTRA_SALES Code.gs:1603) */
const EXTRA_SALES = ['(กุ๊งกิ๊ง) กุลกานต์ จึงวงศ์ไพบูลย์'];

/* ═══ nrm_ (Code.gs:254) — ตัดช่องว่างซ้ำ + อักขระล่องหน ═══ */
const nrm_ = s => String(s == null ? '' : s)
  .replace(/[ ​-‍﻿]/g, ' ').replace(/\s+/g, ' ').trim();

/* ═══ validName_ (Code.gs:257) — เป็นชื่อคนจริงไหม (กรอง path รูป / id 8 หลัก) ═══ */
function validName_(s) {
  s = String(s || '').trim();
  if (!s) return false;
  if (s.indexOf('/') >= 0) return false;        // เช่น Projects_Images/...
  if (/^[0-9a-fA-F]{8}$/.test(s)) return false; // id
  if (s.length > 50) return false;
  return true;
}

/* ═══ findCol_ (Code.gs:241) — หาชื่อคีย์จากชื่อที่เป็นไปได้หลายแบบ ═══
 *  ของเดิมหา index ของคอลัมน์ในชีต · ที่นี่หา "ชื่อคีย์ที่มีอยู่จริงในแถว" */
function findKey_(row, names) {
  const list = Array.isArray(names) ? names : [names];
  for (const n of list) {
    if (row[n] !== undefined) return n;
    const c = dbCol(n);
    if (row[c] !== undefined) return c;
  }
  const keys = Object.keys(row || {});
  for (const n of list) {
    const want = nrm_(n);
    for (const k of keys) {
      const h = nrm_(k);
      if (h === want || h.indexOf(want) === 0 || want.indexOf(h) === 0) return k;
    }
  }
  return undefined;
}
/** อ่านค่าจากแถว โดยลองชื่อคอลัมน์หลายแบบ (คู่กับ findKey_) */
function pick_(row, names) {
  const k = findKey_(row || {}, names);
  return k === undefined ? '' : row[k];
}

/* ═══ toGregMs_ (Code.gs:267) ═══
 *  ของเดิม: ชีตเก็บ Date ที่ปีเป็น พ.ศ. (2569) จึงต้องลบ 543 ตอนอ่าน
 *  ที่นี่ : คอลัมน์เป็นชนิด date ของ PostgreSQL ซึ่งเป็น ค.ศ. อยู่แล้ว
 *          ‼ ยังเหลือกฎ "ปี >= 2400 คือ พ.ศ." ไว้ เพราะข้อมูลที่ซิงก์มา
 *            จากชีตบางแถวอาจติดปี พ.ศ. มาด้วย — ถอดออกเมื่อไหร่วันจะเพี้ยน
 *            ไป 543 ปีแบบเงียบ ๆ
 *
 *  🔴 เขตเวลา (พี่เอสั่ง 8 ก.ย. 69: "อย่าลืมเช็ค Date time, Time zone")
 *     ของเดิมรันบน Apps Script ที่ตั้งโซนเป็น Asia/Bangkok ⇒ `getMonth()`
 *     ของมันคือ "วันตามเวลาไทย" ส่วนเซิร์ฟเวอร์ Railway ตั้งเป็น UTC
 *     ⇒ ต้องอ่านชิ้นส่วนวันตามเวลาไทยเสมอ ถึงจะได้ผลเท่าของเดิมทุกโซน
 *     ‼ อ่านแบบเวลาไทยยังปลอดภัยกับ Date ทั้งสองแหล่ง:
 *        · PostgREST ของจริงคืน 'YYYY-MM-DD' (สตริง) → เข้าทางล่าง
 *        · pg ในเทสต์คืน Date ที่เป็นเที่ยงคืน "ตามโซนเครื่อง"
 *        · โค้ดเราเองสร้างด้วย Date.UTC() = เที่ยงคืน UTC
 *        ทั้งสามแบบ +7 ชม. แล้วยังตกอยู่ในวันเดียวกันเสมอ */
function toGregMs_(v) {
  if (v === null || v === undefined || v === '') return 0;
  let y, mo, da;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return 0;
    const t = dateParts_(v);
    y = t.y; mo = t.mo; da = t.da;
  } else {
    const m = String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return 0;
    y = +m[1]; mo = +m[2] - 1; da = +m[3];
  }
  if (y >= 2400) y -= 543;
  return Date.UTC(y, mo, da);
}

/* ═══ dispBE_ (Code.gs:275) — แสดงวันที่เป็น พ.ศ. เสมอ (dd/MM/yyyy) ═══ */
function dispBE_(ms) {
  if (!ms) return '';
  /* ‼ ของเดิมจัดรูปแบบด้วย Utilities.formatDate(..., 'Asia/Bangkok', ...)
   *   คือ "วันตามเวลาไทย" เสมอ
   *   ปกติ ms ที่ส่งมาคือเที่ยงคืน UTC จาก toGregMs_ (อ่านคอลัมน์ date)
   *   แต่ถ้าวันไหนมีคนส่ง "จุดเวลาจริง" เข้ามา ต้องแสดงวันไทย ไม่ใช่วัน UTC
   *   ⇒ ใช้ dateParts_ ตัวเดียวกับ toBE_/toGregMs_ (กฎเดียวทั้งไฟล์) */
  const t = dateParts_(new Date(ms));
  const dd = String(t.da).padStart(2, '0');
  const mm = String(t.mo + 1).padStart(2, '0');
  return dd + '/' + mm + '/' + (t.y + 543);
}

/* ═══ toBE_ (Code.gs:286) — ตรวจ + แปลงวันที่ก่อนบันทึก ═══
 *  ‼ เก็บทุกด่านตรวจของเดิมไว้ครบ (รูปแบบ · ช่วงวัน/เดือน · วันจริง)
 *    ต่างกันจุดเดียวและตั้งใจ: ของเดิมบวก 543 เพราะชีตเก็บ พ.ศ.
 *    ที่นี่คอลัมน์เป็น date ของจริง จึงเก็บ ค.ศ. ถ้าบวก 543 ตามของเดิม
 *    ทุกวันในระบบใหม่จะกลายเป็นปี 2569 → กรองช่วงเวลาพังทั้งหน้า
 *  คืน '' เมื่อว่าง/รูปแบบผิด/วันไม่มีจริง (เหมือนเดิมเป๊ะ) */
function toBE_(v) {
  if (v === '' || v === null || v === undefined) return '';
  let y, mo, da; // mo = 0-based

  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    /* 🔴 เดิมใช้ getFullYear/getMonth/getDate = โซนของเครื่องที่รัน
     *    Apps Script ตั้งโซนไทยอยู่แล้ว แต่ Railway เป็น UTC
     *    ⇒ งานที่กด Complete ตอนตี 1 ของบ้านเรา จะถูกบันทึกเป็น "เมื่อวาน"
     *      แล้วตกกล่องขวาไปอยู่คนละเดือนแบบเงียบ ๆ
     *    อ่านตามเวลาไทยเสมอ = ได้ผลเท่าของเดิม ไม่ว่าเซิร์ฟเวอร์ตั้งโซนอะไร */
    const t = dateParts_(v);
    y = t.y; mo = t.mo; da = t.da;
  } else {
    const s = String(v).trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {            // ISO: YYYY-MM-DD
      y = +m[1]; mo = +m[2] - 1; da = +m[3];
    } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) {   // ไทย: DD/MM/YYYY
      da = +m[1]; mo = +m[2] - 1; y = +m[3];
    } else {
      const d = new Date(s);                                        // เผื่อรูปแบบอื่น
      if (isNaN(d.getTime())) return '';
      const t = dateParts_(d);                                      // อ่านด้วยกฎเดียวกัน
      y = t.y; mo = t.mo; da = t.da;
    }
  }

  // ตรวจช่วงวัน/เดือน (เหมือนเดิม)
  if (!(mo >= 0 && mo <= 11) || !(da >= 1 && da <= 31)) return '';

  /* ‼ ตั้งแต่บรรทัดนี้ถึงบรรทัดสุดท้าย ทำ "บนปี พ.ศ." เหมือนของเดิมทุกขั้น
   *   แล้วค่อยลบ 543 ตอนคืนค่า เพราะฐานข้อมูลเก็บ ค.ศ.
   *
   *   ทำไมไม่ตรวจบนปี ค.ศ. ตรง ๆ ให้ง่ายกว่า — เพราะผลไม่เท่ากัน:
   *   🐞 29 ก.พ. 2024 (ปีอธิกสุรทินจริง) → +543 = 2567 ซึ่งไม่ใช่ปีอธิกสุรทิน
   *      ของเดิมจึงปฏิเสธวันนี้ทิ้ง ทั้งที่เป็นวันที่มีอยู่จริง
   *      นี่คือ "บั๊กของแอปเดิม" ที่ยกมาด้วยตามคำสั่งพี่เอ 8 ก.ย. 69:
   *        "ห้ามเปลี่ยนอะไรทั้งสิ้น ... ให้เขียนตาม code เดิม 100%"
   *      ‼ ถ้าวันหน้าพี่เอสั่งให้แก้ ให้ย้ายการตรวจไปทำบนปี ค.ศ. แทน
   *        (ตรวจกับ y-543 แล้วเทียบ) — จุดแก้อยู่ตรงนี้จุดเดียว
   *      มีเทสต์คุมไว้ที่ tools/test-pj-same.js ข้อ ⑨ */
  if (y >= 1900 && y < 2400) y += 543;
  if (y < 2500 || y > 2700) return '';

  // ตรวจว่าวันมีจริง (31/2 ต้องถูกปฏิเสธ ไม่ใช่ปัดเป็น 3/3)
  const d = new Date(Date.UTC(y, mo, da, 0, 0, 0));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo || d.getUTCDate() !== da) return '';
  /* ของเดิมคืน Date ปี พ.ศ. ลงชีต · ที่นี่คืน 'YYYY-MM-DD' ปี ค.ศ. ลงคอลัมน์ date */
  return new Date(Date.UTC(y - 543, mo, da)).toISOString().slice(0, 10);
}

/* ═══ fmtIso_ (Code.gs:1340) — ค่าในฐานข้อมูล → 'YYYY-MM-DD' ให้ <input type=date> ═══ */
function fmtIso_(v) {
  const ms = toGregMs_(v);
  if (!ms) return '';
  /* tz:ok — ms มาจาก toGregMs_() ซึ่งคืน Date.UTC(y,mo,da) = เที่ยงคืน UTC ตรึงไว้แล้ว
     ⇒ toISOString() อ่านกลับได้วันเดิมเป๊ะทุกโซนเครื่อง ไม่ใช่การ "ตัดวันจาก UTC" */
  return new Date(ms).toISOString().slice(0, 10);
}

/* ═══ genId8_ (Code.gs:322) — id 8 ตัว hex ตัวแรกเป็นตัวอักษรเสมอ ═══
 *  ‼ ตัวแรกเป็นตัวอักษร เพื่อไม่ให้ชีตเดิมแปลง ID เป็นตัวเลข
 *    ระบบใหม่ไม่มีปัญหานี้ แต่ต้องคงรูปแบบไว้ ไม่งั้น ID ใหม่จะหน้าตา
 *    ไม่เหมือนของเดิม แล้วแอปผลิต/จองคิวที่จับคู่ด้วย ID จะงง */
function genId8_() {
  const hex = '0123456789abcdef', letters = 'abcdef';
  let s = letters.charAt(Math.floor(Math.random() * 6));
  for (let i = 1; i < 8; i++) s += hex.charAt(Math.floor(Math.random() * 16));
  return s;
}

/* ═══ isSalesLikePerm_ (Code.gs:349) ═══ */
function isSalesLikePerm_(perm) {
  const p = String(perm || '').toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!p) return false;
  if (p === 'sale' || p === 'sales' || p.indexOf('sale support') >= 0 || p.indexOf('sales support') >= 0) return true;
  if (p.indexOf('admin') >= 0) return true;
  const extra = CONFIG.SALES_LIKE_PERMISSIONS || [];
  for (let i = 0; i < extra.length; i++) { if (p.indexOf(String(extra[i]).toLowerCase()) >= 0) return true; }
  return false;
}

/* ═══ nameTokens_ (Code.gs:2251) — ตัดวงเล็บออกเพื่อเทียบชื่อคน ═══ */
function nameTokens_(v) {
  const s = nrm_(v).toLowerCase();
  const out = [];
  const inParen = s.match(/\(([^)]+)\)/g) || [];
  inParen.forEach(p => out.push(p.replace(/[()]/g, '').replace(/\s+/g, '')));
  out.push(s.replace(/\([^)]*\)/g, '').replace(/\s+/g, ''));
  out.push(s.replace(/\s+/g, ''));
  return out.filter(x => x && x.length >= 2);
}

/* ═══ wgOf_ (Code.gs:2282) — กลุ่มงานของงานย่อย ═══ */
function wgOf_(reqGroup, projectGroup) {
  const v = nrm_(reqGroup) || nrm_(projectGroup) || '';
  if (v.indexOf('พิมพ์') >= 0) return 'กลุ่มงานพิมพ์';
  if (v.indexOf('ป้าย') >= 0) return 'กลุ่มงานป้าย';
  return '';
}

/* ═══ countGroups_ (Code.gs:2289) — นับงานย่อยแยกกลุ่ม ═══ */
function countGroups_(reqs, projectGroup) {
  const c = { print: 0, sign: 0 };
  (reqs || []).forEach(req => {
    if (!req || (!req.requirement_name && !req.job_type)) return;
    const g = wgOf_(req.work_group, projectGroup);
    if (g === 'กลุ่มงานพิมพ์') c.print++; else if (g === 'กลุ่มงานป้าย') c.sign++;
  });
  return c;
}

/* ═══ jobDone_ (Code.gs:1915) ═══ */
const jobDone_ = v => nrm_(v) === (CONFIG.JOBORDER_DONE || 'เข้าแผนผลิตแล้ว');

/* ═══ _boxOf_ (Code.gs:1916) — งานอยู่กล่องไหนบน Dashboard ═══
 *  ‼ ลำดับ if ห้ามสลับ — 'Complete' ต้องตรวจหลังสถานะอื่นทั้งหมด */
function _boxOf_(statusRaw, completeInPeriod, accOk, jobDone, forceDone) {
  const st = String(statusRaw || '').toLowerCase();
  if (st === 'not started') return 'notstarted';
  if (statusRaw === 'งานด่วน') return 'urgent';
  if (statusRaw === 'Meeting กระดุมเม็ดแรก') return 'meeting';
  if (st === 'in progress') return 'inprogress';
  if (statusRaw === 'จองคิวติดตั้งก่อน Complete') return 'installqueue';
  if (st === 'complete' && completeInPeriod) {
    if (forceDone) return 'complete';          // กดปุ่ม "จบงาน" ปิดย้อนหลังไว้
    if (jobDone) return 'complete';            // เข้าแผนผลิตแล้ว = จบงาน
    if (accOk) return 'accounted';             // บัญชีตรวจแล้ว รอเปิดใบสั่งผลิต
    return 'waitacc';                          // ยังไม่ตรวจ + ยังไม่ลงแผนผลิต
  }
  return '';
}

/* ═══ _periodRange_ (Code.gs:1892) — ช่วงเวลาสำเร็จรูปของ Dashboard ═══
 *  ‼ คิดตามเวลาไทย ไม่ใช่ UTC — ไม่งั้นตั้งแต่เที่ยงคืนถึง 7 โมงเช้า
 *    "วันนี้" จะกลายเป็นเมื่อวาน (บทเรียน core/thai-date.js) */
function _periodRange_(period, todayStr) {
  const [Y, M, D] = String(todayStr).split('-').map(Number);
  const y = Y, mo = M - 1, da = D;
  const t = (yy, mm, dd, hh, mi, ss) => Date.UTC(yy, mm, dd, hh || 0, mi || 0, ss || 0);
  switch (period) {
    case 'today':     return [t(y, mo, da), t(y, mo, da, 23, 59, 59)];
    case '7d':        return [t(y, mo, da - 6), t(y, mo, da, 23, 59, 59)];
    case 'lastmonth': return [t(y, mo - 1, 1), t(y, mo, 0, 23, 59, 59)];
    case '3m':        return [t(y, mo - 2, 1), t(y, mo + 1, 0, 23, 59, 59)];
    case '6m':        return [t(y, mo - 5, 1), t(y, mo + 1, 0, 23, 59, 59)];
    case 'lastyear':  return [t(y - 1, 0, 1), t(y - 1, 11, 31, 23, 59, 59)];
    case 'year':      return [t(y, 0, 1), t(y, 11, 31, 23, 59, 59)];
    case 'all':       return [0, 0];
    default:          return [t(y, mo, 1), t(y, mo + 1, 0, 23, 59, 59)]; // month
  }
}

/** วันที่ (ms) → 'YYYY-MM-DD' (ใช้เทียบวันแบบเดียวกับของเดิม)
 *  tz:ok — ms ที่ส่งมาคือค่าจาก _periodRange_/toGregMs_ ซึ่งปั้นด้วย Date.UTC() ทั้งหมด
 *  ⇒ เป็นเที่ยงคืน UTC ตรึงไว้ ไม่ใช่จุดเวลาจริง จึงไม่มีทางเลื่อนวันตามโซนเครื่อง */
const dstr_ = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : '');

module.exports = {
  CONFIG, ENUMS, IMG_FIELDS, OUTSOURCE_EDITORS, ADMIN_USERS, EXTRA_SALES,
  DB_COL, dbCol, nrm_, validName_, findKey_, pick_,
  toGregMs_, dispBE_, toBE_, fmtIso_, genId8_,
  isSalesLikePerm_, nameTokens_, wgOf_, countGroups_,
  jobDone_, _boxOf_, _periodRange_, dstr_,
};
