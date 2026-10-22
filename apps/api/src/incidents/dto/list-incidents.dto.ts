import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

export class ListIncidentsDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsIn(['open', 'resolved'])
  status?: string;

  @IsOptional()
  @Matches(/^[0-9a-fA-F]{24}$/, { message: 'endpointId must be a valid id' })
  endpointId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
