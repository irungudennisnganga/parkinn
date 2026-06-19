require('dotenv').config()

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),

  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/parking_altura',
  },

  hikcentral: {
    baseUrl: process.env.HIK_BASE_URL || '',
    accessKey: process.env.HIK_ACCESS_KEY || '',
    secretKey: process.env.HIK_SECRET_KEY || '',
    callbackUrl: process.env.HIKCENTRAL_CALLBACK_URL || process.env.MPESA_CALLBACK_URL || '',
    tokenExpiryDays: 7,
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

  floors: {
    residential: (process.env.RESIDENTIAL_FLOORS || '5,6,7,8,9').split(',').map(Number),
    commercial: (process.env.COMMERCIAL_FLOORS || '1,2,3,4').split(',').map(Number),
  },
}
