const winston = require('winston');
require('winston-daily-rotate-file');
const config = require('../../config');
const { redactSecretsInText, redactObject } = require('./redaction');

const fmt = winston.format;

const sharedFormat = fmt.combine(
  fmt.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  fmt.errors({ stack: true }),
  fmt.printf(({ timestamp, level, message, ...meta }) => {
    const safeMessage = redactSecretsInText(String(message ?? ''));
    const safeMeta = Object.keys(meta).length ? ' ' + JSON.stringify(redactObject(meta)) : '';
    return `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${safeMessage}${safeMeta}`;
  })
);

const logger = winston.createLogger({
  level: config.bot.logLevel,
  format: sharedFormat,
  transports: [
    new winston.transports.Console({
      format: fmt.combine(
        fmt.colorize(),
        fmt.timestamp({ format: 'HH:mm:ss' }),
        fmt.printf(({ timestamp, level, message }) =>
          `[${timestamp}] ${level} ${redactSecretsInText(String(message ?? ''))}`
        )
      ),
    }),
    new winston.transports.DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '14d',
      maxSize: '20m',
      zippedArchive: true,
    }),
    new winston.transports.DailyRotateFile({
      filename: 'logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '7d',
      maxSize: '50m',
      zippedArchive: true,
    }),
    new winston.transports.DailyRotateFile({
      filename: 'logs/trades-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'info',
      maxFiles: `${Math.max(1, Number(config.bot?.tradeLogRetentionDays || 30))}d`,
      maxSize: `${Math.max(1, Number(config.bot?.tradeLogMaxSizeMb || 20))}m`,
      zippedArchive: true,
      format: fmt.combine(
        fmt.timestamp(),
        fmt.json()
      ),
    }),
  ],
});

module.exports = logger;
