'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  Google Drive ปลอม สำหรับยามที่ต้อง "ส่งออกไฟล์ขึ้น Drive" (tools/test-users-export.js)
 *
 *  โหลดล่วงหน้าในเซิร์ฟเวอร์ที่ยามเปิดขึ้นมา:  NODE_OPTIONS="--require <ไฟล์นี้>"
 *   → สวมตัวยิงคำขอของ core/drive-write.js ด้วย _setTransport (ช่องที่ไฟล์นั้นเปิดไว้ให้เทสต์โดยเฉพาะ)
 *   → จดทุกคำขอลงไฟล์ FAKE_DRIVE_LOG (บรรทัดละ 1 คำขอ) ให้ยามอ่านว่า "ส่งอะไรออกไปจริง"
 *   → FAKE_DRIVE_MODE_FILE: เขียนคำว่า quota / noshare ลงไฟล์นี้เพื่อจำลองความล้มเหลว (อ่านทุกคำขอ)
 *
 *  🔒 ไม่ยิง Google จริงแม้แต่ครั้งเดียว · ไม่ต้องมีกุญแจบัญชีระบบ
 *  ‼ ใช้ในเทสต์เท่านั้น — เครื่องจริงไม่มีใครโหลดไฟล์นี้
 * ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const LOG = process.env.FAKE_DRIVE_LOG || '';
const MODE_FILE = process.env.FAKE_DRIVE_MODE_FILE || '';
const mode = () => { try { return MODE_FILE ? String(fs.readFileSync(MODE_FILE, 'utf8')).trim() : ''; } catch (e) { return ''; } };
const note = o => { if (LOG) try { fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); } catch (e) { /* จดไม่ได้ก็ไม่เป็นไร */ } };

const res = (status, obj) => {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null },
           text: async () => body, json: async () => JSON.parse(body) };
};

const folders = new Map();          /* ชื่อ → ไอดี */
let seq = 0;

async function fakeFetch(url, opt) {
  const u = String(url), o = opt || {}, m = String(o.method || 'GET').toUpperCase();
  const body = Buffer.isBuffer(o.body) ? o.body.toString('utf8') : (o.body == null ? '' : String(o.body));
  const md = mode();
  note({ m, u, auth: String((o.headers || {}).Authorization || ''), ct: String((o.headers || {})['Content-Type'] || ''), body });

  if (m === 'DELETE' || /\/trash\b/.test(u)) return res(405, { error: { message: 'delete is not allowed in tests' } });

  /* แชร์ไฟล์ */
  const pm = u.match(/\/drive\/v3\/files\/([^/?]+)\/permissions/);
  if (pm && m === 'POST') {
    if (md === 'noshare') return res(403, { error: { errors: [{ reason: 'cannotShareTeamDriveWithNonGoogleAccounts' }], message: 'Sharing outside the organization is not allowed.' } });
    return res(200, { id: 'anyoneWithLink' });
  }
  /* อัปไฟล์ (multipart) */
  if (/\/upload\/drive\/v3\/files/.test(u) && m === 'POST') {
    if (md === 'quota') return res(403, { error: { errors: [{ reason: 'storageQuotaExceeded' }], message: 'Service Accounts do not have storage quota.' } });
    let meta = {};
    try { meta = JSON.parse((body.match(/\r\n\r\n(\{[\s\S]*?\})\r\n--/) || [])[1] || '{}'); } catch (e) { meta = {}; }
    return res(200, { id: 'FAKESHEET' + (++seq) + 'x' + Date.now().toString(36), name: meta.name || '', mimeType: meta.mimeType || '', size: String(body.length) });
  }
  /* ค้นโฟลเดอร์ */
  if (/\/drive\/v3\/files\?/.test(u) && m === 'GET') {
    const q = decodeURIComponent((u.match(/[?&]q=([^&]+)/) || [])[1] || '');
    const nm = (q.match(/name = '([^']+)'/) || [])[1] || '';
    return res(200, { files: folders.has(nm) ? [{ id: folders.get(nm), name: nm }] : [] });
  }
  /* สร้างโฟลเดอร์ */
  if (/\/drive\/v3\/files\?/.test(u) && m === 'POST') {
    let j = {}; try { j = JSON.parse(body); } catch (e) { j = {}; }
    const id = 'FAKEFOLDER' + (++seq);
    folders.set(j.name || '', id);
    return res(200, { id });
  }
  return res(404, { error: { message: 'fake drive: no route ' + m + ' ' + u } });
}

/* โฟลเดอร์แม่ปลอม — core/drive-write.js ต้องมีโฟลเดอร์แม่ถึงจะสร้างโฟลเดอร์ลูกได้ */
if (!process.env.DRIVE_ROOT_FOLDER_ID) process.env.DRIVE_ROOT_FOLDER_ID = 'FAKEROOT';

const DW = require(path.join(process.cwd(), 'core', 'drive-write'));
DW._setTransport({ fetch: fakeFetch, token: async () => 'fake-drive-token' });

module.exports = { fakeFetch };
