'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/mgmt/health.js — ประเมินสุขภาพองค์กร เขียว / เหลือง / แดง
 *
 *  ‼ พี่เอกำหนดเกณฑ์ 3 ต.ค. 69 คำต่อคำ:
 *    "เกณฑ์ เขียว เหลือง แดง ดูที่ Cash flow และแนวโน้มยอดขายที่เพิ่มขึ้น หรือลดลงเป็นหลัก"
 *
 *  ⇒ ตัวหลัก 2 ตัว (กำหนดสีรวมขององค์กร — เอาตัวที่แย่กว่า)
 *      ① Cashflow        เงินเข้า − จ่ายออก ของ 3 เดือนล่าสุดที่จบแล้ว · เดือนล่าสุด · 15 วันข้างหน้า
 *      ② แนวโน้มยอดขาย   เฉลี่ย 3 เดือนล่าสุดที่จบแล้ว เทียบ 3 เดือนก่อนหน้า (เพิ่ม/ลด)
 *                         + เดือนที่ดูเทียบช่วงเดียวกันของเดือนก่อน (ใช้เมื่อผ่านไปแล้ว ≥ 7 วัน)
 *    ตัวประกอบ 10 ตัว — มีไฟของตัวเอง มีผลกับ "คะแนน" (20%) แต่ไม่เปลี่ยนสีรวม
 *    คะแนนรวม = Cashflow 40% + แนวโน้มยอดขาย 40% + เฉลี่ยตัวประกอบ 20%   (เขียว 100 · เหลือง 60 · แดง 20)
 *
 *  ‼ ไฟล์นี้เป็นฟังก์ชันล้วน — ไม่แตะฐานข้อมูล · ก้อนไหนอ่านไม่ได้ = "ประเมินไม่ได้" (ไม่เดาสี)
 * ═══════════════════════════════════════════════════════════════════ */
const PT = { good: 100, warn: 60, crit: 20 };
const RANK = { good: 1, warn: 2, crit: 3 };
const WORD = { good: 'เขียว', warn: 'เหลือง', crit: 'แดง', na: 'ประเมินไม่ได้' };

const fmt = n => Math.round(Number(n) || 0).toLocaleString('en-US');
/** เงิน: ≥ 1 ล้าน → "x.xx ล้านบาท" · ต่ำกว่านั้น → "x,xxx บาท" */
function money(n) {
  const v = Number(n) || 0, a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(2) + ' ล้านบาท';
  return fmt(v) + ' บาท';
}
const sign = n => (n > 0 ? '+' : '') ;
const smoney = n => sign(n) + money(n);
const pc = n => (n == null ? '–' : (n > 0 ? '+' : '') + n + '%');
const ok = p => !!(p && p.ok !== false);
const na = (key, t, why, rule) => ({ key, t, s: 'na', w: why, r: rule });
/* 📒 รอบ 233 (พี่เอ 4 ต.ค. 69: "เรายังดึงค่าใช้จ่ายมาไม่หมดนะ … เค้าไม่ได้คีย์ใน EXP 100% มันจะมีคีย์ไปที่รหัสผังบัญชีโดยตรง")
 *   เงินออกชุดนี้มาจากเอกสาร EXP (ชุดเดียวกับเมนู Cash Flow) — บอกไว้บนการ์ดตรง ๆ จนกว่าจะต่อส่วนที่ขาดเข้ามา
 *   ‼ เป็นข้อความกำกับเท่านั้น ไม่เปลี่ยนสี ไม่เปลี่ยนคะแนน */
const EXP_ONLY = 'เงินออกนับจากเอกสาร EXP ใน PEAK เท่านั้น — รายการที่บัญชีลงตรงรหัสผังบัญชียังไม่รวม ตัวเลขด้านนี้จึงอาจดูดีกว่าความจริง';
/* 💵 รอบ 235 — เมื่อ 3 เดือนที่ใช้ตัดสินมาจากสมุดเงินสดของ PEAK ครบ (ชุดเดียวกับเมนู Cash Flow ใหม่) ⇒ ไม่ต้องเตือนเรื่อง EXP แล้ว
 *   บอกที่มาแทน (info) · ยังปนกัน = เตือนตามเดิม + บอกว่าปน */
const BOOK_INFO = 'เงินเข้า–ออกนับจากบัญชีเงินสด/ธนาคารในสมุดบัญชี PEAK (ชุดเดียวกับเมนู Cash Flow) — รวมรายการที่บัญชีลงตรงรหัสผังบัญชีแล้ว';
const MIX_NOTE = 'บางเดือนยังนับเงินออกจากเอกสาร EXP (สมุดเงินสดจาก PEAK ยังดึงไม่ครบทุกเดือน) — ตัวเลขด้านนี้จึงอาจดีกว่าความจริง';
const srcNote = cash => {
  const b = cash && cash.book;
  if (b && b.done3) return { info: BOOK_INFO + (b.ok ? '' : ' · ⚠ บางเดือนยังตรวจกับงบทดลองไม่ผ่าน') };
  if (b && b.n > 0) return { note: MIX_NOTE };
  return { note: EXP_ONLY };
};
const lvl = (v, good, warn, higherBetter) => {
  if (v == null) return 'na';
  if (higherBetter) return v >= good ? 'good' : (v >= warn ? 'warn' : 'crit');
  return v < good ? 'good' : (v < warn ? 'warn' : 'crit');
};

function cashTile(cash) {
  const rule = 'เขียว: เงินเข้ามากกว่าจ่ายออก 3 เดือนล่าสุด + เดือนล่าสุด และ 15 วันข้างหน้าไม่ติดลบ · เหลือง: ไม่ผ่าน 1 ข้อ · แดง: 3 เดือนสุทธิติดลบ หรือไม่ผ่าน 2 ข้อ';
  if (!ok(cash)) return Object.assign(na('cash', 'Cashflow', 'อ่านข้อมูล Cash Flow ไม่ได้' + (cash && cash.err ? ' — ' + cash.err : ''), rule), { primary: true });
  if (!cash.hasExp) return Object.assign(na('cash', 'Cashflow', 'ยังไม่มีข้อมูลรายจ่ายจาก PEAK ในระบบ จึงคิดเงินสดสุทธิไม่ได้', rule), { primary: true });
  const d = cash.done3 || {}, last = d.last, f = cash.fc15 || {};
  if (!last) return Object.assign(na('cash', 'Cashflow', 'ยังไม่มีเดือนที่จบแล้วให้เทียบ', rule), { primary: true });
  const t3 = d.net > 0, t1 = last.net >= 0, tf = !(f.net < 0) && !f.firstNeg;
  const fails = [t3, t1, tf].filter(x => !x).length;
  const s = (!t3 || fails >= 2) ? 'crit' : (fails === 1 ? 'warn' : 'good');
  return { key: 'cash', t: 'Cashflow', s, primary: true, r: rule, ...srcNote(cash),
    w: 'สุทธิ 3 เดือน (' + (d.months || []).join(' · ') + ') ' + smoney(d.net) + ' · เดือนล่าสุด ' + smoney(last.net) + ' · 15 วันข้างหน้า ' + smoney(f.net),
    checks: [['3 เดือนล่าสุดเงินเข้ามากกว่าจ่ายออก', t3], ['เดือนล่าสุดที่จบแล้วไม่ติดลบ', t1], ['15 วันข้างหน้าเงินสดไม่ติดลบ', tf]] };
}

function salesTile(sales, cfg) {
  const c = (cfg && cfg.sales) || { trendGood: 0, trendBad: -10, paceBad: -10 };
  const rule = 'เขียว: ยอดขายเฉลี่ย 3 เดือนล่าสุดไม่ลดลง (≥ ' + c.trendGood + '%) · แดง: ลดลงถึง ' + c.trendBad + '% หรือลดต่อเนื่องถึงเดือนนี้ · นอกนั้นเหลือง';
  if (!ok(sales)) return Object.assign(na('trend', 'แนวโน้มยอดขาย', 'อ่านข้อมูลยอดขายไม่ได้' + (sales && sales.err ? ' — ' + sales.err : ''), rule), { primary: true });
  const t = sales.trend || {}, w = sales.win || {};
  if (t.trendPct == null) return Object.assign(na('trend', 'แนวโน้มยอดขาย', 'ข้อมูลยอดขายย้อนหลังยังไม่ครบ 6 เดือน จึงยังเทียบแนวโน้มไม่ได้', rule), { primary: true });
  const usePace = (w.full || w.days >= 7) && t.pacePct != null;
  let s;
  if (t.trendPct <= c.trendBad || (t.trendPct < c.trendGood && usePace && t.pacePct <= c.paceBad)) s = 'crit';
  else if (t.trendPct >= c.trendGood && (!usePace || t.pacePct > c.paceBad)) s = 'good';
  else s = 'warn';
  const dir = t.trendPct > 0 ? 'เพิ่มขึ้น' : (t.trendPct < 0 ? 'ลดลง' : 'ทรงตัว');
  return { key: 'trend', t: 'แนวโน้มยอดขาย', s, primary: true, r: rule,
    w: 'เฉลี่ย 3 เดือน (' + (t.m3 || []).join(' · ') + ') ' + money(t.avg3) + ' ต่อเดือน ' + dir + ' ' + pc(t.trendPct) + ' จาก 3 เดือนก่อนหน้า' +
       (usePace ? ' · ' + (w.full ? 'เดือนนี้' : 'เดือนนี้ถึงวันนี้') + ' ' + pc(t.pacePct) + ' เทียบเดือนก่อน' : (w.full ? '' : ' · เดือนนี้เพิ่งเริ่ม ' + w.days + ' วัน ยังไม่นำมาคิด')) };
}

function build(P, cfg) {
  cfg = cfg || {};
  const { sales, cash, ar, ops, stock } = P;
  const tiles = [cashTile(cash), salesTile(sales, cfg)];

  /* ── ตัวประกอบ ── */
  const cr = cfg.closeRate || { warn: 20, bad: 10 };
  /* เดือนที่ยังไม่จบและผ่านมาไม่ถึง 7 วัน: ตัวเลขยังน้อยจนแกว่ง ⇒ ไม่ตัดสินสี (ไม่เดา) */
  const early = ok(sales) && sales.win && !sales.win.full && sales.win.days < 7;
  if (ok(sales) && early) {
    const T = sales.total || {};
    tiles.push(na('close', 'ปิดการขาย', 'เดือนนี้เพิ่งเริ่ม ' + sales.win.days + ' วัน (งานเข้า ' + fmt(T.lead) + ' · ปิดได้ ' + fmt(T.cnt) + ') ยังไม่ประเมิน', 'ประเมินเมื่อผ่านไปอย่างน้อย 7 วัน'),
      na('ads', 'ช่องทาง & โฆษณา', 'เดือนนี้เพิ่งเริ่ม ' + sales.win.days + ' วัน ยังไม่ประเมินความคุ้มของงบโฆษณา', 'ประเมินเมื่อผ่านไปอย่างน้อย 7 วัน'));
  } else if (ok(sales)) {
    const T = sales.total || {};
    tiles.push({ key: 'close', t: 'ปิดการขาย', s: lvl(T.rate, cr.warn, cr.bad, true), r: 'เขียว: ปิดได้ ≥ ' + cr.warn + '% ของงานเข้า · แดง: ต่ำกว่า ' + cr.bad + '%',
      w: T.lead ? ('งานเข้า ' + fmt(T.lead) + ' · ปิดได้ ' + fmt(T.cnt) + ' งาน (' + (T.rate == null ? '–' : T.rate + '%') + ')' + (T.prevRate != null ? ' · ช่วงก่อน ' + T.prevRate + '%' : '')) : 'ยังไม่มีงานเข้าในช่วงนี้' });
    const A = sales.ads || {}, rows = A.rows || [], ro = A.roas || { good: 4, warn: 3 };
    const used = rows.reduce((s, x) => s + (x.used || 0), 0), nwAmt = rows.reduce((s, x) => s + (x.nwAmt || 0), 0);
    const roas = used > 0 ? Math.round(nwAmt / used * 10) / 10 : null;
    const low = rows.filter(x => x.roas != null).sort((a, b) => a.roas - b.roas)[0];
    tiles.push({ key: 'ads', t: 'ช่องทาง & โฆษณา', s: lvl(roas, ro.good, ro.warn, true), r: 'เขียว: ยอดขายลูกค้าใหม่ ≥ ' + ro.good + ' เท่าของงบ · แดง: ต่ำกว่า ' + ro.warn + ' เท่า',
      w: roas == null ? 'ยังไม่ได้ตั้งงบโฆษณา' : ('งบ ' + money(used) + ' ได้ยอดลูกค้าใหม่ ' + roas + ' เท่า' + (low ? ' · ต่ำสุด ' + low.name + ' ' + low.roas + ' เท่า' : '')) });
  } else {
    tiles.push(na('close', 'ปิดการขาย', 'อ่านข้อมูลยอดขายไม่ได้', ''), na('ads', 'ช่องทาง & โฆษณา', 'อ่านข้อมูลยอดขายไม่ได้', ''));
  }

  const ac = cfg.ar || { overduePctWarn: 30, overduePctBad: 50 };
  tiles.push(ok(ar)
    ? { key: 'ar', t: 'ลูกหนี้', s: ar.total > 0 ? lvl(ar.overduePct, ac.overduePctWarn, ac.overduePctBad, false) : 'good', r: 'เขียว: เกินกำหนด < ' + ac.overduePctWarn + '% ของยอดค้างรับ · แดง: ≥ ' + ac.overduePctBad + '%',
        w: ar.total > 0 ? ('ค้างรับ ' + money(ar.total) + ' · เกินกำหนด ' + ar.overduePct + '%' + (ar.over90 > 0 ? ' · เกิน 90 วัน ' + money(ar.over90) : '')) : 'ไม่มีลูกหนี้ค้างรับ' }
    : na('ar', 'ลูกหนี้', 'อ่านข้อมูลลูกหนี้ไม่ได้' + (ar && ar.err ? ' — ' + ar.err : ''), ''));

  const ec = cfg.expense || { toCashInWarn: 80, toCashInBad: 100 };
  if (ok(cash) && cash.hasExp && cash.done3 && cash.done3.cashIn > 0) {
    const p = Math.round(cash.done3.cashOut / cash.done3.cashIn * 1000) / 10;
    tiles.push({ key: 'expense', t: 'ค่าใช้จ่าย', ...srcNote(cash), s: lvl(p, ec.toCashInWarn, ec.toCashInBad, false), r: 'เขียว: จ่ายออก < ' + ec.toCashInWarn + '% ของเงินรับ (3 เดือน) · แดง: ≥ ' + ec.toCashInBad + '%',
      w: 'จ่ายออก 3 เดือน ' + money(cash.done3.cashOut) + ' = ' + p + '% ของเงินรับ' });
  } else tiles.push(na('expense', 'ค่าใช้จ่าย', ok(cash) ? 'ยังไม่มีข้อมูลรายจ่าย/เงินรับพอจะเทียบ' : 'อ่านข้อมูล Cash Flow ไม่ได้', ''));

  const sc = cfg.stock || { slowPctWarn: 10, slowPctBad: 20 };
  if (ok(stock) && ok(stock.counts) && ok(stock.analytics) && stock.counts.value > 0) {
    const p = Math.round(stock.analytics.slowValue / stock.counts.value * 1000) / 10;
    tiles.push({ key: 'stock', t: 'คลังสินค้า', s: lvl(p, sc.slowPctWarn, sc.slowPctBad, false), r: 'เขียว: ของไม่เคลื่อนไหวเกิน 90 วัน < ' + sc.slowPctWarn + '% ของมูลค่าคลัง · แดง: ≥ ' + sc.slowPctBad + '%',
      w: 'มูลค่าคลัง ' + money(stock.counts.value) + ' · ไม่เคลื่อนไหว ' + p + '% · ใกล้หมด ' + fmt(stock.counts.lowStock) + ' รายการ' });
  } else tiles.push(na('stock', 'คลังสินค้า', 'อ่านข้อมูลคลังไม่ได้ หรือยังไม่มีมูลค่าคลัง', ''));

  const o = ok(ops) ? ops : {};
  if (ok(o.projects)) {
    const p = o.projects.active ? Math.round(o.projects.overdue / o.projects.active * 1000) / 10 : 0;
    tiles.push({ key: 'projects', t: 'โปรเจกต์', s: lvl(p, 10, 25, false), r: 'เขียว: งานเลยกำหนดส่ง < 10% ของงานที่เปิดอยู่ · แดง: ≥ 25%',
      w: 'เปิดอยู่ ' + fmt(o.projects.active) + ' · เลยกำหนด ' + fmt(o.projects.overdue) + ' (' + p + '%) · งานด่วน ' + fmt(o.projects.urgent) });
  } else tiles.push(na('projects', 'โปรเจกต์', 'อ่านข้อมูลโปรเจกต์ไม่ได้', ''));

  const pc2 = cfg.production || { onTimeGood: 90, onTimeWarn: 75 };
  tiles.push(ok(o.production)
    ? { key: 'production', t: 'ผลิต', s: lvl(o.production.onTimePct, pc2.onTimeGood, pc2.onTimeWarn, true), r: 'เขียว: แพ็คทันกำหนดส่ง ≥ ' + pc2.onTimeGood + '% · แดง: ต่ำกว่า ' + pc2.onTimeWarn + '%',
        w: o.production.onTimePct == null ? ('ยังไม่มีงานครบกำหนดในช่วงนี้ · ใบเปิดอยู่ ' + fmt(o.production.open)) : ('ทันกำหนด ' + o.production.onTimePct + '% · เกินกำหนดเข้าคลัง ' + fmt(o.production.whOverdue) + ' ใบ · ใบเปิดอยู่ ' + fmt(o.production.open)) }
    : na('production', 'ผลิต', 'อ่านข้อมูล Job Card ไม่ได้', ''));

  const ic = cfg.install || { finishGood: 90, finishWarn: 75 };
  tiles.push(ok(o.install)
    ? { key: 'install', t: 'ติดตั้ง', s: lvl(o.install.finishRate, ic.finishGood, ic.finishWarn, true), r: 'เขียว: จบงาน ≥ ' + ic.finishGood + '% ของคิวที่มีทีมช่าง · แดง: ต่ำกว่า ' + ic.finishWarn + '%',
        w: o.install.total ? ('คิว ' + fmt(o.install.total) + ' · จบงาน ' + fmt(o.install.finished) + (o.install.finishRate == null ? '' : ' (' + o.install.finishRate + '%)') + ' · งานขาดทุน ' + fmt(o.install.lossJobs)) : 'ยังไม่มีคิวติดตั้งในช่วงนี้' }
    : na('install', 'ติดตั้ง', 'อ่านข้อมูลจองคิวไม่ได้', ''));

  tiles.push(ok(o.delivery)
    ? { key: 'delivery', t: 'ส่งมอบ', s: lvl(o.delivery.successPct, 95, 85, true), r: 'เขียว: ส่งสำเร็จ ≥ 95% ของเที่ยวที่ถึงกำหนด · แดง: ต่ำกว่า 85%',
        w: o.delivery.total ? ('เที่ยวส่ง ' + fmt(o.delivery.total) + ' · สำเร็จ ' + fmt(o.delivery.delivered) + ' · เลยกำหนด ' + fmt(o.delivery.overdue)) : 'ยังไม่มีแผนจัดส่งในช่วงนี้' }
    : na('delivery', 'ส่งมอบ', 'อ่านข้อมูลแผนจัดส่งไม่ได้', ''));

  if (ok(o.aftersale)) {
    const a = o.aftersale, p = a.open ? Math.round(a.overdue / a.open * 100) : 0;
    tiles.push({ key: 'aftersale', t: 'หลังการขาย', s: a.overdue === 0 ? 'good' : (p <= 20 ? 'warn' : 'crit'), r: 'เขียว: ไม่มีงานเกิน SLA · แดง: เกิน SLA มากกว่า 20% ของงานที่เปิดอยู่',
      w: 'เปิดอยู่ ' + fmt(a.open) + ' · เกิน SLA ' + fmt(a.overdue) });
  } else tiles.push(na('aftersale', 'หลังการขาย', 'อ่านข้อมูลหลังการขายไม่ได้', ''));

  /* ── สีรวม + คะแนน ── */
  const prim = tiles.filter(t => t.primary), sup = tiles.filter(t => !t.primary);
  const judged = prim.filter(t => t.s !== 'na');
  const color = judged.length ? judged.slice().sort((a, b) => RANK[b.s] - RANK[a.s])[0].s : 'na';
  const supJ = sup.filter(t => t.s !== 'na');
  const supAvg = supJ.length ? supJ.reduce((s, t) => s + PT[t.s], 0) / supJ.length : null;
  let wsum = 0, score = 0;
  prim.forEach(t => { if (t.s !== 'na') { score += PT[t.s] * 0.4; wsum += 0.4; } });
  if (supAvg != null) { score += supAvg * 0.2; wsum += 0.2; }
  score = wsum > 0 ? Math.round(score / wsum) : null;
  const count = { good: 0, warn: 0, crit: 0, na: 0 }; tiles.forEach(t => { count[t.s]++; });

  /* ── เวลาตลอดสาย ── */
  const cycle = [];
  if (ok(sales) && sales.total && sales.total.days != null) cycle.push(['ติดต่อ → ปิดการขาย', sales.total.days]);
  if (ok(o.lead) && o.lead.avg != null) cycle.push(['เปิดใบสั่งผลิต → ปิดงานผลิต', o.lead.avg]);
  if (ok(o.install) && o.install.avgLead != null && o.install.avgLead >= 0) cycle.push(['เข้าคิวติดตั้ง → จองช่างได้', o.install.avgLead]);
  if (ok(cash) && cash.dso != null && cash.dso >= 0) cycle.push(['วางบิล → รับเงิน', cash.dso]);

  /* ── วิเคราะห์ (ข้อความสร้างจากตัวเลขจริง · b = ตัวหนา · t = เนื้อ · a = สิ่งที่ควรทำ) ── */
  const ins = [];
  const cT = tiles[0], sT = tiles[1];
  if (cT.s !== 'na') ins.push({ s: cT.s, b: 'Cashflow ' + WORD[cT.s], t: cT.w, a: cT.s === 'good' ? '' : 'ดูรายการเจ้าหนี้ที่ครบกำหนดและลูกหนี้ที่ตามได้ก่อน' });
  if (sT.s !== 'na') ins.push({ s: sT.s, b: 'แนวโน้มยอดขาย ' + WORD[sT.s], t: sT.w, a: '' });
  if (ok(ar) && ar.over90 > 0) ins.push({ s: 'crit', b: 'ลูกหนี้เกิน 90 วัน ' + money(ar.over90), t: (ar.topOld && ar.topOld[0]) ? 'ค้างนานสุด ' + ar.topOld[0].name + ' ' + fmt(ar.topOld[0].oldest) + ' วัน (' + money(ar.topOld[0].amt) + ')' : '', a: 'นัดวางบิลและติดตามสัปดาห์นี้' });
  if (ok(sales)) {
    const chs = (sales.ch || []).filter(c => c.lead > 0 || c.amt > 0);
    const top = chs.slice().sort((a, b) => b.amt - a.amt)[0], T = sales.total || {};
    if (top && T.amt > 0) ins.push({ s: 'good', b: top.n + ' ทำยอดขายสูงสุด ' + money(top.amt), t: Math.round(top.amt / T.amt * 100) + '% ของยอดขายช่วงนี้' + (top.diffPct != null ? ' · ' + pc(top.diffPct) + ' จากช่วงก่อน' : ''), a: '' });
    const onl = chs.find(c => c.n === 'Online');
    if (onl && onl.lead >= 10) {
      const lost = Math.round(onl.lost / onl.lead * 100);
      if (lost >= 35) ins.push({ s: 'warn', b: 'Online จบที่ "ไม่ซื้อ" ' + lost + '% ของงานเข้า', t: 'งานเข้า ' + fmt(onl.lead) + ' · ยังตามอยู่ ' + fmt(onl.open) + ' งาน', a: 'ตามงาน Onprocess ให้จบ' });
    }
    const down = chs.filter(c => c.diffPct != null && c.diffPct <= -20 && c.prevAmt >= 100000).sort((a, b) => a.diffPct - b.diffPct)[0];
    if (down && (sales.win.full || sales.win.days >= 7)) ins.push({ s: 'warn', b: down.n + ' ยอดขายลด ' + Math.abs(down.diffPct) + '%', t: money(down.prevAmt) + ' → ' + money(down.amt), a: '' });
    const A = sales.ads || {}, rows = early ? [] : (A.rows || []).filter(x => x.roas != null);
    if (rows.length) {
      const best = rows.slice().sort((a, b) => b.roas - a.roas)[0], worst = rows.slice().sort((a, b) => a.roas - b.roas)[0], ro = A.roas || { good: 4, warn: 3 };
      ins.push({ s: best.roas >= ro.good ? 'good' : 'warn', b: best.name + ' คุ้มที่สุด', t: 'งบ 1 บาทได้ยอดขายลูกค้าใหม่ ' + best.roas + ' บาท', a: '' });
      if (worst.key !== best.key && worst.roas < ro.warn) ins.push({ s: 'crit', b: worst.name + ' ได้กลับ ' + worst.roas + ' เท่า', t: 'งบ ' + money(worst.used) + ' ได้ยอดลูกค้าใหม่ ' + money(worst.nwAmt), a: 'ทบทวนงบช่องทางนี้' });
    }
    if (T.cnt > 0 && sales.newAmtPct != null) ins.push({ s: 'good', b: 'ลูกค้าเก่าทำยอดขาย ' + Math.round(100 - sales.newAmtPct) + '%', t: 'จากงานที่ปิดได้ ' + (T.cnt - T.nw) + ' งาน (ลูกค้าใหม่ ' + T.nw + ' งาน)', a: '' });
  }
  if (ok(o.production) && o.production.waiting && o.production.waiting[0]) {
    const w0 = o.production.waiting[0];
    ins.push({ s: o.production.whOverdue > 0 ? 'warn' : 'good', b: 'สถานี ' + w0[0] + ' มีงานรอ ' + fmt(w0[1]) + ' ใบ', t: 'ใบสั่งผลิตเปิดอยู่ ' + fmt(o.production.open) + ' ใบ' + (o.production.whOverdue ? ' · เกินกำหนดเข้าคลัง ' + fmt(o.production.whOverdue) + ' ใบ' : ''), a: o.production.whOverdue ? 'เร่งใบที่เกินกำหนดก่อน' : '' });
  }
  if (ok(stock) && ok(stock.analytics) && stock.analytics.slowValue > 0) ins.push({ s: 'warn', b: 'ของไม่เคลื่อนไหวเกิน 90 วัน ' + money(stock.analytics.slowValue), t: fmt(stock.analytics.slowN) + ' รายการ' + (ok(stock.counts) ? ' · ขณะที่ใกล้หมด ' + fmt(stock.counts.lowStock) + ' รายการ' : ''), a: 'ทบทวนรายการที่สั่งซื้อ' });
  if (ok(cash) && cash.ap && cash.ap.overdue > 0) ins.push({ s: 'warn', b: 'เจ้าหนี้เลยกำหนดจ่าย ' + money(cash.ap.overdue), t: fmt(cash.ap.overdueN) + ' ใบ · ครบกำหนดใน 30 วัน ' + money(cash.ap.due30), a: '' });

  return { ok: true, color, word: WORD[color], score, count, tiles, cycle, insights: ins.slice(0, 10),
           rule: 'สีรวม = ตัวที่แย่กว่าระหว่าง Cashflow กับ แนวโน้มยอดขาย (ตามที่พี่เอกำหนด) · ด้านอื่นเป็นตัวประกอบ มีผลกับคะแนน 20%' };
}

module.exports = { build, cashTile, salesTile, money, WORD, PT };
