const bcrypt = require('bcryptjs')
const { User } = require('../models/User')
const { generateToken, jwtAuth } = require('../middleware/jwtAuth')
const { logger } = require('../utils/logger')

async function authRoutes(app) {
  app.post('/login', async (request, reply) => {
    const { email, password } = request.body

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password required' })
    }

    const user = await User.findOne({ email: email.toLowerCase(), isActive: true })
    if (!user) {
      return reply.status(401).send({ error: 'Invalid credentials' })
    }

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid credentials' })
    }

    const token = generateToken(user)

    return reply.send({
      success: true,
      authToken: token,
      refreshToken: token,
      user: {
        id: user._id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
      },
    })
  })

  app.post('/create-default-user', async (request, reply) => {
    try {
      const existing = await User.countDocuments()
      if (existing > 0) {
        return reply.status(400).send({ error: 'Users already exist. Use admin account to create more.' })
      }

      const { email, password, fullName } = request.body

      if (!email || !password || !fullName) {
        return reply.status(400).send({ error: 'email, password, and fullName required' })
      }

      const hashed = await bcrypt.hash(password, 10)
      const user = await User.create({
        email: email.toLowerCase(),
        password: hashed,
        fullName,
        role: 'admin',
        isActive: true,
      })

      const token = generateToken(user)

      logger.info({ email: user.email }, 'Default admin user created')

      return reply.status(201).send({
        success: true,
        message: 'Default admin user created',
        user: { id: user._id, email: user.email, fullName: user.fullName, role: user.role },
        authToken: token,
      })
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to create default user')
      return reply.status(500).send({ error: 'Failed to create user' })
    }
  })

  app.get('/me', { preHandler: [jwtAuth] }, async (request, reply) => {
    const user = await User.findById(request.user.id).select('-password')
    if (!user) {
      return reply.status(404).send({ error: 'User not found' })
    }
    return reply.send({ user })
  })

  app.post('/change-password', { preHandler: [jwtAuth] }, async (request, reply) => {
    const { currentPassword, newPassword } = request.body
    if (!currentPassword || !newPassword) {
      return reply.status(400).send({ error: 'currentPassword and newPassword required' })
    }

    const user = await User.findById(request.user.id)
    if (!user) {
      return reply.status(404).send({ error: 'User not found' })
    }

    const valid = await bcrypt.compare(currentPassword, user.password)
    if (!valid) {
      return reply.status(401).send({ error: 'Current password is incorrect' })
    }

    user.password = await bcrypt.hash(newPassword, 10)
    await user.save()

    return reply.send({ success: true, message: 'Password changed successfully' })
  })
}

module.exports = { authRoutes }
