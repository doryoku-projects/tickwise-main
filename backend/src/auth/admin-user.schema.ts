import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'admin_users',
  timestamps: true,
})
export class AdminUser {
  @Prop({ type: String, required: true, unique: true, lowercase: true, trim: true })
  email!: string;

  /** `salt:hash` hex pair produced by node:crypto scrypt. Never the raw password. */
  @Prop({ type: String, required: true })
  passwordHash!: string;

  @Prop({ type: String, default: 'admin' })
  role!: string;

  @Prop({ type: Date })
  lastLoginAt?: Date;
}

export type AdminUserDocument = HydratedDocument<AdminUser>;
export const AdminUserSchema = SchemaFactory.createForClass(AdminUser);
// The unique index on `email` comes from `@Prop({ unique: true })` above. Declaring it a
// second time here made Mongoose warn "Duplicate schema index" at every boot (same index).
