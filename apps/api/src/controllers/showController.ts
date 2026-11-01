import type { RequestHandler } from 'express';
import { AppError } from '../utils/errors';
import type { ShowService } from '../services/showService';
import { createShowSchema, showIdParams } from '../validators/shows';

/** A malformed id can't match any show, so it's a 404 rather than a 400. */
function parseShowId(params: unknown): string {
  const parsed = showIdParams.safeParse(params);
  if (!parsed.success) throw new AppError('NOT_FOUND', 'Show not found');
  return parsed.data.id;
}

export function createShowController(shows: ShowService) {
  const list: RequestHandler = async (_req, res) => {
    res.json({ shows: await shows.listUpcoming() });
  };

  const get: RequestHandler = async (req, res) => {
    res.json({ show: await shows.get(parseShowId(req.params)) });
  };

  const seatMap: RequestHandler = async (req, res) => {
    res.json(await shows.seatMap(parseShowId(req.params)));
  };

  const create: RequestHandler = async (req, res) => {
    res.status(201).json({ show: await shows.create(createShowSchema.parse(req.body)) });
  };

  return { list, get, seatMap, create };
}
