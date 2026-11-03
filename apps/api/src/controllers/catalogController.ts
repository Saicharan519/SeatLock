import type { RequestHandler } from 'express';
import type { CatalogService } from '../services/catalogService';
import { AppError } from '../utils/errors';
import {
  createMovieSchema,
  createScreenSchema,
  createShowSchema,
  createTheatreSchema,
  movieKeyParams,
  movieListQuery,
  showListQuery,
  showtimesQuery,
  uuidParams,
} from '../validators/catalog';

/** A malformed id or slug can't match anything, so it's a 404 rather than a 400. */
function parseOr404<T>(
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
  v: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(v);
  if (!parsed.success) throw new AppError('NOT_FOUND', `${what} not found`);
  return parsed.data as T;
}

export function createCatalogController(catalog: CatalogService) {
  const listMovies: RequestHandler = async (req, res) => {
    res.json(await catalog.listMovies(movieListQuery.parse(req.query)));
  };

  const getMovie: RequestHandler = async (req, res) => {
    const { key } = parseOr404(movieKeyParams, req.params, 'Movie');
    res.json({ movie: await catalog.getMovie(key) });
  };

  const showtimes: RequestHandler = async (req, res) => {
    const { key } = parseOr404(movieKeyParams, req.params, 'Movie');
    res.json(await catalog.showtimes(key, showtimesQuery.parse(req.query)));
  };

  const listCities: RequestHandler = async (_req, res) => {
    res.json({ cities: await catalog.listCities() });
  };

  const listShows: RequestHandler = async (req, res) => {
    res.json({ shows: await catalog.listShows(showListQuery.parse(req.query)) });
  };

  const getShow: RequestHandler = async (req, res) => {
    const { id } = parseOr404(uuidParams, req.params, 'Show');
    res.json({ show: await catalog.getShow(id) });
  };

  const seatMap: RequestHandler = async (req, res) => {
    const { id } = parseOr404(uuidParams, req.params, 'Show');
    res.json(await catalog.seatMap(id));
  };

  const createMovie: RequestHandler = async (req, res) => {
    res.status(201).json({ movie: await catalog.createMovie(createMovieSchema.parse(req.body)) });
  };

  const createTheatre: RequestHandler = async (req, res) => {
    res
      .status(201)
      .json({ theatre: await catalog.createTheatre(createTheatreSchema.parse(req.body)) });
  };

  const createScreen: RequestHandler = async (req, res) => {
    const { id } = parseOr404(uuidParams, req.params, 'Theatre');
    res
      .status(201)
      .json({ screen: await catalog.createScreen(id, createScreenSchema.parse(req.body)) });
  };

  const createShow: RequestHandler = async (req, res) => {
    res.status(201).json({ show: await catalog.createShow(createShowSchema.parse(req.body)) });
  };

  return {
    listMovies,
    getMovie,
    showtimes,
    listCities,
    listShows,
    getShow,
    seatMap,
    createMovie,
    createTheatre,
    createScreen,
    createShow,
  };
}
