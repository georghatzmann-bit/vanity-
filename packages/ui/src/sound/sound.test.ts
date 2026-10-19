import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PreferenceModule = typeof import('./preference.ts');
type SynthModule = typeof import('./synth.ts');

/** Frische Modul-Instanzen je Test (Modulzustand: Speicher-Rückfall, geteilte Instanz). */
async function loadModules(): Promise<{ preference: PreferenceModule; synth: SynthModule }> {
  vi.resetModules();
  const preference = await import('./preference.ts');
  const synth = await import('./synth.ts');
  return { preference, synth };
}

interface FakeAudio {
  readonly instances: FakeAudioContext[];
  readonly Ctor: new () => FakeAudioContext;
}

class FakeParam {
  value = 0;
  setValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}

class FakeNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeOscillator extends FakeNode {
  type: OscillatorType = 'sine';
  frequency = new FakeParam();
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeFilter extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  frequency = new FakeParam();
}

class FakeAudioContext {
  state: AudioContextState = 'running';
  currentTime = 1;
  destination = new FakeNode();
  oscillators: FakeOscillator[] = [];
  resume = vi.fn(() => Promise.resolve());
  createOscillator = vi.fn(() => {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  });
  createGain = vi.fn(() => new FakeGain());
  createBiquadFilter = vi.fn(() => new FakeFilter());
}

function installFakeAudio(state: AudioContextState = 'running'): FakeAudio {
  const instances: FakeAudioContext[] = [];
  class Ctor extends FakeAudioContext {
    constructor() {
      super();
      this.state = state;
      instances.push(this);
    }
  }
  vi.stubGlobal('AudioContext', Ctor);
  return { instances, Ctor };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Klang-Einstellung', () => {
  it('ist ohne gespeicherte Wahl eingeschaltet und wird unter „aegis.sound“ gespeichert', async () => {
    const { preference } = await loadModules();
    expect(preference.SOUND_STORAGE_KEY).toBe('aegis.sound');
    expect(preference.isSoundEnabled()).toBe(true);
    preference.setSoundEnabled(false);
    expect(localStorage.getItem('aegis.sound')).toBe('off');
    expect(preference.isSoundEnabled()).toBe(false);
    preference.setSoundEnabled(true);
    expect(localStorage.getItem('aegis.sound')).toBe('on');
    expect(preference.isSoundEnabled()).toBe(true);
  });

  it('liest eine vorhandene Wahl und ignoriert unbekannte Werte', async () => {
    localStorage.setItem('aegis.sound', 'off');
    const { preference } = await loadModules();
    expect(preference.isSoundEnabled()).toBe(false);
    localStorage.setItem('aegis.sound', 'kaputt');
    expect(preference.isSoundEnabled()).toBe(true);
  });

  it('übersteht gesperrten Speicher (Lesen und Schreiben werfen) und merkt sich die Wahl im Speicher', async () => {
    const { preference } = await loadModules();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('gesperrt', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('voll', 'QuotaExceededError');
    });
    expect(preference.isSoundEnabled()).toBe(true);
    expect(() => preference.setSoundEnabled(false)).not.toThrow();
    expect(preference.isSoundEnabled()).toBe(false);
  });

  it('übersteht fehlerhaftes Schreiben bei funktionierendem Lesen', async () => {
    localStorage.setItem('aegis.sound', 'on');
    const { preference } = await loadModules();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('voll', 'QuotaExceededError');
    });
    preference.setSoundEnabled(false);
    // Die Sitzungs-Wahl gewinnt gegen den veralteten gespeicherten Wert.
    expect(preference.isSoundEnabled()).toBe(false);
  });

  it('benachrichtigt Abonnenten und den React-Hook (auch über storage-Ereignisse)', async () => {
    const { preference } = await loadModules();
    const listener = vi.fn();
    const unsubscribe = preference.subscribeSoundEnabled(listener);
    preference.setSoundEnabled(false);
    expect(listener).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: 'aegis.sound' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'anderes' }));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    preference.setSoundEnabled(true);
    expect(listener).toHaveBeenCalledTimes(2);

    const { result } = renderHook(() => preference.useSoundEnabled());
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
  });
});

describe('UI-Synthesizer', () => {
  it('wirft nicht, wenn WebAudio fehlt', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    const { synth } = await loadModules();
    const sound = synth.createUiSound();
    expect(() => {
      sound.bootChime();
      sound.click();
      sound.alert();
    }).not.toThrow();
  });

  it('erzeugt den AudioContext erst beim ersten Klang und spielt leise Töne', async () => {
    const audio = installFakeAudio();
    const { synth } = await loadModules();
    const sound = synth.createUiSound({ volume: 0.5 });
    expect(audio.instances).toHaveLength(0);
    sound.bootChime();
    sound.click();
    sound.alert();
    expect(audio.instances).toHaveLength(1);
    const context = audio.instances[0];
    expect(context?.oscillators.length).toBe(4 + 1 + 2);
    for (const oscillator of context?.oscillators ?? []) {
      expect(oscillator.start).toHaveBeenCalledTimes(1);
      expect(oscillator.stop).toHaveBeenCalledTimes(1);
      oscillator.onended?.();
      expect(oscillator.disconnect).toHaveBeenCalled();
    }
  });

  it('bleibt still, wenn Klänge global ausgeschaltet sind', async () => {
    const audio = installFakeAudio();
    const { preference, synth } = await loadModules();
    preference.setSoundEnabled(false);
    synth.createUiSound().bootChime();
    expect(audio.instances).toHaveLength(0);
  });

  it('respektiert einen eigenen Schalter', async () => {
    const audio = installFakeAudio();
    const { synth } = await loadModules();
    synth.createUiSound({ isEnabled: () => false }).click();
    expect(audio.instances).toHaveLength(0);
  });

  it('holt bei Autoplay-Sperre nichts nach, stößt nur das Fortsetzen an', async () => {
    const audio = installFakeAudio('suspended');
    const { synth } = await loadModules();
    const sound = synth.createUiSound();
    sound.bootChime();
    const context = audio.instances[0];
    expect(context?.resume).toHaveBeenCalledTimes(1);
    expect(context?.createOscillator).not.toHaveBeenCalled();
  });

  it('schluckt abgelehntes Fortsetzen und geschlossene Kontexte still', async () => {
    const audio = installFakeAudio('suspended');
    const { synth } = await loadModules();
    const sound = synth.createUiSound();
    sound.click();
    const context = audio.instances[0];
    context?.resume.mockImplementation(() => Promise.reject(new Error('nicht erlaubt')));
    expect(() => sound.click()).not.toThrow();
    if (context) {
      context.state = 'closed';
    }
    sound.click();
    expect(context?.createOscillator).not.toHaveBeenCalled();
    await Promise.resolve();
  });

  it('bleibt still, wenn der AudioContext-Konstruktor wirft (z. B. Richtlinie)', async () => {
    let attempts = 0;
    // Klassische Konstruktorfunktion: wird mit `new` aufgerufen und wirft.
    function ThrowingAudioContext(): never {
      attempts += 1;
      throw new Error('nicht erlaubt');
    }
    vi.stubGlobal('AudioContext', ThrowingAudioContext);
    const { synth } = await loadModules();
    const sound = synth.createUiSound();
    expect(() => sound.bootChime()).not.toThrow();
    expect(() => sound.click()).not.toThrow();
    // Nach dem ersten Fehlschlag kein erneuter Versuch.
    expect(attempts).toBe(1);
  });

  it('nutzt webkitAudioContext als Rückfall und teilt eine gemeinsame Instanz', async () => {
    const audio = installFakeAudio();
    vi.stubGlobal('webkitAudioContext', audio.Ctor);
    vi.stubGlobal('AudioContext', undefined);
    const { synth } = await loadModules();
    expect(synth.getUiSound()).toBe(synth.getUiSound());
    synth.getUiSound().click();
    expect(audio.instances).toHaveLength(1);
  });
});
