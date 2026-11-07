'use strict';
const Shrink = require('./imgshrink');
/* ═══════════════════════════════════════════════════════════════════
 *  core/storage.js — เก็บไฟล์ที่ Supabase Storage
 *
 *  ทำไมต้องมี: รูปที่อยู่ใน Google Drive แสดงบนเว็บได้ช้าและไม่แน่นอน
 *  (ต้องเช็คสิทธิ์ทุกครั้ง · ปฏิเสธ referer จากโดเมนอื่น · ต้องแชร์สาธารณะ)
 *
 *  วิธีที่เร็วและแน่นอนกว่า: ดึงจาก Drive ครั้งเดียว เก็บไว้ที่ Storage
 *  แล้วให้หน้าเว็บโหลดจาก CDN ของ Supabase — Drive ยังเป็นต้นทางเสมอ
 *  ลบของในถังทิ้งเมื่อไหร่ก็ไปดึงมาใหม่ได้ ไม่มีข้อมูลอะไรหาย
 * ═══════════════════════════════════════════════════════════════════ */
const { CFG } = require('./config');

const BUCKET = CFG.STORAGE_BUCKET || 'crm-files';
const base = () => String(CFG.SUPABASE_URL || '').replace(/\/+$/, '');

const head = () => ({
  apikey: CFG.SUPABASE_KEY,
  Authorization: 'Bearer ' + CFG.SUPABASE_KEY,
});

/** URL สาธารณะของไฟล์ในถัง (ถังต้องตั้งเป็น public — ดู sql/20) */
const publicUrl = path =>
  `${base()}/storage/v1/object/public/${BUCKET}/${String(path).replace(/^\/+/, '')}`;

/**
 * อัปโหลดไฟล์ (มีอยู่แล้วให้ทับ)
 * @param {string} path  ที่อยู่ในถัง เช่น 'avatars/papassorn.jpg'
 * @param {Buffer} buf
 * @param {string} mime
 */
async function upload(path, buf, mime, opt) {
  const o = opt || {};
  const p = String(path).replace(/^\/+/, '');
  /* 🗜 3 พ.ย. 69 รูปทุกใบที่เข้าถังต้องย่อก่อน (ค่าตั้งต้น ≤ 150 KB · ยาวสุด 1600 px) — ทุกครั้งที่เปิดดูรูปนับเป็น egress ของ Supabase
   *   ‼ ผู้เรียกที่ย่อมาแล้วส่ง { shrink: false } · รูปเล็กอยู่แล้วตัวย่อคืนของเดิม (ไม่เข้ารหัสซ้ำ) */
  if (o.shrink !== false && Shrink.isImageMime(mime)) {
    const r = await Shrink.shrink(buf, typeof o.shrink === 'object' ? o.shrink : Shrink.PRESET.photo);
    if (r.changed) { buf = r.buf; mime = r.mime; }
  }
  /* 🗜 ที่อยู่ที่ไม่ซ้ำ (มีรหัสไฟล์/รหัสเนื้อในชื่อ) ⇒ ให้เบราว์เซอร์จำ 1 ปี ไม่ต้องโหลดซ้ำ (เดิม 7 วัน) */
  const cache = o.immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=604800';
  const res = await fetch(`${base()}/storage/v1/object/${BUCKET}/${p}`, {
    method: 'POST',
    headers: { ...head(), 'Content-Type': mime || 'application/octet-stream',
               'x-upsert': 'true', 'Cache-Control': cache },
    body: buf,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`อัปโหลดขึ้น Storage ไม่สำเร็จ (${res.status}) — ${t.slice(0, 200)}`);
  }
  return { path: p, url: publicUrl(p), bytes: buf.length, mime: mime };
}

/** ลบไฟล์ (ใช้ตอนล้างคลังเพื่อดึงใหม่) */
async function remove(paths) {
  const list = (Array.isArray(paths) ? paths : [paths])
    .map(p => String(p).replace(/^\/+/, ''));
  if (!list.length) return { ok: true };
  const res = await fetch(`${base()}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: { ...head(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: list }),
  });
  return { ok: res.ok };
}

/** ถังพร้อมใช้ไหม — ใช้เช็คก่อนเริ่มดึงรูป จะได้บอกได้ว่าต้องรัน SQL ก่อน */
async function bucketReady() {
  try {
    const res = await fetch(`${base()}/storage/v1/bucket/${BUCKET}`, { headers: head() });
    if (!res.ok) return { ok: false, error: 'ยังไม่มีถัง "' + BUCKET + '" — รัน sql/20 ก่อน' };
    const j = await res.json();
    if (!j.public) return { ok: false, error: 'ถัง "' + BUCKET + '" ยังไม่เป็นสาธารณะ — รัน sql/20 ก่อน' };
    return { ok: true, bucket: BUCKET };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { BUCKET, upload, remove, publicUrl, bucketReady };
