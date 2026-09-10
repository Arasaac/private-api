const request = require('supertest')
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

describe('Categories API (private-api)', () => {
  describe('GET /api/categories/:locale', () => {
    it('should return categories for Spanish (es)', async () => {
      const response = await request(app).get('/api/categories/es')
      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('locale', 'es')
      expect(response.body).toHaveProperty('data')
      expect(typeof response.body.data).toBe('object')
    })

    it('should return categories for English (en)', async () => {
      const response = await request(app).get('/api/categories/en')
      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('locale', 'en')
      expect(response.body).toHaveProperty('data')
    })

    it('should return 404 for non-existent locale', async () => {
      const response = await request(app).get('/api/categories/zz_unknown')
      expect(response.status).toBe(404)
    })
  })
})
