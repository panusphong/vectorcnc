'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/mgmt/config.js — ค่าตั้งของแอป Management Report
 *
 *  เก็บในตารางกลาง app.settings คีย์ 'mgmt_config' (ตารางเดิมของระบบ — sql/45)
 *  ‼ ยังไม่มีแถวนี้ / อ่านไม่ได้ ⇒ ใช้ค่าตั้งต้นข้างล่าง แอปต้องเปิดได้เสมอ
 *
 *  ── งบโฆษณา (พี่เอ 3 ต.ค. 69 คำต่อคำ) ─────────────────────────────
 *    "วิเคราะห์ budget การยิง ads ต่อยอดขายลูกค้าใหม่ ของ website , fb ,tiktok
 *     ในส่วน budget website แบ่งเป็น www.101printhouse.com ใช้ 75000 บาทต่อเดือน ,
 *     www.the101.co.th ใช้ 75000 บาทต่อเดือน , tiktok จะใช้ budget 50,000 บาทต่อเดือน
 *     และ fb จะใช้ประมาณ 150,000 บาทต่อเดือน"
 *
 *  ── เกณฑ์ เขียว/เหลือง/แดง (พี่เอ 3 ต.ค. 69 คำต่อคำ) ───────────────
 *    "เกณฑ์ เขียว เหลือง แดง ดูที่ Cash flow และแนวโน้มยอดขายที่เพิ่มขึ้น หรือลดลงเป็นหลัก"
 *    ⇒ สีรวมขององค์กร = ตัวที่แย่กว่าระหว่าง Cashflow กับ แนวโน้มยอดขาย
 *      ด้านอื่น (ลูกหนี้ · ค่าใช้จ่าย · คลัง · ผลิต ฯลฯ) เป็นตัวประกอบ มีผลกับคะแนนแต่ไม่เปลี่ยนสีรวม
 * ═══════════════════════════════════════════════════════════════════ */
const db = require('../../core/db');

const KEY = 'mgmt_config';

const DEFAULTS = {
  /* งบโฆษณาต่อเดือน — group = กลุ่มช่องทาง Online ของรายงานยอดขาย Online (web · fb · tiktok)
   * match = คำที่ใช้จับจาก "ชื่อช่อง / Platform" (ไม่สนตัวพิมพ์ ไม่สนเว้นวรรค) — เฉพาะกลุ่ม web ที่ต้องแยก 2 เว็บ */
  ads: [
    { key: 'web101print', name: 'www.101printhouse.com', group: 'web', budget: 75000, match: ['101print', 'printhouse'] },
    { key: 'webthe101', name: 'www.the101.co.th', group: 'web', budget: 75000, match: ['the101'] },
    { key: 'fb', name: 'Facebook / Instagram', group: 'fb', budget: 150000, match: [] },
    { key: 'tiktok', name: 'TikTok', group: 'tiktok', budget: 50000, match: [] },
  ],
  /* ยอดขายลูกค้าใหม่ต่องบ 1 บาท */
  roas: { good: 4, warn: 3 },
  /* แนวโน้มยอดขาย (%) — เทียบค่าเฉลี่ย 3 เดือนล่าสุดที่จบแล้ว กับ 3 เดือนก่อนหน้า + เดือนนี้เทียบช่วงเดียวกันเดือนก่อน */
  sales: { trendGood: 0, trendBad: -10, paceBad: -10 },
  /* ตัวประกอบ */
  ar: { overduePctWarn: 30, overduePctBad: 50 },
  expense: { toCashInWarn: 80, toCashInBad: 100 },
  stock: { slowPctWarn: 10, slowPctBad: 20 },
  production: { onTimeGood: 90, onTimeWarn: 75 },
  install: { finishGood: 90, finishWarn: 75 },
  closeRate: { warn: 20, bad: 10 },
};

const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
const str = (v, max) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, max || 80);

/** รวมค่าที่บันทึกไว้เข้ากับค่าตั้งต้น — รับเฉพาะคีย์ที่รู้จัก ค่าที่ผิดรูปแบบถอยไปใช้ค่าตั้งต้น */
function merge(saved) {
  const s = (saved && typeof saved === 'object') ? saved : {};
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  if (Array.isArray(s.ads)) {
    const byKey = {}; s.ads.forEach(a => { if (a && a.key) byKey[String(a.key)] = a; });
    out.ads = out.ads.map(d => {
      const a = byKey[d.key]; if (!a) return d;
      const b = num(a.budget, d.budget);
      return {
        key: d.key, group: d.group,
        name: str(a.name, 60) || d.name,
        budget: (b >= 0 && b <= 1e8) ? Math.round(b) : d.budget,
        match: Array.isArray(a.match) ? a.match.map(x => str(x, 40).toLowerCase().replace(/\s+/g, '')).filter(Boolean).slice(0, 8) : d.match,
      };
    });
  }
  const pick = (grp, keys, lo, hi) => {
    const g = s[grp]; if (!g || typeof g !== 'object') return;
    keys.forEach(k => { const v = num(g[k], NaN); if (isFinite(v) && v >= lo && v <= hi) out[grp][k] = v; });
  };
  pick('roas', ['good', 'warn'], 0, 1000);
  pick('sales', ['trendGood', 'trendBad', 'paceBad'], -100, 100);
  pick('ar', ['overduePctWarn', 'overduePctBad'], 0, 100);
  pick('expense', ['toCashInWarn', 'toCashInBad'], 0, 1000);
  pick('stock', ['slowPctWarn', 'slowPctBad'], 0, 100);
  pick('production', ['onTimeGood', 'onTimeWarn'], 0, 100);
  pick('install', ['finishGood', 'finishWarn'], 0, 100);
  pick('closeRate', ['warn', 'bad'], 0, 100);
  return out;
}

let _memo = null;                       /* { at, v, saved, by, when } */
const TTL = 60000;

async function load(force) {
  if (!force && _memo && Date.now() - _memo.at < TTL) return _memo;
  let row = null, err = '';
  try { row = await db.one('settings', { key: 'eq.' + KEY, select: 'value,updated_at,updated_by' }); }
  catch (e) { err = String((e && e.message) || e).slice(0, 160); }
  const m = { at: Date.now(), v: merge(row && row.value), saved: !!row, by: (row && row.updated_by) || '', when: (row && row.updated_at) || '', err };
  if (!err) _memo = m;                  /* อ่านไม่ได้ = ไม่จำ รอบหน้าลองใหม่ */
  return m;
}

async function save(input, username) {
  const v = merge(input);
  await db.upsert('settings', [{ key: KEY, value: v, updated_at: new Date().toISOString(), updated_by: String(username || '').slice(0, 60) }], 'key');
  _memo = null;
  return v;
}

module.exports = { KEY, DEFAULTS, merge, load, save };
