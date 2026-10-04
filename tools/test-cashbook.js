'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  💵 ยาม: Cash Flow ใหม่ (สมุดเงินสดจาก PEAK) — npm run test:cashbook   (รอบ 235 · 4 ต.ค. 69)
 *
 *  พี่เอ: "เดี๋ยวรื้อ code cash flow ใหม่หมดเลยนะ เขียนขึ้นมาใหม่ ทำให้ดูง่าย เห็นสรุปภาพรวม เจาะลงรายละเอียดได้
 *          ไม่ใช่มาอะไรเยอะแยะไปหมดแบบนี้ไม่ดู เสียเวลา"
 *         "พี่ต้องการเห็นยอดเงินในบัญชี ทุกบัญชี ที่เข้าและออกด้วยนะ"  ·  "ดึงจาก peak"
 *
 *  ① อ่านคำตอบของ PEAK (รูปจริงที่เห็นจากเครื่องจริง) — รูปอื่น = บอกว่าอ่านไม่ได้ ไม่เดา
 *  ② ตัวคิดสรุปของเดือน: ยกมา + เข้า − ออก = ยกไป · โอนระหว่างบัญชีไม่นับ · หมวดรวมแล้วเท่ายอดเงินทุกสตางค์
 *  ③ โค้ด — กติกาที่ห้ามพัง (PEAK อ่านอย่างเดียว · ไม่ลบข้อมูล · หน้าจอไม่ยิง PEAK)
 *  ④ ตัวดึง: ดึงครั้งแรก · รอบถัดไปไม่ยิงซ้ำ · บัญชีแก้ใน PEAK ⇒ ดึงเฉพาะรหัสที่เปลี่ยน · PEAK ส่งไม่ครบ/ปฏิเสธ ⇒ บอกตรง ๆ
 *  ⑤ ตัวจัดข้อมูลให้หน้าจอ: รวมบริษัท (ตัดรายการระหว่างกัน) · หมวด · ช่องทางขาย · เอกสาร · สมุดรายบัญชี
 *  ⑥ เซิร์ฟเวอร์จริง: สิทธิ์ (ผู้ดูแลระบบเท่านั้น) · เส้นทาง
 *  ⑦ Management Report ใช้ตัวเลขชุดเดียวกัน
 *  ⑧ หน้าจอจริง (Chromium)   SHOT=<ไฟล์> ทั้งหน้า · SHOT_DOCS=<ไฟล์> ลิ้นชักเอกสาร · SHOT_ACCT=<ไฟล์> สมุดบัญชี · SHOT_OLD=<ไฟล์> หน้าเดิม
 *     APP_DIR=<โฟลเดอร์รุ่นก่อน> + ONLY_SHOT=1 + SHOT_BEFORE=<ไฟล์> ⇒ เก็บภาพหน้า Cash Flow รุ่นก่อน
 *  🔒 ไม่ยิง PEAK จริง (tools/fake-peak-books.js · รูปคำตอบจริง · ข้อมูลจำลอง)
 *  ‼ พอร์ต 55997 / 55998 — ไล่เช็ค tools/*.js แล้วว่าไม่ชนกับใคร
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 55997, APP_PORT = 55998;
const APP_DIR = process.env.APP_DIR || ROOT;
const ONLY_SHOT = !!process.env.ONLY_SHOT;
process.env.SUPABASE_URL = `http://127.0.0.1:${REST_PORT}`;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const KEYS = { PEAK_MODNGAN_ID: 'test_connect_id', PEAK_MODNGAN_KEY: 'test-connect-key-m', PEAK_MODNGAN_APP: 'TESTAPP01',
  PEAK_MODNGAN_USER: 'test-user-token-m', PEAK_THE101_ID: 'test_connect_101', PEAK_THE101_KEY: 'test-connect-key-t',
  PEAK_THE101_APP: 'TESTAPP02', PEAK_THE101_USER: 'test-user-token-t' };
Object.assign(process.env, KEYS, { CASHBOOK_FROM: '2026-07', CASHBOOK_AUTO: '0' });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cbk-'));
const CTL = path.join(TMP, 'ctl.json'), LOG = path.join(TMP, 'peak.log');
process.env.FAKE_BOOKS_CTL = CTL; process.env.FAKE_BOOKS_LOG = LOG;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const near = (a, b) => Math.abs(a - b) < 0.011;
const peakLog = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x)); } catch (e) { return []; } };
const resetLog = () => { try { fs.writeFileSync(LOG, ''); } catch (e) { /* ยังไม่มีไฟล์ */ } };
const M = 'มดงานการป้าย', T = 'The 101';

(async () => {
  console.log('\n💵 Cash Flow ใหม่ — สมุดเงินสดจาก PEAK\n');
  const { Client } = require('pg');
  const pg = new Client({ connectionString: PG });
  await pg.connect();
  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  let app = null, browser = null;
  const wipe = () => pg.query('truncate app.peak_ledger_month, app.peak_ledger_acct, app.peak_cashbook');
  try {
    if (!ONLY_SHOT) {
      await pg.query(read('sql/113-peak-cashbook.sql'));
      await pg.query(read('sql/113-peak-cashbook.sql'));
      await wipe();
      const F = require('./fake-peak-books');
      F.set({ mode: 'subs', extra: [] });
      const C = require('../core/peak-cashbook');
      const X = C._t;
      const S = require('../modules/sales/cashbook');

      /* ══════════════ ① อ่านคำตอบของ PEAK ══════════════ */
      head('① อ่านคำตอบของ PEAK — รูปจริง (เห็นจากเครื่องจริง 4 ต.ค. 69)');
      const tbJ = { PeakTrialBalance: { resCode: '200', resDesc: 'Success', trialBalanceAccount: [
        { account: { accountCode: '111201', accountName: 'ธนาคาร - บัญชีกระแสรายวัน', subAccountCode: '', subAccountName: '', isSubAccount: false },
          beginningBalance: { debit: 2820.94, credit: 0 }, change: { debit: 2300000, credit: 158180.9 }, endingBalance: { debit: 2144640.04, credit: 0 } },
        { account: { accountCode: '212101', accountName: 'เจ้าหนี้การค้า', subAccountCode: '', subAccountName: '', isSubAccount: false },
          beginningBalance: { debit: 0, credit: 175000 }, change: { debit: 0, credit: 0 }, endingBalance: { debit: 0, credit: 175000 } }] } };
      const tb = X.parseTb(tbJ);
      ok(tb.ok && tb.rows.length === 2 && tb.rows[0].code === '111201' && tb.rows[0].cd === 2300000 && tb.rows[0].cc === 158180.9 && tb.rows[0].ed === 2144640.04 && tb.rows[1].bc === 175000,
         'งบทดลอง: รหัส · ยกมา · เคลื่อนไหว · ยกไป (เดบิต/เครดิต) อ่านได้ตรง');
      ok(!X.parseTb({ PeakTrialBalance: { resCode: '200', accounts: [] } }).ok && !X.parseTb({ resCode: '402', resDesc: 'Permission denied' }).ok && !X.parseTb(null).ok,
         '🔴 งบทดลองรูปอื่น / ไม่มีสิทธิ์ / ว่าง ⇒ บอกว่าอ่านไม่ได้ (ไม่เดาชื่อช่อง)');
      ok(!X.parseTb({ PeakTrialBalance: { resCode: '200', trialBalanceAccount: [{ account: { accountCode: '111201' } }] } }).ok, '🔴 แถวงบทดลองไม่มียอดเคลื่อนไหว ⇒ ไม่รับ');
      const glJ = { PeakGeneralLedger: { resCode: '200', fromDate: '20260901', toDate: '20260930', generalLedgers: [{
        account: { accountCode: '111301', accountName: 'ธนาคาร - บัญชีออมทรัพย์', isSubAccount: false },
        summary: { beginningBalance: { debit: 975578.06, credit: 0 }, change: { debit: 582.4, credit: 100000 }, endingBalance: { debit: 976160.46, credit: 100000 } },
        transactions: [{ date: '20260901', journalNumber: 'RV-202609001', description: 'ธนาคาร - บัญชีออมทรัพย์ - มดงานการป้าย - 000-2-00002-2 - BSV001 - บริษัท ทดสอบซี จำกัด - #IV-2026090100003', debit: 582.4, credit: 0 },
                       { date: '20260901', journalNumber: 'JVFN-202609001', description: 'ธนาคาร - บัญชีออมทรัพย์ - มดงานการป้าย - 000-2-00002-2 - BSV001', debit: 0, credit: 100000 }],
        totalTransactions: 2 }] } };
      const gl = X.parseGl(glJ, '111301');
      ok(gl.ok && gl.lines.length === 2 && gl.total === 2 && gl.lines[0].j === 'RV-202609001' && gl.lines[0].dr === 582.4 && gl.lines[1].cr === 100000 && gl.cd === 582.4 && gl.cc === 100000,
         'บัญชีแยกประเภท: วันที่ · เลขสมุดรายวัน · คำอธิบาย · เดบิต · เครดิต + จำนวนบรรทัดที่ PEAK บอก');
      ok(!X.parseGl(glJ, '999999').ok && !X.parseGl({ PeakGeneralLedger: { resCode: '200', accounts: [] } }, '111301').ok, '🔴 คำตอบไม่มีรหัสที่ขอ / รูปอื่น ⇒ ไม่รับ');
      ok(X.parseGl({ PeakGeneralLedger: { resCode: '200', generalLedgers: [] } }, '111301').lines.length === 0, 'ไม่มีรายการในช่วงนั้น ⇒ 0 บรรทัด (ไม่ใช่ข้อผิดพลาด)');
      const li = X.cashLineInfo(glJ.PeakGeneralLedger.generalLedgers[0].transactions[0].description, 'ธนาคาร - บัญชีออมทรัพย์', null);
      ok(li.sub === 'BSV001' && li.cp === 'บริษัท ทดสอบซี จำกัด' && li.ref === 'IV-2026090100003' && /000-2-00002-2/.test(li.subName), 'บรรทัดธนาคารจากเอกสาร: บัญชีย่อย · คู่ค้า · เลขเอกสาร');
      const lj = X.cashLineInfo('ธนาคาร - บัญชีกระแสรายวัน - BCA001 - ธ.ทดสอบสาม กระแสรายวัน - 000-3-00003-3 เดอะ 101 (เงินสดย่อย) - ADV004 - ทดสอบ', 'ธนาคาร - บัญชีกระแสรายวัน', null);
      ok(lj.sub === 'BCA001' && lj.fmt === 'jv' && /ธ.ทดสอบสาม/.test(lj.subName) && lj.cp === 'ADV004 - ทดสอบ' && lj.ref === '', 'บรรทัดธนาคารจากสมุดรายวัน: รหัสบัญชีย่อยมาก่อนชื่อธนาคาร');
      ok(X.cashLineInfo('เงินสด - บริษัท ทดสอบ จำกัด - #IV-1', 'เงินสด', null).sub === '' && X.refOf('x - #EXP-69090100001') === 'EXP-69090100001' && X.refOf('ไม่มีเลข') === '', 'ไม่มีบัญชีย่อย/ไม่มีเลขเอกสาร ⇒ ว่าง (ไม่เดา)');
      ok(C.isCash('111101') && C.isCash('111201') && C.isCash('111301') && C.isCash('111401') && C.isCash('111501') && C.isCash('112101')
         && !C.isCash('113101') && !C.isCash('112201') && !C.isCash('212101') && !C.isCash('1113011'), 'บัญชีเงินสด/ธนาคาร = 1111–1115 + ฝากประจำ 1121 เท่านั้น');

      /* ══════════════ ② ตัวคิดสรุปของเดือน ══════════════ */
      head('② ตัวคิดสรุปของเดือน (ฟังก์ชันล้วน)');
      const A1 = X.allocate('out', 1040, [{ code: '530201', dr: 1000, cr: 0 }, { code: '115401', dr: 70, cr: 0 }, { code: '215204', dr: 0, cr: 30 }]);
      ok(A1.length === 1 && A1[0].a === '530201' && A1[0].amt === 1040, 'จ่าย 1,040 (ค่าใช้จ่าย 1,000 + ภาษีซื้อ 70 − หัก ณ ที่จ่าย 30) ⇒ ลงหมวดค่าใช้จ่ายทั้ง 1,040 (ภาษีไม่ตั้งเป็นหมวด)');
      const A2 = X.allocate('out', 128842.1, [{ code: '530201', dr: 84210.52, cr: 0 }, { code: '530203', dr: 42105.26, cr: 0 }, { code: '115401', dr: 8842.11, cr: 0 }, { code: '215204', dr: 0, cr: 6315.79 }]);
      ok(A2.length === 2 && near(A2[0].amt + A2[1].amt, 128842.1) && near(A2[0].amt / A2[1].amt, 2), 'บิลเดียว 2 หมวด ⇒ แบ่งตามสัดส่วน รวมแล้วเท่ายอดจ่ายทุกสตางค์');
      const A3 = X.allocate('out', 5000, [{ code: '215351', dr: 5000, cr: 0 }]);
      ok(A3.length === 1 && A3[0].a === '215351', 'จ่ายภาษีอย่างเดียว ⇒ หมวดคือบัญชีภาษีนั้น');
      ok(X.allocate('in', 582.4, [{ code: '113101', dr: 0, cr: 599.2 }, { code: '115403', dr: 16.8, cr: 0 }])[0].a === '113101' && X.allocate('in', 500, [])[0].a === '', 'เงินเข้า: ที่มา = บัญชีคู่ฝั่งเครดิต · ไม่มีบัญชีคู่ = "ยังจัดหมวดไม่ได้"');

      const monthOf = (b, biz, ym, prevYms, mut) => {
        const t = X.parseTb({ PeakTrialBalance: { resCode: '200', trialBalanceAccount: F.tbOf(b, ym, false).rows } });
        const sb = X.parseTb({ PeakTrialBalance: { resCode: '200', trialBalanceAccount: F.tbOf(b, ym, true).rows } });
        let accts = t.rows.filter(r => r.cd || r.cc).map(r => ({ code: r.code, name: r.name, ok: true, lines: X.parseGl({ PeakGeneralLedger: { resCode: '200', generalLedgers: [F.glOf(b, ym, r.code)] } }, r.code).lines }));
        if (mut) accts = mut(accts);
        const prev = [];
        (prevYms || []).forEach(p => X.parseTb({ PeakTrialBalance: { resCode: '200', trialBalanceAccount: F.tbOf(b, p, false).rows } }).rows
          .filter(r => /^(5|12|114|1151)/.test(r.code) && (r.cd || r.cc)).forEach(r => prev.push({ code: r.code, lines: X.parseGl({ PeakGeneralLedger: { resCode: '200', generalLedgers: [F.glOf(b, p, r.code)] } }, r.code).lines })));
        return X.buildMonth({ biz, ym, tb: t.rows, subs: X.subsOf(t.rows, sb.rows.filter(r => r.isSub || r.sub)), accts, prev });
      };
      const BM = monthOf('M', M, '2026-09', ['2026-08', '2026-07']), hm = BM.head;
      const BT = monthOf('T', T, '2026-09', ['2026-08', '2026-07']), ht = BT.head;
      ok(hm.in === 152725.9 && hm.out === 150067 && hm.xfer === 100000, 'มดงานการป้าย ก.ย.: เข้า 152,725.90 · ออก 150,067.00 · โอนระหว่างบัญชี 100,000 ไม่นับ');
      ok(near(hm.beg + hm.in - hm.out, hm.end) && near(ht.beg + ht.in - ht.out, ht.end) && hm.verify.ok && ht.verify.ok && hm.verify.cats && ht.verify.cats,
         '🔴 ยอดยกมา + เข้า − ออก = ยอดยกไป ทั้ง 2 กิจการ (ตรวจกับงบทดลอง)');
      ok(hm.accounts.every(a => near(a.beg + a.in - a.out, a.end) && a.ok) && ht.accounts.every(a => near(a.beg + a.in - a.out, a.end) && a.ok), '   ทุกบัญชี: ยกมา + เข้า − ออก = คงเหลือ');
      const sv = hm.accounts.find(a => a.code === '111301'), ca = hm.accounts.find(a => a.code === '111201');
      ok(sv.out === 130000 && sv.xout === 100000 && ca.in === 100000 && ca.xin === 100000, '   รายบัญชีเห็นยอดเดินบัญชีจริง (ออมทรัพย์ออก 130,000 ในนี้เป็นโอนไปกระแสรายวัน 100,000)');
      const tca = ht.accounts.find(a => a.code === '111201');
      ok(tca.subs.length === 2 && tca.subBal === 'tb' && tca.subs[0].code === 'BCA001' && tca.subs[0].end === 67000 && tca.subs[1].code === 'BCA002' && tca.subs[1].in === 51000 && tca.subs[1].end === 151000,
         'The 101: รหัสกระแสรายวันมี 2 บัญชีย่อย — แยกเข้า/ออก/คงเหลือได้รายบัญชี');
      ok(ht.xfer === 182992.08 && ht.accounts.find(a => a.code === '111401').end === 0, 'เช็ครับแล้วนำฝาก = โอนระหว่างบัญชี ไม่ถูกนับเป็นเงินเข้าซ้ำ');
      const dAp = BT.docs.find(d => d.j === 'PV-202609006'), dMix = BT.docs.find(d => d.j === 'PV-202609010');
      ok(dAp.via === 'ap' && dAp.cats.length === 1 && dAp.cats[0].a === '510101' && dAp.cats[0].amt === 48043, '🔴 จ่ายบิลที่ตั้งเจ้าหนี้ไว้เดือนก่อน ⇒ ตามเลขเอกสารไปได้หมวดจริง (ต้นทุนผลิต) ไม่ค้างที่ "เจ้าหนี้การค้า"');
      ok(dMix.cats.length === 2 && near(dMix.cats.reduce((s, c) => s + c.amt, 0), dMix.amt), '   เอกสาร 2 หมวด: ยอดในหมวดรวมกันเท่ายอดจ่าย');
      ok(BM.docs.every(d => d.k === 'x' || near(d.cats.reduce((s, c) => s + c.amt, 0), d.amt)) && BT.docs.every(d => d.k === 'x' || near(d.cats.reduce((s, c) => s + c.amt, 0), d.amt)),
         '🔴 ทุกเอกสาร: ยอดที่ลงหมวดรวมกัน = ยอดเงินของเอกสารทุกสตางค์');
      const sumCats = h => Math.round(h.outCats.reduce((s, c) => s + c.amt, 0) * 100) / 100;
      ok(near(sumCats(hm), hm.out) && near(sumCats(ht), ht.out) && near(hm.inCats.reduce((s, c) => s + c.amt, 0), hm.in), '   ผลรวมทุกหมวด = เงินออก / เงินเข้า ของเดือน');
      const dJv = BM.docs.find(d => d.j === 'JV-202609550'), dPay = BM.docs.find(d => d.j === 'JV-202609600');
      ok(dJv && dJv.k === 'out' && dJv.amt === 39 && dJv.cats[0].a === '530501' && dPay.amt === 46500 && dPay.cats[0].a === '530101',
         '🔴 รายการที่บัญชีลงตรงรหัสผังบัญชี (สมุดรายวัน JV · ไม่มีเอกสาร EXP) ถูกนับเป็นเงินออก: ค่าธรรมเนียม 39 · เงินเดือน 46,500');
      ok(!BM.docs.some(d => /^JVDP/.test(d.j)) && !hm.outCats.some(c => c.a === '530706'), '🔴 ค่าเสื่อมราคา (ไม่ใช่เงินออกจริง) ไม่ถูกนับ');
      ok(hm.icOut === 30000 && BM.docs.find(d => d.j === 'PV-202609002').ic === 1 && ht.icIn === 30000 && BT.docs.find(d => d.j === 'RV-202609001').ic === 1,
         'รายการระหว่าง 2 บริษัท ถูกติดป้าย (มดงานจ่าย 30,000 = The 101 รับ 30,000)');
      const broken = monthOf('M', M, '2026-09', [], a => a.filter(x => x.code !== '111301'));
      ok(!broken.head.verify.ok && !broken.ok && broken.head.accounts.find(a => a.code === '111301').ok === false && broken.head.verify.issues.length > 0,
         '🔴 ดึงบัญชีออมทรัพย์ไม่ได้ ⇒ เดือนนั้นติดป้ายว่ายังไม่ตรงกับงบทดลอง (ไม่ขึ้นว่าตรวจแล้ว)');
      const noCat = monthOf('M', M, '2026-09', [], a => a.filter(x => x.code !== '530101'));
      ok(noCat.head.verify.ok && !noCat.head.verify.cats && noCat.docs.find(d => d.j === 'JV-202609600').q === 1,
         '   ดึงบัญชีค่าใช้จ่ายไม่ครบ ⇒ ยอดเงินยังถูก แต่ติดป้ายว่าหมวดยังไม่ครบ');
      const subsBad = X.subsOf(X.parseTb({ PeakTrialBalance: { resCode: '200', trialBalanceAccount: F.tbOf('T', '2026-09', false).rows } }).rows,
        X.parseTb({ PeakTrialBalance: { resCode: '200', trialBalanceAccount: F.tbOf('T', '2026-09', 'bad').rows } }).rows.filter(r => r.isSub));
      ok(Object.keys(subsBad).length === 0, '🔒 งบทดลองแยกบัญชีย่อยที่รวมแล้วไม่เท่าบัญชีแม่ ⇒ ไม่ใช้ (ถอยไปแสดงระดับรหัสบัญชี)');

      /* ══════════════ ③ โค้ด ══════════════ */
      head('③ โค้ด — กติกาที่ห้ามพัง');
      const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
      const core = strip(read('core/peak-cashbook.js')), rep = strip(read('modules/sales/cashbook.js')), ui = strip(read('modules/sales/public/cashbook.js'));
      ok(/peak\.getOnce\(/.test(core) && !/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(core) && !/\bfetch\s*\(/.test(core),
         '🔒 ตัวดึงคุย PEAK ผ่าน core/peak.js เท่านั้น (getOnce/get = GET) — ไม่ยิงเน็ตเอง ไม่มีคำสั่งเขียน');
      const peak = require('../core/peak');
      let allowed = true; for (const ep of [C.EP.tb, C.EP.gl, C.EP.conn]) { try { await peak.getOnce(ep + '?x=1', {}, M); allowed = false; } catch (e) { if (!/READ-ONLY/.test(e.message)) allowed = false; } }
      ok(allowed && !/db\.remove\(/.test(core) && !/db\.remove\(/.test(rep), '🔒 ชื่อเส้นทางผ่านด่านอ่านอย่างเดียวของ core/peak.js · ไม่มีคำสั่งลบข้อมูลในฐาน');
      ok(!/peak\.get(Once)?\(/.test(rep) && !/\.tick\(/.test(rep) && !/syncMonth/.test(rep), '🔒 ตัวจัดข้อมูลให้หน้าจอไม่ยิง PEAK (อ่านจากฐานอย่างเดียว)');
      ok(!/localStorage|sessionStorage/.test(ui) && /api\/cashbook/.test(ui) && !/peakaccount/.test(ui), 'หน้าจอเรียกเฉพาะเส้นทางของเรา');
      const idx = read('modules/sales/public/index.html');
      ok(/cash:\s*\(\)\s*=>\s*\{[^}]*openCashbook\(\)/.test(idx) && /function openCashFlow\(\)/.test(idx) && /function cfHtml\(/.test(idx) && /cfLedProbe/.test(idx),
         'เมนู Cash Flow เปิดหน้าใหม่ · หน้าเดิม + เครื่องมือทั้งหมดยังอยู่ครบ (ไม่ได้ลบ)');
      ok(!/<script[^>]+cashbook\.js/.test(idx), '⚡ ไฟล์หน้าใหม่ไม่ถูกโหลดตอนเปิดแอป — โหลดตอนกดเมนูเท่านั้น');
      const sidx = read('modules/sales/index.js');
      const routes = ['/api/cashbook', '/api/cashbook/docs', '/api/cashbook/ar', '/api/cashbook/status'];
      ok(routes.every(r => sidx.indexOf("router.get('" + r + "', cbTry(") > 0) && /const cbTry = fn => async \(req, res\) => \{\s*if \(!isAdmin\(req\)\) return denyCf\(req, res\);/.test(sidx)
         && /router\.post\('\/api\/cashbook\/sync', async \(req, res\) => \{\s*if \(!isAdmin\(req\)\) return denyAdmin\(res\);/.test(sidx), '🔒 ทุกเส้นทางของ Cash Flow ใหม่ผ่านด่านผู้ดูแลระบบ');
      const sql = strip(read('sql/113-peak-cashbook.sql').replace(/--[^\n]*/g, ''));
      ok(!/\bdrop\b|\bdelete\b|\btruncate\b|alter table/i.test(sql) && (sql.match(/create table if not exists/g) || []).length === 3, 'sql/113: สร้าง 3 ตารางใหม่ (ถ้ายังไม่มี) · ไม่แตะตารางเดิม ไม่ลบอะไร');

      /* ══════════════ ④ ตัวดึง ══════════════ */
      head('④ ตัวดึงเบื้องหลัง');
      resetLog();
      const t1 = await C.tick();
      const L1 = peakLog();
      const mrows = (await pg.query('select biz, ym, pending, err, full_at from app.peak_ledger_month order by 1,2')).rows;
      ok(t1.ok && !t1.errors.length && mrows.length === 2 * C.ymList('2026-07', C.ymNow()).length && mrows.every(r => r.pending === 0 && !r.err && r.full_at),
         `ดึงครั้งแรก: ${mrows.length} เดือน-กิจการ ครบ ไม่มีค้าง (${t1.sent} คำขอ)`);
      ok(L1.every(x => x.m === 'GET' || /ClientToken/i.test(x.name)) && L1.filter(x => x.m === 'GET').every(x => /^(FinancialReports\/(trialbalance|generalledger)|Receipts)$/.test(x.name)),
         '🔒 ทุกคำขอไป PEAK เป็น GET · เฉพาะงบทดลอง + บัญชีแยกประเภท');
      const books = (await pg.query('select biz, ym, ok, head from app.peak_cashbook order by 1,2')).rows;
      ok(books.length === mrows.length && books.every(b => b.ok && b.head.verify.ok && b.head.verify.cats), 'ทุกเดือนคิดสรุปแล้ว และตรวจกับงบทดลองผ่าน');
      const bT9 = books.find(b => b.biz === T && b.ym === '2026-09');
      ok(bT9.head.in === 214450.08 && bT9.head.out === 211712.45 && bT9.head.outCats.find(c => c.a === '510101').amt === 58398.46 && !bT9.head.outCats.some(c => c.a === '212101'),
         '🔴 ดึงย้อนหลังจากเดือนใหม่ไปเก่า แต่บิลที่ตั้งเจ้าหนี้ไว้ ส.ค. ยังถูกตามเจอ (ต้นทุนผลิต 58,398.46 · ไม่มีก้อน "เจ้าหนี้การค้า")');
      resetLog();
      const t2 = await C.tick();
      ok(t2.ok && t2.sent === 0 && peakLog().length === 0, '⚡ รอบถัดไปทันที: ไม่ยิง PEAK เลย (ยังไม่ถึงเวลาถามใหม่)');
      /* บัญชีลงรายการใหม่ใน PEAK (ก.ย.) ⇒ ครบชั่วโมงแล้วถามงบทดลองใหม่ ดึงเฉพาะรหัสที่ยอดเปลี่ยน */
      F.set({ mode: 'subs', extra: [{ biz: 'M', ym: '2026-09', no: 'JV-202609999', dd: '29',
        lines: [F.L('530501', 'ค่าธรรมเนียมธนาคาร', 15, 0), F.jvLine('M', '111201', 'BCA001', 0, 15)] }] });
      resetLog();
      const later = Date.now() + 61 * 60000;
      const t3 = await C.tick({ now: later });
      const L3 = peakLog();
      const glM9 = L3.filter(x => x.b === 'M' && x.name === 'FinancialReports/generalledger' && /fromDate=20260901/.test(x.q)).map(x => (x.q.match(/accountCode=(\d+)/) || [])[1]).sort();
      ok(t3.ok && glM9.join() === '111201,530501', '⚡ บัญชีลงเพิ่ม 1 ใบ (ก.ย.) ⇒ ดึงบัญชีแยกประเภทใหม่เฉพาะ 2 รหัสที่ยอดเปลี่ยน (' + glM9.join(' · ') + ')');
      const after = (await pg.query("select head from app.peak_cashbook where biz = $1 and ym = '2026-09'", [M])).rows[0].head;
      ok(after.out === 150082 && after.verify.ok && after.outCats.find(c => c.a === '530501').amt === 54, '   ตัวเลขเดือนนั้นอัปเดตตาม: เงินออก 150,082 · ค่าธรรมเนียม 54');
      const oct = (await pg.query("select head from app.peak_cashbook where biz = $1 and ym = '2026-10'", [M])).rows[0].head;
      ok(near(oct.beg, after.end), '   ยอดยกมาของเดือนถัดไป = ยอดคงเหลือของเดือนที่แก้ (ตามงบทดลองใหม่)');
      /* PEAK ส่งรายการมาไม่ครบ */
      F.set({ mode: 'short', extra: [{ biz: 'M', ym: '2026-09', no: 'JV-202609999', dd: '29', lines: [F.L('530501', 'ค่าธรรมเนียมธนาคาร', 15, 0), F.jvLine('M', '111201', 'BCA001', 0, 15)] }] });
      const t4 = await C.tick({ only: { biz: M, ym: '2026-09' }, force: true });
      const sh = (await pg.query("select ok, head from app.peak_cashbook where biz = $1 and ym = '2026-09'", [M])).rows[0];
      const badAcct = (await pg.query("select count(*)::int n from app.peak_ledger_acct where biz = $1 and ym = '2026-09' and not ok", [M])).rows[0].n;
      ok(t4.ok && sh.ok === false && !sh.head.verify.ok && badAcct > 0 && sh.head.verify.issues.length > 0,
         '🔴 PEAK ส่งรายการเดินบัญชีมาไม่ครบ ⇒ เดือนนั้นขึ้น "ยังไม่ตรงกับงบทดลอง" (' + badAcct + ' รหัส) ไม่แสดงว่าตรวจผ่าน');
      /* PEAK ปฏิเสธ ⇒ ของเดิมยังอยู่ + จดเหตุผล */
      F.set({ mode: 'denied', extra: [] });
      const before = (await pg.query('select count(*)::int n from app.peak_cashbook')).rows[0].n;
      const t5 = await C.tick({ only: { biz: T, ym: '2026-09' }, force: true });
      const st5 = await C.status();
      ok(t5.errors.length === 1 && /403/.test(t5.errors[0].err) && (await pg.query('select count(*)::int n from app.peak_cashbook')).rows[0].n === before
         && /403/.test((st5.biz.find(b => b.biz === T) || {}).err || ''), '🔴 PEAK ปฏิเสธ (403) ⇒ จดเหตุผลให้เห็น · ข้อมูลที่ดึงไว้แล้วยังอยู่ครบ');
      F.set({ mode: 'odd', extra: [] });
      const t6 = await C.tick({ only: { biz: T, ym: '2026-09' }, force: true });
      ok(t6.errors.length === 1 && /รูปที่ไม่รู้จัก/.test(t6.errors[0].err), '🔴 PEAK ตอบรูปที่ไม่รู้จัก ⇒ หยุด บอกว่าอ่านไม่ได้ (ไม่เดา)');
      /* กลับมาปกติ + งบคำขอต่อรอบ */
      F.set({ mode: 'subs', extra: [] });
      await wipe();
      const t7 = await C.tick({ maxCalls: 12 });
      const pend = (await pg.query('select coalesce(sum(pending),0)::int n, count(*)::int m from app.peak_ledger_month')).rows[0];
      ok(t7.more === true && t7.sent <= 12 && pend.n > 0, `งบคำขอต่อรอบ: ยิงไม่เกินที่กำหนด (${t7.sent}/12) แล้วพักไว้ต่อรอบหน้า (ค้าง ${pend.n} รหัส)`);
      let guard = 0, tk;
      do { tk = await C.tick({ maxCalls: 60 }); guard++; } while (tk.more && guard < 20);
      const fin = (await pg.query('select count(*)::int n, sum(pending)::int p from app.peak_ledger_month')).rows[0];
      const allOk = (await pg.query('select bool_and(ok) a, count(*)::int n from app.peak_cashbook')).rows[0];
      ok(fin.p === 0 && allOk.a === true && allOk.n === fin.n, `   เดินต่อจนครบ: ${fin.n} เดือน-กิจการ ไม่มีค้าง ทุกเดือนตรวจผ่าน (${guard} รอบ)`);
      F.set({ mode: 'badsubs', extra: [] });
      await C.tick({ only: { biz: T, ym: '2026-09' }, force: true });
      const bs = (await pg.query("select head from app.peak_cashbook where biz = $1 and ym = '2026-09'", [T])).rows[0].head.accounts.find(a => a.code === '111201');
      ok(bs.subBal === 'none' && bs.subs.length === 2 && bs.subs[0].end === null && bs.subs[0].in === 50000 && bs.end === 218000,
         '🔒 PEAK แยกบัญชีย่อยมาไม่ตรง ⇒ ยอดคงเหลือรายบัญชีย่อยไม่แสดง (—) แต่เข้า/ออกรายบัญชีย่อย + ยอดระดับรหัสยังถูก');
      F.set({ mode: 'subs', extra: [] });
      await C.tick({ only: { biz: T, ym: '2026-09' }, force: true });
      const pl = X.plan([{ ym: C.ymNow(), tb_at: new Date().toISOString(), full_at: new Date().toISOString(), pending: 0 }], Date.now());
      ok(!pl.some(j => j.ym === C.ymNow()) && pl.every(j => j.why === 'new') && pl[0].ym === C.ymAdd(C.ymNow(), -1), 'แผนงาน: เดือนที่เพิ่งถาม = ข้าม · เดือนที่ยังไม่มี = ดึง (ใหม่ไปเก่า)');
      ok(C.start() === false, 'เครื่องทดลองไม่เปิดตัวดึงเบื้องหลังเอง (เปิดเองเฉพาะเครื่องจริง หรือ CASHBOOK_AUTO=1)');

      /* ══════════════ ⑤ ตัวจัดข้อมูลให้หน้าจอ ══════════════ */
      head('⑤ ตัวจัดข้อมูลให้หน้าจอ');
      await pg.query('delete from app.total_sales where "_row" >= 990001');
      const SR = (row, iv, src, plat) => pg.query(`insert into app.total_sales ("_row","รหัสงาน","ชื่อบริษัท","Lead Status","ลูกค้ามาจากไหน","ชื่อช่อง / Platform","เลขที่ QO / IV") values ($1,$2,'ทดสอบ','ปิดการขาย',$3,$4,$5)`, [row, 'CBK/' + row, src, plat, iv]);
      await SR(990001, 'IV-2026090100003', 'B2B', 'LINE OA');
      await SR(990002, 'QO-1 / IV-2026062900013', 'สาขามดงาน', 'สาขา_ทดสอบ');
      await SR(990003, 'IV-69090700001', 'Facebook', 'เพจ');
      S._t.resetIx();
      resetLog();
      const O = await S.overview({}, { biz: '', ym: '2026-09' });
      ok(O.ok && peakLog().length === 0, '🔒 เปิดหน้า = อ่านจากฐาน ไม่ยิง PEAK สักคำขอ');
      ok(O.sel.in === 337175.98 && O.sel.out === 331779.45 && O.sel.ic.in === 30000 && O.sel.ic.out === 30000 && near(O.sel.net, 5396.53),
         'รวมทุกบริษัท ก.ย.: เข้า 337,175.98 · ออก 331,779.45 (ตัดเงินที่ 2 บริษัทจ่ายกันเอง 30,000 ออกทั้งสองฝั่ง)');
      ok(near(O.sel.end, hm.end + ht.end) && near(O.sel.beg + (O.sel.in + 30000) - (O.sel.out + 30000), O.sel.end), '   เงินคงเหลือรวม = ผลรวมทุกบัญชีของ 2 บริษัท · ยกมา + เข้า − ออก = คงเหลือ');
      const OM = await S.overview({}, { biz: M, ym: '2026-09' }), OT = await S.overview({}, { biz: T, ym: '2026-09' });
      ok(OM.sel.in === 152725.9 && OM.sel.out === 150067 && OM.sel.ic === null && OT.sel.in === 214450.08, 'ดูรายบริษัท: ไม่ตัดรายการระหว่างกัน (เป็นเงินจริงของบริษัทนั้น)');
      ok(near(OM.sel.in + OT.sel.in - 30000, O.sel.in) && near(OM.sel.out + OT.sel.out - 30000, O.sel.out), '   รวม = มดงาน + The 101 − รายการระหว่างกัน');
      const mo = O.months.find(m => m.ym === '2026-09');
      ok(O.months.length === 12 && mo.in === O.sel.in && mo.out === O.sel.out && mo.ok && O.months[O.months.length - 1].cur, 'ตารางรายเดือน 12 เดือน: ตัวเลขของเดือนตรงกับการ์ดด้านบน');
      ok(O.sel.accounts.length === 8 && O.sel.accounts.filter(a => a.biz === M).length === 3, 'ยอดเงินในบัญชี: ทุกบัญชีของทั้ง 2 บริษัท (มดงาน 3 · The 101 5)');
      const cat = (X2, k) => X2.find(c => c.k === k);
      ok(near(O.sel.outCats.reduce((s, c) => s + c.amt, 0), O.sel.out) && near(O.sel.inCats.reduce((s, c) => s + c.amt, 0), O.sel.in), '🔴 ผลรวมทุกหมวด = ยอดเงินเข้า / เงินออก บนการ์ด');
      ok(cat(O.sel.outCats, 'admin').amt === 175381.1 && cat(O.sel.outCats, 'cogs').amt === 58398.46 && cat(O.sel.outCats, 'pre').amt === 72800 && cat(O.sel.outCats, 'adv').amt === 3000
         && cat(O.sel.outCats, 'loan').amt === 20800 && cat(O.sel.outCats, 'fin').amt === 671.89 && cat(O.sel.outCats, 'refund').amt === 728,
         'หมวดเงินออก: บริหาร · ต้นทุน · จ่ายล่วงหน้า · คืนเงินสำรองจ่าย · ชำระเงินกู้ · ดอกเบี้ย · คืนเงินลูกค้า');
      ok(cat(O.sel.inCats, 'ch:B2B').amt === 582.4 && cat(O.sel.inCats, 'ch:สาขา').amt === 150800 && cat(O.sel.inCats, 'ch:Online').amt === 132992.08
         && cat(O.sel.inCats, 'ch:' + S.CH_NONE).amt === 1801.5 && cat(O.sel.inCats, 'loan').amt === 51000 && cat(O.sel.inCats, 'oinc') === undefined,
         'หมวดเงินเข้า: แยกช่องทางขายตามเลขบิลในตารางขาย (B2B · สาขา · Online) · หาไม่เจอ = บอกว่าไม่พบ ไม่เดา');
      const D1 = await S.docs({}, { biz: '', ym: '2026-09', side: 'out', cat: 'cogs' });
      ok(D1.ok && D1.n === 2 && near(D1.total, 58398.46) && D1.rows.some(r => r.via === 'ap' && r.j === 'PV-202609006') && D1.rows.every(r => r.biz === T), 'กดหมวด "ต้นทุน" ⇒ เอกสาร 2 ใบ รวม = ยอดของหมวด');
      let allMatch = true;
      for (const side of ['in', 'out']) for (const c of (side === 'in' ? O.sel.inCats : O.sel.outCats)) {
        const D = await S.docs({}, { biz: '', ym: '2026-09', side, cat: c.k });
        if (!near(D.total, c.amt) || D.n !== c.n) { allMatch = false; console.log('     ⚠', side, c.k, c.amt, D.total, c.n, D.n); }
      }
      ok(allMatch, '🔴 ทุกหมวด: เอกสารที่กดเข้าไปดู รวมแล้ว = ยอดของหมวดนั้น และจำนวนเอกสารตรง');
      const Dic = await S.docs({}, { biz: '', ym: '2026-09', side: 'in', cat: 'ic' }), Dx = await S.docs({}, { biz: '', ym: '2026-09', side: 'x' });
      ok(Dic.n === 1 && Dic.total === 30000 && Dx.n === 3 && near(Dx.total, 282992.08), 'ดูรายการระหว่าง 2 บริษัท / โอนระหว่างบัญชี ได้');
      const Da = await S.docs({}, { biz: '', ym: '2026-09', acct: '111301', sub: 'BSV001', abiz: T });
      const aT = OT.sel.accounts.find(a => a.code === '111301');
      ok(Da.n === 7 && near(Da.in, aT.in) && near(Da.out, aT.out) && Da.rows.some(r => /โอนระหว่างบัญชี/.test(r.cat)), '🔴 กดที่บัญชี ⇒ สมุดเดินบัญชี: รวมเข้า/ออก = ยอดของบัญชีบนหน้าแรก (รวมรายการโอน)');
      const Da2 = await S.docs({}, { biz: T, ym: '2026-09', acct: '111201', sub: 'BCA002', abiz: T });
      ok(Da2.n === 1 && Da2.in === 51000, '   เลือกบัญชีย่อย ⇒ เฉพาะรายการของบัญชีย่อยนั้น');
      ok((await S.docs({}, { ym: 'x' })).ok === false, '   ไม่ระบุเดือน ⇒ ปฏิเสธ');
      const MT = await S.monthTotals('2026-07', '2026-10');
      ok(MT['2026-09'].in === O.sel.in && MT['2026-09'].out === O.sel.out && MT['2026-09'].full && MT['2026-09'].biz[M].out === 150067, 'ยอดรายเดือนสำหรับ Management Report = ชุดเดียวกับหน้า Cash Flow');
      ok(S.groupOf('out', '510101')[0] === 'cogs' && S.groupOf('out', '212203')[0] === 'adv' && S.groupOf('out', '212101')[0] === 'ap' && S.groupOf('out', '215351')[0] === 'tax'
         && S.groupOf('in', '113101')[0] === 'cust' && S.groupOf('in', '212203')[0] === 'loan' && S.groupOf('out', '')[0] === 'unk', 'ตารางหมวด: รหัสบัญชี → หมวดที่อ่านง่าย');
    }

    /* ══════════════ ⑥ เซิร์ฟเวอร์จริง ══════════════ */
    head('⑥ เซิร์ฟเวอร์จริง');
    fs.writeFileSync(CTL, JSON.stringify({ mode: 'subs', extra: [] }));
    const hash = require('bcryptjs').hashSync('test1234', 10);
    await pg.query(`insert into app.app_users ("Username","Nickname","Name","Permission","PasswordHash","Status")
       values ('cbboss','พี่เอ','Panusphong','Administrator',$1,'Login'), ('cbsale','ส้ม','(ส้ม) สมหญิง','Sale',$1,'Login')
       on conflict (lower("Username")) do update set "PasswordHash" = excluded."PasswordHash",
         "Permission" = excluded."Permission", "Nickname" = excluded."Nickname", "Name" = excluded."Name", "Status" = 'Login'`, [hash]);
    if (fs.existsSync(path.join(ROOT, 'sql', '109-mgmt-report.sql'))) await pg.query(read('sql/109-mgmt-report.sql'));
    const env = Object.assign({}, process.env, KEYS, { SUPABASE_URL: `http://127.0.0.1:${REST_PORT}`, SUPABASE_KEY: 'test-key',
      SESSION_SECRET: 'a'.repeat(64), NODE_ENV: 'development', PORT: String(APP_PORT), SYNC_ON_BOOT: '0', SYNC_EVERY_MIN: '0',
      CASHBOOK_FROM: '2026-07', CASHBOOK_AUTO: '0', FAKE_BOOKS_CTL: CTL, FAKE_BOOKS_LOG: LOG,
      NODE_OPTIONS: '--require ' + path.join(__dirname, 'fake-peak-books.js') });
    app = spawn('node', [path.join(APP_DIR, 'server.js')], { env, stdio: 'pipe', cwd: APP_DIR });
    let booted = false, errOut = '';
    app.stdout.on('data', d => { if (String(d).includes('พอร์ต')) booted = true; });
    app.stderr.on('data', d => { errOut += String(d); });
    for (let i = 0; i < 150 && !booted; i++) await sleep(200);
    const base = `http://127.0.0.1:${APP_PORT}`;
    const login = async who => {
      const r = await fetch(base + '/api/login', { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: who, password: 'test1234' }) });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      return sc.map(s => s.split(';')[0]).join('; ');
    };
    const boss = await login('cbboss'), sale = await login('cbsale');
    const req = async (m, u, c, body) => { const r = await fetch(base + u, { method: m, headers: Object.assign(c ? { cookie: c } : {}, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
      let t = ''; try { t = await r.text(); } catch (e) { /* ว่าง */ } let j = null; try { j = JSON.parse(t); } catch (e) { /* ไม่ใช่ JSON */ } return { s: r.status, j, t }; };
    if (!ONLY_SHOT) {
      for (const [m, u] of [['GET', '/m/sales/api/cashbook'], ['GET', '/m/sales/api/cashbook/docs?ym=2026-09&side=out'], ['GET', '/m/sales/api/cashbook/ar'], ['GET', '/m/sales/api/cashbook/status'], ['POST', '/m/sales/api/cashbook/sync']]) {
        const a = await req(m, u, sale, m === 'POST' ? {} : null), n = await req(m, u, '', m === 'POST' ? {} : null);
        ok(a.s === 403 && n.s !== 200 && !(a.j && a.j.months) && a.t.indexOf('ทดสอบ') < 0, `🔴 ${m} ${u.split('?')[0].replace('/m/sales', '')}: เซลส์ 403 · ไม่ได้ล็อกอิน ${n.s}`);
      }
      resetLog();
      const sy = await req('POST', '/m/sales/api/cashbook/sync', boss, { wait: 1 });
      ok(sy.s === 200 && sy.j.ok && !sy.j.errors.length, 'ผู้ดูแลระบบสั่งดึงจาก PEAK ได้ (' + sy.j.sent + ' คำขอ)');
      resetLog();
      const t0 = Date.now();
      const ov = await req('GET', '/m/sales/api/cashbook?biz=&ym=2026-09', boss);
      const ms = Date.now() - t0;
      ok(ov.s === 200 && ov.j.ok && ov.j.sel.in === 337175.98 && ov.j.sel.accounts.length === 8 && peakLog().length === 0, `⚡ เปิดหน้า: ${ms} ms · ไม่ยิง PEAK · ตัวเลขตรงกับตัวคิด`);
      const dc = await req('GET', '/m/sales/api/cashbook/docs?biz=&ym=2026-09&side=out&cat=admin', boss);
      ok(dc.s === 200 && dc.j.n === 3 && near(dc.j.total, 175381.1), 'เส้นเอกสารของหมวดทำงาน');
      const stt = await req('GET', '/m/sales/api/cashbook/status', boss);
      ok(stt.j.ok && stt.j.biz.length === 2 && stt.j.biz.every(b => b.done === b.months && !b.err) && stt.j.auto === false, 'เส้นสถานะ: 2 กิจการ ดึงครบทุกเดือน');
      const arr = await req('GET', '/m/sales/api/cashbook/ar', boss);
      ok(arr.s === 200 && arr.j && (arr.j.ok === true || arr.j.ok === false) && !/stack|at Object/.test(arr.t), 'เส้นลูกหนี้ตอบได้ (ใช้ตัวคิดลูกหนี้เดิม)');

      /* ══════════════ ⑦ Management Report ══════════════ */
      head('⑦ Management Report ใช้ตัวเลขชุดเดียวกัน');
      const hsrc = read('modules/mgmt/health.js'), dsrc = read('modules/mgmt/data.js');
      ok(/monthTotals\(/.test(dsrc) && /m\.cashIn = b\.in; m\.cashOut = b\.out/.test(dsrc) && /srcNote\(cash\)/.test(hsrc) && /BOOK_INFO/.test(hsrc),
         'ก้อน Cashflow ของ Management Report ใช้ยอดจากสมุดเงินสด (modules/sales/cashbook.js monthTotals) เมื่อมีครบทุกบริษัท');
      const cp = await req('GET', '/m/mgmt/api/part/cash?ym=2026-09', boss);
      if (cp.s === 200 && cp.j && cp.j.ok !== false && cp.j.cur) {
        ok(cp.j.book && cp.j.book.cur === true && cp.j.cur.cashIn === 337175.98 && cp.j.cur.cashOut === 331779.45 && cp.j.byBiz[M].out === 150067,
           '🔴 Management Report เดือน ก.ย.: รับเงิน 337,175.98 · จ่ายออก 331,779.45 = หน้า Cash Flow ทุกบาท');
        const hp = await req('GET', '/m/mgmt/api/part/health?ym=2026-09', boss);
        const ct = hp.j && (hp.j.tiles || []).find(t => t.key === 'cash');
        ok(ct && (ct.info || ct.note) && !/EXP เท่านั้น/.test(ct.note || ''), '   การ์ด Cashflow บอกที่มาใหม่ (ไม่ขึ้นคำเตือน "นับจาก EXP เท่านั้น" แล้ว)');
      } else ok(false, 'อ่านก้อน cash ของ Management Report ไม่ได้ (' + cp.s + ') ' + String(cp.t).slice(0, 200));
    } else {
      await req('POST', '/m/sales/api/cashbook/sync', boss, { wait: 1 }).catch(() => null);
    }

    /* ══════════════ ⑧ หน้าจอจริง ══════════════ */
    head('⑧ หน้าจอจริง (Chromium)');
    const { chromium } = require('playwright');
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const FD = '/root/fonts-prompt/package/files/';
    let css = '';
    if (fs.existsSync(FD)) for (const wt of [400, 500, 600, 700, 800]) for (const [sub, rng] of [['thai', 'U+0E01-0E5B,U+200C-200D,U+25CC'], ['latin', 'U+0000-00FF,U+2000-206F,U+20AC,U+2212']]) {
      const f = FD + `prompt-${sub}-${wt}-normal.woff2`;
      if (fs.existsSync(f)) css += `@font-face{font-family:'Prompt';font-weight:${wt};src:url(data:font/woff2;base64,${fs.readFileSync(f).toString('base64')}) format('woff2');unicode-range:${rng}}\n`;
    }
    const ctx = await browser.newContext({ viewport: { width: 1440, height: +process.env.SHOT_H || 1000 } });
    await ctx.addCookies(boss.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: base }; }));
    await ctx.route('**/fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: css }));
    await ctx.route('**/fonts.gstatic.com/**', r => r.abort());
    const p = await ctx.newPage();
    const errs = [], reqs = [];
    p.on('pageerror', e => errs.push(String(e)));
    p.on('request', r => reqs.push(r.url()));
    await p.goto(base + '/m/sales/', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => { try { return typeof MENU_ACT === 'object' && typeof openCashFlow === 'function'; } catch (e) { return false; } }, null, { timeout: 30000 });
    await p.waitForTimeout(1500);
    if (ONLY_SHOT) {
      await p.evaluate(() => { try { MENU_ACT.cash(); } catch (e) { openCashFlow(); } });
      await p.waitForTimeout(6000);
      if (process.env.SHOT_BEFORE) await p.screenshot({ path: process.env.SHOT_BEFORE, fullPage: false });
      if (process.env.SHOT_BEFORE_FULL) {
        const hgt = await p.evaluate(() => { const b = document.querySelector('#cfOv .ov-body'); return b ? b.scrollHeight : 0; });
        await p.evaluate(() => { const o = document.getElementById('cfOv'); if (o) { o.style.position = 'absolute'; o.style.height = 'auto'; const b = o.querySelector('.ov-body'); b.style.overflow = 'visible'; b.style.height = 'auto'; } });
        await p.screenshot({ path: process.env.SHOT_BEFORE_FULL, fullPage: true });
        void hgt;
      }
    } else {
      ok(!reqs.some(u => /cashbook\.js/.test(u)), '⚡ เปิดแอปคีย์ยอดขาย: ยังไม่โหลดไฟล์หน้า Cash Flow ใหม่');
      await p.evaluate(() => MENU_ACT.cash());
      await p.waitForSelector('#cbIn', { timeout: 30000 });
      await p.waitForTimeout(600);
      ok(reqs.some(u => /\/m\/sales\/cashbook\.js/.test(u)) && await p.isVisible('#cbOv') && !(await p.isVisible('#cfOv')), 'กดเมนู Cash Flow ⇒ เปิดหน้าใหม่ (ไม่ใช่หน้าเดิม)');
      /* ตั้งต้น = เดือนล่าสุดที่มีข้อมูล → ไปเดือน ก.ย. */
      await p.evaluate(() => CB.month('2026-09'));
      await p.waitForFunction(() => /337,176/.test((document.getElementById('cbIn') || {}).textContent || ''), null, { timeout: 20000 });
      const tx = async sel => (await p.innerText(sel)).replace(/\s+/g, ' ').trim();
      const C_MONTHS = require('../core/peak-cashbook').ymList('2026-07', require('../core/peak-cashbook').ymNow()).length;
      ok(await tx('#cbIn') === '฿337,176' && await tx('#cbOut') === '฿331,779' && await tx('#cbNet') === '+฿5,397' && /฿6,822,010/.test(await tx('#cbEnd')), 'การ์ดบนสุด: เงินเข้า · เงินออก · สุทธิ · เงินคงเหลือทุกบัญชี');
      const accTxt = await tx('#cbAcct');
      ok(/มดงานการป้าย/.test(accTxt) && /The 101/.test(accTxt) && /ธ\.ทดสอบสอง ออมทรัพย์/.test(accTxt) && /BCA002/.test(accTxt) && /รวมทุกบัญชี/.test(accTxt) && /6,822,010/.test(accTxt),
         'ตารางยอดเงินในบัญชี: ทุกบัญชีของทั้ง 2 บริษัท (ยกมา · เข้า · ออก · คงเหลือ) + แถวรวม');
      ok(/ตรวจกับงบทดลองของ PEAK แล้ว ตรงทุกบัญชี/.test(await tx('#cbBody')), 'บอกว่าตรวจกับงบทดลองของ PEAK แล้ว');
      ok((await p.$$eval('#cbMonths tbody tr.cb-row', r => r.length)) === C_MONTHS && (await p.$$eval('#cbOlder', r => r.length)) === 1 && await p.$eval('#cbMonths tr.sel td', e => /ก\.ย\. 69/.test(e.textContent)), 'ตารางรายเดือน: เดือนที่มีข้อมูล (' + C_MONTHS + ') กดได้ · เดือนเก่าที่ยังไม่มีรวมเป็นบรรทัดเดียว · เดือนที่เลือกถูกเน้น');
      const outTxt = await tx('#cbCat-out'), inTxt = await tx('#cbCat-in');
      ok(/ค่าใช้จ่ายในการบริหาร/.test(outTxt) && /ต้นทุนขาย/.test(outTxt) && /รายการระหว่าง 2 บริษัท/.test(outTxt) && /ช่องทาง สาขา/.test(inTxt) && /ช่องทาง B2B/.test(inTxt), 'หมวดเงินเข้า (แยกช่องทาง) / เงินออก ของเดือนที่เลือก');
      await p.waitForFunction(() => { const e = document.getElementById('cbAr'); return e && !/กำลังคิด/.test(e.textContent); }, null, { timeout: 30000 }).catch(() => {});
      ok(/ลูกหนี้คงค้างทั้งหมด|อ่านข้อมูลลูกหนี้ไม่ได้/.test(await tx('#cbAr')), 'การ์ดลูกหนี้ / เงินที่คาดว่าจะเข้า โหลดแยก (หน้าแรกไม่ต้องรอ)');
      if (process.env.SHOT) {
        await p.evaluate(() => { const o = document.getElementById('cbOv'); o.style.position = 'absolute'; o.style.height = 'auto'; const b = o.querySelector('.ov-body'); b.style.overflow = 'visible'; b.style.height = 'auto'; b.style.flex = 'none'; document.querySelectorAll('body > *').forEach(n => { if (n !== o && n.tagName !== 'SCRIPT' && n.tagName !== 'STYLE') n.style.display = 'none'; }); });
        await p.screenshot({ path: process.env.SHOT, fullPage: true });
        await p.reload({ waitUntil: 'domcontentloaded' });
        await p.waitForFunction(() => { try { return typeof MENU_ACT === 'object'; } catch (e) { return false; } }, null, { timeout: 30000 });
        await p.waitForTimeout(1200);
        await p.evaluate(() => MENU_ACT.cash());
        await p.waitForSelector('#cbIn', { timeout: 30000 });
        await p.evaluate(() => CB.month('2026-09'));
        await p.waitForFunction(() => /337,176/.test((document.getElementById('cbIn') || {}).textContent || ''), null, { timeout: 20000 });
      }
      /* เดือน → หมวด → เอกสาร */
      await p.click('#cbCat-out .cb-cat:has-text("ต้นทุนขาย")');
      await p.waitForSelector('#cbDr table tbody tr', { timeout: 20000 });
      await p.waitForFunction(() => !/กำลังโหลด/.test(document.getElementById('cbDrBody').textContent), null, { timeout: 20000 });
      const drTxt = await tx('#cbDr');
      ok(/เงินออก — ต้นทุนขาย/.test(drTxt) && /PV-202609006/.test(drTxt) && /จ่ายบิลค้าง/.test(drTxt) && /58,398\.46/.test(drTxt) && /บริษัท ทดสอบแอล จำกัด/.test(drTxt), 'กดหมวด ⇒ ลิ้นชักเอกสาร: วันที่ · คู่ค้า · เลขเอกสาร · จำนวนเงิน · รวม');
      await p.fill('#cbDrFind', 'ทดสอบโอ');
      await p.waitForTimeout(250);
      ok((await p.$$eval('#cbDr tbody tr', r => r.length)) === 2 && /10,355\.46/.test(await tx('#cbDr')), '   ค้นหาในลิ้นชักได้ (เหลือ 1 ใบ + แถวรวม)');
      if (process.env.SHOT_DOCS) { await p.fill('#cbDrFind', ''); await p.waitForTimeout(250); await p.screenshot({ path: process.env.SHOT_DOCS }); }
      await p.keyboard.press('Escape');
      ok(!(await p.$('#cbDr')), '   กด Esc ปิดลิ้นชัก');
      await p.click('#cbAcct tr.cb-row:has-text("ธ.ทดสอบหนึ่ง ออมทรัพย์")');
      await p.waitForFunction(() => { const e = document.getElementById('cbDrBody'); return e && !/กำลังโหลด/.test(e.textContent); }, null, { timeout: 20000 });
      const acTxt = await tx('#cbDr');
      ok(/รายการเดินบัญชี/.test(acTxt) && /โอนระหว่างบัญชีของบริษัท/.test(acTxt) && /162,992\.08/.test(acTxt) && /258,712\.45/.test(acTxt), 'กดที่บัญชี ⇒ สมุดเดินบัญชีของบัญชีนั้น (เข้า 162,992.08 · ออก 258,712.45)');
      if (process.env.SHOT_ACCT) await p.screenshot({ path: process.env.SHOT_ACCT });
      await p.click('#cbDr .x');
      /* เลือกบริษัท + เดือน */
      await p.click('.cb-tab:has-text("มดงานการป้าย")');
      await p.waitForFunction(() => /152,726/.test((document.getElementById('cbIn') || {}).textContent || ''), null, { timeout: 20000 });
      ok(await tx('#cbOut') === '฿150,067' && !/รายการระหว่าง 2 บริษัท/.test(await tx('#cbCat-out')) && !/The 101/.test(await tx('#cbAcct')), 'แท็บบริษัท: ตัวเลขทั้งหน้าเปลี่ยนตาม (มดงานการป้าย)');
      await p.click('#cbMonths tr.cb-row:has-text("ส.ค. 69")');
      await p.waitForFunction(() => /53,500/.test((document.getElementById('cbIn') || {}).textContent || ''), null, { timeout: 20000 });
      ok(/ส\.ค\. 69/.test(await tx('.cb-mon')) && await tx('#cbOut') === '฿37,200', 'กดเดือนในตาราง ⇒ ดูเดือนนั้น');
      /* เครื่องมือผู้ดูแล = หน้าเดิม */
      await p.click('#cbTools');
      await p.waitForSelector('#cfOv:not(.hidden)', { timeout: 10000 });
      ok(!(await p.isVisible('#cbOv')) && /เครื่องมือผู้ดูแล Cash Flow \(หน้าเดิม\)/.test(await tx('#cfOv .ov-head')), 'ปุ่ม "🛠 เครื่องมือผู้ดูแล" ⇒ เปิดหน้า Cash Flow เดิม (เครื่องมือเดิมอยู่ครบ)');
      if (process.env.SHOT_OLD) { await p.waitForTimeout(2500); await p.screenshot({ path: process.env.SHOT_OLD }); }
      await p.click('#cfOv .ov-head button:has-text("Cash Flow (หน้าใหม่)")');
      await p.waitForSelector('#cbOv:not(.hidden)', { timeout: 10000 });
      ok(!(await p.isVisible('#cfOv')), '   ปุ่มกลับ ⇒ หน้า Cash Flow ใหม่');
      /* สั่งดึงจากหน้าจอ */
      resetLog();
      await p.click('#cbSync');
      await p.waitForFunction(() => { const b = document.getElementById('cbSync'); return b && !b.disabled; }, null, { timeout: 60000 });
      ok(peakLog().some(x => x.name === 'FinancialReports/trialbalance') && peakLog().every(x => x.m === 'GET' || /ClientToken/i.test(x.name)) && !(await p.$('#cbSyncMsg')), 'ปุ่ม "⟳ ดึงจาก PEAK" ⇒ ถามงบทดลองใหม่ (GET) · ไม่มีข้อผิดพลาด');
      ok(errs.length === 0, 'ไม่มี error ในหน้า' + (errs.length ? ' — ' + errs[0] : ''));
      /* PEAK ล่ม ⇒ บอกบนจอ */
      fs.writeFileSync(CTL, JSON.stringify({ mode: 'denied', extra: [] }));
      await p.click('#cbSync');
      await p.waitForSelector('#cbSyncMsg', { timeout: 60000 });
      ok(/ดึงจาก PEAK ไม่ครบ|ดึงจาก PEAK ไม่สำเร็จ/.test(await tx('#cbBody')) && /403/.test(await tx('#cbBody')) && await tx('#cbOut') === '฿37,200', '🔴 PEAK ปฏิเสธ ⇒ บอกเหตุผลบนจอ · ตัวเลขเดิมยังแสดงอยู่');
      fs.writeFileSync(CTL, JSON.stringify({ mode: 'subs', extra: [] }));
    }
    await ctx.close();
    if (errOut && /TypeError|ReferenceError/.test(errOut)) { fail++; console.log('  ❌ เซิร์ฟเวอร์พ่น error: ' + errOut.slice(0, 400)); }
  } catch (e) {
    fail++; console.log('  ❌ ล้มกลางทาง: ' + (e && e.stack || e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (app) app.kill();
    try {
      await pg.query(`delete from app.app_users where lower("Username") in ('cbboss','cbsale')`);
      await pg.query('delete from app.total_sales where "_row" >= 990001');
      if (!process.env.KEEP_DATA) await wipe();
    } catch (e) { /* เก็บกวาดไม่ได้ไม่ใช่เหตุให้ยามตก */ }
    try { await rest.close(); } catch (e) { /* ยามจบด้วย process.exit */ }
    await pg.end().catch(() => {});
  }
  console.log(`\n${fail ? '❌' : '✅'} ผ่าน ${pass} · ไม่ผ่าน ${fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
