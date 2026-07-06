(function () {
  var root = document.documentElement;

  // ---- theme toggle (persisted) ----
  var btn = document.getElementById('themeBtn');
  if (btn) btn.addEventListener('click', function () {
    var next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch (e) {}
    if (window.__renderMermaid__) window.__renderMermaid__(next);
  });

  // ---- reading-progress scrubber ----
  var scrub = document.getElementById('scrub');
  if (scrub) {
    var onScroll = function () {
      var h = root.scrollHeight - root.clientHeight;
      scrub.style.width = (h > 0 ? (root.scrollTop / h) * 100 : 0) + '%';
    };
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ---- "on this page" TOC from headings ----
  var doc = document.getElementById('doc');
  var list = document.getElementById('tocList');
  var links = [];
  if (doc && list) {
    var heads = doc.querySelectorAll('h2, h3');
    var slug = function (t, i) {
      var s = (t || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w一-龥-]/g, '');
      return 'h-' + i + (s ? '-' + s : '');
    };
    heads.forEach(function (h, i) {
      if (!h.id) h.id = slug(h.textContent, i);
      var a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent;
      if (h.tagName === 'H3') a.className = 'lvl3';
      list.appendChild(a);
      links.push({ a: a, el: h });
    });
    if (!heads.length) { var aside = list.closest('.toc'); if (aside) aside.style.display = 'none'; }

    // scroll-spy
    var spy = function () {
      var pos = root.scrollTop + 100, cur = null;
      links.forEach(function (x) { if (x.el.offsetTop <= pos) cur = x.a; });
      links.forEach(function (x) { x.a.classList.toggle('active', x.a === cur); });
    };
    addEventListener('scroll', spy, { passive: true });
    spy();
  }

  // ---- prev / next pager ----
  var pager = document.querySelector('.pager');
  if (pager && window.__TOC__ && window.__URL__) {
    var toc = window.__TOC__, idx = -1;
    for (var i = 0; i < toc.length; i++) if (toc[i].url === window.__URL__) idx = i;
    if (idx !== -1) {
      var base = document.querySelector('base') ? '' : '';
      var mk = function (item, dir, label) {
        var a = document.createElement('a');
        a.href = item.url; a.className = dir;
        a.innerHTML = '<span class="dir">' + label + '</span><span class="t">' + item.num + ' · ' + item.title + '</span>';
        return a;
      };
      if (idx > 0) pager.appendChild(mk(toc[idx - 1], 'prev', '← 上一篇'));
      if (idx < toc.length - 1) pager.appendChild(mk(toc[idx + 1], 'next', '下一篇 →'));
    }
  }
})();
