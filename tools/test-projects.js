'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  🗂️ Projects Management — npm run test:projects
 *
 *  พี่เอสั่ง 8 ก.ย. 69:
 *    "ไป copy code เดิม 100% มาทำตอนนี้เลย เอาให้ครบทุกบรรทัดนะ
 *     อย่าคิดเอง อย่าข้าม อย่าเพิ่มอะไรตอนที่สร้าง app"
 *
 *  ชุดนี้พิสูจน์ทีละข้อว่ากติกาของแอปเดิมถูกยกมาครบจริง ไม่ใช่แค่หน้าตาเหมือน:
 *    ① ตัวเลือกทุกชุด (ENUMS Code.gs:65) ลำดับเดิมเป๊ะ
 *    ② เปิดงานใหม่ — ID 8 hex ตัวแรกเป็นตัวอักษร · งานย่อย · นับกลุ่มงาน
 *    ③ วันที่ — เก็บเป็น ค.ศ. ไม่ใช่ พ.ศ. · วันที่ไม่มีจริงต้องถูกปฏิเสธ
 *    ④ ไม่ใส่วันส่งมอบ → ปฏิเสธด้วยข้อความเดิมคำต่อคำ
 *    ⑤ แก้ไขงาน — งานย่อยที่เอาออกต้องหาย และต้องเข้าถังขยะ (ของเดิมมีถังขยะ)
 *    ⑥ ลบงาน — เข้าถังขยะทั้งงานหลัก+งานย่อย · สิทธิ์ตาม canDeleteProject_
 *    ⑦ กล่องงาน — _boxOf_ (Code.gs:1916) ครบทุกทาง รวม 3 ทางหลัง Complete
 *    ⑧ ปุ่ม "จบงาน" — เฉพาะ admin, namna, suntorn (FORCE_FINISH_USERS)
 *    ⑨ Outsource — แก้ได้เฉพาะ admin/namna · กันชื่อซ้ำ
 *    ⑩ Dashboard — นับ "Project + งานย่อย" ตามกติกาเดิม
 *    ⑪ ปฏิทินกราฟิก — งานที่ช่วง [Started, Due] ทับช่วงที่เลือก
 *    ⑫ ค้นหา — มีเงื่อนไข = สแกนทั้งตาราง เจองานเก่าเกินเพดาน index
 *    ⑬ เครื่องมือดูแลระบบ — ยกมาครบ ไม่ได้ข้าม
 *    ⑭ 🔒 ไม่เขียนชีตเดิมแม้แต่บรรทัดเดียว + ยามกันชีตทับงานใหม่
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');

const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:55432/postgres';
const REST_PORT = 55501;
const APP_PORT = 55502;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = t => console.log('\n' + t);
/* 🔴 ห้ามใช้ toISOString() ตัดวันที่ — คืนวัน "ตาม UTC"
 *   ตี 0–7 โมงบ้านเรา UTC ยังเป็นเมื่อวาน ⇒ เทสต์แดงเองวันละ 7 ชั่วโมง
 *   ทั้งที่เซิร์ฟเวอร์ตอบถูก (เจอจริง 9 ก.ย. 69 ตอน UTC 23:09 = ไทย 06:09)
 *   ใช้ตัวกลางตัวเดียวกับเซิร์ฟเวอร์ ไม่งั้นเทสต์กับของจริงคิดวันคนละแบบ */
const { todayTH: _todayTH } = require('../core/thai-date');
const dISO = n => _todayTH(new Date(Date.now() - n * 86400000));
const fISO = n => _todayTH(new Date(Date.now() + n * 86400000));

(async () => {
  console.log('\n🧪 Projects Management (ยกจาก Code.gs 2,772 บรรทัด)\n');

  const pg = new Client({ connectionString: PG });
  await pg.connect();
  /* ‼ ล้างเฉพาะของชุดนี้ แล้วหว่านเอง — เทสต์ต้องรันสลับลำดับกันได้ */
  await pg.query('delete from app.projects');
  await pg.query('delete from app.requirements');
  await pg.query('delete from app.projects_trash');
  await pg.query('delete from app.requirements_trash');
  await pg.query('delete from app.outsource');
  await pg.query('delete from app.channels');
  await pg.query('delete from app.contacts');
  await pg.query('delete from app.img_index');

  const hash = require('bcryptjs').hashSync('test1234', 10);
  await pg.query(`insert into app.app_users ("Username","Nickname","Name","Permission","PasswordHash","Status","Impage")
     values ('admin','แอดมิน','Administrator','Administrator',$1,'Login','User_Images/admin.jpg'),
            ('pjsale','หนึ่ง','(หนึ่ง) หนึ่งฤทัย','Sale',$1,'Login','User_Images/nueng.jpg'),
            ('pjsale2','สอง','(สอง) สองสมร','Sale',$1,'Login',null),
            ('pjgra','โย','(โย) โยธิน กราฟิก','Graphic',$1,'Login','User_Images/yo.jpg'),
            ('pjgra2','ก้อย','(ก้อย) ก้อยกราฟิก','Graphic',$1,'Login',null),
            ('pjout','เก่า','(เก่า) พนักงานลาออก','Graphic',$1,'Logout',null)
     on conflict (lower("Username")) do update set "PasswordHash" = excluded."PasswordHash",
       "Permission" = excluded."Permission", "Nickname" = excluded."Nickname",
       "Name" = excluded."Name", "Status" = excluded."Status", "Impage" = excluded."Impage"`, [hash]);
  /* พนักงานที่ลาออก (Status = Logout) ต้องไม่ขึ้นในรายการกราฟิก */
  await pg.query(`update app.app_users set "Status"='ลาออก' where "Username"='pjout'`);

  await pg.query(`insert into app.contacts (_row,"ID","First Name","แสดงชื่อบริษัท","Company","Phone","Create By")
     values (1,'c0000001','คุณเอ','บ.ลูกค้าหนึ่ง จำกัด','บ.ลูกค้าหนึ่ง จำกัด','0810000001','(หนึ่ง) หนึ่งฤทัย'),
            (2,'c0000002','คุณบี','บ.ลูกค้าสอง จำกัด','บ.ลูกค้าสอง จำกัด','0820000002','(สอง) สองสมร')`);
  await pg.query(`insert into app.channels (_row,"Channel") values (1,'Facebook'),(2,'Line OA')`);
  await pg.query(`insert into app.outsource (_row,_extra)
     values (1,'{"ชื่อบริษัท":"โรงงาน ก"}'::jsonb),(2,'{"ชื่อบริษัท":"โรงงาน ข"}'::jsonb)`);
  /* สารบัญรูปเดิม (แท็บ _ImgIndex) — ต้องแปลง path เป็นรูปได้โดยไม่ยิง Drive */
  await pg.query(`insert into app.img_index (_row,path,fid)
     values (1,'Projects_Images/old.jpg','FID-OLD-1')`);

  /* ── งานเก่า 1 ใบ ไว้ทดสอบ "ค้นหาเจองานเก่า" + กล่องจบงาน ── */
  await pg.query(`insert into app.projects (_row,"ID","Project","แสดงชื่อลูกค้า","ชื่อลูกค้า",
      "พนักงานขาย","Owner","Status","ประเภทงาน","กลุ่มงาน","Started","Due","Complete",
      "วันที่ส่งมอบให้ลูกค้า","acc_result","acc_confirm_date","ผู้ยืนยันรับเงิน","Status JobOrder","Image")
     values (1,'a1111111','งานเก่า ปีที่แล้ว','บ.ลูกค้าหนึ่ง จำกัด','c0000001',
      '(หนึ่ง) หนึ่งฤทัย','(โย) โยธิน กราฟิก','Complete','ติดตั้งใหม่','กลุ่มงานป้าย',
      $1,$2,$3,$3,'ได้รับเงินแล้ว',$3,'บัญชี ก','เข้าแผนผลิตแล้ว','Projects_Images/old.jpg')`,
    [dISO(400), dISO(390), dISO(380)]);

  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  const env = { ...process.env,
    SUPABASE_URL: `http://127.0.0.1:${REST_PORT}`, SUPABASE_KEY: 'test-key',
    SESSION_SECRET: 'a'.repeat(64), NODE_ENV: 'development', PORT: String(APP_PORT),
    SYNC_ON_BOOT: '0', SYNC_EVERY_MIN: '0' };
  const app = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'pipe' });
  let booted = false;
  app.stdout.on('data', d => { if (String(d).includes('พอร์ต')) booted = true; });
  app.stderr.on('data', d => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 80 && !booted; i++) await sleep(200);

  const base = `http://127.0.0.1:${APP_PORT}`;
  const login = async who => {
    const r = await fetch(base + '/api/login', { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: who, password: 'test1234' }) });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    return sc.map(s => s.split(';')[0]).join('; ');
  };
  const get = async (cookie, p) => (await fetch(base + '/m/projects' + p, { headers: { cookie } })).json();
  const post = async (cookie, p, body) => {
    const r = await fetch(base + '/m/projects' + p, { method: 'POST',
      headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    let j = null; try { j = await r.json(); } catch { j = null; }
    return { status: r.status, body: j || {} };
  };

  try {
    const boss = await login('admin');
    const sale = await login('pjsale');
    const sale2 = await login('pjsale2');
    ok(!!boss && !!sale && !!sale2, 'ล็อกอินได้ทั้งแอดมินและเซลส์ 2 คน');

    /* ═══ ① ตัวเลือก dropdown — ENUMS (Code.gs:65) ═══ */
    head('① ตัวเลือกทุกชุด ต้องตรงกับของเดิมทั้งค่าและลำดับ');
    const O = await get(sale, '/api/options');
    ok(JSON.stringify(O.workGroups) === JSON.stringify(['กลุ่มงานพิมพ์', 'กลุ่มงานป้าย']),
       'กลุ่มงาน 2 อย่าง ลำดับเดิม');
    /* 🎨 v1.6.1 พี่เอ 7 พ.ย. 69: "ช่วยเพิ่ม ประเภทงาน เคลมจากกราฟิค / ฝ่ายขาย ให้ด้วยนะ" ⇒ 14 รายการ (ต่อจากเคลมติดตั้ง) */
    ok((O.jobTypes || []).length === 14 && O.jobTypes[0] === 'เริ่มออกแบบใหม่'
       && O.jobTypes[5] === 'งานเคลม(กราฟิค-ขาย) = เสียจากกราฟิก/ขาย'
       && O.jobTypes[13] === 'วาง scale ตัวอักษร',
       '‼ ประเภทงาน 14 รายการครบ · เคลมกราฟิค-ขาย ต่อจากเคลมติดตั้ง (ได้ ' + (O.jobTypes || []).length + ')');
    ok((O.deliveryTypes || []).length === 5 && O.deliveryTypes[4] === 'จัดส่งให้ช่างติดตั้ง',
       'ประเภทการจัดส่ง 5 รายการครบ');
    ok((O.statuses || []).length === 6 && O.statuses[1] === 'Meeting กระดุมเม็ดแรก',
       'สถานะงาน 6 รายการ รวม "Meeting กระดุมเม็ดแรก"');
    ok((O.reqJobTypes || []).length === 8 && O.reqJobTypes[6] === 'เช็คพื้นที่ / วางไกด์',
       'ประเภทงานย่อย 8 รายการ');
    ok(JSON.stringify(O.jobOrderStatuses) === JSON.stringify(['เข้าแผนผลิตแล้ว']),
       'Status JobOrder มีค่าเดียวตามของเดิม');
    const gnames = (O.graphics || []).map(g => g.name);
    ok(gnames.length === 2 && gnames.indexOf('(โย) โยธิน กราฟิก') >= 0,
       'รายชื่อกราฟิก = คนที่ Permission มีคำว่า Graphic (ได้ ' + gnames.length + ' คน)');
    ok(gnames.indexOf('(เก่า) พนักงานลาออก') < 0,
       '‼ คนที่ Status = ลาออก ต้องไม่ขึ้นในรายชื่อ (กติกาเดิม Code.gs:408)');
    ok((O.channels || []).join('|') === 'Facebook|Line OA', 'ช่องทางมาจากตาราง Channel');
    ok((O.outsources || []).join('|') === 'โรงงาน ก|โรงงาน ข', 'รายชื่อ Outsource มาจากตาราง CalPrice');
    ok((O.contactSales || []).length >= 2,
       'รายชื่อพนักงานขายในป๊อปอัปเพิ่มลูกค้า (sales-like) ' + (O.contactSales || []).length + ' คน');

    /* ═══ ② เปิดงานใหม่ — createProject (Code.gs:1202) ═══ */
    head('② เปิดงานใหม่');
    let r = await post(sale, '/api/project/create', {
      contactId: 'c0000001', companyName: 'บ.ลูกค้าหนึ่ง จำกัด', sales: '(หนึ่ง) หนึ่งฤทัย',
      project: 'B2G7/019 ร้านทดสอบ', workGroup: 'กลุ่มงานป้าย', jobType: 'ติดตั้งใหม่',
      owner: '(โย) โยธิน กราฟิก', status: 'Not Started', deliveryType: 'ติดตั้ง', deliveryAddress: '99 ถ.ทดสอบ บางนา กทม.', locationMaps: 'https://maps.app.goo.gl/abc123', 
      started: dISO(1), due: fISO(7), deliveryCust: fISO(10),
      description: 'ป้ายหน้าร้าน 2 จุด',
      requirements: [
        { requirement_name: 'ป้ายหน้าร้าน', job_type: 'ป้ายไฟออกหน้า', work_group: 'กลุ่มงานป้าย',
          size_w: 300, size_h: 80, quantity: 1, brief_detail: 'ไฟ LED' },
        { requirement_name: 'สติกเกอร์กระจก', job_type: 'งานกราฟิก', work_group: 'กลุ่มงานพิมพ์',
          size_w: 120, size_h: 60, quantity: 2 },
      ],
    });
    ok(r.body.ok === true, 'บันทึกงานใหม่ได้' + (r.body.error ? ' — ' + r.body.error : ''));
    const P1 = r.body.id;
    ok(/^[a-f][0-9a-f]{7}$/.test(P1 || ''),
       '‼ รหัสงาน 8 ตัว hex และตัวแรกเป็นตัวอักษรเสมอ (genId8_ Code.gs:322) — ได้ ' + P1);
    ok(r.body.requirements === 2, 'งานย่อยเข้า 2 รายการ (ได้ ' + r.body.requirements + ')');

    let row = (await pg.query(`select * from app.projects where "ID"=$1`, [P1])).rows[0];
    ok(row && Number(row['จำนวนงานพิมพ์']) === 1 && Number(row['จำนวนงานป้าย']) === 1,
       '‼ นับงานย่อยแยกกลุ่มเก็บที่แถวโปรเจกต์ (countGroups_ Code.gs:2289) — พิมพ์ 1 · ป้าย 1');
    ok(row && row['Updated At'], '‼ ประทับ Updated At ไว้ — ยามกันชีตทับงานที่คีย์ในระบบใหม่');

    /* ═══ ③ วันที่ — toBE_ (Code.gs:286) ═══ */
    head('③ วันที่');
    const isoOf = v => (v instanceof Date) ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
    const startedY = isoOf(row.Started).slice(0, 4);
    ok(Number(startedY) < 2400,
       '‼ เก็บเป็น ค.ศ. ไม่ใช่ พ.ศ. (ได้ปี ' + startedY + ') — ถ้าเป็น 25xx คือบวก 543 ผิด');
    ok(isoOf(row.Started) === dISO(1),
       'วันที่เริ่มตรงกับที่ส่งไปเป๊ะ (' + isoOf(row.Started) + ')');
    const reqs1 = (await pg.query(`select * from app.requirements where project_id=$1 order by _row`, [P1])).rows;
    ok(reqs1.length === 2 && reqs1[0].designer === '(โย) โยธิน กราฟิก',
       'งานย่อยได้ designer จาก Owner ของงานหลัก (Code.gs:1278)');
    ok(isoOf(reqs1[0].meeting_date) === dISO(1),
       'meeting_date ของงานย่อย = วันที่เริ่มของงานหลัก (Code.gs:1286)');

    /* วันที่ที่ไม่มีจริง (31 กุมภาพันธ์) ต้องถูกปฏิเสธ ไม่ใช่ปัดเป็น 3 มี.ค. */
    r = await post(sale, '/api/project/create', {
      contactId: 'c0000001', companyName: 'บ.ลูกค้าหนึ่ง จำกัด', sales: '(หนึ่ง) หนึ่งฤทัย',
      project: 'วันที่พัง', workGroup: 'กลุ่มงานป้าย', jobType: 'ติดตั้งใหม่',
      deliveryType: 'ติดตั้ง', deliveryAddress: '99 ถ.ทดสอบ บางนา กทม.', locationMaps: 'https://maps.app.goo.gl/abc123',  started: '2026-02-31', due: '', deliveryCust: fISO(5),
    });
    const badId = r.body.id;
    const badRow = (await pg.query(`select "Started" from app.projects where "ID"=$1`, [badId])).rows[0];
    ok(badRow && badRow.Started && isoOf(badRow.Started) !== '2026-03-03',
       '‼ 31 ก.พ. ไม่มีจริง → ไม่บันทึกวันนั้น (ตกไปใช้วันนี้แทน ไม่ใช่ปัดเป็น 3 มี.ค.)');
    /* เก็บกวาดงานทดสอบวันที่ ไม่ให้ไปปนกับการนับกล่องในข้อ ⑦ */
    await pg.query(`delete from app.projects where "ID"=$1`, [badId]);

    /* ═══ ④ ไม่ใส่วันส่งมอบ → ปฏิเสธด้วยข้อความเดิม ═══ */
    head('④ ด่านตรวจก่อนบันทึก');
    r = await post(sale, '/api/project/create', { project: 'ไม่มีวันส่งมอบ' });
    ok(r.status === 400 && r.body.error === 'กรุณาระบุวันที่ส่งมอบให้ลูกค้า ก่อนบันทึก',
       '‼ ข้อความปฏิเสธตรงกับของเดิมคำต่อคำ (Code.gs:1203)');

    /* 📍 v1.6.0 · พี่เอ 28 ต.ค. 69: "ถ้าประเภทงานติดตั้ง ถ้าไม่ใส่ที่อยู่ กับ ลิงค์โลเคชั่น จะไม่ให้บันทึก" */
    const nInst0 = (await pg.query(`select count(*)::int n from app.projects`)).rows[0].n;
    const base = { contactId: 'c0000001', companyName: 'บ.ลูกค้าหนึ่ง จำกัด', sales: '(หนึ่ง) หนึ่งฤทัย',
      project: 'ติดตั้งไม่มีที่อยู่', workGroup: 'กลุ่มงานป้าย', jobType: 'ติดตั้งใหม่',
      deliveryType: 'ติดตั้ง', started: dISO(1), due: fISO(7), deliveryCust: fISO(10) };
    r = await post(sale, '/api/project/create', { ...base });
    ok(r.status === 400 && /ที่อยู่จัดส่ง/.test(r.body.error) && /Location maps/.test(r.body.error),
       '‼ งานติดตั้ง ไม่ใส่ทั้งที่อยู่และลิงก์ → ไม่ให้บันทึก (' + r.body.error + ')');
    r = await post(sale, '/api/project/create', { ...base, deliveryAddress: '99 ถ.ทดสอบ' });
    ok(r.status === 400 && /Location maps/.test(r.body.error) && !/ที่อยู่จัดส่ง/.test(r.body.error),
       '‼ มีที่อยู่แต่ไม่มีลิงก์ → ไม่ให้บันทึก บอกเฉพาะช่องที่ขาด');
    r = await post(sale, '/api/project/create', { ...base, locationMaps: 'https://maps.app.goo.gl/x1' });
    ok(r.status === 400 && /ที่อยู่จัดส่ง/.test(r.body.error), '‼ มีลิงก์แต่ไม่มีที่อยู่ → ไม่ให้บันทึก');
    r = await post(sale, '/api/project/create', { ...base, deliveryAddress: '99 ถ.ทดสอบ', locationMaps: 'บางนา' });
    ok(r.status === 400 && /https/.test(r.body.error), '‼ ลิงก์ไม่ใช่ URL (พิมพ์ชื่อสถานที่) → ไม่ให้บันทึก');
    r = await post(sale, '/api/project/create', { ...base, deliveryType: 'จัดส่ง' });
    ok(r.body.ok === true, 'ประเภทอื่น (จัดส่ง) ไม่ใส่ที่อยู่ ยังบันทึกได้ตามเดิม' + (r.body.error ? ' — ' + r.body.error : ''));
    if (r.body.id) await pg.query(`delete from app.requirements where project_id=$1`, [r.body.id]).catch(() => {});
    if (r.body.id) await pg.query(`delete from app.projects where "ID"=$1`, [r.body.id]);
    ok((await pg.query(`select count(*)::int n from app.projects`)).rows[0].n === nInst0, '  ‼ ใบที่ถูกปฏิเสธไม่มีแถวไหนหลุดลงฐาน');

    /* ═══ ⑤ แก้ไขงาน — updateProject (Code.gs:2710) ═══ */
    head('⑤ แก้ไขงานเดิม');
    let G = await get(sale, '/api/project/' + P1);
    ok(G.project && G.project.project === 'B2G7/019 ร้านทดสอบ', 'อ่านงานกลับมาแก้ไขได้');
    ok((G.project.requirements || []).length === 2, 'งานย่อยติดมาครบ 2 ใบ');
    ok(G.project.row > 0, 'ส่งเลขแถวกลับไปด้วย → ตอนบันทึกไม่ต้องค้นใหม่ (Code.gs:2689)');

    const keep = G.project.requirements[0];
    r = await post(sale, '/api/project/update', {
      id: P1, row: G.project.row,
      contactId: 'c0000001', companyName: 'บ.ลูกค้าหนึ่ง จำกัด', sales: '(หนึ่ง) หนึ่งฤทัย',
      project: 'B2G7/019 ร้านทดสอบ (แก้แล้ว)', workGroup: 'กลุ่มงานป้าย', jobType: 'ติดตั้งใหม่',
      owner: '(ก้อย) ก้อยกราฟิก', status: 'In Progress', deliveryType: 'ติดตั้ง', deliveryAddress: '99 ถ.ทดสอบ บางนา กทม.', locationMaps: 'https://maps.app.goo.gl/abc123', 
      started: dISO(1), due: fISO(7), deliveryCust: fISO(10),
      requirements: [{ ...keep, requirement_name: 'ป้ายหน้าร้าน (แก้ชื่อ)' }],
    });
    ok(r.body.ok === true, 'อัปเดตงานได้' + (r.body.error ? ' — ' + r.body.error : ''));
    { const r9 = await post(sale, '/api/project/update', { id: P1, row: G.project.row, contactId: 'c0000001', project: 'x',
        deliveryType: 'ติดตั้ง', deliveryAddress: '', locationMaps: '', deliveryCust: fISO(10) });
      ok(r9.status === 400 && /ที่อยู่จัดส่ง/.test(r9.body.error), '‼ แก้งานติดตั้งแล้วลบที่อยู่/ลิงก์ออก → ไม่ให้บันทึก');
      const keepRow = (await pg.query(`select "Project" from app.projects where "ID"=$1`, [P1])).rows[0];
      ok(keepRow && keepRow.Project === 'B2G7/019 ร้านทดสอบ (แก้แล้ว)', '  ข้อมูลเดิมไม่ถูกแตะ'); }
    const reqs2 = (await pg.query(`select * from app.requirements where project_id=$1`, [P1])).rows;
    ok(reqs2.length === 1 && reqs2[0].requirement_name === 'ป้ายหน้าร้าน (แก้ชื่อ)',
       '‼ งานย่อยที่เอาออกจากฟอร์มถูกลบจริง เหลือ 1 ใบและชื่อเปลี่ยนตาม');
    const trashR = (await pg.query(`select * from app.requirements_trash where project_id=$1`, [P1])).rows;
    ok(trashR.length === 1,
       '‼ งานย่อยที่ถูกเอาออก เข้าถังขยะ ไม่ได้หายถาวร (กู้คืนได้เหมือนของเดิม)');
    row = (await pg.query(`select * from app.projects where "ID"=$1`, [P1])).rows[0];
    ok(Number(row['จำนวนงานป้าย']) === 1 && !Number(row['จำนวนงานพิมพ์']),
       'ตัวเลขนับงานย่อยที่แถวโปรเจกต์ถูกคิดใหม่ตามฟอร์ม');

    /* ═══ ⑥ ลบงาน — deleteProject (Code.gs:2313) ═══ */
    head('⑥ ลบงาน + สิทธิ์ลบ (canDeleteProject_ Code.gs:2261)');
    let C = await get(sale2, '/api/can-delete/' + P1);
    ok(C.can === false, 'เซลส์คนอื่นเห็นว่าลบไม่ได้');
    r = await post(sale2, '/api/project/delete', { id: P1 });
    ok(r.status === 403 && /ลบได้เฉพาะงานของตัวเอง/.test(r.body.error || ''),
       '‼ ยิงตรงเข้า API เอง → เซิร์ฟเวอร์ปฏิเสธ ด้วยข้อความเดิม (ไม่ใช่แค่ซ่อนปุ่ม)');
    C = await get(sale, '/api/can-delete/' + P1);
    ok(C.can === true, 'เจ้าของงาน (พนักงานขายคนเดียวกัน) ลบได้');

    r = await post(sale, '/api/project/delete', { id: P1 });
    ok(r.body.ok === true && r.body.requirements === 1, 'ลบงานพร้อมงานย่อย 1 ใบ');
    ok((await pg.query(`select 1 from app.projects where "ID"=$1`, [P1])).rows.length === 0,
       'งานหายจากตารางหลักแล้ว');
    const trashP = (await pg.query(`select * from app.projects_trash where project_id=$1`, [P1])).rows;
    ok(trashP.length === 1 && trashP[0].deleted_by === 'pjsale',
       '‼ งานถูกย้ายเข้าถังขยะพร้อมชื่อคนลบ (trashSheet_ Code.gs:2299)');
    ok(trashP[0].data && trashP[0].data.Project,
       'ถังขยะเก็บข้อมูลทั้งแถวไว้ กู้คืนได้ครบทุกช่อง');

    /* ═══ ⑦ กล่องงาน — _boxOf_ (Code.gs:1916) ═══ */
    head('⑦ กล่องงานบน Dashboard');
    const mk = async (id, rowNo, status, extra) => {
      const c = { Complete: null, acc_result: null, acc_confirm_date: null,
                  'Status JobOrder': null, 'ปิดงานย้อนหลัง': null, ...(extra || {}) };
      await pg.query(`insert into app.projects (_row,"ID","Project","แสดงชื่อลูกค้า","พนักงานขาย","Owner",
          "Status","กลุ่มงาน","Started","Due","Complete","acc_result","acc_confirm_date",
          "Status JobOrder","ปิดงานย้อนหลัง")
        values ($1,$2,$3,'บ.ลูกค้าหนึ่ง จำกัด','(หนึ่ง) หนึ่งฤทัย','(โย) โยธิน กราฟิก',
                $4,'กลุ่มงานป้าย',$5,$6,$7,$8,$9,$10,$11)`,
        [rowNo, id, 'กล่อง ' + status, status, dISO(1), fISO(5),
         c.Complete, c.acc_result, c.acc_confirm_date, c['Status JobOrder'], c['ปิดงานย้อนหลัง']]);
    };
    await mk('b0000001', 101, 'Not Started');
    await mk('b0000002', 102, 'งานด่วน');
    await mk('b0000003', 103, 'Meeting กระดุมเม็ดแรก');
    await mk('b0000004', 104, 'In Progress');
    await mk('b0000005', 105, 'จองคิวติดตั้งก่อน Complete');
    await mk('b0000006', 106, 'Complete', { Complete: dISO(0) });                                 /* รอบัญชีตรวจ */
    await mk('b0000007', 107, 'Complete', { Complete: dISO(0), acc_result: 'ได้รับเงินแล้ว', acc_confirm_date: dISO(0) }); /* บัญชีตรวจแล้ว */
    await mk('b0000008', 108, 'Complete', { Complete: dISO(0), 'Status JobOrder': 'เข้าแผนผลิตแล้ว' }); /* จบงาน */

    let D = await get(sale, '/api/dashboard?period=month');
    const cnt = k => (D.boxes[k] || []).reduce((a, x) => a + x.count, 0);
    ok(cnt('notstarted') === 1, 'กล่องงานใหม่ 1 ใบ');
    ok(cnt('urgent') === 1, 'กล่องงานด่วน 1 ใบ');
    ok(cnt('meeting') === 1, 'กล่อง Meeting 1 ใบ');
    ok(cnt('inprogress') === 1, 'กล่องรอ confirm แก้ไข 1 ใบ');
    ok(cnt('installqueue') === 1, 'กล่องจองคิวติดตั้ง 1 ใบ');
    ok(cnt('waitacc') === 1, '‼ Complete + บัญชียังไม่ตรวจ → กล่องรอบัญชีตรวจ');
    ok(cnt('accounted') === 1, '‼ Complete + บัญชีตรวจแล้ว + ยังไม่เข้าแผน → กล่องรอเปิดใบสั่งผลิต');
    ok(cnt('complete') === 1, '‼ Complete + เข้าแผนผลิตแล้ว → กล่องจบงาน (บัญชีจะตรวจหรือยังก็ตาม)');
    ok(D.summary && D.summary.total === 8,
       '‼ แถบสรุปนับ "Project + Project ย่อย" = 8 (ไม่มีงานย่อยนับ 1 ต่อโปรเจกต์) — ได้ ' + (D.summary || {}).total);
    ok(D.summary.byGroup['กลุ่มงานป้าย'].total === 8, 'แยกยอดตามกลุ่มงานป้ายครบ');
    const ow = D.summary.byOwner['(โย) โยธิน กราฟิก'];
    ok(ow && ow.total === 8 && ow.sign.notstarted === 1, 'สรุปรายกราฟิก แยกงานพิมพ์/ป้ายต่อสถานะ');
    ok((D.items['notstarted|(โย) โยธิน กราฟิก'] || []).length === 1,
       'ส่งรายการงานในกล่องมาให้เปิดดูได้ทันที ไม่ต้องยิงซ้ำ');

    /* ═══════════════════════════════════════════════════════════════
     *  ⑦.5 🔴 "กล่องขวา 3 กล่องว่าง · เปลี่ยนช่วงเวลาแล้วตัวเลขไม่ขยับ"
     *       พี่เอทัก 8 ก.ย. 69: "ข้อมูล filter มันผิดนะ ตรวจตาม code เดิมสิ"
     *
     *  กติกาของเดิม (Code.gs:2140 + _boxOf_ Code.gs:1923) มี 2 ข้อ:
     *    ① กล่องซ้าย 4 กล่อง = "งานในมือทั้งหมด" — ‼ ไม่ขึ้นกับช่วงเวลาเลย
     *    ② กล่องขวา 3 กล่อง = ต้อง Complete + วันที่ Complete อยู่ในช่วงที่เลือก
     *  ⇒ เปลี่ยนช่วงเวลาแล้วกล่องซ้ายไม่ขยับ = ถูกต้องตามของเดิม ไม่ใช่บั๊ก
     * ═══════════════════════════════════════════════════════════════ */
    head('⑦.5 ตัวกรองช่วงเวลา — ต้องมีผลเฉพาะกล่องขวา (กติกาเดิม)');
    const Dm = await get(sale, '/api/dashboard?period=month');
    const Dl = await get(sale, '/api/dashboard?period=lastmonth');
    const cm = (D2, k) => (D2.boxes[k] || []).reduce((a, x) => a + x.count, 0);
    ok(cm(Dm, 'notstarted') === cm(Dl, 'notstarted')
       && cm(Dm, 'urgent') === cm(Dl, 'urgent')
       && cm(Dm, 'inprogress') === cm(Dl, 'inprogress')
       && cm(Dm, 'installqueue') === cm(Dl, 'installqueue'),
       '‼ กล่องซ้าย 4 กล่อง เท่ากันทั้ง "เดือนนี้" และ "เดือนที่แล้ว" (งานในมือ ไม่ผูกช่วงเวลา)');
    ok(cm(Dm, 'waitacc') === 1 && cm(Dl, 'waitacc') === 0,
       '‼ กล่องขวาเปลี่ยนตามช่วงเวลาจริง — งานปิดวันนี้อยู่ "เดือนนี้" ไม่อยู่ "เดือนที่แล้ว"');
    ok(cm(Dl, 'accounted') === 0 && cm(Dl, 'complete') === 0,
       'เลือกเดือนที่แล้ว แล้วไม่มีงานปิดในเดือนนั้น → กล่องขวาว่างทั้ง 3 (ถูกต้อง)');

    /* 🔴 อาการที่พี่เอเจอ: งาน Complete แต่ "ไม่มีวันที่ Complete"
     *    ของเดิมจะไม่เอาเข้ากล่องไหนเลย — ไม่ใช่แค่ไม่ขึ้นกล่องขวา */
    await pg.query(`insert into app.projects (_row,"ID","Project","แสดงชื่อลูกค้า","พนักงานขาย","Owner",
        "Status","กลุ่มงาน","Started","Due","Complete")
      values (120,'c9999999','ปิดแล้วแต่ไม่มีวันปิด','บ.ลูกค้าหนึ่ง จำกัด','(หนึ่ง) หนึ่งฤทัย',
              '(โย) โยธิน กราฟิก','Complete','กลุ่มงานป้าย',$1,$2,null)`, [dISO(1), fISO(5)]);
    const Dx = await get(sale, '/api/dashboard?period=month');
    ok(cm(Dx, 'waitacc') === 1 && cm(Dx, 'complete') === 1,
       '‼ งาน Complete ที่ไม่มีวันที่ปิด ไม่ถูกนับเข้ากล่องไหนเลย (ตรงกับของเดิมเป๊ะ)');

    /* เครื่องมือที่ตอบว่า "ข้อมูลหายไปไหน" ต้องชี้ได้ว่าตกด่านไหน */
    let WE = await get(boss, '/api/maint/why-empty?period=month');
    ok(WE.ok === true && WE['งานที่Status_Complete'] >= 4,
       'เครื่องมือ why-empty นับงานที่ Status = Complete ได้');
    ok(WE['ตกด่าน']['ไม่มีวันที่Complete'] === 1,
       '‼ ชี้ชัดว่ามี 1 ใบตกเพราะ "ไม่มีวันที่ Complete"');
    ok(WE['ตกด่าน']['ผ่านเข้ากล่องขวาได้'] >= 3, 'และบอกว่ากี่ใบผ่านเข้ากล่องขวาได้');
    WE = await get(boss, '/api/maint/why-empty?period=lastmonth');
    ok(WE['ตกด่าน']['มีวันที่แต่นอกช่วงที่เลือก'] >= 3,
       '‼ เลือกเดือนที่แล้ว → บอกว่าตกเพราะ "อยู่นอกช่วงที่เลือก" ไม่ใช่ข้อมูลหาย');
    ok(Array.isArray(WE['เดือนที่มีงานปิดมากสุด']) && WE['เดือนที่มีงานปิดมากสุด'].length >= 1,
       'บอกด้วยว่างานที่ปิดแล้วไปกองอยู่เดือนไหน');
    ok((WE['ตัวอย่างค่าดิบ'] || []).length >= 1
       && WE['ตัวอย่างค่าดิบ'][0]['CompleteดิบในDB'] !== undefined,
       'แสดงค่าดิบในฐานข้อมูลให้ดูด้วย ไม่ต้องเดา');
    await pg.query(`delete from app.projects where "ID"='c9999999'`);

    /* ═══════════════════════════════════════════════════════════════
     *  ⑦.6 🔴 ต้นเหตุจริงที่ 3 กล่องขวาเป็น 0 ตลอด
     *       พี่เอสั่ง 8 ก.ย. 69: "ทำให้มัน load data ของอีก 3 กล่องขวาขึ้นมาให้ได้"
     *
     *  ดัชนีของเดิมเลือกแถวด้วยคอลัมน์ **Started**
     *  แต่ 3 กล่องขวาตัดสินด้วยคอลัมน์ **Complete**
     *  ⇒ งานที่ "ปิดเดือนนี้ แต่เปิดไว้ตั้งแต่หลายเดือนก่อน" อยู่เหนือแถวเริ่มต้น
     *    ไม่ถูกอ่านเข้ามาเลย = ไม่มีทางโผล่ในกล่องขวาได้
     *
     *  เคสนี้จำลองสถานการณ์นั้นเป๊ะ: แถวอยู่บนสุด (_row = 2) · Started 300 วันก่อน
     *  (เก่ากว่าขอบดัชนี) · แต่ปิดงาน "วันนี้"
     * ═══════════════════════════════════════════════════════════════ */
    head('⑦.6 🔴 งานที่ "ปิดเดือนนี้ แต่เปิดไว้นานแล้ว" ต้องขึ้นกล่องขวา');
    const Db4 = await get(sale, '/api/dashboard?period=month');
    const cb4 = k => (Db4.boxes[k] || []).reduce((a, x) => a + x.count, 0);

    await pg.query(`insert into app.projects (_row,"ID","Project","แสดงชื่อลูกค้า","พนักงานขาย","Owner",
        "Status","กลุ่มงาน","Started","Due","Complete")
      values (2,'d1111111','งานยาว เปิดปีที่แล้ว ปิดเดือนนี้','บ.ลูกค้าหนึ่ง จำกัด','(หนึ่ง) หนึ่งฤทัย',
              '(โย) โยธิน กราฟิก','Complete','กลุ่มงานป้าย',$1,$2,$3)`,
      [dISO(300), dISO(200), dISO(0)]);

    const Daf = await get(sale, '/api/dashboard?period=month');
    const caf = k => (Daf.boxes[k] || []).reduce((a, x) => a + x.count, 0);

    ok(caf('waitacc') === cb4('waitacc') + 1,
       '‼ งานที่ปิดเดือนนี้แต่เปิดไว้ 300 วันก่อน ขึ้นกล่อง "รอบัญชีตรวจ" แล้ว (เดิมหายไปเงียบ ๆ)');
    ok((Daf.why || {}).added >= 1,
       'บอกได้ว่าดึงเพิ่มเข้ามากี่ใบ (why.added = ' + (Daf.why || {}).added + ')');
    ok(caf('notstarted') === cb4('notstarted') && caf('urgent') === cb4('urgent')
       && caf('inprogress') === cb4('inprogress') && caf('installqueue') === cb4('installqueue'),
       '‼ 4 กล่องซ้ายไม่ขยับเลย — เติมเฉพาะงานที่ปิดแล้ว ไม่ไปกวนงานในมือ');

    /* เลือกเดือนที่แล้ว → ใบนี้ต้องหายไป (ปิดเดือนนี้ ไม่ใช่เดือนที่แล้ว) */
    const Dlm = await get(sale, '/api/dashboard?period=lastmonth');
    const clm = k => (Dlm.boxes[k] || []).reduce((a, x) => a + x.count, 0);
    ok(clm('waitacc') === 0,
       'เลือก "เดือนที่แล้ว" แล้วใบนี้ไม่โผล่ — ยังเคารพช่วงเวลาเหมือนเดิม');

    /* งานเก่าที่ปิดไปเมื่อ 380 วันก่อน (_row = 1) ต้องไม่ถูกลากเข้ามาด้วย */
    const idsNow = new Set();
    for (const k of ['waitacc', 'accounted', 'complete'])
      for (const g of (Daf.items ? Object.keys(Daf.items) : [])) {
        if (g.indexOf(k + '|') !== 0) continue;
        for (const it of Daf.items[g]) idsNow.add(it.id);
      }
    ok(!idsNow.has('a1111111'),
       '‼ งานที่ปิดไปตั้งแต่ปีที่แล้ว ไม่ถูกลากเข้ามาด้วย (เติมเฉพาะที่อยู่ในช่วง)');

    await pg.query(`delete from app.projects where "ID"='d1111111'`);

    /* ═══ ⑧ ปุ่ม "จบงาน" — forceFinishProject (Code.gs:2500) ═══ */
    head('⑧ ปุ่ม "จบงาน" (ปิดงานย้อนหลัง)');
    let F = await get(sale, '/api/can-finish');
    ok(F.can === false, 'เซลส์ทั่วไปกดจบงานไม่ได้');
    r = await post(sale, '/api/finish', { id: 'b0000006' });
    ok(r.status === 403 && /เฉพาะ admin, namna, suntorn/.test(r.body.error || ''),
       '‼ ยิงตรงเข้า API → ปฏิเสธ ด้วยข้อความเดิม');
    F = await get(boss, '/api/can-finish');
    ok(F.can === true, 'admin กดจบงานได้');
    r = await post(boss, '/api/finish', { id: 'b0000006' });
    ok(r.body.ok === true && /โดย admin/.test(r.body.stamp || ''),
       'บันทึกว่าใครกด เมื่อไหร่ (' + (r.body.stamp || '') + ')');
    D = await get(sale, '/api/dashboard?period=month');
    const cnt2 = k => (D.boxes[k] || []).reduce((a, x) => a + x.count, 0);
    ok(cnt2('waitacc') === 0 && cnt2('complete') === 2,
       '‼ กดจบงานแล้วการ์ดย้ายจากกล่องรอบัญชี → กล่องจบงาน');

    /* ═══ ⑨ Outsource — saveOutsource (Code.gs:911) ═══ */
    head('⑨ รายชื่อ Outsource');
    let OS = await get(sale, '/api/outsource');
    ok(OS.canEdit === false && (OS.rows || []).length === 2, 'เซลส์เห็นรายชื่อแต่แก้ไม่ได้');
    r = await post(sale, '/api/outsource/save', { action: 'add', name: 'โรงงาน ค' });
    ok(r.status === 403 && /เฉพาะ admin และ namna/.test(r.body.error || ''),
       '‼ คนที่ไม่ใช่ admin/namna เพิ่มไม่ได้ ด้วยข้อความเดิม');
    r = await post(boss, '/api/outsource/save', { action: 'add', name: 'โรงงาน ค' });
    ok(r.body.ok === true, 'admin เพิ่มได้');
    r = await post(boss, '/api/outsource/save', { action: 'add', name: 'โรงงาน ก' });
    ok(r.status === 400 && /มีชื่อนี้อยู่แล้ว/.test(r.body.error || ''),
       '‼ กันชื่อซ้ำ (ไม่สนตัวพิมพ์) ตามของเดิม');
    OS = await get(boss, '/api/outsource');
    const osRow = (OS.rows || []).find(x => x.name === 'โรงงาน ค');
    r = await post(boss, '/api/outsource/save', { action: 'edit', name: 'โรงงาน ค (แก้)', row: osRow.row });
    ok(r.body.ok === true, 'admin แก้ชื่อได้');
    r = await post(boss, '/api/outsource/save', { action: 'delete', row: osRow.row });
    ok(r.body.ok === true, 'admin ลบได้');
    OS = await get(boss, '/api/outsource');
    ok((OS.rows || []).length === 2, 'ลบแล้วเหลือ 2 รายชื่อ');

    /* ═══ ⑩ จ่ายงานให้กราฟิก — assignGraphic (Code.gs:2225) ═══ */
    head('⑩ จ่ายงานให้กราฟิก');
    r = await post(sale, '/api/assign', { id: 'b0000001', owner: '(ก้อย) ก้อยกราฟิก' });
    ok(r.body.ok === true, 'จ่ายงานได้');
    const asg = (await pg.query(`select "Owner" from app.projects where "ID"='b0000001'`)).rows[0];
    ok(asg.Owner === '(ก้อย) ก้อยกราฟิก', 'คอลัมน์ Owner เปลี่ยนจริง');

    /* ═══ ⑪ ปฏิทินกราฟิก — getGraphicCalendar (Code.gs:1949) ═══ */
    head('⑪ ปฏิทินงานกราฟิก');
    let CAL = await get(sale, '/api/calendar?from=' + dISO(2) + '&to=' + fISO(6));
    ok(CAL.ok === true && (CAL.rows || []).length >= 5,
       'งานที่ช่วง [Started, Due] ทับช่วงที่เลือก ขึ้นครบ (ได้ ' + (CAL.rows || []).length + ')');
    ok((CAL.rows || []).every(x => x.start <= x.due), 'ทุกแท่งมีวันเริ่มไม่เกินวันครบกำหนด');
    CAL = await get(sale, '/api/calendar?from=' + dISO(2) + '&to=' + fISO(6) + '&owner=' + encodeURIComponent('(ก้อย) ก้อยกราฟิก'));
    ok((CAL.rows || []).length === 1, 'กรองเฉพาะกราฟิกคนเดียวได้');
    CAL = await get(sale, '/api/calendar');
    ok(CAL.ok === false && /ต้องระบุช่วงวันที่/.test(CAL.error || ''), 'ไม่ส่งช่วงวันที่ → บอกตรง ๆ');

    /* ═══ ⑫ ค้นหา — searchProjects (Code.gs:1840) ═══ */
    head('⑫ ค้นหา');
    let S = await get(sale, '/api/search?q=' + encodeURIComponent('งานเก่า'));
    ok((S.rows || []).length === 1 && S.rows[0].id === 'a1111111',
       '‼ มีคำค้น → สแกนทั้งตาราง เจองานเก่ากว่าเพดาน index ด้วย');
    ok(/^\d{2}\/\d{2}\/25\d{2}$/.test(S.rows[0].started || ''),
       '‼ วันที่บนการ์ดแสดงเป็น พ.ศ. เหมือนของเดิม (ได้ ' + S.rows[0].started + ')');
    S = await get(sale, '/api/search?status=Complete');
    ok((S.rows || []).length >= 1 && (S.rows || []).every(x => x.status === 'Complete'),
       'กรองด้วยสถานะได้');
    S = await get(sale, '/api/search');
    ok((S.rows || []).length > 0, 'ไม่มีเงื่อนไข → คืนงานล่าสุด');

    const RC = await get(sale, '/api/recent');
    ok((RC.rows || []).length > 0 && (RC.rows || []).length <= 25,
       'งานล่าสุดไม่เกิน RECENT_LIMIT = 25 ใบ (ได้ ' + (RC.rows || []).length + ')');

    const SO = await get(sale, '/api/search-options');
    ok((SO.sales || []).indexOf('(กุ๊งกิ๊ง) กุลกานต์ จึงวงศ์ไพบูลย์') >= 0,
       '‼ EXTRA_SALES ที่ของเดิมใส่ไว้เอง ยังอยู่ (Code.gs:1603)');
    ok((SO.owners || []).length === 2, 'ตัวเลือกกราฟิกใช้รายชื่อมาตรฐานจากตาราง User');

    /* ═══ ⑬ เครื่องมือดูแลระบบ ═══ */
    head('⑬ เครื่องมือดูแลระบบ (ของเดิมรันจาก Apps Script editor)');
    r = await post(sale, '/api/maint/sync-req-accounting');
    ok(r.status === 403, '🔒 เซลส์ทั่วไปเรียกเครื่องมือดูแลระบบไม่ได้');
    r = await post(boss, '/api/maint/sync-req-accounting');
    ok(r.body.ok === true, 'syncReqAccounting ทำงานได้ (Code.gs:1374)');
    r = await post(boss, '/api/maint/sync-joborder');
    ok(r.body.ok === true && typeof r.body.requirementsUpdated === 'number',
       'syncJobOrderToRequirements ทำงานได้ (Code.gs:1440)');
    r = await post(boss, '/api/maint/backfill-req-counts');
    ok(r.body.ok === true, 'backfillReqCounts ทำงานได้ (Code.gs:1496)');
    r = await post(boss, '/api/maint/fix-names', { apply: false });
    ok(r.body.ok === true && r.body.applied === false,
       '‼ fixPersonNames โหมดพรีวิว ไม่เขียนจริง (Code.gs:1129)');
    let W = await get(boss, '/api/maint/where-is?q=b0000006');
    ok(W.found === 1 && W.rows[0].box === 'complete',
       'whereIsProject บอกได้ว่างานอยู่กล่องไหน (Code.gs:2449)');
    W = await get(boss, '/api/maint/stuck?box=accounted');
    ok(W.ok === true && (W.rows || []).every(x => x.box === 'accounted'),
       'inspectStuck คัดเฉพาะกล่องที่ถาม (Code.gs:2405)');
    W = await get(boss, '/api/maint/why-no-delete?id=b0000001&username=pjsale2');
    ok(W.check && W.check.ok === false, 'whyCannotDelete บอกเหตุผลได้ (Code.gs:2478)');
    W = await get(boss, '/api/maint/why-no-sales?q=' + encodeURIComponent('หนึ่ง'));
    ok((W.rowsFound || []).length >= 1, 'whyNoSales หาแถวของคนนั้นเจอ (Code.gs:451)');
    W = await get(boss, '/api/maint/headers');
    ok((W.headers || []).length > 30, 'listHeaders คืนหัวคอลัมน์จริง (Code.gs:2373)');
    W = await get(boss, '/api/maint/column-values?col=Status');
    ok((W.values || []).length >= 3, 'listColumnValues นับค่าจริงในคอลัมน์ (Code.gs:2384)');
    W = await get(boss, '/api/maint/check-id?id=b0000001');
    ok(W.foundInTable === true, 'checkId บอกได้ว่ามี ID นี้จริง (Code.gs:2568)');
    W = await get(boss, '/api/maint/trash');
    ok((W.rows || []).length === 1, 'เปิดดูถังขยะได้ (แทนชีต _Trash_Projects)');

    const NA = await get(boss, '/api/maint/na');
    const naKeys = (NA.items || []).map(x => x.key);
    ok(naKeys.length === 7,
       '‼ ของเดิมที่ผูกกับกลไก Google 7 ตัว ไม่ได้ข้ามเงียบ ๆ — ตอบเหตุผลไว้ครบ');
    ok((NA.items || []).every(x => x.from && x.why && x.instead),
       'ทุกตัวบอกว่ามาจากฟังก์ชันไหน ทำไมใช้ไม่ได้ และของใหม่ใช้อะไรแทน');

    /* ═══ ⑭ ความปลอดภัย + กฎเหล็ก ═══ */
    head('⑭ 🔒 กฎเหล็ก');
    const fs = require('fs');
    const srcAll = ['index.js', 'lib.js', 'images.js', 'dashboard.js', 'maintenance.js', 'ai.js']
      .map(f => fs.readFileSync(path.join(__dirname, '..', 'modules', 'projects', f), 'utf8')).join('\n');
    ok(!/core\/sheets/.test(srcAll),
       '‼ ไม่มีไฟล์ไหนในโมดูลนี้ require ตัวคุยชีตเลย — ไม่เขียนชีตเดิมแน่นอน');
    ok(!/ANTHROPIC_API_KEY\s*[:=]\s*['"]sk-/.test(srcAll),
       '🔒 ไม่มีกุญแจ AI ฝังอยู่ในโค้ด (อยู่ใน Railway Variables เท่านั้น)');
    const sj = fs.readFileSync(path.join(__dirname, '..', 'core', 'sync-jobs.js'), 'utf8');
    const pj = sj.slice(sj.indexOf("name: 'projects'"), sj.indexOf("name: 'imgindex'"));
    ok(/noDelete:\s*true/.test(pj) && /keepNewerBy:\s*'Updated At'/.test(pj),
       '‼ งานซิงก์ projects/requirements มียาม noDelete + keepNewerBy — งานที่เปิดในระบบใหม่จะไม่ถูกชีตลบ/ทับ');

    /* ═══ ⑮ รูป — สารบัญเดิมใช้ได้ทันที ═══ */
    head('⑮ รูปภาพ');
    const IU = await post(sale, '/api/img-urls', { list: ['Projects_Images/old.jpg', 'https://drive.google.com/file/d/ABCDEFGHIJKLMNOPQRSTU/view'] });
    ok(/FID-OLD-1/.test((IU.body.map || {})['Projects_Images/old.jpg'] || ''),
       '‼ path แบบ AppSheet แปลงเป็นรูปได้จากสารบัญเดิม (app.img_index) โดยไม่ยิง Drive');
    ok(/ABCDEFGHIJKLMNOPQRSTU/.test((IU.body.map || {})['https://drive.google.com/file/d/ABCDEFGHIJKLMNOPQRSTU/view'] || ''),
       'ลิงก์ Drive แปลงเป็น thumbnail ได้ตรง ๆ');
    const B = await get(sale, '/api/box?box=complete&owner=' + encodeURIComponent('(โย) โยธิน กราฟิก') + '&period=month');
    ok(Array.isArray(B.rows), 'เปิดกล่องงานทีละกล่องได้ (getBoxItems Code.gs:2179)');

    /* ═══ ⑯ ผู้ใช้ + บันทึกการเข้าใช้ ═══ */
    head('⑯ ผู้ใช้ · บันทึกการเข้าใช้');
    const ME = await get(sale, '/api/me');
    ok(ME.me && ME.me.username === 'pjsale' && ME.me.nickname === 'หนึ่ง',
       'รู้ว่าใครล็อกอินอยู่จาก session ไม่ใช่จาก ?u= (getMe Code.gs:763)');
    ok(/^\/img\/avatar\//.test(ME.me.photo || ''), 'รูปพนักงานเสิร์ฟผ่านเซิร์ฟเวอร์เราเอง');
    r = await post(sale, '/api/log', { device: 'คอมพิวเตอร์', os: 'Windows', browser: 'Chrome', city: 'กรุงเทพ' });
    ok(r.body.ok === true, 'บันทึกการเข้าใช้ได้ (logAccess Code.gs:773)');
    const LG = await get(sale, '/api/logs?limit=50');
    ok((LG.logs || []).length >= 1, 'อ่านประวัติการเข้าใช้กลับมาได้');
    const PH = await get(sale, '/api/graphic-photos');
    ok(Object.keys(PH.map || {}).length >= 1, 'แผนที่รูปกราฟิกใช้คีย์ชื่อเต็มตัวพิมพ์เล็ก');

    /* ═══ ⑰ เพิ่มลูกค้าใหม่ — createContact (Code.gs:1304) ═══ */
    head('⑰ เพิ่มลูกค้าใหม่');
    r = await post(sale, '/api/contact/create',
      { company: 'บ.ลูกค้าใหม่ จำกัด', person: 'คุณซี', phone: '0830000003',
        sales: '(หนึ่ง) หนึ่งฤทัย', channel: 'Facebook' });
    ok(r.body.ok === true && /^[a-f][0-9a-f]{7}$/.test(r.body.contact.id || ''),
       'เพิ่มลูกค้าได้ และได้ ID รูปแบบเดียวกับของเดิม');
    const CT = await get(sale, '/api/contacts');
    ok((CT.rows || []).length === 3 && CT.rows[0].company === 'บ.ลูกค้าใหม่ จำกัด',
       '‼ ลูกค้าใหม่สุดอยู่บนสุด (ของเดิม reverse() Code.gs:976)');
    r = await post(sale, '/api/contact/create', { company: '', person: '' });
    ok(r.status === 400 && /กรุณากรอกชื่อบริษัทหรือผู้ติดต่อ/.test(r.body.error || ''),
       'ไม่กรอกชื่อ → ปฏิเสธด้วยข้อความเดิม');

  } catch (e) {
    fail++; console.error('💥', e);
  } finally {
    app.kill();
    try { if (rest && rest.close) await rest.close(); } catch { /* ปิดไม่ได้ก็ช่าง */ }
    await pg.end();
  }

  console.log('\n' + (fail ? '❌' : '✅') + ' ผ่าน ' + pass + ' · พลาด ' + fail + '\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('💥', e); process.exit(1); });
