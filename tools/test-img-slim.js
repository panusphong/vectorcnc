'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  ยาม 3 พ.ย. 69 — 🗜 รูปที่เก็บใน Supabase Storage ต้องเล็ก (ลด egress)
 *  พี่เอ: "จัดการทำให้ การส่งข้อมูล รูปภาพ ให้ใช้ โควต้าของ supabase น้อยที่สุดด่วนเลย"
 *   ① core/imgshrink: รูปมือถือ ⇒ ≤ 150 KB · รูปโปรไฟล์ ⇒ ≤ 40 KB / 320 px · หมุนตาม EXIF · PNG ใส ⇒ พื้นขาว · รูปเล็กไม่แตะ · ไฟล์เสียคืนเดิม
 *   ② storage.upload: ย่อรูปทุกใบก่อนเข้าถัง (ค่าตั้งต้น) · ที่อยู่ไม่ซ้ำ ⇒ Cache-Control 1 ปี
 *   ③ photo.save (รูปโปรไฟล์): เก็บ ≤ 40 KB · ชื่อไฟล์มีรหัสเนื้อ · อัปรูปเดิมซ้ำ = ไม่อัปใหม่
 *   ④ files.ensure (รูปจาก Drive): เก็บตัวเล็ก
 *   ⑤ งานย่อของเก่า: user_photo + file_cache ที่ใหญ่ ⇒ ย่อแล้วแทนที่ · ลบไฟล์เก่า · รอบสองไม่ทำซ้ำ
 *   ⑥ visit · server.js
 *  รัน: node tools/test-img-slim.js   (Postgres ในเครื่อง)
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 56301;
process.env.SUPABASE_URL = 'http://127.0.0.1:' + REST_PORT;
process.env.SUPABASE_KEY = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'd'.repeat(64);
const sharp = require('sharp');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);
const KB = 1024, kb = n => (n / KB).toFixed(0) + ' KB';

/* ถัง Storage ปลอม (ดักที่ fetch) */
const bucket = new Map(), uploads = [], removed = [];
const realFetch = global.fetch;
global.fetch = async (url, opt) => {
  const u = String(url), o = opt || {};
  const m = /\/storage\/v1\/object\/(public\/)?crm-files\/(.+)$/.exec(u);
  if (m && (o.method || 'GET') === 'POST' && !m[1]) {
    const buf = Buffer.from(o.body); bucket.set(m[2], { buf, mime: o.headers['Content-Type'], cache: o.headers['Cache-Control'] });
    uploads.push({ path: m[2], bytes: buf.length, cache: o.headers['Cache-Control'], mime: o.headers['Content-Type'] });
    return new Response('{}', { status: 200 });
  }
  if (m && m[1]) { const f = bucket.get(m[2]); return f ? new Response(f.buf, { status: 200, headers: { 'content-type': f.mime } }) : new Response('nf', { status: 404 }); }
  if (/\/storage\/v1\/object\/crm-files$/.test(u) && o.method === 'DELETE') { const b = JSON.parse(o.body); b.prefixes.forEach(p => { removed.push(p); bucket.delete(p); }); return new Response('[]', { status: 200 }); }
  return realFetch(url, opt);
};

(async () => {
  const S = require('../core/imgshrink');
  const noisy = (w, h, sig, ch) => sharp({ create: { width: w, height: h, channels: ch || 3, background: ch === 4 ? { r: 0, g: 0, b: 0, alpha: 0 } : '#7a8', noise: { type: 'gaussian', mean: 128, sigma: sig || 40 } } });
  const PHOTO = await noisy(4032, 3024, 40).blur(0.6).jpeg({ quality: 92 }).toBuffer();
  const ROT = await noisy(3000, 1500, 30).jpeg({ quality: 92 }).withMetadata({ orientation: 6 }).toBuffer();
  const ALPHA = await sharp({ create: { width: 2000, height: 2000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await noisy(1000, 1000, 50).png().toBuffer(), left: 500, top: 500 }]).png().toBuffer();
  const SMALL = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#2d6cdf' } }).jpeg().toBuffer();

  head('① ตัวย่อรูป core/imgshrink');
  let t0 = Date.now(), r = await S.shrink(PHOTO);
  let md = await sharp(r.buf).metadata();
  ok(r.changed && r.buf.length <= 150 * KB && Math.max(md.width, md.height) <= 1600, 'รูปมือถือ 4032×3024 ' + kb(PHOTO.length) + ' ⇒ ' + kb(r.buf.length) + ' ' + md.width + '×' + md.height + ' (' + (Date.now() - t0) + ' ms)');
  r = await S.shrink(PHOTO, S.PRESET.avatar); md = await sharp(r.buf).metadata();
  ok(r.buf.length <= 40 * KB && Math.max(md.width, md.height) <= 320, 'รูปโปรไฟล์ ⇒ ' + kb(r.buf.length) + ' ' + md.width + '×' + md.height);
  r = await S.shrink(ROT); md = await sharp(r.buf).metadata();
  ok(r.buf.length <= 150 * KB && md.height > md.width, 'รูปแนวตั้ง (EXIF 6) ⇒ หมุนถูกทาง ' + md.width + '×' + md.height);
  r = await S.shrink(ALPHA); const px = await sharp(r.buf).extract({ left: 2, top: 2, width: 1, height: 1 }).raw().toBuffer();
  ok(r.buf.length <= 150 * KB && px[0] > 240 && px[1] > 240 && px[2] > 240, 'PNG โปร่งใส ⇒ JPEG พื้นขาว');
  r = await S.shrink(SMALL);
  ok(!r.changed && r.buf === SMALL, 'รูปเล็กอยู่แล้ว ⇒ ไม่แตะ');
  r = await S.shrink(Buffer.from('ไม่ใช่รูป'.repeat(100)));
  ok(!r.changed, 'ไฟล์เสีย ⇒ คืนของเดิม');

  head('② storage.upload ย่อก่อนเข้าถังเสมอ');
  const storage = require('../core/storage');
  let up = await storage.upload('misc/a.jpg', PHOTO, 'image/jpeg');
  ok(up.bytes <= 150 * KB && bucket.get('misc/a.jpg').buf.length === up.bytes && /max-age=604800/.test(uploads[uploads.length - 1].cache), 'ไม่ได้บอกอะไร ⇒ ย่อเหลือ ' + kb(up.bytes) + ' · จำ 7 วัน');
  up = await storage.upload('misc/b.jpg', PHOTO, 'image/jpeg', { immutable: true });
  ok(/max-age=31536000, immutable/.test(uploads[uploads.length - 1].cache), 'ที่อยู่ไม่ซ้ำ ⇒ จำ 1 ปี');
  const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300 * KB, 7)]);
  up = await storage.upload('misc/c.pdf', PDF, 'application/pdf');
  ok(up.bytes === PDF.length, 'ไม่ใช่รูป (PDF) ⇒ ไม่แตะ');

  /* ── ฐานจริง ── */
  const { Client } = require('pg');
  const pg = new Client({ connectionString: PG }); await pg.connect();
  for (const f of ['20-file-cache.sql', '23-user-photo.sql']) { try { await pg.query(fs.readFileSync(path.join(ROOT, 'sql', f), 'utf8')); } catch (e) { /* ลงแล้ว */ } }
  await pg.query(`delete from app.user_photo where username like 'zzslim%'`);
  await pg.query(`delete from app.file_cache where drive_id like 'ZZSLIM%'`);
  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  try {
    head('③ รูปโปรไฟล์ (photo.save)');
    const photo = require('../core/photo');
    const PH4 = await noisy(2400, 1800, 40).jpeg({ quality: 92 }).toBuffer();
    const sv = await photo.save('zzslim1', PH4, { by: 'test' });
    const row = (await pg.query(`select * from app.user_photo where username='zzslim1'`)).rows[0];
    if (!row) console.log('    save:', sv);
    ok(sv.ok && row.bytes <= 40 * KB && bucket.get(row.path).buf.length === row.bytes && /^avatars\/zzslim1-[0-9a-f]{10}\.jpg$/.test(row.path),
      'อัปรูปโปรไฟล์ ' + kb(PH4.length) + ' ⇒ เก็บ ' + kb(row.bytes) + ' ที่ ' + row.path);
    ok(/immutable/.test(bucket.get(row.path).cache), '   จำ 1 ปี (ชื่อไฟล์มีรหัสเนื้อรูป)');
    const n0 = uploads.length, again = await photo.save('zzslim1', PH4, { by: 'test' });
    ok(again.same && uploads.length === n0, 'อัปรูปเดิมซ้ำ ⇒ รู้ว่าเหมือนเดิม ไม่อัปใหม่');
    await photo.save('zzslim1', ROT, { by: 'test' });
    const row2 = (await pg.query(`select * from app.user_photo where username='zzslim1'`)).rows[0];
    ok(row2.path !== row.path && removed.includes(row.path), 'เปลี่ยนรูป ⇒ ชื่อใหม่ + ลบไฟล์เก่าในถัง');

    head('④ รูปจาก Drive (files.ensure)');
    const drive = require('../core/drive');
    const realDl = drive.download, realId = require('../core/files').driveIdOf;
    drive.download = async id => ({ buf: id === 'ZZSLIMPNG' ? ALPHA : PHOTO, mime: id === 'ZZSLIMPNG' ? 'image/png' : 'image/jpeg' });
    const files = require('../core/files');
    const e1 = await files.ensure('https://drive.google.com/file/d/ZZSLIMITEM000000000000000/view', { kind: 'item' });
    const fc = (await pg.query(`select * from app.file_cache where drive_id='ZZSLIMITEM000000000000000'`)).rows[0];
    ok(e1.url && fc && fc.bytes <= 150 * KB && bucket.get(fc.path).buf.length === fc.bytes && /immutable/.test(bucket.get(fc.path).cache), 'รูปสินค้าจาก Drive ' + kb(PHOTO.length) + ' ⇒ เก็บ ' + kb(fc ? fc.bytes : 0) + ' · จำ 1 ปี');
    const e2 = await files.ensure('https://drive.google.com/file/d/ZZSLIMAVA0000000000000000/view', { kind: 'avatar' });
    const fa = (await pg.query(`select * from app.file_cache where drive_id='ZZSLIMAVA0000000000000000'`)).rows[0];
    ok(e2.url && fa && fa.bytes <= 40 * KB, 'รูปโปรไฟล์จาก Drive ⇒ ' + kb(fa ? fa.bytes : 0));

    head('⑤ ย่อของเก่าที่เก็บไปแล้ว');
    /* จำลองของเก่า: ต้นฉบับใหญ่ในถัง */
    bucket.set('avatars/zzslim2.png', { buf: ALPHA, mime: 'image/png', cache: '' });
    await pg.query(`insert into app.user_photo (username,path,url,mime,bytes,sha256,source) values ('zzslim2','avatars/zzslim2.png',$1,'image/png',$2,'abcdef1234567890','upload')`,
      [storage.publicUrl('avatars/zzslim2.png'), ALPHA.length]);
    bucket.set('item/ZZSLIMOLD0000000000000000.jpg', { buf: PHOTO, mime: 'image/jpeg', cache: '' });
    await pg.query(`insert into app.file_cache (drive_id,path,url,mime,bytes,kind) values ('ZZSLIMOLD0000000000000000','item/ZZSLIMOLD0000000000000000.jpg',$1,'image/jpeg',$2,'item'),
      ('ZZSLIMPNG','avatar/ZZSLIMPNG.png',$3,'image/png',$4,'avatar')`,
      [storage.publicUrl('item/ZZSLIMOLD0000000000000000.jpg'), PHOTO.length, storage.publicUrl('avatar/ZZSLIMPNG.png'), ALPHA.length]);
    bucket.set('avatar/ZZSLIMPNG.png', { buf: ALPHA, mime: 'image/png', cache: '' });
    const a = await photo.slimStored({ pauseMs: 0 });
    const s2 = (await pg.query(`select * from app.user_photo where username='zzslim2'`)).rows[0];
    ok(a.done >= 1 && s2.bytes <= 40 * KB && s2.path === 'avatars/zzslim2-abcdef1234.jpg' && s2.sha256 === 'abcdef1234567890' && removed.includes('avatars/zzslim2.png') && bucket.get(s2.path),
      'รูปโปรไฟล์เก่า ' + kb(ALPHA.length) + ' ⇒ ' + kb(s2.bytes) + ' · ลบต้นฉบับในถัง · sha ต้นฉบับคงเดิม (อัปซ้ำยังรู้ว่าเหมือน)');
    const b = await files.slimCached({ pauseMs: 0 });
    const o1 = (await pg.query(`select * from app.file_cache where drive_id='ZZSLIMOLD0000000000000000'`)).rows[0];
    const o2 = (await pg.query(`select * from app.file_cache where drive_id='ZZSLIMPNG'`)).rows[0];
    ok(b.done >= 2 && o1.bytes <= 150 * KB && o1.path === 'item/ZZSLIMOLD0000000000000000.jpg' && bucket.get(o1.path).buf.length === o1.bytes, 'รูปสินค้าเก่า ' + kb(PHOTO.length) + ' ⇒ ' + kb(o1.bytes) + ' (ที่อยู่เดิม)');
    ok(o2.bytes <= 40 * KB && o2.path === 'avatar/ZZSLIMPNG.jpg' && removed.includes('avatar/ZZSLIMPNG.png'), 'รูปโปรไฟล์ PNG เก่า ⇒ JPEG ' + kb(o2.bytes) + ' · ลบ .png เก่า');
    const n1 = uploads.length;
    const a2 = await photo.slimStored({ pauseMs: 0 }), b2 = await files.slimCached({ pauseMs: 0 });
    ok(uploads.length === n1 && a2.found === 0 && b2.done === 0, 'รอบสอง ⇒ ไม่มีอะไรต้องทำ (ไม่อัปซ้ำ)');
    drive.download = realDl; void realId;

    head('⑥ visit · server.js');
    const vs = fs.readFileSync(path.join(ROOT, 'modules/visit/index.js'), 'utf8');
    ok((vs.match(/shrink150\(/g) || []).length >= 3 && (vs.match(/immutable: true/g) || []).length === 2 && !/shrink\(raw, 1600, 82\)/.test(vs), 'Visit: รูปเข้าถัง ≤ 150 KB · จำ 1 ปี');
    const sv2 = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok(/slimStored\(/.test(sv2) && /slimCached\(/.test(sv2) && /IMG_SLIM/.test(sv2) && /180000/.test(sv2), 'server.js: ย่อของเก่าเบื้องหลังหลังบูต 3 นาที (ปิดได้ IMG_SLIM=off)');
  } catch (e) { fail++; console.log('  ❌ ล้ม: ' + (e && e.stack || e)); }
  finally {
    await pg.query(`delete from app.user_photo where username like 'zzslim%'`).catch(() => {});
    await pg.query(`delete from app.file_cache where drive_id like 'ZZSLIM%'`).catch(() => {});
    try { await rest.close(); } catch (e) { /* ข้าม */ }
    await pg.end().catch(() => {});
  }
  console.log('\n' + (fail ? '❌' : '✅') + ' ผ่าน ' + pass + ' · ไม่ผ่าน ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
