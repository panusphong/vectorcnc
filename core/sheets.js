'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  core/sheets.js — อ่าน Google Sheets ด้วย Service Account
 *
 *  ทำไมไม่ใช้ไลบรารี googleapis: มันลากมาหลายสิบแพ็กเกจ ทั้งที่เราต้องการ
 *  แค่ "อ่านค่าจากแท็บ" อย่างเดียว — เซ็น JWT เองด้วย crypto ในตัว Node
 *  แล้วยิง REST ตรง ๆ จบ (แนวเดียวกับ core/db.js ที่ไม่ใช้ supabase-js)
 *
 *  ‼ สองสิทธิ์ แยกกันชัด
 *      อ่าน  → spreadsheets.readonly   ใช้กับทุกอย่างที่แค่ดึงข้อมูล
 *      เขียน → spreadsheets            ใช้เฉพาะ appendRow/updateRow เท่านั้น
 *
 *    แยกไว้เพื่อให้ "งานซิงค์" ไม่มีทางเขียนอะไรหลุดไปได้เลย ต่อให้โค้ดพลาด
 *    Google จะปฏิเสธเอง เพราะโทเคนที่งานซิงค์ถืออยู่ขอมาแค่สิทธิ์อ่าน
 *
 *  ‼ ห้ามใช้กับ PEAK เด็ดขาด — ไฟล์นี้คุยกับ Google Sheets เท่านั้น
 * ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const { CFG } = require('./config');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE       = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const SCOPE_WRITE = 'https://www.googleapis.com/auth/spreadsheets';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

const b64url = b => Buffer.from(b).toString('base64url');

/* ─── โทเคน ─────────────────────────────────────────────────────── */

/** อ่านข้อมูล service account จาก env — รองรับทั้ง JSON เต็มและแบบแยกฟิลด์ */
function credentials() {
  const raw = CFG.GOOGLE_SA_JSON;
  if (raw) {
    let j;
    try {
      // Railway บางทีเก็บ JSON แบบ base64 มา — รองรับทั้งสองแบบ
      const txt = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
      j = JSON.parse(txt);
    } catch (e) {
      throw new Error('GOOGLE_SA_JSON อ่านไม่ออก — ต้องเป็น JSON ของ service account (หรือ base64 ของ JSON นั้น)');
    }
    if (!j.client_email || !j.private_key)
      throw new Error('GOOGLE_SA_JSON ไม่มี client_email หรือ private_key');
    return { email: j.client_email, key: j.private_key };
  }
  if (CFG.GOOGLE_SA_EMAIL && CFG.GOOGLE_SA_KEY)
    return { email: CFG.GOOGLE_SA_EMAIL, key: CFG.GOOGLE_SA_KEY.replace(/\\n/g, '\n') };

  throw new Error(
    'ยังไม่ได้ตั้งค่าบัญชีสำหรับอ่าน Google Sheets — ใส่ GOOGLE_SA_JSON ใน Railway > Variables'
  );
}

/** พร้อมใช้งานไหม (ไม่โยน error) — ใช้เช็คก่อนตั้งเวลาซิงค์ */
function isConfigured() {
  try { credentials(); return true; } catch { return false; }
}

/** ขอ access token (เก็บไว้ใช้ซ้ำจนกว่าจะใกล้หมดอายุ)
 *  แยกกล่องเก็บตาม scope — โทเคนอ่านกับโทเคนเขียนต้องไม่ปนกัน */
const _tokens = new Map();
async function accessToken(scope) {
  const sc = scope || SCOPE;
  const _token = _tokens.get(sc);
  if (_token && Date.now() < _token.exp - 60000) return _token.value;

  const { email, key } = credentials();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email, scope: sc, aud: TOKEN_URL, iat: now, exp: now + 3600,
  }));
  const signature = crypto.createSign('RSA-SHA256')
    .update(header + '.' + claim).sign(key, 'base64url');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new Error('ขอสิทธิ์เข้า Google ไม่สำเร็จ: ' +
      (j.error_description || j.error || 'HTTP ' + res.status));
  }
  const t = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  _tokens.set(sc, t);
  return t.value;
}

/* ─── เรียก Sheets API ──────────────────────────────────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TRIES = 5;

async function apiGet(path, params) {
  const qs = new URLSearchParams(params || {}).toString();
  const url = `${API}/${path}${qs ? '?' + qs : ''}`;
  let lastErr = null;

  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const token = await accessToken();
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });

      if (res.ok) return res.json();

      const text = await res.text();
      // 401 = โทเคนหมดอายุกลางคัน → ล้างแล้วขอใหม่
      if (res.status === 401) { _tokens.delete(SCOPE); continue; }
      // 429/5xx = Google ขอให้รอ → ถอยแล้วลองใหม่
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Google Sheets ${res.status}`);
        if (attempt < TRIES) { await sleep(700 * Math.pow(2, attempt - 1)); continue; }
      }
      if (res.status === 403)
        throw new Error('เข้าชีตไม่ได้ (403) — ยังไม่ได้แชร์ชีตให้ service account หรือแชร์ผิดสิทธิ์');
      if (res.status === 404)
        throw new Error('ไม่พบชีตหรือแท็บนี้ (404) — ตรวจ Spreadsheet ID และชื่อแท็บ');
      throw new Error(`Google Sheets ${res.status}: ${text.slice(0, 300)}`);

    } catch (e) {
      /* ‼ เน็ตสะดุดต้องลองใหม่ ไม่ใช่ล้มทั้งงาน
       *
       *   บั๊กจริง (4 ก.ย. 69): fetch โยน TypeError('fetch failed') ออกมาตรง ๆ
       *   ตอนเน็ตขาดชั่วขณะ — ของเดิมดักไว้แค่ "รหัสตอบกลับที่ผิด"
       *   ไม่ได้ดัก "ต่อไม่ติดเลย" ข้อผิดพลาดจึงกระโดดข้ามลูปลองใหม่ไปทั้งดุ้น
       *   ผลคือรอบนั้นล้ม 7 งานรวดโดยอ่านไม่ได้สักแถว
       *
       *   บทเรียน: ตัวลองใหม่ต้องครอบ "ทั้งการเรียก" ไม่ใช่แค่ครอบผลลัพธ์ */
      if (/\((403|404)\)|Google Sheets \d/.test(e.message)) throw e;   // ผิดที่เราเอง ลองซ้ำก็เท่านั้น
      lastErr = e;
      if (attempt < TRIES) {
        await sleep(700 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300));
        continue;
      }
    }
  }
  const msg = String((lastErr && lastErr.message) || '');
  if (/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|socket|network/i.test(msg))
    throw new Error('ต่อ Google ไม่ติดชั่วคราว (ลองแล้ว ' + TRIES + ' ครั้ง) — ' +
                    'มักเกิดตอนดึงหลายแท็บพร้อมกัน รอบถัดไปจะดึงต่อให้เอง');
  throw new Error('เรียก Google Sheets ไม่สำเร็จหลังลอง ' + TRIES + ' ครั้ง — ' + msg.slice(0, 200));
}

/* ─── ของที่เอาไปใช้จริง ────────────────────────────────────────── */

/** รายชื่อแท็บในไฟล์ — ใช้ตรวจว่าตั้งชื่อแท็บถูกไหม */
async function listTabs(spreadsheetId) {
  const j = await apiGet(encodeURIComponent(spreadsheetId), { fields: 'sheets.properties' });
  return (j.sheets || []).map(s => ({
    title: s.properties.title,
    rows: s.properties.gridProperties && s.properties.gridProperties.rowCount,
    cols: s.properties.gridProperties && s.properties.gridProperties.columnCount,
  }));
}

/**
 * อ่านทั้งแท็บออกมาเป็น { header: [...], rows: [[...], ...] }
 *
 * valueRenderOption = UNFORMATTED_VALUE  → ได้ตัวเลขเป็นตัวเลขจริง ไม่ใช่ "1,234.00"
 * dateTimeRenderOption = SERIAL_NUMBER   → วันที่เป็นเลขซีเรียลของ Sheets
 *   (แปลงเป็นวันที่จริงใน core/sync.js — แม่นกว่าให้ Google ฟอร์แมตเป็นข้อความ
 *    ซึ่งขึ้นกับ locale ของไฟล์ และเคยทำให้ พ.ศ./ค.ศ. ปนกันมาแล้ว)
 */
async function readTab(spreadsheetId, tab) {
  const range = tab ? `'${String(tab).replace(/'/g, "''")}'` : 'A:ZZ';
  const j = await apiGet(
    `${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    {
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    }
  );
  const values = j.values || [];
  if (!values.length) return { header: [], rows: [] };

  const header = values[0].map(h => String(h == null ? '' : h).trim());
  const rows = values.slice(1);
  return { header, rows };
}

/**
 * อ่านแค่ไม่กี่แถวแรก — ใช้ส่องหัวตารางตอนตั้งค่า
 * ไม่ดึงทั้งแท็บ เพราะบางแท็บมีสามหมื่นแถว (เช่น _ImgIndex)
 */
async function readHead(spreadsheetId, tab, n = 3) {
  const t = tab ? `'${String(tab).replace(/'/g, "''")}'!` : '';
  const j = await apiGet(
    `${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(t + 'A1:ZZ' + Math.max(2, n))}`,
    {
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    }
  );
  const values = j.values || [];
  if (!values.length) return { header: [], rows: [] };
  return {
    header: values[0].map(h => String(h == null ? '' : h).trim()),
    rows: values.slice(1),
  };
}

/* ═══════════════════════════════════════════════════════════════════
 *  เขียนลงชีต — ใช้เฉพาะตอนผู้ใช้กด "บันทึก" ในแอปเท่านั้น
 *
 *  ทำไมต้องเขียนลงชีตด้วย ไม่เขียนแค่ Supabase:
 *    ช่วงนี้ชีตยังเป็นแหล่งความจริง งานซิงค์ดึงชีต → ฐานข้อมูลทุก 10 นาที
 *    ถ้าเขียนแค่ฐานข้อมูล รอบซิงค์ถัดไปจะทับของที่เพิ่งคีย์หายทันที
 *    เขียนลงชีตก่อน = แอปเดิมเห็นด้วย · รอบซิงค์ถัดไปก็ไม่ทับ · ย้อนดูได้ในชีต
 *
 *  ‼ ต้องแชร์ชีตให้ service account เป็น "ผู้แก้ไข" ก่อน ไม่งั้นจะได้ 403
 * ═══════════════════════════════════════════════════════════════════ */

/** ยิง Sheets API แบบมีเนื้อหา (POST/PUT) — ใช้สิทธิ์เขียน */
async function apiWrite(method, path, params, body) {
  const qs = new URLSearchParams(params || {}).toString();
  const url = `${API}/${path}${qs ? '?' + qs : ''}`;
  let lastErr = null;

  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const token = await accessToken(SCOPE_WRITE);
      const res = await fetch(url, {
        method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      if (res.ok) return res.json();

      const text = await res.text();
      if (res.status === 401) { _tokens.delete(SCOPE_WRITE); continue; }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Google Sheets ${res.status}`);
        if (attempt < TRIES) { await sleep(700 * Math.pow(2, attempt - 1)); continue; }
      }
      if (res.status === 403)
        throw new Error('เขียนลงชีตไม่ได้ (403) — ต้องแชร์ชีตให้ service account ' +
                        'เป็น "ผู้แก้ไข" ก่อน (ตอนนี้น่าจะยังเป็น "ผู้อ่าน")');
      if (res.status === 404)
        throw new Error('ไม่พบชีตหรือแท็บนี้ (404) — ตรวจ Spreadsheet ID และชื่อแท็บ');
      throw new Error(`Google Sheets ${res.status}: ${text.slice(0, 300)}`);

    } catch (e) {
      if (/\((403|404)\)|Google Sheets \d/.test(e.message)) throw e;
      lastErr = e;
      if (attempt < TRIES) {
        await sleep(700 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300));
        continue;
      }
    }
  }
  throw new Error('เขียนลง Google Sheets ไม่สำเร็จหลังลอง ' + TRIES + ' ครั้ง — ' +
                  String((lastErr && lastErr.message) || '').slice(0, 200));
}

const q = t => `'${String(t).replace(/'/g, "''")}'`;

/**
 * ต่อแถวใหม่ท้ายแท็บ — คืนเลขแถวจริงที่ Google ใส่ให้
 *
 * insertDataOption=INSERT_ROWS  → แทรกแถวจริง ไม่ไปทับสูตร/ข้อมูลที่มีอยู่
 * valueInputOption=USER_ENTERED → ให้ Sheets ตีความวันที่/ตัวเลขเหมือนคนพิมพ์เอง
 *   (RAW จะได้ข้อความล้วน แล้วสูตรในชีตเดิมจะคำนวณไม่ได้)
 */
async function appendRow(spreadsheetId, tab, values) {
  const j = await apiWrite('POST',
    `${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(q(tab) + '!A1')}:append`,
    { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      includeValuesInResponse: 'false' },
    { majorDimension: 'ROWS', values: [values] });

  /* updatedRange เช่น  'TotalSales'!A5702:CE5702  → เอาเลขแถวออกมา */
  const rng = (j.updates && j.updates.updatedRange) || '';
  const m = rng.match(/![A-Z]+(\d+)/);
  if (!m) throw new Error('ต่อแถวลงชีตแล้ว แต่อ่านเลขแถวกลับมาไม่ได้: ' + rng);
  return { row: parseInt(m[1], 10), range: rng };
}

/** เขียนทับทั้งแถว (ใช้ตอนแก้ไข) — values เรียงตามคอลัมน์ A เป็นต้นไป */
async function updateRow(spreadsheetId, tab, rowNo, values) {
  const n = parseInt(rowNo, 10);
  if (!(n > 1)) throw new Error('เลขแถวไม่ถูกต้อง: ' + rowNo);
  const last = colName(values.length);
  await apiWrite('PUT',
    `${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(q(tab) + `!A${n}:${last}${n}`)}`,
    { valueInputOption: 'USER_ENTERED' },
    { range: `${q(tab)}!A${n}:${last}${n}`, majorDimension: 'ROWS', values: [values] });
  return { row: n };
}

/** อ่านแถวเดียวตามเลขแถวจริงในชีต (ใช้ยืนยันก่อนแก้ทับ) */
async function readRow(spreadsheetId, tab, rowNo) {
  const n = parseInt(rowNo, 10);
  if (!(n > 1)) throw new Error('เลขแถวไม่ถูกต้อง: ' + rowNo);
  const j = await apiGet(
    `${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(q(tab) + `!A${n}:ZZ${n}`)}`,
    { majorDimension: 'ROWS', valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER' });
  return ((j.values || [])[0]) || [];
}

/** เลขคอลัมน์ → ชื่อคอลัมน์ (1→A, 27→AA) */
function colName(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s || 'A';
}

module.exports = { isConfigured, listTabs, readTab, readHead, accessToken, credentials,
                   appendRow, updateRow, readRow, colName };

