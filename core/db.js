'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/db.js — ตัวคุยกับ Supabase (PostgREST) ตัวเดียวของทั้งระบบ
 *
 *  ทำไมไม่ใช้ไลบรารี supabase-js: เราต้องคุมเรื่อง schema header,
 *  การ retry และ log เอง + ลด dependency ให้เหลือน้อยที่สุด
 *
 *  ‼ service_role key อยู่ที่ชั้นนี้ชั้นเดียว ไม่มีทางหลุดไปฝั่งเบราว์เซอร์
 * ═══════════════════════════════════════════════════════════════════ */
const { CFG } = require('./config');

const MAX_RETRY = 3;
const BACKOFF_MS = 400;

/** หน่วงเวลาแบบ async */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * ยิง request ไป PostgREST
 * @param {string} method  GET | POST | PATCH | DELETE
 * @param {string} path    เช่น '/total_sales?select=*&limit=10'
 * @param {object} opt     { body, schema, prefer, headers }
 */
async function rest(method, path, opt = {}) {
  const schema = opt.schema || CFG.SUPABASE_SCHEMA;
  const url = CFG.SUPABASE_URL + '/rest/v1' + path;

  const headers = {
    apikey: CFG.SUPABASE_KEY,
    Authorization: 'Bearer ' + CFG.SUPABASE_KEY,
    'Content-Type': 'application/json',
    // PostgREST ใช้ header คนละตัวสำหรับอ่านกับเขียน
    'Accept-Profile': schema,
    'Content-Profile': schema,
    ...(opt.headers || {}),
  };
  if (opt.prefer) headers.Prefer = opt.prefer;

  const init = { method, headers };
  if (opt.body !== undefined) init.body = JSON.stringify(opt.body);

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await fetch(url, init);
      const text = await res.text();

      if (res.ok) {
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
      }

      // 5xx / 429 → ลองใหม่ · 4xx อื่น → ผิดที่คำสั่งเรา ไม่ต้องลองซ้ำ
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
        await sleep(BACKOFF_MS * Math.pow(2, attempt - 1));
        continue;
      }
      const err = new Error(`Supabase ${res.status}: ${text.slice(0, 500)}`);
      err.status = res.status;
      err.body = text;
      throw err;
    } catch (e) {
      if (e.status) throw e;           // 4xx — โยนออกเลย
      lastErr = e;
      if (attempt < MAX_RETRY) await sleep(BACKOFF_MS * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr || new Error('เรียก Supabase ไม่สำเร็จ');
}

/* ─── ตัวช่วยที่ใช้บ่อย ─────────────────────────────────────────── */

const qs = params => {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  return parts.length ? '?' + parts.join('&') : '';
};

const db = {
  rest,
  qs,

  /** อ่านหลายแถว — select('total_sales', { select:'*', limit:100, 'รหัสงาน':'eq.QW2609/001' }) */
  select: (table, params) => rest('GET', '/' + table + qs(params)),

  /**
   * อ่านให้ครบทุกแถว — ไล่ทีละหน้าจนหมด
   *
   * ‼ Supabase จำกัดจำนวนแถวต่อคำขอไว้ 1,000 แถว (ค่า db_max_rows)
   *   และ "ไม่บอก" ว่าตัดให้ — คืน 1,000 แถวมาเฉย ๆ เหมือนมีแค่นั้นจริง
   *
   *   บั๊กจริงจากการซิงค์รอบสอง: ตอนอ่านลายนิ้วมือของแถวที่มีอยู่แล้ว
   *   ได้มาแค่ 1,000 แถวแรก แถวที่ 1,001 เป็นต้นไปจึงถูกนับว่า "ใหม่"
   *   แล้วสั่ง insert ทับของเดิม → 23505 duplicate key (_row)=(1038)
   *   สังเกตได้จากเลข "เท่าเดิม 1,000" ที่ลงท้ายกลม ๆ พอดีเกินไป
   *
   *   บทเรียน: ตัวเลขกลม ๆ ที่พอดีกับลิมิต แปลว่าโดนตัด ไม่ใช่ของครบ
   */
  async selectAll(table, params, pageSize = 1000) {
    /* ‼ ต้องมี order เสมอ
     *   ถ้าไม่สั่งเรียง PostgreSQL ไม่รับประกันว่าแต่ละหน้าจะเรียงเหมือนเดิม
     *   หน้า 2 อาจคืนแถวซ้ำกับหน้า 1 และข้ามบางแถวไปเลย — พังแบบเงียบ ๆ
     *   ยอมโยน error ให้เห็นตั้งแต่ตอนเขียนโค้ด ดีกว่าได้ข้อมูลผิดแบบไม่รู้ตัว */
    if (!params || !params.order)
      throw new Error(`selectAll('${table}') ต้องระบุ order เสมอ เช่น { order: '_row.asc' }`);
    const out = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await rest('GET', '/' + table + qs({ ...params, limit: pageSize, offset }));
      if (!Array.isArray(page) || !page.length) break;
      out.push(...page);
      if (page.length < pageSize) break;
      if (out.length > 1000000)
        throw new Error(`อ่าน ${table} เกินหนึ่งล้านแถว — น่าจะมีอะไรผิดปกติ หยุดก่อน`);
    }
    return out;
  },

  /** อ่านแถวเดียว (คืน null ถ้าไม่เจอ) */
  async one(table, params) {
    const rows = await rest('GET', '/' + table + qs({ ...params, limit: 1 }));
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  },

  /** เพิ่มแถว — คืนแถวที่เพิ่ง insert */
  insert: (table, body) =>
    rest('POST', '/' + table, { body, prefer: 'return=representation' }),

  /** แก้แถวตามเงื่อนไข */
  update: (table, params, body) =>
    rest('PATCH', '/' + table + qs(params), { body, prefer: 'return=representation' }),

  /** ลบแถวตามเงื่อนไข */
  remove: (table, params) => rest('DELETE', '/' + table + qs(params)),

  /** upsert — ต้องมี unique index รองรับ */
  upsert: (table, body, onConflict) =>
    rest('POST', '/' + table + qs({ on_conflict: onConflict }), {
      body,
      prefer: 'resolution=merge-duplicates,return=representation',
    }),

  /** เรียก stored function (RPC) */
  rpc: (fn, args) => rest('POST', '/rpc/' + fn, { body: args || {} }),

  /** นับจำนวนแถว (ไม่ดึงข้อมูลจริง) */
  async count(table, params) {
    const url = CFG.SUPABASE_URL + '/rest/v1/' + table + qs({ ...params, select: 'count' });
    const res = await fetch(url, {
      headers: {
        apikey: CFG.SUPABASE_KEY,
        Authorization: 'Bearer ' + CFG.SUPABASE_KEY,
        'Accept-Profile': CFG.SUPABASE_SCHEMA,
        Prefer: 'count=exact',
        Range: '0-0',
      },
    });
    const cr = res.headers.get('content-range') || '';
    const m = cr.match(/\/(\d+)$/);
    return m ? Number(m[1]) : 0;
  },

  /** ตรวจว่าต่อฐานข้อมูลได้ไหม (ใช้ใน /healthz และ npm run doctor)
   *  ‼ ต้องยิงตารางจริง — เดิมยิง '/' แล้ว catch ทิ้ง ทำให้ ok:true เสมอ
   *    แม้ key ผิดหรือ schema ยังไม่ได้ expose (บั๊กที่ทำให้หาสาเหตุยาก) */
  async ping() {
    const t0 = Date.now();
    try {
      await rest('GET', '/app_users?select=Username&limit=1', {});
      return { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      const msg = String((e && e.message) || e);
      let hint = 'ต่อฐานข้อมูลไม่สำเร็จ';
      if (/42501|permission denied/i.test(msg))
        hint = 'ยังไม่ได้ให้สิทธิ์ service_role เข้า schema app — รัน sql/01-core.sql ใหม่ (บล็อก grant ท้ายไฟล์)';
      else if (/PGRST106|schema must be one of/i.test(msg))
        hint = 'ยังไม่ได้เพิ่ม schema "app" ที่ Supabase > Integrations > Data API > Exposed schemas';
      else if (/PGRST205|Could not find the table|does not exist/i.test(msg))
        hint = 'ยังไม่ได้รัน sql/01-core.sql ใน SQL Editor';
      else if (/401|403|JWT|apikey|Invalid API key|invalid claim/i.test(msg))
        hint = 'SUPABASE_KEY ผิด — ต้องเป็น service_role key (ขึ้นต้น eyJhbGciOi) ไม่ใช่ anon และไม่ใช่รหัสฐานข้อมูล';
      else if (/ENOTFOUND|fetch failed|ECONN|getaddrinfo/i.test(msg))
        hint = 'SUPABASE_URL ผิด หรือออกเน็ตไม่ได้';
      return { ok: false, ms: Date.now() - t0, hint, error: msg.slice(0, 300) };
    }
  },
};

module.exports = db;
