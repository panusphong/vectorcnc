'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/mgmt/data.js — ตัวรวบรวมตัวเลขของ Management Report
 *
 *  พี่เอสั่ง 3 ต.ค. 69:
 *    "มาทำ app Management Report ให้พี่ด้วย โดยนำ ทุก app ใน CRM Hub มาสร้างเป็น Dash board
 *     ที่มีสรุปจบทุกอย่างในหน้าเดียว เพื่อตรวจสอบสุขภาพองค์กร ตั้งแต่ จำนวนงานที่เข้ามาจากฝั่งขาย
 *     โปรเจค การปิดการขาย การรับเงิน การเก็บเงิน ลูกหนี้ กลุ่มลูกค้าในแต่ละช่องทาง
 *     ระยะเวลาในการผลิต การติดตั้ง ส่งมอบ วิเคราะห์ ออกมาในรูปแบบ Dash Board"
 *
 *  ── หลักของไฟล์นี้ ───────────────────────────────────────────────
 *   ① 🔴 อ่านอย่างเดียว — ไม่มี insert / update / upsert / remove สักคำ
 *      PEAK: ไม่เรียก PEAK เลย อ่านเฉพาะตารางที่ซิงก์มาไว้แล้ว
 *   ② ใช้ "ตัวคิดเลขตัวเดิม" ของแต่ละแอปทุกที่ที่มี ⇒ ตัวเลขตรงกับหน้าแอปนั้น
 *      (Cash Flow · ลูกหนี้ · สรุปวันนี้ของ Job Card · จองคิว · คลัง · ใบขอซื้อ · หลังการขาย)
 *      ‼ require ไฟล์ย่อยตรง ๆ เท่านั้น ห้าม require index.js ของแอปอื่น
 *        (index.js ของหลายแอปลงทะเบียนเส้นทาง/ตั้งเวลาอัตโนมัติตอนโหลด)
 *   ③ 🔴 "แอปต้องเร็ว ห้ามโหลดของที่ไม่จำเป็น" + บทเรียน CPU ฐานหมด
 *      · ตารางขายอ่านครั้งเดียวแบบเลือกช่อง แล้วจำ 10 นาที
 *      · ทุกก้อนจำผล 10 นาที + คำขอซ้อนกันรอผลเดียวกัน (ไม่ยิงฐานซ้ำ)
 *      · ก้อนไหนพัง ก้อนนั้นบอกเหตุ — ไม่ลากทั้งหน้าพัง และไม่ใส่เลขเดา
 *   ④ เดือนปัจจุบันยังไม่จบ ⇒ เทียบกับ "ช่วงวันเดียวกันของเดือนก่อน" ไม่เทียบกับทั้งเดือน
 * ═══════════════════════════════════════════════════════════════════ */
const db = require('../../core/db');
const TD = require('../../core/thai-date');

const TTL = Number(process.env.MGMT_CACHE_MS || 600000);          /* 10 นาที */
const clean = v => String(v == null ? '' : v).trim();
const num = v => {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
};
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const p2 = n => (n < 10 ? '0' : '') + n;
const pctOf = (a, b) => (b > 0 ? Math.round(a / b * 1000) / 10 : null);
const chg = (a, b) => (b > 0 ? Math.round((a - b) / b * 1000) / 10 : null);

/* ── วันที่ ─────────────────────────────────────────────────────── */
/** ค่าช่องวันที่ (date ของฐาน = 'YYYY-MM-DD' · ข้อมูลเก่าอาจเป็น d/m/yyyy พ.ศ.) → 'YYYY-MM-DD' */
function ymd(v) {
  const s = clean(v); if (!s) return '';
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) { let y = +m[1]; if (y >= 2400) y -= 543; return y + '-' + m[2] + '-' + m[3]; }
  m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/.exec(s);
  if (m) { let y = +m[3]; if (y >= 2400) y -= 543; return y + '-' + p2(+m[2]) + '-' + p2(+m[1]); }
  return '';
}
/** ค่าช่องเวลา (timestamptz) → วันที่ตามเวลาไทย */
function thDay(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? ymd(v) : TD.todayTH(d);
}
const TH_M = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_MF = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const mLabel = ym => TH_M[+ym.slice(5, 7)] + ' ' + String((+ym.slice(0, 4) + 543) % 100);
const mLabelFull = ym => TH_MF[+ym.slice(5, 7)] + ' ' + (+ym.slice(0, 4) + 543);
const lastDay = ym => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
function addMonth(ym, n) {
  const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1));
  return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1);
}
const monthsBack = (ym, n) => { const a = []; for (let i = n - 1; i >= 0; i--) a.push(addMonth(ym, -i)); return a; };
const daysBetween = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
/** เวลาไทย 00:00 ของวันนั้น เป็น ISO (UTC) — ใช้กรองช่อง timestamptz โดยไม่ต้องมีเครื่องหมาย + ใน URL */
const thStartIso = d => new Date(d + 'T00:00:00+07:00').toISOString();
const nextDay = d => { const x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + 1)); return x.getUTCFullYear() + '-' + p2(x.getUTCMonth() + 1) + '-' + p2(x.getUTCDate()); };

/** ช่วงเวลาที่ดู: เดือนที่เลือก + ช่วงเทียบ (เดือนก่อน "จำนวนวันเท่ากัน") */
function winOf(ymIn, todayIn) {
  const today = todayIn || TD.todayTH();
  const cur = today.slice(0, 7);
  let ym = /^\d{4}-\d{2}$/.test(clean(ymIn)) ? clean(ymIn) : cur;
  if (ym > cur) ym = cur;
  if (ym < addMonth(cur, -11)) ym = addMonth(cur, -11);
  const full = ym < cur;
  const from = ym + '-01';
  const to = full ? ym + '-' + p2(lastDay(ym)) : today;
  const prevYm = addMonth(ym, -1);
  const dom = +to.slice(8, 10);
  const prevTo = full ? prevYm + '-' + p2(lastDay(prevYm)) : prevYm + '-' + p2(Math.min(dom, lastDay(prevYm)));
  return {
    ym, from, to, full, today, days: dom, daysInMonth: lastDay(ym),
    prevYm, prevFrom: prevYm + '-01', prevTo,
    label: mLabelFull(ym), short: mLabel(ym), prevLabel: mLabelFull(prevYm),
    rangeText: full ? ('ทั้งเดือน ' + mLabelFull(ym)) : ('1–' + dom + ' ' + mLabelFull(ym) + ' (เดือนยังไม่จบ)'),
    cmpText: full ? ('เทียบกับทั้งเดือน ' + mLabelFull(prevYm)) : ('เทียบกับ 1–' + (+prevTo.slice(8, 10)) + ' ' + mLabelFull(prevYm) + ' (ช่วงเดียวกัน)'),
  };
}
function monthOptions(todayIn) {
  const cur = (todayIn || TD.todayTH()).slice(0, 7);
  return monthsBack(cur, 12).reverse().map(ym => ({ ym, label: mLabelFull(ym) + (ym === cur ? ' (เดือนนี้)' : '') }));
}

/* ── ที่จำผล: จำ 10 นาที · คำขอที่มาซ้อนกันรอผลเดียวกัน · ไม่จำผลที่พัง ── */
const _memo = new Map();
function memo(key, fn, ttl) {
  const h = _memo.get(key);
  if (h && h.done && Date.now() - h.at < (ttl || TTL)) return Promise.resolve(h.v);
  if (h && h.p) return h.p;
  const p = Promise.resolve().then(fn).then(
    v => { _memo.set(key, { done: true, at: Date.now(), v }); return v; },
    e => { _memo.delete(key); throw e; });
  _memo.set(key, { p });
  return p;
}
function dropAll() { _memo.clear(); }
const errText = e => String((e && e.message) || e || 'ไม่ทราบสาเหตุ').replace(/\s+/g, ' ').slice(0, 220);
/** ก้อนย่อยที่พังได้โดยไม่ลากก้อนอื่น — คืน { ok:false, err } แทนการโยน */
async function safe(fn) {
  try { const v = await fn(); return Object.assign({ ok: true }, v); }
  catch (e) { return { ok: false, err: errText(e) }; }
}

/* ═══════════════════════════════════════════════════════════════════
 *  ① ขาย · ช่องทาง · ลูกค้าใหม่/เก่า · Online · งบโฆษณา
 *     ต้นทาง: app.total_sales (แอปคีย์ยอดขาย)
 *     ยอดขายของแถว = ตัวเดียวกับรายงานในคีย์ยอดขาย (_saleOf + saleSrc ของ biz-report)
 *     ช่องทาง 5 กลุ่ม = _channel3 · กลุ่ม Online 6 กลุ่ม = channelGroup + ONLINE_GROUPS (online-report)
 * ═══════════════════════════════════════════════════════════════════ */
const SALES_COLS = [
  '_row', 'วันที่ติดต่อ', 'วันที่ปิดการขาย', 'Lead Status', 'ยอดขาย (บาท)', 'ยอดขาย PEAK', 'สถานะชำระ PEAK',
  'ประเภทลูกค้า', 'ลูกค้ามาจากไหน', 'ชื่อช่อง / Platform', 'บริษัทที่ขาย', 'เลขที่ QO / IV',
  'เลขที่ใบเสนอราคา PEAK', 'ยอดประเมินราคา', 'รับจริง (บาท)', 'รับชำระแล้ว PEAK',
  'ยอด (บาท)', 'ยอด งวด 1 (บาท)', 'ยอด งวด 2 (บาท)', 'ยอด งวด 3 (บาท)',
];
const CHANNELS = ['Online', 'B2B', 'สาขา', 'Partner', 'ผู้บริหาร'];
const DOW = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

function salesRows() {
  return memo('sales-rows', async () => {
    let rows;
    try {
      rows = await db.selectAll('total_sales', { select: SALES_COLS.map(c => '"' + c + '"').join(','), order: '_row.asc' });
    } catch (e) {
      /* ฐานจริงขาดช่องใดช่องหนึ่ง ⇒ ถอยไปอ่านทั้งแถว (ช้ากว่า แต่ตัวเลขไม่หาย) — ท่าเดียวกับ Cash Flow */
      console.warn('[mgmt] อ่านตารางขายแบบเลือกช่องไม่ได้ ถอยไปอ่านทั้งแถว:', errText(e));
      rows = await db.selectAll('total_sales', { select: '*', order: '_row.asc' });
    }
    const OR = require('../sales/online-report');
    const BR = require('../sales/biz-report');
    const src = await BR.saleSrc();
    const grpKey = {}; OR.ONLINE_GROUPS.forEach(g => { grpKey[g.src] = g.key; });
    const list = [];
    for (const r of (rows || [])) {
      const st = clean(r['Lead Status']);
      const won = /ปิดการขาย/.test(st);
      const c = ymd(r['วันที่ติดต่อ']);
      const d0 = ymd(r['วันที่ปิดการขาย']);
      if (!c && !d0) continue;
      const plat = clean(r['ชื่อช่อง / Platform']);
      const ch = OR._channel3(r);
      const paid = num(r['รับชำระแล้ว PEAK']) || num(r['รับจริง (บาท)']) ||
        (num(r['ยอด (บาท)']) + num(r['ยอด งวด 1 (บาท)']) + num(r['ยอด งวด 2 (บาท)']) + num(r['ยอด งวด 3 (บาท)']));
      list.push({
        c, d: won ? (d0 || c) : '', noClose: won && !d0,
        st: won ? 'won' : (/ไม่ซื้อ/.test(st) ? 'lost' : 'open'),
        amt: won ? num(BR._saleOf(r, src)) : 0,
        ch, og: ch === 'Online' ? (grpKey[OR.channelGroup(plat)] || 'other') : '',
        plat, isNew: /ใหม่/.test(clean(r['ประเภทลูกค้า'])),
        quote: !!(clean(r['เลขที่ใบเสนอราคา PEAK']) || clean(r['เลขที่ QO / IV']) || num(r['ยอดประเมินราคา']) > 0),
        paid: paid > 0,
      });
    }
    return { src, list, n: (rows || []).length, groups: OR.ONLINE_GROUPS.map(g => ({ key: g.key, label: g.label })) };
  });
}

const inR = (d, a, b) => !!d && d >= a && d <= b;
const blank = () => ({ lead: 0, won: 0, open: 0, lost: 0, amt: 0, cnt: 0, prevAmt: 0, prevCnt: 0, prevLead: 0, nw: 0, nwAmt: 0, dSum: 0, dN: 0 });
function fin(b) {
  const o = {
    lead: b.lead, won: b.won, open: b.open, lost: b.lost, amt: r2(b.amt), cnt: b.cnt,
    prevAmt: r2(b.prevAmt), prevCnt: b.prevCnt, prevLead: b.prevLead, nw: b.nw, nwAmt: r2(b.nwAmt),
    days: b.dN ? Math.round(b.dSum / b.dN * 10) / 10 : null,
    /* อัตราปิด = งานที่ปิดได้ในช่วงนี้ ÷ งานเข้าในช่วงนี้ (นับตามวันที่ปิด กับ วันที่ติดต่อ) */
    rate: pctOf(b.cnt, b.lead), prevRate: pctOf(b.prevCnt, b.prevLead), diffPct: chg(b.amt, b.prevAmt), avg: b.cnt ? Math.round(b.amt / b.cnt) : null,
  };
  return o;
}
/** สะสมแถวขาย 1 แถวเข้าถัง ตามช่วงที่ดู */
function addRow(b, x, w) {
  if (inR(x.c, w.from, w.to)) { b.lead++; b[x.st]++; }
  if (inR(x.c, w.prevFrom, w.prevTo)) b.prevLead++;
  if (x.st === 'won') {
    if (inR(x.d, w.from, w.to)) {
      b.amt += x.amt; b.cnt++;
      if (x.isNew) { b.nw++; b.nwAmt += x.amt; }
      if (x.c && x.d >= x.c) { const dd = daysBetween(x.c, x.d); if (dd <= 365) { b.dSum += dd; b.dN++; } }
    }
    if (inR(x.d, w.prevFrom, w.prevTo)) { b.prevAmt += x.amt; b.prevCnt++; }
  }
}
const squash = s => String(s || '').toLowerCase().replace(/\s+/g, '');

async function salesPart(ym, cfg) {
  const w = winOf(ym);
  const S = await salesRows();
  const ms = monthsBack(w.ym, 13);                       /* 13 เดือน: 12 เดือนบนกราฟ + เดือนเดียวกันปีก่อน */
  const idx = {}; ms.forEach((m, i) => { idx[m] = i; });
  const ser = ms.map(() => ({ amt: 0, cnt: 0, lead: 0, onlLead: 0, onlCnt: 0 }));
  const chSer = {}; CHANNELS.forEach(c => { chSer[c] = ms.map(() => 0); });
  const tot = blank(), ch = {}, og = {}, ads = {}, webOther = blank(), plats = {};
  CHANNELS.forEach(c => { ch[c] = blank(); });
  S.groups.forEach(g => { og[g.key] = blank(); });
  const adLines = (cfg && cfg.ads) || [];
  adLines.forEach(a => { ads[a.key] = blank(); });
  const dow = [0, 0, 0, 0, 0, 0, 0];
  const fun = { lead: 0, quote: 0, won: 0, paid: 0 };
  let noClose = 0;

  for (const x of S.list) {
    /* อนุกรมรายเดือน */
    if (x.c && idx[x.c.slice(0, 7)] != null) {
      const s = ser[idx[x.c.slice(0, 7)]]; s.lead++;
      if (x.ch === 'Online') s.onlLead++;
    }
    if (x.st === 'won' && idx[x.d.slice(0, 7)] != null) {
      const i = idx[x.d.slice(0, 7)]; ser[i].amt += x.amt; ser[i].cnt++;
      if (x.ch === 'Online') ser[i].onlCnt++;
      if (chSer[x.ch]) chSer[x.ch][i] += x.amt;
    }
    /* ช่วงที่ดู */
    addRow(tot, x, w);
    if (ch[x.ch]) addRow(ch[x.ch], x, w);
    if (x.noClose && inR(x.d, w.from, w.to)) noClose++;
    if (inR(x.c, w.from, w.to)) { fun.lead++; if (x.quote || x.st === 'won') fun.quote++; }
    if (x.st === 'won' && inR(x.d, w.from, w.to)) { fun.won++; if (x.paid) fun.paid++; }
    if (x.ch === 'Online') {
      if (og[x.og]) addRow(og[x.og], x, w);
      if (inR(x.c, w.from, w.to)) dow[new Date(x.c + 'T00:00:00Z').getUTCDay()]++;
      /* งบโฆษณา: เว็บ 2 เว็บจับจากชื่อช่อง · Facebook / TikTok จับทั้งกลุ่ม */
      let line = null;
      for (const a of adLines) {
        if (a.group !== x.og) continue;
        if (a.group !== 'web') { line = a; break; }
        const p = squash(x.plat);
        if ((a.match || []).some(k => k && p.indexOf(k) >= 0)) { line = a; break; }
      }
      if (line) addRow(ads[line.key], x, w);
      else if (x.og === 'web') addRow(webOther, x, w);
      if (x.og === 'web' && (inR(x.c, w.from, w.to) || (x.st === 'won' && inR(x.d, w.from, w.to)))) {
        const k = x.plat || '(ไม่ระบุชื่อช่อง)';
        if (!plats[k]) plats[k] = { name: k, lead: 0, amt: 0, line: line ? line.name : '' };
        if (inR(x.c, w.from, w.to)) plats[k].lead++;
        if (x.st === 'won' && inR(x.d, w.from, w.to)) plats[k].amt += x.amt;
      }
    }
  }

  const last12 = ms.slice(1), s12 = ser.slice(1);
  /* แนวโน้มยอดขาย: 3 เดือนล่าสุด "ที่จบแล้ว" เทียบ 3 เดือนก่อนหน้า */
  const endI = w.full ? 12 : 11;                         /* ตำแหน่งเดือนล่าสุดที่จบแล้วใน ser (13 ช่อง) */
  const m3 = [endI - 2, endI - 1, endI], q3 = [endI - 5, endI - 4, endI - 3];
  const avg = a => a.reduce((s, i) => s + (ser[i] ? ser[i].amt : 0), 0) / a.length;
  const avg3 = avg(m3), prev3 = avg(q3);
  const T = fin(tot);
  const adRows = adLines.map(a => {
    const f = fin(ads[a.key]);
    const used = w.full ? a.budget : Math.round(a.budget * w.days / w.daysInMonth);
    return { key: a.key, name: a.name, group: a.group, budget: a.budget, used, lead: f.lead, cnt: f.cnt, amt: f.amt, nw: f.nw, nwAmt: f.nwAmt,
             roas: used > 0 ? Math.round(f.nwAmt / used * 10) / 10 : null };
  });
  return {
    ok: true, win: w, src: S.src, rowsRead: S.n, noClose,
    months: last12.map(mLabel), ms: last12,
    sales: s12.map(s => r2(s.amt)), cnt: s12.map(s => s.cnt), leads: s12.map(s => s.lead),
    rate: s12.map(s => pctOf(s.cnt, s.lead)),
    total: T,
    newPct: pctOf(tot.nw, tot.cnt), newAmtPct: pctOf(tot.nwAmt, tot.amt),
    funnel: [['งานเข้า', fun.lead], ['มีใบเสนอราคา / ยอดประเมิน', fun.quote], ['ปิดการขาย', fun.won], ['รับเงินแล้ว', fun.paid]],
    ch: CHANNELS.map(c => Object.assign({ n: c, tr: chSer[c].slice(7).map(r2) }, fin(ch[c]))),
    onl: S.groups.map(g => Object.assign({ key: g.key, n: g.label }, fin(og[g.key]))),
    onlDow: [1, 2, 3, 4, 5, 6, 0].map(i => [DOW[i], dow[i]]),
    onlRate: ser.slice(7).map(s => pctOf(s.onlCnt, s.onlLead)), m6: ms.slice(7).map(mLabel),
    ads: {
      rows: adRows, webOther: fin(webOther), prorated: !w.full, days: w.days, daysInMonth: w.daysInMonth,
      platforms: Object.values(plats).map(p => ({ name: p.name, lead: p.lead, amt: r2(p.amt), line: p.line })).sort((a, b) => b.lead - a.lead || b.amt - a.amt).slice(0, 30),
      roas: (cfg && cfg.roas) || { good: 4, warn: 3 },
    },
    trend: {
      avg3: r2(avg3), prev3: r2(prev3), trendPct: chg(avg3, prev3),
      m3: m3.map(i => mLabel(ms[i])), q3: q3.map(i => mLabel(ms[i])),
      pacePct: T.diffPct, yoyPct: chg(ser[12].amt, ser[0].amt), yoyFull: w.full, yoyLabel: mLabel(ms[0]),
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════
 *  ② Cashflow · ค่าใช้จ่าย — ตัวคิดเลขตัวเดียวกับหน้า Cash Flow ในคีย์ยอดขาย
 *     (modules/sales/cashflow.js cashFlowReport) — อ่านตารางที่ซิงก์จาก PEAK ไว้แล้ว ไม่เรียก PEAK
 *     ‼ รายงานตัวเต็มใหญ่มาก (~680 KB) ⇒ หยิบเฉพาะตัวเลขที่ใช้ ไม่ส่งต่อทั้งก้อน
 * ═══════════════════════════════════════════════════════════════════ */
const BIZ = ['มดงานการป้าย', 'The 101'];

function cashRaw(user) {
  return memo('cash-raw', async () => {
    const CF = require('../sales/cashflow');
    const R = await CF.cashFlowReport(user, { months: 14 });
    if (!R || R.ok === false) throw new Error((R && R.msg) || 'อ่านรายงาน Cash Flow ไม่ได้');
    let expRows = [];
    try { expRows = await require('../../core/peak-expenses').allRows(); } catch (e) { expRows = []; }
    return { R, expRows, CF };
  });
}

async function cashPart(ym, user) {
  const w = winOf(ym);
  const { R, expRows, CF } = await cashRaw(user);
  const all = (R.months || []).map(m => ({ ym: m.ym, cashIn: r2(m.cashIn), cashOut: r2(m.cashOut), net: r2(num(m.cashIn) - num(m.cashOut)), sales: r2(m.sales), dso: m.dso == null ? null : m.dso }));
  /* 💵 รอบ 235 — พี่เอ 4 ต.ค. 69: "ให้มันเป็นข้อมูลชุดเดียวกันกับ เมนูงาน Cash flow ด้วยนะ" + "ดึงจาก peak"
   *   เมนู Cash Flow ใหม่นับเงินเข้า–ออกจากบัญชีเงินสด/ธนาคารในสมุดบัญชี PEAK (modules/sales/cashbook.js monthTotals)
   *   ⇒ เดือนไหนสมุดเงินสดมีข้อมูลครบทุกบริษัท ใช้ตัวเลขชุดนั้น (รวมรายการที่ลงตรงรหัสผังบัญชีแล้ว · ตัดรายการระหว่าง 2 บริษัท)
   *   เดือนที่ยังไม่มี ⇒ ใช้ตัวคิดเดิม (เอกสาร EXP) ไปก่อน แล้วบอกบนการ์ดว่ายังปนกันอยู่ — ไม่สลับเงียบ ๆ */
  let book = {};
  try {
    if (all.length) book = await memo('cash-book', () => require('../sales/cashbook').monthTotals(all[0].ym, all[all.length - 1].ym));
  } catch (e) { book = {}; }
  all.forEach(m => {
    const b = book[m.ym];
    if (b && b.full) { m.cashIn = b.in; m.cashOut = b.out; m.net = r2(b.in - b.out); m.book = true; m.bookOk = !!b.ok; m.bankEnd = b.end; }
  });
  const at = all.findIndex(m => m.ym === w.ym);
  const upto = at >= 0 ? all.slice(0, at + 1) : all;
  const m12 = upto.slice(-12);
  const cur = at >= 0 ? all[at] : { ym: w.ym, cashIn: 0, cashOut: 0, net: 0, sales: 0, dso: null };
  const prev = at > 0 ? all[at - 1] : null;
  /* 3 เดือนล่าสุดที่จบแล้ว (เดือนที่ดูถ้าจบแล้ว นับรวม) */
  const doneTo = w.full ? at : at - 1;
  const done3 = doneTo >= 0 ? all.slice(Math.max(0, doneTo - 2), doneTo + 1) : [];
  const byBiz = {};
  const bm = R.byBizMonthly && (R.byBizMonthly.rows || []).find(x => x.ym === w.ym);
  const bmPrev = R.byBizMonthly && (R.byBizMonthly.rows || []).find(x => x.ym === w.prevYm);
  BIZ.forEach(b => {
    const c = bm && (bm.cells || []).find(x => x.biz === b);
    const cp = bmPrev && (bmPrev.cells || []).find(x => x.biz === b);
    byBiz[b] = { out: r2(c && c.out), inn: r2(c && c.inn), prevOut: r2(cp && cp.out) };
    /* สมุดเงินสดมีของเดือนนี้ ⇒ ยอดรายบริษัทใช้ชุดเดียวกัน (รายบริษัทไม่ตัดรายการระหว่างกัน — เป็นเงินจริงของบริษัทนั้น) */
    const bk = book[w.ym] && book[w.ym].full && book[w.ym].biz[b], bkp = book[w.prevYm] && book[w.prevYm].full && book[w.prevYm].biz[b];
    if (bk) { byBiz[b].out = bk.out; byBiz[b].inn = bk.in; byBiz[b].bankEnd = bk.end; }
    if (bkp) byBiz[b].prevOut = bkp.out;
  });
  const top = {};
  BIZ.forEach(b => {
    try {
      const t = CF._topExpMonth(expRows, w.ym, b, 5);
      top[b] = {
        total: r2(t.total), owe: r2(t.owe), docN: t.docN,
        rows: ((t.vendor && t.vendor.rows) || []).map(v => ({ name: v.name, amt: r2(v.amt), net: r2(v.net), owe: r2(v.owe), cnt: v.cnt, pct: v.pct })),
        shown: r2(t.vendor && t.vendor.shown),
      };
    } catch (e) { top[b] = { err: errText(e), rows: [], total: 0, owe: 0, docN: 0, shown: 0 }; }
  });
  const fc = (R.forecast || []).map(x => ({ k: x.k, t: x.t, amt: r2(x.amt), n: x.n }));
  const ap = R.apAging || {};
  const f15 = R.fc15 || {};
  return {
    ok: true, win: w, hasExp: !!R.hasExp || !!cur.book, expNote: clean(R.expNote).slice(0, 300), hasCf: !!R.hasCf,
    /* ที่มาของเงินเข้า–ออก: สมุดเงินสดจาก PEAK กี่เดือนจากที่แสดง · 3 เดือนที่ใช้ตัดสินการ์ดมาจากสมุดเงินสดครบไหม */
    book: { cur: !!cur.book, n: m12.filter(m => m.book).length, of: m12.length, done3: done3.length > 0 && done3.every(m => m.book),
            ok: m12.filter(m => m.book).every(m => m.bookOk), bankEnd: cur.book ? r2(cur.bankEnd) : null },
    months: m12.map(m => mLabel(m.ym)), ms: m12.map(m => m.ym),
    cashIn: m12.map(m => m.cashIn), cashOut: m12.map(m => m.cashOut), net: m12.map(m => m.net), sales: m12.map(m => m.sales),
    cur, prev,
    done3: { months: done3.map(m => mLabel(m.ym)), net: r2(done3.reduce((s, m) => s + m.net, 0)), cashIn: r2(done3.reduce((s, m) => s + m.cashIn, 0)), cashOut: r2(done3.reduce((s, m) => s + m.cashOut, 0)), last: done3.length ? done3[done3.length - 1] : null },
    dso: cur.dso != null ? cur.dso : (R.avgDays == null ? null : R.avgDays), dsoPrev: prev ? prev.dso : null,
    forecast: fc, forecast30: r2(R.forecast30),
    ap: { total: r2(ap.total), n: ap.n || 0, due7: r2(ap.due7), due30: r2(ap.due30), overdue: r2(ap.overdue), overdueN: ap.overdueN || 0 },
    fc15: { tIn: r2(f15.tIn), tOut: r2(f15.tOut), net: r2(f15.net), sev: clean(f15.sev), msg: clean(f15.msg).slice(0, 240), firstNeg: f15.firstNeg || null },
    byBiz, top,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 *  ③ ลูกหนี้ — ตัวคิดเลขตัวเดียวกับหน้าลูกหนี้ (modules/sales/ar-aging.js arAging)
 *     includeNotDue = นับทุกใบที่ยังค้างรับ (รวมที่ยังไม่ครบกำหนด)
 * ═══════════════════════════════════════════════════════════════════ */
function arPart(user) {
  return memo('ar', async () => {
    const AR = require('../sales/ar-aging');
    const A = await AR.arAging(user, { includeNotDue: true });
    if (!A || A.ok === false) throw new Error((A && A.msg) || 'อ่านรายงานลูกหนี้ไม่ได้');
    const bk = (A.buckets || []).map(b => ({ k: b.k, t: b.t, n: b.n || 0, amt: r2(b.amt) }));
    const total = r2(A.total && A.total.amt), n = (A.total && A.total.n) || 0;
    const notDue = bk.filter(b => b.k === 'd0').reduce((s, b) => s + b.amt, 0);
    const over90 = bk.filter(b => ['d120', 'd180', 'dmax'].indexOf(b.k) >= 0).reduce((s, b) => s + b.amt, 0);
    const cr = (A.custRank && A.custRank.rows) || [];
    const pick = x => ({ name: x.name, amt: r2(x.amt), n: x.n, oldest: x.oldest == null ? null : x.oldest });
    return {
      ok: true, today: A.today, total, n, notDue: r2(notDue), overdue: r2(total - notDue), over90: r2(over90),
      overduePct: pctOf(total - notDue, total), buckets: bk.filter(b => b.n > 0),
      custN: cr.length,
      topAmt: cr.slice(0, 5).map(pick),
      topOld: cr.filter(x => x.oldest != null && x.oldest > 0).slice().sort((a, b) => b.oldest - a.oldest || b.amt - a.amt).slice(0, 5).map(pick),
      seeAll: !!(A.scope && A.scope.seeAll),
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════
 *  ④ โปรเจกต์ · ผลิต · ติดตั้ง · ส่งมอบ · รีวิว · หลังการขาย · ซ่อมบำรุง
 * ═══════════════════════════════════════════════════════════════════ */
const PJ_ACTIVE = ['Not Started', 'งานด่วน', 'Meeting กระดุมเม็ดแรก', 'In Progress', 'จองคิวติดตั้งก่อน Complete'];

async function projectsBlock(w) {
  const inList = 'in.(' + PJ_ACTIVE.map(s => '"' + s + '"').join(',') + ')';
  const [act, done, started, startedPrev] = await Promise.all([
    db.selectAll('projects', { select: '_row,"Status","Started","Due"', Status: inList, order: '_row.asc' }),
    db.selectAll('projects', { select: '_row,"Complete",acc_result,"Status JobOrder"', Status: 'eq.Complete', Complete: 'gte.' + w.from, order: '_row.asc' }),
    db.count('projects', { and: '("Started".gte.' + w.from + ',"Started".lte.' + w.to + ')' }),
    db.count('projects', { and: '("Started".gte.' + w.prevFrom + ',"Started".lte.' + w.prevTo + ')' }),
  ]);
  const by = {}; PJ_ACTIVE.forEach(s => { by[s] = 0; });
  let overdue = 0, old30 = 0;
  for (const r of (act || [])) {
    const s = clean(r.Status); if (by[s] == null) continue; by[s]++;
    const due = ymd(r.Due); if (due && due < w.today) overdue++;
    const st = ymd(r.Started); if (st && daysBetween(st, w.today) > 30) old30++;
  }
  const comp = (done || []).filter(r => inR(ymd(r.Complete), w.from, w.to));
  const waitAcc = comp.filter(r => !clean(r.acc_result) && !/เข้าแผนผลิต/.test(clean(r['Status JobOrder']))).length;
  const active = Object.values(by).reduce((a, b) => a + b, 0);
  return {
    rows: PJ_ACTIVE.map(s => [s, by[s]]).concat([['Complete (ในช่วงนี้)', comp.length]]),
    active, complete: comp.length, started, startedPrev, overdue, old30, waitAcc,
    urgent: by['งานด่วน'], notStarted: by['Not Started'],
  };
}

async function productionBlock(w) {
  const RP = require('../jobcard/reports');
  const [st, rep] = await Promise.all([
    RP.getDailyReportStats(db, { from: w.from, to: w.to }),
    RP.getReports(db, { from: w.from, to: w.to, dateBy: 'delivery' }),
  ]);
  const wait = ((st && st.waiting) || []).map(x => [clean(x.name), x.n || 0]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
  const pk = (rep && rep.packing) || {};
  const judged = (pk.onTime || 0) + (pk.late || 0) + (pk.overdueNotDone || 0);
  const wh = (st && st.warehouse) || {};
  const cl = (st && st.claims) || {};
  return {
    open: (st && st.totals && st.totals.all) || 0, openSign: (st && st.totals && st.totals.sign) || 0, openPrint: (st && st.totals && st.totals.print) || 0,
    created: (st && st.createdAll) || 0, closed: (st && st.totals && st.totals.closedAll) || 0,
    waiting: wait.slice(0, 9), waitingTotal: (st && st.waitingTotal) || 0,
    whOverdue: wh.overdue || 0, whDueToday: wh.dueToday || 0,
    onTime: pk.onTime || 0, late: pk.late || 0, overdueNotDone: pk.overdueNotDone || 0, inProgress: pk.inProgress || 0,
    onTimePct: pctOf(pk.onTime || 0, judged),
    claimP: cl.allP || 0, claimI: cl.allI || 0, claimO: cl.allO || 0, claimN: (cl.allP || 0) + (cl.allI || 0) + (cl.allO || 0),
  };
}

/** ระยะเวลาผลิต = เปิดใบสั่งผลิต (CreatedAt) → ปิดงาน (UpdatedAt ของใบที่ Closed — ระบบไม่มีช่อง "ปิดเมื่อ")
 *  ‼ ใบที่ถูกแก้ทีหลังวันปิดจะนานเกินจริง ⇒ ตัดใบที่เกิน 120 วันออกจากค่าเฉลี่ย แล้วบอกจำนวนที่ตัด */
async function leadTimeBlock(w) {
  const RP = require('../jobcard/reports');
  const ms = monthsBack(w.ym, 6);
  const lo = thStartIso(ms[0] + '-01'), hi = thStartIso(nextDay(w.to));
  const rows = await db.selectAll('production_jobs', {
    select: 'JobID,CreatedAt,UpdatedAt,WorkGroup,ClaimType,JobType', OverallStatus: 'eq.Closed',
    and: '("UpdatedAt".gte.' + lo + ',"UpdatedAt".lt.' + hi + ')', order: '_id.asc',
  });
  const by = {}; ms.forEach(m => { by[m] = { s: 0, n: 0 }; });
  const grp = { 'ป้าย': { s: 0, n: 0 }, 'พิมพ์': { s: 0, n: 0 } };
  let cut = 0, closed = 0;
  for (const j of (rows || [])) {
    if (RP.claimOf(j).is) continue;
    const a = new Date(j.CreatedAt), b = new Date(j.UpdatedAt);
    if (isNaN(a.getTime()) || isNaN(b.getTime())) continue;
    const d = (b.getTime() - a.getTime()) / 86400000;
    const m = thDay(j.UpdatedAt).slice(0, 7);
    if (m === w.ym) closed++;
    if (d < 0 || d > 120) { if (m === w.ym) cut++; continue; }
    if (by[m]) { by[m].s += d; by[m].n++; }
    const g = clean(j.WorkGroup);
    if (m === w.ym && grp[g]) { grp[g].s += d; grp[g].n++; }
  }
  const av = x => (x.n ? Math.round(x.s / x.n * 10) / 10 : null);
  return { months: ms.map(mLabel), series: ms.map(m => av(by[m])), avg: av(by[w.ym]), n: by[w.ym].n, closed, cut,
           prev: av(by[w.prevYm] || { n: 0 }), sign: av(grp['ป้าย']), print: av(grp['พิมพ์']) };
}

async function claimCostBlock(w) {
  const CC = require('../jobcard/claimcost');
  /* สิทธิ์ดูต้นทุนเคลมของ Job Card ผูกกับชื่อผู้ใช้ (suntorn · namna · admin) — หน้านี้ผ่านด่าน Administrator มาแล้ว */
  const r = await CC.getDailyClaimCosts(db, { username: 'admin', from: w.from, to: w.to });
  if (!r || r.success === false) throw new Error((r && (r.error || r.warn)) || 'อ่านค่าใช้จ่ายเคลมไม่ได้');
  const x = r.range || {};
  return { total: r2(x.total), count: x.count || 0, P: x.P || 0, I: x.I || 0, O: x.O || 0, act: x.act || 0, est: x.est || 0, none: x.none || 0, storeReady: r.storeReady !== false };
}

async function installBlock(w) {
  const BK = require('../booking/core-api');
  const s = await BK.getDashboardStats({ startDate: w.from, endDate: w.to });
  return {
    total: s.totalJobs || 0, finished: s.finishedTotal || 0, unfinished: s.unfinishedTotal || 0, waiting: s.waiting || 0,
    finishRate: s.finishRate == null ? null : Math.round(s.finishRate * 10) / 10,
    revenue: r2(s.sumRevenue), cost: r2(s.sumCost), profit: r2(s.sumProfit),
    marginPct: s.marginPct == null ? null : Math.round(s.marginPct * 10) / 10,
    lossJobs: s.lossJobs || 0, avgLead: s.avgLead == null ? null : Math.round(s.avgLead * 10) / 10,
    undated: s.undatedCount || 0, aging: (s.agingList || []).length,
    claimInstall: (s.typeGroups && s.typeGroups.claimInstall) || 0, claimProduction: (s.typeGroups && s.typeGroups.claimProduction) || 0,
  };
}

async function deliveryBlock(w) {
  const rows = await db.selectAll('job_deliveries', {
    select: '"DeliveryID","PlannedDate","Status"', and: '("PlannedDate".gte.' + w.from + ',"PlannedDate".lte.' + w.to + ')', order: '_row.asc',
  });
  let total = 0, delivered = 0, failed = 0, pending = 0, overdue = 0;
  for (const r of (rows || [])) {
    const s = clean(r.Status).toLowerCase(), d = ymd(r.PlannedDate);
    if (s === 'cancelled') continue;
    total++;
    if (s === 'delivered') delivered++;
    else if (s === 'failed') failed++;
    else { pending++; if (d && d < w.today) overdue++; }
  }
  const due = delivered + failed + overdue;
  return { total, delivered, failed, pending, overdue, successPct: pctOf(delivered, due) };
}

async function reviewsBlock(w) {
  const rows = await require('../reviews/db').allReviews();
  const acc = () => ({ n: 0, s: 0, p: [0, 0], q: [0, 0], c: [0, 0], m: [0, 0], recY: 0, recN: 0 });
  const all = acc(), mon = acc();
  const add = (a, r) => {
    const rate = parseFloat(r.rating); if (!isNaN(rate)) { a.n++; a.s += rate; }
    [['p', 'ratingPunctuality'], ['q', 'ratingQuality'], ['c', 'ratingCleanliness'], ['m', 'ratingPoliteness']].forEach(k => {
      const v = parseInt(r[k[1]], 10); if (!isNaN(v) && v > 0) { a[k[0]][0] += v; a[k[0]][1]++; }
    });
    if (clean(r.recommendNext)) { a.recN++; if (clean(r.recommendNext) === 'Yes') a.recY++; }
  };
  for (const r of (rows || [])) {
    add(all, r);
    if (inR(thDay(r.reviewedAt), w.from, w.to)) add(mon, r);
  }
  const a1 = x => (x[1] ? Math.round(x[0] / x[1] * 10) / 10 : null);
  const out = a => ({ n: a.n, avg: a.n ? Math.round(a.s / a.n * 10) / 10 : null, recommend: pctOf(a.recY, a.recN),
                      parts: [['ตรงเวลา', a1(a.p)], ['คุณภาพงาน', a1(a.q)], ['ความสะอาด', a1(a.c)], ['มารยาท', a1(a.m)]] });
  return { all: out(all), month: out(mon) };
}

async function aftersaleBlock(user) {
  const AS = require('../aftersale/dash');
  /* ส่งผู้ใช้แบบ "ผู้ดูแล" เข้าไป — ตัวคิดเลขของหลังการขายจะกรองเฉพาะงานของช่างถ้าเป็นสิทธิ์ช่าง */
  const d = await AS.API.api_dashboard({ username: (user && user.username) || 'admin', permission: 'Administrator', status: 'Login' });
  return { total: d.total || 0, open: d.open || 0, overdue: d.overdue || 0, monthNew: d.monthNew || 0, monthClosed: d.monthClosed || 0, monthCost: r2(d.monthCost) };
}

async function maintenanceBlock() {
  const r = await require('../maintenance/dashboard').getMaintenanceDashboard(db, {});
  if (!r || r.success === false) throw new Error((r && r.error) || 'อ่านข้อมูลซ่อมบำรุงไม่ได้');
  const k = r.kpis || {}, b = r.machineStatusBreakdown || {};
  return { machines: k.totalMachines || 0, down: (b.broken || 0) + (b.maintenance || 0), broken: b.broken || 0, open: k.openRequests || 0, urgent: k.urgentOpen || 0,
           overduePM: k.overduePM || 0, availability: k.availabilityPct == null ? null : k.availabilityPct, cost30: r2(k.costThisMonth) };
}

function opsPart(ym, user) {
  const w = winOf(ym);
  return memo('ops|' + w.ym + '|' + w.to, async () => {
    const [projects, production, lead, claim, install, delivery, reviews, aftersale, maint] = await Promise.all([
      safe(() => projectsBlock(w)), safe(() => productionBlock(w)), safe(() => leadTimeBlock(w)), safe(() => claimCostBlock(w)),
      safe(() => installBlock(w)), safe(() => deliveryBlock(w)), safe(() => reviewsBlock(w)), safe(() => aftersaleBlock(user)), safe(() => maintenanceBlock()),
    ]);
    return { ok: true, win: w, projects, production, lead, claim, install, delivery, reviews, aftersale, maint };
  });
}

/* ═══════════════════════════════════════════════════════════════════
 *  ⑤ คลังสินค้า & จัดซื้อ
 * ═══════════════════════════════════════════════════════════════════ */
function parseApi(s) {
  const o = (typeof s === 'string') ? JSON.parse(s) : s;
  if (!o || o.success === false) throw new Error((o && o.error) || 'แอปคลังตอบว่าไม่สำเร็จ');
  return o;
}
async function stockCounts() {
  const c = await require('../inventory/webapp').dashboardCounts();
  return { items: c.activeItems || 0, lowStock: c.lowStock || 0, value: c.stockValue || 0, valueMT: c.stockValueMT || 0, openMR: c.openMR || 0, suggestedPR: c.suggestedPR || 0 };
}
async function stockAnalytics() {
  const WA = require('../inventory/webapp');
  const a = parseApi(await WA.API.getInventoryAnalytics({ days: 90 }, { username: 'admin' }));
  return {
    slowN: (a.slowSummary && a.slowSummary.count) || 0, slowValue: r2(a.slowSummary && a.slowSummary.value),
    reorder: (a.counts && a.counts.reorder) || 0,
    category: (a.categoryValue || []).slice(0, 6).map(c => [clean(c.category) || '(ไม่ระบุหมวด)', Math.round(num(c.value))]),
    slowTop: (a.slowMoving || []).slice(0, 5).map(x => [clean(x.itemName || x.name || x.itemCode), Math.round(num(x.value))]),
  };
}
async function stockFlow(w) {
  const IR = require('../inventory/reports');
  const [iss, gr] = await Promise.all([
    IR.API.getIssueReport({ from: w.from, to: w.to, bucket: 'day', limit: 1 }, { username: 'admin' }).then(parseApi),
    db.selectAll('inv_gr', { select: '"GRID","GRDate","TotalCost","Status"', and: '("GRDate".gte.' + thStartIso(w.from) + ',"GRDate".lt.' + thStartIso(nextDay(w.to)) + ')', order: '_row.asc' }),
  ]);
  let grSum = 0, grN = 0;
  for (const g of (gr || [])) { if (clean(g.Status).toLowerCase() === 'void') continue; grSum += num(g.TotalCost); grN++; }
  const t = iss.totals || {};
  const top = (iss.byItem || []).slice().sort((a, b) => num(b.value) - num(a.value)).slice(0, 5)
    .map(x => [clean(x.itemName || x.name || x.itemCode), Math.round(num(x.value))]);
  return { issueValue: r2(t.value), issueTimes: t.times || 0, issueItems: t.itemKinds || 0, grValue: r2(grSum), grN, top };
}
async function purchaseBlock() {
  const b = await require('../purchase/board').getBoard({});
  const d = b.dashboard || {};
  const by = Object.keys(d.byStatus || {}).map(k => [k, d.byStatus[k].count || 0, r2(d.byStatus[k].sum)]);
  return { total: b.total || 0, waitN: (d.waitingApprove && d.waitingApprove.count) || 0, waitSum: r2(d.waitingApprove && d.waitingApprove.sum),
           urgentOverdue: (d.urgentOverdue || []).length, openOverdue: (d.openOverdue || []).length, byStatus: by };
}
function stockPart(ym) {
  const w = winOf(ym);
  return memo('stock|' + w.ym + '|' + w.to, async () => {
    const [counts, analytics, flow, purchase] = await Promise.all([
      safe(stockCounts), safe(stockAnalytics), safe(() => stockFlow(w)), safe(purchaseBlock),
    ]);
    let daysCover = null;
    if (counts.ok && flow.ok && flow.issueValue > 0) daysCover = Math.round(counts.value / (flow.issueValue / w.days));
    return { ok: true, win: w, counts, analytics, flow, purchase, daysCover };
  });
}

module.exports = {
  winOf, monthOptions, salesPart, cashPart, arPart, opsPart, stockPart, dropAll, memo,
  _t: { ymd, thDay, addMonth, monthsBack, lastDay, mLabel, mLabelFull, daysBetween, addRow, blank, fin, salesRows, SALES_COLS, CHANNELS, BIZ, PJ_ACTIVE, pctOf, chg, squash },
};
