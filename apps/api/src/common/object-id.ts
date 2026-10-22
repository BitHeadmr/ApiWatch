import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** True only for 24-character hex ids (Mongoose's own isValid also accepts any 12-char string). */
export const isObjectId = (value: unknown): value is string =>
  typeof value === 'string' && OBJECT_ID.test(value);

@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string, string> {
  transform(value: string) {
    if (!isObjectId(value)) throw new BadRequestException('Invalid id');
    return value;
  }
}
