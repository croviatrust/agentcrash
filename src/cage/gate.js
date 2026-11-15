// The gate: the only door out of the cage. The caged process has no network
// of its own; a relay inside forwards a loopback port to this unix socket, and
// here every connection is an HTTP proxy request that is checked against an
// allow-list before anything is dialled. What was refused is remembered, so
// the run can say where the agent tried to go.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const hostOf = (target) => {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(target) || /^([^:]+)(?::(\d+))?$/.exec(target);
  return m ? { host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : null } : null;
};

// "example.com" allows that host on 80 and 443, "*.example.com" every
// subdomain, "host:5432" one host on one port.
export function allowed(list, host, port) {
  return list.some((rule) => {
    const r = hostOf(rule.replace(/^\*\./, ''));
    if (!r) return false;
    const wild = rule.startsWith('*.');
    const hostOk = wild ? host === r.host || host.endsWith(`.${r.host}`) : host === r.host;
    return hostOk && (r.port ? port === r.port : port === 80 || port === 443);
  });
}

export function startGate({ allow = [], routes = {}, dir } = {}) {
  const base = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrash-gate-'));
  const sock = path.join(base, 'gate.sock');
  const log = [];
  const note = (host, port, ok) => {
    const e = log.find((x) => x.host === host && x.port === port && x.allowed === ok);
    if (e) e.count++; else log.push({ host, port, allowed: ok, count: 1 });
  };
  const open = new Set();

  const server = net.createServer((client) => {
    open.add(client);
    client.on('close', () => open.delete(client));
    client.on('error', () => {});
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) { if (head.length > 65536) client.destroy(); return; }
      client.off('data', onData);
      client.pause();
      const lines = head.subarray(0, end).toString('latin1').split('\r\n');
      const rest = head.subarray(end + 4);
      const [method, target, version] = lines[0].split(' ');
      const refuse = (code, why) => client.end(`HTTP/1.1 ${code} ${why}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nagentcrash cage: ${why}\n`);

      let host, port, request = null;
      if (method === 'CONNECT') {
        const t = hostOf(target || '');
        if (!t) return refuse(400, 'bad request');
        ({ host } = t); port = t.port ?? 443;
      } else {
        let u;
        try { u = new URL(target); } catch { return refuse(400, 'not a proxy request'); }
        if (u.protocol !== 'http:') return refuse(400, 'not a proxy request');
        host = u.hostname.toLowerCase(); port = Number(u.port) || 80;
        // Origin form upstream, one request per connection: the next request
        // comes back through this check instead of riding an open pipe.
        const headers = lines.slice(1).filter((l) => !/^(proxy-connection|connection|proxy-authorization):/i.test(l));
        request = Buffer.concat([
          Buffer.from(`${method} ${u.pathname}${u.search} ${version}\r\n${headers.join('\r\n')}\r\nconnection: close\r\n\r\n`, 'latin1'),
          rest,
        ]);
      }
      const route = routes[`${host}:${port}`] || routes[host];
      if (!route && !allowed(allow, host, port)) { note(host, port, false); return refuse(403, `${host}:${port} is not on the allow-list`); }
      note(host, port, true);
      const up = net.connect(route || { host, port });
      open.add(up);
      up.on('close', () => open.delete(up));
      up.on('error', () => { if (!client.destroyed) refuse(502, `cannot reach ${host}:${port}`); });
      up.on('connect', () => {
        if (request) up.write(request);
        else { client.write('HTTP/1.1 200 Connection established\r\n\r\n'); if (rest.length) up.write(rest); }
        client.pipe(up); up.pipe(client);
        client.resume();
      });
      client.on('close', () => up.destroy());
    };
    client.on('data', onData);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(sock, () => resolve({
      sock, dir: base, log,
      close: () => new Promise((r) => {
        for (const s of open) s.destroy();
        server.close(() => { if (!dir) fs.rmSync(base, { recursive: true, force: true }); r(); });
      }),
    }));
  });
}
