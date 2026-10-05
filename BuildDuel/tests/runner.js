// =============================================================================
// Mini-Testsystem für den Browser
// =============================================================================
// Benutzung in einer Test-Datei:
//
//   import { describe, it, assert } from './runner.js';
//   describe('Material', () => {
//     it('kostet 10 pro Bauteil', () => {
//       assert.equal(CONFIG.materials.costPerPiece, 10);
//     });
//   });
//
// tests.html führt alle Tests aus und zeigt sie grün (ok) oder rot (Fehler).
// =============================================================================

const groups = [];
let currentGroup = null;

/** Fasst Tests zu einer Gruppe mit Überschrift zusammen. */
export function describe(name, fn) {
  const group = { name, tests: [] };
  groups.push(group);
  const previous = currentGroup;
  currentGroup = group;
  try {
    fn();
  } finally {
    currentGroup = previous;
  }
}

/** Ein einzelner Test. Wirft er einen Fehler, ist er rot. */
export function it(name, fn) {
  if (!currentGroup) describe('Allgemein', () => {});
  (currentGroup ?? groups[groups.length - 1]).tests.push({ name, fn });
}

class AssertionError extends Error {}

function show(value) {
  try {
    return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Prüf-Funktionen. Jede wirft einen Fehler mit Erklärung, wenn etwas nicht stimmt. */
export const assert = {
  ok(value, message = 'Wert sollte wahr sein') {
    if (!value) throw new AssertionError(`${message} (ist: ${show(value)})`);
  },
  equal(actual, expected, message = 'Werte sollten gleich sein') {
    if (actual !== expected) {
      throw new AssertionError(`${message}: erwartet ${show(expected)}, ist ${show(actual)}`);
    }
  },
  close(actual, expected, tolerance = 1e-6, message = 'Zahlen sollten fast gleich sein') {
    if (!(Math.abs(actual - expected) <= tolerance)) {
      throw new AssertionError(
        `${message}: erwartet ${expected} (± ${tolerance}), ist ${actual}`,
      );
    }
  },
  deepEqual(actual, expected, message = 'Inhalte sollten gleich sein') {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new AssertionError(`${message}: erwartet ${show(expected)}, ist ${show(actual)}`);
    }
  },
  throws(fn, message = 'Hätte einen Fehler werfen sollen') {
    try {
      fn();
    } catch {
      return;
    }
    throw new AssertionError(message);
  },
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/**
 * Führt alle Tests aus und zeigt das Ergebnis an.
 * Das Ergebnis steht danach auch in window.__TEST_RESULTS__ (für automatische Prüfungen).
 * @param {HTMLElement} output
 */
export async function run(output) {
  let passed = 0;
  let failed = 0;
  const failures = [];
  let html = '';

  for (const group of groups) {
    let rows = '';
    let groupFailed = 0;
    for (const test of group.tests) {
      try {
        await test.fn();
        passed++;
        rows += `<li class="test ok"><span class="badge">OK</span>${escapeHtml(test.name)}</li>`;
      } catch (error) {
        failed++;
        groupFailed++;
        const message = error && error.message ? error.message : String(error);
        failures.push({ group: group.name, test: test.name, message });
        rows += `<li class="test fail"><span class="badge">FEHLER</span>${escapeHtml(test.name)}` +
          `<div class="why">${escapeHtml(message)}</div></li>`;
        console.error(`[Test] ${group.name} › ${test.name}:`, error);
      }
    }
    const status = groupFailed ? 'fail' : 'ok';
    html += `<section class="group ${status}"><h2>${escapeHtml(group.name)}</h2><ul>${rows}</ul></section>`;
  }

  const total = passed + failed;
  const summaryClass = failed ? 'fail' : 'ok';
  const summaryText = failed
    ? `${failed} von ${total} Tests fehlgeschlagen`
    : `Alle ${total} Tests bestanden`;
  output.innerHTML = `<div class="summary ${summaryClass}">${summaryText}</div>${html}`;
  document.title = `${failed ? 'FEHLER' : 'OK'} – ${summaryText}`;

  const results = { passed, failed, total, failures, done: true };
  window.__TEST_RESULTS__ = results;
  return results;
}
