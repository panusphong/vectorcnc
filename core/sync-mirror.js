'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/sync-mirror.js — ดึง "ทุกแท็บ" เข้ากระจกรวม app.sheet_rows
 *
 *  ต่างจาก core/sync.js ตรงไหน
 *    sync.js       ต้องรู้ล่วงหน้าว่ามีคอลัมน์อะไร ชนิดอะไร → ได้ตารางจริงที่ใช้งานได้เลย
 *    sync-mirror.js ไม่ต้องรู้อะไรเลย เก็บทั้งแถวเป็น jsonb → ได้ข้อมูลครบไว้ก่อน
 *
 *  ใช้คู่กัน ไม่ใช่แทนกัน:
 *    แท็บที่แอปใหม่ใช้จริง → ตารางจริง (typed)
 *    แท็บที่เหลือ         → กระจก (jsonb) กันข้อมูลหายระหว่างทยอยย้าย
 *
 *  บทเรียนที่ทำให้ต้องมีตัวนี้: เราเดาหัวตารางผิดไปแล้วสองแท็บ
 *  (Channel · ActivityLog) แล้วเสียเวลาไปหนึ่งรอบเต็ม ๆ
 *  ตัวนี้ไม่เดาอะไรเลย จึงเดาผิดไม่ได้
 * ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const db = require('./db');
const sheets = require('./sheets');
const sheetFiles = require('./sheet-files');

const T = 'sheet_rows';
const SENS = 'sensitive_rows';     // ตารางจำกัดสิทธิ์ — เปิด RLS ไว้ anon อ่านไม่ได้

const hashOf = obj => crypto.createHash('md5')
  .update(JSON.stringify(obj)).digest('hex').slice(0, 16);

/** ค่าที่ถือว่า "ว่าง" — ไม่เก็บลง jsonb ให้รก */
const isBlank = v => v === '' || v === null || v === undefined;

/**
 * ดึง 1 แท็บเข้ากระจก
 *
 * @param {object} job
 *   fileKey · sheetId · tab · log
 *   maxRows  จำกัดจำนวนแถว (กันแท็บที่ใหญ่เกินคาดกินเวลาทั้งรอบ)
 */
async function syncTab(job) {
  const t0 = Date.now();
  const log = job.log || (() => {});
  const source = `${job.fileKey}/${job.tab}`;
  const stat = { rows_read: 0, rows_new: 0, rows_upd: 0, rows_same: 0, rows_del: 0 };
  let runId = null;
  let secretCount = 0;      // แยกจาก stat เพราะ sync_run ไม่มีคอลัมน์นี้

  try {
    const started = await db.insert('sync_run', {
      source: 'กระจก:' + source, started_at: new Date().toISOString(),
    });
    runId = Array.isArray(started) && started[0] ? started[0]._id : null;
  } catch { /* จดไม่ได้ก็ทำงานต่อ */ }

  try {
    const { header, rows } = await sheets.readTab(job.sheetId, job.tab);
    if (!header.length) {
      log('แท็บว่าง ข้ามไป');
      if (runId) await db.update('sync_run', { _id: 'eq.' + runId },
        { finished_at: new Date().toISOString(), ok: true, ms: Date.now() - t0, note: 'แท็บว่าง' })
        .catch(() => {});
      return { ok: true, ms: Date.now() - t0, note: 'แท็บว่าง', ...stat };
    }

    /* หัวตารางซ้ำกันได้จริงในชีต — เติมเลขต่อท้ายไม่ให้ทับกันใน jsonb */
    const names = [];
    const used = new Map();
    header.forEach((h, i) => {
      let name = String(h == null ? '' : h).trim() || `คอลัมน์ ${i + 1}`;
      if (used.has(name)) {
        const n = used.get(name) + 1;
        used.set(name, n);
        name = `${name} (${n})`;
      } else used.set(name, 1);
      names.push(name);
    });

    /* คอลัมน์อ่อนไหว — เก็บครบ แต่แยกไปอยู่ app.sensitive_rows
     *
     * พี่เอสั่งให้เอาเข้ามาให้หมด (4 ก.ย. 69) — เอาเข้ามาจริง ไม่ตัดทิ้ง
     * แต่ไม่กองรวมในตารางเดียวกับข้อมูลทั่วไป เพราะเผลอ SELECT * แล้ว
     * เลขบัตรประชาชนโผล่ในรายงาน/log ไม่ได้
     *
     * ตารางนั้นเปิด RLS ไว้โดยไม่มี policy → anon อ่านไม่ได้เลยแม้แต่แถวเดียว */
    const redacted = names.filter(sheetFiles.isSensitiveColumn);
    const redactSet = new Set(redacted);
    if (redacted.length)
      log('🔒 แยกคอลัมน์อ่อนไหว ' + redacted.length + ' ช่อง ไปตารางจำกัดสิทธิ์: ' + redacted.join(', '));

    const limit = job.maxRows && rows.length > job.maxRows ? job.maxRows : rows.length;
    stat.rows_read = limit;
    if (limit < rows.length)
      log(`⚠ แท็บนี้มี ${rows.length} แถว ดึงมา ${limit} แถวแรกก่อน`);

    /* ของเดิมในกระจก — ต้องอ่านให้ครบทุกหน้า (Supabase ตัดที่ 1,000) */
    const existing = new Map();
    const cur = await db.selectAll(T, {
      select: '_row,_hash', source: 'eq.' + source, order: '_row.asc',
    });
    for (const r of cur || []) existing.set(Number(r._row), r._hash);

    const toInsert = [], toUpdate = [];
    const secretRows = [];                             // ไปตารางจำกัดสิทธิ์
    const seen = new Set();

    for (let i = 0; i < limit; i++) {
      const raw = rows[i] || [];
      if (!raw.some(v => !isBlank(v))) continue;      // แถวว่างล้วน
      const sheetRow = i + 2;                          // แถว 1 = หัวตาราง
      seen.add(sheetRow);

      const data = {}, secret = {};
      for (let c = 0; c < names.length; c++) {
        const name = names[c];
        const v = raw[c];
        if (isBlank(v)) continue;
        if (redactSet.has(name)) secret[name] = v; else data[name] = v;
      }

      /* ลายนิ้วมือคิดจากทั้งสองฝั่ง — แก้เฉพาะช่องอ่อนไหวก็ต้องรู้ว่าเปลี่ยน */
      const h = hashOf({ d: data, s: secret });
      if (Object.keys(secret).length) {
        secretRows.push({
          source, file_key: job.fileKey, tab: job.tab, _row: sheetRow,
          _synced_at: new Date().toISOString(), data: secret,
        });
      }
      if (existing.get(sheetRow) === h) { stat.rows_same++; continue; }

      const row = {
        source, file_key: job.fileKey, sheet_id: job.sheetId, tab: job.tab,
        _row: sheetRow, _hash: h, _synced_at: new Date().toISOString(),
        data, redacted: redacted.length ? redacted : null,
      };
      if (existing.has(sheetRow)) toUpdate.push(row); else toInsert.push(row);
    }

    const CHUNK = 200;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      await db.insert(T, toInsert.slice(i, i + CHUNK));
      stat.rows_new += Math.min(CHUNK, toInsert.length - i);
    }
    for (const row of toUpdate) {
      const { source: s, _row, ...rest } = row;
      await db.update(T, { source: 'eq.' + s, _row: 'eq.' + _row }, rest);
      stat.rows_upd++;
    }

    /* ช่องอ่อนไหว → ตารางจำกัดสิทธิ์ (เขียนใหม่ทั้งแท็บ ง่ายและไม่มีทางค้าง)
     *
     * ‼ ล้างก่อนเขียนเสมอ — ถ้าคนลบเลขบัญชีออกจากชีต ของเก่าต้องหายตามด้วย
     *   ข้อมูลแบบนี้ "ค้างอยู่ทั้งที่เจ้าตัวลบไปแล้ว" เป็นปัญหา ไม่ใช่ฟีเจอร์ */
    if (redacted.length) {
      await db.remove(SENS, { source: 'eq.' + source }).catch(() => {});
      const SCHUNK = 200;
      for (let i = 0; i < secretRows.length; i += SCHUNK) {
        await db.insert(SENS, secretRows.slice(i, i + SCHUNK));
      }
      secretCount = secretRows.length;
      log('🔒 เก็บช่องอ่อนไหว ' + secretCount + ' แถวไว้ในตารางจำกัดสิทธิ์');
    }

    /* แถวที่หายจากชีต = ถูกลบ → ลบตาม (เฉพาะช่วงที่เราดึงมาจริง) */
    if (limit >= rows.length) {
      for (const [rowNo] of existing) {
        if (!seen.has(rowNo)) {
          await db.remove(T, { source: 'eq.' + source, _row: 'eq.' + rowNo });
          await db.remove(SENS, { source: 'eq.' + source, _row: 'eq.' + rowNo }).catch(() => {});
          stat.rows_del++;
        }
      }
    }

    const ms = Date.now() - t0;
    log(`เสร็จ · อ่าน ${stat.rows_read} · ใหม่ ${stat.rows_new} · แก้ ${stat.rows_upd} · เท่าเดิม ${stat.rows_same} · ลบ ${stat.rows_del} · ${ms}ms`);
    if (runId) await db.update('sync_run', { _id: 'eq.' + runId },
      { finished_at: new Date().toISOString(), ok: true, ms, ...stat }).catch(() => {});
    return { ok: true, ms, columns: names.length, redacted, secret: secretCount, ...stat };

  } catch (e) {
    const ms = Date.now() - t0;
    log('❌ ล้มเหลว:', e.message);
    if (runId) await db.update('sync_run', { _id: 'eq.' + runId },
      { finished_at: new Date().toISOString(), ok: false, ms,
        error: String(e.message).slice(0, 500), ...stat }).catch(() => {});
    return { ok: false, ms, error: e.message, ...stat };
  }
}

/**
 * สำรวจทุกแท็บในทุกไฟล์ แล้วจดลง app.sheet_catalog
 * ไม่ดึงข้อมูล — แค่ถาม Google ว่ามีแท็บอะไรบ้าง และหัวตารางเขียนว่าอะไร
 */
async function discover(opts = {}) {
  const log = opts.log || (() => {});
  const typedTabs = opts.typedTabs || new Map();   // 'filekey/tab' → ชื่องานซิงค์
  const out = [];

  for (const f of sheetFiles.files()) {
    let tabs;
    try {
      tabs = await sheets.listTabs(f.id);
    } catch (e) {
      out.push({ file_key: f.key, file_title: f.title, error: e.message });
      log(`❌ ${f.title}: ${e.message}`);
      continue;
    }

    const rows = [];
    for (const t of tabs) {
      const skip = sheetFiles.shouldSkip(t.title);
      let headers = [];
      if (!skip) {
        try {
          const head = await sheets.readHead(f.id, t.title, 2);
          headers = head.header.filter(Boolean);
        } catch (e) { headers = []; }
      }
      const covered = typedTabs.get(`${f.key}/${t.title}`) || null;
      rows.push({
        file_key: f.key, sheet_id: f.id, tab: t.title, file_title: f.title,
        rows_est: t.rows || null, cols_est: t.cols || null,
        headers: headers.length ? headers : null,
        covered_by: covered,
        mirror: !skip && !covered,
        note: skip ? 'ข้ามตามกฎ (ข้อมูลชั่วคราวของแอปเดิม)' : null,
        seen_at: new Date().toISOString(),
      });
    }

    /* จดลงทะเบียน — เขียนทับของเดิมทีละแท็บ */
    for (const r of rows) {
      await db.remove('sheet_catalog', { file_key: 'eq.' + r.file_key, tab: 'eq.' + r.tab })
        .catch(() => {});
    }
    if (rows.length) await db.insert('sheet_catalog', rows).catch(e =>
      log('จดทะเบียนแท็บไม่สำเร็จ: ' + e.message));

    out.push({ file_key: f.key, file_title: f.title, sensitive: !!f.sensitive, tabs: rows });
    log(`${f.title}: ${rows.length} แท็บ · ดึงเข้ากระจก ${rows.filter(r => r.mirror).length}`);
  }
  return out;
}

/** งานซิงค์กระจกทั้งหมด — อ่านจากทะเบียนที่สำรวจไว้ */
async function mirrorJobs() {
  const cat = await db.selectAll('sheet_catalog', {
    select: 'file_key,sheet_id,tab,rows_est,mirror,covered_by', order: 'rows_est.desc.nullslast',
  });
  return (cat || [])
    .filter(c => c.mirror && !c.covered_by)
    .map(c => ({
      name: 'กระจก:' + c.file_key + '/' + c.tab,
      title: c.tab,
      fileKey: c.file_key, sheetId: c.sheet_id, tab: c.tab,
      table: 'sheet_rows',
    }));
}

module.exports = { syncTab, discover, mirrorJobs };
