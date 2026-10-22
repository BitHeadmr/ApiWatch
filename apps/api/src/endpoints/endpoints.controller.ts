import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator.js';
import { ParseObjectIdPipe } from '../common/object-id.js';
import { CreateEndpointDto } from './dto/create-endpoint.dto.js';
import { UpdateEndpointDto } from './dto/update-endpoint.dto.js';
import { EndpointsService } from './endpoints.service.js';

@Controller('endpoints')
@UseGuards(JwtAuthGuard)
export class EndpointsController {
  constructor(private readonly endpoints: EndpointsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.endpoints.list(user.teamId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateEndpointDto) {
    return this.endpoints.create(user.teamId, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.endpoints.get(user.teamId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateEndpointDto,
  ) {
    return this.endpoints.update(user.teamId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    await this.endpoints.remove(user.teamId, id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  pause(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.endpoints.pause(user.teamId, id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  resume(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.endpoints.resume(user.teamId, id);
  }

  @Post(':id/check-now')
  @HttpCode(200)
  checkNow(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.endpoints.checkNow(user.teamId, id);
  }

  @Get(':id/checks')
  checks(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseObjectIdPipe) id: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.endpoints.recentChecks(user.teamId, id, limit);
  }
}
