'use strict';

/**
 * Loads the editable text profiles in profiles/.
 *
 * These are plain text on purpose: the bloat lists are the part of this tool
 * most likely to need a five-second edit while a tablet is sitting on the desk,
 * and that should not require rebuilding an Electron app.
 */

const fs = require('node:fs');
const path = require('node:path');

/** profiles/ ships as an extraResource, so it moves when the app is packaged. */
function profilesDir() {
  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, 'profiles')
    : null;
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'profiles');
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * @returns {Array<{scope:string, key:string, value:string}>}
 */
function loadSettings() {
  const out = [];
  for (const line of readLines(path.join(profilesDir(), 'settings.txt'))) {
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [scope, key, value] = parts;
    if (!['global', 'system', 'secure'].includes(scope)) continue;
    out.push({ scope, key, value });
  }
  return out;
}

/** @returns {Set<string>} packages that must never be disabled. */
function loadProtected() {
  return new Set(readLines(path.join(profilesDir(), 'protected.txt')));
}

/**
 * Bloat candidates for a manufacturer. `common` always applies; the OEM file is
 * added when it exists. A leading "!" marks an entry aggressive-tier.
 *
 * @param {string} manufacturer ro.product.manufacturer, any casing
 * @returns {{safe:string[], aggressive:string[], sources:string[]}}
 */
function loadBloat(manufacturer) {
  const dir = path.join(profilesDir(), 'bloat');
  const oem = String(manufacturer || '').toLowerCase().trim();

  const files = ['common.txt'];
  if (oem && fs.existsSync(path.join(dir, `${oem}.txt`))) files.push(`${oem}.txt`);

  const safe = new Set();
  const aggressive = new Set();
  const sources = [];

  for (const file of files) {
    const lines = readLines(path.join(dir, file));
    if (lines.length === 0) continue;
    sources.push(file);
    for (const line of lines) {
      if (line.startsWith('!')) {
        const pkg = line.slice(1).trim();
        if (pkg) aggressive.add(pkg);
      } else {
        safe.add(line);
      }
    }
  }

  return { safe: [...safe], aggressive: [...aggressive], sources };
}

/** OEM profiles that exist on disk, for the UI to report what it matched. */
function availableOems() {
  const dir = path.join(profilesDir(), 'bloat');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.txt') && f !== 'common.txt')
    .map((f) => f.replace(/\.txt$/, ''));
}

module.exports = { profilesDir, loadSettings, loadProtected, loadBloat, availableOems };
