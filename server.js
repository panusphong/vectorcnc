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
const host = require('./core/module-host');
const sheets = require('./core/sheets');
const sync = require('./core/sync');
const syncJobs = require('./core/sync-jobs');
const mirror = require('./core/sync-mirror');
const sheetFiles = require('./core/sheet-files');

assertReady();
process.env.TZ = CFG.TZ;

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
    await auth.audit(req.user, 'change_password', {}, auth.metaOf(req));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══════════════════ Hub ══════════════════ */

app.get('/', auth.requireLogin(), (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'hub.html')));

/** หน้าจัดการการซิงค์ชีต — แอดมินเท่านั้น */
app.get('/sync', auth.requireLogin('ADMIN'), (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'sync.html')));

app.get('/api/me', auth.requireLogin(), (req, res) =>
  res.json({ ok: true, user: req.user, minPassword: CFG.MIN_PASSWORD }));

app.get('/api/modules', auth.requireLogin(), (req, res) => {
  const mods = registry.visibleTo(req.user).map(m => ({
    key: m.key, title: m.title, subtitle: m.subtitle, icon: m.icon,
    color: m.color, status: m.status, path: m.basePath,
    canUse: registry.canUse(req.user, m).ok,
  }));
  res.json({ ok: true, modules: mods, summary: registry.summary() });
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

/* ══════════════════ ตรวจสุขภาพระบบ ══════════════════ */

app.get('/healthz', async (_req, res) => {
  // ‼ ต้องส่ง hint/error ออกมาด้วย ไม่งั้นรู้แค่ว่า "พัง" แต่ไม่รู้ว่าพังเพราะอะไร
  let p = { ok: false, ms: 0, hint: 'เรียก db.ping() ไม่สำเร็จ' };
  try { p = await db.ping(); } catch (e) { p.error = String((e && e.message) || e).slice(0, 300); }
  res.json({
    ok: p.ok, uptime: Math.round(process.uptime()),
    db: p,
    modules: registry.summary(),
    version: require('./package.json').version,
  });
});


/* ══════════════════ ซิงค์จาก Google Sheets (ทางเดียว) ══════════════════
 *  ช่วงใช้ 2 ระบบคู่กัน: ทีมยังคีย์ในแอปเดิม → ลงชีต → ระบบนี้ดึงมาเป็นกระจก
 *  ไม่มี endpoint ไหนเขียนกลับชีตเลย และ core/sheets.js ขอสิทธิ์ readonly ไว้แล้ว */

let _syncing = false;
let _discovering = false;      // ประกาศไว้ตรงนี้คู่กัน — สองตัวนี้ต้องไม่ทำงานพร้อมกัน

/** สั่งซิงค์ทุกงานทีละตัว — กันไม่ให้ทับซ้อนกันเอง */
async function runAllSync(by) {
  if (_syncing) return { ok: false, error: 'มีรอบซิงค์ค้างอยู่ กรุณารอสักครู่' };
  /* ‼ ห้ามชนกับการสำรวจ — ทั้งคู่ยิง Google API รัว ๆ พร้อมกันแล้วเน็ตสะดุด
   *   (4 ก.ย. 69: กดสำรวจตอนรอบตามเวลากำลังทำ → ล้มรวด 7 งาน 'fetch failed') */
  if (_discovering) return { ok: false, error: 'กำลังสำรวจแท็บอยู่ รอให้จบก่อนแล้วค่อยซิงค์' };
  const list = syncJobs.jobs();
  if (!list.length) return { ok: false, error: 'ยังไม่ได้ตั้งค่า SHEET_*_ID ใน Railway > Variables' };
  if (!sheets.isConfigured()) return { ok: false, error: 'ยังไม่ได้ตั้งค่า GOOGLE_SA_JSON' };

  _syncing = true;
  const results = [];
  try {
    for (const job of list) {
      const log = (...a) => console.log(`[sync:${job.name}]`, ...a);
      // บางงานมีกฎเฉพาะของตัวเอง (เช่น ผู้ใช้ ที่ห้ามทับรหัสผ่าน)
      const r = job.run ? await job.run({ ...job, log })
                        : await sync.syncSheet({ ...job, log });
      results.push({ name: job.name, title: job.title, ...r });
    }

    /* ‼ กระจกไม่ได้อยู่ในรอบนี้โดยตั้งใจ
     *
     *   สำรวจแล้วเจอของจริง 181 แท็บ · ใหญ่สุด ProductionLogs 72,934 แถว
     *   รวมกันหลายแสนแถว ถ้าดึงพ่วงมากับรอบ 10 นาที จะไม่มีทางจบสักรอบ
     *   แถมทำให้ตารางจริงที่คนใช้งานอยู่ (ยอดขาย · Projects) พลอยช้าไปด้วย
     *
     *   กระจกจึงมีจังหวะของตัวเอง — ดูฟังก์ชัน runMirrorSync ข้างล่าง */
  } finally { _syncing = false; }

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

app.post('/api/admin/sync/mirror', auth.requireLogin('ADMIN'), async (req, res) => {
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
      configured: sheets.isConfigured(),
      everyMin: CFG.SYNC_EVERY_MIN,
      jobs: syncJobs.jobs().map(j => ({ name: j.name, title: j.title, table: j.table, tab: j.tab })),
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
app.post('/api/admin/sync', auth.requireLogin('ADMIN'), async (req, res) => {
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

  runAllSync(user.username)
    .then(r => auth.audit(user, 'sync_run', { target: 'sheets', ok: r.ok }, auth.metaOf(req)))
    .catch(e => console.error('[sync] ล้มเหลว:', e));
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
    res.json({ ok: true, files: out, email: sheets.credentials().email });
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
        const { header } = await sheets.readHead(j.sheetId, j.tab, 2);
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

/* ══════════════════ ไฟล์หน้าเว็บส่วนกลาง ══════════════════ */
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

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
  db.update('sync_run', { finished_at: 'is.null' }, {
    finished_at: new Date().toISOString(), ok: false,
    error: 'ระบบรีสตาร์ทระหว่างซิงค์ — รอบนี้ไม่จบ (กดซิงค์ใหม่ได้เลย)',
  }).then(r => {
    const n = Array.isArray(r) ? r.length : 0;
    if (n) console.log(`[sync] ปิดรอบที่ค้างจากการรีสตาร์ท ${n} รอบ`);
  }).catch(() => { /* ยังไม่มีตารางก็ไม่เป็นไร */ });

  /* ตั้งเวลาซิงค์อัตโนมัติ — ทำหลังเซิร์ฟเวอร์พร้อมแล้ว
   * ถ้ายังไม่ได้ตั้งค่า Google ก็แค่ข้ามไป ระบบส่วนอื่นทำงานปกติ */
  if (CFG.SYNC_EVERY_MIN > 0 && sheets.isConfigured() && syncJobs.jobs().length) {
    const cron = require('node-cron');
    const every = Math.min(CFG.SYNC_EVERY_MIN, 59);
    cron.schedule(`*/${every} * * * *`, () => {
      runAllSync('ตามเวลา').catch(e => console.error('[sync] รอบตามเวลาพัง:', e.message));
    }, { timezone: CFG.TZ });
    console.log(`[sync] ตั้งเวลาซิงค์ทุก ${every} นาที · ${syncJobs.jobs().length} งาน`);

    /* กระจกมีจังหวะแยก — ปิดไว้เป็นค่าเริ่มต้น (ข้อมูลหลายแสนแถว) */
    if (CFG.SYNC_MIRROR_EVERY_MIN > 0) {
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
