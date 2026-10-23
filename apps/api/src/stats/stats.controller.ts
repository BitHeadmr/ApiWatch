import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import {
  CurrentUser,
  type AuthUser,
} from '../common/current-user.decorator.js';
import { StatsService } from './stats.service.js';

@Controller('stats')
@UseGuards(JwtAuthGuard)
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  /** Historical downsampled stats for an endpoint owned by the caller's team. */
  @Get('endpoints/:endpointId/history')
  history(
    @CurrentUser() user: AuthUser,
    @Param('endpointId') endpointId: string,
    @Query('range') range = '24h',
  ) {
    if (range !== '24h' && range !== '7d') range = '24h';
    return this.stats.history(user.teamId, endpointId, range as '24h' | '7d');
  }

  /** 24-hour uptime and the recent-check strip for every endpoint of the caller's team. */
  @Get('overview')
  overview(@CurrentUser() user: AuthUser) {
    return this.stats.overview(user.teamId);
  }
}
