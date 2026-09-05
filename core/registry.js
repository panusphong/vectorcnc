'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/registry.js — ทะเบียนโมดูล
 *
 *  แต่ละแอปเดิม = 1 โมดูล อยู่ในโฟลเดอร์ modules/<key>/
 *  โครงบังคับของทุกโมดูล:
 *
 *    modules/<key>/
 *      module.json     ← ข้อมูลโมดูล (ชื่อ · ไอคอน · สิทธิ์ · สถานะ)
 *      index.js        ← โค้ดฝั่งเซิร์ฟเวอร์  export { mount(router, ctx) }
 *      public/         ← ไฟล์หน้าเว็บของโมดูลนี้ (เสิร์ฟที่ /m/<key>/…)
 *      legacy/         ← โค้ด .gs เดิม (ถ้ายังไม่เขียนใหม่)
 *
 *  ระบบจะอ่านโฟลเดอร์ modules/ เองอัตโนมัติ — เพิ่มโมดูลใหม่แค่วางโฟลเดอร์
 *  ไม่ต้องแก้ไฟล์นี้
 * ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { atLeast } = require('./auth');

const MODULES_DIR = path.join(__dirname, '..', 'modules');

/** ค่าเริ่มต้นของ module.json ถ้าไม่ได้ระบุ */
const DEFAULTS = {
  title: '(ไม่มีชื่อ)',
  subtitle: '',
  icon: '📦',
  color: '#0d9488',
  order: 999,
  // สิทธิ์ขั้นต่ำที่ "เห็นการ์ดใน Hub"
  minRoleSee: 'VIEWER',
  // สิทธิ์ขั้นต่ำที่ "เปิดเข้าใช้งานได้"
  minRoleUse: 'VIEWER',
  // ถ้าระบุ = เฉพาะ username ในลิสต์นี้เท่านั้นที่เห็น (ว่าง = ใช้ role อย่างเดียว)
  allowUsers: [],
  // สถานะ: ready = ใช้งานได้ · wip = กำลังย้าย · planned = ยังไม่เริ่ม
  status: 'planned',
  // ถ้า true = ปิดไว้ ไม่แสดงใน Hub
  disabled: false,
};

let _cache = null;

/** อ่านทะเบียนโมดูลทั้งหมดจากดิสก์ */
function loadAll(force) {
  if (_cache && !force) return _cache;
  const out = [];

  if (!fs.existsSync(MODULES_DIR)) { _cache = out; return out; }

  for (const key of fs.readdirSync(MODULES_DIR)) {
    const dir = path.join(MODULES_DIR, key);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (key.startsWith('_') || key.startsWith('.')) continue;

    const metaPath = path.join(dir, 'module.json');
    let meta = {};
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (e) {
        console.error(`[registry] อ่าน ${key}/module.json ไม่ได้: ${e.message}`);
        continue;
      }
    }

    const m = { ...DEFAULTS, ...meta, key, dir };
    m.hasServer = fs.existsSync(path.join(dir, 'index.js'));
    m.hasPublic = fs.existsSync(path.join(dir, 'public'));
    m.hasLegacy = fs.existsSync(path.join(dir, 'legacy'));
    m.basePath = '/m/' + key;
    out.push(m);
  }

  out.sort((a, b) => (a.order - b.order) || a.key.localeCompare(b.key));
  _cache = out;
  return out;
}

const get = key => loadAll().find(m => m.key === key) || null;

/** โมดูลที่ผู้ใช้คนนี้ "เห็นการ์ดใน Hub" */
function visibleTo(user) {
  if (!user) return [];
  return loadAll().filter(m => {
    if (m.disabled) return false;
    if (m.allowUsers && m.allowUsers.length) {
      return m.allowUsers.some(u => String(u).toLowerCase() === user.username.toLowerCase());
    }
    return atLeast(user.role, m.minRoleSee);
  });
}

/** ผู้ใช้คนนี้เปิดโมดูลนี้ได้ไหม — คืน { ok } หรือ { ok:false, error } */
function canUse(user, mod) {
  if (!user) return { ok: false, error: 'ต้องเข้าสู่ระบบก่อน' };
  if (!mod)  return { ok: false, error: 'ไม่พบโมดูลนี้' };
  if (mod.disabled) return { ok: false, error: 'โมดูลนี้ถูกปิดใช้งานชั่วคราว' };
  if (mod.status === 'planned')
    return { ok: false, error: 'โมดูลนี้ยังไม่ได้ย้ายเข้าระบบใหม่' };

  if (mod.allowUsers && mod.allowUsers.length) {
    const ok = mod.allowUsers.some(u => String(u).toLowerCase() === user.username.toLowerCase());
    return ok ? { ok: true } : { ok: false, error: 'บัญชีนี้ไม่อยู่ในรายชื่อที่เข้าใช้โมดูลนี้ได้' };
  }
  if (!atLeast(user.role, mod.minRoleUse)) {
    return { ok: false, error: `สิทธิ์ไม่พอ — โมดูลนี้ต้องเป็น ${mod.minRoleUse} ขึ้นไป (คุณคือ ${user.role})` };
  }
  return { ok: true };
}

/** สรุปสถานะการย้ายระบบ (ใช้โชว์ในหน้า Hub และ npm run doctor) */
function summary() {
  const all = loadAll();
  const by = s => all.filter(m => m.status === s).length;
  return { total: all.length, ready: by('ready'), wip: by('wip'), planned: by('planned') };
}

module.exports = { loadAll, get, visibleTo, canUse, summary, MODULES_DIR, DEFAULTS };
