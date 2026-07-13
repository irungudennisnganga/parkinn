const Redis = require('ioredis')
const config = require('./index')
const { logger } = require('../utils/logger')

let redis = null

function getRedis() {
  if (!config.redis.enabled) return null
  if (redis) return redis

  try {
    redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) return null
        return Math.min(times * 200, 2000)
      },
      lazyConnect: true,
    })

    redis.on('connect', () => logger.info('Redis connected'))
    redis.on('error', (err) => logger.warn({ err: err.message }, 'Redis connection error'))
    redis.on('close', () => { redis = null; logger.warn('Redis connection closed') })

    redis.connect().catch(() => {
      redis = null
      logger.warn('Redis unavailable — running without cache')
    })
  } catch (err) {
    redis = null
    logger.warn({ err: err.message }, 'Redis init failed — running without cache')
  }

  return redis
}

async function closeRedis() {
  if (redis) {
    try { await redis.quit() } catch (_) {}
    redis = null
  }
}

module.exports = { getRedis, closeRedis }
