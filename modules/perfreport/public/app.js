/* Report & Ranking 🏆 — หน้าจอ (ตัวเลขทั้งหมดมาจากเซิร์ฟเวอร์ · หน้านี้ไม่คิดคะแนนเอง) */
(function () {
  'use strict';
  var API = 'api/';
  var S = { meta: null, tab: 'mine', kind: 'daily', date: '', rep: null, rankPeriod: 'day', rankRole: 'sale', rank: null,
    audit: { user: '', kind: 'daily', date: '', rep: null, status: null }, notes: {}, busy: false };
  var LIB = { h2c: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', pdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js' };
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (n) { return n == null ? '—' : Number(n).toLocaleString('th-TH', { maximumFractionDigits: 1 }); };
  var baht = function (n) { return n == null ? '—' : '฿' + Number(n).toLocaleString('th-TH', { maximumFractionDigits: 0 }); };
  var TH_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  var thDate = function (d) { if (!d) return ''; var p = d.split('-'); return Number(p[2]) + ' ' + TH_M[Number(p[1]) - 1] + ' ' + String(Number(p[0]) + 543).slice(2); };
  var thTime = function (iso) { if (!iso) return ''; var t = new Date(Date.parse(iso) + 7 * 3600e3).toISOString(); return t.slice(11, 16) + ' น.'; };
  var NOTE_KEYS = [['summary', 'สรุปวันนี้', 'งานหลักที่ทำ ผลที่ได้'], ['deals', 'ดีล / ลูกค้าที่สำคัญ', 'ลูกค้า · มูลค่า · ขั้นถัดไป'], ['lost', 'หลุด / แพ้ เพราะอะไร', 'ราคา · เวลา · คู่แข่ง · สเปก'], ['blockers', 'ติดอะไร / ต้องการความช่วยเหลือ', 'เรื่อง · ใครช่วยได้'], ['plan', 'แผนพรุ่งนี้ / สัปดาห์หน้า', 'นัดหมาย · ใบเสนอที่ต้องตาม']];

  function toast(m, bad) { var t = $('toast'); t.textContent = m; t.className = 'on' + (bad ? ' bad' : ''); clearTimeout(toast.t); toast.t = setTimeout(function () { t.className = ''; }, 3200); }
  function api(path, body) {
    return fetch(API + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('หมดเวลาเข้าสู่ระบบ'); }
        return r.json().then(function (j) { if (!r.ok || j.ok === false) throw new Error(j.error || ('ผิดพลาด ' + r.status)); return j; });
      });
  }
  function avatar(u, cls) {
    var name = (u && u.name) || '', ini = (name.match(/\(([^)]+)\)/) || [])[1] || name.trim().charAt(0) || '?';
    if (u && u.photo) return '<img class="av ' + (cls || '') + '" src="' + esc(u.photo) + '" alt="" loading="lazy" referrerpolicy="no-referrer">';
    return '<span class="av ' + (cls || '') + '">' + esc(ini.slice(0, 2)) + '</span>';
  }
  function loadScript(src) { return new Promise(function (ok, no) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = function () { no(new Error('โหลดตัวช่วยทำไฟล์ไม่สำเร็จ — เช็คอินเทอร์เน็ต')); }; document.head.appendChild(s); }); }

  /* ════════ Report ════════ */
  /* 🎨 v1.0.11 ออกแบบใหม่ — พี่เอ: "ปรับ หน้าตา Report ให้ดู Professional สวยงาม และวาง lay out ให้ดีกว่านี้"
   *   แถบหัว (คน · คะแนน · ตัวเลขหลัก 4 ช่อง) ⇒ ซ้าย: ตัวเลขแยกหมวด · ขวา: คะแนนแยกหัวข้อ + จุดที่ควรปรับ ⇒ สรุปเขียนเอง
   *   tone: good / warn / bad = เทียบเกณฑ์ (สีเป็นตัวช่วย มีคำกำกับเสมอ) */
  function stat(label, v, sub, tone) { var na = v == null; return '<div class="stat' + (na ? ' na' : '') + (tone ? ' t-' + tone : '') + '"><span>' + esc(label) + '</span><b class="num">' + (na ? 'ไม่มีข้อมูล' : v) + '</b>' + (sub ? '<em>' + esc(sub) + '</em>' : '') + '</div>'; }
  function replyTone(c) { if (c.avgReplyMin == null) return ''; return c.avgReplyMin <= (c.replyGoalMin || 5) ? 'good' : c.avgReplyMin <= 15 ? 'warn' : 'bad'; }
  function metricCards(m, role) {
    var c = m.chat || {}, s = m.sales || {}, mo = m.money || {}, cu = m.customer || {}, w = m.work || {};
    var h = '';
    h += sec('💬', 'แชท', 'Ant-Connect', [stat('แชทที่รับ / ถูกมอบหมาย', fmt(c.received)), stat('แชทที่ตอบ', fmt(c.chats), fmt(c.replies) + ' ข้อความ'),
      stat('เวลาตอบเฉลี่ย', c.avgReplyMin == null ? '—' : fmt(c.avgReplyMin) + ' นาที', [c.replyPairs ? 'จาก ' + c.replyPairs + ' คู่ถาม-ตอบ' : '', c.replyGoalMin ? 'เป้า ≤ ' + c.replyGoalMin + ' นาที' : ''].filter(Boolean).join(' · '), replyTone(c)),
      stat(c.slaMin ? 'ลูกค้ารอเกิน ' + fmt(c.slaMin) + ' นาที' : 'ลูกค้ารอเกินเวลา', fmt(c.slaBreaches), 'ครั้ง' + (c.slaMin ? ' · ⏱ ลูกค้ารอได้ไม่เกิน ' + fmt(c.slaMin) + ' นาที' : ''), c.slaBreaches == null ? '' : c.slaBreaches ? 'bad' : 'good'),
      stat('ปิดเคส', fmt(c.closed)), stat('สร้าง lead จากแชท', fmt(c.leads))]);
    var sl = [stat('รหัสงานใหม่', fmt(s.jobCodes)), stat('ใบเสนอราคา', fmt(s.quotes), s.quoteValue ? baht(s.quoteValue) : ''), stat('ปิดการขาย', fmt(s.won), s.wonValue != null ? baht(s.wonValue) + ' ก่อน VAT' : '')];
    if (role === 'support') sl.push(stat('งานที่ดูแล (ปิดแล้ว)', fmt(s.supportedWon), s.supportedValue != null ? baht(s.supportedValue) : ''));
    h += sec('🧾', 'การขาย', 'คีย์ยอดขาย', sl);
    var duo = sec('💰', 'เงิน', 'PEAK · ติดตามหนี้', [stat('เงินเข้า (ใบเสร็จ PEAK)', mo.collected == null ? null : baht(mo.collected), mo.receipts != null ? mo.receipts + ' ใบ' : ''),
      stat('วันเก็บเงินเฉลี่ย', mo.avgCollectDays == null ? '—' : fmt(mo.avgCollectDays) + ' วัน', 'เปิดบิล → ได้เงิน'), stat('ติดตามหนี้', fmt(mo.followups), mo.promised ? 'รับปาก ' + baht(mo.promised) : 'ครั้ง'),
      stat('สลิปในแชท', fmt(mo.slips), mo.slipAmount ? baht(mo.slipAmount) : '')], 'half');
    if (role !== 'branch') duo += sec('🧭', 'ลูกค้าใหม่', 'B2B Visit', [stat('ลูกค้าใหม่ที่หาเจอ', fmt(cu.prospects), cu.prospectValue ? 'มูลค่า ' + baht(cu.prospectValue) : ''), stat('visit', fmt(cu.visits)), stat('ติดตามแชท/โทร', fmt(cu.follows)), stat('นัด visit', fmt(cu.plans)), stat('งานติดตาม', fmt(cu.tasks))], 'half');
    var wk = [stat('จองคิวช่าง', fmt(w.bookings)), stat('เปิด Project', fmt(w.projects))];
    if (role === 'branch') wk.push(stat('จบงาน Projects', fmt(w.projectsDone)), stat('สร้าง Job card ผลิต', fmt(w.jobCards)), stat('งานเคลมจากกราฟิค', fmt(w.graphicClaims), 'ยิ่งน้อยยิ่งดี', w.graphicClaims ? 'bad' : w.graphicClaims === 0 ? 'good' : ''));
    duo += sec('🛠', 'งานต่อ', 'Projects · จองคิวช่าง', wk, 'half');
    h += '<div class="duo">' + duo + '</div>';
    var ch = m.channels || {}, keys = Object.keys(ch);
    if (keys.length) {
      keys.sort(function (a, b) { return (ch[b].value - ch[a].value) || (ch[b].chats - ch[a].chats); });
      var mx = Math.max.apply(null, keys.map(function (k) { return Number(ch[k].value) || 0; }).concat([1]));
      h += '<section class="card pad"><h3 class="sec-h"><span class="ic">📡</span><span>แยกช่องทาง<small>เรียงตามมูลค่าที่ปิดได้</small></span></h3><div class="tblw"><table class="ch"><thead><tr><th>ช่องทาง</th><th class="r">แชทที่ตอบ</th><th class="r">ปิดการขาย</th><th class="r">มูลค่า</th></tr></thead><tbody>' +
        keys.map(function (k) { var x = ch[k]; return '<tr><td><b>' + esc(k) + '</b><i class="cbar" style="width:' + Math.round((Number(x.value) || 0) / mx * 100) + '%"></i></td><td class="r num">' + fmt(x.chats) + '</td><td class="r num">' + fmt(x.won) + '</td><td class="r num"><b>' + baht(x.value) + '</b></td></tr>'; }).join('') + '</tbody></table></div></section>';
    }
    return h;
  }
  function sec(ic, title, sub, items, cls) { return '<section class="card pad ' + (cls || '') + '"><h3 class="sec-h"><span class="ic">' + ic + '</span><span>' + esc(title) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span></h3><div class="stats">' + items.join('') + '</div></section>'; }
  function ring(score, dark) {
    var r = 74, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, Number(score) || 0)), col = p >= 80 ? '#2fbf7f' : p >= 50 ? '#f0a92e' : '#ef5a4c';
    return '<div class="ring' + (dark ? ' dark' : '') + '"><svg viewBox="0 0 176 176" aria-hidden="true"><circle cx="88" cy="88" r="' + r + '" fill="none" stroke="' + (dark ? 'rgba(255,255,255,.14)' : '#edf0f3') + '" stroke-width="13"/><circle cx="88" cy="88" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="13" stroke-linecap="round" stroke-dasharray="' + (c * p / 100) + ' ' + c + '"/></svg>' +
      '<div class="v"><div><b class="num">' + fmt(p) + '</b><small>คะแนน / 100</small></div></div></div>';
  }
  function grade(p) { p = Number(p) || 0; return p >= 85 ? ['ยอดเยี่ยม', 'good'] : p >= 70 ? ['ดี', 'good'] : p >= 50 ? ['พอใช้', 'warn'] : ['ต้องปรับ', 'bad']; }
  function breakdown(list) {
    if (!list || !list.length) return '<p class="hint" style="padding:0 18px 16px">ยังไม่มี Daily report ในสัปดาห์นี้</p>';
    return '<ul class="bd">' + list.map(function (x) { var pc = x.max ? Math.max(0, Math.min(100, x.got / x.max * 100)) : 0, t = pc >= 99.9 ? 'good' : pc >= 50 ? 'warn' : 'bad';
      return '<li><div class="row"><b>' + esc(x.label) + '</b><span class="pill t-' + t + ' num">' + fmt(x.got) + '<i>/' + x.max + '</i></span></div>' + (x.why ? '<small>' + esc(x.why) + '</small>' : '') +
        '<div class="meter"><i class="t-' + t + '" style="width:' + pc + '%"></i></div></li>'; }).join('') + '</ul>';
  }
  /** จุดที่ควรปรับ — หัวข้อที่ได้ไม่ถึงครึ่ง (คะแนนที่หายมากสุดก่อน) */
  function improve(list) {
    var lo = (list || []).filter(function (x) { return x.max && x.got / x.max < 0.5 && x.key !== 'report'; })
      .sort(function (a, b) { return (b.max - b.got) - (a.max - a.got); }).slice(0, 3);
    if (!lo.length) return '';
    return '<div class="imp"><b>🎯 จุดที่ควรปรับ</b><ol>' + lo.map(function (x) { return '<li>' + esc(x.label) + ' <span class="num">(หาย ' + fmt(x.max - x.got) + ' คะแนน)</span></li>'; }).join('') + '</ol></div>';
  }
  function kpis(m, role, chatScored) {
    var c = m.chat || {}, s = m.sales || {}, mo = m.money || {}, cu = m.customer || {}, w = m.work || {};
    var k = function (l, v, sub, tone) { return '<div class="kpi' + (tone ? ' t-' + tone : '') + '"><span>' + esc(l) + '</span><b class="num">' + v + '</b><em>' + esc(sub || '') + '</em></div>'; };
    var out = [k('ปิดการขาย', s.wonValue != null ? baht(s.wonValue) : '—', fmt(s.won) + ' งาน · ก่อน VAT')];
    if (role === 'branch') out.push(k('จบงาน Projects', fmt(w.projectsDone), 'Job card ผลิต ' + fmt(w.jobCards) + ' ใบ'));
    else if (role === 'support') out.push(k('งานที่ดูแล (ปิดแล้ว)', s.supportedValue != null ? baht(s.supportedValue) : '—', fmt(s.supportedWon) + ' งาน'));
    else out.push(k('ใบเสนอราคา', fmt(s.quotes), s.quoteValue ? baht(s.quoteValue) : 'ใบ'));
    out.push(k('เงินเข้า', mo.collected == null ? '—' : baht(mo.collected), mo.receipts != null ? mo.receipts + ' ใบเสร็จ PEAK' : ''));
    if (chatScored === false) out.push(k('visit / ลูกค้าใหม่', fmt(cu.visits) + ' / ' + fmt(cu.prospects), 'ครั้ง / ราย'));
    else out.push(k('ตอบแชทเฉลี่ย', c.avgReplyMin == null ? '—' : fmt(c.avgReplyMin) + ' น.', (c.slaBreaches ? 'ลูกค้ารอเกิน ' + fmt(c.slaMin || 5) + ' นาที ' + fmt(c.slaBreaches) + ' ครั้ง' : 'เป้า ≤ ' + fmt(c.replyGoalMin || 5) + ' นาที'), replyTone(c) || (c.slaBreaches ? 'bad' : '')));
    return '<div class="kpis">' + out.join('') + '</div>';
  }
  function roleName(r) { return r === 'support' ? 'Sale Support' : r === 'branch' ? 'กราฟิก สาขามดงาน' : 'Sale'; }
  function reportHtml(r, opts) {
    var o = opts || {}, saved = r.saved, show = saved ? saved : null;
    var status = saved ? '<span class="chip ' + (saved.onTime ? 'ok' : 'warn') + '">✓ ส่งแล้ว ' + esc(thTime(saved.submittedAt)) + (r.kind === 'daily' ? (saved.onTime ? ' · ตรงเวลา' : ' · ส่งช้า') : '') + '</span>'
      : (r.kind === 'daily' ? '<span class="chip bad">ยังไม่ส่ง report</span>' : '<span class="chip">สรุปสัปดาห์</span>');
    var period = r.kind === 'weekly' ? thDate(r.from) + ' – ' + thDate(r.to) : thDate(r.period);
    var role = roleName(r.user.role);
    function reportMax(b) { var x = (b || []).filter(function (i) { return i.key === 'report'; })[0]; return x ? x.max : 10; }
    var bdl = show ? show.breakdown : r.breakdown, sc = show ? show.score : r.score, gr = grade(sc);
    var m0 = show && show.metrics && !o.live ? show.metrics : r.live;
    var hero = '<section class="rhero"><div class="rh-top"><div class="rh-id">' + avatar(r.user, 'xl') + '<div class="rh-nm"><small>' + (r.kind === 'weekly' ? 'Weekly report' : 'Daily report') + '</small><h2>' + esc(r.user.name) + '</h2>' +
      '<div class="rh-meta"><span>' + esc(role) + '</span><span>' + esc(period) + '</span>' + (r.user.chatScored === false ? '<span>ไม่นำการตอบแชทมาคิดคะแนน</span>' : '') + '</div><div class="rh-st">' + status + '</div></div></div>' +
      '<div class="rh-score">' + ring(sc, true) + '<span class="grade t-' + gr[1] + '">' + gr[0] + '</span>' + (!saved && r.kind === 'daily' ? '<small>ยังไม่รวม ' + reportMax(r.breakdown) + ' คะแนนของการส่ง report</small>' : '') + '</div></div>' +
      kpis(m0 || {}, r.user.role, r.user.chatScored) + '</section>';
    var side = '<aside class="side"><section class="card"><div class="bd-h"><h3>คะแนนแยกหัวข้อ</h3><span class="num">' + fmt(sc) + ' / 100</span></div>' + improve(bdl) + breakdown(bdl) + '</section></aside>';
    var notes = (saved && saved.notes) || S.notes;
    var editable = !!r.canSubmit, adminMake = !!o.audit && editable;
    var form = '<section class="card pad"><h3 class="sec-h"><span class="ic">✍️</span><span>สรุปเพิ่มเติม<small>เขียนเอง · หัวหน้าอ่านประกอบตัวเลข</small></span></h3><div class="notes">' + NOTE_KEYS.map(function (k, i) {
      return '<div class="' + (i === 0 ? 'wide' : '') + '"><label for="n-' + k[0] + '">' + esc(k[1]) + '</label><textarea id="n-' + k[0] + '" data-note="' + k[0] + '" placeholder="' + esc(k[2]) + '"' + (editable ? '' : ' readonly') + '>' + esc((notes && notes[k[0]]) || '') + '</textarea></div>'; }).join('') + '</div>' +
      '<div class="actions">' + (editable ? '<button class="btn pri" data-act="' + (adminMake ? 'asubmit' : 'submit') + '">' + (adminMake ? (saved ? 'บันทึกการแก้ไข (แทน ' + esc(r.user.name) + ')' : '＋ สร้าง Report ของ ' + esc(r.user.name)) : (saved ? 'บันทึกการแก้ไข' : 'ส่ง report')) + '</button>' : '') +
      '<button class="btn" data-act="jpg">⬇ JPG (ส่ง LINE)</button><button class="btn" data-act="pdf">⬇ PDF</button><span class="sp"></span>' +
      (adminMake ? '<span class="hint">Administrator สร้าง report แทนได้ · ตัวเลขมาจากระบบ · ย้อนวัน = นับว่าส่งช้า</span>' : editable ? '<span class="hint">ตัวเลขผลงานมาจากระบบ แก้ไม่ได้ · เขียนสรุปแก้ได้ถึงสิ้นวัน</span>' : '<span class="hint">ส่งได้เฉพาะ report ของวันนี้ / สัปดาห์นี้</span>') + '</div>' +
      (r.errors && r.errors.length ? '<div class="err">⚠ อ่านข้อมูลบางส่วนไม่ได้: ' + esc(r.errors.join(' · ')) + '</div>' : '') + '</section>';
    var m = show && show.metrics && !o.live ? show.metrics : r.live;
    var mkBtn = adminMake ? '<button class="btn pri make" data-act="asubmit">' + (saved ? '💾 บันทึก Report ของ ' + esc(r.user.name) : '＋ สร้าง Report ของ ' + esc(r.user.name)) + '</button>' : '';
    return (o.audit ? '<div class="audit" id="auditHead"><div class="tx">🔍 Administrator — ' + (r.kind === 'weekly' ? 'Weekly' : 'Daily') + ' report ของ <b>' + esc(r.user.name) + '</b> · ' + esc(period) + '<small>' + (saved ? '✓ มี report แล้ว' + (saved.by && saved.by.toLowerCase() !== String(r.user.username).toLowerCase() ? ' (สร้างโดย ' + esc(saved.by) + ')' : '') + ' — แก้สรุปด้านล่างแล้วกดบันทึกได้' : 'ยังไม่มี report — ตัวเลขด้านล่างดึงจากระบบแล้ว กดปุ่มเพื่อสร้างได้เลย') + '</small></div>' + mkBtn + '</div>' : '') +
      hero + '<div class="grid"><div class="stack">' + metricCards(m, r.user.role) + form + '</div>' + side + '</div>';
  }
  function toolbar(kind, date, extra) {
    return '<div class="toolbar"><div class="seg"><button data-kind="daily" class="' + (kind === 'daily' ? 'on' : '') + '">Daily</button><button data-kind="weekly" class="' + (kind === 'weekly' ? 'on' : '') + '">Weekly</button></div>' +
      '<div class="field"><label for="dt">วันที่</label><input type="date" id="dt" value="' + esc(date) + '" max="' + esc(S.meta.today) + '"></div>' + (extra || '') + '<span class="sp"></span>' +
      '<button class="btn" data-act="refresh">↻ ดึงตัวเลขล่าสุด</button></div>';
  }
  function renderMine() {
    var v = $('view-mine');
    if (!S.rep) { v.innerHTML = toolbar(S.kind, S.date) + '<div class="card empty">กำลังดึงตัวเลขจากระบบ…</div>'; return; }
    v.innerHTML = toolbar(S.kind, S.date) + reportHtml(S.rep, { live: true });
  }
  function loadMine() {
    S.rep = null; renderMine();
    return api('report?kind=' + S.kind + '&date=' + S.date).then(function (r) { S.rep = r; S.notes = (r.saved && r.saved.notes) || S.notes; renderMine(); }).catch(function (e) { $('view-mine').innerHTML = toolbar(S.kind, S.date) + '<div class="card empty">' + esc(e.message) + '</div>'; });
  }
  function readNotes(root) { var o = {}; root.querySelectorAll('[data-note]').forEach(function (t) { o[t.dataset.note] = t.value; }); return o; }
  function submit() {
    if (S.busy) return;
    S.busy = true; var notes = readNotes($('view-mine'));
    api('report/submit', { kind: S.kind, notes: notes }).then(function (r) { S.rep = r; S.notes = notes; S.rank = null; renderMine(); toast('✓ ส่ง report แล้ว — คะแนน ' + fmt(r.saved && r.saved.score)); })
      .catch(function (e) { toast(e.message, true); }).then(function () { S.busy = false; });
  }
  /** Administrator กดสร้าง / แก้ report ของพนักงานที่เลือก (วันที่ตามที่เลือก) */
  function adminSubmit() {
    var A = S.audit; if (S.busy || !A.user) return;
    S.busy = true; var notes = readNotes($('view-audit'));
    api('report/submit', { kind: A.kind, user: A.user, date: A.date, notes: notes }).then(function (r) { A.rep = r; S.rank = null; toast('✓ สร้าง report ของ ' + r.user.name + ' แล้ว — คะแนน ' + fmt(r.saved && r.saved.score)); return loadAuditStatus(); })
      .catch(function (e) { toast(e.message, true); }).then(function () { S.busy = false; });
  }

  /* ── ภาพ JPG / PDF ── */
  /** ภาพ / PDF ที่ส่งเข้า LINE — ใส่ครบทุกหัวข้อเหมือนหน้าจอ (พี่เอ 3 พ.ย. 69: "Report ใส่รายละเอียดมาให้ครบทุกหัวข้อ สิ ตอนที่ export ออกมา") */
  function sheet(r, notes) {
    /* 🎨 v1.0.11 หน้าตาเดียวกับหน้าจอ (พี่เอ: "หน้าตาที่ปรับ ต้องรวมถึง export เป็น JPG / PDF ด้วยนะ") · กว้าง 1080 px สำหรับ LINE
     *   ‼ html2canvas: ไม่ใช้ color-mix / backdrop-filter · สีเป็นค่าตรง */
    var m = (r.saved && r.saved.metrics) || r.live || {}, c = m.chat || {}, s = m.sales || {}, mo = m.money || {}, cu = m.customer || {}, w = m.work || {};
    var sc = r.saved ? r.saved.score : r.score, bd = (r.saved && r.saved.breakdown) || r.breakdown || [], role = r.user.role, gr = grade(sc);
    var period = r.kind === 'weekly' ? thDate(r.from) + ' – ' + thDate(r.to) : thDate(r.period);
    var g = function (l, v, sub, tone) { return '<div class="' + (tone ? 't-' + tone : '') + '"><span>' + esc(l) + '</span><b>' + v + '</b>' + (sub ? '<em>' + esc(sub) + '</em>' : '') + '</div>'; };
    var box = function (ic, t, sub, items, cols) { return '<div class="sh-sec"><h2><i>' + ic + '</i>' + esc(t) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</h2><div class="g c' + (cols || 4) + '">' + items.join('') + '</div></div>'; };
    var ph = r._photo ? '<img class="ph" src="' + r._photo + '" alt="">' : '<span class="ph">' + esc(((r.user.name.match(/\(([^)]+)\)/) || [])[1] || r.user.name.charAt(0) || '?').slice(0, 2)) + '</span>';
    var st = r.saved ? '✓ ส่งแล้ว ' + thTime(r.saved.submittedAt) + (r.kind === 'daily' ? (r.saved.onTime ? ' · ตรงเวลา' : ' · ส่งช้า') : '') : (r.kind === 'daily' ? 'ยังไม่ส่ง report' : 'สรุปสัปดาห์');
    var meta = [roleName(role), period].concat(r.days ? ['ส่ง Daily ' + r.days.submitted + '/' + r.days.workdays + ' วัน'] : []).concat(r.user.chatScored === false ? ['ไม่นำการตอบแชทมาคิดคะแนน'] : []);
    var h = '<div class="sheet"><div class="sh-hero"><div class="sh-top"><div class="who">' + ph + '<div><small>' + (r.kind === 'weekly' ? 'WEEKLY REPORT' : 'DAILY REPORT') + '</small><h1>' + esc(r.user.name) + '</h1>' +
      '<p>' + meta.map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('') + '</p><div class="st ' + (r.saved ? (r.saved.onTime || r.kind !== 'daily' ? 'ok' : 'warn') : 'bad') + '">' + esc(st) + '</div></div></div>' +
      '<div class="big"><b>' + fmt(sc) + '</b><span>คะแนน / 100</span><em class="t-' + gr[1] + '">' + gr[0] + '</em></div></div>' +
      kpis(m, role, r.user.chatScored).replace('class="kpis"', 'class="sh-kpis"') + '</div>';
    /* คะแนนแยกหัวข้อ */
    if (bd.length) {
      var lo = (bd || []).filter(function (x) { return x.max && x.got / x.max < 0.5 && x.key !== 'report'; }).sort(function (a, b) { return (b.max - b.got) - (a.max - a.got); }).slice(0, 3);
      h += '<div class="sh-sec"><h2><i>🏅</i>คะแนนแยกหัวข้อ<small>' + fmt(sc) + ' / 100</small></h2>' +
        (lo.length ? '<div class="imp"><b>🎯 จุดที่ควรปรับ</b>' + lo.map(function (x) { return esc(x.label) + ' (หาย ' + fmt(x.max - x.got) + ')'; }).join(' · ') + '</div>' : '') +
        '<table class="bdt">' + bd.map(function (x) { var pc = x.max ? Math.max(0, Math.min(100, x.got / x.max * 100)) : 0, t = pc >= 99.9 ? 'good' : pc >= 50 ? 'warn' : 'bad';
        return '<tr><td><b>' + esc(x.label) + '</b>' + (x.why ? '<small>' + esc(x.why) + '</small>' : '') + '</td><td class="mb"><i class="t-' + t + '" style="width:' + pc + '%"></i></td><td class="r"><span class="pl t-' + t + '">' + fmt(x.got) + ' / ' + x.max + '</span></td></tr>'; }).join('') + '</table></div>';
    }
    h += box('💬', 'แชท', 'Ant-Connect', [g('แชทที่รับ / ถูกมอบหมาย', fmt(c.received)), g('แชทที่ตอบ', fmt(c.chats), fmt(c.replies) + ' ข้อความ'),
      g('เวลาตอบเฉลี่ย', c.avgReplyMin == null ? '—' : fmt(c.avgReplyMin) + ' นาที', c.replyGoalMin ? 'เป้า ≤ ' + c.replyGoalMin + ' นาที' : '', replyTone(c)),
      g(c.slaMin ? 'ลูกค้ารอเกิน ' + fmt(c.slaMin) + ' นาที' : 'ลูกค้ารอเกินเวลา', fmt(c.slaBreaches), 'ครั้ง' + (c.slaMin ? ' · รอได้ไม่เกิน ' + fmt(c.slaMin) + ' นาที' : ''), c.slaBreaches == null ? '' : c.slaBreaches ? 'bad' : 'good'),
      g('ปิดเคส', fmt(c.closed)), g('สร้าง lead จากแชท', fmt(c.leads))], 3);
    var sl = [g('รหัสงานใหม่', fmt(s.jobCodes)), g('ใบเสนอราคา', fmt(s.quotes), s.quoteValue ? baht(s.quoteValue) : ''), g('ปิดการขาย', fmt(s.won), s.wonValue != null ? baht(s.wonValue) + ' ก่อน VAT' : '')];
    if (role === 'support') sl.push(g('งานที่ดูแล (ปิดแล้ว)', fmt(s.supportedWon), s.supportedValue != null ? baht(s.supportedValue) : ''));
    h += box('🧾', 'การขาย', 'คีย์ยอดขาย', sl, sl.length);
    var two = box('💰', 'เงิน', 'PEAK · ติดตามหนี้', [g('เงินเข้า', mo.collected == null ? '—' : baht(mo.collected), mo.receipts != null ? mo.receipts + ' ใบเสร็จ' : ''),
      g('วันเก็บเงินเฉลี่ย', mo.avgCollectDays == null ? '—' : fmt(mo.avgCollectDays) + ' วัน', 'เปิดบิล → ได้เงิน'), g('ติดตามหนี้', fmt(mo.followups), mo.promised ? 'รับปาก ' + baht(mo.promised) : 'ครั้ง'),
      g('สลิปในแชท', fmt(mo.slips), mo.slipAmount ? baht(mo.slipAmount) : '')], 2);
    var wk = [g('จองคิวช่าง', fmt(w.bookings)), g('เปิด Project', fmt(w.projects))];
    if (role === 'branch') wk.push(g('จบงาน Projects', fmt(w.projectsDone)), g('Job card ผลิต', fmt(w.jobCards)), g('เคลมจากกราฟิค', fmt(w.graphicClaims), 'ยิ่งน้อยยิ่งดี', w.graphicClaims ? 'bad' : w.graphicClaims === 0 ? 'good' : ''));
    if (role !== 'branch') { two += box('🧭', 'ลูกค้าใหม่', 'B2B Visit', [g('ลูกค้าใหม่ที่หาเจอ', fmt(cu.prospects), cu.prospectValue ? baht(cu.prospectValue) : ''), g('visit', fmt(cu.visits)), g('ติดตามแชท/โทร', fmt(cu.follows)), g('นัด visit', fmt(cu.plans)), g('งานติดตาม', fmt(cu.tasks))], 2);
      h += '<div class="sh-two">' + two + '</div>' + box('🛠', 'งานต่อ', 'Projects · จองคิวช่าง', wk, 2); }
    else h += '<div class="sh-two">' + two + box('🛠', 'งานต่อ', 'Projects · Job card', wk, 2) + '</div>';
    var ch = m.channels || {}, keys = Object.keys(ch);
    if (keys.length) {
      keys.sort(function (a, b) { return (ch[b].value - ch[a].value) || (ch[b].chats - ch[a].chats); });
      h += '<div class="sh-sec"><h2><i>📡</i>แยกช่องทาง<small>เรียงตามมูลค่าที่ปิดได้</small></h2><table class="cht"><tr><th>ช่องทาง</th><th class="r">แชทที่ตอบ</th><th class="r">ปิดการขาย</th><th class="r">มูลค่า</th></tr>' +
        keys.map(function (k) { var x = ch[k]; return '<tr><td><b>' + esc(k) + '</b></td><td class="r">' + fmt(x.chats) + '</td><td class="r">' + fmt(x.won) + '</td><td class="r"><b>' + baht(x.value) + '</b></td></tr>'; }).join('') + '</table></div>';
    }
    h += '<div class="sh-sec"><h2><i>✍️</i>สรุปเพิ่มเติม</h2><div class="nts">' + NOTE_KEYS.map(function (k, i) { var v = notes && notes[k[0]]; return '<div class="nt' + (v ? '' : ' blank') + (i === 0 ? ' wide' : '') + '"><b>' + esc(k[1]) + '</b>' + (v ? esc(v) : '—') + '</div>'; }).join('') + '</div></div>';
    return h + '<div class="ft"><span><b>CRM มดงานการป้าย</b> · Report &amp; Ranking</span><span>' + (r.saved ? 'ส่งเมื่อ ' + esc(thTime(r.saved.submittedAt)) + (r.saved.by && r.saved.by.toLowerCase() !== String(r.user.username).toLowerCase() ? ' · สร้างโดย ' + esc(r.saved.by) : '') : 'ยังไม่ส่ง') + '</span></div></div>';
  }
  /** รูปพนักงาน ⇒ data URL (ผ่านเซิร์ฟเวอร์เราเอง) · ไม่มีรูป / โหลดไม่ได้ = ใช้ตัวอักษรย่อ */
  function photoData(r) {
    if (!r.user.photo) return Promise.resolve('');
    return fetch('api/photo?user=' + encodeURIComponent(r.user.username), { credentials: 'same-origin' })
      .then(function (x) { if (!x.ok) throw 0; return x.blob(); })
      .then(function (b) { return new Promise(function (ok) { var fr = new FileReader(); fr.onload = function () { ok(String(fr.result || '')); }; fr.onerror = function () { ok(''); }; fr.readAsDataURL(b); }); })
      .catch(function () { return ''; });
  }
  function exportAs(kind, r, notes) {
    if (!r) return;
    toast('กำลังทำไฟล์…');
    var host = $('sheetHost');
    photoData(r).then(function (d) { r._photo = d; host.innerHTML = sheet(r, notes); return doExport(kind, r, host); });
  }
  function doExport(kind, r, host) {
    var name = (r.kind === 'weekly' ? 'Weekly' : 'Daily') + '-report-' + r.user.username + '-' + r.period;
    var need = [window.html2canvas ? null : loadScript(LIB.h2c)];
    if (kind === 'pdf' && !(window.jspdf && window.jspdf.jsPDF)) need.push(loadScript(LIB.pdf));
    var imgs = [].slice.call(host.querySelectorAll('img')).map(function (im) { return im.complete ? null : new Promise(function (ok) { im.onload = im.onerror = ok; }); });
    return Promise.all(need.concat(imgs)).then(function () { return (document.fonts && document.fonts.ready) || null; }).then(function () {
      return window.html2canvas(host.firstChild, { scale: 1, backgroundColor: '#ffffff', useCORS: true });
    }).then(function (cv) {
      if (kind === 'pdf') {
        var pdf = new window.jspdf.jsPDF({ unit: 'px', format: [cv.width, cv.height], orientation: cv.height > cv.width ? 'portrait' : 'landscape' });
        pdf.addImage(cv.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, cv.width, cv.height); pdf.save(name + '.pdf'); toast('⬇ ดาวน์โหลด PDF แล้ว'); return;
      }
      cv.toBlob(function (b) {
        var file = new File([b], name + '.jpg', { type: 'image/jpeg' });
        if (navigator.canShare && navigator.canShare({ files: [file] }) && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
          navigator.share({ files: [file], title: name }).catch(function () { /* ผู้ใช้ยกเลิก */ });
        } else { var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name + '.jpg'; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500); toast('⬇ ดาวน์โหลด JPG แล้ว — ลากใส่ห้อง LINE ได้เลย'); }
      }, 'image/jpeg', 0.9);
    }).catch(function (e) { toast(e.message || 'ทำไฟล์ไม่สำเร็จ', true); }).then(function () { setTimeout(function () { host.innerHTML = ''; }, 500); });
  }

  /* ════════ 💬 ส่งเข้า LINE: ข้อความ (ชื่อ · permission · คะแนน · อลิซวิเคราะห์) + ภาพ ════════
   * พี่เอ 6 พ.ย. 69: "ตอนที่ดึง Report เป็น JPG แล้วกำลังจะส่งเข้า line ช่วยดึง ชื่อ นามสกุล และ permission ของ user แสดงเป็น Text ไว้ด้านบน
   *   แสดงคะแนนที่ได้ และอลิซ วิเคราะห์ ผลลัพธ์การทำงาน และแนะนำการปรับวิธีการทำงานให้ด้วยนะ และตามด้วยภาพ Report"
   * ‼ อลิซวิเคราะห์ = กติกาจากตัวเลขในระบบ (ไม่เรียก AI · ไม่มีค่าใช้จ่าย) */
  var TIP = {
    neglect: function (c) { return 'เปิด Ant-Connect ค้างไว้ และตอบรับลูกค้าสั้น ๆ ภายใน ' + fmt(c.slaMin || 5) + ' นาทีก่อน (เช่น "รับทราบค่ะ ขอเช็คให้สักครู่") แล้วค่อยตอบรายละเอียด'; },
    speed: function (c) { return 'ใช้ข้อความสำเร็จรูป / ปุ่มร่างคำตอบ ช่วยลดเวลาตอบเฉลี่ยให้ไม่เกิน ' + fmt(c.replyGoalMin || 5) + ' นาที'; },
    care: function () { return 'ตามแชทลูกค้าที่ค้างให้ต่อเนื่อง อย่าปล่อยแชทเงียบเกินครึ่งวัน'; },
    visit: function () { return 'visit หรือ 💬 บันทึกการติดตามลูกค้า (แชท/โทร) อย่างน้อย 2 รายต่อวันในแอป Leads & Customer Visit'; },
    prospect: function () { return 'หาลูกค้าใหม่ในแอป Leads & Customer Visit อย่างน้อยวันละ 1 ราย'; },
    quote: function () { return 'ส่งใบเสนอราคาให้ลูกค้าที่คุยค้างอย่างน้อยวันละ 1 ใบ และตั้งวันติดตาม'; },
    jobcode: function () { return 'ลูกค้าสนใจเมื่อไหร่ สร้างรหัสงาน / ส่ง lead เข้าคีย์ยอดขายทันที อย่ารอหลายวัน'; },
    collect: function () { return 'โทรหรือทักติดตามหนี้ค้างชำระอย่างน้อยวันละ 1 ราย แล้วบันทึกผลในระบบ'; },
    handoff: function () { return 'ลูกค้าตกลงแล้ว ให้เปิด Project / จองคิวช่างทันที งานจะเดินต่อไม่สะดุด'; },
    follow: function () { return 'หลังคุยกับลูกค้าทางแชท/โทร กด 💬 บันทึกการติดตาม ในแอป Leads & Customer Visit ทุกครั้ง (ใส่ผล + นัดครั้งถัดไป)'; },
    won: function () { return 'ไล่ปิดดีลที่ส่งใบเสนอราคาไปแล้ว โทรถามความพร้อมและข้อกังวลของลูกค้า'; },
    cash: function () { return 'ลูกค้าชำระแล้ว ขอสลิปในแชทและแจ้งออกใบเสร็จให้ครบทุกงาน'; },
    projdone: function () { return 'งานที่ทำเสร็จแล้ว กด Complete ในแอป Projects ให้ครบ เพื่อให้ Card ผลิตเข้าระบบ'; },
    jobcard: function () { return 'งานที่พร้อมผลิต สร้าง Job card ผลิตให้ทันในวันเดียวกัน'; },
    gclaim: function () { return 'ตรวจไฟล์ ขนาด และสเปกกับลูกค้าอีกรอบก่อนส่งผลิต เพื่อลดงานเคลม'; },
    report: function () { return 'ส่ง Daily report ทุกวันภายในเวลา 24:00 น.'; }
  };
  /** 🎯 ทำอย่างไรให้ได้เต็ม — เกณฑ์เดียวกับ score.js (พี่เอ: "แนะนำ การปรับปรุงการทำงานให้ user ด้วย ทำอย่างไร เค้าจะได้คะแนนเต็ม 100") */
  function fullNeed(x, u, c) {
    var sup = u.role === 'support', noChat = u.chatScored === false;
    var F = { visit: 'visit หรือบันทึกการติดตามแชท/โทรให้ได้ 2 ครั้งต่อวัน', prospect: 'หาลูกค้าใหม่ให้ได้ 1 รายต่อวัน',
      quote: sup && noChat ? 'ใบเสนอราคา + รหัสงาน รวม 2 รายการต่อวัน' : sup ? 'ส่งใบเสนอราคาหรือสร้างรหัสงาน 1 รายการต่อวัน' : 'ส่งใบเสนอราคา 1 ใบต่อวัน',
      neglect: 'ไม่ปล่อยให้ลูกค้ารอเกิน ' + fmt(c.slaMin || 5) + ' นาทีเลย (0 ครั้ง)', speed: 'ตอบแชทเฉลี่ยไม่เกิน ' + fmt(c.replyGoalMin || 5) + ' นาที',
      jobcode: 'สร้างรหัสงาน / lead 1 รายการต่อวัน', collect: 'ติดตามหนี้ 1 ครั้งต่อวัน (บันทึกในระบบ)',
      handoff: sup && noChat ? 'เปิด Project / จองคิวช่าง 2 รายการต่อวัน' : 'เปิด Project / จองคิวช่าง 1 รายการต่อวัน',
      follow: 'visit หรือ บันทึกการติดตามแชท/โทร 1 ครั้งต่อวัน', care: 'ตอบลูกค้าให้ได้อย่างน้อย 10 ข้อความต่อวัน', won: 'ปิดการขายให้ได้ 1 งานต่อวัน',
      cash: 'รับเงิน / สลิปลูกค้า 1 รายการต่อวัน', projdone: 'จบงาน (Complete) ใน Projects 2 งานต่อวัน', jobcard: 'สร้าง Job card ผลิต 2 ใบต่อวัน',
      gclaim: 'ไม่มีงานเคลมจากกราฟิค', report: 'ส่ง Daily report ภายในวันนั้น (ถึง 24:00 น.)' };
    return F[x.key] || ('ทำหัวข้อ "' + x.label + '" ให้ครบ');
  }
  function analysis(r) {
    var m = (r.saved && r.saved.metrics) || r.live || {}, c = m.chat || {}, s = m.sales || {}, mo = m.money || {};
    var bd = (r.saved && r.saved.breakdown) || r.breakdown || [], sc = r.saved ? r.saved.score : r.score;
    var good = bd.filter(function (x) { return x.max && x.got >= x.max && x.key !== 'report'; });
    var bad = bd.filter(function (x) { return x.max && x.got / x.max < 0.5; }).sort(function (a, b) { return (b.max - b.got) - (a.max - a.got); });
    var mid = bd.filter(function (x) { return x.max && x.got / x.max >= 0.5 && x.got < x.max; });
    var L = [];
    L.push(Number(sc) >= 85 ? 'ภาพรวมยอดเยี่ยม ทำได้ครบเกือบทุกหัวข้อ' : Number(sc) >= 70 ? 'ภาพรวมดี ยังเพิ่มคะแนนได้อีกในบางหัวข้อ' : Number(sc) >= 50 ? 'ภาพรวมพอใช้ มีหัวข้อที่ควรเร่งปรับ' : 'คะแนนยังต่ำ ควรปรับวิธีทำงานในหัวข้อหลักด่วน');
    var facts = [];
    if (s.wonValue) facts.push('ปิดการขายได้ ' + baht(s.wonValue) + ' (' + fmt(s.won) + ' งาน)');
    if (s.quotes) facts.push('ส่งใบเสนอราคา ' + fmt(s.quotes) + ' ใบ' + (s.quoteValue ? ' มูลค่า ' + baht(s.quoteValue) : ''));
    if (mo.collected) facts.push('เงินเข้า ' + baht(mo.collected));
    if (r.user.chatScored !== false && c.chats) facts.push('ตอบแชท ' + fmt(c.chats) + ' แชท เฉลี่ย ' + (c.avgReplyMin == null ? '—' : fmt(c.avgReplyMin) + ' นาที') + (c.slaBreaches ? ' · ลูกค้ารอเกิน ' + fmt(c.slaMin || 5) + ' นาที ' + fmt(c.slaBreaches) + ' ครั้ง' : ''));
    if (facts.length) L.push('ผลงาน: ' + facts.join(' · '));
    if (good.length) L.push('✅ จุดแข็ง: ' + good.slice(0, 3).map(function (x) { return x.label; }).join(' · '));
    var weak = bad.concat(mid).slice(0, 3);
    if (weak.length) L.push('⚠️ ต้องปรับ: ' + weak.map(function (x) { return x.label + ' (' + fmt(x.got) + '/' + x.max + ')'; }).join(' · '));
    var tips = weak.map(function (x) { return TIP[x.key] ? TIP[x.key](c) : ''; }).filter(Boolean);
    if (!tips.length) tips.push('รักษามาตรฐานนี้ไว้ และแชร์วิธีทำงานให้เพื่อนในทีม');
    var gap = bd.filter(function (x) { return x.max && x.got < x.max; }).sort(function (a, b) { return (b.max - b.got) - (a.max - a.got); });
    var full = gap.map(function (x) { return '+' + fmt(x.max - x.got) + ' คะแนน — ' + fullNeed(x, r.user, c) + ' (ตอนนี้ ' + fmt(x.got) + '/' + x.max + ')'; });
    return { lines: L, tips: tips, full: full, missing: Math.round(gap.reduce(function (t, x) { return t + (x.max - x.got); }, 0) * 10) / 10 };
  }
  function shareText(r, notes) {
    var u = r.user, sc = r.saved ? r.saved.score : r.score, gr = grade(sc), a = analysis(r);
    var period = r.kind === 'weekly' ? thDate(r.from) + ' – ' + thDate(r.to) : thDate(r.period);
    var st = r.saved ? 'ส่งแล้ว ' + thTime(r.saved.submittedAt) + (r.kind === 'daily' ? (r.saved.onTime ? ' · ตรงเวลา' : ' · ส่งช้า') : '') : 'ยังไม่ส่ง report';
    var t = ['📊 ' + (r.kind === 'weekly' ? 'Weekly' : 'Daily') + ' Report · ' + period,
      '👤 ' + (u.fullName || u.name) + (u.nickname ? ' (' + u.nickname + ')' : ''),
      '🏷 Permission: ' + (u.permission || roleName(u.role)) + ' · ประเมินแบบ ' + roleName(u.role),
      '⭐ คะแนน ' + fmt(sc) + ' / 100 · ระดับ ' + gr[0] + ' · ' + st, '',
      '🤖 อลิซวิเคราะห์'].concat(a.lines.map(function (x) { return '• ' + x; }))
      .concat(['', '💡 แนะนำการปรับวิธีทำงาน']).concat(a.tips.map(function (x, i) { return (i + 1) + '. ' + x; }))
      .concat(['', a.full.length ? '🎯 ทำอย่างไรให้ได้ 100 คะแนน (ขาดอีก ' + fmt(a.missing) + ' คะแนน)' : '🎯 ได้คะแนนเต็ม 100 แล้ว — รักษามาตรฐานนี้ไว้'].concat(a.full.map(function (x) { return '• ' + x; })))
      /* 📅 พี่เอ: "Text ด้านบน ให้ดึงเอาส่วนของ แผนการทำงานในวันพรุ่งนี้ออกมาแสดงต่อให้ด้วยนะ" */
      .concat(['', '📅 ' + (r.kind === 'weekly' ? 'แผนสัปดาห์หน้า' : 'แผนการทำงานพรุ่งนี้'), String((notes && notes.plan) || '').trim() || '— ยังไม่ได้เขียนแผน —'])
      .concat(['', '(ภาพ Report ตามด้านล่าง 👇)']);
    return t.join('\n');
  }
  var SH = { r: null, file: null, text: '' };
  function openShare(r, notes) {
    if (!r) return;
    SH = { r: r, file: null, text: shareText(r, notes) };
    var ov = document.createElement('div'); ov.id = 'shOv'; ov.className = 'sh-ov';
    ov.innerHTML = '<div class="sh-box" role="dialog" aria-modal="true" aria-labelledby="shTitle"><div class="sh-hd"><b id="shTitle">💬 ส่ง Report เข้า LINE</b><button class="x" data-act="sh-close" aria-label="ปิด">✕</button></div>' +
      (isMobile() ? '<ol class="sh-steps"><li><b>คัดลอกข้อความ</b> แล้ววางในห้อง LINE</li><li><b>แชร์ภาพ Report</b> ตามหลังข้อความ</li></ol>'
        : '<ol class="sh-steps"><li><b>คัดลอกข้อความ</b> ⇒ ไปที่ห้อง LINE ⇒ กด Ctrl+V แล้วส่ง</li><li><b>คัดลอกภาพ</b> ⇒ กลับไปห้องเดิม ⇒ กด Ctrl+V แล้วส่ง</li></ol>') +
      '<textarea id="shText" class="sh-text" rows="12">' + esc(SH.text) + '</textarea>' +
      /* 🖥 พี่เอ 6 พ.ย. 69: "บน desktop ปุ่มสองปุ่มนี้ใช้ไม่ได้จริงนะ ตัดไปเลย แล้วให้ใช้การ copy ไปวางเอาครับ" ⇒ คอม = คัดลอกข้อความ + คัดลอกภาพ เท่านั้น */
      (isMobile() ? '<div class="sh-ac"><button class="btn" data-act="sh-copy">📋 คัดลอกข้อความ</button><button class="btn pri" data-act="sh-send" id="shSend" disabled>กำลังทำภาพ…</button></div>'
        : '<div class="sh-ac"><button class="btn pri" data-act="sh-copy">① 📋 คัดลอกข้อความ</button><button class="btn pri" data-act="sh-cimg" id="shCimg" disabled>② 🖼 กำลังทำภาพ…</button></div>' +
          '<p class="hint" style="margin:0">คัดลอกภาพไม่ได้? <button class="lnk" data-act="sh-send" id="shSend" disabled>ดาวน์โหลดภาพ JPG</button> แล้วลากใส่ห้อง LINE แทน</p>') +
      '<p class="hint">ข้อความแก้ไขได้ก่อนคัดลอก · อลิซวิเคราะห์จากตัวเลขในระบบ (ไม่ใช้ AI ไม่มีค่าใช้จ่าย)</p></div>';
    document.body.appendChild(ov);
    var host = $('sheetHost');
    photoData(r).then(function (d) { r._photo = d; host.innerHTML = sheet(r, notes); return renderCanvas(host); })
      .then(function (cv) { SH.cv = cv; cv.toBlob(function (pb) { SH.png = pb; var ci = $('shCimg'); if (ci) { ci.disabled = false; ci.textContent = '② 🖼 คัดลอกภาพ'; } }, 'image/png'); return new Promise(function (ok) { cv.toBlob(function (b) { ok(b); }, 'image/jpeg', 0.9); }); })
      .then(function (b) { SH.file = new File([b], (r.kind === 'weekly' ? 'Weekly' : 'Daily') + '-report-' + r.user.username + '-' + r.period + '.jpg', { type: 'image/jpeg' });
        var bt = $('shSend'); if (bt) { bt.disabled = false; if (isMobile()) bt.textContent = canShareFile() ? '📤 แชร์ภาพเข้า LINE' : '⬇ ดาวน์โหลดภาพ JPG'; } })
      .catch(function (e) { toast(e.message || 'ทำภาพไม่สำเร็จ', true); var bt = $('shSend'); if (bt) bt.textContent = 'ทำภาพไม่สำเร็จ'; })
      .then(function () { setTimeout(function () { host.innerHTML = ''; }, 500); });
  }
  function isMobile() { return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent); }
  /* 🖥 Chrome / Edge บน Windows · Safari บน Mac มีหน้าต่างแชร์ของระบบเหมือนมือถือ (LINE Desktop ขึ้นให้เลือกถ้าติดตั้งไว้) */
  function canShareFile() { try { return !!(SH.file && navigator.canShare && navigator.canShare({ files: [SH.file] })); } catch (e) { return false; } }
  function copyImg() {
    if (!SH.png || !window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) { toast('เบราว์เซอร์นี้คัดลอกภาพไม่ได้ — กด "ดาวน์โหลดภาพ" แล้วลากใส่ LINE แทน', true); return; }
    navigator.clipboard.write([new window.ClipboardItem({ 'image/png': SH.png })]).then(function () { toast('🖼 คัดลอกภาพแล้ว — ไปที่ห้อง LINE แล้วกด Ctrl+V'); }, function () { toast('คัดลอกภาพไม่สำเร็จ — กด "ดาวน์โหลดภาพ" แล้วลากใส่ LINE แทน', true); });
  }
  function closeShare() { var o = $('shOv'); if (o) o.remove(); }
  function copyShare() {
    var ta = $('shText'), txt = ta ? ta.value : SH.text;
    var done = function () { toast('📋 คัดลอกข้อความแล้ว — วางในห้อง LINE ได้เลย'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('กดค้างที่ข้อความแล้วเลือกคัดลอก', true); } });
    else { ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('กดค้างที่ข้อความแล้วเลือกคัดลอก', true); } }
  }
  function sendShare() {
    if (!SH.file) return;
    var txt = ($('shText') || {}).value || SH.text;
    if (isMobile() && canShareFile()) {
      navigator.share({ files: [SH.file], text: txt, title: SH.file.name }).catch(function () { /* ยกเลิก */ });
      return;
    }
    var a = document.createElement('a'); a.href = URL.createObjectURL(SH.file); a.download = SH.file.name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500); toast('⬇ ดาวน์โหลด JPG แล้ว — ลากใส่ห้อง LINE ต่อจากข้อความ');
  }
  function renderCanvas(host) {
    var need = [window.html2canvas ? null : loadScript(LIB.h2c)];
    var imgs = [].slice.call(host.querySelectorAll('img')).map(function (im) { return im.complete ? null : new Promise(function (ok) { im.onload = im.onerror = ok; }); });
    return Promise.all(need.concat(imgs)).then(function () { return (document.fonts && document.fonts.ready) || null; })
      .then(function () { return window.html2canvas(host.firstChild, { scale: 1, backgroundColor: '#f2f4f6', useCORS: true }); });
  }

  /* ════════ Ranking ════════ */
  var PERIODS = [['day', 'วันนี้'], ['week', 'สัปดาห์'], ['month', 'เดือน'], ['quarter', 'ไตรมาส'], ['half', 'ครึ่งปี'], ['year', 'ปี']];
  function renderRank() {
    var v = $('view-rank'), R = S.rank;
    var tb = '<div class="toolbar"><div class="seg per">' + PERIODS.map(function (p) { return '<button data-period="' + p[0] + '" class="' + (S.rankPeriod === p[0] ? 'on' : '') + '">' + p[1] + '</button>'; }).join('') + '</div>' +
      '<div class="seg"><button data-role="sale" class="' + (S.rankRole === 'sale' ? 'on' : '') + '">Sale</button><button data-role="support" class="' + (S.rankRole === 'support' ? 'on' : '') + '">Sale Support</button><button data-role="branch" class="' + (S.rankRole === 'branch' ? 'on' : '') + '">กราฟิก สาขา</button></div><span class="sp"></span>' +
      (R ? '<span class="hint">' + esc(thDate(R.from)) + (R.from !== R.to ? ' – ' + esc(thDate(R.to)) : '') + '</span>' : '') + '</div>';
    if (!R) { v.innerHTML = tb + '<div class="card empty">กำลังจัดอันดับ…</div>'; return; }
    var rows = R.rows.filter(function (x) { return x.role === S.rankRole; });
    if (!rows.length) { v.innerHTML = tb + '<div class="card empty">ยังไม่มีคนในกลุ่มนี้</div>'; return; }
    var long = !(R.period === 'day' || R.period === 'week'), me = S.meta.me.username.toLowerCase();
    var top = rows.slice(0, 3), order = [top[1], top[0], top[2]];
    var pod = '<div class="podium">' + order.map(function (x, i) { if (!x) return '<div></div>'; var p = x.rank;
      return '<div class="pod p' + p + '"><span class="medal">' + p + '</span>' + avatar(x, 'xl') + '<b>' + esc(x.name) + '</b><div class="sc num">' + fmt(x.score) + '</div><small>' + (long ? (x.result == null ? 'รายวันเฉลี่ย ' + fmt(x.daily) : 'ผลลัพธ์ ' + fmt(x.result) + ' · รายวัน ' + fmt(x.daily)) : 'ส่ง ' + x.submitted + '/' + x.workdays + ' วัน') + '</small></div>'; }).join('') + '</div>';
    var list = '<div class="card"><ul class="list">' + rows.map(function (x) {
      var sub = x.onLeave ? 'ลาวันนี้' : (x.submitted ? 'ส่ง ' + x.submitted + (R.period === 'day' ? '' : '/' + x.workdays + ' วัน') + (x.onTime ? ' · ตรงเวลา ' + x.onTime : '') : 'ยังไม่ส่ง report');
      var bars = long ? '<div class="bars">' + (x.result == null ? '' : '<span>ผลลัพธ์ ' + fmt(x.result) + (x.resultGoal ? ' · ' + baht(x.resultGot) : '') + '<div class="meter"><i style="width:' + Math.min(100, x.result || 0) + '%;background:#e89a1c"></i></div></span>') + '<span>รายวันเฉลี่ย ' + fmt(x.daily) + '<div class="meter"><i style="width:' + Math.min(100, x.daily || 0) + '%"></i></div></span></div>'
        : '<div class="bars"><span>คะแนนรายวันเฉลี่ย<div class="meter"><i style="width:' + Math.min(100, x.daily || 0) + '%"></i></div></span></div>';
      return '<li class="' + (x.username.toLowerCase() === me ? 'me' : '') + '"><span class="rk">' + x.rank + '</span>' + avatar(x) + '<div class="nm"><b>' + esc(x.name) + '</b><small>' + esc(sub) + '</small></div>' + bars + '<span class="sc num">' + fmt(x.score) + '</span></li>'; }).join('') + '</ul></div>';
    v.innerHTML = tb + pod + list + '<p class="legend">' + (long && !(S.rankRole === 'branch' && !S.meta.targets.branchPerMonth) ? 'คะแนน = ' + Math.round(S.meta.weights.result * 100) + '% ผลลัพธ์ (ยอดปิดเทียบเป้า ' + baht(S.rankRole === 'support' ? S.meta.targets.supportPerMonth : S.rankRole === 'branch' ? S.meta.targets.branchPerMonth : S.meta.targets.salePerMonth) + '/เดือน) + ' + Math.round(S.meta.weights.daily * 100) + '% คะแนนรายวันเฉลี่ย' : 'คะแนน = คะแนน Daily report เฉลี่ยต่อวันทำงาน') + ' · วันลาไม่นับ · ไม่ส่ง report = 0 คะแนนวันนั้น</p>';
  }
  function loadRank() { S.rank = null; renderRank(); return api('ranking?period=' + S.rankPeriod + '&date=' + S.meta.today).then(function (r) { S.rank = r; renderRank(); }).catch(function (e) { $('view-rank').innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; }); }

  /* ════════ ตรวจสอบ (Administrator) ════════ */
  function renderAudit() {
    var v = $('view-audit'), A = S.audit;
    var st = A.status;
    var people = st ? st.users : [];
    var sel = '<div class="field"><label for="au">พนักงาน</label><select id="au"><option value="">— เลือก —</option>' + people.map(function (u) { return '<option value="' + esc(u.username) + '"' + (A.user === u.username ? ' selected' : '') + '>' + esc(u.name) + ' · ' + roleName(u.role) + '</option>'; }).join('') + '</select></div>';
    var head = toolbar(A.kind, A.date, sel);
    var list = st ? '<div class="card pad" style="margin-bottom:16px"><h3 class="sec-h"><span class="ic">📋</span>ส่ง Daily report ' + (A.date === S.meta.today ? 'วันนี้' : thDate(A.date)) + ' ' + people.filter(function (u) { return u.submitted; }).length + ' / ' + people.length + ' คน</h3><p class="hint" style="margin:-4px 0 12px">กดที่ชื่อพนักงาน ⇒ เปิด report ของคนนั้น แล้วกด "＋ สร้าง Report" ด้านบนได้เลย (เลือกวัน / Daily / Weekly ได้จากแถบด้านบน)</p><div class="who-list">' +
      people.map(function (u) { return '<button class="who-item' + (A.user === u.username ? ' on' : '') + '" data-pick="' + esc(u.username) + '">' + avatar(u) + '<span class="tx"><b>' + esc(u.name) + '</b><small>' + (u.submitted ? '✓ ' + fmt(u.score) + ' คะแนน · ' + esc(thTime(u.at)) : 'ยังไม่ส่ง') + '</small></span>' + (u.submitted ? '<span class="chip ok">ส่งแล้ว</span>' : '<span class="chip make">＋ สร้าง</span>') + '</button>'; }).join('') + '</div></div>' : '<div class="card empty">กำลังโหลดรายชื่อ…</div>';
    var body = A.user ? (A.rep ? reportHtml(A.rep, { audit: true, live: true }) : '<div class="card empty">กำลังดึงตัวเลขของ ' + esc(A.user) + '…</div>') : '';
    v.innerHTML = head + body + list;
  }
  function loadAuditStatus() { return api('admin/status?date=' + (S.audit.date || S.meta.today)).then(function (r) { S.audit.status = r; renderAudit(); }).catch(function (e) { toast(e.message, true); }); }
  function loadAudit() {
    var A = S.audit; if (!A.user) { renderAudit(); return; }
    A.rep = null; renderAudit();
    api('report?kind=' + A.kind + '&date=' + A.date + '&user=' + encodeURIComponent(A.user)).then(function (r) { A.rep = r; renderAudit(); var h = $('auditHead'); if (h && h.scrollIntoView) h.scrollIntoView({ behavior: 'smooth', block: 'start' }); }).catch(function (e) { toast(e.message, true); });
  }

  /* ════════ เหตุการณ์ ════════ */
  function setTab(t) {
    S.tab = t;
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === t); });
    ['mine', 'rank', 'audit'].forEach(function (k) { $('view-' + k).hidden = k !== t; });
    if (t === 'rank' && !S.rank) loadRank();
    if (t === 'audit' && !S.audit.status) loadAuditStatus();
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('button'); if (!b) return;
    var view = b.closest('.view'), inAudit = view && view.id === 'view-audit';
    if (b.dataset.tab) return setTab(b.dataset.tab);
    if (b.dataset.kind) { if (inAudit) { S.audit.kind = b.dataset.kind; loadAudit(); } else { S.kind = b.dataset.kind; loadMine(); } return; }
    if (b.dataset.period) { S.rankPeriod = b.dataset.period; return loadRank(); }
    if (b.dataset.role) { S.rankRole = b.dataset.role; return renderRank(); }
    if (b.dataset.pick) { S.audit.user = b.dataset.pick; loadAudit(); return; }
    var act = b.dataset.act;
    if (act === 'refresh') return inAudit ? loadAudit() : loadMine();
    if (act === 'submit') return submit();
    if (act === 'asubmit') return adminSubmit();
    if (act === 'jpg') { var r1 = inAudit ? S.audit.rep : S.rep; return openShare(r1, readNotes(view)); }
    if (act === 'pdf') { var r2 = inAudit ? S.audit.rep : S.rep; return exportAs('pdf', r2, readNotes(view)); }
    if (act === 'sh-copy') return copyShare();
    if (act === 'sh-send') return sendShare();
    if (act === 'sh-close') return closeShare();
    if (act === 'sh-cimg') return copyImg();
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target, inAudit = t.closest('#view-audit');
    if (t.id === 'dt') { if (inAudit) { S.audit.date = t.value || S.meta.today; loadAuditStatus(); loadAudit(); } else { S.date = t.value || S.meta.today; loadMine(); } }
    if (t.id === 'au') { S.audit.user = t.value; loadAudit(); }
  });
  document.addEventListener('input', function (ev) { if (ev.target.dataset && ev.target.dataset.note && ev.target.closest('#view-mine')) S.notes[ev.target.dataset.note] = ev.target.value; });

  api('meta').then(function (m) {
    S.meta = m; S.date = m.today; S.audit.date = m.today;
    $('ver').textContent = 'v' + m.version;
    $('me').innerHTML = '<span class="nm">' + esc(m.me.name) + '</span>' + avatar(m.me);
    if (m.me.admin) $('tabAudit').hidden = false;
    if (location.hash === '#rank') setTab('rank');
    loadMine();
  }).catch(function (e) { $('view-mine').innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; });
})();
