import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Schema as MongooseSchema, type Types } from 'mongoose';
import { applyApiJson } from './api-json.js';

export const CHANNEL_TYPES = ['EMAIL', 'WEBHOOK'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

@Schema({ collection: 'alert_channels', timestamps: { createdAt: true, updatedAt: false } })
export class AlertChannel {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Team', required: true })
  teamId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Endpoint', required: true })
  endpointId: Types.ObjectId;

  @Prop({ type: String, enum: CHANNEL_TYPES, required: true })
  type: ChannelType;

  /** An email address, or a webhook URL. */
  @Prop({ type: String, required: true })
  target: string;

  /** Webhook signing secret. Never returned by queries unless explicitly selected. */
  @Prop({ type: String, default: null, select: false })
  secret: string | null;

  createdAt: Date;
}

export type AlertChannelDocument = HydratedDocument<AlertChannel>;
export const AlertChannelSchema = SchemaFactory.createForClass(AlertChannel);
AlertChannelSchema.index({ endpointId: 1, type: 1, target: 1 }, { unique: true });
applyApiJson(AlertChannelSchema);
