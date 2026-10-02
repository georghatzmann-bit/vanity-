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
      calState: $('calState'),
      calForm: $('calForm'),
      calUrl: $('calUrl'),
      calSave: $('calSave'),
      calFeeds: $('calFeeds'),
      calGoogle: $('calGoogle'),
      calOutlook: $('calOutlook'),
      appleState: $('appleState'),
      appleHint: $('appleHint'),
      appleRefresh: $('appleRefresh'),
      appleOff: $('appleOff'),
      appleSetup: $('appleSetup'),
      appleLinked: $('appleLinked'),
      appleForm: $('appleForm'),
      appleId: $('appleId'),
      applePass: $('applePass'),
      appleSave: $('appleSave'),
      appleHelp: $('appleHelp'),
      appleCals: $('appleCals'),
      appleMail: $('appleMail'),
      mailList: $('mailList'),
      mailForm: $('mailForm'),
      mailProvider: $('mailProvider'),
      mailEmail: $('mailEmail'),
      mailPass: $('mailPass'),
      mailServer: $('mailServer'),
      mailSave: $('mailSave'),
      mailHelp: $('mailHelp'),
      shopState: $('shopState'),
      shopHint: $('shopHint'),
      shopOff: $('shopOff'),
      shopSetup: $('shopSetup'),
      shopForm: $('shopForm'),
      shopDomain: $('shopDomain'),
      shopClient: $('shopClient'),
      shopSecret: $('shopSecret'),
      shopSave: $('shopSave'),
      shopAdmin: $('shopAdmin'),
      shopScopes: $('shopScopes'),
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

    function renderTailscale() {
      if (!el.tsState) return;
      const on = !!(ts && ts.url);
      el.tsState.textContent = on ? 'Sicher von überall: an' : 'Sicher von überall: aus';
      el.tsToggle.textContent = on ? 'Ausschalten' : tsEnable ? 'Erlaubt, nochmal' : 'Einschalten';
      el.tsHelp.hidden = !(ts && !ts.installed) && !tsEnable;
      el.tsHelp.textContent = tsEnable ? 'HTTPS erlauben' : 'Tailscale holen';
      if (on) el.tsHint.textContent = 'Die App läuft über ' + ts.url.replace(/^https:\/\//, '').replace(/\/$/, '') + '. Den QR-Code oben einmal neu scannen.';
      else if (ts && !ts.installed) el.tsHint.textContent = 'Erst Tailscale holen (oder sag: „Jarvis, installiere Tailscale“), einmal anmelden, am Handy dieselbe App mit demselben Konto. Dann hier einschalten.';
      else if (ts && ts.error) el.tsHint.textContent = ts.error;
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
          if (r && r.ok) toast(want ? 'Sicher von überall ist an. Den QR-Code neu scannen.' : 'Sicher von überall ist aus.', 'ok');
          else toast((r && r.error) || 'Das ging gerade nicht.', 'error');
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

    // ---------- Kalender (geheime iCal-Adresse, nur lesen)

    function renderCalendar(cal) {
      if (!el.calState) return;
      const feeds = (cal && cal.feeds) || [];
      const broken = feeds.filter((f) => f.error);
      el.calState.textContent = !feeds.length ? 'Kein Kalender verbunden'
        : broken.length ? 'Ein Kalender ist gerade nicht erreichbar'
          : (feeds.length === 1 ? 'Kalender verbunden' : feeds.length + ' Kalender verbunden')
            + (typeof cal.count === 'number' ? ' · ' + cal.count + ' Termine in den nächsten 7 Tagen' : '');
      el.calFeeds.replaceChildren(...feeds.map((f) => {
        const li = document.createElement('li');
        const text = document.createElement('span');
        text.className = 'cal-feed';
        text.textContent = f.shown + (f.error ? ' · nicht erreichbar, es gilt der letzte Stand' : '');
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'mem-del';
        del.textContent = '×';
        del.title = 'Kalender entfernen';
        del.setAttribute('aria-label', 'Kalender entfernen');
        del.addEventListener('click', async () => {
          try {
            await call('calendar_remove', f.url);
            toast('Kalender entfernt.', 'ok');
            refreshCalendar();
          } catch {
            toast('Das ging gerade nicht.', 'error');
          }
        });
        li.append(text, del);
        return li;
      }));
    }

    async function refreshCalendar() {
      try {
        renderCalendar(await call('calendar_info'));
      } catch {
        /* ältere Version */
      }
    }

    if (el.calForm) {
      el.calForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const url = el.calUrl.value.trim();
        if (!url) {
          toast('Bitte zuerst die iCal-Adresse einfügen.', 'info');
          return;
        }
        el.calSave.disabled = true;
        el.calSave.textContent = 'Prüfe …';
        try {
          const r = await call('calendar_add', url);
          if (r && r.ok) {
            el.calUrl.value = '';
            const next = (r.next || []).length ? ' Als Nächstes: ' + r.next.join('; ') + '.' : '';
            toast('Kalender verbunden: ' + r.count + ' Termine in den nächsten zwei Wochen.' + next, 'ok');
          } else {
            toast((r && r.error) || 'Diese Adresse ging nicht.', 'error');
          }
        } catch {
          toast('Das ging gerade nicht.', 'error');
        } finally {
          el.calSave.disabled = false;
          el.calSave.textContent = 'Prüfen';
          refreshCalendar();
        }
      });
      el.calGoogle.addEventListener('click', () => call('calendar_help', 'google').catch(() => {}));
      el.calOutlook.addEventListener('click', () => call('calendar_help', 'outlook').catch(() => {}));
    }

    // ---------- iPhone (iCloud): Kalender lesen und schreiben, Mail lesen, Geburtstage

    function renderApple(info) {
      if (!el.appleState) return;
      const on = !!(info && info.verbunden);
      el.appleOff.hidden = !on;
      el.appleRefresh.hidden = !on;
      el.appleSetup.hidden = on;
      el.appleLinked.hidden = !on;
      if (!on) {
        el.appleState.textContent = info && info.fehler ? 'iPhone: ' + info.fehler : 'iPhone nicht verbunden';
        return;
      }
      const cals = info.kalender || [];
      const parts = ['Verbunden: ' + info.email];
      if (cals.length) parts.push(cals.length === 1 ? '1 Kalender' : cals.length + ' Kalender');
      if (info.geburtstage) parts.push(info.geburtstage + ' Geburtstage');
      el.appleState.textContent = parts.join(' · ');
      if (info.fehler) el.appleState.textContent += ' · ' + info.fehler;
      el.appleCals.replaceChildren(...cals.map((c) => {
        const li = document.createElement('li');
        li.classList.toggle('chosen', !!c.gewaehlt);
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'pick';
        pick.disabled = !c.schreibbar;
        pick.title = c.schreibbar ? 'Neue Termine hier eintragen' : 'In diesen Kalender darf Jarvis nicht schreiben';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = /^#[0-9a-f]{3,8}$/i.test(String(c.farbe || '')) ? c.farbe : '';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = String(c.name || c.id);
        const note = document.createElement('small');
        note.textContent = c.gewaehlt ? '' : c.schreibbar ? '' : 'nur lesen';
        pick.append(swatch, name, note);
        if (c.gewaehlt) {
          const check = document.createElement('span');
          check.className = 'check';
          check.textContent = '✓ gewählt';
          pick.append(check);
        }
        pick.addEventListener('click', async () => {
          try {
            const r = await call('apple_choose_calendar', c.id);
            if (r && r.ok) toast('Neue Termine kommen jetzt in „' + c.name + '“.', 'ok');
            else toast((r && r.fehler) || 'Das ging nicht.', 'error');
            refreshApple();
          } catch {
            toast('Das ging gerade nicht.', 'error');
          }
        });
        li.append(pick);
        return li;
      }));
      const mail = info.mail || {};
      if (mail.fehler) {
        el.appleMail.textContent = 'Mail: ' + mail.fehler;
      } else {
        const latest = (mail.letzte || []).slice(0, 3).map((m) => (m.von || m.adresse) + ': ' + m.betreff);
        el.appleMail.textContent = 'Mail: ' + (mail.ungelesen ? mail.ungelesen + ' ungelesen' : 'nichts Neues')
          + (latest.length ? ' · ' + latest.join(' · ') : '');
      }
    }

    function renderMail(accounts) {
      if (!el.mailList) return;
      el.mailList.replaceChildren(...(accounts || []).map((a) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = a.name + ' · ' + a.email + (a.fehler ? ' · ' + a.fehler : '');
        li.append(name);
        if (a.automatisch) {
          const small = document.createElement('small');
          small.textContent = 'kommt mit dem iPhone';
          li.append(small);
        } else {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'mem-del';
          del.textContent = '×';
          del.title = 'Postfach entfernen';
          del.setAttribute('aria-label', 'Postfach ' + a.name + ' entfernen');
          del.addEventListener('click', async () => {
            try {
              const r = await call('mail_remove', a.id);
              toast(r && r.ok ? 'Postfach entfernt. Das Passwort ist gelöscht.' : (r && r.fehler) || 'Das ging nicht.', r && r.ok ? 'ok' : 'error');
            } catch {
              toast('Das ging gerade nicht.', 'error');
            }
            refreshApple();
          });
          li.append(del);
        }
        return li;
      }));
    }

    async function refreshApple() {
      try {
        renderApple(await call('apple_info'));
        renderMail(await call('mail_accounts'));
      } catch (err) {
        // Jarvis-Version ohne iPhone-Anbindung: den Reiter gar nicht erst anbieten
        if (String((err && err.message) || '').startsWith('nicht verbunden')) hideTab('apple');
      }
    }

    function hideTab(pane) {
      for (const b of el.tabs) {
        if (b.dataset.pane !== pane) continue;
        b.hidden = true;
        if (b.getAttribute('aria-selected') === 'true') showPane('phone');
      }
    }

    if (el.appleForm) {
      el.appleForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = el.appleId.value.trim();
        const pass = el.applePass.value.trim();
        if (!id || !pass) {
          toast('Bitte Apple-ID und app-spezifisches Passwort eintragen.', 'info');
          return;
        }
        el.appleSave.disabled = true;
        el.appleSave.textContent = 'Prüfe bei Apple …';
        try {
          const r = await call('apple_connect', id, pass);
          if (r && r.ok) {
            el.applePass.value = '';
            toast('iPhone verbunden. Neue Termine landen jetzt auf dem iPhone.' + (r.fehler ? ' ' + r.fehler : ''), 'ok');
            renderApple(r);
          } else {
            toast((r && r.fehler) || 'Das ging nicht.', 'error');
          }
        } catch {
          toast('Das ging gerade nicht.', 'error');
        } finally {
          el.appleSave.disabled = false;
          el.appleSave.textContent = 'Prüfen und verbinden';
          refreshApple();
        }
      });
      el.appleOff.addEventListener('click', async () => {
        try {
          const r = await call('apple_disconnect');
          toast(r && r.ok ? 'iPhone getrennt. Das Passwort ist gelöscht.' : (r && r.fehler) || 'Das ging nicht.', r && r.ok ? 'ok' : 'error');
        } catch {
          toast('Das ging gerade nicht.', 'error');
        }
        refreshApple();
      });
      el.appleRefresh.addEventListener('click', async () => {
        try {
          renderApple(await call('apple_refresh'));
          toast('Kalender abgerufen, die Kontakte kommen gleich.', 'ok');
        } catch {
          toast('Das ging gerade nicht.', 'error');
        }
      });
      el.appleHelp.addEventListener('click', () => call('apple_help').catch(() => {}));
      el.mailProvider.addEventListener('change', () => {
        el.mailServer.hidden = el.mailProvider.value !== 'imap';
        el.mailHelp.hidden = el.mailProvider.value === 'imap';
      });
      el.mailHelp.addEventListener('click', () => call('mail_help', el.mailProvider.value).catch(() => {}));
      el.mailForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = el.mailEmail.value.trim();
        const pass = el.mailPass.value.trim();
        if (!email || !pass) {
          toast('Bitte E-Mail-Adresse und App-Passwort eintragen.', 'info');
          return;
        }
        el.mailSave.disabled = true;
        el.mailSave.textContent = 'Prüfe …';
        try {
          const r = await call('mail_add', el.mailProvider.value, email, pass, el.mailServer.value.trim());
          if (r && r.ok) {
            el.mailPass.value = '';
            el.mailEmail.value = '';
            toast('Postfach verbunden. Frag „Hab ich neue Mails?“.', 'ok');
          } else {
            toast((r && r.fehler) || 'Das ging nicht.', 'error');
          }
        } catch {
          toast('Das ging gerade nicht.', 'error');
        } finally {
          el.mailSave.disabled = false;
          el.mailSave.textContent = 'Postfach hinzufügen';
          refreshApple();
        }
      });
    }

    // ---------- Shop (Shopify): lesen, Entwürfe, nie veröffentlichen

    const SHOP_SCOPES = 'read_orders,read_products,write_products,read_shopify_payments_payouts';

    function renderShop(info) {
      if (!el.shopState) return;
      const on = !!(info && info.verbunden);
      el.shopOff.hidden = !on;
      el.shopSetup.hidden = on && !info.fehler;
      if (!on) {
        el.shopState.textContent = 'Kein Shop verbunden';
        return;
      }
      if (info.fehler) {
        el.shopState.textContent = (info.name || info.adresse) + ': ' + info.fehler;
        return;
      }
      el.shopState.textContent = 'Verbunden mit ' + info.name + ' · heute ' + info.heute.anzahl + ' '
        + (info.heute.anzahl === 1 ? 'Bestellung' : 'Bestellungen') + ', ' + info.heute.umsatz;
    }

    async function refreshShop() {
      try {
        renderShop(await call('shop_info'));
      } catch {
        /* ältere Version */
      }
    }

    if (el.shopForm) {
      el.shopForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const domain = el.shopDomain.value.trim();
        const client = el.shopClient.value.trim();
        const secret = el.shopSecret.value.trim();
        if (!domain || !client || !secret) {
          toast('Bitte Shop-Adresse, Client-ID und Client-Secret eintragen.', 'info');
          return;
        }
        el.shopSave.disabled = true;
        el.shopSave.textContent = 'Prüfe …';
        try {
          const r = await call('shop_connect', domain, client, secret);
          if (r && r.ok) {
            el.shopSecret.value = '';
            toast('Shop verbunden: ' + r.name + '. Sag „Wie läuft der Shop?“.', 'ok');
            document.dispatchEvent(new CustomEvent('jarvis-shop'));
          } else {
            toast((r && r.error) || 'Das ging nicht.', 'error');
          }
        } catch {
          toast('Das ging gerade nicht.', 'error');
        } finally {
          el.shopSave.disabled = false;
          el.shopSave.textContent = 'Prüfen und verbinden';
          refreshShop();
        }
      });
      el.shopOff.addEventListener('click', async () => {
        try {
          const r = await call('shop_disconnect');
          toast(r && r.ok ? 'Shop getrennt. Das Secret ist gelöscht.' : (r && r.error) || 'Das ging nicht.', r && r.ok ? 'ok' : 'error');
          document.dispatchEvent(new CustomEvent('jarvis-shop'));
        } catch {
          toast('Das ging gerade nicht.', 'error');
        }
        refreshShop();
      });
      el.shopAdmin.addEventListener('click', () => call('shop_help', 'admin').catch(() => {}));
      el.shopScopes.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(SHOP_SCOPES);
          toast('Kopiert: ' + SHOP_SCOPES, 'ok');
        } catch {
          toast('Kopieren ging nicht. Bitte abschreiben: ' + SHOP_SCOPES, 'info');
        }
      });
    }

    function showPane(pane) {
      for (const b of el.tabs) b.setAttribute('aria-selected', String(b.dataset.pane === pane));
      for (const p of el.dlg.querySelectorAll('.dlg-pane')) p.hidden = p.dataset.pane !== pane;
      if (pane === 'alexa') refreshAlexa();
      if (pane === 'discord') refreshDiscord();
      if (pane === 'calendar') refreshCalendar();
      if (pane === 'shop') refreshShop();
      if (pane === 'apple') refreshApple();
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

    const NAMES = { phone: 'Handy', iphone: 'iPhone', alexa: 'Alexa', discord: 'Discord' };

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
      el.btn.title = on.length ? 'Verbunden: ' + on.join(', ') + '. Klicken für Handy, iPhone, Alexa, Discord, Kalender und Shop.'
        : 'Handy, iPhone, Alexa, Discord, Kalender und Shop mit Jarvis verbinden';
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
