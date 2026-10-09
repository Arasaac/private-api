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

describe('Bug Reports API (private-api)', () => {
  const userToken = jwt.sign(
    {
      sub: '60d5ec49f1b2c82d88c8888a',
      role: 'user',
    },
    'test_secret',
  )

  describe('POST /api/bug-reports', () => {
    it('should return 401 when no token is provided', async () => {
      const response = await request(app).post('/api/bug-reports').send({
        description: 'Algo falla',
      })
      expect(response.status).toBe(401)
    })

    it('should return 400 if user email cannot be resolved', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const unknownUserToken = jwt.sign(
        {
          sub: '60d5ec49f1b2c82d88c88880', // non-existent user
          role: 'user',
        },
        'test_secret',
      )

      const response = await request(app)
        .post('/api/bug-reports')
        .set('Authorization', `Bearer ${unknownUserToken}`)
        .send({
          description: 'Algo falla',
        })

      expect(response.status).toBe(400)
      expect(response.body).toHaveProperty('error', 'User email is required')
      spy.mockRestore()
    })
  })

  describe('POST /api/bug-reports/webhook', () => {
    it('should return 401 if webhook token is invalid', async () => {
      const response = await request(app)
        .post('/api/bug-reports/webhook')
        .send({
          token: 'invalid-token',
        })
      expect(response.status).toBe(401)
      expect(response.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should ignore root post (no root_id)', async () => {
      const response = await request(app)
        .post('/api/bug-reports/webhook')
        .send({
          token: 'test-webhook-token',
          text: 'Mensaje raiz',
        })
      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('status', 'ignored')
    })
  })
})
