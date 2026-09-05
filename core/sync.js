'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/sync.js — ซิงค์ Google Sheets → PostgreSQL แบบ "ทางเดียว"
 *
 *  ใช้ระหว่างช่วงเปลี่ยนผ่าน: ทีมยังคีย์งานในแอปเดิม (ลงชีต)
 *  ระบบใหม่ดึงมาแสดง/ทำรายงาน แต่ยังไม่เขียนกลับ
 *
 *  กฎเหล็ก 3 ข้อ
 *    1) ห้ามเขียนกลับชีตเด็ดขาด — โมดูลนี้ไม่มีฟังก์ชันเขียนเลยแม้แต่ตัวเดียว
 *       และ core/sheets.js ขอสิทธิ์ readonly จาก Google ไว้อีกชั้น
 *    2) ชีตคือแหล่งความจริง — ฐานข้อมูลเป็นกระจก ลบ/แก้ตามชีตเสมอ
 *    3) รันซ้ำต้องได้ผลเท่าเดิม (idempotent) — รันพลาดกลางคันแล้วรันใหม่ได้
 *
 *  คีย์ของการซิงค์คือ "เลขแถวในชีต" (_row)
 *  เพราะชีตไม่มี ID ที่ไว้ใจได้ — รหัสงานว่างได้ ซ้ำได้ (เจอมาแล้ว B2K2609/003)
 * ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const db = require('./db');
const sheets = require('./sheets');

/* ─── แปลงค่าจากชีตให้เป็นชนิดที่ PostgreSQL รับ ──────────────────── */

/** วันฐานของเลขซีเรียล Google Sheets คือ 30 ธ.ค. 1899 */
const SHEET_EPOCH = Date.UTC(1899, 11, 30);

/* ‼ ช่วงปีที่ยอมรับว่าเป็น "วันที่จริง"
 *
 *   เจอจริงตอนซิงค์รอบแรก: ช่องหนึ่งในชีตเก็บตัวเลขที่ไม่ใช่วันที่ไว้ใน
 *   คอลัมน์ที่เราประกาศเป็นวันที่ พอแปลงเป็นวันได้ปี ค.ศ. 20266
 *   JavaScript เขียนปีเกิน 9999 เป็นรูปแบบปีขยาย "+020266-04-01T…"
 *   PostgreSQL อ่านท่อนหลังเป็นเขตเวลา แล้วฟ้อง 22009 → ล้มทั้งรอบ
 *   (รอบนั้นเข้าไปได้แค่ 800 จาก 5,700 แถว)
 *
 *   นอกช่วงนี้ถือว่าไม่ใช่วันที่ → คืน null
 *   ค่าดิบยังอยู่ครบใน _extra ถ้าวันหลังอยากรู้ว่าเดิมเขียนอะไรไว้ */
const YEAR_MIN = Date.UTC(1900, 0, 1);
const YEAR_MAX = Date.UTC(2200, 0, 1);
const inRange = ms => Number.isFinite(ms) && ms >= YEAR_MIN && ms <= YEAR_MAX;

/** เลขซีเรียล → 'YYYY-MM-DD' (คิดตามเวลาไทย) */
function serialToDate(n) {
  const ms = SHEET_EPOCH + Math.floor(n) * 86400000;
  return inRange(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

/** เลขซีเรียล → ISO timestamp */
function serialToTs(n) {
  const ms = SHEET_EPOCH + Math.round(n * 86400000);
  return inRange(ms) ? new Date(ms).toISOString() : null;
}

/**
 * แปลงค่า 1 ช่องตามชนิดของคอลัมน์ในฐานข้อมูล
 * คืน null เมื่อว่าง — สำคัญมากกับคอลัมน์ date/numeric
 * เพราะ '' จะทำให้ PostgREST ปฏิเสธทั้งแถว
 */
function coerce(value, type) {
  if (value === null || value === undefined) return null;
  const s = typeof value === 'string' ? value.trim() : value;
  if (s === '') return null;

  if (type === 'date') {
    if (typeof s === 'number') return serialToDate(s);
    // เผื่อชีตส่งเป็นข้อความมา — รับเฉพาะรูปแบบที่ไม่กำกวม
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return inRange(Date.parse(m[0])) ? m[0] : null;
    const th = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);   // d/m/yyyy
    if (th) {
      let y = parseInt(th[3], 10);
      if (y > 2400) y -= 543;                     // พ.ศ. → ค.ศ.
      if (y < 1900 || y > 2200) return null;
      return `${y}-${String(th[2]).padStart(2, '0')}-${String(th[1]).padStart(2, '0')}`;
    }
    return null;                                   // อ่านไม่ออก = ปล่อยว่าง ดีกว่าเดา
  }

  if (type === 'timestamptz') {
    if (typeof s === 'number') return serialToTs(s);
    const d = new Date(s);
    return (isNaN(d) || !inRange(d.getTime())) ? null : d.toISOString();
  }

  if (type === 'numeric' || type === 'integer') {
    if (typeof s === 'number') return type === 'integer' ? Math.round(s) : s;
    // ตัดคอมมาและสัญลักษณ์เงินออก — ชีตบางช่องเก็บเป็นข้อความ
    const n = Number(String(s).replace(/[,\s฿]/g, ''));
    if (!isFinite(n)) return null;
    return type === 'integer' ? Math.round(n) : n;
  }

  if (typeof s === 'boolean') return s ? 'TRUE' : 'FALSE';
  return String(s);
}

/** ลายนิ้วมือของแถว — ใช้ข้ามแถวที่ไม่มีอะไรเปลี่ยน */
const hashRow = obj => crypto.createHash('md5')
  .update(JSON.stringify(obj)).digest('hex').slice(0, 16);

/* ─── ตัวซิงค์หลัก ──────────────────────────────────────────────── */

/* ─── จดลำดับหัวคอลัมน์จริงของแท็บ ลง app.sheet_headers ───────────────
 *
 *   หน้าตารางของแอปเดิมวาดตาม "หัวชีตทั้งแถว" ไม่มีลิสต์คอลัมน์ตายตัว
 *   ระบบใหม่จึงต้องเก็บลำดับจริงไว้ แล้วให้ฝั่งฐานข้อมูลประกอบแถวตามนี้
 *
 *   เขียนทับทั้งชุดทุกรอบ (ลบก่อนใส่ใหม่) — คอลัมน์ที่ถูกลบออกจากชีต
 *   ต้องหายจากตารางด้วย ไม่ใช่ค้างเป็นช่องว่างตลอดไป
 *   ‼ ล้มตรงนี้ไม่ควรทำให้ทั้งงานซิงค์ล้ม — ข้อมูลสำคัญกว่าทะเบียนหัวตาราง */
async function rememberHeaders(source, header, log) {
  try {
    const rows = [];
    const used = new Set();
    header.forEach((h, i) => {
      const name = String(h == null ? '' : h).trim();
      if (!name || used.has(name)) return;   // หัวว่าง/ซ้ำ = ข้าม (ชีตจริงมีทั้งสองแบบ)
      used.add(name);
      rows.push({ source, ord: i + 1, name });
    });
    if (!rows.length) return;
    await db.remove('sheet_headers', { source: 'eq.' + source });
    await db.insert('sheet_headers', rows);
  } catch (e) {
    if (log) log('จดลำดับหัวคอลัมน์ไม่ได้ (ไม่เป็นไร ทำงานต่อ):', e.message);
  }
}

/**
 * @param {object} job
 *   name        ชื่องานซิงค์ (ลง app.sync_run)
 *   sheetId     Spreadsheet ID
 *   tab         ชื่อแท็บ (ว่าง = แท็บแรก)
 *   table       ตารางปลายทางใน schema app
 *   columns     { 'ชื่อหัวคอลัมน์ในชีต': 'ชนิด' }  ชนิด: text|date|timestamptz|numeric|integer
 *   afterRows   (rows) => Promise   ทำงานเพิ่มหลังซิงค์ เช่น จดรหัสงานเข้าทะเบียน
 *   log         ฟังก์ชัน log
 */
async function syncSheet(job) {
  const t0 = Date.now();
  const log = job.log || (() => {});
  const stat = { rows_read: 0, rows_new: 0, rows_upd: 0, rows_same: 0, rows_del: 0 };
  let runId = null;

  try {
    const started = await db.insert('sync_run', { source: job.name, started_at: new Date().toISOString() });
    runId = Array.isArray(started) && started[0] ? started[0]._id : null;
  } catch (e) {
    log('จดเริ่มรอบซิงค์ไม่ได้ (ไม่เป็นไร ทำงานต่อ):', e.message);
  }

  try {
    /* 1) อ่านชีต */
    const { header, rows } = await sheets.readTab(job.sheetId, job.tab);
    if (!header.length) throw new Error('แท็บว่างเปล่า หรืออ่านหัวตารางไม่ได้');
    stat.rows_read = rows.length;

    // จับคู่หัวคอลัมน์ในชีต → ตำแหน่ง (ตัดช่องว่างหัวท้าย ไม่สนตัวพิมพ์)
    const pos = {};
    header.forEach((h, i) => { if (h) pos[h] = i; });

    // ชื่อหัวในชีตอาจไม่เท่ากับชื่อคอลัมน์ในตาราง (เช่น ชื่อไทยยาวเกิน 63 ไบต์)
    const headerOf = job.headers || {};
    const wanted = Object.keys(job.columns);
    const mappedHeads = new Set(wanted.map(c => headerOf[c] || c));
    const missing = wanted.filter(c => pos[headerOf[c] || c] === undefined);

    /* ‼ ล้มทั้งงานเฉพาะตอน "ไม่เจอสักคอลัมน์เดียว" เท่านั้น
     *
     *   เดิมล้มเมื่อหายเกินครึ่ง — ผลคือชีตที่หัวตารางเปลี่ยนไปจากที่เดาไว้
     *   (Channel · ActivityLog) ไม่ได้ข้อมูลเข้ามาเลยแม้แต่แถวเดียว
     *   ทั้งที่ทุกตารางมี _extra ที่เก็บคอลัมน์ที่ยังไม่ได้จับคู่ไว้ครบอยู่แล้ว
     *
     *   เอาข้อมูลเข้ามาก่อน แล้วค่อยจับคู่คอลัมน์ให้สวยทีหลัง
     *   ดีกว่าปล่อยให้ว่างเปล่าเพราะเดาชื่อหัวตารางผิด */
    if (wanted.length && missing.length === wanted.length)
      throw new Error('ไม่พบคอลัมน์ที่ต้องการเลยสักตัว — หัวตารางที่เจอ: ' +
                      header.slice(0, 10).join(' | '));
    if (missing.length)
      log('⚠ ไม่พบคอลัมน์ในชีต ' + missing.length + ' ช่อง (เก็บลง _extra ไว้แทน):',
          missing.slice(0, 12).join(', '));

    /* 1.5) จดลำดับหัวคอลัมน์จริงไว้ใน app.sheet_headers
     *
     *   หน้าตารางของแอปเดิมวาดตาม "หัวชีตทั้งแถว" ไม่ได้เลือกคอลัมน์เอง
     *   ระบบใหม่จึงต้องรู้ลำดับจริง ไม่ใช่ลำดับที่เราเดาไว้ในโค้ด
     *   เพิ่มคอลัมน์ในชีตวันไหน ตารางขึ้นเองวันนั้น โดยไม่ต้องแก้โค้ด */
    await rememberHeaders(job.name, header, log);

    /* 2) อ่านลายนิ้วมือของที่มีอยู่แล้ว เพื่อข้ามแถวที่ไม่เปลี่ยน */
    /* ‼ ต้องใช้ selectAll ไม่ใช่ select
     *   Supabase ตัดที่ 1,000 แถวเงียบ ๆ ถ้าอ่านไม่ครบ แถวที่ 1,001 ขึ้นไป
     *   จะถูกนับว่า "ใหม่" แล้ว insert ทับของเดิม → duplicate key ล้มทั้งงาน */
    const existing = new Map();
    const cur = await db.selectAll(job.table, { select: '_row,_hash', order: '_row.asc' });
    for (const r of cur || []) existing.set(Number(r._row), r._hash);
    log('มีอยู่แล้วในฐานข้อมูล ' + existing.size + ' แถว');

    /* 3) แปลงทีละแถว */
    const toInsert = [], toUpdate = [];
    const seen = new Set();
    const shaped = [];

    for (let i = 0; i < rows.length; i++) {
      const sheetRow = i + 2;                       // แถว 1 คือหัวตาราง
      const raw = rows[i] || [];
      // แถวว่างล้วน = ข้าม (ชีตมักมีแถวว่างท้ายตาราง)
      if (!raw.some(v => v !== '' && v !== null && v !== undefined)) continue;

      const rec = {};
      for (const [col, type] of Object.entries(job.columns)) {
        const head = headerOf[col] || col;
        const idx = pos[head];
        rec[col] = idx === undefined ? null : coerce(raw[idx], type);
      }

      /* ‼ คอลัมน์ในชีตที่เราไม่ได้จับคู่ไว้ → เก็บลง _extra ไม่ทิ้ง
       *   บทเรียนซ้ำ ๆ ของระบบเดิม: ข้อมูลหายเงียบ ๆ เพราะไม่มีใครรู้ว่ามันมี
       *   ถ้าวันหลังต้องใช้คอลัมน์นั้น ข้อมูลย้อนหลังยังอยู่ครบ */
      if (job.extra !== false) {
        const extra = {};
        for (const [headName, colIdx] of Object.entries(pos)) {
          if (mappedHeads.has(headName)) continue;
          const v = raw[colIdx];
          if (v === '' || v === null || v === undefined) continue;
          extra[headName] = v;
        }
        rec._extra = Object.keys(extra).length ? extra : null;
      }
      const h = hashRow(rec);
      seen.add(sheetRow);
      shaped.push({ sheetRow, rec });

      const old = existing.get(sheetRow);
      if (old === h) { stat.rows_same++; continue; }

      const row = { ...rec, _row: sheetRow, _hash: h, _synced_at: new Date().toISOString() };
      if (old === undefined) { toInsert.push(row); } else { toUpdate.push(row); }
    }

    /* 4) เขียนลงฐานข้อมูล — แบ่งก้อนกันคำขอใหญ่เกิน */
    const CHUNK = 200;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      await db.insert(job.table, toInsert.slice(i, i + CHUNK));
      stat.rows_new += Math.min(CHUNK, toInsert.length - i);
    }
    for (const row of toUpdate) {
      const { _row, ...rest } = row;
      await db.update(job.table, { _row: 'eq.' + _row }, rest);
      stat.rows_upd++;
    }

    /* 5) แถวที่หายไปจากชีต = ถูกลบ → ลบตามให้กระจกตรงกับของจริง */
    for (const [rowNo] of existing) {
      if (!seen.has(rowNo)) {
        await db.remove(job.table, { _row: 'eq.' + rowNo });
        stat.rows_del++;
      }
    }

    /* 6) งานเพิ่มเติมของแต่ละงานซิงค์ (เช่น จดรหัสงานเข้าทะเบียนกันซ้ำ) */
    if (typeof job.afterRows === 'function') await job.afterRows(shaped, log);

    const ms = Date.now() - t0;
    log(`เสร็จ · อ่าน ${stat.rows_read} · ใหม่ ${stat.rows_new} · แก้ ${stat.rows_upd} · เท่าเดิม ${stat.rows_same} · ลบ ${stat.rows_del} · ${ms}ms`);

    if (runId) {
      await db.update('sync_run', { _id: 'eq.' + runId },
        { finished_at: new Date().toISOString(), ok: true, ms, ...stat }).catch(() => {});
    }
    return { ok: true, ms, ...stat };

  } catch (e) {
    const ms = Date.now() - t0;
    log('❌ ล้มเหลว:', e.message);
    if (runId) {
      await db.update('sync_run', { _id: 'eq.' + runId },
        { finished_at: new Date().toISOString(), ok: false, ms, error: String(e.message).slice(0, 500), ...stat })
        .catch(() => {});
    }
    return { ok: false, ms, error: e.message, ...stat };
  }
}

/** สถานะรอบล่าสุดของทุกงานซิงค์ */
const status = () => db.select('v_sync_status', { select: '*' });

module.exports = { syncSheet, status, coerce, hashRow, serialToDate, serialToTs };
