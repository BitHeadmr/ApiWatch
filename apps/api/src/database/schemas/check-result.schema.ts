import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';
import { FAILURE_REASONS, type FailureReason } from '../../checker/types.js';
import { applyApiJson } from './api-json.js';

@Schema({ collection: 'check_results' })
export class CheckResult {
  @Prop({ type: Types.ObjectId, ref: 'Endpoint', required: true })
  endpointId: Types.ObjectId;

  @Prop({ type: Date, default: () => new Date() })
  checkedAt: Date;

  @Prop({ type: Boolean, required: true })
  success: boolean;

  @Prop({ type: Number, default: null })
  statusCode: number | null;

  @Prop({ type: Number, default: null })
  responseTimeMs: number | null;

  @Prop({ type: String, enum: FAILURE_REASONS, default: null })
  failureReason: FailureReason | null;

  @Prop({ type: String, default: null })
  errorMessage: string | null;
}

export type CheckResultDocument = HydratedDocument<CheckResult>;
export const CheckResultSchema = SchemaFactory.createForClass(CheckResult);
// "Latest N checks for an endpoint" and every time-range query in Phase 6 use this index.
CheckResultSchema.index({ endpointId: 1, checkedAt: -1 });
applyApiJson(CheckResultSchema);
