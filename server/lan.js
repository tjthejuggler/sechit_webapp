// LAN address detection: prefer a private, non-internal IPv4 interface so the
// join URL works from phones on the same WiFi. Falls back to localhost.
import os from 'node:os';

function scoreAddress(addr) {
  // Higher score = better candidate for phone-reachable LAN host.
  if (addr.internal) return -1;
  if (!addr.family || addr.family !== 'IPv4') return -1;
  const ip = addr.address;
  if (ip.startsWith('192.168.')) return 40;
  if (ip.startsWith('10.')) return 30;
  const m = ip.match(/^172\.(1[6-9]|2\d|3[01])\./);
  if (m) return 20;
  return 10; // other public-ish IPv4 (still better than internal)
}

export function detectLanIp() {
  let best = null;
  let bestScore = -1;
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const addr of ifaces ?? []) {
      const score = scoreAddress(addr);
      if (score > bestScore) {
        bestScore = score;
        best = addr.address;
      }
    }
  }
  return best ?? '127.0.0.1';
}

export function baseUrl(port) {
  return `http://${detectLanIp()}:${port}`;
}
