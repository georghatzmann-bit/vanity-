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
      discordState: $('discordState'),
      discordHint: $('discordHint'),
      discordSteps: $('discordSteps'),
      discordPortal: $('discordPortal'),
      discordForm: $('discordForm'),
      discordToken: $('discordToken'),
      discordSave: $('discordSave'),
      discordInviteRow: $('discordInviteRow'),
      discordInvite: $('discordInvite'),
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

    // ------------------------------------------------------------ Discord

    function renderDiscord(info) {
      const ok = !!(info && info.configured && info.name && !info.error);
      el.discordState.textContent = ok ? 'Bot ' + info.name + (info.guilds.length ? ' ist auf: ' + info.guilds.join(', ') : ' (noch auf keinem Server)')
        : info && info.error ? 'Problem: ' + info.error : 'Nicht eingerichtet';
      el.discordSteps.hidden = ok;
      el.discordForm.hidden = ok && info.guilds.length > 0;
      el.discordInviteRow.hidden = !ok;
    }

    async function refreshDiscord() {
      try {
        renderDiscord(await call('discord_info'));
      } catch {
        renderDiscord(null);
      }
    }

    el.discordPortal.addEventListener('click', () => call('discord_portal').catch(() => {}));
    el.discordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      el.discordSave.disabled = true;
      try {
        const info = await call('discord_save', el.discordToken.value);
        renderDiscord(info);
        if (info && info.configured && !info.error) {
          el.discordToken.value = '';
          toast('Der Bot ist eingerichtet. Jetzt auf deinen Server holen.', 'ok');
        } else {
          toast((info && info.error) || 'Der Token geht nicht.', 'error');
        }
      } catch {
        toast('Das ging gerade nicht.', 'error');
      } finally {
        el.discordSave.disabled = false;
      }
    });
    el.discordInvite.addEventListener('click', async () => {
      try {
        const result = await call('discord_invite');
        toast(result && result.ok ? 'Im Browser den Server wählen und „Autorisieren“.' : (result && result.error) || 'Das ging nicht.',
          result && result.ok ? 'ok' : 'error');
        setTimeout(refreshDiscord, 15000);
      } catch {
        toast('Im Demo-Modus geht das nicht.', 'info');
      }
    });

    function showPane(pane) {
      for (const b of el.tabs) b.setAttribute('aria-selected', String(b.dataset.pane === pane));
      for (const p of el.dlg.querySelectorAll('.dlg-pane')) p.hidden = p.dataset.pane !== pane;
      if (pane === 'alexa') refreshAlexa();
      if (pane === 'discord') refreshDiscord();
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

    // ------------------------------------------------------------ Punkte am Knopf

    const NAMES = { phone: 'Handy', alexa: 'Alexa', discord: 'Discord' };

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
      el.btn.title = on.length ? 'Verbunden: ' + on.join(', ') + '. Klicken für Handy, Alexa und Discord.'
        : 'Handy, Alexa und Discord mit Jarvis verbinden';
      el.btn.setAttribute('aria-label', 'Verbinden' + (on.length ? ', verbunden: ' + on.join(', ') : ''));
    }

    setInterval(refreshDots, 30000);

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
