const request = require('supertest')
const jwt = require('jsonwebtoken')
const axios = require('axios')
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

describe('AI API (private-api proxy)', () => {
  const userToken = jwt.sign(
    {
      sub: '60d5ec49f1b2c82d88c8888a',
      role: 'user',
    },
    'test_secret',
  )

  let originalFetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  describe('POST /api/ai/chat/completions', () => {
    it('returns 400 when messages field is missing or not an array', async () => {
      const response = await request(app)
        .post('/api/ai/chat/completions')
        .send({ model: 'gemma-4-e4b-arasaac' })

      expect(response.status).toBe(400)
      expect(response.body).toHaveProperty('error')
    })

    it('proxies request to ia-2GPU by default with server API key in Authorization header', async () => {
      let capturedUrl = null
      let capturedHeaders = null
      let capturedBody = null

      global.fetch = jest.fn().mockImplementation(async (url, options) => {
        capturedUrl = url
        capturedHeaders = options.headers
        capturedBody = JSON.parse(options.body)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    source: 'o neno corre',
                    outcome: 'el niño corre',
                    wordMapping: [],
                  }),
                },
              },
            ],
          }),
        }
      })

      const response = await request(app)
        .post('/api/ai/chat/completions')
        .send({
          model: 'ia-2GPU:gemma-4-e4b-arasaac',
          messages: [{ role: 'user', content: 'o neno corre' }],
        })

      expect(response.status).toBe(200)
      expect(capturedUrl).toContain('ia2.arasaac.org/v1/chat/completions')
      expect(capturedHeaders['Authorization']).toBeDefined()
      expect(capturedHeaders['Authorization']).toContain('Bearer sk-')
      expect(capturedBody.model).toBe('gemma-4-e4b-arasaac')
      expect(response.body.choices[0].message.content).toContain(
        'el niño corre',
      )
    })

    it('proxies request to ia-prod-1GPU when machineId or model specifies it', async () => {
      let capturedUrl = null
      let capturedHeaders = null

      global.fetch = jest.fn().mockImplementation(async (url, options) => {
        capturedUrl = url
        capturedHeaders = options.headers
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: 'test response' } }],
          }),
        }
      })

      const response = await request(app)
        .post('/api/ai/chat/completions')
        .send({
          machineId: 'ia-prod-1GPU',
          model: 'gemma-4-31b',
          messages: [{ role: 'user', content: 'hola' }],
        })

      expect(response.status).toBe(200)
      expect(capturedUrl).toContain('ia.arasaac.org/v1/chat/completions')
      expect(capturedHeaders['Authorization']).toBeDefined()
    })

    it('returns 502 when upstream AI gateway fails', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('Connection refused'))

      const response = await request(app)
        .post('/api/ai/chat/completions')
        .send({
          model: 'gemma-4-e4b-arasaac',
          messages: [{ role: 'user', content: 'test' }],
        })

      expect(response.status).toBe(502)
      expect(response.body).toHaveProperty('error')
    })
  })

  describe('GET /api/ai/models', () => {
    it('returns connectivity status for AI machines without exposing API keys', async () => {
      global.fetch = jest.fn().mockImplementation(async (url) => {
        if (url.includes('ia2')) {
          return {
            ok: true,
            json: async () => ({
              data: [{ id: 'gemma-4-e4b-arasaac' }, { id: 'gemma-4-12b' }],
            }),
          }
        }
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 'gemma-4-31b' }],
          }),
        }
      })

      const response = await request(app).get('/api/ai/models')

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('ia-prod-1GPU')
      expect(response.body).toHaveProperty('ia-2GPU')
      expect(response.body['ia-2GPU'].online).toBe(true)
      expect(response.body['ia-2GPU'].models).toContain('gemma-4-e4b-arasaac')
    })
  })

  describe('POST /api/ai/training', () => {
    it('submits training record to Supabase with authorization forwarding', async () => {
      jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
      let capturedUrl = null
      let capturedHeaders = null
      let capturedBody = null

      global.fetch = jest.fn().mockImplementation(async (url, options) => {
        capturedUrl = url
        capturedHeaders = options.headers
        capturedBody = JSON.parse(options.body)
        return {
          ok: true,
          json: async () => ({ id: 456, success: true }),
        }
      })

      const response = await request(app)
        .post('/api/ai/training')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          source: 'o can come',
          outcome: 'el perro come',
          detectedLanguage: 'gl',
          wordMapping: [{ source: 'can', target: 'perro' }],
        })

      expect(response.status).toBe(200)
      expect(capturedUrl).toContain('submit-record')
      expect(capturedHeaders['Authorization']).toBe(`Bearer ${userToken}`)
      expect(capturedBody.source).toBe('o can come')
      expect(capturedBody.outcome).toBe('el perro come')
    })
  })
})
