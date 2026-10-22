import { Module } from '@nestjs/common';
import { SchedulerModule } from '../scheduler/scheduler.module.js';
import { EndpointsController } from './endpoints.controller.js';
import { EndpointsService } from './endpoints.service.js';
import { IncidentsModule } from '../incidents/incidents.module.js';

@Module({
  imports: [SchedulerModule,IncidentsModule],
  controllers: [EndpointsController],
  providers: [EndpointsService],
  exports: [EndpointsService],
})
export class EndpointsModule {}
