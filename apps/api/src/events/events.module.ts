import { Global, Module } from '@nestjs/common';
import { EventsService } from './events.service.js';
import { StreamController } from './stream.controller.js';

@Global()
@Module({
  controllers: [StreamController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
