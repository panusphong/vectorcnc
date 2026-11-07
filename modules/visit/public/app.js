/* ═══════════════════════════════════════════════════════════════════
 *  B2B Visit — หน้าเว็บ (v1.0.0 · 20 ต.ค. 69 · v1.1.0 21 ต.ค. 69 การเดินทาง/ใบเบิกค่าเดินทาง/ส่งออก JPG-PDF/หน้าตาใหม่)
 *  หน้า: ภาพรวม · ค้นหาลูกค้า · ลูกค้าของฉัน (รายการ/กระดาน) · ปฏิทิน · รายงาน · เบิกค่าเดินทาง
 *  แฟ้มลูกค้า = ลิ้นชักขวา (มือถือเต็มจอ) · ฟอร์ม = หน้าต่างกลางจอ
 *  ‼ วาดใหม่เฉพาะส่วนที่เปลี่ยน · ไม่วาดทับระหว่างพิมพ์ · ไม่เก็บอะไรลงเครื่องผู้ใช้
 * ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var API = './api';
  var app = document.getElementById('app');
  var B = null;                 /* ข้อมูลตั้งต้น (/api/boot) */
  var L = null;                 /* รายการลูกค้า (/api/list) */
  var ui = { view: 'home', stage: '', owner: '', q: '', mode: 'list', seg: '', area: '', extra: '', count: 10, searching: false, result: null, history: null,
    cal: null, calMonth: monthStart(new Date()), dr: null, drTab: 'info', modal: null, report: null, reports: null, rpFrom: '', rpTo: '', rpOwner: '', rpBusy: false };

  /* ── ตัวช่วย ── */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function req(path, body) {
    return fetch(API + path, body === undefined ? { credentials: 'same-origin', headers: { accept: 'application/json' } }
      : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        if (r.status === 401 || (r.redirected && /\/login/.test(r.url))) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('หมดเวลาเข้าสู่ระบบ'); }
        return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || j.ok === false) throw new Error(j.error || 'ทำรายการไม่สำเร็จ (' + r.status + ')'); return j; });
      });
  }
  var toastT = 0;
  function toast(m, bad) {
    var el = document.querySelector('.toast'); if (!el) { el = document.createElement('div'); el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.className = 'toast' + (bad ? ' bad' : ''); el.textContent = m; clearTimeout(toastT); toastT = setTimeout(function () { el.remove(); }, bad ? 6000 : 2600);
  }
  function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  var TH_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  var TH_MF = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  var TH_D = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  function dt(t, withTime) { if (!t) return '-'; var d = new Date(t); return d.getDate() + ' ' + TH_M[d.getMonth()] + ' ' + String(d.getFullYear() + 543).slice(2) + (withTime ? ' · ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) : ''); }
  function hm(t) { var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function localInput(t) { var d = new Date(t); return ymd(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function baht(n) { n = Number(n) || 0; return n >= 1e6 ? (Math.round(n / 1e4) / 100).toLocaleString('th-TH') + ' ล้าน' : Math.round(n).toLocaleString('th-TH'); }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function stageL(k) { var s = (B.stages || []).filter(function (x) { return x.key === k; })[0]; return s ? s.label : k; }
  function segOf(k) { return (B.segments || []).filter(function (x) { return x.key === k; })[0] || null; }
  function chOf(k) { return (B.channels || []).filter(function (x) { return x.key === k; })[0] || { icon: '📌', label: k }; }
  /* 💬 v1.5.0 ผลการติดตาม (แชท / โทร) */
  function ocOf(k) { return (B.outcomes || []).filter(function (x) { return x.key === k; })[0] || { key: k, icon: '•', label: k || '-', tone: '' }; }
  function who(un) { var u = (B.team || []).filter(function (x) { return x.username.toLowerCase() === String(un || '').toLowerCase(); })[0]; return u ? u.name : (un || '-'); }
  var FIT = { go: ['go', 'ควรไป visit'], wait: ['wait', 'รอก่อน'], skip: ['skip', 'ข้ามไปก่อน'] };
  function fitPill(f) { var x = FIT[f]; return x ? '<span class="pill ' + x[0] + '">' + x[1] + '</span>' : ''; }
  function scoreRing(v, f) { return '<span class="score ' + esc(f || '') + '" style="--v:' + (Number(v) || 0) + '" title="คะแนนความน่าไป visit">' + (Number(v) || 0) + '</span>'; }
  function telLink(p) { var d = String(p || '').split(/[,/]/)[0].replace(/[^\d+]/g, ''); return d ? '<a href="tel:' + esc(d) + '">' + esc(p) + '</a>' : esc(p || '-'); }
  function gcal(e, name, address) {
    var s = new Date(e.at), f = new Date(e.at + ((e.doc && e.doc.minutes) || 60) * 60000);
    var z = function (d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(e.title || ('visit ' + name)) + '&dates=' + z(s) + '/' + z(f) +
      '&details=' + encodeURIComponent((e.body || '') + (e.doc && e.doc.goal ? '\nเป้าหมาย: ' + e.doc.goal : '') + '\n— Leads & Customer Visit · มดงานการป้าย') + '&location=' + encodeURIComponent((e.doc && e.doc.place) || address || '');
  }
  function list(arr, cls) { arr = (arr || []).filter(Boolean); return arr.length ? '<ul' + (cls ? ' class="' + cls + '"' : '') + '>' + arr.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : ''; }
  function editing() { var a = document.activeElement; return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox'); }

  /* ── โหลด ── */
  function loadList() {
    return req('/list' + (B.me.sup && ui.owner ? '?owner=' + encodeURIComponent(ui.owner) : '')).then(function (j) { L = j; render(); }).catch(function (e) { toast(e.message, true); });
  }

  /* ═══════════ วาดหน้า ═══════════ */
  /* ✨ v1.1.0 — พี่เอ: "app b2b visit หน้าตาดูเชยมากนะ ทำให้มันดู สวยงาม ทันสมัย ดู pro กว่านี้นะ" ⇒ ไอคอนเส้น (SVG) แทนอิโมจิในเมนู */
  var ICO = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h5v-6h4v6h5V9.5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    list: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18M8 13h8M8 16.5h5"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/><circle cx="12" cy="15" r="1.4"/>',
    report: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    trip: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/>'
  };
  function ico(k) { return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICO[k] || '') + '</svg>'; }
  var NAV = [['home', 'home', 'ภาพรวม'], ['search', 'search', 'ค้นหาลูกค้า'], ['list', 'list', 'ลูกค้า'], ['cal', 'cal', 'ปฏิทิน'], ['report', 'report', 'รายงาน'], ['trip', 'trip', 'เบิกค่าเดินทาง']];
  function navItems() { return B.claims && B.claims.accOnly ? NAV.filter(function (n) { return n[0] === 'trip'; }) : NAV; }
  function render() {
    if (!B) return;
    if (editing() && app.contains(document.activeElement)) { ui.dirty = true; return; }
    ui.dirty = false;
    var late = L ? L.kpi.overdue : 0;
    var NV = navItems();
    var nav = NV.map(function (n) { return '<button data-go="' + n[0] + '"' + (ui.view === n[0] ? ' aria-current="page"' : '') + '><span class="ic">' + ico(n[1]) + '</span><span class="lb">' + n[2] + '</span>' + (n[0] === 'home' && late ? '<span class="cnt">' + late + '</span>' : '') + '</button>'; }).join('');
    var body = !B.health.ok ? setupView() : ui.view === 'trip' ? tripView() : ui.view === 'search' ? searchView() : ui.view === 'list' ? listView() : ui.view === 'cal' ? calView() : ui.view === 'report' ? reportView() : homeView();
    app.innerHTML = '<div class="shell"><nav class="rail" aria-label="เมนู"><div class="rail-h">เมนู</div>' + nav + '<div class="rail-foot"><span class="dot' + (B.ai.ready ? ' on' : '') + '"></span>อลิซ: ' + (B.ai.ready ? esc(B.ai.engine) : 'ยังไม่ได้ตั้งกุญแจ AI') + '</div></nav><main class="v-' + esc(ui.view) + '">' + body + '</main></div>' +
      '<nav class="tabbar n' + NV.length + '" aria-label="เมนู">' + nav + '</nav>';
  }
  function setupView() {
    return '<div class="page-h"><div><h1>ต้องตั้งค่าฐานข้อมูลก่อน</h1><p>แอปนี้ยังไม่มีตารางในฐานข้อมูล</p></div></div><div class="banner">' +
      (B.health.missing ? 'รันไฟล์ <code>' + esc(B.health.sqlFile) + '</code> ใน Supabase › SQL Editor แล้วโหลดหน้านี้ใหม่' : 'ฐานข้อมูลไม่พร้อม: ' + esc(B.health.error)) + '</div>';
  }
  function ownerSelect(val, id, all) {
    if (!B.me.sup) return '';
    return '<select class="in" id="' + id + '" data-bind="' + id + '" aria-label="เซลส์" style="max-width:220px">' + (all ? '<option value="">ทุกเซลส์</option>' : '') +
      (B.team || []).map(function (u) { return '<option value="' + esc(u.username) + '"' + (u.username === val ? ' selected' : '') + '>' + esc(u.name) + '</option>'; }).join('') + '</select>';
  }

  /* ── ภาพรวม ── */
  function homeView() {
    if (!L) return '<div class="boot">กำลังโหลด…</div>';
    var k = L.kpi, now = Date.now();
    /* 🧭 v1.0.1 — พี่เอถาม "เพิ่มรูป visit หน้างานตรงไหน สร้างแผนการ visit ของเซลล์ แต่ละงานยังงัย" ⇒ ปุ่มใหญ่ 3 ปุ่มบนสุดของหน้าแรก */
    var h = '<section class="hero"><div class="hero-t"><h1>สวัสดีค่ะ ' + esc(B.me.name) + '</h1><p>' + dt(now) + ' · วันนี้มีนัด visit ' + L.agenda.filter(function (e) { return e.kind === 'plan' && sameDay(new Date(e.at), new Date()); }).length + ' งาน · งานติดตาม 7 วัน ' + L.agenda.length + ' งาน</p></div>' +
      (B.me.sup ? '<div class="hero-own">' + ownerSelect(ui.owner, 'owner', true) + '</div>' : '') +
      '<div class="qa">' + quickActs() + '</div></section>';
    h += '<div class="kpis">' +
      '<div class="card kpi"><div class="k">ลูกค้าที่กำลังลุย</div><div class="v">' + k.open + '</div><div class="s">ทั้งหมด ' + k.total + ' ราย</div></div>' +
      '<div class="card kpi' + (k.overdue ? ' alert' : '') + '"><div class="k">งานเลยกำหนด</div><div class="v">' + k.overdue + '</div><div class="s">ภายใน 7 วัน ' + L.agenda.length + ' งาน</div></div>' +
      '<div class="card kpi"><div class="k">มูลค่าในมือ</div><div class="v">฿' + baht(k.pipeline) + '</div><div class="s">ถ่วงโอกาส ฿' + baht(k.weighted) + '</div></div>' +
      '<div class="card kpi good"><div class="k">ปิดการขายได้</div><div class="v">' + k.won + '</div><div class="s">อัตราชนะ ' + (k.winRate === null ? '—' : k.winRate + '%') + '</div></div></div>';
    var ag = L.agenda.slice(0, 14);
    h += '<div class="cols"><div class="stack"><section class="card panel"><h2>📌 งานที่ต้องทำ<span class="sp"></span><button class="btn sm ghost" data-go="cal">ดูปฏิทิน</button></h2>' +
      (ag.length ? '<div class="ag">' + ag.map(agItem).join('') + '</div>' : '<p class="empty">ไม่มีนัดหรืองานติดตามใน 7 วันนี้ — กด "📅 วางแผน visit" ด้านบน</p>') + '</section>';
    var idle = L.items.filter(function (p) { return p.idle; }).slice(0, 6);
    if (idle.length) h += '<section class="card panel"><h2>💤 ลูกค้าที่เงียบไปเกิน 14 วัน</h2><div class="ag">' + idle.map(function (p) {
      return '<div class="ag-it"><div class="ag-when"><b>' + Math.round((now - p.updatedAt) / 864e5) + ' วัน</b>ไม่มีความเคลื่อนไหว</div><div class="ag-main"><div class="t">' + esc(p.name) + '</div><div class="c">' + esc(stageL(p.stage)) + ' · ' + esc(who(p.owner)) + '</div></div><button class="btn sm" data-open="' + esc(p.id) + '">เปิดแฟ้ม</button></div>'; }).join('') + '</div></section>';
    h += '</div><div class="stack"><section class="card panel"><h2>🧭 ขั้นการขาย</h2>' + funnel(L.stageN) + '</section>';
    var hot = L.items.filter(function (p) { return p.stage !== 'won' && p.stage !== 'lost'; }).sort(function (a, b) { return (b.chance * (b.value || 1)) - (a.chance * (a.value || 1)) || b.score - a.score; }).slice(0, 5);
    h += '<section class="card panel"><h2>🔥 ควรโฟกัส</h2>' + (hot.length ? '<div class="ag">' + hot.map(function (p) {
      return '<div class="ag-it" style="grid-template-columns:46px minmax(0,1fr) auto">' + scoreRing(p.score, p.fit) + '<div class="ag-main"><div class="t">' + esc(p.name) + '</div><div class="c">' + esc(stageL(p.stage)) + ' · โอกาส ' + p.chance + '%' + (p.value ? ' · ฿' + baht(p.value) : '') + '</div></div><button class="btn sm" data-open="' + esc(p.id) + '">เปิด</button></div>'; }).join('') + '</div>'
      : '<p class="empty">ยังไม่มีลูกค้า — เริ่มที่ "ค้นหาลูกค้า"</p>') + '</section></div></div>';
    return h;
  }
  function quickActs() {
    return '<button class="qa-b plan" data-act="qplan"><span class="qi">📅</span><b>วางแผน visit</b><small>เลือกลูกค้า · วัน-เวลา · เป้าหมาย ⇒ ลงปฏิทิน</small></button>' +
      '<button class="qa-b shot" data-act="qvisit"><span class="qi">📸</span><b>บันทึก visit + รูปหน้างาน</b><small>ถ่าย/แนบรูป · สรุปสั้น ๆ ⇒ อลิซวิเคราะห์ต่อ</small></button>' +
      '<button class="qa-b find" data-go="search"><span class="qi">🔎</span><b>หาลูกค้าใหม่</b><small>เลือกกลุ่มธุรกิจ · พื้นที่ ⇒ อลิซค้นเว็บให้</small></button>' +
      /* 📞 v1.5.1 แถวล่าง = ทีมขาย online (ไม่ต้องออก visit) */
      '<button class="qa-b task" data-act="qtask"><span class="qi">📞</span><b>วางแผนติดตาม (โทร · แชท)</b><small>เลือกลูกค้า · วัน-เวลา · ช่องทาง ⇒ ลงปฏิทิน</small></button>' +
      '<button class="qa-b follow" data-act="qfollow"><span class="qi">💬</span><b>บันทึกการติดตาม</b><small>แชท · โทร · LINE · Facebook ⇒ ผลการคุย + นัดครั้งถัดไป</small></button>' +
      '<button class="qa-b mine" data-act="manual"><span class="qi">📥</span><b>ลูกค้าที่หาไว้เอง</b><small>ใส่ชื่อ (ได้ทีละหลายราย) ⇒ อลิซบอกว่าควรโฟกัสไหม</small></button>';
  }
  function agItem(e) {
    var d = new Date(e.at), today = sameDay(d, new Date()), ch = e.kind === 'plan' ? { icon: '🚗', label: 'visit' } : chOf(e.doc && e.doc.channel);
    return '<div class="ag-it' + (e.overdue ? ' late' : '') + '"><div class="ag-when"><b>' + (e.overdue ? 'เลยกำหนด' : today ? 'วันนี้' : dt(e.at)) + '</b>' + (e.overdue ? dt(e.at) : hm(e.at)) + '</div>' +
      '<div class="ag-main"><div class="t">' + ch.icon + ' ' + esc(e.title) + '</div><div class="c"><button class="lk" data-open="' + esc(e.prospectId) + '">' + esc(e.name) + '</button> · ' + esc(ch.label) + '</div></div>' +
      '<div class="row">' + (e.kind === 'plan' ? '<button class="btn sm primary" data-visit="' + esc(e.prospectId) + '" data-plan="' + esc(e.id) + '">บันทึก visit</button>' : '<button class="btn sm" data-done="' + esc(e.id) + '" title="บันทึกผลการติดตาม">✓ บันทึกผล</button>') + '</div></div>';
  }
  function funnel(n) {
    var max = Math.max.apply(null, (B.stages || []).map(function (s) { return n[s.key] || 0; }).concat([1]));
    return '<div class="funnel">' + B.stages.map(function (s) {
      return '<button class="fn-row ' + s.key + '" data-stagego="' + s.key + '"><span>' + esc(s.label) + '</span><span class="fn-bar"><i style="width:' + Math.round((n[s.key] || 0) / max * 100) + '%"></i></span><b>' + (n[s.key] || 0) + '</b></button>'; }).join('') + '</div>';
  }

  /* ── ค้นหา ── */
  var AREAS = ['กรุงเทพฯ', 'กรุงเทพฯ และปริมณฑล', 'นนทบุรี', 'ปทุมธานี', 'สมุทรปราการ', 'สมุทรสาคร', 'นครปฐม', 'ชลบุรี', 'ระยอง', 'ฉะเชิงเทรา', 'อยุธยา', 'สระบุรี', 'เชียงใหม่', 'ขอนแก่น', 'นครราชสีมา', 'ภูเก็ต', 'สงขลา', 'บางนา-ตราด', 'ถนนพระราม 2', 'นิคมอมตะนคร', 'นิคมบางปู', 'นิคมลาดกระบัง'];
  function searchView() {
    var sg = segOf(ui.seg);
    var h = '<div class="page-h"><div><h1>ค้นหาลูกค้า B2B</h1><p>เลือกกลุ่มธุรกิจและพื้นที่ — อลิซค้นเว็บแล้วสรุปชื่อ เบอร์ ที่อยู่ ธุรกิจ พร้อมบอกว่าควรไป visit ไหม</p></div><div class="acts"><button class="btn ghost" data-hist="1">🕘 ผลค้นหาเดิม</button></div></div>';
    if (!B.ai.ready) h += '<div class="banner">⚠️ ยังไม่ได้ตั้งกุญแจ AI — ให้ผู้ดูแลใส่ <code>GEMINI_API_KEY</code> (มีโควตาฟรี) หรือ <code>ANTHROPIC_API_KEY</code> ใน Railway Variables · ระหว่างนี้กด "+ เพิ่มลูกค้าเอง" ได้</div>';
    h += '<section class="card panel"><h2>1 · กลุ่มธุรกิจ</h2><div class="segs">' + B.segments.map(function (s) {
      return '<button class="seg" data-seg="' + s.key + '" aria-pressed="' + (ui.seg === s.key) + '"><span class="ic">' + s.icon + '</span><span>' + esc(s.label) + '</span></button>'; }).join('') + '</div>' +
      (sg ? '<div class="needs"><b>ป้ายที่กลุ่มนี้มักใช้:</b> ' + esc(sg.needs) + '</div>' : '') +
      '<div class="searchbar"><label class="field">2 · พื้นที่<input id="area" data-bind="area" list="areas" value="' + esc(ui.area) + '" placeholder="เช่น ชลบุรี · นิคมอมตะนคร · บางนา"><datalist id="areas">' + AREAS.map(function (a) { return '<option value="' + esc(a) + '">'; }).join('') + '</datalist></label>' +
      '<label class="field">3 · เงื่อนไขเพิ่ม (ถ้ามี)<input id="extra" data-bind="extra" value="' + esc(ui.extra) + '" placeholder="เช่น เปิดสาขาใหม่ปีนี้ · มีมากกว่า 5 สาขา · โรงงานญี่ปุ่น"></label>' +
      '<label class="field">จำนวน<select id="count" data-bind="count">' + [5, 10, 15, 20].map(function (n) { return '<option' + (Number(ui.count) === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>' +
      '<button class="btn primary" data-act="search"' + (ui.searching || !B.ai.ready ? ' disabled' : '') + '>🔎 ให้อลิซค้นหา</button></div>' +
      '<p class="small muted" style="margin:10px 0 0">รายแรกขึ้นภายใน ~20–40 วินาที แล้วทยอยเพิ่ม · ข้อมูลจากเว็บอาจไม่ครบ/ไม่สด ตรวจเบอร์ก่อนโทร · บริษัทที่มีในระบบแล้วจะขึ้นป้าย "มีแล้ว" · <button class="btn xs" data-act="manual">+ เพิ่มลูกค้าของฉัน · ให้อลิซวิเคราะห์</button></p></section>';
    if (ui.searching) { var pg0 = ui.prog || {}, got = ui.result ? ui.result.items.length : 0;
      h += '<section class="card busy" style="margin-top:16px"><span class="spin"></span><div style="flex:1;min-width:0"><b>' + (got ? 'พบแล้ว ' + got + ' ราย — อลิซกำลังค้นต่อ…' : 'อลิซกำลังค้นเว็บ…') + '</b><div class="small muted">หา' + esc(sg ? sg.label : 'บริษัท') + (ui.area ? ' แถว ' + esc(ui.area) : '') +
        (pg0.total ? ' · เสร็จ ' + pg0.done + '/' + pg0.total + ' ชุด' : ' · แบ่งค้นหลายมุมพร้อมกัน') + (pg0.sec ? ' · ' + pg0.sec + ' วินาที' : '') + '</div>' +
        (pg0.total ? '<div class="prog"><i style="width:' + Math.round(pg0.done / pg0.total * 100) + '%"></i></div>' : '') + '</div></section>'; }
    if (!ui.searching && ui.searchErr && !ui.result) h += '<section class="card banner-err" style="margin-top:16px"><b>ค้นไม่สำเร็จ</b><div>' + esc(ui.searchErr) + '</div><div class="row" style="margin-top:8px"><button class="btn sm primary" data-act="search">ลองค้นอีกครั้ง</button>' + (B.me.sup ? '<button class="btn sm" data-act="aitest">🩺 ตรวจการเชื่อมต่ออลิซ</button>' : '') + '</div>' + (ui.aiTest ? '<p class="small" style="margin:8px 0 0">' + esc(ui.aiTest) + '</p>' : '') + '</section>';
    if (ui.history && !ui.result) h += '<section class="card panel" style="margin-top:16px"><h2>🕘 ผลค้นหาเดิม (ไม่เสียค่า AI ซ้ำ)</h2>' + (ui.history.length ? '<div class="ag">' + ui.history.map(function (x) {
      var s = segOf(x.query.segment); return '<div class="ag-it"><div class="ag-when"><b>' + dt(x.at) + '</b>' + hm(x.at) + '</div><div class="ag-main"><div class="t">' + (s ? s.icon + ' ' + esc(s.label) : '🔎 ' + esc(x.query.extra)) + '</div><div class="c">' + esc(x.query.area || '-') + ' · ' + x.n + ' ราย · ' + esc(who(x.by)) + '</div></div><button class="btn sm" data-oldsearch="' + esc(x.id) + '">เปิด</button></div>'; }).join('') + '</div>' : '<p class="empty">ยังไม่มีประวัติ</p>') + '</section>';
    if (ui.result) h += resultsView(ui.result);
    return h;
  }
  function resultsView(r) {
    var go = r.items.filter(function (x) { return x.fit === 'go'; }).length;
    var h = '<div class="page-h" style="margin-top:22px"><div><h1 style="font-size:18px">พบ ' + r.items.length + ' ราย · ควรไป visit ' + go + ' ราย</h1><p>' + esc([r.partial ? 'กำลังค้นต่อ — รายการจะเพิ่มขึ้นเรื่อย ๆ' : r.engine, r.at ? dt(r.at, true) : '', 'เรียงตามคะแนนความน่าไป', r.partsFailed ? 'มี ' + r.partsFailed + ' ชุดค้นไม่สำเร็จ' : ''].filter(Boolean).join(' · ')) + '</p></div>' +
      '<div class="acts">' + (B.me.sup ? '<label class="small muted">มอบให้ ' + ownerSelect(ui.addOwner || B.me.username, 'addOwner') + '</label>' : '') + '<button class="btn ghost" data-act="clearres">ปิดผลค้นหา</button></div></div>';
    if (!r.items.length) return h + '<p class="card empty">ไม่พบบริษัทที่ตรงเงื่อนไข — ลองขยายพื้นที่หรือเปลี่ยนกลุ่มธุรกิจ</p>';
    return h + '<div class="results">' + r.items.map(function (c, i) {
      return '<article class="card co"><div class="co-h">' + scoreRing(c.score, c.fit) + '<div class="nm"><b>' + esc(c.name) + '</b><span>' + esc(c.bizType || '') + (c.size ? ' · ' + esc(c.size) : '') + '</span></div>' + fitPill(c.fit) + '</div>' +
        '<div class="co-facts">' +
        '<div><span class="lb">📞</span><span class="vl">' + (c.phone ? telLink(c.phone) : '<span class="muted">ไม่พบเบอร์ — หาในเว็บ/แผนที่</span>') + '</span></div>' +
        '<div><span class="lb">📍</span><span class="vl">' + esc(c.address || c.province || '-') + ' · <a href="' + esc(c.mapsUrl) + '" target="_blank" rel="noopener">Google Maps ↗</a></span></div>' +
        (c.website ? '<div><span class="lb">🌐</span><span class="vl"><a href="' + esc(c.website) + '" target="_blank" rel="noopener">' + esc(c.website.replace(/^https?:\/\//, '').slice(0, 60)) + '</a></span></div>' : '') +
        (c.juristicId ? '<div><span class="lb">🏢</span><span class="vl">เลขทะเบียน ' + esc(c.juristicId) + '</span></div>' : '') + '</div>' +
        (c.summary ? '<p>' + esc(c.summary) + '</p>' : '') +
        (c.reasons && c.reasons.length ? '<div class="why"><b>ทำไมถึงได้คะแนนนี้</b>' + list(c.reasons) + '</div>' : '') +
        (c.signals && c.signals.length ? '<div class="why"><b>สัญญาณที่น่าจะต้องใช้ป้าย</b>' + list(c.signals) + '</div>' : '') +
        (c.pitch && c.pitch.length ? '<div class="why"><b>ควรเสนอ</b>' + list(c.pitch) + '</div>' : '') +
        (c.sources && c.sources.length ? '<div class="src">แหล่งข้อมูล: ' + c.sources.map(function (u, j) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener">[' + (j + 1) + ']</a>'; }).join(' ') + '</div>' : '') +
        '<div class="co-foot">' + (c.existing ? '<span class="pill info">มีในระบบแล้ว · ' + esc(who(c.existing.owner)) + '</span><button class="btn sm" data-open="' + esc(c.existing.id) + '">เปิดแฟ้ม</button>'
          : '<button class="btn sm primary" data-add="' + i + '">+ เพิ่มเป็นลูกค้าเป้าหมาย</button>') + '</div></article>'; }).join('') + '</div>';
  }

  /* ── ลูกค้า ── */
  function listView() {
    if (!L) return '<div class="boot">กำลังโหลด…</div>';
    var q = ui.q.trim().toLowerCase();
    var items = L.items.filter(function (p) { return (!ui.stage || p.stage === ui.stage) && (!q || (p.name + ' ' + p.phone + ' ' + p.bizType + ' ' + p.province).toLowerCase().indexOf(q) >= 0); });
    var h = '<div class="page-h"><div><h1>ลูกค้า</h1><p>' + L.items.length + ' ราย · แตะเพื่อเปิดแฟ้ม (ข้อมูล · การเงิน · visit & ติดตาม)</p></div><div class="acts"><button class="btn" data-act="qtask">📞 วางแผนติดตาม</button><button class="btn follow" data-act="qfollow">💬 บันทึกการติดตาม</button><button class="btn" data-act="manual">+ เพิ่มลูกค้าของฉัน · ให้อลิซวิเคราะห์</button><button class="btn primary" data-go="search">🔎 หาลูกค้าใหม่</button></div></div>';
    h += exPanel();
    /* 🤖 v1.2.0 ลูกค้าที่ยังไม่ได้ให้อลิซวิเคราะห์ */
    var noAi = L.items.filter(function (p) { return !(p.doc && (p.doc.analyzed || p.doc.ai)) && p.stage !== 'lost' && p.stage !== 'won'; });
    if (noAi.length && B.ai.ready) h += '<div class="ai-nudge"><span>🤖 มีลูกค้า <b>' + noAi.length + ' ราย</b> ที่อลิซยังไม่ได้วิเคราะห์ว่าควรโฟกัสไหม</span><button class="btn sm primary" data-act="analyzeall">ให้อลิซวิเคราะห์' + (noAi.length > 30 ? ' 30 รายแรก' : 'ทั้งหมด') + '</button></div>';
    h += '<div class="toolbar"><input class="in" type="search" id="q" data-bind="q" data-live="1" value="' + esc(ui.q) + '" placeholder="ค้นชื่อ เบอร์ ประเภท จังหวัด" aria-label="ค้นลูกค้า">' + ownerSelect(ui.owner, 'owner', true) +
      '<span class="seg-tg"><button data-mode="list" aria-pressed="' + (ui.mode === 'list') + '">☰ รายการ</button><button data-mode="board" aria-pressed="' + (ui.mode === 'board') + '">▦ กระดาน</button></span></div>';
    if (ui.mode === 'board') {
      return h + '<div class="board">' + B.stages.map(function (s) {
        var col = items.filter(function (p) { return p.stage === s.key; });
        return '<div class="col"><h3>' + esc(s.label) + '<span class="muted">' + col.length + '</span></h3>' + col.map(function (p) {
          return '<button class="bc" data-open="' + esc(p.id) + '"><b>' + esc(p.name) + '</b><span class="meta">' + fitPill(p.fit) + '<span>โอกาส ' + p.chance + '%</span>' + (p.value ? '<span>฿' + baht(p.value) + '</span>' : '') + '</span>' +
            (p.nextAction ? '<span class="meta' + '">' + (p.overdue ? '<span class="pill late">เลยกำหนด</span>' : '📌') + ' ' + esc(p.nextAction) + '</span>' : '') + '</button>'; }).join('') + '</div>'; }).join('') + '</div>';
    }
    h += '<div class="chips" style="margin-bottom:12px"><button class="chip" data-stage="" aria-pressed="' + (!ui.stage) + '">ทั้งหมด<span class="n">' + L.items.length + '</span></button>' + B.stages.map(function (s) {
      return '<button class="chip" data-stage="' + s.key + '" aria-pressed="' + (ui.stage === s.key) + '">' + esc(s.label) + '<span class="n">' + (L.stageN[s.key] || 0) + '</span></button>'; }).join('') + '</div>';
    if (!items.length) return h + '<div class="card empty">ไม่มีลูกค้าในมุมมองนี้' + (q.length >= 2 ? ' — <button class="btn sm" data-act="exfromq">🔎 ค้น "' + esc(ui.q.trim()) + '" ในลูกค้าเดิม (คีย์ยอดขาย)</button>' : '') + '</div>';
    return h + '<div class="card tbl-wrap cust"><table class="tbl cust"><thead><tr><th>คะแนน</th><th>บริษัท</th><th>ขั้น</th><th>โอกาส</th><th>มูลค่า</th><th>งานถัดไป</th>' + (B.me.sup ? '<th>เซลส์</th>' : '') + '<th class="ra">visit</th></tr></thead><tbody>' + items.map(function (p) {
      return '<tr data-open="' + esc(p.id) + '"><td>' + scoreRing(p.score, p.fit) + '</td><td class="nm"><b>' + esc(p.name) + '</b><span>' + esc([p.bizType, p.province].filter(Boolean).join(' · ') || '-') + (p.phone ? ' · ' + esc(p.phone) : '') + '</span></td>' +
        '<td><span class="pill' + (p.stage === 'won' ? ' go' : p.stage === 'lost' ? '' : ' cu') + '">' + esc(stageL(p.stage)) + '</span></td><td class="num" data-l="โอกาส">' + p.chance + '%</td><td class="num" data-l="มูลค่า">' + (p.value ? '฿' + baht(p.value) : '—') + '</td>' +
        '<td>' + (p.nextAction ? (p.overdue ? '<span class="pill late">เลยกำหนด</span> ' : '<span class="small muted">' + dt(p.nextAt) + '</span> ') + esc(p.nextAction) : '<span class="muted">—</span>') + '</td>' + (B.me.sup ? '<td class="small">' + esc(who(p.owner)) + '</td>' : '') +
        '<td class="ra"><span class="row-acts"><button class="btn xs" data-planfor="' + esc(p.id) + '" title="วางแผน visit">📅 นัด</button><button class="btn xs follow" data-fufor="' + esc(p.id) + '" title="บันทึก / วางแผนการติดตาม ทางแชท · โทร">💬 ติดตาม</button><button class="btn xs primary" data-visit="' + esc(p.id) + '" title="บันทึก visit + รูปหน้างาน">📸 บันทึก</button></span></td></tr>'; }).join('') + '</tbody></table></div>';
  }

  /* ── ปฏิทิน ── */
  function calView() {
    var m = ui.calMonth, first = new Date(m.getFullYear(), m.getMonth(), 1), start = new Date(first); start.setDate(1 - first.getDay());
    var h = '<div class="page-h"><div><h1>ปฏิทิน visit</h1><p>นัด visit · งานติดตาม · การติดตามทางแชท/โทร · visit ที่บันทึกแล้ว — แตะรายการเพื่อเปิดแฟ้มลูกค้า</p></div><div class="acts"><button class="btn" data-act="qplan">📅 วางแผน visit</button><button class="btn" data-act="qtask">📞 วางแผนติดตาม</button><button class="btn follow" data-act="qfollow">💬 บันทึกการติดตาม</button><button class="btn primary" data-act="qvisit">📸 บันทึก visit + รูป</button></div></div>' +
      '<div class="cal-h"><h2>' + TH_MF[m.getMonth()] + ' ' + (m.getFullYear() + 543) + '</h2><button class="btn sm" data-cal="-1" aria-label="เดือนก่อน">‹</button><button class="btn sm" data-cal="0">เดือนนี้</button><button class="btn sm" data-cal="1" aria-label="เดือนถัดไป">›</button><span class="grow" style="flex:1"></span>' + ownerSelect(ui.owner, 'owner', true) + '</div>';
    if (!ui.cal) return h + '<div class="boot">กำลังโหลด…</div>';
    var today = new Date(), now = Date.now();
    var cells = TH_D.map(function (d) { return '<div class="dow">' + d + '</div>'; }).join('');
    for (var i = 0; i < 42; i++) {
      var d = new Date(start); d.setDate(start.getDate() + i);
      if (i >= 35 && d.getMonth() !== m.getMonth()) break;
      var evs = ui.cal.filter(function (e) { return sameDay(new Date(e.at), d); });
      cells += '<div class="day' + (d.getMonth() !== m.getMonth() ? ' out' : '') + (sameDay(d, today) ? ' today' : '') + '"><span class="dn">' + d.getDate() + '</span>' + evs.slice(0, 4).map(function (e) {
        var late = e.status === 'open' && e.at < now;
        return '<button class="ev ' + e.kind + (e.status === 'done' && e.kind !== 'visit' && e.kind !== 'follow' ? ' done' : '') + (late ? ' late' : '') + '" data-open="' + esc(e.prospectId) + '" title="' + esc(hm(e.at) + ' ' + e.title + ' — ' + e.name) + '">' + (e.kind === 'plan' ? '🚗 ' : e.kind === 'visit' ? '✅ ' : chOf(e.doc && e.doc.channel).icon + (e.kind === 'follow' ? '✓ ' : ' ')) + hm(e.at) + ' ' + esc(e.name) + '</button>'; }).join('') +
        (evs.length > 4 ? '<span class="small muted">+' + (evs.length - 4) + ' รายการ</span>' : '') + '</div>';
    }
    h += '<div class="cal">' + cells + '</div><div class="legend"><span><i style="background:var(--copper-wash);border:1px solid var(--copper)"></i>นัด visit</span><span><i style="background:var(--go-wash);border:1px solid var(--go)"></i>visit แล้ว</span><span><i style="background:var(--info-wash);border:1px solid var(--info)"></i>งานติดตาม</span><span><i style="background:var(--fu-wash);border:1px solid var(--fu)"></i>ติดตามแล้ว (แชท/โทร)</span><span><i style="background:var(--skip-wash);border:1px solid var(--skip)"></i>เลยกำหนด</span></div>';
    return h;
  }
  function loadCal() {
    var m = ui.calMonth, from = new Date(m.getFullYear(), m.getMonth(), 1); from.setDate(1 - from.getDay());
    var to = new Date(from); to.setDate(from.getDate() + 42);
    ui.cal = null; render();
    req('/calendar?from=' + encodeURIComponent(from.toISOString()) + '&to=' + encodeURIComponent(to.toISOString()) + (B.me.sup && ui.owner ? '&owner=' + encodeURIComponent(ui.owner) : ''))
      .then(function (j) { ui.cal = j.events; render(); }).catch(function (e) { ui.cal = []; toast(e.message, true); render(); });
  }

  /* ── รายงาน ── */
  function reportView() {
    var t = new Date();
    if (!ui.rpFrom) { ui.rpFrom = ymd(new Date(t.getFullYear(), t.getMonth(), 1)); ui.rpTo = ymd(t); }
    var h = '<div class="page-h no-print"><div><h1>Summary Report</h1><p>อลิซสรุปทุกรายที่ visit แล้วในช่วงที่เลือก · แผนงานรายลูกค้า · อัตราความสำเร็จ</p></div></div>' +
      '<section class="card panel no-print"><div class="row" style="align-items:flex-end"><label class="field">ตั้งแต่<input type="date" id="rpFrom" data-bind="rpFrom" value="' + esc(ui.rpFrom) + '"></label><label class="field">ถึง<input type="date" id="rpTo" data-bind="rpTo" value="' + esc(ui.rpTo) + '"></label>' +
      (B.me.sup ? '<label class="field">เซลส์' + ownerSelect(ui.rpOwner, 'rpOwner', true) + '</label>' : '') +
      '<button class="btn primary" data-act="report"' + (ui.rpBusy ? ' disabled' : '') + '>📊 ให้อลิซทำรายงาน</button>' + (ui.report ? xBar('#rpDoc', 'visit-summary-report_' + ui.rpFrom + '_' + ui.rpTo) : '') + '</div>' +
      (ui.reports && ui.reports.length ? '<p class="small muted" style="margin:10px 0 0">รายงานเดิม: ' + ui.reports.slice(0, 6).map(function (r) { return '<button class="btn xs" data-oldrp="' + esc(r.id) + '">' + esc(r.from) + ' → ' + esc(r.to) + (r.owner ? ' · ' + esc(who(r.owner)) : '') + '</button>'; }).join(' ') + '</p>' : '') + '</section>';
    if (ui.rpBusy) return h + '<section class="card busy" style="margin-top:16px"><span class="spin"></span><div><b>อลิซกำลังอ่านบันทึก visit ทุกราย…</b><div class="small muted">วางแผนงานรายลูกค้า และประเมินอัตราความสำเร็จ</div></div></section>';
    if (!ui.report) return h;
    var d = ui.report.doc, k = d.kpi, a = d.ai || {}, rate = a.successRate != null ? a.successRate : k.weightedRate;
    h += '<div class="stack xdoc-rp" id="rpDoc" style="margin-top:16px"><div class="rp-head"><div><h2>' + esc(a.headline || ('สรุปการ visit ' + d.periodLabel)) + '</h2><p>ช่วง ' + esc(d.periodLabel) + (d.ownerLabel ? ' · ' + esc(d.ownerLabel) : ' · ทุกเซลส์') + ' · ทำเมื่อ ' + dt(ui.report.at, true) + (a.engine ? ' · ' + esc(a.engine) : '') + '</p>' +
      (a.overview ? '<p style="color:var(--navy-ink);margin-top:10px">' + esc(a.overview) + '</p>' : '') + (d.aiError ? '<p style="margin-top:8px">⚠️ ' + esc(d.aiError) + '</p>' : '') + '</div>' +
      '<div class="gauge" style="--v:' + rate + '"><div><b>' + rate + '%</b><small>อัตราความสำเร็จ<br>ที่คาดการณ์</small></div></div></div>';
    h += '<div class="kpis"><div class="card kpi"><div class="k">ลูกค้าที่ visit</div><div class="v">' + k.customers + '</div><div class="s">' + k.visits + ' ครั้ง</div></div>' +
      '<div class="card kpi"><div class="k">ติดตามทางแชท/โทร</div><div class="v">' + (k.follows || 0) + '</div><div class="s">ครั้งในช่วงนี้</div></div>' +
      '<div class="card kpi"><div class="k">นัดที่ไปจริง</div><div class="v">' + (k.plans ? Math.round(k.plansDone / k.plans * 100) + '%' : '—') + '</div><div class="s">' + k.plansDone + ' / ' + k.plans + ' นัด</div></div>' +
      '<div class="card kpi good"><div class="k">ปิดได้ / คาดว่าจะปิดได้</div><div class="v">' + k.won + ' / ' + k.expectedWins + '</div><div class="s">อัตราชนะจริง ' + (k.winRate === null ? '—' : k.winRate + '%') + '</div></div>' +
      '<div class="card kpi"><div class="k">มูลค่ารอปิด</div><div class="v">฿' + baht(k.pipeline) + '</div><div class="s">ถ่วงโอกาส ฿' + baht(k.weightedValue) + '</div></div>' +
      '<div class="card kpi' + (k.overdue ? ' alert' : '') + '"><div class="k">งานติดตามเลยกำหนด</div><div class="v">' + k.overdue + '</div><div class="s">ทำแล้ว ' + k.tasksDone + ' / ' + k.tasks + '</div></div></div>';
    if (a.successNote) h += '<p class="small muted" style="margin:-6px 0 0">วิธีประเมิน: ' + esc(a.successNote) + '</p>';
    h += '<div class="two"><section class="card panel"><h2>🧭 ขั้นการขายของลูกค้าที่ visit</h2>' + funnel(k.stageN) + '</section>';
    if (k.bySales && k.bySales.length > 1) h += '<section class="card panel"><h2>👥 รายเซลส์</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>เซลส์</th><th>ลูกค้า</th><th>visit</th><th>ปิดได้</th><th>โอกาสเฉลี่ย</th></tr></thead><tbody>' +
      k.bySales.map(function (s) { return '<tr><td>' + esc(s.name) + '</td><td class="num">' + s.customers + '</td><td class="num">' + s.visits + '</td><td class="num">' + s.won + '</td><td class="num">' + s.avgChance + '%</td></tr>'; }).join('') + '</tbody></table></div></section>';
    else h += '<section class="card panel"><h2>✅ ทำได้ดี</h2>' + (list(a.wins, 'lst') || '<p class="empty">—</p>') + '</section>';
    h += '</div>';
    var plans = {}; (a.customers || []).forEach(function (c) { plans[c.id] = c; });
    var order = { A: 0, B: 1, C: 2 };
    var cs = d.customers.slice().sort(function (x, y) { var px = plans[x.id] || {}, py = plans[y.id] || {}; return (order[px.priority] == null ? 1 : order[px.priority]) - (order[py.priority] == null ? 1 : order[py.priority]) || ((py.chance || y.chance) - (px.chance || x.chance)); });
    h += '<section class="card panel"><h2>📋 แผนงานรายลูกค้า (' + cs.length + ' ราย)</h2>' + (cs.length ? cs.map(function (c) {
      var pl = plans[c.id] || {};
      return '<div class="rp-cust">' + (c.photo ? '<img class="thumb" src="' + esc(c.photo) + '" alt="" loading="lazy">' : '<span class="thumb">🏢</span>') +
        '<div><h4>' + (pl.priority ? '<span class="prio ' + pl.priority + '">' + pl.priority + '</span>' : '') + '<button class="btn ghost xs" style="font-size:15px;font-weight:600;padding:0" data-open="' + esc(c.id) + '">' + esc(c.name) + '</button><span class="pill' + (c.stage === 'won' ? ' go' : ' cu') + '">' + esc(c.stageLabel) + '</span></h4>' +
        '<div class="small muted">' + esc(c.ownerName) + ' · visit ' + c.visits + ' ครั้ง · ล่าสุด ' + esc(c.lastVisit) + (c.overdue ? ' · <span style="color:var(--skip)">งานเลยกำหนด ' + c.overdue + '</span>' : '') + '</div>' +
        (pl.plan && pl.plan.length ? '<ol>' + pl.plan.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' : (c.next ? '<p class="small">ถัดไป: ' + esc(c.next) + '</p>' : '')) + (pl.note ? '<p class="small muted" style="margin:4px 0 0">' + esc(pl.note) + '</p>' : '') + '</div>' +
        '<div class="rp-side"><b>' + (pl.chance != null && pl.chance !== undefined && plans[c.id] ? pl.chance : c.chance) + '%</b>โอกาสปิด' + (c.value ? '<br>฿' + baht(c.value) : '') + '</div></div>'; }).join('') : '<p class="empty">ช่วงนี้ยังไม่มีการบันทึก visit</p>') + '</section>';
    if (a.risks && a.risks.length || a.teamAdvice && a.teamAdvice.length) h += '<div class="two"><section class="card panel"><h2>⚠️ ความเสี่ยง / ลูกค้าที่อาจหลุด</h2>' + (list(a.risks, 'lst') || '<p class="empty">—</p>') + '</section><section class="card panel"><h2>💡 คำแนะนำทีมขาย</h2>' + (list(a.teamAdvice, 'lst') || '<p class="empty">—</p>') + '</section></div>';
    return h + '</div>';
  }

  /* ═══════════ แฟ้มลูกค้า ═══════════ */
  var drEl = null;
  function openP(id, tab) {
    ui.dr = { id: id, data: null, edit: null, fin: '', busy: false }; ui.drTab = tab || ui.drTab || 'info';
    drawDr();
    req('/prospect/' + encodeURIComponent(id)).then(function (j) { if (!ui.dr || ui.dr.id !== id) return; ui.dr.data = j; drawDr(); }).catch(function (e) { toast(e.message, true); closeDr(); });
  }
  function reloadDr() { if (!ui.dr) return; var id = ui.dr.id; return req('/prospect/' + encodeURIComponent(id)).then(function (j) { if (ui.dr && ui.dr.id === id) { ui.dr.data = j; drawDr(); } }); }
  function closeDr() { ui.dr = null; if (drEl) { drEl.remove(); drEl = null; } document.body.style.overflow = ''; }
  function drawDr() {
    if (!ui.dr) return closeDr();
    if (!drEl) { drEl = document.createElement('div'); document.body.appendChild(drEl); document.body.style.overflow = 'hidden'; }
    var keep = drEl.querySelector('.dr-body'), st = keep ? keep.scrollTop : 0;
    var d = ui.dr.data;
    if (!d) { drEl.innerHTML = '<div class="drawer-bg" data-x="dr"></div><aside class="drawer" role="dialog" aria-label="แฟ้มลูกค้า"><div class="dr-h"><div class="dr-top"><h2>กำลังโหลด…</h2><button class="btn ghost" data-x="dr" aria-label="ปิด">✕</button></div></div></aside>'; return; }
    var p = d.p, a = p.doc.ai || null;
    var tabs = [['info', 'ข้อมูล & วิเคราะห์'], ['act', 'visit & ติดตาม'], ['fin', 'การเงิน (DBD)']];
    var h = '<div class="drawer-bg" data-x="dr"></div><aside class="drawer" role="dialog" aria-label="แฟ้มลูกค้า ' + esc(p.name) + '"><div class="dr-h"><div class="dr-top">' + scoreRing(p.score, p.fit) + '<h2>' + esc(p.name) + '</h2><button class="btn ghost" data-x="dr" aria-label="ปิด">✕</button></div>' +
      '<div class="dr-sub">' + fitPill(p.fit) + '<span class="pill cu">' + esc(stageL(p.stage)) + '</span><span>โอกาสปิด <b class="num">' + p.chance + '%</b></span>' + (p.value ? '<span>· มูลค่า <b class="num">฿' + baht(p.value) + '</b></span>' : '') + '<span class="muted">· ' + esc(who(p.owner)) + '</span></div>' +
      '<div class="tabs" role="tablist">' + tabs.map(function (t) { return '<button role="tab" data-tab="' + t[0] + '" aria-selected="' + (ui.drTab === t[0]) + '">' + t[1] + '</button>'; }).join('') + '</div></div><div class="dr-body">';
    if (ui.drTab === 'info') h += drInfo(d, p, a); else if (ui.drTab === 'fin') h += drFin(d, p); else h += drAct(d, p);
    drEl.innerHTML = h + '</div></aside>';
    var nb = drEl.querySelector('.dr-body'); if (nb) nb.scrollTop = st;
  }
  function drInfo(d, p, a) {
    var e = ui.dr.edit, sg = segOf(p.segment);
    var h = '<section class="card panel"><h2>ขั้นการขาย</h2><div class="stagebar">' + B.stages.map(function (s) { return '<button class="' + s.key + '" data-setstage="' + s.key + '" aria-pressed="' + (p.stage === s.key) + '">' + esc(s.label) + '</button>'; }).join('') + '</div></section>';
    if (e) {
      h += '<section class="card panel"><h2>แก้ไขข้อมูล</h2><div class="grid2">' +
        [['name', 'ชื่อบริษัท'], ['phone', 'เบอร์ติดต่อ'], ['juristicId', 'เลขทะเบียน 13 หลัก'], ['website', 'เว็บไซต์'], ['bizType', 'ประเภทธุรกิจ'], ['province', 'จังหวัด'], ['value', 'มูลค่างานคาดการณ์ (บาท)']].map(function (f) {
          return '<label class="field">' + f[1] + '<input data-ebind="' + f[0] + '" value="' + esc(e[f[0]]) + '"' + (f[0] === 'value' ? ' inputmode="numeric"' : '') + '></label>'; }).join('') +
        '<label class="field">กลุ่มธุรกิจ<select data-ebind="segment"><option value="">—</option>' + B.segments.map(function (s) { return '<option value="' + s.key + '"' + (e.segment === s.key ? ' selected' : '') + '>' + esc(s.label) + '</option>'; }).join('') + '</select></label>' +
        (B.me.sup ? '<label class="field">เซลส์ผู้ดูแล<select data-ebind="owner">' + B.team.map(function (u) { return '<option value="' + esc(u.username) + '"' + (e.owner === u.username ? ' selected' : '') + '>' + esc(u.name) + '</option>'; }).join('') + '</select></label>' : '') +
        '</div><label class="field" style="margin-top:12px">ที่อยู่<textarea data-ebind="address" style="min-height:60px">' + esc(e.address) + '</textarea></label>' +
        '<h2 style="margin-top:14px">ผู้ติดต่อ</h2>' + e.contacts.map(function (c, i) {
          return '<div class="grid2" style="margin-bottom:8px"><label class="field">ชื่อ<input data-cbind="' + i + '.name" value="' + esc(c.name) + '"></label><label class="field">ตำแหน่ง<input data-cbind="' + i + '.role" value="' + esc(c.role) + '"></label><label class="field">โทร<input data-cbind="' + i + '.phone" value="' + esc(c.phone) + '"></label><label class="field">LINE / อีเมล<input data-cbind="' + i + '.line" value="' + esc(c.line) + '"></label></div>'; }).join('') +
        '<button class="btn sm" data-act="addcontact">+ เพิ่มผู้ติดต่อ</button>' +
        '<label class="field" style="margin-top:12px">บันทึกภายใน<textarea data-ebind="note">' + esc(e.note) + '</textarea></label>' +
        '<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-act="editcancel">ยกเลิก</button><button class="btn primary" data-act="editsave"' + (ui.dr.busy ? ' disabled' : '') + '>บันทึก</button></div></section>';
    } else {
      h += '<section class="card panel"><h2>ข้อมูลบริษัท<span class="sp"></span><button class="btn sm" data-act="edit">✏️ แก้ไข</button></h2><dl class="kv">' +
        '<dt>เบอร์</dt><dd>' + (p.phone ? telLink(p.phone) : '<span class="muted">ยังไม่มี</span>') + '</dd>' +
        '<dt>ที่อยู่</dt><dd>' + esc(p.address || p.province || '-') + ' · <a href="' + esc(p.mapsUrl) + '" target="_blank" rel="noopener">Google Maps ↗</a></dd>' +
        '<dt>ธุรกิจ</dt><dd>' + esc([sg ? sg.icon + ' ' + sg.label : '', p.bizType].filter(Boolean).join(' · ') || '-') + '</dd>' +
        (p.website ? '<dt>เว็บไซต์</dt><dd><a href="' + esc(p.website) + '" target="_blank" rel="noopener">' + esc(p.website.replace(/^https?:\/\//, '')) + '</a></dd>' : '') +
        '<dt>เลขทะเบียน</dt><dd>' + esc(p.juristicId || '-') + '</dd>' +
        /* 🧾 25 ต.ค. 69 — วางแผนติดต่อแล้ว ⇒ ระบบเปิดใบในคีย์ยอดขาย (B2B) + รหัสงานให้เอง */
        '<dt>รหัสงาน</dt><dd>' + (p.doc.sales && p.doc.sales.jobCode
          ? '<b>' + esc(p.doc.sales.jobCode) + '</b> <span class="small muted">ในคีย์ยอดขาย (B2B)' + (p.doc.sales.linked ? ' · ผูกกับใบเดิมของบริษัทนี้' : '') + '</span> · <a href="/m/sales/" target="_blank" rel="noopener">เปิดคีย์ยอดขาย ↗</a>'
          : p.doc.salesErr ? '<span style="color:#b45309">⚠️ ยังเปิดใบไม่ได้: ' + esc(p.doc.salesErr.why) + '</span> <button class="btn sm" data-act="tosales">ลองอีกครั้ง</button>'
          : (['planned', 'visited', 'quoted', 'negotiating'].indexOf(p.stage) >= 0 || p.nextAt) ? '<span class="muted">กำลังเปิดใบในคีย์ยอดขาย…</span> <button class="btn sm" data-act="tosales">เปิดเลย</button>'
          : '<span class="muted">ลงนัด visit / งานติดตาม แล้วระบบเปิดใบ + รหัสงานในคีย์ยอดขายให้เอง</span>') + '</dd>' +
        '<dt>ผู้ติดต่อ</dt><dd>' + ((p.doc.contacts || []).length ? p.doc.contacts.map(function (c) { return esc([c.name, c.role].filter(Boolean).join(' · ')) + (c.phone ? ' · ' + telLink(c.phone) : '') + (c.line ? ' · ' + esc(c.line) : ''); }).join('<br>') : '<span class="muted">ยังไม่มี — กดแก้ไขเพื่อเพิ่ม</span>') + '</dd>' +
        (p.doc.note ? '<dt>บันทึก</dt><dd style="white-space:pre-wrap">' + esc(p.doc.note) + '</dd>' : '') + '</dl>' +
        (p.doc.summary ? '<p class="small" style="margin:12px 0 0;color:var(--ink-2)">' + esc(p.doc.summary) + '</p>' : '') + '</section>';
    }
    h += '<section class="ai-box"><h3>🤖 อลิซวิเคราะห์ว่าควร focus ไหม<span style="flex:1"></span><button class="btn sm' + (a ? '' : ' primary') + '" data-act="analyze"' + (ui.dr.busy || !B.ai.ready ? ' disabled' : '') + '>' + (ui.dr.busy === 'ai' ? 'กำลังวิเคราะห์… (~1 นาที)' : a ? 'วิเคราะห์ใหม่' : 'ให้อลิซเจาะลึก') + '</button></h3>';
    if (a) {
      h += '<div class="row">' + fitPill(a.fit) + '<span class="small muted">คะแนน ' + a.score + '/100 · ' + dt(a.at, true) + '</span></div>' + (a.verdict ? '<div class="verdict">' + esc(a.verdict) + '</div>' : '') + (a.summary ? '<p class="small" style="margin:0">' + esc(a.summary) + '</p>' : '') +
        (a.reasons.length ? '<div class="lbl">เหตุผล</div>' + list(a.reasons) : '') + (a.pitch.length ? '<div class="lbl">ควรเสนอ</div>' + list(a.pitch) : '') + (a.decisionMakers.length ? '<div class="lbl">ควรคุยกับ</div>' + list(a.decisionMakers) : '') +
        (a.openers.length ? '<div class="lbl">ประโยคเปิด / คำถามตอน visit</div>' + list(a.openers) : '') + (a.signals.length ? '<div class="lbl">สัญญาณที่ต้องใช้ป้าย</div>' + list(a.signals) : '') + (a.news.length ? '<div class="lbl">ความเคลื่อนไหวล่าสุด</div>' + list(a.news) : '') +
        (a.risks.length ? '<div class="lbl">ข้อควรระวัง</div>' + list(a.risks) : '') + (a.bestTime ? '<div class="lbl">ช่วงที่เหมาะเข้าพบ</div><p class="small" style="margin:0">' + esc(a.bestTime) + '</p>' : '') +
        (a.sources.length ? '<div class="src">แหล่งข้อมูล: ' + a.sources.map(function (u, j) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener">[' + (j + 1) + ']</a>'; }).join(' ') + '</div>' : '');
    } else if ((p.doc.reasons || []).length) h += '<div class="lbl">จากผลค้นหา</div>' + list(p.doc.reasons) + ((p.doc.pitch || []).length ? '<div class="lbl">ควรเสนอ</div>' + list(p.doc.pitch) : '');
    else h += '<p class="small muted" style="margin:0">กด "ให้อลิซเจาะลึก" — ค้นเว็บเรื่องธุรกิจ ข่าวล่าสุด คนตัดสินใจ และใช้งบ DBD (ถ้าวางไว้) ประกอบคำแนะนำ</p>';
    h += '</section><div class="row"><button class="btn danger sm" data-act="delp">ลบลูกค้ารายนี้</button></div>';
    return h;
  }
  function drFin(d, p) {
    var r = d.risk, f = p.doc.fin;
    var h = '<section class="card panel"><h2>🏢 งบการเงินจาก DBD (ฟรี)</h2><div class="row"><a class="btn" href="' + esc(d.dbd.profile || d.dbd.search) + '" target="_blank" rel="noopener">เปิด DBD DataWarehouse+ ↗</a>' +
      (p.juristicId ? '<button class="btn sm" data-copy="' + esc(p.juristicId) + '">📋 คัดลอกเลขทะเบียน</button>' : '<span class="small muted">ยังไม่มีเลขทะเบียน — ค้นด้วยชื่อในหน้า DBD</span>') + '</div>' +
      '<p class="small muted">แท็บ "ข้อมูลงบการเงิน" › คัดลอกตาราง "งบแสดงฐานะการเงิน" มาวาง แล้วกด "งบกำไรขาดทุน" คัดลอกมาวางต่อท้าย — ระบบแกะตัวเลขทุกปีให้เอง</p>' +
      '<label class="field">วางข้อความจากหน้า DBD<textarea id="fin" data-bind-dr="fin" placeholder="หน่วย : บาท  2564 2565 2566 …">' + esc(ui.dr.fin) + '</textarea></label>' +
      '<div class="row" style="justify-content:flex-end;margin-top:10px">' + (f ? '<button class="btn sm ghost" data-act="finclear">ล้างงบ</button>' : '') + '<button class="btn primary" data-act="finsave"' + (ui.dr.busy ? ' disabled' : '') + '>บันทึก · ประเมินความเสี่ยง</button></div></section>';
    if (r && r.level !== 'unknown') {
      var cls = r.level === 'low' ? 'go' : r.level === 'med' ? 'wait' : 'skip';
      h += '<section class="ai-box"><h3><span class="pill ' + cls + '">' + esc(r.label) + '</span></h3><p class="verdict" style="margin:0">' + esc(r.advice) + '</p>' + list(r.reasons.map(function (x) { return x.text; })) + '</section>';
    }
    if (f && f.years && f.years.length) h += '<section class="card panel"><h2>ตัวเลขงบ (ล้านบาท)</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>ปี</th><th>รายได้รวม</th><th>กำไรสุทธิ</th><th>หนี้สินรวม</th><th>ส่วนผู้ถือหุ้น</th></tr></thead><tbody>' +
      f.years.map(function (y) { var m = function (v) { return v == null ? '—' : (Math.round(v / 1e4) / 100).toLocaleString('th-TH'); }; return '<tr><td>' + (y.year + 543) + '</td><td class="num">' + m(y.revenue) + '</td><td class="num">' + m(y.netProfit) + '</td><td class="num">' + m(y.totalLiabilities) + '</td><td class="num">' + m(y.equity) + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
    return h;
  }
  function drAct(d, p) {
    var now = Date.now();
    var h = '<div class="row"><button class="btn primary" data-act="plan">📅 นัด visit</button><button class="btn dark" data-act="visit">✅ บันทึก visit</button><button class="btn follow" data-act="follow">💬 บันทึกการติดตาม</button><button class="btn" data-act="task">+ งานติดตาม</button></div>';
    var open = d.events.filter(function (e) { return e.status === 'open' && (e.kind === 'plan' || e.kind === 'task'); }).sort(function (a, b) { return a.at - b.at; });
    h += '<section class="card panel"><h2>📌 รอทำ (' + open.length + ')</h2>' + (open.length ? '<div class="tl">' + open.map(function (e) { return tlItem(e, p, now); }).join('') + '</div>' : '<p class="empty">ไม่มีงานค้าง — ทุกการติดตามควรมี "งานถัดไป" เสมอ</p>') + '</section>';
    var past = d.events.filter(function (e) { return !(e.status === 'open' && (e.kind === 'plan' || e.kind === 'task')); });
    h += '<section class="card panel"><h2>🗂 ประวัติ</h2>' + (past.length ? '<div class="tl">' + past.map(function (e) { return tlItem(e, p, now); }).join('') + '</div>' : '<p class="empty">ยังไม่มีประวัติ</p>') + '</section>';
    return h;
  }
  /* 💬 v1.5.0 การติดตามทางแชท / โทร ในประวัติลูกค้า */
  function followItem(e, ic) {
    var oc = ocOf(e.doc && e.doc.outcome), ph = (e.doc && e.doc.photos) || [];
    return '<div class="tl-it follow"><span class="tl-ic">' + ic + '</span><div><div class="t">' + esc(chOf(e.doc && e.doc.channel).label) + ' <span class="pill ' + esc(oc.tone || '') + '">' + oc.icon + ' ' + esc(oc.label) + '</span></div>' +
      '<div class="d">' + dt(e.at, true) + (e.by ? ' · ' + esc(who(e.by)) : '') + (e.doc && e.doc.taskId ? ' · ปิดงานติดตามที่นัดไว้' : '') + '</div>' +
      (e.body ? '<div class="b">' + esc(e.body) + '</div>' : '') +
      (ph.length ? '<div class="photos">' + ph.map(function (x) { return '<a href="' + esc(x.url) + '" target="_blank" rel="noopener"><img src="' + esc(x.url) + '" alt="ภาพแคปแชท" loading="lazy"></a>'; }).join('') + '</div>' : '') + '</div></div>';
  }
  function tlItem(e, p, now) {
    var late = e.status === 'open' && e.at < now, ic = e.kind === 'plan' ? '🚗' : e.kind === 'visit' ? '📸' : e.kind === 'stage' ? '🔀' : chOf(e.doc && e.doc.channel).icon;
    if (e.kind === 'follow') return followItem(e, ic);
    var h = '<div class="tl-it ' + e.kind + (late ? ' late' : '') + (e.status !== 'open' && e.kind !== 'visit' && e.kind !== 'stage' ? ' done' : '') + '"><span class="tl-ic">' + ic + '</span><div><div class="t">' + esc(e.title) +
      (e.status === 'cancelled' ? ' <span class="pill">ยกเลิก</span>' : e.status === 'done' && (e.kind === 'plan' || e.kind === 'task') ? ' <span class="pill go">ทำแล้ว</span>' : late ? ' <span class="pill late">เลยกำหนด</span>' : '') + (e.doc && e.doc.auto ? ' <span class="pill cu">อลิซแนะนำ</span>' : '') + '</div>' +
      '<div class="d">' + dt(e.at, true) + (e.kind === 'task' ? ' · ' + esc(chOf(e.doc.channel).label) : '') + (e.by ? ' · ' + esc(who(e.by)) : '') + '</div>';
    if (e.body) h += '<div class="b">' + esc(e.body) + '</div>';
    if (e.doc && e.doc.result) h += '<div class="b">ผล: ' + esc(e.doc.result) + '</div>';
    if (e.kind === 'visit') {
      var ph = e.doc.photos || [];
      if (ph.length) h += '<div class="photos">' + ph.map(function (x) { return '<a href="' + esc(x.url) + '" target="_blank" rel="noopener"><img src="' + esc(x.url) + '" alt="รูปกิจกรรม visit" loading="lazy"></a>'; }).join('') + '</div>';
      /* 🚗 v1.1.0 การเดินทาง + ✏️ แก้ไข visit */
      h += tripChip(e.doc.trip);
      if (B.me.sup || String(e.by || '').toLowerCase() === B.me.username.toLowerCase()) h += '<div class="tl-acts"><button class="btn xs" data-vedit="' + esc(e.id) + '">✏️ แก้ไข visit</button>' + (e.doc.trip ? '' : '<button class="btn xs" data-vedit="' + esc(e.id) + '" data-vtrip="1">🚗 ใส่การเดินทาง (เบิกค่าน้ำมัน)</button>') + (e.doc.editedAt ? '<span class="small muted">แก้ล่าสุด ' + dt(e.doc.editedAt, true) + '</span>' : '') + '</div>';
      var a = e.doc.ai;
      if (a) h += '<div class="ai-box" style="margin-top:8px"><h3>🤖 อลิซวิเคราะห์ visit<span style="flex:1"></span><span class="pill ' + (a.interest === 'high' ? 'go' : a.interest === 'low' ? 'skip' : 'wait') + '">สนใจ' + (a.interest === 'high' ? 'มาก' : a.interest === 'low' ? 'น้อย' : 'ปานกลาง') + '</span><span class="pill cu">โอกาส ' + a.chance + '%</span></h3>' +
        (a.summary ? '<p class="verdict" style="margin:0">' + esc(a.summary) + '</p>' : '') + (a.needs.length ? '<div class="lbl">ความต้องการ</div>' + list(a.needs) : '') + (a.objections.length ? '<div class="lbl">ข้อกังวล</div>' + list(a.objections) : '') +
        (a.photoNotes.length ? '<div class="lbl">จากรูป</div>' + list(a.photoNotes) : '') + (a.nextSteps.length ? '<div class="lbl">งานถัดไป (ลงรายการติดตามให้แล้ว)</div>' + list(a.nextSteps.map(function (s) { return chOf(s.channel).icon + ' ' + s.action + ' — ภายใน ' + s.inDays + ' วัน'; })) : '') +
        (a.coach ? '<div class="lbl">โค้ชเซลส์</div><p class="small" style="margin:0">' + esc(a.coach) + '</p>' : '') + '</div>';
      else h += '<div class="tl-acts"><button class="btn xs" data-reai="' + esc(e.id) + '"' + (ui.dr.busy || !B.ai.ready ? ' disabled' : '') + '>🤖 ให้อลิซวิเคราะห์</button></div>';
    }
    if (e.status === 'open' && (e.kind === 'plan' || e.kind === 'task')) {
      h += '<div class="tl-acts">' + (e.kind === 'plan' ? '<button class="btn xs primary" data-visit="' + esc(p.id) + '" data-plan="' + esc(e.id) + '">✅ บันทึก visit</button><a class="btn xs" href="' + esc(gcal(e, p.name, p.address)) + '" target="_blank" rel="noopener">+ Google Calendar</a>'
        : '<button class="btn xs primary" data-done="' + esc(e.id) + '">✓ บันทึกผล</button>') + '<button class="btn xs" data-moveev="' + esc(e.id) + '">เลื่อน</button><button class="btn xs ghost" data-cancelev="' + esc(e.id) + '">ยกเลิก</button></div>';
    }
    return h + '</div></div>';
  }


  /* ═══════════════════════════════════════════════════════════════════
   *  🚗 v1.1.0 การเดินทางของ visit · 💰 ใบขอเบิกค่าเดินทาง · 🧾 ส่งออก JPG / PDF
   *  พี่เอ 21 ต.ค. 69: "… ใส่ location maps ต้นทาง ปลายทาง เพื่อเก็บข้อมูลสรุป ระยะทางของแต่ละ visit นำมาเบิกค่าน้ำมัน …
   *     รถไฟฟ้า กม.ละ 4 บาท · รถน้ำมัน กม.ละ 6 บาท … ทำเอกสารขอเบิกค่าเดินทางของเซลล์แต่ละคน … ฝ่ายบัญชี approve ทำจ่ายในระบบ"
   *  · "และต้องเปิดให้มีการแก้ไข ข้อมูลในส่วนนี้ได้ด้วยนะ" · "เอกสาร Report การ visit ต้อง export เป็น PDF , JPG ได้ด้วยนะ รวมถึงเอกสารขออนุมัติ เบิกจ่ายค่าเดินทาง ด้วย"
   * ═══════════════════════════════════════════════════════════════════ */
  function vehOf(k) { return ((B.trip && B.trip.vehicles) || []).filter(function (v) { return v.key === k; })[0] || { key: k, label: k, icon: '🚗', rate: 0 }; }
  function money(n) { return (Number(n) || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function km1(n) { return (Number(n) || 0).toLocaleString('th-TH', { maximumFractionDigits: 1 }); }
  function newTrip(old) {
    var t = { on: true, origin: null, dest: null, roundTrip: false, vehicle: ui.lastVehicle || 'fuel', km: '', kmNote: '', toll: '', tollNote: '', preview: null, qO: '', qD: '', resO: null, resD: null, busy: '' };
    if (old) { t.origin = old.origin; t.dest = old.dest; t.roundTrip = !!old.roundTrip; t.vehicle = old.vehicle || t.vehicle; t.preview = old; if (old.manual) { t.km = String(old.km); t.kmNote = old.kmNote || ''; } if (old.toll) { t.toll = String(old.toll); t.tollNote = old.tollNote || ''; } }
    else if (ui.lastDest) t.origin = Object.assign({}, ui.lastDest, { src: 'last' });
    return t;
  }
  function loadLastTrip() { if (ui.lastTripAsked) return; ui.lastTripAsked = true; req('/trip/last').then(function (j) { if (j.last) { ui.lastDest = j.last.dest; ui.lastVehicle = j.last.vehicle; } }).catch(function () {}); }
  function ptLine(p) { return p ? '<span class="tp-pt"><b>' + esc(p.label) + '</b><a href="https://www.google.com/maps/search/?api=1&query=' + p.lat + ',' + p.lng + '" target="_blank" rel="noopener">' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + ' ↗</a></span>' : '<span class="tp-pt muted">ยังไม่ได้เลือก</span>'; }
  function ptPicker(t, w) {
    var p = w === 'o' ? t.origin : t.dest, q = w === 'o' ? t.qO : t.qD, res = w === 'o' ? t.resO : t.resD;
    var h = '<div class="tp-row"><div class="tp-lbl"><span class="tp-dot ' + w + '"></span>' + (w === 'o' ? 'ต้นทาง' : 'ปลายทาง') + '</div><div class="tp-main">' + ptLine(p) +
      '<div class="tp-btns"><button type="button" class="btn xs" data-tp="' + w + '-gps"' + (t.busy === w + '-gps' ? ' disabled' : '') + '>' + (t.busy === w + '-gps' ? 'กำลังหาตำแหน่ง…' : '📍 ตำแหน่งตอนนี้') + '</button>' +
      (w === 'o' && B.trip && B.trip.office ? '<button type="button" class="btn xs" data-tp="o-office">🏢 ' + esc(B.trip.office.label) + '</button>' : '') +
      (w === 'o' && ui.lastDest ? '<button type="button" class="btn xs" data-tp="o-last" title="ปลายทางของ visit ก่อนหน้า">↩ จุดก่อนหน้า</button>' : '') +
      (w === 'd' && ui.modal && ui.modal.custAddr ? '<button type="button" class="btn xs" data-tp="d-cust" title="ค้นตำแหน่งจากที่อยู่ลูกค้า">🏭 ที่อยู่ลูกค้า</button>' : '') + '</div>' +
      '<div class="tp-find"><input data-tq="' + w + '" value="' + esc(q) + '" placeholder="วางลิงก์ Google Maps · พิกัด · หรือพิมพ์ชื่อสถานที่" aria-label="ค้นตำแหน่ง' + (w === 'o' ? 'ต้นทาง' : 'ปลายทาง') + '"><button type="button" class="btn xs" data-tp="' + w + '-find"' + (t.busy === w + '-find' ? ' disabled' : '') + '>' + (t.busy === w + '-find' ? 'กำลังค้น…' : 'ค้นหา') + '</button></div>';
    if (res) h += res.length ? '<div class="tp-res">' + res.map(function (r, i) { return '<button type="button" data-tpick="' + w + ':' + i + '">📍 ' + esc(r.label) + '</button>'; }).join('') + '</div>' : '<div class="small muted">ไม่พบสถานที่ — ลองวางลิงก์ Google Maps แทน</div>';
    return h + '</div></div>';
  }
  function tripForm(t) {
    var pv = t.preview, sl = (B.trip && B.trip.srcLabel) || {};
    var h = '<section class="tp"><div class="tp-h"><label class="row"><input type="checkbox" data-tbind="on"' + (t.on ? ' checked' : '') + '> <b>🚗 การเดินทาง · เบิกค่าน้ำมัน + ทางด่วน</b></label><span class="small muted">ไม่ใส่ตอนนี้ก็ได้ — เพิ่มทีหลังในแฟ้มลูกค้า</span></div>';
    if (!t.on) return h + '</section>';
    h += '<div class="tp-veh">' + ((B.trip && B.trip.vehicles) || []).map(function (v) { return '<button type="button" class="tp-v" data-tveh="' + v.key + '" aria-pressed="' + (t.vehicle === v.key) + '"><span>' + v.icon + '</span><b>' + esc(v.label) + '</b><small>' + v.rate + ' บาท / กม.</small></button>'; }).join('') + '</div>';
    h += ptPicker(t, 'o') + ptPicker(t, 'd');
    h += '<label class="row small tp-rt"><input type="checkbox" data-tbind="roundTrip"' + (t.roundTrip ? ' checked' : '') + '> ไป-กลับ (คิดระยะทาง × 2)</label>';
    /* 🛣 v1.4.0 พี่เอ: "ให้ user เพิ่มค่าทางด่วนได้ด้วยนะ สำหรับทำการเบิกค่าเดินทาง" */
    h += '<div class="grid2 tp-toll"><label class="field">🛣 ค่าทางด่วน (บาท) <small>ไม่มีเว้นว่าง · รวมทุกด่านของ visit นี้</small><input inputmode="decimal" data-tbind="toll" value="' + esc(t.toll) + '" placeholder="0"></label>' +
      '<label class="field">ด่าน / เส้นทาง <small>ไม่บังคับ</small><input data-tbind="tollNote" value="' + esc(t.tollNote) + '" placeholder="เช่น ด่านดินแดง → บางนา ไป-กลับ"></label></div>';
    h += '<div class="tp-calc"><button type="button" class="btn sm dark" data-tp="calc"' + (!t.origin || !t.dest || t.busy === 'calc' ? ' disabled' : '') + '>' + (t.busy === 'calc' ? 'กำลังคำนวณ…' : '📏 คำนวณระยะทาง') + '</button>';
    if (pv) h += '<div class="tp-sum"><div><small>ระยะทาง (' + esc(sl[pv.routeSrc] || pv.routeSrc) + ')</small><b>' + km1(pv.routeKm) + ' กม.</b></div><div><small>' + esc(vehOf(t.vehicle).label) + '</small><b>× ' + vehOf(t.vehicle).rate + ' บาท</b></div><div class="amt"><small>ขอเบิก' + (tollOf(t) ? ' (รวมทางด่วน ฿' + money(tollOf(t)) + ')' : '') + '</small><b data-tamt="1">฿' + money(tripAmt(t, pv)) + '</b></div>' +
      '<a class="btn xs" href="' + esc(pv.mapsUrl) + '" target="_blank" rel="noopener">🗺 ดูเส้นทาง</a></div>' +
      '<div class="grid2"><label class="field">ระยะที่ขอเบิก (กม.) <small>แก้ได้ถ้าไม่ตรงความจริง</small><input inputmode="decimal" data-tbind="km" value="' + esc(t.km) + '" placeholder="' + km1(pv.routeKm) + '"></label>' +
      '<label class="field">เหตุผลที่แก้ระยะ <small>ต้องใส่ถ้าแก้ระยะ</small><input data-tbind="kmNote" value="' + esc(t.kmNote) + '" placeholder="เช่น อ้อมเพราะถนนปิด · ตามเลขไมล์"></label></div>' +
      (pv.routeSrc === 'est' ? '<p class="small" style="color:var(--wait);margin:0">⚠️ ระยะนี้ประมาณจากเส้นตรง (ระบบแผนที่ไม่ตอบ) — ตรวจกับ Google Maps แล้วแก้ระยะได้</p>' : '');
    else if (t.origin && t.dest) h += '<span class="small muted">กด "คำนวณระยะทาง" เพื่อดูยอดเบิก</span>';
    return h + '</div></section>';
  }
  function tollOf(t) { var v = Number(String((t && t.toll) || '').replace(/[,\s฿]/g, '')); return v > 0 ? v : 0; }
  function tripAmt(t, pv) { return (Number(t.km) > 0 ? Number(t.km) : pv.routeKm) * vehOf(t.vehicle).rate + tollOf(t); }
  function tripPayload(t) {
    if (!t || !t.on) return null;
    if (!t.origin || !t.dest) return 'need';
    return { origin: t.origin, dest: t.dest, roundTrip: t.roundTrip, vehicle: t.vehicle, km: t.km === '' ? undefined : Number(t.km), kmNote: t.kmNote, toll: tollOf(t), tollNote: t.tollNote };
  }
  function tripAct(a, t) {
    var w = a.charAt(0), set = function (p) { if (w === 'o') { t.origin = p; t.resO = null; } else { t.dest = p; t.resD = null; } t.preview = null; drawModal(); if (t.origin && t.dest) tripAct('calc', t); };
    if (/-gps$/.test(a)) {
      if (!navigator.geolocation) return toast('เครื่องนี้หาตำแหน่งไม่ได้ — วางลิงก์ Google Maps แทน', true);
      t.busy = a; drawModal();
      navigator.geolocation.getCurrentPosition(function (pos) { t.busy = ''; set({ label: (w === 'o' ? 'ต้นทาง' : 'ปลายทาง') + ' (GPS ' + new Date().toTimeString().slice(0, 5) + ')', lat: pos.coords.latitude, lng: pos.coords.longitude, src: 'gps' }); },
        function (e) { t.busy = ''; drawModal(); toast(e.code === 1 ? 'ไม่ได้อนุญาตตำแหน่ง — เปิดสิทธิ์ตำแหน่งให้เบราว์เซอร์ หรือวางลิงก์ Google Maps' : 'หาตำแหน่งไม่ได้ — ลองใหม่ / วางลิงก์ Google Maps', true); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
      return;
    }
    if (a === 'o-office') return set(Object.assign({}, B.trip.office, { src: 'office' }));
    if (a === 'o-last') return set(Object.assign({}, ui.lastDest, { src: 'last' }));
    if (a === 'd-cust' || /-find$/.test(a)) {
      var q = a === 'd-cust' ? ui.modal.custAddr : (w === 'o' ? t.qO : t.qD);
      if (!String(q || '').trim()) return toast('พิมพ์ชื่อสถานที่ หรือวางลิงก์ Google Maps ก่อน', true);
      t.busy = a === 'd-cust' ? 'd-find' : a; drawModal();
      req('/geo?q=' + encodeURIComponent(q)).then(function (j) {
        t.busy = '';
        var items = (j.items || []).map(function (r) { var lb = /^https?:|^-?\d+\.\d+\s*,/.test(r.label) ? (w === 'd' ? (ui.modal.name || 'ปลายทาง') + ' (พิกัดจากลิงก์)' : 'ต้นทาง (พิกัดจากลิงก์)') : r.label; return { label: lb, lat: r.lat, lng: r.lng, src: a === 'd-cust' ? 'customer' : /^https?:/.test(r.label) ? 'link' : 'search' }; });
        if (items.length === 1) return set(items[0]);
        if (w === 'o') t.resO = items; else t.resD = items; drawModal();
      }).catch(function (e) { t.busy = ''; drawModal(); toast(e.message, true); });
      return;
    }
    if (a === 'calc') {
      var pl = tripPayload(t); if (!pl || pl === 'need') return;
      t.busy = 'calc'; drawModal();
      req('/trip/preview', { trip: { origin: pl.origin, dest: pl.dest, roundTrip: pl.roundTrip, vehicle: pl.vehicle } }).then(function (j) { t.busy = ''; t.preview = j.trip; drawModal(); }).catch(function (e) { t.busy = ''; drawModal(); toast(e.message, true); });
    }
  }
  function tripChip(tr) {
    if (!tr) return '';
    return '<div class="trip-chip"><span class="tc-r"><i class="tp-dot o"></i>' + esc(tr.origin.label) + '<span class="tc-ar">→</span><i class="tp-dot d"></i>' + esc(tr.dest.label) + (tr.roundTrip ? ' <span class="pill">ไป-กลับ</span>' : '') + '</span>' +
      '<span class="tc-n"><b>' + km1(tr.km) + ' กม.</b> · ' + esc(vehOf(tr.vehicle).icon + ' ' + vehOf(tr.vehicle).label) + (tr.toll ? ' · 🛣 ทางด่วน ฿' + money(tr.toll) : '') + ' · <b>฿' + money(tr.amount) + '</b>' + (tr.manual ? ' <span class="pill wait" title="' + esc(tr.kmNote) + '">แก้ระยะเอง</span>' : '') + (tr.claimId ? ' <span class="pill info">อยู่ในใบเบิก</span>' : '') +
      ' <a href="' + esc(tr.mapsUrl) + '" target="_blank" rel="noopener">เส้นทาง ↗</a></span></div>';
  }
  /* แก้ visit ที่บันทึกแล้ว */
  function openEdit(e, p) {
    loadLastTrip();
    modal({ type: 'vedit', id: e.id, pid: p.id, name: p.name, custAddr: p.address || p.name, at: localInput(e.at), people: (e.doc && e.doc.people) || '', note: e.body || '', photosOld: ((e.doc && e.doc.photos) || []).slice(), removed: [], photos: [], trip: Object.assign(newTrip(e.doc && e.doc.trip), { on: !!(e.doc && e.doc.trip) }), hadTrip: !!(e.doc && e.doc.trip) });
  }

  /* ═══ ส่งออก JPG / PDF (ทำในเบราว์เซอร์ — html2canvas + jsPDF จาก cdnjs โหลดเมื่อกดเท่านั้น) ═══ */
  var XLIB = { h2c: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', pdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js' };
  function xLoad(src) { return new Promise(function (ok, bad) { if ((src === XLIB.h2c && window.html2canvas) || (src === XLIB.pdf && window.jspdf)) return ok(); var s = document.createElement('script'); s.src = src; s.async = true; s.crossOrigin = 'anonymous'; s.onload = function () { ok(); }; s.onerror = function () { bad(new Error('โหลดตัวช่วยสร้างไฟล์ไม่ได้ — ตรวจอินเทอร์เน็ตแล้วลองใหม่')); }; document.head.appendChild(s); }); }
  function xSave(blob, name) { var url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 4000); }
  function exportDoc(sel, kind, name, btn) {
    var el = document.querySelector(sel); if (!el) return toast('ไม่พบเอกสาร', true);
    if (ui.xBusy) return; ui.xBusy = true; if (btn) btn.disabled = true;
    toast(kind === 'pdf' ? 'กำลังสร้าง PDF…' : 'กำลังสร้าง JPG…');
    var imgs = Array.prototype.slice.call(el.querySelectorAll('img'));
    (kind === 'pdf' ? Promise.all([xLoad(XLIB.h2c), xLoad(XLIB.pdf)]) : xLoad(XLIB.h2c))
      .then(function () { return Promise.all(imgs.map(function (im) { return im.complete ? null : new Promise(function (ok) { im.onload = im.onerror = function () { ok(); }; }); })); })
      .then(function () { return window.html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, windowWidth: 1100, scrollX: 0, scrollY: -window.scrollY, onclone: function (doc) { doc.documentElement.setAttribute('data-theme', 'light'); doc.body.classList.add('x-export'); var tg = doc.querySelector(sel); if (tg) { tg.style.width = '1000px'; tg.style.maxWidth = 'none'; tg.style.margin = '0'; } } }); })
      .then(function (cv) {
        var file = String(name || 'document').replace(/[^\w.\-]+/g, '-');
        if (kind === 'jpg') return new Promise(function (ok, bad) { cv.toBlob(function (b) { if (!b) return bad(new Error('ภาพใหญ่เกินไป')); xSave(b, file + '.jpg'); ok(); }, 'image/jpeg', 0.92); });
        var J = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF, pdf = new J('p', 'mm', 'a4'), PW = 210, PH = 297, M = 8, w = PW - M * 2, maxH = PH - M * 2, ppm = cv.width / w, slice = Math.floor(maxH * ppm), y = 0, n = 0;
        while (y < cv.height) { var hh = Math.min(slice, cv.height - y), part = document.createElement('canvas'); part.width = cv.width; part.height = hh; part.getContext('2d').drawImage(cv, 0, y, cv.width, hh, 0, 0, cv.width, hh); if (n) pdf.addPage('a4', 'p'); pdf.addImage(part.toDataURL('image/jpeg', 0.92), 'JPEG', M, M, w, hh / ppm); n++; y += hh; if (cv.height - y < 40) break; }
        xSave(pdf.output('blob'), file + '.pdf');
      })
      .then(function () { toast('✅ บันทึก' + (kind === 'pdf' ? ' PDF' : ' JPG') + ' แล้ว — ดูในโฟลเดอร์ดาวน์โหลด'); })
      .catch(function (e) { toast('สร้างไฟล์ไม่สำเร็จ: ' + (e && e.message || e), true); })
      .then(function () { ui.xBusy = false; if (btn) btn.disabled = false; });
  }
  function xBar(sel, name) {
    return '<div class="xbar no-print"><button class="btn sm" data-x-jpg="' + esc(sel) + '" data-x-name="' + esc(name) + '">🖼 JPG</button><button class="btn sm" data-x-pdf="' + esc(sel) + '" data-x-name="' + esc(name) + '">📄 PDF</button><button class="btn sm" data-act="print">🖨 พิมพ์</button></div>';
  }

  /* ═══ 💰 หน้าเบิกค่าเดินทาง ═══ */
  function curMonth() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function monthLabel(m) { var a = String(m || '').split('-'); return a.length === 2 ? TH_MF[Number(a[1]) - 1] + ' ' + (Number(a[0]) + 543) : m; }
  function stPill(s) { var S = (B.claims && B.claims.status) || {}, x = S[s] || { label: s, icon: '' }; return '<span class="pill st-' + esc(s) + '">' + x.icon + ' ' + esc(x.label) + '</span>'; }
  function loadTrips() {
    if (!B.claims.ready) { render(); return; }
    var m = ui.tMonth || (ui.tMonth = curMonth());
    if (!B.claims.accOnly) req('/claims/pending?month=' + encodeURIComponent(m) + (B.me.sup && ui.tOwner ? '&owner=' + encodeURIComponent(ui.tOwner) : '')).then(function (j) { ui.tPend = j; render(); }).catch(function (e) { toast(e.message, true); });
    req('/claims' + (ui.tStatus ? '?status=' + encodeURIComponent(ui.tStatus) : '')).then(function (j) { ui.tList = j; render(); }).catch(function (e) { toast(e.message, true); });
  }
  function tripView() {
    if (ui.claimDoc) return claimDocView(ui.claimDoc);
    var h = '<div class="page-h"><div><h1>เบิกค่าเดินทาง</h1><p>ระยะทางจาก visit · รถน้ำมัน ' + B.trip.rates.fuel + ' บาท/กม. · รถไฟฟ้า ' + B.trip.rates.ev + ' บาท/กม. · ส่งใบขอเบิกให้บัญชีอนุมัติ / ทำจ่าย</p></div></div>';
    if (!B.claims.ready) return h + '<div class="banner">ยังไม่ได้สร้างตารางใบเบิก — รัน <code>' + esc(B.claims.sqlFile) + '</code> ใน Supabase › SQL Editor แล้วโหลดหน้านี้ใหม่</div>';
    if (!B.claims.accOnly) {
      var P = ui.tPend;
      h += '<section class="card panel"><h2>🧾 ทำใบขอเบิกประจำเดือน<span class="sp"></span><input type="month" class="in" data-bind="tMonth" data-live-trip="1" value="' + esc(ui.tMonth || curMonth()) + '" aria-label="เดือน" style="width:auto">' + (B.me.sup ? ownerSelect(ui.tOwner || '', 'tOwner', true) : '') + '</h2>';
      if (!P) h += '<div class="boot">กำลังโหลด…</div>';
      else {
        h += '<div class="t-sum"><div><small>visit ที่ยังไม่เบิก</small><b>' + P.items.length + '</b></div><div><small>ระยะทางรวม</small><b>' + km1(P.totalKm) + ' กม.</b></div><div><small>ค่าทางด่วนรวม</small><b>฿' + money(P.items.reduce(function (s2, x) { return s2 + (Number(x.toll) || 0); }, 0)) + '</b></div><div class="amt"><small>ยอดขอเบิก</small><b>฿' + money(P.totalAmount) + '</b></div></div>';
        h += P.items.length ? '<div class="tbl-wrap"><table class="tbl trip"><thead><tr><th>วันที่</th><th>ลูกค้า / สถานที่</th><th>ต้นทาง → ปลายทาง</th><th class="ra">ระยะ</th><th>รถ</th><th class="ra">ทางด่วน</th><th class="ra">ยอด</th></tr></thead><tbody>' + P.items.map(function (x) {
          return '<tr data-open="' + esc(x.prospectId) + '"><td data-l="วันที่">' + dt(x.at) + '<div class="small muted">' + (x.planAt ? 'นัด ' + hm(x.planAt) + ' · ' : '') + 'ถึง ' + hm(x.at) + '</div></td><td class="nm"><b>' + esc(x.customer) + '</b><span>' + esc(x.place) + '</span></td>' +
            '<td class="small">' + esc(x.origin.label) + ' → ' + esc(x.dest.label) + (x.roundTrip ? ' · ไป-กลับ' : '') + '</td><td class="ra num">' + km1(x.km) + ' กม.' + (x.manual ? '<div><span class="pill wait">แก้เอง</span></div>' : '') + '</td><td>' + esc(vehOf(x.vehicle).icon) + ' ' + x.rate + '฿</td><td class="ra num">' + tollBtn(x, P.owner.toLowerCase() === B.me.username.toLowerCase() || B.me.sup, 'p') + '</td><td class="ra num"><b>฿' + money(x.amount) + '</b></td></tr>'; }).join('') + '</tbody></table></div>' +
          (P.owner.toLowerCase() === B.me.username.toLowerCase() ? '<div class="row" style="margin-top:12px"><input class="in" data-bind="tNote" value="' + esc(ui.tNote || '') + '" placeholder="หมายเหตุถึงบัญชี (ไม่บังคับ)" style="flex:1;min-width:200px"><button class="btn primary" data-act="claimsubmit"' + (ui.tBusy ? ' disabled' : '') + '>📨 ส่งใบขอเบิกให้บัญชี (' + P.items.length + ' รายการ · ฿' + money(P.totalAmount) + ')</button></div>' : '')
          : '<p class="empty">เดือนนี้ยังไม่มี visit ที่ใส่การเดินทาง (หรือเบิกไปแล้วทั้งหมด) — ตอนบันทึก visit กรอกส่วน "🚗 การเดินทาง"</p>';
        if (P.inClaims && P.inClaims.length) h += '<p class="small muted" style="margin:10px 0 0">อยู่ในใบเบิกแล้ว ' + P.inClaims.length + ' visit</p>';
      }
      h += '</section>';
    }
    var T = ui.tList, sts = ['', 'submitted', 'approved', 'paid', 'rejected'];
    h += '<section class="card panel"><h2>' + (B.claims.acc ? '🏦 ใบขอเบิกทั้งหมด (ฝ่ายบัญชี)' : '📂 ใบขอเบิกของฉัน') + '<span class="sp"></span><span class="chips">' + sts.map(function (s) { return '<button class="chip" data-tstatus="' + s + '" aria-pressed="' + ((ui.tStatus || '') === s) + '">' + (s ? esc(B.claims.status[s].label) : 'ทั้งหมด') + '</button>'; }).join('') + '</span></h2>';
    if (!T) h += '<div class="boot">กำลังโหลด…</div>';
    else h += T.items.length ? '<div class="claims">' + T.items.map(function (c) {
      return '<button class="cl-it" data-claim="' + esc(c.id) + '"><div class="cl-a"><b>' + esc(c.code) + '</b><span>' + esc(c.ownerName || who(c.owner)) + ' · ' + esc(monthLabel(c.month)) + ' · ' + c.count + ' รายการ · ' + km1(c.totalKm) + ' กม.</span></div><div class="cl-b"><b>฿' + money(c.totalAmount) + '</b>' + stPill(c.status) + '</div></button>'; }).join('') + '</div>' : '<p class="empty">ยังไม่มีใบขอเบิก</p>';
    return h + '</section>';
  }
  /* 🛣 v1.4.1 ปุ่มใส่ / แก้ ค่าทางด่วนตรงช่องตาราง (where: p = หน้าทำใบเบิก · c = ใบที่ส่งแล้วรออนุมัติ) */
  function tollBtn(x, can, where) {
    var v = x.toll ? '฿' + money(x.toll) : '—';
    if (!can) return v;
    return '<button type="button" class="btn xs tollb no-x" data-toll="' + esc(x.eventId) + '" data-tw="' + where + '" title="ใส่ / แก้ ค่าทางด่วน">' + (x.toll ? '✎ ' + v : '＋ ทางด่วน') + '</button><span class="x-only">' + v + '</span>';
  }
  function claimDocView(c) {
    var S = B.claims.status, name = c.code + '_travel-claim_' + c.owner + '_' + c.month;   /* ชื่อไฟล์ภาษาอังกฤษ — บางเบราว์เซอร์ตั้งชื่อไฟล์ภาษาไทยไม่ได้ (กลายเป็น "download") */
    var h = '<div class="page-h no-print"><div><button class="btn sm ghost" data-act="claimback">← กลับ</button><h1 style="margin-top:6px">' + esc(c.code) + '</h1><p>' + stPill(c.status) + '</p></div><div class="acts">' + xBar('#claimDoc', name) + '</div></div>';
    var acts = '', cTollOk = c.status === 'submitted' && (B.me.sup || c.owner.toLowerCase() === B.me.username.toLowerCase());
    if (B.claims.acc && c.status === 'submitted') acts += '<button class="btn primary" data-cact="approve">✅ อนุมัติ</button><button class="btn danger" data-cact="reject">↩️ ตีกลับ</button>';
    if (B.claims.acc && c.status === 'approved') acts += '<button class="btn primary" data-cact="paid">💸 บันทึกทำจ่ายแล้ว</button><button class="btn danger" data-cact="reject">↩️ ตีกลับ</button>';
    if (!B.claims.acc && c.status === 'submitted' && c.owner.toLowerCase() === B.me.username.toLowerCase()) acts += '<button class="btn" data-cact="cancel">ถอนใบเบิก (แก้แล้วส่งใหม่)</button>';
    if (cTollOk) acts += '<span class="small muted">🛣 มีค่าทางด่วน? กด "＋ ทางด่วน" ในตารางได้เลย (ก่อนบัญชีอนุมัติ)</span>';
    if (acts) h += '<div class="card panel no-print acc-bar"><b>' + (B.claims.acc ? '🏦 ฝ่ายบัญชี' : 'ใบเบิกของฉัน') + '</b><span class="sp"></span>' + acts + '</div>';
    if (c.status === 'rejected') h += '<div class="banner no-print">↩️ ตีกลับโดย ' + esc(c.rejectedBy) + ' · ' + dt(c.rejectedAt, true) + ' — ' + esc(c.rejectReason) + ' · visit ในใบนี้แก้ไขและส่งใหม่ได้แล้ว</div>';
    h += '<article class="xdoc" id="claimDoc"><header class="xd-h"><img src="/brand/logo.png" alt="" onerror="this.remove()"><div><b>มดงานการป้าย</b><small>ใบขอเบิกค่าเดินทาง (ค่าน้ำมัน + ทางด่วน) · Leads &amp; Customer Visit</small></div><div class="xd-code"><b>' + esc(c.code) + '</b><small>' + esc(S[c.status].label) + '</small></div></header>' +
      '<div class="xd-meta"><div><small>ผู้ขอเบิก</small><b>' + esc(c.ownerName || who(c.owner)) + '</b></div><div><small>ประจำเดือน</small><b>' + esc(monthLabel(c.month)) + '</b></div><div><small>วันที่ส่ง</small><b>' + dt(c.submittedAt, true) + '</b></div><div><small>อัตรา</small><b>รถน้ำมัน ' + B.trip.rates.fuel + ' · รถไฟฟ้า ' + B.trip.rates.ev + ' บาท/กม.</b></div></div>' +
      '<table class="xd-t"><colgroup><col style="width:28px"><col style="width:104px"><col style="width:190px"><col style="width:124px"><col><col style="width:70px"><col style="width:80px"><col style="width:76px"><col style="width:90px"></colgroup><thead><tr><th>#</th><th>วันที่ · เวลา</th><th>ลูกค้า · สถานที่</th><th>ภาพ visit</th><th>เส้นทาง (location)</th><th class="ra">ระยะ (กม.)</th><th>รถ · อัตรา</th><th class="ra">ทางด่วน (บาท)</th><th class="ra">ขอเบิก (บาท)</th></tr></thead><tbody>' +
      c.items.map(function (x) {
        return '<tr><td>' + x.n + '</td><td class="nw">' + dt(x.at) + '<div class="sm">' + (x.planAt ? 'นัด ' + hm(x.planAt) + '<br>' : '') + 'เข้าพบ ' + hm(x.at) + '</div></td><td><b>' + esc(x.customer) + '</b><div class="sm">' + esc(x.place) + '</div>' + (x.people ? '<div class="sm">พบ: ' + esc(x.people) + '</div>' : '') + '</td>' +
          '<td><div class="xd-ph">' + (x.photos.length ? x.photos.map(function (u) { return '<img src="' + esc(u) + '" alt="ภาพ visit">'; }).join('') : '<span class="sm">—</span>') + '</div></td>' +
          '<td><div class="sm"><i class="tp-dot o"></i>' + esc(x.origin.label) + '<br><span class="xco">' + x.origin.lat.toFixed(5) + ', ' + x.origin.lng.toFixed(5) + '</span></div><div class="sm"><i class="tp-dot d"></i>' + esc(x.dest.label) + '<br><span class="xco">' + x.dest.lat.toFixed(5) + ', ' + x.dest.lng.toFixed(5) + '</span></div>' +
          (x.manual ? '<div class="sm warn">✎ แก้ระยะเอง: ' + esc(x.kmNote) + ' (ตามแผนที่ ' + km1(x.routeKm) + ' กม.)</div>' : '') + '<a class="sm no-x" href="' + esc(x.mapsUrl) + '" target="_blank" rel="noopener">🗺 เปิดแผนที่</a></td>' +
          '<td class="ra nw">' + km1(x.km) + (x.roundTrip ? '<div class="sm">ไป-กลับ</div>' : '') + (x.manual ? '<div class="sm warn">แก้เอง</div>' : '') + '</td><td class="nw">' + esc(vehOf(x.vehicle).label) + '<div class="sm">' + x.rate + ' บาท/กม.</div></td><td class="ra">' + (cTollOk ? tollBtn(x, true, 'c') : (x.toll ? money(x.toll) : '—')) + (x.tollNote ? '<div class="sm">' + esc(x.tollNote) + '</div>' : '') + '</td><td class="ra"><b>' + money(x.amount) + '</b>' + (x.toll ? '<div class="sm">น้ำมัน ' + money(x.fuelAmount != null ? x.fuelAmount : x.amount - x.toll) + '</div>' : '') + '</td></tr>'; }).join('') +
      '</tbody><tfoot><tr><td colspan="5" class="ra"><b>รวม ' + c.items.length + ' รายการ</b></td><td class="ra"><b>' + km1(c.totalKm) + '</b></td><td></td><td class="ra"><b>' + money(c.items.reduce(function (s2, x) { return s2 + (Number(x.toll) || 0); }, 0)) + '</b></td><td class="ra"><b>฿' + money(c.totalAmount) + '</b></td></tr></tfoot></table>' +
      (c.note ? '<p class="xd-note">หมายเหตุ: ' + esc(c.note) + '</p>' : '') +
      '<div class="xd-sign"><div><small>ผู้ขอเบิก</small><b>' + esc(c.ownerName || who(c.owner)) + '</b><span>' + dt(c.submittedAt) + '</span></div>' +
      '<div><small>ผู้อนุมัติ (ฝ่ายบัญชี)</small><b>' + esc(c.approvedBy || '………………………') + '</b><span>' + (c.approvedAt ? dt(c.approvedAt) : 'วันที่ ……………') + '</span></div>' +
      '<div><small>ผู้จ่ายเงิน</small><b>' + esc(c.paidBy || '………………………') + '</b><span>' + (c.paidAt ? 'จ่าย ' + esc(c.payDate || dt(c.paidAt)) + (c.payRef ? ' · อ้างอิง ' + esc(c.payRef) : '') : 'วันที่ ……………') + '</span></div></div></article>';
    return h;
  }
  function openClaim(id) { req('/claim/' + encodeURIComponent(id)).then(function (j) { ui.claimDoc = j.claim; ui.view = 'trip'; render(); window.scrollTo(0, 0); }).catch(function (e) { toast(e.message, true); }); }
  function claimAct(a) {
    var c = ui.claimDoc; if (!c) return;
    var done = function (msg) { toast(msg); openClaim(c.id); ui.tList = null; ui.tPend = null; loadTrips(); };
    if (a === 'approve') return modal({ type: 'confirm', title: 'อนุมัติใบเบิก ' + c.code + '?', text: c.ownerName + ' · ' + c.items.length + ' รายการ · ฿' + money(c.totalAmount), run: function () { return req('/claim/approve', { id: c.id }).then(function () { done('อนุมัติแล้ว — รอทำจ่าย'); }); } });
    if (a === 'cancel') return modal({ type: 'confirm', title: 'ถอนใบเบิก ' + c.code + '?', text: 'visit ในใบนี้จะกลับมาแก้ไข / ส่งใหม่ได้', run: function () { return req('/claim/cancel', { id: c.id }).then(function () { done('ถอนใบเบิกแล้ว'); }); } });
    if (a === 'reject') return modal({ type: 'creject', id: c.id, code: c.code, reason: '' });
    if (a === 'paid') return modal({ type: 'cpaid', id: c.id, code: c.code, amount: c.totalAmount, ref: '', date: ymd(new Date()) });
  }

  /* ═══ 📥🤖 v1.2.0 เพิ่มลูกค้าที่เซลส์หาไว้เอง + อลิซวิเคราะห์ว่าควรโฟกัสไหม
   *  พี่เอ 22 ต.ค. 69: "… ให้ ทีมขาย ใส่ชื่อลูกค้าของตัวเองที่หาไว้ก่อนแล้ว ให้เราช่วยวิเคราะห์ให้ด้วยนะ ว่าลูกค้าแต่ละรายเป็นอย่างไร ควรโฟกัสหรือไม่" ═══ */
  function manualTabs(m) {
    return '<div class="seg-tg mtabs"><button type="button" data-mmode="one" aria-pressed="' + (m.mode !== 'many') + '">รายเดียว</button><button type="button" data-mmode="many" aria-pressed="' + (m.mode === 'many') + '">หลายราย (วางรายชื่อ)</button></div>';
  }
  function aiCheck(m) {
    return B.ai.ready ? '<label class="ai-chk"><input type="checkbox" data-mbind="ai"' + (m.ai ? ' checked' : '') + '><span><b>🤖 ให้อลิซวิเคราะห์ทันที</b><small>ค้นเว็บ · ดูธุรกิจ/ขนาด/สัญญาณ · ให้คะแนน · บอกว่าควรโฟกัสไหม และควรเสนออะไร (~1 นาที/ราย)</small></span></label>'
      : '<p class="small muted" style="margin:0">⚠️ ยังไม่ได้ตั้งกุญแจ AI — เพิ่มลูกค้าได้ แต่อลิซยังวิเคราะห์ให้ไม่ได้</p>';
  }
  function parseBulk(t) {
    var seen = {}, out = [];
    String(t || '').split(/\r?\n/).forEach(function (ln) {
      ln = ln.replace(/^\s*(?:\d+[.)]|[-•*·])\s*/, '').trim(); if (ln.length < 2) return;
      var f = ln.split(/\t|\s\|\s|\|/).map(function (x) { return x.trim(); });
      var name = f[0]; if (!name || name.length < 2) return;
      var k = name.toLowerCase().replace(/\s+/g, ''); if (seen[k]) return; seen[k] = 1;
      var rest = f.slice(1), phone = '', prov = '', note = [];
      rest.forEach(function (x) { if (!x) return; if (!phone && /^[+\d][\d\s\-().]{6,}$/.test(x)) phone = x; else if (!prov && x.length <= 30 && !/\s.*\s.*\s/.test(x)) prov = x; else note.push(x); });
      out.push({ name: name.slice(0, 160), province: prov, phone: phone, note: note.join(' · ').slice(0, 500) });
    });
    return out;
  }
  function bulkCountText(t) { var n = parseBulk(t).length; return n ? 'พบ ' + n + ' ราย' + (n > 30 ? ' — เกิน 30 ราย แบ่งส่งเป็นหลายรอบ' : '') + ' · ชื่อซ้ำในรายการตัดออกให้ · บริษัทที่มีในระบบแล้วไม่สร้างซ้ำ' : 'ยังไม่มีรายชื่อ'; }
  var impTimer = 0;
  function openImp(job) { clearTimeout(impTimer); modal({ type: 'imp', job: job }); pollImp(); }
  function pollImp() {
    clearTimeout(impTimer);
    var m = ui.modal; if (!m || m.type !== 'imp' || !m.job || m.job.finished) { loadList(); return; }
    impTimer = setTimeout(function () {
      req('/prospect/job/' + encodeURIComponent(m.job.id)).then(function (j) { if (ui.modal !== m) return; var was = m.job.done; m.job = j.job; drawModal(); if (j.job.done !== was) loadList(); pollImp(); })
        .catch(function (e) { if (ui.modal === m) { m.err = e.message; drawModal(); } });
    }, 2000);
  }
  var FOCUS = { go: ['go', '✅ ควรโฟกัส'], wait: ['wait', '⏸ รอก่อน'], skip: ['skip', '✋ ยังไม่ควรโฟกัส'] };
  function impView(m) {
    var j = m.job || { items: [] }, its = j.items || [], dn = its.filter(function (x) { return x.status === 'done'; });
    var cnt = function (f) { return dn.filter(function (x) { return x.fit === f; }).length; };
    var pct = j.total ? Math.round(j.done / j.total * 100) : 100;
    var order = { go: 0, wait: 1, skip: 2 };
    var rows = its.slice().sort(function (a, b) { var A = a.status === 'done' ? order[a.fit] : 3, Bb = b.status === 'done' ? order[b.fit] : 3; return A - Bb || (b.score || 0) - (a.score || 0); });
    return '<h3>🤖 อลิซวิเคราะห์ลูกค้าของคุณ</h3>' +
      (j.finished ? '' : '<div class="imp-prog"><div class="prog"><i style="width:' + pct + '%"></i></div><span>' + 'วิเคราะห์แล้ว ' + j.done + ' จาก ' + j.total + ' ราย (ผ่านไป ' + j.sec + ' วินาที) — ปิดหน้าต่างนี้ได้ อลิซทำต่อเบื้องหลัง ผลขึ้นในแฟ้มลูกค้า</span></div>') +
      (m.err ? '<p class="banner">' + esc(m.err) + '</p>' : '') +
      (dn.length ? '<div class="imp-sum"><span class="pill go">✅ ควรโฟกัส ' + cnt('go') + '</span><span class="pill wait">⏸ รอก่อน ' + cnt('wait') + '</span><span class="pill skip">✋ ยังไม่ควรโฟกัส ' + cnt('skip') + '</span></div>' : '') +
      '<div class="imp-list">' + rows.map(function (x) {
        var st = x.status === 'done' ? '<span class="pill ' + (FOCUS[x.fit] || FOCUS.wait)[0] + '">' + (FOCUS[x.fit] || FOCUS.wait)[1] + '</span>' + scoreRing(x.score, x.fit)
          : x.status === 'running' ? '<span class="pill info"><span class="spin sm"></span> กำลังวิเคราะห์…</span>' : x.status === 'queued' ? '<span class="pill">รอคิว</span>'
          : x.status === 'other' ? '<span class="pill wait">ของ ' + esc(x.ownerName || x.owner) + '</span>' : x.status === 'error' ? '<span class="pill skip">วิเคราะห์ไม่สำเร็จ</span>' : '<span class="pill">เพิ่มแล้ว</span>';
        return '<div class="imp-it ' + esc(x.status) + '"><div class="imp-h"><b>' + esc(x.name) + '</b>' + (x.existing && x.status !== 'other' ? ' <small class="muted">มีในระบบแล้ว</small>' : '') + '<span class="sp"></span>' + st + '</div>' +
          (x.verdict ? '<p class="imp-v">' + esc(x.verdict) + '</p>' : '') + (x.reasons && x.reasons.length ? list(x.reasons, 'imp-r') : '') +
          (x.note && x.status !== 'done' ? '<p class="small muted" style="margin:2px 0 0">' + esc(x.note) + '</p>' : '') +
          (x.status !== 'other' ? '<button class="btn xs" data-open="' + esc(x.id) + '">เปิดแฟ้มลูกค้า</button>' : '') + '</div>'; }).join('') + '</div>';
  }

  /* ═══════════ หน้าต่างฟอร์ม ═══════════ */
  var mdEl = null;
  function modal(m) {
    if (m.type === 'visit' && !m.trip) { m.trip = newTrip(); loadLastTrip(); var cp = (L && L.items || []).filter(function (x) { return x.id === m.pid; })[0]; if (cp) m.custAddr = cp.address || cp.name; }
    ui.modal = m; drawModal(); setTimeout(function () { var f = mdEl && mdEl.querySelector('input,textarea,select'); if (f) f.focus(); }, 40); }
  function closeModal() { ui.modal = null; if (mdEl) { mdEl.remove(); mdEl = null; } }
  function drawModal() {
    if (!ui.modal) return closeModal();
    if (!mdEl) { mdEl = document.createElement('div'); document.body.appendChild(mdEl); }
    var m = ui.modal, h = '';
    var pick = m.pick ? custPick(m) : '';
    if (m.type === 'plan') h = '<h3>📅 ' + (m.pick ? 'วางแผน visit' : 'นัด visit — ' + esc(m.name)) + '</h3>' + pick + '<div class="grid2"><label class="field">วัน-เวลา<input type="datetime-local" data-mbind="at" value="' + esc(m.at) + '"></label><label class="field">ใช้เวลา (นาที)<input type="number" min="15" step="15" data-mbind="minutes" value="' + esc(m.minutes) + '"></label></div>' +
      '<label class="field">สถานที่<input data-mbind="place" value="' + esc(m.place) + '"></label><label class="field">เป้าหมายของ visit ครั้งนี้<input data-mbind="goal" value="' + esc(m.goal) + '" placeholder="เช่น สำรวจป้ายเดิม · พบฝ่ายจัดซื้อ · นำเสนอตัวอย่างงาน"></label><label class="field">โน้ต<textarea data-mbind="note" style="min-height:70px">' + esc(m.note) + '</textarea></label>';
    else if (m.type === 'follow') h = followForm(m, pick);
    else if (m.type === 'task') h = (m.pick ? '<h3>📞 วางแผนติดตาม (โทร · แชท)</h3>' + pick : '<h3>📞 วางแผนติดตาม — ' + esc(m.name) + '</h3>') + '<label class="field">ช่องทาง<span class="chips">' + B.channels.map(function (c) { return '<button type="button" class="chip" data-mch="' + c.key + '" aria-pressed="' + (m.channel === c.key) + '">' + c.icon + ' ' + esc(c.label) + '</button>'; }).join('') + '</span></label>' +
      '<label class="field">จะติดตามเรื่องอะไร<input data-mbind="title" value="' + esc(m.title) + '" placeholder="เช่น โทรถามผลพิจารณาใบเสนอราคา · ทัก LINE ส่งแบบ"></label><div class="grid2"><label class="field">วัน-เวลาที่จะติดตาม<input type="datetime-local" data-mbind="at" value="' + esc(m.at) + '"></label></div><label class="field">โน้ต<textarea data-mbind="note" style="min-height:60px">' + esc(m.note) + '</textarea></label>';
    else if (m.type === 'visit') h = '<h3>📸 ' + (m.pick ? 'บันทึก visit + รูปหน้างาน' : 'บันทึก visit — ' + esc(m.name)) + '</h3>' + pick + (m.plans && m.plans.length ? '<label class="field">ปิดนัดที่วางแผนไว้<select data-mbind="planId"><option value="">— visit นอกแผน —</option>' + m.plans.map(function (e) { return '<option value="' + esc(e.id) + '"' + (m.planId === e.id ? ' selected' : '') + '>' + esc(dt(e.at) + ' ' + hm(e.at) + ' · ' + e.title) + '</option>'; }).join('') + '</select></label>' : '') + '<label class="field">เวลาที่เข้าพบ<input type="datetime-local" data-mbind="at" value="' + esc(m.at) + '"></label><label class="field">พบใครบ้าง<input data-mbind="people" value="' + esc(m.people) + '" placeholder="เช่น คุณสมชาย ผจก.จัดซื้อ"></label>' +
      '<label class="field">สรุปสั้น ๆ (อลิซใช้วิเคราะห์)<textarea data-mbind="note" placeholder="คุยเรื่องอะไร ลูกค้าต้องการป้ายอะไร งบ/ช่วงเวลา ข้อกังวล นัดหมายถัดไป">' + esc(m.note) + '</textarea></label>' +
      '<div class="field shots">📷 รูปหน้างาน / กิจกรรม (สูงสุด 8 รูป — ป้ายเดิม · ตัวอาคาร · จุดติดตั้ง · ทีมที่พบ)<span class="row"><label class="btn sm">📷 ถ่ายรูป<input type="file" accept="image/*" capture="environment" data-pick="cam" hidden></label><label class="btn sm">🖼 เลือกจากเครื่อง<input type="file" accept="image/*" multiple data-pick="gal" hidden></label></span>' +
      (m.photos.length ? '<div class="photos">' + m.photos.map(function (u, i) { return '<span class="ph"><img src="' + u + '" alt=""><button type="button" data-unpick="' + i + '" aria-label="เอารูปออก">×</button></span>'; }).join('') + '</div>' : '') + '</div>' + tripForm(m.trip);
    else if (m.type === 'vedit') h = '<h3>✏️ แก้ไข visit — ' + esc(m.name) + '</h3><div class="grid2"><label class="field">เวลาที่เข้าพบ<input type="datetime-local" data-mbind="at" value="' + esc(m.at) + '"></label><label class="field">พบใครบ้าง<input data-mbind="people" value="' + esc(m.people) + '"></label></div>' +
      '<label class="field">สรุปสั้น ๆ<textarea data-mbind="note">' + esc(m.note) + '</textarea></label>' +
      '<div class="field shots">📷 รูป visit (รวมไม่เกิน 8 รูป · แตะ × เพื่อเอาออก)<div class="photos">' + m.photosOld.map(function (x, i) { var off = m.removed.indexOf(x.url) >= 0; return '<span class="ph' + (off ? ' off' : '') + '"><img src="' + esc(x.url) + '" alt=""><button type="button" data-unold="' + i + '" aria-label="' + (off ? 'เก็บรูปไว้' : 'เอารูปออก') + '">' + (off ? '↺' : '×') + '</button></span>'; }).join('') +
      m.photos.map(function (u, i) { return '<span class="ph new"><img src="' + u + '" alt=""><button type="button" data-unpick="' + i + '" aria-label="เอารูปออก">×</button></span>'; }).join('') + '</div>' +
      '<span class="row"><label class="btn sm">📷 ถ่ายรูป<input type="file" accept="image/*" capture="environment" data-pick="cam" hidden></label><label class="btn sm">🖼 เพิ่มจากเครื่อง<input type="file" accept="image/*" multiple data-pick="gal" hidden></label></span></div>' + tripForm(m.trip);
    else if (m.type === 'creject') h = '<h3>↩️ ตีกลับใบเบิก ' + esc(m.code) + '</h3><p class="small muted" style="margin:0">เซลส์จะเห็นเหตุผล และแก้ visit แล้วส่งใบใหม่ได้</p><label class="field">เหตุผล *<textarea data-mbind="reason" style="min-height:80px" placeholder="เช่น ระยะทางวันที่ 12 ไม่ตรงกับเลขไมล์ · ขาดรูป visit">' + esc(m.reason) + '</textarea></label>';
    else if (m.type === 'toll') h = '<h3>🛣 ค่าทางด่วน — ' + esc(m.customer) + '</h3><p class="small muted" style="margin:0">' + esc(m.day) + ' · ค่าน้ำมัน ฿' + money(m.fuel) + '</p><div class="grid2"><label class="field">ค่าทางด่วน (บาท) <small>รวมทุกด่าน · ใส่ 0 = ไม่มี</small><input inputmode="decimal" data-mbind="toll" value="' + esc(m.toll) + '" placeholder="0"></label><label class="field">ด่าน / เส้นทาง <small>ไม่บังคับ</small><input data-mbind="tollNote" value="' + esc(m.tollNote) + '" placeholder="เช่น ด่านดินแดง → บางนา ไป-กลับ"></label></div>';
    else if (m.type === 'cpaid') h = '<h3>💸 บันทึกทำจ่าย ' + esc(m.code) + '</h3><p style="margin:0">ยอดจ่าย <b>฿' + money(m.amount) + '</b></p><div class="grid2"><label class="field">วันที่จ่าย<input type="date" data-mbind="date" value="' + esc(m.date) + '"></label><label class="field">เลขอ้างอิง (โอน / เช็ค / เลขเอกสาร PEAK)<input data-mbind="ref" value="' + esc(m.ref) + '"></label></div>';
    else if (m.type === 'manual' && m.mode === 'many') h = '<h3>+ เพิ่มลูกค้าของฉัน</h3>' + manualTabs(m) +
      '<label class="field">วางรายชื่อลูกค้า (บรรทัดละ 1 ราย · ไม่เกิน 30 ราย)<small>รูปแบบ: ชื่อบริษัท | จังหวัด | เบอร์ | โน้ต — ใส่แค่ชื่อก็ได้ · วางจาก Excel (หลายคอลัมน์) ได้เลย</small>' +
      '<textarea data-mbind="bulk" data-mbulk="1" style="min-height:180px" placeholder="บริษัท ไทยเมทัล พาร์ท จำกัด | ระยอง\nโรงแรม ซีบรีซ | ชลบุรี | 038-301-555\nคลินิกฟันสไมล์ 6 สาขา">' + esc(m.bulk || '') + '</textarea></label>' +
      '<p class="small muted" style="margin:0" id="bulkCount">' + bulkCountText(m.bulk) + '</p>' +
      (B.me.sup ? '<label class="field">มอบให้เซลส์' + ownerSelect(m.owner || B.me.username, 'mOwner') + '</label>' : '') + aiCheck(m);
    else if (m.type === 'imp') h = impView(m);
    else if (m.type === 'manual') h = '<h3>+ เพิ่มลูกค้าของฉัน</h3>' + manualTabs(m) + '<div class="grid2"><label class="field">ชื่อบริษัท *<input data-mbind="name" value="' + esc(m.name) + '"></label><label class="field">เบอร์ติดต่อ<input data-mbind="phone" value="' + esc(m.phone) + '"></label>' +
      '<label class="field">กลุ่มธุรกิจ<select data-mbind="segment"><option value="">—</option>' + B.segments.map(function (s) { return '<option value="' + s.key + '"' + (m.segment === s.key ? ' selected' : '') + '>' + esc(s.label) + '</option>'; }).join('') + '</select></label><label class="field">จังหวัด<input data-mbind="province" value="' + esc(m.province) + '"></label></div>' +
      '<label class="field">ที่อยู่<input data-mbind="address" value="' + esc(m.address) + '"></label>' + (B.me.sup ? '<label class="field">มอบให้เซลส์' + ownerSelect(m.owner || B.me.username, 'mOwner') + '</label>' : '') + aiCheck(m);
    else if (m.type === 'move') h = '<h3>เลื่อนเป็นวันไหน</h3><label class="field">วัน-เวลาใหม่<input type="datetime-local" data-mbind="at" value="' + esc(m.at) + '"></label>';
    else if (m.type === 'done') h = '<h3>✓ ทำแล้ว — ' + esc(m.title) + '</h3><label class="field">ผลเป็นอย่างไร (ไม่บังคับ)<textarea data-mbind="result" style="min-height:70px" placeholder="เช่น ลูกค้าขอแก้แบบ นัดส่งใหม่วันศุกร์">' + esc(m.result) + '</textarea></label><label class="row small"><input type="checkbox" data-mbind="next"' + (m.next ? ' checked' : '') + '> ตั้งงานติดตามถัดไปต่อเลย</label>';
    else if (m.type === 'stage') h = '<h3>เปลี่ยนเป็น "' + esc(stageL(m.stage)) + '"</h3><label class="field">' + (m.stage === 'lost' ? 'เหตุผลที่ไม่ได้งาน (ช่วยให้อลิซเรียนรู้)' : 'หมายเหตุ (ไม่บังคับ)') + '<textarea data-mbind="why" style="min-height:70px">' + esc(m.why) + '</textarea></label>' +
      (m.stage === 'won' ? '<label class="field">มูลค่างานที่ปิดได้ (บาท)<input data-mbind="value" inputmode="numeric" value="' + esc(m.value) + '"></label>' : '');
    else if (m.type === 'confirm') h = '<h3>' + esc(m.title) + '</h3><p>' + esc(m.text) + '</p>';
    if (m.type === 'imp') { mdEl.innerHTML = '<div class="modal-bg" data-x="md"><div class="modal wide" role="dialog" aria-modal="true">' + h + '<div class="foot"><button class="btn primary" data-x="md">' + (m.job && m.job.finished ? 'ปิด' : 'ปิด (อลิซวิเคราะห์ต่อเบื้องหลัง)') + '</button></div></div></div>'; return; }
    mdEl.innerHTML = '<div class="modal-bg" data-x="md"><div class="modal' + (m.trip || m.mode === 'many' || m.type === 'follow' ? ' wide' : '') + '" role="dialog" aria-modal="true">' + h + '<div class="foot"><button class="btn" data-x="md">ยกเลิก</button><button class="btn primary" data-act="msave"' + (m.busy ? ' disabled' : '') + '>' + (m.busy ? 'กำลังบันทึก…' : m.type === 'visit' ? 'บันทึก · ให้อลิซวิเคราะห์' : m.type === 'follow' ? '💬 บันทึกการติดตาม' : m.type === 'confirm' ? 'ยืนยัน' : m.type === 'vedit' ? 'บันทึกการแก้ไข' : m.type === 'creject' ? 'ตีกลับ' : m.type === 'cpaid' ? 'บันทึกจ่ายแล้ว' : m.type === 'manual' ? (m.mode === 'many' ? '📥 เพิ่ม ' + parseBulk(m.bulk).length + ' ราย' : 'บันทึก') + (m.ai && B.ai.ready ? ' · ให้อลิซวิเคราะห์' : '') : 'บันทึก') + '</button></div></div></div>';
  }
  /* ═══ 💬 v1.5.0 บันทึกการติดตาม (แชท / โทร) — พี่เอ 7 พ.ย. 69: "ให้เพิ่มส่วนการติดตามลูกค้าที่ไม่การ visit ด้วยนะ
   *   เช่น แชทติดตาม โทรติดตาม ให้กับทีม ขาย online ด้วยนะ เพราะเค้าไม่ได้ออกไปหาลูกค้า" ═══ */
  var FOLLOW_CH = ['call', 'line', 'fb', 'ig', 'email', 'quote', 'other'];
  function newFollow(o) {
    return Object.assign({ type: 'follow', pick: !o || !o.pid, pid: '', name: '', q: '', channel: 'call', outcome: '', at: localInput(Date.now()), note: '', photos: [], taskId: '', taskTitle: '',
      next: true, nextAt: plusDays(3), nextCh: '', nextTitle: '' }, o || {});
  }
  function followForm(m, pick) {
    var chs = FOLLOW_CH.map(function (k) { return chOf(k); });
    var oc = m.outcome ? ocOf(m.outcome) : null, canNext = !(oc && oc.next === false);
    return '<h3>💬 บันทึกการติดตาม' + (m.pick ? '' : ' — ' + esc(m.name)) + '</h3>' + pick +
      (m.taskTitle ? '<p class="fu-task">📌 ปิดงานติดตาม: <b>' + esc(m.taskTitle) + '</b></p>' : '') +
      '<div class="field">ติดตามทางไหน *<span class="chips">' + chs.map(function (c) { return '<button type="button" class="chip" data-mch="' + c.key + '" aria-pressed="' + (m.channel === c.key) + '">' + c.icon + ' ' + esc(c.label) + '</button>'; }).join('') + '</span></div>' +
      '<div class="field">ผลเป็นอย่างไร *<span class="fu-oc">' + (B.outcomes || []).map(function (o) { return '<button type="button" class="fu-ob ' + esc(o.tone) + '" data-moc="' + o.key + '" aria-pressed="' + (m.outcome === o.key) + '"><span>' + o.icon + '</span>' + esc(o.label) + '</button>'; }).join('') + '</span></div>' +
      '<label class="field">คุยอะไรกับลูกค้า *<textarea data-mbind="note" style="min-height:80px" placeholder="เช่น ลูกค้าขอราคาป้ายไฟ 3×1 ม. 2 แบบ · งบไม่เกิน 20,000 · ขอดูแบบก่อนวันศุกร์">' + esc(m.note) + '</textarea></label>' +
      '<label class="field">เวลาที่ติดตาม<input type="datetime-local" data-mbind="at" value="' + esc(m.at) + '"></label>' +
      '<div class="field shots">🖼 ภาพแคปแชท (ไม่บังคับ · สูงสุด 4 รูป)<span class="row"><label class="btn sm">🖼 เลือกภาพแคปหน้าจอ<input type="file" accept="image/*" multiple data-pick="gal" hidden></label></span>' +
      (m.photos.length ? '<div class="photos">' + m.photos.map(function (u, i) { return '<span class="ph"><img src="' + u + '" alt=""><button type="button" data-unpick="' + i + '" aria-label="เอารูปออก">×</button></span>'; }).join('') + '</div>' : '') + '</div>' +
      (canNext ? '<div class="fu-next"><label class="row small"><input type="checkbox" data-mbind="next" data-mredraw="1"' + (m.next ? ' checked' : '') + '> <b>นัดติดตามครั้งถัดไป</b> (ลงปฏิทิน · ขึ้นใน "งานที่ต้องทำ")</label>' +
        (m.next ? '<div class="grid2"><label class="field">วัน-เวลา<input type="datetime-local" data-mbind="nextAt" value="' + esc(m.nextAt) + '"></label><label class="field">จะติดตามเรื่องอะไร<input data-mbind="nextTitle" value="' + esc(m.nextTitle) + '" placeholder="เช่น ส่งแบบ + ถามผลใบเสนอราคา"></label></div>' : '') + '</div>'
        : '<p class="small muted" style="margin:0">ผลนี้ปิดลูกค้ารายนี้แล้ว — ไม่ต้องนัดติดตามต่อ</p>');
  }
  /* ═══ 🔎 v1.5.1 ลูกค้าเดิมในคีย์ยอดขาย — พี่เอ 7 พ.ย. 69: "ในส่วนของลูกค้า ให้สามารถค้นหาลูกค้าเดิมที่มีในระบบ ขึ้นมาทำการ ติดตาม update
   *   โดยไม่ต้อง visit ได้ด้วยนะ เช่น โทรติดตาม chat ติดตาม และลงแผนกิจกรรมในปฏิทินได้เหมือนกับ การ visit สำหรับ user online" ═══ */
  function exRow(x, inModal) {
    var who0 = x.inVisit && !x.inVisit.mine ? '<span class="pill">ดูแลโดย ' + esc(who(x.inVisit.owner)) + '</span>' : '';
    var meta = [x.contact && x.company ? x.contact : '', x.phone, x.jobCode, x.status, x.date, [x.source, x.channel].filter(Boolean).join(' · ')].filter(Boolean).map(esc).join(' · ');
    var acts = who0 ? who0 : inModal ? '<button type="button" class="btn sm primary" data-expick="' + x.row + '">เลือก</button>'
      : (x.inVisit ? '<button class="btn sm" data-open="' + esc(x.inVisit.id) + '">เปิดแฟ้ม</button>' : '') +
        '<button class="btn sm follow" data-exgo="fu:' + x.row + '">💬 บันทึกติดตาม</button><button class="btn sm" data-exgo="tk:' + x.row + '">📞 วางแผนติดตาม</button>';
    return '<div class="ex-it"><div class="ex-main"><b>' + esc(x.company || x.contact) + '</b>' + (x.inVisit ? ' <span class="pill cu">มีในแอปนี้แล้ว</span>' : '') + (x.jobs > 1 ? ' <span class="small muted">' + x.jobs + ' ใบ</span>' : '') +
      '<div class="small muted">' + meta + '</div></div><div class="ex-acts">' + acts + '</div></div>';
  }
  function exResults(st, inModal) {
    if (!st) return '';
    if (st.busy) return '<p class="small muted ex-msg">กำลังค้นในคีย์ยอดขาย…</p>';
    if (st.err) return '<p class="small ex-msg" style="color:var(--skip)">' + esc(st.err) + '</p>';
    if (!st.items) return '';
    if (!st.items.length) return '<p class="small muted ex-msg">ไม่พบ "' + esc(st.q) + '" ในคีย์ยอดขาย' + (st.mineOnly ? ' (ค้นเฉพาะลูกค้าของคุณ)' : '') + '</p>';
    return '<div class="ex-list">' + st.items.map(function (x) { return exRow(x, inModal); }).join('') + '</div>' + (st.mineOnly ? '<p class="small muted ex-msg">แสดงเฉพาะใบที่คุณเป็นเซลส์ผู้ดูแล</p>' : '');
  }
  function exPanel() {
    var st = ui.ex || {};
    return '<section class="card ex-panel"><div class="ex-h"><b>🔎 ลูกค้าเดิมในระบบ (คีย์ยอดขาย)</b><span class="small muted">ค้นแล้วดึงมาติดตามทางแชท / โทร หรือวางแผนในปฏิทิน — ไม่ต้อง visit</span></div>' +
      '<div class="ex-bar"><input class="in" type="search" id="exq" data-bind="exq" value="' + esc(ui.exq || '') + '" placeholder="ชื่อบริษัท · ชื่อผู้ติดต่อ · เบอร์ · รหัสงาน" aria-label="ค้นลูกค้าเดิมในคีย์ยอดขาย"><button class="btn" data-act="exsearch">ค้น</button></div>' +
      exResults(st, false) + '</section>';
  }
  function exSearch(q, target) {
    q = String(q || '').trim(); if (q.length < 2) return toast('พิมพ์อย่างน้อย 2 ตัวอักษร', true);
    var st = { q: q, busy: true }; if (target) target.ex = st; else ui.ex = st;
    var redraw = function () { if (target) { if (ui.modal === target) drawModal(); } else render(); };
    redraw();
    req('/existing?q=' + encodeURIComponent(q)).then(function (j) { st.busy = false; st.items = j.items; st.mineOnly = j.mineOnly; redraw(); })
      .catch(function (e) { st.busy = false; st.err = e.message; redraw(); });
  }
  function exItem(st, row) { return ((st && st.items) || []).filter(function (x) { return String(x.row) === String(row); })[0]; }
  /* ดึงลูกค้าเดิมเข้ามา (หรือใช้ของที่มีแล้ว) ⇒ คืน { id, name } */
  function exAdd(x) {
    if (x.inVisit && x.inVisit.mine) return Promise.resolve({ id: x.inVisit.id, name: x.company || x.contact });
    return req('/existing/add', { row: x.row }).then(function (j) { x.inVisit = { id: j.id, owner: B.me.username, mine: true }; return loadList().then(function () { return { id: j.id, name: j.name }; }); });
  }
  /* 📞 วางแผนติดตาม = งานติดตาม (โทร / แชท) ลงปฏิทิน — เลือกลูกค้าในฟอร์มได้ */
  function newTask(o) { return Object.assign({ type: 'task', pick: !o || !o.pid, pid: '', name: '', q: '', channel: 'call', title: '', at: plusDays(1), note: '' }, o || {}); }
  /* 🧭 v1.0.1 — เลือกลูกค้าในฟอร์ม (กดจากปุ่มใหญ่ ไม่ต้องเปิดแฟ้มก่อน) */
  function custPick(m) {
    var items = (L && L.items || []).filter(function (p) { return p.stage !== 'lost'; });
    var q = (m.q || '').trim().toLowerCase(), list = q ? items.filter(function (p) { return (p.name + ' ' + (p.phone || '') + ' ' + (p.province || '')).toLowerCase().indexOf(q) >= 0; }) : items;
    list = list.slice().sort(function (a, b) { return a.name.localeCompare(b.name, 'th'); });
    var online = m.type === 'follow' || m.type === 'task';
    var addNew = (online && !m.pid && q.length >= 2 ? '<span class="fu-more"><button type="button" class="btn sm" data-act="mexsearch">🔎 ค้น "' + esc((m.q || '').trim()) + '" ในลูกค้าเดิม (คีย์ยอดขาย)</button>' +
        (!items.some(function (p) { return p.name.toLowerCase() === q; }) ? '<button type="button" class="btn sm fu-new" data-act="fnew">+ เพิ่ม "' + esc((m.q || '').trim()) + '" เป็นลูกค้าใหม่</button>' : '') + '</span>' : '') +
      (online && !m.pid ? exResults(m.ex, true) : '');
    if (!items.length) return online ? '<div class="field">ลูกค้า *<input data-mq="1" value="' + esc(m.q || '') + '" placeholder="พิมพ์ชื่อลูกค้า / บริษัท" aria-label="ชื่อลูกค้า">' + addNew + '</div>'
      : '<p class="banner">ยังไม่มีลูกค้าในระบบ — ไปที่ "ค้นหาลูกค้า" หรือ "+ เพิ่มลูกค้าเอง" ก่อน</p>';
    return '<div class="field">ลูกค้า *<input data-mq="1" value="' + esc(m.q || '') + '" placeholder="พิมพ์ค้นชื่อ เบอร์ จังหวัด" aria-label="ค้นลูกค้า"><select data-mpick="1" size="' + Math.min(5, Math.max(2, list.length)) + '" class="pick-list" aria-label="เลือกลูกค้า">' +
      list.map(function (p) { return '<option value="' + esc(p.id) + '"' + (m.pid === p.id ? ' selected' : '') + '>' + esc(p.name + ' · ' + stageL(p.stage) + (B.me.sup ? ' · ' + who(p.owner) : '')) + '</option>'; }).join('') + '</select>' +
      (m.pid ? '' : '<span class="small muted">' + (online ? 'แตะชื่อลูกค้า — ไม่มีในรายการ ค้นในลูกค้าเดิม (คีย์ยอดขาย) หรือเพิ่มเป็นลูกค้าใหม่' : 'แตะชื่อลูกค้าที่จะไป visit') + '</span>') + addNew + '</div>';
  }
  function pickCust(m, id) {
    var p = (L && L.items || []).filter(function (x) { return x.id === id; })[0]; if (!p) return;
    m.pid = p.id; m.name = p.name; m.custAddr = p.address || p.name; if (m.type === 'plan') { m.place = p.address || ''; }
    if (m.type === 'visit') { m.plans = []; m.planId = ''; req('/prospect/' + encodeURIComponent(p.id)).then(function (j) { if (ui.modal !== m) return; m.plans = (j.events || []).filter(function (e) { return e.kind === 'plan' && e.status === 'open'; }).sort(function (a, b) { return a.at - b.at; }); m.planId = m.plans[0] ? m.plans[0].id : ''; drawModal(); }).catch(function () {}); }
    drawModal();
  }
  function plusDays(n, hh) { var d = new Date(); d.setDate(d.getDate() + n); d.setHours(hh == null ? 10 : hh, 0, 0, 0); return localInput(d.getTime()); }
  function resizeImg(file) {
    return new Promise(function (ok, bad) {
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () { var s = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); ok(c.toDataURL('image/jpeg', 0.85)); };
        img.onerror = function () { bad(new Error('เปิดรูปไม่ได้ (ลองเลือกรูป JPG/PNG)')); };
        img.src = fr.result;
      };
      fr.onerror = function () { bad(new Error('อ่านไฟล์ไม่ได้')); };
      fr.readAsDataURL(file);
    });
  }
  function msave() {
    var m = ui.modal; if (!m || m.busy) return;
    var p = ui.dr && ui.dr.data ? ui.dr.data.p : null, after = function () { closeModal(); reloadDr(); loadList(); if (ui.view === 'cal') loadCal(); };
    var fail = function (e) { m.busy = false; drawModal(); toast(e.message, true); };
    var at = function (v) { return new Date(v).toISOString(); };
    if ((m.type === 'plan' || m.type === 'visit' || m.type === 'follow' || m.type === 'task') && !m.pid) return toast('เลือกลูกค้าก่อน', true);
    if (m.type === 'follow') {
      if (!m.outcome) return toast('เลือกผลการติดตาม', true);
      if (m.note.trim().length < 5) return toast('เขียนสั้น ๆ ว่าคุยอะไรกับลูกค้า', true);
      var oc0 = ocOf(m.outcome), wantNext = m.next && oc0.next !== false;
      if (wantNext && new Date(m.nextAt).getTime() <= Date.now()) return toast('วันนัดติดตามครั้งถัดไปต้องเป็นเวลาข้างหน้า', true);
      m.busy = true; drawModal();
      return req('/follow', { prospectId: m.pid, channel: m.channel, outcome: m.outcome, at: at(m.at), note: m.note, photos: m.photos, taskId: m.taskId || '',
        next: wantNext ? { at: at(m.nextAt), channel: m.nextCh || m.channel, title: m.nextTitle } : null })
        .then(function (j) { toast('💬 บันทึกการติดตามแล้ว' + (j.next ? ' · นัดครั้งถัดไป ' + dt(j.next.at) : '') + (oc0.key === 'won' ? ' · 🎉 ปิดการขายได้!' : '')); after(); })
        .catch(fail);
    }
    if (m.type === 'plan') { m.busy = true; drawModal(); req('/plan', { prospectId: m.pid, at: at(m.at), minutes: m.minutes, place: m.place, goal: m.goal, note: m.note, title: 'visit ' + m.name }).then(function (j) { toast('ลงนัดแล้ว' + (j.sales && j.sales.jobCode && !j.sales.existed ? ' · เปิดใบคีย์ยอดขาย ' + j.sales.jobCode : '') + ' — กด "+ Google Calendar" เพื่อเตือนในมือถือได้'); after(); }).catch(fail); }
    else if (m.type === 'task') { if (!m.title.trim()) return toast('พิมพ์ว่าจะติดตามอะไร', true); m.busy = true; drawModal(); req('/task', { prospectId: m.pid, channel: m.channel, title: m.title, at: at(m.at), note: m.note }).then(function (j) { toast('📞 ลงแผนติดตามในปฏิทินแล้ว · ' + dt(new Date(m.at).getTime(), true) + (j && j.sales && j.sales.jobCode && !j.sales.existed ? ' · เปิดใบคีย์ยอดขาย ' + j.sales.jobCode : '')); after(); }).catch(fail); }
    else if (m.type === 'visit') {
      if (m.note.trim().length < 10) return toast('เขียนสรุปสั้น ๆ อย่างน้อย 1 ประโยค', true);
      var tp = tripPayload(m.trip); if (tp === 'need') return toast('ใส่ต้นทาง + ปลายทางให้ครบ — หรือเอาติ๊ก "การเดินทาง" ออกถ้าไม่เบิก', true);
      m.busy = true; drawModal(); if (ui.dr) { ui.dr.busy = 'ai'; }
      if (tp) { ui.lastDest = tp.dest; ui.lastVehicle = tp.vehicle; }
      req('/visit', { prospectId: m.pid, planId: m.planId || '', at: at(m.at), people: m.people, note: m.note, photos: m.photos, trip: tp || undefined }).then(function (j) {
        toast(j.ai ? 'บันทึกแล้ว — อลิซประเมินโอกาสปิด ' + j.ai.chance + '% และลงงานถัดไปให้ ' + (j.tasks || []).length + ' งาน' : (j.note || 'บันทึกแล้ว'), !j.ai && !!j.note);
        if (ui.dr) { ui.dr.busy = false; ui.drTab = 'act'; } closeModal(); if (!ui.dr || ui.dr.id !== m.pid) openP(m.pid, 'act'); else reloadDr(); loadList();
      }).catch(function (e) { if (ui.dr) ui.dr.busy = false; fail(e); });
    }
    else if (m.type === 'manual' && m.mode === 'many') {
      var bl = parseBulk(m.bulk);
      if (!bl.length) return toast('วางรายชื่อลูกค้าก่อน (บรรทัดละ 1 ราย)', true);
      if (bl.length > 30) return toast('ครั้งละไม่เกิน 30 ราย — ตอนนี้ ' + bl.length + ' ราย', true);
      m.busy = true; drawModal();
      req('/prospect/import', { lines: bl, owner: m.owner, analyze: !!(m.ai && B.ai.ready) }).then(function (j) { loadList(); openImp(j.job); }).catch(fail);
    }
    else if (m.type === 'manual') { if (!m.name.trim()) return toast('ต้องมีชื่อบริษัท', true); m.busy = true; drawModal(); var wantAi = !!(m.ai && B.ai.ready); req('/prospect/save', { item: { name: m.name, phone: m.phone, segment: m.segment, province: m.province, address: m.address }, owner: m.owner }).then(function (j) { closeModal(); toast(j.existing ? 'มีบริษัทนี้ในระบบแล้ว — เปิดแฟ้มให้' : wantAi ? 'เพิ่มลูกค้าแล้ว — อลิซกำลังวิเคราะห์ (~1 นาที)' : 'เพิ่มลูกค้าแล้ว'); loadList(); openP(j.id, 'info');
      if (wantAi && !j.existing) { var pid = j.id; setTimeout(function () { if (ui.dr && ui.dr.id === pid) { ui.dr.busy = 'ai'; drawDr(); } }, 50); req('/prospect/analyze', { id: pid }).then(function () { if (ui.dr && ui.dr.id === pid) ui.dr.busy = false; toast('อลิซวิเคราะห์เสร็จแล้ว'); reloadDr(); loadList(); }).catch(function (e) { if (ui.dr && ui.dr.id === pid) { ui.dr.busy = false; drawDr(); } toast(e.message, true); }); } }).catch(fail); }
    else if (m.type === 'move') { m.busy = true; drawModal(); req('/event/update', { id: m.id, at: at(m.at) }).then(function () { toast('เลื่อนแล้ว'); after(); }).catch(fail); }
    else if (m.type === 'done') { m.busy = true; drawModal(); req('/event/update', { id: m.id, status: 'done', result: m.result }).then(function () { toast('เยี่ยม! ทำเครื่องหมายว่าทำแล้ว'); var nx = m.next, pid = m.pid, nm = m.name; after(); if (nx && pid) setTimeout(function () { modal({ type: 'task', pid: pid, name: nm, channel: 'call', title: '', at: plusDays(3), note: '' }); }, 300); }).catch(fail); }
    else if (m.type === 'stage') { m.busy = true; drawModal(); var f = { stage: m.stage, stageWhy: m.why }; if (m.stage === 'won' && m.value) f.value = m.value; req('/prospect/update', { id: m.pid, fields: f }).then(function () { toast(m.stage === 'won' ? '🎉 ยินดีด้วย ปิดการขายได้!' : 'เปลี่ยนขั้นแล้ว'); after(); }).catch(fail); }
    else if (m.type === 'confirm') { m.busy = true; drawModal(); m.run().then(function () { closeModal(); }).catch(fail); }
    else if (m.type === 'vedit') {
      if (m.note.trim().length < 10) return toast('เขียนสรุปสั้น ๆ อย่างน้อย 1 ประโยค', true);
      var te = tripPayload(m.trip); if (te === 'need') return toast('ใส่ต้นทาง + ปลายทางให้ครบ — หรือเอาติ๊ก "การเดินทาง" ออก', true);
      m.busy = true; drawModal();
      req('/visit/edit', { id: m.id, at: at(m.at), people: m.people, note: m.note, removePhotos: m.removed, addPhotos: m.photos, trip: te ? te : (m.hadTrip ? null : undefined) })
        .then(function () { toast('บันทึกการแก้ไขแล้ว'); ui.tPend = null; closeModal(); reloadDr(); loadList(); if (ui.view === 'trip') loadTrips(); }).catch(fail);
    }
    else if (m.type === 'creject') {
      if (String(m.reason || '').trim().length < 3) return toast('พิมพ์เหตุผลที่ตีกลับ', true);
      m.busy = true; drawModal(); req('/claim/reject', { id: m.id, reason: m.reason }).then(function () { closeModal(); toast('ตีกลับแล้ว — เซลส์แก้และส่งใหม่ได้'); openClaim(m.id); loadTrips(); }).catch(fail);
    }
    else if (m.type === 'toll') { m.busy = true; drawModal(); (m.where === 'c' ? req('/claim/toll', { id: m.claimId, eventId: m.eventId, toll: m.toll, tollNote: m.tollNote }) : req('/visit/toll', { id: m.eventId, toll: m.toll, tollNote: m.tollNote }))
      .then(function (j) { closeModal(); toast('🛣 บันทึกค่าทางด่วนแล้ว'); if (m.where === 'c') { ui.claimDoc = j.claim; ui.tList = null; render(); } else { ui.tPend = null; loadTrips(); } }).catch(fail); }
    else if (m.type === 'cpaid') { m.busy = true; drawModal(); req('/claim/paid', { id: m.id, ref: m.ref, date: m.date }).then(function () { closeModal(); toast('💸 บันทึกทำจ่ายแล้ว'); openClaim(m.id); loadTrips(); }).catch(fail); }
  }

  /* ═══════════ เหตุการณ์ ═══════════ */
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('button, a, tr[data-open], [data-x]');
    if (!t) return;
    var d = t.dataset;
    if (d.x === 'dr' && (ev.target === t || t.tagName === 'BUTTON')) return closeDr();
    if (d.x === 'md' && (ev.target === t || t.tagName === 'BUTTON')) return closeModal();
    if (d.toll) {   /* 🛣 v1.4.1 */
      var src = d.tw === 'c' ? (ui.claimDoc && ui.claimDoc.items) : (ui.tPend && ui.tPend.items), x0 = (src || []).filter(function (x) { return x.eventId === d.toll; })[0]; if (!x0) return;
      return modal({ type: 'toll', where: d.tw, claimId: ui.claimDoc && ui.claimDoc.id, eventId: x0.eventId, customer: x0.customer, day: dt(x0.at), fuel: x0.fuelAmount != null ? x0.fuelAmount : x0.amount - (x0.toll || 0), toll: x0.toll ? String(x0.toll) : '', tollNote: x0.tollNote || '' });
    }
    if (d.go) { ui.view = d.go; ui.claimDoc = null; if (d.go === 'trip') loadTrips(); if (d.go === 'cal') loadCal(); if (d.go === 'search' && ui.history === null) ui.history = null; if (d.go === 'report' && !ui.reports) req('/reports').then(function (j) { ui.reports = j.items; render(); }).catch(function () {}); render(); window.scrollTo(0, 0); return; }
    if (d.open) { ev.preventDefault(); if (ui.modal && ui.modal.type === 'imp') closeModal(); return openP(d.open, d.open === (ui.dr && ui.dr.id) ? ui.drTab : 'info'); }
    if (d.stagego !== undefined && ui.view !== 'report') { ui.view = 'list'; ui.mode = 'list'; ui.stage = d.stagego; return render(); }
    if (d.stage !== undefined) { ui.stage = d.stage; return render(); }
    if (d.mode) { ui.mode = d.mode; return render(); }
    if (d.seg) { ui.seg = ui.seg === d.seg ? '' : d.seg; return render(); }
    if (d.cal) { var c = Number(d.cal); ui.calMonth = c === 0 ? monthStart(new Date()) : new Date(ui.calMonth.getFullYear(), ui.calMonth.getMonth() + c, 1); return loadCal(); }
    if (d.tab) { ui.drTab = d.tab; return drawDr(); }
    if (d.copy) { try { navigator.clipboard.writeText(d.copy).then(function () { toast('คัดลอก ' + d.copy + ' แล้ว'); }, function () { toast('คัดลอกไม่ได้ — เลือกตัวเลขแล้วคัดลอกเอง', true); }); } catch (e) { toast('คัดลอกไม่ได้', true); } return; }
    if (d.hist) { ui.result = null; ui.history = []; render(); req('/searches').then(function (j) { ui.history = j.items; render(); }).catch(function (e) { toast(e.message, true); }); return; }
    if (d.oldsearch) { req('/search/' + encodeURIComponent(d.oldsearch)).then(function (j) { ui.result = { id: j.id, items: j.items, engine: j.engine, at: j.at }; ui.seg = j.query.segment || ''; ui.area = j.query.area || ''; ui.extra = j.query.extra || ''; render(); }).catch(function (e) { toast(e.message, true); }); return; }
    if (d.add !== undefined) {
      var it = ui.result && ui.result.items[Number(d.add)]; if (!it) return;
      t.disabled = true;
      req('/prospect/save', { item: it, searchId: ui.result.id, owner: ui.addOwner || '' }).then(function (j) { it.existing = { id: j.id, owner: j.owner || ui.addOwner || B.me.username }; toast(j.existing ? 'มีในระบบแล้ว' : 'เพิ่ม "' + it.name + '" เป็นลูกค้าเป้าหมายแล้ว'); loadList(); render(); })
        .catch(function (e) { t.disabled = false; toast(e.message, true); });
      return;
    }
    if (d.visit) { var pv = d.visit, nm = (L && (L.items.filter(function (x) { return x.id === pv; })[0] || {}).name) || (ui.dr && ui.dr.data && ui.dr.data.p.name) || ''; return modal({ type: 'visit', pid: pv, planId: d.plan || '', name: nm, at: localInput(Date.now()), people: '', note: '', photos: [] }); }
    if (d.planfor) { var pf = (L && L.items.filter(function (x) { return x.id === d.planfor; })[0]) || {}; return modal({ type: 'plan', pid: d.planfor, name: pf.name || '', at: plusDays(1), minutes: 60, place: pf.address || '', goal: '', note: '' }); }
    /* 💬 v1.5.0 "✓ บันทึกผล" ของงานติดตาม ⇒ ฟอร์มบันทึกการติดตาม (ช่องทาง · ผล · นัดครั้งถัดไป) แทนกล่อง "ทำแล้ว" เดิม */
    if (d.done) { var e1 = findEv(d.done); if (!e1) return;
      var ch1 = (e1.doc && e1.doc.channel) || 'call'; if (FOLLOW_CH.indexOf(ch1) < 0) ch1 = 'other';
      return modal(newFollow({ pid: e1.prospectId, name: e1.name || (ui.dr && ui.dr.data && ui.dr.data.p.name) || '', taskId: e1.id, taskTitle: e1.title, channel: ch1 })); }
    if (d.moc && ui.modal) { var o1 = ocOf(d.moc); ui.modal.outcome = d.moc; if (o1.days) ui.modal.nextAt = plusDays(o1.days); if (o1.next === false) ui.modal.next = false; else if (!ui.modal.nextTouched) ui.modal.next = true; return drawModal(); }
    if (d.moveev) { var e2 = findEv(d.moveev); return modal({ type: 'move', id: d.moveev, at: localInput(e2 ? Math.max(e2.at, Date.now()) + 864e5 : Date.now() + 864e5) }); }
    if (d.cancelev) { return modal({ type: 'confirm', title: 'ยกเลิกรายการนี้?', text: 'รายการจะยังอยู่ในประวัติ แต่ไม่นับเป็นงานค้าง', run: function () { return req('/event/update', { id: d.cancelev, status: 'cancelled' }).then(function () { reloadDr(); loadList(); }); } }); }
    if (d.reai) { ui.dr.busy = 'ai'; drawDr(); req('/visit/reanalyze', { id: d.reai }).then(function (j) { ui.dr.busy = false; toast('อลิซวิเคราะห์แล้ว — โอกาส ' + j.ai.chance + '%'); reloadDr(); loadList(); }).catch(function (e) { ui.dr.busy = false; drawDr(); toast(e.message, true); }); return; }
    if (d.setstage) { var pp = ui.dr && ui.dr.data && ui.dr.data.p; if (!pp || pp.stage === d.setstage) return; return modal({ type: 'stage', pid: pp.id, stage: d.setstage, why: '', value: pp.value || '' }); }
    if (d.mch) { ui.modal.channel = d.mch; return drawModal(); }
    /* 🔎 v1.5.1 ลูกค้าเดิมในคีย์ยอดขาย */
    if (d.fufor) { var pf2 = (L && L.items.filter(function (x) { return x.id === d.fufor; })[0]) || {}; return modal(newFollow({ pid: d.fufor, name: pf2.name || '' })); }
    if (d.exgo) { var g = d.exgo.split(':'), xi = exItem(ui.ex, g[1]); if (!xi) return; t.disabled = true;
      return exAdd(xi).then(function (r1) { t.disabled = false; render(); modal(g[0] === 'fu' ? newFollow({ pid: r1.id, name: r1.name }) : newTask({ pid: r1.id, name: r1.name })); })
        .catch(function (e) { t.disabled = false; toast(e.message, true); }); }
    if (d.expick && ui.modal) { var mm2 = ui.modal, xj = exItem(mm2.ex, d.expick); if (!xj || mm2.busy) return; mm2.busy = true; drawModal();
      return exAdd(xj).then(function (r2) { mm2.busy = false; if (ui.modal !== mm2) return; mm2.q = ''; mm2.ex = null; pickCust(mm2, r2.id); drawModal(); toast('ดึง "' + r2.name + '" จากคีย์ยอดขายแล้ว'); })
        .catch(function (e) { mm2.busy = false; drawModal(); toast(e.message, true); }); }
    if (d.mmode && ui.modal) { ui.modal.mode = d.mmode; return drawModal(); }
    if (d.unpick !== undefined) { ui.modal.photos.splice(Number(d.unpick), 1); return drawModal(); }
    /* 🚗💰🧾 v1.1.0 */
    if (d.unold !== undefined && ui.modal) { var ou = ui.modal.photosOld[Number(d.unold)].url, oi = ui.modal.removed.indexOf(ou); if (oi >= 0) ui.modal.removed.splice(oi, 1); else ui.modal.removed.push(ou); return drawModal(); }
    if (d.tp && ui.modal && ui.modal.trip) return tripAct(d.tp, ui.modal.trip);
    if (d.tveh && ui.modal && ui.modal.trip) { ui.modal.trip.vehicle = d.tveh; ui.lastVehicle = d.tveh; return drawModal(); }
    if (d.tpick && ui.modal && ui.modal.trip) { var tk = d.tpick.split(':'), tt = ui.modal.trip, rr = (tk[0] === 'o' ? tt.resO : tt.resD)[Number(tk[1])]; if (tk[0] === 'o') { tt.origin = rr; tt.resO = null; } else { tt.dest = rr; tt.resD = null; } tt.preview = null; drawModal(); if (tt.origin && tt.dest) tripAct('calc', tt); return; }
    if (d.vedit) { var ve = findEv(d.vedit), vp = ui.dr && ui.dr.data && ui.dr.data.p; if (!ve || !vp) return; openEdit(ve, vp); if (d.vtrip) { ui.modal.trip.on = true; drawModal(); } return; }
    if (d.xJpg || d.xPdf) return exportDoc(d.xJpg || d.xPdf, d.xJpg ? 'jpg' : 'pdf', d.xName, t);
    if (d.claim) return openClaim(d.claim);
    if (d.cact) return claimAct(d.cact);
    if (d.tstatus !== undefined) { ui.tStatus = d.tstatus; ui.tList = null; render(); return loadTrips(); }
    if (d.act) return act(d.act, t);
  });
  function findEv(id) {
    var a = (ui.dr && ui.dr.data && ui.dr.data.events || []).filter(function (e) { return e.id === id; })[0];
    if (a) return a;
    return (L && L.agenda || []).concat(ui.cal || []).filter(function (e) { return e.id === id; })[0] || null;
  }
  function act(a, btn) {
    var dr = ui.dr, p = dr && dr.data && dr.data.p;
    if (a === 'search') {
      if (!ui.seg && !ui.extra.trim()) return toast('เลือกกลุ่มธุรกิจ หรือพิมพ์สิ่งที่ต้องการค้นก่อน', true);
      ui.searching = true; ui.result = null; ui.history = null; ui.searchErr = ''; render();
      setTimeout(function () { var bz = document.querySelector('main .busy'); if (bz && bz.getBoundingClientRect().top > window.innerHeight - 120) bz.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, 60);   /* มือถือ: เลื่อนให้เห็นความคืบหน้า */
      /* ⚡ v1.0.2 — เริ่มงานค้นแล้วถามความคืบหน้า ⇒ ชุดไหนเสร็จขึ้นจอก่อน */
      var tok = ui.searchTok = (ui.searchTok || 0) + 1;
      ui.prog = { done: 0, total: 0, sec: 0 };
      req('/search', { segment: ui.seg, area: ui.area, extra: ui.extra, count: ui.count, stream: true }).then(function (j) {
        var poll = function () {
          if (tok !== ui.searchTok) return;
          req('/search/job/' + encodeURIComponent(j.job)).then(function (r) {
            if (tok !== ui.searchTok) return;
            ui.prog = { done: r.done, total: r.total, sec: r.sec };
            var keep = function (list) { var prev = {}; ((ui.result && ui.result.items) || []).forEach(function (x) { if (x.existing) prev[x.name] = x.existing; }); (list || []).forEach(function (x) { if (!x.existing && prev[x.name]) x.existing = prev[x.name]; }); return list; };
            if (r.items && r.items.length) ui.result = { id: r.id || '', items: keep(r.items), engine: r.engine, at: Date.now(), partial: !r.finished };
            if (r.finished) { ui.searching = false; if (r.error) { ui.result = null; ui.searchErr = r.error; toast(r.error, true); } else { ui.searchErr = ''; ui.result = { id: r.id, items: keep(r.items), engine: r.engine, at: Date.now(), partsFailed: r.partsFailed }; } render(); return; }
            render(); setTimeout(poll, 1500);
          }).catch(function (e) { if (tok !== ui.searchTok) return; ui.searching = false; ui.searchErr = e.message; render(); toast(e.message, true); });
        };
        setTimeout(poll, 1200);
      }).catch(function (e) { ui.searching = false; ui.searchErr = e.message; render(); toast(e.message, true); });
    }
    else if (a === 'qplan') modal({ type: 'plan', pick: true, pid: '', name: '', q: '', at: plusDays(1), minutes: 60, place: '', goal: '', note: '' });
    else if (a === 'qfollow') modal(newFollow());
    else if (a === 'qtask') modal(newTask());
    else if (a === 'exsearch') exSearch(ui.exq);
    else if (a === 'exfromq') { ui.exq = ui.q.trim(); exSearch(ui.exq); setTimeout(function () { var e0 = document.querySelector('.ex-panel'); if (e0) e0.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 60); }
    else if (a === 'mexsearch') { if (ui.modal) exSearch(ui.modal.q, ui.modal); }
    else if (a === 'fnew') {
      var mm = ui.modal; if (!mm || mm.busy) return; var nm0 = (mm.q || '').trim(); if (nm0.length < 2) return;
      mm.busy = true; drawModal();
      req('/prospect/save', { item: { name: nm0 }, owner: B.me.username }).then(function (j) { mm.busy = false;
        if (j.existing && !B.me.sup && String(j.owner || '').toLowerCase() !== B.me.username.toLowerCase()) { drawModal(); return toast('"' + nm0 + '" เป็นลูกค้าที่ ' + who(j.owner) + ' ดูแลอยู่ — ให้หัวหน้าโอนให้ก่อน หรือแจ้งเซลส์เจ้าของ', true); }
        toast(j.existing ? 'มีลูกค้ารายนี้ในระบบแล้ว — เลือกให้แล้ว' : 'เพิ่ม "' + nm0 + '" เป็นลูกค้าใหม่แล้ว');
        return loadList().then(function () { if (ui.modal !== mm) return; mm.q = ''; mm.pid = j.id; mm.name = nm0; pickCust(mm, j.id); drawModal(); }); }).catch(function (e) { mm.busy = false; drawModal(); toast(e.message, true); });
    }
    else if (a === 'qvisit') modal({ type: 'visit', pick: true, pid: '', name: '', q: '', planId: '', plans: [], at: localInput(Date.now()), people: '', note: '', photos: [] });
    else if (a === 'aitest') { ui.aiTest = 'กำลังทดสอบ…'; render(); req('/ai/test').then(function (j) { ui.aiTest = j.fail ? '❌ ' + j.engine + ' · ' + Math.round(j.ms / 1000) + ' วิ · ' + j.error : '✅ ' + j.engine + ' ตอบได้ใน ' + Math.round(j.ms / 1000) + ' วินาที' + (j.reply && j.reply.name ? ' (ตัวอย่าง: ' + j.reply.name + ')' : ''); render(); }).catch(function (e) { ui.aiTest = '❌ ' + e.message; render(); }); }
    else if (a === 'clearres') { ui.result = null; ui.searchTok = (ui.searchTok || 0) + 1; ui.searching = false; render(); }
    else if (a === 'manual') modal({ type: 'manual', mode: 'one', ai: true, bulk: '', name: '', phone: '', segment: ui.seg || '', province: ui.area || '', address: '', owner: B.me.username });
    else if (a === 'analyzeall') {
      var ids = L.items.filter(function (p) { return !(p.doc && (p.doc.analyzed || p.doc.ai)) && p.stage !== 'lost' && p.stage !== 'won'; }).slice(0, 30).map(function (p) { return p.id; });
      if (!ids.length) return;
      btn.disabled = true; req('/prospect/analyze-many', { ids: ids }).then(function (j) { openImp(j.job); }).catch(function (e) { btn.disabled = false; toast(e.message, true); });
    }
    else if (a === 'msave') msave();
    else if (a === 'edit') { dr.edit = { name: p.name, phone: p.phone, juristicId: p.juristicId, website: p.website, bizType: p.bizType, province: p.province, value: p.value || '', segment: p.segment, owner: p.owner, address: p.address, note: p.doc.note || '', contacts: JSON.parse(JSON.stringify(p.doc.contacts || [])) }; if (!dr.edit.contacts.length) dr.edit.contacts.push({ name: '', role: '', phone: '', line: '' }); drawDr(); }
    else if (a === 'editcancel') { dr.edit = null; drawDr(); }
    else if (a === 'addcontact') { dr.edit.contacts.push({ name: '', role: '', phone: '', line: '' }); drawDr(); }
    else if (a === 'editsave') { dr.busy = true; drawDr(); var f = Object.assign({}, dr.edit); if (!B.me.sup) delete f.owner; req('/prospect/update', { id: p.id, fields: f }).then(function () { dr.busy = false; dr.edit = null; toast('บันทึกแล้ว'); reloadDr(); loadList(); }).catch(function (e) { dr.busy = false; drawDr(); toast(e.message, true); }); }
    else if (a === 'tosales') { dr.busy = 'sales'; drawDr(); req('/sales-sync', { prospectId: p.id }).then(function (j) { dr.busy = false; toast(j.sales && j.sales.jobCode ? 'รหัสงาน ' + j.sales.jobCode + ' ในคีย์ยอดขายแล้ว' : 'ยังไม่ได้วางแผนติดต่อ'); reloadDr(); loadList(); }).catch(function (e) { dr.busy = false; drawDr(); toast(e.message, true); }); }
    else if (a === 'analyze') { dr.busy = 'ai'; drawDr(); req('/prospect/analyze', { id: p.id }).then(function () { dr.busy = false; toast('อลิซวิเคราะห์เสร็จแล้ว'); reloadDr(); loadList(); }).catch(function (e) { dr.busy = false; drawDr(); toast(e.message, true); }); }
    else if (a === 'finsave' || a === 'finclear') { if (a === 'finsave' && !dr.fin.trim()) return toast('วางข้อความจากหน้า DBD ก่อน', true); dr.busy = true; drawDr(); req('/prospect/fin', a === 'finclear' ? { id: p.id, clear: true } : { id: p.id, text: dr.fin }).then(function (j) { dr.busy = false; dr.fin = ''; toast(j.risk ? 'ประเมินแล้ว: ' + j.risk.label : 'ล้างงบแล้ว'); reloadDr(); loadList(); }).catch(function (e) { dr.busy = false; drawDr(); toast(e.message, true); }); }
    else if (a === 'plan') modal({ type: 'plan', pid: p.id, name: p.name, at: plusDays(1), minutes: 60, place: p.address || '', goal: '', note: '' });
    else if (a === 'follow') modal(newFollow({ pid: p.id, name: p.name }));
    else if (a === 'task') modal(newTask({ pid: p.id, name: p.name, at: plusDays(2) }));
    else if (a === 'visit') { var plan = (dr.data.events || []).filter(function (e) { return e.kind === 'plan' && e.status === 'open'; }).sort(function (x, y) { return x.at - y.at; })[0]; modal({ type: 'visit', pid: p.id, planId: plan ? plan.id : '', name: p.name, at: localInput(Date.now()), people: '', note: '', photos: [] }); }
    else if (a === 'delp') modal({ type: 'confirm', title: 'ลบ "' + p.name + '"?', text: 'ลบลูกค้าและประวัติ visit/งานติดตามทั้งหมดของรายนี้ กู้คืนไม่ได้', run: function () { return req('/prospect/delete', { id: p.id }).then(function () { closeDr(); toast('ลบแล้ว'); loadList(); }); } });
    else if (a === 'report') {
      if (!ui.rpFrom || !ui.rpTo) return toast('เลือกช่วงวันที่', true);
      ui.rpBusy = true; ui.report = null; render();
      req('/report', { from: ui.rpFrom, to: ui.rpTo, owner: ui.rpOwner }).then(function (j) { ui.rpBusy = false; ui.report = j; render(); req('/reports').then(function (x) { ui.reports = x.items; render(); }).catch(function () {}); })
        .catch(function (e) { ui.rpBusy = false; render(); toast(e.message, true); });
    }
    else if (a === 'print') window.print();
    else if (a === 'claimback') { ui.claimDoc = null; render(); }
    else if (a === 'claimsubmit') {
      var P = ui.tPend; if (!P || !P.items.length) return;
      modal({ type: 'confirm', title: 'ส่งใบขอเบิกค่าเดินทาง ' + monthLabel(P.month) + '?', text: P.items.length + ' visit · ' + km1(P.totalKm) + ' กม. · ฿' + money(P.totalAmount) + ' — ส่งแล้ว visit ในใบจะแก้ไม่ได้จนกว่าบัญชีตีกลับ / ถอนใบ',
        run: function () { return req('/claim/submit', { month: P.month, note: ui.tNote || '' }).then(function (j) { ui.tNote = ''; toast('📨 ส่งใบเบิก ' + j.claim.code + ' ให้บัญชีแล้ว'); ui.tPend = null; ui.tList = null; loadTrips(); openClaim(j.claim.id); }); } });
    }
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-oldrp]'); if (!b) return;
    req('/report/' + encodeURIComponent(b.dataset.oldrp)).then(function (j) { ui.report = j; render(); }).catch(function (e) { toast(e.message, true); });
  });
  document.addEventListener('input', function (ev) {
    var el = ev.target, d = el.dataset;
    if (d.bind) { ui[d.bind] = el.type === 'checkbox' ? el.checked : el.value; if (d.live) render(); return; }
    if (d.bindDr && ui.dr) { ui.dr[d.bindDr] = el.value; return; }
    if (d.ebind && ui.dr && ui.dr.edit) { ui.dr.edit[d.ebind] = el.value; return; }
    if (d.cbind && ui.dr && ui.dr.edit) { var k = d.cbind.split('.'); ui.dr.edit.contacts[Number(k[0])][k[1]] = el.value; return; }
    if (d.mbind && ui.modal) { ui.modal[d.mbind] = el.type === 'checkbox' ? el.checked : el.value;
      if (d.mbulk) { var bc = document.getElementById('bulkCount'), sb = mdEl && mdEl.querySelector('[data-act="msave"]'), n = parseBulk(el.value).length; if (bc) bc.textContent = bulkCountText(el.value); if (sb) sb.textContent = '📥 เพิ่ม ' + n + ' ราย' + (ui.modal.ai && B.ai.ready ? ' · ให้อลิซวิเคราะห์' : ''); }
      if (d.mbind === 'ai') drawModal();
      if (d.mredraw) { ui.modal.nextTouched = true; drawModal(); }
      return; }
    if (d.tbind && ui.modal && ui.modal.trip) { var tr0 = ui.modal.trip; if (el.type === 'checkbox') { tr0[d.tbind] = el.checked; if (d.tbind === 'roundTrip') { tr0.preview = null; drawModal(); if (tr0.origin && tr0.dest) tripAct('calc', tr0); } else drawModal(); } else { tr0[d.tbind] = el.value; if ((d.tbind === 'km' || d.tbind === 'toll') && tr0.preview) { var ab = mdEl && mdEl.querySelector('[data-tamt]'); if (ab) ab.textContent = '฿' + money(tripAmt(tr0, tr0.preview)); } } return; }
    if (d.tq && ui.modal && ui.modal.trip) { ui.modal.trip[d.tq === 'o' ? 'qO' : 'qD'] = el.value; return; }
    if (d.mq && ui.modal) { ui.modal.q = el.value; var pos = el.selectionStart; drawModal(); var f = mdEl && mdEl.querySelector('[data-mq]'); if (f) { f.focus(); try { f.setSelectionRange(pos, pos); } catch (e) { /* ไม่เป็นไร */ } } return; }
  });
  document.addEventListener('change', function (ev) {
    var el = ev.target, d = el.dataset;
    if (d.bind === 'owner') { ui.owner = el.value; loadList(); if (ui.view === 'cal') loadCal(); return; }
    if (d.bind === 'mOwner' && ui.modal) { ui.modal.owner = el.value; return; }
    if (d.mpick && ui.modal) { pickCust(ui.modal, el.value); return; }
    if (d.bind === 'addOwner') { ui.addOwner = el.value; return; }
    if (d.bind === 'count') { ui.count = Number(el.value); return; }
    if (d.liveTrip || d.bind === 'tOwner') { ui[d.bind] = el.value; ui.tPend = null; el.blur(); render(); loadTrips(); return; }
    if (d.pick && ui.modal) {
      var cap = ui.modal.type === 'follow' ? 4 : 8;
      var room = cap - ui.modal.photos.length - (ui.modal.photosOld ? ui.modal.photosOld.length - ui.modal.removed.length : 0);
      var files = Array.prototype.slice.call(el.files || []).slice(0, Math.max(0, room));
      if (!files.length && el.files && el.files.length) toast('รูปครบ ' + cap + ' รูปแล้ว — เอารูปเดิมออกก่อน', true);
      Promise.all(files.map(resizeImg)).then(function (urls) { ui.modal.photos = ui.modal.photos.concat(urls).slice(0, cap); drawModal(); }).catch(function (e) { toast(e.message, true); });
      el.value = '';
    }
  });
  document.addEventListener('focusout', function () { setTimeout(function () { if (ui.dirty && !editing()) render(); }, 0); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (ui.modal) closeModal(); else if (ui.dr) closeDr();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target && (ev.target.id === 'area' || ev.target.id === 'extra')) { ev.preventDefault(); act('search'); }
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'exq') { ev.preventDefault(); exSearch(ev.target.value); }
    if (ev.key === 'Enter' && ev.target && ev.target.dataset && ev.target.dataset.mq && ui.modal && (ui.modal.type === 'follow' || ui.modal.type === 'task') && !ui.modal.pid) { ev.preventDefault(); exSearch(ui.modal.q, ui.modal); }
    if (ev.key === 'Enter' && ev.target && ev.target.dataset && ev.target.dataset.tq && ui.modal && ui.modal.trip) { ev.preventDefault(); tripAct(ev.target.dataset.tq + '-find', ui.modal.trip); }
  });

  /* ═══════════ เริ่ม ═══════════ */
  req('/boot').then(function (b) {
    B = b;
    var v = document.getElementById('ver'); if (v) { v.textContent = 'v' + b.version; v.hidden = false; }
    var me = document.getElementById('me'), mu = (b.team || []).filter(function (u) { return u.username.toLowerCase() === b.me.username.toLowerCase(); })[0];
    if (me) me.innerHTML = (mu && mu.image ? '<img src="' + esc(mu.image) + '" alt="">' : '<span class="av">' + esc((b.me.name || '?').replace(/^\(([^)]+)\).*/, '$1').slice(0, 2)) + '</span>') + '<span class="nm">' + esc(b.me.name) + '</span>';   /* 🙋 v1.0.1 — ชื่อเล่นอย่างเดียว */
    var hm0 = /^#(home|search|list|cal|report|trip)$/.exec(location.hash || ''); if (hm0) ui.view = hm0[1];
    if (b.claims && b.claims.accOnly) ui.view = 'trip';   /* 🏦 ฝ่ายบัญชี: เปิดที่ใบเบิกค่าเดินทางเลย */
    render();
    if (b.health.ok) { loadList(); if (ui.view === 'cal') loadCal(); if (ui.view === 'trip') loadTrips(); }
    setInterval(function () { if (!document.hidden && B && B.health.ok && !ui.modal && !editing()) loadList(); }, 60000);
  }).catch(function (e) { app.innerHTML = '<div class="boot">เปิดแอปไม่สำเร็จ: ' + esc(e.message) + '</div>'; });
})();
