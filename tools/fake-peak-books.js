'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  PEAK ปลอม "สมุดบัญชี" สำหรับ tools/test-cashbook.js — สวมที่ global.fetch (ระดับสายเน็ต)
 *
 *  🔴 รูปคำตอบในไฟล์นี้ = รูปจริงที่เห็นจากเครื่องจริง 4 ต.ค. 69 (ทั้ง 2 กิจการ) — ไม่ได้สมมติ
 *     งบทดลอง      PeakTrialBalance.trialBalanceAccount[] { account{…}, beginningBalance, change, endingBalance }
 *     บัญชีแยกประเภท PeakGeneralLedger.generalLedgers[] { account, summary, transactions[]{date,journalNumber,description,debit,credit}, totalTransactions }
 *     คำอธิบายบรรทัด (description) ใช้รูปเดียวกับของจริงทั้งแบบเอกสารและแบบสมุดรายวัน
 *  ‼ ที่ "ยังไม่เคยเห็นของจริง" มีอย่างเดียว: งบทดลองแบบ isShowSubAccount (โหมด subs) — โค้ดจริงจึงใช้ก็ต่อเมื่อเทียบยอดผ่าน
 *  🔒 ชื่อคู่ค้า · เลขบัญชีธนาคาร · ตัวเลขทั้งหมด เป็นข้อมูลจำลอง ไม่ใช่ของบริษัทจริง
 *  🔒 ไม่ยิง PEAK จริงแม้แต่ครั้งเดียว · รับเฉพาะ GET (อย่างอื่นตอบ 405 ให้ยามจับ)
 *
 *  ใช้ 2 ทาง: ① require() ในโปรเซสของยาม  ② โหลดล่วงหน้าในเซิร์ฟเวอร์: NODE_OPTIONS="--require <ไฟล์นี้>"
 *    FAKE_BOOKS_LOG   = ไฟล์จดทุกคำขอ (บรรทัดละ 1)        FAKE_BOOKS_CTL = ไฟล์สั่งงาน JSON { mode, extra:[สมุดรายวันเพิ่ม] }
 * ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const realFetch = global.fetch;
const LOG = process.env.FAKE_BOOKS_LOG || '';
const CTL = process.env.FAKE_BOOKS_CTL || '';
const SEEN = [];
let MEM = { mode: 'subs', extra: [] };
const ctl = () => { if (!CTL) return MEM; try { return Object.assign({ mode: 'subs', extra: [] }, JSON.parse(fs.readFileSync(CTL, 'utf8'))); } catch (e) { return MEM; } };
const r2 = n => Math.round(n * 100) / 100;

const BIZ = { 'test-user-token-m': 'M', 'test-user-token-t': 'T' };
const NAME = {
  '111101': 'เงินสด', '111201': 'ธนาคาร - บัญชีกระแสรายวัน', '111301': 'ธนาคาร - บัญชีออมทรัพย์',
  '111401': 'เช็ครับที่ครบกำหนดแต่ยังมิได้ฝาก', '111501': 'กระเป๋าเงินอิเล็กทรอนิกส์', '112101': 'ธนาคาร - ฝากประจำ',
  '113101': 'ลูกหนี้การค้า', '115104': 'เงินจ่ายล่วงหน้า - เงินมัดจำ', '115401': 'ภาษีซื้อ', '115403': 'ภาษีถูกหัก ณ ที่จ่าย',
  '124106': 'อุปกรณ์สำนักงาน', '124206': 'ค่าเสื่อมราคาสะสม - อุปกรณ์สำนักงาน',
  '211301': 'เงินกู้ยืมระยะสั้นธนาคารมีหลักประกัน', '212101': 'เจ้าหนี้การค้า', '212203': 'สำรองจ่ายแทนกิจการที่ยังไม่ได้คืนเงิน',
  '215101': 'ภาษีขาย ภ.พ.30', '215201': 'ภ.ง.ด. 1 ค้างจ่าย', '215204': 'ภ.ง.ด. 53 ค้างจ่าย', '215501': 'ประกันสังคมค้างจ่าย',
  '311000': 'หุ้นสามัญ', '410201': 'รายได้จากการให้บริการ', '410205': 'รายได้จากการขายป้าย',
  '510101': 'ต้นทุนผลิตสินค้า', '510104': 'ต้นทุนการให้บริการ', '520213': 'ค่าส่งเสริมการขาย',
  '530101': 'เงินเดือน ค่าจ้าง', '530124': 'ค่าน้ำมัน (บริหาร)', '530201': 'ค่าเช่าสำนักงาน', '530203': 'ค่าเช่ายานพาหนะ',
  '530501': 'ค่าธรรมเนียมธนาคาร', '530706': 'ค่าเสื่อมราคา - อุปกรณ์สำนักงาน', '580101': 'ดอกเบี้ยจ่าย',
};
/* บัญชีย่อยของบัญชีเงินสด/ธนาคาร (เลขบัญชีจำลอง) */
const SUB = {
  M: { '111201': { BCA001: ['ธ.ทดสอบหนึ่ง กระแสรายวัน', '000-1-00001-1', 'มดงานการป้าย'] },
       '111301': { BSV001: ['ธ.ทดสอบสอง ออมทรัพย์', '000-2-00002-2', 'มดงานการป้าย'] } },
  T: { '111201': { BCA001: ['ธ.ทดสอบสาม กระแสรายวัน', '000-3-00003-3', 'เดอะ 101 (เงินสดย่อย)'], BCA002: ['ธ.ทดสอบหนึ่ง กระแสรายวัน', '000-4-00004-4', 'เดอะ 101'] },
       '111301': { BSV001: ['ธ.ทดสอบหนึ่ง ออมทรัพย์', '0000000005', 'เดอะ 101'] },
       '111401': {}, '111501': { EWL001: ['กระเป๋าเงินทดสอบ', 'W-0006', 'เดอะ 101'] } },
};
/* ยอดยกมา ณ ต้น ก.ค. 69 (เดบิตเป็นบวก) + ยกมาแยกบัญชีย่อย */
const OPEN = {
  M: { '111101': 23390, '111201': 152820.94, '111301': 975578.06, '113101': 300000, '124106': 155550.48, '124206': -26559, '212101': -20000, '311000': -1560780.48 },
  T: { '111101': 2500000, '111201': 120000, '111301': 2800000, '111501': 324, '113101': 900000, '211301': -750000, '212101': -400000, '212203': -100000, '311000': -5070324 },
};
const OPEN_SUB = { M: { '111201': { BCA001: 152820.94 }, '111301': { BSV001: 975578.06 } },
                   T: { '111201': { BCA001: 20000, BCA002: 100000 }, '111301': { BSV001: 2800000 }, '111501': { EWL001: 324 } } };

/* ── ตัวช่วยเขียนบรรทัด ─────────────────────────────────────────── */
const docLine = (b, code, sub, cp, ref, dr, cr) => {       /* บรรทัดธนาคารจากเอกสาร */
  const s = SUB[b][code][sub];
  return { code, sub, dr, cr, t: [NAME[code], s[2], s[1], sub].concat(cp ? [cp] : []).concat(ref ? ['#' + ref] : []).join(' - ') };
};
const jvLine = (b, code, sub, dr, cr, tail) => {            /* บรรทัดธนาคารจากสมุดรายวัน */
  const s = SUB[b][code][sub];
  return { code, sub, dr, cr, t: [NAME[code], sub, s[0], s[1] + ' ' + s[2]].concat(tail ? [tail] : []).join(' - ') };
};
const L = (code, t, dr, cr) => ({ code, sub: '', dr, cr, t });
const ar = (cp, ref, dr, cr) => L('113101', 'ลูกหนี้การค้า - ' + cp + ' - #' + ref, dr, cr);
const J = (no, dd, lines) => ({ no, dd, lines });

/* ── สมุดรายวัน (ทุกใบสมดุล เดบิต = เครดิต) ───────────────────────── */
const BOOK = { M: {}, T: {} };
/* มดงานการป้าย */
BOOK.M['2026-07'] = [
  J('RV-202607001', '03', [docLine('M', '111301', 'BSV001', 'บริษัท ทดสอบเอ จำกัด', 'IV-2026070100001', 97000, 0), L('115403', 'ภาษีถูกหัก ณ ที่จ่าย - บริษัท ทดสอบเอ จำกัด - #IV-2026070100001', 3000, 0), ar('บริษัท ทดสอบเอ จำกัด', 'IV-2026070100001', 0, 100000)]),
  J('JVFN-202607001', '05', [docLine('M', '111301', 'BSV001', '', '', 0, 50000), docLine('M', '111201', 'BCA001', '', '', 50000, 0)]),
  J('JV-202607010', '25', [L('530101', 'เงินเดือน ค่าจ้าง - เงินเดือน ก.ค. 69', 40000, 0), jvLine('M', '111201', 'BCA001', 0, 37200), L('215501', 'ประกันสังคมค้างจ่าย', 0, 1200), L('215201', 'ภ.ง.ด. 1 ค้างจ่าย', 0, 1600)]),
];
BOOK.M['2026-08'] = [
  J('SV-202608001', '02', [ar('คุณ ทดสอบบี', 'IV-2026080200001', 53500, 0), L('410205', 'รายได้จากการขายป้าย - คุณ ทดสอบบี - #IV-2026080200001', 0, 50000), L('215101', 'ภาษีขาย ภ.พ.30 - คุณ ทดสอบบี - #IV-2026080200001', 0, 3500)]),
  J('RV-202608001', '04', [docLine('M', '111301', 'BSV001', 'คุณ ทดสอบบี', 'IV-2026080200001', 53500, 0), ar('คุณ ทดสอบบี', 'IV-2026080200001', 0, 53500)]),
  J('UV-202608001', '20', [L('510104', 'ค่าผลิตป้าย - บริษัท เดอะ 101 จำกัด - #EXP-2026082000001', 28037.38, 0), L('115401', 'ภาษีซื้อ - บริษัท เดอะ 101 จำกัด - #EXP-2026082000001', 1962.62, 0), L('212101', 'เจ้าหนี้การค้า - บริษัท เดอะ 101 จำกัด - #EXP-2026082000001', 0, 30000)]),
  J('JV-202608010', '25', [L('530101', 'เงินเดือน ค่าจ้าง - เงินเดือน ส.ค. 69', 40000, 0), jvLine('M', '111201', 'BCA001', 0, 37200), L('215501', 'ประกันสังคมค้างจ่าย', 0, 1200), L('215201', 'ภ.ง.ด. 1 ค้างจ่าย', 0, 1600)]),
];
BOOK.M['2026-09'] = [
  J('RV-202609001', '01', [docLine('M', '111301', 'BSV001', 'บริษัท ทดสอบซี จำกัด', 'IV-2026090100003', 582.4, 0), L('115403', 'ภาษีถูกหัก ณ ที่จ่าย - บริษัท ทดสอบซี จำกัด - #IV-2026090100003', 16.8, 0), ar('บริษัท ทดสอบซี จำกัด', 'IV-2026090100003', 0, 599.2)]),
  J('RV-202609002', '01', [docLine('M', '111301', 'BSV001', 'คุณ ทดสอบดี', 'IV-2026090100006', 1337.5, 0), ar('คุณ ทดสอบดี', 'IV-2026090100006', 0, 1337.5)]),
  J('RV-202609039', '01', [docLine('M', '111301', 'BSV001', 'บริษัท ทดสอบอี จำกัด', 'IV-2026062900013', 150800, 0), ar('บริษัท ทดสอบอี จำกัด', 'IV-2026062900013', 0, 150800)]),
  J('JVFN-202609001', '01', [docLine('M', '111301', 'BSV001', '', '', 0, 100000), docLine('M', '111201', 'BCA001', '', '', 100000, 0)]),
  J('JV-202609041', '01', [jvLine('M', '111301', 'BSV001', 6, 0), L('410201', 'รายได้จากการให้บริการ - ดอกเบี้ยรับ', 0, 6)]),
  J('JV-202609550', '02', [L('530501', 'ค่าธรรมเนียมธนาคาร', 39, 0), jvLine('M', '111201', 'BCA001', 0, 39)]),
  J('SV-202609498', '08', [L('410201', 'รายได้จากการให้บริการ - บริษัท ทดสอบเอฟ จำกัด - #CNT-2026090800001', 680.37, 0), L('215101', 'ภาษีขาย ภ.พ.30 - บริษัท ทดสอบเอฟ จำกัด - #CNT-2026090800001', 47.63, 0), docLine('M', '111201', 'BCA001', 'บริษัท ทดสอบเอฟ จำกัด', 'CNT-2026090800001', 0, 728)]),
  J('PV-202609001', '11', [L('115104', 'เงินจ่ายล่วงหน้า - เงินมัดจำ - บริษัท ทดสอบจี จำกัด - #DP-2026091100001', 72800, 0), docLine('M', '111201', 'BCA001', 'บริษัท ทดสอบจี จำกัด', 'DP-2026091100001', 0, 72800)]),
  J('PV-202609002', '15', [L('212101', 'เจ้าหนี้การค้า - บริษัท เดอะ 101 จำกัด - #EXP-2026082000001', 30000, 0), docLine('M', '111301', 'BSV001', 'บริษัท เดอะ 101 จำกัด', 'EXP-2026082000001', 0, 30000)]),
  J('JV-202609600', '25', [L('530101', 'เงินเดือน ค่าจ้าง - เงินเดือน ก.ย. 69', 50000, 0), jvLine('M', '111201', 'BCA001', 0, 46500), L('215501', 'ประกันสังคมค้างจ่าย', 0, 1500), L('215201', 'ภ.ง.ด. 1 ค้างจ่าย', 0, 2000)]),
  J('JVDP-202609005', '30', [L('530706', 'ค่าเสื่อมราคา - อุปกรณ์สำนักงาน - บันทึกการตัดค่าเสื่อมของสินทรัพย์ #COM-00005-001 - 09/2569', 277.59, 0), L('124206', 'ค่าเสื่อมราคาสะสม - อุปกรณ์สำนักงาน', 0, 277.59)]),
];
BOOK.M['2026-10'] = [
  J('RV-202610001', '01', [docLine('M', '111301', 'BSV001', 'บริษัท ทดสอบเอช จำกัด', 'IV-2026100100001', 21400, 0), ar('บริษัท ทดสอบเอช จำกัด', 'IV-2026100100001', 0, 21400)]),
  J('JV-202610001', '02', [L('530501', 'ค่าธรรมเนียมธนาคาร', 54, 0), jvLine('M', '111201', 'BCA001', 0, 54)]),
];
/* The 101 */
BOOK.T['2026-07'] = [
  J('RV-202607001', '02', [docLine('T', '111301', 'BSV001', 'บริษัท ทดสอบเจ จำกัด', 'IV-69070200001', 250000, 0), ar('บริษัท ทดสอบเจ จำกัด', 'IV-69070200001', 0, 250000)]),
  J('PV-202607001', '10', [L('530201', 'ค่าเช่าสำนักงาน - บริษัท ทดสอบเค จำกัด - #EXP-69071000001', 80000, 0), L('115401', 'ภาษีซื้อ - บริษัท ทดสอบเค จำกัด - #EXP-69071000001', 5600, 0), L('215204', 'ภ.ง.ด. 53 ค้างจ่าย - บริษัท ทดสอบเค จำกัด - #EXP-69071000001', 0, 4000), docLine('T', '111301', 'BSV001', 'บริษัท ทดสอบเค จำกัด', 'EXP-69071000001', 0, 81600)]),
];
BOOK.T['2026-08'] = [
  J('UV-202608001', '29', [L('510101', 'เหล็กกล่อง 2x4 - บริษัท ทดสอบแอล จำกัด - #EXP-69082900010', 40000, 0), L('510101', 'เหล็กแบน 2x3.0 - บริษัท ทดสอบแอล จำกัด - #EXP-69082900010', 4900, 0), L('115401', 'ภาษีซื้อ - บริษัท ทดสอบแอล จำกัด - #EXP-69082900010', 3143, 0), L('212101', 'เจ้าหนี้การค้า - บริษัท ทดสอบแอล จำกัด - #EXP-69082900010', 0, 48043)]),
  J('PV-202608001', '30', [L('530124', 'ค่าน้ำมัน (บริหาร) - นาย ทดสอบเอ็ม - ADV014 - บริษัท ทดสอบเอ็น จำกัด - #EXP-69083000001', 500, 0), L('212203', 'สำรองจ่ายแทนกิจการที่ยังไม่ได้คืนเงิน - นาย ทดสอบเอ็ม - ADV014 - บริษัท ทดสอบเอ็น จำกัด - #EXP-69083000001', 0, 500)]),
];
BOOK.T['2026-09'] = [
  J('RV-202609001', '01', [docLine('T', '111301', 'BSV001', 'บริษัท มดงานการป้าย จำกัด', 'IV-69082000001', 30000, 0), ar('บริษัท มดงานการป้าย จำกัด', 'IV-69082000001', 0, 30000)]),
  J('PV-202609001', '01', [L('510101', 'ท่อสี่เหลี่ยมโปร่ง 1 x 1.4 - บริษัท ทดสอบโอ จำกัด - #EXP-69090100001', 4410, 0), L('510101', 'ท่อกลมดำ 3/4 x 1.4 - บริษัท ทดสอบโอ จำกัด - #EXP-69090100001', 5268, 0), L('115401', 'ภาษีซื้อ - บริษัท ทดสอบโอ จำกัด - #EXP-69090100001', 677.46, 0), docLine('T', '111301', 'BSV001', 'บริษัท ทดสอบโอ จำกัด', 'EXP-69090100001', 0, 10355.46)]),
  J('PV-202609006', '02', [L('212101', 'เจ้าหนี้การค้า - บริษัท ทดสอบแอล จำกัด - #EXP-69082900010', 48043, 0), docLine('T', '111301', 'BSV001', 'บริษัท ทดสอบแอล จำกัด', 'EXP-69082900010', 0, 48043)]),
  J('JVFN-202609001', '03', [docLine('T', '111301', 'BSV001', '', '', 0, 50000), docLine('T', '111201', 'BCA001', '', '', 50000, 0)]),
  J('JV-202609004', '03', [L('212203', 'สำรองจ่ายแทนกิจการที่ยังไม่ได้คืนเงิน - ADV011 - ทดสอบพี (ช่าง)', 3000, 0), jvLine('T', '111201', 'BCA001', 0, 3000)]),
  J('PV-202609010', '05', [L('530201', 'ค่าเช่าสำนักงาน - บริษัท ทดสอบเค จำกัด - #EXP-69090500001', 84210.52, 0), L('530203', 'ค่าเช่ายานพาหนะ - บริษัท ทดสอบเค จำกัด - #EXP-69090500001', 42105.26, 0), L('115401', 'ภาษีซื้อ - บริษัท ทดสอบเค จำกัด - #EXP-69090500001', 8842.11, 0), L('215204', 'ภ.ง.ด. 53 ค้างจ่าย - บริษัท ทดสอบเค จำกัด - #EXP-69090500001', 0, 6315.79), docLine('T', '111301', 'BSV001', 'บริษัท ทดสอบเค จำกัด', 'EXP-69090500001', 0, 128842.1)]),
  J('RV-202609050', '07', [L('111401', 'เช็ครับที่ครบกำหนดแต่ยังมิได้ฝาก - บริษัท ทดสอบคิว จำกัด - #IV-69090700001', 132992.08, 0), ar('บริษัท ทดสอบคิว จำกัด', 'IV-69090700001', 0, 132992.08)]),
  J('JVFN-202609005', '08', [docLine('T', '111301', 'BSV001', '', '', 132992.08, 0), L('111401', 'เช็ครับที่ครบกำหนดแต่ยังมิได้ฝาก', 0, 132992.08)]),
  J('RV-202609060', '10', [docLine('T', '111501', 'EWL001', 'ลูกค้าออนไลน์ ทดสอบ', 'IV-69091000002', 458, 0), ar('ลูกค้าออนไลน์ ทดสอบ', 'IV-69091000002', 0, 458)]),
  J('JV-202609068', '25', [jvLine('T', '111201', 'BCA002', 51000, 0), L('212203', 'สำรองจ่ายแทนกิจการที่ยังไม่ได้คืนเงิน - ADV001 - กรรมการ ทดสอบ', 0, 51000)]),
  J('PV-202609099', '28', [L('211301', 'เงินกู้ยืมระยะสั้นธนาคารมีหลักประกัน - ธ.ทดสอบหนึ่ง', 20800, 0), L('580101', 'ดอกเบี้ยจ่าย - ธ.ทดสอบหนึ่ง', 671.89, 0), docLine('T', '111301', 'BSV001', 'ธ.ทดสอบหนึ่ง', 'EXP-69092800009', 0, 21471.89)]),
];
BOOK.T['2026-10'] = [
  J('PV-202610001', '01', [L('520213', 'ค่าส่งเสริมการขาย - บริษัท ทดสอบอาร์ จำกัด - #EXP-69100100001', 5000, 0), L('115401', 'ภาษีซื้อ - บริษัท ทดสอบอาร์ จำกัด - #EXP-69100100001', 350, 0), docLine('T', '111301', 'BSV001', 'บริษัท ทดสอบอาร์ จำกัด', 'EXP-69100100001', 0, 5350)]),
];
const MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10'];

/* ── คิดงบทดลอง / บัญชีแยกประเภทจากสมุดรายวัน ──────────────────────── */
function journals(b, ym) {
  const extra = (ctl().extra || []).filter(x => x.biz === b && x.ym === ym).map(x => J(x.no, x.dd, x.lines));
  return (BOOK[b][ym] || []).concat(extra);
}
function balanceAt(b, ym) {            /* ยอดยกมา ณ ต้นเดือน ym */
  const bal = Object.assign({}, OPEN[b]);
  const sub = JSON.parse(JSON.stringify(OPEN_SUB[b]));
  for (const m of MONTHS) {
    if (m >= ym) break;
    journals(b, m).forEach(j => j.lines.forEach(l => {
      bal[l.code] = r2((bal[l.code] || 0) + l.dr - l.cr);
      if (l.sub) { sub[l.code] = sub[l.code] || {}; sub[l.code][l.sub] = r2((sub[l.code][l.sub] || 0) + l.dr - l.cr); }
    }));
  }
  return { bal, sub };
}
const side = v => (v >= 0 ? { debit: r2(v), credit: 0 } : { debit: 0, credit: r2(-v) });
function tbOf(b, ym, withSub) {
  const { bal, sub } = balanceAt(b, ym);
  const chg = {}, chgSub = {};
  journals(b, ym).forEach(j => j.lines.forEach(l => {
    chg[l.code] = chg[l.code] || { d: 0, c: 0 }; chg[l.code].d = r2(chg[l.code].d + l.dr); chg[l.code].c = r2(chg[l.code].c + l.cr);
    if (l.sub) { const k = l.code + '|' + l.sub; chgSub[k] = chgSub[k] || { d: 0, c: 0 }; chgSub[k].d = r2(chgSub[k].d + l.dr); chgSub[k].c = r2(chgSub[k].c + l.cr); }
  }));
  const codes = Array.from(new Set(Object.keys(bal).filter(c => bal[c]).concat(Object.keys(chg)))).sort();
  const rows = [];
  let sumD = 0, sumC = 0;
  codes.forEach(code => {
    const c = chg[code] || { d: 0, c: 0 }, beg = bal[code] || 0;
    sumD += c.d; sumC += c.c;
    rows.push({ account: { accountCode: code, accountName: NAME[code] || code, subAccountCode: '', subAccountName: '', isSubAccount: false },
                beginningBalance: side(beg), change: { debit: c.d, credit: c.c }, endingBalance: side(r2(beg + c.d - c.c)) });
    if (withSub && SUB[b][code]) Object.keys(SUB[b][code]).forEach(sc => {
      const s = SUB[b][code][sc], sb = (sub[code] || {})[sc] || 0, cs = chgSub[code + '|' + sc] || { d: 0, c: 0 };
      const bad = withSub === 'bad' ? 1000 : 0;
      rows.push({ account: { accountCode: code, accountName: NAME[code], subAccountCode: sc, subAccountName: s[0] + ' - ' + s[1] + ' ' + s[2], isSubAccount: true },
                  beginningBalance: side(sb), change: { debit: cs.d + bad, credit: cs.c }, endingBalance: side(r2(sb + cs.d - cs.c)) });
    });
  });
  return { rows, summary: { change: { debit: r2(sumD), credit: r2(sumC) } } };
}
function glOf(b, ym, code) {
  const { bal } = balanceAt(b, ym);
  const tx = [];
  journals(b, ym).slice().sort((x, y) => x.dd < y.dd ? -1 : (x.dd > y.dd ? 1 : 0)).forEach(j => j.lines.forEach(l => {
    if (l.code === code) tx.push({ date: ym.replace('-', '') + j.dd, journalNumber: j.no, description: l.t, debit: l.dr, credit: l.cr });
  }));
  const d = r2(tx.reduce((s, t) => s + t.debit, 0)), c = r2(tx.reduce((s, t) => s + t.credit, 0));
  const beg = bal[code] || 0, pl = /^[45]/.test(code);
  return { account: { accountCode: code, accountName: NAME[code] || code, isSubAccount: false },
           summary: { beginningBalance: pl ? null : side(beg), change: { debit: d, credit: c },
                      endingBalance: { debit: r2((beg > 0 ? beg : 0) + d), credit: r2((beg < 0 ? -beg : 0) + c) } },
           transactions: tx, totalTransactions: tx.length };
}

const mkRes = (status, obj) => {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { status, ok: status < 300, text: async () => body, json: async () => JSON.parse(body) };
};
const OK = { resCode: '200', resDesc: 'Success' };
const ymOf = s => String(s || '').slice(0, 4) + '-' + String(s || '').slice(4, 6);

function answer(b, name, qs, mode) {
  if (/^Receipts/.test(name)) return mkRes(200, { PeakReceipts: Object.assign({}, OK, { receipts: [] }) });
  if (!/^FinancialReports\//.test(name)) return mkRes(404, { resCode: '404', resDesc: 'Not Found' });
  if (mode === 'denied') return mkRes(403, { resCode: '403', resDesc: 'This application is not allowed to access Financial Reports API' });
  if (mode === 'auth') return mkRes(401, { resCode: '401', resDesc: 'Unauthorized' });
  if (name === 'FinancialReports/trialbalance') {
    const ym = ymOf(qs.get('fromMonth'));
    if (mode === 'odd') return mkRes(200, { PeakTrialBalance: Object.assign({}, OK, { accounts: [] }) });
    const flag = qs.get('isShowSubAccount') === 'true';
    const T = tbOf(b, ym, flag ? (mode === 'subs' ? true : (mode === 'badsubs' ? 'bad' : false)) : false);
    return mkRes(200, { PeakTrialBalance: Object.assign({ trialBalanceAccount: T.rows, summary: T.summary }, OK), eventType: 'Retrieve', apiType: 'ApiFinancialReports' });
  }
  if (name === 'FinancialReports/generalledger') {
    const code = qs.get('accountCode'), from = qs.get('fromDate'), to = qs.get('toDate');
    if (!code || !from || !to) return mkRes(200, { resCode: '400', resDesc: 'Invalid parameter: accountCode is required' });
    const G = glOf(b, ymOf(from), code);
    if (mode === 'short' && G.transactions.length > 1) G.transactions = G.transactions.slice(0, -1);   /* PEAK ส่งมาไม่ครบ */
    return mkRes(200, { PeakGeneralLedger: Object.assign({ fromDate: from, toDate: to, generalLedgers: G.transactions.length || G.totalTransactions ? [G] : [] }, OK),
                        eventType: 'Retrieve', apiType: 'ApiFinancialReports' });
  }
  return mkRes(404, { resCode: '404', resDesc: 'Not Found' });
}

global.fetch = async function (url, opt) {
  const u = String(url), m = String((opt && opt.method) || 'GET').toUpperCase();
  if (u.indexOf('api.peakaccount.com') < 0) return realFetch(url, opt);
  const name = (u.split('?')[0].match(/\/api\/v1\/(.+)$/) || [])[1] || '';
  const b = BIZ[String(((opt && opt.headers) || {})['User-Token'] || '')] || '';
  const rec = { m, name, q: u.split('?')[1] || '', b };
  SEEN.push(rec);
  if (LOG) try { fs.appendFileSync(LOG, JSON.stringify(rec) + '\n'); } catch (e) { /* จดไม่ได้ก็ไม่เป็นไร */ }
  if (/^ClientToken$/i.test(name)) return mkRes(200, { PeakClientToken: { clientToken: 'tok-0123456789abcdef' } });
  if (m !== 'GET') return mkRes(405, { resCode: '405', resDesc: 'Method not allowed' });
  return answer(b, name, new URLSearchParams(u.split('?')[1] || ''), ctl().mode);
};

module.exports = { SEEN, BOOK, OPEN, SUB, NAME, MONTHS, J, L, docLine, jvLine, ar, tbOf, glOf, balanceAt, journals,
  set: o => { MEM = Object.assign({ mode: 'subs', extra: [] }, o || {}); if (CTL) fs.writeFileSync(CTL, JSON.stringify(MEM)); },
  restore: () => { global.fetch = realFetch; } };
