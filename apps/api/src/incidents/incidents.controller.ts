import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator.js';
import { ParseObjectIdPipe } from '../common/object-id.js';
import { ListIncidentsDto } from './dto/list-incidents.dto.js';
import { IncidentsService } from './incidents.service.js';

@Controller('incidents')
@UseGuards(JwtAuthGuard)
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  /** The incident log, newest first. Filter with ?status=open|resolved and ?endpointId=. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListIncidentsDto) {
    return this.incidents.list(user.teamId, query);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.incidents.getWithEvidence(user.teamId, id);
  }
}
