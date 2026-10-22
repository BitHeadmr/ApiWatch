import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { EndpointsModule } from './endpoints/endpoints.module.js';
import { HealthModule } from './health/health.module.js';
import { RedisModule } from './redis/redis.module.js';
import { IncidentsModule } from './incidents/incidents.module.js';
import { EventsModule } from './events/events.module.js';
import { StatsModule } from './stats/stats.module.js';
import { AlertsModule } from './alerts/alerts.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    RedisModule,
    AuthModule,
    EndpointsModule,
    HealthModule,
    EventsModule,
    StatsModule,
    IncidentsModule,
    AlertsModule,
  ],
})
export class AppModule {}
