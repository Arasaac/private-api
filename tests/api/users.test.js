const request = require('supertest')
const axios = require('axios')
const jwt = require('jsonwebtoken')
const db = require('../../db')
const User = require('../../models/User')
const Material = require('../../models/Material')
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

describe('Users API (private-api)', () => {
  describe('DELETE /api/users/:id', () => {
    it('should return 401 when no token is provided', async () => {
      const response = await request(app).delete(
        '/api/users/60d5ec49f1b2c82d88c8888a',
      )
      expect(response.status).toBe(401)
    })

    it('should return 403 when user tries to delete another user account', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const token = jwt.sign(
        {
          sub: '60d5ec49f1b2c82d88c8888a',
          role: 'user',
        },
        'test_secret',
      )

      const response = await request(app)
        .delete('/api/users/60d5ec49f1b2c82d88c88889')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(403)
      spy.mockRestore()
    })

    it('should return 404 when user does not exist', async () => {
      const nonExistentId = '60d5ec49f1b2c82d88c88999'
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const token = jwt.sign(
        {
          sub: nonExistentId,
          role: 'user',
        },
        'test_secret',
      )

      const response = await request(app)
        .delete(`/api/users/${nonExistentId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(404)
      spy.mockRestore()
    })

    it('should completely delete user when user has NO associated materials', async () => {
      // 60d5ec49f1b2c82d88c8888a has no materials
      const userId = '60d5ec49f1b2c82d88c8888a'
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const token = jwt.sign(
        {
          sub: userId,
          role: 'user',
        },
        'test_secret',
      )

      const response = await request(app)
        .delete(`/api/users/${userId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('deleted', true)

      // Verify user is removed from database
      const userInDb = await User.findById(userId)
      expect(userInDb).toBeNull()

      spy.mockRestore()
    })

    it('should deactivate user when user HAS associated materials', async () => {
      // Create a user with a material
      const authorUser = await User.create({
        name: 'Author User',
        email: 'author_with_materials@arasaac.org',
        password: 'password123',
        role: 'user',
        active: true,
      })
      const authorId = authorUser._id.toString()

      await Material.create({
        idMaterial: 9999,
        activities: [1],
        areas: [1],
        status: 1,
        authors: [{ author: authorUser._id, role: 'author' }],
      })

      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const token = jwt.sign(
        {
          sub: authorId,
          role: 'user',
        },
        'test_secret',
      )

      const response = await request(app)
        .delete(`/api/users/${authorId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('deactivated', true)
      expect(response.body.materialsCount).toBeGreaterThan(0)

      // Verify user still exists in DB but is deactivated
      const userInDb = await User.findById(authorId)
      expect(userInDb).not.toBeNull()
      expect(userInDb.active).toBe(false)
      expect(userInDb.password).toBe('')
      expect(userInDb.verifyToken).toBe('DELETED')
      expect(userInDb.name).toBe('Author User') // name preserved for author credits

      spy.mockRestore()
    })
  })

  describe('GET /api/users', () => {
    it('should return 401 when no token is provided', async () => {
      const response = await request(app).get('/api/users')
      expect(response.status).toBe(401)
    })

    it('should return 403 when user is not an admin', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const token = jwt.sign(
        {
          sub: '60d5ec49f1b2c82d88c8888a',
          role: 'user',
        },
        'test_secret',
      )

      const response = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(403)
      spy.mockRestore()
    })

    it('should return paginated users for admin with total, data, page, and limit', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const token = jwt.sign(
        {
          sub: '60d5ec49f1b2c82d88c88888',
          role: 'admin',
        },
        'test_secret',
      )

      const response = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('total')
      expect(response.body).toHaveProperty('data')
      expect(Array.isArray(response.body.data)).toBe(true)
      expect(response.body).toHaveProperty('page', 1)
      expect(response.body).toHaveProperty('limit', 50)
      expect(response.body.total).toBeGreaterThanOrEqual(3)

      // Ensure sensitive fields are excluded
      const firstUser = response.body.data[0]
      expect(firstUser).not.toHaveProperty('password')
      expect(firstUser).not.toHaveProperty('authToken')
      expect(firstUser).not.toHaveProperty('google')
      expect(firstUser).not.toHaveProperty('facebook')
      expect(firstUser).toHaveProperty('name')
      expect(firstUser).toHaveProperty('email')

      spy.mockRestore()
    })

    it('should paginate correctly with limit and page', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const token = jwt.sign(
        {
          sub: '60d5ec49f1b2c82d88c88888',
          role: 'admin',
        },
        'test_secret',
      )

      const responsePage1 = await request(app)
        .get('/api/users?page=1&limit=1')
        .set('Authorization', `Bearer ${token}`)

      expect(responsePage1.status).toBe(200)
      expect(responsePage1.body.data.length).toBe(1)
      expect(responsePage1.body.page).toBe(1)
      expect(responsePage1.body.limit).toBe(1)

      const responsePage2 = await request(app)
        .get('/api/users?page=2&limit=1')
        .set('Authorization', `Bearer ${token}`)

      expect(responsePage2.status).toBe(200)
      expect(responsePage2.body.data.length).toBe(1)
      expect(responsePage2.body.page).toBe(2)
      expect(responsePage2.body.limit).toBe(1)
      expect(responsePage1.body.data[0]._id).not.toBe(
        responsePage2.body.data[0]._id,
      )

      spy.mockRestore()
    })

    it('should filter users by search term in name or email', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const token = jwt.sign(
        {
          sub: '60d5ec49f1b2c82d88c88888',
          role: 'admin',
        },
        'test_secret',
      )

      // Search by email substring
      const response = await request(app)
        .get('/api/users?search=translator@arasaac.org')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body.total).toBe(1)
      expect(response.body.data[0].email).toBe('translator@arasaac.org')

      // Search by name substring
      const responseName = await request(app)
        .get('/api/users?search=Admin')
        .set('Authorization', `Bearer ${token}`)

      expect(responseName.status).toBe(200)
      expect(responseName.body.total).toBe(1)
      expect(responseName.body.data[0].name).toBe('Admin User')

      spy.mockRestore()
    })

    it('should filter users by role', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const token = jwt.sign(
        {
          sub: '60d5ec49f1b2c82d88c88888',
          role: 'admin',
        },
        'test_secret',
      )

      const response = await request(app)
        .get('/api/users?role=translator')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body.total).toBe(1)
      expect(response.body.data[0].role).toBe('translator')

      spy.mockRestore()
    })

    it('should sort users by specified field and direction', async () => {
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      const token = jwt.sign(
        {
          sub: '60d5ec49f1b2c82d88c88888',
          role: 'admin',
        },
        'test_secret',
      )

      const responseAsc = await request(app)
        .get('/api/users?sort=name&direction=asc')
        .set('Authorization', `Bearer ${token}`)

      expect(responseAsc.status).toBe(200)
      const namesAsc = responseAsc.body.data.map((u) => u.name)

      const responseDesc = await request(app)
        .get('/api/users?sort=name&direction=desc')
        .set('Authorization', `Bearer ${token}`)

      expect(responseDesc.status).toBe(200)
      const namesDesc = responseDesc.body.data.map((u) => u.name)

      expect(namesAsc[0]).not.toBe(namesDesc[0])

      spy.mockRestore()
    })
  })
})
