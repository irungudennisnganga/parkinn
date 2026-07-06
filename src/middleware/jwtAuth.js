const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET || 'parking-altura-jwt-secret-key-2026'

function generateToken(user) {
  return jwt.sign(
    { id: user._id, email: user.email, role: user.role, fullName: user.fullName },
    JWT_SECRET,
    { expiresIn: '12h' }
  )
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET)
}

async function jwtAuth(request, reply) {
  const authHeader = request.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Authorization token required' })
  }
  const token = authHeader.split(' ')[1]
  try {
    const decoded = verifyToken(token)
    request.user = decoded
  } catch (err) {
    return reply.status(401).send({ error: 'Invalid or expired token' })
  }
}

module.exports = { jwtAuth, generateToken, verifyToken, JWT_SECRET }
