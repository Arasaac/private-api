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

describe('Materials API (private-api)', () => {
  describe('GET /api/materials/new/:numItems', () => {
    it('should return recent published materials', async () => {
      const response = await request(app).get('/api/materials/new/10')
      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBeGreaterThan(0)
    })
  })

  describe('GET /api/materials/:id', () => {
    it('should return material data for valid id', async () => {
      const response = await request(app).get('/api/materials/1')
      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('idMaterial', 1)
      expect(response.body).toHaveProperty('translations')
    })

    it('should return 404 for non-existent material id', async () => {
      const response = await request(app).get('/api/materials/999999')
      expect(response.status).toBe(404)
    })
  })

  describe('GET /api/materials/:locale/:searchType/:searchText', () => {
    it('should return materials filtered by activity', async () => {
      const response = await request(app).get('/api/materials/es/activity/10')
      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBeGreaterThan(0)
      expect(
        response.body.some((m) => m.activities && m.activities.includes(10)),
      ).toBe(true)
    })

    it('should return materials filtered by area', async () => {
      const response = await request(app).get('/api/materials/es/area/3')
      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBeGreaterThan(0)
      expect(response.body.some((m) => m.areas && m.areas.includes(3))).toBe(
        true,
      )
    })
  })
})
