// Tests für den Ton (src/audio/sfx.js): Begrenzung gleichzeitiger Töne (reine Logik),
// Wichtigkeit, alle geforderten Geräusche vorhanden, Attrappe ohne Bildschirm.
import { describe, it, assert } from './runner.js';
import { CONFIG } from '../src/config.js';
import { VoiceLimiter, soundPriority, SOUND_NAMES, createAudio } from '../src/audio/sfx.js';

describe('Ton: Begrenzung gleichzeitiger Töne', () => {
  it('20 Bots schießen gleichzeitig: nie mehr als die erlaubte Zahl', () => {
    const limiter = new VoiceLimiter(32, { shot: 10 }, 4);
    let played = 0;
    for (let i = 0; i < 200; i++) {
      const slot = limiter.acquire('shot', 1, i * 0.005, 0.1);
      if (slot >= 0) played++;
      assert.ok(limiter.count(i * 0.005, 'shot') <= 10, `zu viele Schüsse bei ${i}`);
      assert.ok(limiter.count(i * 0.005) <= 32);
    }
    assert.ok(played > 10, 'ältere Schüsse werden durch neue ersetzt');
  });

  it('volle Art: gleich wichtig ersetzt den ältesten, weniger wichtig wird weggelassen', () => {
    const limiter = new VoiceLimiter(8, { shot: 2 }, 4);
    assert.equal(limiter.acquire('shot', 2, 0, 1, 'a'), 0);
    assert.equal(limiter.acquire('shot', 2, 0.1, 1, 'b'), 1);
    assert.equal(limiter.acquire('shot', 1, 0.2, 1, 'c'), -1, 'leiser, ferner Schuss fällt weg');
    assert.equal(limiter.stolen, null);
    assert.equal(limiter.acquire('shot', 2, 0.3, 1, 'd'), 0, 'ersetzt den ältesten');
    assert.equal(limiter.stolen, 'a');
    assert.equal(limiter.acquire('shot', 3, 0.4, 1, 'e'), 1, 'eigener Schuss ersetzt');
    assert.equal(limiter.stolen, 'b');
  });

  it('alles voll: nur ein mindestens gleich wichtiger Ton ersetzt den schwächsten', () => {
    const limiter = new VoiceLimiter(3, {}, 3);
    limiter.acquire('a', 2, 0, 1, 'a1');
    limiter.acquire('b', 1, 0.1, 1, 'b1');
    limiter.acquire('c', 2, 0.2, 1, 'c1');
    assert.equal(limiter.acquire('d', 0, 0.3, 1), -1);
    const slot = limiter.acquire('d', 1, 0.3, 1, 'd1');
    assert.ok(slot >= 0);
    assert.equal(limiter.stolen, 'b1', 'der unwichtigste Ton wurde ersetzt');
    assert.equal(limiter.count(0.3), 3);
  });

  it('abgelaufene Töne machen Platz', () => {
    const limiter = new VoiceLimiter(2, {}, 2);
    limiter.acquire('x', 1, 0, 0.5);
    limiter.acquire('x', 1, 0, 0.5);
    assert.equal(limiter.count(0.4), 2);
    assert.equal(limiter.count(0.6), 0);
    assert.ok(limiter.acquire('x', 0, 0.6, 0.5) >= 0, 'freier Platz auch für unwichtige Töne');
    assert.equal(limiter.stolen, null);
    limiter.clear();
    assert.equal(limiter.count(0.6), 0);
  });

  it('Art mit Grenze 0 spielt nie', () => {
    const limiter = new VoiceLimiter(4, { stumm: 0 }, 2);
    assert.equal(limiter.acquire('stumm', 3, 0, 1), -1);
  });

  it('Wichtigkeit: eigene Töne vor nahen vor fernen', () => {
    assert.equal(soundPriority(true, 100), 3);
    assert.equal(soundPriority(false, 10), 2);
    assert.equal(soundPriority(false, 60), 1);
  });

  it('Standard-Werte aus config.js', () => {
    const limiter = new VoiceLimiter();
    assert.equal(limiter.max, CONFIG.audio.maxVoices);
    assert.equal(limiter.capFor('shot'), CONFIG.audio.voicesPerType.shot);
    assert.equal(limiter.capFor('gibtsnicht'), CONFIG.audio.defaultVoicesPerType);
  });
});

describe('Ton: alle Geräusche aus dem Plan', () => {
  it('jedes geforderte Geräusch hat ein Rezept', () => {
    const needed = [
      'footstep_grass', 'footstep_wood', 'footstep_stone', 'footstep_metal', 'jump', 'land',
      'place_wood', 'place_stone', 'place_metal', 'destroy',
      'shotgun', 'ar', 'smg', 'pistol', 'sniper', 'grenadeLauncher', 'explosion',
      'reload_start', 'reload_end', 'hit', 'hit_head', 'hit_kill', 'shield_break',
      'fanfare', 'defeat', 'pickaxe_swing', 'pickaxe_hit', 'harvest_wood', 'harvest_stone', 'harvest_metal',
      'heal_start', 'heal_done_health', 'heal_done_shield', 'ui_click',
    ];
    for (const name of needed) assert.ok(SOUND_NAMES.includes(name), name);
  });

  it('jede Waffe hat einen Schuss-Ton', () => {
    for (const id of ['shotgun', 'ar', 'smg', 'sniper', 'pistol', 'grenadeLauncher']) assert.ok(SOUND_NAMES.includes(id), id);
  });

  it('ohne Bildschirm: stille Attrappe mit allen Methoden', () => {
    const audio = createAudio({ headless: true });
    assert.equal(audio.enabled, false);
    audio.setVolumes({ audio: { master: 0.5, effects: 0.5, music: 0.5 } });
    audio.frameUpdate();
    audio.ui('click');
    audio.playMusic('menu');
    audio.stopMusic();
    assert.equal(audio.play('ar'), false);
    assert.equal(audio.debug.activeVoices(), 0);
    audio.dispose();
  });
});
