const winston = require('winston');
require('winston-daily-rotate-file');
const config = require('../../config');

const fmt = winston.format;

const sharedFormat = fmt.combine(
  fmt.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  fmt.errors({ stack: true }),
  fmt.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}${metaStr}`;
  })
);

// Detect test/sandbox environment so test runs don't pollute the production log
// with expected-error traces. node --test sets NODE_TEST_CONTEXT; runScriptedTests
// can set BOT_TEST_RUNNER=1 explicitly. Either disables file transports.
const isTestEnvironment = (
  process.env.BOT_TEST_RUNNER === '1'
  || process.env.NODE_ENV === 'test'
  || process.env.NODE_TEST_CONTEXT
  || (typeof process.argv[1] === 'string' && /[/\\]test[/\\][^/\\]+\.test\.js$/.test(process.argv[1]))
);

const fileTransports = isTestEnvironment ? [] : [
  // Rotating error log: keeps 14 days, max 20MB per file
  new winston.transports.DailyRotateFile({
    filename: 'logs/error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    level: 'error',
    maxFiles: '14d',
    maxSize: '20m',
    zippedArchive: true,
  }),
  // Rotating combined log: keeps 7 days, max 50MB per file
  new winston.transports.DailyRotateFile({
    filename: 'logs/combined-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: '7d',
    maxSize: '50m',
    zippedArchive: true,
  }),
  // Rotating trades log: keeps 30 days for analysis
  new winston.transports.DailyRotateFile({
    filename: 'logs/trades-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    level: 'info',
    maxFiles: '30d',
    maxSize: '20m',
    zippedArchive: true,
    format: fmt.combine(
      fmt.timestamp(),
      fmt.json()
    ),
  }),
];

const logger = winston.createLogger({
  level: config.bot.logLevel,
  format: sharedFormat,
  transports: [
    new winston.transports.Console({
      format: fmt.combine(
        fmt.colorize(),
        fmt.timestamp({ format: 'HH:mm:ss' }),
        fmt.printf(({ timestamp, level, message }) =>
          `[${timestamp}] ${level} ${message}`
        )
      ),
    }),
    ...fileTransports,
  ],
});

module.exports = logger;
