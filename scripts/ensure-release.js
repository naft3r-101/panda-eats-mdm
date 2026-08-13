'use strict';

/**
 * Create the GitHub release BEFORE electron-builder publishes into it.
 *
 * electron-builder runs one publish task per artifact - the installer and its
 * blockmap - and they race. Both ask whether the release exists, both are told
 * it does not, and both create it. GitHub accepts two releases pointing at the
 * same tag without complaint, so the artifacts end up split across a pair of
 * duplicates and neither one is installable.
 *
 * This is not theoretical: it happened on both releases published so far. On
 * 0.2.0 it left a stray draft behind, and on 0.3.0 it put the blockmap in one
 * release and the installer plus latest.yml in the other, so the tag resolved
 * to a release with no installer in it.
 *
 * Creating the release up front removes the race entirely - both publishers
 * find an existing release and do nothing but upload. Run from the `release`
 * script, before electron-builder.
 *
 * Uses the same GH_TOKEN electron-builder needs to publish, so this adds no
 * new credential and no new dependency.
 */

const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.github.com';

function readConfig() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const publish = (pkg.build && pkg.build.publish) || [];
  const github = (Array.isArray(publish) ? publish : [publish]).find((p) => p && p.provider === 'github');
  if (!github) throw new Error('No github publish provider configured in package.json build.publish.');
  return { version: pkg.version, owner: github.owner, repo: github.repo };
}

async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      'GH_TOKEN is not set. Publish with:  GH_TOKEN="$(gh auth token)" pnpm release'
    );
  }

  const { version, owner, repo } = readConfig();
  const tag = `v${version}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'panda-bench-release',
  };

  const existing = await fetch(`${API}/repos/${owner}/${repo}/releases/tags/${tag}`, { headers });
  if (existing.ok) {
    console.log(`Release ${tag} already exists - electron-builder will upload into it.`);
    return;
  }
  if (existing.status !== 404) {
    throw new Error(`Could not check for release ${tag}: ${existing.status} ${await existing.text()}`);
  }

  const created = await fetch(`${API}/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: version,
      target_commitish: 'main',
      draft: false,
      prerelease: false,
    }),
  });

  if (!created.ok) {
    throw new Error(`Could not create release ${tag}: ${created.status} ${await created.text()}`);
  }
  console.log(`Created release ${tag}.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
