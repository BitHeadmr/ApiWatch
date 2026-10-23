import { describe, expect, it } from 'vitest';
import { isPublicAddress, resolvePublicTarget } from './ssrf.js';

describe('SSRF target validation', () => {
  it.each([
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '100.64.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1',
  ])('blocks non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    'http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.1/', 'file:///etc/passwd', 'http://user:pass@example.com/',
  ])('rejects unsafe target %s', async (url) => {
    await expect(resolvePublicTarget(url)).rejects.toThrow();
  });
});
