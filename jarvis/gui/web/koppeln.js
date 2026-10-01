/* Jarvis aufs Handy: Verbindung an/aus, QR-Code, Adresse. */
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

    function showPane(pane) {
      for (const b of el.tabs) b.setAttribute('aria-selected', String(b.dataset.pane === pane));
      for (const p of el.dlg.querySelectorAll('.dlg-pane')) p.hidden = p.dataset.pane !== pane;
      if (pane === 'alexa') refreshAlexa();
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

    function open() {
      lastFocus = document.activeElement;
      el.shade.hidden = false;
      el.dlg.hidden = false;
      render();
      refresh();
      el.close.focus();
    }

    function close() {
      el.shade.hidden = true;
      el.dlg.hidden = true;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
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
    return { open, close, refresh, showPane };
  }

  window.JarvisKoppeln = { create };
})();
