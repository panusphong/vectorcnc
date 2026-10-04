'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  tools/test-hub-flow.js — รอบ 152 · หน้ารวมแอปแบบ "ขั้นตอนการทำงาน"
 *
 *  พี่เอสั่ง 26 ก.ย. 69: "ทำให้หน้านี้ เป็นเหมือน process flow ของการทำงาน"
 *                        "ใส่หมายเลขลำดับ app ไว้ด้วยนะ มองให้เห็นชัด"
 *  พิสูจน์ด้วย Chromium จริง กับรายชื่อแอปจากทะเบียนจริง (core/registry.js):
 *   ① ทุกแอปที่บัญชีเห็น อยู่บนหน้า "ครบและไม่ซ้ำ" (ไม่มีแอปไหนหายเพราะไม่อยู่ในตารางขั้น)
 *   ② ทุกการ์ดมีเลขลำดับ · เลขไม่ซ้ำ · ในขั้นเดียวกันนับ 1,2,3 ไม่กระโดด
 *   ③ ขั้นเรียง 1 → 7 · มีลูกศรส่งต่อระหว่างขั้น · แถบภาพรวมกดไปขั้นนั้นได้
 *   ④ บัญชีที่เห็นแอปน้อย: ขั้นที่ไม่มีแอปไม่ถูกวาด · เลขไม่กระโดด
 *   ⑤ ค้นหาแล้วเลขเดิมไม่เลื่อน · มือถือ 390px ไม่ล้นจอ
 * ═══════════════════════════════════════════════════════════════════ */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'c'.repeat(64);
const path = require('path');
const express = require('express');
const ROOT = path.join(__dirname, '..');
const registry = require(path.join(ROOT, 'core', 'registry'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n━━ ' + t);
const FOOT_ONLY = ['audit', 'users'];

const ADMIN = { username: 'admin', name: 'เอ', role: 'ADMIN', permission: 'Administrator', appAccess: [] };
const LIMITED = { username: 'tech1', name: 'ช่าง', role: 'TECH', permission: 'ช่างนอก', appAccess: ['booking', 'checklist', 'reviews'] };

(async () => {
  console.log('\n🧪 หน้ารวมแอปแบบขั้นตอนการทำงาน (Chromium จริง)\n');
  let who = ADMIN;
  const payload = u => registry.visibleTo(u).map(m => ({ key: m.key, title: m.title, subtitle: m.subtitle, icon: m.icon,
    color: m.color, status: m.status, path: m.basePath, canUse: registry.canUse(u, m).ok, version: m.version || '' }));
  const app = express();
  app.get('/api/me', (q, r) => r.json({ ok: true, user: who, canSync: who === ADMIN, canGraphic: who === ADMIN, minPassword: 4 }));
  app.get('/api/modules', (q, r) => r.json({ hub: '1', modules: payload(who) }));
  /* 🏷️ รอบ 157 — เวอร์ชันจริงของ Graphic Design (เลียนแบบ server.js > /api/graphic-version) */
  /* 🏷️ รอบ 201 — ตอบเลข 3 ท่อนแบบแอปอื่น (core/gds-app-version.js) + เวลา build จริงในช่อง live */
  const GA = require('../core/gds-app-version');
  app.get('/api/graphic-version', (q, r) => r.json({ ok: true, version: GA.VERSION,
    changelog: GA.CHANGELOG.map(x => ({ v: x[0], when: x[1], what: x[2] })),
    live: { ok: true, version: '2026-09-28.1432', engine: '9.37-test', deployed: '28 ก.ย. 69 14:32 น.' } }));
  app.get('/', (q, r) => r.sendFile(path.join(ROOT, 'public', 'hub.html')));
  app.use(express.static(path.join(ROOT, 'public')));
  const srv = await new Promise(r => { const s = app.listen(55821, '127.0.0.1', () => r(s)); });

  const { chromium } = require('playwright');
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  const open = async () => {
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://127.0.0.1:55821/', { waitUntil: 'networkidle' });
    await p.waitForSelector('.card[data-k]', { timeout: 8000 }).catch(() => {});
    return { p, errs };
  };
  const read = p => p.$$eval('.stage', ss => ss.map(s => ({
    id: s.id, n: s.querySelector('.spine .n').textContent.trim(), sup: s.classList.contains('sup'),
    top: s.classList.contains('mtop'),   /* 📊 รอบ 221 — แถบ Management Report บนสุด (ไม่ใช่ขั้น ไม่ใช่ระบบสนับสนุน) */
    hand: !!s.querySelector('.hand'),
    cards: [...s.querySelectorAll('.card[data-k]')].map(c => ({ k: c.dataset.k, no: c.querySelector('.num').textContent.trim() })),
  })));

  head('① ② ③ แอดมิน — ทุกแอปครบ ไม่ซ้ำ · เลขชัด · ขั้นเรียงตามลำดับ');
  {
    const { p, errs } = await open();
    const st = await read(p);
    const want = payload(ADMIN).map(m => m.key).filter(k => !FOOT_ONLY.includes(k)).concat(['__sync__', '__graphic__', '__designvideo__']);   /* รอบ 158 +การ์ดวิดีโองานออกแบบ */
    const got = st.flatMap(s => s.cards.map(c => c.k));
    ok(!errs.length, 'ไม่มี JS พัง' + (errs.length ? ' — ' + errs.join(' | ') : ''));
    ok(got.length === new Set(got).size, 'ไม่มีแอปซ้ำ (' + got.length + ' การ์ด)');
    const missing = want.filter(k => !got.includes(k));
    ok(!missing.length && got.length === want.length, 'ทุกแอปที่แอดมินเห็นอยู่บนหน้า ครบ ' + want.length + ' แอป' + (missing.length ? ' — หาย: ' + missing.join(',') : ''));
    const nos = st.flatMap(s => s.cards.map(c => c.no));
    ok(nos.every(Boolean) && nos.length === new Set(nos).size, 'ทุกการ์ดมีเลขลำดับ และเลขไม่ซ้ำ');
    const flow = st.filter(s => !s.sup && !s.top);
    ok(flow.map(s => s.n).join(',') === '1,2,3,4,5,6,7', 'ขั้นเรียง 1 → 7: ' + flow.map(s => s.n).join(' → '));
    const seqOk = flow.every(s => s.cards.every((c, i) => c.no === s.n + '.' + (i + 1)));
    ok(seqOk, 'เลขแอปในแต่ละขั้นนับต่อกัน (1.1 · 1.2 …) ไม่กระโดด');
    ok(flow.slice(0, -1).every(s => s.hand) && !flow[flow.length - 1].hand, 'มีลูกศร "ส่งต่อเมื่อ…" ระหว่างขั้น (ขั้นสุดท้ายไม่มี)');
    const sup = st.find(s => s.sup);
    ok(sup && sup.cards.every((c, i) => c.no === 'S' + (i + 1)), 'แอปที่ไม่อยู่ในขั้นไหน ไปอยู่ "ระบบสนับสนุน" เลข S1, S2 …');
    /* 📊 รอบ 221 — พี่เอ 3 ต.ค. 69: "card app management report อยู่ไหน" ⇒ ต้องอยู่บนสุดของหน้า */
    ok(st[0] && st[0].top && st[0].cards.length === 1 && st[0].cards[0].k === 'mgmt' && st[0].cards[0].no === '★1',
       '📊 การ์ด Management Report อยู่แถบแรกของหน้า (เหนือขั้นที่ 1) เลข ★1 — ได้ ' + (st[0] ? st[0].id + ' ' + st[0].cards.map(c => c.no + ' ' + c.k).join(' · ') : '-'));
    ok(st.filter(s => s.top).length === 1 && !st.filter(s => !s.top).some(s => s.cards.some(c => c.k === 'mgmt')), '   และไม่ซ้ำอยู่ในขั้นอื่นหรือในระบบสนับสนุน');
    ok(await p.evaluate(() => { const c = document.querySelector('.card[data-k="mgmt"]'), n = document.querySelector('.ovw'); return !!c && !!n && c.getBoundingClientRect().bottom <= n.getBoundingClientRect().top + 1 && c.getBoundingClientRect().top < innerHeight; }),
       '   มองเห็นได้ทันทีโดยไม่ต้องเลื่อนจอ (อยู่เหนือแถบ 7 ขั้น)');
    await p.fill('#q', 'management report'); await p.waitForTimeout(150);
    const stq = await read(p);
    ok(stq.length === 1 && stq[0].top && stq[0].cards[0].k === 'mgmt', '   ค้นหา "management report" ⇒ เหลือการ์ดนี้ใบเดียว');
    await p.fill('#q', ''); await p.waitForTimeout(100);
    const ovw = await p.$$eval('.ovw a', a => a.map(x => x.getAttribute('href')));
    ok(ovw.join(',') === '#st-1,#st-2,#st-3,#st-4,#st-5,#st-6,#st-7', 'แถบภาพรวม 7 ขั้น กดแล้วไปที่ขั้นนั้น');
    const gv = await p.$eval('.card[data-k="__graphic__"] .ver', e => e.textContent.trim()).catch(() => '');
    ok(gv === 'v' + GA.VERSION && /^v\d+\.\d+\.\d+$/.test(gv), 'การ์ด Graphic Design Solution ขึ้นเลขแบบแอปอื่น (รอบ 201): ' + (gv || '(ไม่มีป้าย)'));
    /* 🏷️ รอบ 201 — หน้าตาป้ายต้องเหมือนการ์ดแอปอื่นเป๊ะ · ไม่มีบรรทัด "↗ รันบน Railway · v…" ใต้การ์ด */
    const vs = await p.evaluate(() => {
      const st = el => { const c = getComputedStyle(el); return [c.fontFamily, c.fontSize, c.fontWeight, c.color, c.backgroundColor, c.borderRadius, c.position, c.right, c.bottom].join('|'); };
      const g = document.querySelector('.card[data-k="__graphic__"] .ver');
      const o = Array.from(document.querySelectorAll('.card[data-k] .ver[data-v]')).find(e => e.closest('.card').dataset.k !== '__graphic__');
      return { same: !!(g && o) && st(g) === st(o), other: o ? o.textContent.trim() : '',
               ext: !!document.querySelector('.card[data-k="__graphic__"] .ext'),
               txt: document.querySelector('.card[data-k="__graphic__"]').innerText };
    });
    ok(vs.same, 'ป้ายเวอร์ชันของ GDS หน้าตาเดียวกับป้ายแอปอื่น (' + vs.other + ')');
    ok(!vs.ext && !/รันบน Railway|v2026-/.test(vs.txt), 'ใต้การ์ด GDS ไม่มีบรรทัด "↗ รันบน Railway · v2026-…" แล้ว');
    await p.click('.card[data-k="__graphic__"] .ver');
    await p.waitForTimeout(150);
    const vbox = await p.$eval('#vbody', e => e.innerText).catch(() => '');
    ok(/v1\.2\.2/.test(vbox) && /v1\.0\.0/.test(vbox) && /Railway/.test(vbox) && /2026-09-28\.1432/.test(vbox),
       'กดป้าย ⇒ ประวัติแบบแอปอื่น + หัวกล่องบอก build ที่รันอยู่จริงบน Railway');
    if (process.env.HUB_SHOT) await p.screenshot({ path: process.env.HUB_SHOT.replace(/\.png$/, '-pop.png') });
    await p.evaluate(() => { if (typeof closeVer === 'function') closeVer(); });
    if (process.env.HUB_SHOT) { await p.mouse.move(5, 890); await p.evaluate(() => document.activeElement && document.activeElement.blur()); await p.waitForTimeout(150); await p.screenshot({ path: process.env.HUB_SHOT }); }
    /* 🎨 รอบ 164 — พี่เอ: "ย้าย app graphic design solution ไปอยู่ต่อ คีย์ยอดขาย" */
    const s1 = flow.find(s => s.n === '1' || s.n === 1);
    ok(s1 && s1.cards[0].k === 'sales' && s1.cards[1].k === '__graphic__' && s1.cards[1].no === '1.2',
       'Graphic Design Solution อยู่ต่อจากคีย์ยอดขาย = 1.2 (ขั้น 1: ' + (s1 ? s1.cards.map(c => c.no + ' ' + c.k).join(' · ') : '-') + ')');
    ok(!st.find(s => String(s.n) === '3').cards.some(c => c.k === '__graphic__'), 'ขั้น 3 ไม่มีการ์ด Graphic Design Solution ซ้ำ');
    await p.fill('#q', 'คลัง'); await p.waitForTimeout(150);
    const st2 = await read(p);
    const inv = st2.flatMap(s => s.cards).find(c => c.k === 'inventory');
    ok(inv && inv.no === '4.2', 'ค้นหา "คลัง" ⇒ เลขเดิม 4.2 ไม่เลื่อน');
    await p.fill('#q', ''); await p.waitForTimeout(100);
    await p.setViewportSize({ width: 390, height: 800 });
    await p.waitForTimeout(150);
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'มือถือ 390px ไม่ล้นจอ');
    await p.close();
  }

  head('④ บัญชีที่เห็นแอปน้อย — ขั้นที่ไม่มีแอปไม่ถูกวาด');
  {
    who = LIMITED;
    const vis = payload(LIMITED).map(m => m.key).filter(k => !FOOT_ONLY.includes(k));
    const { p, errs } = await open();
    const st = await read(p);
    const got = st.flatMap(s => s.cards.map(c => c.k));
    ok(!errs.length && got.sort().join(',') === vis.slice().sort().join(','),
       'เห็นเฉพาะแอปที่เซิร์ฟเวอร์ส่งมา (' + got.length + ' แอป) — หน้าเว็บไม่ได้เพิ่ม/ตัดเอง');
    ok(st.every(s => s.cards.length > 0), 'ไม่มีขั้นว่างโผล่มา');
    ok(st.filter(s => !s.sup && !s.top).every(s => s.cards.every((c, i) => c.no === s.n + '.' + (i + 1))), 'เลขในขั้นยังนับต่อกันไม่กระโดด');
    ok(!st.some(s => s.top) && !got.includes('mgmt'), '📊 บัญชีที่ไม่ใช่ Administrator ไม่มีแถบ/การ์ด Management Report (รอบ 221)');
    await p.close();
  }

  await b.close(); srv.close();
  console.log('\n' + (fail ? '❌' : '✅') + ' ผ่าน ' + pass + ' · ไม่ผ่าน ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('💥', e); process.exit(1); });
