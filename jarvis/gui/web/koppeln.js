/* Verbinden: Handy (Verbindung an/aus, QR-Code, Adresse), Alexa und Georgs Konnektoren. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function create(opts) {
    const call = opts.call;
    const toast = opts.toast || (() => {});
    const el = {
      btn: $('phoneBtn'),
      shade: $('phoneShade'),
      dlg: $('phoneDlg'),
      close: $('phoneClose'),
      toggle: $('phoneToggle'),
      state: $('phoneState'),
      pair: $('phonePair'),
      qr: $('phoneQr'),
      url: $('phoneUrl'),
      copy: $('phoneCopy'),
      mac: $('phoneMac'),
      fresh: $('phoneNew'),
      wol: $('phoneWol'),
      tabs: el_tabs(),
      alexaToggle: $('alexaToggle'),
      alexaState: $('alexaState'),
      alexaSetup: $('alexaSetup'),
      alexaConsole: $('alexaConsole'),
      alexaModel: $('alexaModel'),
      alexaCode: $('alexaCode'),
      alexaLink: $('alexaLink'),
      alexaTest: $('alexaTest'),
      pushToggle: $('pushToggle'),
      pushState: $('pushState'),
      pushSetup: $('pushSetup'),
      pushTopic: $('pushTopic'),
      pushCopy: $('pushCopy'),
      pushTest: $('pushTest'),
      tsState: $('tsState'),
      tsHint: $('tsHint'),
      tsHelp: $('tsHelp'),
      tsToggle: $('tsToggle'),
      konnState: $('konnState'),
      konnList: $('konnList'),
      konnRefresh: $('konnRefresh'),
      konnHelp: $('konnHelp'),
    };
    function el_tabs() {
      return document.querySelectorAll('.dlg-tabs button[data-pane]');
    }
    let alexa = null;
    if (!el.dlg) return null;
    let info = null;
    let lastFocus = null;

    function render() {
      const on = !!(info && info.enabled);
      el.toggle.checked = on;
      el.btn.dataset.on = on ? '1' : '0';
      el.state.textContent = on ? (info.running ? 'An: bereit zum Koppeln' : 'An, startet …') : 'Aus';
      el.pair.hidden = !on;
      if (!on) return;
      el.qr.innerHTML = info.qr || '<span class="qr-missing">QR-Code fehlt. Die Adresse unten im Handy-Browser eintippen.</span>';
      el.url.textContent = info.url || '';
      el.url.title = info.url || '';
      el.mac.hidden = !info.mac;
      el.mac.textContent = info.mac
        ? 'PC per Handy einschalten (Wake-on-LAN): eine App wie „Wake On Lan“ mit der MAC-Adresse ' + info.mac + ' und der Adresse ' + info.ip + '.'
        : '';
    }

    async function refresh() {
      try {
        info = await call('phone_info');
      } catch {
        info = { enabled: false };
      }
      render();
      if (info && info.enabled) refreshTailscale();
    }

    // ------------------------------------------------------------ Sicher von überall (Tailscale)

    let ts = null;
    let tsEnable = '';
    let tsWaiting = '';  // Hinweis, solange Tailscale auf die Freigabe von HTTPS wartet
    let tsPoll = 0;

    function renderTailscale() {
      if (!el.tsState) return;
      const on = !!(ts && ts.url);
      if (on && tsPoll) stopWaiting();
      el.tsState.textContent = on ? 'Sicher von überall: an' : tsWaiting ? 'Sicher von überall: wartet auf Freigabe' : 'Sicher von überall: aus';
      el.tsToggle.textContent = on ? 'Ausschalten' : tsWaiting ? 'Wartet …' : tsEnable ? 'Erlaubt, nochmal' : 'Einschalten';
      el.tsHelp.hidden = !(ts && !ts.installed) && !tsEnable;
      el.tsHelp.textContent = tsEnable ? 'HTTPS erlauben' : 'Tailscale holen';
      if (on) el.tsHint.textContent = 'Die App läuft über ' + ts.url.replace(/^https:\/\//, '').replace(/\/$/, '') + '. Den QR-Code oben einmal neu scannen.';
      else if (tsWaiting) el.tsHint.textContent = tsWaiting;
      else if (ts && !ts.installed) el.tsHint.textContent = 'Erst Tailscale holen (oder sagen Sie: „Jarvis, installiere Tailscale“), einmal anmelden, am Handy dieselbe App mit demselben Konto. Dann hier einschalten.';
      else if (ts && ts.error) el.tsHint.textContent = ts.error;
    }

    // Tailscale wartet, bis HTTPS im Konto erlaubt ist, und schaltet dann selbst ein: so lange nachsehen
    function startWaiting(text) {
      tsWaiting = text;
      clearInterval(tsPoll);
      const until = Date.now() + 10 * 60 * 1000;
      tsPoll = setInterval(async () => {
        if (Date.now() > until) {
          stopWaiting();
          renderTailscale();
          return;
        }
        await refreshTailscale();
        if (ts && ts.url) refresh();
      }, 3000);
    }

    function stopWaiting() {
      clearInterval(tsPoll);
      tsPoll = 0;
      tsWaiting = '';
      tsEnable = '';
    }

    async function refreshTailscale() {
      try {
        ts = await call('tailscale_info');
      } catch {
        ts = null;
      }
      renderTailscale();
    }

    if (el.tsToggle) {
      el.tsToggle.addEventListener('click', async () => {
        const want = !(ts && ts.url);
        el.tsToggle.disabled = true;
        el.tsToggle.textContent = want ? 'Richte ein …' : 'Schalte aus …';
        try {
          const r = await call('tailscale_enable', want);
          tsEnable = r && r.enable_url ? r.enable_url : '';
          if (!want) stopWaiting();
          if (r && r.ok) toast(want ? 'Sicher von überall ist an. Den QR-Code neu scannen.' : 'Sicher von überall ist aus.', 'ok');
          else if (r && r.pending) {
            startWaiting(r.error || 'Im Browser einmal HTTPS erlauben, dann schaltet Jarvis es von selbst ein.');
            toast(r.error || 'Bitte im Browser HTTPS erlauben.', 'info');
          } else toast((r && r.error) || 'Das ging gerade nicht.', 'error');
        } catch {
          toast('Das ging gerade nicht.', 'error');
        } finally {
          el.tsToggle.disabled = false;
          await refreshTailscale();
          refresh();
        }
      });
      el.tsHelp.addEventListener('click', () => call('tailscale_help', tsEnable || 'download').catch(() => {}));
    }

    // ------------------------------------------------------------ Alexa

    function renderAlexa() {
      const on = !!(alexa && alexa.enabled);
      el.alexaToggle.checked = on;
      el.alexaState.textContent = on ? (alexa.connected ? 'An: wartet auf Alexa' : 'An, verbindet …') : 'Aus';
      el.alexaSetup.hidden = !on;
      el.alexaLink.dataset.ok = on && alexa.connected ? '1' : '0';
      el.alexaLink.textContent = !on ? '' : alexa.connected ? 'Der PC ist mit dem Vermittlungsdienst verbunden.' : 'Verbindung wird aufgebaut …';
    }

    async function refreshAlexa() {
      try {
        alexa = await call('alexa_info');
      } catch {
        alexa = { enabled: false };
      }
      renderAlexa();
    }

    async function copy(which, label) {
      try {
        const result = await call('alexa_copy', which);
        if (!result || !result.text) {
          toast('Erst die Alexa-Verbindung einschalten.', 'error');
          return;
        }
        if (!result.ok) await navigator.clipboard.writeText(result.text);
        toast(label + ' ist kopiert. Jetzt in der Konsole einfügen (Strg+V).', 'ok');
      } catch {
        toast('Kopieren ging nicht.', 'error');
      }
    }

    // ---------- Konnektoren (Gmail, Google Kalender, Shopify ... über Georgs Claude-Konto)

    function renderConnectors(info) {
      if (!el.konnState) return;
      const list = (info && info.liste) || [];
      if (info && info.an === false) {
        el.konnState.textContent = 'Abgeschaltet ([brain] konnektoren = false)';
      } else if (info && info.fehler) {
        el.konnState.textContent = info.fehler;
      } else {
        el.konnState.textContent = list.length
          ? list.length + (list.length === 1 ? ' Konnektor' : ' Konnektoren') + ' über Ihr Claude-Konto'
          : 'Noch keine gesehen. Fragen Sie Jarvis einmal etwas, oder auf „Neu prüfen“ klicken.';
      }
      el.konnList.replaceChildren(...list.map((c) => {
        const li = document.createElement('li');
        li.className = 'konn-item';
        li.dataset.ok = c.ok ? '1' : '0';
        const name = document.createElement('b');
        name.textContent = c.name;
        const state = document.createElement('small');
        state.textContent = c.ok ? 'verbunden' : 'nicht verbunden';
        li.append(name, state);
        return li;
      }));
    }

    async function refreshConnectors(fresh) {
      try {
        renderConnectors(await call('connectors', !!fresh));
      } catch {
        renderConnectors({ liste: [], fehler: 'Konnektoren sind im Demo-Modus nicht zu sehen.' });
      }
    }

    if (el.konnRefresh) {
      el.konnRefresh.addEventListener('click', async () => {
        el.konnRefresh.disabled = true;
        el.konnState.textContent = 'Frage Claude Code …';
        await refreshConnectors(true);
        el.konnRefresh.disabled = false;
      });
      el.konnHelp.addEventListener('click', () => call('connectors_help').catch(() => {}));
    }

    function showPane(pane) {
      for (const b of el.tabs) b.setAttribute('aria-selected', String(b.dataset.pane === pane));
      for (const p of el.dlg.querySelectorAll('.dlg-pane')) p.hidden = p.dataset.pane !== pane;
      if (pane === 'alexa') refreshAlexa();
      if (pane === 'konnektoren') refreshConnectors(false);
    }

    for (const b of el.tabs) b.addEventListener('click', () => showPane(b.dataset.pane));
    el.alexaToggle.addEventListener('change', async () => {
      const want = el.alexaToggle.checked;
      el.alexaToggle.disabled = true;
      try {
        alexa = await call('alexa_enable', want);
        toast(want ? 'Alexa-Verbindung ist an. Jetzt die fünf Schritte unten.' : 'Alexa-Verbindung ist aus.', 'ok');
        if (want) setTimeout(refreshAlexa, 2500);
      } catch {
        toast('Das ging gerade nicht.', 'error');
      } finally {
        el.alexaToggle.disabled = false;
        renderAlexa();
      }
    });
    el.alexaConsole.addEventListener('click', async () => {
      try {
        await call('alexa_console');
      } catch {
        toast('Bitte developer.amazon.com/alexa/console/ask im Browser öffnen.', 'info');
      }
    });
    el.alexaModel.addEventListener('click', () => copy('modell', 'Das Sprachmodell'));
    el.alexaCode.addEventListener('click', () => copy('code', 'Der Code'));
    el.alexaTest.addEventListener('click', async () => {
      el.alexaTest.disabled = true;
      el.alexaLink.textContent = 'Teste: ein Befehl auf dem Weg, den auch Alexa nimmt …';
      try {
        const result = await call('alexa_test');
        if (result && result.ok) {
          el.alexaLink.dataset.ok = '1';
          el.alexaLink.textContent = 'Klappt. Jarvis antwortet: „' + result.answer + '“';
        } else {
          el.alexaLink.dataset.ok = '0';
          el.alexaLink.textContent = (result && result.error) || 'Keine Antwort.';
        }
      } catch {
        el.alexaLink.textContent = 'Im Demo-Modus gibt es keine Verbindung.';
      } finally {
        el.alexaTest.disabled = false;
      }
    });

    // ------------------------------------------------------------ Benachrichtigungen aufs Handy

    let push = null;

    function renderPush() {
      if (!el.pushToggle) return;
      const on = !!(push && push.enabled);
      el.pushToggle.checked = on;
      el.pushState.textContent = on ? 'Benachrichtigungen: an' : 'Benachrichtigungen: aus';
      el.pushSetup.hidden = !on;
      el.pushTopic.textContent = on ? push.topic : '';
    }

    async function refreshPush() {
      try {
        push = await call('push_info');
      } catch {
        push = { enabled: false };
      }
      renderPush();
    }

    if (el.pushToggle) {
      el.pushToggle.addEventListener('change', async () => {
        const want = el.pushToggle.checked;
        el.pushToggle.disabled = true;
        try {
          push = await call('push_enable', want);
          toast(want ? 'Benachrichtigungen sind an. Jetzt den Kanal in der App ntfy abonnieren.' : 'Benachrichtigungen sind aus.', 'ok');
        } catch {
          toast('Das ging gerade nicht.', 'error');
        } finally {
          el.pushToggle.disabled = false;
          renderPush();
        }
      });
      el.pushCopy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(el.pushTopic.textContent);
          toast('Kanalname kopiert.', 'ok');
        } catch {
          toast('Kopieren ging nicht. Bitte von Hand abschreiben.', 'error');
        }
      });
      el.pushTest.addEventListener('click', async () => {
        el.pushTest.disabled = true;
        try {
          const result = await call('push_test');
          toast(result && result.ok ? 'Unterwegs. Auf dem Handy sollte gleich eine Nachricht von Jarvis erscheinen.'
            : (result && result.error) || 'Das ging nicht.', result && result.ok ? 'ok' : 'error');
        } catch {
          toast('Im Demo-Modus geht keine Nachricht raus.', 'info');
        } finally {
          el.pushTest.disabled = false;
        }
      });
    }

    // ------------------------------------------------------------ Punkte am Knopf

    const NAMES = { phone: 'Handy', alexa: 'Alexa' };

    async function refreshDots() {
      let state = null;
      try {
        state = await call('connections');
      } catch {
        return; // noch nicht verbunden: später nochmal
      }
      if (!state) return;
      const on = [];
      document.querySelectorAll('#phoneConn i[data-k]').forEach((dot) => {
        const active = !!state[dot.dataset.k];
        dot.dataset.on = active ? '1' : '0';
        if (active) on.push(NAMES[dot.dataset.k]);
      });
      el.btn.dataset.on = state.phone ? '1' : '0';
      el.btn.title = on.length ? 'Verbunden: ' + on.join(', ') + '. Klicken für Handy, Alexa und Konnektoren.'
        : 'Handy und Alexa mit Jarvis verbinden, Konnektoren ansehen';
      el.btn.setAttribute('aria-label', 'Verbinden' + (on.length ? ', verbunden: ' + on.join(', ') : ''));
    }

    setInterval(refreshDots, 30000);

    function open() {
      lastFocus = document.activeElement;
      el.shade.hidden = false;
      el.dlg.hidden = false;
      render();
      refresh();
      refreshPush();
      el.close.focus();
    }

    function close() {
      el.shade.hidden = true;
      el.dlg.hidden = true;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      refreshDots();
    }

    el.btn.addEventListener('click', open);
    el.close.addEventListener('click', close);
    el.shade.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.dlg.hidden) {
        e.preventDefault();
        close();
      }
    });
    el.toggle.addEventListener('change', async () => {
      const want = el.toggle.checked;
      el.toggle.disabled = true;
      try {
        info = await call('phone_enable', want);
        toast(want ? 'Handy-Verbindung ist an. Jetzt den QR-Code scannen.' : 'Handy-Verbindung ist aus.', 'ok');
      } catch {
        toast('Das ging gerade nicht.', 'error');
      } finally {
        el.toggle.disabled = false;
        render();
      }
    });
    el.copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(el.url.textContent);
        toast('Adresse kopiert.', 'ok');
      } catch {
        toast('Kopieren ging nicht. Bitte von Hand abschreiben.', 'error');
      }
    });
    el.wol.addEventListener('click', async () => {
      el.wol.disabled = true;
      toast('Windows fragt gleich nach Administratorrechten …', 'info');
      try {
        const result = await call('wol_prepare');
        toast(result && result.ok ? 'Fertig: ' + result.text + ' Im BIOS muss „Wake on LAN“ auch an sein.' : (result && result.text) || 'Das ging nicht.',
          result && result.ok ? 'ok' : 'error');
      } catch {
        toast('Im Demo-Modus geht das nicht.', 'info');
      } finally {
        el.wol.disabled = false;
      }
    });
    el.fresh.addEventListener('click', async () => {
      try {
        info = await call('phone_new_key');
        toast('Neuer Schlüssel. Bitte das Handy neu koppeln.', 'ok');
        render();
      } catch {
        toast('Das ging gerade nicht.', 'error');
      }
    });
    refresh();
    return { open, close, refresh, showPane, dots: refreshDots };
  }

  window.JarvisKoppeln = { create };
})();
