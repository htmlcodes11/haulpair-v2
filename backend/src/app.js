import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { pinoHttp } from 'pino-http';

import { createAiController } from './controllers/aiController.js';
import { createFuelPriceController } from './controllers/fuelPriceController.js';
import { createCalculationController } from './controllers/calculationController.js';
import { createLogisticsController } from './controllers/logisticsController.js';
import { createReferenceDataController } from './controllers/referenceDataController.js';
import { createRoutingController } from './controllers/routingController.js';
import { createSystemController } from './controllers/systemController.js';
import { createAccessControl, createCsrfGuard } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createRateLimiters, securityHeaders } from './middleware/security.js';
import { createApiRouter } from './routes/index.js';
import { createActivityService } from './services/activityService.js';
import { createCalculationService } from './services/calculationService.js';
import { createExternalQuota } from './services/externalQuota.js';
import { createGeminiClient } from './services/ai/geminiClient.js';
import { createShipmentAiService } from './services/ai/shipmentParser.js';

/** Build the Gemini client when AI is ready; otherwise null (service throws AI_DISABLED, no call). */
function buildAiClient(ai) {
  if (!ai.ready) return null;
  return createGeminiClient({ apiKey: ai.apiKey, model: ai.model, baseUrl: ai.baseUrl, timeoutMs: ai.timeoutMs });
}
import { createFuelPriceService } from './services/fuelPrice/fuelPriceService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(here, '../../frontend');
const require = createRequire(import.meta.url);
const LEAFLET_DIST = path.dirname(require.resolve('leaflet/dist/leaflet.css'));
const { version } = require('../../package.json');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Build the Express application from explicit dependencies, so tests can
 * substitute repositories and providers without network or database access.
 *
 * deps: { healthRepository, referenceDataRepository, calculationRepository,
 *         activityRepository, routingService, geocodingService }
 */
export function createApp({ config, logger, deps }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      // Log only what is needed to operate the service: no IPs, headers, or query strings
      // (location searches can contain addresses).
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, path: req.url?.split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => !req.url.startsWith('/api/') },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );

  app.use(securityHeaders(config.map));

  const limiters = createRateLimiters(config.rateLimit);

  // Access protection covers the whole app (static frontend + API), except the
  // minimal public health check. A pass-through when auth is disabled (dev).
  app.use(createAccessControl({ auth: config.auth, authLimiter: limiters.auth }));

  app.use(express.json({ limit: '32kb', strict: true }));
  // CSRF defence for state-changing /api requests once shared credentials exist.
  app.use('/api', createCsrfGuard({ auth: config.auth }));

  const externalQuota = createExternalQuota(config.external);
  // AI has its own small daily budget (default 50/day), sharing the concurrency ceiling.
  const aiQuota = createExternalQuota({ dailyMax: config.ai.dailyMax, maxConcurrent: config.external.maxConcurrent });

  const activityService = createActivityService({ activityRepository: deps.activityRepository, logger });
  const calculationService = createCalculationService({
    calculationRepository: deps.calculationRepository,
    referenceDataRepository: deps.referenceDataRepository,
    activityService,
    routeTokenSecret: config.routing.tokenSecret,
  });

  const controllers = {
    system: createSystemController({
      config,
      healthRepository: deps.healthRepository,
      routingService: deps.routingService,
      geocodingService: deps.geocodingService,
      version,
      startedAt: Date.now(),
    }),
    routing: createRoutingController({
      routingService: deps.routingService,
      geocodingService: deps.geocodingService,
      activityService,
    }),
    calculations: createCalculationController({ calculationService }),
    reference: createReferenceDataController({ referenceDataRepository: deps.referenceDataRepository, activityService }),
    logistics: createLogisticsController(),
    ai: createAiController({
      shipmentAiService: createShipmentAiService({
        config: config.ai,
        getGrainTypes: async () => (await deps.referenceDataRepository.listCargoTypes()).map((c) => c.code),
        // Real client only for the selected, ready provider; otherwise the service
        // throws AI_DISABLED before any provider call. Tests inject a fake callModel.
        callModel: deps.aiCallModel ?? buildAiClient(config.ai) ?? undefined,
        quota: aiQuota,
      }),
      activityService,
      maxInputChars: config.ai.maxInputChars,
    }),
    fuelPrice: createFuelPriceController({
      fuelPriceService: createFuelPriceService({ config: config.fuelPrice, fuelPriceRepository: deps.fuelPriceRepository }),
      fuelPriceRepository: deps.fuelPriceRepository,
      activityService,
      adminToken: config.fuelPrice.adminToken,
    }),
  };

  app.use('/api', limiters.api, (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', createApiRouter({ controllers, limiters, externalQuota }));
  app.use('/api', notFoundHandler);

  app.use('/vendor/leaflet', express.static(LEAFLET_DIST, { maxAge: '7d', index: false }));
  app.use(express.static(FRONTEND_DIR, { maxAge: config.isProduction ? '1h' : 0, index: 'index.html' }));

  app.use(errorHandler);
  return app;
}
