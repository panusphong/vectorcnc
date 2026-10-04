'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  🧪 tools/test-peak-always212.js — รอบ 212 + 213 (คีย์ยอดขาย v1.46.0)
 *
 *  พี่เอสั่ง 2 ต.ค. 69:
 *   รอบ 212 (หน้าลูกหนี้ค้างชำระ · ส่วนซิงก์ PEAK)
 *    "ในส่วนการ sync กับ peak ตรงนี้เปิด auto ไว้เลยไม่ต้องปิดนะ และแสดงสถานะ การ update เป็น %จำนวนใบที่ยังค้างรับทุกใบให้ด้วย
 *     พี่ไม่ต้องการมานั่งกดทุกวันเสียเวลา และหลุดการ update ฝ่ายขายด้วย เวลาที่เค้าแก้รหัสงาน มันต้อง sync ทันที ทุกใบเข้าใจมั้ย"
 *    "ในส่วนที่ยอดไม่ตรง ทำการ update ไปใน card ลูกหนี้ทุกใบนะ"
 *   รอบ 213 (แอปคีย์ยอดขาย)
 *    "ให้ทำการ refresh data แบบไม่ต้อง refresh หน้าจอให้หายแล้วเปิดใหม่นะ ให้ sync data อย่างเดียว
 *     ให้upate ทุกๆ 2 นาที โดยไม่กระทบการทำงานของ user นะ"
 *
 *   ① ตัวหลังบ้านเปิดตลอด: คิวหมดไม่ถอดตัวจับเวลา · สั่งหยุดไม่หยุด · รอบรายวันปิดไม่ได้ · บูตแล้วเปิดเอง (4 รอบ/วัน)
 *   ② เซลส์บันทึก ⇒ kick() เก็บคิวทันที (ไม่รอครบนาที)
 *   ③ % ใบที่ยังค้างรับที่อัปเดตกับ PEAK แล้ว (อ่านฐานอย่างเดียว)
 *   ④ ยอดไม่ตรง ⇒ ขึ้นบนการ์ดลูกหนี้ทุกใบ
 *   ⑤ หน้าเว็บ: ไม่มีปุ่มหยุด/ปิด · แถบ % · ป้ายยอดไม่ตรง
 *   ⑥ รอบ 213: อัปเดตเงียบทุก 2 นาที — ไม่กระทบคนที่กำลังพิมพ์/เปิดฟอร์ม · ตำแหน่งเลื่อนคงเดิม (Chromium จริง)
 *  ‼ Postgres จริงผ่าน fake-postgrest · ไม่ยิง PEAK จริง (ตัวถามจำลอง)
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');
const ROOT = path.join(__dirname, '..');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 55921;
process.env.SUPABASE_URL = `http://127.0.0.1:${REST_PORT}`;
process.env.SUPABASE_KEY = 'test-key';
process.env.SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA || 'app';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'c'.repeat(64);
process.env.SHEET_SYNC = 'off';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n━━ ' + t);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const R = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  const pg = new Client({ connectionString: PG });
  await pg.connect();
  for (const f of ['01-core.sql', '22-peak-queue.sql'])
    await pg.query(R('sql/' + f)).catch(() => {});
  await pg.query('truncate app.total_sales');
  await pg.query('truncate app.peak_queue restart identity');
  await pg.query('truncate app.peak_state');
  const stamp = (ms) => { const d = new Date(ms + 7 * 3600000), p = n => String(n).padStart(2, '0');
    return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()); };
  const NOW = Date.now();
  const ins = (row, o) => pg.query(
    `insert into app.total_sales
       (_row,"รหัสงาน","ชื่อบริษัท","Lead Status","เลขที่ QO / IV","ยอดขาย (บาท)","ยอดเรียกเก็บ (บาท)",
        "สถานะซิงก์ PEAK","สถานะชำระ PEAK","ยอดขาย PEAK","รับชำระแล้ว PEAK","อัปเดต PEAK เมื่อ","ตรวจยอด","Create By")
     values ($1,$2,'ลูกค้าทดสอบ',$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,'sale1')`,
    [row, 'B2P' + row, o.lead || 'ปิดการขาย', o.ref === undefined ? ('IV-6910010' + String(row).padStart(4, '0')) : o.ref,
     o.amt || 10000, o.ss || '', o.pst || '', o.pamt === undefined ? null : o.pamt, o.ppaid === undefined ? null : o.ppaid,
     o.at === undefined ? '' : o.at, o.chk || '']);
  const q = require('../core/peak-queue');
  const SS = q.SS;
  /* ใบที่ยังค้างรับ 5 ใบ: อัปเดตใน 24 ชม. 2 · เก่ากว่า 24 ชม. 2 (1 ใบยอดไม่ตรง) · ยังไม่เคยซิงก์ 1 */
  await ins(11, { ss: SS.OK, pst: 'ค้างชำระ', pamt: 10000, ppaid: 0, at: stamp(NOW - 2 * 3600000), chk: '✅ ตรง' });
  await ins(12, { ss: SS.OK, pst: 'ชำระบางส่วน', pamt: 10700, ppaid: 5000, at: stamp(NOW - 20 * 3600000), chk: '⚠️ ต่าง +700' });
  await ins(13, { ss: SS.OK, pst: 'ค้างชำระ', pamt: 9000, ppaid: 0, at: stamp(NOW - 30 * 3600000), chk: '⚠️ ต่าง -1,000' });
  await ins(14, { ss: SS.OK, pst: 'ค้างชำระ', pamt: 10000, ppaid: 0, at: stamp(NOW - 5 * 86400000) });
  await ins(15, {});
  /* ไม่นับ: ชำระครบ · ยกเลิก · ไม่ใช่ปิดการขาย · ไม่มีเลขเอกสาร · FlowAccount */
  await ins(21, { ss: SS.OK, pst: 'ชำระครบ', pamt: 10000, ppaid: 10000, at: stamp(NOW - 9 * 86400000) });
  await ins(22, { ss: SS.VOID, pst: 'ยกเลิก', pamt: 10000, ppaid: 0 });
  await ins(23, { lead: 'เสนอราคา' });
  await ins(24, { ref: '' });
  await ins(25, { ref: 'QT-2026100001' });

  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  const peak = require('../core/peak');
  peak.configuredList = () => ['modngan', 'the101'];           /* จำลองว่าตั้งกุญแจครบแล้ว — ไม่ยิง PEAK จริง */
  const pa = require('../core/peak-auto');
  const asked = [], wrote = [];
  pa.setAsker(async (row) => { asked.push(row._row);
    return { ss: SS.OK, inv: { payable: 10000, paid: 0, net: 10000, payKey: 'none', status: 'ค้างชำระ', receipts: [] }, quo: null,
             set: { 'สถานะซิงก์ PEAK': SS.OK, 'อัปเดต PEAK เมื่อ': stamp(Date.now()) } }; });
  pa.setWriter(async (J) => { wrote.push(J.it.row_no);
    await pg.query('update app.total_sales set "อัปเดต PEAK เมื่อ"=$1 where _row=$2', [stamp(Date.now()), J.it.row_no]); });

  try {
    head('① ตัวหลังบ้านเปิดตลอด');
    ok(pa.ALWAYS_ON === true, 'ALWAYS_ON = true');
    await pa.restore();
    let S = await pa.statusOf(), D = await pa.dailyStatus();
    ok(S.on && S.alwaysOn, 'บูตระบบ (restore) ⇒ ตัวหลังบ้านเปิดเอง แม้คิวว่าง (เดิมเปิดเฉพาะตอนมีคิวค้าง)');
    ok(D.alive && D.hours.join(',') === '0,6,12,18' && D.alwaysOn, 'ไม่เคยตั้งเวลารายวัน ⇒ เปิดให้เอง วันละ 4 รอบ ' + D.times + ' น.');
    await sleep(3600);                                           /* รอบแรกที่ start() เตะให้ (3 วิ) */
    const t1 = await pa.tick('auto');
    S = await pa.statusOf();
    ok(t1.ok !== undefined && S.on, 'คิวว่าง/คิวหมด ⇒ ตัวจับเวลายังอยู่ (เดิมถอดทิ้ง ต้องมีคนมากดเปิด) — ' + (t1.note || t1.skipped || ''));
    const st = await pa.stop('สั่งหยุดโดย admin');
    S = await pa.statusOf();
    ok(st.ok === false && st.alwaysOn && S.on && /เปิดตลอด/.test(st.msg), 'สั่งหยุดจากหน้าจอ ⇒ ไม่หยุด + บอกเหตุผล');
    const off = await pa.dailyOff();
    D = await pa.dailyStatus();
    ok(off.ok === false && off.alwaysOn && D.alive, 'ปิดรอบรายวัน ⇒ ปิดไม่ได้ (เปลี่ยนเวลาได้)');
    const on2 = await pa.dailyOn([1, 13], 'day');
    ok(on2.ok && (await pa.dailyStatus()).hours.join(',') === '1,13', 'เปลี่ยนเวลา/จำนวนรอบยังทำได้');
    const hist0 = (await pa.statusOf()).hist.length;
    await pa.tick('auto'); await pa.tick('auto');
    ok((await pa.statusOf()).hist.length === hist0, 'รอบที่คิวว่างไม่จดประวัติซ้ำทุกนาที');
    const aSrc = R('core/peak-auto.js');
    ok(/PAUSE_MS/.test(aSrc) && /_pauseUntil = Date\.now\(\) \+ PAUSE_MS/.test(aSrc) && /watchdog/.test(aSrc),
       'พลาดติดกันหลายรอบ ⇒ พักชั่วคราวแล้วกลับมาเอง · มีตัวเฝ้าเปิดคืนถ้าตัวจับเวลาหาย');
    ok(!/method:\s*['"](POST|PUT|PATCH|DELETE)/i.test(aSrc + R('modules/sales/peak-open.js')), '‼ PEAK อ่านอย่างเดียวเหมือนเดิม');

    head('② เซลส์บันทึก/แก้รหัสงาน ⇒ ซิงก์ทันที');
    asked.length = 0; wrote.length = 0;
    const p = await q.pushTop(14, 'B2P14-NEW');
    const k = pa.kick();
    ok(p.ok && p.queued && (k.kicked || k.queued || k.started), 'pushTop + kick() — ' + JSON.stringify(k));
    let waited = 0;
    while (!wrote.includes(14) && waited < 8000) { await sleep(200); waited += 200; }
    ok(wrote.includes(14) && asked.includes(14) && waited < 5000, 'ใบที่เซลส์แก้ถูกถาม PEAK + เขียนผลภายใน ' + (waited / 1000) + ' วินาที (เดิมรอรอบถัดไปไม่เกิน 1 นาที)');
    const sv = R('modules/sales/save.js');
    ok(/peak-auto'\)\.kick\(\)/.test(sv) && /q\.pushTop\(rowNo, jobCode\)/.test(sv), 'save.js: หย่อนคิวแล้วสั่งเก็บคิวทันที (รวมตอนแก้รหัสงาน — jobCode คือรหัสใหม่)');
    ok(sv.indexOf("jobRename = await planJobRename") < sv.indexOf('q.pushTop(rowNo, jobCode)'), 'ลำดับ: เปลี่ยนรหัสงานเสร็จก่อน แล้วค่อยหย่อนคิวด้วยรหัสใหม่');

    head('③ % ใบที่ยังค้างรับ ที่อัปเดตกับ PEAK แล้ว');
    const PO = require('../modules/sales/peak-open');
    PO._t.reset();
    const P1 = await PO.openProgress({ fresh: true });
    ok(P1.ok && P1.open === 5, 'ใบที่ยังค้างรับ 5 ใบ (ชำระครบ · ยกเลิก · ไม่ปิดการขาย · ไม่มีเลข · FlowAccount ไม่นับ) — ได้ ' + P1.open);
    ok(P1.fresh === 3 && P1.stale === 1 && P1.never === 1 && P1.pct === 60,
       'อัปเดตภายใน 24 ชม. 3 ใบ (รวมใบที่เพิ่งซิงก์ทันที) · เก่ากว่า 1 · ยังไม่เคย 1 ⇒ ' + P1.pct + '%');
    ok(P1.diffAmt === 2, 'ยอดไม่ตรง 2 ใบ (นับจากช่อง "ตรวจยอด")');
    const P2 = await PO.openProgress();
    ok(P2.cached === true, 'จำผล 60 วินาที (หน้าจอถามทุก 8 วินาที ไม่อ่านทั้งตารางซ้ำ)');
    const t = PO._t;
    ok(t.stampMs('02/10/2026 08:22') === Date.UTC(2026, 9, 2, 1, 22) && t.stampMs('02/10/2569 08:22') === Date.UTC(2026, 9, 2, 1, 22) && t.stampMs('') === 0,
       'อ่านประทับเวลาไทย dd/MM/yyyy HH:mm · ปี พ.ศ. · ว่าง = ยังไม่เคย');
    const ix = R('modules/sales/index.js');
    ok(/\/api\/peak\/open-progress/.test(ix) && /r\.alwaysOn/.test(ix), 'มีเส้น /api/peak/open-progress · เส้นสั่งหยุดตอบว่าไม่หยุด');

    head('④ ยอดไม่ตรง ⇒ ขึ้นบนการ์ดลูกหนี้ทุกใบ');
    const AR = require('../modules/sales/ar-aging');
    ok(AR._amtDiffOf('⚠️ ต่าง +700') === 700 && AR._amtDiffOf('⚠️ ต่าง -1,000') === -1000 && AR._amtDiffOf('✅ ตรง') === 0 && AR._amtDiffOf('') === 0,
       'อ่านส่วนต่างจากช่อง "ตรวจยอด" (+700 · −1,000 · ตรง = 0)');
    const rows = (await pg.query('select * from app.total_sales where _row in (11,12,13,22) order by _row')).rows;
    const today = new Date();
    const it = Object.fromEntries(rows.map(r => [r._row, AR._arBuildItem(r, today, []).item]));
    ok(it[12].amtDiff === 700 && it[12].keySale === 10000 && it[12].peakAmt === 10700 && it[13].amtDiff === -1000,
       'การ์ดใบที่ยอดไม่ตรงได้ amtDiff + ยอดที่คีย์ + ยอด PEAK (ใบ 12: คีย์ 10,000 · PEAK 10,700 · ต่าง +700)');
    ok(it[11].amtDiff === undefined && it[11].keySale === undefined, 'ใบที่ยอดตรง ไม่มีช่องนี้ (ไม่กินแบนด์วิดท์)');
    ok(it[12].outstanding === 5700 && it[12].total === 10700, 'ยอดค้างบนการ์ดยึด PEAK เหมือนเดิม (10,700 − 5,000 = 5,700)');

    head('⑤ หน้าเว็บ — ส่วนซิงก์ PEAK + การ์ดลูกหนี้');
    const pgSrc = R('modules/sales/public/index.html');
    ok(!/pkAutoGo\(0\)/.test(pgSrc) && !/onclick="pkDailyOff\(\)"/.test(pgSrc), 'ไม่มีปุ่ม "■ หยุด" ตัวหลังบ้าน และไม่มีปุ่ม "■ ปิด" รอบรายวัน');
    ok(/function pkOpenHtml/.test(pgSrc) && /\/api\/peak\/open-progress/.test(pgSrc) && /ใบที่ยังค้างรับ/.test(pgSrc), 'แถบ % ใบที่ยังค้างรับ อยู่ในกล่องตัวซิงก์หลังบ้าน');
    ok(/function arDiffHtml/.test(pgSrc) && /arDiffHtml\(x\)\+/.test(pgSrc) && /function arDiffBar/.test(pgSrc) && /\.ar-c-diff\{/.test(pgSrc),
       'การ์ดลูกหนี้: ป้ายแดง "ยอดไม่ตรง PEAK" + แถบสรุป/กรองดูเฉพาะใบที่ยอดไม่ตรง');
    ok(/x\.src==='peak'\?'ยอดตาม PEAK ':'ยอดในชีต '/.test(pgSrc), 'บรรทัดยอดบนการ์ดบอกที่มาตามจริง (ยอดตาม PEAK / ยอดในชีต)');

    head('⑥ รอบ 213 — อัปเดตเงียบทุก 2 นาที ไม่กระทบคนใช้ (Chromium จริง)');
    ok(/const AUTO_REF_MS = 120000/.test(pgSrc) && /setInterval\(autoRefTick, AUTO_REF_TRY_MS\)/.test(pgSrc) && /id="autoRefChip"/.test(pgSrc),
       'ตั้งรอบ 2 นาที (ลองใหม่ทุก 15 วิ ถ้ายังไม่ว่าง) + ป้ายบอกเวลาอัปเดตล่าสุด');
    ok(!/location\.reload\(/.test(pgSrc.slice(pgSrc.indexOf('const AUTO_REF_MS'), pgSrc.indexOf("document.addEventListener('visibilitychange'"))),
       '‼ ไม่โหลดหน้าใหม่ (ไม่มี location.reload ในเครื่องอัปเดตเอง)');
    ok(/\$\('btnRefresh'\)\.onclick = \(\) => \{ quietRefresh\('manual'\); \};/.test(pgSrc), 'ปุ่ม ⟳ รีเฟรช ก็อัปเดตแบบไม่ล้างจอ');
    ok(/if \(silent && DATA\.length/.test(pgSrc), 'อัปเดตเงียบโหลดไม่สำเร็จ ⇒ คงตารางเดิมไว้ ไม่ล้างเป็นข้อความแดง');
    const a0 = pgSrc.indexOf('const AUTO_REF_MS'), a1 = pgSrc.indexOf("document.addEventListener('visibilitychange'");
    const block = pgSrc.slice(a0, pgSrc.indexOf('\n', a1));
    const { chromium } = require('playwright');
    const br = await chromium.launch();
    try {
      const page = await br.newPage();
      await page.setContent('<!doctype html><body style="margin:0"><span id="autoRefChip"></span>'
        + '<input id="q"><div id="pn" class="panel"></div><div id="ov" class="ov-panel hidden"></div>'
        + '<div id="wrapTbl" style="height:200px;overflow:auto"><div id="tb" style="height:3000px;width:3000px">ตาราง</div></div>'
        + '<div style="height:5000px"></div></body>');
      await page.evaluate((code) => {
        window.CALLS = [];
        window.$ = id => document.getElementById(id);
        window.toast = () => {};
        window.thStamp = () => '02/10/2026 08:30';
        window.loadRecords = async (s) => { CALLS.push('rec:' + s); document.getElementById('tb').textContent = 'ตารางใหม่ ' + CALLS.length;
          document.getElementById('wrapTbl').scrollTop = 0; document.scrollingElement.scrollTop = 0; };
        window.loadDash = async (qt) => { CALLS.push('dash:' + qt); };
        window.loadActivity = async () => { CALLS.push('act'); };
        window.loadBranch = async () => { CALLS.push('br'); };
        window.campRefreshQuiet = async () => { CALLS.push('camp'); };
        const s = document.createElement('script');
        s.textContent = code + '\nwindow.__ar = { busy: autoRefBusy, tick: autoRefTick, quiet: quietRefresh, setAt: v => { _arefAt = v; }, setInput: v => { _arefInput = v; } };';
        document.body.appendChild(s);
      }, block);
      const ev = (fn, arg) => page.evaluate(fn, arg);
      await ev(() => { __ar.setInput(0); });
      ok(await ev(() => __ar.busy()) === '', 'ไม่มีใครทำอะไร ⇒ ว่าง อัปเดตได้');
      await ev(() => { __ar.setAt(Date.now() - 60000); __ar.tick(); });
      ok((await ev(() => CALLS.length)) === 0, 'ยังไม่ครบ 2 นาที ⇒ ไม่อัปเดต');
      await ev(() => { document.getElementById('q').focus(); __ar.setAt(Date.now() - 130000); __ar.tick(); });
      ok(/กำลังพิมพ์/.test(await ev(() => __ar.busy())) && (await ev(() => CALLS.length)) === 0, 'เคอร์เซอร์อยู่ในช่องค้นหา ⇒ รอ ไม่วาดตารางทับ');
      await ev(() => { document.getElementById('q').blur(); document.getElementById('pn').classList.add('show'); __ar.setInput(0); __ar.tick(); });
      ok(/ฟอร์ม/.test(await ev(() => __ar.busy())) && (await ev(() => CALLS.length)) === 0, 'ฟอร์มคีย์งานเปิดอยู่ ⇒ รอ');
      await ev(() => { document.getElementById('pn').classList.remove('show'); document.getElementById('ov').classList.remove('hidden'); __ar.tick(); });
      ok((await ev(() => CALLS.length)) === 0, 'หน้าต่างเมนูงาน (เช่น ลูกหนี้) เปิดอยู่ ⇒ รอ');
      await ev(() => { document.getElementById('ov').classList.add('hidden'); __ar.setInput(Date.now()); __ar.tick(); });
      ok(/เพิ่งกด/.test(await ev(() => __ar.busy())) && (await ev(() => CALLS.length)) === 0, 'เพิ่งกด/พิมพ์/เลื่อนภายใน 4 วินาที ⇒ รอ');
      await ev(() => { document.scrollingElement.scrollTop = 1234; const w = document.getElementById('wrapTbl'); w.scrollTop = 777; w.scrollLeft = 55;
                       __ar.setInput(0); __ar.tick(); });
      await page.waitForFunction(() => CALLS.length >= 5, null, { timeout: 5000 });
      await sleep(150);
      const after = await ev(() => ({ calls: CALLS.slice(), top: document.scrollingElement.scrollTop, wt: document.getElementById('wrapTbl').scrollTop,
        wl: document.getElementById('wrapTbl').scrollLeft, tb: document.getElementById('tb').textContent, chip: document.getElementById('autoRefChip').textContent }));
      ok(after.calls.includes('rec:true') && after.calls.includes('dash:true') && after.calls.includes('act') && after.calls.includes('br') && after.calls.includes('camp'),
         'ว่างแล้ว + ครบ 2 นาที ⇒ อัปเดตเงียบครบทุกส่วน (ตาราง · การ์ด · กิจกรรม · สาขา · แคมเปญ) — ' + after.calls.join(','));
      ok(Math.abs(after.top - 1234) <= 10 && after.wt === 777 && after.wl === 55 && /ตารางใหม่/.test(after.tb), 'ข้อมูลใหม่ขึ้นแล้ว ตำแหน่งเลื่อนอยู่ที่เดิม (หน้า ~1234 · ตาราง 777/55 — เดิมถูกรีเซ็ตเป็น 0) — ' + JSON.stringify([after.top, after.wt, after.wl]));
      ok(/อัปเดตล่าสุด 08:30/.test(after.chip), 'ป้ายบอกเวลาอัปเดตล่าสุด — "' + after.chip + '"');
      const n0 = after.calls.length;
      await ev(() => { __ar.tick(); });
      await sleep(200);
      ok((await ev(() => CALLS.length)) === n0, 'อัปเดตแล้วเริ่มนับ 2 นาทีใหม่ ไม่ยิงซ้ำ');
    } finally { await br.close(); }

    /* ‼ เวอร์ชันเดินหน้าได้ (1.47 …) — ยามนี้คุมแค่ว่ารอบ 212-213 อยู่ในประวัติ ไม่ตรึงเลขล่าสุด (ท่าเดียวกับ test-gh70-jobcode) */
    { const V = require('../modules/sales/version.js');
      ok((V.CHANGELOG || []).some(x => x[0] === '1.46.0'), 'ประวัติเวอร์ชันคีย์ยอดขายมี 1.46.0 (ล่าสุด ' + V.VERSION + ')'); }
  } finally {
    try { require('node-cron').getTasks().forEach(t => t.stop()); } catch (e) { /* ปล่อย */ }
    if (rest && rest.stop) await rest.stop(); else if (rest && rest.close) await rest.close().catch(() => {});
    await pg.end();
  }
  console.log('\n' + (fail ? '❌' : '✅') + ' ผ่าน ' + pass + ' · ไม่ผ่าน ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('💥', e); process.exit(1); });
