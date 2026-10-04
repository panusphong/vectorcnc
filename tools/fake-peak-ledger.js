'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  PEAK ปลอม สำหรับ tools/test-peak-ledger.js — สวมที่ global.fetch (ระดับสายเน็ต)
 *
 *  ใช้ได้ 2 ทาง
 *   ① require() ในโปรเซสของยาม แล้วสลับโหมดด้วย setMode()
 *   ② โหลดล่วงหน้าในเซิร์ฟเวอร์ที่ยามเปิดขึ้นมา:  NODE_OPTIONS="--require <ไฟล์นี้>"
 *      (โหมดอ่านจากตัวแปร FAKE_PEAK_MODE) — ได้ทดสอบจากปุ่มบนจอจนถึงคำขอที่ยิงออกจริง
 *
 *  🔴 รูปคำตอบในไฟล์นี้ "สมมติขึ้น" ทั้งหมด — เอกสาร PEAK ไม่ได้แสดงตัวอย่างคำตอบของ 4 เส้นนี้
 *    ยามจึงพิสูจน์ได้แค่ว่า "PEAK ตอบแบบไหน โค้ดเราก็กางให้เห็นถูกต้องและไม่พัง"
 *    ส่วน PEAK จริงตอบแบบไหน ⇒ ปุ่ม "ลองถาม PEAK ตามรหัสผังบัญชี" บนเครื่องจริง
 *  🔒 ไม่ยิง PEAK จริงแม้แต่ครั้งเดียว
 * ═══════════════════════════════════════════════════════════════════ */
const realFetch = global.fetch;
const SEEN = [];
let MODE = process.env.FAKE_PEAK_MODE || 'full';
let SECRET = false;

const mkRes = (status, obj) => {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { status, ok: status < 300, text: async () => body, json: async () => JSON.parse(body) };
};
const OK = { resCode: '200', resDesc: 'Success' };

/* ผังบัญชี (รูปสมมติ) */
const COA = [
  ['110101', 'เงินสด'], ['110201', 'เงินฝากธนาคาร กสิกรไทย ออมทรัพย์'], ['110202', 'เงินฝากธนาคาร ไทยพาณิชย์ กระแสรายวัน'],
  ['113101', 'ลูกหนี้การค้า'], ['211101', 'เจ้าหนี้การค้า'], ['215101', 'เงินเดือนค้างจ่าย'], ['410101', 'รายได้จากการขาย'],
  ['510101', 'ต้นทุนวัตถุดิบ'], ['530101', 'เงินเดือนและค่าจ้าง'], ['530105', 'เงินสมทบประกันสังคม'],
  ['530205', 'ค่าเช่าสำนักงาน'], ['530301', 'ค่าไฟฟ้า'], ['530601', 'ค่าเสื่อมราคา'], ['540101', 'ดอกเบี้ยจ่าย'],
];
/* งบทดลอง (รูปสมมติ: ยกมา · เคลื่อนไหว · ยกไป อย่างละ เดบิต/เครดิต) */
const TB = {
  '110101': [25000, 0, 12000, 9000], '110201': [1850000, 0, 4960000, 4380000], '110202': [310000, 0, 880000, 905000],
  '113101': [6100000, 0, 5200000, 4790000], '211101': [0, 1420000, 2950000, 3110000], '215101': [0, 0, 0, 612000],
  '410101': [0, 52300000, 0, 6450000], '510101': [18200000, 0, 2105000, 0],
  '530101': [5508000, 0, 612000, 0], '530105': [247500, 0, 27500, 0], '530205': [720000, 0, 80000, 0],
  '530301': [318400, 0, 41200, 0], '530601': [405000, 0, 45000, 0], '540101': [96300, 0, 11800, 0],
};
const tbRows = () => COA.filter(a => TB[a[0]]).map(a => {
  const [bd, bc, md, mc] = TB[a[0]];
  const net = bd - bc + md - mc;
  return { accountCode: a[0], accountName: a[1], beginningDebit: bd, beginningCredit: bc,
           movementDebit: md, movementCredit: mc, endingDebit: net > 0 ? net : 0, endingCredit: net < 0 ? -net : 0 };
});
/* บัญชีแยกประเภท (รูปสมมติ: หัวบัญชี + รายการเดินบัญชี — มีทั้งเอกสาร EXP และสมุดรายวัน JV) */
const GL = {
  '510101': [['03', 'EXP-2026090300021', 'ซื้ออะคริลิก 3 มม.', 1250000, 0], ['18', 'EXP-2026091800007', 'ซื้อสติกเกอร์ PVC', 855000, 0]],
  '530101': [['25', 'JV-2026092500003', 'เงินเดือนพนักงาน ก.ย. 69', 612000, 0]],
  '530205': [['01', 'EXP-2026090100004', 'ค่าเช่าสำนักงาน ก.ย.', 80000, 0]],
  '110201': [['01', 'EXP-2026090100004', 'จ่ายค่าเช่าสำนักงาน', 0, 80000], ['05', 'RT-2026090500011', 'รับชำระ IV-2026090100007', 250000, 0],
             ['25', 'JV-2026092500003', 'โอนจ่ายเงินเดือน', 0, 584500], ['28', 'JV-2026092800001', 'นำส่งประกันสังคม', 0, 55000]],
};
const glOf = (code, from) => {
  const name = (COA.find(a => a[0] === code) || [])[1] || '';
  let bal = TB[code] ? TB[code][0] - TB[code][1] : 0;
  const tx = (GL[code] || []).map(t => {
    bal += t[3] - t[4];
    return { transactionDate: from.slice(0, 6) + t[0], documentCode: t[1], description: t[2], debit: t[3], credit: t[4], balance: bal };
  });
  return { accountCode: code, accountName: name, beginningBalance: TB[code] ? TB[code][0] - TB[code][1] : 0, transactions: tx };
};
const DJ = [
  { id: 'dj-1', code: 'JV-2026092800001', issuedDate: '20260928', status: 'อนุมัติแล้ว', description: 'นำส่งประกันสังคม',
    entries: [{ accountCode: '530105', debit: 27500, credit: 0 }, { accountCode: '215101', debit: 27500, credit: 0 }, { accountCode: '110201', debit: 0, credit: 55000 }] },
  { id: 'dj-2', code: 'JV-2026092500003', issuedDate: '20260925', status: 'อนุมัติแล้ว', description: 'เงินเดือนพนักงาน ก.ย. 69',
    entries: [{ accountCode: '530101', debit: 612000, credit: 0 }, { accountCode: '110201', debit: 0, credit: 584500 }, { accountCode: '215101', debit: 0, credit: 27500 }] },
];

function answer(name, qs) {
  const led = /^(FinancialReports|DailyJournals)/.test(name);
  if (/^Receipts/.test(name)) {
    if (MODE === 'conn') return mkRes(200, { PeakReceipts: { resCode: '601', resDesc: 'Invalid Client Token' } });
    return mkRes(200, { PeakReceipts: Object.assign({}, OK, { receipts: [{ code: 'RT-2026090500011', paymentAmount: 250000 }] }) });
  }
  if (!led) return mkRes(404, { resCode: '404', resDesc: 'Not Found' });
  if (MODE === 'denied') return mkRes(403, { resCode: '403', resDesc: 'This application is not allowed to access Financial Reports API' });
  if (MODE === 'denied200') return mkRes(200, { resCode: '402', resDesc: 'Permission denied for this package' });
  if (name === 'DailyJournals/accountcode')
    return mkRes(200, { PeakAccountCodes: Object.assign({}, OK, { accountCodes: COA.map(a => (SECRET
      ? { accountCode: a[0], accountName: a[1], apiKey: 'should-be-hidden' }     /* ไว้พิสูจน์ว่าช่องชื่อเป็นความลับถูกซ่อนค่า */
      : { accountCode: a[0], accountName: a[1] })) }) });
  if (name === 'FinancialReports/trialbalance') {
    if (MODE === 'odd') {                       /* รูปแปลก: ไม่มีอาเรย์เลย — เป็นแผนที่ รหัส → ยอด */
      const map = {}; tbRows().forEach(r => { map[r.accountCode] = { name: r.accountName, debit: r.movementDebit, credit: r.movementCredit }; });
      return mkRes(200, { PeakTrialBalance: Object.assign({}, OK, { fromMonth: qs.get('fromMonth'), toMonth: qs.get('toMonth'), balances: map }) });
    }
    if (MODE === 'empty') return mkRes(200, { PeakTrialBalance: Object.assign({}, OK, { accounts: [] }) });
    return mkRes(200, { PeakTrialBalance: Object.assign({}, OK, { fromMonth: qs.get('fromMonth'), toMonth: qs.get('toMonth'), accounts: tbRows() }) });
  }
  if (name === 'FinancialReports/generalledger') {
    if (!qs.get('accountCode') || !qs.get('fromDate') || !qs.get('toDate'))
      return mkRes(200, { resCode: '400', resDesc: 'Invalid parameter: accountCode is required' });
    return mkRes(200, { PeakGeneralLedger: Object.assign({}, OK, { fromDate: qs.get('fromDate'), toDate: qs.get('toDate'),
      accounts: [glOf(qs.get('accountCode'), qs.get('fromDate'))] }) });
  }
  if (name === 'DailyJournals') return mkRes(200, { PeakDailyJournals: Object.assign({}, OK, { dailyJournals: DJ }) });
  return mkRes(404, { resCode: '404', resDesc: 'Not Found' });
}

global.fetch = async function (url, opt) {
  const u = String(url), m = String((opt && opt.method) || 'GET').toUpperCase();
  if (u.indexOf('api.peakaccount.com') < 0) return realFetch(url, opt);
  SEEN.push({ m, u });
  const name = (u.split('?')[0].match(/\/api\/v1\/(.+)$/) || [])[1] || '';
  if (/^ClientToken$/i.test(name)) return mkRes(200, { PeakClientToken: { clientToken: 'tok-0123456789abcdef' } });
  if (m !== 'GET') return mkRes(405, { resCode: '405', resDesc: 'Method not allowed' });
  return answer(name, new URLSearchParams(u.split('?')[1] || ''));
};

module.exports = { SEEN, setMode: v => { MODE = v; }, mode: () => MODE, setSecret: v => { SECRET = !!v; }, COA, TB, GL, DJ, tbRows,
                   restore: () => { global.fetch = realFetch; } };
