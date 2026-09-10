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

describe('Pictograms API (private-api)', () => {
  describe('GET /api/pictograms/:locale/:_id', () => {
    it('should return 200 and pictogram data for valid id in Spanish', async () => {
      const response = await request(app).get('/api/pictograms/es/2317')
      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('_id', 2317)
      expect(response.body).toHaveProperty('keywords')
      expect(response.body.keywords.some((k) => k.keyword === 'casa')).toBe(
        true,
      )
    })

    it('should return 200 and pictogram data for valid id in English', async () => {
      const response = await request(app).get('/api/pictograms/en/2317')
      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('_id', 2317)
      expect(response.body).toHaveProperty('keywords')
      expect(response.body.keywords.some((k) => k.keyword === 'house')).toBe(
        true,
      )
    })

    it('should return 404 for non-existent pictogram id', async () => {
      const response = await request(app).get('/api/pictograms/es/999999')
      expect(response.status).toBe(404)
    })
  })

  describe('GET /api/pictograms/:locale/search/:searchText', () => {
    it('should return matching pictograms for keyword search', async () => {
      const response = await request(app).get('/api/pictograms/es/search/casa')
      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBeGreaterThan(0)
      expect(response.body.some((p) => p._id === 2317)).toBe(true)
    })

    it('should return 404 if no pictograms match search text', async () => {
      const response = await request(app).get(
        '/api/pictograms/es/search/inexistentexyz999',
      )
      expect(response.status).toBe(404)
    })
  })

  describe('GET /api/pictograms/types/:_id', () => {
    it('should return types for pictogram id', async () => {
      const response = await request(app).get('/api/pictograms/types/2317')
      expect(response.status).toBe(200)
    })
  })

  describe('GET /api/pictograms/keywords/:locale/:_id', () => {
    it('should return keywords for pictogram in Spanish', async () => {
      const response = await request(app).get(
        '/api/pictograms/keywords/es/2317',
      )
      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('keywords')
      expect(Array.isArray(response.body.keywords)).toBe(true)
      expect(response.body.keywords.some((k) => k.keyword === 'casa')).toBe(
        true,
      )
    })
  })
})
