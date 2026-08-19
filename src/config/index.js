require('dotenv').config()

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),

  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/parking_altura',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    enabled: process.env.REDIS_ENABLED !== 'false',
  },

  hikcentral: {
    baseUrl: process.env.HIK_BASE_URL || '',
    accessKey: process.env.HIK_ACCESS_KEY || '',
    secretKey: process.env.HIK_SECRET_KEY || '',
    callbackUrl: process.env.HIKCENTRAL_CALLBACK_URL || process.env.MPESA_CALLBACK_URL || '',
    insecure: process.env.HIK_INSECURE !== 'false',
    tokenExpiryDays: 7,
    timeOffsetMs: parseInt(process.env.HIKCENTRAL_TIME_OFFSET_MINUTES || '0', 10) * 60 * 1000,
  },

  mpesa: {
    consumerKey: process.env.MPESA_CONSUMER_KEY || '',
    consumerSecret: process.env.MPESA_CONSUMER_SECRET || '',
    passkey: process.env.MPESA_PASSKEY || '',
    shortCode: process.env.MPESA_SHORTCODE || '174379',
    callbackUrl: process.env.MPESA_CALLBACK_URL || '',
    partyB: process.env.MPESA_PARTY_B || '174379',
  },

  payment: {
    defaultRatePerHour: parseInt(process.env.DEFAULT_RATE_PER_HOUR || '100', 10),
    defaultGraceMinutes: parseInt(process.env.DEFAULT_GRACE_MINUTES || '15', 10),
  },

  cache: {
    activeSessionsTTL: parseInt(process.env.CACHE_ACTIVE_SESSIONS_TTL || '30', 10),
    dashboardStatsTTL: parseInt(process.env.CACHE_DASHBOARD_TTL || '60', 10),
  },

  reconciliation: {
    intervalMs: parseInt(process.env.RECONCILE_INTERVAL_MS || '60000', 10),
    cleanupIntervalMs: parseInt(process.env.STALE_CLEANUP_INTERVAL_MS || '60000', 10),
  },

  floors: {
    residential: (process.env.RESIDENTIAL_FLOORS || '5,6,7,8,9').split(',').map(Number),
    commercial: (process.env.COMMERCIAL_FLOORS || '1,2,3,4').split(',').map(Number),
  },

  defaultAdmin: {
    email: process.env.DEFAULT_ADMIN_EMAIL || 'hob@swanfacilities.com',
    password: process.env.DEFAULT_ADMIN_PASSWORD || '12345678',
    fullName: process.env.DEFAULT_ADMIN_FULL_NAME || 'Administrator',
  },
}
