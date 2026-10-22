import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import bcrypt from 'bcryptjs';
import { Model, Types } from 'mongoose';
import { Team } from '../database/schemas/team.schema.js';
import { User } from '../database/schemas/user.schema.js';
import type { LoginDto } from './dto/login.dto.js';
import type { RegisterDto } from './dto/register.dto.js';

const BCRYPT_ROUNDS = 12;
const DUPLICATE_KEY = 11000;

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    if (await this.users.exists({ email: dto.email })) {
      throw new ConflictException('Email already registered');
    }
    const password = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // No multi-document transactions (they need a replica set), so order the writes so a
    // failure can't leave anything dangling: the user goes first, because the unique email
    // index is the step most likely to fail. If the team insert then fails, undo the user.
    const teamId = new Types.ObjectId();
    let user;
    try {
      user = await this.users.create({ email: dto.email, password, teamId });
    } catch (err) {
      // Lost a race with a concurrent registration of the same email.
      if ((err as { code?: number }).code === DUPLICATE_KEY) {
        throw new ConflictException('Email already registered');
      }
      throw err;
    }
    try {
      await this.teams.create({ _id: teamId, name: dto.teamName });
    } catch (err) {
      await this.users.deleteOne({ _id: user._id });
      throw err;
    }
    return this.issueToken({ id: user.id, email: user.email, teamId: teamId.toString() });
  }

  async login(dto: LoginDto) {
    const user = await this.users.findOne({ email: dto.email }).select('+password');
    // Same error for unknown email and wrong password: don't leak which emails exist.
    const ok = user ? await bcrypt.compare(dto.password, user.password) : false;
    if (!user || !ok) throw new UnauthorizedException('Invalid email or password');
    return this.issueToken({ id: user.id, email: user.email, teamId: user.teamId.toString() });
  }

  async me(userId: string) {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException();
    const team = await this.teams.findById(user.teamId);
    return {
      id: user.id,
      email: user.email,
      teamId: user.teamId.toString(),
      team: team ? { id: team.id, name: team.name } : null,
    };
  }

  private async issueToken(user: { id: string; email: string; teamId: string }) {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      teamId: user.teamId,
    });
    return { accessToken, user };
  }
}
