'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const path = require('path');

const env = require('./config/env');
const requestContext = require('./middleware/requestContext');
const sanitize = require('./middleware/sanitize');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./modules/auth/auth.routes');
const scorecardRoutes = require('./modules/scorecard/scorecard.routes');
const mastersRoutes = require('./modules/masters/masters.routes');

const app = express();

app.disable('x-powered-by');
app.use(helmet()); // sets standard security headers (XSS filter, no-sniff, frameguard, HSTS, etc.)
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(requestContext);
app.use(sanitize);

if (env.env !== 'test') {
  app.use(morgan(env.env === 'production' ? 'combined' : 'dev'));
}

// Global rate limit — protects the whole API; tighter, action-specific limits can be
// layered on top of individual routes (e.g. /auth/login) if brute-force risk warrants it.
app.use(rateLimit({ windowMs: env.rateLimit.windowMs, max: env.rateLimit.max, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (req, res) => res.json({ success: true, data: { status: 'UP', time: new Date().toISOString() } }));

try {
  const openapiDocument = YAML.load(path.join(__dirname, '..', 'openapi.yaml'));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));
} catch (e) {
  // openapi.yaml is optional for the app to boot (e.g. in unit tests) but required in dev/prod.
  // eslint-disable-next-line no-console
  console.warn('[app] openapi.yaml not loaded — /docs disabled:', e.message);
}

const API_PREFIX = '/api/v1';
app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/score-cards`, scorecardRoutes);
app.use(`${API_PREFIX}/masters`, mastersRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
