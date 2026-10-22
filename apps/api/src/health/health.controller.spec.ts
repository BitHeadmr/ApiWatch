import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller.js';

const make = (dbOk: boolean, redisOk: boolean) => {
  const connection = {
    readyState: 1,
    db: {
      admin: () => ({
        ping: dbOk ? async () => ({ ok: 1 }) : async () => Promise.reject(new Error('db down')),
      }),
    },
  };
  const redis = { ping: async () => redisOk };
  return new HealthController(connection as never, redis as never);
};

describe('HealthController', () => {
  it('returns ok when database and redis are up', async () => {
    const res = await make(true, true).check();
    expect(res.status).toBe('ok');
    expect(res.dependencies).toEqual({ database: 'up', redis: 'up' });
  });

  it('throws 503 when a dependency is down', async () => {
    await expect(make(true, false).check()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(make(false, true).check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('treats a disconnected database as down', async () => {
    const c = make(true, true) as unknown as { connection: { readyState: number } };
    c.connection.readyState = 0;
    await expect((c as unknown as HealthController).check()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
