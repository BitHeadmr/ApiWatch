import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.get<string>('REDIS_URL', 'redis://localhost:6379'), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    // Avoid unhandled 'error' events crashing the process when Redis is down.
    this.client.on('error', () => undefined);
  }

  async ping(): Promise<boolean> {
    try {
      if (this.client.status === 'wait') await this.client.connect();
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /** Returns a lock token, or null if someone else holds the lock. */
  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const res = await this.client.set(key, token, 'PX', ttlMs, 'NX');
    return res === 'OK' ? token : null;
  }

  /** Releases the lock only if we still own it (it may have expired and been re-taken). */
  async releaseLock(key: string, token: string): Promise<void> {
    const script =
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
    await this.client.eval(script, 1, key, token);
  }

  async onModuleDestroy() {
    this.client.disconnect();
  }
}
