'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  📊 modules/users/export-sheet.js — ส่งออกรายชื่อผู้ใช้เป็น Google Sheet (รอบ 234 · 4 ต.ค. 69)
 *
 *  พี่เอ (คำต่อคำ · หน้า "จัดการผู้ใช้"): "สร้างปุ่ม export เป็น google sheet ให้ด้วยนะ"
 *
 *  ── ทำงานอย่างไร (ทางเดียวกับ "ส่งออก Google Sheet" ของแอปคลัง ที่ใช้งานจริงอยู่แล้ว) ──
 *   อ่านผู้ใช้จากฐานข้อมูลของเรา (Supabase) → ทำเป็นตาราง → ส่งขึ้น Google Drive เป็น CSV
 *   โดยขอให้ Google แปลงเป็น Google Sheets (1 คำขอ) → คืนลิงก์เปิดชีต
 *   ‼ สร้าง "ไฟล์ใหม่ทุกครั้ง" ในโฟลเดอร์ "Export-จัดการผู้ใช้" — ไม่ทับไฟล์เดิม ไม่ลบอะไร
 *   ‼ ไม่แตะไฟล์ชีตเดิมของระบบ (Login CRM) · ขาเขียน Drive มีที่เดียวคือ core/drive-write.js
 *
 *  🔒 ความเป็นส่วนตัว (รายชื่อพนักงาน = ข้อมูลบุคคล)
 *   ① ไม่มีรหัสผ่าน / แฮชรหัสผ่าน ในไฟล์เด็ดขาด — บอกแค่ "ตั้งแล้ว / ยังไม่มี"
 *   ② ไฟล์ที่สร้าง **ไม่ถูกแชร์แบบ "ใครมีลิงก์ก็เปิดได้" เอง** — เปิดได้เฉพาะบัญชี Google ที่เข้าโฟลเดอร์ Drive
 *      ของบริษัทได้อยู่แล้ว · จะเปิดให้คนมีลิงก์ดูได้ ต้องกดปุ่มแยกอีกครั้ง (ดูอย่างเดียว) และถูกจดในบันทึกการใช้งาน
 *      (ต่างจากไฟล์รายงานของแอปคลังที่แชร์แบบแก้ไขได้ทันที — ที่นั่นเป็นยอดสต็อก ที่นี่เป็นข้อมูลคน)
 *   ③ ปุ่มแชร์ใช้ได้เฉพาะ "ไฟล์ที่ส่งออกจากหน้านี้ในรอบการทำงานนี้" — ส่งไอดีไฟล์อื่นมาให้แชร์ไม่ได้
 *
 *  🔴 กันสูตรแฝง (CSV injection): ค่าที่ขึ้นต้นด้วย = + - @ ถูกเติม ' นำหน้า — Google จะไม่รันเป็นสูตร
 *  🔴 กันเลข 0 หาย: เบอร์โทรที่เป็นตัวเลขล้วนใส่ขีดคั่น · ค่าตัวเลขล้วนที่ขึ้นต้นด้วย 0 เติม ' นำหน้า
 *  🔴 วันที่เขียนแบบ ปี-เดือน-วัน (2026-10-04 10:31) เวลาไทย — ไม่กำกวมว่าเดือนไหนวันไหน ไม่ว่าชีตตั้งภาษาอะไร
 * ═══════════════════════════════════════════════════════════════════ */
const DW = require('../../core/drive-write');
const { partsTH } = require('../../core/thai-date');

const GSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const FOLDER = 'Export-จัดการผู้ใช้';
const KEEP_MS = 12 * 3600 * 1000;      /* จำไฟล์ที่เพิ่งส่งออกไว้เท่านี้ (ไว้ให้ปุ่มแชร์ตรวจ) */
const KEEP_MAX = 200;

const clean = s => String(s == null ? '' : s).trim();

/** หัวตาราง — ลำดับคอลัมน์ของไฟล์ที่ส่งออก */
const HEADERS = ['ลำดับ', 'ชื่อ-นามสกุล', 'ชื่อเล่น', 'Username', 'สิทธิ์ (Permission)', 'บทบาท', 'สาขา / กิจการ',
  'ตำแหน่ง', 'เบอร์โทร', 'อีเมล', 'สถานะ', 'รหัสผ่าน', 'จำกัดเฉพาะแอป', 'เพิ่มจาก',
  'สร้างเมื่อ', 'สร้างโดย', 'แก้ไขล่าสุด', 'แก้ไขโดย', 'ปิดใช้งานเมื่อ', 'ปิดโดย'];

/** เวลาไทยแบบไม่กำกวม 'YYYY-MM-DD HH:mm' · ค่าว่าง/อ่านไม่ออก = คืนค่าเดิม (ไม่เดา) */
function whenTH(v) {
  const s = clean(v);
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const t = partsTH(d);
  return `${t.y}-${t.m}-${t.d} ${t.hh}:${t.mm}`;
}

/** เบอร์โทรที่เป็นตัวเลขล้วน → ใส่ขีดคั่น (Google จะไม่ตัดเลข 0 ข้างหน้า) · รูปอื่นคืนตามเดิม */
function phoneText(v) {
  const s = clean(v);
  if (/^0\d{9}$/.test(s)) return s.slice(0, 3) + '-' + s.slice(3, 6) + '-' + s.slice(6);
  if (/^0\d{8}$/.test(s)) return s.slice(0, 2) + '-' + s.slice(2, 5) + '-' + s.slice(5);
  return s;
}

/**
 * ทำค่า 1 ช่องให้ปลอดภัยก่อนลงไฟล์
 *   · ขึ้นต้นด้วย = + - @ (หรือแท็บ/ขึ้นบรรทัด) ⇒ เติม ' นำหน้า — ไม่ถูกรันเป็นสูตร
 *   · ตัวเลขล้วนที่ขึ้นต้นด้วย 0 ⇒ เติม ' นำหน้า — เลข 0 ไม่หาย
 *   ‼ ตัวเลขจริง (ชนิด number) ไม่แตะ
 */
function safeCell(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r\n]/.test(s) || /^0\d+$/.test(s)) return "'" + s;
  return s;
}

/** ครอบค่าให้ถูกรูป CSV (จุลภาค · เครื่องหมายคำพูด · ขึ้นบรรทัด) */
function csvCell(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
/** ‼ BOM หน้าไฟล์ — ไม่ใส่ Google อ่านภาษาไทยเพี้ยน */
const csvBuffer = rows => Buffer.from('﻿' + rows.map(r => (r || []).map(csvCell).join(',')).join('\r\n'), 'utf8');

const pwText = u => (!u.hasPassword ? 'ยังไม่มีรหัสผ่าน' : (u.plainLeft ? 'ตั้งแล้ว (ยังไม่เข้ารหัส)' : 'ตั้งแล้ว'));

/** ผู้ใช้ 1 คน (รูปเดียวกับที่ /api/list ส่งให้หน้าจอ) → 1 แถวของไฟล์ */
function rowOf(u, i) {
  return [i + 1, u.name, u.nickname, u.username, u.permission, u.role, u.branch, u.position,
    phoneText(u.mobile), u.email, u.active ? 'เปิดใช้งาน' : 'ปิดใช้งาน', pwText(u),
    u.appAccess, u.fromApp ? 'เพิ่มในแอป' : 'ข้อมูลเดิม',
    whenTH(u.createdAt), u.createdBy, whenTH(u.updatedAt), u.updatedBy, whenTH(u.disabledAt), u.disabledBy,
  ].map(safeCell);
}

/* ═══════════════════════════════════════════════════════════════════
 *  กรอง + เรียง — "กติกาเดียวกับ GET /api/list" (modules/users/index.js)
 *   🔴 เป็นสำเนาของตรรกะในเส้นนั้น (ไม่แตะโค้ดเดิม) ⇒ ยาม tools/test-users-export.js
 *     เทียบผลกับ /api/list ทุกชุดตัวกรองทุกครั้งที่รัน — เพี้ยนจากกันเมื่อไหร่ ยามแดงทันที
 *   · สิทธิ์ / สาขา เทียบ "ตรงเป๊ะทั้งสตริง ไม่สนตัวพิมพ์" (ห้าม includes — บทเรียน 13 ก.ย. 69)
 * ═══════════════════════════════════════════════════════════════════ */
function filterSort(all, query, RANK) {
  const qq = query || {};
  let list = all.slice();
  const q = clean(qq.q).toLowerCase();
  if (q) list = list.filter(u =>
    [u.username, u.name, u.nickname, u.permission,
     u.branch, u.position, u.mobile, u.email].join(' ').toLowerCase().includes(q));
  const st = clean(qq.status).toLowerCase();
  if (st === 'active')   list = list.filter(u => u.active);
  if (st === 'inactive') list = list.filter(u => !u.active);
  const fp = clean(qq.permission).toLowerCase();
  if (fp) list = list.filter(u => u.permission.toLowerCase() === fp);
  const fb = clean(qq.branch).toLowerCase();
  if (fb) list = list.filter(u => u.branch.toLowerCase() === fb);
  const R = RANK || {};
  list.sort((a, b) =>
    (R[b.role] || 0) - (R[a.role] || 0) ||
    String(a.permission || '').localeCompare(String(b.permission || ''), 'th') ||
    String(a.nickname || a.name || a.username || '')
      .localeCompare(String(b.nickname || b.name || b.username || ''), 'th'));
  return list;
}

/** ตัวกรองที่ใช้ เป็นข้อความภาษาคน (ลงในหัวไฟล์ + บันทึกการใช้งาน) */
function filterText(query) {
  const qq = query || {}, out = [];
  if (clean(qq.q)) out.push('ค้นหา "' + clean(qq.q) + '"');
  const st = clean(qq.status).toLowerCase();
  if (st === 'active') out.push('สถานะ เปิดใช้งาน');
  if (st === 'inactive') out.push('สถานะ ปิดใช้งาน');
  if (clean(qq.permission)) out.push('สิทธิ์ ' + clean(qq.permission));
  if (clean(qq.branch)) out.push('สาขา/กิจการ ' + clean(qq.branch));
  return out.length ? out.join(' · ') : 'ทั้งหมด (ไม่กรอง)';
}

/** ตารางทั้งไฟล์: หัวเรื่อง · บรรทัดบอกที่มา · หัวตาราง · แถวข้อมูล */
function sheetRows(list, meta) {
  const m = meta || {};
  const t = partsTH(m.now || new Date());
  const active = list.filter(u => u.active).length;
  return [
    ['รายชื่อผู้ใช้ระบบ CRM Hub'],
    [safeCell('ส่งออกเมื่อ ' + `${t.y}-${t.m}-${t.d} ${t.hh}:${t.mm}` + ' น. โดย ' + clean(m.by) +
      ' · ' + list.length + ' คน (เปิดใช้งาน ' + active + ' · ปิดใช้งาน ' + (list.length - active) + ')' +
      ' · ตัวกรอง: ' + clean(m.filter) + ' · ไฟล์นี้ไม่มีรหัสผ่าน')],
    [],
    HEADERS,
  ].concat(list.map(rowOf));
}

function fileName(now) {
  const t = partsTH(now || new Date());
  return `รายชื่อผู้ใช้-CRM-Hub-${t.y}${t.m}${t.d}-${t.hh}${t.mm}`;
}

/* ── ไฟล์ที่ส่งออกจากหน้านี้ (จำในหน่วยความจำ) — ปุ่มแชร์ยอมเฉพาะไฟล์ในรายการนี้ ── */
const _made = new Map();           /* fileId → { at, by, rows, name } */
function remember(fileId, info) {
  const now = Date.now();
  for (const [k, v] of _made) if (now - v.at > KEEP_MS) _made.delete(k);
  while (_made.size >= KEEP_MAX) _made.delete(_made.keys().next().value);
  _made.set(fileId, Object.assign({ at: now }, info));
}
const madeHere = fileId => { const v = _made.get(clean(fileId)); return !!v && Date.now() - v.at <= KEEP_MS; };

/**
 * สร้าง Google Sheet จากรายชื่อ (ที่กรอง/เรียงแล้ว)
 * @return {{fileId, url, name, rows, shared:false}}
 */
async function exportList(list, meta) {
  const m = meta || {};
  const name = fileName(m.now);
  const rows = sheetRows(list, m);
  const folderId = await DW.folderIdByName(FOLDER, { create: true });
  const f = await DW.upload({ folderId, name, mime: 'text/csv', asMime: GSHEET_MIME, buffer: csvBuffer(rows) });
  const fileId = clean(f && f.id);
  if (!fileId) throw new Error('Google Drive ไม่คืนไอดีของไฟล์ที่สร้าง');
  remember(fileId, { by: clean(m.by), rows: list.length, name });
  /* 🔒 ตั้งใจ "ไม่แชร์" ที่นี่ — ดูหัวไฟล์ข้อ ② */
  return { fileId, url: 'https://docs.google.com/spreadsheets/d/' + fileId + '/edit', name,
           rows: list.length, shared: false, folder: FOLDER };
}

/**
 * เปิดให้ "ทุกคนที่มีลิงก์ ดูได้ (ดูอย่างเดียว)" — เฉพาะไฟล์ที่ส่งออกจากหน้านี้
 * @return {{ok, why}}
 */
async function shareLink(fileId) {
  const id = clean(fileId);
  if (!madeHere(id))
    return { ok: false, denied: true,
             why: 'แชร์ได้เฉพาะไฟล์ที่เพิ่งส่งออกจากหน้านี้ (ภายใน 12 ชั่วโมง และเซิร์ฟเวอร์ยังไม่ถูกเริ่มใหม่) — กดส่งออกใหม่อีกครั้ง' };
  const r = await DW.shareAnyoneReadEx(id);
  return { ok: !!r.ok, why: r.why || '' };
}

module.exports = {
  HEADERS, FOLDER, GSHEET_MIME, exportList, shareLink,
  _t: { whenTH, phoneText, safeCell, csvCell, csvBuffer, rowOf, filterSort, filterText, sheetRows, fileName,
        madeHere, remember, reset: () => _made.clear() },
};
