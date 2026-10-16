import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { startBridge } from './http-bridge.mjs';

test('binds loopback only, closes on controller EOF, and releases the port', async () => {
  const input = new PassThrough();
  const bridge = await startBridge({ port: 0, input });
  const address = bridge.server.server.address();
  assert.equal(address.address, '127.0.0.1');
  input.end();
  assert.equal(await bridge.done, 'controller-disconnected');
  const replacement = net.createServer();
  await new Promise((resolve, reject) => replacement.once('error', reject).listen(address.port, '127.0.0.1', resolve));
  await new Promise(resolve => replacement.close(resolve));
});

test('lost heartbeat closes the bridge', async () => {
  const bridge = await startBridge({ port: 0, heartbeatMs: 90, input: new PassThrough() });
  assert.equal(await bridge.done, 'heartbeat-expired');
});

test('heartbeat keeps bridge alive until explicit shutdown', async () => {
  const input = new PassThrough();
  const bridge = await startBridge({ port: 0, heartbeatMs: 300, input });
  const timer = setInterval(() => input.write('\n'), 30);
  try {
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.ok(bridge.server.server.listening);
  } finally {
    clearInterval(timer);
    await bridge.close('test-shutdown');
  }
  assert.equal(await bridge.done, 'test-shutdown');
});
