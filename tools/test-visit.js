'use strict';
process.env.TZ = process.env.TZ || 'UTC';
/* ═══════════════════════════════════════════════════════════════════
 *  ยาม v1.0.0 (20 ต.ค. 69) — 🧭 แอป B2B Visit
 *  พี่เอ: "พี่ต้องการ ทำ app สำหรับหา lead visit ลูกค้ากลุ่ม B2B …"
 *   ① โครง (ทะเบียน · สิทธิ์ · SQL · ฟอนต์ · ปุ่มกลับหน้ารวมแอป)
 *   ② อลิซ (แกะ JSON · ลิงก์ Google Maps · ปรับข้อมูลค้นหา)
 *   ③ ทั้งระบบ (Postgres + fake PostgREST + AI จำลอง + ที่เก็บรูปจำลอง):
 *      ค้นหา ⇒ บันทึกเป้าหมาย (กันซ้ำ) ⇒ สิทธิ์เซลส์ ⇒ เจาะลึก ⇒ งบ DBD ⇒ นัด ⇒ งานติดตาม ⇒ ปฏิทิน
 *      ⇒ บันทึก visit + รูป ⇒ อลิซวิเคราะห์ + ลงงานถัดไป + เลื่อนขั้น ⇒ รายงาน (แผนรายลูกค้า + อัตราความสำเร็จ) ⇒ ลบ
 *  รัน: node tools/test-visit.js
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..'), MOD = path.join(ROOT, 'modules/visit');
const rd = f => fs.readFileSync(path.join(MOD, f), 'utf8');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 56320;
process.env.SUPABASE_URL = 'http://127.0.0.1:' + REST_PORT;
process.env.SUPABASE_KEY = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'd'.repeat(64);
process.env.SHEET_SYNC = 'off';
delete process.env.GEMINI_API_KEY;
process.env.ANTHROPIC_API_KEY = 'sk-test-visit';
process.env.VISIT_ROUTE_URL = 'off';      /* v1.1.0: ทดสอบไม่ออกเน็ต ⇒ ระยะทาง = เส้นตรง × 1.3 */
delete process.env.VISIT_GMAPS_KEY;
let pass = 0, fail = 0, skip = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);
const AI = require('../modules/visit/ai');
const Seg = require('../modules/visit/segments');
const realFetch = global.fetch;

(async () => {
  head('① โครงแอป');
  const mj = JSON.parse(rd('module.json'));
  const REG = require('../core/registry'), perms = require('../core/app-perms');
  ok(mj.key === 'visit' && REG.get('visit') && REG.get('visit').version === require('../modules/visit/version').VERSION, 'ทะเบียนกลางเห็นแอป B2B Visit + เวอร์ชันจาก version.js');
  ok(perms.KNOWN_APPS.indexOf('visit') >= 0, 'อยู่ในรายชื่อแอปที่รู้จัก (core/app-perms)');
  const html = rd('public/index.html'), css = rd('public/app.css'), js = rd('public/app.js');
  ok(/href="\/"/.test(html) && /หน้ารวมแอป/.test(html) && /\/brand\/font\.css/.test(html) && html.indexOf('logo-badge.js') < html.indexOf('</head>'), 'ปุ่มกลับหน้ารวมแอป · ฟอนต์กลาง · โลโก้');
  ok(!/font-family:\s*(?!var\(--font)/.test(css.replace(/font-family: var\(--font-app\)/g, '')) && /prefers-color-scheme: dark/.test(css) && /@media \(max-width: 900px\)/.test(css) && /@media print/.test(css), 'CSS: ไม่ตั้งฟอนต์เอง · กลางคืน · มือถือ · พิมพ์รายงาน');
  ok(!/localStorage|sessionStorage|document\.cookie/.test(js) && /capture="environment"/.test(js) && /multiple data-pick="gal"/.test(js), 'หน้าเว็บไม่เก็บอะไรลงเครื่อง · ปุ่มถ่ายรูป + เลือกจากเครื่องแยกกัน (Samsung/iPhone)');
  const sql = fs.readFileSync(path.join(ROOT, 'sql/126-visit-b2b.sql'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(/create table if not exists app\.visit_prospects/.test(sql) && /app\.visit_events/.test(sql) && /app\.visit_searches/.test(sql) && /app\.visit_reports/.test(sql) && !/\bdrop\b|\btruncate\b|delete from/i.test(sql) && /'visit' = any\(apps\)/.test(sql) && /service_role/.test(sql), 'sql/126: 4 ตาราง · รันซ้ำได้ · ติ๊กสิทธิ์ · grant service_role');
  ok(Seg.SEGMENTS.length >= 12 && Seg.STAGES.map(s => s.key).join() === 'target,planned,visited,quoted,negotiating,won,lost' && Seg.CHANNELS.length >= 6, 'กลุ่มธุรกิจ ' + Seg.SEGMENTS.length + ' กลุ่ม · ขั้นการขาย 7 ขั้น · ช่องทางติดตาม');

  head('①ข 🚗 v1.1.0 การเดินทาง (พี่เอ: "… รถไฟฟ้า จ่าย กม.ละ 4 บาท และ รถน้ำมัน จ่าย กม.ละ 6 บาท")');
  {
    const Trip = require('../modules/visit/trip');
    ok(Trip.RATES.ev === 4 && Trip.RATES.fuel === 6, 'อัตรา: รถไฟฟ้า 4 · รถน้ำมัน 6 บาท/กม.');
    const c1 = Trip.coordsIn('https://www.google.com/maps/place/x/@13.7563309,100.5017651,17z'), c2 = Trip.coordsIn('https://maps.google.com/?q=13.36,100.98'), c3 = Trip.coordsIn('13.123456, 100.654321'), c4 = Trip.coordsIn('!3d13.5!4d100.7');
    ok(c1 && c1.lat === 13.7563309 && c2 && c2.lng === 100.98 && c3 && c3.lat === 13.123456 && c4 && c4.lng === 100.7 && Trip.coordsIn('ชลบุรี') === null && Trip.coordsIn('99.5, 300.1') === null, 'อ่านพิกัดจากลิงก์ Google Maps (@ · q= · !3d!4d) และ "lat, lng" · ข้อความ/พิกัดผิดไม่รับ');
    const O = { label: 'ออฟฟิศ', lat: 13.7563, lng: 100.5018, src: 'office' }, D = { label: 'นิคมอมตะ', link: 'https://maps.google.com/?q=13.4,101.0', src: 'link' };
    const t1 = await Trip.build({ origin: O, dest: D, vehicle: 'fuel' });
    const hv = Trip.haversineKm(O, { lat: 13.4, lng: 101.0 });
    ok(t1.routeSrc === 'est' && Math.abs(t1.km - Math.round(hv * 1.3 * 10) / 10) < 0.11 && t1.rate === 6 && Math.abs(t1.amount - t1.km * 6) < 0.01 && /google\.com\/maps\/dir/.test(t1.mapsUrl), 'ระบบแผนที่ไม่ตอบ ⇒ ประมาณจากเส้นตรง × 1.3 = ' + t1.km + ' กม. × 6 = ฿' + t1.amount + ' · ลิงก์เส้นทาง');
    const t2 = await Trip.build({ origin: O, dest: D, vehicle: 'ev', roundTrip: true });
    ok(t2.km === Math.round(t1.km * 2 * 10) / 10 && t2.rate === 4 && Math.abs(t2.amount - t2.km * 4) < 0.01, 'ไป-กลับ ⇒ ระยะ × 2 · รถไฟฟ้า 4 บาท/กม.');
    let e1 = null; try { await Trip.build({ origin: O, dest: D, km: 200 }); } catch (e) { e1 = e; }
    const t3 = await Trip.build({ origin: O, dest: D, km: 200, kmNote: 'อ้อมถนนปิด' });
    ok(e1 && e1.userError && t3.manual && t3.km === 200 && t3.amount === 1200 && t3.routeKm === t1.km, 'แก้ระยะเอง ต้องมีเหตุผล ⇒ เก็บทั้งระยะจากแผนที่และระยะที่ขอเบิก');
    let e2 = null; try { await Trip.build({ origin: O }); } catch (e) { e2 = e; }
    let e3 = null; try { await Trip.build({ origin: O, dest: D, km: 99999, kmNote: 'พิมพ์ผิด' }); } catch (e) { e3 = e; }
    ok(e2 && /ต้นทาง/.test(e2.message) && e3 && /1500/.test(e3.message), 'ไม่มีปลายทาง / ระยะเกิน 1,500 กม. ⇒ บอกให้แก้');
    const js0 = rd('public/app.js'), css0 = rd('public/app.css'), html0 = rd('public/index.html'), mj0 = JSON.parse(rd('module.json'));
    ok(mj0.title === 'Leads & Customer Visit' && /Leads &amp; Customer Visit/.test(html0) && /^1\.\d+\.\d+$/.test(require('../modules/visit/version').VERSION) && require('../modules/visit/version').VERSION >= '1.1.0', '🏷 ชื่อแอปใหม่ "Leads & Customer Visit" (ทะเบียน · หัวแอป · แท็บเบราว์เซอร์) · v1.1.0');
    ok(/html2canvas\/1\.4\.1/.test(js0) && /jspdf\/2\.5\.1/.test(js0) && /data-x-jpg/.test(js0) && /data-x-pdf/.test(js0) && /#rpDoc/.test(js0) && /#claimDoc/.test(js0), '🧾 ส่งออก JPG / PDF ทั้ง Summary Report และใบขอเบิก (ตัวช่วยโหลดจาก cdnjs ตอนกดเท่านั้น)');
    ok(/navigator\.geolocation/.test(js0) && /data-tveh/.test(js0) && /\/visit\/edit/.test(js0) && /\/claim\/approve/.test(js0) && /\/claim\/paid/.test(js0) && /'trip', 'trip', 'เบิกค่าเดินทาง'/.test(js0), 'หน้าเว็บ: GPS · เลือกรถ · แก้ไข visit · บัญชีอนุมัติ/ทำจ่าย · เมนูเบิกค่าเดินทาง');
    ok(/\.tabbar\.n6/.test(css0) && /--pt-o/.test(css0) && /\.xdoc/.test(css0) && (css0.match(/--top-bg/g) || []).length >= 4, 'CSS ใหม่: เมนูล่าง 6 ช่อง · สีจุดต้นทาง/ปลายทาง · เอกสาร A4 · ธีมกลางคืนครบ');
    const sq = fs.readFileSync(path.join(ROOT, 'sql/129-visit-trip-claims.sql'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    ok(/create table if not exists app\.visit_claims/.test(sq) && !/\bdrop\b|\btruncate\b|delete from/i.test(sq) && /'accounting', 'บัญชี'/.test(sq) && /service_role/.test(sq), 'sql/129: ตารางใบเบิก · รันซ้ำได้ · ไม่มีลบ · บัญชีเปิดแอปได้ · grant');
  }

  head('② อลิซ: แกะผล');
  ok(AI.parseJson('ได้ผลดังนี้\n```json\n{"items":[{"name":"A"}]}\n```') .items[0].name === 'A' && AI.parseJson('[1,2]').length === 2 && AI.parseJson('ไม่มี') === null, 'แกะ JSON จากข้อความ AI (มี ```json / ไม่มี)');
  ok(AI.mapsUrl('บริษัท ก จำกัด', 'ชลบุรี') === 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('บริษัท ก จำกัด ชลบุรี'), 'ลิงก์ Google Maps แบบค้นหา (ฟรี ไม่ต้องมีกุญแจ)');
  const nc = AI.normCompany({ name: 'บริษัท ทดสอบ จำกัด', phone: '038-123456 ต่อ 12', juristicId: '0105560108609', website: 'javascript:alert(1)', score: 150, sources: ['https://a.com', 'ftp://x'] }, 'factory');
  ok(nc.score === 100 && nc.fit === 'go' && nc.website === '' && nc.juristicId === '0105560108609' && nc.sources.length === 1 && /maps/.test(nc.mapsUrl), 'ปรับข้อมูล: คะแนนไม่เกิน 100 · ลิงก์อันตรายทิ้ง · เลขทะเบียนตรวจรูปแบบ');

  head('②ข 🛟 v1.0.1 — ค้นแล้วต้องได้รายชื่อ (พี่เอ: "หาอะไรก็ไม่เจอซักอย่าง มั่วนะ แก้ด่วน")');
  {
    const saveG = process.env.GEMINI_API_KEY, saveC = process.env.ANTHROPIC_API_KEY;
    const gem = o => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: o.text }] }, finishReason: o.fin || 'STOP' }], usageMetadata: {} }), { status: o.st || 200 });
    const cl = t => new Response(JSON.stringify({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: {} }), { status: 200 });
    const cut = '{"items":[{"name":"บริษัท ก จำกัด","phone":"02-111-2222","score":82,"reasons":["ขยายสาขา",]},{"name":"บริษัท ข จำกัด","summary":"มีวงเล็บ } ในข้อความ","score":60},{"name":"บริษัท ค","summ';
    process.env.GEMINI_API_KEY = 'g-test'; process.env.ANTHROPIC_API_KEY = '';
    let calls = [];
    let a = AI.create({ fetch: async (u, o) => { calls.push(JSON.parse(o.body)); return gem({ text: cut, fin: 'MAX_TOKENS' }); } });
    let r = await a.search({ segment: 'factory', area: 'ชลบุรี', count: 10 });
    ok(r.items.length === 2 && r.items[0].name === 'บริษัท ก จำกัด' && r.items[0].phone === '02-111-2222', 'Gemini ตอบยาวจนโดนตัด (MAX_TOKENS) ⇒ ยังได้ 2 รายที่สมบูรณ์ (เดิมได้ 0)');
    ok(calls[0].generationConfig.maxOutputTokens >= 16384 && calls[0].tools[0].google_search && !calls[0].generationConfig.responseMimeType, 'ค้นเว็บ: เพดานคำตอบ ≥ 16k · ใช้ Google Search · ไม่บังคับโหมด JSON (Gemini ห้ามใช้คู่กัน)');
    calls = [];
    a = AI.create({ fetch: async (u, o) => { const b = JSON.parse(o.body); calls.push(b); return b.tools ? gem({ text: 'พบบริษัทดังนี้ 1. บริษัท ง จำกัด โทร 038-000-111 ทำโรงงานอาหาร ...' }) : gem({ text: '{"items":[{"name":"บริษัท ง จำกัด","phone":"038-000-111"}]}' }); } });
    r = await a.search({ segment: 'factory', count: 5 });
    ok(r.items.length === 1 && calls.some(c => c.generationConfig.responseMimeType === 'application/json' && !c.tools) && calls.filter(c => c.tools).length === 2, 'AI ตอบเป็นข้อความธรรมดา ⇒ ให้แปลงเป็น JSON อีกรอบ (ไม่ค้นเว็บซ้ำ) ⇒ ได้รายชื่อ');
    process.env.ANTHROPIC_API_KEY = 'sk-test'; calls = [];
    a = AI.create({ fetch: async (u, o) => { calls.push(u); return /googleapis/.test(u) ? gem({ text: '', st: 429 }) : cl('{"items":[{"name":"บริษัท จ จำกัด"}]}'); } });
    r = await a.search({ segment: 'hotel', count: 5 });
    ok(r.items.length === 1 && /Claude/.test(r.engine) && calls.some(u => /anthropic/.test(u)), 'Gemini ล่ม/โควตาหมด ⇒ สลับไปค้นด้วย Claude ให้เอง');
    process.env.ANTHROPIC_API_KEY = '';
    a = AI.create({ fetch: async () => gem({ text: '' , fin: 'SAFETY' }) });
    let err = null; try { await a.search({ segment: 'hotel', count: 5 }); } catch (e) { err = e; }
    ok(err && err.userError && /ยังไม่ได้รายชื่อ/.test(err.message) && /SAFETY/.test(err.message), 'ยังไม่ได้จริง ๆ ⇒ บอกสาเหตุบนจอ (' + (err && err.message.slice(0, 60)) + '…) ไม่ใช่ "ไม่พบ" เงียบ ๆ');
    a = AI.create({ fetch: async () => gem({ text: '', st: 429 }) });
    err = null; try { await a.search({ segment: 'hotel', count: 5 }); } catch (e) { err = e; }
    ok(err && /429/.test(err.message) && /รอ/.test(err.message), 'โควตาหมด ⇒ บอกให้รอแล้วลองใหม่');

    /* ⚡ v1.0.2 — พี่เอ: "ปรับแก้การค้นหาด้วยนะ มันช้ามาก" */
    process.env.GEMINI_API_KEY = 'g-test'; process.env.ANTHROPIC_API_KEY = '';
    calls = []; let k = 0;
    a = AI.create({ fetch: async (u, o) => { const b = JSON.parse(o.body); calls.push(b); const me = ++k; await new Promise(z => setTimeout(z, 300)); return gem({ text: JSON.stringify({ items: [{ name: 'บริษัท ชุด' + me + ' จำกัด', score: 50 + me }, { name: 'บริษัท ซ้ำ จำกัด', score: 40 }] }) }); } });
    const parts = []; const t0 = Date.now();
    r = await a.search({ segment: 'factory', area: 'ชลบุรี', count: 10 }, (items, done, total) => parts.push(done + '/' + total + ':' + items.length));
    const took = Date.now() - t0, angles = new Set(calls.map(c => (c.contents[0].parts[0].text.match(/visit — ([^\n]+)/) || [])[1]));
    ok(calls.length === 3 && took < 800 && angles.size === 3, 'ค้น 10 ราย ⇒ แบ่ง 3 ชุดเล็ก ค้นพร้อมกันคนละมุม (ใช้เวลาเท่าชุดเดียว ' + took + ' ms ไม่ใช่ 3 เท่า)');
    ok(calls.every(c => c.generationConfig.thinkingConfig.thinkingBudget === 0) && /ตอบสั้นที่สุด/.test(calls[0].contents[0].parts[0].text), 'ปิด "คิดก่อนตอบ" ตอนค้น · สั่งตอบสั้น ⇒ เร็วขึ้น');
    ok(parts.length === 3 && /^1\/3:[1-9]/.test(parts[0]) && /^3\/3:4$/.test(parts[2]) && r.items.length === 4 && r.items[0].score >= r.items[1].score, 'ชุดไหนเสร็จส่งขึ้นจอทันที (' + parts.join(' → ') + ') · ชื่อซ้ำข้ามชุดตัดทิ้ง · เรียงคะแนน');
    k = 0;
    a = AI.create({ fetch: async () => { const me = ++k; return me === 2 ? gem({ text: '', st: 500 }) : gem({ text: '{"items":[{"name":"บริษัท ร' + me + '"}]}' }); } });
    r = await a.search({ segment: 'factory', count: 10 });
    ok(r.items.length === 2 && r.partsFailed === 1, 'ชุดหนึ่งล้ม ⇒ ชุดอื่นยังขึ้นตามปกติ (ไม่หาไม่เจอทั้งหมด)');
    a = AI.create({ fetch: async (u, o) => new Promise((z, bad) => { o.signal.addEventListener('abort', () => bad(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))); }), timeoutMs: 50 });
    err = null; try { await a.search({ segment: 'hotel', count: 3 }); } catch (e) { err = e; }
    ok(false || (err && /ช้าเกินเวลา/.test(err.message)), 'AI ค้างนาน ⇒ ตัดจบพร้อมบอก "AI ตอบช้าเกินเวลา" (ไม่หมุนค้าง)');
    /* 🛟 v1.2.1 — พี่เอ: "แก้ไขด่วนเลย ทำไมขึ้น error แบบนี้" (ให้อลิซเจาะลึก ⇒ "AI ตอบ 402") */
    process.env.GEMINI_API_KEY = 'g-test'; process.env.ANTHROPIC_API_KEY = 'sk-test'; calls = [];
    a = AI.create({ fetch: async (u, o) => { calls.push(u); return /googleapis/.test(u) ? new Response('{"error":{"code":402}}', { status: 402 }) : cl('{"summary":"ร้านกาแฟหลายสาขา","score":80,"fit":"go","pitch":["ป้ายหน้าร้าน"]}'); } });
    const an = await a.analyzeCompany({ name: 'บริษัท กาแฟ จำกัด', segment: 'food' }, null);
    ok(an.summary === 'ร้านกาแฟหลายสาขา' && an.fit === 'go' && /Claude/.test(an.engine) && calls.some(u => /anthropic/.test(u)), 'เจาะลึก: Gemini ตอบ 402 (เครดิตหมด) ⇒ สลับไปใช้ Claude ให้เอง ไม่ขึ้น error (' + an.engine + ')');
    const av = await a.analyzeVisit({ name: 'บริษัท กาแฟ จำกัด', segment: 'food' }, { note: 'คุยแล้วสนใจ' }, []);
    ok(/Claude/.test(av.engine), 'วิเคราะห์ visit: Gemini 402 ⇒ ใช้ Claude แทนเหมือนกัน');
    process.env.ANTHROPIC_API_KEY = '';
    a = AI.create({ fetch: async () => new Response('{"error":{"code":402}}', { status: 402 }) });
    err = null; try { await a.analyzeCompany({ name: 'บริษัท กาแฟ จำกัด' }, null); } catch (e) { err = e; }
    ok(err && /402/.test(err.message) && /เครดิต/.test(err.message) && /Google AI Studio/.test(err.message), 'ไม่มีกุญแจ Claude ⇒ บอกตรง ๆ ว่าเครดิต Gemini หมด ให้เติมที่ Google AI Studio (ไม่ใช่ "AI ตอบ 402")');
    /* 🩺 v1.2.1 — "ค้นไม่สำเร็จ … กุญแจ AI ใน Railway ใช้ไม่ได้ (400)" ⇒ บอกเหตุผลจริง + ลอง Claude รุ่นสำรอง */
    process.env.GEMINI_API_KEY = 'g-test'; process.env.ANTHROPIC_API_KEY = 'sk-test'; calls = [];
    a = AI.create({ fetch: async (u, o) => { const b = JSON.parse(o.body); calls.push(b.model || 'gemini');
      if (/googleapis/.test(u)) return new Response('{"error":{"code":402,"message":"Your prepayment credits are depleted."}}', { status: 402 });
      return b.model === 'claude-haiku-4-5-20251001' ? cl('{"items":[{"name":"บริษัท ฉ จำกัด"}]}') : new Response('{"type":"error","error":{"type":"invalid_request_error","message":"tool not supported for this model"}}', { status: 400 }); } });
    r = await a.search({ segment: 'retail', count: 3 });
    ok(r.items.length === 1 && calls.indexOf('claude-haiku-4-5-20251001') > 0, 'Gemini 402 + Claude รุ่นหลักตอบ 400 ⇒ ลอง Claude รุ่นสำรองแล้วได้รายชื่อ (' + calls.join(' → ') + ')');
    a = AI.create({ fetch: async (u) => /googleapis/.test(u) ? new Response('{"error":{"code":402,"message":"Your prepayment credits are depleted."}}', { status: 402 })
      : new Response('{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}', { status: 400 }) });
    err = null; try { await a.search({ segment: 'retail', count: 3 }); } catch (e) { err = e; }
    ok(err && /Gemini เครดิตหมด/.test(err.message) && /Claude เครดิตหมด/.test(err.message) && /Anthropic Console/.test(err.message) && !/กุญแจ AI ใน Railway ใช้ไม่ได้/.test(err.message),
       'ทั้งคู่ใช้ไม่ได้ ⇒ บอกเหตุผลจริงของแต่ละเจ้า (เครดิตหมด · ต้องไปเติมที่ไหน) ไม่ใช่ "กุญแจใช้ไม่ได้ (400)"');
    process.env.GEMINI_API_KEY = saveG || ''; process.env.ANTHROPIC_API_KEY = saveC || '';
  }

  head('③ ทั้งระบบ (ฐานทดสอบ)');
  let pg = null, rest = null, srv = null;
  try {
    const { Client } = require('pg');
    pg = new Client({ connectionString: PG }); await pg.connect();
    await pg.query(fs.readFileSync(path.join(ROOT, 'sql/126-visit-b2b.sql'), 'utf8'));
    await pg.query('alter table if exists app.visit_claims rename to visit_claims_hold_t').catch(() => {});   /* 🩹 v1.1.1: เริ่มแบบยังไม่รัน sql/129 */
  } catch (e) { skip++; console.log('  ⏭️  ข้ามส่วนทั้งระบบ: ' + String(e.message || e).slice(0, 160)); if (pg) await pg.end().catch(() => {}); pg = null; }
  if (pg) {
    const U = { boss: 'zzvboss', s1: 'zzvsale1', s2: 'zzvsale2', acc: 'zzvacc' };
    const wipe = async () => {
      await pg.query(`delete from app.app_users where "Username" like 'zzv%'`);
      for (const t of ['visit_prospects', 'visit_events', 'visit_searches', 'visit_reports', 'visit_claims']) await pg.query('delete from app.' + t).catch(() => {});
    };
    /* AI จำลอง — ตอบตามชนิดคำถาม · จดคำถามไว้ตรวจ */
    const asked = [];
    const reply = (obj, search) => new Response(JSON.stringify({ content: (search ? [{ type: 'web_search_tool_result', content: [{ url: 'https://www.dbd.go.th/x', title: 'DBD' }] }] : []).concat([{ type: 'text', text: '```json\n' + JSON.stringify(obj) + '\n```' }]), usage: { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: search ? 2 : 0 } } }), { status: 200 });
    const fakeAI = async (url, opt) => {
      const b = JSON.parse(opt.body), txt = (b.messages[0].content.find(c => c.type === 'text') || {}).text || '', imgs = b.messages[0].content.filter(c => c.type === 'image').length;
      asked.push({ txt, web: !!b.tools, imgs, model: b.model });
      if (/ค้นเว็บจริงเพื่อหา/.test(txt)) return reply({ items: [
        { name: 'บริษัท ซันนี่ ฟู้ด อินดัสทรี จำกัด', phone: '038-111222', bizType: 'โรงงานอาหารแช่แข็ง', address: 'นิคมอมตะนคร ชลบุรี', province: 'ชลบุรี', website: 'https://sunnyfood.example', summary: 'ผู้ผลิตอาหารแช่แข็งส่งออก ขยายโรงงานเฟส 2 ปี 2569', signals: ['สร้างโรงงานใหม่ปี 2569'], score: 86, fit: 'go', reasons: ['ขยายโรงงาน ต้องใช้ป้ายอาคารใหม่'], pitch: ['ตัวอักษรโลหะบนอาคาร', 'ป้ายความปลอดภัย'], sources: ['https://news.example/a'] },
        { name: 'บจก. ทีพีเค พลาสติก', phone: '', bizType: 'โรงงานพลาสติก', address: 'บางปู สมุทรปราการ', score: 52, fit: 'wait' },
        { name: 'บริษัท เล็กน้อย จำกัด', score: 20 },
        { name: 'บริษัท ซันนี่ ฟู้ด อินดัสทรี จำกัด', score: 10 }] }, true);
      if (/วิเคราะห์บริษัทนี้ให้เซลส์ตัดสินใจ/.test(txt)) return reply({ summary: 'ผลิตอาหารแช่แข็ง 3 โรงงาน', phone: '038-111222', juristicId: '0205555000013', score: 88, fit: 'go', verdict: 'ควร focus — ขยายโรงงานปีนี้ งบป้ายชัดเจน', reasons: ['ทุนจดทะเบียน 200 ล้าน'], pitch: ['ป้ายอาคาร'], decisionMakers: ['ฝ่ายวิศวกรรมอาคาร'], openers: ['เฟส 2 จะเปิดเมื่อไหร่ครับ'], risks: [], news: ['2569 ลงทุนโรงงานใหม่'], sources: ['https://news.example/b'] }, true);
      if (/วิเคราะห์ผลการ visit/.test(txt)) return reply({ summary: 'ลูกค้าสนใจป้ายอาคารเฟส 2 ขอใบเสนอราคา', interest: 'high', needs: ['ตัวอักษรโลหะ 3 เมตร'], objections: ['งบต้องผ่านญี่ปุ่น'], photoNotes: ['ผนังอาคารเป็นแผ่นเมทัลชีท'], nextSteps: [{ action: 'ส่งใบเสนอราคา + แบบ 3D', channel: 'quote', inDays: 3 }, { action: 'โทรตามผลพิจารณา', channel: 'call', inDays: 10 }], chance: 62, stage: 'quoted', estValue: 480000, coach: 'รีบส่งแบบก่อนคู่แข่ง' });
      if (/ทำ Summary Report/.test(txt)) { const id = (/\[(vp_[0-9a-f]+)\]/.exec(txt) || [])[1]; return reply({ headline: 'visit 1 ราย โอกาสสูง', overview: 'ภาพรวมดี', wins: ['ตอบเร็ว'], risks: ['งบรออนุมัติ'], customers: [{ id: '[' + id + ']', priority: 'A', plan: ['ส่งใบเสนอราคาใน 3 วัน', 'โทรตามใน 10 วัน'], chance: 60, note: 'มูลค่าสูง' }, { id: 'vp_ปลอม', priority: 'A', plan: ['x'] }], successRate: 58, successNote: 'เฉลี่ยถ่วงโอกาส', teamAdvice: ['ส่งแบบเร็ว'] }); }
      return new Response('{}', { status: 500 });
    };
    const photos = [];
    const fakeStorage = { upload: async (p, buf, mime) => { photos.push({ p, n: buf.length, mime }); return { path: p, url: 'https://cdn.example/' + p, bytes: buf.length }; } };
    try {
      await wipe();
      rest = await require('./fake-postgrest').start(PG, REST_PORT);
      await pg.query(`delete from app.sales_prefix where username like 'zzv%'`).catch(() => {});
      await pg.query(`insert into app.sales_prefix (prefix, username, nickname) values ('ZZV','zzvsale1','เซลส์หนึ่ง') on conflict (prefix) do nothing`).catch(() => {});
      const mkU = (un, name, nick, perm) => pg.query(`insert into app.app_users ("Username","Name","Nickname","Permission","Branch","Status") values ($1,$2,$3,$4,'','Login')`, [un, name, nick, perm]);
      await mkU(U.boss, 'บอส วิสิต', 'บอส', 'Administrator'); await mkU(U.s1, 'เมย์ วิสิต', 'เมย์', 'Sales'); await mkU(U.s2, 'จูน วิสิต', 'จูน', 'Sales'); await mkU(U.acc, 'แอน บัญชี', 'แอน', 'Accounting');
      const auth = require('../core/auth'), express = require('express');
      const users = {};
      for (const r0 of (await pg.query(`select * from app.app_users where "Username" like 'zzv%'`)).rows)
        users[r0.Username] = { username: r0.Username, name: r0.Name, nickname: r0.Nickname, image: '', permission: r0.Permission, role: auth.roleOf(r0.Permission), appAccess: [] };
      const M = require('../modules/visit/index');
      const app = express(); app.use(express.json({ limit: '25mb' }));
      const router = express.Router();
      app.use('/m/visit', (req, res, next) => { const u = users[req.get('x-test-user') || '']; if (!u) return res.status(401).json({ ok: false }); req.user = u; next(); }, router);
      const audits = [];
      await M.mount(router, { key: 'visit', db: require('../core/db'), auth, audit: (u, k, d) => audits.push([k, d]), warn: m => { if (process.env.VERBOSE) console.log('    [warn]', m); },
        ai: AI.create({ fetch: fakeAI }), storage: fakeStorage });
      app.use('/brand', express.static(path.join(ROOT, 'public/brand'))); app.use('/m/visit', express.static(path.join(ROOT, 'modules/visit/public')));
      srv = app.listen(0); const BASE = 'http://127.0.0.1:' + srv.address().port + '/m/visit';
      const call = async (un, method, p2, body) => { const r0 = await realFetch(BASE + p2, { method, headers: Object.assign({ 'content-type': 'application/json' }, un ? { 'x-test-user': un } : {}), body: body == null ? undefined : JSON.stringify(body) }); const txt = await r0.text(); let j = null; try { j = JSON.parse(txt); } catch (e) { /* */ } return { st: r0.status, j }; };

      let r = await call(U.s1, 'GET', '/api/boot');
      ok(r.j.claims.ready === false, '🩹 ยังไม่รัน sql/129 ⇒ หน้าแอปบอกให้รัน');
      await pg.query('alter table if exists app.visit_claims_hold_t rename to visit_claims').catch(() => {});
      await pg.query(fs.readFileSync(path.join(ROOT, 'sql/129-visit-trip-claims.sql'), 'utf8'));
      await new Promise(z => setTimeout(z, 5200));
      r = await call(U.s1, 'GET', '/api/boot');
      ok(r.j.claims.ready === true, '🩹 v1.1.1 (พี่เอ: "พี่ run sql แล้วทำไมยังขึ้นแบบนี้") รัน sql/129 ทีหลัง ⇒ โหลดหน้าใหม่ใช้ได้ทันที ไม่ต้อง deploy ใหม่');
      ok(r.st === 200 && r.j.health.ok && r.j.ai.ready && r.j.ai.engine === 'Claude + web search' && r.j.me.sup === false && r.j.team.length === 1 && r.j.segments.length === Seg.SEGMENTS.length, 'boot: ฐานพร้อม · อลิซพร้อม (Claude + web search) · เซลส์เห็นแค่ตัวเอง');
      r = await call(U.boss, 'GET', '/api/boot');
      ok(r.j.me.sup === true && r.j.team.some(u => u.username === U.s1) && r.j.team.some(u => u.username === U.s2), 'ผู้ดูแลเห็นทีมขายทั้งหมด (มอบหมายได้)');

      /* ค้นหา */
      r = await call(U.s1, 'POST', '/api/search', { segment: 'factory', area: 'ชลบุรี', extra: 'ขยายโรงงาน', count: 10 });
      const q1 = asked[asked.length - 1];
      ok(r.st === 200 && r.j.items.length === 3 && r.j.items[0].name === 'บริษัท ซันนี่ ฟู้ด อินดัสทรี จำกัด' && r.j.items[0].fit === 'go' && r.j.items[2].fit === 'skip', 'ค้นหา ⇒ 3 ราย (ชื่อซ้ำตัดทิ้ง) เรียงคะแนน · ควรไป / รอก่อน / ข้าม');
      ok(q1.web && /โรงงานอุตสาหกรรม/.test(q1.txt) && /ชลบุรี/.test(q1.txt) && /ขยายโรงงาน/.test(q1.txt) && /ห้ามเดาเบอร์/.test(q1.txt), 'อลิซค้นเว็บจริง · ส่งกลุ่มธุรกิจ + พื้นที่ + เงื่อนไข · สั่งห้ามแต่งเบอร์');
      ok(/google\.com\/maps\/search/.test(r.j.items[0].mapsUrl) && r.j.items[0].phone === '038-111222' && r.j.items[0].existing === null, 'ผลมีเบอร์ · ลิงก์ Google Maps · ยังไม่มีในระบบ');
      const SID = r.j.id;
      ok((await pg.query(`select count(*)::int n from app.visit_searches where id=$1`, [SID])).rows[0].n === 1, 'เก็บผลค้นหาไว้ (เปิดดูซ้ำไม่เสียค่า AI)');

      /* ⚡ v1.0.2 ค้นแบบงาน: เริ่มแล้วตอบทันที · ถามความคืบหน้า */
      r = await call(U.s1, 'POST', '/api/search', { segment: 'hotel', area: 'ภูเก็ต', count: 5, stream: true });
      ok(r.st === 200 && /^vj_/.test(r.j.job), 'ค้นแบบงาน ⇒ ตอบเลขงานทันที (ไม่ต้องรอค้นเสร็จ)');
      let jb = null; for (let i = 0; i < 40; i++) { jb = (await call(U.s1, 'GET', '/api/search/job/' + r.j.job)).j; if (jb.finished) break; await new Promise(z => setTimeout(z, 100)); }
      ok(jb && jb.finished && !jb.error && jb.items.length === 3 && /^vs_/.test(jb.id) && jb.total === 2 && jb.done === 2, 'ถามความคืบหน้า ⇒ เสร็จ ' + (jb && jb.done) + '/' + (jb && jb.total) + ' ชุด · ได้ ' + (jb && jb.items.length) + ' ราย · บันทึกผลค้นหาแล้ว');
      ok((await call(U.s2, 'GET', '/api/search/job/' + r.j.job)).st === 404, 'เซลส์คนอื่นแอบดูงานค้นของเพื่อนไม่ได้');
      r = await call(U.s1, 'GET', '/api/ai/test'); const r2 = await call(U.boss, 'GET', '/api/ai/test');
      ok(r.st === 403 && r2.st === 200 && typeof r2.j.ms === 'number', '🩺 ตรวจการเชื่อมต่ออลิซ: เฉพาะหัวหน้า/แอดมิน · บอกเวลาที่ใช้');

      /* บันทึกเป้าหมาย */
      r = await call(U.s1, 'POST', '/api/prospect/save', { item: (await call(U.s1, 'GET', '/api/search/' + SID)).j.items[0], searchId: SID });
      const PID = r.j.id;
      ok(r.st === 200 && /^vp_/.test(PID), 'เพิ่มเป็นลูกค้าเป้าหมาย');
      r = await call(U.s2, 'POST', '/api/prospect/save', { item: { name: 'ซันนี่ ฟู้ด อินดัสทรี' } });
      ok(r.j.existing === true && r.j.id === PID && r.j.owner === U.s1, 'กันซ้ำ: ชื่อเดียวกัน (ไม่สนคำนำหน้า บริษัท/จำกัด) ⇒ บอกว่ามีแล้ว · ของใคร');
      r = await call(U.s1, 'GET', '/api/search/' + SID);
      ok(r.j.items[0].existing && r.j.items[0].existing.id === PID, 'ผลค้นหาเดิมขึ้น "มีในระบบแล้ว"');
      r = await call(U.s2, 'GET', '/api/prospect/' + PID);
      ok(r.st === 403, 'เซลส์คนอื่นเปิดแฟ้มลูกค้าของเพื่อนไม่ได้');
      ok((await call(U.s2, 'GET', '/api/list')).j.items.length === 0 && (await call(U.boss, 'GET', '/api/list')).j.items.length === 1, 'รายการ: เซลส์เห็นของตัวเอง · ผู้ดูแลเห็นทั้งหมด');

      /* เจาะลึก */
      r = await call(U.s1, 'POST', '/api/prospect/analyze', { id: PID });
      ok(r.st === 200 && r.j.p.score === 88 && r.j.p.fit === 'go' && r.j.p.doc.ai.verdict && r.j.p.juristicId === '0205555000013' && r.j.p.doc.ai.openers.length === 1, 'อลิซเจาะลึก: คะแนน · คำแนะนำ · เติมเลขทะเบียนที่ยังว่าง · ประโยคเปิด');

      /* งบ DBD */
      const H = 'หน่วย : บาท\t2566\t2567\t2568\n' + 'จำนวนเงิน\t%เปลี่ยนแปลง\t'.repeat(3) + '\n';
      const DW = 'งบแสดงฐานะการเงิน ข้อมูลปีงบการเงิน 2566 - 2568\n' + H + 'หนี้สินรวม\t50,000,000\t1\t40,000,000\t1\t30,000,000\t1\nส่วนของผู้ถือหุ้น\t60,000,000\t1\t70,000,000\t1\t90,000,000\t1\n' +
        'งบกำไรขาดทุน\n' + H + 'รายได้รวม\t300,000,000\t1\t320,000,000\t1\t350,000,000\t1\nกำไร(ขาดทุน) สุทธิ\t10,000,000\t1\t12,000,000\t1\t20,000,000\t1\n';
      r = await call(U.s1, 'POST', '/api/prospect/fin', { id: PID, text: DW });
      ok(r.st === 200 && r.j.risk.level === 'low' && r.j.p.doc.fin.years.length === 3 && r.j.p.doc.risk.label === 'เสี่ยงต่ำ', 'วางตารางงบจาก DBD ⇒ แกะ 3 ปี ⇒ เสี่ยงต่ำ (ตัวเดียวกับ Ant-Connect)');
      r = await call(U.s1, 'POST', '/api/prospect/fin', { id: PID, text: 'สวัสดี' });
      ok(r.st === 400 && /อ่านตัวเลข/.test(r.j.error), 'วางข้อความที่ไม่ใช่งบ ⇒ บอกวิธีคัดลอกที่ถูก');

      /* นัด + งานติดตาม */
      const T0 = Date.now() + 2 * 864e5;
      r = await call(U.s1, 'POST', '/api/plan', { prospectId: PID, at: new Date(T0).toISOString(), minutes: 90, goal: 'พบฝ่ายวิศวกรรม' });
      const PLAN = r.j.event.id;
      ok(r.st === 200 && r.j.p.stage === 'planned' && r.j.p.nextAt === T0 && /visit/.test(r.j.p.nextAction), 'นัด visit ⇒ ขั้น "นัด visit แล้ว" · งานถัดไป = นัดนี้');
      /* 🧾 1.3.0 พี่เอ: "ดึงข้อมูลของ app Leads & Customer visit ที่ถูกวางแผนในการติดต่อแล้ว ดึงเข้ามาสร้าง รหัสงาน auto" */
      const sj = r.j.sales || {};
      const srow = sj.jobCode ? (await pg.query(`select "รหัสงาน","ลูกค้ามาจากไหน","Lead Status","Sales Code","วิธีติดต่อ" from app.total_sales where "รหัสงาน" = $1`, [sj.jobCode])).rows[0] : null;
      ok(sj.jobCode && /^ZZV/.test(sj.jobCode) && srow && srow['ลูกค้ามาจากไหน'] === 'B2B' && srow['Lead Status'] === 'Onprocess' && srow['Sales Code'] === U.s1 && srow['วิธีติดต่อ'] === 'นัดหมาย' && r.j.p.doc.sales.jobCode === sj.jobCode,
         '🧾 นัด visit แล้ว ⇒ เปิดใบ B2B ในคีย์ยอดขายจริง + รหัสงานคำนำหน้าของเซลส์ (' + (sj.jobCode || sj.error || '-') + ')');
      r = await call(U.s1, 'POST', '/api/task', { prospectId: PID, channel: 'line', title: 'ส่งโปรไฟล์บริษัทให้ทาง LINE', at: new Date(Date.now() - 3600e3).toISOString() });
      ok(r.st === 200 && r.j.p.nextAction === 'ส่งโปรไฟล์บริษัทให้ทาง LINE', 'งานติดตาม (LINE) ⇒ งานถัดไปเลื่อนเป็นงานที่ถึงก่อน');
      let L1 = (await call(U.s1, 'GET', '/api/list')).j;
      ok(L1.kpi.overdue === 1 && L1.items[0].overdue === true && L1.agenda.length === 2, 'ภาพรวม: งานเลยกำหนด 1 · รายการรอทำ 2 (นัด + งาน)');
      const TASK = r.j.event.id;
      r = await call(U.s1, 'POST', '/api/event/update', { id: TASK, status: 'done', result: 'ส่งแล้ว ลูกค้าอ่าน' });
      ok(r.st === 200 && (await call(U.s1, 'GET', '/api/list')).j.kpi.overdue === 0, 'กดทำแล้ว + จดผล ⇒ ไม่เลยกำหนดแล้ว');
      const from = new Date(Date.now() - 864e5).toISOString(), to = new Date(Date.now() + 20 * 864e5).toISOString();
      r = await call(U.s1, 'GET', '/api/calendar?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to));
      ok(r.st === 200 && r.j.events.some(e => e.id === PLAN && e.name.indexOf('ซันนี่') >= 0), 'ปฏิทินเห็นนัด visit พร้อมชื่อลูกค้า');
      ok((await call(U.s2, 'GET', '/api/calendar?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to))).j.events.length === 0, 'ปฏิทินของเซลส์อีกคนไม่เห็นนัดของเพื่อน');

      /* บันทึก visit + รูป ⇒ อลิซ */
      const png = 'data:image/png;base64,' + (await require('sharp')({ create: { width: 2400, height: 1600, channels: 3, background: { r: 120, g: 90, b: 60 } } }).png().toBuffer()).toString('base64');
      r = await call(U.s1, 'POST', '/api/visit', { prospectId: PID, planId: PLAN, note: 'สั้น' });
      ok(r.st === 400, 'สรุปสั้นเกินไป ⇒ ให้เขียนเพิ่ม');
      r = await call(U.s1, 'POST', '/api/visit', { prospectId: PID, planId: PLAN, people: 'คุณสมชาย วิศวกร', note: 'พบฝ่ายวิศวกรรม ต้องการตัวอักษรโลหะบนอาคารเฟส 2 สูง 3 เมตร ขอใบเสนอราคาภายในสัปดาห์นี้ งบต้องผ่านบริษัทแม่', photos: [png, png] });
      const qv = asked[asked.length - 1];
      ok(r.st === 200 && r.j.ai && r.j.ai.chance === 62 && r.j.tasks.length === 2 && r.j.p.stage === 'quoted' && r.j.p.value === 480000, 'บันทึก visit ⇒ อลิซวิเคราะห์ โอกาส 62% · ลงงานถัดไป 2 งาน · เลื่อนเป็น "เสนอราคาแล้ว" · มูลค่าคาดการณ์');
      ok(photos.length === 2 && photos.every(x => /^visit\/vp_[0-9a-f]+\/ve_[0-9a-f]+-\d\.jpg$/.test(x.p) && x.mime === 'image/jpeg') && qv.imgs === 2 && !qv.web, 'รูป 2 รูป ⇒ ย่อเป็น JPG ขึ้นที่เก็บ · ส่งรูปย่อให้อลิซดู (ไม่ค้นเว็บ)');
      ok(!/เมย์|วิสิต|zzv/.test(qv.txt), 'ไม่ส่งชื่อพนักงานไปให้ AI');
      let d1 = (await call(U.s1, 'GET', '/api/prospect/' + PID)).j;
      const auto = d1.events.filter(e => e.kind === 'task' && e.doc.auto);
      ok(auto.length === 2 && auto.some(e => e.doc.channel === 'quote') && d1.events.find(e => e.id === PLAN).status === 'done' && d1.events.some(e => e.kind === 'stage' && /เสนอราคา/.test(e.title)), 'แฟ้ม: งานจากอลิซ (ใบเสนอราคา · โทร) · นัดปิดเป็นทำแล้ว · บันทึกการเปลี่ยนขั้น');
      ok(d1.p.nextAction === 'ส่งใบเสนอราคา + แบบ 3D', 'งานถัดไปของลูกค้า = ส่งใบเสนอราคา (ครบกำหนดก่อน)');

      /* 🚗💰 v1.1.0 การเดินทาง · แก้ไข visit · ใบเบิก · บัญชีอนุมัติ/ทำจ่าย */
      {
        const O = { label: 'ออฟฟิศ', lat: 13.7563, lng: 100.5018, src: 'office' }, D = { label: 'ซันนี่ ฟู้ด', lat: 13.4, lng: 101.0, src: 'gps' };
        r = await call(U.acc, 'GET', '/api/boot');
        ok(r.st === 200 && r.j.claims.ready && r.j.claims.acc && r.j.claims.accOnly && r.j.trip.rates.ev === 4 && r.j.trip.vehicles.length === 2, 'boot: ตารางใบเบิกพร้อม · บัญชี = ฝ่ายอนุมัติ (เปิดที่หน้าเบิกค่าเดินทาง) · อัตรา + ชนิดรถ');
        r = await call(U.s1, 'POST', '/api/trip/preview', { trip: { origin: O, dest: D, vehicle: 'ev' } });
        ok(r.st === 200 && r.j.trip.rate === 4 && r.j.trip.km > 50 && r.j.trip.routeSrc === 'est', 'คำนวณก่อนบันทึก: ' + (r.j.trip && r.j.trip.km) + ' กม. × 4');
        r = await call(U.s1, 'POST', '/api/visit', { prospectId: PID, people: 'คุณสมชาย', note: 'กลับไปวัดหน้างานจุดติดตั้งตัวอักษร ถ่ายรูปผนังเพิ่ม ลูกค้าโอเคกับแบบ', photos: [png], trip: { origin: O, dest: D, vehicle: 'fuel', roundTrip: true } });
        const V2 = r.j.event && r.j.event.id;
        ok(r.st === 200 && r.j.event.doc.trip && r.j.event.doc.trip.roundTrip && r.j.event.doc.trip.rate === 6 && r.j.event.doc.trip.claimId === '', 'บันทึก visit พร้อมการเดินทาง (ไป-กลับ · รถน้ำมัน)');
        r = await call(U.s1, 'POST', '/api/visit', { prospectId: PID, note: 'ทดสอบ visit ที่ใส่ปลายทางไม่ครบ ต้องไม่บันทึก', trip: { origin: O } });
        ok(r.st === 400 && /ต้นทาง/.test(r.j.error), 'ใส่การเดินทางไม่ครบ ⇒ ไม่บันทึก บอกให้ใส่ให้ครบ');
        const V1 = d1.events.find(e => e.kind === 'visit').id;
        r = await call(U.s2, 'POST', '/api/visit/edit', { id: V1, note: 'เซลส์อื่นพยายามแก้ visit ของเพื่อน ต้องไม่ได้' });
        ok(r.st === 403, 'เซลส์คนอื่นแก้ visit ของเพื่อนไม่ได้');
        const old = (await call(U.s1, 'GET', '/api/prospect/' + PID)).j.events.find(e => e.id === V1);
        r = await call(U.s1, 'POST', '/api/visit/edit', { id: V1, people: 'คุณสมชาย + คุณนิด', note: 'แก้สรุป: ลูกค้าต้องการตัวอักษรโลหะ 3 เมตร และกล่องไฟหน้าโรงงาน', removePhotos: [old.doc.photos[0].url], addPhotos: [png], trip: { origin: O, dest: D, vehicle: 'ev', km: 150, kmNote: 'ตามเลขไมล์รถ', toll: '120', tollNote: 'ด่านดินแดง ไป-กลับ' } });
        ok(r.st === 200 && r.j.event.doc.people === 'คุณสมชาย + คุณนิด' && /กล่องไฟ/.test(r.j.event.body) && r.j.event.doc.photos.length === 2 && r.j.event.doc.photos.every(x => x.url !== old.doc.photos[0].url) && r.j.event.doc.trip.km === 150 && r.j.event.doc.trip.fuelAmount === 600 && r.j.event.doc.trip.toll === 120 && r.j.event.doc.trip.amount === 720 && r.j.event.doc.trip.tollNote === 'ด่านดินแดง ไป-กลับ' && r.j.event.doc.trip.manual && r.j.event.doc.editedBy === U.s1, '✏️ แก้ visit: ผู้ที่พบ · สรุป · เอารูปออก/เพิ่มรูป · ใส่การเดินทาง (EV แก้ระยะ 150 กม. ฿600 + 🛣 ทางด่วน ฿120 = ฿720)');
        for (const bad of [-5, 99999, 'abc']) { const rb = await call(U.s1, 'POST', '/api/trip/preview', { trip: { origin: O, dest: D, vehicle: 'fuel', toll: bad } }); ok(rb.st === 400 && /ทางด่วน/.test(rb.j.error), '🛣 ค่าทางด่วนผิด (' + bad + ') ⇒ ไม่รับ: ' + rb.j.error); }
        const month = new Date(Date.now()).toISOString().slice(0, 7);
        if (process.env.VSHOT) {   /* 🛣 v1.4.0 ภาพหน้าจอ: ช่องค่าทางด่วนในฟอร์ม + หน้าทำใบเบิก */
          const { chromium } = require('playwright'); const brz = await chromium.launch();
          const pz = await (await brz.newContext({ viewport: { width: 1280, height: 1000 }, extraHTTPHeaders: { 'x-test-user': U.s1 } })).newPage();
          await pz.route(/^https?:\/\/(?!127\.0\.0\.1)/, rr => rr.fulfill({ status: 200, body: '' }));
          await pz.goto(BASE + '/#trip'); await pz.waitForSelector('.t-sum', { timeout: 15000 }); await pz.waitForTimeout(400);
          await pz.screenshot({ path: path.join(process.env.VSHOT, 'v-trip.png'), fullPage: true });
          await pz.click('tr[data-open="' + PID + '"]'); await pz.waitForTimeout(800); await pz.getByText('visit & ติดตาม', { exact: true }).click();
          await pz.waitForSelector('[data-vedit="' + V1 + '"]', { timeout: 15000 });
          await pz.click('[data-vedit="' + V1 + '"]'); await pz.waitForSelector('.tp-toll', { timeout: 15000 });
          await pz.locator('.tp-toll').scrollIntoViewIfNeeded(); await pz.waitForTimeout(300);
          await pz.screenshot({ path: path.join(process.env.VSHOT, 'v-modal.png') });
          await brz.close();
        }
        r = await call(U.s1, 'GET', '/api/claims/pending?month=' + month);
        const want = Math.round((720 + (await call(U.s1, 'GET', '/api/prospect/' + PID)).j.events.find(e => e.id === V2).doc.trip.amount) * 100) / 100;
        ok(r.st === 200 && r.j.items.length === 2 && r.j.items.every(x => x.customer.indexOf('ซันนี่') >= 0 && x.origin && x.dest && x.mapsUrl && x.photos.length >= 1) && Math.abs(r.j.totalAmount - want) < 0.02, 'หน้าทำใบเบิก: 2 visit (วันที่ · ลูกค้า · สถานที่ · รูป · ต้นทาง/ปลายทาง · ระยะ · ยอด) รวม ฿' + (r.j && r.j.totalAmount));
        ok((await call(U.s2, 'GET', '/api/claims/pending?month=' + month)).j.items.length === 0, 'เซลส์อื่นไม่เห็น visit ของเพื่อนในใบเบิกตัวเอง');
        r = await call(U.s1, 'POST', '/api/claim/submit', { month, note: 'เดือนนี้วิ่งชลบุรี' });
        const CL = r.j.claim;
        ok(r.st === 200 && /^TRV-\d{4}-001$/.test(CL.code) && CL.status === 'submitted' && CL.items.length === 2 && CL.items[0].n === 1 && Math.abs(CL.totalAmount - want) < 0.02 && CL.items.some(x => x.toll === 120 && x.fuelAmount === 600 && x.tollNote), '📨 ส่งใบเบิก (รวมค่าทางด่วนในรายการ) ' + (CL && CL.code) + ' (' + (CL && CL.items.length) + ' รายการ)');
        ok((await call(U.s1, 'GET', '/api/claims/pending?month=' + month)).j.items.length === 0, 'visit ที่ส่งแล้วไม่ขึ้นซ้ำ (กันเบิกซ้ำ)');
        /* 🛣 v1.4.1 เติมค่าทางด่วนในใบที่ส่งแล้ว (รออนุมัติ) */
        { const it2 = CL.items.find(x => !x.toll);
          let rt = await call(U.s2, 'POST', '/api/claim/toll', { id: CL.id, eventId: it2.eventId, toll: 80 });
          ok(rt.st === 403, '🛣 เซลส์อื่นเติมค่าทางด่วนในใบของเพื่อนไม่ได้');
          rt = await call(U.s1, 'POST', '/api/claim/toll', { id: CL.id, eventId: it2.eventId, toll: '80', tollNote: 'ด่านบางนา' });
          const x2 = rt.j.claim && rt.j.claim.items.find(x => x.eventId === it2.eventId);
          ok(rt.st === 200 && x2.toll === 80 && Math.abs(x2.amount - (it2.amount + 80)) < 0.02 && Math.abs(rt.j.claim.totalAmount - (want + 80)) < 0.02, '🛣 เจ้าของใบเติมค่าทางด่วน ฿80 ในใบที่รออนุมัติ ⇒ ยอดใบ ฿' + (rt.j.claim && rt.j.claim.totalAmount));
          const ev2 = (await call(U.s1, 'GET', '/api/prospect/' + PID)).j.events.find(e => e.id === it2.eventId);
          ok(ev2.doc.trip.toll === 80 && ev2.doc.trip.tollNote === 'ด่านบางนา', '   visit ต้นทางได้ค่าทางด่วนตรงกัน (ตีกลับ/ถอนแล้วไม่หาย)');
          rt = await call(U.s1, 'POST', '/api/visit/toll', { id: it2.eventId, toll: 10 });
          ok(rt.st === 409, '🔒 visit ที่อยู่ในใบเบิกแล้ว ต้องเติมที่หน้าใบเบิก ไม่ใช่ที่ visit');
          rt = await call(U.s1, 'POST', '/api/claim/toll', { id: CL.id, eventId: it2.eventId, toll: 0 });
          ok(rt.st === 200 && Math.abs(rt.j.claim.totalAmount - want) < 0.02, '   แก้เป็น 0 ได้ ⇒ ยอดกลับเท่าเดิม'); }
        if (process.env.VSHOT) {
          const { chromium } = require('playwright'); const brz = await chromium.launch();
          const pz = await (await brz.newContext({ viewport: { width: 1280, height: 1000 }, extraHTTPHeaders: { 'x-test-user': U.s1 } })).newPage();
          await pz.route(/^https?:\/\/(?!127\.0\.0\.1)/, rr => rr.fulfill({ status: 200, body: '' }));
          await pz.goto(BASE + '/#trip'); await pz.waitForSelector('[data-claim]', { timeout: 15000 }); await pz.click('[data-claim]'); await pz.waitForSelector('#claimDoc', { timeout: 15000 }); await pz.waitForTimeout(400);
          await pz.locator('#claimDoc').screenshot({ path: path.join(process.env.VSHOT, 'v-claimdoc.png') });
          await pz.click('#claimDoc [data-toll]'); await pz.waitForSelector('[data-mbind="toll"]', { timeout: 10000 });
          await pz.screenshot({ path: path.join(process.env.VSHOT, 'v-tollmodal.png') });
          await brz.close();
        }
        r = await call(U.s1, 'POST', '/api/visit/edit', { id: V1, note: 'พยายามแก้หลังส่งใบเบิกแล้ว ต้องไม่ได้นะ' });
        ok(r.st === 409 && /ใบเบิก/.test(r.j.error), '🔒 visit ในใบเบิกที่ส่งแล้วแก้ไม่ได้');
        r = await call(U.s1, 'POST', '/api/claim/approve', { id: CL.id });
        ok(r.st === 403, 'เซลส์อนุมัติใบเบิกตัวเองไม่ได้');
        ok((await call(U.s2, 'GET', '/api/claim/' + CL.id)).st === 403 && (await call(U.acc, 'GET', '/api/claim/' + CL.id)).st === 200, 'เซลส์อื่นเปิดใบเบิกของเพื่อนไม่ได้ · บัญชีเปิดได้');
        r = await call(U.acc, 'POST', '/api/claim/reject', { id: CL.id, reason: 'x' });
        ok(r.st === 400, 'ตีกลับต้องมีเหตุผล');
        r = await call(U.acc, 'POST', '/api/claim/reject', { id: CL.id, reason: 'ระยะวันที่ทดสอบไม่ตรงเลขไมล์' });
        ok(r.st === 200 && (await call(U.s1, 'GET', '/api/claims/pending?month=' + month)).j.items.length === 2, '↩️ บัญชีตีกลับ ⇒ visit กลับมาแก้/ส่งใหม่ได้');
        r = await call(U.s1, 'POST', '/api/visit/edit', { id: V1, note: 'แก้สรุป: ลูกค้าต้องการตัวอักษรโลหะ 3 เมตร และกล่องไฟหน้าโรงงาน', trip: { origin: O, dest: D, vehicle: 'ev', km: 140, kmNote: 'แก้ตามเลขไมล์จริง' } });
        ok(r.st === 200 && r.j.event.doc.trip.amount === 560, 'แก้ระยะหลังตีกลับได้ (140 กม. = ฿560)');
        r = await call(U.s1, 'POST', '/api/visit/toll', { id: V1, toll: 65, tollNote: 'ด่านพระราม 9' });
        ok(r.st === 200 && r.j.trip.toll === 65 && r.j.trip.amount === 625 && r.j.trip.km === 140, '🛣 หน้าทำใบเบิก: ใส่ค่าทางด่วนให้ visit ที่ยังไม่เบิก (140 กม. ฿560 + ฿65 = ฿625) · ระยะเดิมไม่เปลี่ยน');
        ok((await call(U.s2, 'POST', '/api/visit/toll', { id: V1, toll: 1 })).st === 403 && (await call(U.s1, 'POST', '/api/visit/toll', { id: V1, toll: 5000 })).st === 400, '   เซลส์อื่นใส่ไม่ได้ · เกิน 3,000 บาทไม่รับ');
        r = await call(U.s1, 'POST', '/api/claim/submit', { month });
        const CL2 = r.j.claim;
        ok(r.st === 200 && /-002$/.test(CL2.code), 'ส่งใบใหม่ ' + (CL2 && CL2.code));
        r = await call(U.acc, 'POST', '/api/claim/paid', { id: CL2.id, ref: 'T1' });
        ok(r.st === 400, 'ยังไม่อนุมัติ ⇒ ทำจ่ายไม่ได้');
        r = await call(U.acc, 'POST', '/api/claim/approve', { id: CL2.id });
        ok((await call(U.s1, 'POST', '/api/claim/toll', { id: CL2.id, eventId: V1, toll: 99 })).st === 409, '🔒 อนุมัติแล้ว ⇒ เติมค่าทางด่วนไม่ได้ (ต้องให้บัญชีตีกลับก่อน)');
        const r3 = await call(U.acc, 'POST', '/api/claim/paid', { id: CL2.id, ref: 'โอน KBank 0021', date: '2026-10-25' });
        const fin = (await call(U.s1, 'GET', '/api/claim/' + CL2.id)).j.claim;
        ok(r.st === 200 && r3.st === 200 && fin.status === 'paid' && fin.approvedBy && fin.paidBy && fin.payRef === 'โอน KBank 0021' && fin.payDate === '2026-10-25', '✅ บัญชีอนุมัติ ⇒ 💸 ทำจ่าย (วันที่ + เลขอ้างอิง) · เซลส์เห็นสถานะจ่ายแล้ว');
        r = await call(U.acc, 'GET', '/api/claims?status=paid');
        ok(r.j.all && r.j.items.length === 1 && r.j.items[0].count === 2 && (await call(U.s2, 'GET', '/api/claims')).j.items.length === 0, 'บัญชีเห็นใบของทุกคน · เซลส์อื่นเห็นแค่ของตัวเอง');
        ok(audits.some(a => a[0] === 'visit_claim_paid') && audits.some(a => a[0] === 'visit_edit'), 'จด audit: แก้ visit · ทำจ่าย');
        d1 = (await call(U.s1, 'GET', '/api/prospect/' + PID)).j;
      }

      /* 📥🤖 v1.2.0 พี่เอ: "… ให้ ทีมขาย ใส่ชื่อลูกค้าของตัวเองที่หาไว้ก่อนแล้ว ให้เราช่วยวิเคราะห์ให้ด้วยนะ ว่าลูกค้าแต่ละรายเป็นอย่างไร ควรโฟกัสหรือไม่" */
      {
        const nA = asked.length;
        r = await call(U.s2, 'POST', '/api/prospect/import', { lines: [{ name: 'บริษัท สยามสตีล ไวร์ จำกัด', province: 'ชลบุรี' }, { name: 'โรงแรม ซีบรีซ ริมหาด', phone: '038-301-555' }, { name: 'สยามสตีล ไวร์' }, { name: 'ซันนี่ ฟู้ด อินดัสทรี' }] });
        ok(r.st === 200 && r.j.job && r.j.job.total === 3, 'นำเข้า 4 บรรทัด ⇒ 3 ราย (ชื่อซ้ำในรายการตัดออก)');
        const other = r.j.job.items.find(x => /ซันนี่/.test(x.name));
        ok(other && other.status === 'other' && /เมย์/.test(other.ownerName || ''), 'บริษัทที่เป็นลูกค้าของเซลส์คนอื่นแล้ว ⇒ ไม่แตะ · บอกว่าเป็นของใคร');
        let jb = r.j.job;
        for (let i = 0; i < 60 && !jb.finished; i++) { await new Promise(z => setTimeout(z, 100)); jb = (await call(U.s2, 'GET', '/api/prospect/job/' + jb.id)).j.job; }
        const dn = jb.items.filter(x => x.status === 'done');
        ok(jb.finished && dn.length === 2 && dn.every(x => x.fit === 'go' && x.score === 88 && x.verdict) && asked.slice(nA).filter(q => /วิเคราะห์บริษัทนี้ให้เซลส์ตัดสินใจ/.test(q.txt)).length === 2, '🤖 อลิซวิเคราะห์ทีละราย ⇒ ควรโฟกัสไหม · คะแนน · เหตุผล (2 ราย)');
        const mine = (await call(U.s2, 'GET', '/api/list')).j.items;
        ok(mine.length === 2 && mine.every(p => p.owner === U.s2 && p.doc.analyzed && p.doc.imported && p.fit === 'go' && p.doc.verdict) && mine.some(p => p.province === 'ชลบุรี'), 'ลูกค้าเข้าแฟ้มของเซลส์คนนั้น พร้อมผลวิเคราะห์ · จังหวัดที่ใส่มาเก็บไว้');
        ok((await call(U.s1, 'GET', '/api/prospect/job/' + jb.id)).st === 404, 'เซลส์คนอื่นดูงานวิเคราะห์ของเพื่อนไม่ได้');
        r = await call(U.s2, 'POST', '/api/prospect/import', { lines: Array.from({ length: 31 }, (_, i) => ({ name: 'บริษัททดสอบ ' + i })) });
        ok(r.st === 400 && /30/.test(r.j.error), 'ครั้งละไม่เกิน 30 ราย');
        r = await call(U.s2, 'POST', '/api/prospect/analyze-many', { ids: [PID] });
        ok(r.st === 403, 'สั่งวิเคราะห์ลูกค้าของเซลส์คนอื่นไม่ได้');
        r = await call(U.s2, 'POST', '/api/prospect/analyze-many', { ids: mine.map(p => p.id) });
        ok(r.st === 200 && r.j.job.total === 2, 'วิเคราะห์ใหม่หลายรายจากหน้ารายการ (ปุ่ม "ให้อลิซวิเคราะห์ที่ยังไม่วิเคราะห์")');
        jb = r.j.job; for (let i = 0; i < 60 && !jb.finished; i++) { await new Promise(z => setTimeout(z, 100)); jb = (await call(U.s2, 'GET', '/api/prospect/job/' + jb.id)).j.job; }
        for (const p of mine) await call(U.boss, 'POST', '/api/prospect/delete', { id: p.id });
        const js2 = rd('public/app.js');
        ok(/data-mmode="many"/.test(js2) && /\/prospect\/import/.test(js2) && /data-act="analyzeall"/.test(js2) && /ลูกค้าที่หาไว้เอง/.test(js2), 'หน้าเว็บ: แท็บ "หลายราย (วางรายชื่อ)" · ปุ่มบนหน้าแรก · ปุ่มวิเคราะห์ที่ยังไม่วิเคราะห์');
      }

      /* เปลี่ยนขั้นเอง */
      r = await call(U.s2, 'POST', '/api/prospect/update', { id: PID, fields: { stage: 'won' } });
      ok(r.st === 403, 'เซลส์คนอื่นเปลี่ยนขั้นลูกค้าของเพื่อนไม่ได้');
      r = await call(U.s1, 'POST', '/api/prospect/update', { id: PID, fields: { owner: U.s2 } });
      ok(r.st === 403, 'เซลส์เปลี่ยนผู้ดูแลเองไม่ได้ (เฉพาะหัวหน้า)');
      r = await call(U.s1, 'POST', '/api/prospect/update', { id: PID, fields: { contacts: [{ name: 'คุณสมชาย', role: 'วิศวกรอาคาร', phone: '081-0000000' }], note: 'ชอบงานโลหะ' } });
      ok(r.st === 200 && r.j.p.doc.contacts[0].role === 'วิศวกรอาคาร' && r.j.p.doc.ai && r.j.p.doc.fin, 'แก้ผู้ติดต่อ/บันทึก โดยผลวิเคราะห์ + งบยังอยู่');

      /* รายงาน */
      const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10), mStart = today.slice(0, 8) + '01';
      r = await call(U.boss, 'POST', '/api/report', { from: mStart, to: new Date(Date.now() + 7 * 3600e3 + 30 * 864e5).toISOString().slice(0, 10) });
      const qr = asked[asked.length - 1];
      ok(r.st === 200 && r.j.doc.kpi.customers === 1 && r.j.doc.kpi.visits === 2 && r.j.doc.kpi.plansDone === 1 && r.j.doc.customers[0].photo.indexOf('https://cdn.example/') === 0, 'รายงาน: ตัวเลขคำนวณจากฐาน (ลูกค้า 1 · visit 2 รวมครั้งที่ใส่การเดินทาง · นัดที่ไปจริง 1) + รูปกิจกรรม');
      ok(r.j.doc.ai.successRate === 58 && r.j.doc.ai.customers.length === 1 && r.j.doc.ai.customers[0].id === PID && r.j.doc.ai.customers[0].plan.length === 2 && r.j.doc.ai.customers[0].priority === 'A', 'อลิซ: อัตราความสำเร็จ 58% · แผนงานรายลูกค้าครบทุกราย · รายที่ไม่มีจริงถูกตัดทิ้ง');
      ok(/ทุกรายตามรายการ/.test(qr.txt) && /ห้ามเปลี่ยน/.test(qr.txt) && r.j.doc.kpi.expectedWins > 0 && r.j.doc.kpi.weightedRate === 62, 'สั่งอลิซให้ครบทุกราย · KPI คาดการณ์ (ถ่วงโอกาส 62%) ไม่ให้ AI แก้');
      ok((await call(U.s2, 'POST', '/api/report', { from: mStart, to: today })).j.doc.kpi.customers === 0, 'เซลส์อีกคนทำรายงานได้แค่ของตัวเอง');
      ok((await call(U.boss, 'GET', '/api/reports')).j.items.length >= 1, 'รายงานเก็บไว้ย้อนดูได้');

      /* ลบ */
      r = await call(U.s2, 'POST', '/api/prospect/delete', { id: PID });
      ok(r.st === 403, 'เซลส์อื่นลบไม่ได้');
      r = await call(U.boss, 'POST', '/api/prospect/delete', { id: PID });
      ok(r.st === 200 && (await pg.query(`select count(*)::int n from app.visit_events where prospect_id=$1`, [PID])).rows[0].n === 0 && audits.some(a => a[0] === 'visit_prospect_delete'), 'ผู้ดูแลลบได้ ⇒ ลบประวัติทั้งหมด + จด audit');

      /* ไม่มีกุญแจ AI */
      delete process.env.ANTHROPIC_API_KEY;
      r = await call(U.s1, 'POST', '/api/search', { segment: 'hotel' });
      ok(r.st === 503 && /ANTHROPIC_API_KEY/.test(r.j.error), 'ไม่มีกุญแจ AI ⇒ บอกให้ตั้งใน Railway (ไม่ล้ม)');
      process.env.ANTHROPIC_API_KEY = 'sk-test-visit';
    } catch (e) { fail++; console.log('  ❌ ส่วนทั้งระบบล้ม: ' + (e.stack || e)); }
    finally {
      try { srv && srv.close(); } catch (e) { /* */ }
      await wipe().catch(() => {}); if (rest) await rest.close().catch(() => {}); await pg.end().catch(() => {});
    }
  }
  console.log('\n' + (fail ? '❌' : '✅') + ' ผ่าน ' + pass + ' · ไม่ผ่าน ' + fail + (skip ? ' · ข้าม ' + skip : ''));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
