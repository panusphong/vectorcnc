'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  📒 ยาม: "ลองถาม PEAK ตามรหัสผังบัญชี" — npm run test:peakledger   (รอบ 233 · 4 ต.ค. 69)
 *
 *  พี่เอ: "management report เรายังดึงค่าใช้จ่ายมาไม่หมดนะ พี่เพิ่งรู้ว่า เค้าไม่ได้คีย์ใน EXP 100%
 *          มันจะมีคีย์ไปที่รหัสผังบัญชีโดยตรง ส่วนนี้ไปเอามาได้มั้ย อลิซ"
 *         "ทำเลย แล้วให้มันเป็นข้อมูลชุดเดียวกันกับ เมนูงาน Cash flow ด้วยนะ"
 *
 *  🔴 เครื่องนี้ยิง PEAK จริงไม่ได้ และเอกสาร PEAK ไม่ได้แสดงรูปคำตอบของ 4 เส้นนี้
 *    ⇒ ยามชุดนี้ **ไม่ได้พิสูจน์ว่า PEAK จริงเปิดสิทธิ์ให้ หรือตอบรูปไหน**
 *    พิสูจน์ได้ว่า (PEAK ปลอม · รูปคำตอบสมมติ — tools/fake-peak-ledger.js)
 *     ① ยิงถูกเส้น ถูกพารามิเตอร์ ตามเอกสาร PEAK เป๊ะ และเป็น GET ล้วน
 *     ② PEAK ตอบรูปไหนก็กางให้เห็นได้ ไม่พัง: มีกล่อง · กล่องซ้อน · ไม่มีอาเรย์เลย · ว่าง
 *     ③ แยก "การเชื่อมต่อเสีย" ออกจาก "PEAK ไม่เปิดสิทธิ์ส่วนนี้" ได้ถูก
 *     ④ ไม่เขียนตารางข้อมูล · ไม่แตะตัวเลขรายงาน · จดแค่สรุปผลลง app.peak_state
 *     ⑤ ผู้ดูแลระบบเท่านั้น (ทั้งเมนู Cash Flow และ Management Report) · ความลับไม่หลุด
 *     ⑥ หน้าจอจริง (Chromium): ปุ่มในแผงเงินออกของ Cash Flow → ผลขึ้น → Management Report เห็นผลชุดเดียวกัน
 *
 *  SHOT=<ไฟล์> เก็บภาพผลในเมนู Cash Flow · SHOT_MGMT=<ไฟล์> เก็บภาพ Management Report
 *  APP_DIR=<โฟลเดอร์รุ่นก่อน> + ONLY_SHOT=1 ⇒ เก็บภาพรุ่นก่อน (ไม่รันข้อทดสอบ)
 *  ‼ พอร์ต 55987 / 55988 — ไล่เช็ค tools/*.js แล้วว่าไม่ชนกับใคร
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 55987, APP_PORT = 55988;
const APP_DIR = process.env.APP_DIR || ROOT;
const ONLY_SHOT = !!process.env.ONLY_SHOT;
process.env.SUPABASE_URL = `http://127.0.0.1:${REST_PORT}`;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
/* กุญแจปลอม — ยามนี้ไม่มีวันใช้กุญแจจริง */
const KEYS = { PEAK_MODNGAN_ID: 'test_connect_id', PEAK_MODNGAN_KEY: 'test-connect-key-m', PEAK_MODNGAN_APP: 'TESTAPP01',
  PEAK_MODNGAN_USER: 'test-user-token-m', PEAK_THE101_ID: 'test_connect_101', PEAK_THE101_KEY: 'test-connect-key-t',
  PEAK_THE101_APP: 'TESTAPP02', PEAK_THE101_USER: 'test-user-token-t' };
Object.assign(process.env, KEYS);

const FP = require('./fake-peak-ledger');           /* สวม fetch ก่อนโหลด core/peak */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const BZ = 'มดงานการป้าย', BZ2 = 'The 101';

(async () => {
  console.log('\n📒 ลองถาม PEAK ตามรหัสผังบัญชี (PEAK ปลอม · รูปคำตอบสมมติ)\n');
  const { Client } = require('pg');
  const pg = new Client({ connectionString: PG });
  await pg.connect();
  await pg.query("delete from app.peak_state where key = 'ledger_probe'");
  const stateRaw = async () => { const r = (await pg.query("select value from app.peak_state where key = 'ledger_probe'")).rows[0]; return r ? r.value : ''; };
  const expCount = async () => (await pg.query('select count(*)::int n, coalesce(sum(net),0)::numeric s from app.peak_expenses')).rows[0];
  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  let app = null, browser = null;
  try {
    const peak = require('../core/peak');
    const L = require('../core/peak-ledger');
    const T = L._t;
    const calls = () => FP.SEEN.filter(x => !/ClientToken/.test(x.u));
    const pathOf = u => decodeURIComponent(u.replace('https://api.peakaccount.com/api/v1/', ''));

    if (!ONLY_SHOT) {
      head('① ตัวช่วย — เดือน · รหัสบัญชี · กางกล่อง');
      const now = new Date('2026-10-04T05:00:00Z');
      const m0 = T.monthArg('', now);
      ok(m0.ym === '2026-09' && m0.peak === '202609' && m0.from === '20260901' && m0.to === '20260930' && m0.given === false,
         'ไม่ระบุเดือน ⇒ เดือนล่าสุดที่จบแล้ว (ก.ย. 2026 → fromMonth 202609 · 20260901–20260930)');
      ok(T.monthArg('', new Date('2026-01-10T05:00:00Z')).peak === '202512', 'ต้นปี ⇒ ถอยไปธันวาคมของปีก่อน');
      ok(T.monthArg('', new Date('2026-09-30T18:00:00Z')).peak === '202609', '‼ คิดตามเวลาไทย: 30 ก.ย. 18:00 UTC = 1 ต.ค. ไทย ⇒ เดือนที่จบแล้วคือ ก.ย.');
      ok(T.monthArg('2026-02').to === '20260228' && T.monthArg('2024-02').to === '20240229', 'วันสุดท้ายของเดือนถูก (ก.พ. 28 / 29 วัน)');
      ok(T.monthArg('2569-08').peak === '202608' && T.monthArg('202608').ym === '2026-08', 'รับ พ.ศ. และรูป yyyyMM ได้ — ส่งให้ PEAK เป็น ค.ศ. เสมอ');
      ok(T.monthArg('2026-13', now).peak === '202609' && T.monthArg('<x>', now).given === false, 'เดือนมั่ว ⇒ ถอยไปค่าตั้งต้น ไม่ส่งของมั่วไป PEAK');
      const ac = T.acctArg('530101, 110201;530205 999999');
      ok(ac.length === 3 && ac.join() === '530101,110201,530205', 'รหัสบัญชีที่กรอก: รับไม่เกิน 3 รหัส');
      ok(T.acctArg('5301&x=1, ../etc, <b>, 53 01').join() === '53,01' && T.acctArg('').length === 0, '🔒 รหัสที่มีอักขระแปลก (& / < ..) ถูกทิ้ง ไม่ต่อเข้าที่อยู่');
      const j = { W: { resCode: '200', resDesc: 'Success', accounts: [
        { accountCode: '530101', accountName: 'เงินเดือน', tx: [{ doc: 'JV-1', debit: 100 }, { doc: 'EXP-2', debit: 50 }] },
        { accountCode: '530102', accountName: 'ค่าเช่า', tx: [{ doc: 'JV-3', debit: 10 }] }] } };
      const bx = T.boxesOf(j);
      ok(bx.length === 2 && bx[0].path === 'W.accounts[]' && bx[0].n === 2 && bx[1].path === 'W.accounts[].tx[]' && bx[1].n === 3,
         'กางกล่อง: กล่องซ้อนในหลายแถวถูกนับรวมเป็นกล่องเดียว (accounts[] 2 แถว · accounts[].tx[] 3 แถว)');
      ok(T.boxesOf({ a: { b: 1 }, c: [1, 2, 3] }).length === 0, 'ไม่มีอาเรย์ของอ็อบเจกต์ ⇒ ไม่มีกล่อง (ไม่เดา)');
      const hd = T.headOf({ W: { resDesc: 'Success', clientToken: 'SECRET', accounts: [{ a: 1 }] } });
      ok(hd.find(x => x.k === 'W.clientToken').v === '«ซ่อนไว้»' && hd.find(x => x.k === 'W.accounts[]').v === '1 แถว', '🔒 ช่องนอกกล่อง: ช่องที่ชื่อเป็นความลับถูกซ่อนค่า · อาเรย์บอกแค่จำนวนแถว');
      const fr = T.flatRow({ a: 1, b: { c: 'x', d: { e: true } }, list: [{ z: 1 }], tags: ['p', 'q'] });
      ok(fr.a === 1 && fr['b.c'] === 'x' && fr['b.d.e'] === true && fr['list[]'] === '1 แถว' && fr['tags[]'] === '["p","q"]', 'แถวแบน: อ็อบเจกต์ซ้อน → a.b · อาเรย์ซ้อนบอกจำนวน');
      const rows = FP.tbRows();
      ok(T.codeCol(rows) === 'accountCode' && T.nameCol(rows, 'accountCode') === 'accountName', 'หาช่องรหัสบัญชี/ชื่อบัญชีจากรูปของค่า');
      ok(T.codeCol([{ a: 'x', b: 12.5 }, { a: 'y', b: 7 }]) === '', 'ไม่มีช่องไหนเป็นรหัสบัญชี ⇒ คืนว่าง ไม่เดา');
      const pk = T.pickGl(rows, []);
      ok(pk.length === 3 && pk[0].code === '510101' && pk[0].kind === 'exp' && pk[1].kind === 'exp' && pk[2].code === '110201' && pk[2].kind === 'bank',
         'เลือกรหัสตัวอย่าง: ค่าใช้จ่าย (ขึ้นต้น 5) ที่ตัวเลขมากสุด 2 รหัส + บัญชีธนาคาร 1 รหัส (' + pk.map(x => x.code).join(' · ') + ')');
      ok(T.pickGl([], FP.COA.map(a => ({ accountCode: a[0], accountName: a[1] }))).some(x => x.kind === 'bank') && T.pickGl([], []).length === 0,
         'ไม่มีงบทดลอง ⇒ เลือกจากผังบัญชี · ไม่มีทั้งคู่ ⇒ ไม่เลือก');

      head('② ด่านอ่านอย่างเดียว');
      const want = { 'financialreports/trialbalance': 'FinancialReports/trialbalance', 'financialreports/generalledger': 'FinancialReports/generalledger',
                     dailyjournals: 'DailyJournals', 'dailyjournals/accountcode': 'DailyJournals/accountcode' };
      ok(Object.keys(want).every(k => peak.ALLOW.has(k) && peak.CANON[k] === want[k]), 'ชื่อเส้นทาง 4 เส้นอยู่ในด่าน ALLOW ตัวสะกดตรงเอกสาร PEAK');
      ok(Object.values(L.EP).every(e => peak.ALLOW.has(e.toLowerCase())), 'ทุกเส้นที่ core/peak-ledger.js จะยิง ผ่านด่าน ALLOW');
      ok([...peak.ALLOW].filter(a => /create|update|delete|void|cancel|post|save|edit|approve|queue/i.test(a)).length === 0, '‼ ด่าน ALLOW ไม่มีชื่อเส้นทางที่แปลว่าเขียน');
      const src = read('core/peak-ledger.js');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
      ok(!/method\s*:/.test(code) && !/\bfetch\s*\(/.test(code) && /peak\.get\(/.test(code) && /peak\.getOnce\(/.test(code), '🔒 ไฟล์นี้ไม่ยิงเน็ตเอง — ออกทาง peak.get() / peak.getOnce() (GET ตายตัว) เท่านั้น');
      const pkSrc = read('core/peak.js'), go = pkSrc.slice(pkSrc.indexOf('async function getOnce('), pkSrc.indexOf('/** ใบแจ้งหนี้ตามเลขที่'));
      ok(/method: 'GET'/.test(go) && !/POST|PUT|PATCH|DELETE/.test(go) && /ALLOW\.has\(r\)/.test(go) && /CANON\[r\]/.test(go) && /BUDGET\.calls > MAX_CALLS/.test(go),
         '🔒 peak.getOnce(): GET ตายตัว · ผ่านด่าน ALLOW · ยิงด้วยชื่อที่ผ่านด่าน · นับคำขอ/นาทีเหมือน get()');
      ok(/clientToken\(c\.biz, false\)/.test(go) && !/clientToken\(c\.biz, true\)/.test(go), '🔴 peak.getOnce() ไม่บังคับขอกุญแจใหม่ — คำตอบ 401/403 ของเส้นที่ไม่มีสิทธิ์จะไม่ทำให้ตัวซิงก์ทั้งระบบสะดุด');
      ok((pkSrc.match(/method:\s*['"]POST['"]/gi) || []).length <= 1, '   core/peak.js ยังมี POST ที่เดียว (ขอกุญแจ)');
      ok(!/require\(['"]\.\/db['"]\)/.test(src) && !/\b(insert|upsert|update|remove)\s*\(/.test(src), '🔒 ไม่เขียนตารางข้อมูลใด ๆ (จดแค่สรุปผ่าน peak-queue.state)');
      ok(!/peak-ledger/.test(read('modules/sales/cashflow.js')) && !/peak-ledger/.test(read('modules/mgmt/data.js')),
         '🔴 ตัวคิดเลข Cash Flow / Management Report ยังไม่อ่านผลนี้ — รอบนี้ไม่มีตัวเลขไหนเปลี่ยน');

      head('③ PEAK เปิดสิทธิ์ให้ (full) — ยิงถูกเส้น + กางคำตอบ');
      FP.SEEN.length = 0; FP.setMode('full'); FP.setSecret(true); L._t.reset();
      const e0 = await expCount();
      const R = await L.probe({ by: 'boss' });
      const cs = calls();
      ok(R.ok && R.month === (T.monthArg('').ym) && R.biz.length === 2 && R.biz[0].biz === BZ && R.biz[1].biz === BZ2, 'ถามครบทุกกิจการที่ตั้งกุญแจไว้ (2 กิจการ)');
      ok(R.anyYes === true && R.biz.every(b => b.verdict === 'yes'), 'ผล: ✅ ดึงงบทดลอง + บัญชีแยกประเภทได้ ทั้ง 2 กิจการ');
      ok(FP.SEEN.every(x => x.m === 'GET' || /ClientToken$/.test(x.u)), '🔒 ทุกคำขอเป็น GET (ยกเว้นขอกุญแจเข้าระบบ)');
      const M = T.monthArg('');
      const one = cs.slice(0, cs.length / 2).map(x => pathOf(x.u));
      ok(one.length === 6 && cs.length === 12, 'ยิง 6 คำขอต่อกิจการ (เชื่อมต่อ · ผังบัญชี · งบทดลอง · แยกประเภท 2 รหัส · สมุดรายวัน) — ได้ ' + one.length);
      ok(one[1] === 'DailyJournals/accountcode', 'ผังบัญชี: GET DailyJournals/accountcode (ไม่มีพารามิเตอร์)');
      ok(one[2] === `FinancialReports/trialbalance?fromMonth=${M.peak}&toMonth=${M.peak}`, 'งบทดลอง: ' + one[2]);
      ok(one[3] === `FinancialReports/generalledger?fromDate=${M.from}&toDate=${M.to}&accountCode=510101`, 'บัญชีแยกประเภท (ค่าใช้จ่าย): ' + one[3]);
      ok(one[4] === `FinancialReports/generalledger?fromDate=${M.from}&toDate=${M.to}&accountCode=110201`, 'บัญชีแยกประเภท (ธนาคาร): ' + one[4]);
      ok(one[5] === 'DailyJournals?page=1&limit=10', 'สมุดรายวัน: ' + one[5]);
      const B = R.biz[0], st = k => B.steps.filter(s => s.step === k);
      ok(st('conn')[0].ok && !(st('conn')[0].boxes || []).length && !(st('conn')[0].head || []).length && !st('conn')[0].rawHead, '🔒 ขั้นเช็กการเชื่อมต่อ: ไม่ส่งข้อมูลใบเสร็จกลับมาหน้าจอ');
      const tb = st('tb')[0], tbx = tb.boxes[0];
      ok(tb.ok && tb.n === FP.tbRows().length && tbx.path === 'PeakTrialBalance.accounts[]' && tbx.rows.length === tb.n, 'งบทดลอง: ได้ ' + tb.n + ' แถว จากกล่อง ' + tbx.path);
      ok(tbx.fields.map(f => f.k).join() === 'accountCode,accountName,beginningDebit,beginningCredit,movementDebit,movementCredit,endingDebit,endingCredit',
         'ชื่อช่อง = ตามที่ PEAK ส่งมาเป๊ะ ไม่เปลี่ยนชื่อ');
      const r53 = tbx.rows.find(r => r.accountCode === '530101');
      ok(r53 && r53.movementDebit === 612000 && r53.beginningDebit === 5508000, 'ค่าในแถว = ของ PEAK ตรงตัว (ไม่ปัด ไม่รวม)');
      ok(tbx.codeCol === 'accountCode' && tbx.nameCol === 'accountName', 'ชี้ช่องที่น่าจะเป็นรหัสบัญชี/ชื่อบัญชี (เฉพาะผังบัญชี/งบทดลอง)');
      ok(B.steps.filter(s => s.step === 'gl' || s.step === 'dj').every(s => s.boxes.every(x => x.codeCol === '' && x.nameCol === '')),
         '   กล่องของบัญชีแยกประเภท/สมุดรายวันไม่ติดป้ายเดา (กันชี้วันที่ 20260903 ว่าเป็นรหัสบัญชี)');
      ok(T.codeCol([{ transactionDate: '20260903', documentCode: 'EXP-1' }, { transactionDate: '20260918', documentCode: 'EXP-2' }]) === '' && T.codeCol([{ d: '20260903' }, { d: '20261231' }]) === '',
         '   ค่าที่เป็นวันที่ yyyyMMdd ไม่ถูกมองเป็นรหัสบัญชี');
      const gl = st('gl');
      ok(gl.length === 2 && gl[0].acct === '510101' && gl[0].kind === 'exp' && gl[1].acct === '110201' && gl[1].kind === 'bank' && gl.every(g => g.why), 'บัญชีแยกประเภท: ถาม 2 รหัส พร้อมเหตุผลที่เลือก');
      const txb = gl[1].boxes.find(b => /transactions\[\]$/.test(b.path));
      ok(txb && txb.n === 4 && txb.rows.some(r => /^JV-/.test(r.documentCode)) && txb.rows.some(r => /^EXP-/.test(r.documentCode)), 'รายการเดินบัญชี (กล่องซ้อน) กางออกมาให้เห็น — มีทั้งเอกสาร EXP และสมุดรายวัน JV');
      const coa = st('coa')[0];
      ok(coa.boxes[0].rows.every(r => r.apiKey === '«ซ่อนไว้»') && JSON.stringify(R).indexOf('should-be-hidden') < 0, '🔒 ช่องที่ชื่อเป็นความลับ (apiKey) ถูกซ่อนค่า — ทั้งในแถวและในต้นคำตอบดิบ');
      ok(JSON.stringify(R).indexOf('_flat') < 0 && !/test-connect-key|test-user-token|tok-0123456789/.test(JSON.stringify(R)), '🔒 ไม่มีกุญแจ/โทเคน/ของใช้ภายในหลุดออกมาในคำตอบ');
      ok(tb.rawHead && tb.rawHead.length <= 3000 && tb.size > 0 && /PeakTrialBalance/.test(tb.rawHead), 'มีต้นคำตอบดิบ (ตัดไม่เกิน 3,000 ตัวอักษร) ไว้ยืนยันโครงจริง');
      ok(R.used === false && R.readOnly === true && R.full === true, 'คำตอบบอกชัด: อ่านอย่างเดียว · ยังไม่นำไปใช้ในรายงาน · เป็นผลเต็ม');
      const e1 = await expCount();
      ok(e0.n === e1.n && String(e0.s) === String(e1.s), '🔴 ตาราง app.peak_expenses ไม่ถูกแตะ (' + e1.n + ' ใบเท่าเดิม)');
      const sj = JSON.parse(await stateRaw());
      ok(sj.month === R.month && sj.biz.length === 2 && sj.biz[0].verdict === 'yes' && JSON.stringify(sj).indexOf('612000') < 0 && JSON.stringify(sj).indexOf('เงินเดือน') < 0,
         'จดลง app.peak_state แค่สรุปผล — ไม่มีแถวข้อมูล ไม่มีตัวเลขเงิน');

      head('④ PEAK ตอบแบบอื่น');
      const run = async (mode, o) => { FP.SEEN.length = 0; FP.setMode(mode); L._t.reset(); return L.probe(Object.assign({ biz: BZ }, o || {})); };
      let D = await run('denied');
      ok(D.ok && D.biz[0].verdict === 'no' && D.biz[0].steps[0].ok && /HTTP 403/.test(D.biz[0].steps.find(s => s.step === 'tb').err) && /not allowed/.test(D.biz[0].steps.find(s => s.step === 'tb').err),
         'PEAK ปฏิเสธ (HTTP 403): การเชื่อมต่อปกติ + ผล "ไม่ให้ดึงงบทดลอง" + โชว์ข้อความจาก PEAK ตรงตัว');
      ok(D.anyYes === false && /ไม่ให้ดึงงบทดลอง/.test(D.biz[0].verdictTh) && D.biz[0].glNote, 'ไม่มีรหัสบัญชีตัวอย่าง ⇒ บอกให้กรอกรหัสเอง ไม่ยิงบัญชีแยกประเภทมั่ว');
      ok(FP.SEEN.filter(x => /ClientToken/.test(x.u)).length === 0 && ['coa', 'tb', 'dj'].every(k => /HTTP 403/.test(D.biz[0].steps.find(s => s.step === k).err)),
         '🔴 โดน 403 ทั้ง 3 เส้น แต่ไม่ไปขอกุญแจใหม่เลยสักครั้ง (ไม่ชนกติกา 1 ครั้ง/65 วิ) และทุกเส้นได้ข้อความจริงของ PEAK');
      const still = await peak.get('Receipts', { limit: 1, page: 1 }, BZ).then(() => true, () => false);
      ok(still, '   หลังโดนปฏิเสธ การเชื่อมต่อปกติของระบบ (ใบเสร็จ) ยังใช้ได้ทันที — ตัวซิงก์ไม่สะดุด');
      ok(calls().filter(x => /generalledger/.test(x.u)).length === 0, '   ไม่ยิงบัญชีแยกประเภทเมื่อไม่มีรหัส (PEAK บังคับ accountCode)');
      D = await run('denied200');
      ok(D.biz[0].verdict === 'no' && /Permission denied/.test(D.biz[0].steps.find(s => s.step === 'tb').err), 'PEAK ตอบ 200 แต่เนื้อคำตอบบอกว่าไม่มีสิทธิ์ ⇒ ไม่ถูกแปลว่า "ไม่มีข้อมูล"');
      D = await run('conn');
      ok(D.biz[0].verdict === 'conn' && D.biz[0].steps.length === 1 && /เชื่อมต่อ PEAK ของกิจการนี้ไม่ได้/.test(D.biz[0].verdictTh) && calls().length === 1,
         '🔴 กุญแจ/การเชื่อมต่อเสีย ⇒ หยุดที่ขั้นแรก ไม่สรุปว่า "PEAK ไม่เปิดสิทธิ์" และไม่ยิงต่อ');
      D = await run('odd');
      const otb = D.biz[0].steps.find(s => s.step === 'tb');
      ok(otb.ok && otb.n === 0 && otb.boxes.length === 0 && otb.head.length > 5 && /balances/.test(otb.rawHead), 'รูปแปลก (ไม่มีอาเรย์): ไม่พัง · โชว์ช่องนอกกล่อง + ต้นคำตอบดิบให้อ่านโครง');
      ok(D.biz[0].verdict === 'gl' && /งบทดลอง.*ไม่มีแถว/.test(D.biz[0].verdictTh), '   ไม่สรุปว่างบทดลอง "ได้" ทั้งที่อ่านแถวไม่ออก');
      D = await run('empty');
      ok(D.biz[0].steps.find(s => s.step === 'tb').said === '200 · Success' && D.biz[0].steps.find(s => s.step === 'tb').n === 0, 'งบทดลองว่าง: โชว์ว่า PEAK ตอบ "200 · Success" แต่ 0 แถว');
      D = await run('full', { acct: '530101, 530205', month: '2026-08' });
      const gq = calls().filter(x => /generalledger/.test(x.u)).map(x => pathOf(x.u));
      ok(gq.length === 2 && gq[0] === 'FinancialReports/generalledger?fromDate=20260801&toDate=20260831&accountCode=530101' && /accountCode=530205$/.test(gq[1]),
         'กรอกรหัสเอง + เลือกเดือน ⇒ ถามเฉพาะรหัสที่กรอก ในเดือนที่เลือก');
      ok(calls().some(x => /trialbalance\?fromMonth=202608&toMonth=202608$/.test(x.u)) && D.month === '2026-08' && D.acct.join() === '530101,530205', '   งบทดลองใช้เดือนเดียวกัน');
      ok(D.biz[0].steps.filter(s => s.step === 'gl').every(g => g.kind === 'user' && g.why === 'รหัสที่กรอกมา'), '   บอกว่าเป็นรหัสที่กรอกมา');
      const bad = await L.probe({ biz: 'บริษัทมั่ว' });
      ok(bad.ok === false && /ไม่รู้จักกิจการ/.test(bad.msg), 'กิจการที่ไม่รู้จัก ⇒ ปฏิเสธ ไม่ยิง PEAK');
      /* โควตาเต็ม */
      const PX = require('../core/peak-expenses'), g0 = PX.rateGate;
      PX.rateGate = async () => false; FP.SEEN.length = 0; L._t.reset();
      const W = await L.probe({ biz: BZ });
      PX.rateGate = g0;
      ok(W.biz[0].verdict === 'wait' && calls().length === 0 && /โควตา/.test(W.biz[0].verdictTh), 'โควตาคำขอ/นาทีเต็ม (ตัวดึงรายจ่ายใช้อยู่) ⇒ ไม่ยิง ไม่แซงคิว บอกให้รอ');
      /* กดซ้อน */
      FP.setMode('full'); L._t.reset();
      const [p1, p2] = await Promise.all([L.probe({ biz: BZ }), L.probe({ biz: BZ })]);
      ok([p1, p2].filter(x => x.ok).length === 1 && [p1, p2].some(x => x.ok === false && /กำลังทดสอบอยู่/.test(x.msg)), 'กดซ้อนกัน ⇒ วิ่งทีละรอบ');

      head('⑤ ผลครั้งล่าสุด (ไม่ยิง PEAK)');
      FP.SEEN.length = 0;
      const la = await L.last();
      ok(la.full === true && la.biz[0].steps.find(s => s.step === 'tb').boxes.length === 1 && FP.SEEN.length === 0, 'ภายใน 6 ชม.: ได้ผลเต็ม (มีแถวข้อมูล) โดยไม่ยิง PEAK');
      L._t.reset();
      const lb = await L.last();
      ok(lb.ok && lb.full === false && lb.biz[0].verdict === 'yes' && !lb.biz[0].steps[0].boxes && FP.SEEN.length === 0, 'เซิร์ฟเวอร์เริ่มใหม่: เหลือสรุปจาก app.peak_state (ไม่มีแถวข้อมูล)');
      await pg.query("delete from app.peak_state where key = 'ledger_probe'");
      ok((await L.last()).never === true, 'ยังไม่เคยทดสอบ ⇒ บอกว่ายังไม่เคย');
    }

    /* ═══ เซิร์ฟเวอร์จริง + PEAK ปลอมโหลดล่วงหน้า ═══ */
    head('⑥ เส้นทางจริง — สิทธิ์');
    await pg.query("delete from app.peak_state where key = 'ledger_probe'");
    const hash = require('bcryptjs').hashSync('test1234', 10);
    await pg.query(`insert into app.app_users ("Username","Nickname","Name","Permission","PasswordHash","Status")
       values ('crboss','พี่เอ','Panusphong','Administrator',$1,'Login'), ('crsale','ส้ม','(ส้ม) สมหญิง','Sale',$1,'Login')
       on conflict (lower("Username")) do update set "PasswordHash" = excluded."PasswordHash",
         "Permission" = excluded."Permission", "Nickname" = excluded."Nickname", "Name" = excluded."Name", "Status" = 'Login'`, [hash]);
    /* กลุ่ม administrator ต้องมีสิทธิ์แอป Management Report (ของจริง = รัน sql/109 ใน Supabase แล้ว) — รันซ้ำได้ ไม่ลบอะไร */
    await pg.query(read('sql/109-mgmt-report.sql'));
    /* รายจ่ายตัวอย่าง (เอกสาร EXP) — ให้หน้า Cash Flow อยู่ในสภาพเดียวกับเครื่องจริงที่มีเงินออกแล้ว */
    const { todayTH } = require('../core/thai-date');
    const TD = todayTH(), d0 = new Date(TD + 'T00:00:00Z');
    const dAgo = n => new Date(d0.getTime() - n * 86400000).toISOString().slice(0, 10);
    await pg.query("delete from app.peak_expenses where code like 'EXP-LEDTEST%'");
    const seed = [[BZ, 3, 'บ.อะคริลิกไทย', 125000], [BZ, 20, 'หจก.สติกเกอร์', 85500], [BZ, 41, 'บ.อะคริลิกไทย', 96000], [BZ2, 5, 'ร้านเหล็กรุ่งเรือง', 64200], [BZ2, 37, 'บ.ไฟ LED', 48900], [BZ, 70, 'บ.ขนส่ง', 15000]];
    for (let i = 0; i < seed.length; i++) {
      const [b, ago, v, amt] = seed[i], dt = dAgo(ago);
      await pg.query(`insert into app.peak_expenses (code,doc_date,month,due_at,vendor,net,paid,remain,status,biz,paid_at)
        values ($1,$2,$3,$2,$4,$5,$5,0,'จ่ายแล้ว',$6,$2) on conflict do nothing`, ['EXP-LEDTEST' + String(i + 1).padStart(5, '0'), dt, dt.slice(0, 7), v, amt, b]);
    }
    /* ยอดขาย + ใบเสร็จตัวอย่าง — ยามนี้หว่านเอง ไม่พึ่งของที่ยามอื่นทิ้งไว้ (ตารางขายว่าง = หน้า Cash Flow ไม่วาด) */
    await pg.query(`delete from app.total_sales where "รหัสงาน" like 'LEDT26%'`);
    await pg.query("delete from app.cash_flow where iv like 'IV-LEDTEST%'");
    const sales = [[990001, 2, 'บ.ลูกค้าหนึ่ง', 180000, 'B2B', 'LINE OA'], [990002, 9, 'ร้านลูกค้าสอง', 64000, 'สาขามดงาน', 'สาขา_บางนา'],
                   [990003, 33, 'บ.ลูกค้าสาม', 240000, 'Facebook', 'เพจ'], [990004, 48, 'บ.ลูกค้าสี่', 95000, 'B2B', 'LINE OA']];
    for (let i = 0; i < sales.length; i++) {
      const [row, ago, co, amt, src2, plat] = sales[i], dt = dAgo(ago), iv = 'IV-LEDTEST' + String(i + 1).padStart(4, '0');
      const cols = { _row: row, 'รหัสงาน': 'LEDT26/' + String(i + 1).padStart(3, '0'), 'วันที่ติดต่อ': dt, 'วันที่ปิดการขาย': dt, 'ชื่อบริษัท': co,
        'Create By': 'crsale', 'Lead Status': 'ปิดการขาย', 'ประเภทลูกค้า': 'ลูกค้าใหม่', 'ลูกค้ามาจากไหน': src2, 'ชื่อช่อง / Platform': plat,
        'ยอดขาย (บาท)': amt, 'เลขที่ QO / IV': iv };
      const k = Object.keys(cols);
      await pg.query(`insert into app.total_sales (${k.map(c => '"' + c + '"').join(',')}) values (${k.map((_, j) => '$' + (j + 1)).join(',')})`, k.map(c => cols[c]));
      await pg.query(`insert into app.cash_flow (key,paid_at,ym,iv,amount,wht,cash,receipt_no,customer,job_code,sale) values ($1,$2,$3,$4,$5,0,$5,$6,$7,$8,'crsale')
        on conflict do nothing`, [`${iv}|${dt}|${Math.round(amt * 100)}`, dt, dt.slice(0, 7), iv, amt, 'RT-LEDTEST' + (i + 1), co, cols['รหัสงาน']]);
    }
    const env = Object.assign({}, process.env, KEYS, { SUPABASE_URL: `http://127.0.0.1:${REST_PORT}`, SUPABASE_KEY: 'test-key',
      SESSION_SECRET: 'a'.repeat(64), NODE_ENV: 'development', PORT: String(APP_PORT), SYNC_ON_BOOT: '0', SYNC_EVERY_MIN: '0',
      FAKE_PEAK_MODE: 'full', NODE_OPTIONS: '--require ' + path.join(__dirname, 'fake-peak-ledger.js') });
    app = spawn('node', [path.join(APP_DIR, 'server.js')], { env, stdio: 'pipe', cwd: APP_DIR });
    let booted = false;
    app.stdout.on('data', d => { if (String(d).includes('พอร์ต')) booted = true; });
    app.stderr.on('data', () => {});
    for (let i = 0; i < 100 && !booted; i++) await sleep(200);
    const base = `http://127.0.0.1:${APP_PORT}`;
    const login = async who => {
      const r = await fetch(base + '/api/login', { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: who, password: 'test1234' }) });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      return sc.map(s => s.split(';')[0]).join('; ');
    };
    const boss = await login('crboss'), sale = await login('crsale');
    const req = async (m, u, c, body) => {
      const r = await fetch(base + u, { method: m, redirect: 'manual', headers: Object.assign({ 'content-type': 'application/json' }, c ? { cookie: c } : {}), body: body ? JSON.stringify(body) : undefined });
      let j = null; try { j = await r.json(); } catch (e) { j = null; }
      return { s: r.status, j };
    };
    if (!ONLY_SHOT) {
      const s1 = await req('POST', '/m/sales/api/cashflow/ledger/probe', sale, {});
      ok(s1.s === 403 && s1.j && s1.j.ok === false && !s1.j.biz, '🔴 เซลส์สั่งทดสอบไม่ได้ (403) — ไม่มีข้อมูลบัญชีหลุด');
      const s2 = await req('GET', '/m/sales/api/cashflow/ledger/last', sale);
      ok(s2.s === 403 && !s2.j.biz, '🔴 เซลส์ดูผลครั้งล่าสุดไม่ได้ (403)');
      const s3 = await req('POST', '/m/sales/api/cashflow/ledger/probe', '', {});
      ok(s3.s !== 200, 'ไม่ได้ล็อกอิน ⇒ เข้าไม่ได้ (' + s3.s + ')');
      const s4 = await req('GET', '/m/mgmt/api/ledger/last', sale);
      ok(s4.s === 403 && !(s4.j && s4.j.biz), '🔴 Management Report: เซลส์ดูผลไม่ได้ (403)');
      const n0 = await req('GET', '/m/sales/api/cashflow/ledger/last', boss);
      ok(n0.s === 200 && n0.j.never === true, 'ผู้ดูแลระบบ: ยังไม่เคยทดสอบ ⇒ never');
      const m0 = await req('GET', '/m/mgmt/api/ledger/last', boss);
      ok(m0.s === 200 && m0.j.ok && m0.j.never === true, 'Management Report: ยังไม่เคยทดสอบ ⇒ never');
      const cf0 = await req('GET', '/m/sales/api/cashflow?months=2', boss);
      const out0 = cf0.j && cf0.j.totOut;
      const a1 = await req('POST', '/m/sales/api/cashflow/ledger/probe', boss, { month: '2026-09' });
      ok(a1.s === 200 && a1.j.ok && a1.j.by === 'crboss' && a1.j.month === '2026-09' && a1.j.biz.length === 2 && a1.j.biz.every(b => b.verdict === 'yes'),
         'ผู้ดูแลระบบสั่งทดสอบได้ — ผ่านเซิร์ฟเวอร์จริงถึงคำขอที่ยิงออก (PEAK ปลอม) ทั้ง 2 กิจการ');
      const a2 = await req('GET', '/m/sales/api/cashflow/ledger/last', boss);
      ok(a2.j.full === true && a2.j.at === a1.j.at, 'เมนู Cash Flow: ดูผลครั้งล่าสุดได้ (ผลเต็ม)');
      const a3 = await req('GET', '/m/mgmt/api/ledger/last', boss);
      ok(a3.s === 200 && a3.j.at === a1.j.at && a3.j.biz.length === 2 && a3.j.biz[0].verdict === 'yes' && !a3.j.biz[0].steps && JSON.stringify(a3.j).indexOf('accountCode') < 0,
         'Management Report: เห็นผลชุดเดียวกัน (เวลาเดียวกัน) แต่ได้เฉพาะสรุป ไม่มีแถวข้อมูล');
      const cf1 = await req('GET', '/m/sales/api/cashflow?months=2', boss);
      ok(cf0.j && cf0.j.ok && cf0.j.hasExp === true && out0 > 0 && cf1.j.totOut === out0, '🔴 เงินออกของหน้า Cash Flow เท่าเดิมทุกบาทหลังทดสอบ (' + out0 + ') — รอบนี้ไม่มีตัวเลขไหนเปลี่ยน');
      const h1 = await req('GET', '/m/mgmt/api/part/health', boss);
      const ct = ((h1.j && h1.j.tiles) || []).find(t => t.key === 'cash'), et = ((h1.j && h1.j.tiles) || []).find(t => t.key === 'expense');
      ok(ct && /เอกสาร EXP/.test(ct.note || '') && /ยังไม่รวม/.test(ct.note), 'Management Report: การ์ด Cashflow มีบรรทัดเตือนว่าเงินออกนับจาก EXP เท่านั้น');
      ok(!et || et.s === 'na' || /เอกสาร EXP/.test(et.note || ''), '   การ์ดค่าใช้จ่ายมีบรรทัดเตือนเดียวกัน (เมื่อประเมินได้)');
    }

    /* ═══ หน้าจอจริง ═══ */
    head('⑦ หน้าจอจริง (Chromium)');
    const { chromium } = require('playwright');
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const FD = '/root/fonts-prompt/package/files/';
    let css = '';
    if (fs.existsSync(FD)) for (const wt of [400, 500, 600, 700, 800]) for (const [sub, rng] of [['thai', 'U+0E01-0E5B,U+200C-200D,U+25CC'], ['latin', 'U+0000-00FF,U+2000-206F,U+20AC,U+2212']]) {
      const f = FD + `prompt-${sub}-${wt}-normal.woff2`;
      if (fs.existsSync(f)) css += `@font-face{font-family:'Prompt';font-weight:${wt};src:url(data:font/woff2;base64,${fs.readFileSync(f).toString('base64')}) format('woff2');unicode-range:${rng}}\n`;
    }
    const open = async (cookie, url, h) => {
      const ctx = await browser.newContext({ viewport: { width: 1500, height: h || 1100 }, acceptDownloads: true });
      await ctx.addCookies(cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: base }; }));
      await ctx.route('**/fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: css }));
      await ctx.route('**/fonts.gstatic.com/**', r => r.abort());
      const p = await ctx.newPage();
      const errs = [];
      p.on('pageerror', e => errs.push(String(e)));
      await p.goto(base + url, { waitUntil: 'domcontentloaded' });
      return { p, ctx, errs };
    };
    const A = await open(boss, '/m/sales/', +process.env.SHOT_H || 1100);
    await A.p.waitForSelector('#btnMenu', { timeout: 30000 });
    await A.p.waitForTimeout(1200);
    await A.p.click('#btnMenu');
    await A.p.waitForTimeout(300);
    await A.p.click('.menu-i[data-act="cash"]');
    /* รอบ 235 — เมนู Cash Flow เปิดหน้าใหม่ · ปุ่มทดสอบนี้อยู่ในหน้าเดิม หลังปุ่ม "🛠 เครื่องมือผู้ดูแล" (รุ่นก่อนรอบ 235 เปิดหน้าเดิมตรง ๆ) */
    await A.p.waitForSelector('#cbTools, #cfExpOut', { timeout: 40000, state: 'attached' });
    if (await A.p.locator('#cbTools').count()) await A.p.click('#cbTools');
    await A.p.waitForSelector('#cfExpOut', { timeout: 40000, state: 'attached' });
    const hasBox = await A.p.locator('#cfLedBox').count();
    if (ONLY_SHOT) {
      /* ภาพรุ่นก่อน: แผงเงินออก (ยังไม่มีบล็อกรหัสผังบัญชี) */
      if (process.env.SHOT) { const el = A.p.locator('#cfExpOut').locator('xpath=..'); await el.scrollIntoViewIfNeeded(); await el.screenshot({ path: process.env.SHOT }); }
    } else {
      ok(hasBox === 1, 'แผงเงินออกของ Cash Flow มีบล็อก "ค่าใช้จ่ายที่ลงตรงรหัสผังบัญชี"');
      const boxTxt = await A.p.locator('#cfLedBox').innerText();
      ok(/ยังไม่รวมในหน้านี้/.test(boxTxt) && /Management Report/.test(boxTxt) && /อ่านอย่างเดียว/.test(boxTxt) && /ยังไม่นำตัวเลขไปคิดในรายงาน/.test(boxTxt),
         'บอกตรง ๆ: ยังไม่รวม · ใช้ข้อมูลชุดเดียวกับ Management Report · อ่านอย่างเดียว · ยังไม่นำไปคิด');
      const defM = await A.p.inputValue('#cfLedMonth');
      ok(/^\d{4}-\d{2}$/.test(defM), 'ช่องเดือนตั้งต้นเป็นเดือนที่แล้ว (' + defM + ')');
      const outBefore = await A.p.locator('#cfBody').innerText();
      let dlgTxt = '';
      A.p.once('dialog', d => { dlgTxt = d.message(); d.accept(); });
      await A.p.fill('#cfLedMonth', '2026-09');
      await A.p.click('#cfLedBtn');
      await A.p.waitForSelector('#cfLedRes', { timeout: 60000 });
      ok(/อ่านอย่างเดียว/.test(dlgTxt) && /7 คำขอ/.test(dlgTxt), 'ถามยืนยันก่อนยิง PEAK (บอกจำนวนคำขอ + อ่านอย่างเดียว)');
      const res = await A.p.locator('#cfLedRes').innerText();
      ok(/เดือน 2026-09/.test(res) && /ยังไม่นำไปคิดในรายงาน/.test(res), 'ผลขึ้นใต้ปุ่ม พร้อมป้าย "ยังไม่นำไปคิดในรายงาน"');
      const vd = await A.p.$$eval('#cfLedRes .cfled-biz', e => e.map(x => x.getAttribute('data-verdict') + '|' + x.querySelector('.cfled-verdict').textContent));
      ok(vd.length === 2 && vd.every(v => /^yes\|✅/.test(v)), 'ผลรายกิจการ 2 กิจการ: ' + vd.map(v => v.split('|')[1]).join(' / '));
      ok(/FinancialReports\/trialbalance\?fromMonth=202609&toMonth=202609/.test(res) && /DailyJournals\/accountcode/.test(res), 'โชว์เส้นทาง + พารามิเตอร์ที่ถามไปจริง');
      const cells = await A.p.$$eval('#cfLedRes .cfled-tb', t => t.map(x => x.rows.length));
      ok(cells.length >= 8 && cells.some(n => n >= 14), 'กางคำตอบเป็นตารางจริง ' + cells.length + ' ตาราง (งบทดลอง ' + Math.max.apply(null, cells) + ' แถวรวมหัว)');
      ok(/accountCode/.test(res) && /น่าจะเป็นรหัสบัญชี/.test(res) && /612,000/.test(res) && /JV-2026092500003/.test(res), 'เห็นชื่อช่อง · ค่า · เลขเอกสารสมุดรายวัน ตามที่ PEAK (ปลอม) ส่งมา');
      ok(!/แสดงเฉพาะสรุป/.test(res) && await A.p.locator('#cfLedDl').count() === 1, 'ผลที่เพิ่งทดสอบ = ผลเต็ม มีปุ่มดาวน์โหลด');
      const [file] = await Promise.all([A.p.waitForEvent('download', { timeout: 15000 }), A.p.click('#cfLedDl', { timeout: 10000 })]);
      const tmp = path.join(require('os').tmpdir(), 'led-' + Date.now() + '.json');
      await file.saveAs(tmp);
      const dj = JSON.parse(fs.readFileSync(tmp, 'utf8'));
      ok(file.suggestedFilename() === 'peak-ledger-probe-2026-09.json' && dj.biz.length === 2 && dj.biz[0].steps.find(s => s.step === 'tb').boxes[0].rows.length === FP.tbRows().length && !/test-connect-key|tok-0123/.test(JSON.stringify(dj)),
         'ดาวน์โหลดผลทั้งหมดเป็นไฟล์ .json ได้ — ครบทุกแถว ไม่มีกุญแจติดไป');
      fs.unlinkSync(tmp);
      const outAfter = await A.p.locator('#cfBody').innerText();
      const money = t => (t.match(/จ่ายออกจริงใน[^\n]*/) || [''])[0];
      ok(money(outBefore) && money(outBefore) === money(outAfter), '🔴 ตัวเลขเงินออกบนหน้าเท่าเดิม: ' + money(outAfter).slice(0, 60));
      ok(A.errs.length === 0, 'ไม่มี error ในหน้า' + (A.errs.length ? ' — ' + A.errs[0] : ''));
      /* ดูผลครั้งล่าสุด */
      await A.p.evaluate(() => { document.getElementById('cfLedOut').innerHTML = ''; });
      await A.p.click('button[onclick="cfLedLast()"]');
      await A.p.waitForSelector('#cfLedRes', { timeout: 20000 });
      ok(/เดือน 2026-09/.test(await A.p.locator('#cfLedRes').innerText()), 'ปุ่ม "ดูผลครั้งล่าสุด" เรียกผลเดิมกลับมา (ไม่ยิง PEAK)');
      if (process.env.SHOT) {
        /* บล็อกนี้ยาวกว่ากรอบเลื่อนของแผง ⇒ ยกสำเนาออกมาวางบนหน้าเปล่าก่อนถ่าย (ท้ายสุดของการทดสอบหน้านี้แล้ว)
         * SHOT_BIZ=1 ⇒ เก็บเฉพาะกิจการแรก (ภาพไม่ยาวเกิน) */
        await A.p.evaluate(one => {
          const el = document.getElementById('cfLedBox').cloneNode(true);
          if (one) el.querySelectorAll('.cfled-biz').forEach((b, i) => { if (i > 0) b.remove(); });
          el.querySelectorAll('.cf-tb').forEach(t => { t.style.maxHeight = 'none'; });
          const w = document.createElement('div');
          w.id = 'shotWrap'; w.style.cssText = 'width:1400px;background:#fff1f2;padding:14px';
          w.appendChild(el);
          document.body.innerHTML = ''; document.body.appendChild(w);
          document.documentElement.style.cssText = 'overflow:visible;height:auto'; document.body.style.cssText = 'overflow:visible;height:auto;margin:0;background:#fff';
        }, !!process.env.SHOT_BIZ);
        await A.p.waitForTimeout(300);
        await A.p.locator('#shotWrap').screenshot({ path: process.env.SHOT });
      }
    }
    await A.ctx.close();

    const G = await open(boss, '/m/mgmt/', 1500);
    await G.p.waitForFunction(() => { const e = document.getElementById('expStats'); return e && e.innerText && !/กำลังโหลด/.test(e.innerText); }, null, { timeout: 60000 });
    await G.p.waitForFunction(() => { const e = document.getElementById('prim'); return e && !/กำลังโหลด/.test(e.innerText); }, null, { timeout: 60000 });
    await G.p.waitForTimeout(800);
    if (!ONLY_SHOT) {
      const lt = await G.p.locator('#expLedger').innerText();
      ok(/เอกสาร EXP/.test(lt) && /ยังไม่รวม/.test(lt) && /มดงานการป้าย/.test(lt) && /✅/.test(lt) && /The 101/.test(lt) && /ยังไม่นำมาคิดในรายงาน/.test(lt),
         'Management Report: กล่องค่าใช้จ่ายบอกว่ายังไม่รวม + ผลทดสอบล่าสุดของ 2 กิจการ (ชุดเดียวกับเมนู Cash Flow)');
      ok(await G.p.locator('#expLedger a[href="/m/sales/"]').count() === 1, '   มีทางไปเมนู Cash Flow เพื่อกดทดสอบ');
      const pn = await G.p.$$eval('#prim .tnote', e => e.map(x => x.textContent));
      ok(pn.length === 1 && /เอกสาร EXP/.test(pn[0]), 'การ์ด Cashflow (ตัวหลัก) มีบรรทัดเตือน ⚠ เงินออกนับจาก EXP เท่านั้น');
      ok(G.errs.length === 0, 'ไม่มี error ในหน้า' + (G.errs.length ? ' — ' + G.errs[0] : ''));
    }
    if (process.env.SHOT_MGMT) {
      const el = G.p.locator('#expStats').locator('xpath=..');
      await el.scrollIntoViewIfNeeded(); await el.screenshot({ path: process.env.SHOT_MGMT });
    }
    if (process.env.SHOT_MGMT_TOP) await G.p.locator('#prim').screenshot({ path: process.env.SHOT_MGMT_TOP });
    await G.ctx.close();
  } catch (e) {
    fail++; console.log('  ❌ ล้มกลางทาง: ' + (e && e.stack || e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (app) app.kill();
    await pg.query("delete from app.peak_expenses where code like 'EXP-LEDTEST%'").catch(() => {});
    await pg.query(`delete from app.total_sales where "รหัสงาน" like 'LEDT26%'`).catch(() => {});
    await pg.query("delete from app.cash_flow where iv like 'IV-LEDTEST%'").catch(() => {});
    await pg.query("delete from app.peak_state where key = 'ledger_probe'").catch(() => {});
    try { await rest.close(); } catch (e) { /* ปิดไม่ได้ก็ไม่เป็นไร — ยามจบด้วย process.exit */ }
    await pg.end().catch(() => {});
    FP.restore();
  }
  console.log(`\n${fail ? '❌' : '✅'} ผ่าน ${pass} · ไม่ผ่าน ${fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
