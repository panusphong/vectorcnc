'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/app-perms.js — 🔴 ตารางสิทธิ์ "ชุดเดียว" ของทั้งระบบ
 *                      (permission ในฐาน → เห็น/เปิดแอปอะไรได้บ้าง)
 *
 *  ‼ พี่เอสั่ง 17 ก.ย. 69 คำต่อคำ (คัดมาทั้งหมด ไม่ตัดทอน):
 *    "จัด new agent มา 1 ตัวทำเรื่อง การกำหนดสิทธิ์ การเข้าถึง app ทั้งหมดใหม่นะ
 *     1. สิทธิ์ : after sale service เห็นแค่ App : Profile ช่างติดตั้ง , รีวิว + work order ,
 *        ระบบจองคิวติดตั้ง,คลังสินค้า Inventory
 *     2. สิทธ์ : planning เห็นแค่ app : Job card สั่งผลิต , ซ่อมบำรุง + PM , แผนจัดส่ง ,
 *        คลังสินค้า Inventory , Project management, ใบขอซื้อ Purchase request
 *     3. สิทธิ์ : administrator เข้าได้ทุก app
 *     4. สิทธิ์ : sales , sale support  เข้าได้ทุก app
 *     5. สิทธิ์ : กราฟิค เห็นแค่ : Project management system , Graphic design solution ,
 *        Job Card สั่งผลิต , ใบขอซือ Purchase Request , คลังสินค้า Inventory"
 *    "สิทธิ์ : กราฟิค สาขามดงาน เห็น app : Project management system ,
 *     Graphic design solution , Job Card สั่งผลิต , ใบขอซือ Purchase Request ,
 *     คลังสินค้า Inventory , คีย์ยอดขาย"
 *    "และ app ในการจัดการสิทธิ์ผู้ใช้ต้องให้สิทธิ์ แค่ user : admin , namna เท่านั้น"
 *      ⇒ ข้อสุดท้ายผูกกับ "ชื่อผู้ใช้" ไม่ใช่ permission
 *        จึงไม่ได้อยู่ในไฟล์นี้ — อยู่ที่ core/app-access.js (TOOL_ADMIN_USERS)
 *
 *  ── 🔴 ทำไมต้องมีไฟล์นี้ ────────────────────────────────────────
 *    บทเรียนเดิมของโปรเจกต์: "กติกาเดียวกันห้ามมี 2 ที่"
 *    หน้ารวมแอป (การ์ด) · ด่านหน้าเว็บของโมดูล · ด่าน API/RPC
 *    ทั้งสามอ่าน "ตารางเดียวกันนี้" ⇒ เถียงกันไม่ได้โดยโครงสร้าง
 *    เพิ่ม/ถอนสิทธิ์ทีหลัง = แก้ที่ ROLE_APPS ข้างล่าง "บรรทัดเดียว" จบ
 *
 *  ── 🔴 ห้ามยิงฐานข้อมูลแม้แต่คำขอเดียว ─────────────────────────
 *    ไฟล์นี้ "ไม่ require อะไรเลยสักตัว" โดยตั้งใจ (ดูยาม test:appgate ⑧)
 *    ตัดสินจากค่าที่ติดมากับ req.user อยู่แล้วเท่านั้น
 *    ‼ เคยเกิดเหตุจริง: CPU ของ Supabase หมดจนทั้งบริษัทใช้งานไม่ได้
 *
 *  ── 🔴 fail-closed ──────────────────────────────────────────────
 *    permission ว่าง · สะกดแปลกจนไม่รู้จัก · แอปไม่อยู่ในรายการ
 *    ⇒ "ไม่ให้ผ่าน" เสมอ และต้องมีข้อความบอกเหตุผล (ห้ามเงียบ ห้ามหน้าขาว)
 *
 *  ── 🔴 การเทียบทุกจุดในไฟล์นี้ = "ตรงเป๊ะทั้งสตริง ไม่สนตัวพิมพ์" ──
 *    ห้าม includes / startsWith / indexOf / ilike ที่มี * เด็ดขาด
 *    บทเรียนช่องโหว่จริง 13 ก.ย. 69: พิมพ์ username ว่า * แล้วเข้าได้เป็นคนอื่น
 *    (ตัวสะกดที่ต่างกันให้ใส่ใน PERMISSION_ALIAS แทน — เขียนไว้ชัด ๆ ทีละตัว)
 * ═══════════════════════════════════════════════════════════════════ */

/** ค่าพิเศษของ ROLE_APPS: เข้าได้ทุกแอป (ยกเว้นแอปเครื่องมือระบบที่คุมด้วยชื่อผู้ใช้) */
const ALL_APPS = '*';

/* ═══════════════════════════════════════════════════════════════════
 *  ① 📒 ทะเบียนแอปทั้งหมดของระบบ — "คีย์ในโค้ด"
 *
 *  ‼ 21 ตัวแรกคือโฟลเดอร์จริงใน modules/ (core/registry.js อ่านจากดิสก์)
 *    2 ตัวท้ายไม่ใช่โมดูล แต่เป็น "แอป" ที่ผู้ใช้เห็นเป็นการ์ด/เมนู:
 *      sync      = หน้า /sync ของระบบ (ไม่มีโฟลเดอร์ modules/sync)
 *      vectorcnc = Graphic Design Solution — คนละโปรเจกต์ (Python บน Render)
 *                  เข้าผ่าน /api/sso/vectorcnc ของเราเท่านั้น
 *
 *  🔴 รายการนี้ต้องครอบคลุม modules/ ทั้งหมดเสมอ
 *    ยาม tools/test-role-apps.js เทียบกับทะเบียนจริงทุกครั้งที่รัน
 *    ⇒ วางโฟลเดอร์โมดูลใหม่แล้วลืมมาเติมที่นี่ = ยามแดงทันที (ไม่หลุดเงียบ)
 * ═══════════════════════════════════════════════════════════════════ */
const KNOWN_APPS = [
  /* ‼ 20 ก.ย. 69 — ถอด 'appaccess' ออกแล้ว: พี่เอสั่งซ้ำว่า
   *   "การกำหนดสิทธิ์เข้า app ต่างๆ จัดไว้ที่ ทะเบียนกลางได้เลยนะ"
   *   ⇒ เลิกทำเป็นการ์ดใบใหม่ ย้ายไปเป็นแท็บใน registry แทน (ไม่ใช่ "แอป" อีกต่อไป) */
  'acp3d', 'aftersale', 'appraisal', 'assetreg', 'audit', 'bom', 'booking', 'branchplan', 'campaign',
  'chat', 'checklist', 'delivery', 'facade', 'inventory', 'jobcard', 'leave', 'ledqueue',
  'maintenance', 'mgmt', 'payment', 'projects', 'purchase', 'registry', 'reviews',
  'sales', 'technicians', 'users',
  'sync', 'vectorcnc',
];

/* ═══════════════════════════════════════════════════════════════════
 *  🔴 แอปที่ "เปิดได้เฉพาะกลุ่มสิทธิ์ administrator เท่านั้น"
 *
 *  ‼ พี่เอสั่ง 24 ก.ย. 69 คำต่อคำ (ตอนสั่งทำแอป BOM ต้นทุนสินค้า):
 *    "User ที่เข้าได้มีแค่กลุ่ม Permission : administrator เท่านั้นนะ"
 *
 *  ── 🔴 ทำไมต้องมีก้อนนี้แยกออกมา ไม่ใช่แค่ "ไม่ใส่ในตาราง" ────────
 *   ① 'sales' · 'sale support' · 'administrator' ตั้งเป็น ALL_APPS ('*')
 *      ⇒ แอปใหม่ทุกตัว "ติดไปให้สามกลุ่มนี้ฟรี" โดยอัตโนมัติ
 *      ถ้าไม่ดักไว้ เซลส์จะเห็นต้นทุนสินค้าทั้งบริษัททันทีที่วางโฟลเดอร์เสร็จ
 *   ② กลุ่ม PENDING (บัญชี · พนักงานจัดส่ง · ช่างนอก ฯลฯ) ใช้กติกา
 *      "คงสภาพเดิม = KNOWN_APPS ทั้งก้อน" ⇒ ก็ติดไปให้ฟรีเหมือนกัน
 *   ⇒ ด่านนี้จึง "ชนะทุกเส้นทางข้างบน" และต้องอยู่ก่อนการตัดสินอื่นเสมอ
 *
 *  🔴 ต้นทุนสินค้า = ตัวเลขที่อ่อนไหวที่สุดของบริษัท (กำไรต่อชิ้นของทุกงาน)
 *    หลุดไปถึงคนนอกกลุ่ม = เสียเปรียบทั้งตอนขายและตอนซื้อ
 *    ⇒ กติกาที่นี่คือ "ไม่ใช่ administrator = ไม่ได้ ไม่ว่าจะมาทางไหน"
 *
 *  ‼ เทียบด้วย canonPerm() เท่านั้น (ตรงเป๊ะทั้งสตริง ผ่านตารางชื่อพ้อง)
 *    ⇒ 'Administrator' · 'admin' · 'ผู้ดูแลระบบ' ผ่าน
 *      'xadmin' · 'adminx' · '*' · 'Marketing' ไม่ผ่าน
 *    🔴 ห้ามเปลี่ยนไปเทียบ role = 'ADMIN' เด็ดขาด — core/auth.js roleOf()
 *      มีเส้นเดาแบบหลวม p.includes('admin') อยู่ ⇒ 'xadmin' จะกลายเป็น ADMIN
 *
 *  ‼ วันหนึ่งพี่เอสั่งให้กลุ่มอื่นเข้าได้ด้วย ⇒ ลบ 'bom' ออกจากรายการนี้
 *    บรรทัดเดียว แล้วไปติ๊กให้กลุ่มนั้นที่หน้า "ทะเบียนกลาง" ตามปกติ
 *    (admin · namna ยังเข้าได้เสมอจากด่านกันล็อกตัวเองออก — คนละชั้นกัน)
 * ═══════════════════════════════════════════════════════════════════ */
/* ‼ พี่เอสั่ง 3 ต.ค. 69 คำต่อคำ (ตอนสั่งทำแอป Management Report):
 *    "อย่าลืม เพิ่ม ใน app card หน้า crm hub ด้วยนะ และในส่วนนี้ คนที่เปิดดูได้มีแค่
 *     permission : administrator เท่านั้น"
 *   ⇒ 'mgmt' — หน้ารวมตัวเลขทั้งบริษัท (ยอดขาย · เงินสด · ลูกหนี้ · ค่าใช้จ่าย) อ่อนไหวเท่าต้นทุน */
/* ‼ พี่เอสั่ง 4 ต.ค. 69 คำต่อคำ (ตอนสั่งเพิ่มการ์ด "ระบบทะเบียนเบอร์โทร และทรัพย์สิน" — แอปภายนอกบน Google Apps Script):
 *    "ให้เฉพาะ permission : administrator เปิดดูได้เท่านั้นนะ"
 *   ⇒ 'assetreg' — กลุ่มอื่นไม่เห็นการ์ด และไม่ได้ที่อยู่ของแอป (เซิร์ฟเวอร์ส่งต่อให้หลังผ่านด่านเท่านั้น) */
const ADMIN_PERM_ONLY_APPS = ['bom', 'mgmt', 'assetreg'];

/** ชื่อแถวของกลุ่มที่ "เป็นผู้ดูแลระบบ" ในตารางนี้ — พิมพ์ที่เดียว */
const ADMIN_PERM_KEY = 'administrator';

/** แอปนี้ถูกล็อกไว้ให้เฉพาะกลุ่ม administrator ไหม */
const isAdminOnlyApp = appKey => ADMIN_PERM_ONLY_APPS.indexOf(normApp(appKey)) >= 0;

/** ชื่อบนจอของ "แอปที่ไม่ใช่โมดูล" — โมดูลอ่านชื่อจาก module.json อยู่แล้ว
 *  ‼ ห้ามพิมพ์ชื่อโมดูลซ้ำที่นี่ (วันหนึ่งเปลี่ยนชื่อแอปแล้วที่นี่จะโกหก) */
const EXTRA_APP_TITLES = {
  sync:      'ซิงก์ข้อมูลจาก Google Sheets',
  vectorcnc: 'Graphic Design Solution (แอปนอกระบบ)',
};

/* ═══════════════════════════════════════════════════════════════════
 *  ② 🔐 ตารางสิทธิ์ — permission → แอปที่ "เห็นการ์ด + เปิดเข้าใช้ได้"
 *
 *  🔴 กติกาที่พี่เอวางไว้: "เห็นแค่ …" = whitelist ปิดสนิท
 *     ไม่อยู่ในรายการ = ไม่เห็นและเปิดไม่ได้ (ไม่ใช่ "เห็นแต่กดไม่ได้")
 *
 *  🔴 แอปที่พี่เอ "ไม่ได้พูดถึงเลย" ⇒ ไม่มีใครถูกระบุให้เห็น
 *     ⇒ เห็นได้เฉพาะ administrator · sales · sale support (ซึ่งเป็น ALL_APPS)
 *     รายชื่อกลุ่มนั้นอยู่ที่ UNASSIGNED_APPS ข้างล่าง (ไว้ให้พี่เอตรวจ/สั่งเพิ่ม)
 * ═══════════════════════════════════════════════════════════════════ */
const ROLE_APPS = {

  /* ── ข้อ 3 · 4 ของพี่เอ: เข้าได้ทุกแอป ─────────────────────────
   *  ‼ "ทุกแอป" ที่นี่ไม่รวม จัดการผู้ใช้ · บันทึกการใช้งาน · ซิงก์ชีต
   *    เพราะพี่เอสั่งแยกไว้ว่า 3 ตัวนั้นให้ "แค่ user admin , namna"
   *    (ด่านนั้นอยู่ที่ core/app-access.js TOOL_APPS — คนละชั้นกัน) */
  'administrator': ALL_APPS,
  'sales':         ALL_APPS,
  'sale support':  ALL_APPS,

  /* ── ข้อ 1: after sale service ────────────────────────────────
   *  "เห็นแค่ App : Profile ช่างติดตั้ง , รีวิว + work order ,
   *   ระบบจองคิวติดตั้ง , คลังสินค้า Inventory"
   *  🔴 พี่เอไม่ได้ใส่ "บริการหลังการขาย" (aftersale) มาในรายการนี้
   *    ตีความตามกติกา whitelist ⇒ กลุ่มนี้เปิดแอปนั้นไม่ได้
   *    ‼ ข้อนี้ต้องให้พี่เอยืนยัน — ถ้าต้องให้เห็น เติม 'aftersale' บรรทัดเดียว */
  'after sale service': ['technicians', 'reviews', 'booking', 'inventory'],

  /* ── ข้อ 2: planning ──────────────────────────────────────────
   *  "Job card สั่งผลิต , ซ่อมบำรุง + PM , แผนจัดส่ง , คลังสินค้า Inventory ,
   *   Project management , ใบขอซื้อ Purchase request"
   *  ‼ chat · leave = แผงที่อยู่ "ในหน้า Job Card" (module.json hideInHub)
   *    ไม่ใช่แอปที่พี่เอสั่งเพิ่ม แต่เป็นของที่ Job Card ต้องเปิดได้ถึงจะครบ
   *    ⇒ ติดไปกับ jobcard เสมอ (ดู JOBCARD_PANELS ข้างล่าง) */
  'planning': ['jobcard', 'maintenance', 'delivery', 'inventory', 'projects', 'purchase'],

  /* ── ข้อ 5: กราฟิค ────────────────────────────────────────────
   *  "Project management system , Graphic design solution , Job Card สั่งผลิต ,
   *   ใบขอซือ Purchase Request , คลังสินค้า Inventory" */
  'graphic': ['projects', 'vectorcnc', 'jobcard', 'purchase', 'inventory'],

  /* ── ข้อความที่ 2 ของพี่เอ: กราฟิค สาขามดงาน = เหมือนกราฟิค + คีย์ยอดขาย ─ */
  'graphic สาขามดงาน': ['projects', 'vectorcnc', 'jobcard', 'purchase', 'inventory', 'sales'],
};

/* ═══════════════════════════════════════════════════════════════════
 *  ③ 🧩 แผงที่อยู่ "ในหน้า Job Card" — ไม่ใช่แอปแยกที่พี่เอสั่ง
 *
 *  ‼ modules/chat/module.json และ modules/leave/module.json ตั้ง hideInHub = true
 *    (พี่เอสั่งเองเมื่อ 10 ก.ย. 69 ว่าไม่เอาขึ้นเป็นการ์ด — เปิดจากใน Job Card)
 *  ⇒ ใครเปิด Job Card ได้ ต้องเปิดสองตัวนี้ได้ด้วย ไม่งั้นแผงในหน้านั้นพัง
 *    🔴 นี่คือ "ผลพลอยของ jobcard" ไม่ใช่การเพิ่มสิทธิ์ใหม่ให้ใคร
 *      ถ้าพี่เอไม่เห็นด้วย ลบ 2 บรรทัดนี้ได้โดยไม่กระทบข้ออื่น
 * ═══════════════════════════════════════════════════════════════════ */
const JOBCARD_PANELS = ['chat', 'leave'];

/* ═══════════════════════════════════════════════════════════════════
 *  ④ 📝 แอปที่พี่เอ "ไม่ได้พูดถึง" ในคำสั่งรอบนี้
 *     ⇒ ตามกติกา: เห็นได้เฉพาะ administrator · sales · sale support
 *     เขียนไว้เป็นรายการเพื่อให้ "สั่งเพิ่มง่าย" และให้หน้าตรวจสิทธิ์โชว์ได้
 *     ‼ ไม่มีผลต่อการตัดสินใด ๆ — เป็นรายการไว้อ่าน/ไว้ตรวจเท่านั้น
 * ═══════════════════════════════════════════════════════════════════ */
const UNASSIGNED_APPS = [
  'appraisal',   /* ประเมินราคาป้าย */
  'payment',     /* ตรวจสอบการชำระเงินก่อนผลิต */
  'facade',      /* Facade LED Signage */
  'checklist',   /* Checklist ก่อนติดตั้ง */
  'aftersale',   /* บริการหลังการขาย — 🔴 ข้อที่ต้องให้พี่เอยืนยันมากที่สุด */
  'acp3d',       /* ไฟล์ตัด CNC (ยังไม่เปิดใช้ — status planned) */
  'campaign',    /* สลิปรวยไม่อั้น (ปิดถาวรแล้ว — disabled) */
];

/* ═══════════════════════════════════════════════════════════════════
 *  ⑤ 🔤 ตารางชื่อพ้อง — ค่าจริงในคอลัมน์ Permission สะกดได้หลายแบบ
 *
 *  🔴 ต้องเขียนไว้ทีละตัวแบบนี้เท่านั้น ห้ามใช้การเทียบแบบหลวม
 *    (includes / startsWith / regex กว้าง ๆ) เพราะเคยเป็นช่องโหว่จริง
 *
 *  ‼ ค่าที่ "ยืนยันได้จากโค้ดจริง" — core/auth.js > PERMISSION_ROLE:
 *      Administrator · Admin · ผู้ดูแลระบบ · ผู้ดูแล · Accounting · บัญชี
 *      After sale service · Planning · Sale support · Sale · Sales
 *      Graphic · Graphic สาขามดงาน · พนักงานจัดส่ง · ช่างนอก · พนักงานในไลน์ผลิต
 *    + Sale Freelance (มีแต่ใน core/app-access.js เดิม · หาในฐานไม่เจอ)
 *
 *  ‼ ตัวที่เติมเข้ามาเผื่อ "สะกดต่างแต่หมายถึงอันเดียวกัน" ถูกหมายเหตุไว้ทุกตัว
 *    ถ้าในฐานมีค่าที่ไม่อยู่ในตารางนี้ ⇒ ระบบจะ "ปฏิเสธ + รายงานชื่อขึ้นจอ"
 *    (หน้าตรวจสิทธิ์ในแอปจัดการผู้ใช้ · ไม่เงียบแน่นอน)
 * ═══════════════════════════════════════════════════════════════════ */
const PERMISSION_ALIAS = {
  /* administrator */
  'administrator':        'administrator',
  'admin':                'administrator',
  'ผู้ดูแลระบบ':            'administrator',
  'ผู้ดูแล':                'administrator',

  /* sales — ของเดิมมีทั้ง Sale และ Sales */
  'sales':                'sales',
  'sale':                 'sales',

  /* sale support */
  'sale support':         'sale support',
  'sales support':        'sale support',   /* เผื่อสะกดด้วย Sales */
  'salesupport':          'sale support',   /* เผื่อพิมพ์ติดกัน */
  'sale-support':         'sale support',   /* เผื่อใช้ขีด */

  /* after sale service */
  'after sale service':   'after sale service',
  'after sales service':  'after sale service',
  'aftersale service':    'after sale service',
  'aftersales service':   'after sale service',
  'aftersale':            'after sale service',
  'after sale':           'after sale service',
  'บริการหลังการขาย':      'after sale service',

  /* planning */
  'planning':             'planning',
  'plan':                 'planning',
  'วางแผน':               'planning',
  'วางแผนการผลิต':         'planning',

  /* กราฟิค (พี่เอพิมพ์ ค. ไก่ · ในฐานเป็น Graphic) */
  'graphic':              'graphic',
  'graphics':             'graphic',
  'กราฟิก':                'graphic',
  'กราฟิค':                'graphic',

  /* กราฟิค สาขามดงาน */
  'graphic สาขามดงาน':     'graphic สาขามดงาน',
  'graphics สาขามดงาน':    'graphic สาขามดงาน',
  'กราฟิก สาขามดงาน':      'graphic สาขามดงาน',
  'กราฟิค สาขามดงาน':      'graphic สาขามดงาน',
};

/* ═══════════════════════════════════════════════════════════════════
 *  ⑥ ⏳ สิทธิ์ที่ "มีอยู่จริงในระบบ แต่พี่เอยังไม่ได้สั่งว่าเห็นแอปอะไร"
 *
 *  🔴 ทำไมไม่ปิดตายทันที (ทั้งที่กติกาคือ fail-closed):
 *    คนกลุ่มนี้ทำงานอยู่ทุกวันและ "พี่เอไม่ได้สั่งให้เปลี่ยนสิทธิ์ของเขา"
 *    ปิดตายทันที = เปลี่ยนสิทธิ์ที่ไม่ได้สั่ง และทำให้คนทำงานไม่ได้ทั้งกลุ่ม
 *  ⇒ กติกาของกลุ่มนี้คือ "คงสภาพเดิมเป๊ะ" (ทุกแอป ยกเว้นแอปเครื่องมือระบบ
 *    และยกเว้นข้อห้ามเดิมที่พี่เอเคยสั่งไว้ที่ LEGACY_DENY)
 *    แล้ว "ตะโกน" ที่หน้าตรวจสิทธิ์ว่ายังไม่ได้กำหนด — ห้ามเงียบ
 *  🔴 ต่างจาก "ไม่รู้จักเลย" ซึ่งปฏิเสธทันทีตามกติกา fail-closed
 * ═══════════════════════════════════════════════════════════════════ */
const PENDING_PERMISSIONS = [
  'accounting', 'บัญชี',
  'พนักงานจัดส่ง', 'ช่างนอก', 'พนักงานในไลน์ผลิต',
  'sale freelance', 'sales freelance', 'freelance',
];

/* ═══════════════════════════════════════════════════════════════════
 *  ⑦ 🧷 ข้อห้ามเดิมที่ "ยังต้องรักษาไว้" สำหรับกลุ่ม PENDING เท่านั้น
 *
 *  ‼ พี่เอสั่ง 14 ก.ย. 69: "สิทธิ์ Sale Freelance ไม่สามารถเปิด app : คีย์ยอดขายได้นะ"
 *    คำสั่งรอบ 17 ก.ย. ไม่ได้พูดถึง Sale Freelance เลย ⇒ ของเดิมต้องไม่หาย
 *  ‼ Planning / Graphic เคยอยู่ในตารางนี้ด้วย (ห้าม sales + facade)
 *    ตอนนี้ทั้งคู่มี whitelist ปิดสนิทของตัวเองแล้ว ซึ่งไม่มี sales/facade อยู่ดี
 *    ⇒ คำสั่งเดิมยังถูกบังคับใช้ครบ ไม่ได้หายไปไหน
 * ═══════════════════════════════════════════════════════════════════ */
const LEGACY_DENY = {
  'sale freelance':  ['sales'],
  'sales freelance': ['sales'],
  'freelance':       ['sales'],
};

/* ─── 🔧 ตัวเทียบ ─────────────────────────────────────────────────── */

/** Permission: ตัด NBSP · ยุบช่องว่างซ้ำ · trim · ตัวพิมพ์เล็ก
 *  ‼ ค่าที่ไหลมาจาก Google Sheet มีช่องว่างเกิน/NBSP ปนมาบ่อยมาก */
const normPerm = v => String(v == null ? '' : v)
  .replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/** ชื่อแอป: ตัดช่องว่าง + ตัวพิมพ์เล็ก */
const normApp = v => String(v == null ? '' : v).trim().toLowerCase();

/** ค่าที่ผู้ใช้ถืออยู่ → "ชื่อแถวในตาราง" (ตรงเป๊ะทั้งสตริง ไม่สนตัวพิมพ์)
 *  คืน '' ถ้าไม่รู้จัก */
function canonPerm(permission) {
  const p = normPerm(permission);
  if (!p) return '';
  if (PERMISSION_ALIAS[p]) return PERMISSION_ALIAS[p];
  if (ROLE_APPS[p]) return p;                       /* สะกดตรงกับชื่อแถวพอดี */
  if (PENDING_PERMISSIONS.indexOf(p) >= 0) return p;
  return '';
}

/**
 * สถานะของค่า permission ที่ถืออยู่
 *  'empty'   = ไม่ได้กรอกสิทธิ์ไว้เลย        ⇒ ปฏิเสธทุกแอป
 *  'ruled'   = มีในตารางสิทธิ์ที่พี่เอสั่ง     ⇒ ใช้ ROLE_APPS
 *  'pending' = มีในระบบ แต่ยังไม่ได้สั่ง      ⇒ คงสภาพเดิม + ตะโกนที่หน้าตรวจสิทธิ์
 *  'unknown' = ไม่รู้จักเลย                  ⇒ ปฏิเสธทุกแอป + รายงานชื่อขึ้นจอ
 */
function permState(permission) {
  if (!normPerm(permission)) return 'empty';
  const c = canonPerm(permission);
  if (!c) return 'unknown';
  if (ROLE_APPS[c]) return 'ruled';
  return 'pending';
}

/**
 * รายชื่อแอปที่ permission นี้เปิดได้
 *  คืน ALL_APPS ('*') · อาเรย์ชื่อแอป · หรือ [] (ไม่ได้เลย)
 *  ‼ ไม่รวมแอปเครื่องมือระบบ (users · audit · sync) — คุมด้วยชื่อผู้ใช้คนละชั้น
 */
function appsFor(permission) {
  const st = permState(permission);
  if (st === 'empty' || st === 'unknown') return [];

  const c = canonPerm(permission);

  if (st === 'ruled') {
    const list = ROLE_APPS[c];
    /* 🔴 ALL_APPS ของ administrator = ทุกแอปจริง ๆ (รวมแอปที่ล็อกไว้)
     *   ส่วน sales · sale support ที่เป็น ALL_APPS เหมือนกัน ต้องไม่ได้แอปที่ล็อก
     *   ⇒ คืนเป็น "อาเรย์ที่หักแอปล็อกออกแล้ว" ไม่ใช่ '*' เพื่อให้หน้าตรวจสิทธิ์
     *     กางให้เห็นได้ว่ากลุ่มนี้ไม่ได้แอปไหน (ห้ามเงียบ) */
    if (list === ALL_APPS) {
      if (c === ADMIN_PERM_KEY) return ALL_APPS;
      return KNOWN_APPS.filter(k => !isAdminOnlyApp(k));
    }
    const out = list.filter(k => c === ADMIN_PERM_KEY || !isAdminOnlyApp(k));
    /* แผงที่อยู่ในหน้า Job Card ติดไปกับ jobcard เสมอ */
    if (out.indexOf('jobcard') >= 0)
      for (const k of JOBCARD_PANELS) if (out.indexOf(k) < 0) out.push(k);
    return out;
  }

  /* pending — คงสภาพเดิม: ทุกแอป ยกเว้นข้อห้ามเดิมของคนกลุ่มนั้น
   *  🔴 "คงสภาพเดิม" ไม่ได้แปลว่า "ได้ของใหม่ฟรี" — แอปที่พี่เอสั่งล็อกไว้
   *    ให้เฉพาะ administrator ต้องไม่ติดไปกับกลุ่มที่ยังไม่เคยถูกกำหนดสิทธิ์ */
  const deny = LEGACY_DENY[c] || [];
  return KNOWN_APPS.filter(k => deny.indexOf(k) < 0 && !isAdminOnlyApp(k));
}

/**
 * 🔴 คำตอบเดียว: permission นี้เปิดแอปนี้ได้ไหม
 *  ‼ ไม่ตัดสินเรื่องแอปเครื่องมือระบบ (users · audit · sync)
 *    ตัวที่ตัดสินเรื่องนั้นคือ core/app-access.js (ผูกกับชื่อผู้ใช้)
 */
function allows(permission, appKey) {
  const key = normApp(appKey);
  if (!key) return false;                           /* fail-closed */

  /* 🔴 ด่านแอปเฉพาะ administrator — ต้องอยู่ "ก่อน" ทุกการตัดสิน
   *   ไม่งั้น ALL_APPS ('*') ของ sales/sale support จะลัดผ่านไปเลย */
  if (isAdminOnlyApp(key) && canonPerm(permission) !== ADMIN_PERM_KEY) return false;

  const apps = appsFor(permission);
  if (apps === ALL_APPS) return true;
  return apps.indexOf(key) >= 0;
}

/* ─── 💬 ข้อความอธิบายเหตุผล (ห้ามเงียบ ห้ามหน้าขาว) ───────────────── */

/** ชื่อแอปที่คนอ่านเข้าใจ — โมดูลส่ง title เข้ามาได้ ไม่งั้นใช้ของที่รู้จัก/คีย์ */
const appLabel = (appKey, title) =>
  String(title || EXTRA_APP_TITLES[normApp(appKey)] || appKey || '');

/**
 * ทำไมถึงเปิดไม่ได้ — ข้อความภาษาคน บอกด้วยว่าไปถามใครได้
 * @param {string} permission  ค่าที่ผู้ใช้ถืออยู่
 * @param {string} appKey      คีย์แอป
 * @param {string} title       ชื่อแอปบนจอ (ถ้ามี)
 * @param {string} whoToAsk    ชื่อผู้ดูแลที่ให้ไปถาม (ผู้เรียกส่งมาจากที่เดียวของระบบ)
 */
function whyDenied(permission, appKey, title, whoToAsk) {
  const who = String(whoToAsk || 'ผู้ดูแลระบบ');
  const app = appLabel(appKey, title);
  const st  = permState(permission);
  const raw = String(permission == null ? '' : permission).trim();

  if (st === 'empty')
    return 'บัญชีนี้ยังไม่ได้กำหนดสิทธิ์ (ช่อง Permission ว่าง) จึงเปิดแอปไม่ได้ทุกแอป — ' +
           'แจ้ง ' + who + ' ให้ตั้งสิทธิ์ให้ที่แอป "จัดการผู้ใช้"';

  if (st === 'unknown')
    return 'สิทธิ์ "' + raw + '" ยังไม่มีในตารางสิทธิ์ของระบบ จึงเปิดแอปไม่ได้ทุกแอป — ' +
           'แจ้ง ' + who + ' ให้เพิ่มสิทธิ์นี้ลงตาราง (ดูหน้า "ตารางสิทธิ์" ในแอปจัดการผู้ใช้)';

  /* 🔴 แอปที่ล็อกไว้ให้เฉพาะ administrator — ต้องบอกให้ตรงว่าทำไม
   *   ไม่ใช่ข้อความรวม ๆ ว่า "ไม่ได้รับอนุญาต" ซึ่งคนอ่านจะไปขอเพิ่มสิทธิ์
   *   แล้วผู้ดูแลก็เพิ่มให้ไม่ได้อยู่ดี (พี่เอสั่งล็อกไว้ในโค้ด) */
  if (isAdminOnlyApp(appKey))
    return 'แอป "' + app + '" เปิดได้เฉพาะกลุ่มสิทธิ์ Administrator เท่านั้น (พี่เอสั่งไว้ 24 ก.ย. 69) ' +
           '— สิทธิ์ปัจจุบันของบัญชีนี้คือ "' + raw + '" ถ้าจำเป็นต้องใช้งาน ให้แจ้งพี่เอโดยตรง';

  return 'สิทธิ์ "' + raw + '" ไม่ได้รับอนุญาตให้เปิดแอป "' + app + '" — ' +
         'ถ้าจำเป็นต้องใช้งาน แจ้ง ' + who + ' ให้เพิ่มแอปนี้เข้าตารางสิทธิ์ของคุณ';
}

/** คำเตือนที่ต้องขึ้นให้ผู้ใช้/แอดมินเห็น (null = ไม่มีอะไรต้องเตือน) */
function permNotice(permission) {
  const st = permState(permission);
  const raw = String(permission == null ? '' : permission).trim();
  if (st === 'empty')
    return '⚠️ บัญชีนี้ยังไม่ได้กำหนดสิทธิ์ (Permission ว่าง) — เปิดแอปไม่ได้จนกว่าผู้ดูแลจะตั้งให้';
  if (st === 'unknown')
    return '⚠️ สิทธิ์ "' + raw + '" ไม่มีในตารางสิทธิ์ของระบบ — เปิดแอปไม่ได้จนกว่าผู้ดูแลจะเพิ่มลงตาราง';
  if (st === 'pending')
    return 'ℹ️ สิทธิ์ "' + raw + '" ยังไม่ได้กำหนดว่าเห็นแอปอะไรบ้าง — ตอนนี้ใช้ค่าเดิมของระบบไปก่อน';
  return null;
}

module.exports = {
  ALL_APPS, KNOWN_APPS, EXTRA_APP_TITLES,
  ADMIN_PERM_ONLY_APPS, ADMIN_PERM_KEY, isAdminOnlyApp,
  ROLE_APPS, JOBCARD_PANELS, UNASSIGNED_APPS,
  PERMISSION_ALIAS, PENDING_PERMISSIONS, LEGACY_DENY,
  normPerm, normApp, canonPerm, permState, appsFor, allows,
  appLabel, whyDenied, permNotice,
};
