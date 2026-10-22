import { Module } from '@nestjs/common';
import { AlertWorker } from './alert.worker.js';
import { AlertsService } from './alerts.service.js';
import { ChannelsController } from './channels.controller.js';
import { ChannelsService } from './channels.service.js';
import { AlertSender } from './senders/alert-sender.js';
import { EmailService } from './senders/email.service.js';
import { WebhookService } from './senders/webhook.service.js';

@Module({
  controllers: [ChannelsController],
  providers: [AlertsService, AlertWorker, ChannelsService, AlertSender, EmailService, WebhookService],
  exports: [AlertsService],
})
export class AlertsModule {}
