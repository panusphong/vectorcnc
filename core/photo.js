'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/photo.js — รูปพนักงาน แบบที่ "ไม่มีชีตก็อยู่ได้"
 *
 *  ‼ พี่เอสั่ง 5 ก.ย. 69:
 *    "หากไม่มี sheet ให้ดึงข้อมูลจะต้องทำแบบไหน เพราะเดี๋ยวพี่จะปิด
 *     ไม่ให้ดึงข้อมูลจาก sheet แล้วนะ ... แล้วใช้แบบนั้นทันที"
 *
 *  ── หลักคิด ───────────────────────────────────────────────────
 *  ถามตัวเองข้อเดียว: "ถ้าพรุ่งนี้ชีตหายไปเลย รูปยังขึ้นไหม"
 *
 *  คำตอบต้องเป็น "ขึ้น" ทุกกรณี ดังนั้นเส้นทางตอนแสดงผลห้ามแตะ
 *  ชีตหรือ Drive แม้แต่ครั้งเดียว
 *
 *      ตอนแสดงผล   app.user_photo ──▶ Storage CDN ──▶ หน้าเว็บ
 *                   (อ่านตารางล้วน ไม่มีคำขอออกนอกบ้านเลย)
 *
 *      ตอนใส่รูป    อัปโหลดจากในแอป ──▶ Storage ──▶ user_photo
 *                   (ทางถาวร ใช้ตลอดไป แทนการไปแก้ในชีต)
 *
 *      ตอนย้ายของ   ชีต/Drive ──▶ Storage ──▶ user_photo
 *                   (ทางชั่วคราว รันครั้งเดียว แล้วไม่ต้องใช้อีก)
 *
 *  ‼ ข้อสำคัญ: การย้ายของเป็น "งานครั้งเดียว" ไม่ใช่ "ทางที่ระบบพึ่ง"
 *    วันที่พี่เอปิดชีต ให้ตั้ง PHOTO_IMPORT=off เท่านั้น
 *    ไม่ต้องแก้โค้ดสักบรรทัด เพราะเส้นทางแสดงผลไม่เคยพึ่งชีตอยู่แล้ว
 *
 *  ‼ รูปอื่นทั้งหมด (หน้างาน · CheckList · สลิป) ใช้แนวเดียวกันนี้ได้เลย
 *    เปลี่ยนแค่ตารางปลายทางกับโฟลเดอร์ในถัง
 * ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const db = require('./db');
const storage = require('./storage');
const Shrink = require('./imgshrink');

const clean = s => String(s == null ? '' : s).trim();

/* เปิด/ปิดทางย้ายของจากชีต — วันที่ปิดชีตแล้วตั้งเป็น off ได้เลย */
const IMPORT_ON = String(process.env.PHOTO_IMPORT || 'on').toLowerCase() !== 'off';

/* ═══════════════════════════════════════════════════════════════════
 *  ‼ ตรวจว่าเป็นรูปจริง ด้วย "ไบต์ต้นไฟล์" ไม่ใช่เชื่อนามสกุลหรือ mime
 *
 *  นามสกุลกับ Content-Type ผู้ส่งพิมพ์อะไรมาก็ได้ ปลอมง่ายมาก
 *  ถ้าเชื่อตามนั้น จะกลายเป็นช่องให้อัปไฟล์อะไรก็ได้ขึ้นถังสาธารณะ
 *  ไบต์ต้นไฟล์ปลอมยากกว่ามาก และเป็นวิธีเดียวที่บอกได้ว่า "มันคือรูปจริง"
 * ═══════════════════════════════════════════════════════════════════ */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { mime: 'image/png', ext: 'png' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP')
    return { mime: 'image/webp', ext: 'webp' };
  if (buf.slice(0, 6).toString('ascii') === 'GIF89a' ||
      buf.slice(0, 6).toString('ascii') === 'GIF87a') return { mime: 'image/gif', ext: 'gif' };
  return null;
}

const MAX_BYTES = 5 * 1024 * 1024;      // รูปโปรไฟล์ 5MB เหลือเฟือแล้ว

/** แกะ data URL หรือ base64 เปล่า ๆ ให้เป็น Buffer */
function bufOf(input) {
  if (Buffer.isBuffer(input)) return input;
  const s = clean(input);
  if (!s) return null;
  const b64 = s.startsWith('data:') ? s.replace(/^data:[^;]*;base64,/, '') : s;
  try { return Buffer.from(b64, 'base64'); } catch { return null; }
}

/** ชื่อไฟล์ในถัง — ตายตัวต่อคน อัปทับได้เรื่อย ๆ ไม่มีขยะค้าง */
const pathOf = (username, ext, tag) =>
  `avatars/${String(username).replace(/[^A-Za-z0-9_.-]/g, '_')}${tag ? '-' + tag : ''}.${ext}`;

/* ═══════════════════════════════════════════════════════════════════
 *  เก็บรูปของคนหนึ่งลงบ้านเรา — ทางเดียวที่รูปเข้าระบบได้
 *
 *  ทั้งการอัปโหลดจากหน้าเว็บ และการย้ายของจาก Drive วิ่งผ่านฟังก์ชันนี้
 *  ตัวเดียวกันหมด จะได้ไม่มีทางลัดที่ข้ามการตรวจไปได้
 * ═══════════════════════════════════════════════════════════════════ */
async function save(username, input, { by = '', source = 'upload', ref = '' } = {}) {
  const user = clean(username);
  if (!user) return { ok: false, error: 'ไม่ได้ระบุว่าเป็นรูปของใคร' };

  const buf = bufOf(input);
  if (!buf || !buf.length) return { ok: false, error: 'ไม่มีข้อมูลรูป' };
  if (buf.length > MAX_BYTES)
    return { ok: false, error: `ไฟล์ใหญ่เกิน ${Math.round(MAX_BYTES / 1048576)} MB ` +
                                `(ได้มา ${(buf.length / 1048576).toFixed(1)} MB)` };

  const kind = sniff(buf);
  if (!kind)
    return { ok: false, error: 'ไฟล์นี้ไม่ใช่รูปภาพ — รับเฉพาะ JPG · PNG · WEBP · GIF' };

  const sha = crypto.createHash('sha256').update(buf).digest('hex');

  /* ‼ รูปเดิมเป๊ะ = ไม่ต้องอัปซ้ำ (กฎ "เหมือนกันไม่ต้องซิงก์" ของพี่เอ)
   *   อัปทับด้วยของเดิมทำให้ updated_at ขยับ แล้วดูเหมือนมีคนเปลี่ยนรูป
   *   ทั้งที่ไม่มีใครเปลี่ยน — ตามประวัติย้อนหลังไม่ได้ */
  const cur = await db.one('user_photo', { username: 'eq.' + user, select: '*' })
    .catch(() => null);
  if (cur && cur.sha256 === sha) return { ok: true, url: cur.url, same: true };

  /* 🗜 3 พ.ย. 69 รูปโปรไฟล์ขึ้นแทบทุกหน้า — เดิมเก็บต้นฉบับ (ถึง 5 MB) ⇒ ทุกครั้งที่เปิดหน้า = egress ของ Supabase เต็มขนาด
   *   ย่อเหลือ ≤ 40 KB · 320 px (วงกลมรูปโปรไฟล์ใหญ่สุดในแอป ~96 px · ชัดบนจอ retina)
   *   ชื่อไฟล์มีรหัสเนื้อรูป ⇒ เบราว์เซอร์จำได้ 1 ปี · เปลี่ยนรูป = ชื่อใหม่ (ไม่ค้างรูปเก่า) */
  const sm = await Shrink.shrink(buf, Shrink.PRESET.avatar);
  const outBuf = sm.changed ? sm.buf : buf, outMime = sm.changed ? sm.mime : kind.mime, outExt = sm.changed ? 'jpg' : kind.ext;
  const up = await storage.upload(pathOf(user, outExt, sha.slice(0, 10)), outBuf, outMime, { shrink: false, immutable: true });

  const row = {
    path: up.path, url: up.url, mime: outMime, bytes: outBuf.length,
    sha256: sha, source, source_ref: clean(ref) || null,
    updated_by: clean(by) || null, updated_at: new Date().toISOString(),
  };

  /* แก้ก่อน ไม่มีค่อยเพิ่ม — ไม่พึ่งพฤติกรรม upsert ของฝั่งเซิร์ฟเวอร์
   * (บทเรียนเดิมจาก peak_state: พึ่ง upsert แล้ววันหนึ่งพังทั้งตัว) */
  const upd = cur
    ? await db.update('user_photo', { username: 'eq.' + user }, row).catch(() => null)
    : null;
  if (!Array.isArray(upd) || !upd.length)
    await db.insert('user_photo', [{ username: user, ...row }]);

  /* ‼ ไฟล์เก่าคนละนามสกุลต้องลบทิ้ง ไม่งั้นค้างในถังตลอดกาล
   *   (เปลี่ยนจาก .png เป็น .jpg แล้วของเก่ายังนอนอยู่) */
  if (cur && cur.path && cur.path !== up.path)
    await storage.remove(cur.path).catch(() => {});

  return { ok: true, url: up.url, bytes: outBuf.length, mime: outMime };
}

/* ═══════════════════════════════════════════════════════════════════
 *  แผนที่ ชื่อ → URL รูป (หน้าเว็บเรียกตัวนี้)
 *
 *  ‼ อ่านตารางล้วน ไม่มีคำขอออกนอกบ้านเลยแม้แต่คำขอเดียว
 *    นี่คือเหตุผลที่ปิดชีตแล้วรูปยังขึ้นเหมือนเดิม
 * ═══════════════════════════════════════════════════════════════════ */
async function map() {
  try {
    const r = await db.rpc('sales_avatars', {});
    return (Array.isArray(r) ? r[0] : r) || {};
  } catch (e) {
    /* 🔴 15 ก.ย. 69 — เดิมบรรทัดนี้เป็น `catch { return {}; }` เปล่า ๆ
     *   ⇒ ฟังก์ชันในฐานหาย / สิทธิ์ไม่ถึง / แคชสกีมาไม่รีเฟรช = ได้ {} เงียบ ๆ
     *     แล้วทุกแอปที่พึ่งตัวนี้ตัวเดียวจะกลายเป็น "อักษรย่อทั้งกระดาน"
     *     โดยไม่มีใครรู้ว่าทำไม (บทเรียน: catch {} เปล่า ๆ คือที่ซ่อนบั๊กที่ดีที่สุด)
     *   ‼ ยังคืน {} เหมือนเดิมทุกกรณี — เปลี่ยนแค่ "พูดออกมา" */
    console.log('[photo] rpc app.sales_avatars() ไม่สำเร็จ:', (e && e.message) || e);
    return {};
  }
}

/* ═══════════════════════════════════════════════════════════════════
 *  🔑 แผนที่ Username → URL รูป — อ่าน "แหล่งจริง" ตรง ๆ ไม่ผ่านฟังก์ชันใด
 *
 *  ‼ พี่เอสั่ง 9 ก.ย. 69 (คำต่อคำ):
 *    "เรื่องรูปน่ะ ไม่ต้องทำการ sync อะไรให้วุ่นวายนะ
 *     ทำแค่ไปดึงรูปตาม username ก็จบแล้ว"
 *
 *  ── ทำไมต้องมีทั้ง map() และ byUser() ───────────────────────────
 *
 *   map()    = ผลของ rpc app.sales_avatars()  ⇒ "แผนที่ชื่อ → url"
 *              กุญแจมีแค่ 3 แบบ (sql/33-avatar-fast.sql):
 *                Username · ชื่อในวงเล็บของ Nickname · Nickname
 *              และเป็น inner join ใน SQL ที่เทียบ
 *                p.username = btrim(u."Username")   ← ตรงตัวพิมพ์เป๊ะ
 *              🔴 ใครที่ตัวพิมพ์ไม่ตรง · Nickname ว่าง · หรือฟังก์ชันในฐาน
 *                ยังเป็นรุ่นเก่า/เรียกไม่ได้ ⇒ "หายไปจากแผนที่เงียบ ๆ"
 *
 *   byUser() = อ่าน app.user_photo ตรง ๆ (username → url)
 *              ‼ นี่คือ "คำตอบสุดท้ายว่าใครหน้าตาเป็นยังไง" (sql/23-user-photo.sql)
 *                หน้า "จัดการผู้ใช้" เขียนลงตารางนี้ · แอป Projects อ่านตารางนี้
 *                (modules/projects/images.js:userPhotos — รูปขึ้นครบมาตลอด)
 *              ⇒ มีรูปในระบบเมื่อไหร่ ได้ทันที ไม่ต้องรอใครดีพลอย SQL
 *
 *  ‼ selectAll ไม่ใช่ select — Supabase ตัดที่ 1,000 แถวเงียบ ๆ
 *    พี่เอ: "ต้องไม่มีเพดานสิ ขายของเพิ่มขึ้นทุกวัน"
 *  ‼ กุญแจเก็บเป็น "ตัวพิมพ์เล็ก" — ฝั่ง JS เทียบแบบไม่สนตัวพิมพ์
 *    (วิธีเดียวกับ modules/projects/images.js:userPhotos บรรทัด byUser[uname])
 *  ‼ คำขอเดียวต่อการเรียกหนึ่งครั้ง ไม่ว่าจะมีพนักงานกี่คน
 * ═══════════════════════════════════════════════════════════════════ */
async function byUser() {
  const out = {};
  try {
    const rows = await db.selectAll('user_photo',
      { select: 'username,url', order: 'username.asc' }) || [];
    for (const r of rows) {
      const u = clean(r.username).toLowerCase();
      const url = clean(r.url);
      if (u && url && !out[u]) out[u] = url;
    }
  } catch (e) {
    /* ‼ อ่านไม่ได้ = "ไม่รู้" ไม่ใช่ "ไม่มีรูป" — คืนว่างแล้วให้ทางอื่นทำงานต่อ
     *   แต่ต้องพูดออกมาเสมอ ห้ามเงียบ */
    console.log('[photo] อ่าน app.user_photo ไม่ได้:', (e && e.message) || e);
  }
  return out;
}

/** ของคนเดียว */
async function urlOf(username) {
  const r = await db.one('user_photo',
    { username: 'eq.' + clean(username), select: 'url' }).catch(() => null);
  return r ? r.url : '';
}

/** เอารูปออก (ลบทั้งในถังและในตาราง) */
async function remove(username) {
  const user = clean(username);
  const cur = await db.one('user_photo', { username: 'eq.' + user, select: '*' })
    .catch(() => null);
  if (!cur) return { ok: true, note: 'ไม่มีรูปอยู่แล้ว' };
  await storage.remove(cur.path).catch(() => {});
  await db.remove('user_photo', { username: 'eq.' + user });
  return { ok: true };
}

/* ═══════════════════════════════════════════════════════════════════
 *  ย้ายรูปเข้าบ้าน — งานครั้งเดียว ไม่ใช่ทางที่ระบบพึ่ง
 *
 *  ‼ อ่านจากชีต/Drive ได้เฉพาะตอนนี้ที่ชีตยังอยู่
 *    ย้ายจบแล้วตั้ง PHOTO_IMPORT=off ได้เลย ระบบไม่สะดุดสักนิด
 *    เพราะ map() ข้างบนไม่เคยเรียกฟังก์ชันนี้อยู่แล้ว
 *
 *  ‼ ข้ามคนที่มีรูปในบ้านแล้วเสมอ — รันซ้ำกี่รอบก็ไม่เสียหาย
 *    และ "รูปที่อัปโหลดเองต้องไม่ถูกของเก่าจากชีตทับ" เด็ดขาด
 * ═══════════════════════════════════════════════════════════════════ */
async function importFromDrive({ limit = 200, force = false, log = null } = {}) {
  const say = log || (() => {});
  if (!IMPORT_ON)
    return { ok: false, error: 'ปิดการย้ายรูปจากชีตไว้แล้ว (PHOTO_IMPORT=off)' };

  const bucket = await storage.bucketReady();
  if (!bucket.ok) return { ok: false, error: bucket.error };

  let src;
  try { src = await require('./avatar-source').read(); }
  catch (e) { return { ok: false, error: 'อ่านต้นทางไม่ได้: ' + e.message }; }

  /* ใครมีรูปในบ้านแล้วบ้าง — จะได้ไม่ไปดึงซ้ำให้เสียเวลา */
  const have = new Set();
  if (!force) {
    const rows = await db.selectAll('user_photo',
      { select: 'username', order: 'username.asc' }).catch(() => []);
    for (const r of rows || []) have.add(clean(r.username));
  }

  const drive = require('./drive');
  const out = { ok: true, moved: 0, skipped: 0, noSource: 0, failed: 0, errors: [],
                /* ‼ ต้องบอกด้วยว่า "ไม่มีต้นทาง" นั้นหน้าตาเป็นยังไง
                 *   บทเรียน 5 ก.ย. 69: รายงานว่า "ไม่มีต้นทาง 76 คน" เฉย ๆ
                 *   แล้วไม่มีใครรู้ว่าในช่องรูปมันมีอะไรอยู่ เดากันต่อไม่ได้เลย
                 *   ตัวเลขที่ไม่มีตัวอย่างประกอบ = เบาะแสที่ใช้ไม่ได้ */
                kinds: {}, noSourceSample: [] };

  for (const p of src.rows) {
    if (out.moved >= limit) { out.note = `ทำครบ ${limit} คนต่อรอบ กดอีกครั้งเพื่อทำต่อ`; break; }
    const user = clean(p.username);
    if (!user) continue;
    if (have.has(user)) { out.skipped++; continue; }

    /* ‼ หาไอดีไฟล์ให้ครบทุกทาง ไม่ใช่แค่ค่าที่เป็นลิงก์ตรง ๆ
     *
     *   บั๊กจริง 5 ก.ย. 69: ตาราง user_photo ว่างเปล่าทั้งที่ Drive API ใช้ได้
     *   เพราะช่องรูปในชีตเก็บเป็น path แบบ AppSheet (user_photos/x.jpg)
     *   ซึ่งแกะเป็นไอดีตรง ๆ ไม่ได้ ตัวย้ายเลยนับว่า "ไม่มีต้นทาง" ทั้งกระดาน
     *
     *   core/files.js หาให้ได้ทั้ง 3 ทาง: ลิงก์ตรง → สารบัญ → ค้นชื่อใน Drive สด ๆ
     *   ‼ ทางที่ 3 สำคัญมาก — ทำให้ไม่ต้องรอ "เดินสารบัญ" ให้เสร็จก่อน */
    let id = clean(p.id);
    if (!id && p.raw) {
      try { id = await require('./files').driveIdOf(p.raw); }
      catch { id = ''; }
    }
    if (!id) {
      out.noSource++;
      out.kinds[p.kind] = (out.kinds[p.kind] || 0) + 1;
      if (out.noSourceSample.length < 6)
        out.noSourceSample.push({
          ชื่อ: p.nickname || user,
          ชนิด: p.kind,
          ค่าในช่องรูป: p.raw ? String(p.raw).slice(0, 60) : '(ว่างเปล่า)',
        });
      continue;
    }

    try {
      const f = await drive.download(id);             // คืน { buf, mime, bytes }
      const r = await save(user, f.buf,
        { by: 'ย้ายเข้าระบบใหม่', source: 'drive', ref: id });
      if (r.ok) { out.moved++; say(`ย้ายรูป ${p.nickname || user} แล้ว`); }
      else { out.failed++; out.errors.push(`${user}: ${r.error}`); }
    } catch (e) {
      out.failed++;
      out.errors.push(`${user}: ${e.message}`);
      /* ‼ 403 = ไฟล์ใน Drive ยังไม่ได้แชร์ให้บัญชีระบบ
       *   ถ้าเจอ ไม่ต้องไล่ยิงต่อให้ครบ 200 คน เพราะจะพังเหมือนกันหมด
       *   หยุดแล้วบอกวิธีแก้ทันที ดีกว่าปล่อยให้รอเป็นนาทีแล้วได้ 0 เหมือนเดิม */
      if (/\(403\)|ยังไม่ได้แชร์/.test(e.message)) { out.blockedBy403 = true; break; }
    }
  }

  out.errors = out.errors.slice(0, 10);
  _lastImport = { at: new Date().toISOString(), auto: false, ...out };
  return out;
}

/* ═══════════════════════════════════════════════════════════════════
 *  ‼ ไล่ทดสอบ "ทุกข้อต่อ" ด้วยของจริง แล้วบอกว่าขาดตรงไหน
 *
 *  ต้นเรื่อง 5 ก.ย. 69 · พี่เอ: "รูปไม่เห็นมาเลย"
 *  ตาราง app.user_photo สร้างแล้วแต่ว่างเปล่า = ขั้นย้ายของล้มแบบเงียบ ๆ
 *
 *  บทเรียน: อลิซแก้ไปหลายรอบโดยไม่รู้ว่าขาดข้อไหน เพราะทุกขั้นจับ error
 *  แล้วกลืนหายหมด ตัวนี้จึงต้อง "ยิงจริงทุกข้อ แล้วเอา error ดิบมาแสดง"
 *
 *  ‼ ห้ามกลืน error เด็ดขาด — ข้อความจาก Google คือเบาะแสเดียวที่เรามี
 * ═══════════════════════════════════════════════════════════════════ */
async function diagnose() {
  /* ‼ ต้องตั้ง ready = false ไว้ก่อนเสมอ แล้วค่อยเปลี่ยนเป็น true ตอนจบ
   *
   *   บั๊กจริง 5 ก.ย. 69: ตัวนี้เคยใช้ชื่อฟิลด์ว่า ok แล้ว endpoint เขียนว่า
   *   res.json({ ok: true, ...(await diagnose()) })
   *   เวลาตรวจ "ไม่ผ่าน" ฟิลด์ ok จะไม่มีในผลลัพธ์ การ spread จึงไม่ทับอะไร
   *   → ok: true รอดมา → หน้าจอเข้าใจว่าผ่าน แล้วเดินหน้าย้ายรูปต่อ
   *   → ขึ้นว่า "✅ ย้ายรูปเสร็จแล้ว ย้ายได้ 0 คน" ทั้งที่ตรวจไม่ผ่านตั้งแต่ต้น
   *
   *   ‼ บทเรียน: ห้ามใช้ชื่อฟิลด์ซ้ำกับ "ธงว่าคำขอสำเร็จ" ของ endpoint
   *     และธงต้องมีค่าเสมอ ไม่ใช่ "มีบ้างไม่มีบ้าง" */
  const out = { ready: false, steps: [], next: '' };
  const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); return ok; };

  /* อีเมลบัญชีระบบ — ต้องรู้ตั้งแต่ต้น เพราะหลายข้อต้องเอาไปบอกวิธีแก้ */
  try { out.serviceAccount = require('./sheets').credentials().email; } catch { /* ไม่รู้ก็ไม่เป็นไร */ }

  /* ── 1. ถังเก็บไฟล์ ── */
  const bucket = await storage.bucketReady();
  if (!step('ถังเก็บรูป (Supabase Storage)', bucket.ok,
            bucket.ok ? `ถัง "${bucket.bucket}" พร้อมใช้` : bucket.error)) {
    out.next = 'รัน sql/20-file-cache.sql ใน Supabase ก่อน (ตรงนั้นเป็นตัวสร้างถัง)';
    return out;
  }

  /* ── 2. ตารางบ้านของรูป ── */
  let n = -1;
  try {
    const rows = await db.select('user_photo', { select: 'username', limit: 1 });
    n = Array.isArray(rows) ? rows.length : 0;
    step('ตาราง app.user_photo', true, n ? 'มีรูปอยู่แล้ว' : 'ตารางมีแล้ว แต่ยังว่าง');
  } catch (e) {
    step('ตาราง app.user_photo', false, e.message);
    out.next = 'รัน sql/23-user-photo.sql ใน Supabase ก่อน';
    return out;
  }

  /* ── 3. อ่านต้นทางเดิม (ชีต User) ── */
  let src = null;
  try {
    src = await require('./avatar-source').read();
    const k = src.summary.kinds || {};
    step('อ่านชีต User', true,
         `พนักงาน ${src.summary.total} คน · หาไอดีรูปได้ ${src.summary.resolved} คน · ` +
         Object.entries(k).map(([a, b]) => `${a} ${b}`).join(' · '));
  } catch (e) {
    step('อ่านชีต User', false, e.message);
    out.next = 'ยังอ่านชีต User ไม่ได้ — ตรวจ SHEET_LOGIN_ID และการแชร์ชีตให้บัญชีระบบ';
    return out;
  }

  /* ‼ ต้องหาไอดีด้วย "ทุกทางที่ตัวย้ายจริงใช้" ไม่ใช่แค่ลิงก์ตรง
   *   ไม่งั้นตัวตรวจจะบอกว่าไม่มีต้นทาง ทั้งที่ตัวย้ายหาเจอ (หรือกลับกัน)
   *   ตัวตรวจที่เดินคนละทางกับของจริง = ตัวตรวจที่โกหก */
  const files = require('./files');
  let withId = src.rows.filter(r => r.id);
  const hasRaw = src.rows.filter(r => !r.id && r.raw);

  if (!withId.length && hasRaw.length) {
    for (const r of hasRaw.slice(0, 5)) {            // ลองแค่ 5 คนพอ ไม่ให้รอนาน
      try {
        const id = await files.driveIdOf(r.raw);
        if (id) { withId = [{ ...r, id }]; break; }
      } catch { /* ลองคนต่อไป */ }
    }
  }

  if (!step('มีรูปที่พอจะย้ายได้', withId.length > 0,
            withId.length
              ? `หาไฟล์เจอ — เริ่มจาก ${withId[0].nickname || withId[0].username}`
              : `‼ หาไฟล์ไม่เจอเลย (ค่าดิบที่เจอ เช่น "${(hasRaw[0] || {}).raw || '(ว่าง)'}")`)) {
    out.next = hasRaw.length
      ? 'ช่องรูปในชีตเก็บเป็น "ที่อยู่ไฟล์แบบ AppSheet" ไม่ใช่ลิงก์ Drive\n' +
        'ระบบต้องเอาชื่อไฟล์นี้ไปค้นใน Google Drive ก่อน แต่ยังค้นไม่เจอ\n' +
        'วิธีแก้: กดเมนู "อัปเดตสารบัญ Drive" แล้วรอจนขึ้นว่าสารบัญพร้อม ' +
        'จากนั้นกดปุ่มนี้ใหม่\n' +
        '(ถ้าสารบัญเดินแล้วยังไม่เจอ แปลว่าโฟลเดอร์รูปยังไม่ได้แชร์ให้บัญชี ' +
        (out.serviceAccount || 'ของระบบ') + ')'
      : 'รูปทั้งหมดเป็นแบบ "ฝังในเซลล์" หรือ "รูปลอย" ซึ่ง Google ไม่เปิดให้ API อ่าน — ' +
        'ต้องรันสคริปต์ tools/แปลงรูปพนักงานเป็นลิงก์.gs ในแอปเดิมก่อน ' +
        'หรือใช้ปุ่ม "📷 ใส่รูปพนักงาน" ใส่เองทีละคน';
    return out;
  }

  /* ── 4. ‼ ข้อที่ชี้ขาด — ลองโหลดของจริง 1 ใบ ── */
  const one = withId[0];
  let bytes = 0, dlErr = '';
  try {
    const f = await require('./drive').download(one.id);
    bytes = (f.buf || []).length;
  } catch (e) { dlErr = e.message; }

  const email = out.serviceAccount || '';

  if (!step('โหลดรูปจาก Drive ได้จริง', bytes > 0,
            bytes > 0 ? `โหลดรูปของ ${one.nickname || one.username} ได้ ${bytes} ไบต์`
                      : `‼ โหลดไม่ได้ — ${dlErr}`)) {
    out.next = /403|แชร์/.test(dlErr)
      ? 'ไฟล์รูปใน Drive ยังไม่ได้แชร์ให้บัญชีของระบบ\n' +
        'วิธีแก้: เปิดโฟลเดอร์ที่เก็บรูปพนักงานใน Google Drive → กดแชร์ → ' +
        'ใส่อีเมลนี้ "' + (email || '(ดูที่ GOOGLE_SA_JSON)') + '" → ให้สิทธิ์ "ผู้อ่าน" → บันทึก\n' +
        'แล้วกลับมากดปุ่มนี้ใหม่อีกครั้ง'
      : 'โหลดรูปจาก Drive ไม่ได้ — ' + dlErr;
    return out;
  }

  /* ── 5. เขียนขึ้นถังได้จริงไหม ── */
  const put = await save(one.username, (await require('./drive').download(one.id)).buf,
    { by: 'ตรวจระบบ', source: 'drive', ref: one.id });
  if (!step('เก็บขึ้นถังได้จริง', put.ok,
            put.ok ? 'อัปขึ้นถังแล้ว — ' + put.url : put.error)) {
    out.next = 'อัปโหลดขึ้น Supabase Storage ไม่ได้ — ' + put.error;
    return out;
  }

  out.ready = true;
  out.next = 'ทุกข้อต่อใช้งานได้ — กด "ย้ายรูปทั้งหมด" ได้เลย';
  return out;
}

/* ═══════════════════════════════════════════════════════════════════
 *  ‼ ย้ายให้เองรอบแรก — พี่เอไม่ต้องกดอะไรเลย
 *
 *  ทำครั้งเดียวตอนบูต และทำแบบ "ไม่ให้ใครรอ" (ไม่ await ในเส้นทางคำขอ)
 *  ถ้าย้ายไม่ได้ก็ช่างมัน หน้าเว็บยังทำงานปกติ แค่รูปยังไม่ขึ้นบางคน
 * ═══════════════════════════════════════════════════════════════════ */
let _autoDone = false;
/* ‼ เก็บผลรอบล่าสุดไว้ให้หน้าจอเห็นด้วย
 *   บทเรียน 5 ก.ย. 69: อลิซให้มันเขียนลง console อย่างเดียว
 *   พี่เอมองไม่เห็น เลยได้แต่ "รูปไม่เห็นมาเลย" โดยไม่มีใครรู้สาเหตุ
 *   ‼ ข้อความ error ที่ไม่มีใครได้อ่าน มีค่าเท่ากับไม่มี error */
let _lastImport = null;

async function autoImportOnce() {
  if (_autoDone || !IMPORT_ON) return;
  _autoDone = true;
  try {
    const n = await db.count('user_photo', {}).catch(() => -1);
    if (n !== 0) return;                       // มีของแล้ว หรือถามไม่ได้ = ไม่ต้องยุ่ง
    console.log('[รูปพนักงาน] ยังไม่มีรูปในระบบเลย — ย้ายจากต้นทางเดิมให้อัตโนมัติ');
    const r = await importFromDrive({ limit: 200 });
    _lastImport = { at: new Date().toISOString(), auto: true, ...r };
    console.log('[รูปพนักงาน] ย้ายเสร็จ:', JSON.stringify(r).slice(0, 300));
  } catch (e) {
    _lastImport = { at: new Date().toISOString(), auto: true, ok: false, error: e.message };
    console.log('[รูปพนักงาน] ย้ายอัตโนมัติไม่สำเร็จ:', e.message);
  }
}

/** สภาพการย้าย — ใช้ตอบว่า "พร้อมปิดชีตหรือยัง" */
async function status() {
  const out = { importEnabled: IMPORT_ON };
  try {
    const s = await db.select('v_user_photo_stat', { select: '*' });
    out.stat = (s && s[0]) || null;
  } catch (e) { out.error = e.message; }
  try {
    out.missing = await db.select('v_user_photo_gap',
      { select: '*', has_photo: 'is.false', limit: 50 });
  } catch { out.missing = []; }

  /* ‼ ผลการย้ายรอบล่าสุด — รวมทั้งรอบที่ระบบทำเองตอนบูต
   *   ถ้ามันล้ม ต้องมีคนเห็น ไม่ใช่ซ่อนไว้ใน console */
  out.lastImport = _lastImport;

  /* ‼ คำตอบที่พี่เออยากรู้จริง ๆ: ปิดชีตได้หรือยัง */
  const st = out.stat || {};
  out.readyToCloseSheet = Number(st['ยังไม่มีรูป'] || 0) === 0;
  return out;
}

/* ═══════════════════════════════════════════════════════════════════
 *  🗜 3 พ.ย. 69 ย่อรูปโปรไฟล์ที่เก็บไปแล้ว (ต้นฉบับใหญ่) ให้เหลือ ≤ 40 KB — งานเบื้องหลังทีละรูป
 *   ‼ โหลดของเดิมจากถังครั้งเดียว (egress ครั้งเดียว) แล้วทุกการเปิดหน้าหลังจากนี้ใช้ตัวเล็ก
 *   ‼ sha256 ในแถวคงเป็นของต้นฉบับ ⇒ อัปรูปเดิมซ้ำยังรู้ว่า "เหมือนเดิม" ไม่อัปซ้ำ
 * ═══════════════════════════════════════════════════════════════════ */
const SLIM_OVER = Shrink.PRESET.avatar.maxKb * 1024 + 1024;
async function slimStored({ limit = 300, pauseMs = 600, log = () => {} } = {}) {
  const rows = await db.selectAll('user_photo', { select: 'username,path,url,bytes,sha256,mime', bytes: 'gt.' + SLIM_OVER, order: 'bytes.desc', limit }) || [];
  let done = 0, saved = 0, failed = 0;
  for (const r of rows) {
    try {
      const res = await fetch(r.url);
      if (!res.ok) throw new Error('โหลดรูปเดิมไม่ได้ (' + res.status + ')');
      const buf = Buffer.from(await res.arrayBuffer());
      const sm = await Shrink.shrink(buf, Shrink.PRESET.avatar);
      if (!sm.changed || sm.buf.length >= buf.length) { failed++; continue; }
      const sha = clean(r.sha256) || crypto.createHash('sha256').update(buf).digest('hex');
      const up = await storage.upload(pathOf(r.username, 'jpg', sha.slice(0, 10)), sm.buf, sm.mime, { shrink: false, immutable: true });
      await db.update('user_photo', { username: 'eq.' + r.username }, { path: up.path, url: up.url, mime: sm.mime, bytes: sm.buf.length });
      if (r.path && r.path !== up.path) await storage.remove(r.path).catch(() => {});
      done++; saved += (Number(r.bytes) || buf.length) - sm.buf.length;
    } catch (e) { failed++; log('[img-slim] รูปโปรไฟล์ ' + r.username + ': ' + ((e && e.message) || e)); }
    if (pauseMs) await new Promise(rs => setTimeout(rs, pauseMs));
  }
  return { found: rows.length, done, failed, savedBytes: saved };
}

module.exports = { save, map, byUser, urlOf, remove, importFromDrive, autoImportOnce, slimStored,
                   status, diagnose, sniff, bufOf, pathOf, IMPORT_ON, MAX_BYTES };
