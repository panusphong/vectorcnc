#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  นำเข้าผู้ใช้จากชีต "User" (Login CRM) เข้า Supabase
 *
 *  วิธีใช้
 *    1) เปิดชีต Login CRM → แท็บ User
 *    2) File → Download → Comma-separated values (.csv)
 *    3) node tools/import-users.js ~/Downloads/User.csv
 *
 *  หรือถ้าเผยแพร่ชีตเป็น CSV ไว้แล้ว
 *       node tools/import-users.js "https://docs.google.com/.../pub?output=csv"
 *
 *  · รันซ้ำได้ — คนที่มีอยู่แล้วจะถูก "อัปเดต" ไม่ใช่เพิ่มซ้ำ
 *  · รหัสผ่านเดิมจะถูกแปลงเป็น bcrypt ให้ทันที (ไม่เก็บข้อความล้วน)
 * ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('../core/db');
const { assertReady } = require('../core/config');

assertReady();

/* ── ตัวอ่าน CSV (รองรับ , ใน "..." และขึ้นบรรทัดใหม่ในเซลล์) ── */
function parseCSV(text) {
  text = text.replace(/^﻿/, '');          // ตัด BOM
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim()));
}

/** หา index ของคอลัมน์ — รองรับชื่อสะกดต่างกัน */
function findCol(header, names) {
  for (const n of names) {
    const i = header.findIndex(h => String(h).trim().toLowerCase() === n.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

(async () => {
  const src = process.argv[2];
  if (!src) {
    console.error(`
วิธีใช้:  node tools/import-users.js <ไฟล์ CSV หรือ URL>

ตัวอย่าง:
  node tools/import-users.js ./User.csv
  node tools/import-users.js "https://docs.google.com/spreadsheets/d/e/xxx/pub?output=csv"
`);
    process.exit(1);
  }

  /* 1) อ่านข้อมูล */
  let text;
  if (/^https?:\/\//i.test(src)) {
    console.log('📥 กำลังดาวน์โหลดจาก URL…');
    const res = await fetch(src);
    if (!res.ok) { console.error('❌ ดาวน์โหลดไม่สำเร็จ: HTTP ' + res.status); process.exit(1); }
    text = await res.text();
  } else {
    if (!fs.existsSync(src)) { console.error('❌ ไม่พบไฟล์: ' + src); process.exit(1); }
    text = fs.readFileSync(src, 'utf8');
  }

  const rows = parseCSV(text);
  if (rows.length < 2) { console.error('❌ ไฟล์ว่างหรืออ่านไม่ออก'); process.exit(1); }

  const header = rows[0];
  const C = {
    name:  findCol(header, ['Name', 'ชื่อ', 'ชื่อ-นามสกุล']),
    nick:  findCol(header, ['Nickname', 'ชื่อเล่น']),
    img:   findCol(header, ['Impage', 'Image', 'รูป', 'Photo']),
    user:  findCol(header, ['Username', 'User', 'ผู้ใช้']),
    pass:  findCol(header, ['Password', 'รหัสผ่าน']),
    stat:  findCol(header, ['Status', 'สถานะ']),
    perm:  findCol(header, ['Permission', 'สิทธิ์']),
  };

  if (C.user < 0) {
    console.error('❌ ไม่พบคอลัมน์ "Username" — หัวตารางที่เจอ:\n   ' + header.join(' | '));
    process.exit(1);
  }
  console.log(`📋 พบ ${rows.length - 1} แถว · คอลัมน์ที่จับคู่ได้:`);
  for (const [k, v] of Object.entries(C)) {
    console.log(`   ${k.padEnd(6)} ${v >= 0 ? '→ "' + header[v] + '"' : '— ไม่พบ (ข้าม)'}`);
  }
  console.log('');

  /* 2) อ่านคนที่มีอยู่แล้วในฐานข้อมูล */
  const existing = new Map();
  try {
    const cur = await db.select('app_users', { select: 'Username,PasswordHash' });
    for (const u of cur || []) existing.set(String(u.Username).toLowerCase(), u);
  } catch (e) {
    console.error('❌ ต่อฐานข้อมูลไม่ได้: ' + e.message);
    console.error('   ตรวจว่ารัน sql/01-core.sql ใน Supabase แล้วหรือยัง');
    process.exit(1);
  }

  /* 3) นำเข้าทีละคน */
  let added = 0, updated = 0, skipped = 0, hashed = 0;
  const noPassword = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const username = String(r[C.user] || '').trim();
    if (!username) { skipped++; continue; }

    const plain = C.pass >= 0 ? String(r[C.pass] || '').trim() : '';
    const rec = {
      Name:       C.name >= 0 ? String(r[C.name] || '').trim() : '',
      Nickname:   C.nick >= 0 ? String(r[C.nick] || '').trim() : '',
      Impage:     C.img  >= 0 ? String(r[C.img]  || '').trim() : '',
      Username:   username,
      Status:     C.stat >= 0 ? (String(r[C.stat] || '').trim() || 'Login') : 'Login',
      Permission: C.perm >= 0 ? String(r[C.perm] || '').trim() : '',
    };

    // แปลงรหัสผ่านเป็น bcrypt ทันที — ไม่เก็บข้อความล้วนลงฐานข้อมูล
    if (plain) {
      rec.PasswordHash = await bcrypt.hash(plain, 10);
      rec.Password = null;
      hashed++;
    } else {
      noPassword.push(username);
    }

    const key = username.toLowerCase();
    try {
      if (existing.has(key)) {
        // ถ้ามี hash อยู่แล้วและ CSV ไม่มีรหัส → อย่าไปทับของเดิม
        if (!plain) { delete rec.PasswordHash; delete rec.Password; }
        await db.update('app_users', { Username: 'ilike.' + username }, rec);
        updated++;
      } else {
        await db.insert('app_users', rec);
        added++;
      }
      process.stdout.write(`\r   กำลังนำเข้า… ${i}/${rows.length - 1}`);
    } catch (e) {
      console.error(`\n   ⚠ ${username}: ${e.message}`);
      skipped++;
    }
  }

  /* 4) สรุป */
  console.log('\n');
  console.log('═'.repeat(52));
  console.log(`✅ เพิ่มใหม่      ${added} คน`);
  console.log(`🔄 อัปเดต        ${updated} คน`);
  console.log(`🔐 เข้ารหัสผ่าน   ${hashed} คน (bcrypt)`);
  if (skipped) console.log(`⏭  ข้าม           ${skipped} แถว`);
  console.log('═'.repeat(52));

  if (noPassword.length) {
    console.log(`\n⚠ ${noPassword.length} คนไม่มีรหัสผ่านในไฟล์ — ล็อกอินไม่ได้จนกว่าจะตั้งรหัสให้:`);
    console.log('   ' + noPassword.slice(0, 20).join(', ') + (noPassword.length > 20 ? ' …' : ''));
    console.log('\n   ตั้งรหัสให้ทีละคนด้วย:  node tools/set-password.js <username> <รหัสใหม่>');
  }

  console.log('\n🔒 รหัสผ่านทั้งหมดถูกเข้ารหัสแล้ว — ไม่มีข้อความล้วนเก็บในฐานข้อมูล');
  console.log('   ⚠ อย่าลืมลบไฟล์ CSV ทิ้งหลังนำเข้าเสร็จ (ในนั้นมีรหัสผ่านจริง)\n');
})();
