#!/usr/bin/env node
'use strict';
/* ตั้งรหัสผ่านใหม่ให้ผู้ใช้ 1 คน
 * ใช้:  node tools/set-password.js <username> <รหัสใหม่> */
const bcrypt = require('bcryptjs');
const db = require('../core/db');
const { assertReady } = require('../core/config');
assertReady();

(async () => {
  const [u, p] = process.argv.slice(2);
  if (!u || !p) { console.error('ใช้:  node tools/set-password.js <username> <รหัสใหม่>'); process.exit(1); }
  if (p.length < 8) { console.error('❌ รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร'); process.exit(1); }

  const row = await db.one('app_users', { Username: 'ilike.' + u });
  if (!row) { console.error('❌ ไม่พบผู้ใช้: ' + u); process.exit(1); }

  await db.update('app_users', { Username: 'ilike.' + u },
    { PasswordHash: await bcrypt.hash(p, 10), Password: null });
  console.log(`✅ ตั้งรหัสผ่านใหม่ให้ ${row.Username} (${row.Nickname || row.Name || '-'}) แล้ว`);
})();
