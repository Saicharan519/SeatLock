import { z } from 'zod';

export const uuidParams = z.object({ id: z.uuid() });

/** A movie is addressed by slug (interstellar) or id. */
export const movieKeyParams = z.object({
  key: z.union([
    z.uuid(),
    z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(120),
  ]),
});

const optionalText = z
  .string()
  .trim()
  .max(100)
  .transform((s) => s || undefined)
  .optional();

const calendarDate = z.iso.date();

export const movieListQuery = z.object({
  city: optionalText,
  genre: optionalText,
  language: optionalText,
  q: optionalText,
});

export const showtimesQuery = z.object({
  city: optionalText,
  /** A calendar day in the app's timezone. Defaults to the first day with shows. */
  date: calendarDate.optional(),
});

export const showListQuery = z.object({
  movieId: z.uuid().optional(),
  city: optionalText,
  date: calendarDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const category = z
  .string()
  .regex(/^[A-Z][A-Z_]{1,19}$/, 'Categories are UPPER_SNAKE_CASE, e.g. CLASSIC or RECLINER');

/**
 * A screen layout. Row labels are single letters (seat labels look like A1..Z99, matching
 * the hold validator), so at most 26 rows and 99 seats per row.
 */
export const layoutSchema = z
  .object({
    rows: z
      .array(
        z.object({
          label: z.string().regex(/^[A-Z]$/, 'Row labels are single letters A-Z'),
          category,
          seats: z.number().int().min(1).max(99),
          aisleAfter: z.array(z.number().int().min(1)).max(10).default([]),
        }),
      )
      .min(1)
      .max(26),
  })
  .superRefine((layout, ctx) => {
    const labels = layout.rows.map((r) => r.label);
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({ code: 'custom', message: 'Row labels must be unique', path: ['rows'] });
    }
    layout.rows.forEach((r, i) => {
      if (r.aisleAfter.some((n) => n >= r.seats)) {
        ctx.addIssue({
          code: 'custom',
          message: `Row ${r.label}: an aisle must come after a seat inside the row`,
          path: ['rows', i, 'aisleAfter'],
        });
      }
    });
    const total = layout.rows.reduce((n, r) => n + r.seats, 0);
    if (total > 600) {
      ctx.addIssue({ code: 'custom', message: 'A screen has at most 600 seats', path: ['rows'] });
    }
  });

const url = z.url({ protocol: /^https?$/ }).max(500);

export const createMovieSchema = z.object({
  /** Derived from the title when omitted */
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slugs are lowercase words joined by hyphens')
    .max(120)
    .optional(),
  title: z.string().trim().min(1).max(200),
  synopsis: z.string().trim().max(4000).default(''),
  genres: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  language: z.string().trim().min(1).max(40),
  durationMinutes: z.number().int().min(1).max(600),
  certificate: z.enum(['U', 'UA', 'A']),
  rating: z.number().min(0).max(10).nullable().default(null),
  director: z.string().trim().max(200).default(''),
  cast: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  posterUrl: url.nullable().default(null),
  backdropUrl: url.nullable().default(null),
  releaseDate: calendarDate,
});

export const createTheatreSchema = z.object({
  name: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(100),
  address: z.string().trim().max(500).default(''),
});

export const createScreenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  layout: layoutSchema,
});

export const createShowSchema = z.object({
  movieId: z.uuid(),
  screenId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  /** Integer paise per category, e.g. { "CLASSIC": 18000, "RECLINER": 45000 } */
  prices: z.record(category, z.number().int().positive().max(10_000_000)),
});

/** "Dune: Part Two" -> "dune-part-two" */
export function slugify(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip accents (combining marks U+0300 to U+036F)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120)
      .replace(/-+$/, '') || 'movie'
  );
}
