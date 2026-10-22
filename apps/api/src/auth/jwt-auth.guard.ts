import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthUser } from '../common/current-user.decorator.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    const [scheme, token] = header?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Missing bearer token');

    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; email: string; teamId: string }>(
        token,
      );
      const user: AuthUser = { userId: payload.sub, email: payload.email, teamId: payload.teamId };
      req.user = user;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
