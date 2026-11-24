const request = require('supertest')
const axios = require('axios')
const jwt = require('jsonwebtoken')
const zlib = require('zlib')
const fs = require('fs')
const os = require('os')
const path = require('path')
const sharp = require('sharp')
const db = require('../../db')
const { seedDatabase } = require('../seed')
const Share = require('../../models/Share')
let app
let axiosSpy
let testPicto
let cacheDir

const tokenFor = (sub) => jwt.sign({ sub, role: 'user' }, 'test_secret')
const userA = tokenFor('60d5ec49f1b2c82d88c8888a')
const userB = tokenFor('60d5ec49f1b2c82d88c8888b')
const userC = tokenFor('60d5ec49f1b2c82d88c8888c')
const userD = tokenFor('60d5ec49f1b2c82d88c8888d')

const encode = (project) =>
  zlib
    .deflateRawSync(Buffer.from(JSON.stringify(project)))
    .toString('base64url')

const makeProject = (extra = {}) => ({
  metadata: { generator: 'generic' },
  cells: {
    c1: {
      images: [
        { type: 'pictogram', pictogramId: 100 },
        { type: 'pictogram', pictogramId: 100 },
        { type: 'localImage', pictogramId: 'uuid-1' },
        { pictogramId: 200 },
      ],
    },
  },
  ...extra,
})

const payload = (project = makeProject(), extra = {}) => ({
  data: encode(project),
  generator: 'generic',
  lang: 'es',
  title: 'Mi actividad',
  ...extra,
})

const post = (token, body) =>
  request(app)
    .post('/api/shares')
    .set('Authorization', `Bearer ${token}`)
    .send(body)

beforeAll(async () => {
  await db.open()
  await seedDatabase()
  await Share.init()
  app = require('../../privateapi')
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shares-og-test-'))
  process.env.SHARES_OG_CACHE_DIR = cacheDir
  testPicto = await sharp({
    create: { width: 500, height: 500, channels: 4, background: '#e53935' },
  })
    .png()
    .toBuffer()
  axiosSpy = jest.spyOn(axios, 'get')
})

afterAll(async () => {
  axiosSpy.mockRestore()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  await db.close()
})

beforeEach(async () => {
  await Share.deleteMany({})
  delete process.env.SHARES_DAILY_LIMIT
  fs.readdirSync(cacheDir).forEach((f) => fs.unlinkSync(path.join(cacheDir, f)))
  axiosSpy.mockReset()
  axiosSpy.mockImplementation(async (url) => {
    if (String(url).includes('static.arasaac.org')) return { data: testPicto }
    return { data: {} }
  })
})

describe('Shares API', () => {
  describe('POST /api/shares', () => {
    it('401 without token', async () => {
      const res = await request(app).post('/api/shares').send(payload())
      expect(res.status).toBe(401)
    })

    it('creates a share (201) and stores extracted metadata', async () => {
      const res = await post(userA, payload())
      expect(res.status).toBe(201)
      expect(res.body.id).toMatch(/^[0-9A-Za-z]{8}$/)
      expect(res.body.url).toBe(
        `https://aractivities.arasaac.org/s/${res.body.id}`,
      )
      expect(res.body.editUrl).toBe(`${res.body.url}?edit`)
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow')
      const doc = await Share.findById(res.body.id).lean()
      expect(doc.ownerId).toBe('60d5ec49f1b2c82d88c8888a')
      expect(doc.pictogramIds).toEqual([100, 200])
      expect(doc.visits).toBe(0)
    })

    it('returns the same id (200) for the same content', async () => {
      const first = await post(userA, payload())
      const second = await post(userA, payload())
      expect(second.status).toBe(200)
      expect(second.body.id).toBe(first.body.id)
      // another user gets a different link
      const other = await post(userB, payload())
      expect(other.status).toBe(201)
      expect(other.body.id).not.toBe(first.body.id)
    })

    it('400 with corrupt data', async () => {
      const res = await post(userA, payload(undefined, { data: 'abc$$%%' }))
      expect(res.status).toBe(400)
      const notDeflate = Buffer.from('not compressed json').toString(
        'base64url',
      )
      const res2 = await post(userA, payload(undefined, { data: notDeflate }))
      expect(res2.status).toBe(400)
      const notJson = zlib
        .deflateRawSync(Buffer.from('{oops'))
        .toString('base64url')
      const res3 = await post(userA, payload(undefined, { data: notJson }))
      expect(res3.status).toBe(400)
    })

    it('400 with unknown generator', async () => {
      const res = await post(userA, payload(undefined, { generator: 'hacker' }))
      expect(res.status).toBe(400)
    })

    it('400 with too many cells', async () => {
      const cells = {}
      for (let i = 0; i < 5001; i++) cells[`c${i}`] = {}
      const res = await post(userA, payload({ cells }))
      expect(res.status).toBe(400)
    })

    it('413 when body exceeds 200kb', async () => {
      const res = await post(
        userA,
        payload(undefined, { title: 'x'.repeat(210 * 1024) }),
      )
      expect(res.status).toBe(413)
    })

    it('strips control characters and trims title to 100', async () => {
      const res = await post(
        userA,
        payload(undefined, { title: `a\u0000b\n${'z'.repeat(200)}` }),
      )
      expect(res.status).toBe(201)
      const doc = await Share.findById(res.body.id).lean()
      expect(doc.title.length).toBe(100)
      expect(doc.title.startsWith('abzzz')).toBe(true)
    })

    it('limits at most 6 pictogram ids', async () => {
      const images = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
        type: 'pictogram',
        pictogramId: n,
      }))
      const res = await post(userA, payload({ cells: { c: { images } } }))
      const doc = await Share.findById(res.body.id).lean()
      expect(doc.pictogramIds).toEqual([1, 2, 3, 4, 5, 6])
    })

    it('429 after exceeding the daily limit per user', async () => {
      process.env.SHARES_DAILY_LIMIT = '2'
      const mk = (n) => payload(makeProject({ n }))
      expect((await post(userC, mk(1))).status).toBe(201)
      expect((await post(userC, mk(2))).status).toBe(201)
      // repeating an existing one does not count
      expect((await post(userC, mk(2))).status).toBe(200)
      expect((await post(userC, mk(3))).status).toBe(429)
      // other users unaffected
      expect((await post(userD, mk(3))).status).toBe(201)
    })
  })

  describe('GET /api/shares/mine', () => {
    it('401 without token', async () => {
      const res = await request(app).get('/api/shares/mine')
      expect(res.status).toBe(401)
    })

    it('only returns own shares, newest first, without data', async () => {
      const a1 = await post(
        userA,
        payload(makeProject({ n: 1 }), { title: 'uno' }),
      )
      await new Promise((r) => setTimeout(r, 10))
      const a2 = await post(
        userA,
        payload(makeProject({ n: 2 }), { title: 'dos' }),
      )
      await post(userB, payload(makeProject({ n: 3 })))
      const res = await request(app)
        .get('/api/shares/mine')
        .set('Authorization', `Bearer ${userA}`)
      expect(res.status).toBe(200)
      expect(res.body.map((s) => s.id)).toEqual([a2.body.id, a1.body.id])
      expect(res.body[0]).toEqual({
        id: a2.body.id,
        title: 'dos',
        generator: 'generic',
        lang: 'es',
        createdAt: expect.any(String),
        lastAccessedAt: expect.any(String),
        visits: 0,
      })
      expect(res.body[0]).not.toHaveProperty('data')
    })
  })

  describe('GET /api/shares/:id', () => {
    it('is public, counts a visit and updates lastAccessedAt', async () => {
      const body = payload()
      const { body: created } = await post(userA, body)
      const old = new Date(Date.now() - 3600 * 1000)
      await Share.updateOne({ _id: created.id }, { lastAccessedAt: old })
      const res = await request(app).get(`/api/shares/${created.id}`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        data: body.data,
        generator: 'generic',
        lang: 'es',
        title: 'Mi actividad',
        createdAt: expect.any(String),
      })
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow')
      const doc = await Share.findById(created.id).lean()
      expect(doc.visits).toBe(1)
      expect(doc.lastAccessedAt.getTime()).toBeGreaterThan(old.getTime() + 1000)
    })

    it('404 when it does not exist', async () => {
      const res = await request(app).get('/api/shares/Zzzzzzzz')
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/shares/:id', () => {
    it('401 / 404 / 403 / 204 and then GET 404', async () => {
      const { body: created } = await post(userA, payload())
      const url = `/api/shares/${created.id}`
      expect((await request(app).delete(url)).status).toBe(401)
      expect(
        (
          await request(app)
            .delete('/api/shares/Zzzzzzzz')
            .set('Authorization', `Bearer ${userA}`)
        ).status,
      ).toBe(404)
      expect(
        (await request(app).delete(url).set('Authorization', `Bearer ${userB}`))
          .status,
      ).toBe(403)
      expect(await Share.countDocuments({ _id: created.id })).toBe(1)
      expect(
        (await request(app).delete(url).set('Authorization', `Bearer ${userA}`))
          .status,
      ).toBe(204)
      expect((await request(app).get(url)).status).toBe(404)
    })
  })

  describe('GET /api/shares/:id/page', () => {
    it('renders escaped Open Graph html', async () => {
      const title = `<script>alert("x")</script> 'q' & co`
      const { body: created } = await post(userA, payload(undefined, { title }))
      const res = await request(app).get(`/api/shares/${created.id}/page`)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toMatch(/text\/html/)
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow')
      expect(res.text).not.toContain('<script>')
      expect(res.text).toContain(
        '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &#39;q&#39; &amp; co · ARActivities',
      )
      expect(res.text).toContain(
        `<meta property="og:image" content="https://privateapi.arasaac.org/api/shares/${created.id}/og.png">`,
      )
      expect(res.text).toContain(
        `<meta property="og:url" content="https://aractivities.arasaac.org/s/${created.id}">`,
      )
      expect(res.text).toContain('<meta property="og:type" content="website">')
      expect(res.text).toContain(
        '<meta name="twitter:card" content="summary_large_image">',
      )
      expect(res.text).toContain(
        '<meta name="robots" content="noindex, nofollow">',
      )
      expect(res.text).toContain(
        `<a href="https://aractivities.arasaac.org/s/${created.id}">`,
      )
    })

    it('does not count a visit and 404s as html', async () => {
      const { body: created } = await post(userA, payload())
      await request(app).get(`/api/shares/${created.id}/page`)
      expect((await Share.findById(created.id).lean()).visits).toBe(0)
      const res = await request(app).get('/api/shares/Zzzzzzzz/page')
      expect(res.status).toBe(404)
      expect(res.headers['content-type']).toMatch(/text\/html/)
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow')
    })
  })

  describe('GET /api/shares/:id/og.png', () => {
    const pictoCalls = () =>
      axiosSpy.mock.calls.filter(([u]) =>
        String(u).includes('static.arasaac.org'),
      )
    const getImage = (id) =>
      request(app)
        .get(`/api/shares/${id}/og.png`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => cb(null, Buffer.concat(chunks)))
        })

    it('200 image/png 1200x630 under 300KB, cached on disk', async () => {
      const { body: created } = await post(userA, payload())
      const res = await getImage(created.id)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('image/png')
      expect(res.headers['cache-control']).toBe('public, max-age=86400')
      const meta = await sharp(res.body).metadata()
      expect([meta.format, meta.width, meta.height]).toEqual(['png', 1200, 630])
      expect(res.body.length).toBeLessThan(300 * 1024)
      expect(fs.existsSync(path.join(cacheDir, `${created.id}.png`))).toBe(true)
      // pictograms 100 and 200 were downloaded
      expect(
        pictoCalls()
          .map(([u]) => u)
          .sort(),
      ).toEqual([
        'https://static.arasaac.org/pictograms/100/100_500.png',
        'https://static.arasaac.org/pictograms/200/200_500.png',
      ])
      expect(pictoCalls()[0][1]).toMatchObject({ timeout: 5000 })
    })

    it('second request is served from cache without downloading', async () => {
      const { body: created } = await post(userA, payload())
      const first = await getImage(created.id)
      axiosSpy.mockClear()
      const second = await getImage(created.id)
      expect(second.status).toBe(200)
      expect(pictoCalls().length).toBe(0)
      expect(second.body.equals(first.body)).toBe(true)
    })

    it('still 200 when downloads fail (generic image, not cached)', async () => {
      const { body: created } = await post(userA, payload())
      axiosSpy.mockImplementation(async () => {
        throw new Error('network down')
      })
      const res = await getImage(created.id)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('image/png')
      const meta = await sharp(res.body).metadata()
      expect([meta.width, meta.height]).toEqual([1200, 630])
      expect(fs.existsSync(path.join(cacheDir, `${created.id}.png`))).toBe(
        false,
      )
    })

    it('uses the pictograms that could be downloaded', async () => {
      const { body: created } = await post(userA, payload())
      axiosSpy.mockImplementation(async (url) => {
        if (String(url).includes('/100/')) throw new Error('boom')
        return { data: testPicto }
      })
      const res = await getImage(created.id)
      expect(res.status).toBe(200)
      expect((await sharp(res.body).metadata()).width).toBe(1200)
    })

    it('generic image when the share has no pictograms', async () => {
      const { body: created } = await post(userA, payload({ cells: { c: {} } }))
      const res = await getImage(created.id)
      expect(res.status).toBe(200)
      expect(pictoCalls().length).toBe(0)
    })

    it('404 for unknown or malformed ids', async () => {
      expect(
        (await request(app).get('/api/shares/Zzzzzzzz/og.png')).status,
      ).toBe(404)
      expect((await request(app).get('/api/shares/..%2Fx/og.png')).status).toBe(
        404,
      )
      expect((await request(app).get('/api/shares/abc/og.png')).status).toBe(
        404,
      )
    })

    it('does not count visits nor touch lastAccessedAt', async () => {
      const { body: created } = await post(userA, payload())
      const old = new Date(Date.now() - 3600 * 1000)
      await Share.updateOne({ _id: created.id }, { lastAccessedAt: old })
      await getImage(created.id)
      const doc = await Share.findById(created.id).lean()
      expect(doc.visits).toBe(0)
      expect(doc.lastAccessedAt.getTime()).toBe(old.getTime())
    })

    it('DELETE removes the cached png', async () => {
      const { body: created } = await post(userA, payload())
      await getImage(created.id)
      const file = path.join(cacheDir, `${created.id}.png`)
      expect(fs.existsSync(file)).toBe(true)
      const del = await request(app)
        .delete(`/api/shares/${created.id}`)
        .set('Authorization', `Bearer ${userA}`)
      expect(del.status).toBe(204)
      expect(fs.existsSync(file)).toBe(false)
      expect((await getImage(created.id)).status).toBe(404)
    })

    it('cleanOgCache removes only files older than 30 days', async () => {
      const { cleanOgCache } = require('../../controllers/sharesController')
      const oldFile = path.join(cacheDir, 'Old00000.png')
      const newFile = path.join(cacheDir, 'New00000.png')
      fs.writeFileSync(oldFile, 'x')
      fs.writeFileSync(newFile, 'x')
      const past = new Date(Date.now() - 31 * 24 * 3600 * 1000)
      fs.utimesSync(oldFile, past, past)
      expect(await cleanOgCache()).toBe(1)
      expect(fs.existsSync(oldFile)).toBe(false)
      expect(fs.existsSync(newFile)).toBe(true)
    })
  })

  describe('indexes', () => {
    it('has the TTL index on lastAccessedAt (24 months) and the other indexes', async () => {
      const indexes = await Share.collection.indexes()
      const ttl = indexes.find((i) => i.key.lastAccessedAt === 1)
      expect(ttl.expireAfterSeconds).toBe(63072000)
      const uniq = indexes.find((i) => i.key.ownerId === 1 && i.key.hash === 1)
      expect(uniq.unique).toBe(true)
      expect(
        indexes.some((i) => i.key.ownerId === 1 && i.key.createdAt === -1),
      ).toBe(true)
    })
  })
})
