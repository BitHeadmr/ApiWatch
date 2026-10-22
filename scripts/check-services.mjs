#!/usr/bin/env node
// Checks that MongoDB and Redis are reachable, and says how to start them if not.
//   npm run check
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, 'apps/api/.env');

function readEnv() {
  const env = { ...process.env };
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

function hostPort(uri, fallbackPort) {
  try {
    // mongodb+srv:// (Atlas) has no port and is resolved through DNS, so it can't be probed here.
    if (uri.startsWith('mongodb+srv://')) return { srv: true, host: new URL(uri.replace('mongodb+srv', 'https')).hostname };
    const first = uri.replace(/^mongodb:\/\/([^@/]*@)?/, '').split(/[/?]/)[0].split(',')[0];
    const u = new URL(uri.startsWith('redis') ? uri : `tcp://${first}`);
    return { host: u.hostname, port: Number(u.port || fallbackPort) };
  } catch {
    return null;
  }
}

const probe = ({ host, port }) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2000 });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(false));
  });

const env = readEnv();
const targets = [
  {
    name: 'MongoDB',
    uri: env.MONGODB_URI ?? 'mongodb://localhost:27017/apiwatch',
    port: 27017,
    help: [
      'macOS (Homebrew): brew tap mongodb/brew && brew install mongodb-community@7.0',
      '                  brew services start mongodb-community@7.0',
      'Docker:           npm run db:up',
      'No install:       use a free MongoDB Atlas cluster and put its URI in apps/api/.env (MONGODB_URI)',
    ],
  },
  {
    name: 'Redis',
    uri: env.REDIS_URL ?? 'redis://localhost:6379',
    port: 6379,
    help: [
      'macOS (Homebrew): brew install redis && brew services start redis',
      'Docker:           npm run db:up',
      'No install:       a free Upstash Redis URL in apps/api/.env (REDIS_URL)',
    ],
  },
];

if (!fs.existsSync(envFile)) {
  console.log(`! ${path.relative(root, envFile)} not found. Create it with:\n    cp apps/api/.env.example apps/api/.env\n`);
}

let failed = false;
for (const t of targets) {
  const hp = hostPort(t.uri, t.port);
  if (hp?.srv) {
    console.log(`? ${t.name}: ${hp.host} (Atlas SRV address, can't be probed here; the API will report if it can't connect)`);
    continue;
  }
  const ok = hp ? await probe(hp) : false;
  if (ok) {
    console.log(`✓ ${t.name} is reachable at ${hp.host}:${hp.port}`);
  } else {
    failed = true;
    console.log(`✗ ${t.name} is NOT reachable at ${hp ? `${hp.host}:${hp.port}` : t.uri}`);
    for (const h of t.help) console.log(`    ${h}`);
  }
}
if (failed) {
  console.log('\nStart what is missing, then run `npm run check` again.');
  process.exit(1);
}
console.log('\nAll set. Start the API with: npm run dev:api');
