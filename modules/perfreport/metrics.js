'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/perfreport/metrics.js — รวมตัวเลขผลงานของ 1 คน ในช่วงวันที่ (เวลาไทย) จากแอปที่ใช้งานจริง
 *
 *  แหล่งข้อมูล (ตรวจจากโค้ด/ตารางจริง 3 พ.ย. 69 — ดูเอกสารออกแบบ):
 *    Ant-Connect   omni_msg (ข้อความที่พนักงานตอบ) · omni_event (จ่ายแชท · ปิดเคส · ลูกค้ารอเกินเวลา)
 *                  omni_lead_link (lead) · omni_slip (สลิปในแชท) · omni_conv (ช่องทาง)
 *    คีย์ยอดขาย    total_sales (รหัสงาน · ใบเสนอ · ปิดการขาย · ช่องทาง) · sales_support (งานที่ Support ดูแล)
 *    เก็บเงิน      cash_flow (เงินเข้า · วันเก็บ) · collect_log (ติดตามหนี้)
 *    B2B Visit     visit_prospects (ลูกค้าใหม่) · visit_events (visit · งานติดตาม)
 *    จองคิวช่าง    installation_plan ("ผู้ที่จอง" · "วันที่จอง")
 *    Projects      auth_audit (action = project_create)
 *    ลางาน         job_leaves
 *
 *  ‼ อ่านเฉพาะคอลัมน์ที่ใช้ + กรองช่วงเวลาเสมอ (ไม่ดึงทั้งตาราง — คุม egress ของ Supabase)
 *  ‼ แหล่งไหนอ่านไม่ได้ ⇒ หัวข้อนั้นเป็น null + จดเหตุใน errors (report ยังสร้างได้)
 * ═══════════════════════════════════════════════════════════════════ */
const C = require('./config');

const clean = s => String(s == null ? '' : s).trim();
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const q = s => '"' + String(s).replace(/"/g, '') + '"';
const inList = arr => 'in.(' + arr.map(q).join(',') + ')';
const uniq = a => [...new Set(a.filter(Boolean))];
const chunk = (a, k) => { const o = []; for (let i = 0; i < a.length; i += k) o.push(a.slice(i, i + k)); return o; };

/* ── เวลาไทย ── */
const TZ = 7 * 3600e3;
const isoDay = ms => new Date(ms + TZ).toISOString().slice(0, 10);
const todayTH = () => isoDay(Date.now());
const startMs = d => Date.parse(d + 'T00:00:00+07:00');
const addDays = (d, k) => isoDay(startMs(d) + k * 864e5);
const dow = d => new Date(startMs(d) + TZ).getUTCDay();
const mondayOf = d => addDays(d, -((dow(d) + 6) % 7));
const utc = ms => new Date(ms).toISOString();
const okDay = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && Number.isFinite(startMs(d));

/** ชื่อที่ Ant-Connect ใช้ในบันทึก (เหมือน modules/omnichat/people.js displayName) */
function displayName(nick, full, username) {
  const f = clean(full), m = f.match(/^\(\s*([^)]*?)\s*\)\s*/);
  const rest = m ? f.slice(m[0].length).trim() : f, nn = clean(nick) || (m ? clean(m[1]) : '');
  const out = ((nn ? '(' + nn + ')' : '') + (rest ? (nn ? ' ' : '') + rest : '')).trim();
  return out || clean(username);
}
/** บทบาทจากสิทธิ์ผู้ใช้: sale support / sale co ⇒ support · อื่น ๆ ⇒ sale */
const roleOf = perm => (/sale\s*(support|co)/i.test(String(perm || '')) ? 'support' : 'sale');

/** ชื่อเล่นของผู้ใช้ (ช่อง Nickname ก่อน · ไม่มีก็เอาจาก "(ชื่อเล่น) ชื่อจริง") */
function nickOf(u) {
  const n = clean(u && u.Nickname); if (n) return n;
  const m = clean(u && u.Name).match(/^\(\s*([^)]*?)\s*\)/);
  return m ? clean(m[1]) : '';
}
/**
 * บทบาท + วัดแชทหรือไม่ — รายชื่อ Sale Support ใน config มาก่อนสิทธิ์ในระบบ
 * @returns {{role:'sale'|'support', chatScored:boolean, listed:boolean}}
 */
/** อยู่ทีมขายไหม: สิทธิ์ Sale / Sales / Sale Support / Sale Co / Sale Freelance เท่านั้น
 *  ‼ พี่เอ 3 พ.ย. 69: "เอาแค่ sale , sale support แค่นั้นนะ ไม่เอา ช่าง หรือ after sale service" */
const isBranchGraphic = perm => /(graphic|กราฟ(ิ|ฟ)?ิ?[คก])\s*สาขา\s*มดงาน/i.test(clean(perm));
const isSaleTeam = perm => { const p = clean(perm).toLowerCase(); return /\bsales?\b/.test(p) && !/after\s*sales?|ช่าง|tech|admin|ผู้บริหาร|free\s*lance|ฟรีแลนซ์/.test(p); };
function profileOf(u) {
  const C = require('./config');
  /* พี่เอ 3 พ.ย. 69: "เพิ่มชื่อ permission : กราฟิค สาขามดงาน เข้ามาในระบบ report ด้วย" ⇒ กลุ่มของตัวเอง · วัดแชท */
  if (isBranchGraphic(u && u.Permission)) return { role: 'branch', chatScored: true, listed: false, team: true };
  /* พี่เอ 3 พ.ย. 69: "ตัดชื่อ ปัท กับ วันวา ออกนะ" ⇒ Sale Freelance ไม่อยู่ในรายชื่อ (ดูทั้งสิทธิ์และชื่อ) */
  if (!isSaleTeam(u && u.Permission) || /free\s*lance|ฟรีแลนซ์/i.test(clean(u && u.Name))) return { role: roleOf(u && u.Permission), chatScored: true, listed: false, team: false };
  const nk = nickOf(u).toLowerCase();
  const has = arr => !!nk && arr.some(x => x.toLowerCase() === nk);
  if (has(C.SALE_NOCHAT)) return { role: 'sale', chatScored: false, listed: true, team: true };
  if (has(C.SUPPORT_NOCHAT)) return { role: 'support', chatScored: false, listed: true, team: true };
  if (has(C.SUPPORT_CHAT)) return { role: 'support', chatScored: true, listed: true, team: true };
  return { role: roleOf(u && u.Permission), chatScored: true, listed: false, team: true };
}

/** คนทุกรูปแบบชื่อ (บางตารางเก็บชื่อเล่น บางตารางเก็บ username) */
function who(u) {
  const nick = clean(u.Nickname), full = clean(u.Name), un = clean(u.Username);
  const m = full.match(/^\(\s*([^)]*?)\s*\)/);
  return { username: un, nick: nick || (m ? clean(m[1]) : ''), full, disp: displayName(nick, full, un),
    names: uniq([un, nick, full, displayName(nick, full, un), m ? clean(m[1]) : ''].map(clean)) };
}

/** คู่ "ข้อความลูกค้า → ข้อความตอบของคนนี้" ⇒ นาทีที่ใช้ตอบ */
function latencies(msgs, username) {
  const byConv = {};
  for (const r of msgs) (byConv[r.conv_id] = byConv[r.conv_id] || []).push(r);
  const out = [];
  for (const id of Object.keys(byConv)) {
    let wait = null;
    for (const r of byConv[id]) {
      const t = Date.parse(r.at);
      if (r.sender === 'customer') { if (wait == null) wait = t; continue; }
      if (r.sender === 'agent') {
        if (wait != null && clean(r.username).toLowerCase() === username.toLowerCase()) {
          const min = (t - wait) / 60000;
          if (min >= 0 && min <= C.REPLY_PAIR_MAX_MIN) out.push(min);
        }
        wait = null;
      }
    }
  }
  return out;
}

/**
 * @param db  core/db
 * @param u   แถว app_users ({Username, Name, Nickname, Permission})
 * @param from,to  'YYYY-MM-DD' (รวมทั้งสองวัน · เวลาไทย)
 */
/* ⏱ v1.0.10 เกณฑ์ "ลูกค้ารอเกินเวลา" = ค่าเดียวกับ Ant-Connect (ตั้งค่า › routing.slaFirstResponseSec · ค่าเริ่มต้น 180 วินาที = 3 นาที)
 *   พี่เอ 6 พ.ย. 69: "ที่บอกว่าตอบเกินเวลาที่กำหนด เราตั้งไว้กี่นาที แสดงเวลาที่ต้องตอบให้ทันไว้ในช่องด้วยนะ" · จำค่า 1 นาที */
let slaMemo = { at: 0, min: 3 };
async function slaMin(db) {
  if (Date.now() - slaMemo.at < 60e3) return slaMemo.min;   /* v1.0.11 จำแค่ 1 นาที — เปลี่ยนที่ Ant-Connect แล้วเห็นเร็ว (เคยค้างค่า 4 ตอนกดลูกศร 3→4→5) */
  try {
    const row = await db.one('settings', { key: 'eq.omnichat_config', select: 'value' });
    let v = row && row.value; if (typeof v === 'string') v = JSON.parse(v);
    const sec = Number(v && v.routing && v.routing.slaFirstResponseSec);
    slaMemo = { at: Date.now(), min: Number.isFinite(sec) && sec > 0 ? Math.round(sec / 60 * 10) / 10 : 3 };
  } catch (e) { slaMemo = { at: Date.now(), min: slaMemo.min }; }
  return slaMemo.min;
}

async function collect(db, u, from, to) {
  const W = who(u), un = W.username;
  const A = utc(startMs(from)), B = utc(startMs(addDays(to, 1)));
  const win = col => '(' + q(col) + '.gte.' + A + ',' + q(col) + '.lt.' + B + ')';
  const dwin = col => '(' + q(col) + '.gte.' + from + ',' + q(col) + '.lte.' + to + ')';
  const errors = [];
  const safe = async (name, fn) => { try { return await fn(); } catch (e) { errors.push(name + ': ' + String((e && e.message) || e).slice(0, 160)); return null; } };
  const m = { chat: {}, sales: {}, money: {}, customer: {}, work: {}, channels: {} };
  m.chat.slaMin = await slaMin(db);
  m.chat.replyGoalMin = require('./config').REPLY_FAST_MIN;

  /* ── Ant-Connect ── */
  const replies = await safe('Ant-Connect ข้อความ', () => db.selectAll('omni_msg', { select: 'conv_id,at', sender: 'eq.agent', username: 'eq.' + un, and: win('at'), order: 'at.asc' }));
  if (replies) {
    m.chat.replies = replies.length;
    const convs = uniq(replies.map(r => r.conv_id));
    m.chat.chats = convs.length;
    const pick = convs.slice(0, 120);
    if (pick.length) {
      const msgs = [];
      for (const part of chunk(pick, 40)) {
        const rows = await safe('Ant-Connect เวลาตอบ', () => db.selectAll('omni_msg', { select: 'conv_id,at,sender,username', conv_id: inList(part),
          and: '(at.gte.' + utc(startMs(from) - C.REPLY_PAIR_MAX_MIN * 60000) + ',at.lt.' + B + ')', order: 'at.asc' }));
        if (rows) msgs.push(...rows);
      }
      const lat = latencies(msgs.filter(r => r.sender !== 'agent' || Date.parse(r.at) >= startMs(from)), un);
      m.chat.avgReplyMin = lat.length ? Math.round(lat.reduce((s, x) => s + x, 0) / lat.length * 10) / 10 : null;
      m.chat.replyPairs = lat.length;
      const info = [];
      for (const part of chunk(pick, 80)) { const r = await safe('Ant-Connect ช่องทาง', () => db.select('omni_conv', { select: 'id,channel,account_id', id: inList(part), limit: 200 })); if (r) info.push(...r); }
      for (const c of info) { const k = (c.channel || 'อื่น ๆ') + (c.account_id ? ' · ' + c.account_id : ''); m.channels[k] = Object.assign({ chats: 0, won: 0, value: 0 }, m.channels[k]); m.channels[k].chats += 1; }
    } else m.chat.avgReplyMin = null;
  }
  const assigned = await safe('Ant-Connect รับแชท', () => db.selectAll('omni_event', { select: 'id', type: 'eq.assigned', detail: 'like.จ่ายให้ ' + W.disp + '*', and: win('at'), order: 'at.asc' }));
  if (assigned) m.chat.received = assigned.length;
  const closed = await safe('Ant-Connect ปิดเคส', () => db.selectAll('omni_event', { select: 'id', type: 'eq.closed', actor: 'eq.' + W.disp, and: win('at'), order: 'at.asc' }));
  if (closed) m.chat.closed = closed.length;
  const sla = await safe('Ant-Connect ลูกค้ารอ', () => db.selectAll('omni_event', { select: 'conv_id', type: 'eq.sla_breach', and: win('at'), order: 'at.asc' }));
  if (sla) {
    const ids = uniq(sla.map(r => r.conv_id));
    let mine = new Set();
    for (const part of chunk(ids, 80)) { const r = await safe('Ant-Connect ลูกค้ารอ', () => db.select('omni_conv', { select: 'id', id: inList(part), assigned_to: 'eq.' + un, limit: 200 })); if (r) r.forEach(x => mine.add(x.id)); }
    m.chat.slaBreaches = sla.filter(r => mine.has(r.conv_id)).length;
  }
  const leads = await safe('Ant-Connect lead', () => db.selectAll('omni_lead_link', { select: 'conv_id,job_code', owner: 'eq.' + un, and: win('created_at'), order: 'created_at.asc' }));
  if (leads) m.chat.leads = leads.length;
  const slips = await safe('Ant-Connect สลิป', () => db.selectAll('omni_slip', { select: 'amount,dup_of,status', sales_user: 'eq.' + un, and: win('sent_at'), order: 'sent_at.asc' }));
  if (slips) { const ok = slips.filter(s => !s.dup_of && s.status !== 'rejected'); m.money.slips = ok.length; m.money.slipAmount = Math.round(ok.reduce((s, x) => s + num(x.amount), 0)); }

  /* ── คีย์ยอดขาย ── */
  const created = await safe('คีย์ยอดขาย รหัสงาน', () => db.selectAll('total_sales', { select: '_row,"ยอดประเมินราคา"', 'Sales Code': 'eq.' + un, and: win('Created At'), order: '_row.asc' }));
  if (created) {
    m.sales.jobCodes = created.length;
    const qs = created.filter(r => num(r['ยอดประเมินราคา']) > 0);
    m.sales.quotes = qs.length; m.sales.quoteValue = Math.round(qs.reduce((s, r) => s + num(r['ยอดประเมินราคา']), 0));
  }
  const won = await safe('คีย์ยอดขาย ปิดการขาย', () => db.selectAll('total_sales', { select: '_row,"ยอดขายก่อน VAT","ยอดขาย (บาท)","ลูกค้ามาจากไหน","ชื่อช่อง / Platform"', 'Sales Code': 'eq.' + un, and: dwin('วันที่ปิดการขาย'), order: '_row.asc' }));
  const preVat = r => (num(r['ยอดขายก่อน VAT']) || Math.round(num(r['ยอดขาย (บาท)']) / 1.07));
  if (won) {
    m.sales.won = won.length; m.sales.wonValue = Math.round(won.reduce((s, r) => s + preVat(r), 0));
    for (const r of won) {
      const k = clean(r['ลูกค้ามาจากไหน']) || 'ไม่ระบุ';
      m.channels[k] = Object.assign({ chats: 0, won: 0, value: 0 }, m.channels[k]);
      m.channels[k].won += 1; m.channels[k].value += preVat(r);
    }
  }
  if ((u.role || profileOf(u).role) === 'support') {
    const sup = await safe('คีย์ยอดขาย งานที่ดูแล', () => db.selectAll('sales_support', { select: 'row_no,share_pct', support_user: 'eq.' + un, order: 'row_no.asc' }));
    if (sup && sup.length) {
      let val = 0, cnt = 0;
      for (const part of chunk(sup.map(s => s.row_no), 150)) {
        const rows = await safe('คีย์ยอดขาย งานที่ดูแล', () => db.select('total_sales', { select: '_row,"ยอดขายก่อน VAT","ยอดขาย (บาท)"', _row: 'in.(' + part.join(',') + ')', and: dwin('วันที่ปิดการขาย'), limit: 1000 }));
        if (rows) { cnt += rows.length; val += rows.reduce((s, r) => s + preVat(r), 0); }
      }
      m.sales.supportedWon = cnt; m.sales.supportedValue = Math.round(val);
    } else if (sup) { m.sales.supportedWon = 0; m.sales.supportedValue = 0; }
  }

  /* ── เก็บเงิน ── */
  const cash = await safe('เงินเข้า (PEAK)', () => db.selectAll('cash_flow', { select: 'id,amount,cash,days', sale: inList(W.names), and: dwin('paid_at'), order: 'id.asc' }));
  if (cash) {
    m.money.collected = Math.round(cash.reduce((s, r) => s + (num(r.cash) || num(r.amount)), 0));
    m.money.receipts = cash.length;
    const ds = cash.map(r => num(r.days)).filter(d => d > 0);
    m.money.avgCollectDays = ds.length ? Math.round(ds.reduce((s, x) => s + x, 0) / ds.length) : null;
  }
  const fol = await safe('ติดตามหนี้', () => db.selectAll('collect_log', { select: 'id,promise', by_user: inList(W.names), and: win('at'), order: 'id.asc' }));
  if (fol) { m.money.followups = fol.length; m.money.promised = Math.round(fol.reduce((s, r) => s + num(r.promise), 0)); }

  /* ── B2B Visit ── */
  const pros = await safe('B2B Visit ลูกค้าใหม่', () => db.selectAll('visit_prospects', { select: 'id,value', created_by: 'eq.' + un, and: win('created_at'), order: 'created_at.asc' }));
  if (pros) { m.customer.prospects = pros.length; m.customer.prospectValue = Math.round(pros.reduce((s, r) => s + num(r.value), 0)); }
  const ev = await safe('B2B Visit กิจกรรม', () => db.selectAll('visit_events', { select: 'id,kind', by_user: 'eq.' + un, kind: 'in.(visit,task,plan,follow)', and: win('created_at'), order: 'created_at.asc' }));
  if (ev) { m.customer.visits = ev.filter(e => e.kind === 'visit').length; m.customer.tasks = ev.filter(e => e.kind === 'task').length; m.customer.plans = ev.filter(e => e.kind === 'plan').length;
    /* 💬 v1.0.13 บันทึกการติดตามทางแชท/โทร (Visit 1.5.0) — นับเป็นการติดตามลูกค้า */
    m.customer.follows = ev.filter(e => e.kind === 'follow').length; }

  /* ── งานต่อ ── */
  const bk = await safe('จองคิวช่าง', () => db.selectAll('installation_plan', { select: '_row', 'ผู้ที่จอง': 'eq.' + un, and: win('วันที่จอง'), order: '_row.asc' }));
  if (bk) m.work.bookings = bk.length;
  const pj = await safe('Projects', () => db.selectAll('auth_audit', { select: '_id', action: 'eq.project_create', username: 'eq.' + un, and: win('at'), order: '_id.asc' }));
  if (pj) m.work.projects = pj.length;

  /* ── กราฟิก สาขามดงาน เท่านั้น (ไม่ยิงฐานเพิ่มให้คนอื่น) — พี่เอ 3 พ.ย. 69:
   *    "ให้เพิ่มการวัดผล ในส่วนของ การจบงาน projects การสร้าง job card ผลิต และ งานเคลมจากราฟิค เข้ามาด้วยนะ"
   *    จบงาน Projects   projects ("Owner" = กราฟิกคนนี้ · "Complete" อยู่ในช่วง)
   *    Job card ผลิต    production_jobs ("CreatedBy" = คนนี้ · ไม่นับการ์ดเคลม)
   *    เคลมจากกราฟิค    production_jobs การ์ดเคลมประเภท "กราฟิค-ขาย" ที่ "Graphic" = คนนี้ */
  if ((u.role || profileOf(u).role) === 'branch') {
    const pd = await safe('Projects จบงาน', () => db.selectAll('projects', { select: '_row', Owner: inList(W.names), and: dwin('Complete'), order: '_row.asc' }));
    if (pd) m.work.projectsDone = pd.length;
    const jc = await safe('Job card ผลิต', () => db.selectAll('production_jobs', { select: '_id,"JobID"', CreatedBy: inList(W.names), ClaimFromJobID: 'is.null', and: win('CreatedAt'), order: '_id.asc' }));
    if (jc) m.work.jobCards = uniq(jc.map(r => r.JobID)).length;
    const c1 = await safe('เคลมจากกราฟิค', () => db.selectAll('production_jobs', { select: '_id,"JobID"', Graphic: inList(W.names), ClaimType: 'eq.กราฟิค-ขาย', and: win('CreatedAt'), order: '_id.asc' }));
    const c2 = await safe('เคลมจากกราฟิค', () => db.selectAll('production_jobs', { select: '_id,"JobID"', Graphic: inList(W.names), JobType: 'like.*เคลม(กราฟิค*', and: win('CreatedAt'), order: '_id.asc' }));
    if (c1 || c2) m.work.graphicClaims = uniq([].concat(c1 || [], c2 || []).map(r => r.JobID)).length;
  }

  /* ── วันลา ── */
  const lv = await safe('ลางาน', () => db.selectAll('job_leaves', { select: '"LeaveDate"', Username: 'eq.' + un, and: dwin('LeaveDate'), order: '_id.asc' }));
  m.leaveDays = lv ? uniq(lv.map(r => String(r.LeaveDate || '').slice(0, 10))) : [];

  return { metrics: m, errors };
}

module.exports = { collect, latencies, displayName, roleOf, profileOf, nickOf, isSaleTeam, isBranchGraphic, who, todayTH, addDays, mondayOf, dow, okDay, startMs, isoDay };
