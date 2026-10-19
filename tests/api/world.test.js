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

      // Missing description
      const responseNoDesc = await request(app)
        .post('/api/world')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Centro Test',
          tipo: 'Salud',
          latitude: 40.1,
          longitude: -3.2,
        })
      expect(responseNoDesc.status).toBe(422)
      expect(responseNoDesc.body.message).toContain('description')

      spy.mockRestore()
    })

    it('should return 422 when description exceeds 1800 characters', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const response = await request(app)
        .post('/api/world')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Centro Test',
          tipo: 'Salud',
          description: 'a'.repeat(1801),
          latitude: 40.1,
          longitude: -3.2,
        })

      expect(response.status).toBe(422)
      expect(response.body.message).toContain('1800')
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
        links: [
          { url: 'https://huesca.es', type: 'web' },
          { url: 'https://huesca.es/proyecto', type: 'project' },
          { url: 'https://diariodelaltoaragon.es/noticia', type: 'news' },
        ],
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
      expect(response.body.links).toHaveLength(3)
      expect(response.body.links[1].url).toBe('https://huesca.es/proyecto')
      expect(response.body.links[1].type).toBe('project')
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
          JSON.stringify([
            { url: 'https://bibliotecas.zaragoza.es', type: 'web' },
          ]),
        )
        .attach('images', tempFilePath)

      expect(response.status).toBe(201)
      expect(response.body).toHaveProperty('id')
      const createdId = response.body.id
      expect(response.body.status).toBe(2)
      expect(response.body.name).toBe('Biblioteca Central Pictogramas')
      expect(response.body.links).toHaveLength(1)
      expect(response.body.links[0].url).toBe('https://bibliotecas.zaragoza.es')
      expect(response.body.links[0].type).toBe('web')
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

    it('should return 422 when updating with invalid description or too many photos', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })

      // Empty description
      const resEmptyDesc = await request(app)
        .put('/api/world/3')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ description: '   ' })
      expect(resEmptyDesc.status).toBe(422)

      // Description > 1800 chars
      const resLongDesc = await request(app)
        .put('/api/world/3')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ description: 'a'.repeat(1801) })
      expect(resLongDesc.status).toBe(422)

      // Pictures > 15
      const resTooManyPics = await request(app)
        .put('/api/world/3')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ pictures: Array(16).fill('http://example.com/pic.jpg') })
      expect(resTooManyPics.status).toBe(422)

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

    it('should allow admin to delete location and remove its directory from disk', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      // Create a test directory with a file for location 1
      const testLocDir = path.resolve(MAP_DIR, '1')
      await fs.ensureDir(testLocDir)
      await fs.writeFile(
        path.resolve(testLocDir, 'test_image.jpg'),
        'fake content',
      )
      expect(await fs.pathExists(testLocDir)).toBe(true)

      const response = await request(app)
        .delete('/api/world/1')
        .set('Authorization', `Bearer ${adminToken}`)

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty(
        'message',
        'Location deleted successfully',
      )

      // Verify directory on disk was deleted
      expect(await fs.pathExists(testLocDir)).toBe(false)

      // Verify it no longer exists in DB
      const checkResponse = await request(app).get('/api/world/1')
      expect(checkResponse.status).toBe(404)

      spy.mockRestore()
    })
  })

  describe('FTP file sync and unpublish features', () => {
    it('should dynamically include and remove files placed in MAP_DIR/<id> via FTP as single source of truth', async () => {
      // For location 2 (published), create a file in MAP_DIR/2
      const loc2Dir = path.resolve(MAP_DIR, '2')
      await fs.ensureDir(loc2Dir)
      await fs.writeFile(path.resolve(loc2Dir, 'ftp_photo.jpg'), 'image data')

      const response = await request(app).get('/api/world/2')
      expect(response.status).toBe(200)
      expect(response.body.pictures).toBeDefined()
      expect(
        response.body.pictures.some((p) => p.includes('ftp_photo.jpg')),
      ).toBe(true)

      // Also check GET /api/world
      const allResponse = await request(app).get('/api/world')
      expect(allResponse.status).toBe(200)
      const loc2 = allResponse.body.find((l) => l.id === 2)
      expect(loc2).toBeDefined()
      expect(loc2.pictures.some((p) => p.includes('ftp_photo.jpg'))).toBe(true)

      // Delete file from disk (simulating FTP deletion)
      await fs.remove(path.resolve(loc2Dir, 'ftp_photo.jpg'))

      const afterDeleteRes = await request(app).get('/api/world/2')
      expect(afterDeleteRes.status).toBe(200)
      expect(
        afterDeleteRes.body.pictures.some((p) => p.includes('ftp_photo.jpg')),
      ).toBe(false)

      // Clean up
      await fs.remove(loc2Dir)
    })

    it('should allow admin to unpublish a published location back to pending (status: 2)', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      // Location 2 is published (status: 1). Unpublish it by setting status: 2
      const updateRes = await request(app)
        .put('/api/world/2')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 2 })

      expect(updateRes.status).toBe(200)
      expect(updateRes.body.status).toBe(2)

      // Anonymous users should now NOT see location 2 in GET /api/world
      const anonRes = await request(app).get('/api/world')
      expect(anonRes.body.some((l) => l.id === 2)).toBe(false)

      // Admin CAN see it when requesting status=2
      const adminRes = await request(app)
        .get('/api/world?status=2')
        .set('Authorization', `Bearer ${adminToken}`)
      expect(adminRes.body.some((l) => l.id === 2)).toBe(true)

      // Re-publish it
      await request(app)
        .put('/api/world/2')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 1 })

      spy.mockRestore()
    })

    it('should allow admin to create a location with status 1 (published)', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const emails = require('../../emails')
      const emailSpy = jest
        .spyOn(emails, 'sendApprovedWorldLocationEmail')
        .mockResolvedValue()

      const payload = {
        name: 'Iniciativa Creada por Admin',
        tipo: 'Educación',
        description: 'Creada directamente como publicada',
        latitude: 41.3851,
        longitude: 2.1734,
        status: 1,
        email: 'autor_admin@arasaac.org',
      }

      const res = await request(app)
        .post('/api/world')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload)

      expect(res.status).toBe(201)
      expect(res.body.status).toBe(1)
      expect(emailSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Iniciativa Creada por Admin',
          authorEmail: 'autor_admin@arasaac.org',
        }),
      )

      emailSpy.mockRestore()
      spy.mockRestore()
    })
  })
})
