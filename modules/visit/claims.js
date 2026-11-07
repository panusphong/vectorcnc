'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/visit/claims.js — 💰 ใบขอเบิกค่าเดินทาง (ค่าน้ำมัน) ของเซลส์ · บัญชีอนุมัติ / ทำจ่าย (v1.1.0 · 21 ต.ค. 69)
 *
 *  🔴 พี่เอ: "… พร้อมทำเอกสารขอเบิกค่าเดินทางของเซลล์แต่ละคนได้ ต้องมี วันที่ เวลา นัด visit ชื่อลูกค้า สถานที่ ภาพ visit
 *     location map ระยะทางการเดินทาง และคำนวณเป็น ค่าน้ำมันที่ขอเบิกกับบริษัท และให้ฝ่ายบัญชี เข้ามา approve ทำจ่ายในระบบได้ด้วยนะ"
 *
 *  สถานะใบเบิก: submitted (ส่งบัญชีแล้ว · รออนุมัติ) → approved (อนุมัติ · รอทำจ่าย) → paid (จ่ายแล้ว)
 *               ↘ rejected (ตีกลับ — visit ในใบถูกปล่อยกลับมาแก้ / ส่งใหม่ได้) · cancelled (เซลส์ถอนเองก่อนอนุมัติ)
 *  🔒 1 visit อยู่ได้ใบเบิกเดียว (doc.trip.claimId) · ตัวเลขในใบ = ภาพถ่าย ณ วันส่ง (แก้ visit ทีหลังไม่ทำให้ใบเปลี่ยน)
 *  🔒 อนุมัติ / ตีกลับ / ทำจ่าย = Permission Accounting · บัญชี · Administrator เท่านั้น (เซิร์ฟเวอร์ตรวจทุกครั้ง)
 *  ตาราง: app.visit_claims — sql/129-visit-trip-claims.sql
 * ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const Trip = require('./trip');

const CLAIM_SQL = 'sql/129-visit-trip-claims.sql';
const TC = 'visit_claims';
const ACC_PERMS = ['accounting', 'บัญชี', 'administrator'];
const STATUS = {
  submitted: { label: 'รออนุมัติ', icon: '⏳' }, approved: { label: 'อนุมัติแล้ว · รอทำจ่าย', icon: '✅' }, paid: { label: 'จ่ายแล้ว', icon: '💸' },
  rejected: { label: 'ตีกลับ', icon: '↩️' }, cancelled: { label: 'ถอนแล้ว', icon: '✖️' },
};
const LOCKED = ['submitted', 'approved', 'paid'];
const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const clip = (s, n) => clean(s).slice(0, n);
const lower = s => clean(s).toLowerCase();
const r2 = n => Math.round(n * 100) / 100;
const r1 = n => Math.round(n * 10) / 10;
const ms = v => (v ? Date.parse(v) || 0 : 0);
const iso = t => new Date(t).toISOString();
const uerr = (m, st) => Object.assign(new Error(m), { userError: true, status: st || 400 });
const okMonth = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(clean(m));
function monthRange(m) {
  const [y, mo] = clean(m).split('-').map(Number);
  const from = Date.parse(m + '-01T00:00:00+07:00');
  const to = Date.parse((mo === 12 ? (y + 1) + '-01' : y + '-' + String(mo + 1).padStart(2, '0')) + '-01T00:00:00+07:00');
  return { from, to };
}
const thMonth = m => { const TH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']; const [y, mo] = m.split('-').map(Number); return TH[mo - 1] + ' ' + (y + 543); };

/**
 * @param router express router ของโมดูล
 * @param h { db, T, perms, need, meOf, send, teamList, nameOfUser, warn, audit }
 */
function mount(router, h) {
  const { db, T, perms, send } = h;
  let cHealth = { ok: false, missing: false, at: 0 };
  async function cCheck() {
    try { await db.select(TC, { select: 'id', limit: 1 }); cHealth = { ok: true, missing: false, at: Date.now() }; }
    catch (e) { cHealth = { ok: false, missing: /PGRST205|42P01|does not exist|could not find the table/i.test(String((e && (e.body || e.message)) || e)), at: Date.now() }; }
    return cHealth;
  }
  const cReady = cCheck();
  const needC = async () => { await h.need(); await cReady; if (!cHealth.ok) { await cCheck(); if (!cHealth.ok) throw uerr('ยังไม่ได้สร้างตารางใบเบิกค่าเดินทาง — รัน ' + CLAIM_SQL + ' ใน Supabase SQL Editor ก่อน', 503); } };
  const isAcc = u => ACC_PERMS.indexOf(perms.canonPerm(u && u.permission) || '') >= 0;
  const accOnly = u => ['accounting', 'บัญชี'].indexOf(perms.canonPerm(u && u.permission) || '') >= 0;   /* บัญชีล้วน (ไม่ใช่เซลส์) ⇒ หน้าจอเปิดที่เมนูเบิกค่าเดินทาง */
  const mustAcc = req => { if (!isAcc(req.user)) throw uerr('อนุมัติ / ทำจ่ายใบเบิกค่าเดินทาง ได้เฉพาะฝ่ายบัญชี (Accounting) · Administrator', 403); };
  const vOut = r => ({ id: r.id, prospectId: r.prospect_id, at: ms(r.at), by: r.by_user, owner: r.owner, title: r.title, doc: r.doc || {} });

  /* ── visit ของเซลส์ 1 คนในเดือนนั้น ที่มีการเดินทาง ── */
  async function visitsOf(un, m) {
    const { from, to } = monthRange(m);
    const rows = await db.selectAll(T.e, { kind: 'eq.visit', by_user: 'eq.' + un, at: 'gte.' + iso(from), and: '(at.lt.' + iso(to) + ')', select: 'id,prospect_id,at,by_user,owner,title,doc', order: 'at.asc' });
    return (rows || []).map(vOut).filter(v => v.doc && v.doc.trip && v.doc.trip.km > 0);
  }
  async function claimsByIds(ids) {
    const want = [...new Set(ids.filter(Boolean))];
    if (!want.length) return new Map();
    const rows = await db.select(TC, { id: 'in.(' + want.map(x => '"' + String(x).replace(/["\\]/g, '') + '"').join(',') + ')', select: 'id,status,code' }) || [];
    return new Map(rows.map(r => [r.id, r]));
  }
  /** visit ที่ "ยังเบิกได้" = มีการเดินทาง + ยังไม่อยู่ในใบที่ส่ง/อนุมัติ/จ่ายแล้ว */
  async function pendingOf(un, m) {
    const vs = await visitsOf(un, m);
    const cm = await claimsByIds(vs.map(v => v.doc.trip.claimId));
    return vs.map(v => { const c = v.doc.trip.claimId ? cm.get(v.doc.trip.claimId) : null; return Object.assign(v, { claim: c && LOCKED.indexOf(c.status) >= 0 ? { id: c.id, code: c.code, status: c.status } : null }); });
  }
  /** ภาพถ่ายของรายการในใบเบิก (ตัวเลข ณ วันส่ง) */
  async function itemsOf(vs) {
    const pids = [...new Set(vs.map(v => v.prospectId))];
    const ps = pids.length ? await db.selectAll(T.p, { id: 'in.(' + pids.join(',') + ')', select: 'id,name,address', order: 'id.asc' }) : [];
    const pm = new Map(ps.map(p => [p.id, p]));
    const planIds = vs.map(v => clean(v.doc.planId)).filter(Boolean);
    const plans = planIds.length ? await db.selectAll(T.e, { id: 'in.(' + planIds.join(',') + ')', select: 'id,at,doc', order: 'id.asc' }) : [];
    const plm = new Map(plans.map(p => [p.id, p]));
    return vs.map((v, i) => {
      const t = v.doc.trip, p = pm.get(v.prospectId) || {}, pl = plm.get(clean(v.doc.planId));
      return { n: i + 1, eventId: v.id, prospectId: v.prospectId, at: v.at, planAt: pl ? ms(pl.at) : null, customer: clean(p.name) || clean(v.title).replace(/^visit\s+/, ''),
        place: clean((pl && pl.doc && pl.doc.place) || p.address || t.dest.label).slice(0, 300), people: clip(v.doc.people, 200),
        photos: (v.doc.photos || []).slice(0, 3).map(x => x.url).filter(Boolean),
        origin: t.origin, dest: t.dest, roundTrip: !!t.roundTrip, routeKm: t.routeKm, routeSrc: t.routeSrc, manual: !!t.manual, kmNote: t.kmNote || '',
        km: t.km, vehicle: t.vehicle, rate: t.rate, amount: t.amount, mapsUrl: t.mapsUrl,
        /* 🛣 v1.4.0 ค่าทางด่วน (visit เก่าไม่มี = 0) */
        toll: Number(t.toll) || 0, tollNote: clip(t.tollNote, 200), fuelAmount: t.fuelAmount != null ? t.fuelAmount : r2(t.amount - (Number(t.toll) || 0)) };
    });
  }
  const cOut = r => ({ id: r.id, code: r.code, owner: r.owner, ownerName: r.owner_name, month: r.month, status: r.status, statusLabel: (STATUS[r.status] || {}).label || r.status,
    items: r.items || [], totalKm: Number(r.total_km) || 0, totalAmount: Number(r.total_amount) || 0, note: r.note || '',
    submittedAt: ms(r.submitted_at), approvedBy: r.approved_by || '', approvedAt: ms(r.approved_at), approveNote: r.approve_note || '',
    rejectedBy: r.rejected_by || '', rejectedAt: ms(r.rejected_at), rejectReason: r.reject_reason || '',
    paidBy: r.paid_by || '', paidAt: ms(r.paid_at), payRef: r.pay_ref || '', payDate: r.pay_date || '', createdAt: ms(r.created_at) });
  async function mustClaim(req, id) {
    const r = await db.one(TC, { id: 'eq.' + clean(id), select: '*' });
    if (!r) throw uerr('ไม่พบใบเบิกนี้', 404);
    const me = h.meOf(req);
    if (!(isAcc(req.user) || me.sup || lower(r.owner) === lower(me.username))) throw uerr('ใบเบิกนี้เป็นของเซลส์คนอื่น', 403);
    return r;
  }
  async function release(r) {
    for (const it of (r.items || [])) {
      try {
        const e = await db.one(T.e, { id: 'eq.' + it.eventId, select: 'id,doc' });
        if (e && e.doc && e.doc.trip && e.doc.trip.claimId === r.id) await db.update(T.e, { id: 'eq.' + e.id }, { doc: Object.assign({}, e.doc, { trip: Object.assign({}, e.doc.trip, { claimId: '' }) }), updated_at: iso(Date.now()) });
      } catch (e) { h.warn('ใบเบิก ' + r.code + ': ปล่อย visit ' + it.eventId + ' ไม่สำเร็จ'); }
    }
  }
  const whoName = async un => { try { return h.nameOfUser(await h.teamList(), un); } catch (e) { return un; } };

  /* ═══ ตำแหน่ง · ระยะทาง ═══ */
  const geoHits = new Map();
  router.get('/api/geo', (req, res) => send(res, async () => {
    const k = lower(req.user && req.user.username), now = Date.now(), L = (geoHits.get(k) || []).filter(t => now - t < 60000);
    if (L.length >= 30) throw uerr('ค้นตำแหน่งถี่เกินไป — รอสักครู่', 429);
    L.push(now); geoHits.set(k, L);
    return { ok: true, items: await Trip.geocode(req.query.q) };
  }));
  /** คำนวณระยะทาง/ค่าน้ำมันก่อนบันทึก (ไม่บันทึกอะไร) */
  router.post('/api/trip/preview', (req, res) => send(res, async () => ({ ok: true, trip: await Trip.build((req.body || {}).trip) })));
  /** จุดตั้งต้นที่เซลส์ใช้บ่อย: ปลายทางของ visit ล่าสุด + รถที่ใช้ล่าสุด */
  router.get('/api/trip/last', (req, res) => send(res, async () => {
    await h.need();
    const me = h.meOf(req);
    const rows = await db.select(T.e, { kind: 'eq.visit', by_user: 'eq.' + me.username, select: 'at,doc', order: 'at.desc', limit: 20 }) || [];
    const t = rows.map(r => r.doc && r.doc.trip).find(Boolean);
    return { ok: true, last: t ? { dest: t.dest, vehicle: t.vehicle } : null };
  }));
  /** ใส่ / แก้ การเดินทางของ visit ที่บันทึกไปแล้ว (ยังไม่อยู่ในใบเบิกที่ส่งแล้ว) */
  router.post('/api/visit/trip', (req, res) => send(res, async () => {
    await h.need();
    const me = h.meOf(req), b = req.body || {};
    const r = await db.one(T.e, { id: 'eq.' + clean(b.id), kind: 'eq.visit', select: '*' });
    if (!r) throw uerr('ไม่พบบันทึก visit', 404);
    if (!(me.sup || lower(r.by_user) === lower(me.username))) throw uerr('แก้การเดินทางได้เฉพาะเซลส์ที่บันทึก visit นี้', 403);
    const old = (r.doc || {}).trip;
    if (old && old.claimId) { const c = (await claimsByIds([old.claimId])).get(old.claimId); if (c && LOCKED.indexOf(c.status) >= 0) throw uerr('visit นี้อยู่ในใบเบิก ' + c.code + ' (' + STATUS[c.status].label + ') แล้ว — แก้ไม่ได้ ถ้าต้องแก้ให้บัญชีตีกลับใบก่อน', 409); }
    const trip = b.trip === null ? null : await Trip.build(b.trip);
    const doc = Object.assign({}, r.doc || {});
    if (trip) doc.trip = Object.assign(trip, { claimId: '' }); else delete doc.trip;
    await db.update(T.e, { id: 'eq.' + r.id }, { doc, updated_at: iso(Date.now()) });
    return { ok: true, trip: doc.trip || null };
  }));

  /* ═══ 🛣 v1.4.1 ค่าทางด่วน — พี่เอ 4 พ.ย. 69: "ในการทำเบิกค่าเดินทาง อย่าลืมใส่ ค่าทางด่วนเข้าไปด้วยนะ"
   *   ① ใส่ / แก้ ที่หน้าทำใบเบิกได้เลย (ไม่ต้องเปิดแก้ visit ทั้งใบ)
   *   ② ใบที่ "ส่งแล้ว รอบัญชีอนุมัติ" เจ้าของใบ (หรือหัวหน้าเซลส์) เติมค่าทางด่วนได้ — ยอดใบเบิกคิดใหม่ทันที
   *      ‼ อนุมัติแล้ว / จ่ายแล้ว = แก้ไม่ได้ (ต้องให้บัญชีตีกลับก่อน) · ทุกครั้งจดบันทึกระบบ */
  const tollOf = b => {
    const s0 = String(b.toll == null ? '' : b.toll).replace(/[,\s฿]/g, '');
    const v = s0 === '' ? 0 : Number(s0);
    if (!Number.isFinite(v) || v < 0 || v > Trip.MAX_TOLL) throw uerr('ค่าทางด่วนต้องอยู่ระหว่าง 0–' + Trip.MAX_TOLL.toLocaleString('th-TH') + ' บาท');
    return r2(v);
  };
  const withToll = (t, toll, note) => {
    const fuel = t.fuelAmount != null ? Number(t.fuelAmount) : r2(Number(t.amount) - (Number(t.toll) || 0));
    return Object.assign({}, t, { fuelAmount: fuel, toll, tollNote: toll ? clip(note, 200) : '', amount: r2(fuel + toll) });
  };
  router.post('/api/visit/toll', (req, res) => send(res, async () => {
    await h.need();
    const me = h.meOf(req), b = req.body || {}, toll = tollOf(b);
    const r = await db.one(T.e, { id: 'eq.' + clean(b.id), kind: 'eq.visit', select: '*' });
    if (!r || !r.doc || !r.doc.trip) throw uerr('ไม่พบการเดินทางของ visit นี้', 404);
    if (!(me.sup || lower(r.by_user) === lower(me.username))) throw uerr('ใส่ค่าทางด่วนได้เฉพาะเซลส์ที่บันทึก visit นี้', 403);
    const old = r.doc.trip;
    if (old.claimId) { const c = (await claimsByIds([old.claimId])).get(old.claimId); if (c && LOCKED.indexOf(c.status) >= 0) throw uerr('visit นี้อยู่ในใบเบิก ' + c.code + ' แล้ว — เติมค่าทางด่วนที่หน้าใบเบิกนั้นแทน', 409); }
    const doc = Object.assign({}, r.doc, { trip: withToll(old, toll, b.tollNote) });
    await db.update(T.e, { id: 'eq.' + r.id }, { doc, updated_at: iso(Date.now()) });
    if (h.audit) h.audit(req.user, 'visit_toll', { id: r.id, toll });
    return { ok: true, trip: doc.trip };
  }));
  router.post('/api/claim/toll', (req, res) => send(res, async () => {
    await needC();
    const me = h.meOf(req), b = req.body || {}, toll = tollOf(b);
    const r = await mustClaim(req, b.id);
    if (!(me.sup || lower(r.owner) === lower(me.username))) throw uerr('เติมค่าทางด่วนได้เฉพาะเจ้าของใบเบิก', 403);
    if (r.status !== 'submitted') throw uerr('ใบเบิก ' + r.code + ' ' + STATUS[r.status].label + ' แล้ว — เติมค่าทางด่วนได้เฉพาะใบที่รออนุมัติ (ถ้าจำเป็นให้บัญชีตีกลับก่อน)', 409);
    const items = (r.items || []).map(x => (x.eventId === clean(b.eventId) ? Object.assign(withToll(x, toll, b.tollNote), { n: x.n }) : x));
    if (!items.some(x => x.eventId === clean(b.eventId))) throw uerr('ไม่พบรายการนี้ในใบเบิก', 404);
    const total = r2(items.reduce((s, x) => s + (Number(x.amount) || 0), 0));
    await db.update(TC, { id: 'eq.' + r.id }, { items, total_amount: total, updated_at: iso(Date.now()) });
    try {   /* ให้ visit ต้นทางตรงกับใบเบิก (ถ้าถูกตีกลับ/ถอนทีหลัง จะได้ไม่หาย) */
      const e = await db.one(T.e, { id: 'eq.' + clean(b.eventId), select: 'id,doc' });
      if (e && e.doc && e.doc.trip) await db.update(T.e, { id: 'eq.' + e.id }, { doc: Object.assign({}, e.doc, { trip: withToll(e.doc.trip, toll, b.tollNote) }), updated_at: iso(Date.now()) });
    } catch (e) { h.warn('ใบเบิก ' + r.code + ': อัปเดตค่าทางด่วนใน visit ไม่สำเร็จ'); }
    if (h.audit) h.audit(req.user, 'visit_claim_toll', { code: r.code, eventId: clean(b.eventId), toll, total });
    return { ok: true, claim: cOut(Object.assign({}, r, { items, total_amount: total })) };
  }));

  /* ═══ ใบเบิกค่าเดินทาง ═══ */
  /** visit ในเดือนที่ยังเบิกได้ (หน้าทำใบเบิก) */
  router.get('/api/claims/pending', (req, res) => send(res, async () => {
    res.set('Cache-Control', 'no-store');
    await needC();
    const me = h.meOf(req), m = clean(req.query.month);
    if (!okMonth(m)) throw uerr('เลือกเดือน');
    const un = me.sup && clean(req.query.owner) ? clean(req.query.owner) : me.username;
    const vs = await pendingOf(un, m);
    const free = vs.filter(v => !v.claim), items = await itemsOf(free);
    return { ok: true, month: m, monthLabel: thMonth(m), owner: un, ownerName: await whoName(un), items, inClaims: vs.filter(v => v.claim).map(v => ({ eventId: v.id, at: v.at, claim: v.claim })),
      totalKm: r1(items.reduce((s, x) => s + x.km, 0)), totalAmount: r2(items.reduce((s, x) => s + x.amount, 0)) };
  }));
  router.post('/api/claim/submit', (req, res) => send(res, async () => {
    await needC();
    const me = h.meOf(req), b = req.body || {}, m = clean(b.month);
    if (!okMonth(m)) throw uerr('เลือกเดือน');
    const vs = (await pendingOf(me.username, m)).filter(v => !v.claim);
    const want = Array.isArray(b.ids) && b.ids.length ? new Set(b.ids.map(clean)) : null;
    const pick = vs.filter(v => !want || want.has(v.id));
    if (!pick.length) throw uerr('ไม่มี visit ที่ยังไม่ได้เบิกในเดือนนี้ (ต้องใส่การเดินทางใน visit ก่อน)');
    const items = await itemsOf(pick);
    const n = ((await db.select(TC, { month: 'eq.' + m, select: 'id', limit: 1000 })) || []).length + 1;
    const id = 'vc_' + crypto.randomBytes(5).toString('hex');
    const row = { id, code: 'TRV-' + m.slice(2, 4) + m.slice(5, 7) + '-' + String(n).padStart(3, '0'), owner: me.username, owner_name: me.name, month: m, status: 'submitted',
      items, total_km: r1(items.reduce((s, x) => s + x.km, 0)), total_amount: r2(items.reduce((s, x) => s + x.amount, 0)), note: clip(b.note, 500),
      submitted_at: iso(Date.now()), created_at: iso(Date.now()), updated_at: iso(Date.now()) };
    await db.insert(TC, [row]);
    for (const v of pick) await db.update(T.e, { id: 'eq.' + v.id }, { doc: Object.assign({}, v.doc, { trip: Object.assign({}, v.doc.trip, { claimId: id }) }), updated_at: iso(Date.now()) });
    if (h.audit) h.audit(req.user, 'visit_claim_submit', { code: row.code, n: items.length, amount: row.total_amount });
    return { ok: true, claim: cOut(row) };
  }));
  router.get('/api/claims', (req, res) => send(res, async () => {
    res.set('Cache-Control', 'no-store');
    await needC();
    const me = h.meOf(req), q = { select: 'id,code,owner,owner_name,month,status,total_km,total_amount,submitted_at,approved_at,paid_at,approved_by,paid_by,reject_reason,pay_ref,items', order: 'submitted_at.desc', limit: 300 };
    const all = isAcc(req.user) || me.sup;
    if (!all) q.owner = 'eq.' + me.username; else if (clean(req.query.owner)) q.owner = 'eq.' + clean(req.query.owner);
    if (STATUS[clean(req.query.status)]) q.status = 'eq.' + clean(req.query.status);
    if (okMonth(req.query.month)) q.month = 'eq.' + clean(req.query.month);
    const rows = (await db.select(TC, q)) || [];
    return { ok: true, all, items: rows.map(r => Object.assign(cOut(r), { items: undefined, count: (r.items || []).length })) };
  }));
  router.get('/api/claim/:id', (req, res) => send(res, async () => { await needC(); return { ok: true, claim: cOut(await mustClaim(req, req.params.id)) }; }));
  router.post('/api/claim/cancel', (req, res) => send(res, async () => {
    await needC();
    const r = await mustClaim(req, (req.body || {}).id), me = h.meOf(req);
    if (lower(r.owner) !== lower(me.username) && !isAcc(req.user)) throw uerr('ถอนได้เฉพาะเจ้าของใบเบิก', 403);
    if (r.status !== 'submitted') throw uerr('ถอนได้เฉพาะใบที่ยังรออนุมัติ');
    await db.update(TC, { id: 'eq.' + r.id }, { status: 'cancelled', updated_at: iso(Date.now()) });
    await release(r);
    return { ok: true };
  }));
  router.post('/api/claim/approve', (req, res) => send(res, async () => {
    await needC(); mustAcc(req);
    const b = req.body || {}, r = await mustClaim(req, b.id), me = h.meOf(req);
    if (r.status !== 'submitted') throw uerr('อนุมัติได้เฉพาะใบที่รออนุมัติ (ใบนี้: ' + STATUS[r.status].label + ')');
    await db.update(TC, { id: 'eq.' + r.id }, { status: 'approved', approved_by: me.name || me.username, approved_at: iso(Date.now()), approve_note: clip(b.note, 300), updated_at: iso(Date.now()) });
    if (h.audit) h.audit(req.user, 'visit_claim_approve', { code: r.code, amount: Number(r.total_amount) });
    return { ok: true };
  }));
  router.post('/api/claim/reject', (req, res) => send(res, async () => {
    await needC(); mustAcc(req);
    const b = req.body || {}, r = await mustClaim(req, b.id), me = h.meOf(req);
    if (['submitted', 'approved'].indexOf(r.status) < 0) throw uerr('ตีกลับได้เฉพาะใบที่ยังไม่จ่าย');
    if (clean(b.reason).length < 3) throw uerr('พิมพ์เหตุผลที่ตีกลับ (เซลส์จะเห็น)');
    await db.update(TC, { id: 'eq.' + r.id }, { status: 'rejected', rejected_by: me.name || me.username, rejected_at: iso(Date.now()), reject_reason: clip(b.reason, 300), updated_at: iso(Date.now()) });
    await release(r);
    if (h.audit) h.audit(req.user, 'visit_claim_reject', { code: r.code });
    return { ok: true };
  }));
  router.post('/api/claim/paid', (req, res) => send(res, async () => {
    await needC(); mustAcc(req);
    const b = req.body || {}, r = await mustClaim(req, b.id), me = h.meOf(req);
    if (r.status !== 'approved') throw uerr('ทำจ่ายได้เฉพาะใบที่อนุมัติแล้ว');
    const d = /^\d{4}-\d{2}-\d{2}$/.test(clean(b.date)) ? clean(b.date) : new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    await db.update(TC, { id: 'eq.' + r.id }, { status: 'paid', paid_by: me.name || me.username, paid_at: iso(Date.now()), pay_date: d, pay_ref: clip(b.ref, 120), updated_at: iso(Date.now()) });
    if (h.audit) h.audit(req.user, 'visit_claim_paid', { code: r.code, amount: Number(r.total_amount), ref: clip(b.ref, 120) });
    return { ok: true };
  }));

  /* 🩹 v1.1.1 — พี่เอ: "พี่ run sql แล้วทำไมยังขึ้นแบบนี้" — เดิมหน้าแรกใช้ผลตรวจตารางที่จำไว้ตอนเปิดเซิร์ฟเวอร์ ⇒ รัน SQL ทีหลังแล้วยังขึ้นแถบเหลือง
   *  ตอนนี้: ถ้ายังไม่พร้อม ตรวจใหม่ทุกครั้งที่เปิดหน้า (เว้นอย่างน้อย 5 วินาที) · พร้อมแล้วไม่ต้องตรวจซ้ำ */
  const cFresh = async () => { if (!cHealth.ok && Date.now() - (cHealth.at || 0) > 5000) await cCheck(); return cHealth; };
  return { isAcc, accOnly, cHealth: () => cHealth, cFresh, CLAIM_SQL };
}

module.exports = { mount, STATUS, ACC_PERMS, CLAIM_SQL, monthRange, thMonth };
