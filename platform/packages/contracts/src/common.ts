import { z } from "zod";

export const MAX_SIGNED_64_BIT_MINOR_UNITS = 9_223_372_036_854_775_807n;

export function parseMinorUnits(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error("MONEY_MINOR_UNITS_INVALID");
  }
  const minorUnits = BigInt(value);
  if (minorUnits < 0n || minorUnits > MAX_SIGNED_64_BIT_MINOR_UNITS) {
    throw new Error("MONEY_MINOR_UNITS_INVALID");
  }
  return minorUnits;
}

export const PhoneNumberSchema = z.string().regex(/^\+233[1-9]\d{8}$/);

export const GhanaCardNumberSchema = z.string().regex(/^GHA-\d{9}-\d$/);

export const UuidSchema = z.uuid();

export const MoneyDtoSchema = z
  .strictObject({
    currency: z.literal("GHS"),
    minorUnits: z.string().superRefine((value, context) => {
      try {
        parseMinorUnits(value);
      } catch {
        context.addIssue({
          code: "custom",
          message: "Money minor units must fit signed 64-bit storage",
        });
      }
    }),
  })
  .strict();

export const PaginationSchema = z.strictObject({
  cursor: UuidSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export const ProblemDetailSchema = z.strictObject({
  type: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }),
  title: z.string().min(1).max(120),
  status: z.number().int().min(400).max(599),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  detail: z.string().max(2000).optional(),
  instance: z.string().max(2048).optional(),
  requestId: UuidSchema.optional(),
});

export type PhoneNumber = z.infer<typeof PhoneNumberSchema>;
export type GhanaCardNumber = z.infer<typeof GhanaCardNumberSchema>;
export type Uuid = z.infer<typeof UuidSchema>;
export type MoneyDto = z.infer<typeof MoneyDtoSchema>;
export type Pagination = z.infer<typeof PaginationSchema>;
export type ProblemDetail = z.infer<typeof ProblemDetailSchema>;
