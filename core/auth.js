'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/auth.js — ชั้นยืนยันตัวตนกลางของทั้งระบบ
 *
 *  นี่คือชิ้นส่วนที่แก้ปัญหาซ้ำ ๆ ที่เจอทั้ง 11 แอปเดิม:
 *    เดิม  : ?u=<username> ลอยมาจากเบราว์เซอร์ → เชื่อทันที → ปลอมได้
 *    ใหม่  : session cookie ที่เซ็นด้วย HMAC → ปลอมไม่ได้
 *
 *  ยกแบบมาจากของที่ทีมเขียนถูกอยู่แล้ว 2 ที่:
 *    · soMakeToken()    (แอปจองคิวช่าง)   — HMAC + วันหมดอายุ + ผูกกับงานใบเดียว
 *    · genReviewToken() (โมดูลรีวิวลูกค้า) — HMAC + มี unit test ทดสอบการปลอม
 * ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { CFG } = require('./config');
const db = require('./db');

const T_USERS = 'app_users';
const T_AUDIT = 'auth_audit';

/* ─── 1) โทเคน: เซ็น / ตรวจ ──────────────────────────────────────── */

const b64url = buf => Buffer.from(buf).toString('base64url');
const unb64url = s => Buffer.from(s, 'base64url');

function sign(payloadStr, purpose) {
  return crypto
    .createHmac('sha256', CFG.SESSION_SECRET + '|' + purpose)
    .update(payloadStr)
    .digest('base64url');
}

/**
 * สร้างโทเคน  <base64url(json)>.<hmac>
 * @param {object} data     ข้อมูลที่ใส่ไว้ในโทเคน
 * @param {number} ttlSec   อายุ (วินาที)
 * @param {string} purpose  แยกวัตถุประสงค์ ('session' | 'sso') กันเอาโทเคนข้ามงานมาใช้
 */
function issue(data, ttlSec, purpose) {
  const body = b64url(JSON.stringify({ ...data, exp: Date.now() + ttlSec * 1000 }));
  return body + '.' + sign(body, purpose);
}

/**
 * ตรวจโทเคน — คืน payload ถ้าถูกต้องและยังไม่หมดอายุ ไม่งั้นคืน null
 * เทียบลายเซ็นแบบ timing-safe (กัน timing attack)
 */
function verify(token, purpose) {
  try {
    if (typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const expect = sign(body, purpose);
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const data = JSON.parse(unb64url(body).toString('utf8'));
    if (!data || typeof data.exp !== 'number' || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

/* ─── 2) สิทธิ์: Permission ในชีต → บทบาทในระบบ ──────────────────
 *  รวมลิสต์ที่เคยกระจายอยู่ใน 11 แอปมาไว้ที่เดียว
 *  แก้ที่นี่ที่เดียว มีผลกับทุกโมดูลทันที                              */

const ROLE_RANK = { VIEWER: 1, TECH: 2, OFFICER: 3, ACCOUNTING: 4, ADMIN: 5 };

const PERMISSION_ROLE = {
  'administrator':        'ADMIN',
  'admin':                'ADMIN',
  'ผู้ดูแลระบบ':            'ADMIN',
  'ผู้ดูแล':                'ADMIN',
  'accounting':           'ACCOUNTING',
  'บัญชี':                 'ACCOUNTING',
  'after sale service':   'OFFICER',
  'planning':             'OFFICER',
  'sale support':         'OFFICER',
  'sale':                 'VIEWER',
  'sales':                'VIEWER',
  'graphic':              'VIEWER',
  'graphic สาขามดงาน':     'VIEWER',
  'พนักงานจัดส่ง':          'TECH',
  'ช่างนอก':               'TECH',
  'พนักงานในไลน์ผลิต':      'TECH',
};

function roleOf(permission) {
  const p = String(permission || '').trim().toLowerCase();
  if (PERMISSION_ROLE[p]) return PERMISSION_ROLE[p];
  if (p.includes('admin')) return 'ADMIN';
  if (p.includes('account') || p.includes('บัญชี')) return 'ACCOUNTING';
  if (p.includes('after sale') || p.includes('plan')) return 'OFFICER';
  if (p.includes('ช่าง')) return 'TECH';
  return 'VIEWER';
}

const atLeast = (role, min) => (ROLE_RANK[role] || 0) >= (ROLE_RANK[min] || 0);

/* ─── 3) ผู้ใช้ ───────────────────────────────────────────────────── */

/** อ่านผู้ใช้จากฐานข้อมูล (ไม่คืนรหัสผ่านออกไปไหนทั้งสิ้น) */
async function findUser(username) {
  const u = String(username || '').trim();
  if (!u) return null;
  const row = await db.one(T_USERS, { Username: 'ilike.' + u });
  if (!row) return null;
  return {
    username:   String(row.Username || '').trim(),
    name:       String(row.Name || '').trim(),
    nickname:   String(row.Nickname || '').trim(),
    image:      String(row.Impage || '').trim(),
    permission: String(row.Permission || '').trim(),
    status:     String(row.Status || '').trim(),
    role:       roleOf(row.Permission),
    _hash:      String(row.PasswordHash || ''),
    _plain:     String(row.Password || ''),   // เหลือไว้ช่วงย้ายระบบเท่านั้น
  };
}

/** บัญชีนี้ยังใช้งานได้ไหม — Status ต้องไม่ใช่ Logout
 *  (เดิมมีแค่ 2 แอปจาก 11 ที่ตรวจข้อนี้ ตอนนี้บังคับทุกโมดูล) */
const isActive = user => !!user && String(user.status).toLowerCase() !== 'logout';

/* ─── 4) เข้าสู่ระบบ ──────────────────────────────────────────────── */

/**
 * ตรวจรหัสผ่าน
 *  · ถ้ามี PasswordHash → เทียบ bcrypt
 *  · ถ้ายังไม่มี (ข้อมูลเก่าจากชีต) → เทียบข้อความล้วน แล้ว "อัปเกรดเป็น hash ให้ทันที"
 *    ผู้ใช้ไม่ต้องทำอะไร ล็อกอินครั้งเดียวรหัสก็ถูกเข้ารหัสอัตโนมัติ
 */
async function checkPassword(user, password) {
  const pw = String(password || '');
  if (!pw) return false;

  if (user._hash) return bcrypt.compare(pw, user._hash);

  if (user._plain && pw === user._plain) {
    try {
      const hash = await bcrypt.hash(pw, 10);
      await db.update(T_USERS, { Username: 'eq.' + user.username },
        { PasswordHash: hash, Password: null });
      console.log('[auth] อัปเกรดรหัสผ่านเป็น bcrypt ให้ ' + user.username + ' แล้ว');
    } catch (e) {
      console.warn('[auth] อัปเกรดรหัสผ่านไม่สำเร็จ:', e.message);
    }
    return true;
  }
  return false;
}

/** ล็อกอิน — คืน { ok, user, token } หรือ { ok:false, error } */
async function login(username, password, meta = {}) {
  const user = await findUser(username);
  if (!user)              { await audit(null, 'login_fail', { username, reason: 'ไม่พบผู้ใช้' }, meta); return { ok: false, error: 'ไม่พบชื่อผู้ใช้นี้' }; }
  if (!isActive(user))    { await audit(user, 'login_blocked', { reason: 'Status = Logout' }, meta); return { ok: false, error: 'บัญชีนี้ถูกปิดการใช้งาน' }; }
  if (!await checkPassword(user, password)) {
    await audit(user, 'login_fail', { reason: 'รหัสผ่านไม่ถูกต้อง' }, meta);
    return { ok: false, error: 'รหัสผ่านไม่ถูกต้อง' };
  }
  await audit(user, 'login_ok', {}, meta);
  return { ok: true, user: publicUser(user), token: issueSession(user) };
}

const issueSession = user =>
  issue({ u: user.username, r: user.role }, CFG.SESSION_HOURS * 3600, 'session');

/** ข้อมูลผู้ใช้ที่ส่งออกฝั่งเบราว์เซอร์ได้ (ไม่มีรหัสผ่านเด็ดขาด) */
const publicUser = u => ({
  username: u.username, name: u.name, nickname: u.nickname,
  image: u.image, permission: u.permission, role: u.role,
});

/* ─── 5) SSO ticket — ใช้ตอน Hub เปิดโมดูล ────────────────────────
 *  อายุสั้นมาก (60 วิ) ใช้ได้ครั้งเดียวต่อโมดูล
 *  แทนที่ ?u=<username> เดิมที่ปลอมได้                                */

const issueTicket = (user, moduleKey) =>
  issue({ u: user.username, m: moduleKey }, CFG.SSO_TICKET_SECONDS, 'sso');

function verifyTicket(ticket, moduleKey) {
  const d = verify(ticket, 'sso');
  if (!d) return null;
  if (moduleKey && d.m !== moduleKey) return null;   // โทเคนของโมดูลอื่น ใช้ข้ามไม่ได้
  return d.u;
}

/* ─── 6) Middleware ──────────────────────────────────────────────── */

/** แนบ req.user ถ้ามี session ที่ถูกต้อง (ไม่บล็อกถ้าไม่มี) */
async function attachUser(req, _res, next) {
  req.user = null;
  try {
    const raw = req.cookies && req.cookies[CFG.COOKIE_NAME];
    const data = raw && verify(raw, 'session');
    if (data && data.u) {
      const user = await findUser(data.u);
      // ตรวจ Status ใหม่ทุก request — ปิดบัญชีแล้วต้องเด้งออกทันที ไม่ต้องรอ session หมดอายุ
      if (isActive(user)) req.user = publicUser(user);
    }
  } catch { /* session เสีย = ถือว่าไม่ได้ล็อกอิน */ }
  next();
}

/** บังคับว่าต้องล็อกอิน (+ ระบุบทบาทขั้นต่ำได้) */
function requireLogin(minRole) {
  return (req, res, next) => {
    if (!req.user) {
      if (req.path.startsWith('/api/') || req.xhr)
        return res.status(401).json({ ok: false, error: 'ต้องเข้าสู่ระบบก่อน', code: 'NO_SESSION' });
      return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    }
    if (minRole && !atLeast(req.user.role, minRole)) {
      return res.status(403).json({
        ok: false, code: 'NO_PERMISSION',
        error: `สิทธิ์ไม่พอ — ต้องเป็น ${minRole} ขึ้นไป (คุณคือ ${req.user.role})`,
      });
    }
    next();
  };
}

/* ─── 7) Audit log — บังคับทุกเหตุการณ์สำคัญ ─────────────────────
 *  แอปเดิมไม่มีเลยสักตัว ทำให้ตรวจย้อนหลังไม่ได้ว่าใครทำอะไร        */

async function audit(user, action, detail = {}, meta = {}) {
  try {
    await db.insert(T_AUDIT, {
      at: new Date().toISOString(),
      username: user ? user.username : (detail.username || ''),
      role: user ? user.role : '',
      action,
      module: meta.module || '',
      target: detail.target || '',
      detail: JSON.stringify(detail).slice(0, 2000),
      ip: (meta.ip || '').slice(0, 64),
      ua: (meta.ua || '').slice(0, 300),
    });
  } catch (e) {
    // log พังต้องไม่ทำให้งานหลักพัง (ยกแนวคิดมาจาก _peakLog ในแอป PR)
    console.warn('[audit] เขียน log ไม่สำเร็จ:', e.message);
  }
}

const metaOf = req => ({
  ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
  ua: req.headers['user-agent'] || '',
});

module.exports = {
  issue, verify, issueSession, issueTicket, verifyTicket,
  findUser, isActive, publicUser, login, checkPassword,
  roleOf, atLeast, ROLE_RANK, PERMISSION_ROLE,
  attachUser, requireLogin, audit, metaOf,
  T_USERS, T_AUDIT,
};
