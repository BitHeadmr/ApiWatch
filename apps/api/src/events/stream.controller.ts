import { Controller, Header, Sse, UseGuards } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import {
  CurrentUser,
  type AuthUser,
} from '../common/current-user.decorator.js';
import { EventsService } from './events.service.js';

@Controller()
@UseGuards(JwtAuthGuard)
export class StreamController {
  constructor(private readonly events: EventsService) {}

  /**
   * Server-Sent Events. Send the usual `Authorization: Bearer` header (the dashboard uses
   * fetch rather than EventSource precisely so the token never has to go in the URL).
   */
  @Sse('stream')
  @Header('X-Accel-Buffering', 'no') // stop nginx from buffering the stream
  stream(@CurrentUser() user: AuthUser): Observable<MessageEvent> {
    return this.events.stream(user.teamId);
  }
}
