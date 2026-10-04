/* ═══════════════════════════════════════════════════════════════════
 *  💵 Cash Flow ใหม่ — หน้าจอ (รอบ 235 · 4 ต.ค. 69)
 *
 *  🔴 พี่เอสั่ง (คำต่อคำ):
 *    "เดี๋ยวรื้อ code cash flow ใหม่หมดเลยนะ เขียนขึ้นมาใหม่ ทำให้ดูง่าย เห็นสรุปภาพรวม
 *     เจาะลงรายละเอียดได้ ไม่ใช่มาอะไรเยอะแยะไปหมดแบบนี้ไม่ดู เสียเวลา"
 *    "พี่ต้องการเห็นยอดเงินในบัญชี ทุกบัญชี ที่เข้าและออกด้วยนะ"
 *
 *  หน้าเดียว 4 ส่วน (บนลงล่าง):
 *    ① ตัวเลขของเดือน: เงินเข้า · เงินออก · สุทธิ · เงินคงเหลือทุกบัญชี
 *    ② ยอดเงินในบัญชี (ทุกบัญชี: ยกมา · เข้า · ออก · คงเหลือ)  +  ลูกหนี้ / เงินที่คาดว่าจะเข้า
 *    ③ รายเดือน 12 เดือน — กดเดือนเพื่อดูเดือนนั้น
 *    ④ เดือนที่เลือก แยกหมวด เงินเข้า / เงินออก — กดหมวดเพื่อดูเอกสารทีละใบ
 *  เครื่องมือของหน้า Cash Flow เดิมทั้งหมด อยู่หลังปุ่ม "🛠 เครื่องมือผู้ดูแล" (ไม่ได้ลบ)
 *
 *  ‼ ไฟล์นี้ถูกโหลด "ตอนกดเมนู Cash Flow" เท่านั้น — หน้าแอปคีย์ยอดขายไม่หนักขึ้น
 *  ‼ หน้านี้อ่านจากฐานของเรา ไม่ยิง PEAK ตอนเปิด (ตัวดึงเบื้องหลังเป็นคนยิง) · ตัวเลขทุกตัวคิดที่เซิร์ฟเวอร์
 * ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var BASE = location.pathname.replace(/\/$/, '');
  var S = { biz: '', ym: '', data: null, ar: null, arBiz: null, loading: false, poll: null, drawer: null, find: '', syncMsg: '' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function getJ(u) { return fetch(BASE + u, { credentials: 'same-origin' }).then(function (r) { return r.json(); }); }
  function postJ(u, b) { return fetch(BASE + u, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
  function n0(v) { return Math.round(Number(v) || 0).toLocaleString('en-US'); }
  function n2(v) { return (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function baht(v) { var x = Number(v) || 0; return (x < 0 ? '−' : '') + '฿' + n0(Math.abs(x)); }
  function signed(v) { var x = Number(v) || 0; return (x > 0 ? '+' : (x < 0 ? '−' : '')) + '฿' + n0(Math.abs(x)); }
  function dmy(d) { d = String(d || ''); return d.length === 8 ? d.slice(6) + '/' + d.slice(4, 6) : d; }
  function when(iso) {
    if (!iso) return '';
    var t = new Date(iso); if (isNaN(t)) return '';
    var z = new Date(t.getTime() + 7 * 3600000).toISOString();
    return z.slice(8, 10) + '/' + z.slice(5, 7) + ' ' + z.slice(11, 16) + ' น.';
  }

  /* ── หน้าตา: ใช้โทนเดียวกับแอป (ตัวแปร --ink --mut --line --bg --card ของหน้าแอป) + 2 สีของเข้า/ออก ──
   *  สีเข้า/ออกผ่านตัวตรวจแยกสีสำหรับคนตาบอดสีแล้ว และทุกจุดมีป้ายคำกำกับ ไม่พึ่งสีอย่างเดียว */
  var CSS = [
    '#cbOv{--cb-in:#1a8a5f;--cb-out:#c2410c;--cb-soft:#f6f7f9;--cb-warn:#b45309;--cb-warnbg:#fff7e6}',
    '#cbOv .ov-body{padding:16px 18px 40px}',
    '.cb-wrap{max-width:1240px;margin:0 auto;display:flex;flex-direction:column;gap:14px}',
    '.cb-tabs{display:inline-flex;gap:4px;background:var(--cb-soft);border:1px solid var(--line);border-radius:10px;padding:3px}',
    '.cb-tab{border:0;background:none;padding:6px 12px;border-radius:8px;font:inherit;font-size:13px;font-weight:600;color:var(--mut);cursor:pointer}',
    '.cb-tab.on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.08)}',
    '.cb-tab:focus-visible,.cb-row:focus-visible,.cb-cat:focus-visible,.cb-btn:focus-visible{outline:2px solid var(--brand);outline-offset:1px}',
    '.cb-mon{display:inline-flex;align-items:center;gap:2px;font-weight:700;font-size:14px;color:var(--ink)}',
    '.cb-mon button{border:1px solid var(--line);background:#fff;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:15px;color:var(--ink)}',
    '.cb-mon button:disabled{opacity:.35;cursor:default}',
    '.cb-mon span{min-width:78px;text-align:center}',
    '.cb-btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 11px;font:inherit;font-size:12.5px;font-weight:600;color:#475569;cursor:pointer;white-space:nowrap}',
    '.cb-btn:hover{border-color:var(--brand);color:var(--brand)}',
    '.cb-note{font-size:12.5px;color:var(--mut);line-height:1.6}',
    '.cb-flag{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.6;border-radius:10px;padding:8px 12px;border:1px solid var(--line);background:#fff;color:var(--mut)}',
    '.cb-flag.warn{background:var(--cb-warnbg);border-color:#f1d58a;color:#7a4b00}',
    '.cb-flag b{color:var(--ink)}',
    '.cb-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}',
    '.cb-tile{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 16px;min-width:0}',
    '.cb-tile .l{font-size:12.5px;color:var(--mut);font-weight:600;display:flex;align-items:center;gap:6px}',
    '.cb-tile .v{font-size:26px;font-weight:800;color:var(--ink);margin-top:4px;font-variant-numeric:tabular-nums;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cb-tile .s{font-size:12px;color:var(--mut);margin-top:3px;line-height:1.5}',
    '.cb-dot{display:inline-block;width:9px;height:9px;border-radius:3px;flex:0 0 auto}',
    '.cb-dot.in{background:var(--cb-in)}.cb-dot.out{background:var(--cb-out)}',
    '.cb-two{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(0,1fr);gap:12px;align-items:start}',
    '.cb-card{background:#fff;border:1px solid var(--line);border-radius:14px;min-width:0}',
    '.cb-card>h3{margin:0;padding:13px 16px 9px;font-size:14.5px;font-weight:800;color:var(--ink);display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
    '.cb-card>h3 small{font-size:12px;font-weight:500;color:var(--mut)}',
    '.cb-scroll{overflow-x:auto}',
    '.cb-t{width:100%;border-collapse:collapse;font-size:13px}',
    '.cb-t th{font-size:11.5px;font-weight:600;color:var(--mut);text-align:right;padding:6px 12px;border-bottom:1px solid var(--line);white-space:nowrap}',
    '.cb-t th:first-child,.cb-t td:first-child{text-align:left;padding-left:16px}',
    '.cb-t th:last-child,.cb-t td:last-child{padding-right:16px}',
    '.cb-t td{padding:8px 12px;border-bottom:1px solid #f0f1f4;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--ink)}',
    '.cb-t tr:last-child td{border-bottom:0}',
    '.cb-t td.nm{white-space:normal;min-width:180px}',
    '.cb-t td.nm small{display:block;font-size:11.5px;color:var(--mut);font-weight:400}',
    '.cb-row{cursor:pointer}.cb-row:hover td{background:#f7f9fc}',
    '.cb-row.sel td{background:#eef4ff}',
    '.cb-t tr.grp td{background:var(--cb-soft);font-size:12px;font-weight:700;color:#475569;padding:6px 16px;text-align:left}',
    '.cb-t tr.sum td{font-weight:800;border-top:1px solid var(--line);background:#fafbfc}',
    '.cb-t td.sub{padding-left:32px}',
    '.cb-mut{color:var(--mut)}',
    '.cb-bars{display:flex;flex-direction:column;gap:3px;min-width:150px}',
    '.cb-bar{height:7px;border-radius:0 4px 4px 0;min-width:1px}',
    '.cb-bar.in{background:var(--cb-in)}.cb-bar.out{background:var(--cb-out)}',
    '.cb-leg{display:inline-flex;gap:12px;font-size:12px;color:var(--mut);font-weight:500;margin-left:auto}',
    '.cb-leg span{display:inline-flex;align-items:center;gap:5px}',
    '.cb-ar{padding:2px 16px 14px}',
    '.cb-ar .big{font-size:24px;font-weight:800;color:var(--ink);font-variant-numeric:tabular-nums}',
    '.cb-kv{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:7px 0;border-top:1px solid #f0f1f4}',
    '.cb-kv span:first-child{color:var(--mut)}.cb-kv b{font-variant-numeric:tabular-nums;color:var(--ink)}',
    '.cb-cats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start}',
    '.cb-cat{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:10px 16px;border-top:1px solid #f0f1f4;cursor:pointer;width:100%;text-align:left;background:none;border-left:0;border-right:0;border-bottom:0;font:inherit;color:var(--ink)}',
    '.cb-cat:hover{background:#f7f9fc}',
    '.cb-cat .nm{font-size:13.5px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cb-cat .am{font-size:13.5px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.cb-cat .ln{grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--mut)}',
    '.cb-cat .tr{flex:1;height:6px;background:#eef0f4;border-radius:3px;overflow:hidden}',
    '.cb-cat .tr i{display:block;height:100%;border-radius:0 3px 3px 0}',
    '.cb-cat.muted .nm,.cb-cat.muted .am{color:var(--mut);font-weight:500}',
    '.cb-empty{padding:26px 16px;text-align:center;color:var(--mut);font-size:13px;line-height:1.7}',
    '.cb-dr{position:fixed;inset:0;z-index:90;background:rgba(15,23,42,.45);display:flex;justify-content:flex-end}',
    '.cb-dr .pane{width:min(980px,100%);height:100%;background:#fff;display:flex;flex-direction:column;box-shadow:-12px 0 32px rgba(15,23,42,.18)}',
    '.cb-dr .hd{padding:14px 18px 10px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:flex-start}',
    '.cb-dr .hd h4{margin:0;font-size:16px;font-weight:800;color:var(--ink);line-height:1.4}',
    '.cb-dr .hd p{margin:2px 0 0;font-size:12.5px;color:var(--mut)}',
    '.cb-dr .x{margin-left:auto;border:0;background:none;font-size:20px;cursor:pointer;color:var(--mut);padding:2px 6px}',
    '.cb-dr .tl{padding:10px 18px;display:flex;gap:10px;align-items:center;border-bottom:1px solid #f0f1f4}',
    '.cb-dr .tl input{flex:1;border:1px solid var(--line);border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;min-width:0}',
    '.cb-dr .bd{flex:1;overflow:auto}',
    '.cb-dr .cb-t th{position:sticky;top:0;background:#fff;z-index:1}',
    '.cb-dr .cb-t td.nm{min-width:240px}',
    '.cb-pill{display:inline-block;font-size:11px;font-weight:600;border-radius:999px;padding:1px 8px;background:#eef0f4;color:#475569;margin-left:6px;white-space:nowrap}',
    '@media (max-width:900px){.cb-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.cb-two,.cb-cats{grid-template-columns:minmax(0,1fr)}.cb-tile .v{font-size:21px}}',
  ].join('\n');

  function ensureDom() {
    if ($('cbOv')) return;
    var st = document.createElement('style'); st.id = 'cbCss'; st.textContent = CSS; document.head.appendChild(st);
    var d = document.createElement('div');
    d.id = 'cbOv'; d.className = 'ov-panel hidden';
    d.innerHTML =
      '<div class="ov-head">💵 Cash Flow <span style="font-size:12px;font-weight:600;color:var(--mut)">เงินเข้า–ออกจริงจากสมุดบัญชี PEAK</span>' +
        '<span class="ov-acts" style="gap:8px;align-items:center">' +
          '<span id="cbTabs"></span><span id="cbMon"></span>' +
          '<button class="cb-btn" id="cbSync" onclick="CB.sync()" title="สั่งให้ระบบถามงบทดลอง + รายการเดินบัญชีของเดือนนี้จาก PEAK เดี๋ยวนี้ (อ่านอย่างเดียว)">⟳ ดึงจาก PEAK</button>' +
          '<button class="cb-btn" id="cbTools" onclick="CB.tools()" title="หน้า Cash Flow เดิม: ซิงก์รายจ่าย · กระทบยอด · ตรวจรายการซ้ำ · ระยะเวลาเก็บเงิน · ปุ่มทดสอบ PEAK">🛠 เครื่องมือผู้ดูแล</button>' +
          '<span class="ov-x" onclick="CB.close()" style="margin-left:0">✕</span>' +
        '</span></div>' +
      '<div class="ov-body"><div class="cb-wrap" id="cbBody"><div class="cb-empty">กำลังโหลด…</div></div></div>';
    document.body.appendChild(d);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (S.drawer) { closeDrawer(); e.stopPropagation(); }
    }, true);
  }

  /* ── โหลด ─────────────────────────────────────────────────────── */
  function load(keep) {
    S.loading = true;
    if (!keep) $('cbBody').innerHTML = '<div class="cb-empty">กำลังโหลด…</div>';
    var q = '?biz=' + encodeURIComponent(S.biz) + (S.ym ? '&ym=' + encodeURIComponent(S.ym) : '');
    return getJ('/api/cashbook' + q).then(function (R) {
      S.loading = false;
      if (!R || R.ok === false) throw new Error((R && (R.msg || R.error)) || 'โหลดไม่สำเร็จ');
      S.data = R; S.ym = R.ym || S.ym;
      render();
      if (S.arBiz !== S.biz) loadAr();
      watch();
    }).catch(function (e) {
      S.loading = false;
      $('cbBody').innerHTML = '<div class="cb-empty">🔒 ' + esc(e && e.message || e) + '</div>';
    });
  }
  function loadAr() {
    var b = S.biz; S.ar = null; S.arBiz = b; paintAr();
    getJ('/api/cashbook/ar?biz=' + encodeURIComponent(b)).then(function (R) {
      if (S.arBiz !== b) return;
      S.ar = R || { ok: false }; paintAr();
    }).catch(function (e) { if (S.arBiz === b) { S.ar = { ok: false, error: String(e && e.message || e) }; paintAr(); } });
  }
  /* ตัวดึงเบื้องหลังยังทำงานอยู่ (ดึงครั้งแรก/ย้อนหลัง) ⇒ ถามสถานะทุก 15 วินาที แล้วโหลดใหม่เมื่อมีเดือนเสร็จเพิ่ม */
  function watch() {
    if (S.poll) { clearTimeout(S.poll); S.poll = null; }
    var st = S.data && S.data.sync;
    if (!st || $('cbOv').classList.contains('hidden')) return;
    var busy = st.busy || (st.biz || []).some(function (b) { return b.done < b.months && !b.err; });
    if (!busy) return;
    S.poll = setTimeout(function () {
      if ($('cbOv').classList.contains('hidden')) return;
      load(true);
    }, 15000);
  }

  /* ── วาด ──────────────────────────────────────────────────────── */
  function tabs() {
    var R = S.data || {}, L = R.bizList || [];
    var h = '<span class="cb-tabs" role="tablist"><button class="cb-tab' + (S.biz === '' ? ' on' : '') + '" onclick="CB.biz(\'\')">รวมทุกบริษัท</button>';
    L.forEach(function (b, i) { h += '<button class="cb-tab' + (S.biz === b ? ' on' : '') + '" onclick="CB.bizAt(' + i + ')">' + esc(b) + '</button>'; });
    $('cbTabs').innerHTML = h + '</span>';
    var M = R.months || [], i = M.findIndex(function (m) { return m.ym === S.ym; });
    var cur = M[i] || {};
    $('cbMon').innerHTML = '<span class="cb-mon"><button onclick="CB.step(-1)" aria-label="เดือนก่อน"' + (i > 0 ? '' : ' disabled') + '>‹</button>' +
      '<span>' + esc(cur.label || '') + '</span><button onclick="CB.step(1)" aria-label="เดือนถัดไป"' + (i >= 0 && i < M.length - 1 ? '' : ' disabled') + '>›</button></span>';
  }

  function statusLine(R) {
    var st = R.sync || {}, sel = R.sel || {}, out = '';
    if (S.syncMsg) out += '<div class="cb-flag warn" id="cbSyncMsg"><span>⚠</span><div>' + esc(S.syncMsg) + '</div></div>';
    var errs = (st.biz || []).filter(function (b) { return b.err; });
    var back = (st.biz || []).filter(function (b) { return b.done < b.months; });
    if (!(st.configured || []).length)
      return '<div class="cb-flag warn"><span>⚠</span><div><b>ยังไม่ได้ตั้งค่าเชื่อมต่อ PEAK บนเครื่องนี้</b> — หน้านี้แสดงเฉพาะข้อมูลที่เคยดึงไว้</div></div>';
    if (errs.length) out += '<div class="cb-flag warn"><span>⚠</span><div><b>ดึงข้อมูลจาก PEAK ไม่สำเร็จ</b> — ' +
      errs.map(function (b) { return esc(b.biz) + ': ' + esc(b.err); }).join(' · ') + '<br>ตัวเลขด้านล่างคือข้อมูลล่าสุดที่ดึงได้ ระบบจะลองใหม่เองทุก 5 นาที</div></div>';
    if (back.length && !errs.length) out += '<div class="cb-flag"><span>⏳</span><div><b>กำลังดึงข้อมูลย้อนหลังจาก PEAK</b> — ' +
      back.map(function (b) { return esc(b.biz) + ' ' + b.done + '/' + b.months + ' เดือน'; }).join(' · ') +
      (st.auto ? ' · หน้านี้อัปเดตเองทุก 15 วินาที' : ' · กด "⟳ ดึงจาก PEAK" เพื่อดึงต่อ') + '</div></div>';
    if (sel.missing && sel.missing.length && R.months.some(function (m) { return m.has; }))
      out += '<div class="cb-flag warn"><span>⚠</span><div><b>' + esc(sel.label) + ' ยังไม่มีข้อมูลของ ' + esc(sel.missing.join(' · ')) + '</b> — ตัวเลขเดือนนี้จึงยังไม่ครบทุกบริษัท</div></div>';
    else if (sel.issues && sel.issues.length)
      out += '<div class="cb-flag warn"><span>⚠</span><div><b>' + esc(sel.label) + ' ยังตรวจกับงบทดลองของ PEAK ไม่ผ่านทุกข้อ</b><br>' + sel.issues.map(esc).join('<br>') + '</div></div>';
    else if (sel.ok)
      out += '<div class="cb-flag"><span>✔</span><div><b>ตรวจกับงบทดลองของ PEAK แล้ว ตรงทุกบัญชี</b> (ยอดยกมา + เข้า − ออก = ยอดคงเหลือ) · คิดล่าสุด ' + esc(when(sel.builtAt)) +
        (sel.cur ? ' · เดือนนี้ยังไม่จบ ตัวเลขขยับตามที่บัญชีลงใน PEAK' : '') + '</div></div>';
    return out;
  }

  function cmp(cur, pv, key) {
    if (!pv || !pv.has || !pv[key]) return '';
    var p = (cur[key] - pv[key]) / Math.abs(pv[key]) * 100;
    if (!isFinite(p)) return '';
    var a = Math.abs(p) >= 1000 ? '' : (p > 0 ? '▲ ' : (p < 0 ? '▼ ' : '')) + Math.abs(Math.round(p)) + '% ';
    return a ? a + 'จาก ' + esc(pv.label) : '';
  }

  function tiles(R) {
    var s = R.sel, M = R.months, i = M.findIndex(function (m) { return m.ym === s.ym; }), pv = i > 0 ? M[i - 1] : null;
    var cur = M[i] || s;
    var ic = s.ic && (s.ic.in || s.ic.out)
      ? 'ไม่นับเงินที่ 2 บริษัทจ่ายกันเอง (เข้า ' + baht(s.ic.in) + ' · ออก ' + baht(s.ic.out) + ')' : '';
    return '<div class="cb-tiles">' +
      '<div class="cb-tile"><div class="l"><i class="cb-dot in"></i>เงินเข้า · ' + esc(s.label) + '</div><div class="v" id="cbIn">' + baht(s.in) + '</div>' +
        '<div class="s">' + n0(s.n.in) + ' รายการ' + (cmp(cur, pv, 'in') ? ' · ' + cmp(cur, pv, 'in') : '') + '</div></div>' +
      '<div class="cb-tile"><div class="l"><i class="cb-dot out"></i>เงินออก · ' + esc(s.label) + '</div><div class="v" id="cbOut">' + baht(s.out) + '</div>' +
        '<div class="s">' + n0(s.n.out) + ' รายการ' + (cmp(cur, pv, 'out') ? ' · ' + cmp(cur, pv, 'out') : '') + '</div></div>' +
      '<div class="cb-tile"><div class="l">สุทธิ (เข้า − ออก)</div><div class="v" id="cbNet">' + signed(s.net) + '</div>' +
        '<div class="s">' + (s.net >= 0 ? 'เงินเข้ามากกว่าออก' : 'เงินออกมากกว่าเข้า') + (ic ? '<br>' + ic : '') + '</div></div>' +
      '<div class="cb-tile"><div class="l">เงินคงเหลือทุกบัญชี</div><div class="v" id="cbEnd">' + baht(s.end) + '</div>' +
        '<div class="s">' + (s.cur ? 'ณ ตอนนี้ ตามที่ลงบัญชีใน PEAK' : 'ณ สิ้นเดือน ' + esc(s.label)) + ' · ยกมาต้นเดือน ' + baht(s.beg) + '</div></div>' +
      '</div>';
  }

  function acctRows(R) {
    var s = R.sel, A = s.accounts || [], h = '', lastBiz = null, multi = !S.biz && (R.bizList || []).length > 1;
    var T = { beg: 0, in: 0, out: 0, end: 0 };
    A.forEach(function (a, ai) {
      if (multi && a.biz !== lastBiz) { h += '<tr class="grp"><td colspan="5">' + esc(a.biz) + '</td></tr>'; lastBiz = a.biz; }
      T.beg += a.beg; T.in += a.in; T.out += a.out; T.end += a.end;
      var subs = a.subs || [];
      var warn = a.ok ? '' : ' <span class="cb-pill" title="รายการเดินบัญชีที่ดึงได้ยังไม่ตรงกับงบทดลอง">⚠ ยังไม่ตรง</span>';
      var act = function (sub) { return ' class="cb-row" tabindex="0" role="button" onclick="CB.acct(' + ai + ',\'' + esc(sub) + '\')" onkeydown="if(event.key===\'Enter\')CB.acct(' + ai + ',\'' + esc(sub) + '\')"'; };
      var cells = function (x, b, e) {
        return '<td>' + (b == null ? '<span class="cb-mut" title="PEAK ยังไม่แยกยอดคงเหลือรายบัญชีย่อยให้">—</span>' : n0(b)) + '</td>' +
               '<td>' + (x.in ? n0(x.in) : '<span class="cb-mut">–</span>') + '</td><td>' + (x.out ? n0(x.out) : '<span class="cb-mut">–</span>') + '</td>' +
               '<td><b>' + (e == null ? '<span class="cb-mut">—</span>' : n0(e)) + '</b></td>';
      };
      if (subs.length === 1 && a.subBal !== 'none') {
        var s1 = subs[0];
        h += '<tr' + act(s1.code) + '><td class="nm">' + esc(s1.name || a.name) + warn + '<small>' + esc(a.name) + ' · ' + esc(a.code) + ' · ' + esc(s1.code) + '</small></td>' + cells(a, a.beg, a.end) + '</tr>';
      } else {
        h += '<tr' + act('') + '><td class="nm">' + esc(a.name) + warn + '<small>' + esc(a.code) + (subs.length ? ' · ' + subs.length + ' บัญชีย่อย' : '') + '</small></td>' + cells(a, a.beg, a.end) + '</tr>';
        subs.forEach(function (x) {
          h += '<tr' + act(x.code) + '><td class="nm sub">' + esc(x.name || x.code) + '<small>' + esc(x.code) + '</small></td>' + cells(x, x.beg, x.end) + '</tr>';
        });
      }
    });
    if (!A.length) return '<tr><td colspan="5" class="cb-empty">ยังไม่มีข้อมูลบัญชีของเดือนนี้</td></tr>';
    h += '<tr class="sum"><td>รวมทุกบัญชี</td><td>' + n0(T.beg) + '</td><td>' + n0(T.in) + '</td><td>' + n0(T.out) + '</td><td>' + n0(T.end) + '</td></tr>';
    return h;
  }

  function acctCard(R) {
    var s = R.sel;
    var x = s.xfer > 0
      ? '<div class="cb-note" style="padding:8px 16px 12px">ช่อง "เข้า / ออก" ของแต่ละบัญชีคือยอดเดินบัญชีจริง จึงรวม<b>เงินที่โอนระหว่างบัญชีของบริษัทเอง ' + baht(s.xfer) +
        '</b> ไว้ด้วย — ยอดนี้ไม่ถูกนับเป็นเงินเข้า/เงินออกของบริษัทด้านบน · <a href="javascript:void 0" onclick="CB.xfer()">ดูรายการโอน</a></div>' : '';
    return '<div class="cb-card"><h3>ยอดเงินในบัญชี <small>' + esc(s.label) + ' · กดที่บัญชีเพื่อดูรายการเดินบัญชี</small></h3>' +
      '<div class="cb-scroll"><table class="cb-t" id="cbAcct"><thead><tr><th>บัญชี</th><th>ยกมา</th><th>เข้า</th><th>ออก</th><th>คงเหลือ</th></tr></thead><tbody>' +
      acctRows(R) + '</tbody></table></div>' + x + '</div>';
  }

  function paintAr() {
    var el = $('cbAr'); if (!el) return;
    var A = S.ar;
    if (!A) { el.innerHTML = '<div class="cb-empty">กำลังคิดยอดลูกหนี้…</div>'; return; }
    if (!A.ok) { el.innerHTML = '<div class="cb-empty">อ่านข้อมูลลูกหนี้ไม่ได้' + (A.error ? ' — ' + esc(A.error) : '') + '</div>'; return; }
    var fc = (A.forecast || []).filter(function (f) { return f.amt > 0; });
    el.innerHTML = '<div class="cb-ar"><div class="cb-note">ลูกหนี้คงค้างทั้งหมด</div><div class="big" id="cbArTot">' + baht(A.total) + '</div>' +
      '<div class="cb-note">' + n0(A.n) + ' ใบ</div>' +
      '<div class="cb-kv" style="margin-top:8px"><span>เลยกำหนดแล้ว</span><b>' + baht(A.overdue) + ' <span class="cb-mut" style="font-weight:500">· ' + n0(A.overdueN) + ' ใบ</span></b></div>' +
      '<div class="cb-kv"><span>คาดว่าจะเข้าใน 30 วัน</span><b>' + baht(A.fc30) + '</b></div>' +
      fc.map(function (f) { return '<div class="cb-kv"><span>· ครบกำหนด' + esc(f.t) + '</span><b style="font-weight:600">' + baht(f.amt) + ' <span class="cb-mut" style="font-weight:500">· ' + n0(f.n) + ' ใบ</span></b></div>'; }).join('') +
      '<div style="margin-top:10px"><button class="cb-btn" onclick="CB.aging()">ดูลูกหนี้รายใบ →</button></div>' +
      '<div class="cb-note" style="margin-top:8px">ยอดลูกหนี้ยึดสถานะรับชำระของ PEAK รายใบ (ตัวคิดเดียวกับหน้าลูกหนี้ค้างชำระ)</div></div>';
  }

  function monthsCard(R) {
    var M = (R.months || []).slice().reverse();
    var mx = Math.max.apply(null, M.map(function (m) { return Math.max(m.in, m.out); }).concat([1]));
    var h = '<div class="cb-card"><h3>รายเดือน <small>กดที่เดือนเพื่อดูรายละเอียดของเดือนนั้น</small>' +
      '<span class="cb-leg"><span><i class="cb-dot in"></i>เงินเข้า</span><span><i class="cb-dot out"></i>เงินออก</span></span></h3>' +
      '<div class="cb-scroll"><table class="cb-t" id="cbMonths"><thead><tr><th>เดือน</th><th style="text-align:left">เข้า / ออก</th><th>เงินเข้า</th><th>เงินออก</th><th>สุทธิ</th><th>คงเหลือสิ้นเดือน</th></tr></thead><tbody>';
    /* เดือนเก่าที่ยังไม่มีข้อมูล (ก่อนเดือนแรกที่ดึงได้) รวมเป็นบรรทัดเดียวท้ายตาราง — ไม่ให้ตารางรก */
    var firstHas = -1; (R.months || []).forEach(function (m, i) { if (firstHas < 0 && m.has) firstHas = i; });
    var older = firstHas > 0 ? (R.months || []).slice(0, firstHas) : [];
    M.forEach(function (m) {
      if (older.indexOf(m) >= 0) return;
      if (!m.has) { h += '<tr><td>' + esc(m.label) + '</td><td colspan="5" style="text-align:left" class="cb-mut">ยังไม่มีข้อมูลจาก PEAK</td></tr>'; return; }
      var tag = m.cur ? '<span class="cb-pill">เดือนนี้ ยังไม่จบ</span>' : (m.has < m.need ? '<span class="cb-pill" title="ยังไม่มีข้อมูลของ ' + esc((m.missing || []).join(' · ')) + '">⚠ ไม่ครบทุกบริษัท</span>' : (m.ok ? '' : '<span class="cb-pill" title="ยังตรวจกับงบทดลองไม่ผ่าน">⚠ ยังไม่ตรง</span>'));
      h += '<tr class="cb-row' + (m.ym === S.ym ? ' sel' : '') + '" tabindex="0" role="button" onclick="CB.month(\'' + m.ym + '\')" onkeydown="if(event.key===\'Enter\')CB.month(\'' + m.ym + '\')">' +
        '<td style="font-weight:700">' + esc(m.label) + tag + '</td>' +
        '<td style="text-align:left"><div class="cb-bars" title="' + esc(m.label) + ' — เงินเข้า ' + baht(m.in) + ' · เงินออก ' + baht(m.out) + '">' +
          '<div class="cb-bar in" style="width:' + Math.max(0.5, m.in / mx * 100).toFixed(1) + '%"></div>' +
          '<div class="cb-bar out" style="width:' + Math.max(0.5, m.out / mx * 100).toFixed(1) + '%"></div></div></td>' +
        '<td>' + n0(m.in) + '</td><td>' + n0(m.out) + '</td><td><b>' + (m.net > 0 ? '+' : (m.net < 0 ? '−' : '')) + n0(Math.abs(m.net)) + '</b></td><td>' + n0(m.end) + '</td></tr>';
    });
    if (older.length) h += '<tr id="cbOlder"><td colspan="6" style="text-align:left" class="cb-mut">' + esc(older[0].label) + (older.length > 1 ? ' – ' + esc(older[older.length - 1].label) : '') +
      ' (' + older.length + ' เดือน): ยังไม่มีข้อมูลจาก PEAK' + ((R.sync && R.sync.from) && older[older.length - 1].ym < R.sync.from ? ' — ระบบดึงย้อนหลังถึง ' + esc(R.sync.from) : '') + '</td></tr>';
    return h + '</tbody></table></div></div>';
  }

  function catCard(R, side) {
    var s = R.sel, L = side === 'in' ? s.inCats : s.outCats, tot = side === 'in' ? s.in : s.out;
    var h = '<div class="cb-card" id="cbCat-' + side + '"><h3><i class="cb-dot ' + side + '"></i>' + (side === 'in' ? 'เงินเข้า' : 'เงินออก') + ' ' + esc(s.label) + ' <small>' + baht(tot) + ' · กดที่หมวดเพื่อดูเอกสาร</small></h3>';
    if (!L.length) h += '<div class="cb-empty">ไม่มีรายการ' + (side === 'in' ? 'เงินเข้า' : 'เงินออก') + 'ในเดือนนี้</div>';
    L.forEach(function (c, i) {
      h += '<button class="cb-cat" onclick="CB.cat(\'' + side + '\',' + i + ')"><span class="nm">' + esc(c.name) + '</span><span class="am">' + baht(c.amt) + '</span>' +
        '<span class="ln"><span class="tr"><i style="width:' + Math.max(1, c.pct) + '%;background:var(--cb-' + side + ')"></i></span><span>' + c.pct + '% · ' + n0(c.n) + ' เอกสาร</span></span></button>';
    });
    var ic = s.ic && (side === 'in' ? s.ic.in : s.ic.out);
    if (ic) h += '<button class="cb-cat muted" onclick="CB.ic(\'' + side + '\')"><span class="nm">รายการระหว่าง 2 บริษัท (ไม่นับในยอดรวม)</span><span class="am">' + baht(ic) + '</span>' +
      '<span class="ln"><span>' + n0(side === 'in' ? s.ic.nIn : s.ic.nOut) + ' เอกสาร · ดูแยกรายบริษัทได้ที่แท็บด้านบน</span></span></button>';
    return h + '</div>';
  }

  function render() {
    var R = S.data; if (!R) return;
    tabs();
    if (R.needSql) {
      $('cbBody').innerHTML = '<div class="cb-flag warn"><span>⚠</span><div><b>ยังไม่ได้สร้างตารางของ Cash Flow ใหม่ในฐานข้อมูล</b><br>รันไฟล์ <b>' + esc(R.sqlFile) + '</b> ใน Supabase 1 ครั้ง แล้วกลับมาเปิดหน้านี้ใหม่</div></div>';
      return;
    }
    var has = (R.months || []).some(function (m) { return m.has; });
    if (!has) {
      $('cbBody').innerHTML = statusLine(R) + '<div class="cb-card"><div class="cb-empty">ยังไม่มีข้อมูลจาก PEAK ในระบบ<br>' +
        ((R.sync && R.sync.auto) ? 'ระบบกำลังดึงให้เองเบื้องหลัง — หน้านี้จะอัปเดตเองเมื่อเดือนแรกเสร็จ' : 'กดปุ่ม "⟳ ดึงจาก PEAK" ด้านบนเพื่อเริ่มดึง') + '</div></div>';
      return;
    }
    $('cbBody').innerHTML = statusLine(R) + tiles(R) +
      '<div class="cb-two">' + acctCard(R) + '<div class="cb-card"><h3>ลูกหนี้ / เงินที่คาดว่าจะเข้า</h3><div id="cbAr"></div></div></div>' +
      monthsCard(R) +
      '<div class="cb-cats">' + catCard(R, 'in') + catCard(R, 'out') + '</div>';
    paintAr();
  }

  /* ── เอกสาร (ลิ้นชักด้านขวา) ───────────────────────────────────── */
  function closeDrawer() { var d = $('cbDr'); if (d) d.remove(); S.drawer = null; }
  function openDrawer(title, sub, qs, mode) {
    closeDrawer();
    var d = document.createElement('div'); d.className = 'cb-dr'; d.id = 'cbDr';
    d.innerHTML = '<div class="pane" role="dialog" aria-label="' + esc(title) + '"><div class="hd"><div><h4>' + esc(title) + '</h4><p id="cbDrSub">' + esc(sub) + '</p></div>' +
      '<button class="x" onclick="CB.closeDrawer()" aria-label="ปิด">✕</button></div>' +
      '<div class="tl"><input id="cbDrFind" placeholder="ค้นหา ชื่อคู่ค้า / เลขเอกสาร / จำนวนเงิน" oninput="CB.find(this.value)"><span class="cb-note" id="cbDrCnt"></span></div>' +
      '<div class="bd" id="cbDrBody"><div class="cb-empty">กำลังโหลด…</div></div></div>';
    d.addEventListener('click', function (e) { if (e.target === d) closeDrawer(); });
    $('cbOv').appendChild(d);
    S.drawer = { mode: mode, rows: [], title: title }; S.find = '';
    getJ('/api/cashbook/docs?' + qs).then(function (R) {
      if (!S.drawer) return;
      if (!R || R.ok === false) throw new Error((R && (R.error || R.msg)) || 'โหลดไม่สำเร็จ');
      S.drawer.R = R; S.drawer.rows = R.rows || [];
      paintDocs();
    }).catch(function (e) { if ($('cbDrBody')) $('cbDrBody').innerHTML = '<div class="cb-empty">' + esc(e && e.message || e) + '</div>'; });
  }
  function paintDocs() {
    var D = S.drawer; if (!D || !D.R) return;
    var R = D.R, acct = D.mode === 'acct', multi = !S.biz && D.mode !== 'acct';
    var f = S.find.trim().toLowerCase();
    var rows = !f ? D.rows : D.rows.filter(function (r) {
      return (r.cp + ' ' + r.j + ' ' + r.ref + ' ' + r.cat + ' ' + r.acct + ' ' + n2(r.amt) + ' ' + Math.abs(r.amt)).toLowerCase().indexOf(f) >= 0;
    });
    var h = '<table class="cb-t"><thead><tr><th>วันที่</th><th style="text-align:left">คู่ค้า / รายละเอียด</th><th style="text-align:left">' + (acct ? 'หมวด' : 'บัญชีที่เงินเดิน') + '</th>' +
      (acct ? '<th>เข้า</th><th>ออก</th>' : '<th>จำนวนเงิน</th>') + '</tr></thead><tbody>';
    var tin = 0, tout = 0, tot = 0;
    rows.forEach(function (r) {
      tin += r.in || 0; tout += r.out || 0; tot += r.amt || 0;
      var tags = (r.ic ? '<span class="cb-pill">ระหว่าง 2 บริษัท</span>' : '') + (r.via === 'ap' ? '<span class="cb-pill" title="จ่ายบิลที่ตั้งเจ้าหนี้ไว้ก่อน — หมวดมาจากบิลต้นทาง">จ่ายบิลค้าง</span>' : '') +
                 (r.q ? '<span class="cb-pill" title="ยังดึงบัญชีคู่ของเอกสารนี้ไม่ครบ">⚠ หมวดยังไม่ครบ</span>' : '');
      h += '<tr><td style="text-align:left">' + esc(dmy(r.d)) + '</td>' +
        '<td class="nm" style="text-align:left">' + (esc(r.cp) || '<span class="cb-mut">(ไม่มีชื่อคู่ค้า)</span>') + tags +
          '<small>' + esc(r.j) + (r.ref ? ' · #' + esc(r.ref) : '') + (multi ? ' · ' + esc(r.biz) : '') + (!acct && r.cat ? ' · ' + esc(r.cat) : '') + '</small></td>' +
        '<td class="nm" style="text-align:left;min-width:150px">' + esc(acct ? r.cat : r.acct) + '</td>' +
        (acct ? '<td>' + (r.in ? n2(r.in) : '') + '</td><td>' + (r.out ? n2(r.out) : '') + '</td>' : '<td><b>' + n2(r.amt) + '</b></td>') + '</tr>';
    });
    if (!rows.length) h += '<tr><td colspan="5" class="cb-empty">ไม่พบรายการ</td></tr>';
    else h += '<tr class="sum"><td colspan="3" style="text-align:left">รวม ' + n0(rows.length) + ' รายการ' + (f ? ' (ที่ค้นเจอ)' : '') + '</td>' +
      (acct ? '<td>' + n2(tin) + '</td><td>' + n2(tout) + '</td>' : '<td>' + n2(tot) + '</td>') + '</tr>';
    $('cbDrBody').innerHTML = h + '</tbody></table>' + (R.more ? '<div class="cb-empty">แสดง ' + n0(R.rows.length) + ' รายการแรก จากทั้งหมด ' + n0(R.n) + '</div>' : '');
    $('cbDrCnt').textContent = n0(rows.length) + ' รายการ';
  }
  function baseQs() { return 'biz=' + encodeURIComponent(S.biz) + '&ym=' + encodeURIComponent(S.ym); }

  /* ── คำสั่งจากหน้าจอ ───────────────────────────────────────────── */
  window.CB = {
    open: function () { ensureDom(); $('cbOv').classList.remove('hidden'); if (S.data) { render(); watch(); load(true); } else load(); },
    close: function () { closeDrawer(); if (S.poll) { clearTimeout(S.poll); S.poll = null; } $('cbOv').classList.add('hidden'); },
    biz: function (b) { if (S.biz === b) return; S.biz = b; load(true); },
    bizAt: function (i) { var L = (S.data && S.data.bizList) || []; if (L[i] !== undefined) window.CB.biz(L[i]); },
    month: function (ym) { if (S.ym === ym) return; S.ym = ym; load(true).then(function () { var el = document.querySelector('.cb-tiles'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); }); },
    step: function (k) { var M = (S.data && S.data.months) || [], i = M.findIndex(function (m) { return m.ym === S.ym; }); if (M[i + k]) window.CB.month(M[i + k].ym); },
    cat: function (side, i) {
      var s = S.data.sel, c = (side === 'in' ? s.inCats : s.outCats)[i]; if (!c) return;
      openDrawer((side === 'in' ? 'เงินเข้า' : 'เงินออก') + ' — ' + c.name, s.label + ' · ' + (S.biz || 'รวมทุกบริษัท') + ' · ' + baht(c.amt) + ' · ' + n0(c.n) + ' เอกสาร',
        baseQs() + '&side=' + side + '&cat=' + encodeURIComponent(c.k), 'cat');
    },
    ic: function (side) { var s = S.data.sel; openDrawer('รายการระหว่าง 2 บริษัท — ' + (side === 'in' ? 'เงินเข้า' : 'เงินออก'), s.label + ' · ไม่นับในยอดรวมทุกบริษัท', baseQs() + '&side=' + side + '&cat=ic', 'cat'); },
    xfer: function () { var s = S.data.sel; openDrawer('โอนระหว่างบัญชีของบริษัทเอง', s.label + ' · ไม่นับเป็นเงินเข้า/เงินออก', baseQs() + '&side=x', 'cat'); },
    acct: function (ai, sub) {
      var s = S.data.sel, a = s.accounts[ai]; if (!a) return;
      var sn = sub ? ((a.subs || []).filter(function (x) { return x.code === sub; })[0] || {}).name : '';
      openDrawer('รายการเดินบัญชี — ' + (sn || a.name), s.label + ' · ' + a.biz + ' · ' + a.code + (sub ? ' · ' + sub : ''),
        baseQs() + '&acct=' + encodeURIComponent(a.code) + '&sub=' + encodeURIComponent(sub || '') + '&abiz=' + encodeURIComponent(a.biz), 'acct');
    },
    find: function (v) { S.find = String(v || ''); paintDocs(); },
    closeDrawer: closeDrawer,
    aging: function () { if (typeof window.openAging === 'function') { window.CB.close(); window.openAging(); } },
    tools: function () { if (typeof window.openCashFlow === 'function') { window.CB.close(); window.openCashFlow(); } },
    sync: function () {
      var b = $('cbSync'); if (!b || b.disabled) return;
      b.disabled = true; b.textContent = 'กำลังดึง…';
      var done = function (msg) { b.disabled = false; b.textContent = '⟳ ดึงจาก PEAK'; S.syncMsg = msg || ''; load(true); };
      postJ('/api/cashbook/sync', { biz: S.biz, ym: S.ym, force: true, wait: 1 }).then(function (R) {
        if (R && R.busy) done('ระบบกำลังดึงข้อมูลจาก PEAK อยู่แล้ว — รอสักครู่ หน้านี้จะอัปเดตเอง');
        else if (!R || R.ok === false) done('ดึงจาก PEAK ไม่สำเร็จ — ' + ((R && (R.error || R.msg)) || 'ไม่ทราบสาเหตุ'));
        else if (R.errors && R.errors.length) done('ดึงจาก PEAK ไม่ครบ — ' + R.errors.map(function (e) { return e.biz + ': ' + e.err; }).join(' · '));
        else done('');
      }).catch(function (e) { done('ดึงจาก PEAK ไม่สำเร็จ — ' + (e && e.message || e)); });
    },
    _state: S,
  };
})();
