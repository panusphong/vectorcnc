'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/files.js — ตัวกลางเรื่องรูปตัวเดียวของทั้งระบบ
 *
 *  ‼ ทุกแอปเรียกตัวนี้ ห้ามเขียนโค้ดดึงรูปเองซ้ำในแต่ละโมดูล
 *    รูปพนักงาน · รูปหน้างาน · CheckList · สลิป · รูปสินค้า
 *    เปลี่ยนแค่ kind — ที่เหลือเหมือนกันหมด
 *
 *  ═══ ทางเดินของรูปหนึ่งใบ ═══
 *
 *    ค่าในชีต            สารบัญ          คลังของเรา         จอ
 *    "User_Images/       drive_index     file_cache      CDN
 *     abc.jpg"      ──▶  (ชื่อ→ไอดี) ──▶ (ไอดี→URL)  ──▶  เร็ว
 *                         ไม่ยิง Google   ยิงครั้งแรก
 *                                        ครั้งเดียว
 *
 *  ═══ ทำไมถึงออกแบบแบบนี้ ═══
 *
 *  1) สารบัญ (drive_index) แก้ปัญหา "path ไม่มีไอดีอยู่ในตัว"
 *     เดินอ่านทั้งโฟลเดอร์ครั้งเดียว 1,000 ไฟล์ต่อคำขอ
 *     แทนที่จะค้นทีละไฟล์ = 1 คำขอต่อ 1 รูป (พังเมื่อรูปเป็นหมื่น)
 *
 *  2) ดึงตอนถูกเรียกครั้งแรก (lazy) แก้ปัญหา "รูปเยอะเกินจะดึงล่วงหน้า"
 *     รูปหน้างานมีเป็นหมื่นใบ แต่คนเปิดดูจริงไม่กี่ร้อย
 *     ดึงเฉพาะใบที่มีคนเปิด — ครั้งแรกช้านิดเดียว ครั้งต่อไปเร็วจาก CDN
 *
 *  3) Drive ยังเป็นต้นทางเสมอ ของในถังเป็นแค่ก๊อปปี้
 *     ลบทิ้งเมื่อไหร่ก็ดึงใหม่ได้ ไม่มีข้อมูลหาย
 *
 *  ‼ อ่านอย่างเดียวตลอดเส้นทาง — scope เป็น drive.readonly
 *    ต่อให้โค้ดพลาด Google ก็ปฏิเสธการลบ/แก้ไฟล์ต้นทางให้เอง
 * ═══════════════════════════════════════════════════════════════════ */
const db = require('./db');
const drive = require('./drive');
const storage = require('./storage');
const Shrink = require('./imgshrink');

const clean = s => String(s == null ? '' : s).trim();

const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
              'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' };

/** ชื่อไฟล์ในถัง — ใช้ไอดีของ Drive เป็นชื่อ ไม่ซ้ำแน่นอนและไล่ย้อนได้ */
const pathOf = (kind, driveId, mime) =>
  `${kind || 'misc'}/${driveId}.${EXT[String(mime).split(';')[0].toLowerCase()] || 'jpg'}`;

/* ── กันดึงซ้ำซ้อน ──────────────────────────────────────────────
 *  หน้าเว็บหน้าเดียวอาจมี <img> ชี้รูปเดียวกัน 5 จุด เบราว์เซอร์ยิงมาพร้อมกัน
 *  ถ้าไม่กัน จะโหลดจาก Drive 5 รอบพร้อมกันโดยเปล่าประโยชน์
 *  ตัวนี้ให้คำขอที่มาทีหลังรอผลของคำขอแรกแทน */
const _inflight = new Map();

/* ── แคชในหน่วยความจำ ───────────────────────────────────────────
 *  ค่าในชีต → URL — ตัดการยิงฐานข้อมูลซ้ำสำหรับรูปที่เพิ่งเปิดไป */
const MEM_MS = 10 * 60 * 1000;
const _mem = new Map();
const memGet = k => { const h = _mem.get(k);
                      return h && Date.now() < h.exp ? h.v : undefined; };
const memPut = (k, v) => { if (_mem.size > 5000) _mem.clear();
                           _mem.set(k, { v, exp: Date.now() + MEM_MS }); };

/* ═══════════════════ 1. สารบัญ ═══════════════════ */

/**
 * เดินสารบัญ Drive เข้าตาราง app.drive_index
 *
 * @param {string} o.folderId  เดินเฉพาะโฟลเดอร์นี้ลงไปทุกชั้น
 *                             ‼ ไม่ระบุ = เดินจากโฟลเดอร์แม่ของ AppSheet
 *                             ใส่ 'ทั้งไดรฟ์' ถ้าอยากกวาดทุกรูปที่มองเห็นแบบเดิม
 * @param {number} o.max       เพดานจำนวนไฟล์ต่อรอบ (กันรอบนานเกิน)
 *
 * ‼ นี่คือส่วนที่แก้ปัญหาใหญ่สุด — ยิง Google แค่ n/1000 ครั้ง
 *   ไม่ใช่ n ครั้ง จึงรองรับรูปเป็นหมื่นได้จริง
 *
 * ‼ พี่เอสั่ง 6 ก.ย. 69: "เดี๋ยวพี่แชร์ folder เดียวเลย ... จบเลย
 *   ไม่ต้องไปยุ่งกับ sheet แล้วไง"
 *   ค่าตั้งต้นจึงเป็นโฟลเดอร์แม่ของ AppSheet ไม่ใช่กวาดทั้งไดรฟ์ เพราะ
 *     · เดินจากแม่ = ได้โฟลเดอร์ลูกครบทุกอัน และรู้ชื่อโฟลเดอร์แม่ไปในตัว
 *       (กวาดทั้งไดรฟ์ต้องยิงถามชื่อโฟลเดอร์ทีหลังอีกรอบ)
 *     · ไม่หยิบไฟล์อื่นในไดรฟ์ที่ไม่เกี่ยวกับงานเข้ามาปนสารบัญ
 *     · ไม่ต้องอ่านชีต ไม่ต้องรันสคริปต์ในแอปเดิม ไม่ต้องแชร์ทีละโฟลเดอร์
 */
async function reindex({ folderId = '', max = 100000, log = null } = {}) {
  const t0 = Date.now();
  const say = log || (() => {});
  let saved = 0;

  /* '' → โฟลเดอร์แม่ที่ตั้งไว้ · 'ทั้งไดรฟ์' → กวาดทุกรูปที่มองเห็น (ของเดิม)
   * ‼ รองรับหลายโฟลเดอร์ เพราะ appsheet/data มีโฟลเดอร์แอปหลายตัว */
  const ทั้งไดรฟ์ = String(folderId).trim() === 'ทั้งไดรฟ์';
  const targets = ทั้งไดรฟ์ ? []
    : (String(folderId).trim()
        ? String(folderId).split(',').map(s => s.trim()).filter(Boolean)
        : drive.rootFolderIds());

  /* ลงตารางเป็นชุด ๆ ระหว่างเดิน ไม่กองไว้จนจบ
   *   ถ้ารอบนี้ขาดกลางคัน ของที่เดินไปแล้วก็ยังอยู่ รอบหน้าเดินต่อได้ */
  const onBatch = async rows => {
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 500) {
      await db.upsert('drive_index', rows.slice(i, i + 500), 'drive_id');
      saved += Math.min(500, rows.length - i);
    }
  };

  let r = { files: 0, folders: 0, calls: 0 };
  /* ‼ โฟลเดอร์ไหนเดินไม่ได้ ต้องรายงานรายตัว ไม่ใช่ล้มทั้งรอบ
   *   แชร์มา 5 ตัว ลืมตัวเดียว ก็ยังควรได้ของอีก 4 ตัว */
  const พัง = [];
  try {
    if (!targets.length) {
      r = await drive.crawlImages({ onBatch, max, log: say });
    } else {
      for (const id of targets) {
        try {
          const one = await drive.crawlFolder(id, { onBatch, max, log: say });
          r.files += one.files; r.folders += one.folders; r.calls += one.calls;
        } catch (e) {
          พัง.push({ โฟลเดอร์: id, error: e.message });
          say(`โฟลเดอร์ ${id} เดินไม่ได้ — ${e.message}`);
        }
      }
    }
  } catch (e) {
    return { ok: false, error: e.message, saved, targets, ms: Date.now() - t0 };
  }

  /* เดินแบบไม่ระบุโฟลเดอร์จะไม่รู้ชื่อโฟลเดอร์แม่ — เติมให้ทีหลัง
   * ชื่อโฟลเดอร์คือตัวแก้ปัญหาชื่อไฟล์ซ้ำ จึงคุ้มที่จะยิงเพิ่มอีกไม่กี่ครั้ง
   * ‼ เดินจากโฟลเดอร์แม่ไม่ต้องทำขั้นนี้ — รู้ชื่อตั้งแต่ตอนเดินแล้ว */
  let named = 0;
  if (!targets.length) named = await fillFolderNames(say);

  /* ‼ เดินได้ 0 ไฟล์ ต้องบอกสาเหตุที่พบบ่อยที่สุด ไม่ใช่ปล่อยให้เดา
   *   (สาเหตุอันดับหนึ่ง: ยังไม่ได้แชร์โฟลเดอร์ให้บัญชีระบบ) */
  const เตือน = (targets.length && !r.files)
    ? 'เดินได้ 0 ไฟล์ — เกือบทั้งหมดคือยังไม่ได้แชร์โฟลเดอร์นี้ให้บัญชีระบบ'
    : (พัง.length ? `เดินไม่ได้ ${พัง.length} โฟลเดอร์` : null);

  return { ok: true, ...r, saved, folderNamesFilled: named, targets,
           เดินไม่ได้: พัง, เตือน,
           ms: Date.now() - t0,
           note: `ยิง Google ${r.calls} ครั้ง สำหรับ ${r.files} ไฟล์` };
}

/** เติมชื่อโฟลเดอร์แม่ให้แถวที่ยังว่าง (ยิงครั้งเดียวต่อโฟลเดอร์ ไม่ใช่ต่อไฟล์) */
async function fillFolderNames(log = () => {}) {
  const rows = await db.selectAll('drive_index', {
    select: 'parent_id', parent_name: 'is.null', parent_id: 'not.is.null',
    order: 'drive_id.asc' }).catch(() => []);
  const ids = [...new Set((rows || []).map(r => r.parent_id).filter(Boolean))];
  if (!ids.length) return 0;

  log(`เติมชื่อโฟลเดอร์ ${ids.length} โฟลเดอร์`);
  const names = await drive.folderNames(ids);
  let n = 0;
  for (const [id, name] of names) {
    if (!name) continue;
    await db.update('drive_index', { parent_id: 'eq.' + id }, { parent_name: name })
      .catch(() => {});
    n++;
  }
  return n;
}

/* ═══════════════════ 2. ค่าในชีต → ไอดีไฟล์ ═══════════════════ */

/**
 * แปลงค่าในช่องรูป (path / ลิงก์ / ไอดี / สูตร =IMAGE) เป็นไอดีไฟล์ใน Drive
 *
 * ลำดับการหา — ถูกที่สุดก่อนเสมอ
 *   1. แกะจากตัวค่าเอง (ลิงก์/ไอดี)  → ฟรี ไม่ยิงอะไรเลย
 *   2. ค้นในสารบัญ                   → 1 คำขอฐานข้อมูล
 *   3. ค้นใน Drive ทีละไฟล์          → ยิง Google (ทางสุดท้ายจริง ๆ)
 *      แล้วจดลงสารบัญไว้ ครั้งหน้าจะไม่ต้องยิงอีก
 */
async function driveIdOf(raw) {
  const s = clean(raw);
  if (!s) return '';

  const direct = drive.fileIdOf(s.replace(/^.*"([^"]+)".*$/, '$1'));
  if (direct) return direct;

  try {
    const hit = await db.rpc('drive_id_of', { p_raw: s });
    const id = clean(Array.isArray(hit) ? hit[0] : hit);
    if (id) return id;
  } catch { /* ยังไม่ได้รัน sql/21 — ตกไปใช้ทางเดิม */ }

  const found = await drive.resolveId(s);
  if (found) {
    /* จดลงสารบัญ ครั้งหน้าจะเจอตั้งแต่ขั้นที่ 2 ไม่ต้องยิง Google อีก */
    try {
      const m = await drive.meta(found);
      if (m) await db.upsert('drive_index', [drive.rowOf(m, null)], 'drive_id');
    } catch { /* จดไม่ได้ก็ไม่เป็นไร แค่ครั้งหน้าต้องยิงใหม่ */ }
  }
  return found || '';
}

/* ═══════════════════ 3. ไอดี → URL ที่แสดงได้ ═══════════════════ */

/**
 * รับรองว่ารูปใบนี้อยู่ในคลังแล้ว — ดึงจาก Drive ให้ถ้ายังไม่มี
 *
 * @returns {{url:string, driveId:string, cached:boolean}}
 * @throws  ถ้าหาไฟล์ไม่เจอหรือโหลดไม่ได้ (ข้อความไทยบอกสาเหตุชัด)
 *
 * ‼ นี่คือหัวใจของ "ดึงตอนถูกเรียก" — รูปที่ไม่มีใครเปิดจะไม่ถูกดึงเลย
 *   ทำให้รองรับรูปเป็นหมื่นได้โดยไม่ต้องดึงล่วงหน้าทั้งหมด
 */
async function ensure(raw, { kind = 'misc', ownerKey = null, force = false } = {}) {
  const s = clean(raw);
  if (!s) throw new Error('ไม่มีค่าในช่องรูป');

  const memKey = kind + ' ' + s;
  if (!force) {
    const m = memGet(memKey);
    if (m) return { url: m, driveId: '', cached: true };
  }

  const key = 'ensure:' + memKey;
  if (_inflight.has(key)) return _inflight.get(key);

  const job = (async () => {
    const id = await driveIdOf(s);
    if (!id) throw new Error(s.includes('/')
      ? 'ค้นชื่อไฟล์นี้ใน Drive ไม่เจอ — โฟลเดอร์นี้อาจยังไม่ได้แชร์ให้บัญชีระบบ ' +
        'หรือยังไม่ได้เดินสารบัญ (กด "อัปเดตสารบัญ Drive")'
      : 'อ่านไอดีไฟล์จากค่านี้ไม่ได้');

    if (!force) {
      const hit = await db.one('file_cache',
        { drive_id: 'eq.' + id, select: 'drive_id,url' }).catch(() => null);
      if (hit && hit.url) { memPut(memKey, hit.url);
                            return { url: hit.url, driveId: id, cached: true }; }
    }

    const f = await drive.download(id);
    if (!/^image\//.test(f.mime))
      throw new Error('ไฟล์นี้ไม่ใช่รูปภาพ (' + f.mime + ')');

    /* 🗜 3 พ.ย. 69 เดิมเก็บรูปต้นฉบับจาก Drive ลงถังตรง ๆ (หลาย MB) ⇒ ทุกครั้งที่เปิดดู = egress เต็มขนาด
     *   ย่อก่อนเก็บ: รูปโปรไฟล์ ≤ 40 KB · อื่น ๆ ≤ 150 KB · ที่อยู่ผูกกับรหัสไฟล์ Drive ⇒ จำ 1 ปี */
    const sm = await Shrink.shrink(f.buf, kind === 'avatar' ? Shrink.PRESET.avatar : Shrink.PRESET.photo);
    const outBuf = sm.changed ? sm.buf : f.buf, outMime = sm.changed ? sm.mime : f.mime;
    const up = await storage.upload(pathOf(kind, id, outMime), outBuf, outMime, { shrink: false, immutable: true });
    await db.upsert('file_cache', [{
      drive_id: id, path: up.path, url: up.url, mime: outMime, bytes: up.bytes,
      source_name: s.slice(0, 200), owner_key: ownerKey, kind,
      synced_at: new Date().toISOString(), error: null,
    }], 'drive_id').catch(() => {});

    memPut(memKey, up.url);
    return { url: up.url, driveId: id, cached: false };
  })().finally(() => _inflight.delete(key));

  _inflight.set(key, job);
  return job;
}

/** URL ของรูป ถ้าอยู่ในคลังแล้ว — ไม่แตะ Drive เลย (คืน '' ถ้ายังไม่มี) */
async function urlOf(raw) {
  const s = clean(raw);
  if (!s) return '';
  try {
    const r = await db.rpc('file_url', { p_raw: s });
    return clean(Array.isArray(r) ? r[0] : r);
  } catch { return ''; }
}

/**
 * ดึงรูปเป็นชุด — ใช้ตอนรู้ล่วงหน้าว่าจะต้องใช้รูปกลุ่มไหน
 * (เช่น รูปพนักงานทั้งบริษัท ซึ่งมีไม่กี่สิบใบ)
 *
 * ‼ อย่าใช้กับรูปหลักหมื่น — ปล่อยให้ ensure() ดึงตอนถูกเรียกดีกว่า
 */
async function warm(list, { kind = 'misc', limit = 500, log = null } = {}) {
  const say = log || (() => {});
  const out = { done: 0, cached: 0, failed: 0, items: [] };
  for (const it of (list || []).slice(0, limit)) {
    const raw = clean(it && (it.raw !== undefined ? it.raw : it));
    const owner = it && it.ownerKey ? clean(it.ownerKey) : null;
    if (!raw) { out.failed++; continue; }
    try {
      const r = await ensure(raw, { kind, ownerKey: owner });
      r.cached ? out.cached++ : out.done++;
      out.items.push({ raw: raw.slice(0, 90), owner, url: r.url, cached: r.cached });
    } catch (e) {
      out.failed++;
      out.items.push({ raw: raw.slice(0, 90), owner, error: e.message });
      /* จดไว้ว่าใบนี้ดึงไม่ได้เพราะอะไร จะได้ตอบคำถาม "ทำไมรูปไม่ขึ้น" ได้ */
      await db.upsert('file_cache', [{
        drive_id: 'x-' + kind + '-' + (owner || raw).slice(0, 60),
        path: '', url: '', kind, owner_key: owner, source_name: raw.slice(0, 200),
        synced_at: new Date().toISOString(), error: e.message,
      }], 'drive_id').catch(() => {});
    }
    say(`${out.done + out.cached + out.failed}/${Math.min(list.length, limit)}`);
  }
  return out;
}

/** ล้างแคชในหน่วยความจำ (ใช้ตอนเปลี่ยนรูปแล้วอยากเห็นทันที) */
const clearMem = () => { _mem.clear(); };

/* 🗜 3 พ.ย. 69 ย่อรูปที่เก็บในถังไปแล้ว (ต้นฉบับจาก Drive) — ดึงจาก Drive ใหม่ (ไม่กิน egress ของ Supabase) แล้วเก็บตัวเล็กแทน */
async function slimCached({ limit = 500, pauseMs = 600, log = () => {} } = {}) {
  const over = (Shrink.PRESET.photo.maxKb + 2) * 1024, overAv = (Shrink.PRESET.avatar.maxKb + 1) * 1024;
  const rows = await db.selectAll('file_cache', { select: 'drive_id,path,url,mime,bytes,kind', bytes: 'gt.' + overAv, order: 'bytes.desc', limit }) || [];
  let done = 0, saved = 0, failed = 0, skipped = 0;
  for (const r of rows) {
    const preset = r.kind === 'avatar' ? Shrink.PRESET.avatar : Shrink.PRESET.photo;
    if (r.kind !== 'avatar' && Number(r.bytes) <= over) { skipped++; continue; }
    try {
      const f = await drive.download(r.drive_id);
      const sm = await Shrink.shrink(f.buf, preset);
      if (!sm.changed) { skipped++; continue; }
      const up = await storage.upload(pathOf(r.kind || 'misc', r.drive_id, sm.mime), sm.buf, sm.mime, { shrink: false, immutable: true });
      await db.update('file_cache', { drive_id: 'eq.' + r.drive_id }, { path: up.path, url: up.url, mime: sm.mime, bytes: sm.buf.length, synced_at: new Date().toISOString() });
      if (r.path && r.path !== up.path) await storage.remove(r.path).catch(() => {});
      done++; saved += (Number(r.bytes) || 0) - sm.buf.length;
    } catch (e) { failed++; log('[img-slim] ' + r.kind + ' ' + r.drive_id + ': ' + ((e && e.message) || e)); }
    if (pauseMs) await new Promise(rs => setTimeout(rs, pauseMs));
  }
  if (done) clearMem();
  return { found: rows.length, done, failed, skipped, savedBytes: saved };
}

module.exports = { reindex, fillFolderNames, driveIdOf, ensure, urlOf, warm,
                   pathOf, clearMem, slimCached };
