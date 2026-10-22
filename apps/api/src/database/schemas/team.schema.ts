import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { applyApiJson } from './api-json.js';

@Schema({ collection: 'teams', timestamps: { createdAt: true, updatedAt: false } })
export class Team {
  @Prop({ type: String, required: true, trim: true })
  name: string;
}

export type TeamDocument = HydratedDocument<Team>;
export const TeamSchema = SchemaFactory.createForClass(Team);
applyApiJson(TeamSchema);
