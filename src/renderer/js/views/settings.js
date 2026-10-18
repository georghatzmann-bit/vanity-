// Einstellungen von HELIX selbst: Sound, Intro, Leichtlauf, Fortnite-Ordner, Datenordner.

import { sfx } from '../sound.js';

export default {
  async mount(root, env) {
    const { h, icon } = env.ui;
    const ui = env.ui;
    const s = await env.call('app.settings');
    const info = await env.call('app.info').catch(() => ({}));
    const st = await env.call('core.status').catch(() => null);

    const save = async (patch) => {
      try { Object.assign(s, await env.call('app.setSettings', { patch })); } catch (e) { ui.showError(e); }
    };

    const volume = h('input.range', { type: 'range', min: 0, max: 100, value: Math.round((s.volume ?? 0.7) * 100), 'aria-label': 'Lautstärke' });
    volume.addEventListener('change', async () => { await save({ volume: Number(volume.value) / 100 }); sfx('success'); });

    root.append(
      ui.section('Klang & Bewegung', 'Wie sich HELIX anhört und anfühlt.',
        ui.toggle({ label: 'Sound', hint: 'Klänge für Intro, Übergänge und Bestätigungen.', checked: s.sound, onChange: (v) => save({ sound: v }) }),
        h('div.field.inline', h('label', icon('volume', 16), ' Lautstärke'), volume),
        ui.toggle({ label: 'Intro beim Start zeigen', hint: 'Der kurze Kosmos-Clip beim Öffnen. Mit Klick oder Taste überspringbar.', checked: s.intro, onChange: (v) => save({ intro: v }) }),
        ui.toggle({ label: 'Ruhige Übergänge', hint: 'Statt der Energie-Clips nur kurz überblenden.', checked: s.reduceMotion, onChange: (v) => save({ reduceMotion: v }) }),
        ui.toggle({ label: 'Leichtlauf beim Spielen', hint: 'Hält die Hintergrund-Videos an, solange Fortnite läuft. Spart Grafikleistung.', checked: s.lightWhilePlaying, onChange: (v) => save({ lightWhilePlaying: v }) })),
      ui.section('Fortnite-Ordner', 'HELIX sucht den Ordner selbst. Nur wenn er nicht gefunden wird, wählst du ihn hier.',
        h('div.path-line', icon('folder', 16), h('span.mono', st?.location?.configDir || 'nicht gefunden'),
          st?.location?.found ? ui.badge(st.location.source === 'manual' ? 'selbst gewählt' : 'automatisch', 'ok') : ui.badge('fehlt', 'err')),
        h('div.row',
          ui.button('Ordner auswählen', { iconName: 'folder', onClick: async () => { try { const r = await env.call('core.pickFolder'); if (!r.canceled) { ui.toast('Ordner übernommen.'); env.nav.home(); } } catch (e) { ui.showError(e); } } }),
          ui.button('Automatisch suchen', { iconName: 'refresh', onClick: async () => { await env.call('core.resetFolder').catch(ui.showError); ui.toast('Suche zurückgesetzt.'); env.refreshStatus(); } }))),
      ui.section('Deine Daten', 'Profile, Sicherungen und Verlauf liegen nur auf deinem PC.',
        h('div.path-line', icon('folder', 16), h('span.mono', info.dataDir || '–')),
        h('div.row',
          ui.button('Datenordner öffnen', { iconName: 'folder', onClick: () => env.call('core.openFolder', { which: 'data' }).catch(ui.showError) }))),
      ui.section('Über HELIX', null,
        h('p', `HELIX ${info.version || ''} – dein Fortnite-Tuning-Cockpit.`),
        h('p.hint', 'HELIX arbeitet nur mit lokalen Dateien und normalen Windows-Funktionen. Es liest oder verändert keinen Spielspeicher, fasst keine Anti-Cheat-Software, keine Hardware-IDs und keine Login-Daten an und blendet nichts im Spiel ein. Kein offizielles Programm von Epic Games.'),
        h('p.hint', 'Intro, Hintergrund, Übergänge und Planeten wurden mit Higgsfield gerendert.')),
    );
  },
};
