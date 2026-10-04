'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/sales/affiliate.js — สร้าง / อัปเดต lead ใน "คีย์ยอดขาย" อัตโนมัติ
 *  จากตาราง public.leads ของฐาน Supabase "มดงานการป้าย Affiliate"   (รอบ 222)
 *
 *  🗣 พี่เอสั่ง 3 ต.ค. 69 คำต่อคำ:
 *    "ตอนนี้พี่ได้ถูกเชิญให้เข้าไปเป็น admin ของ database : affiliate ใน supabase
 *     พี่ต้องการดึงข้อมูล เข้ามาสร้าง leads ใน app คีย์ยอดขาย แบบ auto
 *     ทันทีที่มีรายการใหม่ หรือมีการแก้ไขจาก database ก้อนนี้"
 *
 *  ── คำตอบพี่เอ 3 ต.ค. 69 = กติกาของไฟล์นี้ ──────────────────────────
 *   ① เจ้าของ lead   = "ตามเซลส์ที่รับ lead ใน Affiliate" · ยังไม่มีคนรับ = บัญชีกลาง
 *   ② ช่องทาง        = ลูกค้ามาจากไหน "พาร์ทเนอร์" · ชื่อช่อง / Platform "Affiliate"
 *                      บริษัทที่ขาย "มดงานการป้าย"
 *   ③ ถูกแก้ซ้ำ       = "อัปเดตเฉพาะช่องที่เซลส์ยังไม่แตะ"
 *                      ช่องเงิน · ปิดการขาย · PEAK ไม่แตะเลย
 *
 *  ── ทางเข้า 2 ทาง (ใช้ตัวประมวลผลตัวเดียวกัน = applyLead) ────────────
 *   ⚡ ทันที    : ฐาน Affiliate ยิง webhook เข้ามา (modules/sales/affiliate-hook.js)
 *   🔁 เก็บตก  : ระบบเราไปอ่านฐาน Affiliate ทุก 1 นาที (pollOnce) — อ่านอย่างเดียว
 *   ทั้งสองทางซ้ำกันได้ไม่เป็นไร: 1 lead ของ Affiliate = 1 ใบในคีย์ยอดขายเสมอ
 *   (ตาราง app.affiliate_lead_link · lead_id เป็น primary key)
 *
 *  🔴 ไม่เขียนกลับฐาน Affiliate แม้แต่ช่องเดียว (affiliate-src.js มีแต่คำขออ่าน)
 *  🔴 ไม่แตะ PEAK · ไม่แตะช่องเงิน · ไม่ลบใบขาย
 *  🔴 ใบที่ "ปิดการขาย" แล้ว = ไม่แก้ตามอะไรทั้งนั้น
 * ═══════════════════════════════════════════════════════════════════ */
const db = require('../../core/db');
const TH = require('../../core/thai-date');
const SRC = require('./affiliate-src');
const SAVE = require('./save');          /* prefixOf · nextRowNo — ของเดิม ไม่เขียนซ้ำ */

const clean = s => String(s == null ? '' : s).trim();
const nowISO = () => new Date().toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const T_LINK = 'affiliate_lead_link';
const T_SALES = 'total_sales';
const KEY_CFG = 'affiliate_sync';
const KEY_STATE = 'affiliate_sync_state';
const SQL_FILE = 'sql/110-affiliate-leads.sql';

/* ─── กติกาตายตัว (คำตอบพี่เอ ②) — เปลี่ยนต้องมีคำสั่งใหม่ ─────────── */
const RULE = Object.freeze({
  biz: 'มดงานการป้าย',
  source: 'พาร์ทเนอร์',
  platform: 'Affiliate',
  custType: 'ลูกค้าใหม่',
});

/* ─── สถานะของ Affiliate → Lead Status ของคีย์ยอดขาย ───────────────
 *  enum lead_status ของฐาน Affiliate (ดูจากฐานจริง 3 ต.ค. 69):
 *    draft · รอติดต่อ · ติดต่อแล้ว · กำลังประเมินราคา · ส่งช่างวัดหน้างาน
 *    มัดจำแล้ว · ชำระมัดจำ · งานเสร็จสิ้น · ไม่ปิดการขาย · สแปม
 *  ‼ ไม่มีสถานะไหนถูกแปลงเป็น "ปิดการขาย" — การปิดการขายมีเรื่องเงิน/วันที่ปิด/PEAK
 *    เซลส์ต้องปิดเองในคีย์ยอดขาย (คำตอบพี่เอ ③ "ปิดการขาย ไม่แตะเลย")              */
const SKIP_NEW = new Set(['draft', 'สแปม']);      /* ยังไม่สร้างใบ */
const LOST = new Set(['ไม่ปิดการขาย', 'สแปม']);
const leadStatusOf = st => (LOST.has(clean(st)) ? 'ไม่ซื้อ' : 'Onprocess');

/* ─── ช่องที่ตัวนี้ "เขียน" ลง total_sales ─────────────────────────────
 *  FIELD_COLS = ข้อมูลของ lead · OWNER_COLS = เจ้าของ (ตัดสินเป็นชุดเดียว 3 ช่อง)
 *  🔴 ห้ามมีช่องเงิน · วันที่ปิดการขาย · ช่อง PEAK ในสองรายการนี้ (ยามคุมไว้)   */
const FIELD_COLS = ['วันที่ติดต่อ', 'ชื่อผู้ติดต่อ', 'ชื่อบริษัท', 'เบอร์ติดต่อ', 'ประเภทลูกค้า',
  'ลูกค้ามาจากไหน', 'ชื่อช่อง / Platform', 'Lead Status', 'หมายเหตุ', 'บริษัทที่ขาย'];
const OWNER_COLS = ['Sales Code', 'Sales Name', 'Create By'];
const DATE_COLS = new Set(['วันที่ติดต่อ']);

/** ช่องของ lead ที่อ่านจากฐาน Affiliate — เท่าที่ใช้จริง
 *  ‼ ไม่ดึงไฟล์ใบเสร็จ · ยอดมัดจำ · ยอดขาย · LINE userId ของลูกค้า */
const LEAD_COLS = ['id', 'order_id', 'affiliate_id', 'ref_code', 'source', 'status',
  'customer_name', 'phone', 'line_display_name', 'sign_type', 'location', 'budget', 'notes',
  'entered_at', 'updated_at', 'claimed_by', 'claimed_by_line_user_id', 'claimed_by_uid'];

const DEFAULTS = Object.freeze({
  enabled: true,
  poolUser: 'admin',     /* บัญชีกลาง — lead ที่ยังไม่มีคนรับ / คนรับยังไม่ได้จับคู่ */
  jobPrefix: 'AFF',      /* คำนำหน้ารหัสงานของ lead จาก Affiliate · ว่าง = ใช้คำนำหน้าของเจ้าของ */
  claimers: {},          /* คนรับ lead ใน Affiliate → ชื่อผู้ใช้ในระบบเรา */
});

/* ═══════════════════ ตั้งค่า + สถานะ (app.settings) ═══════════════════ */
function mergeConfig(v) {
  const o = (v && typeof v === 'object') ? v : {};
  const out = { enabled: o.enabled === undefined ? DEFAULTS.enabled : !!o.enabled,
    poolUser: clean(o.poolUser).slice(0, 80) || DEFAULTS.poolUser,
    jobPrefix: DEFAULTS.jobPrefix, claimers: {} };
  if (o.jobPrefix !== undefined) {
    const p = clean(o.jobPrefix).toUpperCase();
    /* ‼ หน้าตาเดียวกับคำนำหน้าของ jobcode-format.js: ตัวอักษรนำ ตามด้วยอักษร/ตัวเลข ≤ 6 ตัว */
    out.jobPrefix = p === '' ? '' : (/^[A-Z][A-Z0-9]{0,5}$/.test(p) ? p : DEFAULTS.jobPrefix);
  }
  const c = (o.claimers && typeof o.claimers === 'object') ? o.claimers : {};
  for (const [k, u] of Object.entries(c)) {
    const kk = clean(k).slice(0, 120), uu = clean(u).slice(0, 80);
    if (/^(line|uid|name):.+/.test(kk) && uu) out.claimers[kk] = uu;
  }
  return out;
}
let _cfg = null, _cfgAt = 0;
async function loadConfig(force) {
  if (!force && _cfg && Date.now() - _cfgAt < 30000) return _cfg;
  let v = null;
  try { const r = await db.one('settings', { key: 'eq.' + KEY_CFG, select: 'value' }); v = r && r.value; }
  catch (e) { /* อ่านไม่ได้ = ใช้ค่าเริ่มต้น ไม่ล้มทั้งงาน */ }
  _cfg = mergeConfig(v); _cfgAt = Date.now();
  return _cfg;
}
async function saveConfig(input, username) {
  const cfg = mergeConfig(input);
  await db.upsert('settings', [{ key: KEY_CFG, value: cfg, updated_at: nowISO(),
    updated_by: clean(username) }], 'key');
  _cfg = cfg; _cfgAt = Date.now();
  return cfg;
}
async function loadState() {
  try { const r = await db.one('settings', { key: 'eq.' + KEY_STATE, select: 'value' });
        return (r && r.value && typeof r.value === 'object') ? r.value : {}; }
  catch (e) { return {}; }
}
const saveState = st => db.upsert('settings',
  [{ key: KEY_STATE, value: st, updated_at: nowISO(), updated_by: 'affiliate-sync' }], 'key');

/* ═══════════════════ ทะเบียนผู้ใช้ + รายชื่อพาร์ทเนอร์ ═══════════════════ */
let _users = null, _usersAt = 0;
async function users(force) {
  if (!force && _users && Date.now() - _usersAt < 60000) return _users;
  const rows = await db.select('app_users',
    { select: '"Username","Name","Nickname","Permission"', limit: 2000 });
  _users = (rows || []).map(r => ({ username: clean(r.Username), name: clean(r.Name),
    nickname: clean(r.Nickname), permission: clean(r.Permission) })).filter(u => u.username);
  _usersAt = Date.now();
  return _users;
}
/** ‼ เทียบชื่อผู้ใช้แบบ "ตรงทั้งสตริง ไม่สนตัวพิมพ์" เท่านั้น — ห้าม includes / ilike ที่มี * */
async function userOf(username) {
  const want = clean(username).toLowerCase();
  if (!want) return null;
  return (await users()).find(u => u.username.toLowerCase() === want) || null;
}

let _dir = new Map(), _dirAt = 0;
/** ชื่อพาร์ทเนอร์ (affiliate) — อ่านจาก affiliate_sales_directory (id · name · ref_code เท่านั้น) */
async function affiliateName(id) {
  const key = clean(id).toLowerCase();
  if (!key || !SRC.configured()) return '';
  if (Date.now() - _dirAt > 10 * 60000) {
    _dirAt = Date.now();
    try {
      const rows = await SRC.read('affiliate_sales_directory', { select: 'id,name,ref_code', limit: 1000 });
      const m = new Map();
      for (const r of rows) m.set(clean(r.id).toLowerCase(), clean(r.name));
      _dir = m;
    } catch (e) { console.warn('[affiliate] อ่านรายชื่อพาร์ทเนอร์ไม่ได้:', SRC.safeMsg(e)); }
  }
  return _dir.get(key) || '';
}

/* ═══════════════════ แปลง lead → ค่าที่จะลง total_sales ═══════════════════ */
/** คนที่รับ lead ในระบบ Affiliate → กุญแจที่ใช้จับคู่กับชื่อผู้ใช้ของเรา (ลองตามลำดับ) */
function claimerOf(rec) {
  const line = clean(rec && rec.claimed_by_line_user_id);
  const uid = clean(rec && rec.claimed_by_uid).toLowerCase();
  const nm = clean(rec && rec.claimed_by);
  const keys = [];
  if (line) keys.push('line:' + line);
  if (uid) keys.push('uid:' + uid);
  if (nm) keys.push('name:' + nm.toLowerCase());
  if (!keys.length) return null;
  return { key: keys[0], keys, label: nm || (line ? 'LINE ' + line.slice(0, 8) + '…' : 'ผู้ใช้ ' + uid.slice(0, 8) + '…') };
}

async function ownerOf(rec, cfg) {
  const c = claimerOf(rec);
  let un = '';
  if (c) for (const k of c.keys) if (cfg.claimers[k]) { un = cfg.claimers[k]; break; }
  const mapped = !!un;
  if (!un) un = cfg.poolUser;
  let u = await userOf(un);
  /* ชื่อที่จับคู่ไว้ถูกลบออกจากทะเบียนผู้ใช้ไปแล้ว ⇒ ถอยไปบัญชีกลาง (ไม่ปล่อยใบไร้เจ้าของ) */
  if (!u && mapped) { un = cfg.poolUser; u = await userOf(un); }
  return {
    username: u ? u.username : un,
    name: u ? u.name : '',
    /* ‼ ค่าเดียวกับที่ saveRecord ใส่ช่อง Create By ตอนเซลส์คีย์เอง (save.js: who) */
    who: u ? (u.nickname || u.name || u.username) : un,
    mapped: mapped && !!u, pool: !(mapped && !!u), claimer: c,
  };
}

const SRC_LABEL = { web_form: 'เว็บฟอร์ม', line_liff: 'LINE', manual: 'คีย์มือ' };

/** หมายเหตุบรรทัดเดียว (ช่องหมายเหตุของฟอร์มเป็นช่องบรรทัดเดียว) */
function noteOf(rec, affName) {
  const p = [];
  const ref = clean(rec.ref_code);
  p.push('[Affiliate]' + (affName ? ' พาร์ทเนอร์ ' + affName : '') + (ref ? ' (ref ' + ref + ')' : ''));
  if (clean(rec.sign_type)) p.push('ป้าย: ' + clean(rec.sign_type));
  if (clean(rec.location)) p.push('สถานที่: ' + clean(rec.location));
  const b = Number(rec.budget);
  if (rec.budget != null && rec.budget !== '' && Number.isFinite(b) && b > 0)
    p.push('งบลูกค้า ' + b.toLocaleString('en-US') + ' บาท');
  if (clean(rec.line_display_name)) p.push('LINE: ' + clean(rec.line_display_name));
  if (clean(rec.source)) p.push('ที่มา: ' + (SRC_LABEL[clean(rec.source)] || clean(rec.source)));
  if (clean(rec.status)) p.push('สถานะ Affiliate: ' + clean(rec.status));
  if (clean(rec.order_id)) p.push('Order: ' + clean(rec.order_id));
  if (clean(rec.notes)) p.push('หมายเหตุ: ' + clean(rec.notes).replace(/\s+/g, ' '));
  return p.join(' · ').slice(0, 1500);
}

/** lead 1 แถวของ Affiliate → { ชื่อคอลัมน์: ค่า } ที่จะลง total_sales */
function mapLead(rec, owner, affName) {
  const name = clean(rec.customer_name) || clean(rec.line_display_name);
  const at = clean(rec.entered_at) || clean(rec.updated_at);
  const t = at ? new Date(at) : new Date();
  return {
    /* ‼ วันที่ติดต่อห้ามว่าง — ตาราง Sale กรองตามวันที่ติดต่อ (save.js hiddenReasons) */
    'วันที่ติดต่อ': TH.todayTH(Number.isFinite(t.getTime()) ? t : new Date()),
    'ชื่อผู้ติดต่อ': name,
    /* lead จากฟอร์มไม่มีช่องบริษัท ⇒ ใช้ชื่อลูกค้าไปก่อน (ฟอร์มคีย์ยอดขายบังคับช่องนี้) เซลส์แก้ได้ */
    'ชื่อบริษัท': name,
    'เบอร์ติดต่อ': clean(rec.phone),
    'ประเภทลูกค้า': RULE.custType,
    'ลูกค้ามาจากไหน': RULE.source,
    'ชื่อช่อง / Platform': RULE.platform,
    'Lead Status': leadStatusOf(rec.status),
    'หมายเหตุ': noteOf(rec, affName),
    'บริษัทที่ขาย': RULE.biz,
    'Sales Code': owner.username,
    'Sales Name': owner.name,
    'Create By': owner.who,
  };
}

const norm = (col, v) => {
  const s = clean(v);
  return DATE_COLS.has(col) ? s.slice(0, 10) : s;
};
const sameTs = (a, b) => {
  const x = Date.parse(clean(a)), y = Date.parse(clean(b));
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
};
/** สำเนาของ lead ที่เก็บไว้ในตารางจับคู่ — ใช้คิดใหม่ตอนเปลี่ยนการจับคู่คนรับ */
function snap(rec, affName) {
  const o = {};
  for (const c of LEAD_COLS) o[c] = rec[c] === undefined ? null : rec[c];
  if (affName) o._aff_name = affName;
  return o;
}

/** ลายนิ้วมือของ lead (เฉพาะช่องที่ใช้) — ไว้ดูว่า "เนื้อหาเหมือนที่ทำไปแล้วไหม" */
function fingerprint(rec) {
  if (!rec || typeof rec !== 'object') return '';
  return LEAD_COLS.map(c => {
    const v = rec[c];
    if (v == null) return '';
    if (c === 'entered_at' || c === 'updated_at') { const t = Date.parse(v); return Number.isFinite(t) ? String(t) : String(v); }
    if (c === 'budget') return String(Number(v));
    return String(v);
  }).join('\u0001');
}

/* ═══════════════════ ตารางจับคู่ ═══════════════════ */
const getLink = id => db.one(T_LINK, { lead_id: 'eq.' + id, select: '*' });
const putLink = (id, patch) =>
  db.update(T_LINK, { lead_id: 'eq.' + id }, { ...patch, updated_at: nowISO() });
const isDup = e => /23505|duplicate key/i.test(String((e && (e.body || e.message)) || ''));
const isNoTable = e => /PGRST205|42P01|could not find the table|does not exist/i
  .test(String((e && (e.body || e.message)) || '')) && /affiliate_lead_link/i
  .test(String((e && (e.body || e.message)) || ''));

/* ═══════════════════ ออกรหัสงาน — ท่าเดียวกับ saveRecord ═══════════════════ */
async function issueJobCode(prefix, by) {
  let code = '';
  try {
    const r = await db.rpc('next_job_code_ex', { p_prefix: prefix, p_module: 'sales', p_issued_by: by });
    let v = Array.isArray(r) ? r[0] : r;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
    if (v && typeof v === 'object' && v.next_job_code_ex !== undefined) v = v.next_job_code_ex;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
    code = clean(v && typeof v === 'object' ? v.code : '');
  } catch (e) { console.warn('[affiliate] next_job_code_ex ใช้ไม่ได้ ถอยไปตัวเดิม:', e.message); }
  if (!code) {
    let r = await db.rpc('next_job_code', { p_prefix: prefix, p_module: 'sales', p_issued_by: by });
    r = Array.isArray(r) ? r[0] : r;
    if (r && typeof r === 'object') r = r.next_job_code;
    code = clean(r);
  }
  if (!code) throw new Error('ออกรหัสงานไม่ได้ (คำนำหน้า ' + prefix + ')');
  return code;
}

async function logActivity(action, jobCode, want) {
  try {
    await db.insert('activity_log', [{
      _row: await db.nextRow('activity_log'),
      Time: nowISO(), Username: 'affiliate', Nickname: 'Affiliate (อัตโนมัติ)',
      Action: action, 'รหัสงาน': jobCode,
      Company: clean(want['ชื่อบริษัท']), Contact: clean(want['ชื่อผู้ติดต่อ']), Phone: clean(want['เบอร์ติดต่อ']),
    }]);
  } catch (e) { /* จดประวัติไม่ได้ ไม่ใช่เหตุให้งานหลักล้ม */ }
}

/* ═══════════════════ สร้างใบใหม่ ═══════════════════ */
async function createRow(rec, link, cfg, via, affName) {
  const id = clean(rec.id).toLowerCase();
  const owner = await ownerOf(rec, cfg);
  const want = mapLead(rec, owner, affName);
  const base = { src_status: clean(rec.status), src_updated_at: clean(rec.updated_at) || null,
    src: snap(rec, affName), via,
    claimer_key: owner.claimer ? owner.claimer.key : null,
    claimer_label: owner.claimer ? owner.claimer.label : null, owner: owner.username };

  /* ① จองก่อนเสมอ — lead_id เป็น primary key ⇒ สองทางเข้ายิงพร้อมกันก็ได้ใบเดียว */
  if (!link) {
    try { await db.insert(T_LINK, [{ lead_id: id, state: 'creating', ...base }]); }
    catch (e) {
      if (!isDup(e)) throw e;
      const other = await getLink(id);
      if (other && other.state === 'linked') return updateRow(rec, other, cfg, via, affName);
      return { action: 'busy' };
    }
    link = { lead_id: id, state: 'creating' };
  } else {
    await putLink(id, { state: 'creating', reason: null, ...base });
  }

  /* ② รหัสงาน — ถ้ารอบก่อนล้มกลางทาง (จองรหัสไว้แล้ว) ใช้รหัสเดิม และดูว่าใบถูกเขียนไปแล้วหรือยัง */
  let jobCode = clean(link.job_code), issuedHere = false, rowNo = 0, createdAt = '', written = false;
  if (jobCode) {
    const hit = await db.select(T_SALES,
      { 'รหัสงาน': 'eq.' + jobCode, select: '_row,"รหัสงาน","Created At"', limit: 2 });
    if (Array.isArray(hit) && hit.length === 1) { rowNo = Number(hit[0]._row); createdAt = clean(hit[0]['Created At']); written = true; }
  }
  try {
    if (!jobCode) {
      const prefix = cfg.jobPrefix || await SAVE.prefixOf(owner.username);
      jobCode = await issueJobCode(prefix, 'affiliate');
      issuedHere = true;
      await putLink(id, { job_code: jobCode });
    }
    if (!written) {
      createdAt = nowISO();
      const row = { ...want, 'รหัสงาน': jobCode, 'เลขสลิป': jobCode,
        'Created At': createdAt, 'Updated At': createdAt, 'วันที่อัพเดต': TH.todayTH(), _synced_at: createdAt };
      for (const c of Object.keys(row)) if (row[c] === '') row[c] = null;
      /* เลขแถวชน (สองคนบันทึกพร้อมกัน) ⇒ ขอเลขใหม่แล้วเขียนซ้ำ ≤ 6 ครั้ง — กติกาเดียวกับ saveRecord รอบ 77 */
      for (let tryN = 1; ; tryN++) {
        rowNo = await SAVE.nextRowNo();
        try { await db.insert(T_SALES, [{ _row: rowNo, ...row }]); written = true; break; }
        catch (e) {
          const m = String((e && (e.body || e.message)) || e);
          if (!(/23505/.test(m) && /total_sales_row_uk|_row/.test(m)) || tryN >= 6) throw e;
          await new Promise(r => setTimeout(r, 30 + Math.floor(Math.random() * 120)));
        }
      }
      /* ตรวจกลับ — ไม่เชื่อว่า "ไม่ error = สำเร็จ" (บทเรียนเดียวกับ saveRecord) */
      const back = await db.one(T_SALES, { _row: 'eq.' + rowNo, select: '_row,"รหัสงาน"' });
      if (!back || clean(back['รหัสงาน']) !== jobCode)
        throw new Error('เขียนใบขายแล้วอ่านกลับไม่ตรง (แถว ' + rowNo + ')');
    }
  } catch (e) {
    if (issuedHere && !written) {
      try { await db.rpc('release_job_code', { p_code: jobCode, p_by: 'affiliate',
        p_note: 'สร้าง lead จาก Affiliate ไม่สำเร็จ — คืนเลขที่เพิ่งแจก' }); } catch (e2) { /* คืนไม่ได้ก็ไม่ซ้ำเติม */ }
      await putLink(id, { job_code: null, state: 'error', reason: clean(e.message).slice(0, 300) }).catch(() => {});
    } else {
      await putLink(id, { state: 'error', reason: clean(e.message).slice(0, 300) }).catch(() => {});
    }
    throw e;
  }

  const applied = {};
  for (const c of FIELD_COLS.concat(OWNER_COLS)) applied[c] = want[c];
  await putLink(id, { state: 'linked', sales_row: rowNo, job_code: jobCode, row_created_at: createdAt,
    applied, kept: [], reason: null, ...base });
  await logActivity('เพิ่ม (Affiliate)', jobCode, want);
  return { action: 'created', jobCode, row: rowNo, owner: owner.username, pool: owner.pool };
}

/* ═══════════════════ หาใบเดิม + อัปเดตเฉพาะช่องที่เซลส์ยังไม่แตะ ═══════════════════ */
const ROW_SEL = ['_row', 'รหัสงาน', 'Created At'].concat(FIELD_COLS, OWNER_COLS)
  .map(c => (/^[A-Za-z0-9_]+$/.test(c) ? c : '"' + c + '"')).join(',');

async function locateRow(link) {
  const n = Number(link.sales_row);
  if (n > 0) {
    const r = await db.one(T_SALES, { _row: 'eq.' + n, select: ROW_SEL });
    if (r && (sameTs(r['Created At'], link.row_created_at) ||
              (clean(link.job_code) && clean(r['รหัสงาน']).toUpperCase() === clean(link.job_code).toUpperCase())))
      return r;
  }
  if (clean(link.job_code)) {
    const rows = await db.select(T_SALES, { 'รหัสงาน': 'eq.' + clean(link.job_code), select: ROW_SEL, limit: 2 });
    if (Array.isArray(rows) && rows.length === 1) return rows[0];
  }
  return null;
}

async function updateRow(rec, link, cfg, via, affName) {
  const id = clean(rec.id).toLowerCase();
  const row = await locateRow(link);
  const owner = await ownerOf(rec, cfg);
  const base = { src_status: clean(rec.status), src_updated_at: clean(rec.updated_at) || null,
    src: snap(rec, affName),
    claimer_key: owner.claimer ? owner.claimer.key : null,
    claimer_label: owner.claimer ? owner.claimer.label : null };
  if (via !== 'remap') base.via = via;      /* คิดเจ้าของใหม่ ไม่ใช่ "ทางเข้า" ของ lead — คงของเดิมไว้ */
  if (!row) {
    /* 🔴 ใบถูกลบในคีย์ยอดขายไปแล้ว = คนลบตั้งใจ ⇒ ห้ามสร้างกลับ */
    await putLink(id, { state: 'gone', reason: 'ใบนี้ถูกลบในคีย์ยอดขายแล้ว — ไม่สร้างใหม่', ...base });
    return { action: 'gone' };
  }
  const want = mapLead(rec, owner, affName);
  const was = (link.applied && typeof link.applied === 'object') ? link.applied : {};
  const applied = { ...was };
  const set = {}, kept = [];

  if (clean(row['Lead Status']) === 'ปิดการขาย') {
    /* 🔴 ปิดการขายแล้ว = ไม่แก้ตามอะไรทั้งนั้น (คำตอบพี่เอ ③) */
    kept.push('ปิดการขายแล้ว — ไม่แก้ตาม');
  } else {
    for (const c of FIELD_COLS) {
      const cur = norm(c, row[c]), old = norm(c, was[c]), nw = norm(c, want[c]);
      if (cur === nw) { applied[c] = want[c]; continue; }          /* ตรงกันอยู่แล้ว */
      if (cur !== old) { kept.push(c); continue; }                 /* เซลส์แก้เองแล้ว ⇒ ไม่ทับ */
      set[c] = want[c]; applied[c] = want[c];
    }
    /* เจ้าของ 3 ช่องตัดสินเป็นชุดเดียว — มีคนโอนงาน/แก้ช่องใดช่องหนึ่งแล้ว = ไม่ทับทั้งชุด */
    const curO = OWNER_COLS.map(c => norm(c, row[c])).join('\u0001');
    const oldO = OWNER_COLS.map(c => norm(c, was[c])).join('\u0001');
    const newO = OWNER_COLS.map(c => norm(c, want[c])).join('\u0001');
    if (curO === newO) OWNER_COLS.forEach(c => { applied[c] = want[c]; });
    else if (curO !== oldO) kept.push('เจ้าของงาน');
    else OWNER_COLS.forEach(c => { set[c] = want[c]; applied[c] = want[c]; });
  }

  const changed = Object.keys(set);
  if (changed.length) {
    const body = { ...set, 'วันที่อัพเดต': TH.todayTH(), 'Updated At': nowISO(), _synced_at: nowISO() };
    for (const c of Object.keys(body)) if (body[c] === '') body[c] = null;
    const r = await db.update(T_SALES, { _row: 'eq.' + Number(row._row) }, body);
    if (!Array.isArray(r) || !r.length) throw new Error('ไม่มีแถว ' + row._row + ' ให้แก้ในฐานข้อมูล');
    await logActivity('แก้ไข (Affiliate)', clean(row['รหัสงาน']), { ...want });
  }
  await putLink(id, { state: 'linked', sales_row: Number(row._row), job_code: clean(row['รหัสงาน']),
    applied, kept, reason: null, owner: clean(set['Sales Code'] !== undefined ? set['Sales Code'] : row['Sales Code']),
    ...base });
  return { action: changed.length ? 'updated' : 'same', changed, kept,
    jobCode: clean(row['รหัสงาน']), row: Number(row._row) };
}

/* ═══════════════════ ตัวประมวลผล 1 lead (ทุกทางเข้าใช้ตัวนี้) ═══════════════════ */
async function applyLead(rec, via, opt) {
  const id = clean(rec && rec.id).toLowerCase();
  if (!UUID.test(id)) return { action: 'bad', reason: 'ไม่มี id ของ lead' };
  const cfg = await loadConfig();
  if (!cfg.enabled) return { action: 'paused' };
  const force = !!(opt && opt.force);

  let link = await getLink(id);
  const at = clean(rec.updated_at);
  if (link && link.src_updated_at && at && !force) {
    const a = Date.parse(at), b = Date.parse(link.src_updated_at);
    /* ข้อมูลเก่ากว่าที่ทำไปแล้ว (webhook มาถึงช้ากว่าตัวเก็บตก) ⇒ ทิ้ง */
    if (Number.isFinite(a) && Number.isFinite(b)) {
      if (a < b) return { action: 'stale' };
      /* ‼ เวลาแก้ไขเท่ากันไม่ได้แปลว่าเนื้อหาเท่ากัน — ฐาน Affiliate ตั้ง updated_at = เวลาเริ่มธุรกรรม
       *   เพิ่มแล้วแก้ต่อในธุรกรรมเดียวกัน = สองเหตุการณ์ เวลาเดียวกันเป๊ะ ⇒ ต้องเทียบเนื้อหาด้วย */
      if (a === b && fingerprint(rec) === fingerprint(link.src) &&
          (link.state === 'linked' || link.state === 'skipped' || link.state === 'gone'))
        return { action: 'same', jobCode: clean(link.job_code) };
    }
  }
  let affName = await affiliateName(rec.affiliate_id);
  if (!affName && link && link.src && clean(link.src._aff_name)) affName = clean(link.src._aff_name);

  const status = clean(rec.status);
  const created = link && Number(link.sales_row) > 0;
  if (!created) {
    if (link && link.state === 'creating' && !force &&
        Date.now() - Date.parse(link.updated_at || 0) < 90000) return { action: 'busy' };
    if (SKIP_NEW.has(status)) {
      const reason = status === 'draft' ? 'lead ยังเป็นฉบับร่าง (draft) — รอให้กรอกเสร็จก่อน'
                                        : 'lead ถูกทำเครื่องหมายสแปมตั้งแต่ก่อนเข้าระบบ';
      const body = { state: 'skipped', reason, src_status: status, src_updated_at: at || null,
        src: snap(rec, affName), via };
      if (link) await putLink(id, body);
      else { try { await db.insert(T_LINK, [{ lead_id: id, ...body }]); }
             catch (e) { if (!isDup(e)) throw e; } }
      return { action: 'skipped', reason };
    }
    return createRow(rec, link, cfg, via, affName);
  }
  if (link.state === 'gone' && !force) {
    await putLink(id, { src_status: status, src_updated_at: at || null, src: snap(rec, affName), via });
    return { action: 'gone' };
  }
  return updateRow(rec, link, cfg, via, affName);
}

/* ‼ ทำทีละใบเสมอ — webhook กับตัวเก็บตกเข้าพร้อมกันจะได้ไม่แย่งเลขแถว/สร้างซ้ำ */
let _chain = Promise.resolve();
const _mem = { hookAt: null, hookN: 0, pollAt: null, pollOkAt: null, pollErr: null, pollErrAt: null,
  made: 0, updated: 0, startedAt: nowISO() };
function ingest(rec, via, opt) {
  const p = _chain.then(() => applyLead(rec, via, opt)).then(r => {
    if (r && r.action === 'created') _mem.made++;
    if (r && r.action === 'updated') _mem.updated++;
    if (r && !(opt && opt.force)) remember(rec, r.action);
    return r;
  });
  _chain = p.catch(() => {});
  return p;
}
function noteHook() { _mem.hookAt = nowISO(); _mem.hookN++; }

/** lead ถูกลบในฐาน Affiliate — ไม่ลบใบขาย (ห้ามลบ) แค่จดไว้ */
async function markSourceDeleted(leadId) {
  const id = clean(leadId).toLowerCase();
  if (!UUID.test(id)) return { action: 'bad' };
  const link = await getLink(id);
  if (!link) return { action: 'none' };
  await putLink(id, { reason: 'lead นี้ถูกลบในฐาน Affiliate แล้ว (ใบขายยังอยู่ ไม่ได้ลบตาม)', via: 'webhook' });
  return { action: 'noted' };
}

/* ═══════════════════ 🔁 ตัวเก็บตก ═══════════════════ */
const PAGE = 200;
const SEL = LEAD_COLS.join(',');
let _polling = false;
const _fail = new Map();
/* ใบที่ทำไปแล้วในรอบการทำงานนี้ (id → ลายนิ้วมือ) — อ่านย้อนทับมาเจอใบเดิม เนื้อหาเดิม = ข้ามโดยไม่ถามฐาน */
const _done = new Map();
const DONE_ACTIONS = new Set(['created', 'updated', 'same', 'skipped', 'gone', 'stale']);
function remember(rec, action) {
  if (!rec || !DONE_ACTIONS.has(action)) return;
  if (_done.size > 5000) _done.clear();
  _done.set(clean(rec.id).toLowerCase(), fingerprint(rec));
}
/* ‼ ทำไมต้องอ่านย้อนทับ: updated_at ของฐาน Affiliate = เวลา "เริ่ม" ธุรกรรม ไม่ใช่เวลาบันทึกเสร็จ
 *   ธุรกรรมที่เริ่มก่อนแต่เสร็จทีหลัง จะมีเวลาแก้ไข "เก่ากว่า" ตัวชี้ที่ขยับไปแล้ว ⇒ ถ้าอ่านต่อจากตัวชี้เป๊ะ ๆ ใบนั้นหลุดถาวร
 *   ⇒ ทุกรอบอ่านย้อนกลับไป 2 นาที (แต่ไม่ย้อนเกินจุดเริ่มเก็บ) ใบที่ทำไปแล้วถูกข้ามด้วย _done */
const OVERLAP_MS = 120000;
function overlapStart(cursor, since) {
  const c = Date.parse(cursor), s0 = Date.parse(since || '');
  if (!Number.isFinite(c)) return cursor;
  const back = c - OVERLAP_MS;
  if (Number.isFinite(s0) && back <= s0) return c <= s0 ? cursor : since;
  return new Date(back).toISOString();
}

async function drain(fromCursor, via, maxPages) {
  let cursor = fromCursor, seen = 0, made = 0, updated = 0, failed = null, skipped = 0, full = false;
  const later = (a, b) => (Date.parse(a) > Date.parse(b) ? a : b);
  for (let page = 0; page < maxPages; page++) {
    const rows = await SRC.read('leads', { select: SEL, updated_at: 'gt.' + cursor,
      order: 'updated_at.asc,id.asc', limit: PAGE });
    if (!rows.length) break;
    const batch = rows.slice();
    if (rows.length === PAGE) {
      /* หน้าตัดกลางกลุ่มที่เวลาแก้ไขเท่ากันพอดี ⇒ ดึงทั้งกลุ่มนั้นมาให้ครบ ไม่งั้นตกหล่น */
      const lastTs = rows[rows.length - 1].updated_at;
      const tail = await SRC.read('leads', { select: SEL, updated_at: 'eq.' + lastTs, order: 'id.asc', limit: 1000 });
      const has = new Set(rows.map(r => r.id));
      for (const t of tail) if (!has.has(t.id)) batch.push(t);
    }
    for (const r of batch) {
      if (_done.get(clean(r.id).toLowerCase()) === fingerprint(r)) { skipped++; cursor = later(r.updated_at, cursor); continue; }
      try {
        const out = await ingest(r, via);
        seen++; if (out.action === 'created') made++; if (out.action === 'updated') updated++;
        _fail.delete(r.id);
        if (out.action !== 'busy' && out.action !== 'paused') cursor = later(r.updated_at, cursor);
      } catch (e) {
        const n = (_fail.get(r.id) || 0) + 1; _fail.set(r.id, n);
        failed = { id: r.id, msg: clean(e.message).slice(0, 300), tries: n };
        if (n >= 5) { cursor = later(r.updated_at, cursor); _fail.delete(r.id); continue; }   /* ติดซ้ำ 5 รอบ ⇒ ข้ามไปก่อน (จดไว้ในตารางจับคู่แล้ว) */
        return { cursor, seen, made, updated, failed, skipped, full };
      }
    }
    if (rows.length < PAGE) break;
    if (page === maxPages - 1) full = true;       /* ยังไม่หมด — รอบหน้าอ่านต่อจากตัวชี้เป๊ะ ๆ (ไม่ย้อนทับ กันวนที่เดิม) */
  }
  return { cursor, seen, made, updated, failed, skipped, full };
}

async function pollOnce() {
  if (_polling) return { busy: true };
  _polling = true;
  _mem.pollAt = nowISO();
  try {
    if (!SRC.configured()) return { off: 'no-key' };
    const cfg = await loadConfig(true);
    if (!cfg.enabled) return { off: 'paused' };
    const st = await loadState();
    if (!st.cursor) {
      /* ครั้งแรก = เริ่มนับจากตอนนี้ ("รายการใหม่ หรือมีการแก้ไข") — ของเก่าดึงด้วยปุ่ม "ดึงย้อนหลัง" */
      st.cursor = nowISO(); st.since = st.cursor;
      await saveState(st);
      _mem.pollOkAt = nowISO(); _mem.pollErr = null;
      return { started: st.cursor };
    }
    const from = st.noOverlap ? st.cursor : overlapStart(st.cursor, st.since);
    const r = await drain(from, 'poll', 10);
    r.cursor = (Date.parse(r.cursor) > Date.parse(st.cursor)) ? r.cursor : st.cursor;     /* ตัวชี้ไม่ถอยหลัง */
    const hadErr = !!st.lastError;
    if (r.cursor !== st.cursor || (r.failed ? r.failed.msg : null) !== (st.lastError || null) ||
        hadErr !== !!r.failed || !!st.noOverlap !== !!r.full) {
      st.cursor = r.cursor;
      st.noOverlap = !!r.full;
      st.lastError = r.failed ? r.failed.msg : null;
      st.lastErrorAt = r.failed ? nowISO() : (st.lastErrorAt || null);
      st.lastChangeAt = nowISO();
      await saveState(st);
    }
    _mem.pollOkAt = nowISO(); _mem.pollErr = r.failed ? r.failed.msg : null;
    if (r.failed) _mem.pollErrAt = nowISO();
    return r;
  } catch (e) {
    _mem.pollErr = SRC.safeMsg(e); _mem.pollErrAt = nowISO();
    return { error: _mem.pollErr };
  } finally { _polling = false; }
}

/** ดึงย้อนหลังทั้งหมด (กดเองจากหน้าตั้งค่า) — ไม่ขยับตัวชี้ของตัวเก็บตก */
async function backfill() {
  if (!SRC.configured()) throw new Error('ยังไม่ได้ตั้ง AFFILIATE_SUPABASE_URL / AFFILIATE_SUPABASE_KEY ใน Railway');
  return drain('1970-01-01T00:00:00Z', 'backfill', 50);
}

/** คิดเจ้าของใหม่ให้ใบที่จับคู่ไว้แล้ว — เรียกหลังแก้การจับคู่คนรับ / บัญชีกลาง
 *  ‼ ใบไหนเซลส์/แอดมินโอนงานหรือแก้เจ้าของเองไปแล้ว = ไม่ทับ (กติกาเดียวกับ updateRow) */
async function remap() {
  const links = await db.selectAll(T_LINK, { state: 'eq.linked', select: '*', order: 'lead_id.asc' });
  let changed = 0;
  for (const l of links) {
    if (!l.src || typeof l.src !== 'object' || !UUID.test(clean(l.src.id))) continue;
    try { const r = await ingest(l.src, 'remap', { force: true }); if (r.action === 'updated') changed++; }
    catch (e) { console.warn('[affiliate] คิดเจ้าของใหม่ไม่ได้:', l.lead_id, e.message); }
  }
  return { total: links.length, changed };
}

let _timer = null;
function start() {
  if (_timer) return;
  const sec = Math.max(20, Number(process.env.AFFILIATE_POLL_SEC) || 60);
  const tick = () => pollOnce().then(r => {
    if (r && r.error) console.warn('[affiliate] ตัวเก็บตก:', r.error);
    else if (r && (r.made || r.updated)) console.log(`[affiliate] ตัวเก็บตก: สร้าง ${r.made} · อัปเดต ${r.updated}`);
  }).catch(() => {});
  _timer = setInterval(tick, sec * 1000);
  if (_timer.unref) _timer.unref();
  const first = setTimeout(tick, 20000); if (first.unref) first.unref();
  console.log('[affiliate] ตัวเก็บตก lead จาก Affiliate ' +
    (SRC.configured() ? 'เปิด · ทุก ' + sec + ' วินาที' : 'ยังไม่ทำงาน (ยังไม่ได้ตั้ง AFFILIATE_SUPABASE_URL / KEY)'));
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

/* ═══════════════════ สถานะสำหรับหน้าตั้งค่า ═══════════════════ */
async function status() {
  const cfg = await loadConfig(true);
  const out = { ok: true, ready: true, sqlFile: SQL_FILE, cfg, rule: RULE,
    hook: { configured: clean(process.env.AFFILIATE_WEBHOOK_SECRET).length >= 16, lastAt: _mem.hookAt, count: _mem.hookN },
    poll: { configured: SRC.configured(), lastAt: _mem.pollAt, lastOkAt: _mem.pollOkAt,
            error: _mem.pollErr, errorAt: _mem.pollErrAt },
    since: _mem.startedAt, made: _mem.made, updated: _mem.updated, recent: [], claimers: [], users: [] };
  const st = await loadState();
  out.poll.cursor = st.cursor || null; out.poll.startedFrom = st.since || null;
  if (!out.poll.error && st.lastError) { out.poll.error = st.lastError; out.poll.errorAt = st.lastErrorAt || null; }
  try {
    out.users = (await users(true)).map(u => ({ username: u.username,
      label: (u.nickname || u.name || u.username) + ' · ' + u.username }));
  } catch (e) { out.usersError = e.message; }
  try {
    const rows = await db.select(T_LINK, { select: '*', order: 'updated_at.desc', limit: 300 });
    const byKey = new Map();
    for (const l of rows || []) {
      if (l.claimer_key) {
        const o = byKey.get(l.claimer_key) || { key: l.claimer_key, label: clean(l.claimer_label), count: 0 };
        o.count++; if (!o.label) o.label = clean(l.claimer_label);
        byKey.set(l.claimer_key, o);
      }
    }
    for (const k of Object.keys(cfg.claimers)) if (!byKey.has(k)) byKey.set(k, { key: k, label: k.replace(/^[a-z]+:/, ''), count: 0 });
    out.claimers = [...byKey.values()].map(o => ({ ...o, username: cfg.claimers[o.key] || '' }))
      .sort((a, b) => (a.username ? 1 : 0) - (b.username ? 1 : 0) || b.count - a.count);
    out.total = (rows || []).length;
    out.recent = (rows || []).slice(0, 60).map(l => ({
      id: l.lead_id, state: l.state, reason: clean(l.reason), jobCode: clean(l.job_code),
      owner: clean(l.owner), claimer: clean(l.claimer_label), srcStatus: clean(l.src_status),
      name: clean(l.src && (l.src.customer_name || l.src.line_display_name)),
      phone: clean(l.src && l.src.phone), via: clean(l.via), kept: Array.isArray(l.kept) ? l.kept : [],
      at: l.updated_at, srcAt: l.src_updated_at }));
  } catch (e) {
    if (isNoTable(e)) { out.ready = false; out.error = 'ยังไม่ได้รัน ' + SQL_FILE + ' ใน Supabase ของ CRM Hub'; }
    else out.error = e.message;
  }
  return out;
}

module.exports = {
  applyLead, ingest, pollOnce, backfill, remap, start, stop, status, noteHook, markSourceDeleted,
  loadConfig, saveConfig, mergeConfig, mapLead, noteOf, claimerOf, ownerOf, leadStatusOf,
  RULE, FIELD_COLS, OWNER_COLS, LEAD_COLS, SKIP_NEW, DEFAULTS, SQL_FILE, T_LINK,
  fingerprint,
  _t: { reset() { _cfg = null; _users = null; _dir = new Map(); _dirAt = 0; _fail.clear(); _done.clear(); }, mem: _mem, overlapStart, OVERLAP_MS },
};
