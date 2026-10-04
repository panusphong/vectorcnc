'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/sales/ar-install.js — 🔧 งานติดตั้งบนการ์ดลูกหนี้ (รอบ 202)
 *
 *  ‼ พี่เอสั่ง 1 ต.ค. 69 (คำต่อคำ):
 *    "ในหน้าลูกหนี้ค้างชำระ เพิ่มการแสดงรูปพนักงานขาย , ชื่อ รูปช่างติดตั้ง วันที่ เวลาที่เข้าติดตั้ง
 *     และสถานะการจบงาน เพื่อตรวจสอบติดตามการเก็บเงิน"
 *    + "รูปการจบงาน หรือภาพหน้างานด้วย"
 *
 *  ── ตอบอะไร ─────────────────────────────────────────────────────
 *   GET /api/ar-aging/install?rows=1,2,3  →  { ok, map: { row: {...} }, summary }
 *   map[row] = {
 *     by: 'iv'|'code',                 ใบงานที่จับคู่ได้ (กติกาเดียวกับรูปงานเสร็จรอบ 189)
 *     salePhoto: url,                  รูปพนักงานขาย (app.user_photo ตาม Username = Create By)
 *     state: 'done'|'late'|'wait'|'closed'|'none',   สถานะรวมของงานติดตั้ง
 *     queues: [{ id, date, start, end, team, helpers, state, label, doneAt, signBy, siteVisit, reason }],
 *     photos: { ชื่อช่าง: url },        รูปช่าง (ของกลางแอปจองคิว)
 *     finish: [{thumb,url}], nFinish,  ภาพจบงาน (ช่างถ่ายตอนจบงาน · ภาพจบงาน 1–8)
 *     site:   [{thumb,url}], nSite,    ภาพหน้างาน (ภาพหน้างาน 1–8)
 *   }
 *   ไม่พบใบงาน/คิว = ไม่มีคีย์ของแถวนั้น (แต่ salePhoto ยังมาในช่อง sp)
 *   🔴 รอบ 226 — by:'void' = เลข IV ที่ใบงานถืออยู่ถูกยกเลิกใน PEAK แล้วออกใหม่ให้ลูกค้ารายอื่น (why:'reuse' + live/voidNames)
 *                 หรือใบแจ้งหนี้ของใบขายเองถูกยกเลิก (why:'sale') · ask:'fail' = ยังถาม PEAK ไม่ได้
 *   🔴 รอบ 225 — clash[row] = [{ id, name, by:'iv'|'code'|'queue' }]
 *     ใบงาน/คิวที่จับคู่ได้ด้วยรหัสงานหรือเลข IV แต่ "ชื่อลูกค้าเป็นคนละราย" ⇒ ไม่เอาช่าง/วัน/รูปมาแสดง และบอกเหตุผลบนการ์ด
 *     (เคสจริง 3 ต.ค. 69: การ์ด ดี ทรี ได้นัดดูหน้างานของใบงาน c54f6bb4 ซึ่งเป็นของ รมัย คอร์ป — ดูหัว ar-complete.js)
 *
 *  ── link ยังไง ──────────────────────────────────────────────────
 *   ใบขาย → ใบงาน Projects (ทุกสถานะ) ด้วยตัวค้นของรอบ 189 (ar-complete.readProjects)
 *     ① เลข IV/QO ตรงกัน (แม่นสุด)  ② รหัสงาน (X-1 = X)
 *   ใบงาน → คิวติดตั้ง app.installation_plan ด้วย SourceProjectID
 *     = ProjectID ของใบงาน หรือ requirement_id ของงานย่อยในใบงานนั้น (แอปจองคิวใช้คีย์นี้ · รอบ 177)
 *
 *  ‼ อ่านอย่างเดียว — ไม่แก้คิว ไม่แก้ใบขาย ไม่แก้ Project
 *  ‼ ไม่ขอช่องเงินของคิวเลยแม้แต่ช่องเดียว (ค่าติดตั้งงาน · ค่าจ้างช่างนอก · กำไร · ค่ารถ)
 *  ‼ สิทธิ์ = ด่านเดียวกับการ์ดลูกหนี้ (ar-aging._arCanEdit) · ใบที่ไม่ใช่ของคนนี้ = ไม่ตอบ
 *  ‼ เวลาไทยของกลาง core/thai-date เท่านั้น
 *  ‼ พังตรงไหน = ส่วนนั้นว่าง — การ์ดลูกหนี้ไม่มีทางล่มเพราะไฟล์นี้
 * ═══════════════════════════════════════════════════════════════════ */
const TH = require('../../core/thai-date');
const AR = require('./ar-aging');
const ARC = require('./ar-complete')._t;
const SL = require('../payment/saleslink')._t;

const clean = s => String(s == null ? '' : s).trim();
const MAX_ROWS = 400;
const MAX_Q = 4;                     /* คิวต่อใบ */
const MAX_IMG = 4;                   /* ภาพต่อชนิดต่อใบ */
const MEMO_MS = 3 * 60 * 1000;       /* สถานะคิวเปลี่ยนได้ทั้งวัน — จำแค่ 3 นาที */
const _memo = new Map();
let _sp = { at: 0, v: null };        /* รูปพนักงาน (username → url) จำ 10 นาที */

function _bk() {
  return { db: require('../booking/db'), rules: require('../booking/rules'),
           CONFIG: require('../booking/config'), D: require('../booking/dates') };
}

/** timestamptz → 'YYYY-MM-DD' + 'HH:mm' (เวลาไทย) */
function whenTH(v) {
  if (!v) return { date: '', time: '' };
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return { date: '', time: '' };
  const p = TH.partsTH(d);
  return { date: p.y + '-' + p.m + '-' + p.d, time: p.hh + ':' + p.mm };
}
/** 'YYYY-MM-DD' + 'HH:mm' → '28/09/69 16:30' */
function stamp(v) {
  const w = whenTH(v); if (!w.date) return '';
  const p = w.date.split('-');
  return p[2] + '/' + p[1] + '/' + String(+p[0] + 543).slice(-2) + (w.time && w.time !== '00:00' ? ' ' + w.time : '');
}
function isFinished(CONFIG, D, st) {
  const t = D._normalize(st); if (!t) return false;
  return (CONFIG.FINISHED_STATUSES || []).some(k => D._normalize(k) === t);
}
const rawsOf = v => clean(v).split(/[\n,|]+/).map(clean).filter(Boolean);

/** สถานะคิวเดียว — today = 'YYYY-MM-DD' เวลาไทย */
function queueState(q, today) {
  if (q.finished) return { state: 'done', label: '✅ จบงานแล้ว' };
  if (q.closed) return { state: 'closed', label: '🔒 ปิดงาน/ยกเลิกคิวแล้ว' };
  if (!q.date || !q.team) return { state: 'none', label: '⏳ ยังไม่ได้คิวติดตั้ง (รอจองคิว)' };
  /* นัดดูหน้างานที่ผ่านวันไปแล้ว = ดูแล้ว (ไม่ใช่ "เลยวันนัด" — นัดแบบนี้ไม่ได้ปิดงานเหมือนงานติดตั้ง) */
  if (q.siteVisit && q.date < today) return { state: 'sv', label: '🔎 ดูหน้างานแล้ว' };
  if (q.date < today) return { state: 'late', label: '⚠️ เลยวันนัดแล้ว ยังไม่ปิดงาน' };
  if (q.date === today) return { state: 'wait', label: '🔧 ติดตั้งวันนี้' };
  return { state: 'wait', label: '📅 รอติดตั้ง' };
}
/** สถานะรวมของใบ: งานติดตั้งจริงจบแล้วสักคิว = จบ · ไม่งั้นดูคิวที่ "ยังเดินอยู่" */
function overall(qs) {
  const L = qs.filter(q => !q.siteVisit);
  if (!L.length) return 'none';                       /* มีแค่นัดดูหน้างาน = ยังไม่ได้คิวติดตั้ง */
  if (L.some(q => q.state === 'done')) return 'done';
  for (const st of ['late', 'wait', 'none']) if (L.some(q => q.state === st)) return st;
  return 'closed';
}

async function salePhotos() {
  if (_sp.v && Date.now() - _sp.at < 10 * 60 * 1000) return _sp.v;
  let by = {}, mp = {};
  const P = require('../../core/photo');
  try { by = await P.byUser() || {}; } catch (e) { by = {}; }
  try { mp = await P.map() || {}; } catch (e) { mp = {}; }
  _sp = { at: Date.now(), v: { by, mp } };
  return _sp.v;
}

async function arInstallInfo(user, rowsIn, opt) {
  const t0 = Date.now();
  const rows = Array.from(new Set((Array.isArray(rowsIn) ? rowsIn : []).map(Number)
    .filter(n => Number.isInteger(n) && n > 0))).slice(0, MAX_ROWS);
  const out = { ok: true, map: {}, sp: {}, dates: {}, clash: {}, summary: { asked: rows.length, done: 0, late: 0, wait: 0, closed: 0, none: 0, nomatch: 0, denied: 0, clash: 0 }, ms: 0 };
  if (!rows.length) return out;

  /* ⚡ รอบ 204 — ขั้นที่ไม่ต้องรอกันยิงพร้อมกัน (ทะเบียนคำนำหน้า · ใบขาย · รูปพนักงาน · เงินเข้า) */
  const phP = salePhotos().catch(() => ({ by: {}, mp: {} }));
  const payP = require('../../core/db').select('total_sales', {
    select: ['_row', 'วันที่โอน', 'ยอด (บาท)', 'วันที่โอน งวด 1', 'ยอด งวด 1 (บาท)', 'วันที่โอน งวด 2', 'ยอด งวด 2 (บาท)',
             'วันที่โอน งวด 3', 'ยอด งวด 3 (บาท)'].map(c => '"' + c + '"').join(','),
    _row: 'in.(' + rows.join(',') + ')' }).catch(() => []);
  const [prefix, salesAll] = await Promise.all([AR.prefixList(), ARC.readSales(rows)]);
  const sales = salesAll.filter(r => {
    if (AR._arCanEdit(user, r, prefix)) return true;
    out.summary.denied++; return false;
  });

  /* 👤 รูปพนักงานขาย — Username (Create By) → app.user_photo · สำรอง = แผนที่ชื่อของแอปคีย์ยอดขาย */
  try {
    const ph = await phP;
    for (const r of sales) {
      const u = clean(r['Create By']);
      const url = (u && (ph.by[u.toLowerCase()] || ph.mp[u])) || '';
      if (url) out.sp[r._row] = url;
    }
  } catch (e) { /* ไม่มีรูป = อักษรย่อเหมือนเดิม */ }

  const now = Date.now();
  const today = whenTH((opt && opt.now) ? new Date(opt.now) : new Date()).date;   /* opt.now = เทสต์ปักวัน */
  const dlvOf = {};                    /* row → การส่งของ (แผนจัดส่ง) */
  const need = [];
  for (const r of sales) {
    const k = ARC.saleKeys(r);
    const mk = r._row + '|' + k.code + '|' + k.docs.join(',') + '|' + k.name;
    const m = _memo.get(mk);
    if (m && now - m.at < MEMO_MS) { if (m.v) out.map[r._row] = m.v; if (m.d) dlvOf[r._row] = m.d; if (m.c) out.clash[r._row] = m.c; continue; }
    need.push({ r, k, mk });
  }

  if (need.length) {
    /* ① ใบงาน Projects ทุกสถานะ (ตัวค้นของรอบ 189) */
    let projs = [];
    try { projs = (await ARC.readProjects(need.map(n => n.k), true)).map(p => ({ p, pk: SL.keysOf(p) })); }
    catch (e) { projs = []; }
    const pick = new Map();            /* row → { by, pids:[] } */
    const allPid = new Set();
    const clashOf = {};                /* 🔴 รอบ 225 — row → [{id,name,by}] ใบงาน/คิวที่ตัดทิ้งเพราะชื่อลูกค้าเป็นคนละราย */
    for (const n of need) {
      const pi = await ARC.pickChecked(projs, n.k);     /* 🔴 รอบ 203 — กติกาเดียวกับรูปงานเสร็จ (ห้ามหยิบใบงานที่เลข IV/QO ขัดกัน) · 🔴 รอบ 225 + ห้ามหยิบใบงานของลูกค้าอีกราย · 🔴 รอบ 226 + เช็ค PEAK ว่าเลข IV ถูกยกเลิกแล้วออกใหม่ไหม */
      if (pi.clash.length) clashOf[n.r._row] = pi.clash.slice(0, 3);
      const pp = pi.pick;
      if (!pp) continue;
      const pids = pp.cand.map(x => clean(x.p.ID)).filter(Boolean);
      if (!pids.length) continue;
      pick.set(n.r._row, { by: pp.by, pids, names: pp.cand.map(x => ARC.nameKey(x.p['แสดงชื่อลูกค้า'])).filter(Boolean) });
      pids.forEach(p => allPid.add(p));
    }

    const { db, rules, CONFIG, D } = _bk();
    const C = db.COL, qc = rules.qc;
    /* ② งานย่อยของใบงาน → requirement_id (แอปจองคิวใช้เป็น SourceProjectID ของงานย่อย/เคลม) */
    const reqOf = {};                  /* requirement_id → ProjectID */
    /* ⚡ รอบ 204 — งานย่อย · แผนจัดส่ง · รายชื่อช่าง ยิงพร้อมกัน (ไม่ต้องรอกัน) */
    const pidList = [...allPid];
    const [rq, dl, insp] = await Promise.all([
      pidList.length ? db.byIdsAll(db.T.REQUIREMENT, 'project_id', pidList,
        { select: 'requirement_id,project_id', order: 'requirement_id.asc' }).catch(() => []) : [],
      /* ③.5 🚚 วันส่งของจริงจากแอปแผนจัดส่ง (app.job_deliveries · จับด้วย ProjectID เดียวกัน)
       *   ส่งแล้ว (DeliveredAt) = วันส่งจริงล่าสุด · ยังไม่ส่ง = วันตามแผน (PlannedDate) · ใบยกเลิกไม่นับ
       *   ‼ ไม่ขอค่าจัดส่ง / ที่อยู่ / เบอร์ผู้รับ */
      pidList.length ? db.byIdsAll('job_deliveries', 'ProjectID', pidList,
        { select: '"DeliveryID","ProjectID","PlannedDate","Status","DeliveredAt","DeliveryType"', order: '_row.asc' }).catch(() => []) : [],
      Promise.resolve(rules._getInspectorMap()).catch(() => ({})),
    ]);
    (rq || []).forEach(x => { const a = clean(x.requirement_id), b = clean(x.project_id); if (a && b) reqOf[a] = b; });
    /* ③ คิวติดตั้ง — ‼ ไม่ขอช่องเงินเด็ดขาด */
    const PHOTO_SITE = ['sitePhoto1', 'sitePhoto2', 'sitePhoto3', 'sitePhoto4', 'sitePhoto5', 'sitePhoto6', 'sitePhoto7', 'sitePhoto8'];
    const PHOTO_FIN = ['finishImage', 'finishImage2', 'finishImage3', 'finishImage4', 'finishImage5', 'finishImage6', 'finishImage7', 'finishImage8'];
    const cols = ['_row', C.id, C.sourceProjectId, C.customer, C.date, C.time, C.jobType, C.status,
      C.inspector, C.inspector2, C.inspector3, C.inspector4, C.inspectorNickname,
      C.closedAt, C.closedReason, C.techFinishedAt, C.signAt, C.signBy]
      .concat(PHOTO_SITE.map(k => C[k]), PHOTO_FIN.map(k => C[k])).filter(Boolean);
    const keys = [...allPid, ...Object.keys(reqOf)];
    let plan = [];
    if (keys.length && C.sourceProjectId) {
      try {
        plan = await db.byIdsAll(db.T.PLAN, C.sourceProjectId, keys,
          { select: [...new Set(cols)].map(qc).join(','), order: '_row.asc' }) || [];
      } catch (e) { plan = []; }
    }
    const nameOf = id => {
      const k = clean(id); if (!k) return '';
      const o = (insp || {})[k] || (insp || {})[k.toLowerCase()];
      return o ? (clean(o.nickname) || clean(o.name) || k) : k;
    };
    const byPid = {};                  /* ProjectID → [คิว] */
    for (const r of plan) {
      const src = clean(r[C.sourceProjectId]);
      const pid = allPid.has(src) ? src : reqOf[src];
      if (!pid) continue;
      const w = whenTH(r[C.date]);
      const end = clean(r[C.time]);
      const q = {
        id: clean(r[C.id]), row: Number(r._row) || 0,
        date: w.date,
        start: w.time === '00:00' ? '' : w.time,
        end: /^\d{1,2}[:.]\d{2}$/.test(end) ? end.replace('.', ':') : '',
        team: clean(r[C.inspectorNickname]) || nameOf(r[C.inspector]),
        helpers: [C.inspector2, C.inspector3, C.inspector4].filter(Boolean).map(k => nameOf(r[k])).filter(Boolean),
        status: clean(r[C.status]),
        siteVisit: /_SV$/i.test(clean(r[C.id])) || !!(rules._isSiteVisit && rules._isSiteVisit(r[C.jobType])),
        jobType: clean(r[C.jobType]),
        finished: isFinished(CONFIG, D, r[C.status]) || !!r[C.techFinishedAt] || !!r[C.signAt],
        closed: !!(C.closedAt && r[C.closedAt]),
        doneAt: stamp(r[C.techFinishedAt] || r[C.signAt]) || '',
        signBy: clean(r[C.signBy]),
        reason: clean(r[C.closedReason]).slice(0, 80),
        _cust: C.customer ? clean(r[C.customer]) : '',   /* 🔴 รอบ 225 — ชื่อลูกค้าบนคิว (ใช้ตรวจทานอย่างเดียว ไม่ส่งออก) */
        _fin: [].concat(...PHOTO_FIN.map(k => C[k] ? rawsOf(r[C[k]]) : [])),
        _site: [].concat(...PHOTO_SITE.map(k => C[k] ? rawsOf(r[C[k]]) : [])),
      };
      if (!q.date) q.start = '';
      Object.assign(q, queueState(q, today));
      (byPid[pid] = byPid[pid] || []).push(q);
    }

    const dlByPid = {};
    for (const d of (dl || [])) {
      if (/ยกเลิก|cancel/i.test(clean(d.Status))) continue;
      (dlByPid[clean(d.ProjectID)] = dlByPid[clean(d.ProjectID)] || []).push(d);
    }
    for (const n of need) {
      const pk = pick.get(n.r._row); if (!pk) continue;
      const L = [].concat(...pk.pids.map(p => dlByPid[p] || []));
      if (!L.length) continue;
      const done = L.map(d => whenTH(d.DeliveredAt).date).filter(Boolean).sort();
      const plan = L.map(d => whenTH(d.PlannedDate).date).filter(Boolean).sort();
      if (done.length) dlvOf[n.r._row] = { date: done[done.length - 1], actual: true, n: L.length };
      else if (plan.length) dlvOf[n.r._row] = { date: plan[plan.length - 1], actual: false, n: L.length,
                                                 status: clean(L[L.length - 1].Status).slice(0, 40) };
    }

    const built = [];
    for (const n of need) {
      const pk = pick.get(n.r._row);
      if (!pk) continue;
      const seen = new Set();
      let qs = [].concat(...pk.pids.map(p => byPid[p] || [])).filter(q => !seen.has(q.row) && seen.add(q.row));
      /* 🔴 รอบ 225 — ด่านที่สอง: ชื่อลูกค้า "บนคิว" เป็นคนละรายกับใบขาย ⇒ ไม่ใช่คิวของใบนี้ (กันคิวที่ผูกใบงานผิด / ใบงานที่ไม่มีชื่อลูกค้า) */
      const kNames = [n.k.name, n.k.peakName].filter(Boolean);   /* 🔴 รอบ 226 — ชื่อที่เซลส์คีย์ + ชื่อเจ้าของใบใน PEAK */
      if (kNames.length) {
        qs = qs.filter(q => {
          const qn = ARC.nameKey(q._cust);
          if (kNames.some(nm => ARC.sameCustomer(nm, qn) !== false)) return true;
          if (pk.names.some(pn => ARC.sameCustomer(pn, qn) === true)) return true;   /* ชื่อเดียวกับใบงานที่ผ่านด่านแรกมาแล้ว (เช่น ชื่อผู้ติดต่อ) */
          const L = (clashOf[n.r._row] = clashOf[n.r._row] || []);
          if (L.length < 3) L.push({ id: q.id, name: q._cust.slice(0, 80), by: 'queue' });
          return false;
        });
      }
      if (!qs.length) continue;
      /* เรียง: งานติดตั้งจริงก่อนนัดดูหน้างาน · คิวที่ยังเดิน/จบก่อนคิวที่ปิดทิ้ง · วันล่าสุดก่อน */
      const rank = q => (q.siteVisit ? 10 : 0) + (q.state === 'closed' ? 5 : 0);
      qs.sort((a, b) => rank(a) - rank(b) || (b.date + b.start).localeCompare(a.date + a.start));
      built.push({ n, by: pk.by, qs });
    }

    /* ④ รูปช่าง + ภาพจบงาน/หน้างาน — คำขอรวมครั้งเดียวทั้งจอ */
    const names = [];
    built.forEach(b => b.qs.slice(0, MAX_Q).forEach(q => names.push(q.team, ...q.helpers)));
    built.forEach(b => {
      const fin = [].concat(...b.qs.map(q => q._fin)), site = [].concat(...b.qs.map(q => q._site));
      b.fin = [...new Set(fin)]; b.site = [...new Set(site)];
    });
    /* รูปช่าง (ของกลางแอปจองคิว · จำผลไว้ฝั่งเซิร์ฟเวอร์) — ภาพจบงาน/หน้างานไม่แปลงที่นี่แล้ว (รอบ 205 · ดูข้างล่าง) */
    const tph = {};
    const techP = (async () => {
      const list = [...new Set(names.map(clean).filter(Boolean))].slice(0, 300);
      if (!list.length) return;
      const m = await require('../booking/dispatch').getDispatchTechPhotos('', list.map(x => ({ id: x, nickname: x, name: x }))) || {};
      list.forEach(x => { if (clean(m[x])) tph[x] = clean(m[x]); });
    })().catch(() => {});
    /* ⚡ รอบ 205 — วิธีของ Job Card สั่งผลิต: ไม่แปลงรูปในคำขอนี้ ส่งค่าดิบไป · หน้าเว็บขอไอดีแยก (img-ids) แล้วโหลดจาก CDN ของ Google
     *   ⇒ ช่าง/วันที่/สถานะ ขึ้นทันทีโดยไม่ต้องรอ Drive */
    await techP;
    const img = list => list.slice(0, MAX_IMG).map(r => ({ raw: r }));

    for (const b of built) {
      const queues = b.qs.slice(0, MAX_Q).map(q => ({
        id: q.id, date: q.date, start: q.start, end: q.end, team: q.team, helpers: q.helpers,
        state: q.state, label: q.label, doneAt: q.doneAt, signBy: q.signBy, siteVisit: q.siteVisit,
        jobType: q.jobType, reason: q.state === 'closed' ? q.reason : '',
      }));
      const photos = {};
      queues.forEach(q => [q.team].concat(q.helpers).forEach(x => { if (tph[clean(x)]) photos[clean(x)] = tph[clean(x)]; }));
      const v = { by: b.by, state: overall(b.qs), queues, more: Math.max(0, b.qs.length - MAX_Q), photos,
                  finish: img(b.fin), nFinish: b.fin.length, site: img(b.site), nSite: b.site.length };
      out.map[b.n.r._row] = v;
    }
    /* 🔴 รอบ 225 — บอกเหตุผลเฉพาะใบที่ "ไม่มีอะไรแสดงเพราะถูกตัด" (ใบที่ยังมีคิวถูกต้องแสดงอยู่ ไม่ต้องรกจอ) */
    for (const n of need) if (!out.map[n.r._row] && clashOf[n.r._row]) out.clash[n.r._row] = clashOf[n.r._row];
    for (const n of need) _memo.set(n.mk, { at: now, v: out.map[n.r._row] || null, d: dlvOf[n.r._row] || null, c: out.clash[n.r._row] || null });
  }

  /* ═══ 📅 วันสำคัญของใบ (รอบ 202 · พี่เอ 1 ต.ค. 69) ═══
   *   "หรือนับจากวันที่ มีการเก็บมัดจำงวดแรกเข้ามาดีกว่านะ แต่ให้แสดงวันที่ติดตั้ง วันที่ส่งของ (แผนจัดส่ง) ไว้ด้วย วันที่รับเงินมัดจำงวดแรก"
   *   ‼ พี่เอเลือก "เพิ่มตัวนับใหม่" — ตัวนับเดิม (เกิน N วันจากวันครบกำหนด) + ช่องอายุหนี้ + ยอดรวม ไม่แตะ
   *   ตัวนับใหม่ "ค้างมาแล้ว N วัน" นับจาก ① รับเงินงวดแรก (วันที่โอนที่เก่าสุดของใบขาย)
   *     ไม่มีเงินเข้าเลย ⇒ ② วันติดตั้ง (คิวที่จบแล้ว/ถึงวันแล้ว) ⇒ ③ วันส่งของ (ส่งจริง/ถึงวันตามแผน) ⇒ ไม่นับ */
  const pays = (await payP) || [];   /* ⚡ รอบ 204 — ยิงไปตั้งแต่ต้นพร้อมใบขาย */
  const payOf = {};
  pays.forEach(r => { payOf[r._row] = r; });
  for (const r of sales) {
    const row = r._row, P = payOf[row] || {};
    const cand = [['วันที่โอน', 'ยอด (บาท)', 'รับเงิน'], ['วันที่โอน งวด 1', 'ยอด งวด 1 (บาท)', 'งวด 1'],
                  ['วันที่โอน งวด 2', 'ยอด งวด 2 (บาท)', 'งวด 2'], ['วันที่โอน งวด 3', 'ยอด งวด 3 (บาท)', 'งวด 3']]
      .map(c => ({ date: clean(P[c[0]]).slice(0, 10), amt: Number(P[c[1]]) || 0, label: c[2] }))
      .filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date))
      .sort((a, b) => a.date.localeCompare(b.date));
    const dep = cand[0] || null;
    const v = out.map[row];
    let inst = null;
    if (v) {
      const real = (v.queues || []).filter(q => !q.siteVisit && q.state !== 'closed' && q.date);
      const q = real.find(x => x.state === 'done') || real[0];
      if (q) inst = { date: q.date, done: q.state === 'done', late: q.state === 'late' };
    }
    const dlv = dlvOf[row] || null;
    let base = null;
    if (dep) base = { k: 'dep', date: dep.date };
    else if (inst && (inst.done || inst.date <= today)) base = { k: 'inst', date: inst.date };
    else if (dlv && (dlv.actual || dlv.date <= today)) base = { k: 'dlv', date: dlv.date };
    const days = base ? Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(base.date + 'T00:00:00Z')) / 86400000) : null;
    if (dep || inst || dlv) out.dates[row] = { dep, inst, dlv, base, days };
  }

  for (const r of sales) {
    const v = out.map[r._row];
    if (!v) { out.summary.nomatch++; if (out.clash[r._row]) out.summary.clash++; } else out.summary[v.state]++;
  }
  out.ms = Date.now() - t0;
  return out;
}

module.exports = { arInstallInfo, _t: { queueState, overall, whenTH, stamp, _memo, resetPhotos: () => { _sp = { at: 0, v: null }; } } };
