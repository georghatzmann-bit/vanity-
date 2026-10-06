/* VELOX Setup - installer UI logic.
 *
 * Talks to VeloxSetup.exe through window.chrome.webview (docs/ARCHITECTURE.md, "Native host & installer"):
 *   page -> setup: ready | drag | minimize | close | browse{dir} | checkRunning
 *                  | install{dir,desktop,startMenu,launch,closeRunning} | uninstall{keepData,closeRunning}
 *                  | launch | openLog | exit
 *   setup -> page: init{version,mode,installedVersion,dir,defaultDir,sizeMB,freeMB,running}
 *                  | folder{dir,error,freeMB} | running{running} | progress{percent,step,file}
 *                  | done{mode,launched} | error{message,hint}
 *
 * Motion: DOM animations use transform / opacity (Web Animations API); particles, the energy pulse and the
 * confetti are drawn on one canvas whose frame loop only runs while something moves. Every smoothing step
 * is frame-rate independent: v += (target - v) * (1 - exp(-speed * dt)).
 * prefers-reduced-motion: a calm fade instead of the intro, no particles, no parallax, no equalizer.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;
  var stage = $('stage');
  var hero = $('hero');
  var heroTilt = $('hero-tilt');
  var word = $('word');
  var aurora = document.querySelector('.aurora');
  var reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { reduced = false; }
  if (reduced) body.classList.add('reduced');

  var bridge = (window.chrome && window.chrome.webview) ? window.chrome.webview : null;
  var HERO_PX = 160;          // .hero box in CSS px; slots scale it
  var VB = 60, VB0 = -6;      // hero-logo viewBox "-6 -6 60 60"
  var CAP_BASE = [13, 35, 13];  // fader cap centres (logo units) that make the V

  var S = {
    screen: 'intro', mode: 'install', version: '', installedVersion: '', dir: '', defaultDir: '',
    sizeMB: 0, freeMB: -1, running: false, inited: false, introDone: false, task: null,
    busy: false, launched: false, keepData: true, pendingDone: null
  };

  function send(type, data) {
    var m = { type: type };
    if (data) for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) m[k] = data[k];
    if (bridge) { try { bridge.postMessage(m); } catch (e) { /* window is closing */ } }
    else preview(m);
  }

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function smooth(v, target, speed, dt) { return v + (target - v) * (1 - Math.exp(-speed * dt)); }
  function setText(id, t) { var el = $(id); if (el) el.textContent = t == null ? '' : String(t); }
  function fmtMB(mb) {
    if (mb < 0) return '';
    if (mb >= 1024) return (mb / 1024).toFixed(mb >= 102400 ? 0 : 1).replace('.', ',') + ' GB';
    return Math.max(1, Math.round(mb)) + ' MB';
  }

  // ================================================================== layout: slots + shared hero
  Array.prototype.forEach.call(document.querySelectorAll('.in[data-i]'), function (el) { el.style.setProperty('--i', el.getAttribute('data-i')); });
  Array.prototype.forEach.call(document.querySelectorAll('.slot-logo'), function (el) { el.style.setProperty('--slot', el.getAttribute('data-size')); });

  var heroBox = { x: 0, y: 0, size: 176, visible: false };

  function offsetIn(el, ancestor) {
    var x = 0, y = 0;
    while (el && el !== ancestor) { x += el.offsetLeft; y += el.offsetTop; el = el.offsetParent; }
    return { x: x, y: y };
  }
  function slotOf(screen, kind) { return document.querySelector('.screen[data-screen="' + screen + '"] .slot[data-slot="' + kind + '"]'); }

  function sizeWordSlots() {
    var w = word.offsetWidth, h = word.offsetHeight;
    Array.prototype.forEach.call(document.querySelectorAll('.slot-word'), function (el) {
      var k = parseFloat(el.getAttribute('data-scale')) || 1;
      el.style.width = Math.ceil(w * k) + 'px';
      el.style.height = Math.ceil(h * k) + 'px';
    });
  }

  function placeHero(glide) {
    hero.classList.toggle('glide', !!glide);
    word.classList.toggle('glide', !!glide);
    var ls = slotOf(S.screen, 'logo'), ws = slotOf(S.screen, 'word');
    if (ls) {
      var p = offsetIn(ls, stage), size = parseFloat(ls.getAttribute('data-size')) || 112;
      hero.style.transform = 'translate3d(' + p.x + 'px,' + p.y + 'px,0) scale(' + (size / HERO_PX) + ')';
      hero.style.opacity = '1';
      heroBox = { x: p.x, y: p.y, size: size, visible: true };
    } else {
      hero.style.opacity = '0';
      heroBox.visible = false;
    }
    if (ws) {
      var q = offsetIn(ws, stage), k = parseFloat(ws.getAttribute('data-scale')) || 1;
      word.style.transform = 'translate3d(' + q.x + 'px,' + q.y + 'px,0) scale(' + k + ')';
      word.style.opacity = '1';
    } else {
      word.style.opacity = '0';
    }
  }

  /** logo units -> canvas (window) px, for the current hero slot */
  function logoPt(u, v) {
    return {
      x: heroBox.x + (u - VB0) / VB * heroBox.size,
      y: stage.offsetTop + heroBox.y + (v - VB0) / VB * heroBox.size
    };
  }

  // ================================================================== screens
  var leaveTimers = {};
  function show(name) {
    if (S.screen === name) return;
    var prev = document.querySelector('.screen.active');
    var next = document.querySelector('.screen[data-screen="' + name + '"]');
    if (!next) return;
    if (prev) {
      prev.classList.remove('active');
      prev.classList.add('leaving');
      var pn = prev.getAttribute('data-screen');
      clearTimeout(leaveTimers[pn]);
      leaveTimers[pn] = setTimeout(function () { prev.classList.remove('leaving'); }, 180);
    }
    next.classList.remove('leaving');
    next.classList.add('active');
    S.screen = name;
    body.setAttribute('data-screen', name);
    placeHero(S.introDone && !reduced);
    $('btn-close').disabled = name === 'progress';
    if (name === 'progress') startEq(); else stopEq();
    if (name === 'welcome') scheduleIdleSweep(); else clearTimeout(idleTimer);
    focusPrimary(name);
  }

  // move focus to the main button only for keyboard users (a mouse user would just see a focus ring)
  var keyboardUser = false;
  document.addEventListener('keydown', function (e) { if (e.key === 'Tab' || e.key === 'Enter' || e.key === ' ') keyboardUser = true; }, true);
  document.addEventListener('mousedown', function () { keyboardUser = false; }, true);
  function focusPrimary(name) {
    if (!keyboardUser) { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return; }
    var id = { welcome: 'btn-install', options: 'btn-install2', done: $('btn-launch').hidden ? 'btn-done-close' : 'btn-launch', error: 'btn-retry', uninstall: 'btn-uninstall' }[name];
    if (!id) return;
    setTimeout(function () { var b = $(id); if (b && S.screen === name) { try { b.focus({ preventScroll: true }); } catch (e) { b.focus(); } } }, 120);
  }

  function homeScreen() { return S.mode === 'uninstall' ? 'uninstall' : 'welcome'; }

  // ================================================================== canvas fx
  var fx = { cv: $('fx'), ctx: null, w: 0, h: 0, dpr: 1, parts: [], drivers: [], running: false, last: 0 };
  try { fx.ctx = fx.cv.getContext('2d'); } catch (e) { fx.ctx = null; }

  function resizeFx() {
    fx.dpr = Math.min(window.devicePixelRatio || 1, 2);
    fx.w = window.innerWidth; fx.h = window.innerHeight;
    fx.cv.width = Math.round(fx.w * fx.dpr); fx.cv.height = Math.round(fx.h * fx.dpr);
    if (fx.ctx) fx.ctx.setTransform(fx.dpr, 0, 0, fx.dpr, 0, 0);
  }

  function sprite(rgb, core) {
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var g = c.getContext('2d');
    var gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,' + core + ')');
    gr.addColorStop(0.16, 'rgba(' + rgb + ',0.95)');
    gr.addColorStop(0.45, 'rgba(' + rgb + ',0.28)');
    gr.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return c;
  }
  var SPR = fx.ctx ? [sprite('124,92,255', 1), sprite('34,211,238', 1), sprite('156,134,255', 0.6)] : [];
  var CONFETTI = ['#7C5CFF', '#22D3EE', '#9C86FF', '#E8EAF0', '#34D399', '#B6A6FF'];

  function kick() {
    if (fx.running || !fx.ctx) return;
    fx.running = true; fx.last = now();
    requestAnimationFrame(frame);
  }

  function frame(t) {
    var dt = Math.min(0.05, Math.max(0, (t - fx.last) / 1000)); fx.last = t;
    var ctx = fx.ctx;
    ctx.clearRect(0, 0, fx.w, fx.h);
    var i, d;
    for (i = fx.drivers.length - 1; i >= 0; i--) { d = fx.drivers[i]; if (d(t, dt, ctx) === false) fx.drivers.splice(i, 1); }
    ctx.globalCompositeOperation = 'lighter';
    var alive = [];
    for (i = 0; i < fx.parts.length; i++) { var p = fx.parts[i]; if (p.kind !== 'confetti' && step(p, t, dt, ctx)) alive.push(p); }
    ctx.globalCompositeOperation = 'source-over';
    for (i = 0; i < fx.parts.length; i++) { var c = fx.parts[i]; if (c.kind === 'confetti' && step(c, t, dt, ctx)) alive.push(c); }
    ctx.globalAlpha = 1;
    fx.parts = alive;
    if (fx.parts.length || fx.drivers.length) requestAnimationFrame(frame);
    else { fx.running = false; ctx.clearRect(0, 0, fx.w, fx.h); }
  }

  function ease3(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }

  /** advances and draws one particle; false = dead */
  function step(p, t, dt, ctx) {
    var age = t - p.t0;
    if (p.kind === 'conv') {
      if (age < 0) return true;
      var k = Math.min(1, age / p.dur), e = ease3(k), u = 1 - e;
      var x = u * u * p.sx + 2 * u * e * p.cx + e * e * p.tx, y = u * u * p.sy + 2 * u * e * p.cy + e * e * p.ty;
      var a = k < 0.15 ? k / 0.15 : (k > 0.85 ? (1 - k) / 0.15 : 1);
      var s = p.size * (0.6 + 0.6 * (1 - e));
      if (p.px != null) {
        ctx.globalAlpha = a * 0.35; ctx.strokeStyle = p.trail; ctx.lineWidth = s * 0.18;
        ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(x, y); ctx.stroke();
      }
      ctx.globalAlpha = a; ctx.drawImage(SPR[p.spr], x - s / 2, y - s / 2, s, s);
      p.px = x; p.py = y;
      return k < 1;
    }
    if (p.kind === 'spark') {
      if (age < 0) return true;
      var life = age / p.life;
      if (life >= 1) return false;
      var drag = Math.exp(-p.drag * dt);
      p.vx *= drag; p.vy = p.vy * drag + p.g * dt;
      var ox = p.x, oy = p.y;
      p.x += p.vx * dt; p.y += p.vy * dt;
      var al = (1 - life) * (1 - life);
      ctx.globalAlpha = al * 0.55; ctx.strokeStyle = p.trail; ctx.lineWidth = p.size * 0.22;
      ctx.beginPath(); ctx.moveTo(ox - (p.x - ox) * 2, oy - (p.y - oy) * 2); ctx.lineTo(p.x, p.y); ctx.stroke();
      var ss = p.size * (1 - life * 0.5);
      ctx.globalAlpha = al; ctx.drawImage(SPR[p.spr], p.x - ss / 2, p.y - ss / 2, ss, ss);
      return true;
    }
    if (p.kind === 'confetti') {
      if (age < 0) return true;
      var lf = age / p.life;
      if (lf >= 1) return false;
      var dr = Math.exp(-p.drag * dt);
      p.vx *= dr; p.vy = p.vy * dr + p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt; p.flip += p.vf * dt;
      ctx.globalAlpha = lf > 0.7 ? (1 - lf) / 0.3 : 1;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(1, Math.cos(p.flip));
      ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
      return true;
    }
    return false;
  }

  function sparks(x, y, n, speed, opts) {
    if (reduced || !fx.ctx) return;
    opts = opts || {};
    var t0 = now() + (opts.delay || 0);
    for (var i = 0; i < n; i++) {
      var ang = (opts.angle != null ? opts.angle + (Math.random() - 0.5) * (opts.spread || Math.PI * 2) : Math.random() * Math.PI * 2);
      var v = speed * (0.35 + Math.random() * 0.65);
      var spr = Math.random() < 0.6 ? 0 : 1;
      fx.parts.push({
        kind: 'spark', t0: t0, x: x, y: y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v,
        drag: opts.drag || 3.2, g: opts.g || 0, life: (opts.life || 700) * (0.6 + Math.random() * 0.6),
        size: (opts.size || 9) * (0.6 + Math.random() * 0.8), spr: spr, trail: spr ? 'rgba(34,211,238,1)' : 'rgba(156,134,255,1)'
      });
    }
    kick();
  }

  /** cinematic anamorphic streak through (x, y): stretched glow sprites, no per-frame gradients */
  function flare(x, y) {
    if (reduced || !fx.ctx) return;
    var t0 = now(), dur = 820;
    fx.drivers.push(function (t, dt, ctx) {
      var k = (t - t0) / dur;
      if (k >= 1) return false;
      if (k < 0) return true;
      var e = 1 - Math.pow(1 - k, 3), a = (1 - k) * (1 - k);
      var half = fx.w * (0.1 + 0.42 * e);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55 * a; ctx.drawImage(SPR[0], x - half * 0.75, y - 26, half * 1.5, 52);
      ctx.globalAlpha = 0.95 * a; ctx.drawImage(SPR[1], x - half, y - 4, half * 2, 8);
      ctx.globalAlpha = a; ctx.drawImage(SPR[2], x - half * 0.55, y - 1.5, half * 1.1, 3);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      return true;
    });
    kick();
  }

  function confetti(x, y, n, opts) {
    if (reduced || !fx.ctx) return;
    opts = opts || {};
    var t0 = now() + (opts.delay || 0);
    var base = opts.angle != null ? opts.angle : -Math.PI / 2, spread = opts.spread || Math.PI * 1.5, sp = opts.speed || 1;
    for (var i = 0; i < n; i++) {
      var ang = base + (Math.random() - 0.5) * spread;
      var v = (380 + Math.random() * 520) * sp;
      fx.parts.push({
        kind: 'confetti', t0: t0 + Math.random() * 80, x: x + (Math.random() - 0.5) * 30, y: y + (Math.random() - 0.5) * 20,
        vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, drag: 2.1, g: 900, life: 1700 + Math.random() * 900,
        w: 5 + Math.random() * 5, h: 3 + Math.random() * 4, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 14,
        flip: Math.random() * 6.28, vf: 6 + Math.random() * 10, color: CONFETTI[i % CONFETTI.length]
      });
    }
    kick();
  }

  /** a glowing point that gathers energy (the seed the logo grows from) */
  function seed(x, y, dur) {
    if (reduced || !fx.ctx) return;
    var t0 = now();
    fx.drivers.push(function (t, dt, ctx) {
      var k = (t - t0) / dur;
      if (k >= 1 || intro.done) return false;
      var grow = Math.min(1, k / 0.55), fade = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
      var flick = 0.85 + 0.15 * Math.sin(t / 38) * Math.sin(t / 71);
      var sz = (14 + 70 * grow * grow) * flick;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.9 * fade; ctx.drawImage(SPR[0], x - sz / 2, y - sz / 2, sz, sz);
      ctx.globalAlpha = fade; ctx.drawImage(SPR[1], x - sz / 5, y - sz / 5, sz / 2.5, sz / 2.5);
      // a thin horizontal glint through the seed
      ctx.globalAlpha = 0.5 * fade * grow; ctx.drawImage(SPR[2], x - sz * 1.6, y - 1.5, sz * 3.2, 3);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      return true;
    });
    kick();
  }

  /** god rays + double shock ring around the hero logo (ignition and finish) */
  function burstRings(scale) {
    if (reduced) return [];
    scale = scale || 1;
    var out = [];
    var r = $('hero-rays'), s1 = $('hero-shock'), s2 = $('hero-shock2');
    if (r && r.animate) out.push(r.animate([{ opacity: 0, transform: 'rotate(0deg) scale(.55)' }, { opacity: 0.95, transform: 'rotate(9deg) scale(1)', offset: 0.16 }, { opacity: 0, transform: 'rotate(34deg) scale(1.18)' }], { duration: 1700, easing: 'cubic-bezier(.2,.7,.3,1)' }));
    if (s1 && s1.animate) out.push(s1.animate([{ opacity: 0, transform: 'scale(.35)' }, { opacity: 1, offset: 0.12 }, { opacity: 0, transform: 'scale(' + (2.8 * scale) + ')' }], { duration: 820, easing: 'cubic-bezier(.1,.7,.25,1)' }));
    if (s2 && s2.animate) out.push(s2.animate([{ opacity: 0, transform: 'scale(.3)' }, { opacity: 0.9, offset: 0.14 }, { opacity: 0, transform: 'scale(' + (3.9 * scale) + ')' }], { duration: 1100, delay: 110, easing: 'cubic-bezier(.1,.7,.25,1)', fill: 'backwards' }));
    return out;
  }

  /** a tiny camera punch: the whole stage kicks towards the viewer and settles */
  function punch() {
    if (reduced || !stage.animate) return null;
    return stage.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.014)', offset: 0.18 }, { transform: 'scale(.997)', offset: 0.55 }, { transform: 'scale(1)' }], { duration: 520, easing: 'ease-out' });
  }

  // ================================================================== intro
  var intro = { anims: [], events: [], t0: 0, done: false, endTimer: 0 };
  var vMain = $('v-main'), vGlow = $('v-glow');
  var caps = [$('cap1'), $('cap2'), $('cap3')];
  var capGroups = [document.querySelector('.cap-g.g1'), document.querySelector('.cap-g.g2'), document.querySelector('.cap-g.g3')];
  var tracks = [document.querySelector('.track.t1'), document.querySelector('.track.t2'), document.querySelector('.track.t3')];
  var letters = Array.prototype.slice.call(document.querySelectorAll('#word-sharp span'));
  var TRACK_X = [11, 24, 37];

  function anim(el, kf, opt) {
    if (!el || !el.animate) return null;
    var o = { fill: 'backwards', easing: 'linear' };
    for (var k in opt) if (Object.prototype.hasOwnProperty.call(opt, k)) o[k] = opt[k];
    var a = el.animate(kf, o);
    intro.anims.push(a);
    return a;
  }

  function vPoint(p) {   // point on the V polyline (logo units), p 0..1
    if (p <= 0.5) { var k = p * 2; return { u: 11 + 13 * k, v: 13 + 22 * k }; }
    var q = (p - 0.5) * 2; return { u: 24 + 13 * q, v: 35 - 22 * q };
  }

  function runIntro() {
    S.screen = 'intro';
    document.querySelector('.screen.intro').classList.add('active');
    placeHero(false);
    intro.t0 = now();
    if (reduced) {
      anim(hero, [{ opacity: 0 }, { opacity: 1 }], { duration: 600, easing: 'ease-out' });
      anim(word, [{ opacity: 0 }, { opacity: 1 }], { duration: 600, delay: 200, easing: 'ease-out' });
      body.classList.remove('booting');
      intro.endTimer = setTimeout(endIntro, 1400);
      return;
    }
    var T = 0.94;   // global tempo
    var ms = function (x) { return x * T; };
    var spring = 'cubic-bezier(.34,1.56,.64,1)', glide = 'cubic-bezier(.22,1,.36,1)';

    // 1) particles converge onto the three fader tracks
    var targets = [];
    for (var ti = 0; ti < 3; ti++) for (var tv = 6; tv <= 42; tv += 2.2) targets.push({ u: TRACK_X[ti], v: tv });
    var cx = fx.w / 2, cy = stage.offsetTop + heroBox.y + heroBox.size / 2, R = Math.max(fx.w, fx.h) * 0.62;
    var t0 = intro.t0;
    for (var i = 0; i < targets.length * 2; i++) {
      var tg = targets[i % targets.length], tp = logoPt(tg.u + (Math.random() - 0.5) * 1.2, tg.v);
      var ang = Math.random() * Math.PI * 2, rr = R * (0.55 + Math.random() * 0.6);
      var sx = cx + Math.cos(ang) * rr, sy = cy + Math.sin(ang) * rr * 0.75;
      var swirl = (Math.random() < 0.5 ? 1 : -1) * (0.35 + Math.random() * 0.4);
      var mx = (sx + tp.x) / 2, my = (sy + tp.y) / 2;
      var spr = Math.random() < 0.7 ? 0 : 1;
      fx.parts.push({
        kind: 'conv', t0: t0 + ms(Math.random() * 380), dur: ms(620 + Math.random() * 360),
        sx: sx, sy: sy, tx: tp.x, ty: tp.y, cx: mx - (tp.y - sy) * swirl, cy: my + (tp.x - sx) * swirl,
        size: 7 + Math.random() * 9, spr: spr, trail: spr ? 'rgba(34,211,238,1)' : 'rgba(124,92,255,1)'
      });
    }
    kick();
    // the energy seed in the centre the particles are drawn to - the first frame is never empty
    var sc = logoPt(24, 24);
    seed(sc.x, sc.y, ms(1100));

    // 2) tracks draw in from the top
    anim(document.querySelector('.hero-glow'), [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 0.9, transform: 'scale(1)' }], { duration: ms(1300), delay: ms(250), easing: glide });
    tracks.forEach(function (tr, k) {
      anim(tr, [{ transform: 'scaleY(0)', opacity: 0 }, { opacity: 1, offset: 0.25 }, { transform: 'scaleY(1)', opacity: 1 }], { duration: ms(460), delay: ms(380 + k * 70), easing: glide });
    });

    // 3) caps drop in with a squash-and-stretch spring
    var dropOrder = [0, 2, 1], dropFrom = [-34, -56, -34];
    dropOrder.forEach(function (ci, k) {
      var delay = ms(760 + k * 105), dur = ms(640), from = dropFrom[ci];
      anim(capGroups[ci], [
        { transform: 'translateY(' + from + 'px) scale(.9,1.15)', opacity: 0, easing: 'cubic-bezier(.5,0,.92,.55)' },
        { opacity: 1, offset: 0.2 },
        { transform: 'translateY(0) scale(1.18,.72)', offset: 0.42, easing: 'cubic-bezier(.2,.8,.3,1)' },
        { transform: 'translateY(-3.2px) scale(.94,1.07)', offset: 0.64, easing: 'ease-in-out' },
        { transform: 'translateY(0) scale(1.03,.97)', offset: 0.82, easing: 'ease-in-out' },
        { transform: 'translateY(0) scale(1,1)', opacity: 1 }
      ], { duration: dur, delay: delay });
      intro.events.push({ at: delay + dur * 0.42, fn: function () {
        var p = logoPt(TRACK_X[ci], CAP_BASE[ci] + 3.5);
        sparks(p.x, p.y, 14, 260, { angle: -Math.PI / 2, spread: Math.PI * 0.9, life: 420, size: 7, g: 500 });
      } });
    });

    // 4) energy pulse races along the V (dash reveal + comet on the canvas), then ignition
    var pulseAt = ms(1330), pulseDur = ms(400);
    [vMain, vGlow].forEach(function (v) { v.style.strokeDasharray = '100 120'; v.style.strokeDashoffset = '100'; });
    var lastEmit = 0;
    fx.drivers.push(function (t, dt, ctx) {
      if (intro.done) return false;
      var k = (t - intro.t0 - pulseAt) / pulseDur;
      if (k < 0) return true;
      var p = Math.min(1, Math.pow(Math.min(1, k), 1.7));
      var off = (100 - 100 * p).toFixed(2);
      vMain.style.strokeDashoffset = off; vGlow.style.strokeDashoffset = off;
      if (k <= 1.02) {
        var vp = vPoint(p), pt = logoPt(vp.u, vp.v), sz = heroBox.size * 0.5;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 1; ctx.drawImage(SPR[1], pt.x - sz / 2, pt.y - sz / 2, sz, sz);
        ctx.globalAlpha = 0.9; ctx.drawImage(SPR[0], pt.x - sz * 0.35, pt.y - sz * 0.35, sz * 0.7, sz * 0.7);
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
        if (t - lastEmit > 16) { lastEmit = t; sparks(pt.x, pt.y, 3, 120, { life: 380, size: 6 }); }
        return true;
      }
      [vMain, vGlow].forEach(function (v) { v.style.strokeDasharray = ''; v.style.strokeDashoffset = ''; });
      return false;
    });
    var ignite = pulseAt + pulseDur;
    intro.events.push({ at: ignite, fn: function () {
      var c = logoPt(24, 24);
      sparks(c.x, c.y, 70, 900, { life: 900, size: 10, drag: 3.6 });
      var b = logoPt(24, 35);
      sparks(b.x, b.y, 18, 420, { angle: Math.PI / 2, spread: Math.PI * 0.8, life: 600, size: 7, g: 300 });
      flare(c.x, logoPt(24, 26).y);
      burstRings(1);   // not in intro.anims: they may keep fading out while the logo glides on
      punch();
      body.classList.add('lit');
    } });
    anim($('hero-flash'), [{ opacity: 0, transform: 'scale(.55)' }, { opacity: 1, transform: 'scale(1.05)', offset: 0.18 }, { opacity: 0, transform: 'scale(1.6)' }], { duration: ms(760), delay: ignite, easing: 'cubic-bezier(.2,.7,.3,1)' });
    anim(vGlow, [{ opacity: 0.55 }, { opacity: 1, offset: 0.2 }, { opacity: 0.55 }], { duration: ms(900), delay: ignite, easing: 'ease-out' });
    anim(heroTilt, [{ transform: 'scale(1)' }, { transform: 'scale(1.075)', offset: 0.22 }, { transform: 'scale(.99)', offset: 0.6 }, { transform: 'scale(1)' }], { duration: ms(620), delay: ignite, easing: 'ease-out' });

    // 5) light sweep over the caps
    anim($('cap-sweep'), [{ transform: 'translateX(0)', opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.8 }, { transform: 'translateX(66px)', opacity: 0 }], { duration: ms(560), delay: ignite + ms(90), easing: 'cubic-bezier(.4,0,.2,1)' });

    // 6) the wordmark resolves from blur, letters from the centre outwards, then a shine runs over it
    var wordAt = ignite + ms(120);
    anim(word.querySelector('.word-blur'), [{ opacity: 0, transform: 'scaleX(1.35)' }, { opacity: 0.85, transform: 'scaleX(1.05)', offset: 0.35 }, { opacity: 0, transform: 'scaleX(1)' }], { duration: ms(780), delay: wordAt, easing: 'ease-out' });
    letters.forEach(function (l, k) {
      anim(l, [{ opacity: 0, transform: 'translateY(9px) scale(1.25)', filter: 'blur(9px)' }, { opacity: 1, transform: 'translateY(0) scale(1)', filter: 'blur(0px)' }],
        { duration: ms(560), delay: wordAt + ms(70 + Math.abs(k - 2) * 70), easing: glide });
    });
    anim($('word-shine'), [{ opacity: 0, WebkitMaskPosition: '100% 0', maskPosition: '100% 0' }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0, WebkitMaskPosition: '0% 0', maskPosition: '0% 0' }],
      { duration: ms(720), delay: wordAt + ms(520), easing: 'cubic-bezier(.45,0,.25,1)' });

    // event clock + end
    fx.drivers.push(function (t) {
      if (intro.done) return false;
      var el = t - intro.t0;
      for (var e = 0; e < intro.events.length; e++) {
        var ev = intro.events[e];
        if (!ev.fired && el >= ev.at) { ev.fired = true; try { ev.fn(); } catch (err) { /* cosmetic only */ } }
      }
      return el < wordAt + ms(1400);
    });
    body.classList.remove('booting');
    intro.endTimer = setTimeout(endIntro, wordAt + ms(980));
  }

  function skipIntro() {
    if (intro.done) return;
    intro.anims.forEach(function (a) { try { a.cancel(); } catch (e) { /* gone */ } });
    intro.anims = [];
    fx.parts = [];
    [vMain, vGlow].forEach(function (v) { v.style.strokeDasharray = ''; v.style.strokeDashoffset = ''; });
    endIntro();
  }

  function endIntro() {
    if (intro.done) return;
    intro.done = true;
    clearTimeout(intro.endTimer);
    body.classList.remove('booting');
    S.introDone = true;
    if (S.inited) route();
    // else: route() runs when "init" arrives
  }

  function route() {
    if (S.screen === 'intro') show(homeScreen());
  }

  // ================================================================== parallax (mouse) + idle sweep
  var par = { tx: 0, ty: 0, x: 0, y: 0, running: false, last: 0 };
  window.addEventListener('mousemove', function (e) {
    if (reduced) return;
    par.tx = clamp(e.clientX / window.innerWidth * 2 - 1, -1, 1);
    par.ty = clamp(e.clientY / window.innerHeight * 2 - 1, -1, 1);
    if (!par.running) { par.running = true; par.last = now(); requestAnimationFrame(parFrame); }
  });
  document.addEventListener('mouseleave', function () { par.tx = 0; par.ty = 0; });
  function parFrame(t) {
    var dt = Math.min(0.05, Math.max(0, (t - par.last) / 1000)); par.last = t;
    par.x = smooth(par.x, par.tx, 5, dt); par.y = smooth(par.y, par.ty, 5, dt);
    var tilt = S.introDone && S.screen !== 'intro';
    heroTilt.style.transform = tilt ? 'perspective(520px) rotateX(' + (-par.y * 9).toFixed(2) + 'deg) rotateY(' + (par.x * 11).toFixed(2) + 'deg)' : '';
    aurora.style.transform = 'translate3d(' + (-par.x * 18).toFixed(1) + 'px,' + (-par.y * 12).toFixed(1) + 'px,0)';
    if (Math.abs(par.x - par.tx) + Math.abs(par.y - par.ty) > 0.001) requestAnimationFrame(parFrame);
    else par.running = false;
  }

  var idleTimer = 0;
  function scheduleIdleSweep() {
    clearTimeout(idleTimer);
    if (reduced) return;
    idleTimer = setTimeout(function () {
      if (S.screen !== 'welcome') return;
      var sw = $('cap-sweep');
      if (sw && sw.animate) sw.animate([{ transform: 'translateX(0)', opacity: 0 }, { opacity: 0.8, offset: 0.25 }, { opacity: 0.8, offset: 0.75 }, { transform: 'translateX(66px)', opacity: 0 }], { duration: 900, easing: 'cubic-bezier(.4,0,.2,1)' });
      var sh = $('word-shine');
      if (sh && sh.animate) sh.animate([{ opacity: 0, WebkitMaskPosition: '100% 0', maskPosition: '100% 0' }, { opacity: 0.8, offset: 0.2 }, { opacity: 0.8, offset: 0.8 }, { opacity: 0, WebkitMaskPosition: '0% 0', maskPosition: '0% 0' }], { duration: 1000, delay: 200, easing: 'cubic-bezier(.45,0,.25,1)' });
      scheduleIdleSweep();
    }, 6500);
  }

  // ================================================================== progress: ring + live equalizer
  var prog = { target: 0, shown: 0, running: false, last: 0, fast: false };
  var ringArc = $('ring-arc'), ringSpark = $('ring-spark');

  function setProgressTarget(pct) {
    prog.target = clamp(pct, 0, 100);
    if (!prog.running) { prog.running = true; prog.last = now(); requestAnimationFrame(progFrame); }
  }
  function renderProgress(v) {
    ringArc.style.strokeDashoffset = (1000 - v * 10).toFixed(1);
    ringSpark.style.transform = 'rotate(' + (v * 3.6).toFixed(2) + 'deg)';
    var n = v >= 99.5 ? 100 : Math.floor(v);
    var el = $('pct-num');
    if (el.textContent !== String(n)) el.textContent = String(n);
    $('pbar').setAttribute('aria-valuenow', String(n));
  }
  /** window position of the ring's head at v percent (the arc starts at 12 o'clock, clockwise) */
  function ringPoint(v) {
    var r = $('ring-arc').ownerSVGElement.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.width * 92 / 200, a = v / 100 * Math.PI * 2;
    return { x: cx + Math.sin(a) * R, y: cy - Math.cos(a) * R, a: a, cx: cx, cy: cy, R: R };
  }
  var cometAt = 0;
  function comet(t, before, after) {
    if (reduced || !fx.ctx || S.screen !== 'progress' || after - before < 0.02 || t - cometAt < 34) return;
    cometAt = t;
    var p = ringPoint(after), speed = clamp((after - before) * 60, 0.4, 3);
    // sparks peel off backwards along the arc, like a grinder
    sparks(p.x, p.y, Math.round(1 + speed), 150 + 70 * speed, { angle: p.a + Math.PI, spread: 1.1, life: 460, size: 6.5, drag: 4 });
  }
  function ringBurst() {
    if (reduced) return;
    var c = ringPoint(0);
    for (var i = 0; i < 28; i++) {
      var a = i / 28 * Math.PI * 2;
      sparks(c.cx + Math.sin(a) * c.R, c.cy - Math.cos(a) * c.R, 1, 380, { angle: a - Math.PI / 2, spread: 0.5, life: 620, size: 8, drag: 3.4 });
    }
    var g = $('ring-glow');
    if (g && g.animate) g.animate([{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'scale(1.02)', offset: 0.25 }, { opacity: 0, transform: 'scale(1.16)' }], { duration: 700, easing: 'cubic-bezier(.2,.7,.3,1)' });
  }
  function progFrame(t) {
    var dt = Math.min(0.05, Math.max(0, (t - prog.last) / 1000)); prog.last = t;
    var before = prog.shown;
    if (reduced) prog.shown = prog.target;
    else prog.shown = smooth(prog.shown, prog.target, prog.fast ? 9 : 4.5, dt);
    if (Math.abs(prog.target - prog.shown) < 0.05) prog.shown = prog.target;
    comet(t, before, prog.shown);
    renderProgress(prog.shown);
    if (prog.pendingDone && prog.shown >= 99.5) { var f = prog.pendingDone; prog.pendingDone = null; ringBurst(); setTimeout(f, reduced ? 0 : 420); }
    if (prog.shown !== prog.target || prog.pendingDone) requestAnimationFrame(progFrame);
    else prog.running = false;
  }
  function resetProgress() {
    prog.target = 0; prog.shown = 0; prog.fast = false; prog.pendingDone = null;
    renderProgress(0);
    setText('p-step', 'Vorbereiten …'); setText('p-file', '');
  }

  var eq = { on: false, running: false, last: 0, y: CAP_BASE.slice(), ph: [Math.random() * 6, Math.random() * 6, Math.random() * 6] };
  function startEq() {
    if (reduced) return;
    eq.on = true;
    $('stage').querySelector('.progress').classList.add('running');
    if (!eq.running) { eq.running = true; eq.last = now(); requestAnimationFrame(eqFrame); }
  }
  function stopEq() {
    eq.on = false;
    $('stage').querySelector('.progress').classList.remove('running');
  }
  function setCaps(y) {
    for (var i = 0; i < 3; i++) caps[i].setAttribute('y', (y[i] - 3.5).toFixed(2));
    var d = 'M11 ' + y[0].toFixed(2) + ' 24 ' + y[1].toFixed(2) + ' 37 ' + y[2].toFixed(2);
    vMain.setAttribute('d', d); vGlow.setAttribute('d', d);
  }
  function eqFrame(t) {
    var dt = Math.min(0.05, Math.max(0, (t - eq.last) / 1000)); eq.last = t;
    var s = t / 1000, settled = true;
    for (var i = 0; i < 3; i++) {
      var target = CAP_BASE[i];
      if (eq.on) {
        // three detuned oscillators per fader feel like music, not like a sine
        var lvl = 0.5 + 0.28 * Math.sin(s * (3.1 + i * 0.7) + eq.ph[i]) + 0.16 * Math.sin(s * (7.3 + i * 1.9) + eq.ph[i] * 2) + 0.08 * Math.sin(s * 13.7 + i);
        target = 38 - clamp(lvl, 0, 1) * 28;
      }
      eq.y[i] = smooth(eq.y[i], target, eq.on ? 14 : 9, dt);
      if (Math.abs(eq.y[i] - target) > 0.02) settled = false;
    }
    if (!eq.on && settled) { eq.y = CAP_BASE.slice(); setCaps(eq.y); eq.running = false; return; }
    setCaps(eq.y);
    requestAnimationFrame(eqFrame);
  }

  // ================================================================== screens: content
  function applyInit(m) {
    S.version = m.version || ''; S.mode = m.mode || 'install'; S.installedVersion = m.installedVersion || '';
    S.dir = m.dir || ''; S.defaultDir = m.defaultDir || S.dir; S.sizeMB = +m.sizeMB || 0; S.freeMB = m.freeMB == null ? -1 : +m.freeMB;
    S.running = !!m.running; S.inited = true;
    body.classList.toggle('mode-update', S.mode === 'update');
    body.classList.toggle('mode-uninstall', S.mode === 'uninstall');
    setText('tb-ver', S.version ? 'v' + S.version : '');
    setText('tb-title', S.mode === 'uninstall' ? 'VELOX entfernen' : 'VELOX Setup');
    document.title = S.mode === 'uninstall' ? 'VELOX entfernen' : 'VELOX Setup';
    var label = 'Installieren';
    if (S.mode === 'update') {
      var same = S.installedVersion && S.installedVersion === S.version;
      setText('w-title', same ? 'VELOX ist schon installiert.' : 'Eine neue Version von VELOX ist da.');
      setText('w-sub', same ? 'Du kannst VELOX neu installieren. Einstellungen und Sicherungen bleiben.'
        : 'Dauert nur ein paar Sekunden. Einstellungen und Sicherungen bleiben.');
      label = same ? 'Neu installieren' : 'Aktualisieren';
      $('update-note').hidden = same || !S.installedVersion;
      setText('u-from', S.installedVersion); setText('u-to', S.version);
      $('btn-browse').disabled = true;
      $('btn-browse').title = 'Ein Update bleibt im bisherigen Ordner.';
    }
    setText('btn-install-label', label); setText('btn-install2-label', label);
    setText('u-sub', S.dir ? 'VELOX wird aus „' + S.dir + '“ entfernt.' : 'VELOX wird von diesem PC entfernt.');
    $('u-sub').title = S.dir;
    updateDir();
    updateRunning();
    if (S.introDone) route();
  }

  function updateDir() {
    setText('o-dir', S.dir); $('o-dir').title = S.dir;
    var space = S.sizeMB ? 'Braucht ca. ' + fmtMB(S.sizeMB) : '';
    if (S.freeMB >= 0) space += (space ? ' · ' : '') + fmtMB(S.freeMB) + ' frei';
    if (S.mode === 'update') space += (space ? ' · ' : '') + 'Ein Update bleibt im bisherigen Ordner.';
    setText('o-space', space);
    var meta = [];
    if (S.version) meta.push('Version ' + S.version);
    if (S.sizeMB) meta.push('ca. ' + fmtMB(S.sizeMB));
    if (S.dir) meta.push(S.dir);
    setText('w-meta', meta.join('  ·  '));
    var tooSmall = S.freeMB >= 0 && S.sizeMB > 0 && S.freeMB < S.sizeMB;
    if (tooSmall) showDirError('Auf diesem Laufwerk ist nicht genug Platz frei. Wähle bitte einen anderen Ort.');
    else if (!$('o-dir-error').dataset.sticky) showDirError('');
    $('btn-install').disabled = tooSmall; $('btn-install2').disabled = tooSmall;
  }
  function showDirError(text) { var e = $('o-dir-error'); e.textContent = text; e.hidden = !text; }

  function updateRunning() {
    $('running-note').hidden = !(S.running && S.mode === 'update');
    $('u-running').hidden = !S.running;
  }

  function confirmRunning(kind, onOk) {
    setText('c-title', 'VELOX läuft gerade');
    setText('c-text', kind === 'uninstall'
      ? 'Damit VELOX entfernt werden kann, wird es jetzt geschlossen. Falls VELOX gerade etwas an Windows ändert, warte lieber, bis es fertig ist.'
      : 'Damit es weitergehen kann, wird VELOX jetzt kurz geschlossen. Falls VELOX gerade etwas an Windows ändert, warte lieber, bis es fertig ist.');
    var layer = $('confirm');
    layer.hidden = false;
    confirmCb = onOk;
    setTimeout(function () { $('c-ok').focus(); }, 30);
  }
  var confirmCb = null;
  function closeConfirm(ok) {
    var cb = confirmCb; confirmCb = null;
    $('confirm').hidden = true;
    if (ok && cb) cb();
  }

  function startInstall() {
    if (S.busy) return;
    var go = function () {
      S.busy = true;
      S.task = S.mode === 'update' ? 'update' : 'install';
      resetProgress();
      setText('p-title', S.task === 'update' ? 'VELOX wird aktualisiert …' : 'VELOX wird installiert …');
      show('progress');
      send('install', { dir: S.dir, desktop: $('o-desktop').checked, startMenu: $('o-startmenu').checked, launch: $('o-launch').checked, closeRunning: true });
    };
    if (S.running) confirmRunning('install', go); else go();
  }

  function startUninstall() {
    if (S.busy) return;
    var go = function () {
      S.busy = true;
      S.task = 'uninstall';
      S.keepData = $('u-keep').checked;
      resetProgress();
      setText('p-title', 'VELOX wird entfernt …');
      show('progress');
      send('uninstall', { keepData: S.keepData, closeRunning: true });
    };
    if (S.running) confirmRunning('uninstall', go); else go();
  }

  function onDone(m) {
    S.busy = false;
    S.launched = !!m.launched;
    var mode = m.mode || S.task || 'install';
    var update = S.task === 'update';
    if (mode === 'uninstall') {
      setText('d-title', 'VELOX wurde entfernt.');
      setText('d-sub', S.keepData ? 'Deine Einstellungen und Sicherungen sind noch da – falls du VELOX wieder installierst.' : 'Auch die Einstellungen und Sicherungen sind gelöscht.');
      $('d-hint').hidden = true;
      $('btn-launch').hidden = true;
    } else {
      setText('d-title', update ? 'Fertig! VELOX ist auf dem neuesten Stand.' : 'Fertig! VELOX ist installiert.');
      if (S.launched) setText('d-sub', 'VELOX startet gerade. Viel Spaß!');
      else setText('d-sub', $('o-desktop').checked ? 'Du findest VELOX auf dem Desktop und im Startmenü.' : ($('o-startmenu').checked ? 'Du findest VELOX im Startmenü.' : 'Du findest VELOX in „' + S.dir + '“.'));
      $('d-hint').hidden = update;
      $('btn-launch').hidden = S.launched;
    }
    var closeBtn = $('btn-done-close');
    closeBtn.classList.toggle('btn-brand', $('btn-launch').hidden);
    closeBtn.classList.toggle('btn-lg', $('btn-launch').hidden);
    closeBtn.classList.toggle('btn-secondary', !$('btn-launch').hidden);
    var finish = function () {
      show('done');
      if (mode !== 'uninstall') celebrate();
    };
    if (S.screen === 'progress') {
      prog.fast = true;
      prog.pendingDone = finish;
      setProgressTarget(100);
    } else finish();
  }

  function celebrate() {
    if (reduced) return;
    setTimeout(function () {
      if (S.screen !== 'done') return;
      var c = logoPt(24, 24);
      sparks(c.x, c.y, 60, 820, { life: 900, size: 10, drag: 3.4 });
      confetti(c.x, c.y, 46, { speed: 0.85 });
      // two confetti cannons from the lower corners, aimed past the text towards the upper corners
      confetti(-10, fx.h + 10, 70, { angle: -Math.PI * 0.3, spread: 0.5, speed: 1.45, delay: 90 });
      confetti(fx.w + 10, fx.h + 10, 70, { angle: -Math.PI * 0.7, spread: 0.5, speed: 1.45, delay: 90 });
      burstRings(0.9);
      punch();
      var fl = $('hero-flash');
      if (fl.animate) fl.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 0.8, transform: 'scale(1)', offset: 0.2 }, { opacity: 0, transform: 'scale(1.5)' }], { duration: 700, easing: 'ease-out' });
    }, 520);
  }

  function onError(m) {
    S.busy = false;
    prog.pendingDone = null;
    setText('e-msg', m.message || 'Etwas ist unerwartet schiefgelaufen.');
    setText('e-hint', m.hint || 'Versuche es noch einmal. Hilft das nicht, starte den PC neu und probiere es dann erneut.');
    $('confirm').hidden = true;
    show('error');
  }

  // ================================================================== messages from VeloxSetup.exe
  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'init': applyInit(m); break;
      case 'running': S.running = !!m.running; updateRunning(); break;
      case 'folder':
        if (m.error) { $('o-dir-error').dataset.sticky = '1'; showDirError(m.error); }
        else {
          delete $('o-dir-error').dataset.sticky;
          S.dir = m.dir || S.dir;
          S.freeMB = m.freeMB == null ? -1 : +m.freeMB;
          updateDir();
        }
        break;
      case 'progress':
        if (S.screen !== 'progress' && S.screen !== 'done') { S.busy = true; show('progress'); }
        setProgressTarget(+m.percent || 0);
        if (m.step) setText('p-step', m.step);
        setText('p-file', m.file || '');
        break;
      case 'done': onDone(m); break;
      case 'error': onError(m); break;
    }
  }
  if (bridge) {
    bridge.addEventListener('message', function (e) {
      var d = e.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (err) { d = null; } }
      onMessage(d);
    });
  }

  // ================================================================== input
  function ripple(btn, e) {
    if (reduced || !btn.classList.contains('btn')) return;
    var r = btn.getBoundingClientRect(), size = Math.hypot(r.width, r.height) * 2;
    var x = (e && e.clientX ? e.clientX : r.left + r.width / 2) - r.left - size / 2, y = (e && e.clientY ? e.clientY : r.top + r.height / 2) - r.top - size / 2;
    var s = document.createElement('span');
    s.className = 'ripple';
    s.style.width = s.style.height = size + 'px';
    s.style.left = x + 'px'; s.style.top = y + 'px';
    btn.appendChild(s);
    setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 560);
  }
  function on(id, fn) {
    var el = $(id);
    if (el) el.addEventListener('click', function (e) { ripple(el, e); fn(e); });
  }

  $('titlebar').addEventListener('mousedown', function (e) {
    if (e.button !== 0 || (e.target.closest && e.target.closest('[data-nodrag]'))) return;
    e.preventDefault();
    send('drag');
  });
  on('btn-min', function () { send('minimize'); });
  on('btn-close', function () { if (!S.busy) send('close'); });
  on('skip', function (e) { e.stopPropagation(); skipIntro(); });
  document.querySelector('.screen.intro').addEventListener('click', skipIntro);
  on('btn-install', startInstall);
  on('btn-install2', startInstall);
  on('btn-options', function () { show('options'); });
  on('btn-back', function () { show('welcome'); });
  on('btn-browse', function () { send('browse', { dir: S.dir }); });
  on('btn-launch', function () { send('launch'); });
  on('btn-done-close', function () { send('exit'); });
  on('btn-log', function () { send('openLog'); });
  on('btn-err-close', function () { send('exit'); });
  on('btn-retry', function () { send('checkRunning'); show(homeScreen()); });
  on('btn-uninstall', startUninstall);
  on('btn-u-cancel', function () { send('close'); });
  on('c-ok', function () { closeConfirm(true); });
  on('c-cancel', function () { closeConfirm(false); });
  $('confirm').addEventListener('mousedown', function (e) { if (e.target === $('confirm')) closeConfirm(false); });

  document.addEventListener('keydown', function (e) {
    if (!intro.done) { if (e.key !== 'Tab') { e.preventDefault(); skipIntro(); } return; }
    if (e.key === 'Escape') {
      if (!$('confirm').hidden) { closeConfirm(false); return; }
      if (S.screen === 'options') show('welcome');
    }
    // keep keyboard focus inside the confirm dialog while it is open
    if (e.key === 'Tab' && !$('confirm').hidden) {
      var a = $('c-cancel'), b = $('c-ok');
      if (document.activeElement !== a && document.activeElement !== b) { e.preventDefault(); a.focus(); }
      else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
      else if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
    }
  });
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('dragstart', function (e) { e.preventDefault(); });
  // Ctrl+wheel / Ctrl+plus must not zoom the installer
  window.addEventListener('wheel', function (e) { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    resizeFx();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { sizeWordSlots(); placeHero(false); }, 0);
  });

  // ================================================================== preview without VeloxSetup.exe
  // Opening index.html in a normal browser shows a believable demo instead of a dead page.
  var demo = null;
  function preview(m) {
    var reply = function (x, delay) { setTimeout(function () { onMessage(x); }, delay || 0); };
    switch (m.type) {
      case 'ready':
        reply({ type: 'init', version: '1.1.0', mode: /uninstall/.test(location.hash) ? 'uninstall' : (/update/.test(location.hash) ? 'update' : 'install'), installedVersion: /update/.test(location.hash) ? '1.0.0' : '', dir: 'C:\\Program Files\\VELOX', defaultDir: 'C:\\Program Files\\VELOX', sizeMB: 3, freeMB: 182000, running: false }, 30);
        break;
      case 'browse': reply({ type: 'folder', dir: 'D:\\Programme\\VELOX', error: '', freeMB: 512000 }, 200); break;
      case 'install': case 'uninstall':
        var p = 0;
        clearInterval(demo);
        demo = setInterval(function () {
          p = Math.min(100, p + 2 + Math.random() * 5);
          onMessage({ type: 'progress', percent: p, step: p < 80 ? 'Dateien werden kopiert …' : 'Verknüpfungen werden angelegt …', file: p < 80 ? 'ui/js/pages/file-' + Math.round(p) + '.js' : '' });
          if (p >= 100) { clearInterval(demo); onMessage({ type: 'done', mode: m.type, launched: false }); }
        }, 90);
        break;
    }
  }

  // ================================================================== start
  resizeFx();
  sizeWordSlots();
  runIntro();
  send('ready');
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { sizeWordSlots(); if (intro.done) placeHero(false); });
  }

  // test hook (read-only state for the UI tests; harmless in production)
  window.__veloxSetup = { state: S, skipIntro: skipIntro, intro: intro, progress: prog, fxParts: function () { return fx.parts.length; } };
})();
