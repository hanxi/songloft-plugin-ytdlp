import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the date and sequence rules aligned with the MIOT release script.
export function datePrefix(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  return ['year', 'month', 'day']
    .map((key) => parts.find((p) => p.type === key).value)
    .join('.');
}

function versionParts(version) {
  const match = /^v?(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.(\d+))?$/.exec(version);
  if (!match) return null;
  const parts = match
    .slice(1)
    .map((value) => (value === undefined ? undefined : Number(value)));
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (
    date.getUTCFullYear() !== parts[0] ||
    date.getUTCMonth() !== parts[1] - 1 ||
    date.getUTCDate() !== parts[2] ||
    (parts[3] !== undefined && !Number.isSafeInteger(parts[3]))
  )
    return null;
  return parts;
}

export function isReleaseVersion(version) {
  const parts = versionParts(version);
  return (
    !!parts &&
    !version.startsWith('v') &&
    parts[3] !== undefined &&
    parts[3] <= 999999999
  );
}

export function nextVersion(tags, currentVersion, now = new Date()) {
  let date = versionParts(datePrefix(now)).slice(0, 3);
  const current = versionParts(currentVersion);
  if (
    current &&
    current
      .slice(0, 3)
      .some(
        (value, i) =>
          value > date[i] &&
          current.slice(0, i).every((prefix, j) => prefix === date[j]),
      )
  )
    date = current.slice(0, 3);
  const prefix = date.join('.');
  const revisions = tags
    .map(versionParts)
    .filter(
      (parts) =>
        parts &&
        parts.slice(0, 3).join('.') === prefix &&
        parts[3] !== undefined,
    )
    .map((parts) => parts[3]);
  const legacy = tags
    .map(versionParts)
    .some(
      (parts) =>
        parts &&
        parts.slice(0, 3).join('.') === prefix &&
        parts[3] === undefined,
    );
  const revision = revisions.length
    ? Math.max(...revisions) + 1
    : legacy
      ? 1
      : 0;
  if (!Number.isSafeInteger(revision) || revision > 999999999)
    throw new Error('Daily release sequence exhausted');
  return `${prefix}.${revision}`;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' })
    .trim()
    .split('\n');
  const { version: current } = JSON.parse(readFileSync('package.json', 'utf8'));
  const version = process.env.INPUT_VERSION || nextVersion(tags, current);
  if (!isReleaseVersion(version))
    throw new Error('Version must be a valid Y.M.D.N date and sequence');
  console.log(version);
}
