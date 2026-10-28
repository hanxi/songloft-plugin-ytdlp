import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const [assets, version] = process.argv.slice(2);
assert(
  assets && /^\d+\.\d+\.\d+(\.\d+)?$/.test(version || ''),
  'Usage: node smoke.mjs ASSET_DIR YTDLP_VERSION',
);

// A real PCM WAV served locally makes the download check deterministic.
const wav = Buffer.alloc(44 + 1600);
wav.write('RIFF', 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(wav.length - 44, 40);
let requests = 0;
const server = createServer((req, res) => {
  requests++;
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Content-Length': wav.length,
  });
  res.end(req.method === 'HEAD' ? undefined : wav);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const name = `ytdlp-armv7-smoke-${process.pid}`;
try {
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      name,
      '--platform',
      'linux/arm/v7',
      '--network',
      'host',
      '--user',
      '1000:1000',
      '--volume',
      `${resolve(assets)}:/assets:ro`,
      '--env',
      `EXPECTED_VERSION=${version}`,
      '--env',
      `FIXTURE_URL=http://127.0.0.1:${server.address().port}/tone.wav`,
      '--env',
      `FIXTURE_SHA256=${createHash('sha256').update(wav).digest('hex')}`,
      'alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a',
      'sh',
      '-ec',
      `
      test "$(uname -m)" = armv7l
      ! command -v python3
      ! command -v python
      BIN=/assets/yt-dlp_musllinux_armv7l
      time "$BIN" --version
      test "$("$BIN" --version)" = "$EXPECTED_VERSION"
      "$BIN" --list-extractors > /tmp/extractors
      grep -q '^youtube' /tmp/extractors
      "$BIN" --ignore-config --no-progress --output /tmp/tone.wav "$FIXTURE_URL"
      test "$(sha256sum /tmp/tone.wav | cut -d ' ' -f 1)" = "$FIXTURE_SHA256"
      "$BIN" --ignore-config --socket-timeout 30 --retries 2 --skip-download --dump-single-json https://www.w3schools.com/html/horse.mp3
    `,
    ],
    { stdio: 'inherit', timeout: 180_000 },
  );
  const code = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  assert.equal(code, 0, 'ARMv7 runtime smoke failed');
  assert(requests > 0, 'No actual media request received');
  console.log(
    'ARMv7 musl smoke passed (no Python, uid=1000, extractors, HTTP bytes, HTTPS metadata)',
  );
} finally {
  await new Promise((done) => {
    const cleanup = spawn('docker', ['rm', '-f', name], { stdio: 'ignore' });
    cleanup.once('error', done);
    cleanup.once('exit', done);
  });
  server.close();
}
