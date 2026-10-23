import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';

@Schema({ collection: 'stats_rollups', timestamps: true })
export class StatsRollup {
  @Prop({ type: Types.ObjectId, ref: 'Endpoint', required: true })
  endpointId: Types.ObjectId;

  @Prop({ type: Date, required: true })
  bucketStart: Date;

  @Prop({ type: Number, required: true, default: 0 })
  totalChecks: number;

  @Prop({ type: Number, required: true, default: 0 })
  successfulChecks: number;

  @Prop({ type: Number, required: true, default: 0 })
  responseTimeTotalMs: number;

  @Prop({ type: Number, required: true, default: 0 })
  responseTimeCount: number;
}

export type StatsRollupDocument = HydratedDocument<StatsRollup>;
export const StatsRollupSchema = SchemaFactory.createForClass(StatsRollup);
StatsRollupSchema.index({ endpointId: 1, bucketStart: 1 }, { unique: true });
