import { Server } from 'proxy-chain';
import { pathToFileURL } from 'node:url';

export async function startBridge({
  port = Number(process.env.CODEX_HTTP_PROXY_PORT || 8080),
  socksPort = Number(process.env.CODEX_SOCKS_PORT || 1080),
  heartbeatMs = 45000, input = process.stdin,
} = {}) {
  const server = new Server({
    host: '127.0.0.1', port, verbose: false,
    prepareRequestFunction: () => ({ upstreamProxyUrl: `socks5h://127.0.0.1:${socksPort}` }),
  });
  let lastHeartbeat = Date.now();
  let closing;
  let timer;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const heartbeat = () => { lastHeartbeat = Date.now(); };
  const eof = () => { void close('controller-disconnected'); };
  const signal = () => { void close('shutdown'); };
  const close = (reason) => {
    if (closing) return closing;
    clearInterval(timer);
    input.off('data', heartbeat);
    input.off('end', eof);
    input.off('error', eof);
    input.pause();
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(name, signal);
    closing = server.close(true).then(() => resolveDone(reason));
    return closing;
  };
  await server.listen();
  input.on('data', heartbeat);
  input.once('end', eof);
  input.once('error', eof);
  input.resume();
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(name, signal);
  // A severed SSH session must not leave a listener blocking its replacement.
  timer = setInterval(() => {
    if (Date.now() - lastHeartbeat > heartbeatMs) void close('heartbeat-expired');
  }, Math.min(5000, heartbeatMs / 3));
  if (input.readableEnded || input.destroyed) void close('controller-disconnected');
  return { server, close, done };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const bridge = await startBridge();
    console.log(`HTTP bridge listening on loopback port ${bridge.server.port}`);
    console.log(`HTTP bridge stopped: ${await bridge.done}`);
  } catch (error) {
    console.error(`HTTP bridge failed: ${error.code || error.name}`);
    process.exitCode = 1;
  }
}
