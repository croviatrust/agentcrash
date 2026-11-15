#!/usr/bin/env node
// Runs inside the cage. The cage has a loopback interface and nothing else, so
// this forwards loopback ports to the gate's unix socket, then starts the
// caged command and leaves with its exit status.
//   node relay.js <gate.sock> <proxy-port>[,<local-port>...] -- <command> [args...]
// The first port is the HTTP proxy. Every other port stands in for the same
// port on the machine outside: a model server running on localhost.
import net from 'node:net';
import { spawn } from 'node:child_process';

const [sock, ports, dash, cmd, ...args] = process.argv.slice(2);
if (dash !== '--' || !cmd) { console.error('usage: relay.js <gate.sock> <port>[,<port>...] -- <command> [args...]'); process.exit(2); }
const [proxyPort, ...localPorts] = ports.split(',').map(Number);

const listen = (port, opening) => new Promise((resolve) => {
  const server = net.createServer((c) => {
    const up = net.connect(sock);
    c.on('error', () => up.destroy());
    up.on('error', () => c.destroy());
    if (!opening) { c.pipe(up); up.pipe(c); return; }
    // Ask the gate for the outside port, and only then hand the pipe over.
    c.pause();
    let head = Buffer.alloc(0);
    const onData = (d) => {
      head = Buffer.concat([head, d]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      up.off('data', onData);
      if (!/^HTTP\/1\.1 200/.test(head.toString('latin1'))) { c.destroy(); up.destroy(); return; }
      if (head.length > end + 4) c.write(head.subarray(end + 4));
      c.pipe(up); up.pipe(c); c.resume();
    };
    up.on('data', onData);
    up.on('connect', () => up.write(opening));
    up.on('close', () => c.destroy());
  });
  server.on('error', (e) => { console.error(`agentcrash cage: relay port ${port}: ${e.message}`); process.exit(125); });
  server.listen(port, '127.0.0.1', resolve);
});

await listen(proxyPort);
for (const p of localPorts) await listen(p, `CONNECT 127.0.0.1:${p} HTTP/1.1\r\n\r\n`);

const child = spawn(cmd, args, { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('error', (e) => { console.error(`agentcrash cage: cannot start ${cmd}: ${e.message}`); process.exit(127); });
child.on('exit', (code, signal) => process.exit(signal ? 128 + (signal === 'SIGKILL' ? 9 : 15) : code ?? 1));
