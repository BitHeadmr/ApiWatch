import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';

/**
 * Where the tests find MongoDB. Point TEST_MONGODB_URI at any server, with no database name
 * (for example mongodb://localhost:27017). Each test file gets its own throwaway database,
 * so your development data is never touched.
 */
export const TEST_MONGO_BASE = (process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017').replace(/\/+$/, '');

export const throwawayMongoUri = (label: string) =>
  `${TEST_MONGO_BASE}/apiwatch-test-${label}-${Date.now()}-${randomBytes(3).toString('hex')}`;

export async function mongoIsUp(): Promise<boolean> {
  const conn = mongoose.createConnection(TEST_MONGO_BASE, { serverSelectionTimeoutMS: 1_500 });
  try {
    await conn.asPromise();
    return true;
  } catch {
    return false;
  } finally {
    await conn.close().catch(() => undefined);
  }
}
