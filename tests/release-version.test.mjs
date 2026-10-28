import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  datePrefix,
  nextVersion,
  isReleaseVersion,
} from '../scripts/release-version.mjs';

test('Beijing midnight changes the date and resets the suffix to zero', () => {
  assert.equal(datePrefix(new Date('2026-10-28T15:59:59Z')), '2026.10.28');
  assert.equal(datePrefix(new Date('2026-10-28T16:00:00Z')), '2026.10.29');
  assert.equal(
    nextVersion(
      ['v2026.10.28.10'],
      '2026.10.28.10',
      new Date('2026-10-28T16:00:00Z'),
    ),
    '2026.10.29.0',
  );
});

test('same-day tags increase numerically and include prerelease tags', () => {
  assert.equal(
    nextVersion(
      ['v2026.10.28.9', 'v2026.10.28.10'],
      '2026.9.11',
      new Date('2026-10-28T03:00:00Z'),
    ),
    '2026.10.28.11',
  );
});

test('first release of the day starts at zero', () => {
  assert.equal(
    nextVersion(['v2026.9.11'], '2026.9.11', new Date('2026-10-28T03:00:00Z')),
    '2026.10.28.0',
  );
});

test('legacy three-part tag starts at one on migration day', () => {
  assert.equal(
    nextVersion(
      ['v2026.10.28'],
      '2026.10.28',
      new Date('2026-10-28T03:00:00Z'),
    ),
    '2026.10.28.1',
  );
});

test('future current version keeps its date prefix until the clock catches up', () => {
  assert.equal(
    nextVersion(
      ['v2026.10.29.2'],
      '2026.10.29.2',
      new Date('2026-10-28T03:00:00Z'),
    ),
    '2026.10.29.3',
  );
});

test('invalid dates are ignored and explicit versions require four parts', () => {
  assert.equal(
    nextVersion(
      ['v2026.2.30.999', 'v2026.2.28.3'],
      '2026.2.28.3',
      new Date('2026-02-28T03:00:00Z'),
    ),
    '2026.2.28.4',
  );
  for (const version of [
    '2026.2.30.0',
    '2026.10.28',
    'v2026.10.28.0',
    '2026.10.28.1000000000',
  ]) {
    assert.equal(isReleaseVersion(version), false);
  }
  assert.equal(isReleaseVersion('2026.10.28.0'), true);
});
