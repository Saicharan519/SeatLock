import { Router, type RequestHandler } from 'express';
import type { createCatalogController } from '../controllers/catalogController';
import { requireAdmin } from '../middleware/auth';

/** Browsing is public; changing the catalogue is admin-only. */
export function catalogRouter(
  controller: ReturnType<typeof createCatalogController>,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.get('/movies', controller.listMovies);
  router.get('/movies/:key', controller.getMovie);
  router.get('/movies/:key/showtimes', controller.showtimes);
  router.get('/cities', controller.listCities);
  router.get('/shows', controller.listShows);
  router.get('/shows/:id', controller.getShow);
  router.get('/shows/:id/seats', controller.seatMap);

  const admin = [authenticate, requireAdmin];
  router.post('/admin/movies', ...admin, controller.createMovie);
  router.patch('/admin/movies/:id', ...admin, controller.updateMovie);
  router.post('/admin/theatres', ...admin, controller.createTheatre);
  router.post('/admin/theatres/:id/screens', ...admin, controller.createScreen);
  router.post('/admin/shows', ...admin, controller.createShow);
  router.delete('/admin/shows/:id', ...admin, controller.deleteShow);
  return router;
}
