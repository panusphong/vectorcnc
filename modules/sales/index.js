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

/* ‼ "วันนี้" ต้องมาจากที่เดียวของทั้งระบบ (core/thai-date.js)
 *   ห้ามใช้ new Date().toISOString().slice(0,10) แทนเด็ดขาด — นั่นคือวัน UTC
 *   ซึ่งช้ากว่าบ้านเรา 7 ชั่วโมง แล้วทุกเช้ามืดจะตอบว่าเป็นเมื่อวาน */
const { todayTH, monthTH, stampTH } = require('../../core/thai-date');

/* ‼ ชื่อพนักงานขายต้องเป็น "(ชื่อเล่น) ชื่อจริง นามสกุล" เหมือนกันทั้งระบบ
 *   สูตรประกอบชื่ออยู่ "ที่เดียว" คือ core/sale-name.js — ห้ามเขียนสูตรใหม่ที่นี่
 *   (พี่เอสั่ง 14 ก.ย. 69: "รายชื่อ เซลล์ ที่ใช้ ในส่วน filter ต้องเหมือนกัน") */
const SN = require('../../core/sale-name');

/** แกะข้อความจริงออกจาก error ของ Supabase — คนใช้ต้องอ่านรู้เรื่อง ไม่ใช่เห็น JSON ดิบ */
function pgMsg(msg) {
  const s = String(msg || '');
  const m = s.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return s;
  try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
}

async function mount(router, ctx) {
  const { db } = ctx;
  const express = require('express');
  router.use(express.json({ limit: '1mb' }));

  /* ═══════════════════════════════════════════════════════════════
   *  สิทธิ์ — พี่เอสั่ง 6 ก.ย. 69
   *
   *    "เซลล์จะเห็นแค่งานของตัวเอง ในรายการรหัสงาน
   *     แต่ card dashboard ทุกใบ ทุกคนเห็นเหมือนกันหมดนะ"
   *    "ลบได้ เจ้าของงาน (เซลล์) กับ user ที่เป็น admin, Namna เท่านั้น"
   *
   *  ‼ แยกให้ชัด: "รายการรหัสงาน" กรองรายคน · "การ์ดสรุป" ไม่กรองเลย
   *    เผลอเอาไปกรองการ์ดด้วย = ยอดทีมเพี้ยนทั้งกระดาน คนละเรื่องกับที่สั่ง
   *
   *  ‼ บังคับที่เซิร์ฟเวอร์ ไม่ใช่แค่ซ่อนปุ่ม/ซ่อนแถวในหน้าเว็บ
   *    ?sale= ที่ส่งมาจากหน้าเว็บแก้เองได้ใน 10 วินาที
   * ═══════════════════════════════════════════════════════════════ */
  /* ═══════════════════════════════════════════════════════════════
   *  🔴 v25 · พี่เอสั่งรอบ 25:
   *    "เปิด สิทธิ์ ให้ user : Amonrat_18 สามารถดูและแก้ไขรายการ
   *     คีย์ยอดขาย รหัสงานของทุกคนได้ด้วย"  (+ "ดูที่ table : จัดการผู้ใช้ นะ")
   *
   *  เดิมบรรทัดนี้เขียนรายชื่อไว้เอง:
   *      const SUPER_USERS = ['admin', 'namna'];   // code.gs/Index.html:14096
   *  ⇒ ย้ายรายชื่อไปไว้ "ที่เดียว" คือ modules/sales/see-all.js
   *    เพราะ save.js ต้องใช้รายชื่อชุดเดียวกันเป็นด่านแก้รหัสงานด้วย
   *    (บทเรียน "กติกาเดียวกันห้ามมี 2 ที่" — core/app-access.js)
   *    ⇒ เพิ่มคนทีหลัง = แก้ไฟล์เดียว บรรทัดเดียว
   *
   *  ‼ ผลของ admin / namna / สิทธิ์ Administrator "เท่าเดิมทุกตัวอักษร"
   *    ที่เพิ่มคือชื่อ Amonrat_18 ชื่อเดียว (Permission จริง = "Sale support")
   *  ‼ ไม่แตะ isAdmin() ข้างล่าง ซึ่งเป็นด่านของเครื่องมือแอดมิน
   *    (ซิงก์ PEAK · ตัดยอดจริง · ตั้ง Prefix) — สิทธิ์ชุดนั้นไม่ได้ขยายเลย
   * ═══════════════════════════════════════════════════════════════ */
  const SEE = require('./see-all');
  const SUPER_USERS = SEE.SALES_SEE_ALL_USERS;   /* ‼ ชี้ไปที่เดียว ไม่ก๊อปค่า */
  const isBoss = u => SEE.canSeeAllSales(u);
  /* ‼ กับดักที่เกือบทำให้เซลส์ "เห็นว่างเปล่า" ทั้งหน้า:
   *   ตัวกรอง p_sale ของแต่ละ RPC เทียบคนละช่องกัน!
   *     sales_search  (/api/list)              → เทียบ v.owner   = "ชื่อเล่น"
   *     sales_records (/api/records) · sales_find → เทียบ "Sales Code" = "username"
   *   ส่งผิดชนิด = กรองไม่เจออะไรเลย แล้วดูเหมือนไม่มีงาน ทั้งที่งานอยู่ครบ
   *
   *  @param kind 'code' = username · 'nick' = ชื่อเล่น
   *  @returns null = เห็นทุกใบ (แอดมิน/Namna) · string = บังคับกรองเฉพาะของคนนี้ */
  const mustFilter = (req, kind) => {
    if (isBoss(req.user)) return null;
    const u = req.user || {};
    const v = kind === 'nick'
      ? (clean(u.nickname) || clean(u.name) || clean(u.username))
      : clean(u.username);
    /* ‼ หาตัวตนไม่ได้ = ไม่ให้เห็นอะไรเลย ปลอดภัยกว่าปล่อยให้เห็นของทุกคน */
    return v || '—';
  };

  /* ═══════════════════════════════════════════════════════════════
   *  🔴 v22.5 · "บันทึกแล้วไม่ขึ้นในตาราง แต่มียอดใน Ranking"
   *
   *  พี่เอเจอซ้ำอีกครั้ง 7 ก.ย. 69: ล็อกอินเป็นเซลส์ "พลอย"
   *  ตารางขึ้น 0 รายการ ทั้งที่อันดับยอดขายมีชื่อพลอยอยู่
   *
   *  ต้นเหตุ (เหมือนเคสแนน Amonrat_18 ในแอปเก่า Code.gs:1568–1580):
   *    ตารางกรองด้วยช่อง "Sales Code" ทางเดียว
   *    ส่วนอันดับ/ชื่อบนตารางใช้ "Create By" → คนละช่องกัน
   *    แถวไหน Sales Code ว่าง และคำนำหน้ารหัสงานไม่มีในทะเบียน
   *    จะกลายเป็น "ไม่มีเจ้าของ" เจ้าตัวจึงมองไม่เห็นงานตัวเองเลย
   *
   *  แอปเก่าแก้ไว้แล้ว (v22.5) แต่ตอนย้ายมาระบบใหม่ยังไม่ได้ยกกฎนี้มาด้วย
   *  กฎเดิมเป๊ะ (Code.gs:1579):
   *    แถวที่มีเจ้าของชัดเจน  → ยึด Sales Code เหมือนเดิม ไม่หลวมลง
   *    แถวที่ไม่มีเจ้าของเลย → ค่อยดูชื่อบนแถวว่าใช่ของคนนี้ไหม
   * ═══════════════════════════════════════════════════════════════ */
  const isUnknownName = s => !clean(s) || /^\(?\s*ไม่ระบุ\s*\)?$/.test(clean(s));
  /** _meKeys (Code.gs:846) — ชื่อทุกแบบที่ "หมายถึงคนนี้" */
  const meKeys = u => {
    const out = new Set();
    const add = s => { s = clean(s); if (s && !isUnknownName(s)) out.add(s.toLowerCase()); };
    add(u && u.username); add(u && u.nickname); add(u && u.name);
    /* ตัดวงเล็บชื่อเล่นออกมา เช่น "(พลอย) พลอยไพลิน" → "พลอย" */
    const m = clean(u && u.name).match(/^\((.+?)\)/);
    if (m) add(m[1]);
    return out;
  };
  /* ═══════════════════════════════════════════════════════════════
   *  🔴 บันไดหาเจ้าของแถว — ที่เดียวของทั้งระบบ (v1.21.0)
   *
   *  พี่เอเจอซ้ำเป็นครั้งที่ 4 เมื่อ 7 ก.ย. 69: เลือกเดือนกันยายน + "กุ้งกิ๊ง"
   *  แล้วยังขึ้น "ยังไม่มีรายการในช่วงที่เลือก · 0 รายการ"
   *
   *  ‼ รอบก่อน (v1.19.0) หนูเติมแค่ขั้นที่ ② คือเดาจากคำนำหน้ารหัสงาน
   *    ซึ่งช่วยได้ก็ต่อเมื่อคำนำหน้านั้น "ถูกลงทะเบียนไว้แล้ว"
   *    ของกุ้งกิ๊งยังไม่ได้ลงทะเบียน → เดาไม่ออก → กรองแล้วเหลือศูนย์เหมือนเดิม
   *    ‼ บทเรียน: แก้บั๊กแล้วต้องถามต่อว่า "แล้วถ้าข้อมูลที่พึ่งพาไม่มีล่ะ"
   *
   *  บันไดเต็มตามแอปเก่า (Code.gs:1557–1560 + _isMine 860):
   *    ① มี "Sales Code" → ยึดตามนั้นอย่างเดียว ไม่หลวมลง
   *    ② ไม่มี → เดาเจ้าของจากคำนำหน้ารหัสงาน (_ownerByJob)
   *    ③ เดาไม่ออก → ดูชื่อเล่นที่แสดงบนแถว (มาจาก Create By)
   *       เทียบกับ "ชื่อทุกแบบของคนนั้น" — Username · ชื่อเล่น · ชื่อเต็ม
   *
   *  ‼ ใช้บันไดเดียวกันทั้ง "เซลส์ดูงานตัวเอง" และ "แอดมินกรองรายคน"
   *    ถ้าใช้คนละชุด สองหน้าจะเห็นไม่ตรงกัน แล้วไม่มีใครรู้ว่าอันไหนถูก
   *  ‼ ใบที่ไม่ระบุเซลส์ = ไม่ใช่ของใคร (Code.gs:863) ทุกขั้นตอน
   * ═══════════════════════════════════════════════════════════════ */
  const jobOwner = (r, iJob, pfx) => {
    const job = clean(iJob >= 0 && r && r.cells ? r.cells[iJob] : '').toUpperCase();
    if (!job) return '';
    for (const p of (pfx || [])) if (job.startsWith(p.px)) return p.un;
    return '';
  };
  /** แถวนี้เป็นของคนที่มีกุญแจชุด keys (และ username = code) ไหม */
  const rowOwnedBy = (r, keys, code, iJob, pfx) => {
    const sc = clean(r && r.salesCd);
    if (sc) return keys.has(sc.toLowerCase());          /* ① ชัดเจนแล้ว */
    const by = jobOwner(r, iJob, pfx);
    if (by) return by === clean(code).toLowerCase();     /* ② เดาจากคำนำหน้า */
    const nick = clean(r && r.saleNick);                 /* ③ ชื่อบนแถว */
    if (isUnknownName(nick)) return false;
    return keys.has(nick.toLowerCase());
  };
  /** เจ้าของแถวนี้คือคนที่ล็อกอินอยู่ไหม — _isMine (Code.gs:860) + กฎ v22.5 */
  const rowIsMine = (r, u, iJob, pfx) =>
    rowOwnedBy(r, meKeys(u), clean(u && u.username), iJob, pfx);

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
    const sale   = mustFilter(req, 'nick') || clean(req.query.sale);  /* sales_search เทียบชื่อเล่น */
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
  /* ═══════════════════════════════════════════════════════════════
   *  👤 รายชื่อในช่องกรอง "— ทุกคน —" ต้องเป็นพนักงานขายจริงเท่านั้น
   *
   *  พี่เอสั่ง 7 ก.ย. 69:
   *    "ดู filter รายชื่อพนักงานขาย ให้ดึงมาเฉพาะ user ที่มีสิทธิ์
   *     Sale , Sale support , Graphic สาขามดงาน , Administrator เท่านั้น"
   *
   *  ‼ ของเดิมเอา "ทุกรหัสที่เคยมีในชีต" มารวมด้วย (Code.gs:1594) รายชื่อจึงบวม
   *    มีทั้งคนลาออก · ชื่อที่พิมพ์ผิด · สิทธิ์อื่นที่ไม่ใช่ฝ่ายขาย
   *    ข้อนี้พี่เอสั่งให้เปลี่ยน จึงกรองด้วย Permission แทน
   *
   *  ‼ กรองที่ "รายชื่อในดรอปดาวน์" อย่างเดียว — ไม่ได้ตัดข้อมูลแถวไหนทิ้ง
   *    ใบงานของคนที่ไม่อยู่ในรายการยังอยู่ครบ แค่ไม่มีชื่อให้เลือกกรอง
   * ═══════════════════════════════════════════════════════════════ */
  const SALE_PERMS = ['sale', 'sale support', 'graphic สาขามดงาน', 'administrator'];
  const permKey = v => clean(v).toLowerCase().replace(/\s+/g, ' ');
  let _spCache = { at: 0, set: null };
  async function saleFilterCodes() {
    /* ‼ ถามครั้งเดียวต่อ 5 นาที — ตารางรายการขายโหลดถี่มาก
     *   ยิงถามทุกครั้งคือ "การค้นในทางที่คนรอ" ซึ่งเป็นบทเรียนราคาแพงของ 6 ก.ย. */
    if (_spCache.set && Date.now() - _spCache.at < 300000) return _spCache.set;
    const rows = await db.select('app_users',
      { select: '"Username","Permission"', limit: 1000 }).catch(() => null);
    /* ‼ อ่านไม่ได้ = คืน null แปลว่า "ไม่รู้" → ไม่กรองอะไรเลย
     *   ดีกว่าคืนรายการว่างซึ่งทำให้ช่องกรองหายไปทั้งช่อง */
    if (!Array.isArray(rows)) return null;
    const set = new Set();
    for (const u of rows) {
      if (!SALE_PERMS.includes(permKey(u.Permission))) continue;
      const un = clean(u.Username); if (un) set.add(un.toLowerCase());
    }
    _spCache = { at: Date.now(), set };
    return set;
  }

  /* ═══════════════════════════════════════════════════════════════
   *  🔴 v22.5 อีกด้านหนึ่ง — ตัวกรอง "ชื่อพนักงานขาย" ของแอดมิน
   *
   *  พี่เอเจอ 7 ก.ย. 69: เลือกเดือนสิงหาคม + เลือก "พลอย" แล้วตารางแทบว่าง
   *    "ตรวจสอบ filter ชื่อเซลล์ ช่วงเวลาด้วย มันไม่ทำงาน"
   *
   *  ต้นเหตุ: เป็นบั๊กตัวเดียวกับเคส "พลอยมองไม่เห็นงานตัวเอง" แต่มองจาก
   *    ฝั่งแอดมิน — sales_records กรองด้วย `"Sales Code" = p_sale` ทางเดียว
   *    ในชีตจริงแถวส่วนใหญ่ช่องนั้น "ว่าง" จึงหลุดหายไปเกือบหมด
   *    (เทสต์พิสูจน์: พลอยมี 3 ใบ กรองแล้วเหลือ 1 ใบ)
   *
   *  ‼ แอปเก่าทำถูกอยู่แล้ว (Code.gs:1557–1560, 1582) — ถ้า Sales Code ว่าง
   *    ให้ "เดาเจ้าของจากคำนำหน้ารหัสงาน" ก่อน แล้วค่อยเอาผลนั้นไปเทียบ:
   *        if (!rowCode) { var o = _ownerByJob(R[cJob]); if (o) rowCode = o[0]; }
   *        if (u.role === 'admin' && filterCode && rowCode !== filterCode) continue;
   *    ตอนย้ายมาระบบใหม่ ยกมาแค่ครึ่งเดียว — นี่คือครึ่งที่ขาด
   *
   *  ‼ ไม่ผ่อนกฎให้หลวมกว่าเดิม: แถวที่มี Sales Code ยังยึดตามนั้นอย่างเดียว
   *
   *  🔴 รอบสอง 7 ก.ย. 69 — พี่เอส่งภาพมาอีก: เลือก "กุ้งกิ๊ง" แล้วยัง 0 รายการ
   *    เพราะรอบแรกเติมมาแค่ขั้น ② (เดาจากคำนำหน้า) ซึ่งพึ่งทะเบียนคำนำหน้า
   *    ของกุ้งกิ๊งยังไม่ได้ลงทะเบียน → เดาไม่ออก → ว่างเปล่าเหมือนเดิม
   *    ตอนนี้ใช้บันไดเต็ม (rowOwnedBy) มีขั้น ③ เทียบชื่อบนแถวด้วย
   *    จึงทำงานได้แม้ยังไม่ได้ตั้งค่าคำนำหน้าให้ใครเลยสักคน
   * ═══════════════════════════════════════════════════════════════ */
  /* กุญแจชื่อทุกแบบของ "คนที่ถูกเลือกในดรอปดาวน์" — จำ 5 นาที
   *  ‼ ต้องอ่านจากทะเบียนผู้ใช้จริง ไม่ใช่เชื่อค่าที่หน้าเว็บส่งมา */
  let _keyCache = { at: 0, map: null };
  async function saleKeyMap() {
    if (_keyCache.map && Date.now() - _keyCache.at < 300000) return _keyCache.map;
    const rows = await db.select('app_users',
      { select: '"Username","Nickname","Name"', limit: 2000 }).catch(() => null);
    if (!Array.isArray(rows)) return _keyCache.map || new Map();
    const map = new Map();
    for (const u of rows) {
      const un = clean(u.Username); if (!un) continue;
      map.set(un.toLowerCase(),
              meKeys({ username: un, nickname: u.Nickname, name: u.Name }));
    }
    _keyCache = { at: Date.now(), map };
    return map;
  }
  let _pfxCache = { at: 0, list: null };
  async function prefixOwners() {
    /* จำ 5 นาที — ตารางนี้โหลดถี่ ไม่ควรถามทะเบียนใหม่ทุกครั้ง */
    if (_pfxCache.list && Date.now() - _pfxCache.at < 300000) return _pfxCache.list;
    const rows = await db.select('sales_prefix',
      { select: 'prefix,username', limit: 500 }).catch(() => null);
    if (!Array.isArray(rows)) return _pfxCache.list || [];
    /* ‼ ยาวชนะสั้น — B2K ต้องไม่แพ้ B2 ไม่งั้นเดาเจ้าของผิดคน */
    const list = rows.map(p => ({ px: clean(p.prefix).toUpperCase(),
                                  un: clean(p.username).toLowerCase() }))
                     .filter(p => p.px && p.un)
                     .sort((a, b) => b.px.length - a.px.length);
    _pfxCache = { at: Date.now(), list };
    return list;
  }
  /* ‼ sales_find ไม่ได้คืนหัวตารางมาด้วย (คนละรูปกับ sales_records)
   *   จึงต้องรู้เองว่า "รหัสงาน" อยู่คอลัมน์ที่เท่าไรในลำดับเดียวกัน
   *   ‼ ห้ามเดาเป็นเลขตายตัว — ผังคอลัมน์มาจากหัวชีตจริงซึ่งขยับได้ */
  let _jobColCache = { at: 0, i: -1 };
  async function jobColIndex() {
    if (_jobColCache.i >= 0 && Date.now() - _jobColCache.at < 300000) return _jobColCache.i;
    const rows = await db.select('v_sales_cols',
      { select: 'name,ord', order: 'ord.asc', limit: 500 }).catch(() => null);
    if (!Array.isArray(rows)) return _jobColCache.i;
    const i = rows.findIndex(c => clean(c && c.name) === 'รหัสงาน');
    if (i >= 0) _jobColCache = { at: Date.now(), i };
    return i;
  }
  /** เตรียมของที่บันไดหาเจ้าของต้องใช้ — เรียกครั้งเดียวต่อคำขอ ไม่ใช่ต่อแถว */
  async function ownerCtx(headers) {
    const [pfx, kmap] = await Promise.all([prefixOwners(), saleKeyMap()]);
    const i = Array.isArray(headers) ? headers.indexOf('รหัสงาน') : -1;
    return { pfx, kmap, iJob: i >= 0 ? i : await jobColIndex() };
  }
  /* ═══════════════════════════════════════════════════════════════
   *  🔤 v1.39.0 · ติดป้าย "รหัสงานผิดรูปแบบ" ให้แถวในตาราง Sale
   *
   *  🔴 ทีมแจ้ง 21 ก.ย. 69: "ยอดขายของแว่น รหัส QW2026/024 กับ QW2026/025
   *     ไม่โชว์หน้า Sale ค่ะ"
   *  พิสูจน์ด้วยการรันแล้วว่ารูปแบบรหัส "ไม่ได้" ทำให้ใบหาย (ตารางกรองด้วยวันที่ติดต่อ
   *  กับเจ้าของใบเท่านั้น — sql/17:62–66) แต่ใบที่รหัสผิดต้อง "มองเห็นว่าผิด"
   *  ไม่ใช่ปนอยู่เงียบ ๆ ⇒ ติดธง jobBad (ข้อความเหตุผล) ให้หน้าเว็บวาดป้าย
   *
   *  ‼ กติกามาจาก modules/sales/jobcode-format.js ที่เดียว — ไม่เขียนสูตรที่นี่
   *  ‼ คิดจากแถวที่ได้มาแล้วในคำขอเดิม — ไม่มีคำขอฐานข้อมูลเพิ่ม
   *  ‼ ไม่ตัดแถวไหนทิ้ง ไม่แก้ค่าในแถว แค่เติมช่อง jobBad
   * ═══════════════════════════════════════════════════════════════ */
  const JF = require('./jobcode-format');
  function markBadJobs(rows, iJob) {
    if (!Array.isArray(rows) || !(iJob >= 0)) return 0;
    const yy = JF.nowYY();
    let n = 0;
    for (const r of rows) {
      const c = JF.checkJobCode(r && r.cells ? r.cells[iJob] : '', yy);
      if (c.bad) { r.jobBad = c.why; n++; }
    }
    return n;
  }

  /** ตัวคัดแถวสำหรับ "แอดมินเลือกกรองรายคน" — ใช้บันไดเดียวกับเซลส์ดูงานตัวเอง */
  function saleFilterFor(sale, ctx) {
    const code = clean(sale).toLowerCase();
    /* ‼ ไม่มีคนนี้ในทะเบียนผู้ใช้ ก็ยังเทียบ Username กับคำนำหน้าได้
     *   (ดีกว่าคืนว่างเปล่าซึ่งดูเหมือนระบบพัง) */
    const keys = ctx.kmap.get(code) || new Set([code]);
    return r => rowOwnedBy(r, keys, code, ctx.iJob, ctx.pfx);
  }

  router.get('/api/records', async (req, res) => {
    const from = clean(req.query.from), to = clean(req.query.to);
    const ym   = clean(req.query.ym);
    /* ‼ เซลส์ธรรมดา = บังคับกรองเฉพาะงานตัวเอง ไม่สนว่าหน้าเว็บส่งอะไรมา
     *   🔴 v22.5 · แต่ "กรองที่ฐานข้อมูลด้วย Sales Code ทางเดียว" ทำให้เซลส์
     *      ที่แถวไม่มี Sales Code มองไม่เห็นงานตัวเองเลย (เคสพลอย 7 ก.ย. 69)
     *      จึงไม่ส่ง p_sale ลงไป แล้วมาคัดเจ้าของด้วยกฎเดิมของแอปเก่าที่นี่แทน
     *      ‼ ข้อมูลของคนอื่นไม่เคยออกจากเซิร์ฟเวอร์ — คัดทิ้งก่อนตอบกลับเสมอ */
    const mineOnly = mustFilter(req, 'code') !== null;
    const sale = mineOnly ? '' : clean(req.query.sale);
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 10, 1), 400);
    const mode = (from || to) ? 'range' : (/^\d{4}-\d{2}$/.test(ym) ? 'month' : 'days');
    try {
      /* ‼ ไม่ส่ง p_sale ลงฐานข้อมูลอีกแล้ว — ฐานข้อมูลรู้จักแต่ "Sales Code"
       *   ซึ่งกรองได้ไม่ครบ เจ้าของแถวตัวจริงต้องคิดด้วยกฎเดิมของแอปเก่า */
      const r = await db.rpc('sales_records', {
        p_mode: mode, p_ym: ym || null,
        p_from: from || null, p_to: to || null,
        p_days: days, p_sale: null, p_limit: 6000,
      });
      const j = Array.isArray(r) ? r[0] : r;
      const out = { ok: true, ...(j || {}) };
      if ((mineOnly || sale) && Array.isArray(out.rows)) {
        const ctx = await ownerCtx(out.headers);
        /* เซลส์ธรรมดา = เห็นแต่ของตัวเอง · แอดมินเลือกกรองรายคน = ใช้บันไดเดียวกัน */
        out.rows = mineOnly
          ? out.rows.filter(x => rowIsMine(x, req.user, ctx.iJob, ctx.pfx))
          : out.rows.filter(saleFilterFor(sale, ctx));
      }
      /* 🔤 v1.39.0 · ป้าย "รหัสงานผิดรูปแบบ" — หัวตารางมากับคำตอบนี้แล้ว ไม่ต้องถามเพิ่ม */
      out.jobBadN = markBadJobs(out.rows,
        Array.isArray(out.headers) ? out.headers.indexOf('รหัสงาน') : -1);
      /* ‼ ของเดิมโชว์ช่องกรองคนเฉพาะแอดมิน (Index.html:13431) — ยกมาให้เหมือน */
      if (mineOnly) out.salespeople = [];
      else {
        const okCodes = await saleFilterCodes();
        if (okCodes && Array.isArray(out.salespeople))
          out.salespeople = out.salespeople
            .filter(s => okCodes.has(clean(s && s.code).toLowerCase()));
        /* ═══════════════════════════════════════════════════════════
         *  👤 ชื่อในดรอปดาวน์ต้องเป็น "(ชื่อเล่น) ชื่อจริง นามสกุล" ทุกคน
         *
         *  🔴 ต้นเหตุที่รายชื่อปนกัน 2 แบบ (พี่เอส่งภาพมา 14 ก.ย. 69):
         *     app.sales_records() ประกอบ salespeople จาก 2 ทางแล้ว union กัน
         *       (sql/17-sales-records-fast.sql:88–94)
         *         ทาง ก) app_users  → coalesce(Nickname, Username)  = ชื่อเล่นเปล่า ๆ
         *         ทาง ข) total_sales→ "Sales Name" ที่คนคีย์ไว้     = มักเป็นชื่อเต็ม
         *       แล้ว distinct on (code) order by code, name
         *       ⇒ "(" เรียงมาก่อนอักษรไทย คนที่มีใบขายที่คีย์ชื่อเต็มไว้จึงชนะ
         *         ได้ชื่อเต็ม · คนที่ไม่มี ตกไปใช้ Nickname เปล่า ๆ
         *
         *  ‼ แปลงแค่ "ข้อความที่แสดง" — ค่าที่ส่งกลับมากรอง (code) ไม่แตะเลย
         *    ⇒ เปลี่ยนรูปแบบชื่อแล้ว ยังกรองเจอข้อมูลเดิมครบเท่าเดิมทุกใบ
         *  ‼ อ่านทะเบียนผู้ใช้ "ก้อนเดียว" แล้วแคช — ไม่ยิงถามรายคนเด็ดขาด
         *    (บทเรียน 14 ก.ย. 69 · Supabase CPU 99% ทั้งบริษัทใช้งานไม่ได้) */
        if (Array.isArray(out.salespeople) && out.salespeople.length) {
          const dir = await SN.directorySafe();
          out.salespeople = out.salespeople.map(s => ({
            ...s, name: SN.byCode(dir, s && s.code, s && s.name),
          }));
          /* เรียงตามชื่อที่แสดงจริง — สูตรเดียวกับของเดิม (Code.gs:1601) */
          out.salespeople.sort((a, b) => (a.name < b.name ? -1 : 1));
        }
      }
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  รูปพนักงาน — Drive ──(ดึงครั้งเดียว)──▶ Supabase Storage ──(CDN)──▶ จอ
   *
   *  หน้าเว็บอ่านแค่แผนที่ ชื่อเล่น → URL จากตาราง ไม่แตะ Drive เลย
   *  จึงเร็วระดับมิลลิวินาที และไม่เจอปัญหา 403 จาก referer อีก
   *
   *  รูปอื่นที่จะตามมา (หน้างาน · CheckList · สลิป) ใช้ทางเดียวกันนี้ได้
   * ═══════════════════════════════════════════════════════════════ */

  /** แผนที่ ชื่อเล่น → URL รูป (เร็ว อ่านจากตารางล้วน) */
  router.get('/api/avatars', async (req, res) => {
    const av = require('../../core/avatars');
    /* map = ใบที่อยู่ในคลังแล้ว (เร็วที่สุด ใช้ได้ทันที)
     * src = ค่าดิบในชีต สำหรับใบที่ยังไม่อยู่ในคลัง
     *       หน้าเว็บเอาไปต่อเป็น /img/avatar/<ค่าดิบ> แล้วเซิร์ฟเวอร์ดึงให้ตอนนั้น
     *       ‼ นี่คือเหตุผลที่รูปขึ้นได้โดยไม่ต้องกดปุ่มอะไรเลย */
    /* ═══════════════════════════════════════════════════════════════
     *  ‼ อ่านจากบ้านเราอย่างเดียว (พี่เอสั่ง 5 ก.ย. 69 — "เดี๋ยวพี่จะปิดชีต")
     *
     *    map = app.user_photo → Storage CDN · อ่านตารางล้วน
     *          ไม่มีคำขอไปหาชีตหรือ Drive เลยแม้แต่คำขอเดียว
     *          ปิดชีตเมื่อไหร่ เส้นทางนี้ไม่สะดุดเลย
     *
     *    src = ทางถอยระหว่างที่ยังย้ายของไม่ครบเท่านั้น
     *          พอย้ายครบแล้วมันจะว่างเอง ไม่ต้องแก้โค้ดอะไร
     * ═══════════════════════════════════════════════════════════════ */
    /* ‼ อ่านจากฐานข้อมูลล้วน ไม่แตะชีตเลย (พี่เอสั่ง 5 ก.ย. 69)
     *   "หลังจากนี้ เราจะไม่อ่าน sheet แล้ว ต้องอ่าน file path จาก database
     *    แล้วไปดึงรูปจาก google drive ให้ได้"
     *
     *   app.sales_avatars() ทำครบในคำขอเดียว:
     *     app_users.Impage (ที่อยู่ไฟล์) → app.drive_index (สารบัญ) → ลิงก์ Drive
     *   ‼ ไม่มีการก๊อปไฟล์มาเก็บที่เรา — ไฟล์อยู่ที่ Drive ที่เดียวตลอดไป */
    const map = await require('../../core/photo').map();

    const body = { ok: true, map, src: {}, count: Object.keys(map).length };
    if (clean(req.query.debug) === '1') body.rows = await av.status();
    res.json(body);
  });

  /* ‼ การใส่/ลบ/ย้ายรูปพนักงาน ย้ายไปอยู่ที่โมดูล "จัดการผู้ใช้" แล้ว
   *   (พี่เอสั่ง 5 ก.ย. 69: "ไป update รูปพนักงานที่ส่วนของการจัดการผู้ใช้")
   *   ที่นี่เหลือแค่ GET /api/avatars ไว้ "อ่าน" มาวาดรูปในตารางเท่านั้น
   *   ‼ รูปเป็นเรื่องของข้อมูลผู้ใช้ ไม่ใช่เรื่องของงานขาย — ควรอยู่ที่เดียว */

  /** ค้นทั้งชีต — 7 คอลัมน์ ผลไม่เกิน 60 แถว (ถอดจาก findRecords) */
  router.get('/api/find', async (req, res) => {
    const q = clean(req.query.q);
    /* 🔴 v22.5 เหมือนกับ /api/records — กรองด้วย Sales Code ทางเดียวไม่พอ
     *   ขอมากกว่าที่ต้องแสดง แล้วค่อยคัดเจ้าของที่นี่ ตัดให้เหลือ 60 เหมือนเดิม */
    const mineOnly = mustFilter(req, 'code') !== null;
    const sale = mineOnly ? '' : clean(req.query.sale);
    if (q.length < 2) return res.json({ ok: true, q, rows: [], capped: false });
    const t0 = Date.now();
    try {
      /* ‼ ช่องค้นหาก็ต้องเคารพตัวกรองคนแบบเดียวกับตาราง — ไม่งั้นแอดมินเลือก
       *   "พลอย" ไว้ แล้วพิมพ์ค้นหา จะได้ผลคนละชุดกับที่เห็นในตาราง */
      const r = await db.rpc('sales_find',
        { p_q: q, p_sale: null, p_max: (mineOnly || sale) ? 200 : 60 });
      const j = Array.isArray(r) ? r[0] : r;
      const out = { ok: true, ...(j || {}) };
      if ((mineOnly || sale) && Array.isArray(out.rows)) {
        const ctx = await ownerCtx(null);   /* sales_find ไม่ส่งหัวตารางมา */
        out.rows = (mineOnly
          ? out.rows.filter(x => rowIsMine(x, req.user, ctx.iJob, ctx.pfx))
          : out.rows.filter(saleFilterFor(sale, ctx))).slice(0, 60);
      }
      /* 🔤 v1.39.0 · ป้ายเดียวกับตาราง — ‼ คนพิมพ์ค้น "QW2026/024" คือคนที่กำลังตามหาใบนี้
       *   sales_find ไม่ส่งหัวตารางมา ⇒ ใช้ตำแหน่งคอลัมน์ที่แคชไว้ 5 นาที (jobColIndex) */
      if (Array.isArray(out.rows) && out.rows.length)
        out.jobBadN = markBadJobs(out.rows, await jobColIndex());
      res.json({ ...out, ms: Date.now() - t0 });
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
      /* 🔴 v26-F · "ใบนี้ แก้รหัสงานได้ไหม" — ตัดสินเป็นรายใบ (เจ้าของงานแก้ได้)
       *   ‼ เรียก save.mayEditJobCode() ตัวเดียวกับที่ planJobRename() ใช้เป็นด่านจริง
       *     ⇒ หน้าจอกับด่านเซิร์ฟเวอร์เถียงกันไม่ได้โดยโครงสร้าง
       *   ‼ ตอบไม่ได้ = false (fail-closed) แต่ต้องไม่ทำให้ "เปิดใบ" พังตาม */
      let canEditJobCode = false;
      try { canEditJobCode = await save.mayEditJobCode(req.user, row); }
      catch (e) { canEditJobCode = false; }
      res.json({ ok: true, data, meta, extra: row._extra || null, canEditJobCode });
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
    /* ═══════════════════════════════════════════════════════════════
     *  🔴 "วันนี้" ต้องยึดเวลาไทย ไม่ใช่ UTC
     *
     *  ‼ ของเดิมอ่าน d.getUTCFullYear/Month/Date() จากเวลาเครื่องตรง ๆ
     *    เซิร์ฟเวอร์รันด้วยเวลา UTC ซึ่งช้ากว่าบ้านเรา 7 ชั่วโมง
     *
     *  ตี 0 ถึง 7 โมงเช้าบ้านเรา ฝั่ง UTC ยังเป็นเมื่อวาน ผลคือ:
     *    · ช่วง "เดือนนี้" จบที่เมื่อวาน ยอดของวันนี้หายไปทั้งวัน
     *    · 🔴 ร้ายแรงสุด — คืนวันที่ 1 ของเดือน ระบบจะคิดว่ายังอยู่เดือนที่แล้ว
     *      แล้วการ์ด "ยอดขายเดือนนี้" จะโชว์ยอดทั้งเดือนก่อนแทน
     *      ซึ่งเป็นตัวเลขที่ดู "เหมือนจริง" ทุกประการ แต่ผิดเดือน
     *
     *  พี่เอจับได้เอง 7 ก.ย. 69 ตี 1 ครึ่ง: การ์ดขึ้นช่วง 01/09 – 06/09
     *  ทั้งที่บ้านเราข้ามไปวันที่ 7 แล้ว
     * ═══════════════════════════════════════════════════════════════ */
    const d = new Date(todayTH() + 'T00:00:00Z');
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
    /* ‼ หน้าเว็บไม่ส่งวันมา = "เอาของวันนี้" — ต้องเป็นวันนี้ตามเวลาไทย */
    const day = clean(req.query.day) || todayTH();
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

  /* ═══════════════════════════════════════════════════════════════
   *  🏆 รอบ 230 — อันดับสะสม 3 เดือนล่าสุด (ช่องขวาสุดของแถวอันดับ)
   *  พี่เอ 3 ต.ค. 69: "ในส่วนของ Ranking sale ให้เพิ่มอีกช่องนึง คือ Ranking สะสม 3 เดือนล่าสุด ให้ด้วยไว้ช่องขวาสุด"
   *  3 เดือนล่าสุด = เดือนของวันที่เลือก + 2 เดือนก่อนหน้า (นิยามเดียวกับตัวเลือก "3 เดือนล่าสุด" ของการ์ดยอดขาย)
   *  ‼ ใช้ตัวคิดอันดับตัวเดิม (app.sales_ranking → ช่อง month) ทีละเดือนแล้วบวกกัน ⇒ กติกาเดียวกับ "อันดับสะสมเดือนนี้"
   *    ทุกตัว (งานที่ปิดการขาย · เจ้าของงานตามสูตรเดิม) และไม่ต้องรัน SQL เพิ่ม
   *  ⚡ เส้นแยกจาก /api/dashboard (หน้าเว็บเรียกหลังการ์ดขึ้นแล้ว ไม่รอกัน) · จำไว้: เดือนปัจจุบัน 60 วินาที เดือนที่ผ่านแล้ว 10 นาที
   * ═══════════════════════════════════════════════════════════════ */
  const _rk3 = new Map();                       /* 'yyyy-mm' → { at, list } */
  async function rankMonth_(ym, pDay, ttl) {
    const c = _rk3.get(ym);
    if (c && Date.now() - c.at < ttl) return c.list;
    const r = one(await db.rpc('sales_ranking', { p_day: pDay })) || {};
    const list = Array.isArray(r.month) ? r.month : [];
    _rk3.set(ym, { at: Date.now(), list });
    return list;
  }
  router.get('/api/dashboard/rank3m', async (req, res) => {
    const q = clean(req.query.day);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayTH();
    try {
      const d = new Date(day + 'T00:00:00Z');
      const Y = d.getUTCFullYear(), M = d.getUTCMonth();
      const ymd = x => x.toISOString().slice(0, 10);
      const first = k => ymd(new Date(Date.UTC(Y, M - k, 1)));
      const lists = await Promise.all([0, 1, 2].map(k =>
        rankMonth_(first(k).slice(0, 7), k === 0 ? day : first(k), k === 0 ? 60 * 1000 : 10 * 60 * 1000)));
      const by = new Map();
      for (const L of lists) for (const x of L) {
        const nick = clean(x.nick) || '(ไม่ระบุ)';
        const o = by.get(nick) || { nick, amt: 0, deals: 0 };
        o.amt += Number(x.amt) || 0; o.deals += Number(x.deals) || 0;
        by.set(nick, o);
      }
      const list = [...by.values()].map(o => ({ nick: o.nick, amt: Math.round(o.amt * 100) / 100, deals: o.deals }))
        .sort((a, b) => b.amt - a.amt);
      res.json({ ok: true, day, from: first(2), to: ymd(new Date(Date.UTC(Y, M + 1, 0))),
                 months: [2, 1, 0].map(k => first(k).slice(0, 7)), list,
                 total: Math.round(list.reduce((a, x) => a + x.amt, 0) * 100) / 100 });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* 🏆💵 รอบ 230 — ยอดรับเงินของแต่ละคนบนอันดับ (วันที่เลือก · เดือนนั้น · 3 เดือนล่าสุด)
   *   พี่เอ 3 ต.ค. 69: "ในส่วนของ Dashboard sale ranking ให้ใส่ยอดรับเงินของแต่ละคนในช่วงเวลานั้นๆ มาด้วยนะ อย่าให้โหลดช้านะ"
   *   ⚡ เส้นแยก เรียกหลังอันดับขึ้นแล้ว · ใช้งวดรับเงินที่จำไว้ก้อนเดียวกับการ์ดรับเงินจริง (ปกติไม่แตะฐานเลย)
   *   ทุกสิทธิ์ที่เห็นอันดับเห็นยอดนี้ (ยอดรวมต่อคน ไม่มีรายลูกค้า รายบิล) */
  router.get('/api/dashboard/rank-received', async (req, res) => {
    const q = clean(req.query.day);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayTH();
    try {
      const d = new Date(day + 'T00:00:00Z');
      const Y = d.getUTCFullYear(), M = d.getUTCMonth();
      const ymd = x => x.toISOString().slice(0, 10);
      const mEnd = ymd(new Date(Date.UTC(Y, M + 1, 0)));
      const R = await require('./cash-received').receivedByOwner({
        day: [day, day],
        month: [ymd(new Date(Date.UTC(Y, M, 1))), mEnd],
        m3: [ymd(new Date(Date.UTC(Y, M - 2, 1))), mEnd] });
      R.day = day;
      res.json(R);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  💵 รอบ 228–229 — ยอดรับเงินจริงสะสมของช่วงเดียวกับการ์ด "ยอดขายสะสม" + แยกช่องทาง
   *  (พี่เอ 3 ต.ค. 69: "เพิ่มยอดรับเงินจริงสะสมที่ sync data จาก peak ตามช่วงเวลาเดียวกันของยอดขายสะสมด้วย"
   *   + "ตอนโหลดต้องรวดเร็ว ไม่ช้าด้วยนะ" · รอบ 229: "ควรเห็น" (ทุกสิทธิ์) · "เพิ่มการรับเงินจริงในแต่ละช่องทาง"
   *   · "ยอดรับเงินให้ดู Status ที่มีการตัดยอดรับชำระเหมือนกับ Cash flow เลยนะ")
   *  ‼ เส้นแยกจาก /api/dashboard — หน้าเว็บเรียกหลังการ์ดยอดขายขึ้นแล้ว การ์ดเดิมจึงไม่ช้าลงเลย
   *  ‼ รอบ 229: ทุกคนที่เข้าแอปคีย์ยอดขายได้เห็นยอดนี้ (รอบ 228 จำกัดเฉพาะผู้ดูแลระบบ — พี่เอสั่งเปิด)
   *     ส่งเฉพาะยอดรวม/ยอดต่อช่องทาง ไม่มีรายใบ รายลูกค้า หรือรายเซลส์
   *  🔒 อ่านอย่างเดียว ไม่ถาม PEAK สด (ใช้ข้อมูลที่ตัวซิงก์ PEAK เก็บไว้แล้ว)
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/dashboard/received', async (req, res) => {
    try {
      const w = win(clean(req.query.win) || 'this', clean(req.query.from), clean(req.query.to));
      const R = await require('./cash-received').cashReceived(w);
      R.detail = isAdmin(req);          /* รอบ 230 — ผู้ดูแลระบบกด "ดูรายการ" ได้ (หน้าเว็บใช้ตัดสินว่าจะโชว์ปุ่มไหม) */
      res.json(R);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* 🔎 รอบ 230 — รายการที่ประกอบเป็นยอดรับเงินจริง (ทีละงวด ทีละงาน + เหตุผลของช่องทาง)
   *   พี่เอ 3 ต.ค. 69: "check ให้ถูกต้องอีกทีนะ ว่าทำไมสาขาถึงเก็บเงินได้เท่ากับที่ขายเป๊ะเลย"
   *                    "แน่ใจนะ ว่าดึงยอดรับเงินมาถูกช่องทาง … ดึงด้วยหลักการอะไร อ้างอิงจากอะไร"
   *   ‼ มีชื่อลูกค้า + เลขบิล ⇒ เฉพาะผู้ดูแลระบบ (เส้นยอดรวมข้างบนยังเปิดทุกสิทธิ์เหมือนเดิม) */
  router.get('/api/dashboard/received/detail', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false,
      error: '🔒 รายการรับเงินรายงวด (มีชื่อลูกค้าและเลขบิล) เปิดให้เฉพาะผู้ดูแลระบบ' });
    try {
      const w = win(clean(req.query.win) || 'this', clean(req.query.from), clean(req.query.to));
      res.json(await require('./cash-received').cashReceivedDetail(w, clean(req.query.ch)));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** อันดับยอดขายสาขามดงาน */
  router.get('/api/branch', async (req, res) => {
    /* ‼ เดือนก็ต้องยึดเวลาไทย — คืนวันสิ้นเดือนตี 0–7 โมง UTC ยังเป็นเดือนก่อน
     *   ไม่แก้ = รายงานทั้งหน้าเป็นของเดือนที่แล้ว โดยไม่มีอะไรบอก */
    const m = clean(req.query.month) || monthTH();
    try {
      res.json({ ok: true, month: m,
                 ...one(await db.rpc('sales_branch_dash', { p_month: m + '-01' })) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /** Daily Report — เซลส์ × วันในเดือน แยกลูกค้าเก่า/ใหม่ */
  router.get('/api/daily', async (req, res) => {
    /* ‼ เดือนตามเวลาไทย (เหตุผลเดียวกับ /api/branch) */
    const m = clean(req.query.month) || monthTH();
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
      /* ‼ 17 ก.ย. 69 — ต่อคีย์รอง '_row.asc' เข้ากับของเดิม (ไม่ได้เขียนทับ 'No.asc')
       *   ตั้งแต่มี sql/81-channels-add.sql ตารางนี้มี 2 ที่มา:
       *   แถวจากชีต (_row 1..N) กับแถวที่เพิ่มในระบบใหม่ (_row >= 900000000)
       *   ถ้าเลข "No" บังเอิญชนกัน ลำดับของแถวที่เสมอกันจะไม่แน่นอน
       *   คีย์รองทำให้ลำดับคงที่เสมอ และแถวที่เพิ่มในระบบใหม่ต่อท้ายแถวของชีต */
      const rows = await db.selectAll('channels', { select: '*', order: 'No.asc,_row.asc' });
      const seen = new Set();
      for (const r of rows || []) {
        /* ═══════════════════════════════════════════════════════════
         *  🔴 ช่องทางที่ถูก "ปิดการใช้งาน" ที่หน้าทะเบียนกลาง ต้องไม่โผล่ในดรอปดาวน์
         *    (modules/registry — พี่เอสั่ง 17 ก.ย. 69 "ปิด sync sheet ทุกไฟล์")
         *  ‼ null / undefined = เปิดอยู่ ⇒ แถวเดิมทุกแถว และฐานที่ยังไม่ได้รัน
         *    sql/83 ทำงานเหมือนเดิมเป๊ะ ไม่มีใครหายจากดรอปดาวน์
         *  ‼ เทียบกับ false ตรง ๆ เท่านั้น ห้ามเขียน !r._app_active
         *    (ไม่งั้น null จะกลายเป็น "ปิด" แล้วช่องทางหายทั้งตาราง)
         *  ‼ แถวที่ปิดยังอยู่ในตาราง — รายงานยอดขายเก่าที่อ้างชื่อนี้ไม่พัง
         * ═══════════════════════════════════════════════════════════ */
        if (r._app_active === false) continue;
        const name = clean(r.Channel);
        if (!name || seen.has(name) || /\(\d+\)$/.test(name)) continue;
        seen.add(name);
        out.channels.push({ name, group: channelGroup(name) });
      }
    } catch { /* ไม่มีข้อมูลช่องทาง = ปล่อยว่าง ฟอร์มยังใช้ได้ */ }
    /* ผู้ผลิตภายนอก — ถอดจาก _makerOptions() code.gs:6787
     *
     *  ‼ ของเดิมอ่าน "คอลัมน์ A ตั้งแต่แถว 2" ของแท็บ "รายชื่อ Outsource" เท่านั้น
     *
     *  รอบก่อนอลิซเขียนว่า "เอาค่าแรกที่เป็นข้อความ" ซึ่งผิด — ตารางกระจกมีช่องระบบ
     *  _hash อยู่ด้วย มันเลยหยิบลายนิ้วมือ 933efc1daee72676 มาเป็นชื่อผู้ผลิต
     *  ตอนนี้ยึด "ชื่อหัวคอลัมน์แรกจริง ๆ ของแท็บ" จากทะเบียน app.sheet_headers */
    try {
      const hd = await db.select('sheet_headers',
        { source: 'eq.outsource', select: 'name,ord', order: 'ord.asc', limit: 1 });
      const colA = (hd && hd[0] && hd[0].name) || '';
      const rows = await db.selectAll('outsource', { select: '*', order: '_row.asc' });
      const seen = new Set();
      for (const r of rows || []) {
        const ex = r._extra || {};
        const v = clean(colA ? (r[colA] !== undefined ? r[colA] : ex[colA]) : '');
        if (!v || seen.has(v)) continue;
        seen.add(v); out.maker.push(v);
      }
      out.makerCol = colA;   /* ไว้ไล่ย้อนเวลารายชื่อไม่ขึ้น */
    } catch (e) { out.makerError = e.message; }
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
      /* ‼ ทะเบียนชื่อพนักงานขาย ขอ "ครั้งเดียวต่อคำขอ" แล้วใช้กับทุกแถว
       *   ห้ามขอรายแถวเด็ดขาด — 10 แถว = 10 คำขอ คือทางที่ทำให้ฐานล่ม */
      const dir = await SN.directorySafe();
      res.json({ ok: true, rows: (rows || []).map(r => ctCard(r, dir)) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  ผู้ติดต่อ 1 ราย ตาม Contact ID
   *
   *  ‼ ทำไมต้องมี (พี่เอเจอเอง 6 ก.ย. 69):
   *    กดแก้ไขใบขาย → ช่อง ตำแหน่ง · อีเมล · ที่อยู่ ว่างเปล่าทุกครั้ง
   *    เพราะข้อมูลพวกนี้ไม่ได้อยู่ในตารางขาย มันอยู่ในตารางผู้ติดต่อ
   *    แถวขายเก็บไว้แค่ 'Contact ID' → ต้องตามไปอ่านอีกตาราง
   *
   *  🔒 อ่านอย่างเดียว — ไม่มีทางเขียนทับผู้ติดต่อจากทางนี้
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/contact/:id', async (req, res) => {
    const id = clean(req.params.id);
    if (!id) return res.json({ ok: true, row: null });
    try {
      const rows = await db.select('contacts', { ID: 'eq.' + id, select: '*', limit: 1 });
      const dir = await SN.directorySafe();
      res.json({ ok: true, row: rows && rows[0] ? ctCard(rows[0], dir) : null });
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
      const dir = await SN.directorySafe();     /* ‼ ครั้งเดียวต่อคำขอ ไม่ใช่รายแถว */
      const scored = (rows || []).map(r => {
        const c = ctCard(r, dir);
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

  /* ═══════════════════════════════════════════════════════════════
   *  ซิงก์กับ PEAK — ‼ ทิศทางเดียว PEAK ──▶ ชีต
   *
   *  ไม่มี endpoint ไหนที่เขียนอะไรกลับไปที่ PEAK
   *  core/peak.js ยิงได้แค่ GET กับ POST /ClientToken (ขอกุญแจเข้าระบบ)
   *  ผลที่ได้เขียนลง "ชีต" แล้วตามลงฐานข้อมูล — เหมือนทางบันทึกปกติ
   * ═══════════════════════════════════════════════════════════════ */

  /** สถานะการเชื่อมต่อ — ตั้งค่าครบไหม กิจการไหนพร้อมบ้าง */
  router.get('/api/peak/status', async (_req, res) => {
    const peak = require('../../core/peak');
    const ready = peak.configuredList();
    /* ‼ ready = "มีกุญแจครบ" เท่านั้น ไม่ได้แปลว่าเชื่อมต่อได้
     *   verify = ผลทดสอบจริงล่าสุด (null = ยังไม่เคยทดสอบ)
     *   ห้ามเอา ready ไปขึ้นหน้าจอว่า "เชื่อมแล้ว" อีก (พี่เอจับได้ 5 ก.ย. 69) */
    let verify = {};
    try { verify = await peak.verifyMap(); } catch { verify = {}; }
    res.json({ ok: true, ready, verify,
      verified: Object.values(verify).filter(v => v && v.ok).length,
      all: ['มดงานการป้าย', 'The 101'],
      readOnly: true,
      note: ready.length ? '' :
        'ยังไม่ได้ตั้งกุญแจ PEAK — ใส่ PEAK_MODNGAN_KEY / PEAK_MODNGAN_USER ' +
        'และ PEAK_THE101_KEY / PEAK_THE101_USER ใน Railway > Variables' });
  });

  /**
   * ‼ ค้นหาสูตรลายเซ็นที่ PEAK ยอมรับ แล้วจำไว้
   *
   *   เอกสาร PEAK ไม่ได้บอกว่าเซ็นด้วยกุญแจตัวไหน · เซ็นข้อความอะไร ·
   *   ส่งเป็น hex หรือ base64 — แอปเดิมจึงมีตัวไล่ลองแบบนี้เหมือนกัน
   *   ค้นครั้งเดียวจำไว้ตลอด ไม่ต้องทำอีก
   */
  router.post('/api/peak/probe', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    const peak = require('../../core/peak');
    try {
      res.json(await peak.probeSignature(clean((req.body || {}).biz),
        { max: Number((req.body || {}).max) || 40 }));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /** ทดสอบการเชื่อมต่อ (ไม่แตะข้อมูลจริง) */
  router.post('/api/peak/ping', async (req, res) => {
    const peak = require('../../core/peak');
    try {
      res.json(await peak.ping(clean(req.body && req.body.biz)));
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  /** ดึงแถวที่จะซิงก์ (ปิดการขาย + มีเลข IV) ตามช่วงที่เลือก */
  async function rowsToSync(q) {
    const p = { select: '*', order: '_row.desc',
                'Lead Status': 'like.*ปิดการขาย*' };
    const from = clean(q.from), to = clean(q.to), ym = clean(q.ym);
    if (from) p['วันที่ติดต่อ'] = 'gte.' + from;
    if (to)   p['วันที่ติดต่อ'] = 'lte.' + to;
    if (/^\d{4}-\d{2}$/.test(ym)) {
      const a = ym + '-01';
      const d = new Date(a + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0);
      p['วันที่ติดต่อ'] = 'gte.' + a;
      p['and'] = `("วันที่ติดต่อ".lte.${d.toISOString().slice(0, 10)})`;
    }
    if (clean(q.row)) return [await db.one('total_sales', { _row: 'eq.' + clean(q.row), select: '*' })]
                              .filter(Boolean);
    const rows = await db.selectAll('total_sales', p);
    /* เอาเฉพาะที่มีเลขเอกสารจริง — ไม่งั้นเสียคำขอไปกับแถวที่ยังไม่ออกบิล */
    return (rows || []).filter(r => clean(r['เลขที่ QO / IV']));
  }

  /** ตรวจก่อน — ดึงมาเทียบให้ดู ไม่เขียนอะไรทั้งนั้น */
  router.post('/api/peak/preview', async (req, res) => {
    const sync = require('./peak-sync');
    try {
      const rows = await rowsToSync(req.body || {});
      res.json(await sync.preview({ rows, limit: (req.body || {}).limit }));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /** ตัดยอดจริง — เขียนผลลงชีต (เฉพาะแอดมิน) */
  router.post('/api/peak/apply', async (req, res) => {
    const sync = require('./peak-sync');
    const role = clean(req.user && (req.user.permission || req.user.role));
    if (!/administrator|ผู้ดูแล|admin/i.test(role))
      return res.status(403).json({ ok: false,
        error: 'ตัดยอดจริงได้เฉพาะผู้ดูแลระบบ — กด "ตรวจก่อน" เพื่อดูผลได้ทุกคน' });
    try {
      const all = await rowsToSync(req.body || {});
      const pick = (req.body || {}).rows;
      const rows = Array.isArray(pick) && pick.length
        ? all.filter(r => pick.includes(r._row)) : all;
      const r = await sync.apply({ rows, limit: (req.body || {}).limit, user: req.user });
      try { await ctx.audit(req.user, 'peak_apply', { target: r.updated + ' แถว' }); } catch {}
      res.json(r);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  คิวซิงก์หลังบ้าน — ถอดจากแอปเดิมให้เหมือน
   *
   *  ‼ ทำไมต้องมีคิว ไม่ถามสด ๆ ตอนกดบันทึก
   *    1 ใบใช้ราว 3 คำขอ ถามสดแปลว่าเซลส์ต้องนั่งรอทุกครั้งที่บันทึก
   *    และถ้า PEAK ล่ม จะบันทึกงานไม่ได้เลย ซึ่งรับไม่ได้ งานขายต้องมาก่อน
   *
   *  ‼ ทุกเส้นทางในนี้ยังเป็น PEAK ──▶ ชีต ทางเดียวเหมือนเดิม
   * ═══════════════════════════════════════════════════════════════ */
  const pq = require('../../core/peak-queue');
  const pa = require('../../core/peak-auto');

  /* ‼ ปุ่มสั่งซิงก์เปิดให้เฉพาะแอดมิน (กฎเดิม _reqSyncAdmin code.gs:782)
   *   เปิดดูสถานะและรายงานยังใช้ได้ทุกคนตามปกติ */
  const isAdmin = req => /administrator|ผู้ดูแล|admin/i
    .test(clean(req.user && (req.user.permission || req.user.role)));
  const denyAdmin = res => res.status(403).json({ ok: false,
    error: '🔒 ปุ่มสั่งซิงก์กับ PEAK เปิดให้เฉพาะผู้ดูแลระบบ — ' +
           'การเปิดดูสถานะและรายงานยังใช้ได้ตามปกติ' });

  /** ตัวถาม PEAK 1 ใบ — คิวเรียกตัวนี้ ไม่ได้เขียนตรรกะ PEAK ซ้ำเอง */
  const askOne = row => require('./peak-sync').checkRow(row);

  /** ตัวเขียนผล 1 ใบ ลงชีตก่อน แล้วตามลงฐานข้อมูล (ลำดับเดิมของระบบ) */
  const writeOne = async J => {
    const c = J.chk;
    if (!c) return;
    const set = (c.set && Object.keys(c.set).length)
      ? { ...c.set }
      /* ‼ ประทับเวลาต้องเป็นเวลาไทย และรูปแบบเดียวกับที่ peak-sync เขียน
       *   ของเดิมเป็น '2026-09-06T18:33' (เวลา UTC) — คนอ่านเห็นแล้วนึกว่า
       *   ซิงก์ตอนหกโมงเย็น ทั้งที่จริงคือตี 1 ครึ่งของวันถัดไป
       *   ‼ และคนละรูปแบบกับช่องเดียวกันที่เขียนจากอีกทาง = ตารางมีสองภาษา */
      : { 'สถานะซิงก์ PEAK': c.ss, 'อัปเดต PEAK เมื่อ': stampTH() };

    /* ‼ "เคยเจอแล้วรอบนี้หาย" ต้องขึ้นบนชีตว่า lost ไม่ใช่ miss
     *   คิวแยกสองอย่างนี้ออกจากกันได้ แต่ถ้าเขียนลงชีตเป็น "ไม่พบใน PEAK"
     *   เหมือนกันหมด คนอ่านชีตก็ไม่มีทางรู้ว่ามีอะไรผิดปกติ
     *   ซึ่งทำให้การแยกสองอย่างนี้เสียเปล่าไปทั้งหมด */
    if (J.out === 'lost') {
      set['สถานะซิงก์ PEAK'] = '⚠️ เคยเจอ แต่รอบนี้หาไม่เจอ';
      set['ผลตรวจ PEAK'] = 'เคยเจอใบนี้ใน PEAK แล้ว แต่รอบนี้หาไม่เจอ — ' +
        'ตัวเลขเดิมยังอยู่ครบ ไม่ได้ถูกลบ · อาจถูกยกเลิกหรือเปลี่ยนเลขเอกสาร ควรเปิดดูใน PEAK';
    }
    if (J.fpNew)  set['ลายเซ็นข้อมูล PEAK'] = J.fpNew;
    if (J.nextAt) set['ตรวจครั้งถัดไป'] = J.nextAt;
    await require('./peak-sync').writeSet(J.it.row_no, set);
  };
  pa.setAsker(askOne);      /* ‼ ต้องมีทั้งคู่ ขาดตัวใดตัวหนึ่งตัวหลังบ้านไม่เดิน */
  pa.setWriter(writeOne);

  const runQueue = (o) => pq.run({ ask: askOne, write: writeOne, ...o });

  /** สภาพคิว + แถบความครอบคลุม + ตัวนับผลรอบล่าสุด */
  /* ═══════════════════════════════════════════════════════════════
   *  🔍 กระทบยอดกับ PEAK ทุกรายการขาย — พี่เอสั่ง 9 ก.ย. 69
   *    "ทำให้ทุกรายการขาย เช็คกับ peak ทั้งยอดใบแจ้งหนี้
   *     และยอดรับเงินจริงให้ถูกต้อง 100% นะ"
   *
   *  ตอบ 2 ตัวเลขต่อ 1 รายการ แยกกันชัด ๆ:
   *    ① ยอดใบแจ้งหนี้  ชีต vs PEAK
   *    ② ยอดรับเงินจริง ชีต vs ใบเสร็จ RT ทุกงวดที่เก็บไว้ใน cash_flow
   *  ‼ ตัวไหนไม่มีข้อมูลจาก PEAK ต้องบอกว่า "ยังไม่ได้ตรวจ"
   *    ห้ามเงียบแล้วปล่อยให้เข้าใจว่าตรง (บทเรียนซ้ำ ๆ ของทั้งระบบ)
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/peak/reconcile', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    try {
      const q = clean(req.query.q).toLowerCase();
      const onlyBad = clean(req.query.bad) === '1';
      const limit = Math.min(2000, Number(req.query.limit) || 500);

      const sales = await db.selectAll('total_sales', { select: '*', order: '_row.asc' }) || [];
      const cf = await db.selectAll('cash_flow', { select: '*', order: 'id.asc' }) || [];

      /* ใบเสร็จจริงรายงวด จัดกลุ่มตามเลขบิล */
      const byIv = new Map();
      for (const r of cf) {
        const k = clean(r.iv).toUpperCase();
        if (!k) continue;
        if (!byIv.has(k)) byIv.set(k, []);
        byIv.get(k).push(r);
      }

      const n2 = v => Math.round((Number(v) || 0) * 100) / 100;
      const eq = (a, b) => Math.abs(n2(a) - n2(b)) < 1;
      const out = [];
      let okAll = 0, badBill = 0, badPaid = 0, notChecked = 0;

      for (const r of sales) {
        if (!/ปิดการขาย/.test(clean(r['Lead Status']))) continue;
        const iv = clean(r['เลขที่ QO / IV']);
        const comp = clean(r['ชื่อบริษัท']);
        if (q && (comp + ' ' + iv + ' ' + clean(r['รหัสงาน'])).toLowerCase().indexOf(q) < 0) continue;

        const sheetBill = n2(r['ยอดเรียกเก็บ (บาท)']);
        const sheetPaid = n2(r['รับจริง (บาท)']);
        const peakBill  = n2(r['ยอดตาม PEAK'] ?? r['ยอดเรียกเก็บ PEAK']);
        const peakPaid  = n2(r['รับชำระแล้ว (PEAK)'] ?? r['ยอดรับชำระ PEAK']);

        const rts = byIv.get(iv.toUpperCase()) || [];
        const rtSum = n2(rts.reduce((a, x) => a + (Number(x.amount) || 0), 0));

        /* ① ยอดใบแจ้งหนี้ */
        const billState = !peakBill ? 'ยังไม่ได้ตรวจ (ไม่มียอดจาก PEAK)'
                        : eq(sheetBill, peakBill) ? 'ตรง' : 'ไม่ตรง';
        /* ② ยอดรับเงินจริง — ถือใบเสร็จ RT เป็นของจริงก่อนเสมอ */
        const paidRef = rts.length ? rtSum : peakPaid;
        const paidFrom = rts.length ? `ใบเสร็จ RT ${rts.length} งวด`
                       : peakPaid ? 'ยอดรวมที่ PEAK ยืนยัน (ยังไม่มีใบเสร็จรายงวด)'
                       : '';
        const paidState = !paidFrom ? 'ยังไม่ได้ตรวจ (ไม่มีข้อมูลรับเงินจาก PEAK)'
                        : eq(sheetPaid, paidRef) ? 'ตรง' : 'ไม่ตรง';

        const bad = billState === 'ไม่ตรง' || paidState === 'ไม่ตรง';
        if (billState === 'ไม่ตรง') badBill++;
        if (paidState === 'ไม่ตรง') badPaid++;
        if (billState.startsWith('ยังไม่') || paidState.startsWith('ยังไม่')) notChecked++;
        if (!bad && !billState.startsWith('ยังไม่') && !paidState.startsWith('ยังไม่')) okAll++;
        if (onlyBad && !bad) continue;
        if (out.length >= limit) continue;

        out.push({
          แถว: r._row, รหัสงาน: clean(r['รหัสงาน']), บริษัท: comp, เลขที่บิล: iv,
          ยอดใบแจ้งหนี้: { ชีต: sheetBill, PEAK: peakBill, ต่าง: n2(sheetBill - peakBill), ผล: billState },
          ยอดรับเงินจริง: { ชีต: sheetPaid, PEAK: paidRef, ต่าง: n2(sheetPaid - paidRef),
                            ผล: paidState, ที่มา: paidFrom,
                            งวด: rts.map(x => ({ เลขที่RT: x.receipt_no, วันที่รับเงิน: x.paid_at,
                                                  ยอดรับ: n2(x.amount), หักณที่จ่าย: n2(x.wht),
                                                  รับจริง: n2(x.cash) })) },
        });
      }

      res.json({ ok: true,
        สรุป: { รายการที่ปิดการขาย: out.length, ตรงทั้งสองยอด: okAll,
                ยอดใบแจ้งหนี้ไม่ตรง: badBill, ยอดรับเงินไม่ตรง: badPaid,
                ยังไม่ได้ตรวจ: notChecked,
                ใบเสร็จรายงวดในระบบ: cf.length },
        หมายเหตุ: 'ยอดรับเงินจริงยึด "ใบเสร็จ RT ทุกงวด" ก่อนเสมอ ' +
                  'ถ้ายังไม่มีใบเสร็จรายงวดจึงใช้ยอดรวมที่ PEAK ยืนยัน',
        รายการ: out });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  router.get('/api/peak/queue', async (_req, res) => {
    try { res.json(await pq.status()); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /** ตั้งต้นคิว — โหมดคือความต่างของปุ่มกวาดทุกปุ่ม */
  router.post('/api/peak/queue/build', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    const b = req.body || {};
    /* ‼ never / moved เป็นสองปุ่มที่พี่เอสั่งเพิ่ม 7 ก.ย. 69
     *   ลืมใส่ชื่อในรายการนี้เมื่อไหร่ = ปุ่มกดแล้วเงียบ ๆ กลายเป็นโหมด open แทน
     *   ซึ่งกวาดเยอะกว่าที่ตั้งใจมาก โดยไม่มีอะไรบอกคนกด */
    const mode = ['day', 'open', 'all', 'bad', 'retry', 'never', 'moved'].includes(clean(b.mode))
      ? clean(b.mode) : 'open';
    try {
      const r = await pq.build({ mode, day: clean(b.day),
                                 force: b.force === true || b.force === '1' });
      await pa.ensure();                    /* ตั้งต้นแล้วเปิดตัวเก็บคิวให้เลย */
      res.json(r);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /** เก็บคิว 1 รอบเดี๋ยวนี้ (ปกติตัวหลังบ้านทำให้เอง) */
  router.post('/api/peak/queue/run', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    const b = req.body || {};
    try {
      res.json(await runQueue({ budgetMs: Number(b.budgetMs) || 40000,
                                cap: Number(b.cap) || 60 }));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /** ตัวซิงก์หลังบ้าน — เปิด/ปิด/ดูสถานะ */
  router.get('/api/peak/auto', async (_req, res) => {
    try { res.json(await pa.statusOf()); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  router.post('/api/peak/auto/start', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    await pa.start(clean(req.user && req.user.username));
    res.json({ ok: true, msg: '🤖 เก็บคิวเดี๋ยวนี้ — ตัวซิงก์หลังบ้านเปิดตลอด เก็บคิวเองทุก 1 นาที\n' +
      'รอบนี้เริ่มภายในไม่กี่วินาที\n⭐ ปิดหน้าจอได้เลย' });
  });
  router.post('/api/peak/auto/stop', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    /* 🔴 รอบ 212 — พี่เอ: "เปิด auto ไว้เลยไม่ต้องปิดนะ" ⇒ สั่งหยุดแล้วไม่หยุด + บอกเหตุผล */
    const r = await pa.stop('สั่งหยุดโดย ' + clean(req.user && req.user.username));
    if (r && r.alwaysOn) return res.json({ ok: true, alwaysOn: true, msg: r.msg });
    res.json({ ok: true,
      msg: 'หยุดตัวซิงก์หลังบ้านแล้ว (งานที่อยู่ในคิวยังอยู่ครบ ไม่หายไปไหน)' });
  });
  /** 📊 รอบ 212 — % ใบที่ยังค้างรับทุกใบ ที่อัปเดตกับ PEAK แล้ว (อ่านฐานอย่างเดียว · จำ 60 วิ) */
  router.get('/api/peak/open-progress', async (req, res) => {
    try { res.json(await require('./peak-open').openProgress({ fresh: clean(req.query.fresh) === '1' })); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /** ซิงก์อัตโนมัติรายวัน — เลือกได้สูงสุด 6 รอบ */
  router.get('/api/peak/daily', async (_req, res) => {
    try { res.json(await pa.dailyStatus()); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  router.post('/api/peak/daily/on', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    try { res.json(await pa.dailyOn((req.body || {}).hours, (req.body || {}).mode)); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  router.post('/api/peak/daily/off', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    res.json(await pa.dailyOff());
  });

  /** ตรวจว่ายังมีใบไหนหลุด — ‼ อ่านล้วน ไม่ยิงถาม PEAK เลยสักคำขอ */
  /* ═══════════════════════════════════════════════════════════════
   *  🔎 ตรวจสอบข้อมูล PEAK — ยกจากแอปเดิม getPeakAudit (Code.gs:12645)
   *
   *  ‼ สิทธิ์ยกมาตามของเดิมเป๊ะ (_isPeakAdmin Code.gs:747):
   *    ฝ่ายบัญชี (Permission = Accounting) หรือชื่อผู้ใช้ในรายการ
   *    ไม่ได้เปลี่ยนเป็น "แอดมินเท่านั้น" เพราะฝ่ายบัญชีคือคนที่ต้องใช้จริง
   *
   *  🔒 อ่านอย่างเดียว ไม่เรียก PEAK สด ไม่เขียนอะไรกลับ
   * ═══════════════════════════════════════════════════════════════ */
  const PEAK_ADMIN_USERS = ['admin', 'namna', 'saarapao', 'naruemon'];
  const isPeakAdmin = req => {
    const u = req.user || {};
    const un = clean(u.username || u.code).toLowerCase();
    if (un === 'system') return true;              /* ตัวรันอัตโนมัติของระบบเอง ไม่ใช่คน */
    if (PEAK_ADMIN_USERS.includes(un)) return true;
    return /accounting|บัญชี|การเงิน|finance/i.test(clean(u.permission));
  };

  router.get('/api/peak/audit', async (req, res) => {
    if (!isPeakAdmin(req))
      return res.status(403).json({ ok: false,
        error: 'เมนูที่เชื่อมกับ PEAK เปิดให้เฉพาะฝ่ายบัญชี (Permission = Accounting) ' +
               'หรือผู้ใช้ "' + PEAK_ADMIN_USERS.join(' / ') + '" เท่านั้น' +
               (req.user && req.user.username
                 ? ` — คุณเข้าระบบด้วยชื่อ ${req.user.username}` +
                   (req.user.permission ? ` · สิทธิ์ ${req.user.permission}` : '')
                 : '') });
    try {
      res.json(await require('./peak-audit').audit());
    } catch (e) {
      res.status(500).json({ ok: false, msg: pgMsg(e.message), error: pgMsg(e.message) });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🧭 เสนอราคา → วางบิล → รับเงิน — ยกจากแอปเดิม
   *     getQuoLinkReport (Code.gs:13466)
   *
   *  ‼ สิทธิ์ยกมาตามของเดิมเป๊ะ: _reqAdministrator(_auth(token))
   *    = ผู้ดูแลระบบเท่านั้น (คนละชั้นกับเมนูตรวจสอบข้อมูล PEAK ที่ฝ่ายบัญชีเข้าได้)
   *    หน้าเว็บของเดิมก็กันชั้นแรกด้วย admrGate('เสนอราคา → วางบิล')
   *
   *  🔒 อ่านอย่างเดียว ไม่เรียก PEAK สด ไม่เขียนอะไรกลับ
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/quo-link', async (req, res) => {
    if (!isAdmin(req))
      return res.status(403).json({ ok: false,
        msg: '🔒 เมนู "เสนอราคา → วางบิล" เปิดให้เฉพาะผู้ดูแลระบบ' +
             (req.user && req.user.username
               ? ` — คุณเข้าระบบด้วยชื่อ ${req.user.username}` +
                 (req.user.permission ? ` · สิทธิ์ ${req.user.permission}` : '')
               : '') });
    try {
      res.json(await require('./quo-link').quoLink());
    } catch (e) {
      res.status(500).json({ ok: false, msg: pgMsg(e.message), error: pgMsg(e.message) });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🏢 ยอดขายแยกตามบริษัทที่ขาย — ยกจากแอปเดิม
   *     getBizReport (Code.gs:12973)
   *
   *  ‼ สิทธิ์ยกมาตามของเดิมเป๊ะ: _reqAdministrator(_auth(token))
   *    หน้าเว็บของเดิมกันชั้นแรกด้วย admrGate('แยกตามบริษัท')
   *
   *  🔒 อ่านอย่างเดียว ไม่เรียก PEAK สด ไม่เขียนอะไรกลับ
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/biz-report', async (req, res) => {
    if (!isAdmin(req))
      return res.status(403).json({ ok: false,
        msg: '🔒 เมนู "แยกตามบริษัท" เปิดให้เฉพาะผู้ดูแลระบบ' +
             (req.user && req.user.username
               ? ` — คุณเข้าระบบด้วยชื่อ ${req.user.username}` +
                 (req.user.permission ? ` · สิทธิ์ ${req.user.permission}` : '')
               : '') });
    try {
      res.json(await require('./biz-report').bizReport(req.query.months));
    } catch (e) {
      res.status(500).json({ ok: false, msg: pgMsg(e.message), error: pgMsg(e.message) });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  📑 รายงานติดตามรับชำระ — ยกจากแอปเดิม
   *     getCollectionReport (Code.gs:7762)
   *
   *  ‼ สิทธิ์ยกมาตามของเดิมเป๊ะ: _reqPeakAdmin(_auth(token))
   *    = ฝ่ายบัญชี หรือรายชื่อที่กำหนด (ตัวเดียวกับเมนูตรวจสอบข้อมูล PEAK)
   *    ‼ ไม่ใช่ isAdmin — ของเดิมใช้ด่านคนละชั้นกับเมนูรายงานอื่น อย่าสลับ
   *
   *  ‼ ข้อมูลที่เห็นยังถูกคุมอีกชั้นในตัวรายงานเอง (_collFullView)
   *    ทีมติดตามเก็บเงินเห็นของทุกคน · คนอื่นเห็นเฉพาะใบของตัวเอง
   *
   *  🔒 อ่านอย่างเดียว ไม่เรียก PEAK สด ไม่เขียนอะไรกลับ
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/coll-report', async (req, res) => {
    if (!isPeakAdmin(req))
      return res.status(403).json({ ok: false, cnt: 0,
        msg: 'รายงานรับชำระ เปิดให้เฉพาะฝ่ายบัญชี (Permission = Accounting) ' +
             'หรือผู้ใช้ "' + PEAK_ADMIN_USERS.join(' / ') + '" เท่านั้น' +
             (req.user && req.user.username
               ? ` — คุณเข้าระบบด้วยชื่อ ${req.user.username}` +
                 (req.user.permission ? ` · สิทธิ์ ${req.user.permission}` : '')
               : '') });
    try {
      const q = req.query || {};
      res.json(await require('./coll-report')
        .collReport(req.user, q.from, q.to, String(q.all) === 'true'));
    } catch (e) {
      res.status(500).json({ ok: false, cnt: 0, msg: pgMsg(e.message), error: pgMsg(e.message) });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  💰 ลูกหนี้ค้างชำระ · ติดตามหนี้ — ยกจากแอปเดิม
   *     arAging (Code.gs:15169) · logFollowUp (7054) · getFollowUps (7126)
   *
   *  ‼ สิทธิ์ยกมาตามของเดิมเป๊ะ (v21.3): เปิดให้ทุกคนที่เข้าระบบได้
   *    แต่ "เห็นข้อมูลไม่เท่ากัน" — เซิร์ฟเวอร์เป็นคนตัดสินว่าใครเห็นใบไหน
   *      · Administrator / Accounting / ทีมเก็บเงิน → ทุกพนักงานขาย
   *      · เซลส์ทั่วไป → เฉพาะของตัวเอง + ใบที่ยังไม่ระบุเซลส์
   *    ‼ อย่าเผลอเติมด่าน isAdmin ที่นี่ — ของเดิมย้ายสิทธิ์ไปคุมที่ "ข้อมูล"
   *      ไม่ใช่ที่ "ปุ่ม" (Index.html:8054 เขียนกำกับไว้ชัด)
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/ar-aging', async (req, res) => {
    try {
      const q = req.query || {};
      res.json(await require('./ar-aging').arAging(req.user, {
        sale: q.sale, biz: q.biz, bucket: q.bucket, src: q.src,
        /* 🔴 รอบ 26 — ตัวกรอง "ชื่อลูกค้า" (พี่เอสั่ง 15 ก.ย. 69)
         *   ‼ บรรทัดนี้ขาดไม่ได้: ถ้าไม่ส่ง cust ต่อ ช่องค้นหาบนจอจะพิมพ์ได้
         *     แต่ไม่กรองอะไรเลย (ตัวกรองอยู่ฝั่งเซิร์ฟเวอร์ เพราะช่อง
         *     "ยังไม่ครบกำหนด" ไม่มีการ์ดให้กรองที่หน้าเว็บ — ar-aging.js:420)
         *   ‼ ค่านี้ไม่เคยถูกส่งเป็น ilike เข้า PostgREST (กัน * / % เป็นไวลด์การ์ด) */
        cust: q.cust,
        dueFrom: q.dueFrom, dueTo: q.dueTo,
        includeNotDue: String(q.includeNotDue) === 'true',
      }));
    } catch (e) {
      res.status(500).json({ ok: false, msg: pgMsg(e.message), error: pgMsg(e.message) });
    }
  });

  /* 📷 รอบ 189 — รูปงานเสร็จ (Projects · Status Complete · "Image Complete") ของการ์ดลูกหนี้
   *   พี่เอ 30 ก.ย. 69: "เพิ่มรูป project status complete ไปดึงรูปภาพที่จบงาน image complete จาก app project มานะ"
   *   ‼ หน้าเว็บขอทีหลัง (การ์ดขึ้นก่อน รูปตามมา) — หน้าลูกหนี้ไม่ช้าลง · สิทธิ์รายใบด่านเดียวกับการ์ด (_arCanEdit)
   *   ‼ อ่านอย่างเดียว ⇒ GET (?rows=1,2,3 · สูงสุด 400 แถว) */
  router.get('/api/ar-aging/complete-img', async (req, res) => {
    try {
      res.json(await require('./ar-complete').arCompleteImages(req.user,
        String((req.query || {}).rows || '').split(',').slice(0, 400)));
    } catch (e) {
      res.status(500).json({ ok: false, error: pgMsg(e.message) });
    }
  });

  /* 🔧 รอบ 202 — งานติดตั้งบนการ์ดลูกหนี้: รูปเซลส์ · ช่าง+รูป · วันเวลาเข้าติดตั้ง · สถานะจบงาน · ภาพจบงาน/หน้างาน
   *   พี่เอ 1 ต.ค. 69: "ในหน้าลูกหนี้ค้างชำระ เพิ่มการแสดงรูปพนักงานขาย , ชื่อ รูปช่างติดตั้ง วันที่ เวลาที่เข้าติดตั้ง
   *                     และสถานะการจบงาน เพื่อตรวจสอบติดตามการเก็บเงิน" + "รูปการจบงาน หรือภาพหน้างานด้วย"
   *   ‼ อ่านอย่างเดียว ⇒ GET · สิทธิ์รายใบด่านเดียวกับการ์ด · ไม่มีช่องเงินของคิว (modules/sales/ar-install.js) */
  router.get('/api/ar-aging/install', async (req, res) => {
    try {
      res.json(await require('./ar-install').arInstallInfo(req.user,
        String((req.query || {}).rows || '').split(',').slice(0, 400)));
    } catch (e) {
      res.status(500).json({ ok: false, error: pgMsg(e.message) });
    }
  });

  /* ⚡ รอบ 205 — ไอดีไฟล์ของรูปบนการ์ดลูกหนี้ (ภาพงานเสร็จ · ภาพหน้างาน · ภาพจบงาน)
   *   พี่เอ 1 ต.ค. 69: "ไปดูวิธีดึงข้อมูลภาพจาก app Job card สั่งผลิตสิ ทำไมเค้าเร็ว"
   *   ‼ ยืมตัวของ Job Card ตรง ๆ (modules/jobcard/drivefiles.getImageFileIds — ห้ามลอก):
   *     ลิงก์/ไอดี แกะเอง → สารบัญ img_index ครั้งเดียว → ที่ยังไม่เจอถาม Drive พร้อมกัน 8 ไฟล์ แล้วจดกลับสารบัญ
   *   ‼ อ่านอย่างเดียว (คืนแค่ path → ไอดีไฟล์) ⇒ GET (?paths=<JSON> · หน้าเว็บส่งชุดละ 40 ค่า · สูงสุด 400)
   *     (ยาม test-sales: POST = เส้นเขียน ต้องอยู่ในทะเบียน — เส้นนี้ไม่ใช่) */
  router.get('/api/ar-aging/img-ids', async (req, res) => {
    try {
      let arr = [];
      try { arr = JSON.parse(String((req.query || {}).paths || '[]')); } catch (_e) { arr = []; }
      const paths = (Array.isArray(arr) ? arr : []).map(x => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, 400);
      res.json({ ok: true, files: await require('../jobcard/drivefiles').getImageFileIds(paths) });
    } catch (e) {
      res.status(500).json({ ok: false, error: pgMsg(e.message), files: [] });
    }
  });

  /* บันทึกการติดตาม 1 ครั้ง — ‼ ตรวจสิทธิ์รายใบที่เซิร์ฟเวอร์เสมอ (_arCanEdit)
   *   ไม่ได้เชื่อว่าหน้าเว็บซ่อนปุ่มให้แล้ว */
  router.post('/api/ar-aging/follow', async (req, res) => {
    try {
      res.json(await require('./ar-aging').logFollowUp(req.user, req.body || {}));
    } catch (e) {
      res.status(e.userError ? 400 : 500).json({ ok: false, error: pgMsg(e.message) });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🧾 ประวัติการสั่งซื้อของลูกค้า 1 ราย ย้อนหลัง 1 ปี
   *     พี่เอสั่ง 7 ก.ย. 69: "คลิกที่ชื่อบริษัท แล้วแสดงประวัติการ
   *     สั่งซื้อทั้งหมดภายใน 1 ปี ให้เห็นทุกรายการอย่างละเอียด"
   *
   *  🔒 อ่านอย่างเดียว · สิทธิ์คัดที่เซิร์ฟเวอร์ (ใบของเซลส์คนอื่นไม่ออกไป)
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/cust-history', async (req, res) => {
    try {
      const q = req.query || {};
      res.json(await require('./cust-history')
        .custHistory(req.user, { company: q.company, job: q.job, months: q.months }));
    } catch (e) {
      res.status(500).json({ ok: false, msg: pgMsg(e.message), error: pgMsg(e.message) });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🧹 รายชื่อซ้ำ — ยกจากแอปเดิม (Code.gs:6712–6846)
   *
   *  ‼ สิทธิ์ยกมาตามของเดิมเป๊ะ: ดูได้ทุกคน แต่แก้/ลบ/รวม เฉพาะ
   *    CONTACT_ADMINS = admin · Namna (ตัวจริงกันอยู่ในโมดูล)
   *  🔒 ลบ/รวม จดลง contact_gone เพื่อไม่ให้ตัวซิงก์ชีตเอากลับมา
   * ═══════════════════════════════════════════════════════════════ */
  const dupErr = (res, e) => res.status(e.status || (e.userError ? 400 : 500))
    .json({ ok: false, msg: pgMsg(e.message), error: pgMsg(e.message) });

  router.get('/api/dup-contacts', async (req, res) => {
    try { res.json(await require('./contacts-dup').getDupContacts(req.user)); }
    catch (e) { dupErr(res, e); }
  });
  router.post('/api/dup-contacts/save', async (req, res) => {
    try {
      const b = req.body || {};
      res.json(await require('./contacts-dup').saveDupContact(req.user, b.id, b.f));
    } catch (e) { dupErr(res, e); }
  });
  router.post('/api/dup-contacts/delete', async (req, res) => {
    try {
      res.json(await require('./contacts-dup').deleteDupContacts(req.user, (req.body || {}).ids));
    } catch (e) { dupErr(res, e); }
  });
  router.post('/api/dup-contacts/merge', async (req, res) => {
    try {
      const b = req.body || {};
      res.json(await require('./contacts-dup').mergeDupContacts(req.user, b.keepId, b.dropIds));
    } catch (e) { dupErr(res, e); }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🗓️ นัดหมาย / กิจกรรมลูกค้า — ยกจากแอปเดิม (Code.gs:19114–19238)
   *
   *  ‼ สิทธิ์ยกมาตามของเดิมเป๊ะ: ทุกคนที่ล็อกอินใช้ได้ (_auth เฉย ๆ)
   *    แต่ "ลบ / ติ๊กทำแล้ว" ได้เฉพาะรายการของตัวเอง (หรือผู้ดูแล) — กันในโมดูล
   *  🔒 รูปขึ้น Google Drive · ข้อมูลลง Supabase · ไม่เขียนกลับชีตเดิม
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/cust-act/options', (req, res) =>
    res.json(require('./activity').getActivityOptions()));

  router.get('/api/cust-act', async (req, res) => {
    try { res.json(await require('./activity').getActivities(req.user, req.query.company)); }
    catch (e) { dupErr(res, e); }
  });
  router.get('/api/cust-act/calendar', async (req, res) => {
    try { res.json(await require('./activity').getActivityCalendar(req.user, req.query.ym)); }
    catch (e) { dupErr(res, e); }
  });
  router.get('/api/cust-act/customers', async (req, res) => {
    try { res.json({ ok: true, rows: await require('./activity').getCustomerList() }); }
    catch (e) { dupErr(res, e); }
  });
  router.post('/api/cust-act/save', async (req, res) => {
    try { res.json(await require('./activity').saveActivity(req.user, req.body || {})); }
    catch (e) { dupErr(res, e); }
  });
  router.post('/api/cust-act/done', async (req, res) => {
    try {
      const b = req.body || {};
      res.json(await require('./activity').setActivityDone(req.user, b.id, !!b.done));
    } catch (e) { dupErr(res, e); }
  });
  router.post('/api/cust-act/delete', async (req, res) => {
    try { res.json(await require('./activity').deleteActivity(req.user, (req.body || {}).id)); }
    catch (e) { dupErr(res, e); }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🏭 ติดตามงาน Outsource (RFQ) — ยกจากแอปเดิม (Code.gs:19240–19516)
   *
   *  ‼ สิทธิ์ยกมาตามของเดิมเป๊ะ: ดูบอร์ดได้ทุกคน (แย่งกันตามงานได้)
   *    แต่ "แก้ / ลบ / ซิงก์ราคากลับใบงาน" เฉพาะเจ้าของงานหรือผู้ดูแล — กันในโมดูล
   *  🔒 ไฟล์แนบขึ้น Google Drive · ข้อมูลลง Supabase · ไม่เขียนกลับชีตเดิม
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/rfq/options', async (_req, res) => {
    try { res.json(await require('./rfq').getRfqOptions()); }
    catch (e) { dupErr(res, e); }
  });
  router.get('/api/rfq/board', async (req, res) => {
    try {
      const q = req.query || {};
      /* 🔗 รอบ 128 — พี่เอสั่ง "ไม่ต้องให้เซลล์เพิ่มเองแล้ว … ดึงมาจากฐานข้อมูลที่เซลล์คีย์ยอดขาย
       *   ผู้ผลิตที่ไม่ใช่ The101 … มาสร้าง new card outsource" (ปิดการขายตั้งแต่ 1 ม.ค. 69)
       *   ‼ ตัวสร้างการ์ดพัง = บอร์ดยังขึ้นเหมือนเดิม แต่บอกเหตุผลบนจอ (ห้ามเงียบ) */
      const RP = require('./rfqpeak');
      let auto = null;
      try { auto = await RP.ensureAuto(); }
      catch (eA) { auto = { error: String((eA && eA.message) || eA).slice(0, 300) }; }
      /* 📅 รอบ 134 — พี่เอ: "ตั้งต้นให้ดึงข้อมูลย้อนหลัง 3 เดือนพอนะ ส่วนที่เหลือ ให้ user filter ช่วงเวลา เอาเอง
       *   รวมทั้งเลือกชื่อพนักงานขายได้ด้วย"
       *   ไม่ส่ง from มาเลย = ย้อนหลัง 3 เดือน · ส่ง from= (ว่าง) มา = ทุกช่วงเวลา
       *   ‼ ตัวสร้างการ์ดอัตโนมัติยังเก็บตั้งแต่ 1 ม.ค. 69 เหมือนเดิม — เลือกช่วงย้อนไปไกลกว่า 3 เดือนก็ยังเห็น */
      const RQ = require('./rfq');
      const ymdOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '';
      const from = q.from === undefined ? RQ.rfqDefaultFrom() : ymdOk(q.from);
      const to = ymdOk(q.to);
      const R = await RQ.getRfqBoard(req.user,
        { sale: q.sale, outsource: q.outsource, showDone: q.showDone === '1' || q.showDone === 'true', from, to });
      R.range.defaulted = q.from === undefined;
      R.auto = auto;
      /* 🔴 รอบ 130 — พี่เอ: "เคลียร์ data ที่ดึงมาผิดออกจาก list card outsource" ⇒ งานผลิตเองไม่ขึ้นบอร์ด */
      RP.dropInHouse(R);
      /* 🔗 รอบ 128 — เลข QO/IV · ภาพใบงานผลิต · ผลซิงก์ PEAK ล่าสุด (อ่านอย่างเดียว) */
      try { await RP.decorate(R, req.user); }
      catch (eD) { R.peakWarn = 'เติมข้อมูล PEAK/ภาพใบงานไม่ได้ — ' + String((eD && eD.message) || eD).slice(0, 200); }
      res.json(R);
      /* ซิงก์ PEAK ใบที่ยังไม่เคยซิงก์/เก่ากว่า 6 ชม. ต่อท้ายแบบไม่ให้คนรอ (ครั้งละไม่เกิน 8 ใบ) */
      try {
        if (R.peakReady) {
          const ids = RP.staleIds(R, 6 * 3600 * 1000, 8);
          if (ids.length) RP.syncMany(req.user, ids).catch(() => {});
        }
      } catch (eS) { console.log('[rfq] ซิงก์ PEAK ต่อท้ายไม่ได้:', (eS && eS.message) || eS); }
      return;
    } catch (e) { dupErr(res, e); }
  });
  /* 🔗 รอบ 128 — ซิงก์ PEAK (PO · ใบจ่ายมัดจำ DP · EXP) ทีละใบ หรือทั้งบอร์ด · 🔒 GET อย่างเดียว */
  router.post('/api/rfq/peak/sync', async (req, res) => {
    try {
      const b = req.body || {};
      const RP = require('./rfqpeak');
      if (Array.isArray(b.ids)) res.json(await RP.syncMany(req.user, b.ids.map(String).slice(0, 500)));
      else res.json(await RP.syncCard(req.user, b.id));
    } catch (e) { dupErr(res, e); }
  });
  /* ③ "ถ้าไม่มีก็ให้คีย์เองได้" — แอดมิน · บัญชี · เจ้าของงาน คีย์เลข PO แล้วซิงก์ทันที */
  router.post('/api/rfq/peak/po', async (req, res) => {
    try { const b = req.body || {}; res.json(await require('./rfqpeak').savePo(req.user, b.id, b.poNo)); }
    catch (e) { dupErr(res, e); }
  });
  router.get('/api/rfq/summary', async (req, res) => {
    try {
      const q = req.query || {};
      res.json(await require('./rfq').getRfqSummary(req.user,
        { from: q.from, to: q.to, sale: q.sale, outsource: q.outsource }));
    } catch (e) { dupErr(res, e); }
  });
  router.get('/api/rfq/lead', async (req, res) => {
    try { res.json({ ok: true, lead: await require('./rfq').getRfqLeadInfo(req.user, req.query.job) }); }
    catch (e) { dupErr(res, e); }
  });
  router.get('/api/rfq/alert', async (_req, res) => {
    try { res.json({ ok: true, n: await require('./rfq').getRfqAlertCount() }); }
    catch (e) { dupErr(res, e); }
  });
  router.post('/api/rfq/save', async (req, res) => {
    try { res.json(await require('./rfq').saveRfq(req.user, req.body || {})); }
    catch (e) { dupErr(res, e); }
  });
  router.post('/api/rfq/status', async (req, res) => {
    try {
      const b = req.body || {};
      res.json(await require('./rfq').setRfqStatus(req.user, b.id, b.status));
    } catch (e) { dupErr(res, e); }
  });
  router.post('/api/rfq/delete', async (req, res) => {
    try {
      /* 🔗 รอบ 128 — การ์ดอัตโนมัติที่ถูกลบ ต้องไม่ถูกสร้างกลับมาใหม่ */
      const RP = require('./rfqpeak');
      const autoJob = await RP.autoJobOf((req.body || {}).id).catch(() => '');
      const r = await require('./rfq').deleteRfq(req.user, (req.body || {}).id);
      if (r && r.ok && autoJob) await RP.skipAdd(autoJob, req.user);
      res.json(r);
    } catch (e) { dupErr(res, e); }
  });
  router.post('/api/rfq/sync', async (req, res) => {
    try { res.json(await require('./rfq').rfqSyncToLead(req.user, (req.body || {}).id)); }
    catch (e) { dupErr(res, e); }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🏆 ค่าเงินรางวัลพิเศษ — ยกจากแอปเดิม (Code.gs:18076–18345)
   *
   *  ‼ สิทธิ์ยกมาตามของเดิมเป๊ะ (v21.5): เปิดให้ทุกคนเข้าได้
   *    แต่เซิร์ฟเวอร์กรองให้เห็นเฉพาะของตัวเอง — Administrator/Accounting เห็นทุกคน
   *    ‼ ของคนอื่นต้องไม่ถูกส่งไปที่เบราว์เซอร์เลยแม้แต่ตัวเดียว (กรองในโมดูล)
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/comm', async (req, res) => {
    try {
      const q = req.query || {};
      res.json(await require('./reward').commReport(req.user,
        { ym: q.ym, mode: q.mode, biz: q.biz, basis: q.basis }));
    } catch (e) { dupErr(res, e); }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🔄 ตามลูกค้าเก่า Online — ยกจากแอปเดิม (Code.gs:10197–10340)
   *
   *  ‼ สิทธิ์ยกมาตามของเดิมเป๊ะ — พี่เอเขียนกำกับไว้ในโค้ดเดิมว่า
   *    "เห็นได้ทุกคน แย่งกันตามได้" จึงห้ามกรองตามเซลส์เจ้าของ
   *  ‼ บันทึกผลการติดต่อ = ต่อท้ายอย่างเดียว ไม่ทับของเก่า
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/winback', async (req, res) => {
    try {
      const q = req.query || {};
      res.json(await require('./winback').getWinback(req.user, {
        months: q.months, minBuy: q.minBuy, status: q.status, q: q.q,
        sale: q.sale, onlyOpen: q.onlyOpen === '1' || q.onlyOpen === 'true',
      }));
    } catch (e) { dupErr(res, e); }
  });
  router.get('/api/winback/log', async (req, res) => {
    try { res.json(await require('./winback').getWinbackLog(req.user, req.query.key)); }
    catch (e) { dupErr(res, e); }
  });
  router.post('/api/winback/save', async (req, res) => {
    try { res.json(await require('./winback').saveWinbackContact(req.user, req.body || {})); }
    catch (e) { dupErr(res, e); }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🔄 เติม Create By จากรหัสงาน — ยกจากแอปเดิม (Code.gs:5865)
   *  ‼ สิทธิ์ยกมาตามของเดิม: runFillCreatedBy = "เฉพาะผู้ดูแลระบบ (admin)"
   *  ‼ dry = true (ค่าตั้งต้น) แค่คิดให้ดู ยังไม่เขียน — ฐานข้อมูลกดย้อนไม่ได้
   * ═══════════════════════════════════════════════════════════════ */
  router.post('/api/create-by', async (req, res) => {
    if (!isAdmin(req))
      return res.status(403).json({ ok: false,
        msg: 'เฉพาะผู้ดูแลระบบ (admin) เท่านั้นที่อัปเดตได้' +
             (req.user && req.user.username ? ` — คุณเข้าระบบด้วยชื่อ ${req.user.username}` : '') });
    try {
      res.json(await require('./create-by').fillCreatedBy(req.user, { dry: (req.body || {}).dry !== false }));
    } catch (e) { dupErr(res, e); }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🔁 โอนลูกค้าไปเซลส์คนใหม่ — ยกจากแอปเดิม
   *     getTransferInfo · previewTransfer · transferCustomers (Code.gs:4966–5132)
   *
   *  ‼ สิทธิ์ยกมาตามของเดิมเป๊ะ: _requireTransfer
   *    = admin หรือชื่อใน TRANSFER_USERS (admin · Namna · Kunlakarn.c)
   *    ‼ ตัวจริงที่กันอยู่ในโมดูล ไม่ใช่ที่นี่ — หน้าเว็บซ่อนปุ่มไม่นับเป็นการกัน
   *
   *  🔒 เขียนเฉพาะช่องเจ้าของ · ไม่แตะใบที่ปิดการขายแล้ว · ไม่เขียนกลับชีต
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/transfer/info', async (req, res) => {
    try {
      res.json(await require('./transfer').getTransferInfo(req.user));
    } catch (e) {
      res.status(e.status || (e.userError ? 400 : 500))
         .json({ ok: false, msg: pgMsg(e.message), error: pgMsg(e.message) });
    }
  });

  router.get('/api/transfer/preview', async (req, res) => {
    try {
      res.json(await require('./transfer').previewTransfer(req.user, (req.query || {}).from));
    } catch (e) {
      res.status(e.status || (e.userError ? 400 : 500))
         .json({ ok: false, msg: pgMsg(e.message), error: pgMsg(e.message) });
    }
  });

  router.post('/api/transfer', async (req, res) => {
    try {
      res.json(await require('./transfer').transferCustomers(req.user, req.body || {}));
    } catch (e) {
      res.status(e.status || (e.userError ? 400 : 500))
         .json({ ok: false, error: pgMsg(e.message) });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  💵 Cash Flow — เงินเข้าจริงรายเดือน แยกจากยอดขาย
   *     getCashFlowReport (Code.gs:12267)
   *
   *  ‼ สิทธิ์ยกมาตามของเดิมเป๊ะ: _reqAdministrator(_auth(token))
   *    = ผู้ดูแลระบบเท่านั้น · หน้าเว็บเดิมกันชั้นแรกด้วย admrGate('Cash Flow')
   *    หน้านี้เห็นเงินเข้า-ออกทั้งบริษัท อย่าเผลอเปิดกว้างเอง
   *
   *  🔒 อ่านอย่างเดียว ไม่เรียก PEAK สด ไม่เขียนอะไรกลับ
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/cashflow', async (req, res) => {
    if (!isAdmin(req))
      return res.status(403).json({ ok: false,
        msg: '🔒 เมนู "Cash Flow" เปิดให้เฉพาะผู้ดูแลระบบ' +
             (req.user && req.user.username
               ? ` — คุณเข้าระบบด้วยชื่อ ${req.user.username}` +
                 (req.user.permission ? ` · สิทธิ์ ${req.user.permission}` : '')
               : '') });
    try {
      const q = req.query || {};
      /* 🆕 รอบ 38 · ym = เดือนที่เลือกดูอันดับ Top 20 (พี่เอ 18 ก.ย. 69)
       *   "ในแต่ละเดือน (ไม่เอาสะสมทุกเดือนมารวมกันนะ)" ⇒ ต้องเลือกเดือนได้
       *   ไม่ส่งมา = เดือนล่าสุดที่มีความเคลื่อนไหว · พฤติกรรมเดิมทุกอย่างคงเดิม */
      const R = await require('./cashflow').cashFlowReport(req.user,
        { months: q.months, biz: q.biz, from: q.from, to: q.to, ym: q.ym, shift: q.shift });
      /* ⚡ รอบ 74 — "หน้า cash flow โหลดช้ามาก" (พี่เอ 21 ก.ย. 69)
       *   คำตอบก้อนนี้ใหญ่ที่สุดในแอป (วัดจริง ~680 KB ที่รายจ่าย 8,000 ใบ ·
       *   byAcct.raw โตตามจำนวนใบ เพราะการ์ดหมวดกรองวันที่ในเครื่องได้โดยไม่ต้องยิงใหม่)
       *   เซิร์ฟเวอร์นี้ไม่มีตัวบีบอัดกลางเลย ⇒ บีบ gzip เฉพาะเส้นนี้ (~10 เท่า)
       *   ‼ เนื้อหาไม่เปลี่ยนแม้แต่ไบต์เดียว — เบราว์เซอร์คลายให้เองก่อนถึง JSON.parse
       *   ‼ เบราว์เซอร์ไม่รับ gzip ⇒ ส่งแบบเดิม */
      const body = JSON.stringify(R);
      if (body.length < 2048 || !/\bgzip\b/i.test(String(req.headers['accept-encoding'] || '')))
        return res.type('application/json').send(body);
      require('zlib').gzip(body, (err, buf) => {
        if (err) return res.type('application/json').send(body);
        res.set({ 'Content-Type': 'application/json; charset=utf-8',
                  'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
        res.end(buf);
      });
    } catch (e) {
      res.status(500).json({ ok: false, msg: pgMsg(e.message), error: pgMsg(e.message) });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  💸 เงินออก — ตัวดึงเอกสารรายจ่ายจาก PEAK (core/peak-expenses.js)
   *
   *  พี่เอสั่ง 16 ก.ย. 69: "ในส่วนของ Cash flow ยังดึงข้อมูลค่าใช้จ่ายไม่ได้เลยนะ"
   *  ⇒ ชั้นที่ขาดคือ "ตัวดึง" — ตาราง app.peak_expenses มีมาตั้งแต่ sql/22 แล้ว
   *    แต่ไม่เคยมีใครเติมข้อมูลลงไป หน้าจอจึงเห็นเงินออก 0 มาตลอด
   *
   *  ‼ สิทธิ์: ดูสถานะ = คนที่เข้าหน้า Cash Flow ได้ (แอดมิน)
   *    สั่งดึง/หยุด = แอดมินเท่านั้น (กฎเดิม _reqSyncAdmin code.gs:782)
   *  🔒 ทุกเส้นทางนี้ยิง PEAK ด้วย GET เท่านั้น ผ่าน core/peak.js get()
   *     ไม่มี POST/PUT/PATCH/DELETE ไป PEAK แม้แต่เส้นเดียว
   * ═══════════════════════════════════════════════════════════════ */
  const px = require('../../core/peak-expenses');
  const denyCf = (req, res) => res.status(403).json({ ok: false,
    msg: '🔒 เมนู "Cash Flow" เปิดให้เฉพาะผู้ดูแลระบบ' +
         (req.user && req.user.username ? ` — คุณเข้าระบบด้วยชื่อ ${req.user.username}` : '') });

  /** ความคืบหน้า — ‼ ไม่ยิงถาม PEAK เลยสักคำขอ */
  router.get('/api/cashflow/expenses/status', async (req, res) => {
    if (!isAdmin(req)) return denyCf(req, res);
    try { res.json(await px.status()); }
    catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });

  /** เริ่มดึงครั้งแรก / ดึงเพิ่ม — เดินต่อเองบนเซิร์ฟเวอร์ ปิดหน้าจอได้ */
  router.post('/api/cashflow/expenses/start', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    const b = req.body || {};
    try {
      res.json(await px.start({ days: b.days, stopMiss: b.stopMiss, everyMin: b.everyMin }));
    } catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });

  /* 🔁 รอบ 73 — ดึงย้อนหลัง N วันล่าสุดเดี๋ยวนี้ (ปกติระบบทำเองทุกวัน 06:15 น.)
   *  🔒 แอดมินเท่านั้น · GET ล้วนไป PEAK · ไม่ลบอะไรเลย · ห้ามวิ่งซ้อนตัวเดินหลัก
   *  ‼ รอให้จบแล้วตอบ (≤ 9 นาที) — ปิดหน้าจอได้ งานวิ่งต่อบนเซิร์ฟเวอร์ */
  router.post('/api/cashflow/expenses/recent', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    const b = req.body || {};
    try {
      res.json(await px.recent({ days: b.days, force: 1,
        by: (req.user && req.user.username) || 'admin' }));
    } catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });

  router.post('/api/cashflow/expenses/stop', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    try { res.json(await px.stop()); }
    catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });

  /** เดิน 1 รอบเดี๋ยวนี้ (ปกติตัวจับเวลาทำให้เอง) — งบเวลาสั้นกว่า จะได้ไม่ค้างหน้าเว็บ */
  router.post('/api/cashflow/expenses/run', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    const b = req.body || {};
    try {
      /* ‼ reprobe = ไล่ลอง "ขอเป็นรายการ" ใหม่ทุกท่า ไม่ใช้ท่าที่จำไว้
       *   มีไว้เพื่อวันที่ PEAK เปิดสิทธิ์ให้แล้ว — จะได้เลิกเดินไล่เลขเอกสารทันที
       *   โดยไม่ต้องแก้โค้ดหรือรอดีพลอยใหม่ */
      res.json(await px.walk({ restart: b.restart ? 1 : 0, days: b.days,
        stopMiss: b.stopMiss, biz: clean(b.biz), reprobe: b.reprobe ? 1 : 0,
        cap: Number(b.cap) || 0,
        budgetMs: Math.max(3000, Math.min(50000, Number(b.budgetMs) || 25000)) }));
    } catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🔑 "สอนรูปแบบเลขเอกสาร" — พี่เอป้อนเลขจริงจาก PEAK มา 1 ใบ
   *
   *  พี่เอสั่ง 16 ก.ย. 69: "จัดการแก้ไข เรื่อง Cash flow รายรับ รายจ่าย ให้ได้ 100%
   *    ตามเอกสารของ peak ที่จ่ายออกไปจริงด้วย แก้ให้จบนะ"
   *  🔴 กิจการ "มดงานการป้าย" ยิงถาม PEAK สำเร็จ 28 ครั้งแต่ได้ 0 ใบ ⇒ เราถามชื่อใบผิด
   *    พี่เอเปิด PEAK อ่านเลขจริงได้ทันที เราเดาเองไม่ได้ ⇒ ให้คนบอก เครื่องถอดเอง
   *  🔒 GET ล้วนเหมือนทุกเส้นทางฝั่งนี้ (ยืนยันเลขใบนั้นกับ PEAK ด้วย code=)
   * ═══════════════════════════════════════════════════════════════ */
  router.post('/api/cashflow/expenses/learn', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    const b = req.body || {};
    try {
      res.json(await px.learn({ biz: clean(b.biz), sample: clean(b.sample),
        date: clean(b.date), save: b.save === 0 ? 0 : 1,
        verify: b.verify === 0 ? 0 : 1 }));
    } catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🔎 รอบ 68 — "ลองดึงแบบรายการอีกครั้ง" (ปุ่มเดียว พิสูจน์บนเครื่องจริง)
   *  พี่เอ: "Peak เค้าเปิดให้ api มาแล้วอยู่ที่เราดึงได้หรือเปล่านะ"
   *  เป็น POST เพราะ "สั่งงานที่ยิง PEAK จริง" (~20–25 คำขอ/บริษัท) และจำท่าที่ชนะลงฐาน
   *  🔒 GET ล้วนไปที่ PEAK ผ่าน ask() → rateGate · ไม่เขียนรายจ่ายลงตารางเลย · ไม่ลบอะไร
   *  🔒 ส่งกลับแค่ "ชื่อช่อง" ของแถวแรก ไม่ส่งค่าข้อมูล · ผ่าน peak.redactDeep
   * ═══════════════════════════════════════════════════════════════ */
  router.post('/api/cashflow/expenses/probe', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    const b = req.body || {};
    try { res.json(await px.probeList({ biz: clean(b.biz) })); }
    catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🎯 รอบ 67 — "ไล่เก็บใบที่ข้าม" (ยิงเฉพาะเลขที่สำมะโนบอกว่าขาด)
   *  🔴 GET  = ดูแผนอย่างเดียว (กี่คำขอ · กี่นาที) — **ไม่ยิง PEAK แม้แต่คำขอเดียว**
   *  🔴 POST = ยิงจริง **เฉพาะเมื่อ confirm = 1** ที่พี่เอกดยืนยันบนจอเท่านั้น
   *  🔒 รายการเลขคิดใหม่ที่เซิร์ฟเวอร์จากตารางจริงเสมอ — ไม่รับรายการเลขจากหน้าเว็บ
   *    (กันไม่ให้ใครส่งเลขมั่ว ๆ มาให้ยิงไปที่ PEAK)
   *  🔒 เขียนอย่างเดียว ไม่ลบอะไรเลย · GET ล้วนผ่าน ask() + เบรก rateGate เดิม
   * ═══════════════════════════════════════════════════════════════ */
  const refetchPlan = async () => {
    const rows = await px.allRows();
    const C = px.census(rows || []);
    return (C.plan && C.plan.refs) || [];
  };
  router.get('/api/cashflow/expenses/refetch', async (req, res) => {
    if (!isAdmin(req)) return denyCf(req, res);
    try { res.json(await px.refetch({ refs: await refetchPlan(), confirm: 0 })); }
    catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });
  router.post('/api/cashflow/expenses/refetch', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    const b = req.body || {};
    try {
      res.json(await px.refetch({ refs: await refetchPlan(),
                                  confirm: String(b.confirm) === '1' ? 1 : 0 }));
    } catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });

  /* ⚖️ กระทบยอดกับ PEAK — 🔴 ห้ามขึ้น "ครบ 100%" ถ้า proven ไม่เป็น true */
  router.post('/api/cashflow/expenses/reconcile', async (req, res) => {
    if (!isAdmin(req)) return denyCf(req, res);
    const b = req.body || {};
    try {
      res.json(await px.reconcile({ biz: clean(b.biz), from: clean(b.from),
        to: clean(b.to), paste: String(b.paste || '').slice(0, 400000) }));
    } catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });
  router.get('/api/cashflow/expenses/reconcile', async (req, res) => {
    if (!isAdmin(req)) return denyCf(req, res);
    const q = req.query || {};
    try { res.json(await px.reconcile({ biz: clean(q.biz), from: clean(q.from), to: clean(q.to) })); }
    catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  💵 ฝั่งรายรับ — "รับแล้วแต่ไม่รู้วันที่" ติดอะไร และ PEAK มีวันที่ให้ไหม
   *  🔒 อ่านอย่างเดียว (probe = GET /Receipts ตามเลขบิล ผ่าน core/peak.js)
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/cashflow/income/nodate', async (req, res) => {
    if (!isAdmin(req)) return denyCf(req, res);
    const q = req.query || {};
    try {
      res.json(await require('./cashflow').noDateReport(req.user,
        { biz: clean(q.biz), probe: q.probe ? 1 : 0, sample: q.sample }));
    } catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });

  /** 🔬 ดูฟิลด์ดิบ — ระบบไม่เดาชื่อฟิลด์ แต่บอกว่า PEAK ส่งช่องอะไรมาบ้าง */
  router.get('/api/cashflow/expenses/peek', async (req, res) => {
    if (!isAdmin(req)) return denyCf(req, res);
    try { res.json(await px.peek(clean((req.query || {}).biz))); }
    catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });

  /** สุ่มตรวจกับ PEAK สด ๆ ทีละใบ — ยืนยันว่าตัวเลขในฐานตรงกับ PEAK ตอนนี้ */
  router.get('/api/cashflow/expenses/audit', async (req, res) => {
    if (!isAdmin(req)) return denyCf(req, res);
    const q = req.query || {};
    try { res.json(await px.audit(clean(q.biz), q.sample)); }
    catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  📒 รอบ 233 — "ลองถาม PEAK ตามรหัสผังบัญชี" (core/peak-ledger.js)
   *  พี่เอ 4 ต.ค. 69: "management report เรายังดึงค่าใช้จ่ายมาไม่หมดนะ พี่เพิ่งรู้ว่า เค้าไม่ได้คีย์ใน
   *    EXP 100% มันจะมีคีย์ไปที่รหัสผังบัญชีโดยตรง ส่วนนี้ไปเอามาได้มั้ย"
   *    "ทำเลย แล้วให้มันเป็นข้อมูลชุดเดียวกันกับ เมนูงาน Cash flow ด้วยนะ"
   *  probe = ถาม PEAK 4 เส้นตามเอกสาร (ผังบัญชี · งบทดลอง · บัญชีแยกประเภท · สมุดรายวัน)
   *          แล้วกางโครงคำตอบให้เห็น — **ยังไม่นำไปคิดในรายงาน** (รู้รูปคำตอบจริงก่อน ไม่เดาชื่อช่อง)
   *          เป็น POST เพราะ "สั่งงานที่ยิง PEAK จริง" (~7 คำขอ/กิจการ) และจดสรุปผลลง app.peak_state
   *  last  = ผลครั้งล่าสุด (ไม่ยิง PEAK) — Management Report อ่านตัวเดียวกันนี้
   *  🔒 GET ล้วนไปที่ PEAK · ไม่เขียนตารางข้อมูล · ไม่ลบอะไร · ผู้ดูแลระบบเท่านั้น
   *     ยามอยู่ใน tools/test-peak-ledger.js
   * ═══════════════════════════════════════════════════════════════ */
  router.post('/api/cashflow/ledger/probe', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    const b = req.body || {};
    try {
      res.json(await require('../../core/peak-ledger').probe({ biz: clean(b.biz), month: clean(b.month),
        acct: clean(b.acct), by: (req.user && req.user.username) || 'admin' }));
    } catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });
  router.get('/api/cashflow/ledger/last', async (req, res) => {
    if (!isAdmin(req)) return denyCf(req, res);
    try { res.json(await require('../../core/peak-ledger').last()); }
    catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  💵 รอบ 235 — Cash Flow ใหม่ (สมุดเงินสดจาก PEAK · modules/sales/cashbook.js + core/peak-cashbook.js)
   *  พี่เอ 4 ต.ค. 69: "เดี๋ยวรื้อ code cash flow ใหม่หมดเลยนะ เขียนขึ้นมาใหม่ ทำให้ดูง่าย เห็นสรุปภาพรวม
   *                    เจาะลงรายละเอียดได้ ไม่ใช่มาอะไรเยอะแยะไปหมดแบบนี้ไม่ดู เสียเวลา"
   *                   "พี่ต้องการเห็นยอดเงินในบัญชี ทุกบัญชี ที่เข้าและออกด้วยนะ"
   *
   *  GET  /api/cashbook         หน้าแรก + เดือนที่เลือก (อ่านจากฐาน ไม่ยิง PEAK)
   *  GET  /api/cashbook/docs    เอกสารของหมวด/ของบัญชี (ชั้นล่างสุด)
   *  GET  /api/cashbook/ar      ลูกหนี้คงค้าง + คาดว่าจะเข้า (ตัวคิดลูกหนี้เดิม — เรียกแยก หน้าแรกไม่ต้องรอ)
   *  GET  /api/cashbook/status  ความคืบหน้าของตัวดึงเบื้องหลัง
   *  POST /api/cashbook/sync    สั่งดึงจาก PEAK เดี๋ยวนี้ (GET ล้วนไปที่ PEAK · เขียนเฉพาะตารางสมุดเงินสดของเรา)
   *  🔒 สิทธิ์ = ผู้ดูแลระบบ เท่ากับเมนู Cash Flow เดิมทุกเส้น · PEAK อ่านอย่างเดียว
   * ═══════════════════════════════════════════════════════════════ */
  const cbook = require('./cashbook');
  const cbCore = require('../../core/peak-cashbook');
  const cbTry = fn => async (req, res) => {
    if (!isAdmin(req)) return denyCf(req, res);
    try { res.json(await fn(req)); }
    catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message), msg: pgMsg(e.message) }); }
  };
  router.get('/api/cashbook', cbTry(req => cbook.overview(req.user, req.query || {})));
  router.get('/api/cashbook/docs', cbTry(req => cbook.docs(req.user, req.query || {})));
  router.get('/api/cashbook/ar', cbTry(req => cbook.arSummary(req.user, req.query || {})));
  router.get('/api/cashbook/status', cbTry(() => cbCore.status()));
  router.post('/api/cashbook/sync', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    const b = req.body || {};
    const only = {};
    if (clean(b.biz)) only.biz = clean(b.biz);
    if (cbCore.ymOk(clean(b.ym))) only.ym = clean(b.ym);
    const opt = { only: (only.biz || only.ym) ? only : null, force: !!b.force };
    try {
      /* wait=1 = รอจนรอบนี้จบ (ยาม/ปุ่มที่อยากเห็นผลทันที) · ไม่ส่ง = สั่งแล้วกลับเลย หน้าจอถามสถานะเอา */
      if (String(b.wait) === '1') return res.json(await cbCore.tick(opt));
      cbCore.tick(opt).catch(e => ctx.warn('ดึงสมุดเงินสดจาก PEAK ไม่สำเร็จ:', e.message));
      res.json({ ok: true, started: true });
    } catch (e) { res.status(500).json({ ok: false, error: pgMsg(e.message) }); }
  });
  /* ตัวดึงเบื้องหลัง — เปิดเองบนเครื่องจริง (ดูเงื่อนไขใน core/peak-cashbook.js start()) */
  try { cbCore.start(); } catch (e) { ctx.warn('เปิดตัวดึงสมุดเงินสดไม่ได้:', e.message); }

  /* ประวัติการติดตามของใบงานหนึ่ง */
  router.get('/api/ar-aging/history', async (req, res) => {
    try {
      res.json({ ok: true, rows: await require('./ar-aging')
        .getFollowUps(req.user, (req.query || {}).job) });
    } catch (e) {
      res.status(500).json({ ok: false, error: pgMsg(e.message), rows: [] });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  📊 รายงานยอดขาย Online — ยกจากแอปเดิม
   *     getOnlineReport (Code.gs:4381)
   *
   *  ‼ สิทธิ์ยกมาตามของเดิมเป๊ะ: _auth(token) เฉย ๆ
   *    = ทุกคนที่เข้าระบบได้ ดูได้ (ของเดิมไม่ได้กันเมนูนี้ไว้)
   *    อย่าเผลอเติม isAdmin เข้าไปเอง — นั่นคือเปลี่ยนกติกาให้พี่เอโดยไม่ได้สั่ง
   *
   *  🔒 อ่านอย่างเดียว ไม่เรียก PEAK สด ไม่เขียนอะไรกลับ
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/online-report', async (req, res) => {
    try {
      const q = req.query || {};
      res.json(await require('./online-report').onlineReport(q.from, q.to));
    } catch (e) {
      res.status(500).json({ ok: false, cnt: 0, msg: pgMsg(e.message), error: pgMsg(e.message) });
    }
  });

  router.get('/api/peak/gap', async (_req, res) => {
    try {
      const groups = await db.select('v_peak_gap', { select: '*', limit: 50 });
      const gap = (groups || []).reduce((a, g) => a + Number(g['จำนวน'] || 0), 0);
      res.json({ ok: true, gap, groups: groups || [], calls: 0,
        advice: gap ? `ยังเหลือ ${gap.toLocaleString()} ใบที่ควรมีตัวเลขจาก PEAK แล้วแต่ยังไม่มี — ` +
                      'กด "กวาดใหม่ทุกใบ 100%" แล้วกลับมาตรวจซ้ำ'
                    : '✅ ไม่เหลือใบไหนหลุดเลย' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /** ตัดแถวที่ไม่ใช่ปิดการขาย — ‼ ไม่ยิงถาม PEAK เลยสักคำขอ */
  router.post('/api/peak/clear-nonclosed', async (req, res) => {
    if (!isAdmin(req)) return denyAdmin(res);
    try { res.json(await pa.clearNonClosed()); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /** แถวที่วางลิงก์ PEAK ไว้ในช่องเลขเอกสาร — เข้าคิวไม่ได้เพราะอ่านเลขไม่ออก */
  router.get('/api/peak/urlrows', async (_req, res) => {
    try {
      const rows = await db.select('v_peak_url_rows', { select: '*', limit: 50 });
      res.json({ ok: true, n: (rows || []).length, rows: rows || [] });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /** ประวัติการซิงก์รายรอบ */
  router.get('/api/peak/rounds', async (_req, res) => {
    try {
      res.json({ ok: true,
        rounds: await db.select('peak_round', { select: '*', order: 'at.desc', limit: 40 }) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /**
   * ‼ ตรวจว่า "บันทึกลงที่ไหน และจะติดจริงไหม" (พี่เอสั่ง 5 ก.ย. 69)
   *   ทดลองเขียนจริงลงช่องว่างท้ายหัวตาราง แล้วลบคืน — ไม่แตะข้อมูลของใคร
   */
  /* ═══════════════════════════════════════════════════════════════
   *  🔑 v25 · สิทธิ์ของคนที่ล็อกอิน "เท่าที่หน้าเว็บต้องรู้"
   *
   *  หน้าเว็บต้องรู้แค่ 2 อย่าง: เห็นของทุกคนไหม · แก้รหัสงานได้ไหม
   *  ‼ ส่งไปแค่ "คำตอบ" ไม่ส่ง "รายชื่อ" — รายชื่อผู้มีสิทธิ์ไม่ควรรั่วออกหน้าเว็บ
   *  ‼ นี่แค่ทำให้ปุ่ม/ช่องขึ้นถูก ไม่ใช่ระบบความปลอดภัย
   *    ตัวจริงที่กันคือ save.js planJobRename() ซึ่งตรวจซ้ำทุกครั้งที่บันทึก
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/perm', (req, res) => res.json({
    ok: true,
    seeAll:      SEE.canSeeAllSales(req.user),
    editJobCode: SEE.canEditJobCode(req.user),
  }));

  router.get('/api/save/doctor', async (_req, res) => {
    try { res.json({ ok: true, ...(await save.doctor()) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🔤 ตั้งค่าคำนำหน้ารหัสงานของพนักงานขาย
   *
   *  พี่เอสั่ง 6 ก.ย. 69:
   *    "ช่วยเพิ่มการตั้งค่ารหัสงานของพนักงานขายแต่ละคนให้ด้วยนะ
   *     เช่น มีพนักงานใหม่ จะตั้งค่า Prefix ว่าอะไร
   *     และให้ app ทำการสร้างรหัสงานตามเงื่อนไขที่กำหนดและ running ไปเรื่อยๆ"
   *    "คนที่ตั้งค่า prefix ได้มีแค่ user : admin , namna เท่านั้น"
   *
   *  ‼ ด่านนี้เข้มกว่าที่อื่น — เจาะจง "ชื่อผู้ใช้" ไม่ใช่แค่สิทธิ์ Administrator
   *    ตามที่พี่เอสั่งคำต่อคำ · ใครได้สิทธิ์แอดมินทีหลังก็ยังตั้งไม่ได้
   *
   *  ‼ ทำไมต้องหวงขนาดนี้: คำนำหน้าคือตัวชี้ "เจ้าของงาน" ของใบเก่าทั้งหมด
   *    (app.sales_nick เดาเจ้าของจากคำนำหน้าเวลาช่อง Create By ว่าง)
   *    ตั้งมั่ว = ยอดรายคนเพี้ยนย้อนหลังทั้งระบบ และรหัสงานอาจชนกัน
   * ═══════════════════════════════════════════════════════════════ */
  const PREFIX_ADMINS = ['admin', 'namna'];
  const canPrefix = req =>
    PREFIX_ADMINS.includes(clean(req.user && req.user.username).toLowerCase());
  const denyPrefix = res => res.status(403).json({ ok: false,
    error: '🔒 ตั้งค่าคำนำหน้ารหัสงานได้เฉพาะ admin และ Namna เท่านั้น' });

  /** รายชื่อคำนำหน้าทั้งหมด + เลขที่วิ่งถึงของเดือนนี้ + รายชื่อพนักงานให้เลือก */
  router.get('/api/prefix', async (req, res) => {
    try {
      const [rows, users] = await Promise.all([
        db.rpc('sales_prefix_list', {}),
        db.rpc('sales_user_list', {}).catch(() => []),
      ]);
      res.json({ ok: true, canEdit: canPrefix(req), rows: rows || [], users: users || [] });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** เพิ่ม / แก้ไข 1 รายการ */
  router.post('/api/prefix/save', async (req, res) => {
    if (!canPrefix(req)) return denyPrefix(res);
    const b = req.body || {};
    try {
      /* ‼ พี่เอสั่ง 6 ก.ย. 69:
       *   "ช่องอื่น อ้างอิงข้อมูลมาจากระบบที่ user ใช้ login มาเลย"
       *
       *  ชื่อเล่นต้องอ่านจาก "ทะเบียนผู้ใช้" ที่เดียว ไม่รับจากฟอร์ม
       *  เพราะถ้ารับมา แล้วใครพิมพ์ต่างจากในระบบล็อกอินแม้แต่ตัวเดียว
       *  รูปพนักงาน · อันดับ · ยอดรายคน จะจับคู่ไม่เจอทันที
       *  (หน้าเว็บส่งมาก็ไม่เชื่อ — ของจริงต้องมาจากฐานข้อมูล) */
      const un = clean(b.username);
      const users = (await db.rpc('sales_user_list', {}).catch(() => [])) || [];
      const u = users.find(x => clean(x.username).toLowerCase() === un.toLowerCase());
      if (!u) {
        return res.status(400).json({ ok: false,
          error: `ไม่พบผู้ใช้ "${un}" ในระบบ — ต้องเลือกจากรายชื่อที่มีอยู่จริงเท่านั้น` });
      }
      const r = await db.rpc('sales_prefix_save', {
        p_prefix: clean(b.prefix), p_username: clean(u.username),
        p_nickname: clean(u.nickname), p_sep: clean(b.sep) || '/',
        p_active: b.active !== false, p_note: clean(b.note) || null,
        p_by: clean(req.user && req.user.username),
      });
      try { await ctx.audit(req.user, 'prefix_save', { target: clean(b.prefix) }); } catch {}
      res.json({ ok: true, ...(Array.isArray(r) ? r[0] : r) });
    } catch (e) {
      /* ‼ ข้อความจาก PostgreSQL ห่อมาใน JSON — แกะให้เหลือประโยคที่คนอ่านรู้เรื่อง */
      res.status(400).json({ ok: false, error: pgMsg(e.message) });
    }
  });

  /** ลบ — ทำได้เฉพาะตัวที่ยังไม่เคยออกรหัสเลย (ตัว SQL เป็นคนกัน) */
  router.post('/api/prefix/delete', async (req, res) => {
    if (!canPrefix(req)) return denyPrefix(res);
    try {
      const r = await db.rpc('sales_prefix_delete', { p_prefix: clean((req.body || {}).prefix) });
      try { await ctx.audit(req.user, 'prefix_delete', { target: clean((req.body || {}).prefix) }); } catch {}
      res.json({ ok: true, ...(Array.isArray(r) ? r[0] : r) });
    } catch (e) {
      res.status(400).json({ ok: false, error: pgMsg(e.message) });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   *  🗑️ ลบรายการขาย — ถอดจาก deleteRecord() code.gs:4799
   *
   *  ‼ พี่เอสั่ง 6 ก.ย. 69:
   *    "ให้เพิ่มการลบข้อมูลได้ด้วยนะ โดยเจ้าของงาน (เซลล์) กับ user
   *     ที่เป็น admin, Namna เท่านั้นที่ลบได้"
   *
   *  ‼ ตรวจสิทธิ์ที่ "เซิร์ฟเวอร์" เสมอ ห้ามเชื่อว่าหน้าเว็บซ่อนปุ่มแล้วจะปลอดภัย
   *    ปุ่มที่ซ่อนไว้ยิงตรงเข้ามาได้ใน 10 วินาที — ข้อมูลขายลบแล้วไม่มีถังขยะ
   *
   *  🔑 ยึด "รหัสงาน" เป็นหลักเหมือนตอนแก้ไข (คำสั่งพี่เอวันเดียวกัน)
   *    เลขแถวเลื่อนได้ตลอด ลบผิดแถว = ลบใบคนอื่นทิ้งถาวร
   * ═══════════════════════════════════════════════════════════════ */
  router.post('/api/delete', async (req, res) => {
    try {
      const r = await save.deleteRecord(req.user, req.body || {});
      try { await ctx.audit(req.user, 'sales_delete', { target: r.code }); } catch {}
      res.json(r);
    } catch (e) {
      res.status(e.userError ? 400 : 500).json({ ok: false, error: e.message });
    }
  });

  /** บันทึกรายการ (เพิ่มใหม่ / แก้ไข) — ลงชีตก่อน แล้วตามลง Supabase */
  /* ═══════════════════════════════════════════════════════════════
   *  🔢 v1.8 · "ใบถัดไปจะได้เลขอะไร" — บอกก่อนกดบันทึก
   *
   *  🔴 พี่เอ 16 ก.ย. 69: "เลขกระโดดข้าม 045 เป็น 046 ทำไมมันไม่นับ
   *     จากเลขที่มากที่สุด" ⇒ ต้องมองเห็นได้ว่าเลขถัดไปคืออะไร
   *     และถ้าระบบต้องข้ามเลข ต้องบอกว่าเพราะใครถืออยู่ ห้ามข้ามเงียบ ๆ
   *
   *  ‼ อ่านอย่างเดียว — ไม่จองเลข ไม่เขียนทะเบียน
   *    เปิดหน้าจอทิ้งไว้ 10 คนก็เห็นเลขเดียวกัน แล้วใครกดบันทึกก่อนได้ก่อน
   *    (เลขจริงออกตอนกดบันทึกเท่านั้น — app.next_job_code_ex)
   *  ‼ คำนำหน้ารหัสเป็นของ "คนที่ล็อกอินอยู่" เสมอ ไม่รับจาก query
   *    ⇒ ดูเลขของคนอื่นไม่ได้ และปลอมคำนำหน้าไม่ได้
   * ═══════════════════════════════════════════════════════════════ */
  router.get('/api/jobcode/next', async (req, res) => {
    try {
      const pfx = await save.prefixOf(clean(req.user && req.user.username));
      const r = await db.rpc('job_code_preview', { p_prefix: pfx, p_sep: '/' });
      /* ‼ คืน jsonb ก้อนเดียว — รับทั้งแบบห่ออาร์เรย์ / ห่อชื่อฟังก์ชัน / เป็นข้อความ */
      let v = Array.isArray(r) ? r[0] : r;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
      if (v && typeof v === 'object' && v.job_code_preview !== undefined) v = v.job_code_preview;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
      if (!v || !v.code) {
        /* ครบ 999 ใบแล้วก็บอกตรง ๆ ไม่ใช่ตอบช่องว่างเฉย ๆ */
        return res.json({ ok: true, code: '', prefix: pfx,
                          note: (v && v.error) || '' });
      }
      const skipped = Array.isArray(v.skipped) ? v.skipped : [];
      res.json({
        ok: true,
        prefix: pfx,
        code: v.code,
        head: v.head,
        no: v.no,
        /* เลขมากสุดที่ "ใช้อยู่จริง" ตอนนี้ — ตัวที่ระบบนับต่อจาก */
        highWater: v.high_water,
        seqNo: v.seq_no,
        skipped,
        /* ═══════════════════════════════════════════════════════════
         *  🔴 v1.8.1 · "เลขมากสุดมาจากไหน" — พี่เอสั่งรอบ 2 (16 ก.ย. 69)
         *    ต้องตอบได้ว่าทำไมเลขถัดไปถึงเป็นเลขนี้ ไม่ใช่บอกแค่เลขเฉย ๆ
         *    why.source = 'ใบจริงใน total_sales'
         *              | 'ทะเบียน (มีใบ/เอกสารถืออยู่)'
         *              | 'เพิ่งแจกยังไม่บันทึก (ในช่วงคุ้มครอง N นาที)'
         *              | 'ไม่พบหลักฐานเลย (ยามกันถอยหลังจะทำงาน — ไม่ถอยกลับ 001)'
         *    ‼ ฐานที่ยังไม่ได้รัน sql/77 จะไม่มีก้อนนี้ ⇒ ส่ง null ไป ไม่ใช่ทำหน้าจอพัง */
        why: (v.why && typeof v.why === 'object') ? v.why : null,
        from: (v.why && typeof v.why === 'object') ? clean(v.why.source) : '',
        graceMin: (v.grace_minutes === undefined || v.grace_minutes === null)
                  ? null : Number(v.grace_minutes),
        note: skipped.length
          ? 'ข้ามเลข ' + skipped.map(s => clean(s.code) + ' (' + clean(s.reason) + ')').join(' · ')
          : '',
      });
    } catch (e) {
      /* ยังไม่ได้รัน sql/75 = ไม่มีฟังก์ชันนี้ ⇒ ไม่ใช่เรื่องต้องทำให้หน้าจอพัง */
      res.json({ ok: false, code: '', error: e.message });
    }
  });

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

  /* ═══════════════════════════════════════════════════════════════
   *  🧧 แคมเปญ "สลิปรวยไม่อั้น" — เมนูงานในแอปนี้ ไม่ใช่แอปแยก
   *
   *  พี่เอสั่ง 6 ก.ย. 69:
   *    "สลิปรวยไม่อั้น ย้ายไปอยู่ที่ เมนูงาน ใน apps คีย์ยอดขายสิ
   *     แล้วดึงข้อมูลจาก app คีย์ยอดขายมาเลย"
   *
   *  ‼ อลิซเคยทำผิดเป็นแอปแยกในหน้ารวมแอป — ถอดออกแล้ว
   *    ในแอปเดิมมันคือแผงที่เปิดทับหน้าจอจากปุ่มเมนูงาน (campOv)
   *    และใช้ข้อมูลชุดเดียวกับตารางขาย ไม่ได้มีฐานข้อมูลของตัวเอง
   * ═══════════════════════════════════════════════════════════════ */
  await require('./campaign-api').mount(router, ctx);

  /* 🤝 รอบ 222 · Lead จาก Affiliate — หน้าตั้งค่า/สถานะ (เฉพาะแอดมิน) · เมนูงาน → Lead จาก Affiliate
   *   ตัวรับ webhook อยู่ที่ server.js (นอกด่านล็อกอิน) · ตรรกะอยู่ที่ affiliate.js */
  await require('./affiliate-api').mount(router, ctx);
}

/** แถวในตาราง Contacts → การ์ดที่ฟอร์มใช้ (ถอดจาก _ctCard() code.gs:4908)
 *
 *  ‼ dir = ทะเบียนชื่อพนักงานขาย (core/sale-name.js) — ส่งมาได้ ไม่ส่งก็ได้
 *    ไม่ส่ง = ไม่แปลงชื่อ คืนค่าดิบเหมือนเดิมเป๊ะ (ของเดิมที่เรียกอยู่ไม่พัง) */
function ctCard(r, dir) {
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
    /* 🔴 ช่อง "พนักงานขาย" ของลูกค้า — ข้อมูลเก่าคีย์ไว้เป็นชื่อเล่นเปล่า ๆ ("น้ำ")
     *   ต้องแสดงเป็น "(น้ำ) จุฬารัตน์ เรืองโชติ" ให้ตรงกับตัวกรอง
     *   ‼ แปลงตอนแสดงผลเท่านั้น — ค่าในตาราง contacts ไม่ถูกแตะแม้แต่ตัวเดียว
     *   ‼ แปลงไม่ได้ (ไม่มีในทะเบียน / ชื่อเล่นซ้ำ 2 คน) → คืนค่าดิบ ห้ามเดา */
    owner:      dir ? SN.resolve(dir, r['Create By']) : clean(r['Create By']),
    ownerRaw:   clean(r['Create By']),
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
