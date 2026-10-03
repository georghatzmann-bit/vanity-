/* ==========================================================================
   Jarvis – System wie im Video "AgenticOS" (system.css, system.py, wissensnetz.py)
   Links die Agents mit Stand, Skills und Werkzeugen (ein Klick klappt auf, dort geht ein Auftrag raus),
   in der Mitte das Wissensnetz als lebendiger Graph, rechts die Skill-Knöpfe, Automationen und das
   Gedächtnis Sitzung für Sitzung. Texte aus Python kommen nur als Klartext (textContent) ins Fenster.
   Gezeichnet wird nur, solange die Ansicht zu sehen ist.
   ========================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(motionQuery && motionQuery.matches);

  const KINDS = {
    gedaechtnis: { name: 'Gedächtnis', one: 'Gedächtnis', color: '#6e8cff' },
    person: { name: 'Personen', one: 'Person', color: '#c48bff' },
    projekt: { name: 'Projekte', one: 'Projekt', color: '#ff9f43' },
    recherche: { name: 'Recherchen', one: 'Recherche', color: '#5ad1ff' },
    notiz: { name: 'Notizen', one: 'Notiz', color: '#d9dde8' },
    tag: { name: 'Tage', one: 'Tagebuch', color: '#7b869e' },
    sitzung: { name: 'Sitzungen', one: 'Sitzung', color: '#f2c94c' },
  };
  const ORDER = ['gedaechtnis', 'person', 'projekt', 'recherche', 'notiz', 'tag', 'sitzung'];
  const RING = { gedaechtnis: 0, person: 150, projekt: 210, sitzung: 230, recherche: 270, notiz: 290, tag: 360 };
  const EDGE_WORDS = { link: 'verlinkt', auto: 'automatisch verknüpft', gedaechtnis: 'im Gedächtnis', erwaehnt: 'beim Namen genannt' };
  const STATUS_WORDS = {
    bereit: 'Bereit', arbeitet: 'Arbeitet', schreibt: 'Schreibt', wartet: 'Wartet auf Sie', fertig: 'Fertig',
    fehler: 'Fehler', aus: 'Aus',
  };
  const ICONS = {
    uhr: ['M12 7v5l3 2', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
    blitz: ['M13 3 5 13.5h6L10 21l8-10.5h-6z'],
    kreis: ['M4 12a8 8 0 0 1 13.7-5.6L20 9', 'M20 4v5h-5', 'M20 12a8 8 0 0 1-13.7 5.6L4 15', 'M4 20v-5h5'],
  };

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function icon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    (ICONS[name] || []).forEach((d) => {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    });
    return svg;
  }

  function hash(text) {
    let h = 2166136261;
    const s = String(text);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  }

  function fold(text) {
    return String(text || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  }

  function kindOf(art) {
    return KINDS[art] || { name: art, one: art, color: '#93a0bb' };
  }

  function create(opts) {
    const call = opts.call;
    const toast = opts.toast || (() => {});
    const setHome = opts.setHome || (() => {});
    const body = document.body;
    const el = {
      root: $('sy'),
      agents: $('syAgents'), agentsMeta: $('syAgentsMeta'),
      graphMeta: $('syGraphMeta'), search: $('sySearch'), hits: $('syHits'),
      wrap: $('syCanvasWrap'), canvas: $('syCanvas'), legend: $('syLegend'), empty: $('syGraphEmpty'),
      zoomIn: $('syZoomIn'), zoomOut: $('syZoomOut'), fit: $('syFit'),
      detail: $('syDetail'), detailKind: $('syDetailKind'), detailTitle: $('syDetailTitle'),
      detailText: $('syDetailText'), detailFile: $('syDetailFile'), detailLinks: $('syDetailLinks'),
      detailOpen: $('syDetailOpen'), detailAsk: $('syDetailAsk'), detailClose: $('syDetailClose'),
      skills: $('sySkills'), skillsMeta: $('sySkillsMeta'),
      ask: $('syAsk'), askLabel: $('syAskLabel'), askInput: $('syAskInput'), askCancel: $('syAskCancel'),
      auto: $('syAuto'), autoMeta: $('syAutoMeta'), autoEmpty: $('syAutoEmpty'),
      sessions: $('sySessions'), sessMeta: $('sySessMeta'), sessEmpty: $('sySessEmpty'),
    };
    if (!el.root || !el.canvas) return null;
    const ctx = el.canvas.getContext('2d');

    const S = {
      data: null,
      graph: null,
      sig: '',
      open: new Set(),
      cards: new Map(),     // Agent-ID -> {li, ...}
      off: new Set(),       // ausgeblendete Arten
      ask: null,            // Skill, der noch einen Text braucht
      selected: '',
      hover: '',
      hit: -1,              // markierter Suchtreffer
      timer: 0,
      graphAt: 0,
      loading: false,
    };

    // ---------------------------------------------------------------- sichtbar?

    function active() {
      return body.dataset.home === 'system' && body.dataset.view === 'hud' && body.dataset.fenster !== 'zu' && !document.hidden;
    }

    // ---------------------------------------------------------------- Laden

    function refresh(withGraph) {
      if (S.loading) return;
      S.loading = true;
      call('system_state').then((d) => {
        if (d) render(d);
      }).catch(() => {}).finally(() => { S.loading = false; });
      if (withGraph || Date.now() - S.graphAt > 20000) {
        S.graphAt = Date.now();
        call('system_graph', false).then((g) => {
          if (g) setGraph(g);
          else showEmpty('Das Wissensnetz ist gerade nicht erreichbar.');
        }).catch(() => showEmpty('Jarvis ist gerade nicht verbunden.'));
      }
    }

    function schedule() {
      clearTimeout(S.timer);
      if (!active()) return;
      S.timer = setTimeout(() => {
        refresh(false);
        schedule();
      }, 4000);
    }

    function wake() {
      if (!active()) {
        clearTimeout(S.timer);
        return;
      }
      resize();
      refresh(!S.graph);
      schedule();
      kick(S.graph ? 0.05 : 0);
    }

    // ---------------------------------------------------------------- Agents

    function statusPill(status, zeit) {
      const pill = node('span', 'sy-status');
      pill.append(node('i'), node('span', '', STATUS_WORDS[status] || status || 'Bereit'));
      if (zeit && status !== 'bereit' && status !== 'aus') pill.title = 'Seit ' + zeit + ' Uhr';
      return pill;
    }

    function chipsFor(a, limit) {
      const ul = node('ul', 'sy-chips');
      const skills = a.skills || [];
      const tools = a.werkzeuge || [];
      const shownSkills = skills.slice(0, limit ? 3 : skills.length);
      const shownTools = tools.slice(0, limit ? 2 : tools.length);
      shownSkills.forEach((s) => {
        const li = node('li', 'sy-chip skill' + (s.gelernt ? ' learned' : ''), s.name);
        li.title = (s.gelernt ? 'Selbst gelernt: ' : 'Skill: ') + (s.beschreibung || s.name);
        ul.append(li);
      });
      shownTools.forEach((t) => {
        const li = node('li', 'sy-chip tool', t);
        li.title = 'Werkzeug: ' + t;
        ul.append(li);
      });
      const rest = skills.length - shownSkills.length + tools.length - shownTools.length;
      if (rest > 0) ul.append(node('li', 'sy-chip more', '+' + rest));
      return ul;
    }

    function buildCard(a) {
      const li = node('li', 'sy-agent');
      li.dataset.id = a.id;
      const main = node('button', 'sy-agent-main');
      main.type = 'button';
      const moreId = 'syAgentMore-' + a.id;
      main.setAttribute('aria-controls', moreId);
      const avatar = node('span', 'sy-avatar', a.kuerzel || '?');
      avatar.setAttribute('aria-hidden', 'true');
      const name = node('span', 'sy-agent-name', a.name);
      const pillSlot = node('span');
      const text = node('span', 'sy-agent-text');
      main.append(avatar, name, pillSlot, text);
      const bar = node('div', 'sy-bar');
      bar.append(node('i'));
      const chipSlot = node('div');
      const more = node('div', 'sy-agent-more');
      more.id = moreId;
      li.append(main, bar, chipSlot, more);
      main.addEventListener('click', () => {
        if (S.open.has(a.id)) S.open.delete(a.id);
        else S.open.add(a.id);
        updateCard(S.cards.get(a.id), S.cards.get(a.id).data, true);
        if (S.open.has(a.id)) {
          const input = more.querySelector('input');
          if (input) setTimeout(() => input.focus(), 30);
        }
      });
      return { li, main, pillSlot, text, bar, chipSlot, more, data: a, key: '' };
    }

    function buildMore(card, a) {
      const more = card.more;
      more.textContent = '';
      more.append(node('p', 'sy-agent-text', a.rolle || ''));
      more.append(node('h4', '', 'Skills'));
      if ((a.skills || []).length) {
        const list = node('ul', 'sy-skill-list');
        a.skills.forEach((s) => {
          const li = node('li');
          li.append(node('b', '', s.name + (s.gelernt ? ' (gelernt)' : '')), document.createTextNode(': ' + (s.beschreibung || '')));
          list.append(li);
        });
        more.append(list);
      } else {
        more.append(node('p', 'sy-agent-text', 'Keine eigenen Skills. Was Jarvis kann, steht ihm trotzdem zur Verfügung.'));
      }
      more.append(node('h4', '', 'Werkzeuge'));
      const tools = node('ul', 'sy-chips');
      (a.werkzeuge || []).forEach((t) => tools.append(node('li', 'sy-chip tool', t)));
      more.append(tools);
      if (a.auftrag && a.status !== 'aus') {
        const form = node('form', 'sy-order');
        const input = node('input', 'sy-input');
        input.type = 'text';
        input.maxLength = 400;
        input.placeholder = a.beispiel ? 'z. B. ' + a.beispiel : 'Auftrag';
        input.setAttribute('aria-label', 'Auftrag an ' + a.name);
        const send = node('button', 'btn primary small', 'Senden');
        send.type = 'submit';
        form.append(input, send);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const value = input.value.trim();
          if (!value) {
            input.focus();
            return;
          }
          send.classList.add('busy');
          call('system_agent', a.id, value).then((r) => {
            if (r && r.ok) {
              input.value = '';
              toast((r.laufend ? 'Geht in die laufende Arbeit: ' : 'Auftrag an ' + a.name + ': ') + value, 'info');
              setTimeout(() => refresh(false), 900);
            } else {
              toast((r && r.error) || 'Das hat nicht geklappt.', 'error');
            }
          }).catch(() => toast('Jarvis ist gerade nicht verbunden.', 'error'))
            .finally(() => send.classList.remove('busy'));
        });
        more.append(form);
      }
    }

    function updateCard(card, a, force) {
      card.data = a;
      const open = S.open.has(a.id);
      card.li.dataset.status = a.status || 'bereit';
      card.li.dataset.open = open ? '1' : '0';
      card.main.setAttribute('aria-expanded', String(open));
      card.main.title = a.name + ': ' + (a.rolle || '');
      card.pillSlot.textContent = '';
      card.pillSlot.append(statusPill(a.status, a.zeit));
      card.text.textContent = a.text || a.rolle || '';
      const running = a.status === 'arbeitet' || a.status === 'schreibt';
      card.bar.hidden = !running;
      const p = a.fortschritt;
      card.bar.dataset.openEnded = p === null || p === undefined ? '1' : '0';
      card.bar.firstChild.style.setProperty('--p', Math.round(clamp(Number(p) || 0, 0, 1) * 100) + '%');
      const key = JSON.stringify([a.skills, a.werkzeuge, a.auftrag, a.status === 'aus', a.rolle]);
      if (force || key !== card.key) {
        card.key = key;
        card.chipSlot.textContent = '';
        card.chipSlot.append(chipsFor(a, true));
        const typing = card.more.contains(document.activeElement);
        if (!typing) buildMore(card, a);
      }
      card.chipSlot.hidden = open;
      card.more.hidden = !open;
    }

    function renderAgents(list) {
      const items = list || [];
      const seen = new Set();
      items.forEach((a, i) => {
        seen.add(a.id);
        let card = S.cards.get(a.id);
        if (!card) {
          card = buildCard(a);
          S.cards.set(a.id, card);
        }
        updateCard(card, a, false);
        if (el.agents.children[i] !== card.li) el.agents.insertBefore(card.li, el.agents.children[i] || null);
      });
      Array.from(S.cards.keys()).forEach((id) => {
        if (!seen.has(id)) {
          S.cards.get(id).li.remove();
          S.cards.delete(id);
        }
      });
      const busy = items.filter((a) => a.status === 'arbeitet' || a.status === 'schreibt').length;
      el.agentsMeta.textContent = items.length + ' Agents' + (busy ? ' · ' + busy + ' aktiv' : '');
    }

    // ---------------------------------------------------------------- Skills

    function renderSkills(list) {
      const items = list || [];
      if (el.skills.dataset.key === JSON.stringify(items)) return;
      el.skills.dataset.key = JSON.stringify(items);
      el.skills.textContent = '';
      items.forEach((q) => {
        const b = node('button', 'sy-skill' + (q.gelernt ? ' learned' : ''));
        b.type = 'button';
        b.dataset.id = q.id;
        const name = node('b');
        name.append(node('span', '', q.name));
        b.append(name, node('small', '', q.hinweis || ''));
        b.title = q.name + (q.hinweis ? ': ' + q.hinweis : '');
        b.addEventListener('click', () => runSkill(q, b));
        el.skills.append(b);
      });
      el.skillsMeta.textContent = items.length + ' bereit';
    }

    function runSkill(q, button, text) {
      if (q.frage && !text) {
        S.ask = q;
        el.askLabel.textContent = q.frage;
        el.ask.hidden = false;
        el.askInput.value = '';
        el.askInput.focus();
        return;
      }
      if (button) {
        button.dataset.busy = '1';
        setTimeout(() => { button.dataset.busy = '0'; }, 1600);
      }
      call('system_skill', q.id, text || '').then((r) => {
        if (r && r.ok) toast('Läuft: ' + q.name.replace(/\u00ad/g, ''), 'info');
        else toast((r && r.error) || 'Das hat nicht geklappt.', 'error');
      }).catch(() => toast('Jarvis ist gerade nicht verbunden.', 'error'));
    }

    el.ask.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = el.askInput.value.trim();
      if (!value || !S.ask) {
        el.askInput.focus();
        return;
      }
      const q = S.ask;
      S.ask = null;
      el.ask.hidden = true;
      runSkill(q, el.skills.querySelector('[data-id="' + CSS.escape(q.id) + '"]'), value);
    });
    el.askCancel.addEventListener('click', () => {
      S.ask = null;
      el.ask.hidden = true;
    });
    el.askInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        el.askCancel.click();
      }
    });

    // ---------------------------------------------------------------- Automationen, Sitzungen

    function renderAuto(a) {
      const data = a || {};
      el.auto.textContent = '';
      const rows = [];
      (data.zeitplaene || []).forEach((z) => rows.push(['uhr', z.befehl, z.tage + ' um ' + z.uhrzeit + ' Uhr', 'Zeitplan']));
      (data.befehle || []).forEach((c) => rows.push(['blitz', '„' + c.name + '“', c.aktion, 'Eigener Befehl']));
      (data.gewohnheiten || []).forEach((g) => rows.push(['kreis', g.text, 'erkannt an ' + g.anzahl + ' Tagen', 'Gewohnheit']));
      rows.slice(0, 12).forEach(([ico, title, sub, kind]) => {
        const li = node('li');
        const box = node('span', 'sy-auto-ico');
        box.title = kind;
        box.append(icon(ico));
        li.append(box, node('b', '', title), node('small', '', kind + ' · ' + sub));
        li.title = kind + ': ' + title + ' (' + sub + ')';
        el.auto.append(li);
      });
      el.autoEmpty.hidden = rows.length > 0;
      el.autoMeta.textContent = rows.length ? String(rows.length) : '';
    }

    function renderSessions(g) {
      const data = g || {};
      const items = data.sitzungen || [];
      el.sessions.textContent = '';
      items.slice(0, 6).forEach((s) => {
        const li = node('li');
        li.dataset.live = s.laufend ? '1' : '0';
        const head = node('div', 'sy-session-head');
        head.append(node('span', '', s.tag + ' · ' + s.von + (s.bis && s.bis !== s.von ? '–' + s.bis : '')));
        head.append(node('small', '', s.anzahl + (s.anzahl === 1 ? ' Befehl' : ' Befehle')));
        if (s.laufend) head.append(node('span', 'sy-live', 'läuft'));
        li.append(head);
        const themes = node('ul', 'sy-themes');
        (s.themen || []).slice(0, 3).forEach((t) => themes.append(node('li', '', t)));
        if (!(s.themen || []).length) themes.append(node('li', '', 'Nur kurze Befehle'));
        li.append(themes);
        el.sessions.append(li);
      });
      el.sessEmpty.hidden = items.length > 0;
      const facts = data.fakten || 0;
      el.sessMeta.textContent = (data.gesamt ? data.gesamt + ' gespeichert' : '') + (facts ? (data.gesamt ? ' · ' : '') + facts + ' Fakten' : '');
    }

    function render(d) {
      S.data = d;
      renderAgents(d.agenten);
      renderSkills(d.skills);
      renderAuto(d.automationen);
      renderSessions(d.gedaechtnis);
    }

    // ---------------------------------------------------------------- Wissensnetz: Daten

    const G = {
      nodes: [], byId: new Map(), edges: [], adj: new Map(),
      alpha: 0, view: { x: 0, y: 0, s: 1 }, target: null, moved: false,
      w: 0, h: 0, dpr: 1, raf: 0, drag: null, fitted: false, t0: performance.now(),
    };

    function radius(n) {
      if (n.art === 'gedaechtnis') return 20;
      return clamp(6 + Math.sqrt(n.grad || 0) * 2.6, 6, 18);
    }

    function setGraph(g) {
      const sig = [g.zahlen && g.zahlen.knoten, g.zahlen && g.zahlen.kanten, g.stand,
        (g.knoten || []).length && g.knoten[g.knoten.length - 1].id].join('|');
      S.graph = g;
      if (sig === S.sig) return;
      S.sig = sig;
      const old = G.byId;
      const nodes = [];
      const byId = new Map();
      (g.knoten || []).forEach((k) => {
        const before = old.get(k.id);
        const n = before || { id: k.id, x: 0, y: 0, vx: 0, vy: 0, fixed: false, placed: false };
        n.k = k;
        n.art = k.art;
        n.grad = k.grad || 0;
        n.r = radius(k);
        n.color = kindOf(k.art).color;
        n.title = k.titel || k.id;
        n.fold = fold(n.title + ' ' + (k.auszug || ''));
        nodes.push(n);
        byId.set(k.id, n);
      });
      const edges = [];
      const adj = new Map();
      nodes.forEach((n) => adj.set(n.id, []));
      (g.kanten || []).forEach((e) => {
        const a = byId.get(e.a);
        const b = byId.get(e.b);
        if (!a || !b) return;
        const edge = { a, b, art: e.art, warum: e.warum || '' };
        edges.push(edge);
        adj.get(a.id).push({ other: b, edge });
        adj.get(b.id).push({ other: a, edge });
      });
      // Neue Knoten: neben einen schon platzierten Nachbarn, sonst in ihren Ring
      nodes.forEach((n) => {
        if (n.placed) return;
        const friend = adj.get(n.id).map((x) => x.other).find((o) => o.placed);
        const turn = hash(n.id) * Math.PI * 2;
        if (n.art === 'gedaechtnis') {
          n.x = 0;
          n.y = 0;
        } else if (friend) {
          n.x = friend.x + Math.cos(turn) * 40;
          n.y = friend.y + Math.sin(turn) * 40;
        } else {
          const ring = (RING[n.art] || 300) * (0.85 + hash(n.id + '*') * 0.3);
          n.x = Math.cos(turn) * ring;
          n.y = Math.sin(turn) * ring;
        }
        n.placed = true;
      });
      const first = G.nodes.length === 0;
      G.nodes = nodes;
      G.byId = byId;
      G.edges = edges;
      G.adj = adj;
      if (S.selected && !byId.has(S.selected)) closeDetail();
      renderLegend(g);
      renderMeta(g);
      if (nodes.length <= 1) {
        showEmpty(g.notizbuch === false
          ? 'Das Notizbuch ist in den Einstellungen aus. Ohne Notizbuch gibt es kein Netz, nur das Gedächtnis.'
          : 'Das Netz wächst mit jedem Gespräch: Recherchen, Notizen, Personen und Projekte verknüpft Jarvis von selbst.');
      } else {
        el.empty.hidden = true;
      }
      if (first) {
        G.alpha = 1;
        for (let i = 0; i < 160 && G.alpha > 0.02; i += 1) tick(); // vorrechnen: kein wildes Zappeln beim Öffnen
        fit(false);
      }
      kick(first ? 0.25 : 0.4);
      if (S.selected) showDetail(S.selected);
    }

    function showEmpty(text) {
      el.empty.textContent = text;
      el.empty.hidden = false;
      if (!S.graph) el.graphMeta.textContent = '';
    }

    function renderMeta(g) {
      const z = g.zahlen || {};
      const parts = [(z.knoten || 0).toLocaleString('de-DE') + ' Knoten', (z.kanten || 0).toLocaleString('de-DE') + ' Verbindungen'];
      if (z.auto) parts.push(z.auto.toLocaleString('de-DE') + ' automatisch');
      el.graphMeta.textContent = parts.join(' · ') + (g.stand ? ' · Stand ' + g.stand : '');
    }

    function renderLegend(g) {
      const counts = (g.zahlen && g.zahlen.art) || {};
      el.legend.textContent = '';
      ORDER.filter((art) => counts[art]).forEach((art) => {
        const k = kindOf(art);
        const li = node('li');
        const b = node('button');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(!S.off.has(art)));
        b.title = S.off.has(art) ? k.name + ' einblenden' : k.name + ' ausblenden';
        const dot = node('span', 'sy-dot');
        dot.dataset.shape = art;
        dot.style.setProperty('--kind', k.color);
        b.append(dot, node('span', '', k.name), node('b', '', counts[art]));
        if (art === 'gedaechtnis') {
          b.setAttribute('aria-disabled', 'true');
          b.title = 'Das Gedächtnis bleibt immer sichtbar';
        }
        b.addEventListener('click', () => {
          if (art === 'gedaechtnis') return;
          if (S.off.has(art)) S.off.delete(art);
          else S.off.add(art);
          if (S.selected && G.byId.get(S.selected) && S.off.has(G.byId.get(S.selected).art)) closeDetail();
          renderLegend(S.graph);
          kick(0.3);
        });
        li.append(b);
        el.legend.append(li);
      });
      const auto = (g.zahlen && g.zahlen.auto) || 0;
      if (auto) {
        const li = node('li');
        const key = node('button');
        key.type = 'button';
        key.tabIndex = -1;
        key.setAttribute('aria-hidden', 'true');
        key.style.pointerEvents = 'none';
        key.append(node('span', 'sy-line-key'), node('span', '', 'automatisch verknüpft'));
        li.append(key);
        el.legend.append(li);
      }
    }

    function shown(n) {
      return !S.off.has(n.art);
    }

    // ---------------------------------------------------------------- Wissensnetz: Kräfte

    function tick() {
      const nodes = G.nodes.filter(shown);
      const alpha = G.alpha;
      const cell = 140;
      const grid = new Map();
      nodes.forEach((n) => {
        const key = Math.floor(n.x / cell) + ':' + Math.floor(n.y / cell);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(n);
      });
      // Abstoßen (nur Nachbarzellen) und nicht überlappen
      nodes.forEach((n) => {
        const cx = Math.floor(n.x / cell);
        const cy = Math.floor(n.y / cell);
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            const list = grid.get((cx + dx) + ':' + (cy + dy));
            if (!list) continue;
            for (let i = 0; i < list.length; i += 1) {
              const m = list[i];
              if (m === n) continue;
              let x = n.x - m.x;
              let y = n.y - m.y;
              let d2 = x * x + y * y;
              if (d2 < 0.01) {
                x = (hash(n.id + m.id) - 0.5) * 2;
                y = (hash(m.id + n.id) - 0.5) * 2;
                d2 = x * x + y * y + 0.01;
              }
              if (d2 > cell * cell * 2.25) continue;
              const d = Math.sqrt(d2);
              const push = (700 / d2) * alpha;
              n.vx += (x / d) * push;
              n.vy += (y / d) * push;
              const min = n.r + m.r + 8;
              if (d < min) {
                const k = ((min - d) / d) * 0.5;
                n.vx += x * k * 0.5;
                n.vy += y * k * 0.5;
              }
            }
          }
        }
      });
      // Federn entlang der Kanten
      G.edges.forEach((e) => {
        if (!shown(e.a) || !shown(e.b)) return;
        const hub = e.a.art === 'gedaechtnis' || e.b.art === 'gedaechtnis';
        const want = (hub ? 120 : e.art === 'auto' ? 72 : 56) + e.a.r + e.b.r;
        const strength = hub ? 0.012 : e.art === 'auto' ? 0.03 : 0.06;
        const x = e.b.x - e.a.x;
        const y = e.b.y - e.a.y;
        const d = Math.sqrt(x * x + y * y) || 1;
        const f = ((d - want) / d) * strength * alpha;
        const ba = e.b.grad / ((e.a.grad + e.b.grad) || 1);
        e.a.vx += x * f * ba;
        e.a.vy += y * f * ba;
        e.b.vx -= x * f * (1 - ba);
        e.b.vy -= y * f * (1 - ba);
      });
      // Zur Mitte, das Gedächtnis bleibt in der Mitte
      nodes.forEach((n) => {
        if (n.art === 'gedaechtnis') {
          n.x = 0;
          n.y = 0;
          n.vx = 0;
          n.vy = 0;
          return;
        }
        n.vx -= n.x * 0.006 * alpha;
        n.vy -= n.y * 0.006 * alpha;
        if (n.fixed) {
          n.vx = 0;
          n.vy = 0;
          return;
        }
        n.vx *= 0.58;
        n.vy *= 0.58;
        n.x += clamp(n.vx, -40, 40);
        n.y += clamp(n.vy, -40, 40);
      });
      G.alpha += (0 - G.alpha) * 0.03;
      if (G.alpha < 0.004) G.alpha = 0;
    }

    function kick(alpha) {
      G.alpha = Math.max(G.alpha, alpha || 0);
      if (!G.raf && active()) G.raf = requestAnimationFrame(frame);
    }

    function frame(t) {
      G.raf = 0;
      if (!active()) return;
      if (G.alpha > 0) {
        tick();
        if (G.alpha > 0.3) tick();
      }
      if (G.target) {
        const v = G.view;
        const k = reduced() ? 1 : 0.18;
        v.x += (G.target.x - v.x) * k;
        v.y += (G.target.y - v.y) * k;
        v.s += (G.target.s - v.s) * k;
        if (Math.abs(G.target.x - v.x) < 0.5 && Math.abs(G.target.y - v.y) < 0.5 && Math.abs(G.target.s - v.s) < 0.002) {
          Object.assign(v, G.target);
          G.target = null;
        }
      }
      draw(t);
      const pulsing = !reduced() && G.nodes.some((n) => n.k && n.k.neu && shown(n));
      if (G.alpha > 0 || G.target || G.drag || pulsing) G.raf = requestAnimationFrame(frame);
    }

    // ---------------------------------------------------------------- Wissensnetz: Zeichnen

    function resize() {
      const rect = el.wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (w === G.w && h === G.h && dpr === G.dpr) return;
      G.w = w;
      G.h = h;
      G.dpr = dpr;
      el.canvas.width = Math.round(w * dpr);
      el.canvas.height = Math.round(h * dpr);
      if ((!G.fitted || !G.moved) && G.nodes.length) fit(false); // solange Georg nichts verschoben hat: alles zeigen
      kick(0);
      if (active()) draw(performance.now());
    }

    function toScreen(x, y) {
      const v = G.view;
      return [(x - v.x) * v.s + G.w / 2, (y - v.y) * v.s + G.h / 2];
    }

    function toWorld(sx, sy) {
      const v = G.view;
      return [(sx - G.w / 2) / v.s + v.x, (sy - G.h / 2) / v.s + v.y];
    }

    function focusSet() {
      const id = S.hover || S.selected;
      if (!id || !G.adj.has(id)) return null;
      const set = new Set([id]);
      G.adj.get(id).forEach((x) => set.add(x.other.id));
      return set;
    }

    function shape(n, x, y, r) {
      ctx.beginPath();
      if (n.art === 'projekt') {
        const s = r * 0.92;
        const c = s * 0.35;
        ctx.moveTo(x - s + c, y - s);
        ctx.arcTo(x + s, y - s, x + s, y + s, c);
        ctx.arcTo(x + s, y + s, x - s, y + s, c);
        ctx.arcTo(x - s, y + s, x - s, y - s, c);
        ctx.arcTo(x - s, y - s, x + s, y - s, c);
        ctx.closePath();
      } else if (n.art === 'sitzung') {
        ctx.moveTo(x, y - r * 1.15);
        ctx.lineTo(x + r * 1.15, y);
        ctx.lineTo(x, y + r * 1.15);
        ctx.lineTo(x - r * 1.15, y);
        ctx.closePath();
      } else if (n.art === 'tag') {
        const s = r * 0.8;
        ctx.rect(x - s, y - s, s * 2, s * 2);
      } else {
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
    }

    function draw(t) {
      const dpr = G.dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, G.w, G.h);
      if (!G.nodes.length) return;
      const v = G.view;
      const focus = focusSet();
      const time = (t || performance.now()) - G.t0;
      // Kanten
      ctx.lineCap = 'round';
      G.edges.forEach((e) => {
        if (!shown(e.a) || !shown(e.b)) return;
        const [ax, ay] = toScreen(e.a.x, e.a.y);
        const [bx, by] = toScreen(e.b.x, e.b.y);
        const lit = focus && focus.has(e.a.id) && focus.has(e.b.id) && (e.a.id === (S.hover || S.selected) || e.b.id === (S.hover || S.selected));
        const dim = focus && !lit;
        let color = 'rgba(201, 210, 230, 0.16)';
        let dash = [];
        if (e.art === 'auto') {
          color = 'rgba(110, 140, 255, 0.55)';
          dash = [4, 4];
        } else if (e.art === 'gedaechtnis') {
          color = 'rgba(110, 140, 255, 0.2)';
        } else if (e.art === 'erwaehnt') {
          color = 'rgba(201, 210, 230, 0.14)';
          dash = [1.5, 3.5];
        }
        ctx.globalAlpha = dim ? 0.12 : lit ? 1 : 0.85;
        ctx.strokeStyle = lit ? (e.art === 'auto' ? 'rgba(150, 175, 255, 0.95)' : 'rgba(220, 228, 245, 0.7)') : color;
        ctx.lineWidth = lit ? 1.6 : 1;
        ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      });
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // Knoten
      const labels = [];
      const scale = clamp(v.s, 0.6, 1.8);
      const few = G.nodes.filter(shown).length <= 60;
      G.nodes.forEach((n) => {
        if (!shown(n)) return;
        const [x, y] = toScreen(n.x, n.y);
        const r = n.r * scale;
        if (x < -40 || y < -40 || x > G.w + 40 || y > G.h + 40) return;
        const dim = focus && !focus.has(n.id);
        ctx.globalAlpha = dim ? 0.22 : 1;
        if (n.art === 'gedaechtnis') {
          ctx.strokeStyle = 'rgba(110, 140, 255, 0.35)';
          ctx.lineWidth = 1;
          [1.7, 2.5].forEach((f, i) => {
            ctx.globalAlpha = (dim ? 0.15 : 1) * (i ? 0.45 : 0.8);
            ctx.beginPath();
            ctx.arc(x, y, r * f, 0, Math.PI * 2);
            ctx.stroke();
          });
          ctx.globalAlpha = dim ? 0.22 : 1;
          const glow = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 1.6);
          glow.addColorStop(0, 'rgba(110, 140, 255, 0.45)');
          glow.addColorStop(1, 'rgba(110, 140, 255, 0)');
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(x, y, r * 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
        if (n.k.neu && !reduced() && !dim) {
          const p = (time % 2400) / 2400;
          ctx.strokeStyle = n.color;
          ctx.globalAlpha = 0.5 * (1 - p);
          ctx.lineWidth = 1.5;
          shape(n, x, y, r + 3 + p * 10);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = n.color;
        shape(n, x, y, r);
        ctx.fill();
        if (n.art === 'projekt' && n.k.laeuft) {
          ctx.strokeStyle = '#3fbf85';
          ctx.lineWidth = 2;
          shape(n, x, y, r + 2.5);
          ctx.stroke();
        }
        if (n.id === S.selected || n.id === S.hover) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          shape(n, x, y, r + 3);
          ctx.stroke();
        }
        const lit = n.id === S.selected || n.id === S.hover;
        const near = focus && focus.has(n.id);
        // Wichtig zuerst: gewählt, das Gedächtnis, Nachbarn, dann nach Zahl der Verbindungen
        const rank = lit ? 1e6 : n.art === 'gedaechtnis' ? 1e5 : near ? 1e4 + n.grad : n.grad;
        if (lit || near || few || n.grad >= 3 || v.s >= 1.2) labels.push([n, x, y + r + 12, dim && !near, rank]);
      });
      // Beschriftungen (mit dunklem Rand, damit sie auf Linien lesbar bleiben)
      ctx.font = '500 12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      labels.sort((a, b) => b[4] - a[4]);
      const taken = [];
      labels.forEach(([n, x, y, dim]) => {
        const text = n.title.length > 34 ? n.title.slice(0, 33) + '…' : n.title;
        const lit = n.id === S.selected || n.id === S.hover;
        // Beschriftungen überlappen nicht: was keinen Platz hat, zeigt sich beim Zeigen mit der Maus
        const half = ctx.measureText(text).width / 2 + 4;
        const box = [x - half, y - 9, x + half, y + 9];
        if (!lit && taken.some((t) => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1])) return;
        taken.push(box);
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.strokeStyle = 'rgba(15, 22, 36, 0.92)';
        ctx.lineWidth = 4;
        ctx.strokeText(text, x, y);
        ctx.fillStyle = lit ? '#ffffff' : n.art === 'gedaechtnis' ? '#c9d4ff' : 'rgba(215, 222, 238, 0.86)';
        ctx.fillText(text, x, y);
      });
      ctx.globalAlpha = 1;
    }

    // ---------------------------------------------------------------- Wissensnetz: Bedienung

    function nodeAt(sx, sy) {
      const [wx, wy] = toWorld(sx, sy);
      const scale = clamp(G.view.s, 0.6, 1.8);
      let best = null;
      let bestD = Infinity;
      G.nodes.forEach((n) => {
        if (!shown(n)) return;
        const d = Math.hypot(n.x - wx, n.y - wy) * G.view.s;
        const reach = n.r * scale + 6;
        if (d < reach && d < bestD) {
          best = n;
          bestD = d;
        }
      });
      return best;
    }

    function fit(animate) {
      const list = G.nodes.filter(shown);
      if (!list.length || !G.w) return;
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      list.forEach((n) => {
        x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r);
        x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r);
      });
      const s = clamp(Math.min(G.w / (x1 - x0 + 120), G.h / (y1 - y0 + 140)), 0.25, 1.6);
      const target = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 + 10 / s, s };
      G.fitted = true;
      G.moved = false;
      if (animate && !reduced()) {
        G.target = target;
        kick(0);
      } else {
        Object.assign(G.view, target);
        G.target = null;
      }
    }

    function zoomBy(factor, sx, sy) {
      const v = G.view;
      const px = sx === undefined ? G.w / 2 : sx;
      const py = sy === undefined ? G.h / 2 : sy;
      const [wx, wy] = toWorld(px, py);
      const s = clamp(v.s * factor, 0.2, 4);
      v.s = s;
      v.x = wx - (px - G.w / 2) / s;
      v.y = wy - (py - G.h / 2) / s;
      G.target = null;
      G.moved = true;
      kick(0);
    }

    function centerOn(n) {
      // Rechts liegen die Einzelheiten: der Knoten kommt in die Mitte der freien Fläche daneben
      const s = Math.max(G.view.s, 1.05);
      const shift = G.w >= 700 ? (Math.min(320, G.w - 24) + 12) / 2 : 0;
      G.target = { x: n.x + shift / s, y: n.y, s };
      G.moved = true;
      kick(0);
    }

    function pointerPos(e) {
      const rect = el.canvas.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    }

    el.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const [sx, sy] = pointerPos(e);
      const hit = nodeAt(sx, sy);
      el.canvas.setPointerCapture(e.pointerId);
      G.drag = { id: hit ? hit.id : '', sx, sy, x: sx, y: sy, moved: 0, vx: G.view.x, vy: G.view.y };
      if (hit && hit.art !== 'gedaechtnis') hit.fixed = true;
      el.canvas.classList.add('is-dragging');
    });
    el.canvas.addEventListener('pointermove', (e) => {
      const [sx, sy] = pointerPos(e);
      const d = G.drag;
      if (!d) {
        const hit = nodeAt(sx, sy);
        const id = hit ? hit.id : '';
        if (id !== S.hover) {
          S.hover = id;
          el.canvas.classList.toggle('is-pointing', !!hit);
          el.canvas.title = hit ? hit.title + ' (' + kindOf(hit.art).one + ')' : '';
          kick(0);
        }
        return;
      }
      d.moved = Math.max(d.moved, Math.hypot(sx - d.sx, sy - d.sy));
      if (d.id) {
        const n = G.byId.get(d.id);
        if (n && n.art !== 'gedaechtnis' && d.moved > 3) {
          const [wx, wy] = toWorld(sx, sy);
          n.x = wx;
          n.y = wy;
          kick(0.12);
        }
      } else if (d.moved > 3) {
        G.view.x = d.vx - (sx - d.sx) / G.view.s;
        G.view.y = d.vy - (sy - d.sy) / G.view.s;
        G.target = null;
        G.moved = true;
        kick(0);
      }
    });
    function endDrag(e) {
      const d = G.drag;
      if (!d) return;
      G.drag = null;
      el.canvas.classList.remove('is-dragging');
      try { el.canvas.releasePointerCapture(e.pointerId); } catch { /* egal */ }
      const n = d.id ? G.byId.get(d.id) : null;
      if (n) n.fixed = false;
      if (d.moved <= 3) {
        if (n) select(n.id, false);
        else closeDetail();
      }
      kick(0.05);
    }
    el.canvas.addEventListener('pointerup', endDrag);
    el.canvas.addEventListener('pointercancel', endDrag);
    el.canvas.addEventListener('pointerleave', () => {
      if (!G.drag && S.hover) {
        S.hover = '';
        el.canvas.classList.remove('is-pointing');
        kick(0);
      }
    });
    el.canvas.addEventListener('dblclick', (e) => {
      const [sx, sy] = pointerPos(e);
      const hit = nodeAt(sx, sy);
      if (hit) openNode(hit);
    });
    el.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = pointerPos(e);
      zoomBy(Math.exp(-clamp(e.deltaY, -120, 120) * 0.0022), sx, sy);
    }, { passive: false });
    el.canvas.addEventListener('keydown', (e) => {
      const step = 60 / G.view.s;
      const keys = {
        ArrowLeft: () => { G.view.x -= step; }, ArrowRight: () => { G.view.x += step; },
        ArrowUp: () => { G.view.y -= step; }, ArrowDown: () => { G.view.y += step; },
        '+': () => zoomBy(1.25), '=': () => zoomBy(1.25), '-': () => zoomBy(0.8), '0': () => fit(true),
        Escape: () => closeDetail(),
      };
      const run = keys[e.key];
      if (!run) return;
      e.preventDefault();
      G.target = null;
      if (e.key !== '0' && e.key !== 'Escape') G.moved = true;
      run();
      kick(0);
    });
    el.zoomIn.addEventListener('click', () => zoomBy(1.3));
    el.zoomOut.addEventListener('click', () => zoomBy(1 / 1.3));
    el.fit.addEventListener('click', () => fit(true));

    // ---------------------------------------------------------------- Einzelheiten

    function select(id, center) {
      S.selected = id;
      const n = G.byId.get(id);
      if (!n) return;
      if (center) centerOn(n);
      showDetail(id);
      kick(0);
    }

    function closeDetail() {
      if (!S.selected && el.detail.hidden) return;
      S.selected = '';
      el.detail.hidden = true;
      kick(0);
    }

    function askFor(n) {
      const t = n.title;
      switch (n.art) {
        case 'gedaechtnis': return 'Was weißt du über mich?';
        case 'person': return 'Was weißt du über ' + t + '?';
        case 'projekt': return 'Zeig mir das Projekt ' + t;
        case 'tag': return 'Was haben wir am ' + (n.k.id || t) + ' gemacht?';
        case 'sitzung': return 'Woran haben wir in der Sitzung am ' + (n.k.tag || '') + ' um ' + t.split(' ').pop() + ' gearbeitet?';
        default: return 'Was steht in meinem Notizbuch zu ' + t + '?';
      }
    }

    function showDetail(id) {
      const n = G.byId.get(id);
      if (!n) return;
      const k = kindOf(n.art);
      const info = n.k;
      el.detailKind.textContent = '';
      const dot = node('span', 'sy-dot');
      dot.dataset.shape = n.art;
      dot.style.setProperty('--kind', k.color);
      el.detailKind.append(dot, node('span', '', k.one + (info.neu ? ' · neu' : '')));
      el.detailTitle.textContent = n.title;
      let text = info.auszug || '';
      if (n.art === 'projekt') text = (info.laeuft ? 'Wird gerade gebaut. ' : 'Werkstatt-Projekt. ') + text;
      if (n.art === 'sitzung') text = (info.anzahl || 0) + ' Befehle' + (info.laufend ? ', läuft gerade' : '') + (text ? ': ' + text : '');
      if (n.art === 'gedaechtnis') text = (info.fakten || 0) + ' Fakten gespeichert. ' + (info.auszug || '');
      el.detailText.textContent = text || 'Noch kein Text.';
      el.detailFile.textContent = info.datei || '';
      el.detailLinks.textContent = '';
      const links = (G.adj.get(id) || []).filter((x) => shown(x.other));
      links.sort((a, b) => ORDER.indexOf(a.other.art) - ORDER.indexOf(b.other.art) || b.other.grad - a.other.grad);
      links.slice(0, 12).forEach(({ other, edge }) => {
        const li = node('li');
        const b = node('button');
        b.type = 'button';
        const d = node('span', 'sy-dot');
        d.dataset.shape = other.art;
        d.style.setProperty('--kind', kindOf(other.art).color);
        const why = edge.warum || EDGE_WORDS[edge.art] || '';
        b.append(d, node('span', '', other.title), node('small', edge.art === 'auto' ? 'auto' : '', why));
        b.title = other.title + ': ' + why;
        b.addEventListener('click', () => select(other.id, true));
        li.append(b);
        el.detailLinks.append(li);
      });
      if (links.length > 12) el.detailLinks.append(node('li', 'sy-detail-file', 'und ' + (links.length - 12) + ' weitere'));
      const canOpen = !!info.datei || n.art === 'projekt';
      el.detailOpen.hidden = !canOpen;
      el.detailOpen.textContent = n.art === 'projekt' ? 'Ordner öffnen' : 'In Obsidian öffnen';
      el.detailOpen.title = n.art === 'projekt' ? 'Den Projektordner im Explorer öffnen'
        : 'In Obsidian öffnen (ohne Obsidian im Standardprogramm)';
      el.detailAsk.title = 'Fragt Jarvis: ' + askFor(n);
      el.detail.hidden = false;
    }

    function openNode(n) {
      call('system_open', n.id).then((r) => {
        if (r && r.ok) toast(r.wie === 'obsidian' ? 'In Obsidian geöffnet.' : 'Geöffnet.', 'info');
        else toast((r && r.error) || 'Das ließ sich nicht öffnen.', 'error');
      }).catch(() => toast('Jarvis ist gerade nicht verbunden.', 'error'));
    }

    el.detailClose.addEventListener('click', () => {
      closeDetail();
      el.canvas.focus();
    });
    el.detailOpen.addEventListener('click', () => {
      const n = G.byId.get(S.selected);
      if (n) openNode(n);
    });
    el.detailAsk.addEventListener('click', () => {
      const n = G.byId.get(S.selected);
      if (!n) return;
      const text = askFor(n);
      call('send_text', text).then(() => {
        toast('Gefragt: ' + text, 'info');
        setHome('gespraech');
      }).catch(() => toast('Jarvis ist gerade nicht verbunden.', 'error'));
    });
    el.detail.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeDetail();
        el.canvas.focus();
      }
    });

    // ---------------------------------------------------------------- Suche

    function searchHits(query) {
      const q = fold(query.trim());
      if (!q) return [];
      const words = q.split(/\s+/);
      return G.nodes.filter((n) => shown(n) && words.every((w) => n.fold.includes(w)))
        .sort((a, b) => (fold(a.title).startsWith(words[0]) ? 0 : 1) - (fold(b.title).startsWith(words[0]) ? 0 : 1)
          || b.grad - a.grad)
        .slice(0, 8);
    }

    function renderHits() {
      const hits = searchHits(el.search.value);
      el.hits.textContent = '';
      if (!el.search.value.trim()) {
        el.hits.hidden = true;
        el.search.removeAttribute('aria-activedescendant');
        return;
      }
      if (!hits.length) {
        el.hits.append(node('li', 'sy-none', 'Nichts gefunden.'));
      }
      S.hit = clamp(S.hit, 0, Math.max(0, hits.length - 1));
      hits.forEach((n, i) => {
        const li = node('li');
        li.setAttribute('role', 'presentation');
        const b = node('button');
        b.type = 'button';
        b.id = 'syHit' + i;
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(i === S.hit));
        const d = node('span', 'sy-dot');
        d.dataset.shape = n.art;
        d.style.setProperty('--kind', n.color);
        b.append(d, node('span', '', n.title), node('small', '', kindOf(n.art).one));
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => pick(n));
        li.append(b);
        el.hits.append(li);
      });
      el.hits.hidden = false;
      if (hits.length) el.search.setAttribute('aria-activedescendant', 'syHit' + S.hit);
      return hits;
    }

    function pick(n) {
      el.hits.hidden = true;
      select(n.id, true);
    }

    el.search.addEventListener('input', () => {
      S.hit = 0;
      renderHits();
    });
    el.search.addEventListener('keydown', (e) => {
      const hits = searchHits(el.search.value);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        S.hit = clamp(S.hit + (e.key === 'ArrowDown' ? 1 : -1), 0, Math.max(0, hits.length - 1));
        renderHits();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (hits[S.hit]) pick(hits[S.hit]);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        el.search.value = '';
        renderHits();
      }
    });
    el.search.addEventListener('blur', () => setTimeout(() => { el.hits.hidden = true; }, 120));
    el.search.addEventListener('focus', () => {
      if (el.search.value.trim()) renderHits();
    });

    // ---------------------------------------------------------------- Anstoßen

    if (window.ResizeObserver) {
      new ResizeObserver(() => resize()).observe(el.wrap);
    } else {
      window.addEventListener('resize', resize);
    }
    document.addEventListener('jarvis:home', wake);
    document.addEventListener('visibilitychange', wake);
    const shownBefore = window.jarvisShown;
    const hiddenBefore = window.jarvisHidden;
    window.jarvisShown = () => {
      if (typeof shownBefore === 'function') shownBefore();
      setTimeout(wake, 0);
    };
    window.jarvisHidden = () => {
      if (typeof hiddenBefore === 'function') hiddenBefore();
      wake();
    };

    return {
      handle(ev) {
        if (!ev || typeof ev !== 'object') return;
        if (ev.action === 'show') {
          setHome('system');
          setTimeout(() => refresh(true), 0);
        }
      },
      connected() {
        if (active()) wake();
      },
      refresh: () => refresh(true),
      isActive: active,
    };
  }

  // ------------------------------------------------------------------ Demo (?demo&home=system, ohne Python)

  function demoGraph() {
    const today = new Date();
    const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const wd = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    const knoten = [];
    const kanten = [];
    const add = (id, titel, art, auszug, extra) => knoten.push(Object.assign({ id, titel, art, grad: 0, neu: false, auszug: auszug || '', datei: '' }, extra || {}));
    const link = (a, b, art, warum) => kanten.push(Object.assign({ a, b, art }, warum ? { warum } : {}));
    add('Gedächtnis', 'Gedächtnis', 'gedaechtnis', 'Georg spielt gern Valorant. Max ist sein bester Freund. Georg streamt freitags auf Twitch.', { fakten: 38, datei: 'Gedächtnis.md' });
    [['Max', 'Bester Freund, schreibt über Discord'], ['Anna', 'Schwester, Geburtstag am 3. Mai'], ['Lena', 'Kollegin, Mails über Gmail'], ['Tom', 'Spielt mit Georg Valorant']]
      .forEach(([n, t]) => add(n, n, 'person', t, { datei: 'Personen/' + n + '.md' }));
    [['stream-overlay', 'Ein Twitch-Overlay mit Alerts für OBS', true], ['discord-bot-wuerfel', 'Ein Würfelspiel-Bot für den Discord-Server'],
      ['wetter-app', 'Eine kleine Wetter-App für den Desktop'], ['portfolio-webseite', 'Eine Webseite mit Georgs Projekten'],
      ['valorant-tracker', 'Zeigt die letzten Valorant-Runden mit Statistik']]
      .forEach(([n, t, run]) => add('projekt:' + n, n, 'projekt', t, { laeuft: !!run }));
    [['Die besten Gaming-Mäuse', 'Logitech G Pro Superlight, Razer Viper V3: leicht, Funk, guter Sensor.'],
      ['Streaming-Setup', 'OBS mit Overlay, ein gutes Mikrofon und eine Webcam reichen für Twitch.'],
      ['Mikrofone für Twitch', 'Rode NT-USB, Shure MV7: im Vergleich für Streamer.'],
      ['Urlaub in Italien', 'Gardasee im Juni: Hotels, Flüge, Wetter.'],
      ['Grafikkarten 2026', 'RTX 5070 gegen RX 9070: Leistung pro Euro.'],
      ['Discord-Bots im Vergleich', 'Welche Bibliothek für einen Würfel-Bot: discord.py oder nextcord.'],
      ['Steuererklärung 2025', 'Fristen, Belege, Elster: was Georg braucht.']]
      .forEach(([n, t], i) => add(n, n, 'recherche', t, { datei: 'Recherchen/' + n + '.md', neu: i === 2 }));
    [['Stream-Ideen', 'Overlay mit Alerts, Mikrofon-Filter testen, Valorant-Turnier am Freitag.'],
      ['Schnellnotizen', 'Milch kaufen. Max wegen Samstag anrufen.'],
      ['Geschenkideen', 'Anna: Kopfhörer. Max: Mauspad XXL.'],
      ['Einkaufsliste', 'Kabelbinder, HDMI-Kabel, Kaffee.']]
      .forEach(([n, t]) => add(n, n, 'notiz', t, { datei: 'Notizen/' + n + '.md' }));
    for (let i = 0; i < 9; i += 1) {
      const d = new Date(today.getTime() - i * 86400000);
      add(iso(d), wd[d.getDay()] + ' ' + d.getDate() + '.' + (d.getMonth() + 1) + '.', 'tag', 'Gespräche des Tages.', { datei: 'Tagebuch/' + iso(d) + '.md', neu: i === 0 });
    }
    const sessions = [];
    for (let i = 0; i < 5; i += 1) {
      const d = new Date(today.getTime() - i * 86400000 * 1.3);
      const hh = [20, 18, 21, 19, 10][i];
      const id = 'sitzung:' + iso(d) + 'T' + hh + ':00';
      add(id, wd[d.getDay()] + ' ' + hh + ':00', 'sitzung', ['Recherchiere die besten Gaming-Mäuse', 'Bau mir ein Stream-Overlay', 'Plan meine Woche', 'Schreib Max wegen Samstag', 'Briefing'][i],
        { anzahl: [7, 12, 4, 5, 3][i], laufend: i === 0, tag: iso(d) });
      sessions.push([id, iso(d)]);
    }
    ['Max', 'Anna', 'Tom', 'projekt:stream-overlay', 'projekt:valorant-tracker'].forEach((n) => link('Gedächtnis', n, 'gedaechtnis', 'steht im Gedächtnis'));
    sessions.forEach(([id, day]) => {
      link('Gedächtnis', id, 'gedaechtnis', 'Sitzung für Sitzung');
      if (knoten.some((k) => k.id === day)) link(id, day, 'link');
    });
    const days = knoten.filter((k) => k.art === 'tag').map((k) => k.id);
    link(days[0], 'Max', 'link');
    link(days[0], 'Mikrofone für Twitch', 'erwaehnt', 'beim Namen genannt');
    link(days[1], 'Die besten Gaming-Mäuse', 'erwaehnt', 'beim Namen genannt');
    link(days[1], 'Tom', 'link');
    link(days[2], 'projekt:stream-overlay', 'erwaehnt', 'beim Namen genannt');
    link(days[3], 'Anna', 'link');
    link(days[4], 'Urlaub in Italien', 'erwaehnt', 'beim Namen genannt');
    link(days[5], 'Lena', 'link');
    link(days[6], 'Steuererklärung 2025', 'erwaehnt', 'beim Namen genannt');
    link(days[7], 'projekt:discord-bot-wuerfel', 'erwaehnt', 'beim Namen genannt');
    link('Geschenkideen', 'Anna', 'link');
    link('Geschenkideen', 'Max', 'link');
    link('Schnellnotizen', 'Max', 'link');
    link('Stream-Ideen', 'projekt:stream-overlay', 'auto', 'gemeinsam: Overlay, Alerts, Twitch');
    link('Stream-Ideen', 'Streaming-Setup', 'auto', 'gemeinsam: Overlay, Mikrofon, OBS');
    link('Streaming-Setup', 'Mikrofone für Twitch', 'auto', 'gemeinsam: Mikrofon, Twitch, Rode');
    link('Streaming-Setup', 'projekt:stream-overlay', 'auto', 'gemeinsam: Overlay, OBS, Alerts');
    link('Die besten Gaming-Mäuse', 'Grafikkarten 2026', 'auto', 'gemeinsam: Gaming, Leistung');
    link('Discord-Bots im Vergleich', 'projekt:discord-bot-wuerfel', 'auto', 'gemeinsam: Discord, Würfel, Bot');
    link('projekt:valorant-tracker', 'Stream-Ideen', 'auto', 'gemeinsam: Valorant, Turnier');
    link('projekt:portfolio-webseite', 'projekt:wetter-app', 'auto', 'gemeinsam: Webseite, Desktop');
    link('Einkaufsliste', 'Schnellnotizen', 'auto', 'gemeinsam: kaufen, Kaffee');
    link('Tom', 'projekt:valorant-tracker', 'erwaehnt', 'beim Namen genannt');
    const grad = {};
    kanten.forEach((e) => { grad[e.a] = (grad[e.a] || 0) + 1; grad[e.b] = (grad[e.b] || 0) + 1; });
    knoten.forEach((k) => { k.grad = grad[k.id] || 0; });
    const art = {};
    knoten.forEach((k) => { art[k.art] = (art[k.art] || 0) + 1; });
    const now = new Date();
    return {
      knoten, kanten, notizbuch: true,
      zahlen: { knoten: knoten.length, kanten: kanten.length, auto: kanten.filter((e) => e.art === 'auto').length, art },
      stand: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
    };
  }

  function demoState() {
    const skill = (name, beschreibung, gelernt) => Object.assign({ name, beschreibung }, gelernt ? { gelernt: true } : {});
    const agents = [
      { id: 'jarvis', name: 'Jarvis', kuerzel: 'JA', rolle: 'Ihr Butler: hört zu, antwortet, verteilt die Arbeit', status: 'bereit', text: 'Hört auf „Jarvis“',
        skills: [skill('morgen-briefing', 'Morgen-Briefing oder Tagesüberblick'), skill('tagesplan', 'Den Tag planen und den Kalender ordnen'),
          skill('notizbuch', 'Im Notizbuch nachsehen oder hineinschreiben'), skill('smart-home', 'Licht, Steckdosen und Alexa steuern'),
          skill('obs-aufnahme', 'Ein Video mit OBS aufnehmen und exportieren', true)],
        werkzeuge: ['Sprache', 'Programme', 'Gmail', 'Google Calendar'], beispiel: 'Öffne Spotify', auftrag: true },
      { id: 'recherche', name: 'Recherche', kuerzel: 'RE', rolle: 'Sucht gründlich, vergleicht, legt einen Bericht ab', status: 'arbeitet',
        text: 'Vergleicht Gaming-Mäuse unter 100 Euro', zeit: '09:41', fortschritt: null,
        skills: [skill('recherche', 'Gründliche Recherche mit Bericht im Notizbuch'), skill('nachrichten', 'Nachrichten und Börse')],
        werkzeuge: ['Websuche', 'Webseiten', 'Notizbuch'], beispiel: 'Die besten Gaming-Mäuse unter 100 Euro', auftrag: true },
      { id: 'texte', name: 'Texte', kuerzel: 'TX', rolle: 'Schreibt Mails, Nachrichten und Posts, verschickt nie selbst', status: 'fertig',
        text: 'Absage an den Vermieter liegt bereit', zeit: '09:12', skills: [], werkzeuge: ['Entwürfe', 'Websuche'],
        beispiel: 'Eine freundliche Absage an den Vermieter', auftrag: true },
      { id: 'technik', name: 'Technik', kuerzel: 'TE', rolle: 'Untersucht PC-Probleme, ändert nichts ohne Sie', status: 'bereit', text: 'Wacht über den Rechner',
        skills: [skill('pc-pflege', 'Den PC aufräumen, aktualisieren, schneller machen'), skill('bildschirm', 'Sehen, was auf dem Bildschirm steht')],
        werkzeuge: ['PowerShell', 'Ereignisanzeige'], beispiel: 'Warum ruckelt Valorant seit gestern?', auftrag: true },
      { id: 'post', name: 'Posteingang', kuerzel: 'PO', rolle: 'Sichtet Ihre Mails fürs Lagebild, nur lesend', status: 'fertig', text: '17 neue Mails, 1 wichtig', zeit: '09:05',
        skills: [skill('morgen-briefing', 'Morgen-Briefing oder Tagesüberblick')], werkzeuge: ['Gmail'], beispiel: 'Ist die Rechnung schon da?', auftrag: true },
      { id: 'kalender', name: 'Kalender', kuerzel: 'KA', rolle: 'Hält Ihren Tag und Ihre Woche im Blick', status: 'wartet', text: 'Zwei Termine überschneiden sich um 14 Uhr', zeit: '09:05',
        skills: [skill('tagesplan', 'Den Tag planen und den Kalender ordnen')], werkzeuge: ['Google Kalender'], beispiel: 'Wann habe ich nächste Woche Zeit?', auftrag: true },
      { id: 'werkstatt', name: 'Werkstatt', kuerzel: 'WE', rolle: 'Baut Programme, Webseiten und Spiele und testet sie', status: 'arbeitet', text: 'Baut: Stream Overlay',
        fortschritt: 0.6, skills: [], werkzeuge: ['Claude Code', 'Unsichtbarer Testplatz'], beispiel: 'Ein Würfelspiel für Discord', auftrag: true },
      { id: 'blueprint', name: 'Blueprint', kuerzel: 'BP', rolle: 'Entwirft 3D-Modelle als Hologramm', status: 'bereit', text: 'Zuletzt: Aufklärungsdrohne',
        skills: [], werkzeuge: ['Hologramm', 'Blender'], beispiel: 'Einen Iron-Man-Helm', auftrag: true },
      { id: 'stream', name: 'Stream', kuerzel: 'ST', rolle: 'Bereitet Ihren Stream vor und geht live', status: 'bereit', text: 'Sagen Sie „Ich will streamen“',
        skills: [skill('spiele', 'Spiele starten, auflisten oder beenden')], werkzeuge: ['OBS', 'Twitch', 'Steam'], beispiel: 'Valorant', auftrag: true },
    ];
    const q = (id, name, hinweis, frage) => ({ id, name, hinweis, frage: frage || '' });
    const now = new Date();
    const hhmm = (h, m) => String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    return {
      agenten: agents,
      skills: [
        q('briefing', 'Morgen-Briefing', 'Mails, Termine, Nachrichten und Wetter vorgelesen'), q('heute', 'Heute planen', 'Termine und Vorhaben als Tagesplan'),
        q('woche', 'Woche planen', 'Die nächsten sieben Tage im Überblick'), q('mails', 'Mails prüfen', 'Nur lesend, über Ihren Gmail-Konnektor'),
        q('recherche', 'Tiefen\u00adrecherche', 'Mehrere Quellen, mit Bericht im Notizbuch', 'Was soll ich recherchieren?'),
        q('notiz', 'Notiz', 'Landet im Notizbuch, verknüpft sich von selbst', 'Was soll ich notieren?'),
        q('weltlage', 'Weltlage', 'Die Erde mit den neuesten Meldungen'), q('spiele', 'Spiele-Updates', 'Steam und Epic durchsehen'),
        q('stream', 'Stream vorbereiten', 'OBS, Kamera, Mikrofon und Twitch'), q('pc', 'PC-Pflege', 'Was bremst, was Speicher frisst'),
        q('sitzung', 'Letzte Sitzung', 'Woran Sie zuletzt mit Jarvis waren'), q('lernen', 'Fähigkeit lernen', 'Ein Ablauf, den Jarvis ab jetzt kann', 'Was soll Jarvis lernen?'),
        Object.assign(q('gelernt:obs-aufnahme', 'Obs aufnahme', 'Ein Video mit OBS aufnehmen und exportieren'), { gelernt: true }),
      ],
      automationen: {
        zeitplaene: [{ id: 'a', tage: 'werktags', uhrzeit: '08:00', befehl: 'Briefing' }, { id: 'b', tage: 'freitags', uhrzeit: '19:30', befehl: 'Ich will streamen' }],
        befehle: [{ name: 'Zockmodus', aktion: 'öffne Discord und Steam, Gaming-Modus an', anzahl: 14 }],
        gewohnheiten: [{ text: 'werktags gegen 18:00 Uhr: Discord und Spotify', anzahl: 9 }],
      },
      gedaechtnis: {
        fakten: 38, personen: 4, gesamt: 23,
        sitzungen: [
          { tag: 'Heute', von: hhmm(Math.max(0, now.getHours() - 1), 12), bis: hhmm(now.getHours(), now.getMinutes()), anzahl: 7, laufend: true,
            themen: ['Recherchiere die besten Gaming-Mäuse', 'Werkstatt: Bau mir ein Stream-Overlay', 'Plan meinen Tag'] },
          { tag: 'Gestern', von: '18:04', bis: '19:21', anzahl: 12, themen: ['Ich will Valorant streamen', 'Schreib Max wegen Samstag', 'Mach den Gaming-Modus an'] },
          { tag: 'Mittwoch', von: '21:10', bis: '21:32', anzahl: 4, themen: ['Plan meine Woche', 'Notiere: Steuer bis 31. Juli'] },
          { tag: 'Dienstag', von: '19:00', bis: '19:15', anzahl: 3, themen: ['Wie wird das Wetter am Gardasee?'] },
        ],
      },
      zahlen: { agenten: agents.length, aktiv: 2, skills: 13 },
      stand: hhmm(now.getHours(), now.getMinutes()),
    };
  }

  function demo(push) {
    const say = (user, answer) => {
      push({ type: 'message', role: 'user', text: user });
      setTimeout(() => push({ type: 'message', role: 'jarvis', text: answer, final: true }), 500);
    };
    return {
      api: {
        system_state: () => Promise.resolve(demoState()),
        system_graph: () => Promise.resolve(demoGraph()),
        system_skill: (id, text) => {
          const s = demoState().skills.find((x) => x.id === id);
          if (!s) return Promise.resolve({ ok: false, error: 'Diesen Skill gibt es nicht.' });
          if (s.frage && !text) return Promise.resolve({ ok: false, error: 'Dafür fehlt noch, was Jarvis tun soll.' });
          const satz = s.frage ? s.name + ': ' + text : s.name;
          say(satz, 'Im Demo-Modus spiele ich das nur vor, Sir. Verbunden mit Jarvis läuft es sofort.');
          return Promise.resolve({ ok: true, satz });
        },
        system_agent: (id, text) => {
          say(text, 'Im Demo-Modus spiele ich das nur vor, Sir.');
          return Promise.resolve({ ok: true, satz: text });
        },
        system_open: () => Promise.resolve({ ok: false, error: 'Im Demo-Modus öffnet sich nichts.' }),
      },
    };
  }

  window.JarvisSystem = { create, demo, demoGraph, demoState };
})();
