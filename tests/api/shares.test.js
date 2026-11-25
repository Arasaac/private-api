const constants = require('../../utils/constants')
const originalAssetsDir = constants.ARACTIVITIES_DIR
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
const {
  ogVersion,
  flushNotices,
} = require('../../controllers/sharesController')
let app
let server
let axiosSpy
let postSpy
let testPicto
let cacheDir
let assetsDir

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
  return path.join(cacheDir, `${id}-${await ogVersion(share, user)}.png`)
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
  // one server for the whole file: an ephemeral server per request makes
  // supertest flaky (socket hang up, answers from the wrong server)
  server = require('../../privateapi').listen(0)
  app = server
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shares-og-test-'))
  process.env.SHARES_OG_CACHE_DIR = cacheDir
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shares-assets-test-'))
  constants.ARACTIVITIES_DIR = assetsDir
  testPicto = await sharp({
    create: { width: 500, height: 500, channels: 4, background: '#e53935' },
  })
    .png()
    .toBuffer()
  axiosSpy = jest.spyOn(axios, 'get')
  postSpy = jest.spyOn(axios, 'post')
})

afterAll(async () => {
  axiosSpy.mockRestore()
  postSpy.mockRestore()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(cacheDir, { recursive: true, force: true })
  fs.rmSync(assetsDir, { recursive: true, force: true })
  constants.ARACTIVITIES_DIR = originalAssetsDir
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
  postSpy.mockReset()
  postSpy.mockResolvedValue({ data: {} })
})

// Mattermost notices are fire and forget: let them end inside their test
afterEach(async () => {
  await flushNotices()
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
      expect(doc.visits).toBe(0)
      expect(doc).not.toHaveProperty('pictogramIds')
      expect(doc.preview).toBeNull()
      expect(doc.images).toEqual([])
      expect(res.body.preview).toBeNull()
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

    it('creating allows 12mb bodies; other routes keep 200kb', async () => {
      // ~6 MB (the title is trimmed to 100)
      const big = await post(
        userA,
        payload(undefined, { title: 'x'.repeat(6 * 1024 * 1024) }),
      )
      expect(big.status).toBe(201)
      const tooBig = await post(
        userA,
        payload(undefined, { title: 'x'.repeat(13 * 1024 * 1024) }),
      )
      expect(tooBig.status).toBe(413)
      const patched = await request(app)
        .patch(`/api/shares/${big.body.id}`)
        .set('Authorization', `Bearer ${userA}`)
        .send({ description: 'x'.repeat(210 * 1024) })
      expect(patched.status).toBe(413)
      const reported = await request(app)
        .post(`/api/shares/${big.body.id}/report`)
        .set('Authorization', `Bearer ${userB}`)
        .send({ reason: 'x'.repeat(210 * 1024) })
      expect(reported.status).toBe(413)
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
        featured: false,
        preview: null,
        imagesCount: 0,
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
        hidden: false,
        featured: false,
        createdAt: expect.any(String),
        author: {
          id: USER_A_ID,
          name: 'Normal User',
          picture: DEFAULT_PICTURE,
        },
        preview: null,
        images: [],
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

    it('200 image/png 1200x630 under 300KB, cached on disk (no capture: author only)', async () => {
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
      // only the author's avatar is downloaded (no pictograms)
      expect(pictoCalls().map(([u]) => u)).toEqual([DEFAULT_PICTURE])
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

    it('still 200 when downloads fail (not cached)', async () => {
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

  describe('administration', () => {
    const adminList = (query = {}, token = admin) =>
      request(app)
        .get('/api/shares/admin')
        .set('Authorization', `Bearer ${token}`)
        .query(query)

    const reportBy = (token, id, reason) =>
      request(app)
        .post(`/api/shares/${id}/report`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason })

    it('only admins can list every link', async () => {
      expect((await request(app).get('/api/shares/admin')).status).toBe(401)
      expect((await adminList({}, userA)).status).toBe(403)
      expect((await adminList()).status).toBe(200)
    })

    it('lists every link with author email, reports with reporter, and tab counters', async () => {
      const reported = await listed(userA, { title: 'Bingo granja' })
      await reportBy(userB, reported, 'Datos de alumnos')
      const hiddenId = await make(userA, {}, { hidden: true })
      const unlisted = await make(userA)
      const res = await adminList()
      expect(res.status).toBe(200)
      expect(res.body.total).toBe(3)
      expect(res.body.counts).toEqual({
        all: 3,
        reported: 1,
        hidden: 1,
        listed: 1,
        featured: 0,
      })
      const item = res.body.items.find((i) => i.id === reported)
      const userADoc = await User.findById(USER_A_ID).lean()
      expect(item).toMatchObject({
        title: 'Bingo granja',
        listed: true,
        hidden: false,
        reportsCount: 1,
        dismissedReportsCount: 0,
        moderation: null,
        url: `https://aractivities.arasaac.org/s/${reported}`,
        image: `https://privateapi.arasaac.org/api/shares/${reported}/og.png`,
        author: { id: USER_A_ID, name: 'Normal User', email: userADoc.email },
      })
      expect(item.reports).toEqual([
        {
          reason: 'Datos de alumnos',
          at: expect.any(String),
          user: expect.objectContaining({ id: '60d5ec49f1b2c82d88c8888b' }),
        },
      ])
      expect(item).not.toHaveProperty('data')
      expect(res.body.items.map((i) => i.id)).toEqual(
        expect.arrayContaining([hiddenId, unlisted]),
      )
    })

    it('filters by status, type, author and text (words, link id or author)', async () => {
      const a = await listed(userA, { title: 'Animales de la granja' })
      const b = await make(
        userB,
        { title: 'Rutina', generator: 'timetable' },
        { hidden: true },
      )
      await reportBy(userC, a, '')
      const ids = (res) => res.body.items.map((i) => i.id).sort()
      expect(ids(await adminList({ status: 'reported' }))).toEqual([a])
      expect(ids(await adminList({ status: 'hidden' }))).toEqual([b])
      expect(ids(await adminList({ status: 'listed' }))).toEqual([a])
      expect(ids(await adminList({ status: 'unlisted' }))).toEqual([b])
      expect(ids(await adminList({ generator: 'timetable' }))).toEqual([b])
      expect(ids(await adminList({ author: USER_A_ID }))).toEqual([a])
      expect(ids(await adminList({ q: 'granj' }))).toEqual([a])
      expect(ids(await adminList({ q: b }))).toEqual([b])
      expect(ids(await adminList({ q: 'Normal User' }))).toEqual([a])
      // counters follow the text filter
      expect((await adminList({ q: 'granj' })).body.counts).toEqual({
        all: 1,
        reported: 1,
        hidden: 0,
        listed: 1,
        featured: 0,
      })
    })

    it('sorts by reports, visits and copies, and paginates', async () => {
      const few = await listed(userA, {}, { visits: 50, copies: 1 })
      const many = await listed(userA, {}, { visits: 5, copies: 9 })
      await reportBy(userB, many, '')
      await reportBy(userC, many, '')
      await reportBy(userB, few, '')
      const order = async (sort) =>
        (await adminList({ sort })).body.items.map((i) => i.id)
      expect(await order('reports')).toEqual([many, few])
      expect(await order('visits')).toEqual([few, many])
      expect(await order('copies')).toEqual([many, few])
      const page2 = await adminList({ sort: 'visits', limit: '1', page: '2' })
      expect(page2.body).toMatchObject({ total: 2, page: 2, limit: 1 })
      expect(page2.body.items.map((i) => i.id)).toEqual([many])
    })

    it('rejects invalid parameters', async () => {
      for (const query of [
        { status: 'x' },
        { sort: 'x' },
        { generator: 'x' },
        { author: 'x' },
        { limit: '101' },
        { page: '0' },
      ]) {
        expect((await adminList(query)).status).toBe(400)
      }
    })

    it('restoring a link moves its reports to the history, so they do not hide it again', async () => {
      process.env.SHARES_REPORT_HIDE_THRESHOLD = '2'
      const id = await listed(userA)
      await reportBy(userB, id, 'uno')
      await reportBy(userC, id, 'dos')
      expect((await Share.findById(id).lean()).hidden).toBe(true)

      const res = await patch(admin, id, { hidden: false })
      expect(res.status).toBe(200)
      const doc = await Share.findById(id).lean()
      expect(doc.hidden).toBe(false)
      expect(doc.reports).toEqual([])
      expect(doc.dismissedReports.map((r) => r.reason)).toEqual(['uno', 'dos'])
      expect(doc.moderation).toMatchObject({ action: 'restored', by: ADMIN_ID })

      // one new report is not enough to hide it again
      await reportBy(userD, id, 'tres')
      expect((await Share.findById(id).lean()).hidden).toBe(false)
      const listedItem = (await adminList({ status: 'reported' })).body.items[0]
      expect(listedItem).toMatchObject({
        reportsCount: 1,
        dismissedReportsCount: 2,
      })
      expect(listedItem.moderation).toMatchObject({
        action: 'restored',
        by: { id: ADMIN_ID },
      })
    })

    it('an admin can dismiss reports without hiding, or hide it', async () => {
      const id = await listed(userA)
      await reportBy(userB, id, 'spam')
      const dismissed = await patch(admin, id, { dismissReports: true })
      expect(dismissed.status).toBe(200)
      let doc = await Share.findById(id).lean()
      expect(doc.reports).toEqual([])
      expect(doc.hidden).toBe(false)
      expect(doc.moderation.action).toBe('dismissed')

      await patch(admin, id, { hidden: true })
      doc = await Share.findById(id).lean()
      expect(doc.hidden).toBe(true)
      expect(doc.moderation.action).toBe('hidden')

      expect((await patch(userA, id, { dismissReports: true })).status).toBe(
        403,
      )
      expect((await patch(admin, id, { dismissReports: 'yes' })).status).toBe(
        400,
      )
    })

    it('an admin can delete any link; other users cannot', async () => {
      const id = await make(userA)
      const del = (token) =>
        request(app)
          .delete(`/api/shares/${id}`)
          .set('Authorization', `Bearer ${token}`)
      expect((await del(userB)).status).toBe(403)
      expect((await del(admin)).status).toBe(204)
      expect(await Share.findById(id).lean()).toBeNull()
    })

    it('moderation data never reaches the author or the public', async () => {
      const id = await listed(userA)
      await reportBy(userB, id, 'x')
      await patch(admin, id, { hidden: true })
      const mine = await request(app)
        .get('/api/shares/mine')
        .set('Authorization', `Bearer ${userA}`)
      expect(mine.body[0]).not.toHaveProperty('reports')
      expect(mine.body[0]).not.toHaveProperty('moderation')
      expect(mine.body[0]).not.toHaveProperty('dismissedReports')
      const pub = await request(app).get(`/api/shares/${id}`)
      expect(pub.status).toBe(410)
      expect(pub.body).toEqual({ error: 'Hidden' })
      const own = await request(app)
        .get(`/api/shares/${id}`)
        .set('Authorization', `Bearer ${userA}`)
      expect(own.status).toBe(200)
      expect(own.body).not.toHaveProperty('moderation')
      expect(own.body).not.toHaveProperty('dismissedReports')
      expect(own.body).not.toHaveProperty('reports')
    })
  })

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
        ['description', 'editUrl', 'id', 'listed', 'preview', 'url'].sort(),
      )
      expect(res.body.listed).toBeNull()
      expect(res.body.description.length).toBe(200)
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
        preview: null,
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
        featured: false,
        preview: null,
        imagesCount: 0,
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
        featured: false,
        author: {
          id: USER_A_ID,
          name: 'Normal User',
          picture: DEFAULT_PICTURE,
        },
        preview: null,
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

    it('without a user nor a capture: the generic image', async () => {
      const id = await make(userB)
      const res = await getImage(id)
      expect(res.status).toBe(200)
      expect((await sharp(res.body).metadata()).height).toBe(630)
      expect(urls().filter((u) => !u.includes('/tokeninfo'))).toEqual([])
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

  describe('hidden links stop opening', () => {
    const get = (id, token) => {
      const req = request(app).get(`/api/shares/${id}`)
      return token ? req.set('Authorization', `Bearer ${token}`) : req
    }

    it('GET: 410 for the public and other users, without counting a visit', async () => {
      const old = new Date(Date.now() - 3600 * 1000)
      const id = await listed(
        userA,
        {},
        { hidden: true, lastAccessedAt: old, visits: 7 },
      )
      for (const token of [undefined, userB, 'not-a-jwt']) {
        const res = await get(id, token)
        expect([token, res.status]).toEqual([token, 410])
        expect(res.body).toEqual({ error: 'Hidden' })
      }
      const doc = await Share.findById(id).lean()
      expect(doc.visits).toBe(7)
      expect(doc.lastAccessedAt.getTime()).toBe(old.getTime())
    })

    it('GET: the owner and admins still open it (hidden: true)', async () => {
      const id = await listed(userA, {}, { hidden: true })
      for (const token of [userA, admin]) {
        const res = await get(id, token)
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({
          hidden: true,
          featured: false,
          title: expect.any(String),
          author: { id: USER_A_ID },
        })
        expect(res.body.data).toEqual(expect.any(String))
      }
      expect((await Share.findById(id).lean()).visits).toBe(2)
    })

    it('GET: optional auth never answers 401', async () => {
      const id = await listed(userA)
      const hiddenId = await make(userA, {}, { hidden: true })
      expect((await get(id, 'not-a-jwt')).status).toBe(200)
      expect((await get(id, userB)).status).toBe(200)
      // the auth server is down: anonymous
      axiosSpy.mockImplementation(async (url) => {
        if (String(url).includes('tokeninfo')) throw new Error('ECONNREFUSED')
        return { data: {} }
      })
      expect((await get(id, userB)).status).toBe(200)
      // the owner with an unverifiable token is anonymous: 410, not 401/500
      expect((await get(hiddenId, userA)).status).toBe(410)
      expect((await Share.findById(id).lean()).visits).toBe(3)
    })

    it('copy: 410 for other users, allowed for the owner and admins', async () => {
      const id = await listed(userA, {}, { hidden: true })
      const copy = (token) =>
        request(app)
          .post(`/api/shares/${id}/copy`)
          .set('Authorization', `Bearer ${token}`)
      const res = await copy(userB)
      expect(res.status).toBe(410)
      expect(res.body).toEqual({ error: 'Hidden' })
      expect((await Share.findById(id).lean()).copies).toBe(0)
      expect((await copy(userA)).status).toBe(204)
      expect((await copy(admin)).status).toBe(204)
      expect((await Share.findById(id).lean()).copies).toBe(1)
    })

    it('page: 410 noindex html without the activity data; og.png unchanged', async () => {
      const id = await listed(
        userA,
        { title: 'Secreto', description: 'Datos privados' },
        { hidden: true },
      )
      const res = await request(app).get(`/api/shares/${id}/page`)
      expect(res.status).toBe(410)
      expect(res.headers['content-type']).toMatch(/text\/html/)
      expect(res.text).toContain(
        '<meta name="robots" content="noindex, nofollow">',
      )
      expect(res.text).toContain(
        'Esta actividad se ha retirado mientras se revisa.',
      )
      expect(res.text).not.toContain('og:title')
      expect(res.text).not.toContain('og:description')
      expect(res.text).not.toContain('Secreto')
      expect(res.text).not.toContain('Datos privados')
      expect(res.text).not.toContain('Normal User')
      const png = await request(app).get(`/api/shares/${id}/og.png`)
      expect(png.status).toBe(200)
      expect(png.headers['content-type']).toBe('image/png')
    })
  })

  describe('Mattermost notices on reports', () => {
    const report = (token, id, reason) =>
      request(app)
        .post(`/api/shares/${id}/report`)
        .set('Authorization', `Bearer ${token}`)
        .send(reason === undefined ? {} : { reason })
    const messages = () => postSpy.mock.calls.map(([, body]) => body.message)
    const links = (id) =>
      `https://aractivities.arasaac.org/s/${id}?edit · Revisar: https://admin.arasaac.org/shared-activities`
    const saved = {}

    beforeEach(() => {
      ;[
        'MATTERMOST_URL',
        'MATTERMOST_TOKEN',
        'MATTERMOST_CHANNEL_ID',
        'MATTERMOST_CHANNEL_ID_ARACTIVITIES',
        'ARASAAC_ADMIN_URL',
      ].forEach((key) => {
        saved[key] = process.env[key]
      })
    })

    afterEach(() => {
      Object.entries(saved).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
    })

    it('posts a notice on the first pending report only', async () => {
      const id = await listed(userA, { title: 'Bingo granja' })
      expect((await report(userB, id, 'Datos de alumnos')).status).toBe(204)
      await flushNotices()
      expect(postSpy).toHaveBeenCalledTimes(1)
      const [url, body, config] = postSpy.mock.calls[0]
      expect(url).toBe('http://localhost/api/v4/posts')
      expect(body).toEqual({
        channel_id: 'test-channel',
        message: `🚩 Nueva denuncia en ARActivities: **Bingo granja** de Normal User\n> Datos de alumnos\n${links(id)}`,
      })
      expect(config).toMatchObject({
        headers: { Authorization: 'Bearer test-token' },
        timeout: 5000,
      })
      // second report below the threshold: no notice
      expect((await report(userC, id, 'otra')).status).toBe(204)
      await flushNotices()
      expect(postSpy).toHaveBeenCalledTimes(1)
    })

    it('fallbacks for title, author and reason; ARActivities channel and admin url', async () => {
      process.env.MATTERMOST_CHANNEL_ID_ARACTIVITIES = 'aractivities-channel'
      process.env.ARASAAC_ADMIN_URL = 'https://admin.test.org/'
      // userB has no User document
      const id = await listed(userB, { title: '' })
      await report(userC, id)
      await flushNotices()
      expect(postSpy.mock.calls[0][1]).toEqual({
        channel_id: 'aractivities-channel',
        message: `🚩 Nueva denuncia en ARActivities: **Sin título** de autor desconocido\n> (sin motivo)\nhttps://aractivities.arasaac.org/s/${id}?edit · Revisar: https://admin.test.org/shared-activities`,
      })
    })

    it('posts the auto-hide notice with every pending reason', async () => {
      process.env.SHARES_REPORT_HIDE_THRESHOLD = '3'
      const id = await listed(userA, { title: 'Colores' })
      await report(userB, id, 'spam')
      await report(userC, id, '')
      await flushNotices()
      expect(postSpy).toHaveBeenCalledTimes(1)
      await report(userD, id, 'datos personales')
      await flushNotices()
      expect((await Share.findById(id).lean()).hidden).toBe(true)
      expect(postSpy).toHaveBeenCalledTimes(2)
      expect(messages()[1]).toBe(
        `⛔ Actividad ocultada automáticamente tras 3 denuncias: **Colores** de Normal User\n> spam\n> (sin motivo)\n> datos personales\n${links(id)}`,
      )
      // more reports on a hidden link: no more notices
      await report(admin, id, 'más')
      await flushNotices()
      expect(postSpy).toHaveBeenCalledTimes(2)
    })

    it('a first report on an already hidden link does not notify', async () => {
      const id = await listed(userA, {}, { hidden: true })
      expect((await report(userB, id, 'x')).status).toBe(204)
      await flushNotices()
      expect(postSpy).not.toHaveBeenCalled()
    })

    it('mentions in user text are neutralized', async () => {
      const id = await listed(userA, { title: '@all hola' })
      await report(userB, id, '@channel urgente')
      await flushNotices()
      const message = messages()[0]
      expect(message).toContain('**@​all hola**')
      expect(message).toContain('> @​channel urgente')
      expect(message).not.toMatch(/@(channel|all)/)
    })

    it('does nothing when Mattermost is not configured', async () => {
      const id = await listed(userA)
      delete process.env.MATTERMOST_URL
      expect((await report(userB, id, 'x')).status).toBe(204)
      process.env.MATTERMOST_URL = saved.MATTERMOST_URL
      delete process.env.MATTERMOST_TOKEN
      const id2 = await listed(userA)
      expect((await report(userB, id2, 'x')).status).toBe(204)
      process.env.MATTERMOST_TOKEN = saved.MATTERMOST_TOKEN
      delete process.env.MATTERMOST_CHANNEL_ID
      delete process.env.MATTERMOST_CHANNEL_ID_ARACTIVITIES
      const id3 = await listed(userA)
      expect((await report(userB, id3, 'x')).status).toBe(204)
      await flushNotices()
      expect(postSpy).not.toHaveBeenCalled()
      expect((await Share.findById(id3).lean()).reports).toHaveLength(1)
    })

    it('a failing Mattermost never breaks the response', async () => {
      postSpy.mockRejectedValue(new Error('Mattermost down'))
      process.env.SHARES_REPORT_HIDE_THRESHOLD = '1'
      const id = await listed(userA)
      expect((await report(userB, id, 'x')).status).toBe(204)
      await expect(flushNotices()).resolves.toBeDefined()
      expect(postSpy).toHaveBeenCalledTimes(1)
      const doc = await Share.findById(id).lean()
      expect(doc.reports).toHaveLength(1)
      expect(doc.hidden).toBe(true)
      // threshold 1: only the auto-hide notice
      expect(postSpy.mock.calls[0][1].message).toMatch(
        /^⛔ Actividad ocultada automáticamente tras 1 denuncias/,
      )
    })

    it('a slow Mattermost does not delay the response', async () => {
      let release
      postSpy.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      const id = await listed(userA)
      expect((await report(userB, id, 'x')).status).toBe(204)
      // the response is back while the notice is still pending
      for (let i = 0; i < 50 && !release; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(postSpy).toHaveBeenCalledTimes(1)
      release({ data: {} })
      await flushNotices()
    })
  })

  describe('featured links', () => {
    const adminList = (query = {}) =>
      request(app)
        .get('/api/shares/admin')
        .set('Authorization', `Bearer ${admin}`)
        .query(query)

    it('PATCH featured: admins only, boolean, sets featuredAt/featuredBy', async () => {
      const id = await listed(userA)
      expect((await patch(userA, id, { featured: true })).status).toBe(403)
      expect((await patch(userB, id, { featured: true })).status).toBe(403)
      expect((await patch(admin, id, { featured: 'yes' })).status).toBe(400)
      expect((await patch(admin, id, { featured: 1 })).status).toBe(400)
      expect((await Share.findById(id).lean()).featured).toBe(false)

      const before = Date.now()
      const res = await patch(admin, id, { featured: true })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ id, featured: true, hidden: false })
      expect(res.body).not.toHaveProperty('featuredBy')
      let doc = await Share.findById(id).lean()
      expect(doc.featured).toBe(true)
      expect(doc.featuredBy).toBe(ADMIN_ID)
      expect(doc.featuredAt.getTime()).toBeGreaterThanOrEqual(before - 1000)

      const off = await patch(admin, id, { featured: false })
      expect(off.status).toBe(200)
      expect(off.body.featured).toBe(false)
      doc = await Share.findById(id).lean()
      expect(doc.featured).toBe(false)
      // dates are kept as history
      expect(doc.featuredAt).toEqual(expect.any(Date))
    })

    it('GET /:id, /mine and /search include featured', async () => {
      const id = await listed(userA, {}, { featured: true })
      const other = await listed(userA)
      expect((await request(app).get(`/api/shares/${id}`)).body.featured).toBe(
        true,
      )
      const mine = await request(app)
        .get('/api/shares/mine')
        .set('Authorization', `Bearer ${userA}`)
      const byId = Object.fromEntries(mine.body.map((s) => [s.id, s]))
      expect(byId[id].featured).toBe(true)
      expect(byId[other].featured).toBe(false)
      const res = await search()
      const items = Object.fromEntries(res.body.items.map((s) => [s.id, s]))
      expect(items[id].featured).toBe(true)
      expect(items[other].featured).toBe(false)
      expect(JSON.stringify(res.body)).not.toContain('featuredBy')
    })

    it('search featured filter', async () => {
      const featured = await listed(userA, {}, { featured: true })
      const normal = await listed(userA)
      await listed(userA, {}, { featured: true, hidden: true })
      await make(userA, {}, { featured: true })
      for (const value of ['1', 'true']) {
        expect(ids(await search({ featured: value }))).toEqual([featured])
      }
      for (const value of ['', '0', 'false']) {
        expect(ids(await search({ featured: value })).sort()).toEqual(
          [featured, normal].sort(),
        )
      }
      for (const value of ['yes', '2', 'TRUE']) {
        expect((await search({ featured: value })).status).toBe(400)
      }
      expect(
        (await request(app).get('/api/shares/search?featured=1&featured=1'))
          .status,
      ).toBe(400)
    })

    it('ranking: featured first without q, small boost with q, ignored by popular/recent', async () => {
      const now = Date.now()
      const popular = await listed(
        userA,
        { title: 'Gatos' },
        { visits: 5000, listedAt: new Date(now) },
      )
      const featured = await listed(
        userA,
        { title: 'Gatos y perros' },
        { featured: true, listedAt: new Date(now - 400 * DAY) },
      )
      const partial = await listed(
        userA,
        { title: 'Gatos y ratones' },
        { listedAt: new Date(now - 400 * DAY) },
      )
      expect(ids(await search())).toEqual([featured, popular, partial])
      // exact title still wins; the boost beats an equal partial match
      expect(ids(await search({ q: 'gatos' }))).toEqual([
        popular,
        featured,
        partial,
      ])
      expect(ids(await search({ sort: 'popular' }))[0]).toBe(popular)
      expect(ids(await search({ sort: 'recent' }))[0]).toBe(popular)
    })

    it('admin: featured status, counter and featuredAt', async () => {
      const id = await listed(userA)
      await listed(userA)
      await patch(admin, id, { featured: true })
      const all = await adminList()
      expect(all.body.counts).toEqual({
        all: 2,
        reported: 0,
        hidden: 0,
        listed: 2,
        featured: 1,
      })
      const item = all.body.items.find((i) => i.id === id)
      expect(item).toMatchObject({
        featured: true,
        featuredAt: expect.any(String),
      })
      const other = all.body.items.find((i) => i.id !== id)
      expect(other).toMatchObject({ featured: false, featuredAt: null })
      const onlyFeatured = await adminList({ status: 'featured' })
      expect(onlyFeatured.body.items.map((i) => i.id)).toEqual([id])
      expect(onlyFeatured.body.total).toBe(1)
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
      expect(
        indexes.some(
          (i) =>
            JSON.stringify(i.key) ===
            JSON.stringify({ listed: 1, hidden: 1, featured: 1 }),
        ),
      ).toBe(true)
    })
  })
})
