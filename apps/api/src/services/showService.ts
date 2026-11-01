import type { Pool } from 'pg';
import { insertSeatsForShow, withTransaction } from '@seatlock/db';
import * as shows from '../repositories/showRepository';
import { AppError } from '../utils/errors';

export interface PublicShow {
  id: string;
  title: string;
  description: string;
  venue: string;
  startsAt: string;
  pricePerSeat: number;
}

const toPublicShow = (s: shows.ShowRow): PublicShow => ({
  id: s.id,
  title: s.title,
  description: s.description,
  venue: s.venue,
  startsAt: s.starts_at.toISOString(),
  pricePerSeat: s.price_per_seat,
});

export function createShowService(pool: Pool) {
  return {
    async listUpcoming(): Promise<PublicShow[]> {
      return (await shows.listUpcomingShows(pool)).map(toPublicShow);
    },

    async get(id: string): Promise<PublicShow> {
      const show = await shows.findShowById(pool, id);
      if (!show) throw new AppError('NOT_FOUND', 'Show not found');
      return toPublicShow(show);
    },

    async seatMap(id: string) {
      const seats = await shows.getSeatMap(pool, id);
      // Every show has 50 seats, so no rows means no show
      if (seats.length === 0) throw new AppError('NOT_FOUND', 'Show not found');
      return { showId: id, seats };
    },

    /** Creates the show and its 50 seats in one transaction. */
    async create(input: {
      title: string;
      description: string;
      venue: string;
      startsAt: Date;
      pricePerSeat: number;
    }) {
      if (input.startsAt.getTime() <= Date.now()) {
        throw new AppError('VALIDATION_ERROR', 'startsAt must be in the future');
      }
      return withTransaction(pool, async (client) => {
        const show = await shows.insertShow(client, input);
        const seatCount = await insertSeatsForShow(client, show.id);
        return { ...toPublicShow(show), seatCount };
      });
    },
  };
}

export type ShowService = ReturnType<typeof createShowService>;
