import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AlertChannel,
  AlertChannelSchema,
} from './schemas/alert-channel.schema.js';
import { AlertLog, AlertLogSchema } from './schemas/alert-log.schema.js';
import {
  CheckResult,
  CheckResultSchema,
} from './schemas/check-result.schema.js';
import { Endpoint, EndpointSchema } from './schemas/endpoint.schema.js';
import { Incident, IncidentSchema } from './schemas/incident.schema.js';
import { Team, TeamSchema } from './schemas/team.schema.js';
import { User, UserSchema } from './schemas/user.schema.js';
import { StatsRollup, StatsRollupSchema } from './schemas/stats-rollup.schema.js';

/** Connects to MongoDB and registers every model, globally available for injection. */
@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>(
          'MONGODB_URI',
          'mongodb://localhost:27017/apiwatch',
        ),
        serverSelectionTimeoutMS: 5_000,
        retryAttempts: 2,
        retryDelay: 1_500,
      }),
    }),
    MongooseModule.forFeature([
      { name: Team.name, schema: TeamSchema },
      { name: User.name, schema: UserSchema },
      { name: Endpoint.name, schema: EndpointSchema },
      { name: CheckResult.name, schema: CheckResultSchema },
      { name: Incident.name, schema: IncidentSchema },
      { name: AlertChannel.name, schema: AlertChannelSchema },
      { name: AlertLog.name, schema: AlertLogSchema },
      { name: StatsRollup.name, schema: StatsRollupSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class DatabaseModule {}
