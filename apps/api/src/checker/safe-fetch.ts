import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { resolvePublicTarget, UnsafeTargetError } from './ssrf.js';

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function requestOnce(url: URL, address: { address: string; family: number }, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (typeof options === 'object' && options.all) {
        callback(null, [{ address: address.address, family: address.family }]);
      } else {
        callback(null, address.address, address.family);
      }
    };
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined,
      method: init.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
      lookup,
      ...(url.protocol === 'https:' && !/^\d+(?:\.\d+){3}$/.test(url.hostname) ? { servername: url.hostname } : {}),
      timeout: 0,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (size >= MAX_RESPONSE_BYTES) return;
        const accepted = buffer.subarray(0, MAX_RESPONSE_BYTES - size);
        chunks.push(accepted);
        size += accepted.length;
        if (size >= MAX_RESPONSE_BYTES) response.destroy();
      });
      response.on('end', () => {
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 502,
          statusText: response.statusMessage,
          headers: response.headers as HeadersInit,
        }));
      });
      response.on('close', () => {
        if (!response.complete) resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 502,
          statusText: response.statusMessage,
          headers: response.headers as HeadersInit,
        }));
      });
      response.on('error', reject);
    });
    const signal = init.signal;
    const abort = () => request.destroy(signal?.reason instanceof Error ? signal.reason : new Error('Request aborted'));
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    request.on('error', reject);
    request.on('close', () => signal?.removeEventListener('abort', abort));
    if (init.body !== undefined && init.body !== null) request.write(typeof init.body === 'string' ? init.body : Buffer.from(init.body as ArrayBuffer));
    request.end();
  });
}

/** HTTP(S) fetch that pins the socket to a vetted DNS answer and validates every redirect hop. */
export async function safeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  let url = new URL(input);
  let method = String(init.method ?? 'GET').toUpperCase();
  let body = init.body;
  let headers = new Headers(init.headers);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url: checkedUrl, addresses } = await resolvePublicTarget(url.toString());
    const response = await requestOnce(checkedUrl, addresses[0], { ...init, method, body, headers });
    const location = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
    if (hop === MAX_REDIRECTS) throw new UnsafeTargetError('Too many redirects');
    const nextUrl = new URL(location, checkedUrl);
    // Validate before following; next loop re-resolves and pins the new destination.
    await resolvePublicTarget(nextUrl.toString());
    if (nextUrl.origin !== checkedUrl.origin) {
      headers.delete('authorization');
      headers.delete('cookie');
      headers.delete('proxy-authorization');
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers.delete('content-length');
      headers.delete('content-type');
    }
    url = nextUrl;
  }
  throw new UnsafeTargetError('Too many redirects');
}
