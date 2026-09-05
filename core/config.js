'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/config.js — ค่าตั้งค่าทั้งระบบ อ่านจาก environment variable
 *  ‼ ห้ามใส่รหัสหรือ key ลงในไฟล์นี้เด็ดขาด (บทเรียนจากแอป PR ที่ฝัง
 *    connectKey ของ PEAK ไว้ในโค้ด) — ทุกอย่างมาจาก Railway Variables
 * ═══════════════════════════════════════════════════════════════════ */
require('dotenv').config();

function need(key) {
  const v = process.env[key];
  if (!v) {
    throw new Error(
      `ยังไม่ได้ตั้งค่า ${key} — ใส่ใน Railway > Variables (หรือไฟล์ .env ตอนรันเครื่องตัวเอง)`
    );
  }
  return v;
}
function opt(key, dflt) {
  const v = process.env[key];
  return (v === undefined || v === '') ? dflt : v;
}

const CFG = {
  /* ── เซิร์ฟเวอร์ ── */
  PORT: Number(opt('PORT', 3000)),
  NODE_ENV: opt('NODE_ENV', 'production'),
  TZ: opt('TZ', 'Asia/Bangkok'),

  /* ── Supabase ── */
  //  SUPABASE_URL      = https://xxxx.supabase.co
  //  SUPABASE_KEY      = service_role key  ‼ ห้ามส่งออกฝั่งเบราว์เซอร์เด็ดขาด
  //  SUPABASE_SCHEMA   = ชื่อ schema (ค่าเริ่มต้น: app)
  get SUPABASE_URL()   { return need('SUPABASE_URL').replace(/\/+$/, ''); },
  get SUPABASE_KEY()   { return need('SUPABASE_KEY'); },
  SUPABASE_SCHEMA: opt('SUPABASE_SCHEMA', 'app'),

  /* ── ความปลอดภัย ── */
  //  SESSION_SECRET = สุ่มยาว ๆ 64 ตัวอักษรขึ้นไป (สร้างด้วย: openssl rand -hex 32)
  get SESSION_SECRET() { return need('SESSION_SECRET'); },
  //  อายุ session (ชั่วโมง) — ค่าเริ่มต้น 12 ชม. พอดีกับ 1 กะทำงาน
  SESSION_HOURS: Number(opt('SESSION_HOURS', 12)),
  //  อายุ SSO ticket ที่ Hub ออกให้ตอนกดเปิดโมดูล (วินาที) — สั้นมากโดยตั้งใจ
  SSO_TICKET_SECONDS: Number(opt('SSO_TICKET_SECONDS', 60)),
  COOKIE_NAME: opt('COOKIE_NAME', 'crmhub_sid'),
  //  ความยาวรหัสผ่านขั้นต่ำตอน "ตั้งใหม่" ผ่านหน้าเว็บ
  //  ตั้ง 4 ตามที่พี่เอเลือก — ของเดิมในชีตหลายคนใช้เลข 4 หลัก
  //  อยากเข้มขึ้นเมื่อไร เพิ่มตัวแปร MIN_PASSWORD ใน Railway ได้เลย ไม่ต้องแก้โค้ด
  MIN_PASSWORD: Math.max(1, Number(opt('MIN_PASSWORD', 4)) || 4),


  /* ── ซิงค์จาก Google Sheets (ทางเดียว: ชีต → ฐานข้อมูล) ──
   *  GOOGLE_SA_JSON = ไฟล์ JSON ของ service account ทั้งก้อน (หรือ base64 ของมัน)
   *  แชร์ชีตให้อีเมลของ service account แบบ "ผู้อ่าน" ก็พอ ไม่ต้องให้สิทธิ์แก้ไข
   *  ‼ ห้าม commit ค่านี้ขึ้น git — ใส่ที่ Railway > Variables เท่านั้น */
  GOOGLE_SA_JSON:  opt('GOOGLE_SA_JSON', ''),
  GOOGLE_SA_EMAIL: opt('GOOGLE_SA_EMAIL', ''),
  GOOGLE_SA_KEY:   opt('GOOGLE_SA_KEY', ''),

  //  ไฟล์ชีตต้นทาง (เอา ID จาก URL: docs.google.com/spreadsheets/d/<ID>/edit)
  SHEET_SALES_ID:      opt('SHEET_SALES_ID', ''),
  SHEET_SALES_TAB:     opt('SHEET_SALES_TAB', 'TotalSales'),
  SHEET_PROJECTS_ID:   opt('SHEET_PROJECTS_ID', ''),
  SHEET_PROJECTS_TAB:  opt('SHEET_PROJECTS_TAB', 'Projects'),
  SHEET_REQ_TAB:       opt('SHEET_REQ_TAB', 'Requirements'),
  SHEET_CONTACTS_ID:   opt('SHEET_CONTACTS_ID', ''),
  SHEET_CONTACTS_TAB:  opt('SHEET_CONTACTS_TAB', 'Contacts'),
  SHEET_CALPRICE_ID:   opt('SHEET_CALPRICE_ID', ''),
  SHEET_LOGIN_ID:      opt('SHEET_LOGIN_ID', ''),
  SHEET_LOGIN_TAB:     opt('SHEET_LOGIN_TAB', 'User'),

  //  ซิงค์ทุกกี่นาที (0 = ปิดการซิงค์อัตโนมัติ สั่งเองผ่านหน้าเว็บได้อยู่)
  SYNC_EVERY_MIN: Math.max(0, Number(opt('SYNC_EVERY_MIN', 10)) || 0),

  /* กระจกของแท็บที่เหลือ — ต้องแยกจังหวะจากตารางจริง
   *
   * ‼ ของจริงที่สำรวจเจอ (4 ก.ย. 69): 181 แท็บ · ใหญ่สุด ProductionLogs 72,934 แถว
   *   รวมกันหลายแสนแถว — ถ้าดึงทุก 10 นาทีเหมือนตารางจริงจะไม่มีทางจบสักรอบ
   *   ชนโควตา Google และทำให้ตารางจริงที่คนใช้งานอยู่พลอยช้าไปด้วย
   *
   * 0 = ไม่ดึงอัตโนมัติ กดเอาเองเมื่อต้องการ (ค่าเริ่มต้น — ปลอดภัยที่สุด) */
  SYNC_MIRROR_EVERY_MIN: Math.max(0, Number(opt('SYNC_MIRROR_EVERY_MIN', 0)) || 0),

  /* ── ไฟล์แนบ ── */
  //  STORAGE_DRIVER = supabase | drive | none
  STORAGE_DRIVER: opt('STORAGE_DRIVER', 'supabase'),
  STORAGE_BUCKET: opt('STORAGE_BUCKET', 'crm-files'),

  /* ── ตัวเชื่อมภายนอก (ใส่เมื่อจะเปิดใช้) ── */
  PEAK_ENV: opt('PEAK_ENV', 'UAT'),
  ANTHROPIC_API_KEY: opt('ANTHROPIC_API_KEY', ''),

  /* ── โหมดบำรุงรักษา ── */
  //  ตั้ง MAINTENANCE=1 เพื่อปิดระบบชั่วคราว (เหลือแต่ admin เข้าได้)
  MAINTENANCE: opt('MAINTENANCE', '') === '1',
};

/** ตรวจว่าตัวแปรจำเป็นครบไหม — เรียกตอนเปิดเซิร์ฟเวอร์ */
function assertReady() {
  const missing = [];
  for (const k of ['SUPABASE_URL', 'SUPABASE_KEY', 'SESSION_SECRET']) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length) {
    console.error('\n❌ เปิดระบบไม่ได้ — ยังไม่ได้ตั้งค่า:\n');
    for (const k of missing) console.error('   · ' + k);
    console.error('\nดูวิธีตั้งค่าในไฟล์ SETUP.md\n');
    process.exit(1);
  }
  if (process.env.SESSION_SECRET.length < 32) {
    console.error('\n❌ SESSION_SECRET สั้นเกินไป — ต้องยาวอย่างน้อย 32 ตัวอักษร');
    console.error('   สร้างใหม่ด้วยคำสั่ง:  openssl rand -hex 32\n');
    process.exit(1);
  }
}

module.exports = { CFG, assertReady };
