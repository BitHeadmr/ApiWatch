import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Schema as MongooseSchema, type Types } from 'mongoose';
import { applyApiJson } from './api-json.js';
import { CHANNEL_TYPES, type ChannelType } from './alert-channel.schema.js';

export const ALERT_EVENTS = ['incident.opened', 'incident.resolved'] as const;
export type AlertEventName = (typeof ALERT_EVENTS)[number];

export const ALERT_STATUSES = ['PENDING', 'SENT', 'FAILED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** One row per (incident, channel, event): the record of one alert and how its delivery went. */
@Schema({ collection: 'alert_logs', timestamps: { createdAt: true, updatedAt: false } })
export class AlertLog {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Team', required: true })
  teamId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Endpoint', required: true })
  endpointId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Incident', required: true })
  incidentId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AlertChannel', required: true })
  channelId: Types.ObjectId;

  @Prop({ type: String, enum: ALERT_EVENTS, required: true })
  event: AlertEventName;

  /** Snapshots, so the history still reads correctly after a channel is deleted. */
  @Prop({ type: String, enum: CHANNEL_TYPES, required: true })
  channelType: ChannelType;

  @Prop({ type: String, required: true })
  target: string;

  @Prop({ type: String, enum: ALERT_STATUSES, default: 'PENDING' })
  status: AlertStatus;

  @Prop({ type: Number, default: 0 })
  attempts: number;

  @Prop({ type: String, default: null })
  lastError: string | null;

  @Prop({ type: Date, default: null })
  sentAt: Date | null;

  createdAt: Date;
}

export type AlertLogDocument = HydratedDocument<AlertLog>;
export const AlertLogSchema = SchemaFactory.createForClass(AlertLog);
// The idempotency guarantee: one alert per incident, per channel, per event. Ever.
AlertLogSchema.index({ incidentId: 1, channelId: 1, event: 1 }, { unique: true });
AlertLogSchema.index({ status: 1, createdAt: 1 });
applyApiJson(AlertLogSchema);
