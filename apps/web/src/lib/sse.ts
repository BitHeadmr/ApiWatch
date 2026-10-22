import { notifyUnauthorized } from './token';

export interface SseMessage {
  event: string;
  data: unknown;
}

/**
 * Splits a chunk of Server-Sent Events text into complete messages and the unfinished rest.
 * Handles \n and \r\n line endings, comment lines (": ..."), and multi-line `data:` fields.
 */
export function parseSse(buffer: string): { messages: SseMessage[]; rest: string } {
  const text = buffer.replace(/\r\n/g, '\n');
  const messages: SseMessage[] = [];
  let rest = text;
  for (;;) {
    const end = rest.indexOf('\n\n');
    if (end === -1) break;
    const block = rest.slice(0, end);
    rest = rest.slice(end + 2);

    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // comment, used as a keep-alive by some servers
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) continue;
    try {
      messages.push({ event, data: JSON.parse(data.join('\n')) });
    } catch {
      /* ignore a malformed message rather than dropping the connection */
    }
  }
  return { messages, rest };
}

export interface StreamOptions {
  url: string;
  getToken: () => string | null;
  onMessage: (message: SseMessage) => void;
  onOpen: () => void;
  onClose: () => void;
  fetchImpl?: typeof fetch;
  /** Reconnect delay for the given attempt number (0-based). Overridable for tests. */
  backoff?: (attempt: number) => number;
  /** Reconnect if nothing at all (not even a heartbeat) arrives for this long. */
  silenceTimeoutMs?: number;
}

const defaultBackoff = (attempt: number) =>
  Math.min(1000 * 2 ** attempt, 15_000) * (0.75 + Math.random() * 0.5);

/**
 * Keeps a Server-Sent Events connection open, reconnecting with backoff whenever it drops.
 * Uses fetch rather than EventSource so the access token travels in a header, not in the URL.
 */
export function connectStream(opts: StreamOptions): { close: () => void } {
  const doFetch = opts.fetchImpl ?? fetch;
  const backoff = opts.backoff ?? defaultBackoff;
  const silenceMs = opts.silenceTimeoutMs ?? 45_000;
  let stopped = false;
  let current: AbortController | null = null;
  let wake: (() => void) | null = null;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  async function run() {
    let attempt = 0;
    while (!stopped) {
      const controller = new AbortController();
      current = controller;
      let lastActivity = Date.now();
      const watchdog = setInterval(
        () => {
          if (Date.now() - lastActivity > silenceMs) controller.abort();
        },
        Math.max(250, Math.min(5000, silenceMs / 3)),
      );

      try {
        const token = opts.getToken();
        const res = await doFetch(opts.url, {
          headers: {
            accept: 'text/event-stream',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          signal: controller.signal,
        });
        if (res.status === 401) {
          notifyUnauthorized();
          stopped = true;
          return;
        }
        if (!res.ok || !res.body) throw new Error(`Stream responded ${res.status}`);

        attempt = 0;
        opts.onOpen();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          lastActivity = Date.now();
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSse(buffer);
          buffer = parsed.rest;
          parsed.messages.forEach((m) => opts.onMessage(m));
        }
      } catch {
        /* dropped, aborted or refused: fall through to reconnect */
      } finally {
        clearInterval(watchdog);
      }

      if (stopped) return;
      opts.onClose();
      await sleep(backoff(attempt++));
    }
  }

  void run();

  return {
    close() {
      stopped = true;
      current?.abort();
      wake?.();
    },
  };
}
