'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  🔐 ด่านล็อกอิน "พนักงานภายใน vs คนนอก" — npm run test:logingate
 *
 *  พี่เอสั่ง 13 ก.ย. 69:
 *    "ตอนที่ login เข้ามาตอนนี้ มันจับ Table : Login ใน google sheet เดิมอยู่
 *     เพื่อเช็คว่าเป็นพนักงานภายในเราเอง หรือเป็นคนนอก login เข้ามานะ
 *     ต้องเปลี่ยนตรงนี้ให้พี่ก่อน ไม่งั้น คนที่เข้าผ่าน link จะเข้ามาใช้งานได้หมด"
 *
 *  ยามตัวนี้คุม 6 เรื่อง — ทุกข้อยิงผ่าน express ตัวจริง ไม่ได้อ่านซอร์สเดา
 *    ① กวาด "ทุก route ของทุกโมดูล" แบบไดนามิก (อ่านจาก express router จริง)
 *       ⇒ ใครเพิ่ม route ใหม่แล้วลืมด่าน ยามนี้แดงทันทีโดยไม่ต้องมาแก้เทสต์
 *    ② คนนอกที่ไม่มีคุกกี้ — ต้องโดนปฏิเสธทุกเส้น
 *    ③ คนนอกที่มีคุกกี้ลายเซ็นถูก แต่ไม่มีชื่อในระบบ (เช่นถูกลบไปแล้ว) — ต้องโดนปฏิเสธทุกเส้น
 *    ④ พนักงานภายในทุกบทบาทยังเข้าได้เหมือนเดิม (พิสูจน์ว่าไม่ได้ล็อกใครออก)
 *    ⑤ ‼ ฐานข้อมูลล่ม / ตอบ error ⇒ ต้อง "ปฏิเสธ" ไม่ใช่ปล่อยผ่าน (fail-closed)
 *    ⑥ เส้นทางล็อกอินต้องไม่แตะ Google Sheet อีกแล้ว · ลิงก์ภายนอกต้องไม่มีตั๋วติดไป
 *
 *  🔴 ห้ามหยุดเวลาด้วย Date.now = () => … (V8 ไม่เรียก) — ยามนี้ไม่ได้หยุดเวลาเลย
 * ═══════════════════════════════════════════════════════════════════ */
const http = require('http');
const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok   = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);

/* ═══════════════════════════════════════════════════════════════════
 *  ① ฐานข้อมูลปลอมที่ "สวิตช์ให้ล่มได้"
 *
 *  ‼ ปลอมที่ชั้น HTTP (PostgREST) ไม่ใช่ปลอมที่ db.one
 *    เพราะสิ่งที่ต้องพิสูจน์คือ "ฐานตอบ error แล้วระบบทำตัวยังไง"
 *    ปลอมสูงกว่านั้น = ไม่ได้ทดสอบเส้นทาง error จริงที่ core/db.js เดินผ่าน
 *
 *  ‼ ilike ของที่นี่ทำตัวเหมือน PostgREST จริง: * และ % = อะไรก็ได้ · _ = 1 ตัว
 *    ถ้าทำให้ใจดีกว่าของจริง บั๊ก "ล็อกอินด้วยชื่อ *" จะไม่ถูกจับ
 * ═══════════════════════════════════════════════════════════════════ */
const bcrypt = require('bcryptjs');
const H = pw => bcrypt.hashSync(pw, 4);          /* cost ต่ำ = เทสต์เร็ว (ใช้ในเทสต์เท่านั้น) */

/** พนักงานภายในครบทุกบทบาทที่ core/auth.js รู้จัก (ADMIN·ACCOUNTING·OFFICER·TECH·VIEWER) */
const STAFF = [
  { Username: 'admin',   Name: 'พนัสพงษ์',  Nickname: 'เอ',   Permission: 'Administrator',  Status: 'Login' },
  { Username: 'namna',   Name: 'น้ำหนา',    Nickname: 'น้ำ',  Permission: 'Administrator',  Status: 'Login' },
  { Username: 'som',     Name: 'สมศรี',     Nickname: 'ศรี',  Permission: 'Accounting',     Status: 'Login' },
  { Username: 'plan1',   Name: 'ปราณี',     Nickname: 'ปุ๊ก', Permission: 'Planning',       Status: 'Login' },
  { Username: 'chang1',  Name: 'ชาติชาย',   Nickname: 'ชาย',  Permission: 'ช่างนอก',        Status: 'Login' },
  { Username: 'ploy',    Name: 'พลอยไพลิน', Nickname: 'พลอย', Permission: 'Sale',           Status: 'Login' },
  /* ‼ 'pu.s' กับ 'pu_s' อยู่คู่กันตั้งใจ — ใช้จับบั๊ก "_ ของ ilike ไปตรงแถวคนอื่น" */
  { Username: 'pu.s',    Name: 'ปุณณภา',    Nickname: 'ปู',   Permission: 'Sale support',   Status: 'Login' },
  /* คนที่ถูกปิดบัญชีไว้ — ต้องเข้าไม่ได้ (กติกาเดิมของระบบใหม่) */
  { Username: 'ออก',     Name: 'ลาออกแล้ว', Nickname: '-',    Permission: 'Sale',           Status: 'Logout' },
].map(u => ({ ...u, Impage: '', AppAccess: '', Password: null, PasswordHash: H('pw-' + u.Username) }));

let MODE = 'ok';                 /* 'ok' | 'down' */
let sheetCalls = 0;              /* นับการเปิด Google Sheet ระหว่างล็อกอิน */

function ilikeRx(pat) {
  const body = String(pat)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/%/g, '.*')
    .replace(/_/g, '.');
  return new RegExp('^' + body + '$', 'i');
}

const fakeDb = http.createServer((req, res) => {
  if (MODE === 'down') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end('{"message":"ฐานข้อมูลล่ม (จำลอง)"}');
  }
  const u = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    let out = [];
    if (u.pathname.startsWith('/rest/v1/app_users')) {
      const raw = u.searchParams.get('Username') || '';
      const op  = raw.split('.')[0];
      const val = raw.slice(op.length + 1);
      if (op === 'ilike')   out = STAFF.filter(x => ilikeRx(val).test(x.Username));
      else if (op === 'eq') out = STAFF.filter(x => x.Username === val);
      else                  out = STAFF.slice();
      const lim = Number(u.searchParams.get('limit') || 0);
      if (lim) out = out.slice(0, lim);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  ② ยกเซิร์ฟเวอร์ตัวจริงขึ้นมา (server.js ทั้งไฟล์ ไม่ใช่ router จำลอง)
 *
 *  ‼ server.js ไม่ได้ export app ออกมา (และห้ามแก้เพื่อเทสต์)
 *    ⇒ ดัก express() ตัวแรกที่ถูกเรียก = ตัว app จริง แล้วดัก app.listen
 *      ให้เปิดพอร์ตสุ่มแทนพอร์ตจริง — โค้ดที่ทดสอบไม่ถูกแตะแม้แต่บรรทัดเดียว
 * ═══════════════════════════════════════════════════════════════════ */
function bootRealServer() {
  return new Promise(resolve => {
    const em = require(path.join(ROOT, 'node_modules', 'express'));
    let first = null;
    const wrapped = function (...a) {
      const app = em(...a);
      if (!first) {
        first = app;
        const origListen = app.listen.bind(app);
        app.listen = (...args) => {
          const cb = args[args.length - 1];
          const srv = origListen(0, () => {});
          if (typeof cb === 'function') setTimeout(cb, 0);
          resolve({ app, srv });
          return srv;
        };
      }
      return app;
    };
    Object.setPrototypeOf(wrapped, em);
    for (const k of Object.keys(em)) wrapped[k] = em[k];
    require.cache[require.resolve(path.join(ROOT, 'node_modules', 'express'))].exports = wrapped;

    /* ‼ ดัก core/sheets.js ก่อน server.js จะถูกโหลด — ไว้พิสูจน์ข้อ ⑥
     *   ถ้ามีใครแอบเปิดชีตในเส้นทางล็อกอิน ตัวนับนี้จะขึ้น */
    const sheets = require(path.join(ROOT, 'core', 'sheets.js'));
    for (const fn of ['readTab', 'readRange', 'listTabs', 'open']) {
      if (typeof sheets[fn] === 'function') {
        const orig = sheets[fn];
        sheets[fn] = (...a) => { sheetCalls++; return orig.apply(sheets, a); };
      }
    }

    process.chdir(ROOT);
    require(path.join(ROOT, 'server.js'));
  });
}

/* ─── อ่านทุก route ออกจาก express router จริง ─────────────────────── */
function listRoutes(app) {
  const out = [];
  const mountPath = layer => {
    if (layer.path) return layer.path;
    const s = layer.regexp && layer.regexp.source;
    if (!s || s === '^\\/?(?=\\/|$)') return '';
    const m = s.match(/^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)\$?$/);
    return m ? '/' + m[1].replace(/\\\//g, '/').replace(/\\\./g, '.') : '';
  };
  (function walk(stack, prefix) {
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const p of paths)
          for (const m of Object.keys(layer.route.methods))
            if (m !== '_all') out.push({ p: prefix + p, m });
      } else if (layer.name === 'serveStatic') {
        /* ‼ ไฟล์หน้าเว็บก็ต้องมีด่าน — ไม่งั้นคนนอกโหลด index.html ของแอปได้ */
        out.push({ p: prefix + mountPath(layer) + '/index.html', m: 'get' });
      } else if (layer.handle && layer.handle.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer));
      }
    }
  })(app._router.stack, '');

  const seen = new Set();
  return out.filter(r => {
    const k = r.m + ' ' + r.p;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const fillParams = p => p.replace(/:([A-Za-z0-9_]+)\*?/g, 'x').replace(/\*/g, 'x');

/* ═══════════════════════════════════════════════════════════════════
 *  🔓 ทะเบียน "เส้นทางที่ตั้งใจเปิดให้คนนอก" — ต้องตรงเป๊ะ ไม่ขาดไม่เกิน
 *
 *  ‼ นี่คือหัวใจของยามตัวนี้: เปิดเพิ่มเส้นไหนโดยไม่ได้ตั้งใจ = แดงทันที
 *    ถ้าจะเปิดเส้นใหม่จริง ต้องมาเติมที่นี่ด้วยมือ = มีคนอ่านและรับผิดชอบ
 *
 *  ที่มาของแต่ละเส้น:
 *    /login · /api/login · /api/logout   ประตูเข้าออกเอง
 *    /healthz                            Railway เรียกเช็คสุขภาพ (ไม่มีข้อมูลลูกค้า)
 *    /api/version                        ไว้ตอบ "ดีพลอยแล้วหรือยัง" (เลขเวอร์ชันล้วน)
 *    /assets · /brand                    โลโก้/ฟอนต์กลาง (ไฟล์หน้าเว็บล้วน)
 *    /m/delivery/track · /t · /api/track  ลูกค้าติดตามพัสดุ (module.json > publicPaths)
 *    /m/booking/sign…                    ลูกค้าเซ็นรับงานจาก QR (allow-list 2 ฟังก์ชัน)
 *    /m/reviews/r · /pub                 ลูกค้าให้รีวิวช่าง (allow-list 3 action)
 *
 *    🔴 /api/sso/verify                  เพิ่ม 13 ก.ย. 69 — เส้นเดียวที่เพิ่มเข้ามา
 *      จากงาน "ด่านเข้าแอปนอกระบบ Graphic Design Solution (VectorCNC)"
 *      ‼ ทำไมต้องเปิด: คนที่ยิงเข้าเส้นนี้คือ "เซิร์ฟเวอร์ของ VectorCNC"
 *        (Python บน Render) ไม่ใช่เบราว์เซอร์ของคน — มันไม่มีคุกกี้ของเรา
 *        และไม่มีทางมีได้ ⇒ requireLogin() ใช้กับเส้นนี้ไม่ได้โดยธรรมชาติ
 *      ‼ ด่านของมันคือ header X-SSO-Key (ค่าลับร่วมที่รู้กันแค่ 2 เครื่อง)
 *        ไม่ส่งคีย์ · คีย์ผิด · ยังไม่ได้ตั้งค่าลับ ⇒ 401 { ok:false } ทุกกรณี
 *        ⇒ "เข้าถึงได้" ไม่เท่ากับ "ใช้ได้" — ยาม npm run test:sso พิสูจน์ไว้
 *      ‼ ส่วนเส้นออกตั๋ว GET /api/sso/vectorcnc "ไม่ได้" อยู่ในทะเบียนนี้
 *        เพราะมันผ่าน auth.requireLogin() เหมือนเส้นอื่นทุกประการ
 * ═══════════════════════════════════════════════════════════════════ */
const PUBLIC_ALLOW = new Set([
  'GET /login',
  'POST /api/login',
  'POST /api/logout',
  'GET /healthz',
  'GET /api/version',
  'GET /assets/index.html',
  'GET /brand/index.html',
  'GET /m/delivery/track',
  'GET /m/delivery/t/:id',
  'GET /m/delivery/api/track',
  'GET /m/booking/sign/',
  'POST /m/booking/sign/rpc',
  /* ═══════════════════════════════════════════════════════════════
   *  🔓 /m/inventory/recv — คนหน้างานสแกน QR ใบเบิกแล้วรับของเข้าคลังย่อย
   *
   *  ‼ พี่เออนุมัติเอง 17 ก.ย. 69 คำต่อคำ:
   *    "QR คลัง ทำให้เหมือนระบบเดิมที่ทำนะ ไม่ต้อง login เป็น QR Code สาธารณะ
   *     เหมือนกับ QR code ที่แชร์ให้ช่างติดตั้งไปเปิดให้ลูกค้าเซ็นต์รับงานนั่นแหละ"
   *  ⇒ ทำตามท่าเดียวกับ /m/booking/sign เป๊ะ (module.json > publicPaths)
   *
   *  ── เปิดแค่ไหน (อนุมัติแค่นี้ ห้ามขยายเอง) ──────────────────────
   *   · GET  /m/inventory/recv?p=recv&slip=…&t=…  หน้ารับของหน้าเดียว
   *     ‼ ?p= ค่าอื่น (manual · catalog) เด้งกลับเข้าแอปคลังหลังด่านล็อกอิน
   *   · POST /m/inventory/recv/rpc  เรียกได้ 2 ชื่อเท่านั้น
   *     (getIssueSlip · receiveIssueSlip) และ **ต้องมีลายเซ็น t= เสมอ**
   *     ⇒ ไม่มี t= = ปฏิเสธ (กันไล่เดาเลขใบ MR-YYYYMM-0001..9999)
   *     ‼ ไม่ได้อยู่ในทะเบียนนี้ เพราะมันตอบ 403 ให้ตัวตรวจอยู่แล้ว
   *   · GET  /m/inventory/?p=recv&slip=…&t=…  ลิงก์ QR "รูปเก่า" ที่พิมพ์ไปแล้ว
   *     ส่งต่อ (302) มาที่เส้นบนอย่างเดียว · ต้องมี slip + t ครบถึงจะส่งต่อ
   *     ไม่ครบ = เด้งไปหน้าล็อกอินตามเดิม ⇒ ตัวตรวจถือว่า "ปฏิเสธ" อยู่แล้ว
   *
   *  ── ยังปิดอยู่ทั้งหมด (ยาม npm run test:qrrecv พิสูจน์ทีละข้อ) ──────
   *   หน้าแอปคลังทั้งตัว · index/catalog/manual/receive.html · /api/_diag ·
   *   /api/rpc ตัวใหญ่ (132 ฟังก์ชัน) · ราคาทุน/ราคาซื้อ/มูลค่าสต็อก ·
   *   ประวัติการเบิก · รายงาน · ใบอื่นที่ไม่ได้อยู่ในลิงก์
   * ═══════════════════════════════════════════════════════════════ */
  'GET /m/inventory/recv/',
  'GET /m/reviews/r',
  'GET /m/reviews/pub',
  'POST /m/reviews/pub',
  'POST /api/sso/verify',
  /* 🔴 24 ก.ย. 69 (รอบ 94) — เส้นที่ "เซิร์ฟเวอร์ของ VectorCNC" ยิงเข้ามาเอง
   *   ท่าเดียวกับ /api/sso/verify เป๊ะ: ไม่มีคุกกี้ของเรา และไม่มีทางมีได้
   *   ⇒ ด่านคือ X-SSO-Key ไม่ใช่ด่านล็อกอิน (ยาม test:pricefeed พิสูจน์ทีละข้อ)
   *   ‼ ไม่ส่งคีย์มา / คีย์ผิด = 401 เสมอ ⇒ ตัวตรวจถือว่า "ปฏิเสธ" อยู่แล้ว */
  'GET /api/sso/price-catalog',
  /* 🔴 3 ต.ค. 69 (รอบ 222) — เส้นที่ "ฐานข้อมูลของระบบ Affiliate" ยิงเข้ามาเอง (Database Webhook)
   *   ท่าเดียวกับ /api/sso/verify: ไม่มีคุกกี้ของเรา และไม่มีทางมีได้
   *   ⇒ ด่านคือรหัสลับร่วม AFFILIATE_WEBHOOK_SECRET ไม่ใช่ด่านล็อกอิน (ยาม test:affiliate พิสูจน์ทีละข้อ)
   *   ‼ ไม่ตั้งรหัสลับ / ไม่ส่ง / ส่งผิด = 401 เสมอ ⇒ ตัวตรวจถือว่า "ปฏิเสธ" อยู่แล้ว */
  'POST /hook/affiliate/lead',
  /* 🔗 ลิงก์ให้ลูกค้าเปิดดูวิดีโอ (ไม่ต้องล็อกอินโดยตั้งใจ · ลิงก์สุ่ม 144 บิต · ปิดได้ · ไม่มีข้อมูลภายใน)
   *   /pv = วิดีโอ Facade (รอบ 149) · /dv = วิดีโองานออกแบบป้าย (รอบ 158)
   *   ‼ ตั๋วผิด/ปิดลิงก์ = 404 หน้า "ลิงก์นี้ปิดแล้ว" — ยาม test:designvideo / test-facade-video พิสูจน์ */
  'GET /pv/:tok',
  'GET /pv/:tok/video.mp4',
  'GET /pv/:tok/poster.jpg',
  'GET /dv/:tok',
  'GET /dv/:tok/video.mp4',
  'GET /dv/:tok/poster.jpg',
]);

/** โดนปฏิเสธไหม — 401 · 403 · เด้งไปหน้าล็อกอิน ถือว่า "ปฏิเสธ" */
const isDenied = (st, txt) => st === 401 || st === 403 || (st === 302 && /\/login/.test(txt));

(async () => {
  await new Promise(r => fakeDb.listen(0, r));

  process.env.SUPABASE_URL   = 'http://127.0.0.1:' + fakeDb.address().port;
  process.env.SUPABASE_KEY   = 'test-key';
  process.env.SESSION_SECRET = 'g'.repeat(64);
  process.env.PORT           = '0';
  process.env.PHOTO_IMPORT   = 'off';
  process.env.SYNC_EVERY_MIN = '0';
  process.env.DB_TIMEOUT_MS  = '1500';

  console.log('\n🔐 ทดสอบด่านล็อกอิน "พนักงานภายใน vs คนนอก"');

  const { app, srv } = await bootRealServer();
  await new Promise(r => setTimeout(r, 800));      /* รอ mountAll ต่อสายครบทุกโมดูล */
  const BASE = 'http://127.0.0.1:' + srv.address().port;

  const auth = require(path.join(ROOT, 'core', 'auth.js'));
  const CFG  = require(path.join(ROOT, 'core', 'config.js')).CFG;
  const cookieOf = tok => CFG.COOKIE_NAME + '=' + tok;

  async function hit(r, cookie) {
    const init = {
      method: r.m.toUpperCase(), redirect: 'manual',
      headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { cookie } : {}),
    };
    if (['post', 'put', 'patch'].includes(r.m)) init.body = '{}';
    try {
      const res = await fetch(BASE + fillParams(r.p), init);
      return { st: res.status, txt: (await res.text()).slice(0, 200) };
    } catch (e) { return { st: -1, txt: String(e.message) }; }
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('① 🔭 กวาดทุก route ของทุกโมดูลจาก express router ตัวจริง');
  const ROUTES = listRoutes(app);
  ok(ROUTES.length > 200, `อ่าน route ออกมาได้ ${ROUTES.length} เส้น (ต้องเป็นหลักร้อย ไม่งั้นแปลว่าอ่านไม่ครบ)`);
  ok(ROUTES.some(r => r.p.startsWith('/m/jobcard/')), '  ครอบคลุมถึงเส้นทางในโมดูล (เช่น /m/jobcard/…)');

  /* ═════════════════════════════════════════════════════════════════ */
  head('② 🚪 คนนอก "ไม่มีคุกกี้เลย" ยิงทุกเส้น — ต้องโดนปฏิเสธหมด');
  const leakedNoCookie = [];
  for (const r of ROUTES) {
    const key = r.m.toUpperCase() + ' ' + r.p;
    const res = await hit(r, null);
    if (!isDenied(res.st, res.txt) && !PUBLIC_ALLOW.has(key))
      leakedNoCookie.push(`${res.st} ${key} → ${res.txt.replace(/\s+/g, ' ').slice(0, 70)}`);
  }
  ok(leakedNoCookie.length === 0,
     `‼ ไม่มีเส้นไหนหลุดด่านเลยจาก ${ROUTES.length} เส้น` +
     (leakedNoCookie.length ? '\n     🔴 ' + leakedNoCookie.join('\n     🔴 ') : ''));

  /* เส้นสาธารณะที่ประกาศไว้ ต้องยังเปิดอยู่จริง — กันแก้แรงจนลูกค้าใช้ไม่ได้ */
  {
    const missing = [];
    for (const key of PUBLIC_ALLOW) {
      const [m, p] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
      if (!ROUTES.some(r => r.m.toUpperCase() === m && r.p === p)) missing.push(key);
    }
    ok(missing.length === 0,
       '  เส้นสาธารณะที่ประกาศไว้ยังอยู่ครบ (ไม่ได้เผลอปิดหน้าติดตามพัสดุ/เซ็นรับงาน/รีวิว)' +
       (missing.length ? ' — หายไป: ' + missing.join(' · ') : ''));
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('③ 👻 คนนอกที่ถือคุกกี้ลายเซ็นถูก แต่ไม่มีชื่อในระบบ');
  const ghost = cookieOf(auth.issue({ u: 'ghost_outsider', r: 'ADMIN' }, 3600, 'session'));
  const leakedGhost = [];
  for (const r of ROUTES) {
    const key = r.m.toUpperCase() + ' ' + r.p;
    const res = await hit(r, ghost);
    if (!isDenied(res.st, res.txt) && !PUBLIC_ALLOW.has(key))
      leakedGhost.push(`${res.st} ${key}`);
  }
  ok(leakedGhost.length === 0,
     '‼ ปลอมบทบาทเป็น ADMIN ในโทเคนก็ไม่ช่วย — ระบบเช็คชื่อกับฐานข้อมูลทุกคำขอ' +
     (leakedGhost.length ? '\n     🔴 ' + leakedGhost.join('\n     🔴 ') : ''));

  /* ═════════════════════════════════════════════════════════════════ */
  head('④ 🔑 ประตูล็อกอิน — คนนอกเข้าไม่ได้ · ชื่อต้องตรงตัว');
  const login = async (username, password) => {
    const res = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    let j = null; try { j = JSON.parse(await res.text()); } catch { /* ไม่ใช่ JSON */ }
    return { st: res.status, j, cookie: res.headers.get('set-cookie') || '' };
  };

  ok((await login('ghost_outsider', 'อะไรก็ได้')).st === 401, 'คนนอกที่ไม่มีชื่อในระบบ → 401');
  ok((await login('admin', 'รหัสผิด')).st === 401,           'พนักงานภายในแต่รหัสผิด → 401');
  ok((await login('', '')).st === 401,                        'ชื่อว่าง/รหัสว่าง → 401');
  ok((await login('ออก', 'pw-ออก')).st === 401,               'บัญชีที่ Status = Logout → 401 (กติกาเดิมของระบบใหม่)');

  /* 🔴 บั๊กจริงที่เจอ 13 ก.ย. 69 — ilike ของ PostgREST ถือว่า * % _ เป็นอักขระแทน
   *    ของเดิม (Apps Script) เทียบชื่อ "ตรงตัว" ทีละแถว จึงไม่มีช่องนี้เลย
   *    _source/jobcard/Code.gs:15358-15365 */
  for (const bad of ['*', '%', 'ad*', 'a%', '_dmin', '%%%']) {
    const r = await login(bad, 'pw-admin');
    ok(r.st === 401, `🔴 ล็อกอินด้วยชื่อ ${JSON.stringify(bad)} + รหัสของ admin → ต้องไม่ผ่าน (ได้ ${r.st})`);
  }
  {
    /* 'pu_s' ไม่มีในระบบ แต่ ilike ทำให้ไปตรงแถวของ 'pu.s' — สวมสิทธิ์ข้ามบัญชี */
    const r = await login('pu_s', 'pw-pu.s');
    ok(r.st === 401, '🔴 "pu_s" ต้องไม่ไปตรงกับแถวของ "pu.s" (สวมสิทธิ์ข้ามบัญชี)');
  }
  {
    const r = await login('ADMIN', 'pw-admin');
    ok(r.st === 200, '  ชื่อผู้ใช้ยังไม่สนตัวพิมพ์เล็กใหญ่เหมือนเดิม ("ADMIN" เข้าได้)');
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('⑤ 👨‍🏭 พนักงานภายในทุกบทบาทต้องเข้าได้เหมือนเดิม (ห้ามล็อกใครออก)');
  const cookies = {};
  for (const s of STAFF.filter(x => x.Status === 'Login')) {
    const r = await login(s.Username, 'pw-' + s.Username);
    ok(r.st === 200 && r.j && r.j.ok === true,
       `  ${s.Username} (${s.Permission}) ล็อกอินได้ · บทบาท = ${(r.j && r.j.user && r.j.user.role) || '-'}`);
    cookies[s.Username] = (r.cookie.split(';')[0] || '');
  }
  ok(!!cookies.admin && !!cookies.namna, '‼ admin และ namna ต้องเข้าได้เสมอ (ห้ามล็อกตัวเองออก)');

  for (const un of ['admin', 'namna', 'som', 'plan1', 'chang1', 'ploy', 'pu.s']) {
    const r1 = await hit({ p: '/api/me', m: 'get' }, cookies[un]);
    const r2 = await hit({ p: '/api/modules', m: 'get' }, cookies[un]);
    const r3 = await hit({ p: '/', m: 'get' }, cookies[un]);
    ok(r1.st === 200 && r2.st === 200 && r3.st === 200,
       `  ${un} เปิดหน้ารวมแอป + /api/me + /api/modules ได้ตามปกติ`);
  }
  {
    /* ADMIN ต้องยังเข้าหน้าซิงก์ได้ · คนทั่วไปต้องยังเข้าไม่ได้ (กติกาเดิม ไม่ได้เปลี่ยน) */
    const a = await hit({ p: '/sync', m: 'get' }, cookies.admin);
    const b = await hit({ p: '/sync', m: 'get' }, cookies.ploy);
    ok(a.st === 200, '  ADMIN ยังเข้าหน้าซิงก์ (/sync) ได้');
    ok(isDenied(b.st, b.txt), '  คนที่ไม่ใช่ ADMIN ยังเข้า /sync ไม่ได้เหมือนเดิม');
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('⑥ 🔴 ฐานข้อมูลล่ม / ตอบ error ⇒ ต้อง "ปฏิเสธ" ไม่ใช่ปล่อยผ่าน');
  {
    /* ‼ ต้องล้างแคชผู้ใช้ก่อน ไม่งั้นได้คำตอบจากของที่จำไว้ ไม่ใช่จากฐานที่ล่ม */
    MODE = 'down';
    auth.forgetUser();

    const probes = [
      { p: '/', m: 'get' }, { p: '/api/me', m: 'get' }, { p: '/api/modules', m: 'get' },
      { p: '/sync', m: 'get' }, { p: '/api/open/jobcard', m: 'get' },
      { p: '/m/jobcard/api/rpc', m: 'post' }, { p: '/m/sales/api/records', m: 'get' },
      { p: '/m/users/api/list', m: 'get' }, { p: '/m/audit/api/list', m: 'get' },
      { p: '/api/admin/sensitive', m: 'get' }, { p: '/facade/index.html', m: 'get' },
      { p: '/api/acp3d/health', m: 'get' },
    ];
    const passedThrough = [];
    for (const r of probes) {
      const res = await hit(r, cookies.admin);
      if (!isDenied(res.st, res.txt)) passedThrough.push(`${res.st} ${r.m.toUpperCase()} ${r.p}`);
    }
    ok(passedThrough.length === 0,
       '‼ ฐานล่มแล้วคุกกี้ของ admin ที่ถูกต้องก็ยังเข้าไม่ได้ (fail-closed)' +
       (passedThrough.length ? '\n     🔴 ปล่อยผ่าน: ' + passedThrough.join('\n     🔴 ') : ''));

    const l = await login('admin', 'pw-admin');
    ok(l.st !== 200, `‼ ล็อกอินตอนฐานล่มต้องไม่สำเร็จ (ได้ ${l.st})`);
    ok(!/crmhub|sid=/.test(l.cookie || ''), '  และต้องไม่มีคุกกี้เซสชันแจกออกมาด้วย');

    MODE = 'ok';
    auth.forgetUser();
    const back = await login('admin', 'pw-admin');
    ok(back.st === 200, '  ฐานกลับมา → ล็อกอินได้ตามปกติทันที (ไม่ค้างอยู่ในสภาพปฏิเสธ)');
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('⑦ 📄 เส้นทางล็อกอินต้องไม่แตะ Google Sheet อีกแล้ว');
  {
    ok(sheetCalls === 0,
       `‼ ตลอดการทดสอบทั้งหมด ไม่มีการเปิดชีตแม้แต่ครั้งเดียว (นับได้ ${sheetCalls} ครั้ง)`);

    /* ตัดคอมเมนต์ทิ้งก่อนค่อยกวาด — ไฟล์นี้พูดถึงชีตในคอมเมนต์เยอะมาก */
    const strip = src => String(src)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const authCode = strip(fs.readFileSync(path.join(ROOT, 'core', 'auth.js'), 'utf8'));
    ok(!/sheet|spreadsheet|readTab|googleapis/i.test(authCode),
       '‼ core/auth.js (ตัดคอมเมนต์แล้ว) ไม่มีคำสั่งอ่านชีตเหลืออยู่เลย');
    ok(/db\.select\(\s*T_USERS/.test(authCode) && /app_users/.test(authCode),
       '‼ ด่านนี้ตัดสินจากตาราง app_users บน Supabase');

    /* ตัวตัดสินต้องเป็น "ชื่อตรงตัว" — ไม่ใช่แถวแรกที่ ilike คว้ามาได้ */
    ok(/trim\(\)\.toLowerCase\(\)\s*===\s*want/.test(authCode),
       '‼ findUser() คัดเอาเฉพาะแถวที่ชื่อ "ตรงตัว" (เหมือน Apps Script เดิม)');

    /* หน้าล็อกอินต้องไม่ยิงไปที่ชีต/สคริปต์ของ Google */
    const loginHtml = fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8');
    ok(!/script\.google\.com|spreadsheets\/d\//i.test(loginHtml),
       '  หน้า /login ไม่ได้ยิงไปหา Google Apps Script / Google Sheets');
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('⑧ 🔒 ลิงก์ของการ์ดในหน้ารวมแอป ต้องไม่มีตั๋ว/โทเคน/ชื่อผู้ใช้ติดไปด้วย');
  {
    const hub = fs.readFileSync(path.join(ROOT, 'public', 'hub.html'), 'utf8');

    /* ‼ แก้ 13 ก.ย. 69 — เดิมกวาดเฉพาะ href ที่ขึ้นต้นด้วย http(s)://
     *   พอการ์ด Graphic Design เปลี่ยนไปชี้ที่ /api/sso/vectorcnc (เส้นในบ้าน
     *   ที่มี requireLogin กั้น แล้วค่อย redirect ออก) ก็ไม่เหลือ href ภายนอก
     *   ให้กวาดเลยสักเส้น ⇒ เงื่อนไข "ต้องมีอย่างน้อย 1 เส้น" จะแดงทั้งที่โค้ดถูก
     *
     *   ‼ นี่ไม่ใช่การลดความเข้ม — กวาด "ทุก href ของการ์ด" ทั้งในบ้านนอกบ้าน
     *     คือกวาดกว้างกว่าเดิม ข้อห้ามเรื่องพ่วงตั๋ว/ชื่อผู้ใช้ยังบังคับเหมือนเดิม */
    const m = hub.match(/href:\s*'([^']+)'/g) || [];
    ok(m.length > 0, `พบ href ของการ์ดในหน้ารวมแอป ${m.length} เส้น`);
    ok(m.every(x => !/[?&](t|ticket|token|u|user|email)=/.test(x)),
       '‼ ไม่มีเส้นไหนพ่วง ?t= / token / ชื่อผู้ใช้ / อีเมล ไปกับ URL');
    ok(!/href:\s*'https?:\/\/vectorcnc/i.test(hub),
       '🔴 การ์ด Graphic Design ไม่ลิงก์ตรงไป vectorcnc.onrender.com แล้ว — ต้องผ่านด่านของเราก่อน');
    ok(/href:\s*'\/api\/sso\/vectorcnc'/.test(hub),
       '🔴 ชี้ไปที่ /api/sso/vectorcnc ซึ่งมี auth.requireLogin() กั้นอยู่ที่ server.js');
    ok(/openUrl\(m\.href/.test(hub),
       '‼ การ์ดที่มี href เปิดด้วย openUrl() ซึ่งไม่แตะ /api/open (ทางที่พ่วงตั๋วคือ openApp เท่านั้น)');
    ok(/tab\.opener\s*=\s*null/.test(hub),
       '  และตัด opener ทิ้ง — หน้าปลายทางเขียนกลับมาที่หน้ารวมแอปไม่ได้');
  }

  console.log(`\n${fail ? '❌' : '✅'} ผ่าน ${pass} · ไม่ผ่าน ${fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n❌ ยามล้มกลางคัน:', e && e.stack || e);
  process.exit(1);
});
