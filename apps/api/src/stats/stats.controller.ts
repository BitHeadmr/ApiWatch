import { Controller, Get, UseGuards } from '@nestjs/common';
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

  /** 24-hour uptime and the recent-check strip for every endpoint of the caller's team. */
  @Get('overview')
  overview(@CurrentUser() user: AuthUser) {
    return this.stats.overview(user.teamId);
  }
}
