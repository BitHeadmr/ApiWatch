import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module.js';
import { CheckRunnerService } from '../checker/check-runner.service.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { CheckWorker } from './check.worker.js';
import { SchedulerService } from './scheduler.service.js';

@Module({
  imports: [IncidentsModule, AlertsModule],
  providers: [SchedulerService, CheckRunnerService, CheckWorker],
  exports: [SchedulerService, CheckRunnerService],
})
export class SchedulerModule {}
