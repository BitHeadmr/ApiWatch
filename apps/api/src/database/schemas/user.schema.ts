import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';
import { applyApiJson } from './api-json.js';

@Schema({ collection: 'users', timestamps: { createdAt: true, updatedAt: false } })
export class User {
  @Prop({ type: String, required: true, unique: true, lowercase: true, trim: true })
  email: string;

  /** bcrypt hash. Excluded from queries unless explicitly selected. */
  @Prop({ type: String, required: true, select: false })
  password: string;

  @Prop({ type: Types.ObjectId, ref: 'Team', required: true, index: true })
  teamId: Types.ObjectId;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
applyApiJson(UserSchema);
