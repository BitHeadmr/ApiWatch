import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Schema as MongooseSchema, type Types } from 'mongoose';
import { FAILURE_REASONS, type FailureReason } from '../../checker/types.js';

export const INCIDENT_STATUSES = ['OPEN', 'RESOLVED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** Why an incident ended. PAUSED means monitoring was stopped, not that the API recovered. */
export const INCIDENT_RESOLUTIONS = ['RECOVERED', 'PAUSED'] as const;
export type IncidentResolution = (typeof INCIDENT_RESOLUTIONS)[number];

@Schema({ collection: 'incidents' })
export class Incident {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Team', required: true })
  teamId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Endpoint', required: true })
  endpointId: Types.ObjectId;

  /** Snapshot at the time of the incident, so the log reads sensibly after a rename. */
  @Prop({ type: String, required: true })
  endpointName: string;

  @Prop({ type: String, enum: INCIDENT_STATUSES, default: 'OPEN' })
  status: IncidentStatus;

  /** Failure type of the check that tripped the threshold. */
  @Prop({ type: String, enum: FAILURE_REASONS, default: null })
  reason: FailureReason | null;

  @Prop({ type: String, default: null })
  errorMessage: string | null;

  @Prop({ type: Number, default: 0 })
  consecutiveFailures: number;

  /** First failing check of the streak: when the outage actually began. */
  @Prop({ type: Date, required: true })
  startedAt: Date;

  /** When the failure threshold was crossed (this is when alerts fire). */
  @Prop({ type: Date, required: true })
  detectedAt: Date;

  @Prop({ type: Date, default: null })
  resolvedAt: Date | null;

  @Prop({ type: String, enum: INCIDENT_RESOLUTIONS, default: null })
  resolution: IncidentResolution | null;

  /**
   * Set to the endpoint's id while the incident is OPEN and removed when it resolves.
   * Together with the unique sparse index below it guarantees at most one open incident
   * per endpoint, even when two workers race. (A partial index would say the same thing,
   * but sparse unique works on every MongoDB-compatible server.)
   */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: undefined })
  openFor?: Types.ObjectId;
}

export type IncidentDocument = HydratedDocument<Incident>;
export const IncidentSchema = SchemaFactory.createForClass(Incident);

IncidentSchema.index({ openFor: 1 }, { unique: true, sparse: true });
IncidentSchema.index({ teamId: 1, status: 1, startedAt: -1 });
IncidentSchema.index({ endpointId: 1, startedAt: -1 });

// Untyped view of the schema so the JSON transform can reshape the plain output object.
const untyped = IncidentSchema as unknown as MongooseSchema;
untyped.set('versionKey', false);
untyped.set('toJSON', {
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.openFor; // internal bookkeeping
    const started = (ret.startedAt as Date).getTime();
    const ended = ret.resolvedAt ? (ret.resolvedAt as Date).getTime() : Date.now();
    ret.durationMs = Math.max(0, ended - started); // live while the incident is still open
    return ret;
  },
});
