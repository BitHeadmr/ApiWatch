import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';
import { applyApiJson } from './api-json.js';

export const ENDPOINT_STATUSES = ['UNKNOWN', 'UP', 'DOWN', 'PAUSED'] as const;
export type EndpointStatus = (typeof ENDPOINT_STATUSES)[number];

@Schema({ collection: 'endpoints', timestamps: true })
export class Endpoint {
  @Prop({ type: Types.ObjectId, ref: 'Team', required: true, index: true })
  teamId: Types.ObjectId;

  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String, required: true })
  url: string;

  @Prop({ type: String, default: 'GET' })
  method: string;

  @Prop({ type: Object, default: null })
  headers: Record<string, string> | null;

  @Prop({ type: String, default: null })
  body: string | null;

  @Prop({ type: Number, default: 300 })
  intervalSeconds: number;

  @Prop({ type: Number, default: 10_000 })
  timeoutMs: number;

  @Prop({ type: String, default: '200' })
  expectedStatus: string;

  @Prop({ type: String, default: null })
  expectedBodyContains: string | null;

  @Prop({ type: Number, default: 3 })
  failureThreshold: number;

  @Prop({ type: Boolean, default: true, index: true })
  isActive: boolean;

  @Prop({ type: String, enum: ENDPOINT_STATUSES, default: 'UNKNOWN' })
  currentStatus: EndpointStatus;

  @Prop({ type: Number, default: 0 })
  consecutiveFailures: number;

  @Prop({ type: Date, default: null })
  lastCheckedAt: Date | null;
}

export type EndpointDocument = HydratedDocument<Endpoint>;
export const EndpointSchema = SchemaFactory.createForClass(Endpoint);
applyApiJson(EndpointSchema);
