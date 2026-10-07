// =============================================================================
// Hauptmenü (Lobby), Spind, Shop, Modus-Auswahl
// =============================================================================
// Aufbau wie im Original-Lobby-Bildschirm (eigene Grafik, eigene Texte):
//   - Mitte: eigene Figur auf dem Podest (3D, world/lobbyScene.js)
//   - oben: Name (klicken = umbenennen), Level + XP-Balken, Pokale, Münzen, Zahnrad
//   - links: große Knöpfe "Shop" und "Spind"
//   - rechts unten: Modus-Karte (klicken = Modus wählen), Solo/Duo, großer gelber "SPIELEN"-Knopf
// Bedienung mit Maus, Tastatur (Pfeile, Enter, Esc) und Controller (Steuerkreuz/Stick, A, B).
// Alles, was gespeichert wird, läuft über die Rückrufe (saveProgress, saveSettings).
// =============================================================================
import { CONFIG } from '../config.js';
import { lobbyModes, getModeDef } from '../modes/index.js';
import {
  catalog, isOwned, canBuy, buyItem, equipItem, equippedItems, levelInfo, EQUIP_KEY,
} from '../core/progress.js';
import { emoteMotion } from '../world/cosmetics.js';
import { pickNeighbor } from './menuLogic.js';
import { ICONS, MODE_ICONS } from './menuIcons.js';

const KIND_SINGULAR = { skins: 'Skin', pickaxes: 'Spitzhacke', emotes: 'Emote' };

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function formatNumber(n) {
  return Math.round(n).toLocaleString('de-DE');
}

/**
 * @param {object} o
 * @param {HTMLElement} o.root       hierhin kommt das Menü (body)
 * @param {object} o.settings        Einstellungen (Name)
 * @param {object} o.progress        Fortschritt (core/progress.js)
 * @param {object} o.lobby           Lobby-Bühne (world/lobbyScene.js)
 * @param {object} o.audio           Ton (ui, playMusic …)
 * @param {Function} o.onPlay        (modeId, { team }) – SPIELEN gedrückt
 * @param {Function} o.openSettings  Einstellungen öffnen
 * @param {Function} o.isSettingsOpen
 * @param {Function} o.saveProgress
 * @param {Function} o.saveSettings
 */
export function createMenus(o) {
  const { settings, progress, lobby, audio } = o;
  const el = document.createElement('div');
  el.className = 'menu-root';
  el.innerHTML = template();
  o.root.appendChild(el);
  // Blende für den Übergang ins Spiel – liegt außerhalb des Menüs (bleibt sichtbar, wenn das Menü weg ist)
  const fadeEl = document.createElement('div');
  fadeEl.className = 'mfade';
  o.root.appendChild(fadeEl);
  const q = (sel) => el.querySelector(sel);

  const ui = {
    lobby: q('.lobby'),
    avatar: q('.profile-avatar img'),
    nameBtn: q('.name-btn'),
    nameText: q('.name-text'),
    nameInput: q('.name-input'),
    level: q('.level-badge b'),
    xpFill: q('.xp-bar i'),
    xpText: q('.xp-text'),
    trophies: q('.chip-trophies b'),
    coins: el.querySelectorAll('.chip-coins b'),
    gear: q('.gear-btn'),
    shopBtn: q('.btn-shop'),
    lockerBtn: q('.btn-locker'),
    modeCard: q('.mode-card'),
    modeIcon: q('.mode-card .mode-icon'),
    modeName: q('.mode-card .mode-name'),
    modeDesc: q('.mode-card .mode-desc'),
    soloBtn: q('.team-solo'),
    duoBtn: q('.team-duo'),
    play: q('.play-big'),
    collection: q('.collection'),
    colTitle: q('.collection .col-title'),
    colTabs: q('.collection .col-tabs'),
    colGrid: q('.collection .col-grid'),
    colDetail: q('.collection .col-detail'),
    colBack: q('.collection .col-back'),
    picker: q('.mode-picker'),
    pickerGrid: q('.mode-picker .picker-grid'),
    confirm: q('.confirm'),
    toast: q('.mtoast'),
    fade: fadeEl,
  };

  const state = {
    screen: null, // 'lobby' | 'locker' | 'shop' | null (im Spiel)
    collectionKind: 'skins',
    selected: null, // Katalog-Eintrag (Spind/Shop)
    mode: getModeDef(progress.lastMode) && !getModeDef(progress.lastMode).hidden ? progress.lastMode : CONFIG.lobby.defaultMode,
    team: 'solo',
    confirmItem: null,
    toastTimer: 0,
    hoverAt: 0,
    pad: { buttons: [], axes: [0, 0], repeatAt: 0, dir: null },
  };

  // --- kleine Helfer ----------------------------------------------------------------------
  function click(name = 'click') {
    audio?.ui?.(name);
  }

  function toast(text, kind = 'info') {
    ui.toast.textContent = text;
    ui.toast.dataset.kind = kind;
    ui.toast.hidden = false;
    ui.toast.classList.remove('show');
    void ui.toast.offsetWidth; // Animation neu starten
    ui.toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      ui.toast.hidden = true;
    }, 2400);
  }

  // Hover-Ton für alle Knöpfe (höchstens alle 70 ms)
  el.addEventListener('pointerover', (e) => {
    const b = e.target.closest?.('button');
    if (!b || b.disabled || b.contains(e.relatedTarget)) return;
    const now = performance.now();
    if (now - state.hoverAt < 70) return;
    state.hoverAt = now;
    audio?.ui?.('hover');
  });

  // --- Oben: Profil, Level, Münzen ------------------------------------------------------------
  function refreshTop() {
    const info = levelInfo(progress.xp);
    ui.nameText.textContent = settings.game.playerName;
    ui.level.textContent = String(info.level);
    ui.xpFill.style.width = `${Math.round(info.fraction * 100)}%`;
    ui.xpText.textContent = info.maxed ? 'MAX' : `${formatNumber(info.xpIntoLevel)} / ${formatNumber(info.xpForNext)} XP`;
    ui.trophies.textContent = formatNumber(progress.trophies);
    for (const c of ui.coins) c.textContent = formatNumber(progress.coins);
    const skin = equippedItems(progress).skin;
    const thumbs = lobby.thumbnails('skins', [skin]);
    ui.avatar.dataset.thumb = `skins:${skin.id}`;
    if (thumbs.get(skin.id)) ui.avatar.src = thumbs.get(skin.id);
  }

  function startRename() {
    click();
    ui.nameBtn.hidden = true;
    ui.nameInput.hidden = false;
    ui.nameInput.value = settings.game.playerName;
    ui.nameInput.focus();
    ui.nameInput.select();
  }
  function finishRename(save) {
    if (ui.nameInput.hidden) return;
    if (save) {
      const name = ui.nameInput.value.replace(/\s+/g, ' ').trim().slice(0, 20) || 'Spieler';
      if (name !== settings.game.playerName) {
        settings.game.playerName = name;
        o.saveSettings?.();
        toast(`Name gespeichert: ${name}`);
      }
    }
    ui.nameInput.hidden = true;
    ui.nameBtn.hidden = false;
    refreshTop();
    ui.nameBtn.focus();
  }
  ui.nameBtn.addEventListener('click', startRename);
  ui.nameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finishRename(true);
    else if (e.key === 'Escape') finishRename(false);
  });
  ui.nameInput.addEventListener('blur', () => finishRename(true));

  ui.gear.addEventListener('click', () => {
    click();
    o.openSettings?.();
  });

  // --- Modus ---------------------------------------------------------------------------------
  function refreshMode() {
    const entry = lobbyModes().find((m) => m.id === state.mode) ?? lobbyModes()[0];
    ui.modeIcon.innerHTML = MODE_ICONS[entry.id] ?? MODE_ICONS.default;
    ui.modeName.textContent = entry.name;
    ui.modeDesc.textContent = entry.description;
  }

  function setMode(id) {
    const entry = lobbyModes().find((m) => m.id === id);
    if (!entry?.available) return false;
    state.mode = id;
    progress.lastMode = id;
    o.saveProgress?.();
    refreshMode();
    return true;
  }

  function openPicker() {
    click();
    ui.pickerGrid.innerHTML = lobbyModes().map((m) => `
      <button class="mode-tile${m.id === state.mode ? ' selected' : ''}${m.available ? '' : ' soon'}" data-mode="${esc(m.id)}"
        ${m.available ? '' : 'aria-disabled="true"'}>
        <span class="tile-icon">${MODE_ICONS[m.id] ?? MODE_ICONS.default}</span>
        <b>${esc(m.name)}</b>
        <em>${esc(m.description)}</em>
        ${m.available ? '' : '<span class="soon-ribbon">bald</span>'}
      </button>`).join('');
    ui.picker.hidden = false;
    focusFirst(ui.picker, '.mode-tile.selected');
  }
  function closePicker() {
    ui.picker.hidden = true;
    ui.modeCard.focus();
  }
  ui.modeCard.addEventListener('click', openPicker);
  ui.pickerGrid.addEventListener('click', (e) => {
    const tile = e.target.closest('.mode-tile');
    if (!tile) return;
    if (tile.classList.contains('soon')) {
      click('back');
      tile.classList.remove('shake');
      void tile.offsetWidth;
      tile.classList.add('shake');
      toast('Dieser Modus kommt bald!');
      return;
    }
    click('confirm');
    setMode(tile.dataset.mode);
    closePicker();
  });
  q('.mode-picker .picker-close').addEventListener('click', () => {
    click('back');
    closePicker();
  });

  // Solo / Duo (Duo braucht Bots – kommt bald)
  ui.soloBtn.addEventListener('click', () => {
    click();
    state.team = 'solo';
  });
  ui.duoBtn.addEventListener('click', () => {
    click('back');
    toast('Duo kommt bald (braucht Bot-Partner).');
  });

  ui.play.addEventListener('click', () => {
    if (!getModeDef(state.mode)) return;
    click('confirm');
    o.onPlay?.(state.mode, { team: state.team });
  });

  // --- Spind und Shop ---------------------------------------------------------------------------
  ui.lockerBtn.addEventListener('click', () => {
    click();
    openCollection('locker');
  });
  ui.shopBtn.addEventListener('click', () => {
    click();
    openCollection('shop');
  });
  ui.colBack.addEventListener('click', () => {
    click('back');
    showLobby();
  });
  ui.colTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-kind]');
    if (!tab) return;
    click();
    state.collectionKind = tab.dataset.kind;
    state.selected = null;
    renderCollection();
    previewEquipped();
  });
  ui.colGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.item-card');
    if (!card) return;
    click();
    const entry = catalog(state.collectionKind).find((x) => x.id === card.dataset.id);
    if (!entry) return;
    state.selected = entry;
    preview(entry);
    renderCollection(false);
  });
  ui.colDetail.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action || !state.selected) return;
    const entry = state.selected;
    if (action === 'equip') {
      click('confirm');
      equipItem(progress, entry.kind, entry.id);
      o.saveProgress?.();
      toast(`${entry.name} ausgerüstet`);
      renderCollection(false);
      refreshTop();
    } else if (action === 'buy') {
      click();
      openConfirm(entry);
    } else if (action === 'toShop') {
      click();
      openCollection('shop', entry);
    } else if (action === 'preview') {
      click();
      preview(entry);
    }
  });

  function openCollection(type, select = null) {
    finishRename(true);
    state.screen = type;
    if (select) state.collectionKind = select.kind;
    state.selected = select;
    ui.lobby.hidden = true;
    ui.collection.hidden = false;
    ui.collection.dataset.type = type;
    ui.colTitle.textContent = type === 'shop' ? 'Shop' : 'Spind';
    lobby.setLayout('side');
    renderCollection();
    if (select) preview(select);
    else previewEquipped();
  }

  function renderCollection(refocus = true) {
    const kind = state.collectionKind;
    const shop = state.screen === 'shop';
    ui.colTabs.querySelectorAll('[data-kind]').forEach((t) => t.classList.toggle('active', t.dataset.kind === kind));
    let entries = catalog(kind);
    // Shop: Ungekauftes zuerst, billig → teuer
    if (shop) entries = [...entries].sort((a, b) => (isOwned(progress, kind, a.id) - isOwned(progress, kind, b.id)) || a.price - b.price);
    const equippedId = progress.equipped[EQUIP_KEY[kind]];
    if (!state.selected || state.selected.kind !== kind) state.selected = entries.find((x) => x.id === equippedId) ?? entries[0];
    const thumbs = kind === 'emotes' ? null : lobby.thumbnails(kind, entries);
    const focusedId = document.activeElement?.closest?.('.item-card')?.dataset.id;
    ui.colGrid.innerHTML = entries.map((x) => {
      const owned = isOwned(progress, kind, x.id);
      const equipped = x.id === equippedId;
      const url = thumbs?.get(x.id);
      const img = thumbs ? `<img ${url ? `src="${url}" ` : ''}data-thumb="${kind}:${esc(x.id)}" alt="">` : `<span class="emote-icon">${ICONS.emote}</span>`;
      const badge = equipped ? `<span class="badge on">${ICONS.check}</span>`
        : owned ? (shop ? '<span class="badge owned">Im Besitz</span>' : '')
          : `<span class="price">${ICONS.lock}<b>${formatNumber(x.price)}</b></span>`;
      return `<button class="item-card tier-${x.tier}${owned ? ' owned' : ' locked'}${state.selected?.id === x.id ? ' selected' : ''}"
        data-id="${esc(x.id)}" style="--tier:${x.color}">
        <span class="thumb">${img}</span>
        <span class="item-name">${esc(x.name)}</span>
        ${badge}
      </button>`;
    }).join('');
    renderDetail();
    for (const c of ui.coins) c.textContent = formatNumber(progress.coins);
    if (refocus) focusFirst(ui.colGrid, '.item-card.selected');
    else if (focusedId) ui.colGrid.querySelector(`[data-id="${CSS.escape(focusedId)}"]`)?.focus();
  }

  function renderDetail() {
    const x = state.selected;
    if (!x) {
      ui.colDetail.innerHTML = '';
      return;
    }
    const owned = isOwned(progress, x.kind, x.id);
    const equipped = progress.equipped[EQUIP_KEY[x.kind]] === x.id;
    const shop = state.screen === 'shop';
    let button;
    if (shop) {
      if (owned) button = `<button class="act act-done" disabled>${ICONS.check} Im Besitz</button>`;
      else {
        const check = canBuy(progress, x.kind, x.id);
        button = `<button class="act act-buy" data-action="buy"${check.ok ? '' : ' disabled'}>${ICONS.coin}<b>${formatNumber(x.price)}</b> Kaufen</button>` +
          (check.reason === 'coins' ? '<span class="detail-warn">Zu wenig Münzen</span>' : '');
      }
    } else if (equipped) button = `<button class="act act-done" disabled>${ICONS.check} Ausgerüstet</button>`;
    else if (owned) button = '<button class="act act-equip" data-action="equip">Ausrüsten</button>';
    else button = `<button class="act act-buy" data-action="toShop">${ICONS.lock} Im Shop · ${formatNumber(x.price)}</button>`;
    const previewBtn = x.kind === 'emotes' ? `<button class="act act-preview" data-action="preview">${ICONS.play} Vorschau</button>` : '';
    ui.colDetail.innerHTML = `
      <div class="detail-info"><span class="tier-tag" style="--tier:${x.color}">${esc(x.tierName)}</span><b>${esc(x.name)}</b>
        <small>${esc(KIND_SINGULAR[x.kind])}</small></div>
      <div class="detail-actions">${previewBtn}${button}</div>`;
  }

  /** Auf dem Podest zeigen (ohne anzuziehen). */
  function preview(entry) {
    const eq = equippedItems(progress);
    if (entry.kind === 'skins') {
      lobby.setSkin(entry.id);
      lobby.setPickaxe(null);
      lobby.faceCamera();
    } else if (entry.kind === 'pickaxes') {
      lobby.setSkin(eq.skin.id);
      lobby.setPickaxe(entry.id);
      lobby.faceCamera();
    } else {
      lobby.setSkin(eq.skin.id);
      lobby.setPickaxe(null);
      lobby.playEmote(emoteMotion(entry.id));
    }
  }

  function previewEquipped() {
    const eq = equippedItems(progress);
    lobby.setSkin(eq.skin.id);
    lobby.setPickaxe(state.screen && state.screen !== 'lobby' && state.collectionKind === 'pickaxes' ? eq.pickaxe.id : null);
  }

  // --- Kaufen bestätigen -------------------------------------------------------------------------
  function openConfirm(entry) {
    state.confirmItem = entry;
    const thumbs = entry.kind === 'emotes' ? null : lobby.thumbnails(entry.kind, [entry]);
    const url = thumbs?.get(entry.id);
    q('.confirm .confirm-thumb').innerHTML = thumbs ? `<img ${url ? `src="${url}" ` : ''}data-thumb="${entry.kind}:${esc(entry.id)}" alt="">` : ICONS.emote;
    q('.confirm .confirm-thumb').style.setProperty('--tier', entry.color);
    q('.confirm .confirm-name').textContent = entry.name;
    q('.confirm .confirm-price b').textContent = formatNumber(entry.price);
    q('.confirm .confirm-after').textContent = `Danach hast du noch ${formatNumber(progress.coins - entry.price)} Münzen.`;
    ui.confirm.hidden = false;
    q('.confirm .confirm-yes').focus();
  }
  function closeConfirm() {
    ui.confirm.hidden = true;
    state.confirmItem = null;
    ui.colDetail.querySelector('button')?.focus();
  }
  q('.confirm .confirm-yes').addEventListener('click', () => {
    const entry = state.confirmItem;
    if (!entry) return;
    const r = buyItem(progress, entry.kind, entry.id);
    if (r.ok) {
      click('confirm');
      equipItem(progress, entry.kind, entry.id);
      o.saveProgress?.();
      toast(`${entry.name} gekauft und ausgerüstet!`, 'good');
    } else {
      click('back');
      toast(r.reason === 'coins' ? 'Zu wenig Münzen.' : 'Kauf nicht möglich.', 'bad');
    }
    closeConfirm();
    renderCollection(false);
    refreshTop();
  });
  q('.confirm .confirm-no').addEventListener('click', () => {
    click('back');
    closeConfirm();
  });

  // --- Bildschirme ---------------------------------------------------------------------------------
  function showLobby() {
    state.screen = 'lobby';
    el.hidden = false;
    ui.lobby.hidden = false;
    ui.collection.hidden = true;
    ui.picker.hidden = true;
    ui.confirm.hidden = true;
    lobby.setVisible(true);
    lobby.setLayout('center');
    previewEquipped();
    refreshTop();
    refreshMode();
    audio?.playMusic?.('menu');
    requestAnimationFrame(() => {
      if (state.screen === 'lobby' && !o.isSettingsOpen?.()) ui.play.focus({ preventScroll: true });
    });
  }

  function hide() {
    finishRename(true);
    state.screen = null;
    el.hidden = true;
    lobby.setVisible(false);
    audio?.stopMusic?.();
  }

  /** Esc / Controller B: eine Ebene zurück. @returns {boolean} etwas geschlossen? */
  function back() {
    if (!ui.confirm.hidden) {
      click('back');
      closeConfirm();
      return true;
    }
    if (!ui.picker.hidden) {
      click('back');
      closePicker();
      return true;
    }
    if (state.screen === 'locker' || state.screen === 'shop') {
      click('back');
      showLobby();
      return true;
    }
    return false;
  }

  // --- Übergang Lobby → Spiel (blaue Blende) ------------------------------------------------------------
  function fade(on) {
    ui.fade.classList.toggle('on', !!on);
  }

  // --- Tastatur und Controller ------------------------------------------------------------------------
  function activeLayer() {
    if (!ui.confirm.hidden) return ui.confirm;
    if (!ui.picker.hidden) return ui.picker;
    if (!ui.collection.hidden) return ui.collection;
    return ui.lobby;
  }

  function focusables(layer) {
    return [...layer.querySelectorAll('button, input')].filter((b) => !b.hidden && b.offsetParent !== null && !b.disabled);
  }

  function focusFirst(layer, preferred) {
    const target = (preferred && layer.querySelector(preferred)) || focusables(layer)[0];
    target?.focus({ preventScroll: true });
  }

  function moveFocus(dir) {
    const layer = activeLayer();
    const list = focusables(layer);
    if (!list.length) return;
    const current = layer.contains(document.activeElement) ? document.activeElement : null;
    if (!current) {
      focusFirst(layer, layer === ui.lobby ? '.play-big' : '.selected');
      return;
    }
    const others = list.filter((b) => b !== current);
    const i = pickNeighbor(current.getBoundingClientRect(), others.map((b) => b.getBoundingClientRect()), dir);
    if (i >= 0) {
      others[i].focus({ preventScroll: true });
      audio?.ui?.('hover');
    }
  }

  const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  window.addEventListener('keydown', (e) => {
    if (el.hidden || o.isSettingsOpen?.() || e.target === ui.nameInput) return;
    if (ARROWS[e.code]) {
      e.preventDefault();
      moveFocus(ARROWS[e.code]);
    } else if (e.code === 'Escape' || e.code === 'Backspace') {
      if (back()) e.preventDefault();
    }
  });

  // Controller im Menü: Steuerkreuz/linker Stick = wählen, A = drücken, B = zurück
  function pollGamepad(now) {
    let pads = [];
    try {
      pads = navigator.getGamepads ? [...navigator.getGamepads()] : [];
    } catch {
      return;
    }
    const pad = pads.find((p) => p && p.connected);
    if (!pad) return;
    const prev = state.pad.buttons;
    const pressed = (i) => !!pad.buttons[i]?.pressed && !prev[i];
    let dir = null;
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    if (pad.buttons[12]?.pressed || ay < -0.6) dir = 'up';
    else if (pad.buttons[13]?.pressed || ay > 0.6) dir = 'down';
    else if (pad.buttons[14]?.pressed || ax < -0.6) dir = 'left';
    else if (pad.buttons[15]?.pressed || ax > 0.6) dir = 'right';
    if (dir && (dir !== state.pad.dir || now >= state.pad.repeatAt)) {
      state.pad.repeatAt = now + (dir !== state.pad.dir ? 380 : 160);
      if (o.isSettingsOpen?.()) o.settingsNavigate?.(dir);
      else moveFocus(dir);
    }
    state.pad.dir = dir;
    if (pressed(0)) {
      const target = document.activeElement;
      if (target && target !== document.body && el.contains(target)) target.click();
      else if (o.isSettingsOpen?.()) o.settingsNavigate?.('press');
      else if (!el.hidden) moveFocus('down');
    }
    if (pressed(1)) {
      if (o.isSettingsOpen?.()) o.settingsNavigate?.('back');
      else back();
    }
    state.pad.buttons = pad.buttons.map((b) => b.pressed);
  }

  function frameUpdate() {
    if (!el.hidden || o.isSettingsOpen?.()) pollGamepad(performance.now());
  }

  return {
    element: el,
    get screen() {
      return state.screen;
    },
    get selectedMode() {
      return state.mode;
    },
    get visible() {
      return !el.hidden;
    },
    showLobby,
    hide,
    back,
    fade,
    toast,
    setMode,
    openPicker,
    openLocker: (select) => openCollection('locker', select),
    openShop: (select) => openCollection('shop', select),
    selectKind(kind) {
      state.collectionKind = kind;
      state.selected = null;
      renderCollection();
      previewEquipped();
    },
    refresh() {
      refreshTop();
      refreshMode();
    },
    frameUpdate,
    moveFocus,
    /** Für Tests: was gerade zu sehen ist. */
    debugState() {
      return {
        screen: state.screen,
        mode: state.mode,
        kind: state.collectionKind,
        selected: state.selected?.id ?? null,
        picker: !ui.picker.hidden,
        confirm: !ui.confirm.hidden,
        name: ui.nameText.textContent,
        coins: progress.coins,
        level: ui.level.textContent,
        focused: document.activeElement?.className ?? null,
      };
    },
  };
}

// -----------------------------------------------------------------------------
// HTML-Gerüst
// -----------------------------------------------------------------------------
function template() {
  return `
  <div class="menu-vignette"></div>
  <section class="mscreen lobby" hidden>
    <header class="lobby-top">
      <div class="profile">
        <div class="profile-avatar"><img alt=""></div>
        <div class="profile-info">
          <button class="name-btn" type="button" title="Namen ändern"><span class="name-text"></span>${ICONS.pencil}</button>
          <input class="name-input" type="text" maxlength="20" spellcheck="false" aria-label="Spielername" hidden>
          <div class="level-row">
            <span class="level-badge" title="Level"><b>1</b></span>
            <span class="xp-bar"><i></i></span>
            <span class="xp-text"></span>
          </div>
        </div>
      </div>
      <div class="top-right">
        <div class="chip chip-trophies" title="Pokale">${ICONS.trophy}<b>0</b></div>
        <div class="chip chip-coins" title="Münzen">${ICONS.coin}<b>0</b></div>
        <button class="icon-btn gear-btn" type="button" aria-label="Einstellungen" title="Einstellungen">${ICONS.gear}</button>
      </div>
    </header>
    <nav class="lobby-left">
      <button class="big-square btn-shop" type="button">${ICONS.shop}<span>Shop</span></button>
      <button class="big-square btn-locker" type="button">${ICONS.locker}<span>Spind</span></button>
    </nav>
    <div class="lobby-play">
      <button class="mode-card" type="button" aria-label="Modus wählen">
        <span class="mode-icon"></span>
        <span class="mode-text"><small>Modus</small><b class="mode-name"></b><em class="mode-desc"></em></span>
        <span class="mode-change">${ICONS.swap}<small>Ändern</small></span>
      </button>
      <div class="play-row">
        <div class="team-toggle" role="group" aria-label="Team-Größe">
          <button class="team-solo on" type="button">${ICONS.solo}<span>Solo</span></button>
          <button class="team-duo off" type="button" title="Duo kommt bald" aria-disabled="true">${ICONS.duo}<span>Duo</span><small>bald</small></button>
        </div>
        <button class="play-big" type="button"><span>Spielen</span></button>
      </div>
    </div>
    <div class="lobby-hint">Ziehen: Figur drehen · Pfeile/Controller: wählen</div>
  </section>

  <section class="mscreen collection" hidden>
    <header class="col-head">
      <button class="col-back icon-btn" type="button" aria-label="Zurück">${ICONS.back}</button>
      <h1 class="col-title">Spind</h1>
      <div class="chip chip-coins" title="Münzen">${ICONS.coin}<b>0</b></div>
    </header>
    <div class="col-panel">
      <div class="col-tabs" role="tablist">
        <button type="button" data-kind="skins">${ICONS.skin}<span>Skins</span></button>
        <button type="button" data-kind="pickaxes">${ICONS.pickaxe}<span>Spitzhacken</span></button>
        <button type="button" data-kind="emotes">${ICONS.emote}<span>Emotes</span></button>
      </div>
      <div class="col-grid"></div>
      <div class="col-detail"></div>
    </div>
  </section>

  <div class="mmodal mode-picker" hidden>
    <div class="modal-card picker-card">
      <header><h2>Modus wählen</h2><button class="icon-btn picker-close" type="button" aria-label="Schließen">${ICONS.close}</button></header>
      <div class="picker-grid"></div>
    </div>
  </div>

  <div class="mmodal confirm" hidden>
    <div class="modal-card confirm-card">
      <h2>Kaufen?</h2>
      <div class="confirm-thumb"></div>
      <b class="confirm-name"></b>
      <div class="confirm-price">${ICONS.coin}<b>0</b></div>
      <small class="confirm-after"></small>
      <div class="confirm-actions">
        <button class="confirm-no act" type="button">Abbrechen</button>
        <button class="confirm-yes act act-buy" type="button">Kaufen</button>
      </div>
    </div>
  </div>

  <div class="mtoast" role="status" aria-live="polite" hidden></div>`;
}
