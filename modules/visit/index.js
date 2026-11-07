'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/visit — 🧭 B2B Visit (v1.0.0 · 20 ต.ค. 69)
 *
 *  🔴 พี่เอ: "พี่ต้องการ ทำ app สำหรับหา lead visit ลูกค้ากลุ่ม B2B ให้เราช่วยให้เค้า กำหนดกลุ่มประเภทธุรกิจ
 *    กดค้นหาใน app แล้วให้ดึงชื่อ ที่อยู่ ข้อมูลทางการเงิน เบอร์ติดต่อ google maps พร้อมรายละเอียดการดำเนินธุรกิจ
 *    และวิเคราะห์ให้ด้วยว่า ควร focus เข้าไป visit หรือไม่อย่างไร … เมื่อวางแผนลงปฏิทิน visit แล้ว ให้มีระบบติดตาม
 *    ในรูปแบบต่างๆ เพื่อปิดการขาย และให้เซลล์ upload ภาพกิจกรรม การ visit และเขียนสรุปสั้นๆ ลงใน app เพื่อให้อลิซ
 *    วิเคราะห์เป็น summary report … ระบุแผนการทำงานกับลูกค้าแต่ละรายที่ได้ออก visit ไปแล้วทุกราย และประเมินอัตรา
 *    ความสำเร็จออกมาให้ได้ ออกแบบให้ใช้งานง่าย สวยงาม ดู Pro ด้วยนะ ทั้งหน้า desktop และ มือถือ"
 *
 *  สิทธิ์: เซลส์เห็น/แก้เฉพาะลูกค้าที่ตัวเองดูแล · ผู้ดูแล (Administrator / รายชื่อเห็นยอดทุกคนของคีย์ยอดขาย) เห็นทุกคน + มอบหมายเซลส์
 *  ตาราง: sql/126-visit-b2b.sql (ยังไม่รัน ⇒ หน้าจอบอกให้รัน ไม่ล้ม)
 * ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const Seg = require('./segments');
const AI = require('./ai');
const VERSION = require('./version');
const Biz = require('../omnichat/bizcheck');
const perms = require('../../core/app-perms');
const Trip = require('./trip');       /* 🚗 v1.1.0 การเดินทาง · ระยะทาง · ค่าน้ำมัน */
const Claims = require('./claims');   /* 💰 v1.1.0 ใบขอเบิกค่าเดินทาง · บัญชีอนุมัติ / ทำจ่าย */

const SQL_FILE = 'sql/126-visit-b2b.sql';
const T = { p: 'visit_prospects', e: 'visit_events', s: 'visit_searches', r: 'visit_reports' };
const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const clip = (s, n) => clean(s).slice(0, n);
const lower = s => clean(s).toLowerCase();
const rid = p => p + crypto.randomBytes(5).toString('hex');
const iso = ms => new Date(ms).toISOString();
const ms = v => (v ? Date.parse(v) || 0 : 0);
const errText = e => String((e && e.message) || e || 'ไม่ทราบสาเหตุ').replace(/\s+/g, ' ').slice(0, 240);
const noTable = e => /PGRST205|42P01|does not exist|could not find the table/i.test(String((e && (e.body || e.message)) || e));
const uerr = (m, status) => { const e = new Error(m); e.userError = true; e.status = status || 400; return e; };
/** ชื่อบริษัทแบบเทียบซ้ำ: ตัดคำนำหน้านิติบุคคล วรรค จุด */
const nameKey = s => lower(s).replace(/บริษัท|บจก\.?|จำกัด|\(มหาชน\)|มหาชน|ห้างหุ้นส่วน|หจก\.?|co\.?,?\s*ltd\.?|company|limited|public|plc\.?|inc\.?|[\s.,()&\-–]/gi, '');
const DAY = 864e5;
const phoneKey = s => String(s || '').replace(/\D/g, '').slice(-9);

async function mount(router, ctx) {
  const db = ctx.db, warn = ctx.warn || (() => {}), auth = ctx.auth;
  const ai = ctx.ai || AI.create({});
  const storage = ctx.storage || require('../../core/storage');
  const SEE = (() => { try { return require('../sales/see-all'); } catch (e) { return null; } })();
  let health = { ok: false, missing: false, error: '' };

  async function check() {
    try { await db.select(T.p, { select: 'id', limit: 1 }); await db.select(T.e, { select: 'id', limit: 1 }); await db.select(T.r, { select: 'id', limit: 1 }); await db.select(T.s, { select: 'id', limit: 1 }); health = { ok: true, missing: false, error: '' }; }
    catch (e) { health = { ok: false, missing: noTable(e), error: errText(e) }; if (health.missing) warn('B2B Visit: ยังไม่ได้รัน ' + SQL_FILE); }
    return health;
  }
  const ready = check();
  const need = async () => { await ready; if (!health.ok) { await check(); if (!health.ok) throw uerr(health.missing ? 'ยังไม่ได้สร้างตารางของแอป — รัน ' + SQL_FILE + ' ใน Supabase SQL Editor ก่อน' : 'ฐานข้อมูลไม่พร้อม: ' + health.error, 503); } };

  /* ── ผู้ใช้ · ทีมขาย ── */
  const isSup = u => !!u && ((SEE && SEE.canSeeAllSales(u)) || perms.canonPerm(u.permission) === perms.ADMIN_PERM_KEY);
  /* 🙋 v1.0.1 — พี่เอ: "ตัดชื่อจริงออกเลย เอาแค่ชื่อเล่น แสดง user login พอ" ⇒ ทั้งแอปใช้ชื่อเล่น (ไม่มี ⇒ user login) ไม่ส่งชื่อจริงไปหน้าจอ */
  const nickOf = (nick, full, username) => { const n = clean(nick).replace(/^\(\s*|\s*\)$/g, ''); if (n) return n; const m = clean(full).match(/^\(\s*([^)]+?)\s*\)/); return m ? clean(m[1]) : clean(username); };
  const meOf = req => { const u = req.user || {}; return { username: clean(u.username), name: nickOf(u.nickname, u.name, u.username), sup: isSup(u) }; };
  let team = { at: 0, list: [] };
  async function teamList() {
    if (Date.now() - team.at < 5 * 60e3 && team.list.length) return team.list;
    let photos = {};
    try { photos = (await require('../../core/photo').byUser()) || {}; } catch (e) { photos = {}; }
    const rows = await db.selectAll('app_users', { select: '"Username","Name","Nickname","Permission","Status","Impage"', order: 'Username.asc' }).catch(e => { warn('B2B Visit: อ่านรายชื่อไม่สำเร็จ ' + errText(e)); return []; });
    const People = require('../omnichat/people');
    const list = (rows || []).filter(r => clean(r.Status).toLowerCase() !== 'logout' && ['sales', 'sale support', 'administrator'].indexOf(perms.canonPerm(r.Permission)) >= 0)
      .map(r => ({ username: clean(r.Username), name: nickOf(r.Nickname, r.Name, r.Username), nick: nickOf(r.Nickname, r.Name, r.Username), image: People.imageOf(r.Username, r.Impage, photos), perm: perms.canonPerm(r.Permission) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'th'));
    team = { at: Date.now(), list };
    return list;
  }
  const nameOfUser = (list, un) => { const x = list.find(u => lower(u.username) === lower(un)); return x ? x.name : un; };

  /* ── แถว ⇄ วัตถุ ── */
  const pOut = r => ({ id: r.id, name: r.name, juristicId: r.juristic_id, phone: r.phone, segment: r.segment, bizType: r.biz_type, province: r.province, address: r.address, website: r.website,
    owner: r.owner, stage: r.stage, score: r.score, fit: r.fit, chance: r.chance, value: Number(r.value) || 0, nextAt: ms(r.next_at), nextAction: r.next_action, doc: r.doc || {},
    createdBy: r.created_by, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at), mapsUrl: AI.mapsUrl(r.name, r.address) });
  const eOut = r => ({ id: r.id, prospectId: r.prospect_id, kind: r.kind, status: r.status, at: ms(r.at), owner: r.owner, by: r.by_user, title: r.title, body: r.body, doc: r.doc || {}, createdAt: ms(r.created_at) });
  const canTouch = (me, p) => me.sup || lower(p.owner) === lower(me.username) || (!p.owner && lower(p.createdBy) === lower(me.username));
  async function mustP(me, id) {
    const r = await db.one(T.p, { id: 'eq.' + clean(id), select: '*' });
    if (!r) throw uerr('ไม่พบลูกค้ารายนี้', 404);
    const p = pOut(r);
    if (!canTouch(me, p)) throw uerr('ลูกค้ารายนี้อยู่ในความดูแลของเซลส์คนอื่น', 403);
    return p;
  }
  async function saveP(p, patch) {
    const row = Object.assign({ updated_at: iso(Date.now()) }, patch);
    const out = await db.update(T.p, { id: 'eq.' + p.id }, row);
    return pOut((out && out[0]) || Object.assign({}, p, row));
  }
  const prow = (x, me, owner) => ({
    name: clip(x.name, 160), name_key: nameKey(x.name), juristic_id: Biz.validId(x.juristicId) ? x.juristicId : '', phone: clip(x.phone, 60), segment: clip(x.segment, 40), biz_type: clip(x.bizType, 120),
    province: clip(x.province, 60), address: clip(x.address, 300), website: /^https?:\/\//i.test(clean(x.website)) ? clip(x.website, 300) : '', owner: clip(owner, 80),
    score: Math.max(0, Math.min(100, Math.round(Number(x.score) || 0))), fit: ['go', 'wait', 'skip'].indexOf(x.fit) >= 0 ? x.fit : '',
  });

  /** งานถัดไปของลูกค้า = นัด/งานติดตามที่ยังเปิดอยู่ ที่ครบกำหนดก่อนสุด */
  async function refreshNext(p) {
    const open = (await db.select(T.e, { prospect_id: 'eq.' + p.id, status: 'eq.open', kind: 'in.(plan,task)', select: 'id,kind,at,title', order: 'at.asc', limit: 1 })) || [];
    const n = open[0];
    return saveP(p, { next_at: n ? n.at : null, next_action: n ? (n.kind === 'plan' ? '🚗 visit: ' : '') + clip(n.title, 160) : '' });
  }
  async function addEvent(p, me, ev) {
    const row = { id: rid('ve_'), prospect_id: p.id, kind: ev.kind, status: ev.status || 'open', at: iso(ev.at || Date.now()), owner: p.owner || me.username, by_user: me.username,
      title: clip(ev.title, 200), body: String(ev.body || '').slice(0, 4000), doc: ev.doc || {} };
    await db.insert(T.e, [row]);
    return eOut(row);
  }
  const STAGE_ORDER = Seg.STAGES.map(s => s.key);
  const further = (a, b) => STAGE_ORDER.indexOf(a) > STAGE_ORDER.indexOf(b);   /* a ไกลกว่า b */
  async function setStage(p, me, stage, why) {
    if (!Seg.STAGE[stage] || stage === p.stage) return p;
    await addEvent(p, me, { kind: 'stage', status: 'done', title: Seg.STAGE[p.stage].label + ' → ' + Seg.STAGE[stage].label, body: clip(why, 400), doc: { from: p.stage, to: stage } });
    return saveP(p, { stage, chance: stage === 'won' ? 100 : stage === 'lost' ? 0 : Math.max(p.chance || 0, Seg.STAGE_CHANCE[stage] || 0) });
  }

  /* ── รูป: ย่อ (sharp) → Storage ── */
  function bufOfData(s) {
    const m = /^data:(image\/(?:jpeg|png|webp|heic|heif));base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
    if (!m) throw uerr('รูปไม่ถูกต้อง (รองรับ JPG / PNG / WEBP)');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 12 * 1024 * 1024) throw uerr('รูปใหญ่เกิน 12MB');
    return buf;
  }
  /** 🗜 3 พ.ย. 69 รูปที่เก็บใน Supabase Storage ≤ 150 KB (core/imgshrink) · ย่อไม่ได้ ⇒ แบบเดิม 1600px */
  async function shrink150(buf) {
    const r = await require('../../core/imgshrink').shrink(buf, { maxKb: 150, maxSide: 1600 });
    return r.changed ? r.buf : r.why === 'small' ? buf : shrink(buf, 1600, 82);
  }
  async function shrink(buf, max, q) {
    const sharp = require('sharp');
    return sharp(buf, { failOn: 'none', animated: false }).rotate().resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: q || 80 }).toBuffer();
  }

  const send = (res, fn) => Promise.resolve().then(fn).then(v => res.json(v === undefined ? { ok: true } : v))
    .catch(e => { if (!e.userError) warn('B2B Visit: ' + errText(e)); res.status(e.status && e.userError ? e.status : (e.userError ? 400 : 500)).json({ ok: false, error: errText(e) }); });

  /* 💰 v1.1.0 ใบเบิกค่าเดินทาง (ตารางแยก · ยังไม่รัน sql/129 ⇒ เฉพาะส่วนนี้บอกให้รัน ส่วนอื่นใช้ได้ปกติ) */
  const CL = Claims.mount(router, { db, T, perms, need, meOf, send, teamList, nameOfUser, warn, audit: ctx.audit });
  /** ออฟฟิศ (จุดตั้งต้นของการเดินทาง) — Railway Variables: VISIT_OFFICE = "13.7,100.5|ชื่อออฟฟิศ" (ไม่ตั้ง = ไม่มีปุ่มออฟฟิศ) */
  const office = (() => { const v = clean(process.env.VISIT_OFFICE); if (!v) return null; const [c, lb] = v.split('|'); const p = Trip.point({ link: c, label: clean(lb) || 'ออฟฟิศ', src: 'office' }); return p; })();

  /* ═══ เริ่มต้น ═══ */
  router.get('/api/boot', (req, res) => send(res, async () => {
    res.set('Cache-Control', 'no-store');
    await ready; if (!health.ok) await check();
    const me = meOf(req);
    return { ok: true, version: VERSION.VERSION, me, health: Object.assign({ sqlFile: SQL_FILE }, health), ai: { ready: ai.ready(), engine: ai.engineLabel() },
      team: me.sup ? await teamList() : (await teamList()).filter(u => lower(u.username) === lower(me.username)),
      segments: Seg.SEGMENTS.map(s => ({ key: s.key, label: s.label, icon: s.icon, needs: s.needs })), stages: Seg.STAGES, channels: Seg.CHANNELS, outcomes: Seg.OUTCOMES,   /* 💬 v1.5.0 */
      /* 🚗💰 v1.1.0 */ trip: { vehicles: Trip.VEHICLES, rates: Trip.RATES, office, srcLabel: Trip.SRC_LABEL, maxKm: Trip.MAX_KM, maxToll: Trip.MAX_TOLL },
      claims: { ready: (await CL.cFresh()).ok, sqlFile: Claims.CLAIM_SQL, acc: CL.isAcc(req.user), accOnly: CL.accOnly(req.user), status: Claims.STATUS } };
  }));

  /* ═══ รายการลูกค้า + ภาพรวม ═══ */
  router.get('/api/list', (req, res) => send(res, async () => {
    res.set('Cache-Control', 'no-store');
    await need();
    const me = meOf(req), q = { select: '*', order: 'updated_at.desc' };
    const owner = clean(req.query.owner);
    if (!me.sup) q.owner = 'eq.' + me.username; else if (owner) q.owner = 'eq.' + owner;
    const rows = await db.selectAll(T.p, q);
    const now = Date.now();
    const items = rows.map(pOut).map(p => Object.assign(p, { overdue: !!(p.nextAt && p.nextAt < now && Seg.OPEN_STAGES.indexOf(p.stage) >= 0),
      idle: Seg.OPEN_STAGES.indexOf(p.stage) >= 0 && p.stage !== 'target' && now - p.updatedAt > 14 * DAY,
      doc: { summary: clip((p.doc.ai && p.doc.ai.summary) || p.doc.summary, 220), verdict: clip(p.doc.ai && p.doc.ai.verdict, 200), risk: p.doc.risk ? { level: p.doc.risk.level, label: p.doc.risk.label } : null, contacts: (p.doc.contacts || []).slice(0, 1), lastVisitAt: p.doc.lastVisitAt || 0, analyzed: !!p.doc.ai, imported: !!(p.doc.from && p.doc.from.import) } }));
    const stageN = Object.fromEntries(Seg.STAGES.map(s => [s.key, items.filter(p => p.stage === s.key).length]));
    const openItems = items.filter(p => Seg.OPEN_STAGES.indexOf(p.stage) >= 0);
    const pipeline = openItems.reduce((s, p) => s + (p.value || 0), 0), weighted = openItems.reduce((s, p) => s + (p.value || 0) * (p.chance || 0) / 100, 0);
    /* งานวันนี้ + เลยกำหนด (นัด + งานติดตาม) */
    const ids = new Set(items.map(p => p.id));
    const evq = { status: 'eq.open', kind: 'in.(plan,task)', at: 'lt.' + iso(now + 7 * DAY), select: '*', order: 'at.asc' };
    if (!me.sup) evq.owner = 'eq.' + me.username; else if (owner) evq.owner = 'eq.' + owner;
    const agenda = (await db.selectAll(T.e, evq)).map(eOut).filter(e => ids.has(e.prospectId)).map(e => Object.assign(e, { name: (items.find(p => p.id === e.prospectId) || {}).name || '', overdue: e.at < now }));
    const won = stageN.won || 0, lost = stageN.lost || 0;
    return { ok: true, items, stageN, agenda, kpi: { total: items.length, open: openItems.length, pipeline, weighted, won, lost, winRate: won + lost ? Math.round(won / (won + lost) * 100) : null,
      overdue: agenda.filter(e => e.overdue).length, today: agenda.filter(e => !e.overdue && e.at < new Date(new Date(now + 7 * 3600e3).toISOString().slice(0, 10) + 'T23:59:59+07:00').getTime()).length } };
  }));

  /* ═══ แฟ้มลูกค้า ═══ */
  router.get('/api/prospect/:id', (req, res) => send(res, async () => {
    res.set('Cache-Control', 'no-store');
    await need();
    const me = meOf(req), p = await mustP(me, req.params.id);
    const events = (await db.selectAll(T.e, { prospect_id: 'eq.' + p.id, select: '*', order: 'at.desc' })).map(eOut);
    const cand = { name: p.name, juristicId: p.juristicId };
    return { ok: true, p, events, dbd: Biz.dbdLinks(cand), risk: Biz.scoreRisk(p.doc.fin || null), canEdit: canTouch(me, p) };
  }));

  /* ═══ ค้นหา (อลิซค้นเว็บ) ═══ */
  /* ⚡ v1.0.2 — ค้นแบบ "งาน" : เริ่มแล้วตอบทันที · หน้าจอถามความคืบหน้าทุก ~1.5 วิ ⇒ ชุดไหนเสร็จขึ้นจอก่อน (ไม่ต้องรอครบ)
   *   ‼ เก็บในหน่วยความจำ (หายเมื่อรีสตาร์ต) — ผลสุดท้ายยังบันทึกลง visit_searches เหมือนเดิม */
  const jobs = new Map();
  const sweepJobs = () => { const old = Date.now() - 15 * 60e3; for (const [k, v] of jobs) if (v.at < old) jobs.delete(k); };
  async function runSearch(me, b, onPart) {
    if (!Seg.SEG[clean(b.segment)] && !clean(b.extra)) throw uerr('เลือกกลุ่มธุรกิจ หรือพิมพ์สิ่งที่ต้องการค้นก่อน');
    if (!ai.ready()) throw uerr('ยังไม่ได้ตั้ง GEMINI_API_KEY หรือ ANTHROPIC_API_KEY ใน Railway — อลิซค้นหาให้ไม่ได้', 503);
    const all = await db.selectAll(T.p, { select: 'id,name,name_key,phone,owner', order: 'id.asc' });
    const q = { segment: clean(b.segment), area: clip(b.area, 80), extra: clip(b.extra, 200), count: Math.max(3, Math.min(20, Math.round(Number(b.count) || 10))) };
    const byKey = new Map(all.map(x => [x.name_key, x])), byPhone = new Map(all.filter(x => phoneKey(x.phone).length >= 8).map(x => [phoneKey(x.phone), x]));
    const mark = list => list.map(it => { const hit = byKey.get(nameKey(it.name)) || (phoneKey(it.phone).length >= 8 && byPhone.get(phoneKey(it.phone))); return Object.assign({}, it, { existing: hit ? { id: hit.id, owner: hit.owner } : null }); });
    const segAll = all.map(x => x.name);
    const r = await ai.search(Object.assign({ exclude: segAll.slice(-25) }, q), onPart ? (items, done, total) => onPart(mark(items), done, total) : null);
    const items = mark(r.items);
    const row = { id: rid('vs_'), by_user: me.username, query: q, results: items, engine: r.engine };
    await db.insert(T.s, [row]).catch(e => warn('B2B Visit: เก็บผลค้นหาไม่สำเร็จ ' + errText(e)));
    if (ctx.audit) ctx.audit(me.req || {}, 'visit_search', { segment: q.segment, area: q.area, n: items.length, ms: r.ms });
    return { ok: true, id: row.id, items, sources: r.sources, engine: r.engine, query: q, ms: r.ms, partsFailed: r.partsFailed || 0 };
  }
  router.post('/api/search', (req, res) => send(res, async () => {
    await need();
    const me = Object.assign(meOf(req), { req: req.user }), b = req.body || {};
    if (!b.stream) return runSearch(me, b, null);
    sweepJobs();
    if (!Seg.SEG[clean(b.segment)] && !clean(b.extra)) throw uerr('เลือกกลุ่มธุรกิจ หรือพิมพ์สิ่งที่ต้องการค้นก่อน');
    if (!ai.ready()) throw uerr('ยังไม่ได้ตั้ง GEMINI_API_KEY หรือ ANTHROPIC_API_KEY ใน Railway — อลิซค้นหาให้ไม่ได้', 503);
    const job = { id: rid('vj_'), by: me.username, at: Date.now(), items: [], done: 0, total: 0, finished: false, error: '', result: null };
    jobs.set(job.id, job);
    runSearch(me, b, (items, done, total) => { job.items = items; job.done = done; job.total = total; })
      .then(r => { job.result = r; job.items = r.items; job.finished = true; })
      .catch(e => { job.error = errText(e); job.finished = true; if (!e.userError) warn('B2B Visit: ค้นหาไม่สำเร็จ ' + errText(e)); });
    return { ok: true, job: job.id };
  }));
  router.get('/api/search/job/:id', (req, res) => send(res, async () => {
    const me = meOf(req), job = jobs.get(clean(req.params.id));
    if (!job || (job.by !== me.username && !me.sup)) throw uerr('ไม่พบงานค้นหานี้ (เซิร์ฟเวอร์อาจเพิ่งรีสตาร์ต) — กดค้นใหม่อีกครั้ง', 404);
    return { ok: true, finished: job.finished, error: job.error, done: job.done, total: job.total, sec: Math.round((Date.now() - job.at) / 1000),
      items: job.items, id: job.result ? job.result.id : '', engine: job.result ? job.result.engine : '', partsFailed: job.result ? job.result.partsFailed : 0 };
  }));
  /* 🩺 v1.0.2 — ตรวจการเชื่อมต่ออลิซ (หัวหน้า/แอดมิน) — ถามสั้น ๆ 1 ครั้ง บอกเวลาที่ใช้และข้อผิดพลาดจริง */
  router.get('/api/ai/test', (req, res) => send(res, async () => {
    const me = meOf(req);
    if (!me.sup) throw uerr('เฉพาะหัวหน้า/แอดมิน', 403);
    const t0 = Date.now();
    try { const r = await ai.ping(); return { ok: true, engine: ai.engineLabel(), ms: Date.now() - t0, reply: r, stat: ai.stat() }; }
    catch (e) { return { ok: true, fail: true, engine: ai.engineLabel(), ms: Date.now() - t0, error: errText(e), stat: ai.stat() }; }
  }));
  router.get('/api/searches', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), q = { select: 'id,by_user,query,engine,created_at,results', order: 'created_at.desc', limit: 20 };
    if (!me.sup) q.by_user = 'eq.' + me.username;
    const rows = await db.select(T.s, q);
    return { ok: true, items: rows.map(r => ({ id: r.id, by: r.by_user, query: r.query, engine: r.engine, at: ms(r.created_at), n: (r.results || []).length })) };
  }));
  router.get('/api/search/:id', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), r = await db.one(T.s, { id: 'eq.' + clean(req.params.id), select: '*' });
    if (!r || (!me.sup && lower(r.by_user) !== lower(me.username))) throw uerr('ไม่พบผลการค้นหานี้', 404);
    const all = await db.selectAll(T.p, { select: 'id,name_key,owner', order: 'id.asc' });
    const byKey = new Map(all.map(x => [x.name_key, x]));
    return { ok: true, id: r.id, query: r.query, engine: r.engine, at: ms(r.created_at), items: (r.results || []).map(it => Object.assign(it, { existing: (byKey.get(nameKey(it.name)) && { id: byKey.get(nameKey(it.name)).id, owner: byKey.get(nameKey(it.name)).owner }) || null })) };
  }));

  /* ═══ บันทึกลูกค้าเป้าหมาย (จากผลค้นหา หรือกรอกเอง) ═══ */
  /* ═══ 🔎 v1.5.1 (7 พ.ย. 69) ลูกค้าเดิมในคีย์ยอดขาย ⇒ ดึงมาติดตาม (แชท / โทร / นัดในปฏิทิน) โดยไม่ต้อง visit
   *  พี่เอ: "ในส่วนของลูกค้า ให้สามารถค้นหาลูกค้าเดิมที่มีในระบบ ขึ้นมาทำการ ติดตาม update โดยไม่ต้อง visit ได้ด้วยนะ
   *         เช่น โทรติดตาม chat ติดตาม และลงแผนกิจกรรมในปฏิทินได้เหมือนกับ การ visit สำหรับ user online"
   *  · ค้น total_sales ตาม ชื่อบริษัท / ผู้ติดต่อ / เบอร์ / รหัสงาน · เซลส์เห็นเฉพาะใบของตัวเอง (Sales Code) · หัวหน้าเห็นทุกใบ
   *  · ดึงเข้ามา = สร้างลูกค้าในแอปนี้ ผูกกับใบเดิม (doc.sales.linked) ⇒ ไม่ออกรหัสงานใหม่ ไม่เปิดใบ B2B ซ้ำ
   *  · อ่านเฉพาะตอนกดค้น (ไม่อยู่ในทางเปิดแอป) · ≤ 60 แถว/ครั้ง */
  const SALES_T = 'total_sales';
  const SALES_COLS = ['_row', 'รหัสงาน', 'ชื่อบริษัท', 'ชื่อผู้ติดต่อ', 'เบอร์ติดต่อ', 'Lead Status', 'วันที่ติดต่อ', 'ลูกค้ามาจากไหน', 'ชื่อช่อง / Platform', 'Sales Code', 'Create By'];
  const qcol = c => /^[a-z_]+$/.test(c) ? c : '"' + c.replace(/"/g, '""') + '"';
  const sOut = r => ({ row: Number(r._row), jobCode: clean(r['รหัสงาน']), company: clean(r['ชื่อบริษัท']), contact: clean(r['ชื่อผู้ติดต่อ']), phone: clean(r['เบอร์ติดต่อ']),
    status: clean(r['Lead Status']), date: clean(r['วันที่ติดต่อ']), source: clean(r['ลูกค้ามาจากไหน']), channel: clean(r['ชื่อช่อง / Platform']), sales: clean(r['Sales Code']), salesNick: clean(r['Create By']) });
  router.get('/api/existing', (req, res) => send(res, async () => {
    res.set('Cache-Control', 'no-store');
    await need();
    const me = meOf(req), q = clean(req.query.q).replace(/[,()*"\\]/g, ' ').trim();
    if (q.length < 2) throw uerr('พิมพ์อย่างน้อย 2 ตัวอักษร');
    const like = 'ilike.*' + q.replace(/\s+/g, '*') + '*';
    const digits = q.replace(/\D/g, '');
    const terms = ['ชื่อบริษัท', 'ชื่อผู้ติดต่อ', 'รหัสงาน'].map(c => qcol(c) + '.' + like);
    /* เบอร์ในใบมีขีด/เว้นวรรคปนได้ (089-111-2233) ⇒ แทรก * ระหว่างตัวเลข ให้พิมพ์ติดกันก็เจอ */
    if (digits.length >= 4) terms.push(qcol('เบอร์ติดต่อ') + '.ilike.*' + digits.slice(-10).split('').join('*') + '*');
    const qq = { select: SALES_COLS.map(qcol).join(','), or: '(' + terms.join(',') + ')', order: '_row.desc', limit: 60 };
    if (!me.sup) qq['Sales Code'] = 'ilike.' + me.username;
    let rows;
    try { rows = (await db.select(SALES_T, qq)) || []; } catch (e) { throw uerr('ค้นคีย์ยอดขายไม่สำเร็จ: ' + errText(e), 502); }
    /* รวมใบของลูกค้าคนเดียวกัน (ชื่อบริษัท/ผู้ติดต่อ) ⇒ แสดงใบล่าสุด + จำนวนใบ */
    const by = new Map();
    for (const r of rows.map(sOut)) {
      const k = nameKey(r.company || r.contact) || ('row' + r.row);
      if (!by.has(k)) by.set(k, Object.assign(r, { jobs: 1, key: k })); else by.get(k).jobs++;
    }
    const items = [...by.values()].slice(0, 20);
    const keys = items.map(x => x.key).filter(k => !/^row/.test(k));
    const have = keys.length ? await db.select(T.p, { name_key: 'in.(' + keys.map(k => '"' + k.replace(/"/g, '') + '"').join(',') + ')', select: 'id,name_key,owner' }).catch(() => []) : [];
    for (const x of items) { const h = (have || []).find(p => p.name_key === x.key); x.inVisit = h ? { id: h.id, owner: h.owner, mine: me.sup || lower(h.owner) === lower(me.username) } : null; delete x.key; }
    return { ok: true, items, total: rows.length, mineOnly: !me.sup };
  }));
  router.post('/api/existing/add', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), rowNo = Number((req.body || {}).row);
    if (!Number.isInteger(rowNo) || rowNo <= 0) throw uerr('ไม่พบใบนี้');
    const r0 = await db.one(SALES_T, { _row: 'eq.' + rowNo, select: SALES_COLS.map(qcol).join(',') });
    if (!r0) throw uerr('ไม่พบใบนี้ในคีย์ยอดขาย', 404);
    const r = sOut(r0);
    if (!me.sup && lower(r.sales) !== lower(me.username)) throw uerr('ใบนี้เป็นลูกค้าของ ' + (r.salesNick || r.sales || 'เซลส์คนอื่น') + ' — ให้หัวหน้าโอนให้ก่อน', 403);
    const name = r.company || r.contact;
    if (!name) throw uerr('ใบนี้ไม่มีชื่อบริษัท/ผู้ติดต่อ');
    const key = nameKey(name);
    const dup = key ? await db.one(T.p, { name_key: 'eq.' + key, select: 'id,owner' }) : null;
    if (dup) {
      if (!me.sup && lower(dup.owner) !== lower(me.username)) throw uerr('"' + name + '" เป็นลูกค้าที่ ' + dup.owner + ' ดูแลในแอปนี้อยู่แล้ว — ให้หัวหน้าโอนให้ก่อน', 403);
      return { ok: true, id: dup.id, existing: true, name };
    }
    const owner = me.sup ? (r.sales || me.username) : me.username;
    const row = Object.assign(prow({ name, phone: r.phone }, me, owner), { id: rid('vp_'), stage: 'target', chance: Seg.STAGE_CHANCE.target, created_by: me.username,
      doc: { from: { sales: r.jobCode, row: r.row }, contacts: r.contact ? [{ name: r.contact, role: '', phone: r.phone, line: '' }] : [],
        note: 'ลูกค้าเดิมจากคีย์ยอดขาย ' + r.jobCode + (r.source ? ' · ' + r.source : '') + (r.channel ? ' · ' + r.channel : '') + (r.status ? ' · ' + r.status : ''),
        sales: r.jobCode ? { jobCode: r.jobCode, row: r.row, linked: true, at: Date.now() } : undefined } });
    await db.insert(T.p, [row]);
    if (ctx.audit) ctx.audit(req.user, 'visit_existing_add', { id: row.id, name, jobCode: r.jobCode });
    return { ok: true, id: row.id, existing: false, name };
  }));

  router.post('/api/prospect/save', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), x = (req.body && req.body.item) || {};
    if (!clean(x.name)) throw uerr('ต้องมีชื่อบริษัท');
    const owner = me.sup && clean(req.body.owner) ? clean(req.body.owner) : me.username;
    const key = nameKey(x.name);
    const dup = key ? await db.one(T.p, { name_key: 'eq.' + key, select: 'id,owner' }) : null;
    if (dup) return { ok: true, id: dup.id, existing: true, owner: dup.owner };
    const row = Object.assign(prow(x, me, owner), { id: rid('vp_'), stage: 'target', chance: Seg.STAGE_CHANCE.target, created_by: me.username,
      doc: { summary: clip(x.summary, 900), size: clip(x.size, 160), signals: (x.signals || []).slice(0, 5).map(s => clip(s, 200)), reasons: (x.reasons || []).slice(0, 5).map(s => clip(s, 220)),
        pitch: (x.pitch || []).slice(0, 5).map(s => clip(s, 200)), sources: (x.sources || []).filter(u => /^https?:\/\//.test(u)).slice(0, 6), from: req.body.searchId ? { search: clip(req.body.searchId, 40) } : { manual: true },
        contacts: [] } });
    await db.insert(T.p, [row]);
    if (ctx.audit) ctx.audit(req.user, 'visit_prospect_add', { id: row.id, name: row.name, owner });
    return { ok: true, id: row.id };
  }));
  router.post('/api/prospect/update', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), b = req.body || {}, p = await mustP(me, b.id), f = b.fields || {};
    const patch = {}, doc = Object.assign({}, p.doc);
    for (const [k, col, n] of [['name', 'name', 160], ['phone', 'phone', 60], ['address', 'address', 300], ['province', 'province', 60], ['bizType', 'biz_type', 120]]) if (f[k] !== undefined) patch[col] = clip(f[k], n);
    if (f.name !== undefined) { if (!clean(f.name)) throw uerr('ชื่อบริษัทต้องไม่ว่าง'); patch.name_key = nameKey(f.name); }
    if (f.website !== undefined) patch.website = /^https?:\/\//i.test(clean(f.website)) ? clip(f.website, 300) : '';
    if (f.juristicId !== undefined) { const id = clean(f.juristicId).replace(/\D/g, ''); if (id && !Biz.validId(id)) throw uerr('เลขทะเบียนนิติบุคคลไม่ถูกต้อง (13 หลัก)'); patch.juristic_id = id; }
    if (f.segment !== undefined) patch.segment = Seg.SEG[clean(f.segment)] ? clean(f.segment) : '';
    if (f.value !== undefined) patch.value = Math.max(0, Math.round(Number(String(f.value).replace(/[^\d.]/g, '')) || 0));
    if (f.owner !== undefined) { if (!me.sup) throw uerr('เปลี่ยนเซลส์ผู้ดูแลได้เฉพาะหัวหน้า/ผู้ดูแล', 403); patch.owner = clip(f.owner, 80); }
    if (Array.isArray(f.contacts)) doc.contacts = f.contacts.slice(0, 8).map(c => ({ name: clip(c && c.name, 80), role: clip(c && c.role, 80), phone: clip(c && c.phone, 40), line: clip(c && c.line, 60), email: clip(c && c.email, 120) })).filter(c => c.name || c.phone || c.email || c.line);
    if (f.note !== undefined) doc.note = String(f.note || '').slice(0, 2000);
    patch.doc = doc;
    let out = await saveP(p, patch);
    if (f.stage !== undefined && f.stage !== p.stage) out = await setStage(out, me, clean(f.stage), clip(f.stageWhy, 400));
    return { ok: true, p: out };
  }));
  router.post('/api/prospect/delete', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), p = await mustP(me, (req.body || {}).id);
    await db.remove(T.e, { prospect_id: 'eq.' + p.id });
    await db.remove(T.p, { id: 'eq.' + p.id });
    if (ctx.audit) ctx.audit(req.user, 'visit_prospect_delete', { id: p.id, name: p.name });
    return { ok: true };
  }));

  /* ═══ อลิซเจาะลึกบริษัท ═══ */
  router.post('/api/prospect/analyze', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), p = await mustP(me, (req.body || {}).id);
    if (!ai.ready()) throw uerr('ยังไม่ได้ตั้ง GEMINI_API_KEY หรือ ANTHROPIC_API_KEY ใน Railway', 503);
    return { ok: true, p: await analyzeOne(p) };
  }));
  async function analyzeOne(p) {
    const risk = Biz.scoreRisk(p.doc.fin || null);
    const a = await ai.analyzeCompany(Object.assign({}, p, { verdict: '' }), risk);
    const patch = { score: a.score, fit: a.fit, doc: Object.assign({}, p.doc, { ai: a }) };
    if (!p.phone && a.phone) patch.phone = a.phone;
    if (!p.website && a.website) patch.website = a.website;
    if (!p.address && a.address) patch.address = a.address;
    if (!p.juristicId && a.juristicId) patch.juristic_id = a.juristicId;
    if (!p.bizType && a.bizType) patch.biz_type = a.bizType;
    return saveP(p, patch);
  }

  /* ═══ 📥🤖 v1.2.0 นำเข้าลูกค้าที่เซลส์หาไว้เอง + ให้อลิซวิเคราะห์ทีละราย ═══
   *  พี่เอ 22 ต.ค. 69: "ใน app leads & customer visit พี่ต้องการให้ ทีมขาย ใส่ชื่อลูกค้าของตัวเองที่หาไว้ก่อนแล้ว
   *     ให้เราช่วยวิเคราะห์ให้ด้วยนะ ว่าลูกค้าแต่ละรายเป็นอย่างไร ควรโฟกัสหรือไม่"
   *  POST /api/prospect/import  { lines:[{name,province,phone,note}], owner?, analyze } ⇒ { job } (สร้างลูกค้าทันที · อลิซวิเคราะห์เบื้องหลังทีละ 2 ราย)
   *  POST /api/prospect/analyze-many { ids } ⇒ { job } (วิเคราะห์ลูกค้าที่มีอยู่แล้ว เช่น "ยังไม่ได้วิเคราะห์")
   *  GET  /api/prospect/job/:id ⇒ ความคืบหน้า + ผลรายราย (ควร focus ไหม · คะแนน · เหตุผล)
   *  ‼ ครั้งละไม่เกิน 30 ราย (ค่า AI) · ลูกค้าที่เป็นของเซลส์คนอื่นแล้ว ⇒ ไม่แตะ บอกว่าเป็นของใคร */
  const IMPORT_MAX = 30;
  const ajobs = new Map();
  const ajobOut = j => ({ id: j.id, by: j.by, at: j.at, finished: j.finished, done: j.items.filter(x => ['done', 'error', 'skip', 'other'].indexOf(x.status) >= 0).length, total: j.items.length,
    items: j.items.map(x => Object.assign({}, x)), sec: Math.round((Date.now() - j.at) / 1000) });
  function startAnalyzeJob(me, items, analyze) {
    for (const [k, v] of ajobs) if (v.at < Date.now() - 60 * 60e3) ajobs.delete(k);
    const job = { id: rid('va_'), by: me.username, at: Date.now(), finished: false, items };
    ajobs.set(job.id, job);
    const queue = items.filter(x => x.status === 'queued');
    if (!analyze || !ai.ready()) { queue.forEach(x => { x.status = 'skip'; x.note = ai.ready() ? 'ไม่ได้ให้วิเคราะห์' : 'ยังไม่ได้ตั้งกุญแจ AI'; }); job.finished = true; return job; }
    let i = 0;
    const worker = async () => {
      while (i < queue.length) {
        const x = queue[i++]; x.status = 'running';
        try {
          const p = await db.one(T.p, { id: 'eq.' + x.id, select: '*' });
          if (!p) throw uerr('ไม่พบลูกค้า');
          const out = await analyzeOne(pOut(p)), a = (out.doc || {}).ai || {};
          Object.assign(x, { status: 'done', fit: out.fit, score: out.score, verdict: clip(a.verdict, 300), reasons: (a.reasons || []).slice(0, 3), bizType: out.bizType || '', province: out.province || '' });
        } catch (e) { x.status = 'error'; x.note = clip(errText(e), 200); warn('B2B Visit: วิเคราะห์ ' + x.name + ' ไม่สำเร็จ ' + errText(e)); }
      }
    };
    Promise.all([worker(), worker()]).then(() => { job.finished = true; if (ctx.audit) ctx.audit({ username: me.username }, 'visit_import_analyze', { n: items.length }); });
    return job;
  }
  router.post('/api/prospect/import', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), b = req.body || {};
    const lines = (Array.isArray(b.lines) ? b.lines : []).map(l => ({ name: clip(l && l.name, 160), province: clip(l && l.province, 60), phone: clip(l && l.phone, 60), note: clip(l && l.note, 500) })).filter(l => l.name.length >= 2);
    if (!lines.length) throw uerr('ใส่ชื่อลูกค้าอย่างน้อย 1 ราย (บรรทัดละ 1 ราย)');
    if (lines.length > IMPORT_MAX) throw uerr('ครั้งละไม่เกิน ' + IMPORT_MAX + ' ราย — แบ่งส่งเป็นหลายรอบ');
    const owner = me.sup && clean(b.owner) ? clean(b.owner) : me.username;
    const seen = new Set(), items = [];
    for (const l of lines) {
      const key = nameKey(l.name);
      if (!key || seen.has(key)) continue; seen.add(key);
      const dup = await db.one(T.p, { name_key: 'eq.' + key, select: 'id,owner,doc' });
      if (dup) {
        const mine = lower(dup.owner) === lower(owner) || me.sup;
        items.push({ id: dup.id, name: l.name, status: mine ? 'queued' : 'other', existing: true, owner: dup.owner, ownerName: mine ? '' : nameOfUser(await teamList().catch(() => []), dup.owner),
          note: mine ? 'มีในระบบแล้ว — วิเคราะห์ใหม่' : 'เป็นลูกค้าของเซลส์คนอื่นแล้ว' });
        continue;
      }
      const row = Object.assign(prow({ name: l.name, province: l.province, phone: l.phone }, me, owner), { id: rid('vp_'), stage: 'target', chance: Seg.STAGE_CHANCE.target, created_by: me.username,
        doc: { summary: '', note: l.note, from: { manual: true, import: true }, contacts: [] } });
      await db.insert(T.p, [row]);
      items.push({ id: row.id, name: l.name, status: 'queued', existing: false });
    }
    if (ctx.audit) ctx.audit(req.user, 'visit_import', { n: items.length, owner });
    return { ok: true, job: ajobOut(startAnalyzeJob(me, items, b.analyze !== false)) };
  }));
  router.post('/api/prospect/analyze-many', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), ids = [...new Set((Array.isArray((req.body || {}).ids) ? req.body.ids : []).map(clean).filter(Boolean))];
    if (!ids.length) throw uerr('เลือกลูกค้าก่อน');
    if (ids.length > IMPORT_MAX) throw uerr('ครั้งละไม่เกิน ' + IMPORT_MAX + ' ราย');
    if (!ai.ready()) throw uerr('ยังไม่ได้ตั้ง GEMINI_API_KEY หรือ ANTHROPIC_API_KEY ใน Railway', 503);
    const items = [];
    for (const id of ids) { const p = await mustP(me, id); items.push({ id: p.id, name: p.name, status: 'queued', existing: true }); }
    return { ok: true, job: ajobOut(startAnalyzeJob(me, items, true)) };
  }));
  router.get('/api/prospect/job/:id', (req, res) => send(res, async () => {
    res.set('Cache-Control', 'no-store');
    const me = meOf(req), j = ajobs.get(clean(req.params.id));
    if (!j || (lower(j.by) !== lower(me.username) && !me.sup)) throw uerr('ไม่พบงานนี้ (เซิร์ฟเวอร์อาจเพิ่งรีสตาร์ต) — ลูกค้าที่เพิ่มแล้วยังอยู่ กด "ให้อลิซวิเคราะห์" ในแฟ้มได้', 404);
    return { ok: true, job: ajobOut(j) };
  }));

  /* ═══ งบการเงินจาก DBD (วางตาราง/กรอกเอง — ฟรี ตัวเดียวกับ Ant-Connect) ═══ */
  router.post('/api/prospect/fin', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), b = req.body || {}, p = await mustP(me, b.id);
    let fin;
    if (b.clear) fin = null;
    else if (clean(b.text)) { fin = Biz.parseDbd(b.text); if (!fin.years.length && !fin.status && fin.capital === null) throw uerr('อ่านตัวเลขจากข้อความที่วางไม่ได้ — คัดลอกตาราง "งบแสดงฐานะการเงิน" และ "งบกำไรขาดทุน" จาก DataWarehouse+ มาวาง'); }
    else fin = Biz.normFin(b.form || {});
    const risk = fin ? Biz.scoreRisk(fin) : null;
    const patch = { doc: Object.assign({}, p.doc, { fin: fin ? Object.assign(fin, { by: me.username, at: Date.now() }) : null, risk: risk ? { level: risk.level, label: risk.label } : null }) };
    if (fin && fin.juristicId && !p.juristicId) patch.juristic_id = fin.juristicId;
    return { ok: true, p: await saveP(p, patch), risk };
  }));

  /* ═══ 🧾 25 ต.ค. 69 — ลูกค้าที่วางแผนติดต่อแล้ว ⇒ เปิดใบในคีย์ยอดขาย (B2B) + รหัสงานอัตโนมัติ (salesjob.js) ═══ */
  const SJ = require('./salesjob').create({ db, warn });
  async function toSales(p) {
    let latest = null;
    const r = await SJ.ensure(p, async patch => { latest = await saveP(latest || p, patch); return latest; }).catch(e => ({ error: errText(e) }));
    return { p: latest || p, sales: r };
  }
  let sjRun = null;
  async function salesSync(force) {
    if (sjRun) return sjRun;
    sjRun = (async () => {
      await ready; if (!health.ok) return { ok: false, error: 'ตารางของแอปยังไม่พร้อม' };
      const rows = (await db.selectAll(T.p, { select: '*', order: 'id.asc', stage: 'in.(' + SJ.PLANNED.join(',') + ')' })) || [];
      const more = (await db.selectAll(T.p, { select: '*', order: 'id.asc', stage: 'eq.target', next_at: 'not.is.null' }).catch(() => [])) || [];
      let made = 0, linked = 0, failed = 0, skipped = 0;
      for (const r of rows.concat(more)) {
        const p = pOut(r), d = p.doc || {};
        if (d.sales && d.sales.jobCode) continue;
        if (!force && d.salesErr && Date.now() - (d.salesErr.at || 0) < 6 * 3600e3) { skipped++; continue; }   /* ติดเหตุเดิม (เช่นยังไม่มีคำนำหน้า) ⇒ ลองใหม่ทุก 6 ชม. */
        const x = await toSales(p);
        if (x.sales.jobCode) { if (x.sales.linked) linked++; else made++; } else if (x.sales.error) failed++;
      }
      return { ok: true, made, linked, failed, skipped };
    })().finally(() => { sjRun = null; });
    return sjRun;
  }
  setTimeout(() => salesSync().catch(e => warn('B2B Visit: ซิงก์ใบคีย์ยอดขาย ' + errText(e))), 90e3).unref?.();
  setInterval(() => salesSync().catch(e => warn('B2B Visit: ซิงก์ใบคีย์ยอดขาย ' + errText(e))), 15 * 60e3).unref?.();
  router.post('/api/sales-sync', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), b = req.body || {};
    if (b.prospectId) { const p = await mustP(me, b.prospectId); const x = await toSales(p); if (x.sales.error) throw uerr(x.sales.error); return { ok: true, p: x.p, sales: x.sales }; }
    if (!me.sup) throw uerr('เฉพาะหัวหน้า/ผู้ดูแล', 403);
    return salesSync(true);
  }));

  /* ═══ นัด visit · งานติดตาม ═══ */
  const atOf = v => { const t = typeof v === 'number' ? v : Date.parse(String(v || '')); if (!Number.isFinite(t) || t < Date.now() - 400 * DAY || t > Date.now() + 400 * DAY) throw uerr('วันเวลาไม่ถูกต้อง'); return t; };
  router.post('/api/plan', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), b = req.body || {}; let p = await mustP(me, b.prospectId);
    const at = atOf(b.at), mins = Math.max(15, Math.min(480, Math.round(Number(b.minutes) || 60)));
    const ev = await addEvent(p, me, { kind: 'plan', at, title: clip(b.title, 200) || 'visit ' + p.name, body: b.note, doc: { minutes: mins, place: clip(b.place, 300) || p.address, goal: clip(b.goal, 300) } });
    if (p.stage === 'target') p = await setStage(p, me, 'planned', 'นัด visit ' + new Date(at).toISOString().slice(0, 10));
    p = await refreshNext(p);
    const x = await toSales(p);                     /* 🧾 วางแผนติดต่อแล้ว ⇒ เปิดใบคีย์ยอดขาย B2B ทันที */
    return { ok: true, event: ev, p: x.p, sales: x.sales };
  }));
  router.post('/api/task', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), b = req.body || {}; let p = await mustP(me, b.prospectId);
    if (!clean(b.title)) throw uerr('พิมพ์ว่าจะติดตามอะไร');
    const ch = Seg.CHANNEL[clean(b.channel)] ? clean(b.channel) : 'other';
    const ev = await addEvent(p, me, { kind: 'task', at: atOf(b.at), title: clip(b.title, 200), body: b.note, doc: { channel: ch } });
    p = await refreshNext(p);
    const x = await toSales(p);                     /* 🧾 มีงานติดตาม = วางแผนติดต่อแล้ว ⇒ เปิดใบคีย์ยอดขาย B2B */
    return { ok: true, event: ev, p: x.p, sales: x.sales };
  }));
  router.post('/api/event/update', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), b = req.body || {};
    const r = await db.one(T.e, { id: 'eq.' + clean(b.id), select: '*' });
    if (!r) throw uerr('ไม่พบรายการนี้', 404);
    let p = await mustP(me, r.prospect_id);
    const patch = { updated_at: iso(Date.now()) };
    if (b.status !== undefined) { if (['open', 'done', 'cancelled'].indexOf(clean(b.status)) < 0) throw uerr('สถานะไม่ถูกต้อง'); patch.status = clean(b.status); }
    if (b.at !== undefined) patch.at = iso(atOf(b.at));
    if (b.result !== undefined) patch.doc = Object.assign({}, r.doc || {}, { result: clip(b.result, 600), doneBy: me.username, doneAt: Date.now() });
    await db.update(T.e, { id: 'eq.' + r.id }, patch);
    p = await refreshNext(p);
    return { ok: true, p };
  }));

  /* ═══ 💬 v1.5.0 (7 พ.ย. 69) บันทึกการติดตาม — แชท / โทร (ไม่ต้องออกไปหาลูกค้า)
   *  พี่เอ: "ให้เพิ่มส่วนการติดตามลูกค้าที่ไม่การ visit ด้วยนะ เช่น แชทติดตาม โทรติดตาม ให้กับทีม ขาย online ด้วยนะ
   *         เพราะเค้าไม่ได้ออกไปหาลูกค้า"
   *  · kind 'follow' (status done) · doc: ช่องทาง · ผล · รูปแคปแชท (≤ 4 · ย่อ ≤150KB เก็บ Storage) · งานที่ทำเสร็จ (taskId)
   *  · ผล "ขอใบเสนอราคา" ⇒ ขั้นเสนอราคา · "ปิดการขายได้" ⇒ ปิดการขาย · "ไม่สนใจ" ⇒ ไม่ได้งาน (ไม่ถอยขั้น)
   *  · นัดติดตามครั้งถัดไป (ไม่บังคับ) ⇒ งานติดตามใหม่ลงปฏิทิน
   *  · ไม่ใช้ AI ไม่มีค่า API · นับคะแนน "ติดตามลูกค้า" ใน Report & Ranking */
  router.post('/api/follow', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), b = req.body || {}; let p = await mustP(me, b.prospectId);
    const ch = Seg.CHANNEL[clean(b.channel)] ? clean(b.channel) : '';
    if (!ch) throw uerr('เลือกช่องทางที่ติดตาม (โทร / LINE / Facebook …)');
    const oc = Seg.OUTCOME[clean(b.outcome)];
    if (!oc) throw uerr('เลือกผลการติดตาม');
    const note = String(b.note || '').trim().slice(0, 4000);
    if (note.length < 5) throw uerr('เขียนสรุปสั้น ๆ ว่าคุยอะไรกับลูกค้า (อย่างน้อย 5 ตัวอักษร)');
    const at = b.at ? atOf(b.at) : Date.now();
    if (at > Date.now() + 10 * 60e3) throw uerr('เวลาที่ติดตามต้องไม่เกินตอนนี้ (ถ้าจะนัดล่วงหน้า ใช้ "+ งานติดตาม")');
    let next = null;
    if (b.next && b.next.at) {
      const nAt = atOf(b.next.at);
      if (nAt <= Date.now()) throw uerr('วันนัดติดตามครั้งถัดไปต้องเป็นเวลาข้างหน้า');
      next = { at: nAt, channel: Seg.CHANNEL[clean(b.next.channel)] ? clean(b.next.channel) : ch, title: clip(b.next.title, 200) };
    }
    const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 4);
    const id = rid('ve_'), saved = [];
    for (let i = 0; i < photos.length; i++) {
      const big = await shrink150(bufOfData(photos[i]));
      const path = 'visit/' + p.id + '/' + id + '-' + (i + 1) + '.jpg';
      try { const u = await storage.upload(path, big, 'image/jpeg', { shrink: false, immutable: true }); saved.push({ url: u.url, path: u.path || path, bytes: big.length }); }
      catch (e) { throw uerr('อัปโหลดรูปไม่สำเร็จ: ' + errText(e), 502); }
    }
    const taskId = clean(b.taskId);
    const row = { id, prospect_id: p.id, kind: 'follow', status: 'done', at: iso(at), owner: p.owner || me.username, by_user: me.username,
      title: clip(b.title, 200) || (Seg.CHANNEL[ch].label + ' · ' + oc.label), body: note,
      doc: { channel: ch, outcome: oc.key, photos: saved, taskId } };
    await db.insert(T.e, [row]);
    /* งานติดตามที่ทำเสร็จจากการติดตามครั้งนี้ */
    if (taskId) await db.update(T.e, { id: 'eq.' + taskId, prospect_id: 'eq.' + p.id, status: 'eq.open' }, { status: 'done', updated_at: iso(Date.now()), doc: { channel: ch, result: clip(oc.label + ' — ' + note, 600), doneBy: me.username, doneAt: Date.now(), followId: id } }).catch(() => {});
    /* ขั้นการขาย: ขยับไปข้างหน้าเท่านั้น · ปิดการขาย/ไม่ได้งาน ตามผล */
    if (oc.stage && p.stage !== oc.stage && p.stage !== 'won' && (oc.stage === 'won' || oc.stage === 'lost' || further(oc.stage, p.stage)))
      p = await setStage(p, me, oc.stage, 'ติดตามทาง' + Seg.CHANNEL[ch].label + ': ' + oc.label);
    let nextEv = null;
    if (next && p.stage !== 'won' && p.stage !== 'lost') nextEv = await addEvent(p, me, { kind: 'task', at: next.at, title: next.title || ('ติดตามต่อ · ' + oc.label), doc: { channel: next.channel, fromFollow: id } });
    p = await saveP(p, { doc: Object.assign({}, p.doc, { lastFollowAt: at, lastFollow: { channel: ch, outcome: oc.key } }) });
    p = await refreshNext(p);
    /* ‼ v1.5.1 ไม่เปิดใบคีย์ยอดขาย B2B จากการติดตามทางแชท/โทร — ลูกค้า online มีใบตามช่องทางของตัวเองอยู่แล้ว (ไม่ให้ไปนับเป็น B2B) */
    if (ctx.audit) ctx.audit(req.user, 'visit_follow', { id: p.id, name: p.name, channel: ch, outcome: oc.key, photos: saved.length });
    return { ok: true, event: eOut(row), next: nextEv, p };
  }));

  /* ═══ บันทึก visit: รูป + สรุป ⇒ อลิซวิเคราะห์ ⇒ งานถัดไปอัตโนมัติ ═══ */
  async function runVisitAI(p, me, ev, images) {
    const hist = (await db.selectAll(T.e, { prospect_id: 'eq.' + p.id, kind: 'in.(visit,stage,task,follow)', select: 'kind,at,title,body,status', order: 'at.asc' }))
      .filter(x => x.at && ms(x.at) < ev.at).map(x => new Date(ms(x.at) + 7 * 3600e3).toISOString().slice(0, 10) + ' ' + x.kind + ': ' + clip(x.title + ' ' + (x.body || ''), 200));
    const a = await ai.analyzeVisit(Object.assign({ verdict: p.doc.ai && p.doc.ai.verdict }, p), { note: ev.body, history: hist }, images);
    await db.update(T.e, { id: 'eq.' + ev.id }, { doc: Object.assign({}, ev.doc, { ai: a }), updated_at: iso(Date.now()) });
    /* งานถัดไปที่อลิซแนะนำ ⇒ ลงรายการติดตามให้ (เซลส์แก้/ปิดได้) */
    const tasks = [];
    for (const s of a.nextSteps) tasks.push(await addEvent(p, me, { kind: 'task', at: ev.at + Math.max(1, s.inDays) * DAY, title: s.action, doc: { channel: s.channel, auto: true, fromVisit: ev.id } }));
    let patch = { chance: a.chance, doc: Object.assign({}, p.doc, { lastVisitAt: ev.at, lastVisit: { summary: a.summary, interest: a.interest, coach: a.coach } }) };
    if (!p.value && a.estValue) patch.value = a.estValue;
    let out = await saveP(p, patch);
    const target = ['quoted', 'negotiating'].indexOf(a.stage) >= 0 && further(a.stage, out.stage) ? a.stage : (further('visited', out.stage) ? 'visited' : '');
    if (target && out.stage !== 'won' && out.stage !== 'lost') out = await setStage(out, me, target, 'อลิซประเมินจากบันทึก visit');
    out = await saveP(out, { chance: a.chance });
    out = await refreshNext(out);
    return { ai: a, tasks, p: out };
  }
  router.post('/api/visit', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), b = req.body || {}; let p = await mustP(me, b.prospectId);
    const note = String(b.note || '').trim().slice(0, 4000);
    if (note.length < 10) throw uerr('เขียนสรุปการ visit สั้น ๆ อย่างน้อย 1 ประโยค (อลิซใช้วิเคราะห์)');
    const at = b.at ? atOf(b.at) : Date.now();
    /* 🚗 v1.1.0 การเดินทาง (ไม่บังคับ — ใส่ทีหลังได้) · คำนวณก่อนอัปรูป ⇒ ตำแหน่งผิดไม่เสียรูป */
    const trip = b.trip ? Object.assign(await Trip.build(b.trip), { claimId: '' }) : null;
    const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 8);
    const id = rid('ve_'), saved = [], forAi = [];
    for (let i = 0; i < photos.length; i++) {
      const raw = bufOfData(photos[i]);
      const big = await shrink150(raw);   /* 🗜 3 พ.ย. 69 ≤ 150 KB (เดิม 1600px@82 ไม่คุมขนาดไฟล์ · เก็บใน Supabase Storage = egress) */
      const path = 'visit/' + p.id + '/' + id + '-' + (i + 1) + '.jpg';
      try { const u = await storage.upload(path, big, 'image/jpeg', { shrink: false, immutable: true }); saved.push({ url: u.url, path: u.path || path, bytes: big.length }); }
      catch (e) { throw uerr('อัปโหลดรูปไม่สำเร็จ: ' + errText(e), 502); }
      if (forAi.length < 3) forAi.push({ mime: 'image/jpeg', b64: (await shrink(raw, 768, 70)).toString('base64') });
    }
    const row = { id, prospect_id: p.id, kind: 'visit', status: 'done', at: iso(at), owner: p.owner || me.username, by_user: me.username, title: clip(b.title, 200) || 'visit ' + p.name, body: note,
      doc: Object.assign({ photos: saved, people: clip(b.people, 300), planId: clip(b.planId, 40) }, trip ? { trip } : {}) };
    await db.insert(T.e, [row]);
    const ev = eOut(row);
    if (clean(b.planId)) await db.update(T.e, { id: 'eq.' + clean(b.planId), prospect_id: 'eq.' + p.id }, { status: 'done', updated_at: iso(Date.now()), doc: { visitId: id } }).catch(() => {});
    if (ctx.audit) ctx.audit(req.user, 'visit_log', { id: p.id, name: p.name, photos: saved.length });
    if (!ai.ready()) { p = await saveP(p, { doc: Object.assign({}, p.doc, { lastVisitAt: at }) }); if (further('visited', p.stage)) p = await setStage(p, me, 'visited', 'บันทึก visit'); return { ok: true, event: ev, p: await refreshNext(p), ai: null, note: 'ยังไม่ได้ตั้งกุญแจ AI — บันทึกแล้วแต่อลิซยังวิเคราะห์ไม่ได้' }; }
    try { const r = await runVisitAI(p, me, ev, forAi); return { ok: true, event: ev, p: r.p, ai: r.ai, tasks: r.tasks }; }
    catch (e) { warn('B2B Visit: วิเคราะห์ visit ไม่สำเร็จ ' + errText(e)); if (further('visited', p.stage)) p = await setStage(p, me, 'visited', 'บันทึก visit'); return { ok: true, event: ev, p: await refreshNext(p), ai: null, note: 'บันทึกแล้ว — อลิซวิเคราะห์ไม่สำเร็จ (' + errText(e) + ') กด "วิเคราะห์ใหม่" ได้' }; }
  }));
  router.post('/api/visit/reanalyze', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), r = await db.one(T.e, { id: 'eq.' + clean((req.body || {}).id), kind: 'eq.visit', select: '*' });
    if (!r) throw uerr('ไม่พบบันทึก visit', 404);
    const p = await mustP(me, r.prospect_id);
    if (!ai.ready()) throw uerr('ยังไม่ได้ตั้งกุญแจ AI', 503);
    const out = await runVisitAI(p, me, eOut(r), []);
    return { ok: true, p: out.p, ai: out.ai, tasks: out.tasks };
  }));

  /* ✏️ v1.1.0 แก้บันทึก visit — พี่เอ: "และต้องเปิดให้มีการแก้ไข ข้อมูลในส่วนนี้ได้ด้วยนะ"
   *   แก้ได้: เวลาที่เข้าพบ · พบใคร · สรุป · เพิ่ม/ลบรูป · การเดินทาง (ต้นทาง/ปลายทาง/รถ/ระยะ)
   *   🔒 เซลส์ที่บันทึก visit นั้น (หรือผู้ดูแล) · visit ที่อยู่ในใบเบิกที่ส่ง/อนุมัติ/จ่ายแล้ว แก้ไม่ได้ (ให้บัญชีตีกลับก่อน) */
  router.post('/api/visit/edit', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), b = req.body || {};
    const r = await db.one(T.e, { id: 'eq.' + clean(b.id), kind: 'eq.visit', select: '*' });
    if (!r) throw uerr('ไม่พบบันทึก visit', 404);
    await mustP(me, r.prospect_id);
    if (!(me.sup || lower(r.by_user) === lower(me.username))) throw uerr('แก้ได้เฉพาะเซลส์ที่บันทึก visit นี้', 403);
    const doc = Object.assign({}, r.doc || {}), old = doc.trip;
    if (old && old.claimId) {
      const c = await db.one('visit_claims', { id: 'eq.' + old.claimId, select: 'code,status' }).catch(() => null);
      if (c && ['submitted', 'approved', 'paid'].indexOf(c.status) >= 0) throw uerr('visit นี้อยู่ในใบเบิก ' + c.code + ' แล้ว — แก้ไม่ได้ ถ้าต้องแก้ให้บัญชีตีกลับใบก่อน (หรือถอนใบที่ยังรออนุมัติ)', 409);
    }
    const patch = { updated_at: iso(Date.now()) };
    if (b.note !== undefined) { const n = String(b.note || '').trim().slice(0, 4000); if (n.length < 10) throw uerr('สรุปการ visit อย่างน้อย 1 ประโยค'); patch.body = n; }
    if (b.at !== undefined) patch.at = iso(atOf(b.at));
    if (b.people !== undefined) doc.people = clip(b.people, 300);
    let photos = (doc.photos || []).slice();
    if (Array.isArray(b.removePhotos)) { const rm = new Set(b.removePhotos.map(String)); photos = photos.filter(x => !rm.has(String(x.url))); }
    const add = (Array.isArray(b.addPhotos) ? b.addPhotos : []).slice(0, Math.max(0, 8 - photos.length));
    for (let i = 0; i < add.length; i++) {
      const big = await shrink150(bufOfData(add[i]));
      const path = 'visit/' + r.prospect_id + '/' + r.id + '-e' + Date.now().toString(36) + i + '.jpg';
      try { const u = await storage.upload(path, big, 'image/jpeg', { shrink: false, immutable: true }); photos.push({ url: u.url, path: u.path || path, bytes: big.length }); }
      catch (e) { throw uerr('อัปโหลดรูปไม่สำเร็จ: ' + errText(e), 502); }
    }
    doc.photos = photos.slice(0, 8);
    if (b.trip === null) delete doc.trip;
    else if (b.trip) doc.trip = Object.assign(await Trip.build(b.trip), { claimId: '' });
    doc.editedBy = me.username; doc.editedAt = Date.now();
    patch.doc = doc;
    await db.update(T.e, { id: 'eq.' + r.id }, patch);
    if (ctx.audit) ctx.audit(req.user, 'visit_edit', { id: r.id });
    return { ok: true, event: eOut(Object.assign({}, r, patch)) };
  }));

  /* ═══ ปฏิทิน ═══ */
  router.get('/api/calendar', (req, res) => send(res, async () => {
    res.set('Cache-Control', 'no-store');
    await need();
    const me = meOf(req), from = Date.parse(clean(req.query.from)), to = Date.parse(clean(req.query.to));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 62 * DAY) throw uerr('ช่วงวันที่ไม่ถูกต้อง');
    const q = { at: 'gte.' + iso(from), and: '(at.lt.' + iso(to) + ')', kind: 'in.(plan,task,visit,follow)', status: 'neq.cancelled', select: '*', order: 'at.asc' };
    const owner = clean(req.query.owner);
    if (!me.sup) q.owner = 'eq.' + me.username; else if (owner) q.owner = 'eq.' + owner;
    const evs = (await db.selectAll(T.e, q)).map(eOut);
    const pids = [...new Set(evs.map(e => e.prospectId))];
    const ps = pids.length ? await db.selectAll(T.p, { id: 'in.(' + pids.join(',') + ')', select: 'id,name,address,stage,owner', order: 'id.asc' }) : [];
    const byId = new Map(ps.map(x => [x.id, x]));
    return { ok: true, events: evs.filter(e => byId.has(e.prospectId)).map(e => Object.assign(e, { name: byId.get(e.prospectId).name, address: byId.get(e.prospectId).address, stage: byId.get(e.prospectId).stage })) };
  }));

  /* ═══ Summary Report ═══ */
  router.post('/api/report', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), b = req.body || {};
    const from = Date.parse(clean(b.from) + 'T00:00:00+07:00'), to = Date.parse(clean(b.to) + 'T23:59:59+07:00');
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 370 * DAY) throw uerr('เลือกช่วงวันที่ให้ถูกต้อง (ไม่เกิน 1 ปี)');
    const owner = me.sup ? clean(b.owner) : me.username;
    const pq = { select: '*', order: 'id.asc' }; if (owner) pq.owner = 'eq.' + owner;
    const ps = (await db.selectAll(T.p, pq)).map(pOut);
    const eq = { at: 'gte.' + iso(from), and: '(at.lte.' + iso(to) + ')', select: '*', order: 'at.asc' }; if (owner) eq.owner = 'eq.' + owner;
    const evs = (await db.selectAll(T.e, eq)).map(eOut);
    const visits = evs.filter(e => e.kind === 'visit'), plans = evs.filter(e => e.kind === 'plan'), tasks = evs.filter(e => e.kind === 'task'), follows = evs.filter(e => e.kind === 'follow');
    const vids = [...new Set(visits.map(v => v.prospectId))];
    const team0 = await teamList();
    const now = Date.now();
    const openTasks = (await db.selectAll(T.e, Object.assign({ status: 'eq.open', kind: 'in.(plan,task)', select: '*', order: 'at.asc' }, owner ? { owner: 'eq.' + owner } : {}))).map(eOut);
    const customers = vids.map(id => ps.find(p => p.id === id)).filter(Boolean).map(p => {
      const vv = visits.filter(v => v.prospectId === p.id), last = vv[vv.length - 1], nt = openTasks.filter(t => t.prospectId === p.id);
      return { id: p.id, name: p.name, owner: p.owner, ownerName: nameOfUser(team0, p.owner), stage: p.stage, stageLabel: Seg.STAGE[p.stage].label, chance: p.chance, value: p.value, visits: vv.length,
        lastVisit: new Date(last.at + 7 * 3600e3).toISOString().slice(0, 10), lastNote: last.body, ai: last.doc.ai ? last.doc.ai.summary + (last.doc.ai.coach ? ' · ' + last.doc.ai.coach : '') : '',
        next: nt[0] ? nt[0].title + ' (' + new Date(nt[0].at + 7 * 3600e3).toISOString().slice(0, 10) + ')' : '', overdue: nt.filter(t => t.at < now).length, photos: vv.reduce((s, v) => s + ((v.doc.photos || []).length), 0),
        photo: (vv.map(v => (v.doc.photos || [])[0]).filter(Boolean).pop() || {}).url || '' };
    });
    const won = customers.filter(c => c.stage === 'won').length, lost = customers.filter(c => c.stage === 'lost').length, openC = customers.filter(c => c.stage !== 'won' && c.stage !== 'lost');
    const expected = won + openC.reduce((s, c) => s + c.chance / 100, 0);
    const kpi = { customers: customers.length, visits: visits.length, follows: follows.length, plans: plans.length, plansDone: plans.filter(x => x.status === 'done').length, tasks: tasks.length, tasksDone: tasks.filter(x => x.status === 'done').length,
      overdue: openTasks.filter(t => t.at < now && vids.indexOf(t.prospectId) >= 0).length, won, lost, open: openC.length,
      winRate: won + lost ? Math.round(won / (won + lost) * 100) : null, weightedRate: customers.length ? Math.round(expected / customers.length * 100) : 0, expectedWins: Math.round(expected * 10) / 10,
      pipeline: openC.reduce((s, c) => s + (c.value || 0), 0), weightedValue: Math.round(openC.reduce((s, c) => s + (c.value || 0) * c.chance / 100, 0)),
      stageN: Object.fromEntries(Seg.STAGES.map(s => [s.key, customers.filter(c => c.stage === s.key).length])),
      bySales: [...new Set(customers.map(c => c.owner))].map(u => { const cc = customers.filter(c => c.owner === u); return { owner: u, name: nameOfUser(team0, u), customers: cc.length, visits: visits.filter(v => cc.some(c => c.id === v.prospectId)).length, follows: follows.filter(v => cc.some(c => c.id === v.prospectId)).length, won: cc.filter(c => c.stage === 'won').length, avgChance: cc.length ? Math.round(cc.reduce((s, c) => s + c.chance, 0) / cc.length) : 0 }; }) };
    const periodLabel = clean(b.from) + ' ถึง ' + clean(b.to), ownerLabel = owner ? nameOfUser(team0, owner) : '';
    let aiOut = null, aiErr = '';
    if (customers.length && ai.ready()) { try { aiOut = await ai.report({ customers, kpi, periodLabel, ownerLabel }); } catch (e) { aiErr = errText(e); } }
    else if (!customers.length) aiErr = 'ช่วงนี้ยังไม่มีการบันทึก visit';
    else aiErr = 'ยังไม่ได้ตั้งกุญแจ AI — แสดงเฉพาะตัวเลข';
    const doc = { kpi, customers, ai: aiOut, aiError: aiErr, periodLabel, ownerLabel };
    const row = { id: rid('vr_'), by_user: me.username, period_from: clean(b.from), period_to: clean(b.to), owner, doc };
    await db.insert(T.r, [row]).catch(e => warn('B2B Visit: เก็บรายงานไม่สำเร็จ ' + errText(e)));
    if (ctx.audit) ctx.audit(req.user, 'visit_report', { from: b.from, to: b.to, owner, n: customers.length });
    return { ok: true, id: row.id, at: Date.now(), by: me.name, doc };
  }));
  router.get('/api/reports', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), q = { select: 'id,by_user,period_from,period_to,owner,created_at,doc', order: 'created_at.desc', limit: 20 };
    if (!me.sup) q.owner = 'eq.' + me.username;
    const rows = await db.select(T.r, q);
    return { ok: true, items: rows.map(r => ({ id: r.id, by: r.by_user, from: r.period_from, to: r.period_to, owner: r.owner, at: ms(r.created_at), customers: ((r.doc || {}).kpi || {}).customers || 0, rate: ((r.doc || {}).ai || {}).successRate })) };
  }));
  router.get('/api/report/:id', (req, res) => send(res, async () => {
    await need();
    const me = meOf(req), r = await db.one(T.r, { id: 'eq.' + clean(req.params.id), select: '*' });
    if (!r || (!me.sup && lower(r.owner) !== lower(me.username))) throw uerr('ไม่พบรายงานนี้', 404);
    return { ok: true, id: r.id, at: ms(r.created_at), by: r.by_user, doc: r.doc };
  }));

  mount._t = { check, health: () => health, ai, nameKey };
}

module.exports = { mount, nameKey, SQL_FILE, T };
