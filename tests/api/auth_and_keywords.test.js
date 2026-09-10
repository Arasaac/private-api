const request = require('supertest')
const axios = require('axios')
const jwt = require('jsonwebtoken')
const db = require('../../db')
const { seedDatabase } = require('../seed')
let app

beforeAll(async () => {
  await db.open()
  await seedDatabase()
  app = require('../../privateapi')
})

afterAll(async () => {
  await db.close()
})

describe('API Root and Auth / Keywords (private-api)', () => {
  describe('GET /api', () => {
    it('should return 200 and connection message', async () => {
      const response = await request(app).get('/api')
      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        message: 'Connected to ARASAAC private API',
      })
    })
  })

  describe('GET /api/keywords (Authentication & Role Verification)', () => {
    it('should return 401 Unauthorized when no token is provided', async () => {
      const response = await request(app).get('/api/keywords')
      expect(response.status).toBe(401)
    })

    it('should return 403 Forbidden when token has insufficient role (user role)', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const token = jwt.sign(
        {
          sub: '60d5ec49f1b2c82d88c8888a',
          role: 'user',
        },
        'test_secret',
      )

      const response = await request(app)
        .get('/api/keywords')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(403)
      expect(response.body).toHaveProperty('message', 'Error getting user data')
      spy.mockRestore()
    })

    it('should allow access when user has translator role', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const token = jwt.sign(
        {
          sub: '60d5ec49f1b2c82d88c88889',
          role: 'translator',
          targetLanguages: ['es'],
        },
        'test_secret',
      )

      const response = await request(app)
        .get('/api/keywords')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
      spy.mockRestore()
    })

    it('should allow access when user has admin role', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const token = jwt.sign(
        {
          sub: '60d5ec49f1b2c82d88c88888',
          role: 'admin',
          targetLanguages: ['es', 'en'],
        },
        'test_secret',
      )

      const response = await request(app)
        .get('/api/keywords')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
      spy.mockRestore()
    })
  })
})
