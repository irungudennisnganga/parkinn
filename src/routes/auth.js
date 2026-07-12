const bcrypt = require('bcryptjs')
const { User } = require('../models/User')
const { AuditLog } = require('../models/AuditLog')
const { generateToken, jwtAuth } = require('../middleware/jwtAuth')
const { logger } = require('../utils/logger')

async function audit(action, resource, details, request, status = 'success') {
  try {
    const user = request?.user || {}
    await AuditLog.create({
      userId: user.id || '',
      userEmail: user.email || '',
      action,
      resource,
      details: typeof details === 'string' ? details : JSON.stringify(details),
      ip: request?.ip || '',
      status,
      timestamp: new Date(),
    })
  } catch (_) {}
}

async function authRoutes(app) {
  app.post('/login', async (request, reply) => {
    const { email, password } = request.body

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password required' })
    }

    const user = await User.findOne({ email: email.toLowerCase(), isActive: true })
    if (!user) {
      await audit('login', 'auth', `Failed login attempt for ${email}`, request, 'failure')
      return reply.status(401).send({ error: 'Invalid credentials' })
    }

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      await audit('login', 'auth', `Failed login attempt for ${email}`, request, 'failure')
      return reply.status(401).send({ error: 'Invalid credentials' })
    }

    const token = generateToken(user)
    await audit('login', 'auth', 'User logged in', request, 'success')

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

  app.get('/users', { preHandler: [jwtAuth] }, async (request, reply) => {
    const users = await User.find().select('-password').sort({ createdAt: -1 }).lean()
    return reply.send({ users })
  })

  app.post('/users', { preHandler: [jwtAuth] }, async (request, reply) => {
    const { email, password, fullName, role } = request.body

    if (!email || !password || !fullName) {
      return reply.status(400).send({ error: 'email, password, and fullName required' })
    }

    const existing = await User.findOne({ email: email.toLowerCase() })
    if (existing) {
      return reply.status(409).send({ error: 'A user with that email already exists' })
    }

    const hashed = await bcrypt.hash(password, 10)
    const user = await User.create({
      email: email.toLowerCase(),
      password: hashed,
      fullName,
      role: role === 'admin' ? 'admin' : 'operator',
      isActive: true,
    })

    await audit('user_created', 'users', `Created user ${user.email} (${user.role})`, request)

    return reply.status(201).send({
      success: true,
      user: { id: user._id, email: user.email, fullName: user.fullName, role: user.role, isActive: user.isActive, createdAt: user.createdAt },
    })
  })

  app.patch('/users/:id', { preHandler: [jwtAuth] }, async (request, reply) => {
    const { id } = request.params
    const { role, isActive } = request.body

    const user = await User.findById(id)
    if (!user) {
      return reply.status(404).send({ error: 'User not found' })
    }

    if (role !== undefined) user.role = role
    if (isActive !== undefined) user.isActive = isActive
    await user.save()

    await audit('user_updated', 'users', `Updated user ${user.email}: role=${user.role}, active=${user.isActive}`, request)

    return reply.send({ success: true, user: { id: user._id, email: user.email, fullName: user.fullName, role: user.role, isActive: user.isActive } })
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

    await audit('password_changed', 'auth', 'User changed password', request)

    return reply.send({ success: true, message: 'Password changed successfully' })
  })

  app.get('/audit-logs', { preHandler: [jwtAuth] }, async (request, reply) => {
    const page = parseInt(request.query.page) || 1
    const limit = Math.min(parseInt(request.query.limit) || 50, 200)
    const skip = (page - 1) * limit
    const search = request.query.search || ''
    const action = request.query.action || ''

    const filter = {}
    if (search) {
      filter.$or = [
        { userEmail: { $regex: search, $options: 'i' } },
        { details: { $regex: search, $options: 'i' } },
      ]
    }
    if (action) filter.action = action

    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ])

    return reply.send({ logs, pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: skip + limit < total } })
  })
}

module.exports = { authRoutes }
