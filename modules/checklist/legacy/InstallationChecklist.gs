/**
 * ============================================================================
 * ระบบ Checklist งานติดตั้ง - InstallationPlan
 * ============================================================================
 * วัตถุประสงค์: สร้างระบบ Checklist เพื่อให้ Sales ทำการ Confirm งานสำคัญ
 *              ก่อนเข้าติดตั้ง 4 รายการ
 *
 * Author: มดงานทีม
 * Created: 2026-05-14
 * Integration: AppSheet "มดงานการป้าย CRM"
 * ============================================================================
 */

// ============================================================================
// CONFIGURATION - แก้ไขค่าเหล่านี้ตามชื่อจริงในชีท
// ============================================================================
const CONFIG = {
  // Spreadsheet ID (เอามาจาก URL ของไฟล์ Sheet ส่วนระหว่าง /d/ กับ /edit)
  // ถ้าเปิด Apps Script จากเมนู Extensions → Apps Script ในไฟล์ Sheet จะไม่จำเป็นต้องใส่
  // แต่ถ้าเป็น Standalone Script ต้องใส่ ID ของไฟล์ที่นี่
  SPREADSHEET_ID: '1oiN3wzd33fu4rwWlFZHm6a9fBzDI59sudFGqoBAY3mY',

  // User Login Sheet (เก็บ Username + รูปพนักงาน) - ใช้ Sheet เดียวกับระบบ CRM อื่น
  LOGIN_SS_ID: '10NgAH66TDVrDBKW5s8uugBeKUi3-UozeEN7iO1-61n4',
  LOGIN_TAB: 'User',

  // Timezone — Hardcode เป็น Bangkok เพื่อกันการตั้งค่า Sheet ผิด
  // ถ้าอยู่ในประเทศไทยใช้ค่านี้เลย ไม่ต้องเปลี่ยน
  TIMEZONE: 'Asia/Bangkok',

  // ชื่อ Sheet (Table) ในไฟล์ Google Sheets
  SHEET_NAME: 'InstallationPlan',

  // ชื่อ Column เดิม (ต้องตรงกับชื่อจริงในไฟล์)
  COL_STATUS: 'Status',                        // คอลัมน์สถานะงาน
  COL_INSTALL_DATE: 'แผนวันที่ติดตั้ง',          // วันที่แผนติดตั้ง
  COL_CUSTOMER: 'แสดงชื่อลูกค้า',                // ชื่อลูกค้า (Display)
  COL_SALES_EMAIL: 'พนักงานขาย',                // ชื่อพนักงานขาย
  COL_JOB_NUMBER: 'เลขที่ใบงาน',                // เลขที่ใบงาน
  COL_IMAGE: 'ภาพใบงาน',                       // ภาพใบงาน (AppSheet path)

  // Column สำหรับรับ Username จาก AppSheet User Settings
  // AppSheet จะเขียนค่า USERSETTINGS("Username") ลง Column นี้
  // ทุกครั้งที่มีการ Save Row (ตั้งค่าใน AppSheet)
  COL_APPSHEET_USER: 'AppSheet_Username',

  // ค่า Status ที่ "ไม่" ต้องการให้ระบบทำงาน (Exclude List)
  // ระบบจะดึงข้อมูลทุกสถานะ ยกเว้นรายการใน list นี้
  STATUS_EXCLUDE: ['จบงาน'],

  // ชื่อ Column ใหม่ที่จะเพิ่ม (Checklist 4 รายการ)
  // หมายเหตุ: key (CHK3/CHK4) ไม่เปลี่ยน เพื่อรักษาข้อมูลใน DB เดิม สลับเฉพาะลำดับการแสดงผล
  CHECKLIST_COLUMNS: [
    {
      key: 'CHK1_SiteCheck',
      label: '1. เช็คลิสต์พื้นที่หน้างาน',
      desc: 'จัดทำ check list พื้นที่หน้างานก่อนติดตั้งเรียบร้อย'
    },
    {
      key: 'CHK2_ConfirmCustomer',
      label: '2. Confirm วันเวลากับลูกค้า',
      desc: 'Confirm วันเวลา เข้าติดตั้งกับลูกค้าล่วงหน้า 1 วัน'
    },
    {
      key: 'CHK4_ConfirmPayment',
      label: '3. Confirm การรับชำระเงิน',
      desc: 'confirm การรับชำระเงินจากทางลูกค้าก่อนเข้าติดตั้งให้ชัดเจน'
    },
    {
      key: 'CHK3_BriefTeam',
      label: '4. บรีฟทีมช่าง',
      desc: 'จัดทำ Meeting บรีฟงานทีมช่างก่อนเข้าติดตั้ง ล่วงหน้า 1 วัน'
    }
  ],

  // Column สรุปและ Audit Trail
  COL_OVERALL: 'Overall_Status',     // สถานะรวม (✅ ครบ 4/4 หรือ ⚠️ X/4)
  COL_PROGRESS: 'Progress',           // % ความคืบหน้า

  // สีพื้นหลัง
  COLOR_DONE: '#34A853',      // เขียว
  COLOR_PENDING: '#EA4335',   // แดง
  COLOR_HEADER: '#1A73E8',    // น้ำเงิน (header)

  // สัญลักษณ์
  SYMBOL_DONE: '✅ เรียบร้อย',
  SYMBOL_PENDING: '❌ ยังไม่ทำ',

  // อีเมลผู้ดูแลระบบ (CC เมื่อแจ้งเตือน)
  ADMIN_EMAIL: 'arayayyps.the101@gmail.com'
};

// ============================================================================
// HELPER - หา Spreadsheet (รองรับทั้ง Container-bound และ Standalone Script)
// ============================================================================
function getSpreadsheet_() {
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  if (!ss && CONFIG.SPREADSHEET_ID) {
    try { ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID); } catch (e) {
      throw new Error(
        'ไม่สามารถเปิด Spreadsheet ได้ — ตรวจสอบ SPREADSHEET_ID ใน CONFIG หรือสิทธิ์การเข้าถึงไฟล์\n' +
        'รายละเอียด: ' + e.message
      );
    }
  }
  if (!ss) {
    throw new Error(
      'ไม่พบ Spreadsheet\n\n' +
      'วิธีแก้:\n' +
      '1. เปิด Apps Script จากเมนู Extensions → Apps Script ในไฟล์ Sheet โดยตรง\n' +
      '2. หรือใส่ SPREADSHEET_ID ใน CONFIG (ID อยู่ใน URL ของไฟล์ Sheet)'
    );
  }
  return ss;
}

// ============================================================================
// SETUP - รันครั้งเดียวเพื่อติดตั้งระบบ
// ============================================================================
/**
 * รันฟังก์ชันนี้ครั้งเดียวเพื่อ:
 * 1. เพิ่ม Column ใหม่ใน Sheet InstallationPlan
 * 2. ตั้งค่า Conditional Formatting (สีเขียว/แดง)
 * 3. ติดตั้ง Trigger สำหรับ onEdit และแจ้งเตือนรายวัน
 */
function setupChecklistSystem() {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) {
    const msg = 'ไม่พบ Sheet ชื่อ: ' + CONFIG.SHEET_NAME + '\nกรุณาตรวจสอบชื่อ Sheet ใน CONFIG';
    try { SpreadsheetApp.getUi().alert(msg); } catch (e) { throw new Error(msg); }
    return;
  }

  // 1. เพิ่ม Column ใหม่
  addChecklistColumns_(sheet);

  // 2. ตั้งค่า Conditional Formatting
  applyConditionalFormatting_(sheet);

  // 3. Validate dropdown สำหรับ checklist (✅/❌)
  applyDataValidation_(sheet);

  // 4. ติดตั้ง Triggers
  installTriggers_(ss);

  const successMsg =
    '✅ ติดตั้งระบบ Checklist สำเร็จ!\n\n' +
    '- เพิ่ม Column ใหม่เรียบร้อย\n' +
    '- ตั้งค่าสีเขียว/แดง อัตโนมัติ\n' +
    '- เปิดใช้งานแจ้งเตือนล่วงหน้า 1 วัน\n\n' +
    'กรุณาเชื่อมต่อ AppSheet กับ Sheet นี้ต่อไป';
  try { SpreadsheetApp.getUi().alert(successMsg); } catch (e) { Logger.log(successMsg); }
}

/**
 * เพิ่ม Column ใหม่สำหรับ Checklist + Audit + Overall
 */
function addChecklistColumns_(sheet) {
  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const newCols = [];

  // Column สำหรับรับ Username จาก AppSheet User Settings (ใส่ไว้ก่อน)
  newCols.push(CONFIG.COL_APPSHEET_USER);

  // สร้างรายการ Column ที่จะเพิ่ม
  CONFIG.CHECKLIST_COLUMNS.forEach(chk => {
    newCols.push(chk.key);                    // ค่า ✅/❌
    newCols.push(chk.key + '_UpdatedBy');     // ผู้ update (Username จาก AppSheet)
    newCols.push(chk.key + '_UpdatedAt');     // เวลา update
  });
  newCols.push(CONFIG.COL_OVERALL);
  newCols.push(CONFIG.COL_PROGRESS);

  // เช็คว่ามี Column ไหนยังไม่ถูกเพิ่ม
  const colsToAdd = newCols.filter(c => headerRow.indexOf(c) === -1);
  if (colsToAdd.length === 0) {
    Logger.log('Columns already exist');
    return;
  }

  const startCol = sheet.getLastColumn() + 1;
  sheet.getRange(1, startCol, 1, colsToAdd.length).setValues([colsToAdd]);

  // จัดรูปแบบ Header
  const headerRange = sheet.getRange(1, startCol, 1, colsToAdd.length);
  headerRange
    .setBackground(CONFIG.COLOR_HEADER)
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setWrap(true);

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(startCol, colsToAdd.length);
}

/**
 * Data Validation ให้ Column Checklist เป็น Dropdown ✅/❌
 */
function applyDataValidation_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const lastRow = Math.max(sheet.getLastRow(), 2);

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList([CONFIG.SYMBOL_DONE, CONFIG.SYMBOL_PENDING], true)
    .setAllowInvalid(false)
    .build();

  CONFIG.CHECKLIST_COLUMNS.forEach(chk => {
    const col = headers.indexOf(chk.key) + 1;
    if (col > 0) {
      const range = sheet.getRange(2, col, lastRow - 1, 1);
      range.setDataValidation(rule);

      // ตั้งค่า default = ❌ ยังไม่ทำ ในแถวที่ยังว่าง
      const values = range.getValues();
      const updated = values.map(r => [r[0] || CONFIG.SYMBOL_PENDING]);
      range.setValues(updated);
    }
  });
}

/**
 * ตั้งค่า Conditional Formatting (สีเขียว = ✅, สีแดง = ❌)
 */
function applyConditionalFormatting_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const lastRow = Math.max(sheet.getLastRow(), 1000);
  const rules = [];

  CONFIG.CHECKLIST_COLUMNS.forEach(chk => {
    const col = headers.indexOf(chk.key) + 1;
    if (col > 0) {
      const range = sheet.getRange(2, col, lastRow - 1, 1);

      // เขียว = ✅
      rules.push(
        SpreadsheetApp.newConditionalFormatRule()
          .whenTextContains('✅')
          .setBackground(CONFIG.COLOR_DONE)
          .setFontColor('#FFFFFF')
          .setBold(true)
          .setRanges([range])
          .build()
      );
      // แดง = ❌
      rules.push(
        SpreadsheetApp.newConditionalFormatRule()
          .whenTextContains('❌')
          .setBackground(CONFIG.COLOR_PENDING)
          .setFontColor('#FFFFFF')
          .setBold(true)
          .setRanges([range])
          .build()
      );
    }
  });

  // Overall Status
  const overallCol = headers.indexOf(CONFIG.COL_OVERALL) + 1;
  if (overallCol > 0) {
    const range = sheet.getRange(2, overallCol, lastRow - 1, 1);
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenTextContains('พร้อมติดตั้ง')
        .setBackground(CONFIG.COLOR_DONE)
        .setFontColor('#FFFFFF')
        .setBold(true)
        .setRanges([range])
        .build(),
      SpreadsheetApp.newConditionalFormatRule()
        .whenTextContains('ยังไม่พร้อม')
        .setBackground(CONFIG.COLOR_PENDING)
        .setFontColor('#FFFFFF')
        .setBold(true)
        .setRanges([range])
        .build()
    );
  }

  sheet.setConditionalFormatRules(rules);
}

// ============================================================================
// onEdit TRIGGER - ทำงานเมื่อมีการแก้ไข
// ============================================================================
/**
 * เมื่อ Sales กดเปลี่ยน Checklist:
 * - บันทึก UpdatedBy (อีเมล)
 * - บันทึก UpdatedAt (วันเวลา)
 * - คำนวณ Overall_Status และ Progress ใหม่
 */
function onEditChecklist(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== CONFIG.SHEET_NAME) return;

  const row = e.range.getRow();
  if (row < 2) return;

  const col = e.range.getColumn();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const editedHeader = headers[col - 1];

  // ตรวจสอบว่าเป็น Column Checklist หรือไม่
  const chk = CONFIG.CHECKLIST_COLUMNS.find(c => c.key === editedHeader);
  if (chk) {
    // เช็คสถานะของ Row นี้ ถ้าอยู่ใน Exclude List (เช่น "จบงาน") ให้ข้าม
    const idxStatus = headers.indexOf(CONFIG.COL_STATUS);
    if (idxStatus >= 0) {
      const rowStatus = sheet.getRange(row, idxStatus + 1).getValue();
      if (!isRowActive_(rowStatus)) return;
    }

    const now = new Date();

    // ดึง Username จาก AppSheet User Settings (อ่านจาก Column AppSheet_Username)
    // หากไม่มีค่า (เช่น edit จากหน้า Google Sheets โดยตรง) จะใช้ Email Google เป็น Fallback
    let userName = '';
    const idxAppSheetUser = headers.indexOf(CONFIG.COL_APPSHEET_USER);
    if (idxAppSheetUser >= 0) {
      userName = String(sheet.getRange(row, idxAppSheetUser + 1).getValue() || '').trim();
    }
    if (!userName) {
      userName = Session.getActiveUser().getEmail() || 'unknown';
    }

    const updatedByCol = headers.indexOf(chk.key + '_UpdatedBy') + 1;
    const updatedAtCol = headers.indexOf(chk.key + '_UpdatedAt') + 1;

    if (updatedByCol > 0) {
      sheet.getRange(row, updatedByCol).setValue(userName);
    }
    if (updatedAtCol > 0) {
      sheet.getRange(row, updatedAtCol).setValue(now);
      sheet.getRange(row, updatedAtCol).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    }

    // คำนวณ Overall
    recalculateOverall_(sheet, row, headers);
  }
}

/**
 * คำนวณสถานะรวมและ % Progress
 */
function recalculateOverall_(sheet, row, headers) {
  let doneCount = 0;
  CONFIG.CHECKLIST_COLUMNS.forEach(chk => {
    const c = headers.indexOf(chk.key) + 1;
    if (c > 0) {
      const v = sheet.getRange(row, c).getValue();
      if (String(v).indexOf('✅') !== -1) doneCount++;
    }
  });

  const total = CONFIG.CHECKLIST_COLUMNS.length;
  const overallCol = headers.indexOf(CONFIG.COL_OVERALL) + 1;
  const progressCol = headers.indexOf(CONFIG.COL_PROGRESS) + 1;

  const overall = (doneCount === total)
    ? '✅ พร้อมติดตั้ง (' + doneCount + '/' + total + ')'
    : '⚠️ ยังไม่พร้อม (' + doneCount + '/' + total + ')';

  if (overallCol > 0) sheet.getRange(row, overallCol).setValue(overall);
  if (progressCol > 0) {
    sheet.getRange(row, progressCol).setValue(doneCount / total);
    sheet.getRange(row, progressCol).setNumberFormat('0%');
  }
}

// ============================================================================
// DAILY NOTIFICATION - แจ้งเตือนล่วงหน้า 1 วัน
// ============================================================================
/**
 * ตรวจสอบงานที่จะติดตั้งพรุ่งนี้ และส่งอีเมลแจ้งเตือน Sales
 * หากยัง Checklist ไม่ครบ 4/4
 *
 * จะถูก Trigger ทำงานอัตโนมัติทุกวันเวลา 08:00 น.
 */
function sendDailyReminder() {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;

  const TZ = CONFIG.TIMEZONE || ss.getSpreadsheetTimeZone() || 'Asia/Bangkok';
  const headers = data[0];
  const idxStatus = headers.indexOf(CONFIG.COL_STATUS);
  const idxDate = headers.indexOf(CONFIG.COL_INSTALL_DATE);
  const idxCustomer = headers.indexOf(CONFIG.COL_CUSTOMER);
  const idxSalesEmail = headers.indexOf(CONFIG.COL_SALES_EMAIL);
  const idxOverall = headers.indexOf(CONFIG.COL_OVERALL);

  if (idxStatus === -1 || idxDate === -1) {
    Logger.log('ไม่พบ Column Status หรือ แผนวันที่ติดตั้ง');
    return;
  }

  // วันพรุ่งนี้ (ใน TZ ของ Sheet)
  const todayISO = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const tomorrowStr = isoAddDays_(todayISO, 1);
  const pending = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = row[idxStatus];
    const installDate = row[idxDate];

    // ข้ามถ้าสถานะอยู่ใน Exclude List (เช่น "จบงาน")
    if (CONFIG.STATUS_EXCLUDE.indexOf(status) !== -1) continue;
    // ข้ามถ้าไม่มีสถานะเลย
    if (!status) continue;
    if (!(installDate instanceof Date)) continue;

    const dateStr = Utilities.formatDate(installDate, TZ, 'yyyy-MM-dd');
    if (dateStr !== tomorrowStr) continue;

    // นับจำนวน checklist ที่ยังไม่ทำ
    const undone = [];
    CONFIG.CHECKLIST_COLUMNS.forEach(chk => {
      const c = headers.indexOf(chk.key);
      if (c >= 0 && String(row[c]).indexOf('✅') === -1) {
        undone.push(chk.label);
      }
    });

    if (undone.length > 0) {
      pending.push({
        row: i + 1,
        customer: idxCustomer >= 0 ? row[idxCustomer] : '',
        salesEmail: idxSalesEmail >= 0 ? row[idxSalesEmail] : '',
        undone: undone,
        overall: idxOverall >= 0 ? row[idxOverall] : ''
      });
    }
  }

  if (pending.length === 0) {
    Logger.log('ไม่มีงานที่ต้องแจ้งเตือนพรุ่งนี้');
    return;
  }

  // กลุ่มตาม Sales Email
  const groupedBySales = {};
  pending.forEach(p => {
    const key = p.salesEmail || CONFIG.ADMIN_EMAIL;
    if (!groupedBySales[key]) groupedBySales[key] = [];
    groupedBySales[key].push(p);
  });

  Object.keys(groupedBySales).forEach(email => {
    sendReminderEmail_(email, groupedBySales[email], tomorrowStr);
  });
}

/**
 * ส่งอีเมลแจ้งเตือน
 */
function sendReminderEmail_(toEmail, items, installDateStr) {
  const subject = '⚠️ แจ้งเตือน: Checklist งานติดตั้งพรุ่งนี้ (' + installDateStr + ') ยังไม่ครบ';

  let html = '<div style="font-family: Sarabun, Arial, sans-serif;">';
  html += '<h2 style="color:#1A73E8;">📋 รายการ Checklist ที่ยังไม่ครบก่อนติดตั้ง</h2>';
  html += '<p>วันที่ติดตั้ง: <b>' + installDateStr + '</b> (พรุ่งนี้)</p>';
  html += '<p>กรุณาดำเนินการให้เรียบร้อยก่อนเข้าติดตั้ง</p>';
  html += '<hr>';

  items.forEach(it => {
    html += '<div style="margin:12px 0; padding:12px; border-left:4px solid #EA4335; background:#FFF8F8;">';
    html += '<b>ลูกค้า:</b> ' + (it.customer || '-') + '<br>';
    html += '<b>สถานะรวม:</b> ' + (it.overall || '-') + '<br>';
    html += '<b>รายการที่ยังไม่ทำ:</b><ul>';
    it.undone.forEach(u => { html += '<li>' + u + '</li>'; });
    html += '</ul></div>';
  });

  html += '<p style="color:#666;font-size:12px;">ระบบส่งโดยอัตโนมัติจาก Google Apps Script - มดงานการป้าย CRM</p>';
  html += '</div>';

  try {
    MailApp.sendEmail({
      to: toEmail,
      cc: CONFIG.ADMIN_EMAIL,
      subject: subject,
      htmlBody: html
    });
    Logger.log('Sent reminder to: ' + toEmail);
  } catch (err) {
    Logger.log('Error sending email: ' + err);
  }
}

// ============================================================================
// TRIGGER MANAGEMENT
// ============================================================================
/**
 * ติดตั้ง Triggers (รันครั้งเดียวตอน Setup)
 */
function installTriggers_(ssParam) {
  const ss = ssParam || getSpreadsheet_();

  // ลบ Trigger เดิมก่อน
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'onEditChecklist' || fn === 'sendDailyReminder') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // onEdit Trigger
  ScriptApp.newTrigger('onEditChecklist')
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  // Daily Trigger (08:00 ทุกวัน)
  ScriptApp.newTrigger('sendDailyReminder')
    .timeBased()
    .atHour(8)
    .everyDays(1)
    .create();
}

// ============================================================================
// UTILITY - สำหรับ AppSheet หรือ Manual Run
// ============================================================================
/**
 * ตรวจสอบว่า Row นี้ Active (ต้อง track checklist) หรือไม่
 * - Active = สถานะไม่ใช่ค่าใน STATUS_EXCLUDE และมีสถานะ
 */
function isRowActive_(status) {
  if (!status) return false;
  return CONFIG.STATUS_EXCLUDE.indexOf(status) === -1;
}

/**
 * ฟังก์ชันให้ AppSheet เรียก (ผ่าน Automation)
 * เพื่อ Recalculate Overall ของทั้ง Sheet
 * จะคำนวณเฉพาะ Row ที่ Active (สถานะไม่ใช่ "จบงาน")
 */
function recalculateAll() {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;

  const headers = data[0];
  const idxStatus = headers.indexOf(CONFIG.COL_STATUS);

  for (let r = 2; r <= data.length; r++) {
    const status = data[r - 1][idxStatus];
    if (isRowActive_(status)) {
      recalculateOverall_(sheet, r, headers);
    }
  }
}

// ============================================================================
// USER PHOTO - ดึงรูปพนักงานจาก User Login Sheet
// ============================================================================
/**
 * ดึง Google Drive File ID จาก URL หลากหลายรูปแบบ
 */
function _driveFileId_(s) {
  s = String(s || '');
  const m = s.match(/\/file\/d\/([-\w]{20,})/)
        || s.match(/[?&]id=([-\w]{20,})/)
        || s.match(/\/d\/([-\w]{20,})/);
  return m ? m[1] : '';
}

/**
 * แปลงค่ารูป (URL / Path AppSheet "User_Images/xxx.jpg" / สูตร IMAGE) -> Drive File ID
 * - ถ้าเป็น URL ที่มี Drive ID ฝัง -> ดึง ID
 * - ถ้าเป็น AppSheet Path เช่น "User_Images/xxx.jpg" -> ค้นใน Drive ด้วยชื่อไฟล์
 */
function _resolveImgFileId_(s) {
  s = String(s || '').trim();
  if (!s) return '';
  // 1) URL ตรง
  if (/^https?:\/\//i.test(s)) {
    const id = _driveFileId_(s);
    if (id) return id;
  }
  // 2) มี URL อยู่ในข้อความ
  const mm = s.match(/https?:\/\/[^\s)"']+/i);
  if (mm) {
    const id2 = _driveFileId_(mm[0]);
    if (id2) return id2;
  }
  // 3) AppSheet Path -> ค้นใน Drive ด้วยชื่อไฟล์
  const fn = s.split('/').pop();
  if (!fn) return '';
  try {
    const it = DriveApp.searchFiles('title = "' + fn.replace(/"/g, '\\"') + '" and trashed = false');
    if (it.hasNext()) return it.next().getId();
  } catch (e) {
    Logger.log('_resolveImgFileId_ Drive search error: ' + e.message);
  }
  return '';
}

/**
 * ตั้งสิทธิ์ไฟล์ Drive เป็น "ทุกคนที่มีลิงก์ดูได้"
 * พอไฟล์เป็น Public, Thumbnail URL จะใช้ได้ทุกอุปกรณ์ (มือถือ, คอม) โดยไม่ต้อง Login Google
 */
function _makeFilePublic_(id) {
  if (!id) return false;
  try {
    DriveApp.getFileById(id).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return true;
  } catch (e) {
    Logger.log('_makeFilePublic_ error: ' + e.message);
    return false;
  }
}

/**
 * ดึง URL รูปของพนักงานจาก Username
 * @param {string} username - Username (จาก AppSheet User Settings ผ่าน ?u= parameter)
 * @return {string} thumbnail URL หรือ '' ถ้าไม่พบ
 */
function getUserPhoto(username) {
  if (!username) return '';
  try {
    const sh = SpreadsheetApp.openById(CONFIG.LOGIN_SS_ID).getSheetByName(CONFIG.LOGIN_TAB);
    if (!sh) return '';
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow < 2) return '';

    const hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    // หา column Username + Photo (ยืดหยุ่นตามชื่อหัวคอลัมน์)
    let cU = -1, cP = -1;
    for (let c = 0; c < hdr.length; c++) {
      const h = String(hdr[c] || '').toLowerCase().trim();
      if (cU < 0 && /^username$|^user$|ผู้ใช้/i.test(h)) cU = c;
      if (cP < 0 && /รูป|ภาพ|โปรไฟล์|photo|image|impage|imapge|img|avatar|picture|^pic$|โลโก้/.test(h)) cP = c;
    }
    if (cU < 0) {
      Logger.log('getUserPhoto: ไม่พบ Column Username');
      return '';
    }
    if (cP < 0) {
      Logger.log('getUserPhoto: ไม่พบ Column รูป (photo/image/impage)');
      return '';
    }

    const data = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
    const formulas = sh.getRange(2, cP + 1, lastRow - 1, 1).getFormulas();

    const target = String(username).trim().toLowerCase();
    for (let i = 0; i < data.length; i++) {
      const uname = String(data[i][cU] || '').trim().toLowerCase();
      if (uname !== target) continue;

      const raw = data[i][cP];
      let fid = '';

      // 1) CellImage Object (รูปใน Cell)
      if (raw && typeof raw === 'object' && typeof raw.getUrl === 'function') {
        try { fid = _driveFileId_(raw.getUrl() || ''); } catch (e) {}
      }
      // 2) URL / AppSheet Path / Drive ID (เป็น String)
      if (!fid) fid = _resolveImgFileId_(raw);
      // 3) สูตร =IMAGE("...")
      if (!fid) {
        const f = String(formulas[i][0] || '');
        const fm = f.match(/"([^"]+)"/);
        if (fm) fid = _resolveImgFileId_(fm[1]);
      }

      if (fid) {
        _makeFilePublic_(fid);
        return 'https://drive.google.com/thumbnail?id=' + fid + '&sz=w200';
      }
      Logger.log('getUserPhoto: พบ user "' + username + '" แต่ resolve รูปไม่ได้');
      return '';
    }
    Logger.log('getUserPhoto: ไม่พบ Username "' + username + '" ในตาราง');
  } catch (e) {
    Logger.log('getUserPhoto error: ' + e.message);
  }
  return '';
}

/**
 * รันครั้งเดียวเพื่อแชร์รูปพนักงานทั้งหมดให้ Public
 * ทำให้รูปแสดงได้ทั้งบน Web Dashboard ทั้งบนมือถือและคอม
 * โดยไม่ต้อง Login Google
 */
function shareAllUserPhotos() {
  let shared = 0, failed = 0, total = 0, errSample = '';
  try {
    const sh = SpreadsheetApp.openById(CONFIG.LOGIN_SS_ID).getSheetByName(CONFIG.LOGIN_TAB);
    if (!sh) throw new Error('ไม่พบ Sheet: ' + CONFIG.LOGIN_TAB);
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow < 2) return 'ไม่มีข้อมูล User';

    const hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    let cP = -1;
    for (let c = 0; c < hdr.length; c++) {
      const h = String(hdr[c] || '').toLowerCase();
      if (/รูป|ภาพ|โปรไฟล์|photo|image|impage|imapge|img|avatar|picture/.test(h)) {
        cP = c; break;
      }
    }
    if (cP < 0) throw new Error('ไม่พบ Column รูป');

    const vals = sh.getRange(2, cP + 1, lastRow - 1, 1).getValues();
    const formulas = sh.getRange(2, cP + 1, lastRow - 1, 1).getFormulas();

    for (let i = 0; i < vals.length; i++) {
      const raw = vals[i][0];
      let fid = '';
      if (raw && typeof raw === 'object' && typeof raw.getUrl === 'function') {
        try { fid = _driveFileId_(raw.getUrl() || ''); } catch (e) {}
      }
      if (!fid) fid = _resolveImgFileId_(raw);
      if (!fid) {
        const f = String(formulas[i][0] || '');
        const fm = f.match(/"([^"]+)"/);
        if (fm) fid = _resolveImgFileId_(fm[1]);
      }
      if (fid) {
        total++;
        if (_makeFilePublic_(fid)) shared++;
        else { failed++; if (!errSample) errSample = 'ไม่สามารถแชร์ไฟล์ ID: ' + fid; }
      }
    }
  } catch (e) {
    return '⚠ Error: ' + e.message;
  }
  return '✅ พบรูปทั้งหมด ' + total + ' ไฟล์ · แชร์สำเร็จ ' + shared + ' ไฟล์'
    + (failed ? (' · ล้มเหลว ' + failed + ' ไฟล์ — ' + errSample) : '');
}

// ============================================================================
// WEB DASHBOARD - หน้า HTML สรุปงาน
// ============================================================================
/**
 * doGet - แสดงหน้า Web Dashboard
 * URL: <Deploy as Web App URL>
 *
 * รองรับ Query Parameter:
 *   ?u=<username>  — Username จาก AppSheet User Settings
 *                    AppSheet ส่งมาด้วยสูตร:
 *                    CONCATENATE("<URL>?u=", ENCODEURL(USERSETTINGS("Username")))
 */
function doGet(e) {
  const template = HtmlService.createTemplateFromFile('Dashboard');
  template.data = getDashboardData();

  // อ่าน Username จาก URL Parameter (ส่งมาจาก AppSheet)
  let appsheetUsername = '';
  let userPhoto = '';
  try {
    if (e && e.parameter && e.parameter.u) {
      appsheetUsername = String(e.parameter.u).trim();
    }
    // ดึงรูปพนักงานจาก User Login Sheet (ตามชื่อ AppSheet)
    if (appsheetUsername) {
      userPhoto = getUserPhoto(appsheetUsername);
    }
  } catch (err) {
    Logger.log('Parse username/photo from URL failed: ' + err);
  }
  template.appsheetUsername = appsheetUsername;
  template.userPhoto = userPhoto;

  return template.evaluate()
    .setTitle('📋 Dashboard งานติดตั้ง - มดงานการป้าย CRM')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * ดึงข้อมูลทั้งหมดสำหรับ Dashboard (สรุป + รายการงาน)
 * เรียกได้จาก client-side ผ่าน google.script.run.getDashboardData()
 */
function getDashboardData() {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) return { error: 'ไม่พบ Sheet: ' + CONFIG.SHEET_NAME, items: [], summary: {} };

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { items: [], summary: { total: 0, ready: 0, pending: 0, dueSoon: 0 } };

  // ใช้ TZ คนละตัวสำหรับ 2 จุด:
  //   sheetTZ — ใช้ format Cell Date จาก Sheet (ให้ตรงกับที่เห็นในไฟล์ Sheet เป๊ะ)
  //   userTZ  — ใช้คำนวณ "วันนี้/พรุ่งนี้/เมื่อวาน" (ตามเวลาจริงในประเทศไทย)
  const sheetTZ = ss.getSpreadsheetTimeZone() || 'Asia/Bangkok';
  const userTZ = CONFIG.TIMEZONE || 'Asia/Bangkok';
  Logger.log('Sheet TZ: ' + sheetTZ + ' | User TZ: ' + userTZ
    + ' | Now in Sheet TZ: ' + Utilities.formatDate(new Date(), sheetTZ, 'yyyy-MM-dd HH:mm:ss')
    + ' | Now in User TZ: ' + Utilities.formatDate(new Date(), userTZ, 'yyyy-MM-dd HH:mm:ss'));

  const headers = data[0];
  const idx = {
    status: headers.indexOf(CONFIG.COL_STATUS),
    date: headers.indexOf(CONFIG.COL_INSTALL_DATE),
    customer: headers.indexOf(CONFIG.COL_CUSTOMER),
    sales: headers.indexOf(CONFIG.COL_SALES_EMAIL),
    overall: headers.indexOf(CONFIG.COL_OVERALL),
    progress: headers.indexOf(CONFIG.COL_PROGRESS),
    jobNumber: headers.indexOf(CONFIG.COL_JOB_NUMBER),
    image: headers.indexOf(CONFIG.COL_IMAGE)
  };

  // ถ้าหา Column แผนวันที่ติดตั้งไม่เจอ ส่ง Error กลับให้ Dashboard
  if (idx.date < 0) {
    Logger.log('WARN: ไม่พบ Column "' + CONFIG.COL_INSTALL_DATE + '" — Headers ที่มี: ' + headers.join(', '));
  }

  // "วันนี้" ใน Bangkok TZ (User's real today)
  const todayISO = Utilities.formatDate(new Date(), userTZ, 'yyyy-MM-dd');

  const items = [];
  let ready = 0, pending = 0, dueSoon = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = row[idx.status];
    if (!isRowActive_(status)) continue;

    const installDate = row[idx.date];
    const dateObj = (installDate instanceof Date) ? installDate : null;
    let daysFromNow = null;
    let installISO = '';
    if (dateObj) {
      // Format ใน Sheet TZ เพื่อให้ได้วันที่ตรงตามที่เห็นใน Sheet
      installISO = Utilities.formatDate(dateObj, sheetTZ, 'yyyy-MM-dd');
      // คำนวณ daysFromNow โดยเทียบ installISO (Sheet TZ) กับ todayISO (User TZ)
      daysFromNow = isoDaysDiff_(todayISO, installISO);
    }

    const checks = CONFIG.CHECKLIST_COLUMNS.map(chk => {
      const c = headers.indexOf(chk.key);
      const updatedBy = headers.indexOf(chk.key + '_UpdatedBy');
      const updatedAt = headers.indexOf(chk.key + '_UpdatedAt');
      const v = c >= 0 ? String(row[c] || '') : '';
      const isDone = v.indexOf('✅') !== -1;
      return {
        key: chk.key,
        label: chk.label,
        done: isDone,
        updatedBy: updatedBy >= 0 ? row[updatedBy] : '',
        updatedAt: updatedAt >= 0 && row[updatedAt] instanceof Date
          ? Utilities.formatDate(row[updatedAt], userTZ, 'dd/MM HH:mm')
          : ''
      };
    });

    const doneCount = checks.filter(c => c.done).length;
    const isReady = doneCount === CONFIG.CHECKLIST_COLUMNS.length;
    if (isReady) ready++; else pending++;
    if (daysFromNow !== null && daysFromNow >= 0 && daysFromNow <= 1) dueSoon++;

    // แสดงผลในรูป dd/MM/yyyy โดย parse จาก ISO เพื่อความถูกต้อง
    let installDisplay = '-';
    if (installISO) {
      const parts = installISO.split('-');
      installDisplay = parts[2] + '/' + parts[1] + '/' + parts[0];
    }

    items.push({
      row: i + 1,
      customer: idx.customer >= 0 ? row[idx.customer] : '',
      status: status,
      installDate: installDisplay,
      installDateISO: installISO,
      daysFromNow: daysFromNow,
      sales: idx.sales >= 0 ? row[idx.sales] : '',
      jobNumber: idx.jobNumber >= 0 ? String(row[idx.jobNumber] || '') : '',
      imagePath: idx.image >= 0 ? String(row[idx.image] || '') : '',
      checks: checks,
      doneCount: doneCount,
      total: CONFIG.CHECKLIST_COLUMNS.length,
      isReady: isReady,
      overall: idx.overall >= 0 ? row[idx.overall] : ''
    });
  }

  // เรียงตามวันที่ติดตั้งใกล้สุดก่อน
  items.sort((a, b) => {
    if (a.daysFromNow === null) return 1;
    if (b.daysFromNow === null) return -1;
    return a.daysFromNow - b.daysFromNow;
  });

  // รายชื่อ Sales ที่ไม่ซ้ำ สำหรับ Filter Dropdown
  const salesSet = {};
  items.forEach(it => { if (it.sales) salesSet[it.sales] = true; });
  const salesList = Object.keys(salesSet).sort();

  // Labels ของ Checklist (สำหรับใช้ใน tooltip)
  const checklistLabels = CONFIG.CHECKLIST_COLUMNS.map(c => c.label);

  // Default date range: วันนี้ ถึง วันนี้ + 15 วัน (ใน TZ ของ Sheet)
  const futureISO = isoAddDays_(todayISO, 15);

  return {
    items: items,
    summary: {
      total: items.length,
      ready: ready,
      pending: pending,
      dueSoon: dueSoon
    },
    salesList: salesList,
    checklistLabels: checklistLabels,
    defaultRange: { from: todayISO, to: futureISO },
    timezone: { sheet: sheetTZ, user: userTZ },
    updatedAt: Utilities.formatDate(new Date(), userTZ, 'dd/MM/yyyy HH:mm:ss')
  };
}

// ============================================================================
// DIAGNOSTIC - รันเพื่อตรวจสอบข้อมูลในชีท + Timezone
// ============================================================================
/**
 * รันฟังก์ชันนี้ใน Apps Script Editor แล้วดู Execution Log
 * จะแสดง: TZ ที่ใช้, วันที่ปัจจุบัน, ตัวอย่างข้อมูล 5 แถวแรก
 */
function diagnoseDateColumn() {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    Logger.log('❌ ไม่พบ Sheet: ' + CONFIG.SHEET_NAME);
    return;
  }

  const TZ = CONFIG.TIMEZONE || ss.getSpreadsheetTimeZone();
  const sheetTZ = ss.getSpreadsheetTimeZone();
  const scriptTZ = Session.getScriptTimeZone();

  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🔍 DIAGNOSTIC REPORT');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('CONFIG.TIMEZONE (hardcoded): ' + CONFIG.TIMEZONE);
  Logger.log('Sheet TZ (จาก File → Settings): ' + sheetTZ);
  Logger.log('Script TZ (จาก Apps Script Project Settings): ' + scriptTZ);
  Logger.log('Using TZ: ' + TZ);
  Logger.log('---');
  const now = new Date();
  Logger.log('UTC Now: ' + now.toISOString());
  Logger.log('Bangkok Now: ' + Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss'));
  Logger.log('Sheet TZ Now: ' + Utilities.formatDate(now, sheetTZ, 'yyyy-MM-dd HH:mm:ss'));
  Logger.log('Using TZ Now: ' + Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm:ss'));
  Logger.log('---');

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  Logger.log('Headers ทั้งหมด:');
  headers.forEach((h, i) => Logger.log('  [' + (i+1) + '] "' + h + '"'));
  Logger.log('---');

  const idxDate = headers.indexOf(CONFIG.COL_INSTALL_DATE);
  const idxCustomer = headers.indexOf(CONFIG.COL_CUSTOMER);
  Logger.log('Column "' + CONFIG.COL_INSTALL_DATE + '" index: ' + idxDate + ' (Column ' + (idxDate + 1) + ')');
  Logger.log('Column "' + CONFIG.COL_CUSTOMER + '" index: ' + idxCustomer + ' (Column ' + (idxCustomer + 1) + ')');
  Logger.log('---');

  Logger.log('5 แถวแรกของข้อมูล (Customer | Raw Date | Type | ISO in Bangkok):');
  for (let i = 1; i <= Math.min(5, data.length - 1); i++) {
    const row = data[i];
    const customer = idxCustomer >= 0 ? row[idxCustomer] : '?';
    const rawDate = idxDate >= 0 ? row[idxDate] : null;
    const type = rawDate === null ? 'null' : (rawDate instanceof Date ? 'Date' : typeof rawDate);
    let bangkokISO = '-';
    if (rawDate instanceof Date) {
      bangkokISO = Utilities.formatDate(rawDate, 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
    }
    Logger.log('  [Row ' + (i+1) + '] ' + customer + ' | ' + rawDate + ' | ' + type + ' | ' + bangkokISO);
  }
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ============================================================================
// HELPER - คำนวณวันที่จาก ISO String (เลี่ยงปัญหา Timezone)
// ============================================================================
/**
 * คำนวณจำนวนวันระหว่าง 2 ISO date strings (yyyy-MM-dd)
 * Treat ทั้งคู่เป็น UTC midnight เพื่อความ consistent
 */
function isoDaysDiff_(fromISO, toISO) {
  if (!fromISO || !toISO) return null;
  const from = new Date(fromISO + 'T00:00:00Z').getTime();
  const to = new Date(toISO + 'T00:00:00Z').getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

/**
 * บวก N วัน เข้ากับ ISO date string คืน ISO string ใหม่
 */
function isoAddDays_(iso, days) {
  const ts = new Date(iso + 'T00:00:00Z').getTime() + days * 24 * 60 * 60 * 1000;
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// ============================================================================
// API SERVER-SIDE FUNCTIONS - เรียกจาก Dashboard ผ่าน google.script.run
// ============================================================================
/**
 * Toggle สถานะ Checklist (เรียกจาก Dashboard เมื่อ User คลิกไอคอน)
 * @param {number} rowNumber - row index ใน Sheet (1-based)
 * @param {string} checklistKey - key ของ Checklist (เช่น 'CHK1_SiteCheck')
 * @param {boolean} newDone - true = ✅ เรียบร้อย, false = ❌ ยังไม่ทำ
 * @param {string} username - ชื่อผู้กระทำ (จาก Dashboard)
 */
function toggleChecklist(rowNumber, checklistKey, newDone, username) {
  try {
    const ss = getSpreadsheet_();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) throw new Error('ไม่พบ Sheet: ' + CONFIG.SHEET_NAME);

    let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    let col = headers.indexOf(checklistKey) + 1;

    // Auto-Setup: ถ้ายังไม่มี Column ให้สร้างเฉพาะ Column ก่อน (เร็ว ไม่ทำ formatting/validation)
    if (col === 0) {
      Logger.log('Auto-creating columns for ' + checklistKey);
      addChecklistColumns_(sheet);
      // อ่าน Header ใหม่
      headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      col = headers.indexOf(checklistKey) + 1;
      if (col === 0) {
        throw new Error('Auto-setup ล้มเหลว: ไม่สามารถสร้าง Column "' + checklistKey + '" ได้ กรุณารัน setupChecklistSystem จาก Apps Script Editor');
      }
    }

  // เช็คสถานะของ Row นี้ ถ้าอยู่ใน Exclude List ห้ามแก้ไข
  const idxStatus = headers.indexOf(CONFIG.COL_STATUS);
  if (idxStatus >= 0) {
    const rowStatus = sheet.getRange(rowNumber, idxStatus + 1).getValue();
    if (!isRowActive_(rowStatus)) {
      throw new Error('ไม่สามารถแก้ไขได้: งานนี้สถานะ "' + rowStatus + '"');
    }
  }

  const newValue = newDone ? CONFIG.SYMBOL_DONE : CONFIG.SYMBOL_PENDING;
  sheet.getRange(rowNumber, col).setValue(newValue);

  const now = new Date();
  let userName = (username || '').toString().trim();
  if (!userName) {
    userName = Session.getActiveUser().getEmail() || 'unknown';
  }

  const updatedByCol = headers.indexOf(checklistKey + '_UpdatedBy') + 1;
  const updatedAtCol = headers.indexOf(checklistKey + '_UpdatedAt') + 1;

  if (updatedByCol > 0) sheet.getRange(rowNumber, updatedByCol).setValue(userName);
  if (updatedAtCol > 0) {
    sheet.getRange(rowNumber, updatedAtCol).setValue(now);
    sheet.getRange(rowNumber, updatedAtCol).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }

  // คำนวณ Overall ใหม่
  recalculateOverall_(sheet, rowNumber, headers);

  // นับ done ใหม่
  let doneCount = 0;
  CONFIG.CHECKLIST_COLUMNS.forEach(chk => {
    const c = headers.indexOf(chk.key) + 1;
    if (c > 0) {
      const v = sheet.getRange(rowNumber, c).getValue();
      if (String(v).indexOf('✅') !== -1) doneCount++;
    }
  });

    return {
      success: true,
      newDone: newDone,
      updatedBy: userName,
      updatedAt: Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd/MM HH:mm'),
      doneCount: doneCount,
      total: CONFIG.CHECKLIST_COLUMNS.length,
      isReady: doneCount === CONFIG.CHECKLIST_COLUMNS.length
    };
  } catch (e) {
    Logger.log('toggleChecklist error: ' + e.message + '\n' + e.stack);
    throw new Error('[toggle] ' + e.message);
  }
}

/**
 * โหลดภาพใบงานจาก AppSheet Path
 * คืนค่าเป็น data URL (base64) เพื่อแสดงในหน้า Web ได้โดยตรง
 * @param {string} path - AppSheet image path (เช่น 'Images/xxxx.jpg')
 */
function getImageDataUrl(path) {
  if (!path) return { success: false, error: 'ไม่มี Path' };
  try {
    const pathStr = String(path).trim();
    let file = null;
    let filename = '';

    // ===== STEP 1: พยายามดึง Google Drive File ID จาก URL =====
    let fileId = '';

    // Format A: ?id=FILE_ID หรือ &id=FILE_ID (เช่น thumbnail?id=XXX, uc?id=XXX)
    let m = pathStr.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
    if (m) fileId = m[1];

    // Format B: /d/FILE_ID/ (เช่น drive.google.com/file/d/XXX/view)
    if (!fileId) {
      m = pathStr.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
      if (m) fileId = m[1];
    }

    // Format C: /file/d/FILE_ID หรือ open?id=
    if (!fileId) {
      m = pathStr.match(/\/file\/([a-zA-Z0-9_-]{20,})/);
      if (m) fileId = m[1];
    }

    // ถ้าเจอ ID ลองโหลดด้วย ID โดยตรง (เร็วและแม่นยำกว่าค้นหาด้วยชื่อ)
    if (fileId) {
      try {
        file = DriveApp.getFileById(fileId);
        filename = file.getName();
      } catch (e) {
        Logger.log('Drive ID ' + fileId + ' ไม่สามารถเข้าถึงได้: ' + e.message);
        // ไม่ throw ปล่อยให้ไป fallback search by name
      }
    }

    // ===== STEP 2: Fallback - ค้นหาตามชื่อไฟล์ =====
    if (!file) {
      const cleanPath = pathStr.replace(/\\/g, '/').split('?')[0];   // ตัด query string
      filename = cleanPath.split('/').pop();
      if (!filename) {
        return { success: false, error: 'Path ไม่ถูกต้อง: ' + pathStr };
      }

      const files = DriveApp.getFilesByName(filename);
      if (!files.hasNext()) {
        return {
          success: false,
          error: 'ไม่พบไฟล์: ' + filename + (fileId ? ' (ลอง ID: ' + fileId + ' แล้วไม่สำเร็จ)' : '')
        };
      }
      file = files.next();
    }

    // ===== STEP 3: อ่านไฟล์เป็น base64 =====
    const blob = file.getBlob();
    const mime = blob.getContentType();
    const bytes = blob.getBytes();
    if (bytes.length > 5 * 1024 * 1024) {
      return {
        success: false,
        error: 'ไฟล์ใหญ่เกินไป (' + Math.round(bytes.length / 1024 / 1024) + ' MB)',
        directLink: 'https://drive.google.com/file/d/' + file.getId() + '/view'
      };
    }

    return {
      success: true,
      dataUrl: 'data:' + mime + ';base64,' + Utilities.base64Encode(bytes),
      filename: filename,
      directLink: 'https://drive.google.com/file/d/' + file.getId() + '/view'
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * เมนูใน Spreadsheet
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🐜 มดงานการป้าย CRM')
    .addItem('🚀 Setup ระบบ Checklist (รันครั้งแรก)', 'setupChecklistSystem')
    .addSeparator()
    .addItem('🔄 Recalculate Overall ทั้งหมด', 'recalculateAll')
    .addItem('📧 ทดสอบแจ้งเตือนวันนี้', 'sendDailyReminder')
    .addToUi();
}
