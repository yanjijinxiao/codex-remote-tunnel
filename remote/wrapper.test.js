const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const source = fs.readFileSync(__dirname + '/codex-wrapper', 'utf8');
const script = source.replace('exec "${CODEX_REAL_BIN:-$HOME/.local/bin/codex-real}" "$@"',
  'printf "%s\\n" "$ALL_PROXY" "$HTTPS_PROXY" "$HTTP_PROXY" "$SSL_CERT_FILE"');

test('default SOCKS settings map to HTTP while certificates stay intact', () => {
  const result = execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8', env: {
    HOME: '/tmp/test-home', PATH: '/usr/bin:/bin', ALL_PROXY: 'socks5h://127.0.0.1:1080', HTTPS_PROXY: 'socks5://127.0.0.1:1080',
  } }).trim().split('\n');
  assert.deepEqual(result.slice(0, 3), Array(3).fill('http://127.0.0.1:8080'));
  assert.equal(result[3], '/tmp/test-home/.codex/codex-ca-bundle.pem');
});

test('custom proxy and certificate settings are preserved', () => {
  const result = execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8', env: {
    HOME: '/tmp/test-home', PATH: '/usr/bin:/bin', ALL_PROXY: 'http://custom:8888', HTTPS_PROXY: 'http://custom:8888',
    HTTP_PROXY: 'http://custom:8888', SSL_CERT_FILE: '/custom.pem',
  } }).trim().split('\n');
  assert.deepEqual(result, ['http://custom:8888', 'http://custom:8888', 'http://custom:8888', '/custom.pem']);
});

test('ports and runtime home are supplied by the environment', () => {
  const result = execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8', env: {
    HOME: '/tmp/test-home', PATH: '/usr/bin:/bin', CODEX_HOME: '/tmp/runtime',
    CODEX_SOCKS_PORT: '1081', CODEX_HTTP_PROXY_PORT: '8081',
    ALL_PROXY: 'socks5h://127.0.0.1:1081',
  } }).trim().split('\n');
  assert.deepEqual(result.slice(0, 3), Array(3).fill('http://127.0.0.1:8081'));
  assert.equal(result[3], '/tmp/runtime/codex-ca-bundle.pem');
});
