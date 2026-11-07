'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/perfreport/score.js — สูตรคะแนน (ฟังก์ชันล้วน · ทดสอบได้ · ไม่แตะฐาน)
 *
 *  ‼ ตามเอกสาร "ออกแบบแอป Report & Ranking ทีม Sale / Sale Support" (3 พ.ย. 69)
 *    คะแนนการทำงานรายวัน 100 · คะแนนผลลัพธ์ 100 · ranking ช่วงยาว = 60% ผลลัพธ์ + 40% รายวันเฉลี่ย
 *  ‼ ทุกหัวข้อคืน { key, label, got, max, why } ⇒ หน้าจอโชว์ได้ว่าได้/ไม่ได้เพราะอะไร
 * ═══════════════════════════════════════════════════════════════════ */
const C = require('./config');

const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const item = (key, label, got, max, why) => ({ key, label, got: Math.max(0, Math.min(max, Math.round(got * 10) / 10)), max, why });

/** เวลาตอบเฉลี่ย (นาที) → คะแนน · ไม่มีแชทให้ตอบ = เต็ม (ไม่ลงโทษคนที่ไม่มีแชท) */
function speed(avgMin, replies, max, half) {
  if (!replies || avgMin == null) return [max, 'ไม่มีแชทให้ตอบ'];
  /* ⏱ v1.0.10 บอกเกณฑ์ให้เห็น: ≤ 5 นาที = เต็ม · ≤ 15 นาที = ครึ่ง · เกิน 15 = 0 */
  const rule = 'เต็มเมื่อ ≤ ' + C.REPLY_FAST_MIN + ' นาที · ครึ่งเมื่อ ≤ ' + C.REPLY_OK_MIN + ' นาที';
  if (avgMin <= C.REPLY_FAST_MIN) return [max, 'ตอบเฉลี่ย ' + avgMin + ' นาที (' + rule + ')'];
  if (avgMin <= C.REPLY_OK_MIN) return [half, 'ตอบเฉลี่ย ' + avgMin + ' นาที (' + rule + ')'];
  return [0, 'ตอบเฉลี่ย ' + avgMin + ' นาที (' + rule + ')'];
}
function neglect(breaches, max, slaMin) {
  const b = n(breaches);
  const lim = slaMin ? 'ต้องตอบภายใน ' + slaMin + ' นาที' : '';
  return [max - b * C.NEGLECT_PENALTY, b ? 'ลูกค้ารอเกินเวลา ' + b + ' ครั้ง (' + (lim ? lim + ' · ' : '') + 'หัก ' + C.NEGLECT_PENALTY + '/ครั้ง)' : 'ไม่ปล่อยลูกค้ารอ' + (lim ? ' (' + lim + ')' : '')];
}
function onTime(r, max) {
  if (!r || !r.submitted) return [0, 'ยังไม่ส่ง report'];
  const due = C.DUE_HHMM === '24:00' ? 'ภายในวันนั้น (ถึง 24:00 น.)' : C.DUE_HHMM;
  return r.onTime ? [max, 'ส่ง' + (C.DUE_HHMM === '24:00' ? due : 'ก่อน ' + due)] : [max / 2, C.DUE_HHMM === '24:00' ? 'ส่งย้อนหลัง (เลยวันนั้นไปแล้ว)' : 'ส่งหลัง ' + due];
}

/**
 * คะแนนการทำงานรายวัน
 * @param {'sale'|'support'} role
 * @param {object} m  metrics ของวันนั้น (metrics.js)
 * @param {{submitted:boolean,onTime:boolean}} sub
 */
function daily(role, m, sub, opt) {
  m = m || {};
  const noChat = !!(opt && opt.noChat);
  const chat = m.chat || {}, sales = m.sales || {}, money = m.money || {}, cust = m.customer || {}, work = m.work || {};
  const out = [];
  if (role === 'branch') {
    /* กราฟิก สาขามดงาน — รับแชท/ลูกค้าหน้าร้าน · ใบเสนอ · รหัสงาน · ปิดการขาย · เก็บเงิน (ไม่มี visit / หาลูกค้าใหม่) */
    const [g1, w1] = neglect(chat.slaBreaches, 10, chat.slaMin); out.push(item('neglect', 'ไม่ทิ้งแชทให้ลูกค้ารอ', g1, 10, w1));
    const [g2, w2] = speed(chat.avgReplyMin, chat.replies, 10, 5); out.push(item('speed', 'เวลาตอบแชทเฉลี่ย', g2, 10, w2));
    out.push(item('care', 'ตอบลูกค้าต่อเนื่อง (≥ ' + C.SUPPORT_REPLY_MIN + ' ข้อความ)', n(chat.replies) >= C.SUPPORT_REPLY_MIN ? 5 : 0, 5, n(chat.replies) + ' ข้อความ'));
    out.push(item('quote', 'ใบเสนอราคา', n(sales.quotes) >= 1 ? 10 : 0, 10, n(sales.quotes) + ' ใบ'));
    const jc = n(sales.jobCodes) + n(chat.leads);
    out.push(item('jobcode', 'สร้างรหัสงาน / lead', jc >= 1 ? 5 : 0, 5, jc + ' รายการ'));
    out.push(item('won', 'ปิดการขาย', n(sales.won) >= 1 ? 10 : 0, 10, n(sales.won) + ' งาน'));
    const cash = n(money.receipts) + n(money.slips);
    out.push(item('cash', 'รับเงิน / สลิปลูกค้า', cash >= 1 ? 5 : 0, 5, cash + ' รายการ'));
    const pd = n(work.projectsDone);
    out.push(item('projdone', 'จบงาน Projects', pd >= 2 ? 15 : pd === 1 ? 10 : 0, 15, pd + ' งาน'));
    const jcard = n(work.jobCards);
    out.push(item('jobcard', 'สร้าง Job card ผลิต', jcard >= 2 ? 10 : jcard === 1 ? 5 : 0, 10, jcard + ' ใบ'));
    const gc = n(work.graphicClaims);
    out.push(item('gclaim', 'ไม่มีงานเคลมจากกราฟิค', 10 - gc * 5, 10, gc ? 'เคลมจากกราฟิค ' + gc + ' งาน (หัก 5/งาน)' : 'ไม่มีงานเคลม'));
    const [g8, w8] = onTime(sub, 10); out.push(item('report', 'ส่ง Daily report', g8, 10, w8));
  } else if (role === 'support' && noChat) {
    /* Sale Support ที่ไม่วัดการตอบแชท (เปตอง · มิ้งค์) — ตัดหัวข้อแชท 40 คะแนน แล้วกระจายไปงานหลัก */
    const qj = n(sales.quotes) + n(sales.jobCodes);
    out.push(item('quote', 'ใบเสนอราคา / รหัสงาน', qj >= 2 ? 25 : qj === 1 ? 15 : 0, 25, qj + ' รายการ'));
    const pb = n(work.projects) + n(work.bookings);
    out.push(item('handoff', 'เปิด Project / จองคิวช่าง', pb >= 2 ? 25 : pb === 1 ? 15 : 0, 25, pb + ' รายการ'));
    /* 💬 v1.0.13 พี่เอ: "ถ้าทีมนี้ทำ การ update ติดตามลูกค้าในระบบนี้แล้ว คะแนนของเค้าต้องได้ด้วยนะ" ⇒ นับแชท/โทรที่บันทึกในแอป Visit */
    const fu = n(cust.visits) + n(cust.tasks) + n(cust.follows);
    out.push(item('follow', 'ติดตามลูกค้า (visit / แชท / โทร)', fu >= 1 ? 15 : 0, 15, fu + ' ครั้ง'));
    out.push(item('collect', 'ติดตามหนี้', n(money.followups) >= 1 ? 15 : 0, 15, n(money.followups) + ' ครั้ง'));
    const [g5, w5] = onTime(sub, 20); out.push(item('report', 'ส่ง Daily report', g5, 20, w5));
  } else if (role === 'support') {
    const [g1, w1] = neglect(chat.slaBreaches, 20, chat.slaMin); out.push(item('neglect', 'ไม่ทิ้งแชทให้ลูกค้ารอ', g1, 20, w1));
    const [g2, w2] = speed(chat.avgReplyMin, chat.replies, 15, 7); out.push(item('speed', 'เวลาตอบแชทเฉลี่ย', g2, 15, w2));
    out.push(item('quote', 'ใบเสนอราคา / รหัสงาน', n(sales.quotes) + n(sales.jobCodes) >= 1 ? 15 : 0, 15, (n(sales.quotes) + n(sales.jobCodes)) + ' รายการ'));
    const pb = n(work.projects) + n(work.bookings);
    out.push(item('handoff', 'เปิด Project / จองคิวช่าง', pb >= 1 ? 15 : 0, 15, pb + ' รายการ'));
    const fu = n(cust.visits) + n(cust.tasks) + n(cust.follows);   /* 💬 v1.0.13 นับแชท/โทรด้วย */
    out.push(item('follow', 'ติดตามลูกค้า (visit / แชท / โทร)', fu >= 1 ? 10 : 0, 10, fu + ' ครั้ง'));
    out.push(item('collect', 'ติดตามหนี้', n(money.followups) >= 1 ? 10 : 0, 10, n(money.followups) + ' ครั้ง'));
    out.push(item('care', 'ตอบลูกค้าต่อเนื่อง (≥ ' + C.SUPPORT_REPLY_MIN + ' ข้อความ)', n(chat.replies) >= C.SUPPORT_REPLY_MIN ? 5 : 0, 5, n(chat.replies) + ' ข้อความ'));
    const [g8, w8] = onTime(sub, 10); out.push(item('report', 'ส่ง Daily report', g8, 10, w8));
  } else if (noChat) {
    /* Sale B2B ที่ไม่วัดการตอบแชท (กุ๊งกิ๊ง · พลอย) — ตัดหัวข้อแชท 25 คะแนน แล้วกระจายไปงานขาย */
    const v = n(cust.visits);
    out.push(item('visit', 'visit / นัดลูกค้าใหม่', v >= 2 ? 30 : v === 1 ? 15 : 0, 30, v + ' ครั้ง'));
    out.push(item('prospect', 'ลูกค้าใหม่ที่หาเจอ', n(cust.prospects) >= 1 ? 15 : 0, 15, n(cust.prospects) + ' ราย'));
    out.push(item('quote', 'ใบเสนอราคา', n(sales.quotes) >= 1 ? 20 : 0, 20, n(sales.quotes) + ' ใบ'));
    const jc = n(sales.jobCodes) + n(chat.leads);
    out.push(item('jobcode', 'สร้างรหัสงาน / lead', jc >= 1 ? 10 : 0, 10, jc + ' รายการ'));
    out.push(item('collect', 'ติดตามหนี้', n(money.followups) >= 1 ? 10 : 0, 10, n(money.followups) + ' ครั้ง'));
    const [g6, w6] = onTime(sub, 15); out.push(item('report', 'ส่ง Daily report', g6, 15, w6));
  } else {
    /* 💬 v1.0.13 เซลส์ที่วัดแชท (ทีมขาย online) — ไม่ได้ออกไปหาลูกค้า ⇒ บันทึกการติดตามทางแชท/โทรนับแทน visit ได้ */
    const v = n(cust.visits) + n(cust.follows);
    out.push(item('visit', 'visit / ติดตามลูกค้า (แชท · โทร)', v >= 2 ? 20 : v === 1 ? 10 : 0, 20, n(cust.visits) + ' visit · ' + n(cust.follows) + ' ติดตาม'));
    out.push(item('prospect', 'ลูกค้าใหม่ที่หาเจอ', n(cust.prospects) >= 1 ? 10 : 0, 10, n(cust.prospects) + ' ราย'));
    out.push(item('quote', 'ใบเสนอราคา', n(sales.quotes) >= 1 ? 15 : 0, 15, n(sales.quotes) + ' ใบ'));
    const [g4, w4] = neglect(chat.slaBreaches, 15, chat.slaMin); out.push(item('neglect', 'ไม่ทิ้งแชทให้ลูกค้ารอ', g4, 15, w4));
    const [g5, w5] = speed(chat.avgReplyMin, chat.replies, 10, 5); out.push(item('speed', 'เวลาตอบแชทเฉลี่ย', g5, 10, w5));
    const jc = n(sales.jobCodes) + n(chat.leads);
    out.push(item('jobcode', 'สร้างรหัสงาน / lead', jc >= 1 ? 10 : 0, 10, jc + ' รายการ'));
    out.push(item('collect', 'ติดตามหนี้', n(money.followups) >= 1 ? 10 : 0, 10, n(money.followups) + ' ครั้ง'));
    const [g8, w8] = onTime(sub, 10); out.push(item('report', 'ส่ง Daily report', g8, 10, w8));
  }
  const total = Math.round(out.reduce((s, x) => s + x.got, 0) * 10) / 10;
  return { score: total, breakdown: out };
}

/**
 * คะแนนผลลัพธ์ของช่วง (0–100)
 * @param {'sale'|'support'} role
 * @param {{closed:number, supported:number}} r  ยอดก่อน VAT ในช่วง
 * @param {number} months  จำนวนเดือนของช่วง (ตามสัดส่วนวันที่ผ่านไปแล้ว)
 * @param {object} [targets]
 */
function result(role, r, months, targets) {
  const T = Object.assign({}, C.TARGETS, targets || {});
  const mo = Math.max(1 / 31, n(months));
  if (role === 'branch') {
    if (!T.branchPerMonth) return { score: null, goal: 0, got: n(r && r.closed) };
    const goal = T.branchPerMonth * mo, got = n(r && r.closed);
    return { score: Math.round(Math.min(100, got / goal * 100) * 10) / 10, goal, got };
  }
  if (role === 'support') {
    const goal = T.supportPerMonth * mo, got = n(r && r.supported);
    return { score: Math.round(Math.min(100, goal ? got / goal * 100 : 0) * 10) / 10, goal, got };
  }
  const goal = T.salePerMonth * mo, got = n(r && r.closed);
  return { score: Math.round(Math.min(100, goal ? got / goal * 100 : 0) * 10) / 10, goal, got };
}

/** ranking ช่วงยาว: 60% ผลลัพธ์ + 40% คะแนนรายวันเฉลี่ย · ช่วงรายวัน/สัปดาห์ = คะแนนรายวันล้วน */
function combine(kind, resultScore, avgDaily) {
  if (kind === 'day' || kind === 'week' || resultScore == null) return Math.round(n(avgDaily) * 10) / 10;
  return Math.round((C.W_RESULT * n(resultScore) + C.W_DAILY * n(avgDaily)) * 10) / 10;
}

module.exports = { daily, result, combine };
