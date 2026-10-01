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
    };
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
    return { open, close, refresh };
  }

  window.JarvisKoppeln = { create };
})();
