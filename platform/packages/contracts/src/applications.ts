import { z } from "zod";
import { PhoneNumberSchema, UuidSchema } from "./common.js";

export const ApplicationCreateInputSchema = z.strictObject({
  vehicleModelId: UuidSchema,
  repaymentFrequency: z.enum(["WEEKLY", "MONTHLY"]),
  tenureMonths: z.union([
    z.literal(6),
    z.literal(8),
    z.literal(12),
    z.literal(24),
    z.literal(36),
    z.literal(48),
  ]),
});

export const GuarantorInvitationSchema = z.strictObject({
  applicationId: UuidSchema,
  guarantorPhoneNumber: PhoneNumberSchema,
});

export type ApplicationCreateInput = z.infer<
  typeof ApplicationCreateInputSchema
>;
export type GuarantorInvitation = z.infer<typeof GuarantorInvitationSchema>;
