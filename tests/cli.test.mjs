import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { childEnvironment, serviceAddress, resolveCodex } from '../src/cli.mjs';

test('missing home variables are supplied to a real child process', () => {
  const result = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify({profile:process.env.USERPROFILE,home:process.env.HOME,codex:process.env.CODEX_HOME,local:process.env.LOCALAPPDATA}))'], {
    env: childEnvironment({ PATH: process.env.PATH }), encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.profile, os.homedir());
  assert.equal(actual.home, actual.profile);
  assert.equal(actual.codex, path.join(actual.profile, '.codex'));
  assert.equal(actual.local, path.join(actual.profile, 'AppData', 'Local'));
});

test('explicit Codex home and unrelated parent settings are preserved', () => {
  const parent = { USERPROFILE: os.homedir(), CODEX_HOME: 'D:\\CustomCodex', LOCALAPPDATA: 'D:\\AppData', CODEX_THREAD_ID: 'original-thread' };
  const actual = childEnvironment(parent);
  assert.equal(actual.CODEX_HOME, parent.CODEX_HOME);
  assert.equal(actual.LOCALAPPDATA, parent.LOCALAPPDATA);
  assert.equal(actual.CODEX_THREAD_ID, parent.CODEX_THREAD_ID);
  assert.equal(parent.HOME, undefined);
});

test('service address supports another loopback port and IPv6', () => {
  assert.equal(serviceAddress({}), 'http://127.0.0.1:3080');
  assert.equal(serviceAddress({ DSH_BRIDGE_URL: 'http://localhost:4567/' }), 'http://localhost:4567');
  assert.equal(serviceAddress({ DSH_BRIDGE_URL: 'http://[::1]:4567' }), 'http://[::1]:4567');
});

test('service address refuses remote hosts and credential-bearing URLs', () => {
  for (const url of ['http://example.com', 'https://localhost', 'http://user:secret@localhost', 'http://localhost/path', 'http://localhost/?token=secret', 'invalid']) {
    assert.throws(() => serviceAddress({ DSH_BRIDGE_URL: url }), /DSH_BRIDGE_URL/);
  }
});

test('explicit native Codex binary wins, while shell shims are rejected', () => {
  assert.equal(resolveCodex({ CODEX_BIN: process.execPath }), process.execPath);
  assert.throws(() => resolveCodex({ CODEX_BIN: path.resolve('codex.cmd') }), /shell shim/);
  assert.throws(() => resolveCodex({ CODEX_BIN: 'relative.exe' }), /absolute/);
});

test('CLI help and version work without a running DSH service', () => {
  const entry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--retry-delivery/);
  const version = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8', windowsHide: true });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
});
