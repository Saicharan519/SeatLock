import { z } from 'zod';

export const showIdParams = z.object({ id: z.uuid() });

export const createShowSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
  venue: z.string().trim().min(1).max(200),
  startsAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  /** Integer paise */
  pricePerSeat: z.number().int().positive().max(10_000_000),
});
