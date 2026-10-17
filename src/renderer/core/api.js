// Access to the main process (window.phoenix from preload) with a browser mock fallback.
import { createMockApi } from './mock-api.js';

const raw = typeof window !== 'undefined' && window.phoenix ? window.phoenix : createMockApi();

/** True when running without Electron (Vite dev server, screenshots). */
export const isBrowserMock = !(typeof window !== 'undefined' && window.phoenix);

const PREFIX = /^Error invoking remote method '[^']+':\s*(Error:\s*)?/;

/** Turns IPC rejections into clean German messages. */
export function errorMessage(err) {
  const msg = (err && err.message) || String(err || 'Unbekannter Fehler');
  return msg.replace(PREFIX, '');
}

function wrap(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'function') {
      out[key] = async (...args) => {
        try {
          return await value(...args);
        } catch (err) {
          throw new Error(errorMessage(err));
        }
      };
    } else if (value && typeof value === 'object') {
      out[key] = wrap(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export const api = { ...wrap(raw), on: (channel, cb) => raw.on(channel, cb) };
