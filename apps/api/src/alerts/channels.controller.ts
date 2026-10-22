import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator.js';
import { ParseObjectIdPipe } from '../common/object-id.js';
import { ChannelsService } from './channels.service.js';
import { CreateChannelDto } from './dto/create-channel.dto.js';

@Controller()
@UseGuards(JwtAuthGuard)
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Post('endpoints/:endpointId/channels')
  create(
    @CurrentUser() user: AuthUser,
    @Param('endpointId', ParseObjectIdPipe) endpointId: string,
    @Body() dto: CreateChannelDto,
  ) {
    return this.channels.create(user.teamId, endpointId, dto);
  }

  @Get('endpoints/:endpointId/channels')
  list(@CurrentUser() user: AuthUser, @Param('endpointId', ParseObjectIdPipe) endpointId: string) {
    return this.channels.list(user.teamId, endpointId);
  }

  @Delete('channels/:id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    await this.channels.remove(user.teamId, id);
  }

  /** Always 200: `success: false` with an `error` is the useful answer when delivery fails. */
  @Post('channels/:id/test')
  @HttpCode(200)
  test(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.channels.test(user.teamId, id);
  }
}
