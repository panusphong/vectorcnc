'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  🔐 ยาม "ตารางสิทธิ์การเข้าแอปทั้งระบบ" — npm run test:roleapps
 *
 *  ‼ พี่เอสั่ง 17 ก.ย. 69 คำต่อคำ (ยกมาทั้งหมด ไม่ตัดทอน):
 *    "จัด new agent มา 1 ตัวทำเรื่อง การกำหนดสิทธิ์ การเข้าถึง app ทั้งหมดใหม่นะ
 *     1. สิทธิ์ : after sale service เห็นแค่ App : Profile ช่างติดตั้ง , รีวิว + work order ,
 *        ระบบจองคิวติดตั้ง,คลังสินค้า Inventory
 *     2. สิทธ์ : planning เห็นแค่ app : Job card สั่งผลิต , ซ่อมบำรุง + PM , แผนจัดส่ง ,
 *        คลังสินค้า Inventory , Project management, ใบขอซื้อ Purchase request
 *     3. สิทธิ์ : administrator เข้าได้ทุก app
 *     4. สิทธิ์ : sales , sale support  เข้าได้ทุก app
 *     5. สิทธิ์ : กราฟิค เห็นแค่ : Project management system , Graphic design solution ,
 *        Job Card สั่งผลิต , ใบขอซือ Purchase Request , คลังสินค้า Inventory"
 *    "สิทธิ์ : กราฟิค สาขามดงาน เห็น app : Project management system ,
 *     Graphic design solution , Job Card สั่งผลิต , ใบขอซือ Purchase Request ,
 *     คลังสินค้า Inventory , คีย์ยอดขาย"
 *    "และ app ในการจัดการสิทธิ์ผู้ใช้ต้องให้สิทธิ์ แค่ user : admin , namna เท่านั้น"
 *
 *  ── 🔴 ยามนี้พิสูจน์อะไร ────────────────────────────────────────
 *    ① ทะเบียนแอปจริงกับตารางสิทธิ์ตรงกันเป๊ะ (โมดูลใหม่หลุดไม่ได้)
 *    ② แต่ละสิทธิ์เห็นการ์ดที่หน้ารวมแอป "ครบและไม่เกิน" ทีละใบ
 *    ③ 🔴 ซ่อนการ์ดไม่นับ — ยิง URL หน้าเว็บ และ API/RPC ตรง ๆ ต้องโดนปฏิเสธ
 *    ④ admin · namna เท่านั้นที่เปิดแอปจัดการผู้ใช้ได้ (ผูกชื่อ ไม่ใช่สิทธิ์)
 *    ⑤ 🔴 ชื่อคล้ายกันต้องไม่ผ่าน — 'xadmin' · 'adminx' · '*' · 'admin ' (เว้นวรรค)
 *       แต่ 'ADMIN' · 'Admin' ต้องผ่าน (ต่างแค่ตัวพิมพ์)
 *    ⑥ fail-closed — permission ว่าง/ไม่รู้จัก ⇒ ปฏิเสธ + มีข้อความบอกเหตุผล
 *    ⑦ หน้าตรวจสิทธิ์ของแอดมินรายงานสิทธิ์ที่ยังไม่มีในตารางจริง (ห้ามเงียบ)
 *    ⑧ 🔴 ตรวจสิทธิ์แล้วต้องไม่ยิงฐานข้อมูลเพิ่มแม้แต่คำขอเดียว
 *    ⑨ red-team — ถอดของที่แก้ออก ยามต้องแดงกลับ
 * ═══════════════════════════════════════════════════════════════════ */
const http = require('http');
const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok   = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);

/* ═══════════════════════════════════════════════════════════════════
 *  ① ฐานข้อมูลปลอมที่ "นับคำขอได้" (ท่าเดียวกับ tools/test-appgate.js)
 * ═══════════════════════════════════════════════════════════════════ */
const bcrypt = require('bcryptjs');
const H = pw => bcrypt.hashSync(pw, 4);

/* ‼ ค่า Permission ทุกตัวสะกดตามของจริงที่ยืนยันได้จาก core/auth.js PERMISSION_ROLE */
const STAFF = [
  /* ── เจ้าของระบบ ── */
  { Username: 'admin',   Permission: 'Administrator' },
  { Username: 'namna',   Permission: 'Administrator' },
  /* ── 🔴 Administrator คนอื่น — ต้องเข้าแอปจัดการผู้ใช้ไม่ได้ ── */
  { Username: 'bossx',   Permission: 'Administrator' },
  /* ── 🔴 ชื่อที่ "เกือบตรง" — ต้องไม่ผ่านเด็ดขาด ── */
  { Username: 'xadmin',  Permission: 'Administrator' },
  { Username: 'adminx',  Permission: 'Administrator' },
  /* ── 7 สิทธิ์ที่พี่เอสั่งไว้ ── */
  { Username: 'sale1',   Permission: 'Sale' },
  { Username: 'sales2',  Permission: 'Sales' },
  { Username: 'ss1',     Permission: 'Sale support' },
  { Username: 'as1',     Permission: 'After sale service' },
  { Username: 'plan1',   Permission: 'Planning' },
  { Username: 'graf1',   Permission: 'Graphic' },
  { Username: 'graf2',   Permission: 'Graphic สาขามดงาน' },
  /* ── สิทธิ์ที่มีในระบบแต่พี่เอยังไม่ได้สั่ง (คงสภาพเดิม + ต้องถูกรายงาน) ── */
  { Username: 'acc1',    Permission: 'Accounting' },
  { Username: 'free1',   Permission: 'Sale Freelance' },
  /* ── 🔴 fail-closed: ไม่รู้จัก / ว่าง ⇒ เปิดแอปไม่ได้เลย ── */
  { Username: 'weird1',  Permission: 'Marketing' },
  { Username: 'blank1',  Permission: '' },
].map(u => ({
  ...u, Name: u.Username, Nickname: u.Username, Impage: '', Status: 'Login',
  AppAccess: '', Password: null, PasswordHash: H('pw-' + u.Username),
}));

let MODE = 'ok';
let dbHits = 0;        /* ทุกคำขอที่วิ่งถึงฐาน */
let dbHitsUsers = 0;   /* เฉพาะที่อ่านตาราง app_users (= ของที่ด่านสิทธิ์จะใช้) */

function ilikeRx(pat) {
  const body = String(pat)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp('^' + body + '$', 'i');
}

const fakeDb = http.createServer((req, res) => {
  dbHits++;
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
      dbHitsUsers++;
      const raw = u.searchParams.get('Username') || '';
      if (raw) {
        const op = raw.split('.')[0];
        const val = raw.slice(op.length + 1);
        if (op === 'ilike')   out = STAFF.filter(x => ilikeRx(val).test(x.Username));
        else if (op === 'eq') out = STAFF.filter(x => x.Username === val);
        else                  out = STAFF.slice();
      } else {
        out = STAFF.slice();                 /* หน้าตรวจสิทธิ์อ่านรายชื่อสิทธิ์ทั้งหมด */
      }
      const lim = Number(u.searchParams.get('limit') || 0);
      if (lim) out = out.slice(0, lim);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});

/* ── ยกเซิร์ฟเวอร์ตัวจริงขึ้นมา (server.js ทั้งไฟล์) ───────────────── */
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
    process.chdir(ROOT);
    require(path.join(ROOT, 'server.js'));
  });
}

const isDenied = (st, txt) => st === 401 || st === 403 || (st === 302 && /\/login/.test(txt));

/* ═══════════════════════════════════════════════════════════════════
 *  🔴 ตารางที่ "พี่เอสั่งด้วยปาก" — เขียนไว้ที่นี่อีกชุดโดยตั้งใจ
 *
 *  ‼ ห้าม import มาจาก core/app-perms.js เด็ดขาด
 *    ยามที่อ่านคำตอบจากตัวที่มันตรวจ = ยามที่ยืนยันความผิดของตัวเอง
 *    ⇒ พิมพ์ซ้ำจากคำสั่งพี่เอตรง ๆ แล้วให้ทั้งสองฝั่งต้องตรงกัน
 * ═══════════════════════════════════════════════════════════════════ */

/** การ์ดโมดูลทั้งหมดที่ "คนเห็นทุกแอป" ควรเห็นที่หน้ารวมแอป
 *  (ready · ไม่ disabled · ไม่ hideInHub · ไม่ใช่แอปเครื่องมือระบบ) */
const ALL_CARDS = ['aftersale', 'appraisal', 'booking', 'checklist', 'delivery',
  'facade', 'inventory', 'jobcard', 'maintenance', 'payment', 'projects',
  'purchase', 'reviews', 'sales', 'technicians',
  /* 🏬💡 รอบ 234 (พี่เอ 4 ต.ค. 69: "ระบบจัดตารางสาขา … ระบบจองคิว LED … เพิ่ม app card หน้า CRM Hub ให้ด้วยนะ")
   *   การ์ดทางเข้าแอปภายนอก 2 ใบ — พี่เอไม่ได้จำกัดกลุ่ม ⇒ ตามกติกาเดิมของตารางนี้: คนที่ "เห็นทุกแอป" เห็น */
  'branchplan', 'ledqueue'];

/** + แอปเครื่องมือระบบที่เป็นโมดูล (เฉพาะ admin · namna)
 *  ‼ 17 ก.ย. 69 เพิ่ม 'registry' (ทะเบียนกลาง) — เกิดจากคำสั่งพี่เอ
 *    "ปิดการ sync sheet ให้หมดทุกไฟล์ ทำบน supabase 100%"
 *    ⇒ ค่ากลางที่ชีตเคยเป็นคนป้อน (ช่องทางการขาย · กิจการ · ทีมช่าง · ทักษะ)
 *      ต้องแก้ได้ในแอป และเปิดได้เฉพาะ admin · namna
 *      (core/app-access.js ADMIN_ONLY_EXTRA — คนละก้อนกับ TOOL_APPS ที่ถูกตรึงไว้) */
const TOOL_CARDS = ['audit', 'users', 'registry'];

/* ═══════════════════════════════════════════════════════════════════
 *  🔴 การ์ดที่ "กลุ่มสิทธิ์ administrator เท่านั้น" เห็น
 *
 *  ‼ พี่เอสั่ง 24 ก.ย. 69 คำต่อคำ (ตอนสั่งทำแอป BOM ต้นทุนสินค้า):
 *    "User ที่เข้าได้มีแค่กลุ่ม Permission : administrator เท่านั้นนะ"
 *
 *  🔴 ต่างจาก TOOL_CARDS ตรงที่ผูกกับ "กลุ่ม permission" ไม่ใช่ "ชื่อผู้ใช้"
 *    ⇒ bossx (Permission = Administrator แต่ชื่อไม่ใช่ admin/namna) ต้องเห็น
 *      แต่ sales · sale support · accounting ที่เคยได้ "ทุกแอป" ต้องไม่เห็น
 *    ‼ ข้อนี้คือกับดักจริงของรอบนี้: ROLE_APPS ตั้งสามกลุ่มนั้นเป็น ALL_APPS
 *      ⇒ แอปใหม่ทุกตัว "ติดไปให้ฟรี" ถ้าไม่มีด่านเฉพาะ
 * ═══════════════════════════════════════════════════════════════════ */
const ADMIN_PERM_CARDS = ['bom', 'mgmt', 'assetreg'];   /* mgmt = Management Report (รอบ 220 · พี่เอ 3 ต.ค. 69)
                                                         * assetreg = ระบบทะเบียนเบอร์โทร และทรัพย์สิน (รอบ 233 · พี่เอ 4 ต.ค. 69:
                                                         *   "ให้เฉพาะ permission : administrator เปิดดูได้เท่านั้นนะ") */

/* 🔴 การ์ดของ "เจ้าของระบบคนเดียว"
 *  ‼ 20 ก.ย. 69 พี่เอสั่งสองรอบติดกันในวันเดียว:
 *    รอบแรก  "ทำ app card สำหรับพี่คนเดียว คือ user : admin" → เคยมีการ์ด appaccess
 *    รอบสอง  "การกำหนดสิทธิ์เข้า app ต่างๆ จัดไว้ที่ ทะเบียนกลางได้เลยนะ"
 *    ⇒ การ์ดใบนั้นถูกถอดออกแล้ว ย้ายไปเป็น 3 แท็บใน "ทะเบียนกลาง" (registry)
 *    ⇒ รายการนี้จึงว่าง — คงชื่อไว้ให้เติมได้ทันทีถ้าวันหนึ่งมีการ์ดแบบนี้อีก
 *      (ด่าน ownerOnly ของสามแท็บนั้นมียามเฝ้าที่ tools/test-appaccess-card.js) */
const OWNER_CARDS = [];

const EXPECT_CARDS = {
  /* ข้อ 1 */
  as1:    ['technicians', 'reviews', 'booking', 'inventory'],
  /* ข้อ 2 */
  plan1:  ['jobcard', 'maintenance', 'delivery', 'inventory', 'projects', 'purchase'],
  /* ข้อ 5 — Graphic design solution ไม่ใช่โมดูล จึงไม่อยู่ในกริดของ /api/modules */
  graf1:  ['projects', 'jobcard', 'purchase', 'inventory'],
  /* ข้อความที่ 2 ของพี่เอ — เหมือน graphic + คีย์ยอดขาย */
  graf2:  ['projects', 'jobcard', 'purchase', 'inventory', 'sales'],
  /* ข้อ 3 · 4 */
  sale1:  ALL_CARDS,
  sales2: ALL_CARDS,
  ss1:    ALL_CARDS,
  /* 🔴 Administrator แต่ไม่ใช่ admin/namna — ได้การ์ด BOM เพราะผูกกับ "กลุ่ม" */
  bossx:  ALL_CARDS.concat(ADMIN_PERM_CARDS),
  admin:  ALL_CARDS.concat(ADMIN_PERM_CARDS).concat(TOOL_CARDS).concat(OWNER_CARDS),
  namna:  ALL_CARDS.concat(ADMIN_PERM_CARDS).concat(TOOL_CARDS),  /* 🔴 ไม่มี appaccess — พี่เอสั่ง "พี่คนเดียว" */
  /* สิทธิ์ที่ยังไม่ได้สั่ง — คงสภาพเดิม (ทุกแอป ยกเว้นข้อห้ามเดิมของคนนั้น) */
  acc1:   ALL_CARDS,
  free1:  ALL_CARDS.filter(k => k !== 'sales'),   /* คำสั่ง 14 ก.ย. 69 ยังอยู่ */
  /* 🔴 fail-closed */
  weird1: [],
  blank1: [],
};

/** แอปที่ Graphic Design Solution (นอกระบบ) ควรเปิดได้ */
const EXPECT_GRAPHIC = ['admin', 'namna', 'bossx', 'xadmin', 'adminx',
  'sale1', 'sales2', 'ss1', 'graf1', 'graf2', 'acc1', 'free1'];

(async () => {
  await new Promise(r => fakeDb.listen(0, r));

  process.env.SUPABASE_URL   = 'http://127.0.0.1:' + fakeDb.address().port;
  process.env.SUPABASE_KEY   = 'test-key';
  process.env.SESSION_SECRET = 'r'.repeat(64);
  process.env.PORT           = '0';
  process.env.PHOTO_IMPORT   = 'off';
  process.env.SYNC_EVERY_MIN = '0';
  process.env.DB_TIMEOUT_MS  = '1500';

  console.log('\n🔐 ยามตารางสิทธิ์การเข้าแอปทั้งระบบ (พี่เอสั่ง 17 ก.ย. 69)');

  const { srv } = await bootRealServer();
  await new Promise(r => setTimeout(r, 900));
  const BASE = 'http://127.0.0.1:' + srv.address().port;

  const registry  = require(path.join(ROOT, 'core', 'registry.js'));
  const appAccess = require(path.join(ROOT, 'core', 'app-access.js'));
  const perms     = require(path.join(ROOT, 'core', 'app-perms.js'));

  async function hit(p, m, cookie) {
    const init = {
      method: String(m || 'get').toUpperCase(), redirect: 'manual',
      headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { cookie } : {}),
    };
    if (['POST', 'PUT', 'PATCH'].includes(init.method)) init.body = '{}';
    try {
      const res = await fetch(BASE + p, init);
      return { st: res.status, txt: (await res.text()).slice(0, 4000) };
    } catch (e) { return { st: -1, txt: String(e.message) }; }
  }

  const login = async (username, password) => {
    const res = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    let j = null; try { j = JSON.parse(await res.text()); } catch { /* ไม่ใช่ JSON */ }
    return { st: res.status, j, cookie: (res.headers.get('set-cookie') || '').split(';')[0] || '' };
  };

  const C = {};
  for (const s of STAFF) {
    const r = await login(s.Username, 'pw-' + s.Username);
    if (r.st !== 200) { console.log('  ❌ ล็อกอิน ' + s.Username + ' ไม่ผ่าน (' + r.st + ')'); fail++; }
    C[s.Username] = r.cookie;
  }

  const cardsOf = async un => {
    const res = await fetch(BASE + '/api/modules', { headers: { cookie: C[un] } });
    const body = await res.json();
    return (body.modules || []).map(m => m.key).sort();
  };
  const meOf = async un =>
    (await fetch(BASE + '/api/me', { headers: { cookie: C[un] } })).json();

  /* เส้นทางจริงของทุกแอป — ② หน้าเว็บ · ③ API/RPC
   *  ‼ โมดูลถูกครอบด่านทั้ง prefix ที่ core/module-host.js
   *    ⇒ เส้น API มั่ว ๆ ใต้ /m/<key>/ ก็ต้องโดน 403 ถ้าไม่มีสิทธิ์
   *      (ถ้ามีสิทธิ์จะได้ 404/200 ซึ่งแปลว่า "ผ่านด่าน") */
  const ROUTES = {
    facade:    [['/facade/index.html', 'get'], ['/api/facade/leads', 'get']],
    sync:      [['/sync', 'get'], ['/api/admin/sync', 'get'], ['/api/admin/drive', 'get']],
    vectorcnc: [['/api/sso/vectorcnc', 'get']],
    acp3d:     [['/acp3d/', 'get'], ['/api/acp3d/health', 'get']],
  };
  const routesOf = key => ROUTES[key] ||
    [['/m/' + key + '/', 'get'], ['/m/' + key + '/index.html', 'get'],
     ['/m/' + key + '/api/rpc', 'post'], ['/m/' + key + '/api/list', 'get']];

  /** คืนรายการเส้นที่ "หลุด" (ไม่ถูกปฏิเสธ) ของแอปที่คนนี้ไม่ควรเข้าได้ */
  const leaks = async (un, key) => {
    const bad = [];
    for (const [p, m] of routesOf(key)) {
      const r = await hit(p, m, C[un]);
      if (!isDenied(r.st, r.txt)) bad.push(m.toUpperCase() + ' ' + p + ' → ' + r.st);
    }
    return bad;
  };

  /* ═════════════════════════════════════════════════════════════════ */
  head('① 📒 ทะเบียนแอปจริง ต้องอยู่ในตารางสิทธิ์ครบทุกตัว');
  {
    const real = registry.loadAll().map(m => m.key).sort();
    const missing = real.filter(k => perms.KNOWN_APPS.indexOf(k) < 0);
    ok(missing.length === 0,
       `‼ โมดูลจริง ${real.length} ตัว อยู่ในตารางครบ` +
       (missing.length ? ' — 🔴 ตกสำรวจ: ' + missing.join(' · ') : ''));

    const ghost = perms.KNOWN_APPS
      .filter(k => real.indexOf(k) < 0 && !perms.EXTRA_APP_TITLES[k]);
    ok(ghost.length === 0,
       '‼ ในตารางไม่มีแอปผีที่ไม่มีอยู่จริง' + (ghost.length ? ' — 🔴 ' + ghost.join(' · ') : ''));

    ok(perms.KNOWN_APPS.indexOf('sync') >= 0 && perms.KNOWN_APPS.indexOf('vectorcnc') >= 0,
       '  แอปที่ไม่ใช่โมดูล (sync · vectorcnc) อยู่ในตารางด้วย');
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('② 👁️ การ์ดที่หน้ารวมแอป ต้องตรงกับตารางสิทธิ์ "เป๊ะ" ไม่ขาดไม่เกิน');
  for (const un of Object.keys(EXPECT_CARDS)) {
    const want = EXPECT_CARDS[un].slice().sort();
    const got  = await cardsOf(un);
    const miss = want.filter(k => got.indexOf(k) < 0);
    const over = got.filter(k => want.indexOf(k) < 0);
    ok(miss.length === 0 && over.length === 0,
       `  ${un} เห็น ${got.length} การ์ด ตรงตามที่สั่ง` +
       (miss.length ? '\n     🔴 ขาด: ' + miss.join(' · ') : '') +
       (over.length ? '\n     🔴 เกิน: ' + over.join(' · ') : ''));
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('③ 🔴 ซ่อนการ์ดไม่นับ — ยิง URL หน้าเว็บ และ API ตรง ๆ ต้องโดนปฏิเสธ');
  {
    /* แอปที่มีเส้นทางให้ยิงจริง (ไม่รวม campaign ที่ปิดถาวร · chat/leave ไม่มีการ์ด) */
    const PROBE = ['sales', 'facade', 'jobcard', 'inventory', 'projects', 'purchase',
      'booking', 'technicians', 'reviews', 'delivery', 'maintenance', 'payment',
      'appraisal', 'checklist', 'aftersale', 'acp3d', 'vectorcnc', 'sync',
      'users', 'audit', 'bom'];
    for (const un of ['as1', 'plan1', 'graf1', 'graf2', 'free1', 'bossx', 'weird1', 'blank1']) {
      const allowed = new Set(EXPECT_CARDS[un]);
      if (EXPECT_GRAPHIC.indexOf(un) >= 0) allowed.add('vectorcnc');
      /* acp3d/sync/users/audit ไม่อยู่ใน EXPECT_CARDS ของใครนอกจาก admin/namna */
      if (un === 'bossx' || un === 'acc1' || un === 'free1') allowed.add('acp3d');
      if (un === 'sale1' || un === 'sales2' || un === 'ss1') allowed.add('acp3d');

      const bad = [];
      for (const key of PROBE) {
        if (allowed.has(key)) continue;
        for (const l of await leaks(un, key)) bad.push(key + ' · ' + l);
      }
      ok(bad.length === 0, `  🔴 ${un} ยิงตรงเข้าแอปที่ไม่มีสิทธิ์ไม่ได้สักเส้น` +
         (bad.length ? '\n     🔴 หลุด: ' + bad.join('\n     🔴 หลุด: ') : ''));
    }
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('④ ✅ แอปที่ "ต้องเข้าได้" ต้องเข้าได้จริง (ไม่ได้กันเกินคำสั่ง)');
  {
    const must = {
      as1:   ['technicians', 'reviews', 'booking', 'inventory'],
      plan1: ['jobcard', 'maintenance', 'delivery', 'inventory', 'projects', 'purchase'],
      graf1: ['projects', 'jobcard', 'purchase', 'inventory', 'vectorcnc'],
      graf2: ['projects', 'jobcard', 'purchase', 'inventory', 'sales', 'vectorcnc'],
      ss1:   ['sales', 'facade', 'jobcard', 'aftersale', 'payment'],
      sale1: ['sales', 'facade', 'jobcard', 'aftersale', 'payment'],
    };
    for (const un of Object.keys(must)) {
      const bad = [];
      for (const key of must[un]) {
        const [p, m] = routesOf(key)[0];
        const r = await hit(p, m, C[un]);
        if (isDenied(r.st, r.txt)) bad.push(key + ' → ' + r.st);
      }
      ok(bad.length === 0, `  ${un} เปิดแอปที่ควรเปิดได้ครบ` +
         (bad.length ? ' — 🔴 โดนกันผิด: ' + bad.join(' · ') : ''));
    }
    /* แผงที่อยู่ในหน้า Job Card ต้องเปิดได้ตามไปด้วย ไม่งั้นหน้านั้นพัง */
    for (const un of ['plan1', 'graf1']) for (const k of ['chat', 'leave']) {
      const r = await hit('/m/' + k + '/', 'get', C[un]);
      ok(!isDenied(r.st, r.txt), `  ${un} เปิดแผง ${k} ของ Job Card ได้ (${r.st})`);
    }
    for (const k of ['chat', 'leave']) {
      const r = await hit('/m/' + k + '/', 'get', C.as1);
      ok(isDenied(r.st, r.txt),
         `  🔴 as1 (ไม่มี Job Card) เปิดแผง ${k} ไม่ได้ (${r.st})`);
    }
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('⑤ 🔑 แอปจัดการผู้ใช้ — admin · namna เท่านั้น (ผูกชื่อ ไม่ใช่สิทธิ์)');
  {
    for (const un of ['admin', 'namna']) {
      const bad = [];
      for (const key of ['users', 'audit', 'sync']) {
        for (const [p, m] of routesOf(key)) {
          const r = await hit(p, m, C[un]);
          if (isDenied(r.st, r.txt)) bad.push(key + ' · ' + m.toUpperCase() + ' ' + p + ' → ' + r.st);
        }
      }
      ok(bad.length === 0, `  ${un} เปิด จัดการผู้ใช้ · บันทึกการใช้งาน · ซิงก์ชีต ได้ครบ` +
         (bad.length ? '\n     🔴 โดนกันผิด: ' + bad.join(' · ') : ''));
      /* 🔴 ห้ามล็อกตัวเองออก — ต้องเข้าได้ "ทุกแอป" ไม่ใช่แค่ 3 ตัวนี้
       *  ‼ 20 ก.ย. 69 — OWNER_ONLY_APPS ว่างแล้ว เพราะพี่เอสั่งให้ย้าย
       *    "จัดการสิทธิ์เข้าแอป" ไปเป็นแท็บในทะเบียนกลาง ไม่ใช่การ์ดใบใหม่
       *    ⇒ ทั้ง admin และ namna ต้องเปิดได้ครบทุกแอปในทะเบียนเหมือนเดิม
       *    (ส่วนด่าน "แท็บสิทธิ์เข้าแอป" ที่ admin คนเดียวแก้ได้ มียามแยกเฝ้าไว้
       *     ที่ tools/test-appaccess-card.js — คนละชั้นกับการเปิดแอป) */
      const owner = appAccess.OWNER_ONLY_APPS || [];
      const want = perms.KNOWN_APPS.filter(k => un === 'admin' || owner.indexOf(k) < 0);
      const no = want.filter(k => !appAccess.canOpen({ username: un, permission: 'Administrator' }, k));
      ok(no.length === 0, `  🔴 ${un} เปิดได้ทุกแอปที่ควรได้ (${want.length} แอป)` +
         (no.length ? ' — 🔴 เปิดไม่ได้: ' + no.join(' · ') : ''));
      /* 🔴 ห้ามมีแอปไหนหลงเหลืออยู่ใน OWNER_ONLY_APPS โดยไม่ตั้งใจ
       *   (ถ้าวันหนึ่งมีคนเติมกลับเข้าไป ต้องรู้ทันทีว่า namna จะเข้าไม่ได้ตัวไหน) */
      if (un === 'namna')
        ok(owner.every(k => !appAccess.canOpen({ username: un, permission: 'Administrator' }, k)),
           `  ‼ รายการแอปเฉพาะเจ้าของระบบ = [${owner.join(' · ') || 'ว่าง'}] ` +
           '— namna เปิดตัวที่อยู่ในรายการนี้ไม่ได้');
    }
    for (const un of ['bossx', 'xadmin', 'adminx']) {
      const bad = [];
      for (const key of ['users', 'audit', 'sync'])
        for (const l of await leaks(un, key)) bad.push(key + ' · ' + l);
      ok(bad.length === 0,
         `  🔴 ${un} (Permission = Administrator แต่ชื่อไม่ใช่) เปิด 3 แอปนั้นไม่ได้` +
         (bad.length ? '\n     🔴 หลุด: ' + bad.join('\n     🔴 หลุด: ') : ''));
      const me = await meOf(un);
      ok(me.canSync === false, `    ${un} ได้ canSync = false จาก /api/me`);
    }
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('⑥ 🔤 ชื่อผู้ใช้ "ไม่แคร์ตัวพิมพ์ แต่ตรงเป๊ะทั้งสตริง"');
  {
    const mk = un => ({ username: un, permission: 'Sale', appAccess: [] });
    for (const good of ['admin', 'Admin', 'ADMIN', 'namna', 'NamNa', ' namna ', '  admin  '])
      ok(appAccess.canOpen(mk(good), 'users') === true,
         `  ${JSON.stringify(good)} → เปิดแอปจัดการผู้ใช้ได้`);
    for (const bad of ['xadmin', 'adminx', 'admin2', 'namnax', '*', '%', '_dmin',
                       'ad*', 'admin ผู้ดูแล', '', '  ', 'nam'])
      ok(appAccess.canOpen(mk(bad), 'users') === false,
         `  🔴 ${JSON.stringify(bad)} → ต้องเปิดไม่ได้`);

    /* ยิงผ่าน HTTP จริง — 'ADMIN' ตัวใหญ่ต้องยังเข้าได้ · '*' ต้องล็อกอินไม่ผ่าน */
    const up = await login('ADMIN', 'pw-admin');
    ok(up.st === 200, '  ล็อกอินด้วย "ADMIN" ตัวใหญ่ยังได้เหมือนเดิม');
    const r = await hit('/m/users/', 'get', up.cookie);
    ok(!isDenied(r.st, r.txt), '  🔴 และเปิดแอปจัดการผู้ใช้ได้จริง (' + r.st + ')');
    const star = await login('*', 'pw-admin');
    ok(star.st !== 200, '  🔴 ล็อกอินด้วยชื่อ "*" ยังเข้าไม่ได้ (บทเรียน 13 ก.ย. 69)');

    /* สิทธิ์ก็ต้องเทียบตรงเป๊ะ ห้าม includes */
    ok(perms.allows('Planning', 'sales') === false, '  สิทธิ์ Planning เปิดคีย์ยอดขายไม่ได้');
    ok(perms.allows('Planningx', 'jobcard') === false,
       '  🔴 "Planningx" (ต่อท้ายตัวเดียว) ต้องไม่ถูกนับเป็น Planning');
    ok(perms.allows('xPlanning', 'jobcard') === false,
       '  🔴 "xPlanning" (นำหน้าตัวเดียว) ต้องไม่ถูกนับเป็น Planning');
    ok(perms.allows('PLANNING', 'jobcard') === true, '  "PLANNING" ตัวใหญ่ = Planning (ต่างแค่ตัวพิมพ์)');
    ok(perms.allows('  planning  ', 'jobcard') === true, '  เว้นวรรคหัวท้ายยังนับเป็น Planning');
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('⑦ 🔒 fail-closed — สิทธิ์ว่าง/ไม่รู้จัก ⇒ ปฏิเสธ + บอกเหตุผล (ห้ามเงียบ)');
  {
    for (const un of ['weird1', 'blank1']) {
      const cards = await cardsOf(un);
      ok(cards.length === 0, `  ${un} ไม่เห็นการ์ดสักใบ (${cards.length})`);
      const me = await meOf(un);
      ok(typeof me.permNotice === 'string' && me.permNotice.length > 10,
         `  🔴 ${un} ได้ข้อความเตือนจาก /api/me: "${String(me.permNotice).slice(0, 60)}…"`);
      const r = await hit('/m/jobcard/', 'get', C[un]);
      ok(r.st === 403, `  ${un} เปิด Job Card ตรง ๆ ไม่ได้ (${r.st})`);
      ok(/สิทธิ์|Permission/.test(r.txt) && !/stack|Error:/i.test(r.txt),
         `  🔴 หน้าปฏิเสธบอกเหตุผลเป็นภาษาคน ไม่ใช่ error ดิบ`);
      const a = await hit('/m/jobcard/api/rpc', 'post', C[un]);
      ok(a.st === 403 && /"ok":false/.test(a.txt),
         `  API ของ Job Card ตอบ 403 JSON (${a.st})`);
    }
    ok(appAccess.canOpen(null, 'sales') === false,        '  ไม่มีผู้ใช้เลย → เปิดไม่ได้');
    ok(appAccess.canOpen({}, 'jobcard') === false,        '  user ว่างเปล่า → เปิดไม่ได้');
    ok(appAccess.canOpen({ username: 'admin' }, '') === false, '  ไม่ระบุชื่อแอป → เปิดไม่ได้');
    ok(perms.permState('') === 'empty' && perms.permState('Marketing') === 'unknown',
       '  แยก "ว่าง" กับ "ไม่รู้จัก" ออกจากกันได้');

    /* ฐานล่ม = ปฏิเสธทุกเส้น แม้เป็นคุกกี้ของ admin */
    MODE = 'down';
    require(path.join(ROOT, 'core', 'auth.js')).forgetUser();
    const probes = [['/m/jobcard/', 'get'], ['/m/users/', 'get'], ['/api/sso/vectorcnc', 'get'],
                    ['/acp3d/', 'get'], ['/api/modules', 'get']];
    const leaked = [];
    for (const [p, m] of probes) {
      const r = await hit(p, m, C.admin);
      if (!isDenied(r.st, r.txt)) leaked.push(r.st + ' ' + m.toUpperCase() + ' ' + p);
    }
    ok(leaked.length === 0, '‼ ฐานล่มแล้วคุกกี้ของ admin ก็ยังเข้าไม่ได้ทุกเส้น' +
       (leaked.length ? '\n     🔴 ปล่อยผ่าน: ' + leaked.join(' · ') : ''));
    MODE = 'ok';
    require(path.join(ROOT, 'core', 'auth.js')).forgetUser();
    const back = await hit('/m/users/', 'get', C.admin);
    ok(!isDenied(back.st, back.txt), '  ฐานกลับมา → admin เข้าได้ทันที (ไม่ค้างในสภาพปฏิเสธ)');
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('⑧ 🎨 Graphic Design Solution (แอปนอกระบบ) — การ์ด + เส้นทางจริง');
  {
    for (const un of STAFF.map(s => s.Username)) {
      const me = await meOf(un);
      const want = EXPECT_GRAPHIC.indexOf(un) >= 0;
      ok(me.canGraphic === want,
         `  ${un} ได้ canGraphic = ${me.canGraphic} (ควรเป็น ${want})`);
    }
    /* 🔴 ตัวจริงที่กันคือเส้นทาง ไม่ใช่การ์ด */
    for (const un of ['as1', 'plan1', 'weird1', 'blank1']) {
      const r = await hit('/api/sso/vectorcnc', 'get', C[un]);
      ok(isDenied(r.st, r.txt),
         `  🔴 ${un} ยิง /api/sso/vectorcnc ตรง ๆ ไม่ได้ตั๋ว (${r.st})`);
    }
    const hub = fs.readFileSync(path.join(ROOT, 'public', 'hub.html'), 'utf8');
    ok(/if \(me\.canGraphic\)/.test(hub),
       '‼ หน้ารวมแอปต่อการ์ดใบนี้ตามค่าที่เซิร์ฟเวอร์ตัดสิน ไม่ได้คิดเอง');
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('⑨ 🧾 หน้าตรวจสิทธิ์ของแอดมิน — ต้องรายงานสิทธิ์ที่ไม่มีในตาราง');
  {
    const r = await fetch(BASE + '/m/users/api/perm-matrix', { headers: { cookie: C.admin } });
    const j = await r.json();
    ok(j.ok === true, '  admin เปิดตารางตรวจสิทธิ์ได้');
    ok((j.apps || []).length === perms.KNOWN_APPS.length,
       `  ตารางมีครบทุกแอป (${(j.apps || []).length})`);
    ok((j.rows || []).length >= 7, `  มีแถวสิทธิ์อย่างน้อย 7 แถว (${(j.rows || []).length})`);
    const un = (j.unknownInDb || []).map(x => String(x.value || '').toLowerCase());
    ok(un.indexOf('marketing') >= 0,
       '  🔴 รายงานว่ามีสิทธิ์ "Marketing" ในฐานที่ไม่มีในตาราง (ห้ามเงียบ)');
    ok(un.indexOf('') >= 0, '  🔴 รายงานบัญชีที่ช่องสิทธิ์ว่างด้วย');
    const pend = (j.pendingInDb || []).map(x => String(x.value || '').toLowerCase());
    ok(pend.indexOf('accounting') >= 0 && pend.indexOf('sale freelance') >= 0,
       '  รายงานสิทธิ์ที่ "ยังไม่ได้สั่งว่าเห็นแอปอะไร" ด้วย');
    ok((j.appsMissingFromTable || []).length === 0, '  ไม่มีโมดูลที่ตกสำรวจจากตาราง');

    /* 🔴 คนอื่นเปิดหน้านี้ไม่ได้ — มันคือ API ของแอปจัดการผู้ใช้ */
    for (const who of ['bossx', 'ss1', 'plan1']) {
      const q = await hit('/m/users/api/perm-matrix', 'get', C[who]);
      ok(q.st === 403, `  🔴 ${who} เปิด /m/users/api/perm-matrix ไม่ได้ (${q.st})`);
    }
    /* แถวของตารางต้องตรงกับที่ด่านจริงตอบ */
    const rowPlan = (j.rows || []).find(x => x.permission === 'planning');
    ok(rowPlan && rowPlan.apps.slice().sort().join(',') ===
       ['jobcard', 'maintenance', 'delivery', 'inventory', 'projects', 'purchase', 'chat', 'leave']
         .sort().join(','),
       '  แถว planning ในตาราง = แอปที่พี่เอสั่ง (+ แผงของ Job Card)');
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('⑩ 🔴 ตรวจสิทธิ์แล้วต้องไม่ยิงฐานข้อมูลเพิ่มแม้แต่คำขอเดียว');
  {
    const src = fs.readFileSync(path.join(ROOT, 'core', 'app-perms.js'), 'utf8');
    ok(!/require\s*\(/.test(src), '‼ core/app-perms.js ไม่ require อะไรเลยสักตัว');
    const src2 = fs.readFileSync(path.join(ROOT, 'core', 'app-access.js'), 'utf8');
    ok(!/require\(['"]\.\/auth['"]\)/.test(src2),
       '‼ core/app-access.js ไม่ require core/auth.js');
    /* ═══════════════════════════════════════════════════════════════
     *  ‼ 20 ก.ย. 69 — ข้อนี้เปลี่ยนเงื่อนไข เพราะพี่เอสั่งให้ตารางสิทธิ์
     *    ย้ายไปอยู่ในฐาน (กดกำหนดเองจากหน้าจอได้) ⇒ ไฟล์นี้ต้องอ่านฐานได้
     *  🔴 แต่กติกาเดิมยังอยู่ครบ: "ตอนตัดสินห้ามยิงฐาน"
     *    ⇒ require('./db') ต้องอยู่ "ข้างในฟังก์ชัน" (lazy) เท่านั้น
     *      ห้ามอยู่บนสุดของไฟล์ (ไม่งั้นโหลดไฟล์นี้ = ลากชุดโค้ดฐานเข้ามาด้วย)
     *    ⇒ และตัวตัดสินต้องไม่เป็น async (ถ้าเป็น = มีคน await = มีโอกาสยิงฐาน)
     *    ตัวเลขจริงพิสูจน์ด้วยตัวนับ dbHits ข้างล่าง
     * ═══════════════════════════════════════════════════════════════ */
    /* ‼ "ระดับบนสุด" = บรรทัดที่ไม่มีการย่อหน้าเลย (require ใน scope ของไฟล์)
     *   ส่วนที่อยู่ข้างในฟังก์ชันจะถูกย่อหน้าเสมอ ⇒ แยกกันได้ด้วยช่องว่างหน้าบรรทัด */
    const topRequire = src2.split(/\n/).filter(l => /^const\s+\w+\s*=\s*require\(/.test(l));
    ok(!topRequire.some(l => /['"]\.\/db['"]/.test(l)),
       '🔴 core/app-access.js ไม่ require core/db.js ที่ระดับบนสุดของไฟล์ (lazy เท่านั้น)');
    ok(/require\(['"]\.\/db['"]\)/.test(src2),
       '  ‼ แต่อ่านตารางสิทธิ์จากฐานได้ (require แบบ lazy ข้างใน refresh())');
    ok(!/async\s+function\s+(canOpen|decide)\s*\(/.test(src2),
       '🔴 canOpen() / decide() ไม่ใช่ async — ตัดสินจากแคชล้วน ๆ ไม่มีการรอฐาน');
    ok(/ห้ามถอยไปเป็น|ไม่ได้เปิดหมด/.test(src2),
       '  ‼ มีข้อความกำกับว่า "ฐานอ่านไม่ได้ ห้ามถอยไปเป็นเปิดหมด"');

    const u = { username: 'plan1', permission: 'Planning', appAccess: [] };
    dbHits = 0;
    for (let i = 0; i < 20000; i++) appAccess.canOpen(u, i % 2 ? 'sales' : 'jobcard');
    ok(dbHits === 0, `‼ เรียก canOpen() 20,000 ครั้ง → ยิงฐาน ${dbHits} คำขอ (ต้องเป็น 0 เป๊ะ)`);

    /* ‼ ผ่าน HTTP จริง — นับเฉพาะคำขอที่อ่านตาราง app_users
     *   (งานเบื้องหลังของโมดูลอื่นยิงตารางอื่นอยู่ตลอด ไม่เกี่ยวกับด่านสิทธิ์
     *    ถ้านับรวมจะได้ตัวเลขที่แกว่งตามจังหวะ cron ซึ่งพิสูจน์อะไรไม่ได้) */
    await hit('/api/modules', 'get', C.plan1);        /* อุ่นแคชผู้ใช้ */
    dbHitsUsers = 0;
    for (let i = 0; i < 20; i++) await hit('/api/modules', 'get', C.plan1);
    ok(dbHitsUsers === 0, `‼ ขอรายการแอป 20 ครั้ง → อ่าน app_users ${dbHitsUsers} คำขอ (ต้องเป็น 0 เป๊ะ)`);

    dbHitsUsers = 0;
    for (let i = 0; i < 20; i++) {
      await hit('/m/sales/api/rpc', 'post', C.plan1);
      await hit('/api/sso/vectorcnc', 'get', C.as1);
      await hit('/m/users/', 'get', C.bossx);
    }
    ok(dbHitsUsers === 0, `‼ ยิงเส้นที่ถูกปฏิเสธ 60 ครั้ง → อ่าน app_users ${dbHitsUsers} คำขอ`);
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('⑪ 🧩 กติกาอยู่ที่เดียว — ห้ามพิมพ์ตารางสิทธิ์ซ้ำที่อื่น');
  {
    const R = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const reg = R('core/registry.js'), srv = R('server.js'), hub = R('public/hub.html');

    ok(/appAccess\.canOpen\(user, m\.key\)/.test(reg),
       '① ทะเบียนโมดูลตัดการ์ดที่ไม่มีสิทธิ์ออกจาก visibleTo()');
    ok(/appAccess\.canOpen\(user, mod\.key\)/.test(reg),
       '②③ canUse() กันทั้งหน้าเว็บและ API ของทุกโมดูล');
    ok(/appAccess\.denyReason\(/.test(reg),
       '  ข้อความปฏิเสธมาจาก core/app-access.js ไม่ได้แต่งใหม่ที่ทะเบียน');
    ok(/appAccess\.requireApp\('vectorcnc'/.test(srv), '②③ /api/sso/vectorcnc ถูกครอบด่าน');
    ok(/appAccess\.requireApp\('acp3d'/.test(srv),     '②③ /acp3d + /api/acp3d ถูกครอบด่าน');
    ok(/appAccess\.requireApp\('sync'\)/.test(srv),    '②③ /sync + API ของมันถูกครอบด่าน (ของเดิม)');
    ok(/appAccess\.requireApp\('facade'\)/.test(srv),  '②③ Facade ถูกครอบด่าน (ของเดิม)');
    ok(/canGraphic: appAccess\.canOpen\(req\.user, 'vectorcnc'\)/.test(srv),
       '① /api/me ส่ง canGraphic ให้หน้ารวมแอป');
    ok(/permNotice: appAccess\.permNotice\(req\.user\)/.test(srv),
       '🔴 /api/me ส่งคำเตือนเรื่องสิทธิ์ให้หน้ารวมแอป (ห้ามเงียบ)');
    ok(/permwarn/.test(hub), '  หน้ารวมแอปมีที่สำหรับขึ้นคำเตือนนั้นจริง');

    /* 🔴 ตารางสิทธิ์ต้องอยู่ที่ core/app-perms.js ที่เดียว */
    const dup = ['core/registry.js', 'server.js', 'public/hub.html', 'core/module-host.js',
                 'modules/users/index.js', 'modules/users/public/index.html']
      /* ‼ มองหา "ตารางสิทธิ์" ที่ถูกพิมพ์ซ้ำ = คู่ 'ชื่อสิทธิ์': [รายชื่อแอป]
       *   ไม่ใช่การเอ่ยชื่อสิทธิ์ในคอมเมนต์ (อธิบายได้ ไม่ใช่การตัดสินใจซ้ำ) */
      .filter(f => /['"](after sale service|graphic สาขามดงาน)['"]\s*:/.test(R(f)));
    ok(dup.length === 0, '🔴 ไม่มีใครพิมพ์ชื่อสิทธิ์ซ้ำนอก core/app-perms.js' +
       (dup.length ? ' — ซ้ำที่: ' + dup.join(' · ') : ''));
    ok(/const TOOL_ADMIN_USERS = \['admin', 'namna'\];/.test(R('core/app-access.js')),
       '  รายชื่อที่เปิดแอปจัดการผู้ใช้ได้ ยังอยู่ที่ core/app-access.js ที่เดียว');
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('⑫ 🧮 แอปที่ "กลุ่ม administrator เท่านั้น" (พี่เอสั่ง 24 ก.ย. 69)');
  {
    /* ‼ พิมพ์รายชื่อซ้ำจากคำสั่งพี่เอตรง ๆ แล้วให้ทั้งสองฝั่งต้องตรงกัน
     *   (ห้ามอ่านคำตอบจากตัวที่กำลังตรวจ) */
    ok(perms.ADMIN_PERM_ONLY_APPS.slice().sort().join(',') === ADMIN_PERM_CARDS.slice().sort().join(','),
       '  รายการแอปเฉพาะกลุ่ม administrator = [' + ADMIN_PERM_CARDS.join(' · ') + ']');

    /* ① ผ่าน "ตัวตัดสินตัวจริง" ทีละบัญชี */
    const WANT = { admin: true, namna: true, bossx: true, xadmin: true, adminx: true };
    for (const s of STAFF) {
      const want = !!WANT[s.Username];
      const got = appAccess.canOpen({ username: s.Username, permission: s.Permission }, 'bom');
      ok(got === want,
         `  ${s.Username} (${s.Permission || 'ว่าง'}) → เปิดแอป BOM = ${got} (ควรเป็น ${want})`);
    }

    /* ② 🔴 ซ่อนการ์ดไม่นับ — ยิงเส้นทางจริงต้องโดนปฏิเสธ */
    for (const un of ['sale1', 'sales2', 'ss1', 'acc1', 'free1', 'plan1', 'graf1', 'as1']) {
      const bad = await leaks(un, 'bom');
      ok(bad.length === 0, `  🔴 ${un} ยิง /m/bom/ ตรง ๆ ไม่ได้สักเส้น` +
         (bad.length ? '\n     🔴 หลุด: ' + bad.join('\n     🔴 หลุด: ') : ''));
    }
    /* ③ คนที่ควรเข้าได้ ต้องเข้าได้จริง (ไม่ได้กันเกินคำสั่ง) */
    for (const un of ['admin', 'namna', 'bossx']) {
      const r = await hit('/m/bom/', 'get', C[un]);
      ok(!isDenied(r.st, r.txt), `  ${un} เปิดแอป BOM ได้จริง (${r.st})`);
    }
    /* ④ 🔴 ข้อความปฏิเสธต้องบอกเหตุผลจริง ไม่ใช่ให้ไปรอผู้ดูแลเปิดสิทธิ์ให้เก้อ */
    {
      const r = await hit('/m/bom/', 'get', C.ss1);
      ok(r.st === 403 && /Administrator/.test(r.txt) && !/stack|Error:/i.test(r.txt),
         '  🔴 หน้าปฏิเสธบอกว่า "เฉพาะกลุ่มสิทธิ์ Administrator" เป็นภาษาคน');
      const why = appAccess.denyReason({ username: 'ss1', permission: 'Sale support' }, 'bom', 'BOM ต้นทุนสินค้า');
      ok(/แจ้งพี่เอโดยตรง/.test(why) && !/เพิ่มแอปนี้เข้าตารางสิทธิ์/.test(why),
         '  🔴 ไม่ได้บอกให้ไปขอผู้ดูแลเพิ่มสิทธิ์ (ผู้ดูแลเพิ่มให้ไม่ได้อยู่ดี)');
    }
    /* ⑤ 🔴 ด่านนี้ต้องชนะ "ตารางในฐาน" ด้วย — ติ๊กให้กลุ่มอื่นก็ยังไม่ผ่าน
     *   (จำลองสภาพที่ตารางในฐานอ่านได้ และมีคนติ๊ก bom ให้กลุ่ม sales) */
    {
      const st = appAccess.cacheState();
      ok(st.source === 'code',
         '  ‼ ยามนี้รันในสภาพ "ฐานสิทธิ์อ่านไม่ได้" → ใช้ตารางสำรองในโค้ด (' + st.source + ')');
    }
    /* ⑥ โมดูลตั้งด่านของตัวเองไว้อีกชั้น (ซ้อนกับด่านสิทธิ์ ไม่ได้แทนกัน) */
    {
      const mj = JSON.parse(fs.readFileSync(path.join(ROOT, 'modules', 'bom', 'module.json'), 'utf8'));
      ok(mj.minRoleSee === 'ADMIN' && mj.minRoleUse === 'ADMIN',
         '  modules/bom/module.json ตั้ง minRoleSee/minRoleUse = ADMIN ไว้อีกชั้น');
    }
  }

  /* ═════════════════════════════════════════════════════════════════ */
  head('🔴 red-team — ถอดของที่แก้ออก ยามต้องแดงกลับ');
  {
    const P = require(path.join(ROOT, 'core', 'app-perms.js'));

    /* Ⓐ ถ้า whitelist ของ planning ถูกเปิดเป็น "ทุกแอป" ⇒ ต้องเห็น sales ทันที */
    const keepPlan = P.ROLE_APPS['planning'];
    P.ROLE_APPS['planning'] = P.ALL_APPS;
    ok(appAccess.canOpen({ username: 'plan1', permission: 'Planning' }, 'sales') === true,
       'Ⓐ เปิด whitelist ของ planning เป็นทุกแอป → เห็นคีย์ยอดขายทันที (ยามจับได้จริง)');
    P.ROLE_APPS['planning'] = keepPlan;
    ok(appAccess.canOpen({ username: 'plan1', permission: 'Planning' }, 'sales') === false,
       '  คืนค่าแล้วกลับมาปิดเหมือนเดิม');

    /* Ⓑ ถ้าเทียบชื่อสิทธิ์แบบหลวม (includes) ⇒ 'xPlanning' จะผ่าน */
    const loose = (perm, app) => {
      for (const k of Object.keys(P.ROLE_APPS))
        if (String(perm).toLowerCase().includes(k)) return P.ROLE_APPS[k] === P.ALL_APPS
          || P.ROLE_APPS[k].indexOf(app) >= 0;
      return false;
    };
    ok(loose('xPlanningy', 'jobcard') === true && P.allows('xPlanningy', 'jobcard') === false,
       'Ⓑ ถ้าใครเปลี่ยนไปใช้ includes → "xPlanningy" จะได้สิทธิ์ Planning ⇒ ของจริงไม่ผ่าน ถูกต้อง');

    /* Ⓒ ถ้าถอดด่านชื่อผู้ใช้ออก ⇒ Administrator คนอื่นจะเปิดแอปจัดการผู้ใช้ได้ */
    const asRole = perm => /administrator/i.test(perm);
    ok(asRole('Administrator') === true &&
       appAccess.canOpen({ username: 'bossx', permission: 'Administrator' }, 'users') === false,
       'Ⓒ ถ้าเปลี่ยนไปเช็ค role = ADMIN → bossx จะเปิดได้ ⇒ ของจริงยังปิดอยู่ ถูกต้อง');

    /* Ⓓ ถ้า fail-closed หาย ⇒ สิทธิ์ที่ไม่รู้จักจะเปิดได้หมด */
    ok(P.appsFor('Marketing').length === 0 &&
       appAccess.canOpen({ username: 'weird1', permission: 'Marketing' }, 'jobcard') === false,
       'Ⓓ สิทธิ์ที่ไม่รู้จัก = เปิดไม่ได้เลยสักแอป (fail-closed ยังอยู่)');

    /* ═══════════════════════════════════════════════════════════════
     *  Ⓕ 🔴 ถ้าถอด "แอปเฉพาะกลุ่ม administrator" ออก ⇒ ใครเห็นต้นทุนบ้าง
     *    พิสูจน์ด้วยการรันจริง ไม่ใช่เชื่อว่าด่านทำงาน
     * ═══════════════════════════════════════════════════════════════ */
    const keepAdminOnly = P.ADMIN_PERM_ONLY_APPS.slice();
    P.ADMIN_PERM_ONLY_APPS.length = 0;          /* ถอดด่านออก (ก้อนเดียวกับที่โค้ดจริงอ่าน) */
    const leakedNow = ['sale1', 'ss1', 'acc1', 'free1']
      .map(u => ({ u, can: appAccess.canOpen({ username: u,
        permission: { sale1: 'Sale', ss1: 'Sale support', acc1: 'Accounting',
                      free1: 'Sale Freelance' }[u] }, 'bom') }))
      .filter(x => x.can).map(x => x.u);
    ok(leakedNow.length === 4,
       'Ⓕ ถอดด่านออก → ' + leakedNow.join(' · ') + ' เห็นต้นทุนสินค้าทันที (ยามจับได้จริง)');
    P.ADMIN_PERM_ONLY_APPS.push(...keepAdminOnly);
    ok(!appAccess.canOpen({ username: 'ss1', permission: 'Sale support' }, 'bom') &&
       appAccess.canOpen({ username: 'bossx', permission: 'Administrator' }, 'bom'),
       '  คืนด่านแล้วกลับมาปิดเหมือนเดิม (และ administrator ยังเข้าได้)');

    /* Ⓖ 🔴 ถ้าเปลี่ยนไปเทียบ role = ADMIN แทนกลุ่ม permission ⇒ 'xadmin' ทะลุ
     *   (core/auth.js roleOf() มีเส้นเดาแบบหลวม p.includes('admin') อยู่จริง) */
    const byRole = perm => /admin/i.test(String(perm));
    ok(byRole('xadmin permission') === true && P.canonPerm('xadmin') === '',
       'Ⓖ เทียบแบบหลวมจะรับ "xadmin" ⇒ ของจริงเทียบตรงเป๊ะทั้งสตริง ถูกต้อง');

    /* Ⓔ ถ้าลืมกันเส้นทางจริง การ์ดที่ซ่อนก็ไม่ช่วยอะไร — พิสูจน์ว่าด่านอยู่ที่เส้นทาง */
    const r = await hit('/m/sales/', 'get', C.as1);
    ok(r.st === 403 && /กลับหน้ารวมแอป/.test(r.txt),
       'Ⓔ as1 ยิง /m/sales/ ตรง ๆ ได้หน้าปฏิเสธที่มีทางกลับ (ไม่ใช่หน้าขาว)');
  }

  console.log(`\n${fail ? '❌' : '✅'} ผ่าน ${pass} · ไม่ผ่าน ${fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n❌ ยามล้มกลางคัน:', e && e.stack || e);
  process.exit(1);
});
