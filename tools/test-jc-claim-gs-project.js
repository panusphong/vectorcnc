'use strict';
process.env.TZ = process.env.TZ || 'UTC';
/* ═══════════════════════════════════════════════════════════════════
 *  🧪 tools/test-jc-claim-gs-project.js — Job Card 1.29.1 · Projects 1.6.1
 *  พี่เอ 7 พ.ย. 69: "เช็คด้วยว่ากดปุ่มเคลมจากกราฟิค และเซลล์ ทำไมไม่สร้าง project เคลมให้"
 *                  "ช่วยเพิ่ม ประเภทงาน เคลมจากกราฟิค / ฝ่ายขาย ให้ด้วยนะ" (app project management)
 * ═══════════════════════════════════════════════════════════════════ */
const path = require('path'), fs = require('fs');
const { Client } = require('pg');
const ROOT = path.join(__dirname, '..');
const PG = process.env.TEST_PG || 'postgresql://postgres@localhost:5432/postgres';
const REST_PORT = 55893;
process.env.SUPABASE_URL = 'http://127.0.0.1:' + REST_PORT;
process.env.SUPABASE_KEY = 'test';
process.env.SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA || 'app';
process.env.SHEET_SYNC = 'off';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const PFX = 'ZZGS-';
const GS = 'งานเคลม(กราฟิค-ขาย) = เสียจากกราฟิก/ขาย';

async function wipe(pg) {
  await pg.query(`delete from app.production_jobs where "JobID" like $1`, [PFX + '%']);
  await pg.query(`delete from app.requirements where project_id like $1`, [PFX + '%']);
  await pg.query(`delete from app.projects where "ID" like $1`, [PFX + '%']);
}
(async () => {
  console.log('\n🎨 เคลมกราฟิค-ขาย ⇒ งานย่อยเคลมใน Projects\n');
  const pg = new Client({ connectionString: PG }); await pg.connect();
  await wipe(pg);
  const P1 = PFX + 'P1', P2 = PFX + 'P2';
  await pg.query(`insert into app.projects (_row,"ID","Project") values (99901,$1,'ร้านทดสอบเคลมกราฟิค'),(99902,$2,'ร้านเคลมเก่า')`, [P1, P2]);
  /* ใบเคลมเก่า (ก่อนแก้) ไม่มีงานย่อย */
  await pg.query(`insert into app.production_jobs ("JobID","ProjectID","OverallStatus","JobType","ClaimType","ClaimFromJobID","ClaimReason","CreatedBy","ClaimImg1","CreatedAt","UpdatedAt")
    values ($1,$2,'Pending',$3,'กราฟิค-ขาย',$4,'สะกดชื่อร้านผิด','namna','https://x/img1.jpg',now(),now())`, [PFX + 'OLD1', P2, GS, PFX + 'SRC9']);
  const rest = await require('./fake-postgrest').start(PG, REST_PORT);
  const DB = require(path.join(ROOT, 'core/db.js'));
  const CLM = require(path.join(ROOT, 'modules/jobcard/claiminstall.js'));
  try {
    console.log('① เปิดงานย่อยเคลม');
    const r = await CLM.addGsClaimRequirement(DB, { projectId: P1, claimJobId: PFX + 'C1', fromJobId: PFX + 'SRC1', reason: 'ไฟล์สีผิด', by: 'suntorn', images: ['https://x/a.jpg'] });
    ok(r.ok && r.seq === 1 && r.requirementId, 'สร้างงานย่อยใหม่ ครั้งที่ 1');
    let rows = (await pg.query(`select * from app.requirements where project_id=$1`, [P1])).rows;
    const q = rows[0] || {};
    ok(rows.length === 1 && q.job_type === GS, 'ประเภทงานย่อย = ' + GS);
    ok(q.claim_seq == null, 'ไม่มี claim_seq ⇒ ระบบจองคิวไม่ดึงเข้าคิวช่างเอง');
    ok(q.claim_job_id === PFX + 'C1' && q.claim_from_job_id === PFX + 'SRC1' && q.claim_reason === 'ไฟล์สีผิด' && q.claim_by === 'suntorn' && q.claim_img1 === 'https://x/a.jpg', 'เก็บใบเคลม · ใบต้นทาง · สาเหตุ · ผู้สร้าง · รูป');
    ok(q.status === 'Not started' && /เคลมกราฟิค-ขาย ครั้งที่ 1/.test(q.requirement_name), 'ชื่อ "เคลมกราฟิค-ขาย ครั้งที่ 1" · Not started');
    const r2 = await CLM.addGsClaimRequirement(DB, { projectId: P1, claimJobId: PFX + 'C1' });
    ok(r2.ok && r2.existed && (await pg.query(`select count(*)::int n from app.requirements where project_id=$1`, [P1])).rows[0].n === 1, 'กดซ้ำใบเดิม ⇒ ไม่เปิดซ้ำ');
    const r3 = await CLM.addGsClaimRequirement(DB, { projectId: P1, claimJobId: PFX + 'C2' });
    ok(r3.ok && r3.seq === 2, 'ใบเคลมใบที่ 2 ⇒ ครั้งที่ 2');
    const r4 = await CLM.addGsClaimRequirement(DB, { projectId: PFX + 'NOPE', claimJobId: PFX + 'C3' });
    ok(!r4.ok && /ไม่พบงานหลัก/.test(r4.reason), 'ไม่มีงานหลัก ⇒ ไม่ล้ม บอกเหตุ');

    console.log('② เติมใบเก่าย้อนหลัง');
    let b = await CLM.backfillGsClaimRequirements(DB);
    rows = (await pg.query(`select * from app.requirements where project_id=$1`, [P2])).rows;
    ok(b.ok && b.created >= 1 && rows.length === 1 && rows[0].claim_job_id === PFX + 'OLD1' && rows[0].claim_reason === 'สะกดชื่อร้านผิด', 'ใบเคลมเก่าได้งานย่อยเคลม');
    b = await CLM.backfillGsClaimRequirements(DB);
    ok(b.created === 0 && (await pg.query(`select count(*)::int n from app.requirements where project_id=$1`, [P2])).rows[0].n === 1, 'รันซ้ำ ⇒ ไม่เติมซ้ำ');

    console.log('③ ต่อสาย / ตัวกรอง');
    const edit = fs.readFileSync(path.join(ROOT, 'modules/jobcard/edit.js'), 'utf8');
    ok(/claimType === CLAIM_GS\) \{[\s\S]{0,400}addGsClaimRequirement/.test(edit), 'สร้างการ์ดเคลมกราฟิค-ขาย ⇒ เรียกเปิดงานย่อย');
    const sr = fs.readFileSync(path.join(ROOT, 'modules/jobcard/subreqs.js'), 'utf8');
    const cc = fs.readFileSync(path.join(ROOT, 'modules/jobcard/claimcost.js'), 'utf8');
    ok(/เคลม/.test(sr) && /job_type/.test(cc) && /เคลม/.test(cc), 'งานย่อยเคลมไม่นับในเตือนงานย่อย / ค่าใช้จ่ายเคลม');
    const ai = fs.readFileSync(path.join(ROOT, 'modules/booking/autoimport.js'), 'utf8');
    ok(/claim_seq/.test(ai), 'ระบบจองคิวดึงเฉพาะแถวที่มี claim_seq');
    const { ENUMS } = require(path.join(ROOT, 'modules/projects/lib.js'));
    const i = ENUMS.jobTypes.indexOf(GS);
    ok(i === ENUMS.jobTypes.indexOf('งานเคลม(ติดตั้ง) = เสียจากติดตั้ง') + 1, 'Projects: ประเภทงานใหม่ต่อจากงานเคลม(ติดตั้ง)');
    ok(new Set(ENUMS.jobTypes).size === ENUMS.jobTypes.length && ENUMS.jobTypes.length === 14, 'ประเภทงานครบ 14 ไม่ซ้ำ');
    ok(require(path.join(ROOT, 'modules/jobcard/version.js')).VERSION === '1.29.1' && require(path.join(ROOT, 'modules/projects/version.js')).VERSION === '1.6.1', 'เวอร์ชัน Job Card 1.29.1 · Projects 1.6.1');
  } catch (e) { fail++; console.log('  ❌ ล้ม: ' + (e.stack || e)); }
  await wipe(pg); await pg.end(); try { rest.close && rest.close(); } catch (_) {}
  console.log(`\n${pass} ผ่าน · ${fail} ไม่ผ่าน`); process.exit(fail ? 1 : 0);
})();
