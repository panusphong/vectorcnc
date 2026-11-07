'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/imgshrink.js — 🗜 ย่อรูปให้ไม่เกินขนาดไฟล์ที่กำหนด (ค่าตั้งต้น 150 KB)
 *
 *  ‼ พี่เอ 3 พ.ย. 69: "จัดการทำให้ การส่งข้อมูล รูปภาพ ให้ใช้ โควต้าของ supabase น้อยที่สุดด่วนเลย"
 *    เหตุ: Supabase ล็อก (exceed_egress_quota) — รูปที่เก็บใน Storage เป็นไฟล์ต้นฉบับหลาย MB
 *          (รูปโปรไฟล์ · รูปที่ดึงจาก Drive มาเก็บ · รูป visit) ทุกครั้งที่เปิดดู = นับ egress เต็มขนาด
 *
 *  ใช้ sharp (มีในเครื่องอยู่แล้ว) · ไม่ใช้ AI · ไม่ยิงเน็ต
 *  วิธีย่อ: ลองครั้งแรกที่ขนาดสูงสุด → เดาขนาดที่พอดีจากผล (ขนาดไฟล์ ∝ จำนวนพิกเซล) → ลดอีกเล็กน้อยจนไม่เกิน
 *  ‼ ย่อไม่ได้ (ไม่ใช่รูป / ไฟล์เสีย / ไม่มี sharp) ⇒ คืนของเดิม (ไม่ขวางงาน) · GIF เคลื่อนไหวใช้เฟรมแรก
 * ═══════════════════════════════════════════════════════════════════ */
let _sharp;
function sharp() {
  if (_sharp === undefined) { try { _sharp = require('sharp'); } catch (e) { _sharp = null; } }
  return _sharp;
}

const KB = 1024;
/** ค่าตั้งต้นตามชนิดรูป — รูปโปรไฟล์แสดงเล็ก (วงกลม 24–96 px) ⇒ 320 px พอ (ชัดบนจอ retina) */
const PRESET = {
  avatar: { maxKb: 40, maxSide: 320 },
  photo:  { maxKb: 150, maxSide: 1600 },
};

const isImageMime = m => /^image\/(jpeg|jpg|png|webp|gif|heic|heif)$/i.test(String(m || ''));

/**
 * @param {Buffer} buf
 * @param {{maxKb?:number, maxSide?:number}} [opt]
 * @returns {Promise<{buf:Buffer, mime:string, changed:boolean, width?:number, height?:number, why:string}>}
 */
async function shrink(buf, opt) {
  const o = Object.assign({}, PRESET.photo, opt || {});
  const max = Math.max(8, Number(o.maxKb) || 150) * KB, side = Math.max(64, Number(o.maxSide) || 1600);
  const S = sharp();
  const keep = why => ({ buf, mime: '', changed: false, why });
  if (!S) return keep('no_sharp');
  if (!Buffer.isBuffer(buf) || buf.length < 12) return keep('empty');
  let md;
  try { md = await S(buf, { failOn: 'none', animated: false }).metadata(); } catch (e) { return keep('unreadable'); }
  if (!md || !md.width || !md.height) return keep('unreadable');
  const turn = md.orientation >= 5 && md.orientation <= 8;
  const W = turn ? md.height : md.width, H = turn ? md.width : (md.pageHeight || md.height);
  /* เล็กพอแล้วทั้งขนาดไฟล์และขนาดภาพ ⇒ เก็บเดิม (ไม่ต้องเข้ารหัสใหม่ให้เสียคุณภาพ) */
  if (buf.length <= max && Math.max(W, H) <= side && /^(jpeg|png|webp)$/.test(md.format || '')) return keep('small');
  try {
    let base = S(buf, { failOn: 'none', animated: false }).rotate();
    if (md.hasAlpha) base = base.flatten({ background: '#ffffff' });
    const raw = await base.resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const info = raw.info, long0 = Math.max(info.width, info.height);
    const enc = (long, q) => S(raw.data, { raw: { width: info.width, height: info.height, channels: info.channels } })
      .resize({ width: long, height: long, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: q, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    let best = await enc(long0, 80);
    if (best.data.length <= max) return { buf: best.data, mime: 'image/jpeg', changed: true, width: best.info.width, height: best.info.height, why: 'shrunk' };
    let long = Math.max(160, Math.min(long0, Math.floor(long0 * Math.sqrt(max / best.data.length) * 1.1)));
    for (let i = 0; i < 12 && long >= 120; i++) {
      for (const q of [78, 66, 55]) {
        const r = await enc(long, q);
        if (r.data.length < best.data.length) best = r;
        if (r.data.length <= max) return { buf: r.data, mime: 'image/jpeg', changed: true, width: r.info.width, height: r.info.height, why: 'shrunk' };
      }
      long = Math.floor(long * 0.85);
    }
    return { buf: best.data, mime: 'image/jpeg', changed: true, width: best.info.width, height: best.info.height, why: 'smallest' };
  } catch (e) { return keep('error:' + String((e && e.message) || e).slice(0, 80)); }
}

module.exports = { shrink, isImageMime, PRESET };
