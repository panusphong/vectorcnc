#!/usr/bin/env node
'use strict';
/* ตรวจสุขภาพระบบก่อนใช้งานจริง — node tools/doctor.js */
const path = require('path');
require('dotenv').config();

const ok = s => console.log('  ✅ ' + s);
const no = s => console.log('  ❌ ' + s);
const wa = s => console.log('  ⚠  ' + s);
let fail = 0;

(async () => {
console.log('\n🔍 ตรวจระบบ CRM มดงานการป้าย\n');

console.log('1) ตัวแปรสภาพแวดล้อม');
for (const k of ['SUPABASE_URL','SUPABASE_KEY','SESSION_SECRET']) {
  if (!process.env[k]) { no(k + ' — ยังไม่ได้ตั้ง'); fail++; }
  else if (k === 'SESSION_SECRET' && process.env[k].length < 32) { no('SESSION_SECRET สั้นเกินไป (ต้อง ≥32)'); fail++; }
  else ok(k);
}
if (fail) { console.log('\n❌ ตั้งค่าไม่ครบ — ดู SETUP.md\n'); process.exit(1); }

console.log('\n2) ฐานข้อมูล');
const db = require('../core/db');
try {
  const n = await db.count('app_users', {});
  ok(`ต่อ Supabase ได้ · มีผู้ใช้ ${n} คน`);
  if (n === 0) wa('ยังไม่มีผู้ใช้ — รัน: npm run import-users <ไฟล์.csv>');

  const noHash = await db.select('app_users', { select: 'Username', PasswordHash: 'is.null', limit: 100 });
  if (noHash && noHash.length) wa(`${noHash.length} คนยังไม่มีรหัสผ่านที่เข้ารหัส`);
  else ok('รหัสผ่านเข้ารหัสครบทุกคน');

  await db.count('auth_audit', {});
  ok('ตาราง auth_audit พร้อม');
} catch (e) {
  no('ต่อฐานข้อมูลไม่ได้: ' + e.message);
  console.log('     · ตรวจ SUPABASE_URL / SUPABASE_KEY');
  console.log('     · รัน sql/01-core.sql ใน Supabase SQL Editor แล้วหรือยัง');
  fail++;
}

console.log('\n3) โมดูล');
const registry = require('../core/registry');
const mods = registry.loadAll(true);
const s = registry.summary();
ok(`พบ ${s.total} โมดูล · พร้อมใช้ ${s.ready} · กำลังย้าย ${s.wip} · ยังไม่เริ่ม ${s.planned}`);
for (const m of mods) {
  const icon = m.status === 'ready' ? '✅' : m.status === 'wip' ? '🟡' : '📋';
  console.log(`     ${icon} ${m.key.padEnd(13)} ${m.title}`);
}

console.log(fail ? '\n❌ ยังมีปัญหา ' + fail + ' จุด\n' : '\n✅ ระบบพร้อมใช้งาน — เปิดด้วย: npm start\n');
process.exit(fail ? 1 : 0);
})();
