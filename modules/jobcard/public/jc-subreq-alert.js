/* ═══════════════════════════════════════════════════════════════════
 *  jc-subreq-alert.js — ⚠️ แถบเตือนบนการ์ด: งานย่อยของ Project เดียวกันยังเข้ามาไม่ครบ (v1.29.0)
 *
 *  ‼ พี่เอสั่ง 5 พ.ย. 69: "กรณี Job card ที่เป็นงานหลัก complete แต่งานย่อยยังไม่ complete ช่วยแจ้งเตือน ในหน้า card หลัก ด้วยนะ …
 *     การแจ้งเตือนที่ card หลักจะต้องอยู่จนกว่า job งานย่อยจะเข้ามาจนครบทุกใบให้ด้วย"
 *
 *  ‼ บอร์ดวาดการ์ดเสร็จ (ของเดิม ไม่แตะ) ⇒ ไฟล์นี้เห็นการ์ด ([data-jobid][data-projid]) ⇒ ถามเซิร์ฟเวอร์ครั้งเดียวทั้งจอ
 *     SRUN().getJobSubReqAlerts({ jobIDs }) (modules/jobcard/subreqs.js) ⇒ วางแถบ
 *     การ์ดเต็ม = แถบเตือนเหนือ "📢 ข้อความสำคัญ" · การ์ดย่อ = ป้ายเล็ก
 *  ‼ การ์ดนี้ Complete (Closed) แล้วแต่งานย่อยยังไม่ครบ = แถบแดง · ยังไม่จบ = แถบเหลือง
 *  ‼ การ์ดงานย่อยเข้ามาครบทุกใบแล้ว = แถบหายเอง · จำผล 3 นาที · การ์ดขึ้นก่อน ข้อมูลตามมา (ไม่ทำให้บอร์ดช้า)
 * ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var TTL = 3 * 60 * 1000, BATCH = 400;
  var S = { cache: {}, at: {}, busy: false, timer: null };
  var e = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function css() {
    if (document.getElementById('jsraCss')) return;
    var st = document.createElement('style'); st.id = 'jsraCss';
    st.textContent = '.jsra{margin:8px 10px;padding:10px 12px;border-radius:10px;border:1.5px solid #fcd34d;background:#fffbeb;color:#78350f;font-size:12.5px;line-height:1.5;text-align:left}'
      + '.jsra.red{border-color:#f87171;background:#fef2f2;color:#7f1d1d;animation:jsraPulse 2.4s ease-in-out infinite}'
      + '@keyframes jsraPulse{0%,100%{box-shadow:0 0 0 0 rgba(248,113,113,.0)}50%{box-shadow:0 0 0 4px rgba(248,113,113,.25)}}'
      + '@media (prefers-reduced-motion:reduce){.jsra.red{animation:none}}'
      + '.jsra b.h{display:block;font-size:13.5px;margin-bottom:3px}'
      + '.jsra ul{margin:4px 0 2px;padding-left:18px}.jsra li{margin:1px 0}'
      + '.jsra .st{display:inline-block;font-size:10.5px;font-weight:700;border-radius:99px;padding:0 7px;margin-left:4px;background:rgba(0,0,0,.07)}'
      + '.jsra .ft{font-size:11.5px;opacity:.85;margin-top:3px}'
      + '.jsra-chip{display:inline-flex;align-items:center;gap:3px;margin:3px 0 0;padding:1px 8px;border-radius:99px;font-size:10.5px;font-weight:800;background:#fef3c7;color:#92400e;border:1px solid #fcd34d}'
      + '.jsra-chip.red{background:#fee2e2;color:#b91c1c;border-color:#fca5a5}';
    document.head.appendChild(st);
  }
  function full(x) {
    var n = x.missing.length;
    var head = x.thisDone
      ? '⚠️ การ์ดนี้ Complete แล้ว แต่ Project นี้ยังมีงานย่อยอีก ' + n + ' รายการที่ยังไม่มี Card ผลิต'
      : '⚠️ Project นี้ยังมีงานย่อยอีก ' + n + ' รายการที่ยังไม่มี Card ผลิต';
    return '<b class="h">' + e(head) + '</b>'
      + '<div>Card ผลิตงานย่อยเข้ามาแล้ว ' + x.subCards + ' / ' + x.subTotal + ' ใบ — รายการที่ยังไม่เข้ามา (Project ย่อยยังไม่ได้กด Complete ในแอป Projects):</div>'
      + '<ul>' + x.missing.slice(0, 12).map(function (m) { return '<li>' + e(m.name) + '<span class="st">' + e(m.status) + '</span></li>'; }).join('')
      + (n > 12 ? '<li>… อีก ' + (n - 12) + ' รายการ</li>' : '') + '</ul>'
      + (x.open && x.open.length ? '<div class="ft">🏭 การ์ดงานย่อยที่เข้ามาแล้วแต่ยังผลิตไม่จบ ' + x.open.length + ' ใบ: ' + x.open.slice(0, 6).map(function (o) { return e(o.name); }).join(' · ') + (x.open.length > 6 ? ' …' : '') + '</div>' : '')
      + '<div class="ft">👉 ตามให้กด Complete งานย่อยในแอป Projects — แถบนี้จะหายเองเมื่อ Card งานย่อยเข้ามาครบทุกใบ</div>';
  }
  function paint(el) {
    var id = el.getAttribute('data-jobid'), x = S.cache[id];
    var isFull = !!el.querySelector('.sts'), sel = isFull ? '.jsra' : '.jsra-chip';
    var old = null, kids = el.querySelectorAll(sel);
    for (var i = 0; i < kids.length; i++) if (kids[i].getAttribute('data-for') === id) { old = kids[i]; break; }
    if (!x) { if (old && old.parentNode) old.parentNode.removeChild(old); return; }
    var k = [x.missing.length, x.thisDone ? 1 : 0, x.subCards, (x.open || []).length].join('|');
    if (old && old.getAttribute('data-k') === k) return;
    var n = old || document.createElement('div');
    n.setAttribute('data-for', id); n.setAttribute('data-k', k);
    if (isFull) {
      n.className = 'jsra' + (x.thisDone ? ' red' : '');
      n.setAttribute('role', 'alert');
      n.innerHTML = full(x);
      if (old) return;
      var sn = el.querySelector('.sn-sec');
      if (sn && sn.parentNode) sn.parentNode.insertBefore(n, sn); else (el.querySelector('.sts') || el).insertAdjacentElement('beforebegin', n);
    } else {
      n.className = 'jsra-chip' + (x.thisDone ? ' red' : '');
      n.title = 'Project นี้ยังมีงานย่อย ' + x.missing.length + ' รายการที่ยังไม่มี Card ผลิต';
      n.textContent = '⚠️ งานย่อยยังไม่ครบ ' + x.subCards + '/' + x.subTotal;
      if (old) return;
      (el.querySelector('.bd') || el).appendChild(n);
    }
  }
  function scan() {
    var els = document.querySelectorAll('[data-jobid][data-projid]');
    if (!els.length) return;
    css();
    var now = Date.now(), need = [];
    for (var i = 0; i < els.length; i++) {
      var id = els[i].getAttribute('data-jobid');
      if (!id || !els[i].getAttribute('data-projid')) continue;
      if (Object.prototype.hasOwnProperty.call(S.cache, id) && now - (S.at[id] || 0) < TTL) paint(els[i]);
      else if (need.indexOf(id) < 0) need.push(id);
    }
    if (!need.length || S.busy || typeof SRUN !== 'function') return;
    S.busy = true;
    var ask = need.slice(0, BATCH);
    SRUN().withSuccessHandler(function (r) {
      S.busy = false;
      if (typeof r === 'string') { try { r = JSON.parse(r); } catch (_e) { r = {}; } }
      var m = (r && r.success && r.map) || {}, t = Date.now();
      ask.forEach(function (id) { S.cache[id] = m[id] || null; S.at[id] = t; });
      scan();
    }).withFailureHandler(function (err) {
      S.busy = false;
      console.warn('[งานย่อยบนการ์ด] getJobSubReqAlerts ไม่สำเร็จ', err);
      var t = Date.now();
      ask.forEach(function (id) { if (!Object.prototype.hasOwnProperty.call(S.cache, id)) { S.cache[id] = null; S.at[id] = t; } });
    }).getJobSubReqAlerts({ jobIDs: ask });
  }
  function kick() { clearTimeout(S.timer); S.timer = setTimeout(scan, 350); }
  function start() {
    if (window.MutationObserver) {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var a = muts[i].addedNodes;
          for (var k = 0; k < a.length; k++) {
            var x = a[k];
            if (x.nodeType !== 1 || (x.classList && (x.classList.contains('jsra') || x.classList.contains('jsra-chip')))) continue;
            if ((x.hasAttribute && x.hasAttribute('data-jobid')) || (x.querySelector && x.querySelector('[data-jobid][data-projid]'))) { kick(); return; }
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
    setInterval(function () { if (!document.hidden) scan(); }, TTL);
    kick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.JCSubReqAlert = { scan: scan, _S: S, _full: full };
})();
