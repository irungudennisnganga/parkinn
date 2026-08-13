const bcrypt = require('bcryptjs')
const { User } = require('../models/User')
const { logger } = require('../utils/logger')
const config = require('../config')

async function seedAdmin() {
  const { email, password, fullName } = config.defaultAdmin

  if (!email || !password) {
    logger.info('No DEFAULT_ADMIN_EMAIL/DEFAULT_ADMIN_PASSWORD set — skipping admin seed')
    return null
  }

  const existing = await User.countDocuments()
  if (existing > 0) {
    logger.info({ userCount: existing }, 'Users already exist — skipping admin seed')
    return null
  }

  const hashed = await bcrypt.hash(password, 10)
  const user = await User.create({
    email: email.toLowerCase(),
    password: hashed,
    fullName,
    role: 'admin',
    isActive: true,
  })

  logger.info({ email: user.email }, 'Default admin user seeded')
  return user
}

module.exports = { seedAdmin }
