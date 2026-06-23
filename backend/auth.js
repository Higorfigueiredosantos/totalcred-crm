const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const db = require('./db')

const JWT_SECRET = process.env.JWT_SECRET || 'totalcred-jwt-secret-2024'

function getUsers() {
  return db.getState('users') || []
}

function saveUsers(users) {
  db.setState('users', users)
}

function initAdmin() {
  const users = getUsers()
  if (users.some(u => u.email === 'higorluna26@gmail.com')) return
  users.push({
    id: crypto.randomUUID(),
    name: 'Higor Luna',
    email: 'higorluna26@gmail.com',
    passwordHash: bcrypt.hashSync('Pcyes26@', 10),
    role: 'admin',
    permissions: { dispatcher: true, chipsPage: true, settings: true, channelIds: [], chipIds: [] },
    createdAt: new Date().toISOString(),
  })
  saveUsers(users)
  console.log('[Auth] Usuário admin criado: higorluna26@gmail.com')
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  )
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET) } catch { return null }
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autorizado' })
  const payload = verifyToken(header.slice(7))
  if (!payload) return res.status(401).json({ error: 'Token inválido ou expirado' })
  req.user = payload
  next()
}

function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito ao administrador' })
  next()
}

module.exports = { initAdmin, getUsers, saveUsers, signToken, verifyToken, authMiddleware, adminMiddleware }
