import type { Schema } from 'mongoose';

/** Makes documents serialise as { id, ... } with no _id or __v, matching the REST API shape. */
export function applyApiJson(schema: Schema) {
  schema.set('versionKey', false);
  schema.set('toJSON', {
    transform: (_doc, ret: Record<string, unknown>) => {
      ret.id = String(ret._id);
      delete ret._id;
      return ret;
    },
  });
}
