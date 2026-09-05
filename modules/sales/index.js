'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  โมดูล "คีย์ยอดขาย / Sales Report"
 *
 *  ‼ วิธีเขียนข้อมูล — ลงชีตก่อน แล้วตามลงฐานข้อมูล (5 ก.ย. 69)
 *
 *    ช่วงนี้ทีมยังคีย์งานในแอปเดิมอยู่ด้วย ชีตจึงยังเป็นแหล่งความจริง
 *    งานซิงค์ดึงชีต → ฐานข้อมูลทุก 10 นาที
 *    ถ้าเขียนแค่ฐานข้อมูล รอบซิงค์ถัดไปจะทับของที่เพิ่งคีย์หายเงียบ ๆ
 *
 *    ลำดับที่ปลอดภัย: เขียนชีตให้สำเร็จก่อน → ค่อยเขียนกระจกลงฐานข้อมูล
 *    ชีตพลาด = หยุด ไม่แตะฐานข้อมูล · ฐานข้อมูลพลาด = ไม่เป็นไร รอบหน้าเก็บเอง
 *
 *  ‼ PEAK อ่านอย่างเดียวตลอดไป — ไม่มี endpoint ไหนในไฟล์นี้คุยกับ PEAK เลย
 *    มีเทสต์ใน tools/test-sales.js คุมไว้
 * ═══════════════════════════════════════════════════════════════════ */

const save = require('./save');

const clean = s => String(s == null ? '' : s).trim();
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function mount(router, ctx) {
  const { db } = ctx;
  const express = require('express');
  router.use(express.json({ limit: '1mb' }));

  /** ตัวเลือกในช่องกรอง — สถานะ · พนักงานขาย */
  router.get('/api/filters', async (_req, res) => {
    try {
      const r = await db.rpc('sales_filters', {});
      const j = Array.isArray(r) ? r[0] : r;
      res.json({ ok: true, status: (j && j.status) || [], sales: (j && j.sales) || [] });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** ค้นหา + แบ่งหน้า + ยอดรวมของผลลัพธ์ที่กรองแล้ว */
  router.get('/api/list', async (req, res) => {
    const q      = clean(req.query.q);
    const status = clean(req.query.status);
    const sale   = clean(req.query.sale);
    const from   = clean(req.query.from);
    const to     = clean(req.query.to);
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const page   = Math.max(parseInt(req.query.page, 10) || 1, 1);

    try {
      const r = await db.rpc('sales_search', {
        p_q: q || null, p_status: status || null, p_sale: sale || null,
        p_from: from || null, p_to: to || null,
        p_limit: limit, p_offset: (page - 1) * limit,
      });
      const j = Array.isArray(r) ? r[0] : r;
      const total = num(j && j.total);
      res.json({
        ok: true,
        page, limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
        sum: {
          amount:   num(j && j.amount),
          received: num(j && j.received),
          billed:   num(j && j.billed),
          due:      num(j && j.amount) - num(j && j.received),
        },
        rows: (j && j.rows) || [],
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ─── ตารางรายการขาย "ทุกคอลัมน์" — แบบเดียวกับ getRecords() ของเดิม ───
   *
   *  ‼ ห้ามเลือกคอลัมน์เองเด็ดขาด — ของเดิมคืนหัวชีตทั้งแถวแล้วให้หน้าจอวาดตาม
   *    ถ้าเราหยิบมาแค่ไม่กี่ช่อง คนใช้จะหาคอลัมน์ที่เคยเห็นไม่เจอ
   *
   *  ช่วงข้อมูล: from/to > ym > days (ดีฟอลต์ 10 วันล่าสุด เหมือนเดิมเป๊ะ) */
  router.get('/api/records', async (req, res) => {
    const from = clean(req.query.from), to = clean(req.query.to);
    const ym   = clean(req.query.ym);
    const sale = clean(req.query.sale);
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 10, 1), 400);
    const mode = (from || to) ? 'range' : (/^\d{4}-\d{2}$/.test(ym) ? 'month' : 'days');
    try {
      const r = await db.rpc('sales_records', {
        p_mode: mode, p_ym: ym || null,
        p_from: from || null, p_to: to || null,
        p_days: days, p_sale: sale || null, p_limit: 6000,
      });
      const j = Array.isArray(r) ? r[0] : r;
      res.json({ ok: true, ...(j || {}) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** รูปพนักงานขาย — ชื่อเล่น → URL (ถอดจาก _saleAvatars/getSaleAvatars) */
  router.get('/api/avatars', async (_req, res) => {
    try {
      const r = await db.rpc('sales_avatars', {});
      res.json({ ok: true, map: (Array.isArray(r) ? r[0] : r) || {} });
    } catch (e) {
      res.json({ ok: true, map: {} });   // ไม่มีรูปก็ไม่ต้องพัง — หน้าจอถอยไปใช้อักษรย่อ
    }
  });

  /** ค้นทั้งชีต — 7 คอลัมน์ ผลไม่เกิน 60 แถว (ถอดจาก findRecords) */
  router.get('/api/find', async (req, res) => {
    const q = clean(req.query.q), sale = clean(req.query.sale);
    if (q.length < 2) return res.json({ ok: true, q, rows: [], capped: false });
    const t0 = Date.now();
    try {
      const r = await db.rpc('sales_find', { p_q: q, p_sale: sale || null, p_max: 60 });
      const j = Array.isArray(r) ? r[0] : r;
      res.json({ ok: true, ...(j || {}), ms: Date.now() - t0 });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** รายละเอียดเต็มของงานเดียว — ทุกคอลัมน์ตามชีต รวม _extra */
  router.get('/api/row/:id', async (req, res) => {
    try {
      /* ?by=row = เลขแถวในชีต (คีย์ที่แอปเดิมใช้ทุกที่) · ไม่ใส่ = _id ของตาราง
       * ต้องแยกให้ชัด เพราะ _row 5 กับ _id 5 เป็นคนละแถวกันได้ */
      const key = clean(req.query.by) === 'row' ? '_row' : '_id';
      const row = await db.one('total_sales', { [key]: 'eq.' + req.params.id, select: '*' });
      if (!row) return res.status(404).json({ ok: false, error: 'ไม่พบรายการนี้' });

      /* แยกช่องระบบออกจากช่องข้อมูลจริง เพื่อให้หน้าจออ่านง่าย */
      const meta = {}, data = {};
      for (const [k, v] of Object.entries(row)) {
        if (k.startsWith('_')) meta[k] = v; else data[k] = v;
      }
      res.json({ ok: true, data, meta, extra: row._extra || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ─── ช่วงเวลาของ Dashboard — ถอดจาก _mixWindow() Code.gs:3948–3986 ───
   *
   *  this  = วันที่ 1 เดือนนี้ → วันนี้   เทียบ วันที่ 1 เดือนก่อน → วันเดียวกันเดือนก่อน
   *  prev  = ทั้งเดือนที่แล้ว              เทียบ ทั้งเดือนก่อนหน้านั้น
   *  3m/6m = k เดือนล่าสุด (รวมเดือนนี้)  เทียบ k เดือนก่อนหน้า
   *  custom= ช่วงที่เลือก                 เทียบช่วงยาวเท่ากันที่ติดกันข้างหน้า
   */
  function win(kind, from, to) {
    const d = new Date();
    const ymd = x => x.toISOString().slice(0, 10);
    const mStart = (y, m) => new Date(Date.UTC(y, m, 1));
    const mEnd   = (y, m) => new Date(Date.UTC(y, m + 1, 0));
    const Y = d.getUTCFullYear(), M = d.getUTCMonth(), D = d.getUTCDate();

    if (kind === 'prev') {
      return { from: ymd(mStart(Y, M - 1)), to: ymd(mEnd(Y, M - 1)),
               pFrom: ymd(mStart(Y, M - 2)), pTo: ymd(mEnd(Y, M - 2)),
               label: 'เดือนที่แล้ว', pLabel: 'เดือนก่อนหน้า', mtd: false };
    }
    if (kind === '3m' || kind === '6m') {
      const k = kind === '3m' ? 3 : 6;
      return { from: ymd(mStart(Y, M - k + 1)), to: ymd(d),
               pFrom: ymd(mStart(Y, M - 2 * k + 1)), pTo: ymd(mEnd(Y, M - k)),
               label: k + ' เดือนล่าสุด', pLabel: k + ' เดือนก่อนหน้า', mtd: false };
    }
    if (kind === 'custom' && from && to) {
      const a = new Date(from + 'T00:00:00Z'), b = new Date(to + 'T00:00:00Z');
      const days = Math.max(1, Math.round((b - a) / 86400000) + 1);
      const pb = new Date(a.getTime() - 86400000);
      const pa = new Date(pb.getTime() - (days - 1) * 86400000);
      return { from, to, pFrom: ymd(pa), pTo: ymd(pb),
               label: 'ช่วงที่เลือก', pLabel: 'ช่วงก่อนหน้า', mtd: false };
    }
    /* this (ค่าเริ่มต้น) */
    return { from: ymd(mStart(Y, M)), to: ymd(d),
             pFrom: ymd(mStart(Y, M - 1)),
             pTo: ymd(new Date(Date.UTC(Y, M - 1, Math.min(D, mEnd(Y, M - 1).getUTCDate())))),
             label: 'เดือนนี้', pLabel: 'เดือนก่อน ช่วงวันเดียวกัน', mtd: true };
  }

  const one = r => (Array.isArray(r) ? r[0] : r) || {};

  /** ข้อมูลหน้าแรกทั้งหมด — การ์ดช่องทาง · อันดับ · mix · KPI */
  router.get('/api/dashboard', async (req, res) => {
    const w = win(clean(req.query.win) || 'this', clean(req.query.from), clean(req.query.to));
    const day = clean(req.query.day) || new Date().toISOString().slice(0, 10);
    try {
      const [ch, rank, mix, kpi] = await Promise.all([
        db.rpc('sales_channel_dash', { p_from: w.from, p_to: w.to, p_prev_from: w.pFrom, p_prev_to: w.pTo }),
        db.rpc('sales_ranking',      { p_day: day }),
        db.rpc('sales_mix_dash',     { p_from: w.from, p_to: w.to, p_prev_from: w.pFrom, p_prev_to: w.pTo }),
        db.rpc('sales_kpi',          { p_today: day }),
      ]);
      res.json({ ok: true, win: w, day,
                 channel: one(ch), rank: one(rank), mix: one(mix), kpi: one(kpi) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** อันดับยอดขายสาขามดงาน */
  router.get('/api/branch', async (req, res) => {
    const m = clean(req.query.month) || new Date().toISOString().slice(0, 7);
    try {
      res.json({ ok: true, month: m,
                 ...one(await db.rpc('sales_branch_dash', { p_month: m + '-01' })) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /** Daily Report — เซลส์ × วันในเดือน แยกลูกค้าเก่า/ใหม่ */
  router.get('/api/daily', async (req, res) => {
    const m = clean(req.query.month) || new Date().toISOString().slice(0, 7);
    try {
      res.json({ ok: true, ...one(await db.rpc('sales_daily', { p_month: m + '-01' })) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /** แถบกิจกรรมล่าสุด */
  router.get('/api/activity', async (req, res) => {
    try {
      const r = await db.rpc('sales_activity', { p_limit: 10 });
      res.json({ ok: true, rows: Array.isArray(r) ? r : (r || []) });
    } catch (e) { res.json({ ok: true, rows: [] }); }   // ไม่มีก็ไม่ต้องพัง
  });

  /** สรุปรายเดือน + รายพนักงานขาย */
  router.get('/api/summary', async (_req, res) => {
    try {
      const [byMonth, byPerson] = await Promise.all([
        db.select('v_sales_by_month',  { select: '*', limit: 24 }),
        db.select('v_sales_by_person', { select: '*', limit: 50 }),
      ]);
      res.json({ ok: true, byMonth: byMonth || [], byPerson: byPerson || [] });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  ฝั่งเขียน — เปิดตามที่พี่เอสั่ง 5 ก.ย. 69 "ให้คีย์ตัวเลขได้จริง"
   *
   *  ‼ กติกาที่ห้ามหลุด
   *    1. เขียนลง "ชีต" ก่อนเสมอ แล้วค่อยตามลง Supabase
   *       (ชีตยังเป็นแหล่งความจริง รอบซิงค์ถัดไปจะได้ไม่ทับของที่เพิ่งคีย์)
   *    2. ไม่แตะ PEAK เลยแม้แต่ช่องเดียว — คอลัมน์ PEAK ทั้ง 17 ช่อง
   *       ไม่อยู่ใน FIELD_COL ยกเว้น "ลิงก์เอกสาร PEAK" ที่เซลส์วางลิงก์เอง
   *    3. คำนวณเงินซ้ำที่เซิร์ฟเวอร์ ไม่เชื่อตัวเลขที่หน้าจอส่งมา
   * ═══════════════════════════════════════════════════════════════ */

  /** ตัวเลือกในฟอร์ม — ถอดจาก _buildOptions() code.gs:6891 */
  router.get('/api/options', async (_req, res) => {
    const out = {
      custType:  ['ลูกค้าใหม่', 'ลูกค้าเก่า'],
      leadStatus: ['Onprocess', 'ปิดการขาย', 'ไม่ซื้อ'],
      biz:       ['มดงานการป้าย', 'The 101'],
      method:    ['แชท', 'โทร', 'Walk in', 'Email', 'นัดหมาย'],
      source:    ['Online', 'สาขา', 'B2B', 'พาร์ทเนอร์', 'จากผู้บริหาร'],
      bizGroup:  ['อื่นๆ', 'แฟรนไชส์อาหาร-เครื่องดื่ม', 'เทคโนโลยี', 'ความงาม',
                  'ผู้รับเหมาตกแต่ง', 'บริการด้านการเงิน', 'สัตว์เลี้ยง',
                  'บริการขนส่ง Logistics', 'อุปโภคบริโภค'],
      payTerms:  ['เงินสด 100% ก่อนสั่งผลิต',
                  'มัดจำเงินสด 50% ก่อนสั่งผลิต ชำระ 50% ทันทีหลังจบงาน',
                  'มัดจำ 50% - ก่อนติดตั้ง 30% - หลังส่งมอบงาน 20%',
                  'เครดิต 30 วันหลังจากส่งมอบสินค้า ชำระเงิน 100% ตามรอบวางบิล'],
      maker:     ['ผลิตเอง-The101'],
      channels:  [],
    };
    /* ช่องทาง: อ่านจากแท็บ Channels จริง แล้วจัดกลุ่มตาม _channelGroup() code.gs:997 */
    try {
      const rows = await db.selectAll('channels', { select: '*', order: 'No.asc' });
      const seen = new Set();
      for (const r of rows || []) {
        const name = clean(r.Channel);
        if (!name || seen.has(name) || /\(\d+\)$/.test(name)) continue;
        seen.add(name);
        out.channels.push({ name, group: channelGroup(name) });
      }
    } catch { /* ไม่มีข้อมูลช่องทาง = ปล่อยว่าง ฟอร์มยังใช้ได้ */ }
    /* ผู้ผลิตภายนอก: อ่านจากตาราง outsource ที่ซิงค์มาจาก CalPrice */
    try {
      const rows = await db.selectAll('outsource', { select: '*', order: '_row.asc' });
      const seen = new Set();
      for (const r of rows || []) {
        const v = clean(Object.values(r).find(x => typeof x === 'string' && clean(x)));
        if (!v || seen.has(v) || /^ชื่อ|^รายชื่อ|^บริษัท$/.test(v)) continue;
        seen.add(v); out.maker.push(v);
      }
    } catch { /* ไม่มีรายชื่อ outsource ก็เหลือแค่ "ผลิตเอง" */ }
    res.json({ ok: true, ...out });
  });

  /** ค้นรายชื่อลูกค้าเดิม — ถอดจาก searchContacts() code.gs:4948 (ตัด 10 รายการ) */
  router.get('/api/contacts', async (req, res) => {
    const q = clean(req.query.q);
    if (q.length < 2) return res.json({ ok: true, rows: [] });
    try {
      const like = '*' + q + '*';
      const rows = await db.select('contacts', {
        or: `("First Name".ilike.${like},"Company".ilike.${like},"แสดงชื่อบริษัท".ilike.${like})`,
        select: '*', limit: 10,
      });
      res.json({ ok: true, rows: (rows || []).map(ctCard) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** ตรวจรายชื่อซ้ำ — ถอดจาก checkDuplicate() code.gs:4918 (คะแนน ≥3 · ตัด 8) */
  router.get('/api/dupcheck', async (req, res) => {
    const company = clean(req.query.company), contact = clean(req.query.contact);
    const phone = clean(req.query.phone).replace(/\D/g, '');
    if (phone.length < 6 && !(company && contact)) return res.json({ ok: true, rows: [] });
    try {
      const pick = [];
      if (phone.length >= 6) pick.push(`"Phone".ilike.*${phone.slice(-9)}*`);
      if (contact) pick.push(`"First Name".ilike.*${contact}*`);
      if (company) pick.push(`"Company".ilike.*${company}*`);
      const rows = await db.select('contacts',
        { or: '(' + pick.join(',') + ')', select: '*', limit: 40 });

      const norm = s => clean(s).toLowerCase().replace(/\s+/g, '');
      const scored = (rows || []).map(r => {
        const c = ctCard(r);
        let score = 0; const why = [];
        if (phone.length >= 6 && clean(c.phone).replace(/\D/g, '').endsWith(phone.slice(-9)))
          { score += 3; why.push('เบอร์ตรง'); }
        if (contact && (norm(c.contact).includes(norm(contact)) ||
                        norm(contact).includes(norm(c.contact)) && norm(c.contact)))
          { score += 2; why.push('ชื่อผู้ติดต่อใกล้เคียง'); }
        if (company && (norm(c.company).includes(norm(company)) ||
                        norm(company).includes(norm(c.company)) && norm(c.company)))
          { score += 2; why.push('ชื่อบริษัทใกล้เคียง'); }
        const exact = !!(contact && company &&
          norm(c.contact) === norm(contact) && norm(c.company) === norm(company));
        if (exact) { score += 5; why.push('ชื่อผู้ติดต่อ + บริษัท ตรงกันทั้งคู่'); }
        return { ...c, score, why, exact };
      }).filter(x => x.score >= 3).sort((a, b) => b.score - a.score).slice(0, 8);

      res.json({ ok: true, rows: scored, hasExact: scored.some(x => x.exact) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** บันทึกรายการ (เพิ่มใหม่ / แก้ไข) — ลงชีตก่อน แล้วตามลง Supabase */
  router.post('/api/save', async (req, res) => {
    const t0 = Date.now();
    try {
      const r = await save.saveRecord(req.user, req.body || {});
      try {
        await ctx.audit(req.user, Number(req.body.row) > 1 ? 'sales_edit' : 'sales_new',
          { target: r.code });
      } catch { /* audit ล้มไม่ใช่เรื่องต้องหยุดงาน */ }
      res.json({ ...r, ms: Date.now() - t0 });
    } catch (e) {
      /* userError = ผู้ใช้กรอกไม่ครบ ไม่ใช่ระบบพัง → 400 ไม่ใช่ 500 */
      res.status(e.userError ? 400 : 500).json({ ok: false, error: e.message });
    }
  });
}

/** แถวในตาราง Contacts → การ์ดที่ฟอร์มใช้ (ถอดจาก _ctCard() code.gs:4908) */
function ctCard(r) {
  return {
    id:         clean(r.ID),
    contact:    clean(r['First Name']),
    lastName:   clean(r['Last Name']),
    title:      clean(r.Title),
    email:      clean(r.Email),
    company:    clean(r['แสดงชื่อบริษัท']) || clean(r.Company),
    phone:      clean(r.Phone),
    address:    clean(r.Address),
    taxid:      clean(r.TaxID),
    payTerms:   clean(r['เงื่อนไขการชำระเงิน']),
    bizGroup:   clean(r['Business Group']),
    fromChannel: clean(r['From Channel']),
    status:     clean(r.Status),
    owner:      clean(r['Create By']),
  };
}

/** ชื่อช่อง → กลุ่ม (ถอดจาก _channelGroup() code.gs:997) */
function channelGroup(name) {
  const s = String(name || '');
  if (/^LINE@/i.test(s))              return 'LINE';
  if (/^(FB\/|FB_|FACEBOOK)/i.test(s)) return 'Facebook / IG';
  if (/^TIKTOK/i.test(s))             return 'TikTok';
  if (/^(SHOPEE|FASTWORK)/i.test(s))  return 'Marketplace / อื่นๆ';
  if (/^สาขา/.test(s))                 return 'สาขาหน้าร้าน';
  if (/^Direct/i.test(s))             return 'Direct';
  return 'อื่นๆ';
}

module.exports = { mount };
