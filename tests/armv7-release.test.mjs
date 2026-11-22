import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveRelease, updateStatus } from '../scripts/armv7/release.mjs';

test('async ARM status preserves plugin notes and user additions', () => {
  const before =
    'Plugin ready\n<!-- armv7-status:start -->\nPending\n<!-- armv7-status:end -->\nUser notes';
  const failed = updateStatus(before, 'Build failed; retry');
  assert(failed.startsWith('Plugin ready\n'));
  assert(failed.endsWith('\nUser notes'));
  assert(!failed.includes('Pending'));
  const succeeded = updateStatus(failed, 'Ready $&');
  assert(succeeded.includes('Ready $&'));
  assert(!succeeded.includes('Build failed'));
  assert.equal(succeeded.match(/armv7-status:start/g).length, 1);
});

test('status can be added to existing release notes without a marker', () => {
  assert(
    updateStatus('Existing release', 'Ready').startsWith(
      'Existing release\n\n',
    ),
  );
});

const repo = 'example/ytdlp';
const tag = 'v2026.11.22.0';
const source = 'a'.repeat(40);
const snapshot = 'b'.repeat(40);
const files = [
  'yt-dlp_musllinux_armv7l',
  'yt-dlp-LICENSE',
  'yt-dlp-THIRD_PARTY_LICENSES.txt',
  'yt-dlp-python-requirements.txt',
  'yt-dlp-build.json',
  'yt-dlp-SHA256SUMS',
];

function fixture({ sha = snapshot, parent = source, assets = [], draft = false } = {}) {
  return (...args) => {
    if (args[0] === 'release') {
      assert.equal(args[2], tag);
      return JSON.stringify({
        isDraft: draft,
        body: `Notes\n\nSource commit: ${source}\n`,
        assets: assets.map((name) => ({ name, size: 1 })),
      });
    }
    assert.equal(args[1], `repos/${repo}/commits/${tag}`);
    return JSON.stringify({ sha, parents: [{ sha: parent }] });
  };
}

test('ARM attachment accepts both legacy source tags and new version snapshots', () => {
  for (const options of [{ sha: source }, { sha: snapshot, parent: source }]) {
    assert.deepEqual(resolveRelease(repo, tag, source, fixture(options)), {
      tag, source, skip: false,
    });
  }
});

test('ARM attachment rejects a mismatched build source, wrong tag parent or draft', () => {
  assert.throws(() => resolveRelease(repo, tag, snapshot, fixture()), /does not match source/);
  assert.throws(() => resolveRelease(repo, tag, source, fixture({ parent: snapshot })), /does not match source/);
  assert.throws(() => resolveRelease(repo, tag, source, fixture({ draft: true })), /draft/);
});

test('replayed automatic ARM handoffs only skip a complete attachment set', () => {
  assert.equal(resolveRelease(repo, tag, source, fixture({ assets: files.slice(0, 1) })).skip, false);
  assert.equal(resolveRelease(repo, tag, source, fixture({ assets: files })).skip, true);
  assert.equal(resolveRelease(repo, tag, '', fixture({ assets: files })).skip, false);
});
