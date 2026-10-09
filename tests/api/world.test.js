const path = require('path')
const fs = require('fs-extra')
const request = require('supertest')
const axios = require('axios')
const jwt = require('jsonwebtoken')
const db = require('../../db')
const { seedDatabase } = require('../seed')
const { MAP_DIR } = require('../../utils/constants')
let app

beforeAll(async () => {
  await db.open()
  await seedDatabase()
  app = require('../../privateapi')
})

afterAll(async () => {
  await db.close()
})

describe('World API (private-api)', () => {
  const userToken = jwt.sign(
    {
      sub: '60d5ec49f1b2c82d88c8888a',
      role: 'user',
    },
    'test_secret',
  )

  const adminToken = jwt.sign(
    {
      sub: '60d5ec49f1b2c82d88c88888',
      role: 'admin',
    },
    'test_secret',
  )

  describe('GET /api/world', () => {
    it('should return 200 and list of published locations for anonymous requests', async () => {
      const response = await request(app).get('/api/world')
      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBe(2)
      // All returned locations must have status: 1
      response.body.forEach((loc) => {
        expect(loc.status).toBe(1)
      })
      // Status 2 (pending) should NOT be returned
      const hasPending = response.body.some((loc) => loc.id === 3)
      expect(hasPending).toBe(false)
    })

    it('should filter locations by tipo', async () => {
      const response = await request(app).get('/api/world?tipo=Colegio')
      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBe(2)
      response.body.forEach((loc) => {
        expect(loc.tipo).toBe('Colegio')
      })
    })

    it('should filter locations by text search', async () => {
      const response = await request(app).get('/api/world?search=Gabriel')
      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBe(1)
      expect(response.body[0].name).toContain('Gabriel')
    })

    it('should filter locations by country', async () => {
      const response = await request(app).get(
        '/api/world?country=' + encodeURIComponent('España'),
      )
      expect(response.status).toBe(200)
      expect(response.body.length).toBeGreaterThan(0)
      expect(response.body[0].address.country).toBe('España')
    })

    it('should allow admin to query pending locations by status', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const response = await request(app)
        .get('/api/world?status=2')
        .set('Authorization', `Bearer ${adminToken}`)

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBe(1)
      expect(response.body[0].id).toBe(3)
      expect(response.body[0].status).toBe(2)
      spy.mockRestore()
    })
  })

  describe('GET /api/world/:id', () => {
    it('should return location for valid published id', async () => {
      const response = await request(app).get('/api/world/1')
      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('id', 1)
      expect(response.body).toHaveProperty(
        'name',
        'C.F.I. Gabriel Pérez Cárcel',
      )
      expect(response.body).toHaveProperty('location')
      expect(response.body.location.coordinates).toEqual([
        -1.1207346, 37.9745102,
      ])
    })

    it('should return 404 for non-existent id', async () => {
      const response = await request(app).get('/api/world/999999')
      expect(response.status).toBe(404)
    })

    it('should return 404 for pending location when accessed anonymously', async () => {
      const response = await request(app).get('/api/world/3')
      expect(response.status).toBe(404)
    })

    it('should return pending location when accessed by admin', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const response = await request(app)
        .get('/api/world/3')
        .set('Authorization', `Bearer ${adminToken}`)

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('id', 3)
      expect(response.body).toHaveProperty('status', 2)
      spy.mockRestore()
    })
  })

  describe('POST /api/world', () => {
    it('should return 401 when no token is provided', async () => {
      const response = await request(app).post('/api/world').send({
        name: 'Nuevo Centro',
        tipo: 'Colegio',
        latitude: 40.4168,
        longitude: -3.7038,
      })
      expect(response.status).toBe(401)
    })

    it('should return 422 when required fields are missing', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const response = await request(app)
        .post('/api/world')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          description: 'Sin nombre ni tipo',
        })

      expect(response.status).toBe(422)
      expect(response.body).toHaveProperty('message')
      spy.mockRestore()
    })

    it('should create new location with status 2 (pending) for regular user', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const payload = {
        name: 'Hospital San Jorge - Señalética',
        tipo: 'Hospital',
        description: 'Adaptación con pictogramas de ARASAAC en urgencias',
        latitude: 42.1321,
        longitude: -0.4087,
        address: {
          address: 'Avenida Martínez de Velasco 36',
          postalCode: '22004',
          city: 'Huesca',
          province: 'Huesca',
          country: 'España',
        },
        links: {
          mainWeb: 'https://huesca.es',
          proyectWeb: 'https://huesca.es/proyecto',
          urlNews: 'https://diariodelaltoaragon.es/noticia',
        },
        picture: 'https://static.arasaac.org/map/hospital_1.jpg',
        pictures: ['https://static.arasaac.org/map/hospital_1.jpg'],
        video: 'https://youtube.com/watch?v=123456',
        email: 'contacto@hospital.es',
      }

      const response = await request(app)
        .post('/api/world')
        .set('Authorization', `Bearer ${userToken}`)
        .send(payload)

      expect(response.status).toBe(201)
      expect(response.body).toHaveProperty('id')
      expect(response.body.id).toBe(4) // sequential after 3
      expect(response.body.status).toBe(2) // pending review
      expect(response.body.name).toBe(payload.name)
      expect(response.body.location.coordinates).toEqual([-0.4087, 42.1321])
      expect(response.body.links.proyectWeb).toBe(payload.links.proyectWeb)
      expect(response.body.author).toBe('60d5ec49f1b2c82d88c8888a')
      spy.mockRestore()
    })

    it('should create new location via multipart/form-data with attached image file', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const tempFilePath = path.resolve(__dirname, '../fixtures/test_image.jpg')
      await fs.writeFile(tempFilePath, 'dummy-image-content')

      const response = await request(app)
        .post('/api/world')
        .set('Authorization', `Bearer ${userToken}`)
        .field('name', 'Biblioteca Central Pictogramas')
        .field('tipo', 'Cultura')
        .field('latitude', '41.6561')
        .field('longitude', '-0.8773')
        .field('description', 'Señalización de la biblioteca con pictogramas')
        .field(
          'address',
          JSON.stringify({
            city: 'Zaragoza',
            country: 'España',
          }),
        )
        .field(
          'links',
          JSON.stringify({
            mainWeb: 'https://bibliotecas.zaragoza.es',
          }),
        )
        .attach('images', tempFilePath)

      expect(response.status).toBe(201)
      expect(response.body).toHaveProperty('id')
      const createdId = response.body.id
      expect(response.body.status).toBe(2)
      expect(response.body.name).toBe('Biblioteca Central Pictogramas')
      expect(response.body.pictures.length).toBe(1)
      expect(response.body.pictures[0]).toBe(
        `https://static.arasaac.org/map/${createdId}/test_image.jpg`,
      )
      expect(response.body.picture).toBe(
        `https://static.arasaac.org/map/${createdId}/test_image.jpg`,
      )

      // Verify file was saved in MAP_DIR / createdId
      const savedFilePath = path.resolve(
        MAP_DIR,
        String(createdId),
        'test_image.jpg',
      )
      expect(await fs.pathExists(savedFilePath)).toBe(true)

      // Clean up test files
      await fs.remove(path.resolve(MAP_DIR, String(createdId)))
      await fs.remove(tempFilePath)

      spy.mockRestore()
    })
  })

  describe('PUT /api/world/:id', () => {
    it('should return 401 when no token is provided', async () => {
      const response = await request(app)
        .put('/api/world/3')
        .send({ status: 1 })
      expect(response.status).toBe(401)
    })

    it('should return 403 when user is not admin', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const response = await request(app)
        .put('/api/world/3')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ status: 1 })

      expect(response.status).toBe(403)
      spy.mockRestore()
    })

    it('should allow admin to update and approve location', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const response = await request(app)
        .put('/api/world/3')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          status: 1, // approve
          description: 'Descripción actualizada y aprobada',
        })

      expect(response.status).toBe(200)
      expect(response.body.id).toBe(3)
      expect(response.body.status).toBe(1)
      expect(response.body.description).toBe(
        'Descripción actualizada y aprobada',
      )

      // Now location 3 should be visible anonymously in GET /api/world
      const publicResponse = await request(app).get('/api/world/3')
      expect(publicResponse.status).toBe(200)
      expect(publicResponse.body.status).toBe(1)

      spy.mockRestore()
    })

    it('should return 404 when updating non-existent location', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const response = await request(app)
        .put('/api/world/999999')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 1 })

      expect(response.status).toBe(404)
      spy.mockRestore()
    })
  })

  describe('DELETE /api/world/:id', () => {
    it('should return 401 when no token is provided', async () => {
      const response = await request(app).delete('/api/world/1')
      expect(response.status).toBe(401)
    })

    it('should return 403 when user is not admin', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const response = await request(app)
        .delete('/api/world/1')
        .set('Authorization', `Bearer ${userToken}`)

      expect(response.status).toBe(403)
      spy.mockRestore()
    })

    it('should allow admin to delete location', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const response = await request(app)
        .delete('/api/world/1')
        .set('Authorization', `Bearer ${adminToken}`)

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty(
        'message',
        'Location deleted successfully',
      )

      // Verify it no longer exists
      const checkResponse = await request(app).get('/api/world/1')
      expect(checkResponse.status).toBe(404)

      spy.mockRestore()
    })
  })
})
