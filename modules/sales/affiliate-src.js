'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  modules/sales/affiliate-src.js — ตัว "อ่าน" ฐาน Supabase ของระบบ Affiliate
 *  (โปรเจกต์ "มดงานการป้าย Affiliate" — คนละโปรเจกต์กับฐานของ CRM Hub)
 *
 *  🔴 อ่านอย่างเดียว — ไฟล์นี้ยิงได้แค่คำขอแบบ "ขออ่าน" (GET) เท่านั้น
 *     ไม่มีฟังก์ชันเขียน/แก้/ลบ และห้ามเติม (ยาม tools/test-affiliate.js คุมไว้)
 *     ฐาน Affiliate เป็นของอีกทีม — CRM Hub เป็นแค่ผู้อ่าน
 *
 *  🔑 ค่าที่ต้องตั้งใน Railway > Variables เท่านั้น (ห้ามใส่ในโค้ด · ห้ามส่งในแชท · ห้าม commit)
 *     AFFILIATE_SUPABASE_URL = https://<ref>.supabase.co
 *     AFFILIATE_SUPABASE_KEY = key ฝั่งเซิร์ฟเวอร์ของโปรเจกต์ Affiliate (secret / service_role)
 *  ไม่ตั้ง = ตัวเก็บตกไม่ทำงาน (จุดรับ webhook ยังทำงานได้ตามปกติ)
 * ═══════════════════════════════════════════════════════════════════ */

const clean = s => String(s == null ? '' : s).trim();
const TIMEOUT_MS = 15000;

/** ตารางที่อนุญาตให้อ่าน — อย่างอื่นปฏิเสธ (ไม่แตะข้อมูลธนาคาร/บัตรของพาร์ทเนอร์) */
const ALLOW = new Set(['leads', 'affiliate_sales_directory']);

const baseUrl = () => clean(process.env.AFFILIATE_SUPABASE_URL).replace(/\/+$/, '');
const apiKey  = () => clean(process.env.AFFILIATE_SUPABASE_KEY);
/* ‼ ต้องเป็น https เสมอ — ยกเว้นเครื่องตัวเอง (127.0.0.1 / localhost) ที่ยามใช้จำลองฐาน Affiliate */
const URL_OK = /^(https:\/\/[a-z0-9.-]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/i;
const configured = () => URL_OK.test(baseUrl()) && apiKey().length >= 20;

/* หัวคำขอ — key รุ่นใหม่ของ Supabase (sb_secret_…) ให้ส่งที่หัว apikey อย่างเดียว
 * (เอกสาร Supabase: "Send publishable and secret keys on the apikey header, not on Authorization: Bearer")
 * key รุ่นเดิม (service_role แบบ JWT ขึ้นต้น eyJ) ส่งทั้งสองหัวเหมือน core/db.js */
function authHeaders() {
  const k = apiKey();
  const h = { apikey: k, 'Accept-Profile': 'public' };
  if (/^eyJ/.test(k)) h.Authorization = 'Bearer ' + k;
  return h;
}

/** ข้อความ error ที่ปลอดภัย — ไม่มี key ติดไปเด็ดขาด */
function safeMsg(e) {
  let m = clean(e && e.message) || 'ไม่ทราบสาเหตุ';
  const k = apiKey();
  if (k) m = m.split(k).join('***');
  return m.slice(0, 300);
}

/**
 * อ่านแถวจากฐาน Affiliate (PostgREST)
 * @param {string} table   ชื่อตารางใน schema public (ต้องอยู่ใน ALLOW)
 * @param {object} params  ตัวกรองแบบ PostgREST เช่น { select:'id,name', updated_at:'gt.2026-…', order:'updated_at.asc', limit:200 }
 * @returns {Promise<object[]>}
 */
async function read(table, params) {
  if (!ALLOW.has(table)) throw new Error('ไม่อนุญาตให้อ่านตาราง ' + table + ' ของฐาน Affiliate');
  if (!configured()) throw new Error('ยังไม่ได้ตั้ง AFFILIATE_SUPABASE_URL / AFFILIATE_SUPABASE_KEY ใน Railway');
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) q.set(k, String(v));
  const url = baseUrl() + '/rest/v1/' + table + (String(q) ? '?' + q : '');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: authHeaders(),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403
        ? ' — key ของฐาน Affiliate ใช้ไม่ได้ (ตรวจ AFFILIATE_SUPABASE_KEY ใน Railway)' : '';
      throw new Error('ฐาน Affiliate ตอบ ' + res.status + hint + ' ' + text.slice(0, 160));
    }
    const data = text ? JSON.parse(text) : [];
    return Array.isArray(data) ? data : [];
  } catch (e) {
    if (e && (e.name === 'AbortError' || /abort/i.test(e.message || '')))
      throw new Error('ฐาน Affiliate ไม่ตอบภายใน ' + Math.round(TIMEOUT_MS / 1000) + ' วินาที');
    throw new Error(safeMsg(e));
  } finally { clearTimeout(timer); }
}

module.exports = { configured, read, safeMsg, authHeaders, ALLOW };
