const request = require('supertest')
const axios = require('axios')
const crypto = require('crypto')
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
  cleanShareAssets,
} = require('../../controllers/sharesController')

let app
let server
let axiosSpy
let testPicto
let cacheDir
let assetsDir

const tokenFor = (sub) => jwt.sign({ sub, role: 'user' }, 'test_secret')
const userA = tokenFor('60d5ec49f1b2c82d88c8888a')
const userB = tokenFor('60d5ec49f1b2c82d88c8888b')
const admin = jwt.sign(
  { sub: '60d5ec49f1b2c82d88c88888', role: 'admin' },
  'test_secret',
)
const ASSETS_URL = 'https://static.arasaac.org/materials/aractivities'

const encode = (project) =>
  zlib
    .deflateRawSync(Buffer.from(JSON.stringify(project)))
    .toString('base64url')
const decode = (data) =>
  JSON.parse(zlib.inflateRawSync(Buffer.from(data, 'base64url')).toString())

const shared = (file) => ({ type: 'sharedImage', file, src: '' })

// k1 is used twice, k2 once
const makeProject = (k1 = 'k1', k2 = 'k2', extra = {}) => ({
  metadata: { generator: 'generic' },
  cells: {
    c1: { images: [shared(k1), { type: 'pictogram', pictogramId: 100 }] },
    c2: { images: [shared(k2), shared(k1)] },
  },
  ...extra,
})

const image = async (format, width, height, color = '#1e88e5', fn) => {
  let img = sharp({
    create: { width, height, channels: 3, background: color },
  })
  if (fn) img = fn(img)
  return img.toFormat(format).toBuffer()
}

const noise = (width, height) =>
  sharp(crypto.randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer()

const mime = { webp: 'webp', jpeg: 'jpeg', jpg: 'jpeg', png: 'png' }
const dataUrl = (bytes, format) =>
  `data:image/${mime[format]};base64,${bytes.toString('base64')}`

const sha = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)

let photo1
let photo2
let previewPng

const assetsBody = (extra = {}, project = makeProject()) => ({
  data: encode(project),
  generator: 'generic',
  lang: 'es',
  title: 'Con fotos',
  images: {
    k1: dataUrl(photo1, 'webp'),
    k2: dataUrl(photo2, 'jpeg'),
  },
  preview: dataUrl(previewPng, 'png'),
  ...extra,
})

const post = (token, body) =>
  request(app)
    .post('/api/shares')
    .set('Authorization', `Bearer ${token}`)
    .send(body)

const folders = () => fs.readdirSync(assetsDir).sort()
const filesOf = (id) => fs.readdirSync(path.join(assetsDir, id)).sort()

const getImage = (id) =>
  request(app)
    .get(`/api/shares/${id}/og.png`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => cb(null, Buffer.concat(chunks)))
    })

// downloads (not the auth tokeninfo calls)
const downloads = () =>
  axiosSpy.mock.calls
    .map(([u]) => String(u))
    .filter((u) => u.includes('static.arasaac.org'))

const pixel = async (png, left, top) => {
  const data = await sharp(png)
    .removeAlpha()
    .extract({ left, top, width: 1, height: 1 })
    .raw()
    .toBuffer()
  return [...data]
}

const cacheFile = async (id) => {
  const share = await Share.findById(id).lean()
  const user = await User.findById(share.ownerId).lean()
  return path.join(cacheDir, `${id}-${await ogVersion(share, user)}.png`)
}

beforeAll(async () => {
  await db.open()
  await seedDatabase()
  await Share.init()
  server = require('../../privateapi').listen(0)
  app = server
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shares-og-assets-'))
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shares-assets-'))
  process.env.SHARES_OG_CACHE_DIR = cacheDir
  process.env.SHARES_ASSETS_DIR = assetsDir
  testPicto = await image('png', 500, 500, '#e53935')
  photo1 = await image('webp', 300, 200, '#43a047')
  photo2 = await image('jpeg', 200, 300, '#fdd835')
  previewPng = await image('png', 800, 450, '#1e88e5')
  axiosSpy = jest.spyOn(axios, 'get')
})

afterAll(async () => {
  axiosSpy.mockRestore()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(cacheDir, { recursive: true, force: true })
  fs.rmSync(assetsDir, { recursive: true, force: true })
  delete process.env.SHARES_ASSETS_DIR
  await db.close()
})

beforeEach(async () => {
  await Share.deleteMany({})
  delete process.env.SHARES_ASSETS_URL
  for (const dir of [cacheDir, assetsDir]) {
    fs.readdirSync(dir).forEach((f) =>
      fs.rmSync(path.join(dir, f), { recursive: true, force: true }),
    )
  }
  axiosSpy.mockReset()
  axiosSpy.mockImplementation(async (url) => {
    if (String(url).includes('static.arasaac.org')) return { data: testPicto }
    return { data: {} }
  })
})

describe('Shares assets: capture and photos', () => {
  describe('POST /api/shares', () => {
    it('writes the files with sha names and rewrites the project', async () => {
      const res = await post(userA, assetsBody())
      expect(res.status).toBe(201)
      const { id } = res.body
      const name1 = `${sha(photo1)}.webp`
      const name2 = `${sha(photo2)}.jpg`
      expect(res.body.preview).toBe(`${ASSETS_URL}/${id}/preview.png`)

      expect(folders()).toEqual([id])
      expect(filesOf(id)).toEqual([name1, name2, 'preview.png'].sort())
      // never re-encoded
      const folder = path.join(assetsDir, id)
      expect(fs.readFileSync(path.join(folder, name1)).equals(photo1)).toBe(
        true,
      )
      expect(fs.readFileSync(path.join(folder, name2)).equals(photo2)).toBe(
        true,
      )
      expect(
        fs.readFileSync(path.join(folder, 'preview.png')).equals(previewPng),
      ).toBe(true)

      const doc = await Share.findById(id).lean()
      expect(doc.preview).toBe('preview.png')
      expect(doc.images).toEqual([name1, name2])
      const project = decode(doc.data)
      const ref = (name) => ({
        type: 'sharedImage',
        file: name,
        src: `${ASSETS_URL}/${id}/${name}`,
      })
      expect(project.cells.c1.images).toEqual([
        ref(name1),
        { type: 'pictogram', pictogramId: 100 },
      ])
      expect(project.cells.c2.images).toEqual([ref(name2), ref(name1)])
      expect(project.metadata).toEqual({ generator: 'generic' })
    })

    it('SHARES_ASSETS_URL is read on each request', async () => {
      process.env.SHARES_ASSETS_URL = 'https://cdn.example.org/acts/'
      const res = await post(userA, assetsBody())
      expect(res.body.preview).toBe(
        `https://cdn.example.org/acts/${res.body.id}/preview.png`,
      )
      const doc = await Share.findById(res.body.id).lean()
      expect(decode(doc.data).cells.c1.images[0].src).toBe(
        `https://cdn.example.org/acts/${res.body.id}/${sha(photo1)}.webp`,
      )
    })

    it('same photos with other client keys (or no capture): same link, nothing written', async () => {
      const first = await post(userA, assetsBody())
      expect(first.status).toBe(201)
      const before = filesOf(first.body.id)
      const mtimes = before.map(
        (f) => fs.statSync(path.join(assetsDir, first.body.id, f)).mtimeMs,
      )

      const otherKeys = assetsBody(
        {
          images: {
            'photo-B_2': dataUrl(photo2, 'jpeg'),
            photoA: dataUrl(photo1, 'webp'),
          },
        },
        makeProject('photoA', 'photo-B_2'),
      )
      const second = await post(userA, otherKeys)
      expect(second.status).toBe(200)
      expect(second.body.id).toBe(first.body.id)
      expect(second.body.preview).toBe(first.body.preview)

      const noPreview = await post(userA, assetsBody({ preview: undefined }))
      expect(noPreview.status).toBe(200)
      expect(noPreview.body.id).toBe(first.body.id)

      expect(folders()).toEqual([first.body.id])
      expect(filesOf(first.body.id)).toEqual(before)
      expect(
        before.map(
          (f) => fs.statSync(path.join(assetsDir, first.body.id, f)).mtimeMs,
        ),
      ).toEqual(mtimes)
      expect(await Share.countDocuments()).toBe(1)

      // another photo is another link
      const other = await image('webp', 300, 200, '#8e24aa')
      const third = await post(
        userA,
        assetsBody({
          images: { k1: dataUrl(other, 'webp'), k2: dataUrl(photo2, 'jpeg') },
        }),
      )
      expect(third.status).toBe(201)
      expect(folders()).toHaveLength(2)
    })

    it('only a capture (no photos), and a link without assets has no folder', async () => {
      const capture = await image('webp', 1600, 900)
      const res = await post(userA, {
        data: encode({ cells: { c1: {} } }),
        generator: 'generic',
        title: 'Solo captura',
        preview: dataUrl(capture, 'webp'),
      })
      expect(res.status).toBe(201)
      expect(filesOf(res.body.id)).toEqual(['preview.webp'])
      const doc = await Share.findById(res.body.id).lean()
      expect(doc.images).toEqual([])
      // data is stored as sent when there are no photos
      expect(doc.data).toBe(encode({ cells: { c1: {} } }))

      const plain = await post(userA, {
        data: encode({ cells: { c2: {} } }),
        generator: 'generic',
      })
      expect(plain.status).toBe(201)
      expect(plain.body.preview).toBeNull()
      expect(folders()).toEqual([res.body.id])
    })

    it('a photo used by an older and a newer link is written once per link', async () => {
      const project = {
        cells: { c1: { images: [shared('a'), shared('b')] } },
      }
      // two keys with the same bytes: one file
      const res = await post(userA, {
        data: encode(project),
        generator: 'generic',
        images: { a: dataUrl(photo1, 'webp'), b: dataUrl(photo1, 'webp') },
      })
      expect(res.status).toBe(201)
      expect(filesOf(res.body.id)).toEqual([`${sha(photo1)}.webp`])
      const doc = await Share.findById(res.body.id).lean()
      expect(doc.images).toEqual([`${sha(photo1)}.webp`])
    })

    describe('validation (400, nothing written)', () => {
      const expect400 = async (body, error) => {
        const res = await post(userA, body)
        expect(res.status).toBe(400)
        expect(res.body.error).toEqual(error)
        expect(folders()).toEqual([])
        expect(await Share.countDocuments()).toBe(0)
      }

      it('too many images', async () => {
        const tiny = dataUrl(await image('png', 4, 4), 'png')
        const keys = Array.from({ length: 31 }, (_, i) => `k${i}`)
        await expect400(
          {
            ...assetsBody(),
            data: encode({
              cells: { c1: { images: keys.map((k) => shared(k)) } },
            }),
            images: Object.fromEntries(keys.map((k) => [k, tiny])),
          },
          'Too many images (max 30)',
        )
        // 30 is fine
        const ok = keys.slice(0, 30)
        const res = await post(userA, {
          ...assetsBody(),
          data: encode({ cells: { c1: { images: ok.map((k) => shared(k)) } } }),
          images: Object.fromEntries(ok.map((k) => [k, tiny])),
        })
        expect(res.status).toBe(201)
      })

      it('missing and unused keys', async () => {
        await expect400(
          assetsBody({ images: { k1: dataUrl(photo1, 'webp') } }),
          'Missing images: k2',
        )
        await expect400(
          assetsBody({ images: undefined }),
          expect.stringMatching(/^Missing images: /),
        )
        await expect400(
          assetsBody({
            images: {
              k1: dataUrl(photo1, 'webp'),
              k2: dataUrl(photo2, 'jpeg'),
              k3: dataUrl(photo2, 'jpeg'),
            },
          }),
          'Images not used in the activity: k3',
        )
        await expect400(
          {
            data: encode({ cells: { c1: {} } }),
            generator: 'generic',
            images: { k1: dataUrl(photo1, 'webp') },
          },
          'Images not used in the activity: k1',
        )
      })

      it('invalid keys and invalid shared images', async () => {
        await expect400(
          assetsBody(
            { images: { 'bad key': dataUrl(photo1, 'webp') } },
            { cells: { c1: { images: [shared('bad key')] } } },
          ),
          'Invalid image key',
        )
        await expect400(
          assetsBody(
            { images: { ['k'.repeat(65)]: dataUrl(photo1, 'webp') } },
            { cells: { c1: { images: [shared('k'.repeat(65))] } } },
          ),
          'Invalid image key',
        )
        for (const file of [undefined, '', '../x', 5, 'k'.repeat(65)]) {
          await expect400(
            assetsBody(
              { images: {} },
              { cells: { c1: { images: [{ type: 'sharedImage', file }] } } },
            ),
            'Invalid shared image',
          )
        }
        await expect400(assetsBody({ images: ['x'] }), 'Invalid images')
        await expect400(assetsBody({ images: 'x' }), 'Invalid images')
      })

      it('bad format or not an image', async () => {
        const tiff = await image('tiff', 10, 10)
        const gif = await image('gif', 10, 10)
        await expect400(
          assetsBody({
            images: { k1: dataUrl(tiff, 'png'), k2: dataUrl(photo2, 'jpeg') },
          }),
          'Invalid Image k1 format',
        )
        await expect400(
          assetsBody({
            images: {
              k1: `data:image/gif;base64,${gif.toString('base64')}`,
              k2: dataUrl(photo2, 'jpeg'),
            },
          }),
          'Invalid Image k1',
        )
        await expect400(
          assetsBody({
            images: {
              k1: dataUrl(Buffer.from('not an image'), 'png'),
              k2: dataUrl(photo2, 'jpeg'),
            },
          }),
          'Invalid Image k1',
        )
        await expect400(
          assetsBody({
            images: { k1: 5, k2: dataUrl(photo2, 'jpeg') },
          }),
          'Invalid Image k1',
        )
        await expect400(
          assetsBody({ preview: dataUrl(tiff, 'webp') }),
          'Invalid Preview format',
        )
        await expect400(assetsBody({ preview: 'hello' }), 'Invalid Preview')
      })

      it('too large in px and in bytes', async () => {
        await expect400(
          assetsBody({
            images: {
              k1: dataUrl(await image('png', 1025, 10), 'png'),
              k2: dataUrl(photo2, 'jpeg'),
            },
          }),
          'Image k1 too large (max 1024 px)',
        )
        await expect400(
          assetsBody({
            images: {
              k1: dataUrl(photo1, 'webp'),
              k2: dataUrl(await image('png', 10, 1025), 'png'),
            },
          }),
          'Image k2 too large (max 1024 px)',
        )
        const heavy = await noise(500, 500) // ~750 KB
        expect(heavy.length).toBeGreaterThan(600 * 1024)
        await expect400(
          assetsBody({
            images: { k1: dataUrl(heavy, 'png'), k2: dataUrl(photo2, 'jpeg') },
          }),
          'Image k1 too large (max 614400 bytes)',
        )
        await expect400(
          assetsBody({ preview: dataUrl(await image('png', 1601, 10), 'png') }),
          'Preview too large (max 1600 px)',
        )
        const heavyPreview = await noise(420, 420) // ~530 KB
        expect(heavyPreview.length).toBeGreaterThan(500 * 1024)
        await expect400(
          assetsBody({ preview: dataUrl(heavyPreview, 'png') }),
          'Preview too large (max 512000 bytes)',
        )
      })

      it('EXIF data', async () => {
        const withExif = await image('jpeg', 50, 50, '#000000', (img) =>
          img.withExif({ IFD0: { Copyright: 'someone' } }),
        )
        expect((await sharp(withExif).metadata()).exif).toBeTruthy()
        await expect400(
          assetsBody({
            images: {
              k1: dataUrl(withExif, 'jpeg'),
              k2: dataUrl(photo2, 'jpeg'),
            },
          }),
          'Image k1 must not have EXIF data',
        )
        await expect400(
          assetsBody({ preview: dataUrl(withExif, 'jpeg') }),
          'Preview must not have EXIF data',
        )
      })
    })

    it('if the document cannot be created the folder is removed', async () => {
      const spy = jest
        .spyOn(Share, 'create')
        .mockRejectedValueOnce(new Error('db down'))
      try {
        const res = await post(userA, assetsBody())
        expect(res.status).toBe(500)
      } finally {
        spy.mockRestore()
      }
      expect(folders()).toEqual([])
      expect(await Share.countDocuments()).toBe(0)
    })

    it('accepts a ~7 MB request with real photos', async () => {
      const keys = Array.from({ length: 10 }, (_, i) => `p${i}`)
      const photos = await Promise.all(keys.map(() => noise(420, 420)))
      const body = {
        data: encode({ cells: { c1: { images: keys.map((k) => shared(k)) } } }),
        generator: 'generic',
        images: Object.fromEntries(
          keys.map((k, i) => [k, dataUrl(photos[i], 'png')]),
        ),
      }
      expect(JSON.stringify(body).length).toBeGreaterThan(6 * 1024 * 1024)
      const res = await post(userA, body)
      expect(res.status).toBe(201)
      expect(filesOf(res.body.id)).toHaveLength(10)
    })
  })

  describe('reading', () => {
    it('GET /:id, /search, /mine and /admin include the assets', async () => {
      const { body: created } = await post(userA, assetsBody())
      const { id } = created
      const previewUrl = `${ASSETS_URL}/${id}/preview.png`
      const images = [
        `${ASSETS_URL}/${id}/${sha(photo1)}.webp`,
        `${ASSETS_URL}/${id}/${sha(photo2)}.jpg`,
      ]
      const plain = await post(userA, {
        data: encode({ cells: { c: {} } }),
        generator: 'generic',
      })

      const got = await request(app).get(`/api/shares/${id}`)
      expect(got.status).toBe(200)
      expect(got.body.preview).toBe(previewUrl)
      expect(got.body.images).toEqual(images)
      const gotPlain = await request(app).get(`/api/shares/${plain.body.id}`)
      expect(gotPlain.body.preview).toBeNull()
      expect(gotPlain.body.images).toEqual([])

      await request(app)
        .patch(`/api/shares/${id}`)
        .set('Authorization', `Bearer ${userA}`)
        .send({ listed: true })
      const found = await request(app).get('/api/shares/search')
      expect(found.body.items).toHaveLength(1)
      expect(found.body.items[0].preview).toBe(previewUrl)
      expect(found.body.items[0]).not.toHaveProperty('images')

      const mine = await request(app)
        .get('/api/shares/mine')
        .set('Authorization', `Bearer ${userA}`)
      const byId = Object.fromEntries(mine.body.map((s) => [s.id, s]))
      expect(byId[id]).toMatchObject({ preview: previewUrl, imagesCount: 2 })
      expect(byId[plain.body.id]).toMatchObject({
        preview: null,
        imagesCount: 0,
      })

      const adminRes = await request(app)
        .get('/api/shares/admin')
        .set('Authorization', `Bearer ${admin}`)
      const item = adminRes.body.items.find((s) => s.id === id)
      expect(item.preview).toBe(previewUrl)
      expect(item.images).toEqual(images)
    })
  })

  describe('og.png with the capture', () => {
    const BLUE = [0x1e, 0x88, 0xe5]
    const RED = [0xe5, 0x39, 0x35]
    // center of the area above the author strip / of the large avatar
    const AREA = [600, 239]

    it('draws the capture above the author strip', async () => {
      const { body: created } = await post(userA, assetsBody())
      const res = await getImage(created.id)
      expect(res.status).toBe(200)
      const meta = await sharp(res.body).metadata()
      expect([meta.format, meta.width, meta.height]).toEqual(['png', 1200, 630])
      expect(res.body.length).toBeLessThan(300 * 1024)
      expect(await pixel(res.body, ...AREA)).toEqual(BLUE)
      // the white border of the box, left of the capture
      const scaled = Math.round((374 * 800) / 450)
      const boxLeft = Math.round((1200 - scaled - 24) / 2)
      expect(await pixel(res.body, boxLeft + 6, 239)).toEqual([255, 255, 255])
      // the green background outside
      expect(await pixel(res.body, 20, 20)).toEqual([0x8b, 0xc3, 0x4a])
      // the author's avatar is still drawn
      expect(downloads()).toEqual([
        'https://static.arasaac.org/pictograms/28307/28307_300.png',
      ])
      // cached by version
      expect(fs.existsSync(await cacheFile(created.id))).toBe(true)
    })

    it('without a user only the capture is drawn', async () => {
      const { body: created } = await post(userB, assetsBody())
      const res = await getImage(created.id)
      expect(res.status).toBe(200)
      expect(await pixel(res.body, 600, 315)).toEqual(BLUE)
      expect(downloads()).toEqual([])
    })

    it('the version depends on the capture; falls back when it is missing or broken', async () => {
      const { body: created } = await post(userA, assetsBody())
      const { id } = created
      const withCapture = await cacheFile(id)
      const page = await request(app).get(`/api/shares/${id}/page`)
      expect(page.text).toContain(
        `og.png?v=${path.basename(withCapture).slice(9, 19)}`,
      )
      const file = path.join(assetsDir, id, 'preview.png')

      // broken: the author layout, not cached
      fs.writeFileSync(file, 'not an image')
      const broken = await cacheFile(id)
      expect(broken).not.toBe(withCapture)
      const res = await getImage(id)
      expect(res.status).toBe(200)
      expect(await pixel(res.body, ...AREA)).toEqual(RED)
      expect(fs.existsSync(broken)).toBe(false)

      // missing (e.g. deleted by hand): the author layout, cached
      fs.unlinkSync(file)
      const missing = await cacheFile(id)
      expect(missing).not.toBe(withCapture)
      const res2 = await getImage(id)
      expect(await pixel(res2.body, ...AREA)).toEqual(RED)
      expect(fs.existsSync(missing)).toBe(true)

      // back again: the capture
      fs.writeFileSync(file, previewPng)
      const res3 = await getImage(id)
      expect(await pixel(res3.body, ...AREA)).toEqual(BLUE)
    })
  })

  describe('deleting and expiry', () => {
    it('DELETE removes the folder (owner and admin)', async () => {
      const { body: one } = await post(userA, assetsBody())
      const { body: two } = await post(userA, assetsBody({ title: 'otra' }))
      expect(folders()).toEqual([one.id, two.id].sort())
      const del = await request(app)
        .delete(`/api/shares/${one.id}`)
        .set('Authorization', `Bearer ${userA}`)
      expect(del.status).toBe(204)
      expect(folders()).toEqual([two.id])
      const byAdmin = await request(app)
        .delete(`/api/shares/${two.id}`)
        .set('Authorization', `Bearer ${admin}`)
      expect(byAdmin.status).toBe(204)
      expect(folders()).toEqual([])
    })

    it('cleanShareAssets removes orphan folders older than 1 hour', async () => {
      const past = new Date(Date.now() - 2 * 3600 * 1000)
      const age = (name) =>
        fs.utimesSync(path.join(assetsDir, name), past, past)
      const mkFolder = (name, files = ['preview.webp']) => {
        fs.mkdirSync(path.join(assetsDir, name))
        files.forEach((f) =>
          fs.writeFileSync(path.join(assetsDir, name, f), 'x'),
        )
      }

      const { body: alive } = await post(userA, assetsBody())
      const { body: expired } = await post(userA, assetsBody({ title: 'b' }))
      // expired by the TTL index (or deleted without the API)
      await Share.deleteOne({ _id: expired.id })
      age(alive.id)
      age(expired.id)

      mkFolder('Orphan01', ['0123456789abcdef.webp', '.x.webp.1.tmp'])
      age('Orphan01')
      mkFolder('Orphan02') // too recent: maybe being created
      mkFolder('notAnId') // not an id
      age('notAnId')
      mkFolder('Material', ['readme.txt']) // not made by us
      age('Material')
      fs.writeFileSync(path.join(assetsDir, 'Abcdefgh'), 'x') // a file
      fs.utimesSync(path.join(assetsDir, 'Abcdefgh'), past, past)

      expect(await cleanShareAssets()).toBe(2)
      expect(folders()).toEqual(
        [alive.id, 'Orphan02', 'notAnId', 'Material', 'Abcdefgh'].sort(),
      )
      expect(filesOf(alive.id)).toHaveLength(3)
    })

    it('cleanShareAssets returns 0 when the folder does not exist', async () => {
      process.env.SHARES_ASSETS_DIR = path.join(assetsDir, 'missing')
      try {
        expect(await cleanShareAssets()).toBe(0)
      } finally {
        process.env.SHARES_ASSETS_DIR = assetsDir
      }
    })
  })
})
