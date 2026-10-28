import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateStatus } from '../scripts/armv7/release.mjs';

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
