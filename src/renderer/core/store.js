// Tiny reactive store + persisted settings.
//
//   store.get()                       -> whole state
//   store.get('scan')                 -> one slot
//   store.set('scan', result)         -> replace a slot
//   store.patch('settings', { sound: false })  -> shallow-merge into an object slot
//   store.patch({ machine, scan })    -> shallow-merge several top-level slots
//   store.update('selection', (s) => new Set(s).add(key))
//   const off = store.subscribe((s) => s.settings.effects, (now, prev) => ..., { immediate: true })
//   const off = store.subscribe((state, changedKeys) => ...)   // every change

const SETTINGS_KEY = 'phoenix.settings.v1';
export const EFFECT_LEVELS = ['ultra', 'high', 'low', 'off'];
export const DEFAULT_SETTINGS = Object.freeze({ effects: 'ultra', sound: true, volume: 0.6 });

function sanitizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    if (EFFECT_LEVELS.includes(raw.effects)) s.effects = raw.effects;
    if (typeof raw.sound === 'boolean') s.sound = raw.sound;
    const v = Number(raw.volume);
    if (Number.isFinite(v)) s.volume = Math.min(1, Math.max(0, v));
  }
  return s;
}

export function loadSettings() {
  try {
    return sanitizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)));
  } catch {
    /* storage unavailable – settings live for this session only */
  }
}

export function createStore(initial) {
  let state = { ...initial };
  const subs = new Set();
  let persistSettings = true;

  function notify(changed) {
    for (const sub of [...subs]) {
      try {
        sub(state, changed);
      } catch (err) {
        console.error('[store] subscriber failed', err);
      }
    }
  }

  function commit(next, changed) {
    if (!changed.length) return;
    state = next;
    if (changed.includes('settings') && persistSettings) saveSettings(state.settings);
    notify(changed);
  }

  const api = {
    get(key) {
      return key === undefined ? state : state[key];
    },

    set(key, value) {
      if (Object.is(state[key], value)) return;
      if (key === 'settings') value = sanitizeSettings(value);
      commit({ ...state, [key]: value }, [key]);
    },

    patch(keyOrObj, partial) {
      if (typeof keyOrObj === 'string') {
        const prev = state[keyOrObj];
        let value = { ...(prev && typeof prev === 'object' ? prev : {}), ...partial };
        if (keyOrObj === 'settings') value = sanitizeSettings(value);
        const differs = !prev || Object.keys(value).some((k) => !Object.is(prev[k], value[k]));
        if (differs) commit({ ...state, [keyOrObj]: value }, [keyOrObj]);
        return;
      }
      const changed = Object.keys(keyOrObj).filter((k) => !Object.is(state[k], keyOrObj[k]));
      commit({ ...state, ...keyOrObj }, changed);
    },

    update(key, fn) {
      api.set(key, fn(state[key]));
    },

    subscribe(selectorOrFn, cb, { immediate = false } = {}) {
      let sub;
      if (typeof cb === 'function') {
        let prev = selectorOrFn(state);
        sub = (s) => {
          const next = selectorOrFn(s);
          if (Object.is(next, prev)) return;
          const old = prev;
          prev = next;
          cb(next, old);
        };
        if (immediate) cb(prev, undefined);
      } else {
        sub = selectorOrFn;
        if (immediate) sub(state, []);
      }
      subs.add(sub);
      return () => subs.delete(sub);
    },

    /** URL overrides (?effects=low) should not be written to disk. */
    setPersistSettings(on) {
      persistSettings = !!on;
    },
  };
  return api;
}

export const store = createStore({
  settings: loadSettings(),
  appInfo: null, //  { version, firstRun, isPackaged, mock }
  machine: null, //  MachineInfo
  scan: null, //     ScanResult
  profile: null, //  Profile
  selection: new Set(), // Set<'source:id'>
  installJob: null, // { jobId, items, results, summary, ... } owned by install screen
  games: null, //    GameEntry[] (+ launcher state)
});

// ---- Convenience helpers for the selection Set (always replaces the Set so subscribers fire) ----
export const selection = {
  has: (key) => store.get('selection').has(key),
  toggle(key, force) {
    store.update('selection', (prev) => {
      const next = new Set(prev);
      const on = force === undefined ? !next.has(key) : !!force;
      on ? next.add(key) : next.delete(key);
      return next;
    });
  },
  setAll(keys) {
    store.set('selection', new Set(keys));
  },
  add(keys) {
    store.update('selection', (prev) => new Set([...prev, ...keys]));
  },
  remove(keys) {
    const drop = new Set(keys);
    store.update('selection', (prev) => new Set([...prev].filter((k) => !drop.has(k))));
  },
  clear() {
    store.set('selection', new Set());
  },
  get size() {
    return store.get('selection').size;
  },
};

export const settings = {
  get: () => store.get('settings'),
  set: (partial) => store.patch('settings', partial),
};
