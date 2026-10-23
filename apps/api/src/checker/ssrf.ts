import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UnsafeTargetError extends Error {
  constructor(message = 'Target resolves to a private or reserved network address') {
    super(message);
    this.name = 'UnsafeTargetError';
  }
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((n, part) => ((n * 256) + Number(part)) >>> 0, 0);
}

function inV4(address: string, network: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
}

function ipv6Number(input: string): bigint | null {
  let address = input.toLowerCase().split('%')[0];
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    if (lastColon < 0) return null;
    const v4 = address.slice(lastColon + 1);
    if (isIP(v4) !== 4) return null;
    const n = ipv4Number(v4);
    address = `${address.slice(0, lastColon)}:${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.reduce((n, group) => (n << 16n) | BigInt(`0x${group}`), 0n);
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const blocked: Array<[string, number]> = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return !blocked.some(([network, bits]) => inV4(address, network, bits));
  }
  if (version === 6) {
    const value = ipv6Number(address);
    if (value === null) return false;
    const inRange = (network: bigint, bits: number) => (value >> BigInt(128 - bits)) === (network >> BigInt(128 - bits));
    // IPv4-mapped IPv6 addresses must be checked using their embedded IPv4 address.
    if (inRange(0x00000000000000000000ffff00000000n, 96)) {
      const v4 = `${Number((value >> 24n) & 255n)}.${Number((value >> 16n) & 255n)}.${Number((value >> 8n) & 255n)}.${Number(value & 255n)}`;
      return isPublicAddress(v4);
    }
    return !(value === 0n || value === 1n || inRange(0xfc000000000000000000000000000000n, 7) ||
      inRange(0xfe800000000000000000000000000000n, 10) || inRange(0xff000000000000000000000000000000n, 8) ||
      inRange(0x20010db8000000000000000000000000n, 32) || inRange(0x20010000000000000000000000000000n, 23));
  }
  return false;
}

export function assertTargetUrlAllowed(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new UnsafeTargetError('Target URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new UnsafeTargetError('Only HTTP and HTTPS targets are allowed');
  if (url.username || url.password) throw new UnsafeTargetError('Target URLs must not contain credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new UnsafeTargetError();
  }
  const family = isIP(hostname);
  if (family && !isPublicAddress(hostname)) throw new UnsafeTargetError();
  return url;
}

export async function resolvePublicTarget(input: string): Promise<{ url: URL; addresses: Array<{ address: string; family: number }> }> {
  const url = assertTargetUrlAllowed(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) throw new UnsafeTargetError();
  return { url, addresses };
}
