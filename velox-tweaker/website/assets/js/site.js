/* VELOX website - shared behaviour for every page (classic script, deferred).
 * Theme toggle, mobile menu, header state, active section in the nav, screenshot lightbox,
 * scroll reveal and the values from config.js. No tracking, no requests. */
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  var cfg = window.VELOX_SITE || {};

  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }

  // ---- values from config.js (version, download link, size)
  Array.prototype.forEach.call(doc.querySelectorAll('[data-velox]'), function (el) {
    var key = el.getAttribute('data-velox');
    if (key === 'download' && cfg.download) el.setAttribute('href', cfg.download);
    else if (key === 'source' && cfg.source) el.setAttribute('href', cfg.source);
    else if (key === 'version' && cfg.version) el.textContent = cfg.version;
    else if (key === 'size' && cfg.size) el.textContent = cfg.size;
  });
  Array.prototype.forEach.call(doc.querySelectorAll('[data-year]'), function (el) { el.textContent = String(new Date().getFullYear()); });

  // ---- theme (default dark; theme.js applied the stored one before paint)
  var themeBtns = doc.querySelectorAll('[data-theme-toggle]');
  function syncThemeButtons() {
    var light = root.getAttribute('data-theme') === 'light';
    Array.prototype.forEach.call(themeBtns, function (b) {
      b.setAttribute('aria-label', light ? 'Dunkles Design einschalten' : 'Helles Design einschalten');
      b.setAttribute('title', light ? 'Dunkles Design' : 'Helles Design');
    });
    var meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', light ? '#F2F0EB' : '#0C0D0F');
  }
  Array.prototype.forEach.call(themeBtns, function (b) {
    b.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      store('velox.site.theme', next);
      syncThemeButtons();
    });
  });
  syncThemeButtons();

  // ---- header: hairline once the page scrolls
  var header = doc.querySelector('.site-header');
  function onScroll() { if (header) header.classList.toggle('is-scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---- mobile menu
  var menuBtn = doc.querySelector('.menu-btn');
  var nav = doc.getElementById('site-nav');
  function setMenu(open) {
    if (!menuBtn || !nav) return;
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    menuBtn.setAttribute('aria-label', open ? 'Menü schließen' : 'Menü öffnen');
    nav.classList.toggle('is-open', open);
  }
  if (menuBtn && nav) {
    menuBtn.addEventListener('click', function () { setMenu(menuBtn.getAttribute('aria-expanded') !== 'true'); });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menuBtn.getAttribute('aria-expanded') === 'true') { setMenu(false); menuBtn.focus(); }
    });
    doc.addEventListener('click', function (e) {
      if (menuBtn.getAttribute('aria-expanded') === 'true' && !nav.contains(e.target) && !menuBtn.contains(e.target)) setMenu(false);
    });
    window.addEventListener('resize', function () { if (window.innerWidth > 960) setMenu(false); });
  }

  // ---- active section in the nav
  var links = nav ? nav.querySelectorAll('a[href^="#"]') : [];
  if (links.length && 'IntersectionObserver' in window) {
    var map = {};
    Array.prototype.forEach.call(links, function (a) {
      var s = doc.getElementById(a.getAttribute('href').slice(1));
      if (s) map[s.id] = a;
    });
    var visible = {};
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { visible[en.target.id] = en.isIntersecting; });
      var current = null;
      Object.keys(map).forEach(function (id) { if (visible[id] && !current) current = id; });
      Array.prototype.forEach.call(links, function (a) { a.removeAttribute('aria-current'); });
      if (current) map[current].setAttribute('aria-current', 'true');
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(map).forEach(function (id) { spy.observe(doc.getElementById(id)); });
  }

  // ---- scroll reveal (CSS skips it under reduced motion)
  var reveals = doc.querySelectorAll('.reveal');
  if (reveals.length) {
    if ('IntersectionObserver' in window) {
      var rio = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('is-in'); rio.unobserve(en.target); } });
      }, { rootMargin: '0px 0px -8% 0px' });
      Array.prototype.forEach.call(reveals, function (el) { rio.observe(el); });
    } else {
      Array.prototype.forEach.call(reveals, function (el) { el.classList.add('is-in'); });
    }
  }

  // ---- screenshot lightbox
  var box = doc.getElementById('lightbox');
  if (box && typeof box.showModal === 'function') {
    var boxImg = box.querySelector('img'), boxTitle = box.querySelector('[data-lightbox-title]');
    var opener = null;
    Array.prototype.forEach.call(doc.querySelectorAll('.shot-frame[data-full]'), function (btn) {
      btn.addEventListener('click', function () {
        var img = btn.querySelector('img');
        opener = btn;
        boxImg.src = btn.getAttribute('data-full');
        boxImg.alt = img ? img.alt : '';
        if (boxTitle) boxTitle.textContent = img ? img.alt : '';
        box.showModal();
      });
    });
    box.addEventListener('click', function (e) { if (e.target === box || e.target.closest('[data-lightbox-close]')) box.close(); });
    box.addEventListener('close', function () { if (opener) opener.focus(); });
  } else {
    // no <dialog>: open the big image directly
    Array.prototype.forEach.call(doc.querySelectorAll('.shot-frame[data-full]'), function (btn) {
      btn.addEventListener('click', function () { window.open(btn.getAttribute('data-full'), '_blank', 'noopener'); });
    });
  }

  // ---- hero: if the intro module never starts (old browser, opened as a file), show the still wordmark
  var stage = doc.getElementById('hero-stage');
  if (stage) setTimeout(function () { if (!window.__veloxHero) root.classList.add('hero-failed'); }, 2500);
})();
