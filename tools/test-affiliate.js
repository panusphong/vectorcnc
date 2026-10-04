'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  tools/test-affiliate.js — รอบ 222 · Lead จากฐาน Affiliate เข้าคีย์ยอดขายอัตโนมัติ
 *
 *  พี่เอสั่ง 3 ต.ค. 69: "…ดึงข้อมูล เข้ามาสร้าง leads ใน app คีย์ยอดขาย แบบ auto
 *    ทันทีที่มีรายการใหม่ หรือมีการแก้ไขจาก database ก้อนนี้"
 *  คำตอบพี่เอ: เจ้าของ = เซลส์ที่รับ lead ใน Affiliate (ยังไม่มีคนรับ = บัญชีกลาง)
 *            · พาร์ทเนอร์ / Affiliate / มดงานการป้าย · อัปเดตเฉพาะช่องที่เซลส์ยังไม่แตะ
 *            · ช่องเงิน / ปิดการขาย / PEAK ไม่แตะเลย
 *
 *   ① 🔴 อ่านฐาน Affiliate อย่างเดียว — ตัวอ่านไม่มีคำสั่งเขียน · ไม่มี key ในโค้ด
 *   ② 🔒 จุดรับ webhook: ไม่ตั้งรหัสลับ = ปฏิเสธ · รหัสผิด = ปฏิเสธ · อยู่นอกด่านล็อกอินโดยตั้งใจ
 *   ③ การแปลง lead → ช่องของคีย์ยอดขาย (กติกาตายตัว) + ไม่มีช่องเงิน/ปิดการขาย/PEAK ในรายการที่เขียน
 *   ④ หน้าเว็บ / เมนูงาน / SQL
 *   ⑤ กับฐานจริง (ถ้าต่อฐานเทสต์ได้): ไม่สร้างซ้ำ · ไม่ทับช่องที่เซลส์แก้ · ไม่แตะเงิน
 *      · ไม่สร้างกลับใบที่ถูกลบ · ตัวเก็บตก · จุดรับ webhook จริง
 * ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const noComment = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1 ');
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

(async () => {
  console.log('\n🧪 Lead จากฐาน Affiliate → คีย์ยอดขาย\n');
  const srcCode = read('modules/sales/affiliate-src.js');
  const affCode = read('modules/sales/affiliate.js');
  const hookCode = read('modules/sales/affiliate-hook.js');
  const apiCode = read('modules/sales/affiliate-api.js');
  const server = read('server.js');

  /* ─────────────────────────────────────────────────────────────── */
  console.log('━━ ① 🔴 อ่านฐาน Affiliate อย่างเดียว');
  const srcBare = noComment(srcCode);
  ok(!/['"`](POST|PATCH|PUT|DELETE)['"`]/.test(srcBare) && /method:\s*'GET'/.test(srcBare),
     'ตัวอ่านฐาน Affiliate ยิงได้แค่ GET — ไม่มี POST / PATCH / PUT / DELETE');
  ok((srcBare.match(/fetch\(/g) || []).length === 1, 'มีจุดยิงคำขอจุดเดียว (คุมง่าย)');
  ok(/ALLOW = new Set\(\['leads', 'affiliate_sales_directory'\]\)/.test(srcCode),
     'อ่านได้แค่ 2 ตาราง: leads · affiliate_sales_directory (ไม่แตะตารางที่มีเลขบัญชี/บัตรของพาร์ทเนอร์)');
  const all = [srcCode, affCode, hookCode, apiCode].join('\n');
  ok(!/eyJ[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_]{8,}|service_role\s*[:=]\s*['"]/.test(all) &&
     !/uxvddqsrxfabqkhshzdc/.test(all),
     '‼ ไม่มี key / รหัสลับ / ที่อยู่โปรเจกต์ Affiliate ฝังในโค้ด — อ่านจาก Railway Variables เท่านั้น');
  ok(/process\.env\.AFFILIATE_SUPABASE_URL/.test(srcCode) && /process\.env\.AFFILIATE_SUPABASE_KEY/.test(srcCode) &&
     /process\.env\.AFFILIATE_WEBHOOK_SECRET/.test(hookCode), 'ค่าลับ 3 ตัวอ่านจากตัวแปรระบบ');
  {
    const SRC0 = require('../modules/sales/affiliate-src');
    const kv = process.env.AFFILIATE_SUPABASE_KEY;
    process.env.AFFILIATE_SUPABASE_KEY = 'sb_secret_' + 'x'.repeat(30);
    const h1 = SRC0.authHeaders();
    process.env.AFFILIATE_SUPABASE_KEY = 'eyJ' + 'x'.repeat(60);
    const h2 = SRC0.authHeaders();
    if (kv === undefined) delete process.env.AFFILIATE_SUPABASE_KEY; else process.env.AFFILIATE_SUPABASE_KEY = kv;
    ok(h1.apikey && h1.Authorization === undefined && /^Bearer eyJ/.test(h2.Authorization) && h2.apikey,
       'key รุ่นใหม่ (sb_secret_…) ส่งที่หัว apikey อย่างเดียว · key รุ่นเดิม (JWT) ส่งทั้งสองหัว — ตามเอกสาร Supabase');
  }
  const affBare = noComment(affCode);
  ok(!/SRC\.(write|insert|update|remove|upsert|rpc)/.test(affBare) && /SRC\.read\(/.test(affBare),
     'ตัวประมวลผลเรียกฐาน Affiliate ผ่าน SRC.read เท่านั้น');
  ok(!/peak/i.test(affBare.replace(/'ปิดการขาย'/g, '')), '‼ ตัวประมวลผลไม่เรียกอะไรของ PEAK เลย');
  ok(!/db\.remove\(/.test(affBare), '‼ ตัวประมวลผลไม่มีคำสั่งลบแถวในฐานของเรา');
  ok(require('../modules/sales/affiliate').LEAD_COLS.length === 18 &&
     !require('../modules/sales/affiliate').LEAD_COLS.some(c => /receipt|deposit_amount|sales_amount|^line_user_id$/.test(c)),
     'ไม่ดึงไฟล์ใบเสร็จ · ยอดมัดจำ · ยอดขาย · LINE userId ของลูกค้า จากฐาน Affiliate');

  /* ─────────────────────────────────────────────────────────────── */
  console.log('\n━━ ② 🔒 จุดรับ webhook');
  const HOOK = require('../modules/sales/affiliate-hook');
  const mk = h => ({ headers: h });
  delete process.env.AFFILIATE_WEBHOOK_SECRET;
  ok(HOOK.secretOk(mk({ 'x-affiliate-secret': '' })) === false && HOOK.secretOk(mk({ 'x-affiliate-secret': 'anything-anything' })) === false,
     '‼ ไม่ตั้งรหัสลับ = ปฏิเสธทุกคำขอ (fail-closed)');
  process.env.AFFILIATE_WEBHOOK_SECRET = 'short';
  ok(HOOK.secretOk(mk({ 'x-affiliate-secret': 'short' })) === false, 'รหัสลับสั้นกว่า 16 ตัว = ถือว่ายังไม่ได้ตั้ง');
  process.env.AFFILIATE_WEBHOOK_SECRET = 'test-secret-0123456789';
  ok(HOOK.secretOk(mk({ 'x-affiliate-secret': 'test-secret-0123456789' })) === true, 'รหัสถูก (หัว x-affiliate-secret) = ผ่าน');
  ok(HOOK.secretOk(mk({ authorization: 'Bearer test-secret-0123456789' })) === true, 'รหัสถูก (Authorization: Bearer) = ผ่าน');
  ok(HOOK.secretOk(mk({ 'x-affiliate-secret': 'test-secret-012345678X' })) === false &&
     HOOK.secretOk(mk({ 'x-affiliate-secret': 'test-secret-0123456789 extra' })) === false &&
     HOOK.secretOk(mk({})) === false, 'รหัสผิด / ยาวไม่เท่า / ไม่ส่ง = ปฏิเสธ');
  ok(/timingSafeEqual/.test(hookCode), 'เทียบรหัสลับแบบเวลาคงที่');
  ok(!/console\.(log|warn|error)\([^)]*(AFFILIATE_WEBHOOK_SECRET\]|want|got)\b/.test(noComment(hookCode)), 'ไม่พิมพ์รหัสลับลง log');
  ok(/require\('\.\/modules\/sales\/affiliate-hook'\)\.install\(app\)/.test(server) &&
     server.indexOf("affiliate-hook').install(app)") < server.indexOf("app.get('/healthz'"),
     'server.js ติดตั้งจุดรับ /hook/affiliate/lead (นอกด่านล็อกอินโดยตั้งใจ ท่าเดียวกับ /api/sso/verify)');
  ok(/try \{\s*require\('\.\/modules\/sales\/affiliate-hook'\)/.test(server), 'ห่อ try — ไฟล์มีปัญหาระบบยังบูตได้');
  ok(/router\.(get|post)\('\/api\/affiliate\/[a-z]+', gate,/.test(apiCode) &&
     (apiCode.match(/router\.(get|post)\('\/api\/affiliate\//g) || []).length ===
     (apiCode.match(/router\.(get|post)\('\/api\/affiliate\/[a-z]+', gate,/g) || []).length,
     '‼ เส้นของหน้าตั้งค่าทุกเส้นผ่านด่านผู้ดูแลระบบ');
  ok(!/AFFILIATE_SUPABASE_KEY|AFFILIATE_WEBHOOK_SECRET/.test(noComment(apiCode)), 'เส้นของหน้าตั้งค่าไม่ส่ง key / รหัสลับออกหน้าเว็บ');

  /* ─────────────────────────────────────────────────────────────── */
  console.log('\n━━ ③ การแปลง lead → ช่องของคีย์ยอดขาย');
  const AFF = require('../modules/sales/affiliate');
  const owner = { username: 'pool1', name: 'พูล ทดสอบ', who: 'พูล' };
  const L = { id: uuid(1), status: 'รอติดต่อ', customer_name: ' คุณสมชาย ', phone: '081-234-5678', source: 'web_form',
    ref_code: '84762123266', sign_type: 'ป้ายกล่องไฟ', location: 'ลาดพร้าว', budget: 35000, notes: 'ขอด่วน\nภายในเดือนนี้',
    line_display_name: 'Somchai', order_id: 'ORD-1', entered_at: '2026-10-02T18:30:00+00:00', updated_at: '2026-10-02T18:30:00+00:00' };
  const m = AFF.mapLead(L, owner, 'น้องเอ');
  ok(m['ลูกค้ามาจากไหน'] === 'พาร์ทเนอร์' && m['ชื่อช่อง / Platform'] === 'Affiliate' && m['บริษัทที่ขาย'] === 'มดงานการป้าย',
     'พี่เอ ②: พาร์ทเนอร์ · Affiliate · มดงานการป้าย');
  ok(m['วันที่ติดต่อ'] === '2026-10-03', '‼ วันที่ติดต่อ = วันที่ lead เข้า "ตามเวลาไทย" (18:30 UTC ของวันที่ 2 = วันที่ 3 ของไทย)');
  ok(m['ชื่อผู้ติดต่อ'] === 'คุณสมชาย' && m['ชื่อบริษัท'] === 'คุณสมชาย' && m['เบอร์ติดต่อ'] === '081-234-5678' && m['ประเภทลูกค้า'] === 'ลูกค้าใหม่',
     'ชื่อ · เบอร์ · ลูกค้าใหม่ (ไม่มีช่องบริษัทใน lead ⇒ ใช้ชื่อลูกค้าไปก่อน)');
  ok(m['Sales Code'] === 'pool1' && m['Sales Name'] === 'พูล ทดสอบ' && m['Create By'] === 'พูล', 'เจ้าของ 3 ช่อง: Sales Code · Sales Name · Create By');
  ok(/^\[Affiliate\] พาร์ทเนอร์ น้องเอ \(ref 84762123266\)/.test(m['หมายเหตุ']) && /ป้าย: ป้ายกล่องไฟ/.test(m['หมายเหตุ']) &&
     /งบลูกค้า 35,000 บาท/.test(m['หมายเหตุ']) && /สถานะ Affiliate: รอติดต่อ/.test(m['หมายเหตุ']) && !/\n/.test(m['หมายเหตุ']),
     'หมายเหตุบรรทัดเดียว: พาร์ทเนอร์ · ป้าย · สถานที่ · งบ · สถานะ Affiliate');
  ok(AFF.mapLead({ ...L, customer_name: '' }, owner, '')['ชื่อผู้ติดต่อ'] === 'Somchai', 'ไม่มีชื่อลูกค้า ⇒ ใช้ชื่อ LINE');
  const st = s => AFF.leadStatusOf(s);
  ok(['รอติดต่อ', 'ติดต่อแล้ว', 'กำลังประเมินราคา', 'ส่งช่างวัดหน้างาน', 'มัดจำแล้ว', 'ชำระมัดจำ', 'งานเสร็จสิ้น'].every(s => st(s) === 'Onprocess'),
     '‼ ไม่มีสถานะไหนของ Affiliate ถูกแปลงเป็น "ปิดการขาย" (มัดจำแล้ว/งานเสร็จสิ้น ก็ยัง Onprocess — เซลส์ปิดเอง)');
  ok(st('ไม่ปิดการขาย') === 'ไม่ซื้อ' && st('สแปม') === 'ไม่ซื้อ', 'ไม่ปิดการขาย / สแปม ⇒ ไม่ซื้อ');
  ok(AFF.SKIP_NEW.has('draft') && AFF.SKIP_NEW.has('สแปม') && AFF.SKIP_NEW.size === 2, 'ฉบับร่าง / สแปม ⇒ ยังไม่สร้างใบ');
  const SAVE = require('../modules/sales/save');
  const banned = Object.entries(SAVE.FIELD_COL).filter(([k]) =>
    /^(outsource|quote|sale|billed|received|shortfall|payAmt\d?|payDate\d?|slip\d?|payNote|closeDate|qoiv|docUrl|maker)$/.test(k)).map(([, c]) => c);
  const writes = AFF.FIELD_COLS.concat(AFF.OWNER_COLS);
  ok(banned.length >= 20 && !writes.some(c => banned.includes(c)) && !writes.some(c => /PEAK|ยอด|โอน|สลิป|ปิดการขาย/.test(c)),
     '‼ พี่เอ ③: ช่องที่ตัวดึงเขียนไม่มีช่องเงิน · วันที่ปิดการขาย · ช่อง PEAK (' + writes.length + ' ช่อง เทียบกับช่องต้องห้าม ' + banned.length + ' ช่อง)');
  const c1 = AFF.claimerOf({ claimed_by: 'แนน', claimed_by_line_user_id: 'Uabc123', claimed_by_uid: 'AAAAAAAA-0000-4000-8000-000000000001' });
  ok(c1.key === 'line:Uabc123' && c1.keys.length === 3 && c1.keys[1] === 'uid:aaaaaaaa-0000-4000-8000-000000000001' && c1.keys[2] === 'name:แนน' && c1.label === 'แนน',
     'คนรับ lead: กุญแจ LINE ก่อน → ผู้ใช้หน้าเว็บ → ชื่อ');
  ok(AFF.claimerOf({}) === null && AFF.claimerOf({ claimed_by: '  ' }) === null, 'ยังไม่มีคนรับ = ไม่มีกุญแจ');
  const mc = AFF.mergeConfig({ enabled: 0, poolUser: ' namna ', jobPrefix: 'af', claimers: { 'line:U1': 'zsale', 'bad': 'x', 'name:แนน': '' }, hack: 1 });
  ok(mc.enabled === false && mc.poolUser === 'namna' && mc.jobPrefix === 'AF' && Object.keys(mc.claimers).join() === 'line:U1' && mc.hack === undefined,
     'ตั้งค่า: รับเฉพาะคีย์ที่รู้จัก · คำนำหน้าเป็นตัวพิมพ์ใหญ่ · การจับคู่ที่ผิดรูปถูกทิ้ง');
  ok(AFF.mergeConfig({ jobPrefix: '' }).jobPrefix === '' && AFF.mergeConfig({ jobPrefix: '9X' }).jobPrefix === 'AFF' &&
     AFF.mergeConfig(null).jobPrefix === 'AFF' && AFF.mergeConfig(null).poolUser === 'admin' && AFF.mergeConfig(null).enabled === true,
     'คำนำหน้า: ว่าง = ใช้ของเจ้าของ · ผิดรูป = ถอยไป AFF · ค่าตั้งต้น = admin / AFF / เปิด');

  /* ─────────────────────────────────────────────────────────────── */
  console.log('\n━━ ④ หน้าเว็บ · เมนูงาน · SQL');
  const page = read('modules/sales/public/affiliate.html');
  const idx = read('modules/sales/public/index.html');
  ok(/<link rel="stylesheet" href="\/brand\/font\.css">/.test(page) && !/font-family:\s*['"]?(?!var\(--font-app\)|inherit)/.test(page),
     'หน้าใหม่ใช้ฟอนต์กลาง (Prompt) ไม่พิมพ์ชื่อฟอนต์เอง');
  ok(!/localStorage|sessionStorage/.test(page) && !/<script[^>]+src=/.test(page), 'หน้าใหม่ไม่โหลดสคริปต์ภายนอก ไม่เก็บของในเบราว์เซอร์');
  ok(/'api\/affiliate\/' \+ p/.test(page) && /timeZone: 'Asia\/Bangkok'/.test(page), 'เรียก API ของตัวเอง · แสดงเวลาไทย');
  ok(/\['🤝','#dcfce7','Lead จาก Affiliate',[^\]]+,'aff'\]/.test(idx) && /aff:\s+\(\) => \{[^}]*affOpen\(\)/.test(idx) &&
     idx.indexOf("'pfx'],") < idx.indexOf("'aff'],"), 'เมนูงาน → หมวดเฉพาะแอดมิน มีรายการ "Lead จาก Affiliate"');
  ok(/<iframe id="affFrame"[^>]*src="about:blank"/.test(idx) && /f\.src = 'affiliate\.html\?t=' \+ Date\.now\(\)/.test(idx),
     '‼ แผงโหลดเนื้อหาเมื่อกดเปิดเท่านั้น — หน้าคีย์ยอดขายไม่โหลดอะไรเพิ่มตอนเปิดปกติ');
  const sql = read('sql/110-affiliate-leads.sql');
  const sqlBare = noComment(sql);
  ok(/create table if not exists app\.affiliate_lead_link/.test(sql) && /lead_id\s+uuid primary key/.test(sql),
     'sql/110: ตารางจับคู่ lead_id เป็น primary key (กันสร้างซ้ำที่ชั้นฐานข้อมูล)');
  ok(!/\b(drop|truncate)\b/i.test(sqlBare) && !/delete\s+from/i.test(sqlBare) && !/update\s+app\.total_sales/i.test(sqlBare),
     'sql/110: ไม่ลบ ไม่ล้าง ไม่แตะแถวการขายเดิม');
  ok(/on conflict \(key\) do nothing/.test(sql) && /lower\(btrim\("Channel"\)\) = 'affiliate'/.test(sql) && /899999999/.test(sql),
     'sql/110: รันซ้ำได้ · ช่องทาง Affiliate ไม่เพิ่มซ้ำ · เลขแถว ≥ 900000000');
  let grp = '';
  try { grp = require('../modules/sales/online-report').channelGroup('Affiliate'); } catch (e) { grp = 'ERR'; }
  ok(/'อื่นๆ', 'Affiliate'/.test(sql) && (grp === 'อื่นๆ' || grp === 'ERR'), 'sql/110: กลุ่มของช่องทาง = channelGroup("Affiliate") ของแอป (' + grp + ')');
  ok(/notify pgrst, 'reload schema'/.test(sql) && /grant all on all tables\s+in schema app to service_role/.test(sql), 'sql/110: สิทธิ์ service_role + reload schema');
  const ver = require('../modules/sales/version');
  ok((ver.CHANGELOG || []).some(x => x[0] === '1.47.0' && /Affiliate/.test(x[2])), 'ประวัติเวอร์ชันคีย์ยอดขายมี 1.47.0 (ล่าสุด ' + ver.VERSION + ')');
  const gate = read('tools/test-login-gate.js');
  ok(/'POST \/hook\/affiliate\/lead',/.test(gate) && !/'GET \/hook\/affiliate/.test(gate) && !/app\.get\(PATH/.test(hookCode),
     'ยามด่านล็อกอินรู้จักเส้นนี้ (POST เส้นเดียว · ไม่มีเส้น GET)');
  ok(/<a class="back" href="\/" target="_top">← หน้ารวมแอป<\/a>/.test(read('modules/sales/public/affiliate.html')), 'หน้าใหม่มีปุ่มกลับหน้ารวมแอป (กติกาทุกแอปย่อย)');

  /* ─────────────────────────────────────────────────────────────── */
  console.log('\n━━ ⑤ กับฐานจริง (ฐานเทสต์)');
  const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:55432/postgres';
  let pg = null;
  try {
    const { Client } = require('pg');
    pg = new Client({ connectionString: PG, connectionTimeoutMillis: 2500 });
    await pg.connect();
    await pg.query('select 1 from app.total_sales limit 1');
    await pg.query('select 1 from app.affiliate_lead_link limit 1');
  } catch (e) { if (pg) await pg.end().catch(() => {}); pg = null;
    console.log('  ⏭  ข้าม — ต่อฐานเทสต์ไม่ได้หรือยังไม่ได้รัน sql/110 (' + String(e.message).slice(0, 80) + ')'); }

  if (pg) {
    const fake = await require('./fake-postgrest').start(PG, 0).catch(() => null);
    const port = fake && fake.srv && fake.srv.address() ? fake.srv.address().port : 0;
    if (!port) console.log('  ⏭  ข้าม — เปิดตัวจำลอง PostgREST ไม่ได้');
    else {
      process.env.SUPABASE_URL = 'http://127.0.0.1:' + port; process.env.SUPABASE_KEY = 'test-key'; process.env.SUPABASE_SCHEMA = 'app';
      const db = require('../core/db');

      /* ── ฐาน Affiliate จำลอง (ตอบแบบ PostgREST เท่าที่ตัวอ่านใช้) ── */
      const SRCDB = { leads: [], affiliate_sales_directory: [{ id: uuid(900), name: 'น้องเอ', ref_code: 'REF900' }] };
      const hits = [];
      const mock = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const table = u.pathname.replace('/rest/v1/', '');
        hits.push({ method: req.method, table, key: req.headers.apikey });
        let rows = (SRCDB[table] || []).slice();
        const f = u.searchParams.get('updated_at');
        if (f) { const op = f.slice(0, f.indexOf('.')), v = Date.parse(f.slice(f.indexOf('.') + 1));
          rows = rows.filter(r => (op === 'gt' ? Date.parse(r.updated_at) > v : Date.parse(r.updated_at) === v)); }
        rows.sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || String(a.id).localeCompare(String(b.id)));
        const lim = Number(u.searchParams.get('limit')) || 1000;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(rows.slice(0, lim)));
      });
      await new Promise(r => mock.listen(0, '127.0.0.1', r));
      process.env.AFFILIATE_SUPABASE_URL = 'http://127.0.0.1:' + mock.address().port;
      process.env.AFFILIATE_SUPABASE_KEY = 'k'.repeat(40);

      const q = async (s, a) => (await pg.query(s, a || [])).rows;
      const ids = Array.from({ length: 30 }, (_, i) => uuid(i + 1));
      const keep = {};
      for (const k of ['affiliate_sync', 'affiliate_sync_state'])
        keep[k] = (await q('select value from app.settings where key = $1', [k]))[0] || null;
      const wipe = async () => {
        await pg.query('delete from app.affiliate_lead_link where lead_id = any($1::uuid[])', [ids]);
        await pg.query(`delete from app.total_sales where "รหัสงาน" like 'ZAF%' or "รหัสงาน" like 'ZQS%'`);
        await pg.query(`delete from app.activity_log where "รหัสงาน" like 'ZAF%' or "รหัสงาน" like 'ZQS%'`).catch(() => {});
        await pg.query(`delete from app.job_code where code like 'ZAF%' or code like 'ZQS%'`).catch(() => {});
        await pg.query(`delete from app.job_code_seq where head like 'ZAF%' or head like 'ZQS%'`).catch(() => {});
        await pg.query(`delete from app.app_users where "Username" in ('zzaffpool','zzaffsale')`);
        await pg.query(`delete from app.sales_prefix where prefix = 'ZQS'`).catch(() => {});
      };
      const T = s => new Date(Date.UTC(2026, 9, 3, 2, 0, s)).toISOString();     /* 3 ต.ค. 69 09:00:ss เวลาไทย */
      const rowOf = async id => {
        const l = (await q('select * from app.affiliate_lead_link where lead_id = $1', [id]))[0];
        const r = l && l.sales_row ? (await q('select * from app.total_sales where _row = $1', [l.sales_row]))[0] : null;
        return { l, r };
      };
      const lead = (n, o) => ({ id: uuid(n), order_id: null, affiliate_id: uuid(900), ref_code: 'REF900', source: 'web_form',
        status: 'รอติดต่อ', customer_name: 'ลูกค้า ' + n, phone: '08000000' + String(n).padStart(2, '0'), line_display_name: null,
        sign_type: 'ป้ายไวนิล', location: 'กรุงเทพ', budget: 10000, notes: null, entered_at: T(0), updated_at: T(n),
        claimed_by: null, claimed_by_line_user_id: null, claimed_by_uid: null, ...(o || {}) });

      try {
        await wipe();
        await pg.query(`insert into app.app_users ("Username","Name","Nickname","Permission","Status") values
          ('zzaffpool','(กลาง) บัญชีกลางทดสอบ','กลาง','Administrator','Login'),('zzaffsale','(เอส) เซลส์ทดสอบ','เอส','Sale','Login')`);
        await pg.query(`insert into app.sales_prefix (prefix, username, nickname) values ('ZQS','zzaffsale','เอส') on conflict (prefix) do nothing`);
        AFF._t.reset();
        await AFF.saveConfig({ enabled: true, poolUser: 'zzaffpool', jobPrefix: 'ZAF', claimers: {} }, 'test');
        const before = (await q('select count(*)::int n from app.total_sales'))[0].n;

        /* ── สร้างใบใหม่ ── */
        let r = await AFF.ingest(lead(1), 'webhook');
        let x = await rowOf(uuid(1));
        ok(r.action === 'created' && /^ZAF\d{4}\/\d+$/.test(r.jobCode) && x.r && x.r['รหัสงาน'] === r.jobCode,
           'lead ใหม่ ⇒ สร้างใบขาย 1 ใบ รหัสงาน ' + r.jobCode + ' (คำนำหน้าที่ตั้งไว้ + ปปดด/ลำดับ)');
        ok(x.r['Lead Status'] === 'Onprocess' && x.r['ลูกค้ามาจากไหน'] === 'พาร์ทเนอร์' && x.r['ชื่อช่อง / Platform'] === 'Affiliate' &&
           x.r['บริษัทที่ขาย'] === 'มดงานการป้าย' && String(x.r['วันที่ติดต่อ']).slice(0, 10) === '2026-10-03',
           'ใบที่สร้าง: Onprocess · พาร์ทเนอร์ · Affiliate · มดงานการป้าย · วันที่ติดต่อเป็นวันไทย');
        ok(x.r['Sales Code'] === 'zzaffpool' && x.r['Create By'] === 'กลาง' && x.r['Sales Name'] === '(กลาง) บัญชีกลางทดสอบ',
           'ยังไม่มีคนรับ ⇒ เจ้าของ = บัญชีกลาง (ค่า Create By แบบเดียวกับตอนเซลส์คีย์เอง)');
        ok(/พาร์ทเนอร์ น้องเอ \(ref REF900\)/.test(x.r['หมายเหตุ']), 'หมายเหตุมีชื่อพาร์ทเนอร์ (อ่านจาก affiliate_sales_directory)');
        ok(x.r['ยอดขาย (บาท)'] == null && x.r['ยอดประเมินราคา'] == null && x.r['วันที่ปิดการขาย'] == null && x.r['Contact ID'] == null,
           '‼ ช่องเงิน / วันที่ปิดการขาย ว่าง (งบลูกค้าอยู่ในหมายเหตุเท่านั้น) · ยังไม่สร้างรายชื่อลูกค้า');
        ok(x.l.state === 'linked' && x.l.via === 'webhook' && x.l.job_code === r.jobCode && x.l.applied['เบอร์ติดต่อ'] === '0800000001',
           'ตารางจับคู่: linked · จำค่าที่เขียนไว้รายช่อง');
        const act = await q(`select "Action","Nickname" from app.activity_log where "รหัสงาน" = $1`, [r.jobCode]);
        ok(act.length === 1 && act[0].Action === 'เพิ่ม (Affiliate)', 'จดกิจกรรม "เพิ่ม (Affiliate)" 1 บรรทัด');

        /* ── ไม่สร้างซ้ำ ── */
        r = await AFF.ingest(lead(1), 'poll');
        ok(r.action === 'same' && (await q('select count(*)::int n from app.total_sales'))[0].n === before + 1,
           '‼ lead เดิมเข้ามาอีกทาง (webhook แล้วตามด้วยตัวเก็บตก) ⇒ ไม่สร้างซ้ำ');
        const two = await Promise.all([AFF.applyLead(lead(2), 'webhook'), AFF.applyLead(lead(2), 'poll')]);
        const n2 = (await q(`select count(*)::int n from app.total_sales where "เบอร์ติดต่อ" = '0800000002'`))[0].n;
        ok(n2 === 1 && two.filter(t => t.action === 'created').length === 1,
           '‼ สองทางยิงพร้อมกันเป๊ะ ⇒ ได้ใบเดียว (อีกทางได้ "' + two.find(t => t.action !== 'created').action + '")');
        r = await AFF.ingest({ ...lead(1), updated_at: T(0) }, 'webhook');
        ok(r.action === 'stale', 'ข้อมูลเก่ากว่าที่ทำไปแล้ว (webhook มาช้า) ⇒ ทิ้ง');

        /* ── แก้ใน Affiliate ⇒ อัปเดตเฉพาะช่องที่เซลส์ยังไม่แตะ ── */
        r = await AFF.ingest(lead(1, { phone: '0899999999', claimed_by: 'แนน', claimed_by_line_user_id: 'Uline1', updated_at: T(40) }), 'webhook');
        x = await rowOf(uuid(1));
        ok(r.action === 'updated' && x.r['เบอร์ติดต่อ'] === '0899999999' && x.r['Sales Code'] === 'zzaffpool' && x.l.claimer_key === 'line:Uline1',
           'เบอร์ถูกแก้ใน Affiliate ⇒ ใบขายอัปเดตตาม · มีคนรับแล้วแต่ยังไม่จับคู่ ⇒ ยังอยู่บัญชีกลาง');
        await pg.query(`update app.total_sales set "ชื่อผู้ติดต่อ" = 'เซลส์แก้เอง', "ยอดประเมินราคา" = 5000, "ผู้ผลิต" = 'ผลิตเอง-The101' where _row = $1`, [x.l.sales_row]);
        r = await AFF.ingest(lead(1, { phone: '0899999999', customer_name: 'ชื่อใหม่จาก Affiliate', sign_type: 'ป้ายอะคริลิค',
          claimed_by: 'แนน', claimed_by_line_user_id: 'Uline1', updated_at: T(41) }), 'webhook');
        x = await rowOf(uuid(1));
        ok(x.r['ชื่อผู้ติดต่อ'] === 'เซลส์แก้เอง' && r.kept.includes('ชื่อผู้ติดต่อ'),
           '‼ พี่เอ ③: ช่องที่เซลส์แก้เองแล้ว ไม่ถูกทับ (ชื่อผู้ติดต่อ)');
        ok(x.r['ชื่อบริษัท'] === 'ชื่อใหม่จาก Affiliate' && /ป้าย: ป้ายอะคริลิค/.test(x.r['หมายเหตุ']),
           'ช่องที่เซลส์ยังไม่แตะ อัปเดตตาม Affiliate (ชื่อบริษัท · หมายเหตุ)');
        ok(Number(x.r['ยอดประเมินราคา']) === 5000 && x.r['ผู้ผลิต'] === 'ผลิตเอง-The101', '‼ ช่องเงิน / ผู้ผลิต ที่เซลส์คีย์ไว้ อยู่ครบ');

        /* ── จับคู่คนรับ ⇒ ย้ายเจ้าของ ── */
        await AFF.saveConfig({ enabled: true, poolUser: 'zzaffpool', jobPrefix: 'ZAF', claimers: { 'line:Uline1': 'zzaffsale' } }, 'test');
        const rm = await AFF.remap();
        x = await rowOf(uuid(1));
        ok(rm.changed >= 1 && x.r['Sales Code'] === 'zzaffsale' && x.r['Create By'] === 'เอส' && x.r['Sales Name'] === '(เอส) เซลส์ทดสอบ',
           '‼ พี่เอ ①: จับคู่คนรับ "แนน" → zzaffsale ⇒ ใบที่แนนรับย้ายเป็นของเซลส์คนนั้น');
        ok(/^ZAF/.test(x.r['รหัสงาน']) && x.r['ชื่อผู้ติดต่อ'] === 'เซลส์แก้เอง', 'ย้ายเจ้าของแล้วรหัสงานเดิม · ช่องที่เซลส์แก้ยังอยู่');
        r = await AFF.ingest(lead(3, { claimed_by: 'แนน', claimed_by_line_user_id: 'Uline1' }), 'webhook');
        x = await rowOf(uuid(3));
        ok(r.action === 'created' && x.r['Sales Code'] === 'zzaffsale', 'lead ใหม่ที่คนรับจับคู่ไว้แล้ว ⇒ เป็นของเซลส์คนนั้นตั้งแต่สร้าง');
        await pg.query(`update app.total_sales set "Sales Code" = 'admin', "Create By" = 'โอนแล้ว' where _row = $1`, [x.l.sales_row]);
        r = await AFF.ingest(lead(3, { claimed_by: 'คนอื่น', claimed_by_line_user_id: 'Uline2', updated_at: T(42) }), 'webhook');
        x = await rowOf(uuid(3));
        ok(x.r['Sales Code'] === 'admin' && x.r['Create By'] === 'โอนแล้ว' && r.kept.includes('เจ้าของงาน'),
           '‼ ใบที่มีคนโอนงาน/แก้เจ้าของเองแล้ว ⇒ ไม่ย้ายเจ้าของทับ');
        await AFF.saveConfig({ enabled: true, poolUser: 'zzaffpool', jobPrefix: '', claimers: { 'line:Uline1': 'zzaffsale' } }, 'test');
        r = await AFF.ingest(lead(4, { claimed_by: 'แนน', claimed_by_line_user_id: 'Uline1' }), 'webhook');
        ok(/^ZQS\d{4}\/\d+$/.test(r.jobCode), 'เว้นคำนำหน้าว่าง ⇒ ใช้คำนำหน้าของเจ้าของใบ (' + r.jobCode + ')');
        await AFF.saveConfig({ enabled: true, poolUser: 'zzaffpool', jobPrefix: 'ZAF', claimers: { 'line:Uline1': 'zzaffsale' } }, 'test');

        /* ── ปิดการขายแล้ว ⇒ ไม่แก้ตาม ── */
        x = await rowOf(uuid(1));
        await pg.query(`update app.total_sales set "Lead Status" = 'ปิดการขาย', "ยอดขาย (บาท)" = 9999, "วันที่ปิดการขาย" = '2026-10-03' where _row = $1`, [x.l.sales_row]);
        r = await AFF.ingest(lead(1, { status: 'ไม่ปิดการขาย', phone: '0811111111', customer_name: 'ชื่อใหม่จาก Affiliate',
          claimed_by: 'แนน', claimed_by_line_user_id: 'Uline1', updated_at: T(43) }), 'webhook');
        x = await rowOf(uuid(1));
        ok(r.action === 'same' && x.r['Lead Status'] === 'ปิดการขาย' && Number(x.r['ยอดขาย (บาท)']) === 9999 && x.r['เบอร์ติดต่อ'] === '0899999999',
           '‼ พี่เอ ③: ใบที่ปิดการขายแล้ว ไม่ถูกแก้ตามแม้แต่ช่องเดียว');

        /* ── สถานะ ── */
        await AFF.ingest(lead(5), 'webhook');
        r = await AFF.ingest(lead(5, { status: 'ไม่ปิดการขาย', updated_at: T(44) }), 'webhook');
        x = await rowOf(uuid(5));
        ok(x.r['Lead Status'] === 'ไม่ซื้อ', 'Affiliate เปลี่ยนเป็น "ไม่ปิดการขาย" ⇒ ใบขายเป็น "ไม่ซื้อ"');
        r = await AFF.ingest(lead(5, { status: 'มัดจำแล้ว', updated_at: T(45) }), 'webhook');
        x = await rowOf(uuid(5));
        ok(x.r['Lead Status'] === 'Onprocess' && /สถานะ Affiliate: มัดจำแล้ว/.test(x.r['หมายเหตุ']) && x.r['ยอดขาย (บาท)'] == null,
           '‼ Affiliate เป็น "มัดจำแล้ว" ⇒ ใบขายยัง Onprocess (เห็นสถานะในหมายเหตุ) ไม่ปิดการขายให้เอง');
        r = await AFF.ingest(lead(6, { status: 'draft' }), 'webhook');
        x = await rowOf(uuid(6));
        ok(r.action === 'skipped' && !x.r && x.l.state === 'skipped', 'ฉบับร่าง (draft) ⇒ ยังไม่สร้างใบ');
        r = await AFF.ingest(lead(6, { status: 'รอติดต่อ', updated_at: T(46) }), 'webhook');
        ok(r.action === 'created', 'ฉบับร่างกรอกเสร็จ (เป็น รอติดต่อ) ⇒ สร้างใบ');
        r = await AFF.ingest(lead(7, { status: 'สแปม' }), 'webhook');
        ok(r.action === 'skipped' && !(await rowOf(uuid(7))).r, 'สแปมตั้งแต่ก่อนเข้าระบบ ⇒ ไม่สร้างใบ');

        /* ── ใบถูกลบในคีย์ยอดขาย ⇒ ไม่สร้างกลับ ── */
        x = await rowOf(uuid(5));
        await pg.query('delete from app.total_sales where _row = $1', [x.l.sales_row]);
        r = await AFF.ingest(lead(5, { status: 'ติดต่อแล้ว', updated_at: T(47) }), 'webhook');
        const again = await AFF.ingest(lead(5, { status: 'ติดต่อแล้ว', updated_at: T(48) }), 'poll');
        ok(r.action === 'gone' && again.action === 'gone' &&
           (await q(`select count(*)::int n from app.total_sales where "เบอร์ติดต่อ" = '0800000005'`))[0].n === 0,
           '‼ ใบที่เซลส์ลบไปแล้ว ไม่ถูกสร้างกลับ แม้ lead ถูกแก้อีกกี่รอบ');

        /* ── เซลส์เปลี่ยนรหัสงานเอง ⇒ ยังตามใบเดิมเจอ ── */
        x = await rowOf(uuid(2));
        await pg.query(`update app.total_sales set "รหัสงาน" = 'ZAFRENAME/1' where _row = $1`, [x.l.sales_row]);
        r = await AFF.ingest(lead(2, { phone: '0822222222', updated_at: T(49) }), 'webhook');
        x = await rowOf(uuid(2));
        ok(r.action === 'updated' && x.r['รหัสงาน'] === 'ZAFRENAME/1' && x.r['เบอร์ติดต่อ'] === '0822222222' && x.l.job_code === 'ZAFRENAME/1',
           'เซลส์แก้รหัสงานเอง ⇒ ยังอัปเดตใบเดิม (ไม่สร้างใบใหม่) และจำรหัสใหม่');

        /* ── ล้มกลางทาง ⇒ รอบหน้าทำต่อ ไม่ซ้ำ ── */
        await pg.query(`insert into app.affiliate_lead_link (lead_id, state, job_code, updated_at) values ($1, 'creating', 'ZAFCRASH/1', now() - interval '10 minutes')`, [uuid(8)]);
        r = await AFF.ingest(lead(8), 'poll');
        x = await rowOf(uuid(8));
        ok(r.action === 'created' && x.r['รหัสงาน'] === 'ZAFCRASH/1', 'ล้มหลังจองรหัสงาน ⇒ รอบหน้าสร้างต่อด้วยรหัสเดิม');
        await pg.query(`update app.affiliate_lead_link set state = 'creating', sales_row = null, updated_at = now() - interval '10 minutes' where lead_id = $1`, [uuid(8)]);
        r = await AFF.ingest(lead(8, { updated_at: T(50) }), 'poll');
        ok((await q(`select count(*)::int n from app.total_sales where "รหัสงาน" = 'ZAFCRASH/1'`))[0].n === 1 && (await rowOf(uuid(8))).l.state === 'linked',
           '‼ ล้มหลังเขียนใบขายแล้ว (ยังไม่ทันจดการจับคู่) ⇒ รอบหน้ารับใบเดิมมาผูก ไม่สร้างซ้ำ');

        /* ── พักการดึง ── */
        await AFF.saveConfig({ enabled: false, poolUser: 'zzaffpool', jobPrefix: 'ZAF', claimers: {} }, 'test');
        r = await AFF.ingest(lead(9), 'webhook');
        ok(r.action === 'paused' && !(await rowOf(uuid(9))).l, 'พักการดึงไว้ ⇒ ไม่สร้าง ไม่แก้อะไร');
        await AFF.saveConfig({ enabled: true, poolUser: 'zzaffpool', jobPrefix: 'ZAF', claimers: { 'line:Uline1': 'zzaffsale' } }, 'test');

        /* ── 🔁 ตัวเก็บตก ── */
        await pg.query(`delete from app.settings where key = 'affiliate_sync_state'`);
        SRCDB.leads = [lead(10, { updated_at: T(1) }), lead(11, { updated_at: T(2) })];
        r = await AFF.pollOnce();
        ok(r.started && !(await rowOf(uuid(10))).l, 'ตัวเก็บตกรอบแรก = เริ่มนับจากตอนนี้ (ไม่ดึงของเก่าเข้ามาเอง)');
        await pg.query(`update app.settings set value = value || jsonb_build_object('cursor', $1::text, 'since', $1::text) where key = 'affiliate_sync_state'`, [T(1)]);
        r = await AFF.pollOnce();
        ok(r.made === 1 && (await rowOf(uuid(11))).r && !(await rowOf(uuid(10))).l, 'ตัวเก็บตกดึงเฉพาะรายการที่แก้ไข "หลัง" จุดเริ่มเก็บ');
        const cur1 = (await q(`select value->>'cursor' c from app.settings where key = 'affiliate_sync_state'`))[0].c;
        r = await AFF.pollOnce();
        ok(Date.parse(cur1) === Date.parse(T(2)) && r.seen === 0 && r.skipped === 1 && r.made === 0,
           'ตัวชี้ขยับตาม · รอบถัดไปอ่านย้อนทับเจอใบเดิม เนื้อหาเดิม = ข้าม ไม่ทำอะไร');
        SRCDB.leads.push(lead(12, { updated_at: T(3) }), lead(11, { phone: '0811000011', updated_at: T(4) }));
        SRCDB.leads = SRCDB.leads.filter((l, i, a) => a.findIndex(z => z.id === l.id && Date.parse(z.updated_at) >= Date.parse(l.updated_at) && z !== l) < 0);
        r = await AFF.pollOnce();
        ok(r.made === 1 && r.updated === 1 && (await rowOf(uuid(11))).r['เบอร์ติดต่อ'] === '0811000011', 'ตัวเก็บตก: รายการใหม่ = สร้าง · รายการที่ถูกแก้ = อัปเดต');
        /* ธุรกรรมที่เริ่มก่อนแต่บันทึกเสร็จทีหลัง: เวลาแก้ไข "เก่ากว่า" ตัวชี้ (T4) แต่เพิ่งโผล่ */
        SRCDB.leads.push(lead(16, { updated_at: T(3) }));
        r = await AFF.pollOnce();
        ok(r.made === 1 && (await rowOf(uuid(16))).r && r.skipped === 2,
           '‼ ใบที่บันทึกเสร็จช้า (เวลาแก้ไขเก่ากว่าตัวชี้) ไม่หลุด — ตัวเก็บตกอ่านย้อนทับ 2 นาทีทุกรอบ');
        const cur2 = (await q(`select value->>'cursor' c from app.settings where key = 'affiliate_sync_state'`))[0].c;
        ok(Date.parse(cur2) === Date.parse(T(4)), 'ตัวชี้ไม่ถอยหลังเมื่อเจอใบที่เวลาเก่ากว่า');
        await AFF.ingest(lead(17, { updated_at: T(52) }), 'webhook');
        r = await AFF.ingest(lead(17, { phone: '0817171717', updated_at: T(52) }), 'webhook');
        ok(r.action === 'updated' && (await rowOf(uuid(17))).r['เบอร์ติดต่อ'] === '0817171717',
           '‼ เพิ่มแล้วแก้ต่อในธุรกรรมเดียวกัน (เวลาแก้ไขเท่ากันเป๊ะ เนื้อหาต่างกัน) ⇒ ยังอัปเดตตาม');
        r = await AFF.ingest(lead(17, { phone: '0817171717', updated_at: T(52) }), 'poll');
        ok(r.action === 'same', 'เวลาเท่ากัน เนื้อหาเท่ากัน ⇒ ไม่ทำซ้ำ');
        r = await AFF.backfill();
        ok(r.made === 1 && (await rowOf(uuid(10))).r && r.seen + r.skipped === SRCDB.leads.length, 'ปุ่ม "ดึงย้อนหลังทั้งหมด" ⇒ ได้ใบที่ตกก่อนหน้า · ใบที่มีแล้วไม่ซ้ำ');
        ok(hits.length > 0 && hits.every(h => h.method === 'GET') && hits.every(h => h.table === 'leads' || h.table === 'affiliate_sales_directory'),
           '‼ คำขอที่ไปถึงฐาน Affiliate ทั้งหมด ' + hits.length + ' ครั้ง เป็น GET ล้วน · 2 ตารางที่อนุญาตเท่านั้น');
        delete process.env.AFFILIATE_SUPABASE_KEY;
        r = await AFF.pollOnce();
        ok(r.off === 'no-key', 'ไม่ได้ตั้ง key ⇒ ตัวเก็บตกไม่ทำงาน (ไม่พัง)');
        process.env.AFFILIATE_SUPABASE_KEY = 'k'.repeat(40);

        /* ── ⚡ จุดรับ webhook จริง (express) ── */
        const express = require('express');
        const app = express(); app.use(express.json());
        HOOK.install(app, { noPoll: true });
        const srv = await new Promise(rs => { const s = app.listen(0, '127.0.0.1', () => rs(s)); });
        const url = 'http://127.0.0.1:' + srv.address().port + HOOK.PATH;
        const post = (body, hdr) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(hdr || {}) }, body: JSON.stringify(body) })
          .then(async z => ({ status: z.status, body: await z.json().catch(() => null) }));
        const SEC = { 'x-affiliate-secret': 'test-secret-0123456789' };
        const payload = (type, rec, old) => ({ type, table: 'leads', schema: 'public', record: rec, old_record: old || null });
        let w = await post(payload('INSERT', lead(13)), {});
        ok(w.status === 401 && !(await rowOf(uuid(13))).l, '‼ ยิงเข้ามาโดยไม่มีรหัสลับ ⇒ 401 ไม่สร้างอะไร');
        w = await post(payload('INSERT', lead(13)), { 'x-affiliate-secret': 'wrong-secret-0123456789' });
        ok(w.status === 401 && !(await rowOf(uuid(13))).l, '‼ รหัสลับผิด ⇒ 401 ไม่สร้างอะไร');
        w = await post(payload('INSERT', lead(13)), SEC);
        x = await rowOf(uuid(13));
        ok(w.status === 200 && w.body.action === 'created' && x.r && x.l.via === 'webhook' && Object.keys(w.body).sort().join() === 'action,ok',
           'รหัสลับถูก + INSERT ⇒ สร้างใบ · คำตอบมีแค่ ok/action (ไม่มีข้อมูลลูกค้าสะท้อนกลับ)');
        w = await post(payload('UPDATE', lead(13, { phone: '0813131313', updated_at: T(51) }), lead(13)), SEC);
        ok(w.body.action === 'updated' && (await rowOf(uuid(13))).r['เบอร์ติดต่อ'] === '0813131313', 'UPDATE ⇒ อัปเดตใบเดิม');
        w = await post({ type: 'INSERT', table: 'payouts', schema: 'public', record: { id: uuid(14) } }, SEC);
        ok(w.body.action === 'ignored' && !(await rowOf(uuid(14))).l, 'ตารางอื่นที่ไม่ใช่ leads ⇒ ไม่สนใจ');
        w = await post(payload('DELETE', null, { id: uuid(13) }), SEC);
        x = await rowOf(uuid(13));
        ok(w.body.action === 'noted' && x.r && /ถูกลบในฐาน Affiliate/.test(x.l.reason), '‼ lead ถูกลบในฐาน Affiliate ⇒ ใบขายยังอยู่ (ไม่ลบตาม) แค่จดไว้');
        const sv = process.env.AFFILIATE_WEBHOOK_SECRET; delete process.env.AFFILIATE_WEBHOOK_SECRET;
        w = await post(payload('INSERT', lead(15)), SEC);
        ok(w.status === 401 && !(await rowOf(uuid(15))).l, '‼ ถอดรหัสลับออกจากระบบ ⇒ ปฏิเสธทุกคำขอทันที');
        process.env.AFFILIATE_WEBHOOK_SECRET = sv;
        const g = await fetch(url);
        ok(g.status === 404, 'เปิดที่อยู่จุดรับด้วยเบราว์เซอร์ (GET) ⇒ ไม่มีเส้นนี้ — เปิดรับเฉพาะ POST ที่มีรหัสลับ');
        await new Promise(rs => srv.close(rs));

        /* ── สถานะสำหรับหน้าตั้งค่า ── */
        const S = await AFF.status();
        ok(S.ready && S.recent.length > 5 && S.claimers.some(c => c.key === 'line:Uline1' && c.username === 'zzaffsale' && c.count >= 2) &&
           S.claimers.some(c => c.key === 'line:Uline2' && !c.username) && S.users.some(u => u.username === 'zzaffsale'),
           'หน้าตั้งค่า: รายการล่าสุด · คนรับที่จับคู่แล้ว / ยังไม่จับคู่ · รายชื่อผู้ใช้');
        ok(!/kkkkkkkk|test-secret/.test(JSON.stringify(S)), '‼ สถานะที่ส่งให้หน้าเว็บไม่มี key / รหัสลับ');
        const moneyTouched = await q(`select count(*)::int n from app.total_sales where ("รหัสงาน" like 'ZAF%' or "รหัสงาน" like 'ZQS%')
          and _row <> $1 and ("ยอดขาย (บาท)" is not null or "ยอดประเมินราคา" is not null or "วันที่ปิดการขาย" is not null)`, [(await rowOf(uuid(1))).l.sales_row]);
        ok(moneyTouched[0].n === 0, '‼ ทุกใบที่ตัวดึงสร้าง/แก้ ช่องเงินและวันที่ปิดการขายว่างทั้งหมด (ยกเว้นใบที่เทสต์จำลองว่าเซลส์คีย์เอง)');
      } finally {
        await wipe().catch(e => console.log('  (ล้างข้อมูลเทสต์ไม่สำเร็จ: ' + e.message + ')'));
        for (const k of Object.keys(keep)) {
          if (keep[k]) await pg.query('insert into app.settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [k, keep[k].value]);
          else await pg.query('delete from app.settings where key = $1', [k]);
        }
        await new Promise(rs => mock.close(rs));
      }
    }
    if (fake && fake.close) await fake.close().catch(() => {});
    await pg.end();
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log((fail ? '❌' : '✅') + ' ผ่าน ' + pass + ' · ไม่ผ่าน ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('❌ เทสต์ล้ม:', e); process.exit(1); });
