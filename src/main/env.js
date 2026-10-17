'use strict';
// Runtime flags shared by all main-process modules.
const MOCK = process.platform !== 'win32' || process.env.PHOENIX_MOCK === '1';

module.exports = { MOCK };
