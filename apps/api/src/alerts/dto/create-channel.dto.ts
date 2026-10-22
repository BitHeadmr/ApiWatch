import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CHANNEL_TYPES } from '../../database/schemas/alert-channel.schema.js';

export class CreateChannelDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(CHANNEL_TYPES)
  type: 'EMAIL' | 'WEBHOOK';

  /** An email address (type EMAIL) or an http(s) URL (type WEBHOOK). Checked against `type` in the service. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(2048)
  target: string;

  /** Webhook only. Leave out to have one generated (it is shown once, in the response). */
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(200)
  secret?: string;
}
