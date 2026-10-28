import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import {
  aiParseSchema,
  calculationRequestSchema,
  fuelPriceImportSchema,
  fuelPriceQuerySchema,
  geocodeQuerySchema,
  idParamSchema,
  listQuerySchema,
  routeRequestSchema,
} from '../validation/schemas.js';

/**
 * REST API routes. Express 5 forwards rejected promises from async handlers to
 * the error handler, so controllers can simply throw.
 */
export function createApiRouter({ controllers, limiters, externalQuota }) {
  const { system, routing, calculations, reference, logistics, ai, fuelPrice } = controllers;
  const router = Router();
  // No-op passthroughs when a shared quota is not supplied (e.g. focused unit tests).
  const passthrough = (_req, _res, next) => next();
  const quota = (label) => (externalQuota ? externalQuota.middleware(label) : passthrough);

  router.get('/health', system.health);
  router.get('/config', system.publicConfig);

  router.get('/trucks', reference.trucks);
  router.get('/cargo-types', reference.cargoTypes);
  router.get('/activity', validate(listQuerySchema, 'query'), reference.activity);

  router.get('/geocode', limiters.geocode, quota('geocoding'), validate(geocodeQuerySchema, 'query'), routing.geocode);
  router.post('/routes', limiters.routes, quota('routing'), validate(routeRequestSchema), routing.route);

  router.post('/calculations/estimate', validate(calculationRequestSchema), calculations.estimate);
  router.post('/calculations', validate(calculationRequestSchema), calculations.create);
  router.get('/calculations', validate(listQuerySchema, 'query'), calculations.list);
  router.get('/calculations/:id', validate(idParamSchema, 'params'), calculations.get);
  router.delete('/calculations/:id', validate(idParamSchema, 'params'), calculations.remove);

  // AI "describe shipment" (returns a suggestion only; off until configured)
  router.post('/ai/parse-shipment', limiters.ai, validate(aiParseSchema), ai.parseShipment);

  // Fuel price: shared suggestion (read) + admin import (admin-token protected)
  router.get('/fuel-price', validate(fuelPriceQuerySchema, 'query'), fuelPrice.suggestion);
  router.post('/fuel-price/import', validate(fuelPriceImportSchema), fuelPrice.import);

  // Logistics module (cargo catalog, compatibility, fuel, costs, savings)
  router.get('/logistics/catalog', logistics.catalog);
  router.post('/logistics/compatibility', logistics.compatibility);
  router.post('/logistics/fuel', logistics.fuel);
  router.post('/logistics/transport-cost', logistics.transportCost);
  router.post('/logistics/savings', logistics.savings);

  return router;
}
