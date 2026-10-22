import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { RedisService } from '../redis/redis.service.js';

type Dep = 'up' | 'down';

@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async check() {
    const [database, redis] = await Promise.all([this.checkDb(), this.redis.ping()]);
    const deps: Record<string, Dep> = {
      database: database ? 'up' : 'down',
      redis: redis ? 'up' : 'down',
    };
    const body = {
      status: database && redis ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      dependencies: deps,
    };
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }

  private async checkDb(): Promise<boolean> {
    try {
      if (this.connection.readyState !== 1 || !this.connection.db) return false;
      const res = await this.connection.db.admin().ping();
      return res.ok === 1;
    } catch {
      return false;
    }
  }
}
