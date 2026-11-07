'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  ทดสอบรูปพนักงานแบบ "ไม่มีชีตก็อยู่ได้" — npm run test:photo
 *
 *  ‼ พี่เอสั่ง 5 ก.ย. 69:
 *    "ต้องคิดว่า หากไม่มี sheet ให้ดึงข้อมูลจะต้องทำแบบไหน
 *     เพราะเดี๋ยวพี่จะปิด ไม่ให้ดึงข้อมูลจาก sheet แล้วนะ"
 *
 *  เทสต์ชุดนี้ถามคำถามเดียว ซ้ำ ๆ ทุกข้อ:
 *      "ถ้าพรุ่งนี้ชีตหายไปเลย ข้อนี้ยังทำงานไหม"
 *
 *  ‼ ข้อที่สำคัญที่สุดคือข้อ 4 — ตัดชีตกับ Drive ออกจากระบบจริง ๆ
 *    (ทำให้เรียกแล้วพังทันที) แล้วพิสูจน์ว่ารูปยังขึ้นเหมือนเดิม
 *    ถ้าเทสต์ข้อนั้นผ่าน แปลว่าพี่เอปิดชีตได้จริง ไม่ใช่แค่เราคิดว่าได้
 * ═══════════════════════════════════════════════════════════════════ */
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

process.env.SESSION_SECRET = 'p'.repeat(64);
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_KEY = 'k';

/* รูปจริงขนาดจิ๋ว — ไบต์ต้นไฟล์ถูกต้องตามมาตรฐาน */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 7)]);
const PDF = Buffer.from('%PDF-1.4 ไม่ใช่รูปนะ แต่แกล้งบอกว่าเป็นรูป', 'utf8');

/* ─── ถังปลอม + ฐานข้อมูลปลอม ─────────────────────────────────── */
const BUCKET = {};      // path → bytes
let removed = [];
const stp = require.resolve('../core/storage.js');
require.cache[stp] = { id: stp, filename: stp, loaded: true, exports: {
  BUCKET: 'crm-files',
  bucketReady: async () => ({ ok: true, bucket: 'crm-files' }),
  publicUrl: p => 'https://cdn.test/' + p,
  async upload(path, buf, mime) {
    BUCKET[path] = { bytes: buf.length, mime };
    return { path, url: 'https://cdn.test/' + path, bytes: buf.length };
  },
  async remove(p) { removed.push(p); delete BUCKET[p]; return { ok: true }; },
} };

const TABLE = new Map();      // username → row
let rpcCalls = 0;
const dbp = require.resolve('../core/db.js');
require.cache[dbp] = { id: dbp, filename: dbp, loaded: true, exports: {
  async one(_t, p) {
    const u = String(p.username || '').replace(/^eq\./, '');
    return TABLE.get(u) || null;
  },
  async update(_t, p, row) {
    const u = String(p.username || '').replace(/^eq\./, '');
    if (!TABLE.has(u)) return [];
    TABLE.set(u, { ...TABLE.get(u), ...row });
    return [TABLE.get(u)];
  },
  async insert(_t, rows) {
    for (const r of rows) TABLE.set(r.username, r);
    return rows;
  },
  async remove(_t, p) {
    TABLE.delete(String(p.username || '').replace(/^eq\./, ''));
    return [];
  },
  async selectAll() { return [...TABLE.values()]; },
  async select() { return []; },
  async count() { return TABLE.size; },
  /* app.sales_avatars() ตัวจริงอ่านจากตารางล้วน — ตรงนี้จำลองผลของมัน */
  async rpc() {
    rpcCalls++;
    const out = {};
    for (const [u, r] of TABLE) out[u] = r.url;
    return out;
  },
} };

const photo = require('../core/photo');

(async () => {
  console.log('\n📷 ทดสอบรูปพนักงานแบบไม่พึ่งชีต\n');

  /* ═══════════════════════════════════════════════════════════════
   *  1) รับเฉพาะรูปจริง — ตรวจจากไบต์ต้นไฟล์ ไม่ใช่เชื่อนามสกุล
   * ═══════════════════════════════════════════════════════════════ */
  console.log('1) รับเฉพาะไฟล์ที่เป็นรูปจริง');
  ok((photo.sniff(PNG) || {}).ext === 'png', 'รู้จัก PNG');
  ok((photo.sniff(JPG) || {}).ext === 'jpg', 'รู้จัก JPG');
  ok(photo.sniff(PDF) === null,
     '‼ ไฟล์ที่ไม่ใช่รูป ต้องไม่ผ่าน — ถังนี้เปิดสาธารณะ ห้ามให้อัปอะไรก็ได้');

  const bad = await photo.save('somchai', PDF.toString('base64'));
  ok(bad.ok === false && /ไม่ใช่รูปภาพ/.test(bad.error),
     '‼ ปฏิเสธไฟล์ปลอมพร้อมบอกเหตุผลให้คนอ่านรู้เรื่อง');
  ok(Object.keys(BUCKET).length === 0, '‼ ของที่ไม่ผ่าน ต้องไม่มีอะไรขึ้นถังเลย');

  /* ═══════════════════════════════════════════════════════════════
   *  2) ใส่รูปเข้าระบบโดยไม่ผ่านชีต — ทางถาวรที่แทนการแก้ชีต
   * ═══════════════════════════════════════════════════════════════ */
  console.log('\n2) ใส่รูปเข้าระบบโดยตรง (ทางที่ใช้หลังปิดชีต)');
  const r1 = await photo.save('somchai', 'data:image/png;base64,' + PNG.toString('base64'),
                              { by: 'papassorn' });
  ok(r1.ok && /^https:\/\/cdn\.test\//.test(r1.url), 'อัปโหลดแล้วได้ URL จาก CDN ของเรา');
  const pngKey = Object.keys(BUCKET).find(k => /^avatars\/somchai-[0-9a-f]{10}\.(png|jpg)$/.test(k));
  ok(!!pngKey, 'ไฟล์ไปนอนอยู่ในถังจริง ชื่อไฟล์ผูกกับ Username (+ รหัสเนื้อรูป · 3 พ.ย. 69)');
  ok(TABLE.get('somchai').source === 'upload', 'จดไว้ว่ามาจากการอัปโหลด');
  ok(TABLE.get('somchai').updated_by === 'papassorn', 'จดว่าใครเป็นคนใส่');
  ok(!!TABLE.get('somchai').sha256, 'เก็บลายนิ้วมือของรูปไว้เทียบภายหลัง');

  /* ‼ กฎ "เหมือนกันไม่ต้องซิงก์" ของพี่เอ ใช้กับรูปด้วย */
  const before = TABLE.get('somchai').updated_at;
  await new Promise(r => setTimeout(r, 5));
  const r2 = await photo.save('somchai', PNG.toString('base64'), { by: 'papassorn' });
  ok(r2.ok && r2.same === true, '‼ รูปเดิมเป๊ะ → ไม่อัปซ้ำ (กฎเหมือนกันไม่ต้องซิงก์)');
  ok(TABLE.get('somchai').updated_at === before,
     '‼ ตอนรูปเท่าเดิม เวลาอัปเดตต้องไม่ขยับ ไม่งั้นดูเหมือนมีคนเปลี่ยนรูปตลอด');

  /* เปลี่ยนเป็นไฟล์คนละนามสกุล — ของเก่าต้องถูกลบ ไม่ค้างในถัง */
  removed = [];
  const r3 = await photo.save('somchai', JPG.toString('base64'), { by: 'papassorn' });
  const jpgKey = Object.keys(BUCKET).find(k => k !== pngKey && /^avatars\/somchai-[0-9a-f]{10}\.jpg$/.test(k));
  ok(r3.ok && !!jpgKey, 'เปลี่ยนรูปเป็น JPG ได้');
  ok(removed.includes(pngKey),
     '‼ ไฟล์เก่าคนละนามสกุลต้องถูกลบ ไม่งั้นค้างในถังตลอดกาล');

  console.log('\n3) กันของเสียเข้าระบบ');
  const noWho = await photo.save('', PNG.toString('base64'));
  ok(noWho.ok === false, 'ไม่บอกว่าเป็นรูปของใคร → ไม่รับ');
  const empty = await photo.save('somsri', '');
  ok(empty.ok === false && /ไม่มีข้อมูลรูป/.test(empty.error), 'ส่งค่าว่างมา → ไม่รับ');
  const huge = await photo.save('somsri',
    Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]).toString('base64'));
  ok(huge.ok === false && /ใหญ่เกิน/.test(huge.error), 'ไฟล์ใหญ่เกิน 5MB → ไม่รับ');

  /* ═══════════════════════════════════════════════════════════════
   *  ‼ 4) ข้อสำคัญที่สุด — ตัดชีตกับ Drive ออกจริง ๆ แล้วรูปต้องยังขึ้น
   *
   *     ทำให้ทั้งสองตัวพังทันทีที่ถูกเรียก ถ้าเส้นทางแสดงผลยังแอบ
   *     ไปแตะอยู่ เทสต์นี้จะพังทันที — จับได้แน่นอน ไม่ใช่เดา
   * ═══════════════════════════════════════════════════════════════ */
  console.log('\n4) ‼ ปิดชีตและ Drive แล้วรูปต้องยังขึ้น');
  const shp = require.resolve('../core/sheets.js');
  require.cache[shp] = { id: shp, filename: shp, loaded: true, exports: {
    isConfigured: () => { throw new Error('ชีตถูกปิดแล้ว'); },
    readTab: async () => { throw new Error('ชีตถูกปิดแล้ว'); },
    readHead: async () => { throw new Error('ชีตถูกปิดแล้ว'); },
    accessToken: async () => { throw new Error('ชีตถูกปิดแล้ว'); },
  } };
  const drp = require.resolve('../core/drive.js');
  require.cache[drp] = { id: drp, filename: drp, loaded: true, exports: {
    download: async () => { throw new Error('Drive ถูกปิดแล้ว'); },
    thumbUrl: () => { throw new Error('Drive ถูกปิดแล้ว'); },
    fileIdOf: () => { throw new Error('Drive ถูกปิดแล้ว'); },
  } };

  rpcCalls = 0;
  const map = await photo.map();
  ok(!!map['somchai'], '‼ ชีตปิด · Drive ปิด → รูปยังขึ้นตามปกติ');
  ok(rpcCalls === 1, 'อ่านจากตารางล้วน 1 ครั้ง ไม่มีคำขอออกนอกบ้านเลย');

  const one = await photo.urlOf('somchai');
  ok(/^https:\/\/cdn\.test\//.test(one), 'ถามรูปรายคนก็ยังได้ ไม่พึ่งชีตเหมือนกัน');

  const up = await photo.save('somsri', PNG.toString('base64'), { by: 'papassorn' });
  ok(up.ok === true, '‼ ชีตปิดแล้วยัง "ใส่รูปพนักงานใหม่" ได้ — นี่คือหัวใจของเรื่องนี้');
  ok(!!(await photo.map())['somsri'], 'คนที่เพิ่งใส่รูป ขึ้นในแผนที่ทันที');

  console.log('\n5) เอารูปออก');
  removed = [];
  const del = await photo.remove('somsri');
  ok(del.ok && removed.length === 1, 'ลบทั้งในถังและในตาราง ไม่เหลือขยะ');
  ok((await photo.map())['somsri'] === undefined, 'ลบแล้วหายจากแผนที่จริง');
  ok((await photo.remove('ไม่มีคนนี้')).ok === true, 'ลบคนที่ไม่มีรูป ต้องไม่พัง');

  console.log('\n6) ทางย้ายของ ปิดได้ด้วยสวิตช์เดียว');
  process.env.PHOTO_IMPORT = 'off';
  delete require.cache[require.resolve('../core/photo.js')];
  const photo2 = require('../core/photo');
  ok(photo2.IMPORT_ON === false, 'ตั้ง PHOTO_IMPORT=off แล้วปิดทางย้ายของได้');
  const imp = await photo2.importFromDrive({});
  ok(imp.ok === false && /ปิดการย้ายรูป/.test(imp.error),
     '‼ ปิดแล้วต้องไม่แตะชีตอีกเลย แม้จะมีคนกดปุ่มย้าย');
  ok(!!(await photo2.map())['somchai'],
     '‼ ปิดทางย้ายของแล้ว รูปที่ย้ายมาแล้วยังใช้ได้ปกติ');

  /* ═══════════════════════════════════════════════════════════════
   *  ‼ 7) ตัวไล่ทดสอบทุกข้อต่อ — ต้องชี้จุดที่ขาดได้จริง
   *
   *  ต้นเรื่อง 5 ก.ย. 69 · พี่เอ: "รูปไม่เห็นมาเลย"
   *  ตาราง user_photo สร้างแล้วแต่ว่าง 0 แถว = ขั้นย้ายของล้มแบบเงียบ ๆ
   *  ทุกขั้นจับ error แล้วกลืนหาย จึงไม่มีใครรู้ว่าขาดตรงไหน
   *
   *  ‼ บทเรียน: error ที่ไม่มีใครได้อ่าน มีค่าเท่ากับไม่มี error
   * ═══════════════════════════════════════════════════════════════ */
  console.log('\n7) ‼ ไล่ทดสอบทุกข้อต่อ ต้องบอกได้ว่าขาดตรงไหน');
  {
    delete require.cache[require.resolve('../core/photo.js')];
    process.env.PHOTO_IMPORT = 'on';
    const ph = require('../core/photo');

    const asp = require.resolve('../core/avatar-source.js');
    const setSource = rows => {
      require.cache[asp] = { id: asp, filename: asp, loaded: true, exports: {
        read: async () => ({ map: {}, rows,
          summary: { total: rows.length, resolved: rows.filter(r => r.id).length, kinds: {} } }),
      } };
    };
    const setDrive = impl => {
      require.cache[drp] = { id: drp, filename: drp, loaded: true, exports: {
        download: impl, thumbUrl: () => '', fileIdOf: () => '' } };
    };
    require.cache[shp].exports.credentials = () => ({ email: 'crm-bot@antsign.iam.gserviceaccount.com' });

    /* ‼ core/files.js ปลอม — คุมได้ว่า "ค้นชื่อไฟล์ใน Drive" เจอหรือไม่เจอ */
    const flp = require.resolve('../core/files.js');
    const setFiles = fn => {
      require.cache[flp] = { id: flp, filename: flp, loaded: true,
                             exports: { driveIdOf: fn } };
    };
    setFiles(async () => '');

    /* 7.1 ไม่มีใครมีไอดีเลย = รูปเป็นแบบฝังในเซลล์ทั้งหมด */
    setSource([{ username: 'a', nickname: 'เอ', id: '', raw: '', kind: 'ว่าง' }]);
    const d1 = await ph.diagnose();
    const st1 = n => (d1.steps || []).find(s => s.name === n) || {};
    ok(st1('มีรูปที่พอจะย้ายได้').ok === false, 'ไม่มีไอดีให้ดึงเลย → ต้องขึ้นว่าไม่ผ่าน');
    ok(/ฝังในเซลล์|รูปลอย/.test(d1.next), 'บอกสาเหตุว่าเป็นรูปฝังในเซลล์');
    ok(/แปลงรูปพนักงานเป็นลิงก์|ใส่รูปพนักงาน/.test(d1.next),
       '‼ บอก "สิ่งที่ต้องทำต่อ" ให้ชัด ไม่ใช่บอกแค่ว่าพัง');

    /* ═══════════════════════════════════════════════════════════════
     *  ‼ 7.1b เคสที่เกิดขึ้นจริง 5 ก.ย. 69 — ช่องรูปเป็น path แบบ AppSheet
     *
     *  ตาราง user_photo ว่างเปล่าทั้งที่ Drive API เรียกได้ปกติ
     *  เพราะ "user_photos/x.jpg" แกะเป็นไอดีตรง ๆ ไม่ได้
     *  ตัวย้ายเลยนับว่า "ไม่มีต้นทาง" ทั้งกระดาน แล้วเงียบไป
     * ═══════════════════════════════════════════════════════════════ */
    setSource([{ username: 'somsak', nickname: 'ศักดิ์', id: '',
                 raw: 'user_photos/somsak.jpg', kind: 'pathแบบAppSheet' }]);

    /* ยังค้นชื่อไฟล์ไม่เจอ → ต้องบอกให้ไปเดินสารบัญ ไม่ใช่บอกว่ารูปฝังในเซลล์ */
    setFiles(async () => '');
    const dPath = await ph.diagnose();
    ok((dPath.steps.find(s => s.name === 'มีรูปที่พอจะย้ายได้') || {}).ok === false,
       'ค่าเป็น path แบบ AppSheet แล้วยังค้นไม่เจอ → ไม่ผ่าน');
    ok(/AppSheet|ที่อยู่ไฟล์/.test(dPath.next) && /สารบัญ/.test(dPath.next),
       '‼ ต้องบอกว่าเป็น path แบบ AppSheet และให้ไปเดินสารบัญ — ไม่ใช่บอกว่ารูปฝังในเซลล์');
    ok(/user_photos\/somsak\.jpg/.test(
         (dPath.steps.find(s => s.name === 'มีรูปที่พอจะย้ายได้') || {}).detail || ''),
       'โชว์ค่าดิบที่เจอในชีตให้ดูด้วย จะได้รู้ว่ากำลังพูดถึงอะไร');

    /* ค้นเจอแล้ว → ต้องย้ายได้จริง ไม่ต้องรอสารบัญให้เสร็จก่อน */
    setFiles(async raw => (raw === 'user_photos/somsak.jpg' ? 'FOUNDID' : ''));
    setDrive(async () => ({ buf: PNG, mime: 'image/png', bytes: PNG.length }));
    const impPath = await ph.importFromDrive({ limit: 5 });
    ok(impPath.moved === 1 && impPath.noSource === 0,
       '‼ ค้นชื่อไฟล์ใน Drive เจอ → ย้ายได้ (นี่คือทางที่ขาดไปตอนแรก)');
    ok(TABLE.get('somsak') && TABLE.get('somsak').source_ref === 'FOUNDID',
       'จดไอดีที่ค้นเจอไว้ ไว้ไล่ย้อนทีหลังได้');
    TABLE.delete('somsak');

    /* 7.2 ‼ เคสที่น่าจะเป็นของจริง — ไฟล์ใน Drive ไม่ได้แชร์ให้บัญชีระบบ */
    setSource([{ username: 'somchai', nickname: 'ชาย', id: 'FILEID1', raw: 'x', kind: 'ลิงก์หรือไอดี' }]);
    setDrive(async () => {
      throw new Error('โหลดไฟล์จาก Drive ไม่ได้ (403) — ไฟล์ยังไม่ได้แชร์ให้บัญชีระบบ');
    });
    const d2 = await ph.diagnose();
    const st2 = n => (d2.steps || []).find(s => s.name === n) || {};
    ok(st2('โหลดรูปจาก Drive ได้จริง').ok === false,
       '‼ ลองโหลดของจริงแล้วพัง → จับได้ ไม่ปล่อยผ่าน');
    ok(/403/.test(st2('โหลดรูปจาก Drive ได้จริง').detail || ''),
       'เอา error ดิบของ Google มาแสดง ไม่กลืนหาย');
    ok(/crm-bot@antsign/.test(d2.next),
       '‼ บอกอีเมลบัญชีระบบที่ต้องเอาไปแชร์ให้ — พี่เอจะได้ทำต่อได้ทันที');
    ok(/แชร์/.test(d2.next) && /ผู้อ่าน/.test(d2.next),
       'บอกวิธีแก้เป็นขั้นตอน ไม่ใช่ศัพท์เทคนิคลอย ๆ');

    /* ‼ เจอ 403 แล้วต้องหยุด ไม่ไล่ยิงต่อให้ครบทุกคน */
    setSource(Array.from({ length: 50 }, (_, i) =>
      ({ username: 'u' + i, nickname: 'u' + i, id: 'F' + i, raw: 'x', kind: 'ลิงก์หรือไอดี' })));
    let tries = 0;
    setDrive(async () => {
      tries++;
      throw new Error('โหลดไฟล์จาก Drive ไม่ได้ (403) — ไฟล์ยังไม่ได้แชร์ให้บัญชีระบบ');
    });
    const imp = await ph.importFromDrive({ limit: 50 });
    ok(tries === 1 && imp.blockedBy403 === true,
       '‼ เจอ 403 ใบแรกแล้วหยุดทันที — ยิงต่อไปก็พังเหมือนกันหมด เสียเวลาเปล่า');

    /* 7.3 ทุกอย่างพร้อม → ต้องบอกว่าผ่าน และย้ายได้จริง */
    setSource([{ username: 'somkid', nickname: 'คิด', id: 'FILEID2', raw: 'x', kind: 'ลิงก์หรือไอดี' }]);
    setDrive(async () => ({ buf: PNG, mime: 'image/png', bytes: PNG.length }));
    const d3 = await ph.diagnose();
    ok(d3.ready === true, 'ทุกข้อต่อใช้งานได้ → ขึ้นว่าผ่าน');
    ok(!!TABLE.get('somkid'), '‼ ตอนตรวจผ่าน ย้ายรูปใบที่ทดสอบเข้าระบบไปแล้วจริง');

    const imp2 = await ph.importFromDrive({ limit: 10 });
    ok(imp2.moved === 0 && imp2.skipped === 1,
       'คนที่มีรูปแล้วต้องถูกข้าม — รันซ้ำกี่รอบก็ไม่เสียหาย');

    /* 7.4 ผลรอบล่าสุดต้องเก็บไว้ให้หน้าจอเห็น ไม่ใช่ซ่อนใน console */
    const st = await ph.status();
    ok(!!st.lastImport, '‼ เก็บผลรอบย้ายล่าสุดไว้ให้หน้าจอแสดงได้');
  }

  console.log('\n' + '═'.repeat(52));
  console.log(`ผ่าน ${pass} · ไม่ผ่าน ${fail}`);
  console.log('═'.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n💥 ' + e.stack); process.exit(1); });
