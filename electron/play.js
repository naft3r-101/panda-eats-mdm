'use strict';

/**
 * What Google Play is currently serving for the order app.
 *
 * "Is this tablet up to date" needs a source of truth for "up to date", and
 * Play is the only one: the backend knows the MINIMUM version it will still
 * talk to, not the latest. The Play Developer API answers from the production
 * track, authenticated with the same service account the order app's Gradle
 * publish uses - the key file sits in that repo, gitignored, on the bench PC.
 *
 * No dependency: the JWT is signed with node:crypto and the two API calls are
 * plain fetch. The key is read, signed with, and never logged or returned.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const CACHE_MS = 10 * 60 * 1000;

const cache = new Map();

/** Where the service-account key may be. First hit wins. */
function keyCandidates() {
  const out = [];
  if (process.env.PANDA_BENCH_PLAY_KEY) out.push(process.env.PANDA_BENCH_PLAY_KEY);
  out.push(path.join(__dirname, '..', '..', 'panda-eats-orderapp-kotlin', 'play-api-key.json'));
  return out;
}

function findKey() {
  for (const candidate of keyCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // unreadable path, keep looking
    }
  }
  return null;
}

const base64url = (input) =>
  Buffer.from(input)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

async function accessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: key.token_uri, iat: now, exp: now + 3600 })
  );
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), key.private_key);
  const assertion = `${header}.${claims}.${base64url(signature)}`;

  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`Google refused the service account: ${res.status}`);
  const body = await res.json();
  if (!body.access_token) throw new Error('Google returned no access token');
  return body.access_token;
}

/**
 * The highest version code Play is serving to everyone from a track
 * response, and the release it belongs to. Pure, so it is testable.
 *
 * A release still rolling out (inProgress) counts: a tablet that has not got
 * it yet is about to. A halted or draft one does not.
 */
function pickLatest(track) {
  let best = null;
  for (const release of (track && track.releases) || []) {
    if (!['completed', 'inProgress'].includes(release.status)) continue;
    for (const code of release.versionCodes || []) {
      const n = Number(code);
      if (!Number.isFinite(n)) continue;
      if (!best || n > best.versionCode) {
        best = { versionCode: n, versionName: release.name || null, status: release.status };
      }
    }
  }
  return best;
}

/**
 * @returns {Promise<{versionCode:number, versionName:string|null, status:string, source:string}|{error:string, source:string|null}>}
 */
async function latestProductionVersionCode(packageName) {
  const cached = cache.get(packageName);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const value = await lookup(packageName);
  cache.set(packageName, { at: Date.now(), value });
  return value;
}

async function lookup(packageName) {
  const keyPath = findKey();
  if (!keyPath) {
    return { error: `No Play service-account key found. Looked for ${keyCandidates().join(' and ')}.`, source: null };
  }

  let key;
  try {
    key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  } catch {
    return { error: `Could not read the Play service-account key at ${keyPath}.`, source: keyPath };
  }
  if (!key.client_email || !key.private_key || !key.token_uri) {
    return { error: `${keyPath} is not a Google service-account key.`, source: keyPath };
  }

  try {
    const token = await accessToken(key);
    const headers = { Authorization: `Bearer ${token}` };

    // Track reads hang off an edit. Create one, read, throw it away.
    const created = await fetch(`${API}/${packageName}/edits`, { method: 'POST', headers, body: '{}' });
    if (!created.ok) throw new Error(`Play refused to open an edit: ${created.status} ${await created.text()}`);
    const edit = await created.json();

    try {
      const res = await fetch(`${API}/${packageName}/edits/${edit.id}/tracks/production`, { headers });
      if (!res.ok) throw new Error(`Play refused the production track: ${res.status} ${await res.text()}`);
      const latest = pickLatest(await res.json());
      if (!latest) return { error: 'The production track has no live release.', source: keyPath };
      return { ...latest, source: keyPath };
    } finally {
      await fetch(`${API}/${packageName}/edits/${edit.id}`, { method: 'DELETE', headers }).catch(() => {});
    }
  } catch (err) {
    return { error: err.message, source: keyPath };
  }
}

module.exports = { latestProductionVersionCode, pickLatest, findKey };
