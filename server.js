'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  server.js — ประตูหน้าของระบบ CRM มดงานการป้าย
 *
 *  เส้นทางหลัก
 *    /                  หน้ารวมแอป (Hub)         ต้องล็อกอิน
 *    /login             หน้าเข้าสู่ระบบ
 *    /m/<key>/…         โมดูลแต่ละตัว             ต้องล็อกอิน + มีสิทธิ์
 *    /api/me            ข้อมูลผู้ใช้ปัจจุบัน
 *    /api/modules       รายการโมดูลที่ผู้ใช้เห็น
 *    /api/open/<key>    ขอ SSO ticket เปิดโมดูล
 *    /healthz           ตรวจสุขภาพระบบ (ไม่ต้องล็อกอิน)
 * ═══════════════════════════════════════════════════════════════════ */
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { CFG, assertReady } = require('./core/config');
const db = require('./core/db');
const auth = require('./core/auth');
const registry = require('./core/registry');
const appAccess = require('./core/app-access');
const host = require('./core/module-host');
const sheets = require('./core/sheets');
const sync = require('./core/sync');
const syncJobs = require('./core/sync-jobs');
const mirror = require('./core/sync-mirror');
const sheetFiles = require('./core/sheet-files');

assertReady();
process.env.TZ = CFG.TZ;

/* 🔴 22 ก.ย. 69 (รอบ 81) — กันทั้งระบบล้มเพราะ Promise ตัวเดียวที่ไม่มีใครรับ error
 *   Node 22 ค่าเริ่มต้น: เจอ unhandledRejection = "ปิดโปรเซสทันที"
 *   ⇒ ทุกแอปใน hub ดับพร้อมกัน ทุกคำขอที่ค้างอยู่ได้ "Failed to fetch"
 *     (พี่เอเจอในใบส่งงานช่าง + แถบแดง "โหลดข้อมูลผิดพลาด" ขึ้นพร้อมกัน)
 *   ⇒ จดลง log ให้หาตัวการเจอ แล้ว "ไม่ล้มทั้งระบบ" เพราะ Promise ตัวเดียว
 *   ‼ uncaughtException ยังปิดโปรเซสเหมือนเดิม (สถานะในหน่วยความจำอาจเสียแล้ว
 *     ปล่อยวิ่งต่ออันตรายกว่า) — แต่จด log ก่อนปิดเสมอ Railway จะเปิดใหม่ให้เอง
 *   ‼ ห้าม log ข้อมูลลูกค้า/ช่าง — จดแค่ข้อความ error และ stack */
process.on('unhandledRejection', (reason) => {
  const e = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[กันล้ม] unhandledRejection — ระบบยังวิ่งต่อ:', e.stack || e.message);
});
process.on('uncaughtException', (err) => {
  console.error('[กันล้ม] uncaughtException — ปิดโปรเซสให้ Railway เปิดใหม่:', (err && err.stack) || err);
  setTimeout(() => process.exit(1), 200);
});

const app = express();
app.set('trust proxy', 1);           // Railway อยู่หลัง proxy — ต้องเปิดถึงจะได้ IP จริง
app.disable('x-powered-by');

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(cookieParser());

/* ─── security headers พื้นฐาน ──────────────────────────────────── */
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

/* ─── แนบผู้ใช้จาก session ทุก request ──────────────────────────── */
app.use(auth.attachUser);

/* ─── โหมดบำรุงรักษา ────────────────────────────────────────────── */
app.use((req, res, next) => {
  if (!CFG.MAINTENANCE) return next();
  if (req.path === '/healthz' || req.path === '/login') return next();
  if (req.user && req.user.role === 'ADMIN') return next();
  res.status(503).send('<meta charset="utf-8"><h2 style="font-family:sans-serif;text-align:center;margin-top:80px">🔧 ระบบกำลังปรับปรุง กรุณาลองใหม่อีกครั้ง</h2>');
});

/* ══════════════════ เข้าสู่ระบบ ══════════════════ */

app.get('/login', (req, res) => {
  if (req.user) return res.redirect(req.query.next || '/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const r = await auth.login(username, password, auth.metaOf(req));
    if (!r.ok) return res.status(401).json(r);
    res.cookie(CFG.COOKIE_NAME, r.token, {
      httpOnly: true,                                  // JavaScript ฝั่งหน้าเว็บอ่านไม่ได้
      sameSite: 'lax',                                 // กัน CSRF ข้ามเว็บ
      secure: CFG.NODE_ENV === 'production',           // ส่งเฉพาะ https
      maxAge: CFG.SESSION_HOURS * 3600 * 1000,
      path: '/',
    });
    res.json({ ok: true, user: r.user });
  } catch (e) {
    console.error('[login]', e);
    res.status(500).json({ ok: false, error: 'ระบบขัดข้อง กรุณาลองใหม่' });
  }
});

app.post('/api/logout', async (req, res) => {
  if (req.user) await auth.audit(req.user, 'logout', {}, auth.metaOf(req));
  res.clearCookie(CFG.COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.post('/api/change-password', auth.requireLogin(), async (req, res) => {
  const { current, next } = req.body || {};
  try {
    const u = await auth.findUser(req.user.username);
    if (!await auth.checkPassword(u, current))
      return res.status(400).json({ ok: false, error: 'รหัสผ่านเดิมไม่ถูกต้อง' });
    if (!next || String(next).length < CFG.MIN_PASSWORD)
      return res.status(400).json({ ok: false,
        error: `รหัสผ่านใหม่ต้องยาวอย่างน้อย ${CFG.MIN_PASSWORD} ตัวอักษร` });

    const bcrypt = require('bcryptjs');
    await db.update(auth.T_USERS, { Username: 'eq.' + u.username },
      { PasswordHash: await bcrypt.hash(String(next), 10), Password: null });
    auth.forgetUser(u.username);   // ‼ หลังเขียนเสร็จ
    await auth.audit(req.user, 'change_password', {}, auth.metaOf(req));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══════════════════ Hub ══════════════════ */

app.get('/', auth.requireLogin(), (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'hub.html')));

/* ═══════════════════════════════════════════════════════════════════
 *  🔐 แอป "ซิงค์ข้อมูลจาก Google Sheet" — พี่เอสั่ง 14 ก.ย. 69
 *    "ทุก account ต้องไม่สามารถเปิด app : … ซิงค์ข้อมูลจาก google sheet
 *     ยกเว้น user : admin , namna เท่านั้น"
 *
 *  ‼ แอปนี้ไม่ใช่โมดูลในทะเบียน (ไม่มีโฟลเดอร์ modules/sync)
 *    ⇒ core/module-host.js ไม่ได้ครอบด่านให้ ต้องครอบเองที่นี่ครบทั้ง 2 ชั้น
 *      ② หน้าเว็บ /sync   ③ API ทุกเส้นที่หน้านั้นเรียกใช้
 *  ‼ requireLogin('ADMIN') เดิมยังอยู่ครบไม่ได้ถอด — ของใหม่เป็นด่าน "เพิ่ม"
 *    ⇒ ADMIN คนอื่นที่ไม่ใช่ 2 ชื่อนี้ ผ่านด่านเดิมแต่ตกด่านใหม่
 *  ‼ กติกาอยู่ที่ core/app-access.js ที่เดียว (TOOL_APPS + TOOL_ADMIN_USERS)
 * ═══════════════════════════════════════════════════════════════════ */
const requireSyncApp = appAccess.requireApp('sync');

/* ‼ ต้องประกาศ "ก่อน" ทุกเส้น /api/admin/sync · /api/admin/drive ·
 *   /api/admin/booking-time ข้างล่าง (Express เจอตัวไหนก่อนใช้ตัวนั้น)
 *   🔴 3 prefix นี้คือ API ทั้งหมดที่หน้า public/sync.html เรียกใช้
 *     (ไล่จาก fetch() ในไฟล์นั้นจริง ๆ — และไม่มีหน้าอื่นในระบบเรียกเลย) */
for (const p of ['/api/admin/sync', '/api/admin/drive', '/api/admin/booking-time'])
  app.use(p, requireSyncApp);

/** หน้าจัดการการซิงค์ชีต — แอดมินเท่านั้น (+ ต้องเป็น admin หรือ namna) */
app.get('/sync', auth.requireLogin('ADMIN'), requireSyncApp, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'sync.html')));

app.get('/api/me', auth.requireLogin(), (req, res) =>
  res.json({ ok: true, user: req.user, minPassword: CFG.MIN_PASSWORD,
    /* ‼ การ์ด/ปุ่ม "ซิงก์ข้อมูลจาก Google Sheets" ที่หน้ารวมแอปใช้ค่านี้
     *   🔴 ให้เซิร์ฟเวอร์เป็นคนตัดสินเหมือนการ์ดอื่น — หน้าเว็บห้ามคิดเอง
     *     (เดิมหน้าเว็บเช็ค role === 'ADMIN' เอง ซึ่งใช้กับคำสั่งใหม่ไม่ได้แล้ว) */
    canSync: appAccess.canOpen(req.user, 'sync'),
    /* 🔐 พี่เอสั่ง 17 ก.ย. 69 — การ์ด "Graphic Design Solution" ก็ต้องคุมด้วย
     *   ‼ เดิมหน้ารวมแอปต่อการ์ดใบนี้เข้าไปเองทุกคน ⇒ ทุกสิทธิ์เห็นหมด
     *     ตอนนี้เซิร์ฟเวอร์เป็นคนตัดสิน เหมือนการ์ดอื่นทุกใบ */
    canGraphic: appAccess.canOpen(req.user, 'vectorcnc'),
    /* 🔴 "ห้ามเงียบ" — ค่าสิทธิ์ที่ระบบไม่รู้จัก / ยังไม่ได้กำหนด ต้องขึ้นให้เห็น
     *   null = ปกติ · มีข้อความ = หน้ารวมแอปเอาไปขึ้นแถบเตือน */
    permNotice: appAccess.permNotice(req.user) }));

app.get('/api/modules', auth.requireLogin(), (req, res) => {
  const mods = registry.visibleTo(req.user).map(m => ({
    key: m.key, title: m.title, subtitle: m.subtitle, icon: m.icon,
    color: m.color, status: m.status, path: m.basePath,
    canUse: registry.canUse(req.user, m).ok,
    /* ‼ พี่เอสั่ง 9 ก.ย. 69: "มันไป update version อะไร ระบุไว้ที่หน้า app หลักด้วยนะ"
     *   เลขเวอร์ชันของแอปนั้นเอง + ประวัติย่อว่าแต่ละรอบแก้อะไร */
    version: m.version || '',
    changelog: m.changelog || [],
  }));
  res.json({ ok: true, modules: mods, summary: registry.summary(),
    /* เวอร์ชันของทั้งระบบ ไว้เทียบตอนไล่ปัญหาดีพลอย */
    hub: require('./package.json').version });
});

/**
 * ขอ SSO ticket เพื่อเปิดโมดูล
 * แทนที่ ?u=<username> เดิมที่ปลอมได้ — ตั๋วนี้เซ็นด้วย HMAC อายุ 60 วินาที
 * และผูกกับ "ผู้ใช้คนนี้ + โมดูลนี้" เท่านั้น เอาไปใช้ข้ามโมดูลไม่ได้
 */
app.get('/api/open/:key', auth.requireLogin(), async (req, res) => {
  const mod = registry.get(req.params.key);
  const chk = registry.canUse(req.user, mod);
  if (!chk.ok) return res.status(403).json({ ok: false, error: chk.error });

  await auth.audit(req.user, 'open_module', { target: mod.key },
    { ...auth.metaOf(req), module: mod.key });

  res.json({
    ok: true,
    url: mod.basePath + '/',
    ticket: auth.issueTicket(req.user, mod.key),
    expiresIn: CFG.SSO_TICKET_SECONDS,
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  🔴 ด่านเข้า "แอปนอกระบบ" — Graphic Design Solution (VectorCNC)
 *
 *  ‼ พี่เอสั่ง 13 ก.ย. 69 คำต่อคำ:
 *    "ในส่วนของ app : Graphic design solution ถ้าเป็นคนนอก ไม่ผ่านการ login
 *     ที่ app card CRM HUB จะต้องกดเข้าไปใช้งานไม่ได้นะ จัดการเรื่องนี้ด้วย
 *     ตอนนี้ เอา link https://vectorcnc.onrender.com/ นี้ไปวางใครก็กดเข้าใช้งานได้หมด"
 *
 *  ── 🔴 ความจริงที่ต้องเข้าใจก่อนอ่านโค้ดข้างล่าง ──────────────────
 *    VectorCNC "ไม่ได้อยู่ในเซิร์ฟเวอร์นี้" — คนละโปรเจกต์ (Python)
 *    คนละเครื่อง (Render) คนละโดเมน คนละการล็อกอิน
 *    ⇒ ใส่ด่านที่การ์ดในหน้ารวมแอปอย่างเดียว "กันไม่ได้เลย"
 *      ใครพิมพ์ https://vectorcnc.onrender.com ตรง ๆ ก็ยังเข้าได้อยู่ดี
 *    ⇒ งานนี้แก้ 2 ฝั่ง: ที่นี่ "ออกตั๋ว" · VectorCNC ต้อง "ตรวจตั๋ว"
 *      แพตช์ฝั่งโน้นอยู่ที่ vectorcnc-sso-patch.md (รากโปรเจกต์)
 *      ‼ ถ้ายังไม่ได้เอาแพตช์ไปใส่ ลิงก์ตรงยังเข้าได้เหมือนเดิมทุกประการ
 *
 *  ── ทำไมตั๋วเป็น "ค่าสุ่มทึบ" ไม่ใช่ JWT / ไม่ใช่ auth.issueTicket() ──
 *    ตั๋วใบนี้วิ่งออกไป "นอกบ้าน" ไม่เหมือนตั๋วของ /api/open ที่วิ่งอยู่ในบ้าน
 *    🔴 JWT (และตั๋วของ auth.issue) ถอดอ่านได้ — ชื่อผู้ใช้/สิทธิ์โผล่ให้เห็น
 *      ใครยืน URL ไปดูก็รู้ว่าใครเป็นใคร และเรียกคืนกลางคันไม่ได้
 *    ✅ ค่าสุ่ม 32 ไบต์ "ไม่มีความหมายในตัวเอง" — ต้องเอามาถามที่นี่เท่านั้น
 *      ถึงจะรู้ว่าเป็นของใคร และถามได้ครั้งเดียวภายใน 60 วินาที
 *    ⇒ กฎข้อ 1 ของงานนี้: อีเมล · รหัสผ่าน · คุกกี้ · ข้อมูลลูกค้า
 *      ห้ามออกนอกโดเมนเด็ดขาด สิ่งเดียวที่ออกไปคือค่าสุ่มใบนี้
 * ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const thaiDate = require('./core/thai-date');

const SSO_APP_KEY = 'vectorcnc';      /* แอปนอกระบบใบเดียวที่มีตอนนี้ */
const T_SSO = 'sso_ticket';           /* app.sso_ticket — sql/68-sso-ticket.sql */

/** 🔴 ฐานเก็บแต่ hash — ฐานหลุดก็หยิบตั๋วไปใช้ไม่ได้ (ท่าเดียวกับ PasswordHash) */
const hashTicket = raw => crypto.createHash('sha256').update(String(raw)).digest('hex');

/* 🔴 ล้างข้อความก่อนเข้า log — กฎข้อ 5 ของงานนี้: ห้าม log ค่าตั๋ว/ค่าลับ
 *   ‼ ข้อความ error ของ Supabase แนบ "ค่าที่ทำให้พัง" มาด้วยเสมอ เช่น
 *     Key (ticket_hash)=(3f9c…) already exists  ⇒ hash โผล่เข้า log ทันที
 *   ⇒ ตัดทุกสายอักขระยาว ๆ ที่หน้าตาเป็นค่าสุ่ม/hash/คีย์ ทิ้งให้หมดก่อน
 *     เหลือไว้แต่คำอธิบายที่คนอ่านแล้วไล่ปัญหาต่อได้ */
const ssoSafeMsg = e =>
  String((e && e.message) || e || '').replace(/[A-Za-z0-9_+/=-]{20,}/g, '…').slice(0, 200);

/** ข้อความเวลาตั้งค่าไม่ครบ/ออกตั๋วไม่ได้ — ‼ ห้ามบอกรายละเอียดภายใน */
const ssoSorry = msg =>
  '<meta charset="utf-8"><h2 style="font-family:sans-serif;text-align:center;margin-top:80px">' +
  msg + ' · <a href="/">กลับหน้ารวมแอป</a></h2>';

/**
 * ออกตั๋วแล้วเด้งไป VectorCNC
 * 🔴 ต้องผ่าน requireLogin() เท่านั้น — คนนอกที่ไม่ได้ล็อกอินเด้งไปหน้าล็อกอิน
 *    และ "ไม่มีตั๋วใบไหนถูกสร้างขึ้นมาเลย" (requireLogin จบก่อนถึงบรรทัดแรก)
 */
/* 🔐 พี่เอสั่ง 17 ก.ย. 69 — "Graphic design solution" ถูกใส่เข้าตารางสิทธิ์แล้ว
 *   (เห็นได้เฉพาะ กราฟิค · กราฟิค สาขามดงาน · administrator · sales · sale support)
 *   ‼ ต้องกันที่ "เส้นทางจริง" ไม่ใช่ซ่อนการ์ดอย่างเดียว — คนที่รู้ URL เส้นนี้
 *     จะได้ตั๋วไปเปิดแอปนอกระบบทันทีถ้าไม่มีด่านตรงนี้
 *   ‼ กติกาอยู่ที่ core/app-perms.js ที่เดียว (คีย์แอป = 'vectorcnc') */
const requireGraphicApp = appAccess.requireApp('vectorcnc', 'Graphic Design Solution');

app.get('/api/sso/vectorcnc', auth.requireLogin(), requireGraphicApp, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  /* 🔴 ยังไม่ได้ตั้งค่าลับร่วม = ตรวจตั๋วฝั่งโน้นไม่ได้อยู่ดี ⇒ ปฏิเสธไว้ก่อน
   *   (fail-closed — ไม่ออกตั๋วลอย ๆ ทิ้งไว้ในฐานให้เปลือง) */
  if (!CFG.SSO_SHARED_KEY)
    return res.status(503).send(ssoSorry('ยังเปิดใช้งานแอปนี้ไม่ได้ — ผู้ดูแลระบบยังตั้งค่าไม่ครบ'));

  const raw = crypto.randomBytes(32).toString('base64url');   /* ‼ ≥32 ไบต์ */
  try {
    await db.insert(T_SSO, {
      ticket_hash: hashTicket(raw),          /* 🔴 เก็บ hash ไม่เก็บค่าดิบ */
      app_key: SSO_APP_KEY,
      username: req.user.username,
      role: req.user.role || '',
      /* ‼ เวลาไทยติดเขตเวลา +07:00 ผ่าน core/thai-date.js เท่านั้น
       *   (ห้าม toISOString().slice() ห้ามบวก 7 ชม.เอง — บทเรียนเขตเวลา 4 รอบ) */
      issued_at:  thaiDate.isoTH(),
      expires_at: thaiDate.isoTH(Date.now() + CFG.SSO_TICKET_SECONDS * 1000),
    });
  } catch (e) {
    /* 🔴 ฐานล่ม/เขียนไม่ติด = ยืนยันตัวตนต่อฝั่งโน้นไม่ได้ ⇒ ปฏิเสธ ไม่ใช่ปล่อยผ่าน
     *   ‼ log ได้แค่ "พัง" ห้ามมีค่าตั๋วหรือค่าลับติดไปแม้แต่ตัวเดียว */
    console.error('[sso] ออกตั๋วไม่สำเร็จ:', ssoSafeMsg(e));
    return res.status(503).send(ssoSorry('เปิดแอปไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'));
  }

  /* 🧹 กวาดตั๋วเก่าที่หมดอายุเกิน 1 วัน — ไม่รอผล ไม่ให้ถ่วงการเปิดแอป
   *   (คำสั่งเดียวกับที่เขียนไว้ใน sql/68-sso-ticket.sql · ตั้งใจไม่ทำเป็น trigger) */
  db.remove(T_SSO, { expires_at: 'lt.' + thaiDate.isoTH(Date.now() - 86400000) })
    .catch(() => { /* กวาดไม่ได้ไม่เป็นไร ไม่ใช่งานหลัก */ });

  await auth.audit(req.user, 'open_external', { target: SSO_APP_KEY },
    { ...auth.metaOf(req), module: SSO_APP_KEY });

  /* ‼ query string มีตัวเดียวคือ t=<ค่าสุ่ม> — ไม่มีชื่อผู้ใช้ ไม่มีอีเมล ไม่มีคุกกี้ */
  res.redirect(302, CFG.VECTORCNC_URL + '/sso?t=' + encodeURIComponent(raw));
});

/* ═══════════════════════════════════════════════════════════════════
 *  🏷️ รอบ 157 · เวอร์ชัน + ประวัติอัปเดตของ Graphic Design Solution บนการ์ด
 *  พี่เอสั่ง 27 ก.ย. 69: "ไปแก้ ใน crm hub ให้ app graphic design solution มี version update ด้วย"
 *  ‼ อ่านสดจาก /api/health ของแอปนั้นเอง (core/gds-version.js) — ไม่พิมพ์เลขฝังไว้
 *  ‼ ด่านเดียวกับการ์ด: ต้องล็อกอิน + มีสิทธิ์แอป vectorcnc
 *  ‼ ต่อไม่ติด ⇒ ok:false การ์ดยังกดเข้าแอปได้ตามปกติ
 * ═══════════════════════════════════════════════════════════════════ */
const readGdsVersion = require('./core/gds-version').makeReader({ baseUrl: CFG.VECTORCNC_URL });
/* 🏷️ รอบ 201 — พี่เอสั่ง 1 ต.ค. 69: "ทำเลข version ให้เหมือนกับ app อื่นๆด้วยนะ สำหรับ app graphic design solution"
 *   ⇒ เลขบนการ์ด = เลข 3 ท่อนแบบแอปอื่น (core/gds-app-version.js · โครงกลาง core/app-version.js)
 *   ⇒ ของที่อ่านสดจาก /api/health ย้ายไปอยู่ช่อง live (ขึ้นหัวกล่องประวัติ: เวลา build ที่รันอยู่จริง)
 *   ‼ ไม่ให้การ์ดรอแอปภายนอก: รอสดไม่เกิน 1.2 วิ ช้ากว่านั้นตอบเลขไปก่อน (ตัวอ่านทำงานต่อแล้วจำไว้ 10 นาที) */
const GDS_APP = require('./core/gds-app-version');
const GDS_LIVE_WAIT = 1200;
app.get('/api/graphic-version', auth.requireLogin(), requireGraphicApp, async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  let live = null;
  try {
    let t = null;
    live = await Promise.race([
      readGdsVersion().catch(() => null),
      new Promise(r => { t = setTimeout(() => r(null), GDS_LIVE_WAIT); }),
    ]);
    clearTimeout(t);
  } catch (_) { live = null; }
  res.json({
    ok: true,
    version: GDS_APP.VERSION,
    changelog: GDS_APP.CHANGELOG.map(x => ({ v: String(x[0]), when: String(x[1] || ''), what: String(x[2] || '') })),
    live: (live && live.ok === true)
      ? { ok: true, version: live.version, build: live.build, engine: live.engine, deployed: live.deployed }
      : { ok: false },
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  🎬 รอบ 158 · วิดีโอนำเสนองานออกแบบป้าย (โหมดฟรี) — แอปคู่กับ Graphic Design Solution
 *  พี่เอสั่ง: "แยกส่วนมาทำ app Graphic design solution เพิ่มปุ่ม ให้นำภาพ 3D หรือ 2D
 *    ที่ออกแบบป้ายแล้ว มาสร้างเป็น VDO Presentation ให้ด้วย ใช้โหมดฟรี เหมือนกับ app facade"
 *  ‼ หน้าเว็บ + API = ล็อกอิน + สิทธิ์เดียวกับการ์ด GDS (requireGraphicApp)
 *  ‼ /dv/:tok = ลิงก์ให้ลูกค้าเปิดดู (ไม่ต้องล็อกอิน · สุ่มเดาไม่ได้ · ปิดได้) — ท่าเดียวกับ /pv ของ Facade
 *  ‼ ไฟล์ทั้งหมดอยู่บน Google Drive · ตารางเก็บแค่เลขไฟล์ (sql/design_video_01.sql)
 * ═══════════════════════════════════════════════════════════════════ */
try {
  const DV = require('./core/design-video-router');
  const dvDb = {
    sel: (t, p) => db.select(t, p), one: (t, p) => db.one(t, p),
    ins: (t, r) => db.insert(t, r), upd: (t, p, x) => db.update(t, p, x),
  };
  app.use('/design-video', auth.requireLogin(), requireGraphicApp,
    express.static(path.join(__dirname, 'public', 'design-video'), {
      index: 'index.html',
      setHeaders: (res, fp) => { if (/\.html?$/i.test(fp)) res.setHeader('Cache-Control', 'no-cache, must-revalidate'); },
    }));
  app.use('/api/design-video', auth.requireLogin(), requireGraphicApp, DV.makeRouter(dvDb));
  app.use('/dv', DV.makePublicRouter(dvDb));
} catch (e) {
  console.error('[design-video] ⚠️ ต่อหน้าวิดีโอนำเสนองานออกแบบไม่สำเร็จ:', e.message);
}

/* ═══════════════════════════════════════════════════════════════════
 *  🔴 ตรวจตั๋ว — เส้น "เครื่องคุยกับเครื่อง" (VectorCNC ยิงเข้ามา)
 *
 *  ‼ เส้นนี้ตั้งใจ "ไม่ผ่าน requireLogin" และอยู่ในทะเบียนเส้นสาธารณะ
 *    (tools/test-login-gate.js > PUBLIC_ALLOW) โดยจงใจ
 *    เพราะคนยิงเข้ามาคือ "เซิร์ฟเวอร์ของ VectorCNC" ไม่ใช่เบราว์เซอร์ของคน
 *    ⇒ มันไม่มีคุกกี้ของเรา และไม่มีทางมีได้
 *  ‼ ด่านของเส้นนี้คือ X-SSO-Key แทน — ค่าลับร่วมที่รู้กันแค่ 2 เครื่อง
 *    🔴 เส้นนี้เป็นเส้นเดียวที่เพิ่มเข้าทะเบียนสาธารณะจากงานนี้
 *
 *  ── ค่าเริ่มต้นคือ "ปฏิเสธ" ทุกทาง ─────────────────────────────────
 *    ไม่ได้ตั้งค่าลับ · ไม่ส่งคีย์มา · คีย์ผิด · ไม่มีตั๋ว · ตั๋วหมดอายุ
 *    · ตั๋วเคยใช้แล้ว · ตั๋วของแอปอื่น · ฐานล่ม ⇒ 401 { ok:false } เหมือนกันหมด
 *  ‼ ห้ามบอกว่า "ผิดเพราะอะไร" — ไม่งั้นคนนอกเดาทีละชั้นจนเจอช่อง
 *    (ตั๋วไม่มีจริง กับ ตั๋วหมดอายุ ต้องแยกไม่ออกจากภายนอก)
 * ═══════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════
 *  🔒 ด่าน "ค่าลับร่วม" — ที่เดียวของทั้งระบบ
 *
 *  ‼ เทียบแบบ timing-safe (ท่าเดียวกับ auth.verify) — เทียบด้วย === เฉย ๆ
 *    จะหยุดทันทีที่ตัวอักษรแรกที่ต่าง เวลาที่ใช้จึงบอกใบ้ได้ว่า
 *    "เดาถูกไปกี่ตัวแล้ว" ซึ่งพอเดาไล่ทีละตัวจนครบได้จริง
 *  🔴 ค่าเริ่มต้นคือปฏิเสธ: ไม่ได้ตั้งค่าลับ · ไม่ส่งมา · ยาวไม่เท่ากัน ⇒ false
 *  ‼ 24 ก.ย. 69 (รอบ 94) — แยกออกมาเป็นฟังก์ชันตอนเปิดเส้น price-catalog
 *    เพราะกติกาเดียวกันห้ามมีสองที่ (คัดลอกไปวางแล้วแก้ที่เดียวลืมอีกที่)
 * ═══════════════════════════════════════════════════════════════════ */
function ssoKeyOk(req) {
  const want = String(CFG.SSO_SHARED_KEY || '');
  const got  = String((req && req.headers && req.headers['x-sso-key']) || '');
  if (!want || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/api/sso/verify', async (req, res) => {
  const deny = () => res.status(401).json({ ok: false });
  res.setHeader('Cache-Control', 'no-store');
  try {
    /* ── ด่านที่ 1: ค่าลับร่วม ───────────────────────────────────── */
    if (!ssoKeyOk(req)) return deny();

    /* ── ด่านที่ 2: ตัวตั๋ว ────────────────────────────────────────── */
    const raw = (req.body && req.body.ticket) || '';
    if (typeof raw !== 'string' || raw.length < 16 || raw.length > 400) return deny();

    /* 🔴 ตรวจ + ทำเครื่องหมายว่าใช้แล้ว "ในคำสั่งเดียว" (atomic)
     *   UPDATE ... WHERE used_at IS NULL AND expires_at > now() RETURNING *
     *   ⇒ ยิงพร้อมกันสิบครั้ง ก็มีครั้งเดียวที่ได้แถวกลับมา ที่เหลือได้อาเรย์ว่าง
     *   ‼ ถ้าแยกเป็น SELECT ก่อนแล้วค่อย UPDATE จะมีช่องให้ใช้ตั๋วซ้ำได้จริง */
    const rows = await db.update(T_SSO, {
      ticket_hash: 'eq.' + hashTicket(raw),
      app_key:     'eq.' + SSO_APP_KEY,
      used_at:     'is.null',                              /* ยังไม่เคยใช้ */
      expires_at:  'gt.' + thaiDate.isoTH(),               /* ยังไม่หมดอายุ */
    }, {
      used_at: thaiDate.isoTH(),
      used_ip: (auth.metaOf(req).ip || '').slice(0, 64),
    });

    if (!Array.isArray(rows) || rows.length !== 1) return deny();

    /* ‼ ส่งกลับแค่ "ใครเป็นใคร" เท่าที่ VectorCNC ต้องใช้เปิดเซสชันของตัวเอง
     *   ไม่มีอีเมล ไม่มีรหัสผ่าน ไม่มีคุกกี้ของเรา ไม่มีข้อมูลลูกค้า
     *   และไม่มี SSO_SHARED_KEY สะท้อนกลับไปแม้แต่ตัวเดียว */
    return res.json({ ok: true, username: rows[0].username, role: rows[0].role || '' });
  } catch (e) {
    /* 🔴 ฐานล่ม / ตอบช้า / ตอบ error ⇒ ปฏิเสธ ห้าม fail-open
     *   ‼ log ได้แค่ "พัง" — ห้ามมีค่าตั๋วหรือค่าลับติดไป */
    console.warn('[sso] ตรวจตั๋วไม่สำเร็จ — ปฏิเสธไว้ก่อน:', ssoSafeMsg(e));
    return deny();
  }
});

/* ═══════════════════════════════════════════════════════════════════
 *  📤 GET /api/sso/price-catalog — ตารางราคาชุดเดียวกับแอปประเมินราคา
 *
 *  ‼ พี่เอสั่ง 24 ก.ย. 69 คำต่อคำ:
 *    "ตรวจสอบฐานข้อมูลของ app Graphic design solution ในส่วนของการประเมิน
 *     ราคาด้วย ว่าไปเอาข้อมูลอะไรจากไหนมาประเมินราคา ตอนนี้ พี่ต้องการให้
 *     ปรับฐานข้อมูลประเมินราคาเป็น ฐานข้อมูลชุดเดียวกันกับ app ประเมินราคานะ"
 *
 *  ⇒ ของเดิม Graphic Design Solution ฝังตารางราคาไว้ในโค้ดของตัวเอง
 *    (vectorcnc/price_catalog.py — 135 รายการ ราคาตรงกันแต่ไม่รู้เรื่องส่วนลด)
 *    ⇒ เปิดประตู "อ่านอย่างเดียว" ให้มันดึงของจริงไปใช้ ที่เดียวทั้งบริษัท
 *
 *  ── 🔒 ด่านของเส้นนี้ ────────────────────────────────────────────
 *   ‼ เส้นนี้อยู่นอกด่านล็อกอิน "โดยตั้งใจ" ท่าเดียวกับ /api/sso/verify
 *     เพราะคนยิงเข้ามาคือ "เซิร์ฟเวอร์ของ VectorCNC" ไม่ใช่เบราว์เซอร์ของคน
 *     มันไม่มีคุกกี้ของเรา และไม่มีทางมีได้
 *   ⇒ ด่านคือ X-SSO-Key ค่าลับร่วมตัวเดิม (ไม่ได้สร้างกุญแจใหม่)
 *   🔴 อ่านอย่างเดียว · ไม่มีชื่อคน · ไม่มีข้อมูลลูกค้า · ไม่มีค่าลับสะท้อนกลับ
 *   🔴 ราคาที่ส่งออกเป็น "ราคาหลังลด" เหมือนที่แอปประเมินราคาใช้จริง
 *     พร้อมราคาก่อนลดติดไปด้วยทุกรายการ เพื่อให้ตรวจย้อนได้
 * ═══════════════════════════════════════════════════════════════════ */
app.get('/api/sso/price-catalog', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!ssoKeyOk(req)) return res.status(401).json({ ok: false });
  try {
    const feed = await require('./modules/appraisal/pricefeed').priceFeed();
    return res.json(Object.assign({ ok: true }, feed));
  } catch (e) {
    /* 🔴 ส่งราคามั่ว ๆ ออกไปอันตรายกว่าไม่ส่ง ⇒ ปฏิเสธ ห้าม fail-open
     *   ‼ log ได้แค่ "พัง" ห้ามมีค่าลับติดไป */
    console.error('[pricefeed] ส่งตารางราคาไม่สำเร็จ:', ssoSafeMsg(e));
    return res.status(503).json({ ok: false, error: 'ตารางราคายังไม่พร้อมใช้งาน' });
  }
});


/* ═══════════════════════════════════════════════════════════════════
 *  🤝 รอบ 222 — จุดรับ lead จากฐาน Supabase "มดงานการป้าย Affiliate"
 *
 *  พี่เอสั่ง 3 ต.ค. 69: "ดึงข้อมูล เข้ามาสร้าง leads ใน app คีย์ยอดขาย แบบ auto
 *  ทันทีที่มีรายการใหม่ หรือมีการแก้ไขจาก database ก้อนนี้"
 *
 *  ‼ POST /hook/affiliate/lead อยู่นอกด่านล็อกอิน "โดยตั้งใจ" (ท่าเดียวกับ /api/sso/verify)
 *    คนยิงคือฐานข้อมูลของ Affiliate — ด่านคือรหัสลับร่วม AFFILIATE_WEBHOOK_SECRET
 *    ไม่ตั้งรหัสลับ = ปฏิเสธทุกคำขอ · ตรรกะทั้งหมดอยู่ที่ modules/sales/affiliate*.js
 *  ‼ ห่อ try — ไฟล์โมดูลมีปัญหาต้องไม่ทำให้ทั้งระบบบูตไม่ขึ้น
 * ═══════════════════════════════════════════════════════════════════ */
try {
  require('./modules/sales/affiliate-hook').install(app);
} catch (e) {
  console.warn('[affiliate] ติดตั้งจุดรับ lead ไม่สำเร็จ:', e.message);
}

/* ══════════════════ ตรวจสุขภาพระบบ ══════════════════ */

app.get('/healthz', async (_req, res) => {
  // ‼ ต้องส่ง hint/error ออกมาด้วย ไม่งั้นรู้แค่ว่า "พัง" แต่ไม่รู้ว่าพังเพราะอะไร
  let p = { ok: false, ms: 0, hint: 'เรียก db.ping() ไม่สำเร็จ' };
  try { p = await db.ping(); } catch (e) { p.error = String((e && e.message) || e).slice(0, 300); }
  res.json({
    ok: p.ok, uptime: Math.round(process.uptime()),
    db: p,
    /* ═══════════════════════════════════════════════════════════════════
     *  🔴 14 ก.ย. 69 — ส่องชั้นกันฐานโดนถล่มจาก "สัญญาณออนไลน์"
     *
     *  เปิด /healthz แล้วดูได้เลยว่าชั้นนี้ทำงานอยู่จริงไหม โดยไม่ต้องเดา:
     *    cacheMs / minWriteMs  ค่าที่ใช้อยู่จริง (ตั้งผ่าน env บน Railway)
     *    hit + join            จำนวนครั้งที่ "ไม่ต้องแตะฐาน" เพราะแคช
     *    miss                  จำนวนครั้งที่อ่านฐานจริง
     *    skipped               heartbeat ที่ถูกรวบไว้ ไม่ได้เขียนลงฐาน
     *    wrote                 heartbeat ที่เขียนลงฐานจริง
     *  ‼ ตัวเลขล้วน ๆ ไม่มีชื่อคน ไม่มีข้อมูลส่วนบุคคล — เปิดสาธารณะได้
     *  ‼ hit ค้างที่ 0 ทั้งที่มีคนใช้งาน = ชั้นนี้ถูกปิดอยู่ (env ถูกตั้งเป็น 0)
     * ═══════════════════════════════════════════════════════════════════ */
    presence: require('./core/presence-cache').stats(),
    modules: registry.summary(),
    version: require('./package.json').version,
  });
});


/* ══════════════════ ซิงค์จาก Google Sheets (ทางเดียว) ══════════════════
 *  ช่วงใช้ 2 ระบบคู่กัน: ทีมยังคีย์ในแอปเดิม → ลงชีต → ระบบนี้ดึงมาเป็นกระจก
 *  ไม่มี endpoint ไหนเขียนกลับชีตเลย และ core/sheets.js ขอสิทธิ์ readonly ไว้แล้ว */

let _syncing = false;
/* ‼ ธงสั่งหยุด — พี่เอสั่ง 6 ก.ย. 69:
 *   'ทำปุ่มให้หยุดได้ด้วย ไม่ต้องทำอะไรกันเลย มานั่งรอมันเสียเวลา'
 *   ‼ หยุดแบบ 'บอกให้เลิก' ไม่ใช่ 'ฆ่าทิ้ง' — งานจะหยุดที่จุดปลอดภัย
 *     แล้วปิดสถานะให้เรียบร้อย ไม่ทิ้งแถวค้างเหมือนตอนโดนตัดเพราะหมดเวลา */
let _stopSync = false;
let _discovering = false;      // ประกาศไว้ตรงนี้คู่กัน — สองตัวนี้ต้องไม่ทำงานพร้อมกัน
let _syncSince = 0;            // เวลาที่รอบปัจจุบันเริ่ม — ไว้ปลดล็อกที่ค้าง

/* ═══════════════════════════════════════════════════════════════════
 *  ‼ ล็อกต้องมีวันหมดอายุ ไม่งั้นค้างครั้งเดียว = ตายตลอดกาล
 *
 *  บั๊กจริง 5 ก.ย. 69 (พี่เอเจอ): งาน "คีย์ยอดขาย" ค้างเป็น "กำลังทำอยู่"
 *  แล้วรอบตามเวลาทุกรอบหลังจากนั้นถูกปฏิเสธด้วย "มีรอบซิงค์ค้างอยู่"
 *  พี่เอแก้ข้อมูลในชีตแล้วไม่เข้าฐานข้อมูลเลยสักรอบ — เพราะล็อกตัวนี้
 *
 *  แก้ที่ต้นเหตุแล้ว (ใส่เวลาหมดอายุให้ทุกคำขอใน core/sheets.js กับ core/db.js)
 *  แต่ยังต้องมีตาข่ายรับไว้ชั้นสอง: ถ้ารอบไหนนานเกินเพดาน ให้ปลดล็อกทิ้ง
 *  ดีกว่าปล่อยให้ระบบเงียบไปทั้งวันโดยไม่มีใครรู้
 * ═══════════════════════════════════════════════════════════════════ */
const SYNC_LOCK_MAX_MS = Number(process.env.SYNC_LOCK_MAX_MS || 25 * 60 * 1000);

/* เพดานเวลาของ "งานซิงค์หนึ่งงาน" — เกินนี้ถือว่างานนั้นพัง แล้วทำงานถัดไปต่อ */
const JOB_MAX_MS = Number(process.env.SYNC_JOB_MAX_MS || 8 * 60 * 1000);

/* ตรรกะจริงอยู่ที่ core/guard.js — แยกออกไปเพื่อให้เขียนเทสต์ได้
 * (require server.js ในเทสต์ไม่ได้ เพราะมันเปิดพอร์ตทันที) */
const { withCap } = require('./core/guard');

/** ล็อกค้างเกินเพดานไหม — ถ้าใช่ ปลดให้แล้วคืน true */
function lockStuck() {
  if (!_syncing) return false;
  if (Date.now() - _syncSince < SYNC_LOCK_MAX_MS) return false;
  console.warn(`[sync] ‼ ล็อกค้างเกิน ${Math.round(SYNC_LOCK_MAX_MS / 60000)} นาที — ปลดล็อกให้รอบใหม่ทำงานต่อ`);
  _syncing = false;
  return true;
}

/**
 * ปิดรอบใน app.sync_run ที่ค้างไว้เกินเพดาน
 *
 * ‼ ถ้าไม่ปิด หน้าจอจะขึ้น "⏳ กำลังทำอยู่" ค้างตลอดกาล
 *   ทั้งที่งานนั้นตายไปแล้ว — พี่เอเห็นแล้วเข้าใจว่าระบบยังทำงานอยู่
 *   ทั้งที่จริงมันหยุดไปนานแล้ว นี่คือหน้าจอโกหก ต้องไม่มี
 */
async function closeStaleRuns() {
  const cut = new Date(Date.now() - (JOB_MAX_MS + 60000)).toISOString();
  try {
    const r = await db.update('sync_run',
      { finished_at: 'is.null', started_at: 'lt.' + cut },
      { finished_at: new Date().toISOString(), ok: false,
        error: 'รอบนี้ค้างเกินเวลา ระบบปิดให้อัตโนมัติ — กดซิงค์ใหม่ได้เลย' });
    const n = Array.isArray(r) ? r.length : 0;
    if (n) console.log(`[sync] ปิดรอบที่ค้างเกินเวลา ${n} รอบ`);
  } catch { /* ยังไม่มีตารางก็ไม่เป็นไร */ }
}

/** สั่งซิงค์ทุกงานทีละตัว — กันไม่ให้ทับซ้อนกันเอง
 *
 *  ‼ manual = true คือ "พี่เอกดปุ่มเอง" — ทำครบทุกงาน
 *    manual = false คือ รอบตามเวลา — ข้ามงานที่ตั้ง manualOnly ไว้
 *
 *  ทำไมต้องมี: งาน "คีย์ยอดขาย" บันทึกลง Supabase ที่เดียวแล้ว
 *  ถ้ารอบตามเวลายังดึงชีตมาทับ แถวที่เพิ่งคีย์ใหม่จะถูกลบทิ้ง
 *  (การซิงค์ถือว่าชีตคือของจริง แถวไหนไม่มีในชีต = ลบ)
 *  แต่ห้ามตัดงานนี้ทิ้ง เพราะพี่เอยังต้องกดซิงค์เองตอนเทสข้อมูล
 */
async function runAllSync(by, opt = {}) {
  const manual = opt.manual === true;

  /* ═══════════════════════════════════════════════════════════════
   *  🔒 ด่านที่ ① — บนสุดของทางเข้าเดียวที่ทุกการซิงก์ต้องผ่าน
   *
   *  🗣 พี่เอสั่งคำต่อคำ 17 ก.ย. 69:
   *    "พี่สั่งเราเลยนะ ห้ามไป sync data ใดๆ ใน google sheet เข้ามาอีกแล้วนะ
   *     ทำบน supabase 100% เคลียร์เรื่องนี้ให้ตรงกันก่อน"
   *
   *  ‼ วางไว้ "ก่อน lockStuck / closeStaleRuns / _syncing" โดยตั้งใจ
   *    โหมด off ต้องไม่แตะฐานข้อมูลแม้แต่คำขอเดียว ไม่ตั้งล็อก ไม่เปิดรอบ
   *    ⇒ ตอบกลับทันที ไม่มีผลข้างเคียงอะไรทั้งสิ้น
   *
   *  ‼ ด่านนี้ไม่ดู manual — ทางที่หลุดมาแล้วในอดีตคือทางที่ "มีข้อยกเว้นให้"
   *    (ตัวกู้คืนหลังรีสตาร์ทยิงด้วย manual: true ซึ่งข้าม manualOnly ไปทั้งหมด)
   * ═══════════════════════════════════════════════════════════════ */
  if (syncJobs.syncMode() === 'off') {
    console.log(`[sync] 🔒 ปฏิเสธรอบ "${by || 'ตามเวลา'}" — SHEET_SYNC=off`);
    return { ok: false, blocked: true, error: syncJobs.SYNC_OFF_MSG };
  }

  lockStuck();
  await closeStaleRuns();
  if (_syncing) return { ok: false, error: 'มีรอบซิงค์ค้างอยู่ กรุณารอสักครู่' };
  /* ‼ ห้ามชนกับการสำรวจ — ทั้งคู่ยิง Google API รัว ๆ พร้อมกันแล้วเน็ตสะดุด
   *   (4 ก.ย. 69: กดสำรวจตอนรอบตามเวลากำลังทำ → ล้มรวด 7 งาน 'fetch failed') */
  if (_discovering) return { ok: false, error: 'กำลังสำรวจแท็บอยู่ รอให้จบก่อนแล้วค่อยซิงค์' };
  let list = syncJobs.jobs();
  /* ‼ ทำเฉพาะงานที่ระบุ — ใช้ตอน "กู้คืนหลังรีสตาร์ท" และปุ่ม "ลองใหม่เฉพาะที่ล้มเหลว"
   *   ไม่งั้นต้องลากงานที่เพิ่งสำเร็จมาทำใหม่ทั้งยวง เสียเวลาเป็นสิบนาทีโดยเปล่าประโยชน์ */
  if (Array.isArray(opt.only) && opt.only.length) {
    const want = new Set(opt.only);
    list = list.filter(j => want.has(j.name));
  }
  if (!list.length) return { ok: false, error: 'ยังไม่ได้ตั้งค่า SHEET_*_ID ใน Railway > Variables' };
  if (!sheets.isConfigured()) return { ok: false, error: 'ยังไม่ได้ตั้งค่า GOOGLE_SA_JSON' };

  _syncing = true;
  _syncSince = Date.now();
  const results = [];
  try {
    for (const job of list) {
      const log = (...a) => console.log(`[sync:${job.name}]`, ...a);
      /* ‼ งานหนึ่งค้าง ต้องไม่ลากงานที่เหลือค้างตามไปด้วย
       *   เดิมงาน "คีย์ยอดขาย" อยู่ตัวแรก พอมันค้าง อีก 8 งานก็ไม่ได้ทำเลย */
      /* ‼ ถูกสั่งหยุดแล้ว ไม่ต้องเริ่มงานที่เหลือ */
      if (_stopSync) { results.push({ name: job.name, title: job.title, ok: false,
        error: 'หยุดตามคำสั่ง — ยังไม่ได้เริ่มงานนี้' }); continue; }
      /* ═══════════════════════════════════════════════════════════
       *  🔒 ด่านที่ ② — ต่องานต่องาน ชั้นในสุด ตรงที่จะยิง Google จริง ๆ
       *
       *  ‼ ทำไมต้องมีทั้งที่ด่าน ① กรองแล้ว: ด่าน ① ตอบเฉพาะโหมด off
       *    โหมด phase1 ยังปล่อยรอบให้เดินต่อ (กลุ่ม A 11 งานต้องทำได้)
       *    ⇒ ตัวที่ตัดสินว่า "งานนี้ใช่กลุ่ม A ไหม" ต้องอยู่ตรงนี้
       *      ไม่ใช่ที่ปุ่ม ไม่ใช่ที่หน้าจอ — ใครเรียก runAllSync ทางไหนก็โดน
       *
       *  ‼ ไม่กรองงานทิ้งเงียบ ๆ — จดลง results ว่า blocked พร้อมเหตุผล
       *    หน้า /sync จะได้บอกได้ว่า "ถูกปิด" ไม่ใช่ "หายไปเฉย ๆ"
       * ═══════════════════════════════════════════════════════════ */
      if (!syncJobs.syncAllowed(job.name)) {
        results.push({ name: job.name, title: job.title, ok: true, skipped: true,
          blocked: true, note: syncJobs.syncBlockReason(job.name) });
        log('🔒 ข้าม — ปิดการซิงก์จากชีตแล้ว');
        continue;
      }
      /* ‼ งานที่ตั้งไว้ว่า "กดเองเท่านั้น" — รอบตามเวลาต้องไม่แตะ */
      if (job.manualOnly && !manual) {
        results.push({ name: job.name, title: job.title, ok: true, skipped: true,
          note: job.manualNote || 'ตั้งไว้ให้กดเองเท่านั้น — รอบตามเวลาข้ามงานนี้' });
        log('ข้าม (กดเองเท่านั้น)');
        continue;
      }
      const shouldStop = () => _stopSync;
      const r = await withCap(
        job.run ? job.run({ ...job, log, shouldStop })
                : sync.syncSheet({ ...job, log, shouldStop }),
        JOB_MAX_MS, job.title || job.name);

      /* ═══════════════════════════════════════════════════════════
       *  ‼ บั๊กจริง 6 ก.ย. 69 (พี่เอเจอ): "ตอนนี้ยัง sync Totalsales
       *    ไม่เสร็จเลย เกิดอะไรขึ้น" — งานอื่นเสร็จหมด เหลือตัวนี้ค้าง
       *
       *  สาเหตุที่หลอกตามาก: TotalSales อยู่ "ตัวแรก" ของลิสต์
       *  ถ้ามันค้างจริง งานที่เหลือจะไม่ได้ทำเลย — แต่งานอื่นเสร็จหมด
       *  แปลว่ามันไม่ได้ค้างอยู่ มันถูก withCap ตัดไปแล้วต่างหาก
       *
       *  ‼ withCap ตัดแค่ "การรอ" ไม่ได้หยุดงานที่วิ่งอยู่ข้างใน
       *    แถวใน sync_run ที่ syncSheet เปิดไว้จึงไม่มีใครปิด
       *    → หน้าจอขึ้น "กำลังทำอยู่" ค้างตลอดกาล ทั้งที่ระบบเดินต่อไปแล้ว
       *    → และที่แย่กว่า: งานนี้ไม่เคยซิงค์สำเร็จเลยสักรอบ
       *      พี่เอแก้ข้อมูลในชีตแล้วไม่เข้าฐานข้อมูลจริง ๆ ไม่ใช่แค่ช้า
       *
       *  ‼ ตัดแล้วต้องปิดแถวให้เรียบร้อย พร้อมบอกสาเหตุตรง ๆ
       *    หน้าจอที่บอกว่า "กำลังทำ" ทั้งที่เลิกทำไปแล้ว คือหน้าจอโกหก
       * ═══════════════════════════════════════════════════════════ */
      if (r && r.timedOut) {
        console.warn(`[sync:${job.name}] ‼ เกินเพดาน ${Math.round(JOB_MAX_MS / 60000)} นาที — ปิดแถวที่ค้างไว้`);
        await db.update('sync_run',
          { source: 'eq.' + job.name, finished_at: 'is.null' },
          { finished_at: new Date().toISOString(), ok: false,
            error: `งานนี้ใช้เวลาเกินเพดาน ${Math.round(JOB_MAX_MS / 60000)} นาที ` +
                   'ระบบจึงตัดทิ้งเพื่อไปทำงานถัดไป — ข้อมูลรอบนี้ยังไม่เข้า' })
          .catch(() => {});
      }
      results.push({ name: job.name, title: job.title, ...r });
    }

    /* ‼ กระจกไม่ได้อยู่ในรอบนี้โดยตั้งใจ
     *
     *   สำรวจแล้วเจอของจริง 181 แท็บ · ใหญ่สุด ProductionLogs 72,934 แถว
     *   รวมกันหลายแสนแถว ถ้าดึงพ่วงมากับรอบ 10 นาที จะไม่มีทางจบสักรอบ
     *   แถมทำให้ตารางจริงที่คนใช้งานอยู่ (ยอดขาย · Projects) พลอยช้าไปด้วย
     *
     *   กระจกจึงมีจังหวะของตัวเอง — ดูฟังก์ชัน runMirrorSync ข้างล่าง */
  } finally { _syncing = false; _stopSync = false; }

  console.log(`[sync] จบรอบ (${by || 'ตามเวลา'}) — ` +
    results.map(r => `${r.name}:${r.ok ? 'ok' : 'พัง'}`).join(' · '));
  return { ok: results.every(r => r.ok), results };
}

/**
 * ดึงกระจกของแท็บที่เหลือ — จังหวะของตัวเอง ไม่พ่วงกับตารางจริง
 *
 * เรียงจากแท็บเล็กไปใหญ่ (mirrorJobs เรียงตามขนาด) แล้วมี budget เวลา
 * ทำได้เท่าไรเอาเท่านั้น รอบหน้าค่อยทำต่อ — ดีกว่าล้มทั้งรอบเพราะทำไม่ทัน
 */
async function runMirrorSync(by, budgetMs) {
  /* 🔒 ด่านเดียวกับ runAllSync — กระจกก็คือการดึงข้อมูลจากชีตเข้ามา
   *   ไม่มีงานกระจกงานไหนอยู่ในกลุ่ม A ⇒ เปิดได้เฉพาะโหมด on */
  if (syncJobs.syncMode() !== 'on') {
    console.log(`[กระจก] 🔒 ปฏิเสธรอบ "${by || 'ตามเวลา'}" — SHEET_SYNC=${syncJobs.syncMode()}`);
    return { ok: false, blocked: true, error: syncJobs.SYNC_OFF_MSG };
  }
  lockStuck();
  if (_syncing) return { ok: false, error: 'มีรอบซิงค์ตารางจริงอยู่ รอให้จบก่อน' };
  if (_discovering) return { ok: false, error: 'กำลังสำรวจแท็บอยู่ รอให้จบก่อน' };
  if (!sheets.isConfigured()) return { ok: false, error: 'ยังไม่ได้ตั้งค่า GOOGLE_SA_JSON' };

  const jobs = await mirror.mirrorJobs().catch(e => {
    console.log('[กระจก] อ่านทะเบียนแท็บไม่ได้ (ยังไม่ได้กดสำรวจ?):', e.message);
    return [];
  });
  if (!jobs.length)
    return { ok: false, error: 'ยังไม่มีทะเบียนแท็บ — กด "สำรวจทุกแท็บ" ก่อน' };

  _syncing = true;
  _syncSince = Date.now();
  const t0 = Date.now();
  const budget = budgetMs || 20 * 60 * 1000;      // 20 นาทีต่อรอบ
  const results = [];
  let stopped = null;
  try {
    for (const job of jobs) {
      if (Date.now() - t0 > budget) {
        stopped = `หมดเวลาที่ให้ไว้ (${Math.round(budget / 60000)} นาที) — ` +
                  `ทำไป ${results.length} จาก ${jobs.length} แท็บ รอบหน้าทำต่อ`;
        break;
      }
      const log = (...a) => console.log(`[${job.name}]`, ...a);
      const r = await mirror.syncTab({ ...job, log });
      results.push({ name: job.name, title: job.title, mirror: true, ...r });
    }
  } finally { _syncing = false; }

  console.log(`[กระจก] จบรอบ (${by || 'ตามเวลา'}) — ทำ ${results.length}/${jobs.length} แท็บ`);
  return { ok: results.every(r => r.ok), total: jobs.length, done: results.length,
           note: stopped, results };
}

/* ═══════════════════════════════════════════════════════════════════
 *  🔒 ด่านที่ ③ — ฝั่งเซิร์ฟเวอร์ของปุ่มบนหน้า /sync
 *
 *  ‼ ปิดปุ่มบนหน้าจออย่างเดียวไม่นับว่าปิด
 *    ใครเปิด DevTools แล้วยิง POST /api/admin/sync ตรง ๆ ก็ซิงก์ได้อยู่ดี
 *    (แอดมินทุกคนยิงได้ ไม่ใช่แค่พี่เอ) ⇒ ด่านจริงต้องอยู่ฝั่งนี้
 *
 *  ‼ เส้นที่ "ดึงข้อมูลเข้า" เท่านั้นที่โดน:
 *      POST /api/admin/sync · /sync/one · /sync/retry-failed · /sync/mirror
 *    เส้นที่ "อ่านอย่างเดียว" ไม่โดนสักเส้น — พี่เอสั่งให้เก็บไว้ใช้ได้ปกติ:
 *      GET /api/admin/sync (สถานะ) · /sync/check (ตรวจการเชื่อมต่อ) ·
 *      /sync/peek (ดูหัวตาราง) · POST /sync/discover (สำรวจแท็บ — อ่านชื่อแท็บ
 *      ไม่ได้ดึงข้อมูลเข้าตารางจริง)
 * ═══════════════════════════════════════════════════════════════════ */

/** ตอบปฏิเสธเป็นภาษาคน — ใช้ร่วมกันทุกเส้นที่ดึงข้อมูลเข้า */
function denySheetPull(res, reason) {
  return res.status(403).json({ ok: false, blocked: true,
    sheetSync: syncJobs.syncMode(),
    error: reason || syncJobs.SYNC_OFF_MSG });
}

app.post('/api/admin/sync/mirror', auth.requireLogin('ADMIN'), async (req, res) => {
  /* 🔒 กระจกคือการ "ดึงทุกแท็บที่เหลือเข้ามาที่ app.sheet_rows" = ดึงข้อมูลเข้าเต็มตัว
   *   ไม่มีงานกระจกงานไหนอยู่ในกลุ่ม A ⇒ เปิดได้เฉพาะโหมด on (ไว้ถอยกลับ) */
  if (syncJobs.syncMode() !== 'on')
    return denySheetPull(res, syncJobs.SYNC_OFF_MSG + ' · ปุ่ม "ดึงกระจก" ถูกปิดด้วย');
  lockStuck();
  if (_syncing || _discovering)
    return res.status(409).json({ ok: false, error: 'มีงานอื่นทำอยู่ รอให้จบก่อน' });
  const user = req.user;
  res.status(202).json({
    ok: true, started: true,
    message: 'เริ่มดึงกระจกแล้ว — แท็บเยอะและใหญ่ ใช้เวลานาน ดูความคืบหน้าที่ตารางข้างล่าง',
  });
  runMirrorSync(user.username)
    .then(r => auth.audit(user, 'sync_mirror', { target: 'แท็บที่เหลือ', ok: r.ok }, auth.metaOf(req)))
    .catch(e => console.error('[กระจก] ล้มเหลว:', e));
});

app.get('/api/admin/sync', auth.requireLogin('ADMIN'), async (_req, res) => {
  try {
    res.json({
      ok: true,
      running: _syncing,
      runningSince: _syncing ? new Date(_syncSince).toISOString() : null,
      configured: sheets.isConfigured(),
      everyMin: CFG.SYNC_EVERY_MIN,
      /* 🔒 สถานะด่านปิดซิงก์ — หน้า /sync ใช้ตัดสินว่าปุ่มไหนกดได้ (17 ก.ย. 69)
       *   ‼ ส่งมาจากเซิร์ฟเวอร์ ไม่ให้หน้าเว็บเดาเอง — หน้าเว็บกับเซิร์ฟเวอร์
       *     ต้องเห็นตรงกันเสมอ ไม่งั้นปุ่มเปิดอยู่แต่กดแล้วโดนปฏิเสธ (หรือกลับกัน) */
      sheetSync: syncJobs.syncMode(),
      sheetSyncMsg: syncJobs.SYNC_OFF_MSG,
      phase1Note: syncJobs.PHASE1_NOTE,
      jobs: syncJobs.jobs().map(j => ({ name: j.name, title: j.title, table: j.table, tab: j.tab,
        manualOnly: !!j.manualOnly, manualNote: j.manualNote || null,
        blocked: !syncJobs.syncAllowed(j.name),
        phase1: syncJobs.PHASE1_JOBS.includes(j.name) })),
      status: await sync.status(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * สั่งซิงค์ — ตอบกลับทันที แล้วทำงานต่อเบื้องหลัง
 *
 * ‼ ห้ามถือคำขอไว้จนซิงค์เสร็จ
 *   Railway ตัดคำขอที่นานเกินกำหนดแล้วส่งข้อความล้วน "upstream error" กลับมา
 *   เบราว์เซอร์พยายามอ่านเป็น JSON → "Unexpected token 'u'"
 *   ทั้งที่เบื้องหลังยังซิงค์อยู่ดี ๆ — ผู้ใช้เห็นแค่ error งง ๆ
 *
 *   ของจริงใช้เวลาหลายนาที (ห้าหมื่นกว่าแถวจาก 9 แท็บ)
 *   จึงตอบ 202 ทันที แล้วให้หน้าเว็บถามความคืบหน้าจาก GET /api/admin/sync แทน
 */
/* ═══════════════════════════════════════════════════════════════════
 *  ‼ ปุ่มหยุดซิงค์ — พี่เอสั่ง 6 ก.ย. 69:
 *    "ทำปุ่มให้หยุดได้ด้วย ไม่ต้องทำอะไรกันเลย มานั่งรอมันเสียเวลา"
 *
 *  ‼ หยุดแบบ "บอกให้เลิก" ไม่ใช่ "ฆ่ากลางคัน"
 *    งานจะหยุดที่จุดปลอดภัยจุดถัดไป แล้วปิดสถานะให้เรียบร้อย
 *    ถ้าฆ่าดื้อ ๆ จะเหลือแถวค้าง "กำลังทำอยู่" แบบที่เพิ่งแก้ไป
 *
 *  ‼ หยุดตอนยังอ่านชีตไม่ครบ = ไม่เขียนอะไรลงฐานข้อมูลเลย
 *    เพราะระบบจะเข้าใจผิดว่าแถวที่ยังอ่านไม่ถึงคือ "ถูกลบจากชีต" แล้วลบตาม
 * ═══════════════════════════════════════════════════════════════════ */
app.post('/api/admin/sync/stop', auth.requireLogin('ADMIN'), async (req, res) => {
  if (!_syncing && !_reindexing)
    return res.json({ ok: true, note: 'ไม่มีงานที่กำลังทำอยู่' });
  _stopSync = true;
  console.warn(`[sync] ‼ ${req.user.username} สั่งหยุด — จะหยุดที่จุดปลอดภัยจุดถัดไป`);
  await auth.audit(req.user, 'sync_stop', {}, auth.metaOf(req)).catch(() => {});
  res.json({ ok: true,
    msg: 'สั่งหยุดแล้ว — งานจะหยุดภายในไม่กี่วินาที แล้วปิดสถานะให้เอง' });
});

app.post('/api/admin/sync', auth.requireLogin('ADMIN'), async (req, res) => {
  /* 🔒 ปุ่ม "ซิงค์เดี๋ยวนี้" = ดึงครบทุกงาน ⇒ เปิดได้เฉพาะโหมด on
   *   โหมด phase1 ต้องกดเป็นงาน ๆ ที่ปุ่มหน้าแถว (POST /api/admin/sync/one)
   *   เพื่อให้เห็นกับตาว่ากำลังดึงงานไหนเข้ามา ไม่ใช่กดปุ่มเดียวแล้วเหมาทั้งยวง */
  if (syncJobs.syncMode() !== 'on')
    return denySheetPull(res, syncJobs.SYNC_OFF_MSG +
      (syncJobs.syncMode() === 'phase1'
        ? ' · เฟส 1 เหลือเฉพาะปุ่มของงานกลุ่ม A หน้าแถวเท่านั้น'
        : ''));
  lockStuck();
  _stopSync = false;                 // เริ่มรอบใหม่ = ล้างคำสั่งหยุดเก่า
  if (_syncing)
    return res.status(409).json({ ok: false, error: 'มีรอบซิงค์ค้างอยู่ กรุณารอให้จบก่อน' });
  if (!sheets.isConfigured())
    return res.status(400).json({ ok: false, error: 'ยังไม่ได้ตั้งค่า GOOGLE_SA_JSON ใน Railway' });
  if (!syncJobs.jobs().length)
    return res.status(400).json({ ok: false, error: 'ยังไม่ได้ตั้งค่า SHEET_*_ID' });

  const user = req.user;
  res.status(202).json({
    ok: true, started: true,
    message: 'เริ่มซิงค์แล้ว — ดูความคืบหน้าที่ตารางข้างล่าง อัปเดตเองทุก 4 วินาที',
  });

  runAllSync(user.username, { manual: true })   // กดปุ่มเอง = ทำครบทุกงาน
    .then(r => auth.audit(user, 'sync_run', { target: 'sheets', ok: r.ok }, auth.metaOf(req)))
    .catch(e => console.error('[sync] ล้มเหลว:', e));
});

/* ═══════════════════════════════════════════════════════════════════
 *  ซิงก์ "ทีละงาน" — พี่เอสั่ง 9 ก.ย. 69
 *    "ขอให้ทำปุ่มแยก sync แต่ละรายการหน้าแถวไว้เลย
 *     พี่ไม่เอาแบบรวม ปุ่มเดียวแบบนี้"
 *
 *  ‼ ปุ่มรวมทำครบ 9 งาน กินเวลาเป็นสิบนาที ทั้งที่บางทีอยากดึงแค่ตารางเดียว
 *  ‼ ยังใช้ล็อก _syncing ตัวเดียวกับรอบรวม — ยิงพร้อมกันสองงานไม่ได้
 *    (สองรอบเขียนตารางเดียวกันพร้อมกัน = แถวชนกัน ข้อมูลเพี้ยนเงียบ ๆ)
 * ═══════════════════════════════════════════════════════════════════ */
app.post('/api/admin/sync/one', auth.requireLogin('ADMIN'), async (req, res) => {
  lockStuck();
  const name = String((req.body && req.body.name) || '').trim();
  const job = syncJobs.jobs().find(j => j.name === name);
  if (!job)
    return res.status(400).json({ ok: false, error: 'ไม่รู้จักงานชื่อ "' + name + '"' });
  /* 🔒 ปุ่มหน้าแถว — โหมด phase1 เปิดเฉพาะ 11 งานของกลุ่ม A
   *   ‼ ตัดสินด้วย syncAllowed ตัวเดียวกับที่ด่าน ② ใช้ ไม่ได้เขียนเงื่อนไขซ้ำ
   *     เขียนซ้ำเมื่อไหร่ = วันหนึ่งสองที่ไม่ตรงกัน แล้วรูรั่วอยู่ที่ตัวที่ไม่มีใครอ่าน */
  if (!syncJobs.syncAllowed(job.name))
    return denySheetPull(res, syncJobs.syncBlockReason(job.name));
  if (_syncing)
    return res.status(409).json({ ok: false, error: 'มีรอบซิงค์ค้างอยู่ กรุณารอให้จบก่อน' });
  if (!sheets.isConfigured())
    return res.status(400).json({ ok: false, error: 'ยังไม่ได้ตั้งค่า GOOGLE_SA_JSON ใน Railway' });

  _stopSync = false;
  const user = req.user;
  res.status(202).json({ ok: true, started: true, job: job.name,
    message: 'เริ่มซิงค์ "' + (job.title || job.name) + '" แล้ว — ดูความคืบหน้าที่แถวของงานนี้' });

  /* ‼ manual: true เพราะเป็นการกดเอง — งานที่ตั้งไว้ว่า "กดเองเท่านั้น"
   *   (เช่นคีย์ยอดขาย) ต้องทำได้เมื่อพี่เอกดปุ่มของมันเอง */
  runAllSync(user.username + ' (ทีละงาน)', { manual: true, only: [job.name] })
    .then(r => auth.audit(user, 'sync_one', { target: job.name, ok: r.ok }, auth.metaOf(req)))
    .catch(e => console.error('[sync] ซิงก์ทีละงานพัง:', e));
});

/* ═══════════════════════════════════════════════════════════════════
 *  ลองใหม่ "เฉพาะงานที่ล้มเหลว" — พี่เอสั่ง 8 ก.ย. 69
 *    "table TotalSales มันยังค้างอยู่นั่นแหละ มีปัญหาไม่แก้ให้จบซะที"
 *
 *  ‼ กดปุ่มซิงค์ปกติ = ทำครบ 9 งาน กินเวลาเป็นสิบนาที ทั้งที่พังงานเดียว
 *    ปุ่มนี้หยิบมาเฉพาะงานที่รอบล่าสุดไม่สำเร็จ
 * ═══════════════════════════════════════════════════════════════════ */
app.post('/api/admin/sync/retry-failed', auth.requireLogin('ADMIN'), async (req, res) => {
  if (_syncing)
    return res.status(409).json({ ok: false, error: 'มีรอบซิงค์ค้างอยู่ กรุณารอให้จบก่อน' });

  const rows = await sync.status().catch(() => []);
  const bad = (Array.isArray(rows) ? rows : [])
    .filter(r => r && r.ok === false && r.source)
    .map(r => r.source);
  const names = [...new Set(bad)];
  if (!names.length)
    return res.json({ ok: true, started: false, note: 'ไม่มีงานที่ล้มเหลว — ไม่ต้องลองใหม่' });

  /* 🔒 "ลองใหม่เฉพาะที่ล้มเหลว" ก็คือการดึงข้อมูลเข้าเหมือนกัน
   *   ‼ งานที่แดงค้างไว้จากก่อนปิดซิงก์ ต้องไม่ถูกลากกลับเข้ามาทางประตูนี้
   *     ⇒ กรองให้เหลือเฉพาะงานที่ด่านอนุญาต แล้วถ้าไม่เหลือเลยก็ปฏิเสธไปตรง ๆ */
  const allow = names.filter(n => syncJobs.syncAllowed(n));
  if (!allow.length)
    return denySheetPull(res, syncJobs.SYNC_OFF_MSG +
      ' · งานที่ล้มเหลวค้างอยู่ ' + names.length + ' งาน ถูกปิดไว้ทั้งหมด');

  _stopSync = false;
  const user = req.user;
  /* ‼ บอกตามจริงว่าลองใหม่ "กี่งานจากกี่งาน" — งานที่ถูกด่านปิดต้องไม่ถูกนับรวม
   *   ไม่งั้นหน้าจอบอกว่าลองใหม่ 9 งาน แต่จริง ๆ ทำแค่ 1 งาน = หน้าจอโกหก */
  res.status(202).json({ ok: true, started: true, jobs: allow,
    blocked: names.filter(n => !syncJobs.syncAllowed(n)),
    sheetSync: syncJobs.syncMode(),
    message: 'ลองใหม่เฉพาะงานที่ล้มเหลว ' + allow.length + '/' + names.length +
             ' งาน: ' + allow.join(', ') });

  runAllSync(user.username + ' (ลองใหม่เฉพาะที่ล้มเหลว)', { manual: true, only: allow })
    .then(r => auth.audit(user, 'sync_retry_failed', { target: allow.join(','), ok: r.ok }, auth.metaOf(req)))
    .catch(e => console.error('[sync] ลองใหม่เฉพาะที่ล้มเหลวพัง:', e));
});

/** ตรวจว่าต่อชีตได้ไหม + ชื่อแท็บมีจริงไหม — ใช้ตอนตั้งค่าครั้งแรก */
app.get('/api/admin/sync/check', auth.requireLogin('ADMIN'), async (_req, res) => {
  try {
    if (!sheets.isConfigured())
      return res.status(400).json({ ok: false, error: 'ยังไม่ได้ตั้งค่า GOOGLE_SA_JSON' });
    const out = [];
    const seen = new Set();
    for (const j of syncJobs.jobs()) {
      if (seen.has(j.sheetId)) continue;
      seen.add(j.sheetId);
      out.push({ sheetId: j.sheetId, tabs: await sheets.listTabs(j.sheetId) });
    }

    /* ═══════════════════════════════════════════════════════════════
     *  ‼ วัดเวลาอ่านจริงของแต่ละแท็บ — ตอบคำถามที่พี่เอถาม 6 ก.ย. 69
     *
     *    "แล้วทำไม table อื่นมัน sync ได้ปกติล่ะ แล้วเร็วด้วย
     *     ตรวจตรงนี้ด้วยนะ มันเป็นแค่ ตารางเดียวเนี่ยนะ"
     *
     *  ‼ คำถามนี้ล้มทฤษฎี "ชีตใหญ่เกินไป" ของอลิซทันที
     *    เพราะ _ImgIndex มี 31,398 แถว มากกว่า TotalSales หลายเท่า แต่อ่านได้
     *    แปลว่าตัวแปรที่ต่างกันไม่ใช่ "จำนวนแถวข้อมูล"
     *
     *  ตัวนี้วัดของจริงทีละแท็บ แล้วเทียบให้เห็นว่า TotalSales ต่างตรงไหน:
     *    · ขนาดตาราง (แถว × คอลัมน์ ที่ประกาศไว้ในชีต ไม่ใช่ที่มีข้อมูลจริง)
     *      ‼ ตารางที่ประกาศคอลัมน์ไว้เป็นพัน ต่อให้ใช้จริง 60 คอลัมน์
     *        การขอข้อมูลก็หนักตามที่ประกาศ ไม่ใช่ตามที่ใช้
     *    · เวลาที่ Google ใช้ตอบ "แค่ 5 แถวแรก"
     *      ‼ ถ้า 5 แถวแรกก็ช้าแล้ว แปลว่าชีตนั้นหนักเอง (สูตรเยอะ/ไฟล์ใหญ่)
     *        ไม่เกี่ยวกับจำนวนแถวที่เราขอ
     * ═══════════════════════════════════════════════════════════════ */
    const เทียบแท็บ = [];
    for (const j of syncJobs.jobs()) {
      const t0 = Date.now();
      let หัวคอลัมน์ = 0, ผิดพลาด = null;
      try {
        /* ‼ ส่งแถวหัวของงานไปด้วย — แท็บหัว 2 แถวจะได้ไม่ขึ้น "หัวคอลัมน์ 0"
         *   แล้วชวนให้เข้าใจผิดว่าแท็บว่าง (รับทั้ง headerRow และ headerRows) */
        const h = await sheets.readHead(j.sheetId, j.tab, 5,
          { headerRow: j.headerRow || j.headerRows });
        หัวคอลัมน์ = (h.header || []).length;
      } catch (e) { ผิดพลาด = e.message.slice(0, 120); }
      const ms = Date.now() - t0;

      /* ขนาดตารางที่ชีตประกาศไว้ */
      let ตารางกว้าง = null, ตารางสูง = null;
      try {
        const tabs = await sheets.listTabs(j.sheetId);
        const hit = (tabs || []).find(t => t.title === j.tab);
        if (hit) { ตารางสูง = hit.rows; ตารางกว้าง = hit.cols; }
      } catch { /* ไม่ได้ก็ข้าม */ }

      เทียบแท็บ.push({ งาน: j.title || j.name, แท็บ: j.tab,
                       'อ่าน5แถวใช้เวลา(ms)': ms, หัวคอลัมน์,
                       ตารางสูง, ตารางกว้าง, ผิดพลาด });
    }

    /* ‼ ชี้ตัวผิดปกติให้เลย ไม่ใช่โยนตัวเลขให้คนอ่านเทียบเอง */
    const เร็วสุด = Math.min(...เทียบแท็บ.map(x => x['อ่าน5แถวใช้เวลา(ms)']));
    const ช้าผิดปกติ = เทียบแท็บ
      .filter(x => x['อ่าน5แถวใช้เวลา(ms)'] > Math.max(3000, เร็วสุด * 5))
      .map(x => `${x.งาน} (${x['อ่าน5แถวใช้เวลา(ms)']}ms · ตาราง ${x.ตารางสูง}×${x.ตารางกว้าง})`);
    const กว้างผิดปกติ = เทียบแท็บ
      .filter(x => x.ตารางกว้าง && x.หัวคอลัมน์ && x.ตารางกว้าง > x.หัวคอลัมน์ * 3)
      .map(x => `${x.งาน} (ประกาศ ${x.ตารางกว้าง} คอลัมน์ แต่ใช้จริง ${x.หัวคอลัมน์})`);

    res.json({ ok: true, files: out, email: sheets.credentials().email,
               เทียบแท็บ,
               ช้าผิดปกติ: ช้าผิดปกติ.length ? ช้าผิดปกติ : null,
               กว้างผิดปกติ: กว้างผิดปกติ.length ? กว้างผิดปกติ : null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * ส่องหัวตารางจริงของทุกแท็บ — ใช้ตอนจับคู่คอลัมน์
 *
 * ระบบเดิมไม่ได้ประกาศหัวตารางของหลายชีตไว้ในโค้ด เราจึงต้องเดา
 * และเดาผิดไปแล้วสองแท็บ (Channel · ActivityLog) อันนี้คือตัวเลิกเดา
 * อ่านแค่ 3 แถวแรก ไม่ดึงทั้งแท็บ
 */
app.get('/api/admin/sync/peek', auth.requireLogin('ADMIN'), async (_req, res) => {
  try {
    if (!sheets.isConfigured())
      return res.status(400).json({ ok: false, error: 'ยังไม่ได้ตั้งค่า GOOGLE_SA_JSON' });
    const out = [];
    for (const j of syncJobs.jobs()) {
      try {
        /* ‼ แท็บหัว 2 แถวต้องส่องจากแถวหัวจริง ไม่งั้นตอบว่า "ไม่เจอสักคอลัมน์"
         *   ทั้งที่หัวตารางตรงกันหมด — คนอ่านจะไล่ผิดทางทั้งวัน */
        const { header } = await sheets.readHead(j.sheetId, j.tab, 2,
          { headerRow: j.headerRow || j.headerRows });
        const wanted = Object.keys(j.columns || {});
        const heads = new Set(header);
        out.push({
          name: j.name, title: j.title, tab: j.tab, table: j.table,
          header,
          matched: wanted.filter(c => heads.has((j.headers || {})[c] || c)),
          missing: wanted.filter(c => !heads.has((j.headers || {})[c] || c)),
        });
      } catch (e) {
        out.push({ name: j.name, title: j.title, tab: j.tab, error: e.message });
      }
    }
    res.json({ ok: true, jobs: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * สำรวจทุกแท็บในไฟล์ชีตกลางทุกไฟล์ แล้วจดลงทะเบียน
 *
 * แท็บไหนมีตารางจริงแล้วจะถูกทำเครื่องหมายว่า "ครอบคลุมแล้ว" ไม่ดึงซ้ำ
 * ที่เหลือจะถูกดึงเข้ากระจกรวม app.sheet_rows ในรอบซิงค์ถัดไป
 * ตัวนี้ไม่ดึงข้อมูล — แค่ถามว่ามีแท็บอะไร หัวตารางเขียนว่าอะไร
 */
app.post('/api/admin/sync/discover', auth.requireLogin('ADMIN'), async (req, res) => {
  lockStuck();
  if (_discovering)
    return res.status(409).json({ ok: false, error: 'กำลังสำรวจอยู่ กรุณารอให้จบก่อน' });
  if (_syncing)
    return res.status(409).json({ ok: false,
      error: 'มีรอบซิงค์กำลังทำอยู่ รอให้จบก่อน (ไม่งั้นยิง Google พร้อมกันแล้วเน็ตสะดุด)' });
  if (!sheets.isConfigured())
    return res.status(400).json({ ok: false, error: 'ยังไม่ได้ตั้งค่า GOOGLE_SA_JSON' });
  _discovering = true;
  try {
    const out = await mirror.discover({
      typedTabs: syncJobs.typedTabs(),
      log: (...a) => console.log('[สำรวจ]', ...a),
    });
    await auth.audit(req.user, 'sheet_discover', { target: 'ทุกไฟล์' }, auth.metaOf(req));
    res.json({ ok: true, files: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally { _discovering = false; }
});

/**
 * สรุปว่ามีข้อมูลอ่อนไหวเก็บอยู่ที่ไหนบ้าง — บอกแค่ "จำนวน" กับ "ชื่อช่อง"
 * ไม่มีค่าจริงหลุดออกมา ปลอดภัยพอที่จะแสดงในหน้าจัดการ
 */
app.get('/api/admin/sensitive', auth.requireLogin('ADMIN'), async (_req, res) => {
  try {
    const rows = await db.select('v_sensitive_summary', { select: '*' }).catch(() => []);
    res.json({ ok: true, groups: rows || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * เปิดดูข้อมูลอ่อนไหวของ "แถวเดียว" — แอดมินเท่านั้น และจดลงบันทึกทุกครั้ง
 *
 * ‼ ตั้งใจให้ดูได้ทีละแถว ไม่มีทางดึงยกตาราง
 *   ถ้าวันหนึ่งต้องใช้เป็นชุด (เช่น ทำใบเบิกจ่ายรอบเดือน) ให้เขียน endpoint
 *   เฉพาะงานนั้น ที่คืนเฉพาะช่องที่งานนั้นต้องใช้ ไม่ใช่เปิดตัวนี้ให้กว้างขึ้น
 */
app.get('/api/admin/sensitive/row', auth.requireLogin('ADMIN'), async (req, res) => {
  const { source, row } = req.query || {};
  if (!source || !row)
    return res.status(400).json({ ok: false, error: 'ต้องระบุ source และ row' });
  try {
    const r = await db.one('sensitive_rows',
      { source: 'eq.' + source, _row: 'eq.' + row, select: 'source,_row,data,_synced_at' });
    await auth.audit(req.user, 'read_sensitive',
      { target: `${source} แถว ${row}` }, auth.metaOf(req));
    if (!r) return res.status(404).json({ ok: false, error: 'ไม่พบข้อมูลอ่อนไหวของแถวนี้' });
    res.json({ ok: true, row: r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** ทะเบียนแท็บที่สำรวจไว้ + จำนวนแถวที่ดึงเข้ากระจกแล้ว */
app.get('/api/admin/sync/catalog', auth.requireLogin('ADMIN'), async (_req, res) => {
  try {
    const [cat, mir] = await Promise.all([
      db.selectAll('sheet_catalog', { select: '*', order: 'file_key.asc' }),
      db.selectAll('v_sheet_mirror', { select: '*', order: 'source.asc' }).catch(() => []),
    ]);
    const got = {};
    for (const m of mir || []) got[m.source] = m['แถว'];
    res.json({
      ok: true,
      files: sheetFiles.files().map(f => ({ key: f.key, title: f.title, used_by: f.used_by, sensitive: !!f.sensitive })),
      tabs: (cat || []).map(c => ({ ...c, mirrored: got[`${c.file_key}/${c.tab}`] || 0 })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════
 *  🔴🔴 ปุ่ม "ซ่อมวันเวลาคิวติดตั้ง" บนหน้า /sync — พี่เอสั่ง 14 ก.ย. 69
 *    พี่เอชี้ที่หน้า /sync แล้วบอกว่า "มันอยู่หน้านี้ปุ่มซ่อม"
 *
 *  ‼ ทำไมต้องเป็นปุ่ม ทั้งที่มีเครื่องมือบรรทัดคำสั่งอยู่แล้ว:
 *    tools/fix-booking-time.js ต้องใช้ SUPABASE_URL / SUPABASE_KEY
 *    ซึ่งอยู่บน Railway เท่านั้น — กฎเหล็กห้ามเอา service_role ลงเครื่องผู้ใช้
 *    ⇒ เครื่องที่รันได้จริงคือ "เซิร์ฟเวอร์" ไม่ใช่เครื่องพี่เอ
 *
 *  🔴 ไม่มีตรรกะการซ่อมอยู่ในไฟล์นี้แม้แต่บรรทัดเดียว
 *    ทุกเส้นเรียก run() ของ tools/fix-booking-time.js ตัวเดียวกับที่ยาม 207 ข้อ
 *    คุมอยู่ (test:bookfixtime 133 + test:fromsheet 74)
 *    ‼ ก๊อปตรรกะมาวางเมื่อไหร่ = มีสองตัวที่คิดคนละแบบ แต่ยามคุมได้ตัวเดียว
 *      แล้ววันหนึ่งปุ่มบนเว็บจะซ่อมไม่เหมือนที่ยามพิสูจน์ไว้
 *
 *  ‼ งานนี้กินเวลาหลายสิบวินาทีถึงหลายนาที (อ่านชีต + เทียบ + เขียนฐานทีละช่อง)
 *    ⇒ ทำแบบเดียวกับปุ่ม "ซิงค์เดี๋ยวนี้" เป๊ะ: ตอบ 202 ทันที ทำต่อเบื้องหลัง
 *      แล้วให้หน้าเว็บถามความคืบหน้าจาก GET /api/admin/booking-time
 *      (ถือคำขอไว้จนจบ = Railway ตัดทิ้ง หน้าเว็บได้ "upstream error" แบบเดิม)
 *
 *  🔒 ทุกเส้นอยู่หลัง auth.requireLogin('ADMIN') เหมือนทั้งกลุ่ม /api/admin/*
 * ═══════════════════════════════════════════════════════════════════ */
const BT_LOCK_MAX_MS = Number(process.env.BOOKING_FIX_LOCK_MAX_MS || 20 * 60 * 1000);

let _btFix = {
  running: false, mode: null, since: 0, by: '',
  finishedAt: null, ok: null, error: null, needSql: false, result: null,
  /* ‼ ความคืบหน้าระหว่างทำงาน — เครื่องมือบอกมาเป็นก้อน ๆ (opt.onProgress)
   *   หน้าเว็บถามทุก 2 วินาทีอยู่แล้ว ⇒ ได้เห็นว่ามันเดินอยู่ ไม่ใช่ค้าง */
  progress: null,
};
/* 🔴 ผลตรวจล่าสุด — ปุ่ม "ซ่อม" ทำงานไม่ได้ถ้ายังไม่มีตัวนี้
 *   ‼ ด่านนี้อยู่ฝั่งเซิร์ฟเวอร์ ไม่ใช่แค่ปิดปุ่มบนหน้าเว็บ
 *     ปิดปุ่มอย่างเดียวกันได้แค่คนกดพลาด กันคนยิง API ตรงไม่ได้ */
let _btScan = null;

/** ล็อกค้างเกินเพดาน = ปลดให้ (บทเรียนเดียวกับ lockStuck ของรอบซิงก์) */
function btBusy() {
  if (!_btFix.running) return false;
  if (Date.now() - _btFix.since > BT_LOCK_MAX_MS) {
    console.warn('[ซ่อมเวลาคิว] ‼ ล็อกค้างเกินเพดาน — ปลดให้');
    _btFix.running = false;
    return false;
  }
  return true;
}

/** ค่าดิบ → ข้อความเวลาไทยอ่านง่าย
 *  🔴 ไม่คิดเลขเอง — ใช้ thaiOf/hhmm ของเครื่องมือ ซึ่งวิ่งผ่าน core/thai-date (กฎเหล็กข้อ ⑥) */
function btFmt(FIX, v) {
  if (v === null || v === undefined || v === '') return '—';
  const t = FIX.thaiOf(v);
  return t ? `${t.ymd} ${FIX.hhmm(t.min)}` : String(v);
}

/* ═══════════════════════════════════════════════════════════════════
 *  แผนของเครื่องมือ → "ตารางเทียบ" ตารางเดียวรวมทุกกอง
 *
 *  🔴 กฎเหล็กข้อ ⑦ — แถวที่ตัดสินไม่ได้ต้องขึ้นบนหน้าจอ ไม่ใช่ข้ามเงียบ
 *    ⇒ ทุกกองของ plan ถูกเทลงตารางนี้หมด ไม่มีกองไหนถูกทิ้ง
 *    ‼ ไม่มีการตัดจำนวนแถว — ตัดเมื่อไหร่คือข้อมูลหายเงียบอีกแบบ
 * ═══════════════════════════════════════════════════════════════════ */
function btTable(FIX, plan) {
  const rows = [];
  const base = x => ({
    jobId: String(x.jobId || ''), customer: String(x.customer || ''),
    sheetRow: x.sheetRow != null ? x.sheetRow : (x._row != null ? x._row : null),
  });

  for (const x of plan.changes) {
    const d = (x.diffs || []).find(z => z.column === FIX.C_DATE);
    rows.push({
      group: 'fix', ...base(x),
      sheet: x.sheetDate || '—', db: x.dbDate || '—',
      to: d ? btFmt(FIX, d.newValue) : '(เปลี่ยนช่องอื่น ไม่ใช่วันติดตั้ง)',
      cols: (x.diffs || []).map(z => ({ column: z.column, from: z.oldValue, to: z.newValue })),
      why: '',
    });
  }
  for (const x of plan.appEdited) rows.push({
    group: 'appEdited', ...base(x), sheet: x.sheetDate || '—', db: x.dbDate || '—',
    to: '— ไม่แตะ', cols: [], why: (x.signals || []).join(' + '),
  });
  for (const x of plan.appRows) rows.push({
    group: 'appRows', ...base(x), sheet: '—', db: '—', to: '— ห้ามแตะ', cols: [], why: x.why || '',
  });
  for (const x of plan.noSheetRow) rows.push({
    group: 'noSheetRow', ...base(x), sheet: '—', db: '—', to: '— ไม่แตะ', cols: [], why: x.why || '',
  });
  for (const x of plan.idMismatch) rows.push({
    group: 'idMismatch', ...base(x), sheet: '—', db: '—', to: '— ไม่เดา', cols: [], why: x.why || '',
  });
  for (const x of plan.sheetBlank) rows.push({
    group: 'sheetBlank', ...base(x), sheet: '(ว่าง)', db: String(x.current || ''),
    to: '— ไม่ลบทิ้ง', cols: [{ column: x.column, from: x.current, to: null }], why: x.why || '',
  });
  for (const x of plan.noDbRow) rows.push({
    group: 'noDbRow', ...base(x), sheet: '—', db: '—', to: '— ต้องสั่งซิงก์',
    cols: [], why: 'มีในชีตแต่ยังไม่มีในฐาน — ต้องซิงก์ ไม่ใช่งานของปุ่มนี้',
  });
  return rows;
}

/** แถวในสมุดบันทึก → ข้อความสั้นให้คนอ่านออก (ไม่ส่งค่าดิบทั้งก้อนออกหน้าเว็บ) */
const btSlim = r => ({
  jobId: String(r.job_id || ''), column: String(r.column_name || ''),
  why: String(r.why || r.error || '').slice(0, 200),
});

/* ─── ตัวเดินงานเบื้องหลัง — ทุกโหมดผ่านทางนี้ทางเดียว ─────────────── */
async function btRun(mode, user, meta) {
  const t0 = Date.now();
  try {
    /* ‼ require ตอนใช้ ไม่ใช่ตอนบูต — เครื่องมือนี้ลาก core/sync + core/sheets ตามมา
     *   ไม่มีใครกดปุ่ม = ไม่ต้องโหลด */
    const FIX = require('./tools/fix-booking-time');
    let out = null;

    /* ‼ เครื่องมือเรียกตัวนี้ทุกก้อน — เก็บไว้ให้เส้นถามสถานะตอบกลับไป
     *   🔴 ห้ามทำงานหนักในนี้ ไม่งั้นไปหน่วงตัวซ่อมเอง */
    const onProgress = p => { _btFix.progress = { ...p, at: Date.now() }; };

    if (mode === 'undo') {
      const r = await FIX.run({ mode: 'undo', yes: true, quiet: true, onProgress });
      out = { mode, undo: {
        restored: r.undo.restored,
        skipped: (r.undo.skipped || []).map(btSlim),
        failed:  (r.undo.failed  || []).map(btSlim),
      } };
    } else {
      const apply = (mode === 'apply');
      const r = await FIX.run({
        mode: apply ? 'apply-from-sheet' : 'from-sheet',
        yes: apply, quiet: true, onProgress,
      });
      out = {
        mode,
        sheet: r.sheet,
        counts: r.counts,
        rows: btTable(FIX, r.plan),
        applied: r.applied ? {
          updated: r.applied.updated, columns: r.applied.columns,
          skipped: (r.applied.skippedAlreadyFixed || []).map(x => ({
            jobId: String(x.jobId || ''), column: String(x.column || ''), why: String(x.why || '') })),
          failed: (r.applied.failed || []).map(x => ({
            jobId: String(x.jobId || ''), column: String(x.column || ''), why: String(x.error || '') })),
        } : null,
      };
      /* ‼ ตรวจแล้วเก็บผลไว้ให้ปุ่มซ่อม · ซ่อมแล้วล้างทิ้ง
       *   ⇒ อยากซ่อมรอบหน้า ต้องกดตรวจใหม่ก่อนเสมอ ไม่มีทางซ่อมซ้อนโดยไม่ได้ดู */
      _btScan = apply ? null : { at: new Date().toISOString(), changes: r.counts.changes };
    }

    out.ms = Date.now() - t0;
    _btFix.ok = true; _btFix.error = null; _btFix.needSql = false; _btFix.result = out;
    console.log(`[ซ่อมเวลาคิว] ${mode} เสร็จใน ${Math.round(out.ms / 1000)} วิ` +
      (out.counts ? ` — ต้องแก้ ${out.counts.changes} · ตรงแล้ว ${out.counts.same}` : '') +
      (out.applied ? ` — เขียนจริง ${out.applied.updated} แถว` : '') +
      (out.undo ? ` — ย้อนคืน ${out.undo.restored} ช่อง` : ''));
  } catch (e) {
    /* 🔴 ยังไม่ได้รัน sql/67 = ไม่มีสมุดบันทึก ⇒ ซ่อมแล้วย้อนไม่ได้
     *   ต้องฟ้องให้ชัดแล้วหยุด ไม่ใช่ซ่อมเงียบ ๆ (อันตรายกว่าไม่ซ่อม) */
    _btFix.ok = false;
    _btFix.needSql = !!(e && e.needSql);
    _btFix.error = String((e && e.message) || e).slice(0, 500);
    _btFix.result = null;
    console.error('[ซ่อมเวลาคิว] ' + mode + ' ล้มเหลว:', _btFix.error);
  } finally {
    _btFix.running = false;
    _btFix.finishedAt = new Date().toISOString();
    await auth.audit(user, 'booking_time_' + mode,
      { target: 'installation_plan', ok: _btFix.ok }, meta || {}).catch(() => {});
  }
}

/** เริ่มงานเบื้องหลัง — ตอบ 202 ทันทีเหมือนปุ่มซิงก์ */
function btStart(mode, req, res, message) {
  _btFix = {
    running: true, mode, since: Date.now(), by: (req.user && req.user.username) || '',
    finishedAt: null, ok: null, error: null, needSql: false, result: null, progress: null,
  };
  res.status(202).json({ ok: true, started: true, mode, message });
  btRun(mode, req.user, auth.metaOf(req));
}

/** สถานะ/ผลล่าสุดของงานซ่อม — หน้าเว็บถามซ้ำทุก 2 วินาทีระหว่างทำงาน */
app.get('/api/admin/booking-time', auth.requireLogin('ADMIN'), (_req, res) => {
  const running = btBusy();
  res.json({
    ok: true,
    running,
    mode: _btFix.mode,
    runningSince: running ? new Date(_btFix.since).toISOString() : null,
    /* ‼ ของเดิมตอบแค่ "ทำอยู่/จบแล้ว" — เพิ่มตัวเลขก้อนเข้าไป ไม่ได้เอาของเดิมออก */
    progress: _btFix.progress,
    hasScan: !!_btScan,
    scanAt: _btScan ? _btScan.at : null,
    scanChanges: _btScan ? _btScan.changes : null,
    finishedAt: _btFix.finishedAt,
    jobOk: _btFix.ok,
    error: _btFix.error,
    needSql: _btFix.needSql,
    result: _btFix.result,
  });
});

/** 🔒 ตรวจอย่างเดียว — อ่านชีต อ่านฐาน เทียบ แล้วรายงาน ไม่เขียนอะไรเลยสักช่อง */
app.post('/api/admin/booking-time/scan', auth.requireLogin('ADMIN'), (req, res) => {
  if (btBusy())
    return res.status(409).json({ ok: false, error: 'มีงานซ่อมวันเวลาทำอยู่ รอให้จบก่อน' });
  if (_syncing)
    return res.status(409).json({ ok: false,
      error: 'มีรอบซิงค์กำลังทำอยู่ รอให้จบก่อน (ไม่งั้นซิงก์กับซ่อมเขียนตารางเดียวกันพร้อมกัน)' });
  if (!sheets.isConfigured())
    return res.status(400).json({ ok: false, error: 'ยังไม่ได้ตั้งค่า GOOGLE_SA_JSON ใน Railway' });
  btStart('scan', req, res,
    'กำลังอ่านชีตแล้วเทียบกับฐานข้อมูล — 🔒 ไม่แตะข้อมูลเลยแม้แต่ช่องเดียว');
});

/** 🔴 ซ่อมจริง — ต้องกด "ตรวจ" มาก่อน และต้องยืนยันมาด้วย */
app.post('/api/admin/booking-time/apply', auth.requireLogin('ADMIN'), (req, res) => {
  if (btBusy())
    return res.status(409).json({ ok: false, error: 'มีงานซ่อมวันเวลาทำอยู่ รอให้จบก่อน' });
  if (_syncing)
    return res.status(409).json({ ok: false,
      error: 'มีรอบซิงค์กำลังทำอยู่ รอให้จบก่อน (ไม่งั้นซิงก์กับซ่อมเขียนตารางเดียวกันพร้อมกัน)' });
  if (!_btScan)
    return res.status(400).json({ ok: false, code: 'NEED_SCAN',
      error: 'ต้องกด "🔍 ตรวจวันเวลาคิว (เทียบชีต)" แล้วดูตารางเทียบก่อน จึงจะซ่อมได้' });
  /* ‼ คำยืนยันต้องมาจากคนกดเท่านั้น — เซิร์ฟเวอร์ไม่ติ๊กให้เอง */
  if (!(req.body && req.body.confirm === true))
    return res.status(400).json({ ok: false, code: 'NEED_CONFIRM',
      error: 'ต้องยืนยันก่อนถึงจะซ่อมได้' });
  if (!sheets.isConfigured())
    return res.status(400).json({ ok: false, error: 'ยังไม่ได้ตั้งค่า GOOGLE_SA_JSON ใน Railway' });
  btStart('apply', req, res,
    'กำลังเขียนค่าจากชีตลงฐานข้อมูล — จดค่าเดิมลง app.time_fix_log ทุกช่อง ย้อนคืนได้');
});

/** ↩️ ย้อนคืนการซ่อมล่าสุดจากสมุดบันทึก app.time_fix_log */
app.post('/api/admin/booking-time/undo', auth.requireLogin('ADMIN'), (req, res) => {
  if (btBusy())
    return res.status(409).json({ ok: false, error: 'มีงานซ่อมวันเวลาทำอยู่ รอให้จบก่อน' });
  btStart('undo', req, res,
    'กำลังย้อนคืนค่าเดิมจากสมุดบันทึก — แถวที่มีคนแก้ต่อจะถูกข้ามและรายงานไว้');
});

app.get('/api/admin/modules', auth.requireLogin('ADMIN'), (_req, res) =>
  res.json({ ok: true, modules: host.status() }));

/** โหลดโมดูลเดียวใหม่ — ใช้ตอนอัปเดตโค้ดโมดูลนั้น ไม่ต้องรีสตาร์ททั้งระบบ */
app.post('/api/admin/reload/:key', auth.requireLogin('ADMIN'), async (req, res) => {
  try {
    await host.reload(req.params.key);
    await auth.audit(req.user, 'reload_module', { target: req.params.key }, auth.metaOf(req));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** รูปแทนที่ตอนหาไม่เจอ — วงกลมเทาเรียบ ๆ ไม่ใช่ไอคอนรูปแตก */
const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
<rect width="96" height="96" rx="48" fill="#e8edf0"/>
<circle cx="48" cy="38" r="15" fill="#c2ccd3"/>
<path d="M20 88a28 28 0 0 1 56 0z" fill="#c2ccd3"/></svg>`;

let _reindexing = false;          // กันเดินสารบัญซ้อนกันเอง

/* ══════════════════ รูปทุกใบของทั้งระบบ ══════════════════
 *
 *  ‼ นี่คือทางแก้เรื่อง "รูปจาก Drive" ที่ใช้ได้กับทุกแอป
 *
 *  หน้าเว็บไม่ต้องรู้อะไรเลยเกี่ยวกับ Drive แค่เขียน
 *      <img src="/img/avatar/User_Images%2Fabc.jpg">
 *  ใส่ค่าดิบจากชีตไปตรง ๆ ได้เลย เป็น path · ลิงก์ · ไอดี · สูตร =IMAGE ก็ได้
 *
 *  สิ่งที่เกิดขึ้นหลังบ้าน
 *    ครั้งแรก : แปลงเป็นไอดีจากสารบัญ → โหลดจาก Drive → เก็บลงถัง → ส่งต่อไป CDN
 *    ครั้งต่อ : เจอในคลังทันที → ส่งต่อไป CDN เลย (ไม่แตะ Drive อีก)
 *
 *  ‼ ทำไมต้อง "ดึงตอนถูกเรียก" ไม่ดึงล่วงหน้าทั้งหมด
 *    รูปหน้างานของแอปอื่นมีเป็นหมื่นใบ แต่คนเปิดดูจริงไม่กี่ร้อย
 *    ดึงล่วงหน้าทั้งหมด = เสียเวลาและพื้นที่ไปกับรูปที่ไม่มีใครดู
 *    ดึงตอนถูกเรียก = จ่ายเฉพาะที่ใช้จริง และไม่มีเพดานว่ารูปเยอะแค่ไหน
 *
 *  ‼ ต้องล็อกอินก่อนถึงจะเรียกได้ — แท็ก <img> ส่งคุกกี้ไปให้เองอยู่แล้ว
 */
app.get('/img/:kind/*', auth.requireLogin(), async (req, res) => {
  const files = require('./core/files');
  const kind = String(req.params.kind || 'misc').replace(/[^a-z0-9_-]/gi, '') || 'misc';
  let raw = '';
  try { raw = decodeURIComponent(req.params[0] || ''); } catch { raw = req.params[0] || ''; }
  if (!raw) return res.status(400).send('ไม่ได้ระบุรูป');

  /* ‼ ต้องมีทางสำรอง ห้ามยอมแพ้ตั้งแต่ชั้นเดียว
   *
   *   5 ก.ย. 69 — บทเรียนจากของจริง: พี่เอทำครบทุกขั้นแล้วรูปก็ยังไม่ขึ้น
   *   เพราะโค้ดเดิมของอลิซ ถ้าเก็บเข้าคลังไม่สำเร็จก็เลิกทันที
   *   ทั้งที่ยังเหลือทางที่แอปเดิมใช้ได้มาตลอด คือลิงก์ thumbnail ของ Drive
   *
   *   ตอนนี้ไล่ 3 ชั้น หมดทุกทางก่อนถึงจะยอม:
   *     1. คลังของเรา (เร็วสุด · ผ่าน CDN)
   *     2. ดึงจาก Drive เข้าคลังตอนนั้น แล้วส่งต่อไป CDN
   *     3. ลิงก์ thumbnail ของ Drive ตรง ๆ — ช้ากว่าแต่ "รูปขึ้น"
   *        (ใช้ได้เมื่อไฟล์แชร์แบบ "ทุกคนที่มีลิงก์" ซึ่งของพี่เอแชร์ไว้แล้ว)
   *
   *   ชั้น 3 สำคัญมาก: มันแยก "ระบบยังไม่พร้อม" ออกจาก "รูปไม่มีจริง"
   *   ผู้ใช้เห็นรูปตามปกติระหว่างที่เรายังไล่แก้ระบบหลังบ้านกันอยู่ */
  let why = '';
  try {
    const r = await files.ensure(raw, { kind, ownerKey: req.query.owner || null });
    /* 302 ไป CDN แทนการส่งไฟล์เอง — เซิร์ฟเวอร์เราไม่ต้องแบกทราฟฟิกรูปเลย
     *   และให้เบราว์เซอร์จำทางลัดนี้ไว้ 1 วัน จะได้ไม่ต้องถามเราซ้ำ */
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.redirect(302, r.url);
  } catch (e) { why = e.message; }

  /* ── ชั้น 3: ลิงก์ Drive ตรง ๆ ────────────────────────────────── */
  try {
    const drive = require('./core/drive');
    const id = await files.driveIdOf(raw).catch(() => '');
    if (id) {
      /* จำทางไว้สั้น ๆ (1 ชม.) เพราะนี่เป็นทางชั่วคราว
       * พอระบบคลังใช้ได้เมื่อไหร่ จะได้กลับไปใช้ CDN โดยไม่ต้องรอแคชหมดอายุนาน */
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Image-Fallback', 'drive-thumbnail');
      res.setHeader('X-Image-Error', encodeURIComponent(String(why).slice(0, 200)));
      return res.redirect(302, drive.thumbUrl(id, Number(req.query.sz) || 200));
    }
    why = why || 'แปลงค่าในชีตเป็นไอดีไฟล์ไม่ได้ — สารบัญยังไม่ครอบคลุมโฟลเดอร์นี้';
  } catch (e) { why = why || e.message; }

  /* ── หมดทุกทางแล้วจริง ๆ ──────────────────────────────────────
   *  ‼ ห้ามตอบ 500 — <img> ที่พังทำให้หน้าเว็บดูเหมือนระบบล่ม
   *    ตอบรูปแทนที่ แล้วบอกสาเหตุไว้ใน header (ดูได้ที่ DevTools > Network) */
  res.setHeader('X-Image-Error', encodeURIComponent(String(why).slice(0, 200)));
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).type('svg').send(FALLBACK_SVG);
});

/**
 * ตรวจรูปใบเดียวแบบละเอียด — บอกทีละขั้นว่าใบนี้ติดตรงไหน
 * ‼ เปิดในเบราว์เซอร์ได้เลย ไม่ต้องกดเมนู เช่น
 *     /api/admin/images/trace?raw=User_Images/abc.jpg
 */
app.get('/api/admin/images/trace', auth.requireLogin('ADMIN'), async (req, res) => {
  const files = require('./core/files');
  const drive = require('./core/drive');
  const storage = require('./core/storage');
  const raw = String(req.query.raw || '').trim();
  if (!raw) return res.status(400).json({ ok: false, error: 'ต้องระบุ ?raw=<ค่าในชีต>' });

  const out = { ค่าที่ส่งมา: raw, ขั้นตอน: [] };
  const say = (k, v) => out['ขั้นตอน'].push({ ขั้น: k, ผล: v });

  try {
    const id = await files.driveIdOf(raw);
    say('1. แปลงเป็นไอดีไฟล์', id || '❌ แปลงไม่ได้ (สารบัญไม่มีชื่อไฟล์นี้)');
    if (!id) return res.json(out);

    out['ลิงก์ Drive ตรง'] = drive.thumbUrl(id, 200);

    const b = await storage.bucketReady();
    say('2. ถังเก็บไฟล์', b.ok ? '✅ ' + b.bucket : '❌ ' + b.error);

    try {
      const f = await drive.download(id);
      say('3. โหลดไฟล์จาก Drive', `✅ ${f.mime} · ${Math.round(f.bytes / 1024)} KB`);
      try {
        const up = await storage.upload(files.pathOf('avatar', id, f.mime), f.buf, f.mime);
        say('4. อัปขึ้นถัง', '✅ ' + up.url);
        out['ลิงก์ในคลัง'] = up.url;
      } catch (e) { say('4. อัปขึ้นถัง', '❌ ' + e.message); }
    } catch (e) { say('3. โหลดไฟล์จาก Drive', '❌ ' + e.message); }
  } catch (e) { say('ล้มเหลว', e.message); }

  res.json(out);
});

/**
 * เดินสารบัญ Drive — แอดมินเท่านั้น
 *
 * ‼ ตัวนี้คือของที่แก้ปัญหาใหญ่สุด
 *   files.list คืนได้ทีละ 1,000 ไฟล์ต่อคำขอ รูปหมื่นใบจึงยิง Google แค่ 10 ครั้ง
 *   ถ้าค้นทีละไฟล์แบบเดิมจะเป็นหมื่นครั้ง ซึ่งชน rate limit และช้าจนใช้ไม่ได้
 *
 * ?folder=<ไอดีโฟลเดอร์>  เดินเฉพาะโฟลเดอร์นั้นลงไปทุกชั้น
 * ไม่ระบุ                 เดินรูปทุกใบที่บัญชีระบบมองเห็น
 */
app.post('/api/admin/drive/reindex', auth.requireLogin('ADMIN'), async (req, res) => {
  if (!sheets.isConfigured())
    return res.status(400).json({ ok: false, error: 'ยังไม่ได้ตั้งค่า GOOGLE_SA_JSON' });
  if (_reindexing)
    return res.status(409).json({ ok: false, error: 'กำลังเดินสารบัญอยู่ รอให้จบก่อน' });

  const folderId = String((req.body && req.body.folder) || req.query.folder || '').trim();
  const user = req.user;
  _reindexing = true;
  res.status(202).json({
    ok: true, started: true,
    message: folderId
      ? 'เริ่มเดินสารบัญโฟลเดอร์นี้แล้ว — ดูความคืบหน้าที่ GET /api/admin/drive'
      : 'เริ่มเดินสารบัญรูปทั้งหมดแล้ว — ไฟล์เยอะใช้เวลาสักครู่',
  });

  require('./core/files').reindex({ folderId, log: (...a) => console.log('[สารบัญ]', ...a) })
    .then(r => {
      console.log('[สารบัญ] จบรอบ —', r.note || r.error);
      return auth.audit(user, 'drive_reindex',
        { target: folderId || 'รูปทั้งหมด', ok: r.ok, files: r.files }, auth.metaOf(req));
    })
    .catch(e => console.error('[สารบัญ] ล้มเหลว:', e))
    .finally(() => { _reindexing = false; });
});

/**
 * ตรวจว่าระบบรูปติดขั้นไหน — แอดมินเท่านั้น
 *
 * ‼ มีไว้เพื่อเลิกเดา
 *   เรื่องรูปมีหลายขั้นต่อกัน แต่เวลาพังจะเห็นเหมือนกันหมดคือ "รูปไม่ขึ้น"
 *   ตัวนี้เดินตรวจตามลำดับจริง แล้วบอกว่าติดขั้นไหนและต้องทำอะไร
 */
app.get('/api/admin/images/doctor', auth.requireLogin('ADMIN'), async (_req, res) => {
  try {
    res.json(await require('./core/image-doctor').run());
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * ‼ รายชื่อโฟลเดอร์ที่เก็บไฟล์ "ทุกแอป" — ไว้เอาไปแชร์ให้บัญชีระบบ
 *
 *  พี่เอสั่ง 5 ก.ย. 69: "ไปอ่านใน code สิ ว่าดึงภาพ และ เขียนไปใน
 *  โฟล์เดอร์ไหนบ้าง มันมีไม่กี่ folder หรอก อย่าเดามั่ว"
 *
 *  ‼ รายชื่อมาจาก app.image_folder_ref ซึ่งถอดมาจากโค้ดแอปเดิมตรง ๆ
 *    พร้อมเลขบรรทัดอ้างอิงให้ตรวจย้อนได้ ไม่ใช่กวาดเดาจากข้อมูล
 *    (ตัวเดิมกวาด sheet_rows หลายแสนแถวจน Supabase ตัดทิ้ง — และผลก็เป็นการเดา)
 *  ‼ ไม่ยิงถาม Google เลยสักคำขอ
 */
app.get('/api/admin/drive/folders', auth.requireLogin('ADMIN'), async (_req, res) => {
  try {
    const rows = await db.select('v_image_folders', { select: '*', limit: 200 });
    let account = '';
    try { account = sheets.credentials().email; } catch { /* ยังไม่ได้ตั้งค่า */ }
    res.json({ ok: true, account, folders: rows || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** สภาพสารบัญ + รายชื่อรูปที่ยังแปลงเป็นไอดีไม่ได้ */
app.get('/api/admin/drive', auth.requireLogin('ADMIN'), async (_req, res) => {
  try {
    const [stats, unresolved, total] = await Promise.all([
      db.select('v_drive_index_stats', { select: '*', limit: 100 }).catch(() => []),
      db.select('v_avatar_unresolved', { select: '*', limit: 100 }).catch(() => []),
      db.count('drive_index', {}).catch(() => 0),
    ]);
    /* ‼ ส่งอีเมลบัญชีระบบไปด้วยเสมอ
     *   สาเหตุอันดับหนึ่งที่สารบัญได้ 0 ไฟล์ คือยังไม่ได้แชร์โฟลเดอร์ให้บัญชีนี้
     *   หน้าจอต้องบอกอีเมลได้ทันที ไม่ใช่ให้ไปตามหาใน Railway Variables */
    let account = '';
    try { account = sheets.credentials().email; } catch { /* ยังไม่ได้ตั้งค่า */ }

    /* ‼ ตอนสารบัญยังว่าง ต้องส่องให้รู้ว่า "ไม่เห็นอะไรเลย" หรือ "เห็นแต่ไม่ใช่รูป"
     *   สองอย่างนี้แก้คนละวิธี ถ้าไม่แยกก็เดากันต่อไม่จบ
     *   ‼ ส่องเฉพาะตอนสารบัญว่าง — ปกติไม่ต้องยิง Google ให้เปลืองคำขอ */
    let peek = null;
    if (!total && !_reindexing) {
      try { peek = await require('./core/drive').peek(10); } catch { peek = null; }
    }

    res.json({ ok: true, running: _reindexing, total, account, peek,
               /* ‼ "เดินเสร็จ" กับ "ใช้งานได้" คนละเรื่องกัน
                *   0 ไฟล์ = เดินเสร็จแล้วจริง แต่ใช้งานไม่ได้เลย
                *   เคยขึ้นว่า "✅ สารบัญพร้อมแล้ว 0 ไฟล์" ซึ่งเป็นการโกหก
                *   (พี่เอเจอ 5 ก.ย. 69) */
               ready: total > 0,
               folders: stats || [], unresolved: unresolved || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══════════════════ ไฟล์หน้าเว็บส่วนกลาง ══════════════════ */
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

/* ‼ โลโก้มดงาน — ทุกแอปในระบบเรียกใช้ที่เดียวกันจากตรงนี้
 *   พี่เอสั่ง 7 ก.ย. 69: "เก็บไว้ใช้ในทุกๆ app ด้วยนะ"
 *   แคชได้ยาว (1 วัน) เพราะโลโก้แทบไม่เปลี่ยน — เปลี่ยนเมื่อไหร่ค่อยเปลี่ยนชื่อไฟล์
 *   ‼ เอกสาร/PDF ที่เปิดหน้าต่างใหม่ ห้ามใช้ทางนี้ — ใช้ LOGO_DATA จาก core/brand.js
 *     เพราะหน้าต่างนั้นไม่มี base URL ของเรา รูปจะไม่ขึ้นและหายจาก PDF เงียบ ๆ */
app.use('/brand', express.static(path.join(__dirname, 'public', 'brand'),
  { maxAge: '1d', immutable: false }));

/* ‼ หน้าเว็บส่วนกลางก็ห้ามแคชเหมือนกัน */
app.use((_req, res, next) => {
  const p = _req.path || '';
  if (/\.html?$/i.test(p) || p === '/' || p === '/sync')
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  next();
});

/**
 * รุ่นที่กำลังรันอยู่ — ‼ ไว้ตอบคำถาม "ดีพลอยแล้วหรือยัง" ให้จบในวินาทีเดียว
 *
 *   เวลาที่เสียไปมากที่สุดในโปรเจกต์นี้ ไม่ใช่การแก้บั๊ก
 *   แต่คือการเดากันไปมาว่า "โค้ดที่รันอยู่คือรุ่นไหน"
 *   BUILT_AT ตั้งตอนโปรเซสเริ่ม = เวลาที่ดีพลอยรุ่นนี้ขึ้นไปจริง ๆ
 */
const BUILT_AT = new Date().toISOString();
app.get('/api/version', (_req, res) => res.json({
  ok: true,
  version: require('./package.json').version,
  /* ‼ พี่เอสั่ง 9 ก.ย. 69: "ทำโครงสร้าง รอไว้สำหรับ Version ให้กับทุกแอปเลยสิ"
   *   เวอร์ชันของแต่ละแอป (modules/<แอป>/version.js) — หน้าแอปหยิบของตัวเองไปโชว์
   *   ที่ต้องแยกจาก version ข้างบน: อันบนคือของทั้งระบบ ขยับทุกครั้งที่แตะแอปไหนก็ได้ */
  apps: Object.fromEntries(registry.loadAll()
    .filter(m => m.version)
    .map(m => [m.key, m.version])),
  builtAt: BUILT_AT,
  uptimeSec: Math.round(process.uptime()),
  features: {
    peakQueue: true,          /* คิวซิงก์หลังบ้าน */
    peakBizCard: true,        /* การ์ดสถานะ 2 บริษัท */
    imageDoctor: true,        /* ตัวตรวจระบบรูป */
    driveIndex: true,         /* สารบัญ Drive */
  },
}));

/* ═══════════════════════════════════════════════════════════════════
 *  🏢 โมดูล Facade LED Signage — พี่เอส่งชุดโค้ดมา 10 ก.ย. 69
 *
 *  ‼ พี่เอสั่ง: "copy code จาก ไฟล์ที่ส่งให้ 100% นะ ห้ามแก้ไขใดๆ ทั้งสิ้น"
 *    ⇒ ไฟล์ใน modules/facade/ · public/facade/ · sql/facade_*.sql
 *      เหมือนต้นฉบับทุกไบต์ ไม่ได้แตะแม้แต่ตัวอักษรเดียว (ตรวจด้วย md5 ครบ 25 ไฟล์)
 *      ของที่เพิ่มคือ "สายไฟรอบนอก" ตรงนี้เท่านั้น + module.json/version.js
 *      ซึ่งเป็นไฟล์ใหม่ที่ต้นฉบับไม่มี (ทะเบียนแอปของ crm-hub ต้องใช้)
 *
 *  ต่อตามที่ README ของชุดโค้ดบอกไว้เป๊ะ:
 *      app.use('/api/facade', facade.router)
 *      หน้าเว็บอยู่ที่ public/facade/ เข้าที่ /facade/index.html
 *
 *  ‼ ต้องมาก่อน host.mountAll() — ตัวจัดการโมดูลจะพยายามโหลด
 *    modules/facade/index.js ด้วยกติกาของ crm-hub (ต้อง export mount())
 *    แต่ชุดนี้ export { router, health } ตามแบบ Express ธรรมดา
 *    ⇒ ปล่อยให้ mountAll เจอก่อนเมื่อไหร่ /m/facade/ จะกลายเป็น 503
 *      ลงทะเบียนเส้นทางจริงไว้ก่อน = ของถูกตัวมาก่อนเสมอ
 *
 *  ‼ ฐานข้อมูล (แก้ 10 ก.ย. 69 — พี่เอสั่ง "ทำเหมือน app อื่นเลย"):
 *    ชุดนี้คุยผ่าน PostgREST ด้วย core/db เหมือนทุกแอปในระบบแล้ว
 *    ⇒ ไม่ต้องตั้ง DATABASE_URL อีกต่อไป ใช้ SUPABASE_KEY ที่มีอยู่แล้ว
 *      ตารางอยู่ใน schema app ชื่อขึ้นต้นด้วย facade_ ⇒ ไม่ชนของเดิมสักตาราง
 *      (ดู _source/facade/สัญญาการย้าย.md)
 * ═══════════════════════════════════════════════════════════════════ */
{
  const FACADE_DIR = path.join(__dirname, 'public', 'facade');

  /* ═══════════════════════════════════════════════════════════════
   *  🔐 ด่าน "Planning · Graphic เปิด Facade LED Signage ไม่ได้"
   *    พี่เอสั่ง 14 ก.ย. 69: "Planning , graphic จำกัดสิทธิ์ ไม่ให้เห็น app :
   *    คีย์ยอดขาย , Facade LED Signage"
   *
   *  🔴 ทำไมต้องมาใส่เองตรงนี้ ทั้งที่ facade อยู่ในทะเบียนโมดูลแล้ว:
   *    ชุดโค้ด Facade เป็นของที่ยกมา 100% จึงต่อสายเองที่ server.js
   *    (module.json > mountedElsewhere = true) ⇒ core/module-host.js
   *    "ไม่ได้ครอบ registry.canUse ให้" เหมือนโมดูลอื่น
   *    ⇒ ถ้าใส่แค่ที่ทะเบียน การ์ดจะหายไปก็จริง แต่พิมพ์ /facade/index.html
   *      หรือยิง /api/facade/… ตรง ๆ ยังเข้าได้อยู่ดี — ต้องกันครบทั้ง 3 เส้น
   *  ‼ ไม่ได้แตะไฟล์ในชุดของพี่เอแม้แต่ตัวอักษรเดียว — ครอบที่สายไฟรอบนอก
   * ═══════════════════════════════════════════════════════════════ */
  const requireFacadeApp = appAccess.requireApp('facade');

  /* ‼ ต้องมาก่อนทุกเส้น /api/facade/… ข้างล่าง (ทั้ง _diag · photos · router
   *   ของชุดโค้ด) — Express เจอตัวไหนก่อนใช้ตัวนั้น */
  app.use('/api/facade', requireFacadeApp);

  /* หน้าเว็บของแอป — ต้องล็อกอินก่อนเหมือนทุกแอปในระบบ */
  app.use('/facade', auth.requireLogin(), requireFacadeApp,
    express.static(FACADE_DIR, {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        if (/\.html?$/i.test(filePath))
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      },
    }));

  /* การ์ดที่หน้ารวมแอปเปิดมาที่ /m/facade/ (มาตรฐานของ crm-hub)
   *  ‼ พาไปหน้าจริงของชุดนี้ พร้อมส่งตั๋ว SSO ต่อไปให้ครบ
   *
   *  ‼ แก้ 14 ก.ย. 69 — พี่เอสั่งยุบ 2 หน้าที่ซ้ำซ้อนให้เหลือหน้าเดียว
   *    "ให้ย้าย เมนู ไฟล์ตัด ไปอยู่ใน ภาพที่ 2 พร้อมทั้งลบหน้าของ ภาพซ้ายมือทิ้งไป"
   *    ⇒ หน้าหลักของแอปย้ายจาก index.html ไปเป็น present-panel.html
   *      (index.html เหลือเป็นป้ายบอกทางให้บุ๊กมาร์กเก่า — ไม่ปล่อย 404)
   *    🔴 ด่านสิทธิ์ไม่ได้ขยับตาม เพราะครอบไว้ที่ "ทั้ง prefix /facade"
   *      อยู่แล้ว (app.use('/facade', requireLogin, requireFacadeApp, static))
   *      ⇒ เปลี่ยนชื่อไฟล์หน้าหลักกี่ครั้ง ด่านก็ยังครอบครบทุกไฟล์เหมือนเดิม */
  app.get(['/m/facade', '/m/facade/'], auth.requireLogin(), requireFacadeApp, (req, res) => {
    const t = req.query && req.query.t ? '?t=' + encodeURIComponent(req.query.t) : '';
    res.redirect('/facade/present-panel.html' + t);
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🔑 สะพานเรื่อง "ตัวตนผู้ใช้" — จำเป็นจริง ๆ ไม่ใช่ของแถม
   *
   *  ชุดโค้ดอ่านผู้ใช้จาก req.user โดยดูช่อง id หรือ user_id
   *  (modules/facade/auth.js readUser) แต่ crm-hub ใส่ req.user มาเป็น
   *  { username, name, nickname, image, permission, role } — ไม่มี id เลย
   *  ⇒ ถ้าไม่ทำอะไร ทุกเส้นทางของ Facade จะตอบ 401 "ยังไม่ได้เข้าสู่ระบบ" ทั้งหมด
   *
   *  ‼ แก้ที่นี่ ไม่ได้แก้ในไฟล์ของพี่เอ (สั่งไว้ว่าห้ามแตะแม้แต่ตัวอักษรเดียว)
   *  ‼ ใช้ username เป็นตัวตน เพราะเป็นกุญแจที่ไม่ซ้ำและไม่เปลี่ยนของ crm-hub
   *    และตาราง facade.staff.user_id เก็บเป็น text อยู่แล้ว (ตาม README)
   *  ‼ ไม่แตะ req.user เดิมสักช่อง — เติมเฉพาะ id ที่ยังไม่มี */
  app.use('/api/facade', (req, _res, next) => {
    if (req.user && !req.user.id && !req.user.user_id && req.user.username)
      req.user = Object.assign({}, req.user, { id: req.user.username });
    next();
  });

  /* ═══════════════════════════════════════════════════════════
   *  🔧 ACP3D — สร้างไฟล์ตัด/เซาะร่อง CNC งานอลูมิเนียมคอมโพสิต 3 มิติ
   *     พี่เอส่งชุดโค้ดมา 10 ก.ย. 69 · วางไว้เหมือนต้นฉบับทุกไบต์
   *     ต่อตามที่ README_ACP3D.md บอกไว้เป๊ะ (แบบ CommonJS)
   *
   *  ‼ ชุดนี้ไม่ต้องลง npm เพิ่มสักตัว และไม่ต้อง build
   *  ‼ การประมวลผลรูปทำในเบราว์เซอร์ทั้งหมด รูปไม่ถูกอัปโหลดไปไหน */
  /* 🔐 พี่เอสั่ง 17 ก.ย. 69 — แอปนี้ไม่ได้อยู่ในรายการของสิทธิ์กลุ่มไหนเลย
   *   ⇒ ตามกติกา "แอปที่ไม่มีใครถูกระบุให้เห็น" = administrator · sales ·
   *     sale support เท่านั้น (ตารางที่ core/app-perms.js · คีย์ 'acp3d')
   *   ‼ ชุดนี้ต่อสายเองที่ server.js ไม่ผ่าน core/module-host.js
   *     ⇒ ต้องครอบด่านเองทั้ง "หน้าเว็บ /acp3d" และ "API /api/acp3d" */
  const requireAcp3dApp = appAccess.requireApp('acp3d', 'ไฟล์ตัด CNC (ACP 3 มิติ)');
  app.use('/acp3d', auth.requireLogin(), requireAcp3dApp,
    express.static(path.join(__dirname, 'public', 'acp3d'), {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        if (/\.html?$/i.test(filePath))
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      },
    }));
  /* 🔒 13 ก.ย. 69 — ปิดช่องที่หลุดด่านอยู่เส้นเดียวของชุดนี้
   *   ชุดโค้ด ACP3D ใส่ด่านให้ /designs · /generate · /image ครบ
   *   แต่ /api/acp3d/health ไม่ได้ใส่ (modules/acp3d/index.js:76) ⇒ คนนอกยิงได้
   *   ‼ ห้ามแก้ไฟล์ในชุดของพี่เอ ⇒ ครอบด่านไว้ที่ prefix ตรงนี้แทน
   *     ต้องมาก่อน mount ของชุดนั้น (Express เจอตัวไหนก่อนใช้ตัวนั้น) */
  app.use('/api/acp3d', auth.requireLogin(), requireAcp3dApp);

  try {
    require('./modules/acp3d/index.cjs')
      .mount(app, express, { auth: auth.requireLogin() })
      .then(base => console.log('[acp3d] ✅ พร้อมใช้งาน —', base))
      .catch(e => console.error('[acp3d] ❌ ต่อไม่สำเร็จ:', e.message));
  } catch (e) {
    console.error('[acp3d] ❌ โหลดโมดูลไม่สำเร็จ:', e.message);
  }

  /* ═══════════════════════════════════════════════════════════
   *  🩺 ตัววินิจฉัย — พี่เอ 10 ก.ย. 69: "app facade ทำไมเห็นแค่นี้"
   *    หน้าเว็บของชุดโค้ดเรียก /me เป็นอย่างแรก ถ้าล้ม เมนูไม่ขึ้นเลย
   *    และ error เป็น toast ที่หายไปใน 5 วินาที ⇒ เห็นแค่หน้าว่าง
   *
   *  🔴 แก้ 10 ก.ย. 69 (รอบสอง) — เดิมวางไว้ "ข้างใน try ที่ require โมดูล"
   *     ⇒ ถ้าโมดูลโหลดไม่สำเร็จ ตัววินิจฉัยก็ไม่ถูกติดตั้งไปด้วย
   *       คือพังพร้อมกันกับสิ่งที่มันมีหน้าที่อธิบาย
   *     ‼ บทเรียน: "ตาข่ายนิรภัย ห้ามแขวนไว้กับสิ่งที่มันรับตก"
   *       ตัววินิจฉัยต้องอยู่นอกทุก try และต้องติดตั้งให้ได้เสมอ
   *
   *  ‼ ต้องมาก่อน facade.router — และไม่ผ่าน requireAuth() ของชุดโค้ด
   *    (ตัวนั้นเองคือตัวที่พังอยู่) แต่ยังต้องล็อกอินระบบหลักก่อน
   *    ไม่เปิดให้คนนอกดูสถานะระบบ */
  try {
    app.use('/api/facade/_diag', auth.requireLogin(), require('./core/facade-diag').makeRouter());
  } catch (e) {
    app.use('/api/facade/_diag', (_req, res) => res.status(500).json({
      ok: false, summary: 'ตัววินิจฉัยเองก็โหลดไม่ขึ้น: ' + e.message, checks: [],
    }));
  }

  /* API — ต่อตรงตาม README ของชุดโค้ด */
  try {
    const facade = require('./modules/facade');

    /* ═══════════════════════════════════════════════════════════
     *  📎 ไฟล์ทุกชนิดขึ้น Google Drive เท่านั้น — พี่เอสั่ง 10 ก.ย. 69
     *    "ไฟล์ต่างๆ เช่น รูปภาพ ไฟล์งาน .ai ของลูกค้า ให้ทำการบันทึกใน
     *     Google drive เท่านั้นนะ แล้ว get link มาเก็บใน Supabase"
     *
     *  ‼ ต้องมาก่อน facade.router — Express เจอตัวไหนก่อนใช้ตัวนั้น
     *    ทับเฉพาะเส้นที่ "เขียนไฟล์" (POST /photos) เส้นอ่าน/ลบยังเป็นของเขา
     *  ‼ ทำแบบนี้เพราะห้ามแก้ไฟล์ในชุดโค้ด — ของเขาเขียนลงดิสก์ container
     *    ซึ่ง Railway ล้างทุกครั้งที่ดีพลอย (README ของเขาเตือนไว้เอง)
     *    ไฟล์งานลูกค้าหายแบบนั้น = งานเสียหายจริง */
    try {
      const facadeDb = require('./modules/facade/db');
      const facadeAuth = require('./modules/facade/auth');
      app.use('/api/facade/photos',
        facadeAuth.requireAuth(),
        require('./core/facade-files').makeRouter(facadeDb));
    } catch (e) {
      console.error('[facade] ⚠️ ต่อทางอัปไฟล์ขึ้น Drive ไม่สำเร็จ:', e.message);
    }

    /* 🎬 รอบ 148 — วิดีโอนำเสนอเสมือน 3D ของ Lead (Veo + ffmpeg · ไฟล์อยู่บน Drive)
     *   พี่เอสั่ง 26 ก.ย. 69: "นำไฟล์ ภาพ … ของ Honda มาสร้างเป็น VDO Presentation" · "ทำให้เสมือน 3D นะ"
     *   ‼ ต่อสายจากข้างนอกแบบเดียวกับ facade-files — ไม่แตะไฟล์ในชุดโค้ด modules/facade/ */
    try {
      const facadeDb = require('./modules/facade/db');
      const facadeAuth = require('./modules/facade/auth');
      app.use('/api/facade/videos',
        facadeAuth.requireAuth(),
        require('./core/facade-video-router').makeRouter(facadeDb));
      /* 🔗 รอบ 149 — ลิงก์ให้ลูกค้าเปิดดูวิดีโอออนไลน์ (ไม่ต้องล็อกอิน · ลิงก์สุ่มเดาไม่ได้ · ปิดได้)
       *   พี่เอสั่ง: "ส่ง link URL ให้ลูกค้าเปิดดูได้ online"
       *   ‼ ไม่ผ่าน requireLogin โดยตั้งใจ — หน้าแสดงแค่ชื่อบนการ์ด + วิดีโอ ไม่มีข้อมูลภายใน */
      app.use('/pv', require('./core/facade-video-router').makePublicRouter(facadeDb));
    } catch (e) {
      console.error('[facade] ⚠️ ต่อทางวิดีโอนำเสนอไม่สำเร็จ:', e.message);
    }

    /* 🖼️ รอบ 149 — ภาพผลงานอ้างอิงบนหน้าแรก (admin อัป · ทุกคนดู · ไฟล์อยู่บน Drive)
     *   พี่เอสั่ง 26 ก.ย. 69: "ในหน้าแรก ให้ admin สามารถ upload ภาพ Reference ได้ด้วยนะ" · "แสดงบนหน้า app และกดขยายได้" */
    try {
      const facadeDb = require('./modules/facade/db');
      const facadeAuth = require('./modules/facade/auth');
      app.use('/api/facade/references',
        facadeAuth.requireAuth(),
        require('./core/facade-refs').makeRouter(facadeDb));
    } catch (e) {
      console.error('[facade] ⚠️ ต่อทางภาพผลงานอ้างอิงไม่สำเร็จ:', e.message);
    }

    app.use('/api/facade', facade.router);
    facade.health()
      .then(h => console.log('[facade]', h.ok ? '✅ ต่อฐานข้อมูลติด' : '⚠️ ' + h.error))
      .catch(e => console.log('[facade] ⚠️', e.message));

    /* ═══════════════════════════════════════════════════════════
     *  🕐 เขตเวลา — พี่เอสั่ง 10 ก.ย. 69 "อย่าลืมเช็คเรื่องวันเวลา
     *     time zone ให้ถูกต้องด้วยนะ"
     *
     *  🔴 จุดที่เคยเพี้ยน 2 จุด (เดือนของค่าคอม · วันหมดอายุใบเสนอราคา)
     *     เดิมตัดสินตาม "เขตเวลาของเซสชันฐานข้อมูล" ซึ่งบน Supabase คือ UTC
     *     ⇒ ช่วง 00:00–07:00 เวลาไทย ได้วันเมื่อวาน / เดือนที่แล้ว
     *
     *  ✅ ย้ายมาคุยผ่าน PostgREST แล้ว "ไม่มีเซสชันให้ตั้งอีกต่อไป"
     *     ยามตัวเดิมที่ยิง select current_setting('TimeZone') จึงถูกถอดออก
     *     เขตเวลาปักไว้ในฟังก์ชัน SQL แทน ด้วย
     *       (now() at time zone 'Asia/Bangkok')::date
     *     ⇒ ถูกทุกครั้งโดยไม่ต้องพึ่งการตั้งค่าที่คนลืมได้
     *       (สัญญาการย้าย ข้อ ⑤ · sql/facade_10_app_schema.sql) */
  } catch (e) {
    /* ‼ โมดูลเดียวพัง ต้องไม่ทำให้ทั้งระบบล่ม — กติกาเดียวกับ module-host */
    console.error('[facade] ❌ โหลดโมดูลไม่สำเร็จ:', e.message);
    app.use('/api/facade', (_req, res) => res.status(503).json({
      ok: false, code: 'FACADE_ERROR',
      error: 'โมดูล Facade LED โหลดไม่สำเร็จ', detail: e.message,
    }));
  }
}

/* ══════════════════ เริ่มระบบ ══════════════════ */
(async () => {
  await host.mountAll(app);

  // 404
  app.use((req, res) => {
    if (req.path.startsWith('/api/'))
      return res.status(404).json({ ok: false, error: 'ไม่พบเส้นทางนี้' });
    res.status(404).send('<meta charset="utf-8"><h2 style="font-family:sans-serif;text-align:center;margin-top:80px">ไม่พบหน้านี้ · <a href="/">กลับหน้ารวมแอป</a></h2>');
  });

  // ตัวจับ error สุดท้าย — ไม่ปล่อย stack trace ออกไปฝั่งผู้ใช้
  app.use((err, req, res, _next) => {
    console.error('[error]', req.method, req.originalUrl, err);
    if (res.headersSent) return;
    res.status(500).json({ ok: false, error: 'ระบบขัดข้อง กรุณาลองใหม่' });
  });

  /* ปิดรอบซิงค์ที่ค้างจากการรีสตาร์ท
   *
   * ถ้าระบบถูกรีสตาร์ท (deploy ใหม่ · Railway ย้ายเครื่อง) ระหว่างซิงค์
   * แถวใน sync_run จะไม่มีเวลาจบ แล้วค้างเป็น "กำลังทำ" ตลอดกาล
   * ตอนบูตไม่มีงานไหนกำลังทำอยู่จริง ปิดให้หมดได้เลย */
  /* 🔴 พี่เอทัก 8 ก.ย. 69: "table TotalSales มันยังค้างอยู่นั่นแหละ
   *    มีปัญหาไม่แก้ให้จบซะที"
   *
   *  ต้นเหตุ: ตัวซิงก์วิ่งอยู่ในโปรเซสเดียวกับเว็บ ทุกครั้งที่ Railway ดีพลอย
   *  (= ทุกครั้งที่อัปโค้ดขึ้น GitHub) โปรเซสเกิดใหม่ รอบที่กำลังวิ่งถูกฆ่ากลางคัน
   *  งาน "คีย์ยอดขาย" อยู่ตัวแรกและตัวใหญ่สุด (สามหมื่นแถว) จึงโดนบ่อยที่สุด
   *
   *  ‼ ของเดิมแค่ "ปิดแถวแล้วเขียนว่าล้มเหลว" — แล้วนอนค้างตลอดกาล
   *    จนกว่าจะมีคนมากดเอง นั่นคือเหตุผลที่พี่เอเห็นมันแดงอยู่นั่นแหละทุกที
   *  ⇒ ต้องลองใหม่ให้เอง ไม่ต้องรอใครมากด */
  db.update('sync_run', { finished_at: 'is.null' }, {
    finished_at: new Date().toISOString(), ok: false,
    error: 'ระบบรีสตาร์ทระหว่างซิงค์ — จะลองใหม่ให้เองภายใน 1 นาที (ไม่ต้องกดอะไร)',
  }).then(rows => {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return;
    const names = [...new Set(list.map(r => r.source).filter(Boolean))];
    console.log(`[sync] ปิดรอบที่ค้างจากการรีสตาร์ท ${list.length} รอบ: ${names.join(', ') || '-'}`);
    if (!names.length) return;

    /* ═══════════════════════════════════════════════════════════
     *  🔒 ด่านที่ ④ — ตัวยิงอัตโนมัติ 60 วินาทีหลังบูต
     *
     *  🔴 นี่คือทางเข้าที่อันตรายที่สุดของทั้งสามทาง เพราะ "ไม่มีใครกด"
     *    · ยิงด้วย manual: true ⇒ ข้ามเงื่อนไข manualOnly ไปทั้งหมด
     *    · ไม่สนใจ SYNC_EVERY_MIN ⇒ ตั้ง 0 ไว้ก็ยังยิงอยู่ดี
     *    ⇒ ตั้ง SYNC_EVERY_MIN=0 แล้วนึกว่าปิดซิงก์แล้ว = เข้าใจผิด
     *      ทุกครั้งที่ Railway ดีพลอย ระบบจะดึงชีตเข้ามาเองภายใน 1 นาที
     *
     *  ‼ ต้องตัดทิ้ง "ตั้งแต่ก่อนตั้งเวลา" ไม่ใช่ปล่อยให้ไปตกด่านข้างใน
     *    เพราะ 60 วินาทีนั้นคือเวลาที่ไม่มีใครเฝ้าจอ
     * ═══════════════════════════════════════════════════════════ */
    if (syncJobs.syncMode() === 'off') {
      console.log('[sync] 🔒 SHEET_SYNC=off — ไม่ยิงตัวกู้คืนหลังรีสตาร์ท ' +
                  `(งานที่ค้าง ${names.length} งานถูกปิดแถวไว้แล้ว ไม่ต้องดึงชีตซ้ำ)`);
      return;
    }
    const retry = names.filter(n => syncJobs.syncAllowed(n));
    if (!retry.length) {
      console.log(`[sync] 🔒 SHEET_SYNC=${syncJobs.syncMode()} — งานที่ค้าง ` +
                  `${names.length} งานถูกด่านปิดไว้ทั้งหมด ไม่ยิงตัวกู้คืน`);
      return;
    }
    if (retry.length !== names.length)
      console.log(`[sync] 🔒 SHEET_SYNC=${syncJobs.syncMode()} — กู้คืนเฉพาะ ` +
                  `${retry.length}/${names.length} งานที่ด่านอนุญาต`);

    /* ‼ หน่วง 60 วินาที ให้เซิร์ฟเวอร์ตั้งตัวก่อน (โมดูล · Google · ฐานข้อมูล)
     *   ยิงทันทีตอนบูตคือวิธีที่ดีที่สุดที่จะทำให้มันพังซ้ำรอบสอง */
    setTimeout(() => {
      console.log(`[sync] กู้คืนหลังรีสตาร์ท — ลองใหม่: ${retry.join(', ')}`);
      runAllSync('กู้คืนหลังรีสตาร์ท', { manual: true, only: retry })
        .then(r => console.log('[sync] กู้คืนหลังรีสตาร์ท:', r.ok ? 'สำเร็จ' : (r.error || 'ไม่สำเร็จ')))
        .catch(e => console.error('[sync] กู้คืนหลังรีสตาร์ทพัง:', e.message));
    }, 60000).unref?.();
  }).catch(() => { /* ยังไม่มีตารางก็ไม่เป็นไร */ });

  /* ตั้งเวลาซิงค์อัตโนมัติ — ทำหลังเซิร์ฟเวอร์พร้อมแล้ว
   * ถ้ายังไม่ได้ตั้งค่า Google ก็แค่ข้ามไป ระบบส่วนอื่นทำงานปกติ */
  /* ═══════════════════════════════════════════════════════════════
   *  🔒 ด่านที่ ⑤ — ไม่ตั้งนาฬิกาเลยเมื่อ SHEET_SYNC=off
   *
   *  ‼ ด่าน ① ใน runAllSync ก็กันได้อยู่แล้ว แต่ปล่อยให้ cron วิ่งทุก 10 นาที
   *    เพื่อไปตกด่านคือการ "เขียน log ขยะทุก 10 นาทีตลอดกาล" และทำให้
   *    คนอ่าน log เข้าใจผิดว่าระบบยังพยายามซิงก์อยู่ ⇒ ไม่ตั้งไปเลยดีกว่า
   *  ‼ โหมด phase1 ยังตั้งนาฬิกาตามเดิม — แต่รอบที่วิ่งจะเหลือแค่กลุ่ม A
   *    เพราะด่าน ② ในลูปคัดให้ทีละงาน
   * ═══════════════════════════════════════════════════════════════ */
  if (syncJobs.syncMode() === 'off') {
    console.log('[sync] 🔒 ' + syncJobs.SYNC_OFF_MSG);
    console.log('[sync] 🔒 SHEET_SYNC=off — ไม่ตั้งเวลาซิงก์ · ไม่ตั้งเวลาดึงกระจก · ' +
                'ปุ่มดึงข้อมูลบนหน้า /sync ถูกปฏิเสธที่ฝั่งเซิร์ฟเวอร์');
  } else if (CFG.SYNC_EVERY_MIN > 0 && sheets.isConfigured() && syncJobs.jobs().length) {
    const cron = require('node-cron');
    const every = Math.min(CFG.SYNC_EVERY_MIN, 59);
    cron.schedule(`*/${every} * * * *`, () => {
      runAllSync('ตามเวลา').catch(e => console.error('[sync] รอบตามเวลาพัง:', e.message));
    }, { timezone: CFG.TZ });
    /* ‼ บอกจำนวน "งานที่จะวิ่งจริง" ไม่ใช่จำนวนงานทั้งหมด
     *   log ที่บอก 95 งานทั้งที่วิ่งจริง 11 งาน คือ log โกหก */
    console.log(`[sync] ตั้งเวลาซิงค์ทุก ${every} นาที · ` +
      (syncJobs.syncMode() === 'on'
        ? `${syncJobs.jobs().length} งาน`
        : `🔒 SHEET_SYNC=${syncJobs.syncMode()} — วิ่งจริง ${syncJobs.allowedJobs().length}` +
          `/${syncJobs.jobs().length} งาน (อีก ${syncJobs.blockedJobs().length} งานถูกปิด)`));

    /* กระจกมีจังหวะแยก — ปิดไว้เป็นค่าเริ่มต้น (ข้อมูลหลายแสนแถว) */
    /* 🔒 กระจก = ดึงทุกแท็บที่เหลือเข้ามา ⇒ ไม่มีงานไหนอยู่ในกลุ่ม A
     *   โหมดที่ไม่ใช่ on ต้องไม่ตั้งนาฬิกาให้มันเลย */
    if (syncJobs.syncMode() !== 'on') {
      console.log(`[กระจก] 🔒 SHEET_SYNC=${syncJobs.syncMode()} — ไม่ตั้งเวลาดึงกระจก ` +
                  'และปุ่ม "ดึงกระจก" ถูกปฏิเสธที่ฝั่งเซิร์ฟเวอร์');
    } else if (CFG.SYNC_MIRROR_EVERY_MIN > 0) {
      const m = Math.min(CFG.SYNC_MIRROR_EVERY_MIN, 59);
      cron.schedule(`*/${m} * * * *`, () => {
        runMirrorSync('ตามเวลา').catch(e => console.error('[กระจก] รอบตามเวลาพัง:', e.message));
      }, { timezone: CFG.TZ });
      console.log(`[กระจก] ตั้งเวลาดึงทุก ${m} นาที`);
    } else {
      console.log('[กระจก] ปิดการดึงอัตโนมัติ — กดเองที่หน้า /sync');
    }
  } else if (!sheets.isConfigured()) {
    console.log('[sync] ยังไม่ได้ตั้งค่า Google Sheets — ข้ามการซิงค์อัตโนมัติ');
  }

  /* ‼ คืนตัวจับเวลาซิงก์ PEAK หลังรีสตาร์ท
   *   Railway ดีพลอยใหม่ = โปรเซสเกิดใหม่ ตัวจับเวลาในหน่วยความจำหายหมด
   *   ถ้าไม่คืนให้ คิวที่ค้างอยู่จะนอนนิ่งจนกว่าจะมีคนมากดเอง
   *   (ของเดิมไม่มีปัญหานี้เพราะตัวจับเวลาอยู่ที่ Google ไม่ได้อยู่ในโปรเซส) */
  require('./core/peak-auto').restore()
    .catch(e => console.log('[peak-auto] คืนตัวจับเวลาไม่ได้:', e.message));

  /* ‼ เหตุผลเดียวกันสำหรับตัวดึงรายจ่าย (เงินออกของหน้า Cash Flow)
   *   ของเดิมเป็น trigger ของ Google จึงรอดการรีสตาร์ท — ของเราอยู่ในโปรเซส
   *   สั่งดึงค้างไว้แล้วระบบดีพลอยใหม่ = ค้างกลางทางตลอดกาลถ้าไม่คืนให้ */
  require('./core/peak-expenses').ensure()
    .catch(e => console.log('[peak-expenses] คืนตัวจับเวลาไม่ได้:', e.message));

  /* ‼ ย้ายรูปพนักงานเข้าบ้านเราให้เอง ถ้ายังไม่เคยย้าย (5 ก.ย. 69)
   *   พี่เอไม่ต้องกดอะไรเลย — ทำครั้งเดียวตอนบูต แล้วไม่ยุ่งอีก
   *   ‼ ไม่ await เพราะห้ามให้เซิร์ฟเวอร์ช้าเพราะเรื่องรูป
   *   ‼ วันที่ปิดชีตแล้ว ตั้ง PHOTO_IMPORT=off ตัวนี้จะข้ามไปเอง */
  require('./core/photo').autoImportOnce()
    .catch(e => console.log('[รูปพนักงาน] ย้ายอัตโนมัติไม่สำเร็จ:', e.message));

  app.listen(CFG.PORT, () => {
    const s = registry.summary();
    console.log(`
╔══════════════════════════════════════════════════════╗
║  🐜 ระบบ CRM มดงานการป้าย                            ║
╠══════════════════════════════════════════════════════╣
║  พอร์ต    : ${String(CFG.PORT).padEnd(40)}║
║  โหมด     : ${String(CFG.NODE_ENV).padEnd(40)}║
║  โมดูล    : พร้อมใช้ ${s.ready} · กำลังย้าย ${s.wip} · ยังไม่เริ่ม ${String(s.planned).padEnd(14)}║
╚══════════════════════════════════════════════════════╝`);
  });
})();
