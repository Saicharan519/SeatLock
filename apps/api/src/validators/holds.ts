import { z } from 'zod';

const seatLabel = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][1-9]\d?$/, 'Seat labels look like A1 or E10');

export function createHoldSchema(maxSeats: number) {
  return z.object({
    showId: z.uuid(),
    seats: z
      .array(seatLabel)
      .min(1)
      .max(maxSeats, `At most ${maxSeats} seats per hold`)
      .refine((labels) => new Set(labels).size === labels.length, 'Duplicate seat labels')
      // Order doesn't change the request, so ["A2","A1"] and ["A1","A2"] hash the same
      .transform((labels) => [...labels].sort()),
  });
}

export const bookingIdParams = z.object({ bookingId: z.uuid() });
