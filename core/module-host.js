'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/module-host.js — ตัวโหลดและแยกขอบเขตของโมดูล
 *
 *  🔑 หัวใจของการ "รวมแอปแต่แยกโมดูล"
 *
 *  ปัญหา: แอปเดิมทุกตัวประกาศชื่อซ้ำกันหมด — CONFIG, doGet, _ymd, _user,
 *         _readSheet, TZ ... ถ้าโหลดเข้ามาในที่เดียวกันจะทับกันพัง
 *
 *  ทางแก้: ทุกโมดูลรันใน "กล่องของตัวเอง"
 *    · โมดูลที่เขียนใหม่ (native)  → Node module ปกติ (แยก scope อยู่แล้ว)
 *    · โมดูลที่ยังใช้โค้ด .gs เดิม → vm.createContext() แยกกล่องต่อโมดูล
 *      โค้ดเดิมไม่ต้องแก้แม้แต่บรรทัดเดียว และชื่อซ้ำกันได้ไม่ชนกัน
 *
 *  ผลคือ: อัปเดตโมดูลไหน กระทบแค่โมดูลนั้น
 * ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');

const db = require('./db');
const auth = require('./auth');
const { CFG } = require('./config');
const registry = require('./registry');

/** เก็บสถานะโมดูลที่โหลดแล้ว */
const loaded = new Map();   // key -> { mod, router, sandbox, error, loadedAt }

/* ─── บริการกลางที่ทุกโมดูลใช้ร่วมกัน ─────────────────────────────
 *  โมดูลไม่ต้องต่อฐานข้อมูลเอง ไม่ต้องทำ auth เอง — เรียกจากตรงนี้     */
function makeContext(mod) {
  return {
    key: mod.key,
    meta: mod,
    db,                         // ตัวคุย Supabase ตัวเดียวของระบบ
    auth,                       // ยืนยันตัวตน + สิทธิ์
    CFG,
    /** เขียน audit log โดยติดชื่อโมดูลให้อัตโนมัติ */
    audit: (user, action, detail, meta) =>
      auth.audit(user, action, detail, { ...(meta || {}), module: mod.key }),
    /** path ของไฟล์ในโฟลเดอร์โมดูลนี้ */
    file: (...p) => path.join(mod.dir, ...p),
    log: (...a) => console.log(`[${mod.key}]`, ...a),
    warn: (...a) => console.warn(`[${mod.key}]`, ...a),
  };
}

/* ─── กล่องแยกสำหรับโค้ด .gs เดิม ─────────────────────────────────
 *  สร้าง context ใหม่ต่อโมดูล แล้วโหลดไฟล์ .gs เข้าไปตามลำดับ
 *  ทุกโมดูลได้ global ของตัวเอง — ชื่อซ้ำกันไม่ชนกัน                  */
function createLegacySandbox(mod, ctx) {
  const legacyDir = path.join(mod.dir, 'legacy');
  if (!fs.existsSync(legacyDir)) return null;

  // global ของกล่องนี้ — ใส่เฉพาะของที่ปลอดภัย ไม่ให้เห็น process / require
  const sandbox = {
    console: {
      log:   (...a) => ctx.log(...a),
      warn:  (...a) => ctx.warn(...a),
      error: (...a) => ctx.warn(...a),
    },
    JSON, Math, Date, RegExp, Error, TypeError, RangeError,
    String, Number, Boolean, Array, Object, Map, Set, Promise,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent,
    decodeURIComponent, encodeURI, decodeURI, Buffer,
    setTimeout, clearTimeout,
    // ตัวช่วยของระบบใหม่ที่โค้ดเดิมเรียกใช้ได้
    __ctx: ctx,
    __module: mod.key,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // ลำดับการโหลด: อ่านจาก module.json → legacyFiles ถ้าไม่ระบุ = เรียงชื่อไฟล์
  const files = (mod.legacyFiles && mod.legacyFiles.length)
    ? mod.legacyFiles
    : fs.readdirSync(legacyDir).filter(f => /\.(gs|js)$/i.test(f)).sort();

  for (const f of files) {
    const full = path.join(legacyDir, f);
    if (!fs.existsSync(full)) { ctx.warn('ไม่พบไฟล์ legacy:', f); continue; }
    const src = fs.readFileSync(full, 'utf8');
    try {
      vm.runInContext(src, sandbox, { filename: `${mod.key}/legacy/${f}` });
    } catch (e) {
      throw new Error(`โหลด ${mod.key}/legacy/${f} ไม่สำเร็จ: ${e.message}`);
    }
  }
  ctx.log(`โหลดโค้ดเดิม ${files.length} ไฟล์เข้ากล่องแยกแล้ว`);
  return sandbox;
}

/* ─── โหลดโมดูล 1 ตัว ─────────────────────────────────────────────── */
async function loadModule(mod) {
  const ctx = makeContext(mod);
  const router = express.Router();
  const entry = { mod, router, sandbox: null, error: null, loadedAt: new Date() };

  try {
    // 1) กล่องโค้ดเดิม (ถ้ามี)
    if (mod.hasLegacy) {
      entry.sandbox = createLegacySandbox(mod, ctx);
      ctx.legacy = entry.sandbox;
      /** เรียกฟังก์ชันในโค้ดเดิมจากฝั่ง Node */
      ctx.callLegacy = (fnName, ...args) => {
        const fn = entry.sandbox && entry.sandbox[fnName];
        if (typeof fn !== 'function')
          throw new Error(`ไม่พบฟังก์ชัน ${fnName}() ในโค้ดเดิมของโมดูล ${mod.key}`);
        return fn(...args);
      };
    }

    // 2) ไฟล์หน้าเว็บของโมดูล
    if (mod.hasPublic) {
      router.use(express.static(path.join(mod.dir, 'public'), { index: 'index.html' }));
    }

    // 3) โค้ดฝั่งเซิร์ฟเวอร์ของโมดูล
    if (mod.hasServer) {
      const m = require(path.join(mod.dir, 'index.js'));
      if (typeof m.mount === 'function') {
        await m.mount(router, ctx);
      } else {
        throw new Error(`modules/${mod.key}/index.js ต้อง export { mount(router, ctx) }`);
      }
    }

    console.log(`[registry] ✅ ${mod.key} — ${mod.title}`);
  } catch (e) {
    entry.error = e;
    console.error(`[registry] ❌ ${mod.key} โหลดไม่สำเร็จ: ${e.message}`);
    // โมดูลพังตัวเดียว ต้องไม่ทำให้ทั้งระบบล่ม — ใส่ router แจ้งเตือนแทน
    router.use((_req, res) => res.status(503).json({
      ok: false, code: 'MODULE_ERROR',
      error: `โมดูล "${mod.title}" โหลดไม่สำเร็จ`, detail: e.message,
    }));
  }

  loaded.set(mod.key, entry);
  return entry;
}

/* ─── โหลดทุกโมดูล + ต่อเข้า express ─────────────────────────────── */
async function mountAll(app) {
  const mods = registry.loadAll(true);
  console.log(`[registry] พบ ${mods.length} โมดูล`);

  for (const mod of mods) {
    if (mod.disabled)            { console.log(`[registry] ⏸  ${mod.key} (ปิดไว้)`); continue; }
    if (mod.status === 'planned'){ console.log(`[registry] 📋 ${mod.key} (ยังไม่ได้ย้าย)`); continue; }

    const entry = await loadModule(mod);

    // ทุก request เข้าโมดูลต้องผ่านด่าน: ล็อกอิน → มีสิทธิ์ใช้โมดูลนี้
    app.use(mod.basePath,
      auth.requireLogin(),
      (req, res, next) => {
        const chk = registry.canUse(req.user, mod);
        if (!chk.ok) {
          if (req.path.startsWith('/api/') || req.xhr)
            return res.status(403).json({ ok: false, code: 'NO_PERMISSION', error: chk.error });
          return res.status(403).send(denyPage(mod, chk.error));
        }
        req.module = mod;
        next();
      },
      entry.router
    );
  }
  return loaded;
}

/** โหลดโมดูลเดียวใหม่ (ใช้ตอนพี่เอส่งโค้ดอัปเดตมา — ไม่ต้องรีสตาร์ททั้งระบบ) */
async function reload(key) {
  const mod = registry.get(key);
  if (!mod) throw new Error('ไม่พบโมดูล ' + key);
  // ล้าง require cache ของโมดูลนั้น
  for (const p of Object.keys(require.cache)) {
    if (p.startsWith(mod.dir)) delete require.cache[p];
  }
  registry.loadAll(true);
  return loadModule(registry.get(key));
}

const denyPage = (mod, msg) => `<!doctype html><meta charset="utf-8">
<title>เข้าใช้งานไม่ได้</title>
<style>body{font-family:system-ui,'Prompt',sans-serif;background:#0b1422;color:#eef4f5;
display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
.b{max-width:420px;text-align:center;background:rgba(255,255,255,.05);
border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:36px 28px}
h2{margin:10px 0;font-size:19px}p{color:#8ba0ad;font-size:14px;line-height:1.6}
a{color:#2ee6c5;text-decoration:none;font-weight:600;display:inline-block;margin-top:18px}</style>
<div class="b"><div style="font-size:48px">⛔</div>
<h2>${mod.icon} ${mod.title}</h2><p>${msg}</p><a href="/">← กลับหน้ารวมแอป</a></div>`;

const status = () => [...loaded.values()].map(e => ({
  key: e.mod.key, title: e.mod.title, status: e.mod.status,
  ok: !e.error, error: e.error ? e.error.message : null,
  legacy: !!e.sandbox, loadedAt: e.loadedAt,
}));

module.exports = { mountAll, reload, status, loaded };
