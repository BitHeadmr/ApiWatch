import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateEndpointDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @Transform(trim)
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true, require_tld: false },
    { message: 'url must be a valid http(s) URL' },
  )
  @MaxLength(2048)
  url: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(HTTP_METHODS)
  method?: string;

  /** Extra request headers, e.g. { "Authorization": "Bearer ..." } */
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  body?: string;

  /** Seconds between checks. The lower bound (MIN_INTERVAL_SECONDS) is enforced in the service. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(86_400)
  intervalSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(60_000)
  timeoutMs?: number;

  /** Exact status ("200") or class ("2xx"). */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @Matches(/^([1-5]\d\d|[1-5]xx)$/, { message: 'expectedStatus must look like "200" or "2xx"' })
  expectedStatus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  expectedBodyContains?: string;

  /** Consecutive failures before an incident opens. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  failureThreshold?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
