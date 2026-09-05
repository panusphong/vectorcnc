'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/sync-users.js — ซิงค์ชีต User (Login CRM) → app.app_users
 *
 *  ‼ ตัวนี้ต้องแยกจาก core/sync.js เพราะ "ผู้ใช้" ไม่ใช่ตารางกระจกธรรมดา
 *
 *  ระบบใหม่เป็นเจ้าของรหัสผ่านแล้ว (เก็บเป็น bcrypt) ส่วนชีตยังเก็บข้อความล้วน
 *  ถ้าซิงค์ทับแบบตารางอื่น = PasswordHash หายทุกคน ล็อกอินไม่ได้ทั้งบริษัท
 *
 *  กฎที่ใช้แทน:
 *    · คนใหม่ในชีต   → เพิ่มเข้าระบบ + แปลงรหัสเป็น bcrypt ทันที
 *    · คนที่มีอยู่แล้ว → อัปเดตแค่ ชื่อ · ชื่อเล่น · รูป · สิทธิ์ · สถานะ · เบอร์ · อีเมล
 *                       ‼ ไม่แตะรหัสผ่านเด็ดขาด (รหัสที่ตั้งในระบบใหม่ต้องอยู่)
 *    · คนที่หายจากชีต → ไม่ลบ ไม่ปิดบัญชี แค่รายงานให้แอดมินตัดสินใจเอง
 *                       (ลบบัญชีอัตโนมัติจากการที่ใครเผลอลบแถว = อันตรายเกินไป)
 *
 *  ผลลัพธ์: ไม่ต้องดาวน์โหลด CSV ไม่ต้องรันคำสั่งอะไรเลย
 * ═══════════════════════════════════════════════════════════════════ */
const bcrypt = require('bcryptjs');
const db = require('./db');
const sheets = require('./sheets');

const T = 'app_users';

/** ชื่อคอลัมน์ที่ยอมรับได้ (ชีตแต่ละไฟล์สะกดไม่เหมือนกัน) */
const FIELD = {
  Name:       ['Name', 'ชื่อ', 'ชื่อ-นามสกุล'],
  Nickname:   ['Nickname', 'ชื่อเล่น'],
  Impage:     ['Impage', 'Image', 'รูป', 'Photo'],
  Username:   ['Username', 'User', 'ผู้ใช้'],
  Password:   ['Password', 'รหัสผ่าน'],
  Status:     ['Status', 'สถานะ'],
  Permission: ['Permission', 'สิทธิ์'],
  Mobile:     ['Mobile', 'เบอร์โทร', 'โทรศัพท์'],
  email:      ['email', 'Email', 'อีเมล'],
};

const clean = s => String(s == null ? '' : s).trim();

async function syncUsers(job) {
  const t0 = Date.now();
  const log = job.log || (() => {});
  const stat = { rows_read: 0, rows_new: 0, rows_upd: 0, rows_same: 0, rows_del: 0 };
  let runId = null;

  try {
    const started = await db.insert('sync_run', { source: 'users', started_at: new Date().toISOString() });
    runId = Array.isArray(started) && started[0] ? started[0]._id : null;
  } catch { /* จดไม่ได้ก็ทำงานต่อ */ }

  try {
    const { header, rows } = await sheets.readTab(job.sheetId, job.tab);
    if (!header.length) throw new Error('แท็บ User ว่างเปล่า หรืออ่านหัวตารางไม่ได้');
    stat.rows_read = rows.length;

    // จับคู่คอลัมน์แบบยืดหยุ่น
    const pos = {};
    header.forEach((h, i) => { if (h) pos[clean(h)] = i; });
    const idx = {};
    for (const [field, names] of Object.entries(FIELD)) {
      for (const n of names) {
        const hit = Object.keys(pos).find(h => h.toLowerCase() === n.toLowerCase());
        if (hit !== undefined) { idx[field] = pos[hit]; break; }
      }
    }
    if (idx.Username === undefined)
      throw new Error('ไม่พบคอลัมน์ Username — หัวตารางที่เจอ: ' + header.slice(0, 8).join(' | '));

    /* คนที่มีอยู่แล้วในระบบ */
    const existing = new Map();
    /* selectAll ไม่ใช่ select — Supabase ตัดที่ 1,000 แถวเงียบ ๆ
     * ถ้าอ่านไม่ครบ คนที่มีอยู่แล้วจะถูกนับเป็น "คนใหม่" แล้วเพิ่มซ้ำ */
    const cur = await db.selectAll(T, {
      select: 'Username,Name,Nickname,Impage,Status,Permission,PasswordHash',
      order: 'Username.asc',
    });
    for (const u of cur || []) existing.set(clean(u.Username).toLowerCase(), u);

    const seen = new Set();
    const noPassword = [];

    for (const raw of rows) {
      const username = clean(raw[idx.Username]);
      if (!username) continue;
      seen.add(username.toLowerCase());

      const profile = {
        Name:       idx.Name       !== undefined ? clean(raw[idx.Name])       : '',
        Nickname:   idx.Nickname   !== undefined ? clean(raw[idx.Nickname])   : '',
        Impage:     idx.Impage     !== undefined ? clean(raw[idx.Impage])     : '',
        Status:     idx.Status     !== undefined ? (clean(raw[idx.Status]) || 'Login') : 'Login',
        Permission: idx.Permission !== undefined ? clean(raw[idx.Permission]) : '',
      };
      if (idx.Mobile !== undefined) profile.Mobile = clean(raw[idx.Mobile]);
      if (idx.email  !== undefined) profile.email  = clean(raw[idx.email]);

      const old = existing.get(username.toLowerCase());

      if (!old) {
        /* คนใหม่ — แปลงรหัสเป็น bcrypt ตั้งแต่ตอนเข้า ไม่เก็บข้อความล้วนแม้แต่วินาทีเดียว */
        const plain = idx.Password !== undefined ? clean(raw[idx.Password]) : '';
        const rec = { ...profile, Username: username, Password: null };
        if (plain) rec.PasswordHash = await bcrypt.hash(plain, 10);
        else noPassword.push(username);

        await db.insert(T, rec);
        stat.rows_new++;
        continue;
      }

      /* คนเดิม — เทียบเฉพาะข้อมูลโปรไฟล์ ไม่แตะรหัสผ่าน */
      const changed = Object.keys(profile).some(k => clean(old[k]) !== clean(profile[k]));
      if (!changed) { stat.rows_same++; continue; }

      await db.update(T, { Username: 'ilike.' + username },
        { ...profile, updated_at: new Date().toISOString() });
      stat.rows_upd++;
    }

    /* คนที่หายจากชีต — รายงานอย่างเดียว ไม่แตะต้อง */
    const gone = [...existing.keys()].filter(u => !seen.has(u));
    const note = gone.length
      ? 'มีในระบบแต่ไม่มีในชีตแล้ว ' + gone.length + ' คน: ' + gone.slice(0, 10).join(', ')
      : null;
    if (gone.length) log('ℹ ' + note + ' — ไม่ได้ลบให้ ตัดสินใจเองที่โมดูลจัดการผู้ใช้');
    if (noPassword.length)
      log('⚠ ไม่มีรหัสผ่านในชีต ' + noPassword.length + ' คน — ล็อกอินไม่ได้จนกว่าจะตั้งรหัสให้: '
          + noPassword.slice(0, 10).join(', '));

    const ms = Date.now() - t0;
    log(`เสร็จ · อ่าน ${stat.rows_read} · ใหม่ ${stat.rows_new} · แก้ ${stat.rows_upd} · เท่าเดิม ${stat.rows_same}`);
    if (runId) {
      await db.update('sync_run', { _id: 'eq.' + runId },
        { finished_at: new Date().toISOString(), ok: true, ms, note, ...stat }).catch(() => {});
    }
    return { ok: true, ms, note, ...stat };

  } catch (e) {
    const ms = Date.now() - t0;
    log('❌ ล้มเหลว:', e.message);
    if (runId) {
      await db.update('sync_run', { _id: 'eq.' + runId },
        { finished_at: new Date().toISOString(), ok: false, ms, error: String(e.message).slice(0, 500), ...stat })
        .catch(() => {});
    }
    return { ok: false, ms, error: e.message, ...stat };
  }
}

module.exports = { syncUsers };
