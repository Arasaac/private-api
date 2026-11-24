const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const axios = require('axios')
const sharp = require('sharp')
const zlib = require('zlib')
const { customAlphabet } = require('nanoid')
const rateLimit = require('express-rate-limit')
const Share = require('../models/Share')
const logger = require('../utils/logger')

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const newId = customAlphabet(BASE62, 8)
const ID_REGEX = /^[0-9A-Za-z]{8}$/

const FRONT_URL = 'https://aractivities.arasaac.org/s'
const API_URL = 'https://privateapi.arasaac.org/api/shares'

const GENERATORS = [
  'generic',
  'intruders',
  'timetable',
  'bingo',
  'domino',
  'cube',
  'arawrite',
  'calendar',
]
const MAX_CELLS = 5000
const MAX_TITLE = 100
const MAX_PICTOGRAMS = 6
const MAX_INFLATED_BYTES = 20 * 1024 * 1024

const escapeHtml = (value) =>
  String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const cleanTitle = (title) =>
  String(title === undefined || title === null ? '' : title)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
    .trim()
    .slice(0, MAX_TITLE)

const cleanLang = (lang) =>
  typeof lang === 'string'
    ? lang.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 10)
    : ''

const decodeProject = (data) => {
  if (typeof data !== 'string' || !/^[A-Za-z0-9_-]+$/.test(data)) return null
  try {
    const compressed = Buffer.from(data, 'base64url')
    const json = zlib
      .inflateRawSync(compressed, { maxOutputLength: MAX_INFLATED_BYTES })
      .toString('utf8')
    const project = JSON.parse(json)
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      return null
    }
    return project
  } catch (err) {
    return null
  }
}

const extractPictogramIds = (cells) => {
  const ids = new Set()
  Object.values(cells).forEach((cell) => {
    const images = cell && Array.isArray(cell.images) ? cell.images : []
    images.forEach((img) => {
      if (
        img &&
        (img.type === undefined || img.type === 'pictogram') &&
        Number.isInteger(img.pictogramId) &&
        img.pictogramId > 0
      ) {
        ids.add(img.pictogramId)
      }
    })
  })
  return [...ids].slice(0, MAX_PICTOGRAMS)
}

const DEFAULT_DAILY_LIMIT = 100

// New links per user per day. It runs only when a new link is about to be
// created, so repeating an existing one (200) never counts or gets blocked.
// The limit is read on each request so it can be configured (e.g. in tests).
const createLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: () => Number(process.env.SHARES_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT,
  keyGenerator: (req) => String(req.user.id),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many shared links created today' },
})

const checkLimit = (req, res) =>
  new Promise((resolve) => createLimiter(req, res, () => resolve(true))).then(
    (ok) => ok,
  )

// ---- og.png (social preview image) ----
const OG_WIDTH = 1200
const OG_HEIGHT = 630
const OG_MAX_BYTES = 300 * 1024
const OG_GREEN = '#8bc34a'
const OG_LOGO = path.join(
  __dirname,
  '..',
  'assets',
  'og',
  'logo_aractivities.png',
)
const OG_GENERIC = path.join(__dirname, '..', 'assets', 'og', 'generic.png')
const PICTO_SIZE = 160
const PICTO_GAP = 24
const BOX_PADDING = 40
const OG_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const ogCacheDir = () =>
  process.env.SHARES_OG_CACHE_DIR || path.join(os.tmpdir(), 'shares-og')
const ogCachePath = (id) => path.join(ogCacheDir(), `${id}.png`)

const toPng = async (image) => {
  let buffer = await image.png({ compressionLevel: 9 }).toBuffer()
  if (buffer.length > OG_MAX_BYTES) {
    buffer = await sharp(buffer)
      .png({ palette: true, compressionLevel: 9 })
      .toBuffer()
  }
  return buffer
}

const logoLayer = async (top) => {
  const input = await sharp(OG_LOGO).resize({ width: 720 }).toBuffer()
  const { width } = await sharp(input).metadata()
  return { input, left: Math.round((OG_WIDTH - width) / 2), top }
}

const background = () =>
  sharp({
    create: {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      channels: 3,
      background: OG_GREEN,
    },
  })

// Generic image: logo centered on green. No text (no fonts in the container).
const buildGenericImage = async () => {
  const { height } = await sharp(OG_LOGO).resize({ width: 720 }).metadata()
  const logo = await logoLayer(Math.round((OG_HEIGHT - height) / 2))
  return toPng(background().composite([logo]))
}

const getGenericImage = async () => {
  try {
    return await fs.promises.readFile(OG_GENERIC)
  } catch (err) {
    return buildGenericImage()
  }
}

const downloadPictogram = async (id) => {
  const url = `https://static.arasaac.org/pictograms/${id}/${id}_500.png`
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 5000,
  })
  return sharp(Buffer.from(res.data))
    .resize(PICTO_SIZE, PICTO_SIZE, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .png()
    .toBuffer()
}

// returns { buffer, complete }: complete=false if any download failed (or none)
const buildShareImage = async (pictogramIds) => {
  const ids = (pictogramIds || []).slice(0, MAX_PICTOGRAMS)
  const results = await Promise.all(
    ids.map((id) =>
      downloadPictogram(id).catch((err) => {
        logger.debug(`og.png: could not get pictogram ${id}: ${err.message}`)
        return null
      }),
    ),
  )
  const pictos = results.filter(Boolean)
  const complete = pictos.length === ids.length
  if (pictos.length === 0)
    return { buffer: await getGenericImage(), complete: false }

  const logo = await logoLayer(40)
  const logoHeight = (await sharp(logo.input).metadata()).height
  const n = pictos.length
  const boxWidth = n * PICTO_SIZE + (n - 1) * PICTO_GAP + 2 * BOX_PADDING
  const boxHeight = PICTO_SIZE + 2 * BOX_PADDING
  const boxLeft = Math.round((OG_WIDTH - boxWidth) / 2)
  const areaTop = 40 + logoHeight + 30
  const boxTop = Math.round(
    areaTop + (OG_HEIGHT - 40 - areaTop - boxHeight) / 2,
  )
  const box = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${boxWidth}" height="${boxHeight}"><rect width="${boxWidth}" height="${boxHeight}" rx="36" ry="36" fill="#ffffff"/></svg>`,
  )
  const layers = [
    logo,
    { input: box, left: boxLeft, top: boxTop },
    ...pictos.map((input, i) => ({
      input,
      left: boxLeft + BOX_PADDING + i * (PICTO_SIZE + PICTO_GAP),
      top: boxTop + BOX_PADDING,
    })),
  ]
  return { buffer: await toPng(background().composite(layers)), complete }
}

const sendPng = (res, buffer) => {
  res.set({
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400',
  })
  return res.status(200).send(buffer)
}

const ogImage = async (req, res) => {
  const { id } = req.params
  if (!ID_REGEX.test(id)) return res.status(404).json({ error: 'Not found' })
  try {
    // existence check only: does not count visits nor touch lastAccessedAt
    const share = await Share.findById(id, { pictogramIds: 1 }).lean()
    if (!share) return res.status(404).json({ error: 'Not found' })

    try {
      return sendPng(res, await fs.promises.readFile(ogCachePath(id)))
    } catch (err) {
      // not cached yet
    }

    const { buffer, complete } = await buildShareImage(share.pictogramIds)
    // do not cache incomplete images, so a transient failure can heal later
    if (complete) {
      try {
        await fs.promises.mkdir(ogCacheDir(), { recursive: true })
        const tmp = `${ogCachePath(id)}.${process.pid}.${Date.now()}.tmp`
        await fs.promises.writeFile(tmp, buffer)
        await fs.promises.rename(tmp, ogCachePath(id))
      } catch (err) {
        logger.warn(`og.png: could not write cache for ${id}: ${err.message}`)
      }
    }
    return sendPng(res, buffer)
  } catch (error) {
    logger.error(`Error building og.png: ${error.message}`)
    try {
      return sendPng(res, await getGenericImage())
    } catch (err) {
      return res.status(500).json({ error: 'Error building image' })
    }
  }
}

const removeOgCache = async (id) => {
  try {
    await fs.promises.unlink(ogCachePath(id))
  } catch (err) {
    if (err.code !== 'ENOENT')
      logger.warn(`og.png: cache delete failed: ${err.message}`)
  }
}

// Used by crontab: delete cached PNGs older than 30 days
const cleanOgCache = async () => {
  const dir = ogCacheDir()
  let files
  try {
    files = await fs.promises.readdir(dir)
  } catch (err) {
    return 0
  }
  const limit = Date.now() - OG_CACHE_MAX_AGE_MS
  let removed = 0
  for (const file of files) {
    if (!file.endsWith('.png')) continue
    try {
      const full = path.join(dir, file)
      const stat = await fs.promises.stat(full)
      if (stat.mtimeMs < limit) {
        await fs.promises.unlink(full)
        removed++
      }
    } catch (err) {
      logger.warn(`og.png: cache cleanup failed for ${file}: ${err.message}`)
    }
  }
  return removed
}

const create = async (req, res) => {
  logger.debug('EXEC create sharesController')
  const ownerId = req.user.id
  const { data, generator, lang } = req.body || {}

  if (!GENERATORS.includes(generator)) {
    return res.status(400).json({ error: 'Invalid generator' })
  }
  const project = decodeProject(data)
  if (!project) {
    return res.status(400).json({ error: 'Invalid data' })
  }
  const cells = project.cells
  if (!cells || typeof cells !== 'object' || Array.isArray(cells)) {
    return res.status(400).json({ error: 'Invalid project: missing cells' })
  }
  if (Object.keys(cells).length > MAX_CELLS) {
    return res.status(400).json({ error: 'Too many cells' })
  }

  const title = cleanTitle(req.body.title)
  const cleanedLang = cleanLang(lang)
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(project) + title + cleanedLang + ownerId)
    .digest('hex')

  const respond = (status, id) => {
    const url = `${FRONT_URL}/${id}`
    return res.status(status).json({ id, url, editUrl: `${url}?edit` })
  }

  try {
    const existing = await Share.findOne({ ownerId, hash }, { _id: 1 }).lean()
    if (existing) return respond(200, existing._id)

    // createLimiter answers 429 itself and never calls next in that case
    const allowed = await Promise.race([
      checkLimit(req, res),
      new Promise((resolve) => res.once('finish', () => resolve(false))),
    ])
    if (!allowed) return

    const pictogramIds = extractPictogramIds(cells)
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId()
      try {
        await Share.create({
          _id: id,
          ownerId,
          hash,
          data,
          generator,
          lang: cleanedLang,
          title,
          pictogramIds,
        })
        return respond(201, id)
      } catch (err) {
        if (err && err.code === 11000) {
          // duplicate: same content created concurrently, or id collision
          const same = await Share.findOne({ ownerId, hash }, { _id: 1 }).lean()
          if (same) return respond(200, same._id)
          continue
        }
        throw err
      }
    }
    throw new Error('Could not generate a unique id')
  } catch (error) {
    logger.error(`Error creating share: ${error.message}`)
    return res.status(500).json({ error: 'Error creating share' })
  }
}

const mine = async (req, res) => {
  try {
    const shares = await Share.find({ ownerId: req.user.id })
      .select('-data')
      .sort({ createdAt: -1 })
      .lean()
    return res.status(200).json(
      shares.map((s) => ({
        id: s._id,
        title: s.title,
        generator: s.generator,
        lang: s.lang,
        createdAt: s.createdAt,
        lastAccessedAt: s.lastAccessedAt,
        visits: s.visits,
      })),
    )
  } catch (error) {
    logger.error(`Error listing shares: ${error.message}`)
    return res.status(500).json({ error: 'Error listing shares' })
  }
}

const get = async (req, res) => {
  const { id } = req.params
  if (!ID_REGEX.test(id)) return res.status(404).json({ error: 'Not found' })
  try {
    const share = await Share.findOneAndUpdate(
      { _id: id },
      { $inc: { visits: 1 }, $set: { lastAccessedAt: new Date() } },
      { new: true },
    ).lean()
    if (!share) return res.status(404).json({ error: 'Not found' })
    const { data, generator, lang, title, createdAt } = share
    return res.status(200).json({ data, generator, lang, title, createdAt })
  } catch (error) {
    logger.error(`Error getting share: ${error.message}`)
    return res.status(500).json({ error: 'Error getting share' })
  }
}

const remove = async (req, res) => {
  const { id } = req.params
  if (!ID_REGEX.test(id)) return res.status(404).json({ error: 'Not found' })
  try {
    const share = await Share.findById(id, { ownerId: 1 }).lean()
    if (!share) return res.status(404).json({ error: 'Not found' })
    if (share.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    await Share.deleteOne({ _id: id, ownerId: req.user.id })
    await removeOgCache(id)
    return res.status(204).end()
  } catch (error) {
    logger.error(`Error deleting share: ${error.message}`)
    return res.status(500).json({ error: 'Error deleting share' })
  }
}

const page = async (req, res) => {
  const { id } = req.params
  res.set('Content-Type', 'text/html; charset=utf-8')
  try {
    const share = ID_REGEX.test(id)
      ? await Share.findById(id, { title: 1 }).lean()
      : null
    if (!share) {
      return res
        .status(404)
        .send(
          '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>No encontrado</title></head><body><p>Esta actividad no existe o ha caducado.</p></body></html>',
        )
    }
    const url = `${FRONT_URL}/${id}`
    const ogTitle = `${share.title || 'Actividad'} · ARActivities`
    const description =
      'Actividad creada con ARActivities, de ARASAAC. Ábrela para verla y usarla.'
    const image = `${API_URL}/${id}/og.png`
    const e = escapeHtml
    return res.status(200).send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${e(ogTitle)}</title>
<meta name="robots" content="noindex, nofollow">
<meta property="og:title" content="${e(ogTitle)}">
<meta property="og:description" content="${e(description)}">
<meta property="og:image" content="${e(image)}">
<meta property="og:url" content="${e(url)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
</head>
<body>
<p><a href="${e(url)}">${e(url)}</a></p>
</body>
</html>`)
  } catch (error) {
    logger.error(`Error rendering share page: ${error.message}`)
    return res.status(500).send('Error')
  }
}

module.exports = {
  create,
  mine,
  get,
  remove,
  page,
  ogImage,
  cleanOgCache,
  buildGenericImage,
  escapeHtml,
}
