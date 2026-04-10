const { v4: uuidv4 } = require('uuid');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function log(level, message, meta = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    env: process.env.NODE_ENV ?? 'development',
    ...meta,
  }));
}

const logger = {
  debug: (msg, meta) => log('debug', msg, meta),
  info:  (msg, meta) => log('info',  msg, meta),
  warn:  (msg, meta) => log('warn',  msg, meta),
  error: (msg, meta) => log('error', msg, meta),

  attachRequestId: (req, _res, next) => {
    req.requestId = uuidv4();
    next();
  },

  tool: (toolName) => (req, res, next) => {
    const start = Date.now();
    const requestId = req.requestId;
    const userId = req.user?.id;

    logger.info('tool.start', { requestId, tool: toolName, userId, path: req.path });

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      logger.info('tool.success', {
        requestId, tool: toolName, userId,
        durationMs: Date.now() - start,
        statusCode: res.statusCode,
      });
      return originalJson(body);
    };

    res.on('finish', () => {
      if (res.statusCode >= 400) {
        logger.error('tool.error', {
          requestId, tool: toolName, userId,
          durationMs: Date.now() - start,
          statusCode: res.statusCode,
        });
      }
    });

    next();
  },
};

module.exports = logger;
