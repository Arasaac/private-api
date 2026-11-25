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
const User = require('../../models/User')
const { ogVersion } = require('../../controllers/sharesController')
let app
let axiosSpy
let testPicto
let cacheDir

const tokenFor = (sub) => jwt.sign({ sub, role: 'user' }, 'test_secret')
const userA = tokenFor('60d5ec49f1b2c82d88c8888a')
const userB = tokenFor('60d5ec49f1b2c82d88c8888b')
const userC = tokenFor('60d5ec49f1b2c82d88c8888c')
const userD = tokenFor('60d5ec49f1b2c82d88c8888d')
const ADMIN_ID = '60d5ec49f1b2c82d88c88888'
const USER_A_ID = '60d5ec49f1b2c82d88c8888a'
const admin = jwt.sign({ sub: ADMIN_ID, role: 'admin' }, 'test_secret')
const DEFAULT_PICTURE =
  'https://static.arasaac.org/pictograms/28307/28307_300.png'

// expected cache file for a share as it is now in the database
const cacheFile = async (id) => {
  const share = await Share.findById(id).lean()
  const user = await User.findById(share.ownerId).lean()
  return path.join(cacheDir, `${id}-${ogVersion(share, user)}.png`)
}

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
      await new Promise((resolve) => setTimeout(resolve, 10))
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
        description: '',
        copies: 0,
        listed: null,
        hidden: false,
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
        description: '',
        listed: null,
        createdAt: expect.any(String),
        author: {
          id: USER_A_ID,
          name: 'Normal User',
          picture: DEFAULT_PICTURE,
        },
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
      expect(res.text).toMatch(
        new RegExp(
          `<meta property="og:image" content="https://privateapi.arasaac.org/api/shares/${created.id}/og.png\\?v=[0-9a-f]{10}">`,
        ),
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
      const file = await cacheFile(created.id)
      expect(path.basename(file)).toMatch(
        new RegExp(`^${created.id}-[0-9a-f]{10}\\.png$`),
      )
      expect(fs.existsSync(file)).toBe(true)
      // pictograms 100 and 200 and the author's avatar were downloaded
      expect(
        pictoCalls()
          .map(([u]) => u)
          .sort(),
      ).toEqual([
        'https://static.arasaac.org/pictograms/100/100_500.png',
        'https://static.arasaac.org/pictograms/200/200_500.png',
        DEFAULT_PICTURE,
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
      expect(fs.readdirSync(cacheDir)).toEqual([])
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
      // only the author's avatar
      expect(pictoCalls().map(([u]) => u)).toEqual([DEFAULT_PICTURE])
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
      const file = await cacheFile(created.id)
      expect(fs.existsSync(file)).toBe(true)
      // other cached versions of the same share are removed too
      const older = path.join(cacheDir, `${created.id}-0123456789.png`)
      fs.writeFileSync(older, 'x')
      const del = await request(app)
        .delete(`/api/shares/${created.id}`)
        .set('Authorization', `Bearer ${userA}`)
      expect(del.status).toBe(204)
      expect(fs.existsSync(file)).toBe(false)
      expect(fs.existsSync(older)).toBe(false)
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

describe('Shares API: listing, search and moderation', () => {
  const GOOGLE_ID = '60d5ec49f1b2c82d88c8888e'
  const FACEBOOK_ID = '60d5ec49f1b2c82d88c8888f'
  const GOOGLE_PICTURE = 'https://lh3.googleusercontent.com/a/photo=s96-c'
  const googleUser = tokenFor(GOOGLE_ID)
  const facebookUser = tokenFor(FACEBOOK_ID)
  const DAY = 24 * 3600 * 1000

  beforeAll(async () => {
    await User.collection.deleteMany({ _id: { $in: [GOOGLE_ID, FACEBOOK_ID] } })
    await User.collection.insertMany([
      {
        _id: new User.base.Types.ObjectId(GOOGLE_ID),
        name: 'Google Person',
        email: 'google@example.org',
        pictureProvider: 'google',
        google: { picture: GOOGLE_PICTURE, email: 'google@example.org' },
        role: 'user',
      },
      {
        _id: new User.base.Types.ObjectId(FACEBOOK_ID),
        name: 'Facebook Person',
        email: 'facebook@example.org',
        pictureProvider: 'facebook',
        facebook: { picture: 'https://graph.facebook.com/x/picture' },
        role: 'user',
      },
    ])
  })

  afterEach(() => {
    delete process.env.SHARES_REPORT_HIDE_THRESHOLD
  })

  let counter = 0
  // creates a share and then sets fields directly in the database
  const make = async (token, body = {}, fields = {}) => {
    counter++
    const res = await post(
      token,
      payload(makeProject({ n: counter }), { title: `t${counter}`, ...body }),
    )
    expect(res.status).toBe(201)
    if (Object.keys(fields).length) {
      await Share.updateOne({ _id: res.body.id }, { $set: fields })
    }
    return res.body.id
  }
  const listed = (token, body, fields) =>
    make(token, body, { listed: true, listedAt: new Date(), ...fields })

  const patch = (token, id, body) =>
    request(app)
      .patch(`/api/shares/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)

  const search = (query = {}) =>
    request(app).get('/api/shares/search').query(query)

  const ids = (res) => res.body.items.map((i) => i.id)

  describe('POST /api/shares with description', () => {
    it('stores description and searchText, returns the new fields', async () => {
      const res = await post(
        userA,
        payload(undefined, {
          title: 'Pájaros  del Bosque',
          description: `  Aves\u0000 que vuelan ${'x'.repeat(600)}`,
        }),
      )
      expect(res.status).toBe(201)
      expect(Object.keys(res.body).sort()).toEqual(
        ['description', 'editUrl', 'id', 'listed', 'url'].sort(),
      )
      expect(res.body.listed).toBeNull()
      expect(res.body.description.length).toBe(500)
      expect(res.body.description.startsWith('Aves que vuelan x')).toBe(true)
      const doc = await Share.findById(res.body.id).lean()
      expect(doc.description).toBe(res.body.description)
      expect(doc.listed).toBeUndefined()
      expect(doc.copies).toBe(0)
      expect(doc.hidden).toBe(false)
      expect(doc.reports).toEqual([])
      expect(
        doc.searchText.startsWith('pajaros del bosque aves que vuelan x'),
      ).toBe(true)
    })

    it('description is not part of the hash and an existing share is not modified', async () => {
      const first = await post(
        userA,
        payload(undefined, { description: 'uno' }),
      )
      await Share.updateOne({ _id: first.body.id }, { listed: true })
      const second = await post(
        userA,
        payload(undefined, { description: 'dos' }),
      )
      expect(second.status).toBe(200)
      expect(second.body).toEqual({
        id: first.body.id,
        url: first.body.url,
        editUrl: first.body.editUrl,
        listed: true,
        description: 'uno',
      })
      const doc = await Share.findById(first.body.id).lean()
      expect(doc.description).toBe('uno')
    })

    it('description defaults to empty', async () => {
      const res = await post(userA, payload())
      expect(res.body.description).toBe('')
      expect((await Share.findById(res.body.id).lean()).searchText).toBe(
        'mi actividad',
      )
    })
  })

  describe('PATCH /api/shares/:id', () => {
    it('owner can list it and change the description', async () => {
      const id = await make(userA, { title: 'Los Colores' })
      const before = Date.now()
      const res = await patch(userA, id, {
        listed: true,
        description: ' Ñandú y camión ',
      })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        id,
        title: 'Los Colores',
        description: 'Ñandú y camión',
        generator: 'generic',
        lang: 'es',
        createdAt: expect.any(String),
        lastAccessedAt: expect.any(String),
        visits: 0,
        copies: 0,
        listed: true,
        hidden: false,
      })
      const doc = await Share.findById(id).lean()
      expect(doc.listedAt.getTime()).toBeGreaterThanOrEqual(before - 1000)
      expect(doc.searchText).toBe('los colores nandu y camion')

      // listing again keeps listedAt; unlisting keeps it too
      const old = new Date(Date.now() - 10 * DAY)
      await Share.updateOne({ _id: id }, { listedAt: old })
      await patch(userA, id, { listed: true })
      expect((await Share.findById(id).lean()).listedAt.getTime()).toBe(
        old.getTime(),
      )
      const off = await patch(userA, id, { listed: false })
      expect(off.body.listed).toBe(false)
      // listing again after unlisting sets a new listedAt
      await patch(userA, id, { listed: true })
      expect(
        (await Share.findById(id).lean()).listedAt.getTime(),
      ).toBeGreaterThan(old.getTime())
    })

    it('an older link without searchText becomes searchable by title when listed', async () => {
      const id = await make(userA, { title: 'Animales de la Granja' })
      await Share.updateOne({ _id: id }, { $unset: { searchText: 1 } })
      await patch(userA, id, { listed: true })
      expect((await Share.findById(id).lean()).searchText).toBe(
        'animales de la granja',
      )
      const res = await request(app).get('/api/shares/search?q=granj')
      expect(res.body.items.map((i) => i.id)).toEqual([id])
    })

    it('401 / 404 / 403 for other users / 400 for bad types', async () => {
      const id = await make(userA)
      expect(
        (await request(app).patch(`/api/shares/${id}`).send({ listed: true }))
          .status,
      ).toBe(401)
      expect((await patch(userA, 'Zzzzzzzz', { listed: true })).status).toBe(
        404,
      )
      expect((await patch(userA, 'bad', { listed: true })).status).toBe(404)
      expect((await patch(userB, id, { listed: true })).status).toBe(403)
      expect((await patch(userA, id, { listed: 'yes' })).status).toBe(400)
      expect((await patch(userA, id, { description: 5 })).status).toBe(400)
      expect((await patch(userA, id, { hidden: 'no' })).status).toBe(400)
      // only admins can hide
      expect((await patch(userA, id, { hidden: true })).status).toBe(403)
      const doc = await Share.findById(id).lean()
      expect(doc.listed).toBeUndefined()
      expect(doc.hidden).toBe(false)
    })

    it('admin can hide any share and change listed/description', async () => {
      const id = await listed(userA)
      const res = await patch(admin, id, {
        hidden: true,
        description: 'moderado',
      })
      expect(res.status).toBe(200)
      expect(res.body.hidden).toBe(true)
      expect(res.body.description).toBe('moderado')
      expect((await search()).body.total).toBe(0)
      const back = await patch(admin, id, { hidden: false, listed: false })
      expect(back.body).toMatchObject({ hidden: false, listed: false })
    })
  })

  describe('GET /api/shares/mine new fields', () => {
    it('includes description, listed, copies and hidden', async () => {
      const id = await make(
        userA,
        { description: 'desc' },
        { listed: false, copies: 4, hidden: true },
      )
      await make(userA)
      const res = await request(app)
        .get('/api/shares/mine')
        .set('Authorization', `Bearer ${userA}`)
      const item = res.body.find((s) => s.id === id)
      expect(item).toMatchObject({
        description: 'desc',
        listed: false,
        copies: 4,
        hidden: true,
      })
      expect(res.body.find((s) => s.id !== id).listed).toBeNull()
      expect(item).not.toHaveProperty('reports')
      expect(item).not.toHaveProperty('searchText')
    })
  })

  describe('GET /api/shares/search', () => {
    it('only listed and not hidden, public with cache header and safe authors', async () => {
      const a = await listed(userA, { description: 'hola' })
      const g = await listed(googleUser)
      const f = await listed(facebookUser)
      await make(userA, {}, { listed: false })
      await make(userA)
      await listed(userA, {}, { hidden: true })
      const res = await search({ sort: 'recent' })
      expect(res.status).toBe(200)
      expect(res.headers['cache-control']).toBe('public, max-age=60')
      expect(res.body.total).toBe(3)
      expect(res.body.page).toBe(1)
      expect(res.body.limit).toBe(24)
      expect(res.body.author).toBeNull()
      expect(ids(res).sort()).toEqual([a, g, f].sort())
      const byId = Object.fromEntries(res.body.items.map((i) => [i.id, i]))
      expect(byId[a]).toEqual({
        id: a,
        title: expect.any(String),
        description: 'hola',
        generator: 'generic',
        lang: 'es',
        createdAt: expect.any(String),
        visits: 0,
        copies: 0,
        author: {
          id: USER_A_ID,
          name: 'Normal User',
          picture: DEFAULT_PICTURE,
        },
      })
      expect(byId[g].author).toEqual({
        id: GOOGLE_ID,
        name: 'Google Person',
        picture: GOOGLE_PICTURE,
      })
      // facebook pictures expire: default picture
      expect(byId[f].author.picture).toBe(DEFAULT_PICTURE)
      expect(JSON.stringify(res.body)).not.toContain('@')
      expect(JSON.stringify(res.body)).not.toContain('reports')
    })

    it('author of a missing user has an empty name and default picture', async () => {
      const id = await listed(userB)
      const res = await search()
      expect(res.body.items.find((i) => i.id === id).author).toEqual({
        id: '60d5ec49f1b2c82d88c8888b',
        name: '',
        picture: DEFAULT_PICTURE,
      })
    })

    it('filters by generator and author (with top-level author)', async () => {
      const bingo = await listed(userA, { generator: 'bingo' })
      const generic = await listed(userA)
      const google = await listed(googleUser, { generator: 'bingo' })
      expect(ids(await search({ generator: 'bingo' })).sort()).toEqual(
        [bingo, google].sort(),
      )
      const byAuthor = await search({ author: GOOGLE_ID })
      expect(ids(byAuthor)).toEqual([google])
      expect(byAuthor.body.author).toEqual({
        id: GOOGLE_ID,
        name: 'Google Person',
        picture: GOOGLE_PICTURE,
      })
      const both = await search({ author: USER_A_ID, generator: 'generic' })
      expect(ids(both)).toEqual([generic])
      // unknown user: no items and no top-level author
      const unknown = await search({ author: '60d5ec49f1b2c82d88c88880' })
      expect(unknown.status).toBe(200)
      expect(unknown.body).toMatchObject({ total: 0, items: [], author: null })
    })

    it('400 with invalid params', async () => {
      const bad = [
        { generator: 'hacker' },
        { author: 'abc' },
        { author: '60d5ec49f1b2c82d88c8888z' },
        { sort: 'best' },
        { page: '0' },
        { page: 'x' },
        { page: '1.5' },
        { limit: '0' },
        { limit: '49' },
        { limit: '-1' },
      ]
      for (const query of bad) {
        const res = await search(query)
        expect([query, res.status]).toEqual([query, 400])
      }
      expect(
        (await request(app).get('/api/shares/search?q=a&q=b')).status,
      ).toBe(400)
      expect((await search({ limit: '48', page: '3' })).status).toBe(200)
    })

    it('q matches the start of words, accent and case insensitive, all tokens', async () => {
      const birds = await listed(userA, {
        title: 'Pájaros del bosque',
        description: 'Animales que vuelan',
      })
      const clothes = await listed(userA, { title: 'Ropa de invierno' })
      const q = async (value) => ids(await search({ q: value }))
      expect(await q('paja')).toEqual([birds])
      expect(await q('PÁJAROS')).toEqual([birds])
      expect(await q('  pajaros   BOSQ ')).toEqual([birds])
      expect(await q('vuel')).toEqual([birds])
      expect(await q('aros')).toEqual([])
      expect(await q('pajaros ropa')).toEqual([])
      expect(await q('inv')).toEqual([clothes])
      expect(await q('de')).toHaveLength(2)
      // regex characters are literal
      expect(await q('.*')).toEqual([])
      expect(await q('(')).toEqual([])
      // empty q returns everything
      expect(await q('')).toHaveLength(2)
    })

    it('sort=relevance with q: exact title, then title over description', async () => {
      const descOnly = await listed(userA, {
        title: 'Otra cosa',
        description: 'gatos y perros',
      })
      const partial = await listed(userA, { title: 'Gatos y ratones' })
      const exact = await listed(userA, { title: 'Gatos' })
      // popularity does not beat the text score
      await Share.updateOne({ _id: descOnly }, { visits: 1000, copies: 100 })
      expect(ids(await search({ q: 'gatos' }))).toEqual([
        exact,
        partial,
        descOnly,
      ])
    })

    it('sort=relevance without q: popularity and freshness', async () => {
      const old = new Date(Date.now() - 400 * DAY)
      const fresh = await listed(userA)
      const oldPopular = await listed(
        userA,
        {},
        { listedAt: old, visits: 5000 },
      )
      const oldQuiet = await listed(userA, {}, { listedAt: old })
      expect(ids(await search())).toEqual([oldPopular, fresh, oldQuiet])
    })

    it('sort=popular and sort=recent', async () => {
      const now = Date.now()
      const a = await listed(
        userA,
        {},
        { visits: 10, copies: 0, listedAt: new Date(now - 3 * DAY) },
      )
      const b = await listed(
        userA,
        {},
        { visits: 0, copies: 3, listedAt: new Date(now - 1 * DAY) },
      )
      const c = await listed(
        userA,
        {},
        { visits: 1, copies: 0, listedAt: new Date(now - 2 * DAY) },
      )
      // without listedAt: createdAt is used
      const d = await listed(
        userA,
        {},
        { visits: 1, copies: 0, createdAt: new Date(now - 4 * DAY) },
      )
      await Share.updateOne({ _id: d }, { $unset: { listedAt: 1 } })
      // popular: b (15), a (10), c (1, newer), d (1, older)
      expect(ids(await search({ sort: 'popular' }))).toEqual([b, a, c, d])
      expect(ids(await search({ sort: 'recent' }))).toEqual([b, c, a, d])
    })

    it('paginates after ranking', async () => {
      const now = Date.now()
      const created = []
      for (let i = 0; i < 5; i++) {
        created.push(
          await listed(userA, {}, { listedAt: new Date(now - i * DAY) }),
        )
      }
      const p1 = await search({ sort: 'recent', limit: '2' })
      const p2 = await search({ sort: 'recent', limit: '2', page: '2' })
      const p3 = await search({ sort: 'recent', limit: '2', page: '3' })
      const p4 = await search({ sort: 'recent', limit: '2', page: '4' })
      expect(p2.body).toMatchObject({ total: 5, page: 2, limit: 2 })
      expect([...ids(p1), ...ids(p2), ...ids(p3)]).toEqual(created)
      expect(ids(p4)).toEqual([])
      expect(p4.body.total).toBe(5)
    })
  })

  describe('POST /api/shares/:id/copy', () => {
    it('counts copies by other users only', async () => {
      const id = await listed(userA)
      const url = `/api/shares/${id}/copy`
      expect((await request(app).post(url)).status).toBe(401)
      const copy = (token, path = url) =>
        request(app).post(path).set('Authorization', `Bearer ${token}`)
      expect((await copy(userB, '/api/shares/Zzzzzzzz/copy')).status).toBe(404)
      expect((await copy(userA)).status).toBe(204)
      expect((await Share.findById(id).lean()).copies).toBe(0)
      expect((await copy(userB)).status).toBe(204)
      expect((await copy(userC)).status).toBe(204)
      expect((await Share.findById(id).lean()).copies).toBe(2)
    })
  })

  describe('POST /api/shares/:id/report', () => {
    const report = (token, id, body = {}) =>
      request(app)
        .post(`/api/shares/${id}/report`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)

    it('401 / 404', async () => {
      const id = await listed(userA)
      expect((await request(app).post(`/api/shares/${id}/report`)).status).toBe(
        401,
      )
      expect((await report(userB, 'Zzzzzzzz')).status).toBe(404)
    })

    it('one report per user, cleaned reason, hidden at the threshold', async () => {
      process.env.SHARES_REPORT_HIDE_THRESHOLD = '2'
      const id = await listed(userA)
      expect(
        (await report(userB, id, { reason: `spam\u0000 ${'x'.repeat(400)}` }))
          .status,
      ).toBe(204)
      expect((await report(userB, id, { reason: 'again' })).status).toBe(204)
      let doc = await Share.findById(id).lean()
      expect(doc.reports).toHaveLength(1)
      expect(doc.reports[0]).toEqual({
        userId: '60d5ec49f1b2c82d88c8888b',
        reason: expect.stringMatching(/^spam x+$/),
        at: expect.any(Date),
      })
      expect(doc.reports[0].reason.length).toBe(300)
      expect(doc.hidden).toBe(false)
      expect((await search()).body.total).toBe(1)

      expect((await report(userC, id)).status).toBe(204)
      doc = await Share.findById(id).lean()
      expect(doc.reports).toHaveLength(2)
      expect(doc.reports[1].reason).toBe('')
      expect(doc.hidden).toBe(true)
      expect((await search()).body.total).toBe(0)
    })

    it('default threshold is 3', async () => {
      const id = await listed(userA)
      await report(userB, id)
      await report(userC, id)
      expect((await Share.findById(id).lean()).hidden).toBe(false)
      await report(userD, id)
      expect((await Share.findById(id).lean()).hidden).toBe(true)
    })
  })

  describe('GET /api/shares/:id author and description', () => {
    it('returns description, listed and the author', async () => {
      const id = await listed(googleUser, { description: 'Para clase' })
      const res = await request(app).get(`/api/shares/${id}`)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        description: 'Para clase',
        listed: true,
        author: {
          id: GOOGLE_ID,
          name: 'Google Person',
          picture: GOOGLE_PICTURE,
        },
      })
      expect(res.body).not.toHaveProperty('reports')
      expect(res.body).not.toHaveProperty('ownerId')
      expect(Object.keys(res.body.author).sort()).toEqual([
        'id',
        'name',
        'picture',
      ])
    })
  })

  describe('og.png and page with the author', () => {
    const getImage = (id) =>
      request(app)
        .get(`/api/shares/${id}/og.png`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => cb(null, Buffer.concat(chunks)))
        })
    const urls = () => axiosSpy.mock.calls.map(([u]) => String(u))

    it('downloads the google avatar and caches by version', async () => {
      axiosSpy.mockImplementation(async (url) => {
        if (/static\.arasaac\.org|googleusercontent\.com/.test(String(url)))
          return { data: testPicto }
        return { data: {} }
      })
      const id = await make(googleUser)
      const res = await getImage(id)
      expect(res.status).toBe(200)
      const meta = await sharp(res.body).metadata()
      expect([meta.format, meta.width, meta.height]).toEqual(['png', 1200, 630])
      expect(urls()).toContain(GOOGLE_PICTURE)
      expect(urls()).not.toContain(DEFAULT_PICTURE)
      const avatarCall = axiosSpy.mock.calls.find(([u]) => u === GOOGLE_PICTURE)
      expect(avatarCall[1]).toMatchObject({ timeout: 5000, maxRedirects: 0 })
      const first = await cacheFile(id)
      expect(fs.existsSync(first)).toBe(true)

      // a new name produces a new version (new file and new og:image url)
      const page1 = await request(app).get(`/api/shares/${id}/page`)
      await User.collection.updateOne(
        { _id: new User.base.Types.ObjectId(GOOGLE_ID) },
        { $set: { name: 'Renamed Person' } },
      )
      const second = await cacheFile(id)
      expect(second).not.toBe(first)
      const page2 = await request(app).get(`/api/shares/${id}/page`)
      const v = (html) => html.match(/og\.png\?v=([0-9a-f]{10})/)[1]
      expect(v(page1.text)).toBe(path.basename(first).slice(9, 19))
      expect(v(page2.text)).toBe(path.basename(second).slice(9, 19))
      expect((await getImage(id)).status).toBe(200)
      expect(fs.existsSync(second)).toBe(true)
      await User.collection.updateOne(
        { _id: new User.base.Types.ObjectId(GOOGLE_ID) },
        { $set: { name: 'Google Person' } },
      )
    })

    it('never downloads avatars from unknown hosts', async () => {
      await User.collection.updateOne(
        { _id: new User.base.Types.ObjectId(GOOGLE_ID) },
        { $set: { 'google.picture': 'https://169.254.169.254/latest' } },
      )
      try {
        const id = await make(googleUser)
        expect((await getImage(id)).status).toBe(200)
        expect(urls()).not.toContain('https://169.254.169.254/latest')
        expect(urls()).toContain(DEFAULT_PICTURE)
      } finally {
        await User.collection.updateOne(
          { _id: new User.base.Types.ObjectId(GOOGLE_ID) },
          { $set: { 'google.picture': GOOGLE_PICTURE } },
        )
      }
    })

    it('without a user only the pictograms are drawn', async () => {
      const id = await make(userB)
      const res = await getImage(id)
      expect(res.status).toBe(200)
      expect((await sharp(res.body).metadata()).height).toBe(630)
      expect(urls().filter((u) => u.includes('28307'))).toEqual([])
    })

    it('page uses the description and prefixes the author name', async () => {
      const withDesc = await make(userA, { description: 'Juego de colores' })
      const res = await request(app).get(`/api/shares/${withDesc}/page`)
      expect(res.text).toContain(
        '<meta property="og:description" content="Normal User · Juego de colores">',
      )
      const noUser = await make(userB)
      const res2 = await request(app).get(`/api/shares/${noUser}/page`)
      expect(res2.text).toContain(
        '<meta property="og:description" content="Actividad creada con ARActivities, de ARASAAC. Ábrela para verla y usarla.">',
      )
    })

    it('isSafeAvatarUrl only allows https from known hosts', () => {
      const { isSafeAvatarUrl } = require('../../controllers/sharesController')
      expect(isSafeAvatarUrl(GOOGLE_PICTURE)).toBe(true)
      expect(isSafeAvatarUrl(DEFAULT_PICTURE)).toBe(true)
      expect(isSafeAvatarUrl('http://lh3.googleusercontent.com/a')).toBe(false)
      expect(isSafeAvatarUrl('https://googleusercontent.com.evil.org/a')).toBe(
        false,
      )
      expect(isSafeAvatarUrl('https://evilgoogleusercontent.com/a')).toBe(false)
      expect(isSafeAvatarUrl('https://static.arasaac.org:8443/x')).toBe(false)
      expect(isSafeAvatarUrl('https://user@static.arasaac.org/x')).toBe(false)
      expect(isSafeAvatarUrl('not a url')).toBe(false)
      expect(isSafeAvatarUrl(undefined)).toBe(false)
    })
  })

  describe('new indexes', () => {
    it('has the search indexes', async () => {
      const indexes = await Share.collection.indexes()
      expect(
        indexes.some(
          (i) =>
            JSON.stringify(i.key) ===
            JSON.stringify({ listed: 1, hidden: 1, generator: 1 }),
        ),
      ).toBe(true)
      expect(
        indexes.some(
          (i) =>
            JSON.stringify(i.key) === JSON.stringify({ listed: 1, ownerId: 1 }),
        ),
      ).toBe(true)
    })
  })
})
