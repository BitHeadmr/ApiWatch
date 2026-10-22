import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  userId: string;
  teamId: string;
  email: string;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().user as AuthUser;
});
