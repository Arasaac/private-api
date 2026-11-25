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
const User = require('../models/User')
const logger = require('../utils/logger')
const constants = require('../utils/constants')
const { postToMattermost } = require('../utils/mattermost')
const {
  normalizeText,
  escapeRegex,
  buildSearchText,
  tokenize,
  prefixPattern,
  rankShares,
} = require('../utils/sharesSearch')

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const newId = customAlphabet(BASE62, 8)
const ID_REGEX = /^[0-9A-Za-z]{8}$/
const USER_ID_REGEX = /^[0-9a-fA-F]{24}$/

const FRONT_URL = 'https://aractivities.arasaac.org/s'
const API_URL = 'https://privateapi.arasaac.org/api/shares'
const DEFAULT_PICTURE =
  'https://static.arasaac.org/pictograms/28307/28307_300.png'

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
const SORTS = ['relevance', 'popular', 'recent']
const MAX_CELLS = 5000
const MAX_TITLE = 100
const MAX_DESCRIPTION = 200
const MAX_REASON = 300
const MAX_QUERY = 100
const MAX_SEARCH_CANDIDATES = 5000
const DEFAULT_SEARCH_LIMIT = 24
const MAX_SEARCH_LIMIT = 48
const DEFAULT_REPORT_HIDE_THRESHOLD = 3
const MAX_INFLATED_BYTES = 20 * 1024 * 1024

const escapeHtml = (value) =>
  String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const cleanText = (value, max) =>
  String(value === undefined || value === null ? '' : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
    .trim()
    .slice(0, max)

const cleanTitle = (title) => cleanText(title, MAX_TITLE)
const cleanDescription = (description) =>
  cleanText(description, MAX_DESCRIPTION)

const cleanLang = (lang) =>
  typeof lang === 'string'
    ? lang.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 10)
    : ''

const listedValue = (share) =>
  share.listed === undefined || share.listed === null ? null : share.listed

// a hidden share is only available to its owner and to admins
const canSeeHidden = (user, share) =>
  !!user && (user.role === 'admin' || String(user.id) === share.ownerId)

const isBlocked = (user, share) =>
  share.hidden === true && !canSeeHidden(user, share)

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

// ---- authors ----

// facebook pictures expire, so only google pictures are used
const pictureFor = (user) =>
  user &&
  user.pictureProvider === 'google' &&
  user.google &&
  user.google.picture
    ? user.google.picture
    : DEFAULT_PICTURE

// public author data only: never email or other user fields
const authorFor = (id, user) => ({
  id: String(id),
  name: (user && user.name) || '',
  picture: pictureFor(user),
})

const USER_FIELDS = { name: 1, pictureProvider: 1, 'google.picture': 1 }

// Map id -> user (lean) with one query. Invalid ids are skipped.
const findUsers = async (ids) => {
  const valid = [...new Set(ids.map(String))].filter((id) =>
    USER_ID_REGEX.test(id),
  )
  if (valid.length === 0) return new Map()
  const users = await User.find({ _id: { $in: valid } }, USER_FIELDS).lean()
  return new Map(users.map((u) => [String(u._id), u]))
}

const findUser = async (id) => (await findUsers([id])).get(String(id)) || null

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

// ---- shared assets (activity capture and the author's photos) ----
// One folder per link in the materials volume, served by static.arasaac.org.
// Images are checked but never re-encoded: the client already optimized them.
const MAX_IMAGES = 30
const IMAGE_KEY_REGEX = /^[A-Za-z0-9_-]{1,64}$/
const PHOTO_LIMITS = { maxSide: 1024, maxBytes: 600 * 1024 }
const PREVIEW_LIMITS = { maxSide: 1600, maxBytes: 500 * 1024 }
// sharp format -> file extension
const IMAGE_FORMATS = { webp: 'webp', jpeg: 'jpg', png: 'png' }
const DATA_URL_REGEX =
  /^data:image\/(?:webp|jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/
const PREVIEW_NAME_REGEX = /^preview\.(?:webp|jpg|png)$/
const PHOTO_NAME_REGEX = /^[0-9a-f]{16}\.(?:webp|jpg|png)$/
const TMP_NAME_REGEX = /^\..+\.tmp$/
// orphan folders younger than this are kept (a link may be being created)
const ASSETS_MIN_AGE_MS = 60 * 60 * 1000

// read on each call (tests point them to a temp dir)
const assetsDir = () => constants.ARACTIVITIES_DIR
const assetsUrl = () => constants.ARACTIVITIES_URL.replace(/\/+$/, '')
const assetFolder = (id) => path.join(assetsDir(), id)
const assetUrl = (id, name) => `${assetsUrl()}/${id}/${name}`

const isPreviewName = (name) =>
  typeof name === 'string' && PREVIEW_NAME_REGEX.test(name)

const previewUrl = (share) =>
  share && isPreviewName(share.preview)
    ? assetUrl(share._id, share.preview)
    : null

const imageUrls = (share) =>
  ((share && share.images) || []).map((name) => assetUrl(share._id, name))

const sha256 = (value) =>
  crypto.createHash('sha256').update(value).digest('hex')

// a 400 for the client
class AssetError extends Error {}

// decodes and checks a data URL image: { bytes, ext }
const readImage = async (value, limits, label) => {
  if (typeof value !== 'string') throw new AssetError(`Invalid ${label}`)
  // cheap check before decoding (base64 is 4/3 of the bytes)
  if (value.length > Math.ceil((limits.maxBytes * 4) / 3) + 64) {
    throw new AssetError(`${label} too large (max ${limits.maxBytes} bytes)`)
  }
  const match = DATA_URL_REGEX.exec(value)
  if (!match) throw new AssetError(`Invalid ${label}`)
  const bytes = Buffer.from(match[1], 'base64')
  if (bytes.length > limits.maxBytes) {
    throw new AssetError(`${label} too large (max ${limits.maxBytes} bytes)`)
  }
  let meta
  try {
    meta = await sharp(bytes).metadata()
  } catch (err) {
    throw new AssetError(`Invalid ${label}`)
  }
  const ext = IMAGE_FORMATS[meta.format]
  if (!ext) throw new AssetError(`Invalid ${label} format`)
  if (
    !meta.width ||
    !meta.height ||
    meta.width > limits.maxSide ||
    meta.height > limits.maxSide
  ) {
    throw new AssetError(`${label} too large (max ${limits.maxSide} px)`)
  }
  if (meta.exif) throw new AssetError(`${label} must not have EXIF data`)
  if ((meta.pages || 1) > 1)
    throw new AssetError(`${label} must not be animated`)
  return { bytes, ext }
}

// every { type: 'sharedImage' } object in the project (iterative walk)
const findSharedImages = (project) => {
  const refs = []
  const stack = [project]
  while (stack.length) {
    const node = stack.pop()
    if (!Array.isArray(node) && node.type === 'sharedImage') refs.push(node)
    Object.values(node).forEach((value) => {
      if (value && typeof value === 'object') stack.push(value)
    })
  }
  return refs
}

// Checks the photos and the capture of a new link and replaces, in the
// project, each client key with the final file name (and src with ''), so the
// same photos give the same hash whatever the client keys.
// Returns { refs, photos: [{ name, bytes }], preview: { name, bytes } | null }
const prepareAssets = async (project, images, preview) => {
  if (
    images !== undefined &&
    images !== null &&
    (typeof images !== 'object' || Array.isArray(images))
  ) {
    throw new AssetError('Invalid images')
  }
  const keys = images ? Object.keys(images) : []
  if (keys.length > MAX_IMAGES) {
    throw new AssetError(`Too many images (max ${MAX_IMAGES})`)
  }
  if (keys.some((key) => !IMAGE_KEY_REGEX.test(key))) {
    throw new AssetError('Invalid image key')
  }
  const refs = findSharedImages(project)
  const referenced = new Set()
  refs.forEach((ref) => {
    if (typeof ref.file !== 'string' || !IMAGE_KEY_REGEX.test(ref.file)) {
      throw new AssetError('Invalid shared image')
    }
    referenced.add(ref.file)
  })
  const given = new Set(keys)
  const missing = [...referenced].filter((key) => !given.has(key))
  if (missing.length) {
    throw new AssetError(`Missing images: ${missing.join(', ')}`)
  }
  const unused = keys.filter((key) => !referenced.has(key))
  if (unused.length) {
    throw new AssetError(
      `Images not used in the activity: ${unused.join(', ')}`,
    )
  }

  // one by one: bounded memory
  const names = new Map()
  const photos = new Map()
  for (const key of keys) {
    const { bytes, ext } = await readImage(
      images[key],
      PHOTO_LIMITS,
      `Image ${key}`,
    )
    const name = `${sha256(bytes).slice(0, 16)}.${ext}`
    names.set(key, name)
    photos.set(name, { name, bytes })
  }
  let capture = null
  if (preview !== undefined && preview !== null) {
    const { bytes, ext } = await readImage(preview, PREVIEW_LIMITS, 'Preview')
    capture = { name: `preview.${ext}`, bytes }
  }
  refs.forEach((ref) => {
    ref.file = names.get(ref.file)
    ref.src = ''
  })
  return { refs, photos: [...photos.values()], preview: capture }
}

const encodeProject = (project) =>
  zlib
    .deflateRawSync(Buffer.from(JSON.stringify(project), 'utf8'))
    .toString('base64url')

const removeAssets = async (id) => {
  if (!ID_REGEX.test(id)) return
  try {
    await fs.promises.rm(assetFolder(id), { recursive: true, force: true })
  } catch (err) {
    logger.warn(`Could not remove the assets of share ${id}: ${err.message}`)
  }
}

// Writes the files in a new folder for `id`. The folder must not exist
// (EEXIST is thrown as is, so the caller tries another id).
const writeAssets = async (id, files) => {
  await fs.promises.mkdir(assetsDir(), { recursive: true })
  const folder = assetFolder(id)
  await fs.promises.mkdir(folder)
  try {
    for (const { name, bytes } of files) {
      const tmp = path.join(folder, `.${name}.${process.pid}.tmp`)
      await fs.promises.writeFile(tmp, bytes)
      await fs.promises.rename(tmp, path.join(folder, name))
    }
  } catch (err) {
    await removeAssets(id)
    throw err
  }
}

// only folders made by writeAssets (never something else in the volume)
const isAssetsFolder = async (folder) => {
  const files = await fs.promises.readdir(folder)
  return files.every(
    (f) =>
      PHOTO_NAME_REGEX.test(f) ||
      PREVIEW_NAME_REGEX.test(f) ||
      TMP_NAME_REGEX.test(f),
  )
}

// Used by crontab: removes asset folders of links that no longer exist
// (expired by the TTL index or deleted). Returns the number removed.
const cleanShareAssets = async () => {
  const dir = assetsDir()
  let entries
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (err) {
    return 0
  }
  const limit = Date.now() - ASSETS_MIN_AGE_MS
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_REGEX.test(entry.name)) continue
    try {
      const folder = path.join(dir, entry.name)
      const stat = await fs.promises.stat(folder)
      if (stat.mtimeMs < limit && (await isAssetsFolder(folder))) {
        candidates.push(entry.name)
      }
    } catch (err) {
      logger.warn(`Assets cleanup failed for ${entry.name}: ${err.message}`)
    }
  }
  let removed = 0
  for (let i = 0; i < candidates.length; i += 500) {
    const batch = candidates.slice(i, i + 500)
    const existing = await Share.find(
      { _id: { $in: batch } },
      { _id: 1 },
    ).lean()
    const alive = new Set(existing.map((s) => String(s._id)))
    for (const id of batch) {
      if (alive.has(id)) continue
      try {
        await fs.promises.rm(path.join(dir, id), {
          recursive: true,
          force: true,
        })
        removed++
      } catch (err) {
        logger.warn(`Assets cleanup failed for ${id}: ${err.message}`)
      }
    }
  }
  return removed
}

// ---- og.png (social preview image) ----
// The activity capture with the author's avatar and name below, resolved from
// the User at request time. Without a capture, the author alone; without both,
// a generic image. The cache file name includes a version hash of everything
// drawn, so a new avatar, name or capture produces a new image.
const OG_LAYOUT_VERSION = 3
const OG_WIDTH = 1200
const OG_HEIGHT = 630
const OG_MAX_BYTES = 300 * 1024
const OG_GREEN = '#8bc34a'
const OG_GENERIC = path.join(__dirname, '..', 'assets', 'og', 'generic.png')
const OG_MARGIN = 40
const PREVIEW_PADDING = 12
const PREVIEW_RADIUS = 28
const PREVIEW_ROW_GAP = 30
const AVATAR_SIZE = 110
const AVATAR_LARGE_SIZE = 240
const AVATAR_RING = 6
const NAME_FONT_SIZE = 52
const NAME_GAP = 28
// Pango family list: DejaVu Sans (fonts-dejavu-core), fallback to sans
const NAME_FONT_FAMILY = 'DejaVu Sans,sans Bold'
const AVATAR_HOSTS = ['static.arasaac.org']
const AVATAR_HOST_SUFFIXES = ['.googleusercontent.com']
const OG_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const ogCacheDir = () =>
  process.env.SHARES_OG_CACHE_DIR || path.join(os.tmpdir(), 'shares-og')
const ogCachePath = (id, v) => path.join(ogCacheDir(), `${id}-${v}.png`)

// the capture file of a share: { file, name, size, mtimeMs } or null
const previewFile = async (share) => {
  if (!share || !ID_REGEX.test(String(share._id))) return null
  if (!isPreviewName(share.preview)) return null
  const file = path.join(assetFolder(String(share._id)), share.preview)
  try {
    const stat = await fs.promises.stat(file)
    if (!stat.isFile()) return null
    return {
      file,
      name: share.preview,
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
    }
  } catch (err) {
    return null
  }
}

// what is drawn for a share: author (null if no user)
const ogContent = (user) => ({
  avatarUrl: user ? pictureFor(user) : null,
  name: user ? cleanText(user.name, MAX_TITLE) : '',
})

const versionFor = (user, preview) => {
  const { avatarUrl, name } = ogContent(user)
  return crypto
    .createHash('sha1')
    .update(
      JSON.stringify([
        OG_LAYOUT_VERSION,
        avatarUrl,
        name,
        preview ? [preview.name, preview.size, preview.mtimeMs] : null,
      ]),
    )
    .digest('hex')
    .slice(0, 10)
}

// async: the capture file (its size and mtime) is part of the version
const ogVersion = async (share, user) =>
  versionFor(user, await previewFile(share))

const toPng = async (image) => {
  let buffer = await image.png({ compressionLevel: 9 }).toBuffer()
  if (buffer.length > OG_MAX_BYTES) {
    buffer = await sharp(buffer)
      .png({ palette: true, compressionLevel: 9 })
      .toBuffer()
  }
  return buffer
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

const roundedRect = (width, height, radius) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="#ffffff"/></svg>`,
  )

// Generic image: a white rounded box centered on green. No logo, no text.
const buildGenericImage = async () => {
  const width = 720
  const height = 300
  return toPng(
    background().composite([
      {
        input: roundedRect(width, height, 36),
        left: Math.round((OG_WIDTH - width) / 2),
        top: Math.round((OG_HEIGHT - height) / 2),
      },
    ]),
  )
}

const getGenericImage = async () => {
  try {
    return await fs.promises.readFile(OG_GENERIC)
  } catch (err) {
    return buildGenericImage()
  }
}

const download = async (url) => {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 5000,
    maxRedirects: 0,
    maxContentLength: 5 * 1024 * 1024,
  })
  return Buffer.from(res.data)
}

// only https from known hosts (avoid SSRF)
const isSafeAvatarUrl = (value) => {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    if (url.port && url.port !== '443') return false
    const host = url.hostname.toLowerCase()
    return (
      AVATAR_HOSTS.includes(host) ||
      AVATAR_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
    )
  } catch (err) {
    return false
  }
}

// circle of `size` px with a white ring around it
const circleAvatar = async (data, size) => {
  const outer = size + 2 * AVATAR_RING
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
  )
  const ring = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outer}" height="${outer}"><circle cx="${outer / 2}" cy="${outer / 2}" r="${outer / 2}" fill="#ffffff"/></svg>`,
  )
  const round = await sharp(data)
    .resize(size, size, { fit: 'cover' })
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer()
  return sharp(ring)
    .composite([{ input: round, left: AVATAR_RING, top: AVATAR_RING }])
    .png()
    .toBuffer()
}

// returns { buffer, ok }: ok=false after a (possibly transient) failure
const buildAvatar = async (avatarUrl, size) => {
  const url = isSafeAvatarUrl(avatarUrl) ? avatarUrl : DEFAULT_PICTURE
  try {
    return { buffer: await circleAvatar(await download(url), size), ok: true }
  } catch (err) {
    logger.debug(`og.png: could not get avatar ${url}: ${err.message}`)
  }
  if (url !== DEFAULT_PICTURE) {
    try {
      const data = await download(DEFAULT_PICTURE)
      return { buffer: await circleAvatar(data, size), ok: false }
    } catch (err) {
      logger.debug(`og.png: could not get default avatar: ${err.message}`)
    }
  }
  return { buffer: null, ok: false }
}

// sharp text input accepts Pango markup
const escapePango = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const renderText = async (text) => {
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="#ffffff">${escapePango(text)}</span>`,
      font: `${NAME_FONT_FAMILY} ${NAME_FONT_SIZE}`,
      dpi: 72,
      rgba: true,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true })
  return { input: data, width: info.width, height: info.height }
}

// author's name in white, ellipsized to maxWidth. null if it cannot be drawn.
const renderName = async (name, maxWidth) => {
  if (!name) return null
  try {
    const full = await renderText(name)
    if (full.width <= maxWidth) return full
    const chars = Array.from(name)
    let low = 1
    let high = chars.length - 1
    let best = null
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const candidate = await renderText(
        `${chars.slice(0, mid).join('').trim()}…`,
      )
      if (candidate.width <= maxWidth) {
        best = candidate
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return best
  } catch (err) {
    logger.warn(`og.png: could not render the author name: ${err.message}`)
    return null
  }
}

// the capture, flattened on white and at most the og size (null if unreadable)
const loadPreview = async (preview) => {
  try {
    return await sharp(preview.file)
      .flatten({ background: '#ffffff' })
      .resize(OG_WIDTH, OG_HEIGHT, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
  } catch (err) {
    logger.warn(`og.png: could not read ${preview.file}: ${err.message}`)
    return null
  }
}

// the capture scaled to fit (contain) in a white rounded box, centered in the
// area between top and bottom
const previewLayer = async (capture, top, bottom) => {
  const maxWidth = OG_WIDTH - 2 * OG_MARGIN - 2 * PREVIEW_PADDING
  const maxHeight = bottom - top - 2 * PREVIEW_PADDING
  const { data, info } = await sharp(capture)
    .resize(maxWidth, maxHeight, { fit: 'inside' })
    .png()
    .toBuffer({ resolveWithObject: true })
  const rounded = await sharp(data)
    .ensureAlpha()
    .composite([
      {
        input: roundedRect(
          info.width,
          info.height,
          PREVIEW_RADIUS - PREVIEW_PADDING,
        ),
        blend: 'dest-in',
      },
    ])
    .png()
    .toBuffer()
  const width = info.width + 2 * PREVIEW_PADDING
  const height = info.height + 2 * PREVIEW_PADDING
  const box = await sharp(roundedRect(width, height, PREVIEW_RADIUS))
    .composite([
      { input: rounded, left: PREVIEW_PADDING, top: PREVIEW_PADDING },
    ])
    .png()
    .toBuffer()
  return {
    input: box,
    left: Math.round((OG_WIDTH - width) / 2),
    top: Math.round(top + (bottom - top - height) / 2),
  }
}

// avatar large and centered with the name under it
const authorOnlyLayers = (avatar, avatarOuter, nameLayer) => {
  const gap = avatar && nameLayer ? 30 : 0
  const height =
    (avatar ? avatarOuter : 0) + gap + (nameLayer ? nameLayer.height : 0)
  let top = Math.round((OG_HEIGHT - height) / 2)
  const layers = []
  if (avatar) {
    layers.push({
      input: avatar,
      left: Math.round((OG_WIDTH - avatarOuter) / 2),
      top,
    })
    top += avatarOuter + gap
  }
  if (nameLayer) {
    layers.push({
      input: nameLayer.input,
      left: Math.round((OG_WIDTH - nameLayer.width) / 2),
      top,
    })
  }
  return layers
}

// avatar + name row at the bottom: { layers, top } (top of the row, or the
// bottom margin when there is nothing to draw)
const authorRowLayers = (avatar, avatarOuter, nameLayer) => {
  const rowHeight = Math.max(
    avatar ? avatarOuter : 0,
    nameLayer ? nameLayer.height : 0,
  )
  const rowTop = OG_HEIGHT - OG_MARGIN - rowHeight
  const layers = []
  if (rowHeight > 0) {
    const rowWidth =
      (avatar ? avatarOuter : 0) +
      (avatar && nameLayer ? NAME_GAP : 0) +
      (nameLayer ? nameLayer.width : 0)
    let left = Math.round((OG_WIDTH - rowWidth) / 2)
    if (avatar) {
      layers.push({
        input: avatar,
        left,
        top: rowTop + Math.round((rowHeight - avatarOuter) / 2),
      })
      left += avatarOuter + NAME_GAP
    }
    if (nameLayer) {
      layers.push({
        input: nameLayer.input,
        left,
        top: rowTop + Math.round((rowHeight - nameLayer.height) / 2),
      })
    }
  }
  return { layers, top: rowHeight > 0 ? rowTop : null }
}

// returns { buffer, complete }: complete=false if anything could not be got.
// `preview` (from previewFile) is looked up when not given.
const buildShareImage = async (share, user, preview) => {
  const info = preview === undefined ? await previewFile(share) : preview
  const capture = info ? await loadPreview(info) : null
  let complete = !info || !!capture
  const { avatarUrl, name } = ogContent(user)

  if (capture) {
    let row = { layers: [], top: null }
    if (user) {
      const avatarOuter = AVATAR_SIZE + 2 * AVATAR_RING
      const avatar = await buildAvatar(avatarUrl, AVATAR_SIZE)
      if (!avatar.ok) complete = false
      const nameMaxWidth =
        OG_WIDTH - 2 * OG_MARGIN - (avatar.buffer ? avatarOuter + NAME_GAP : 0)
      const nameLayer = await renderName(name, nameMaxWidth)
      row = authorRowLayers(avatar.buffer, avatarOuter, nameLayer)
    }
    const bottom =
      row.top === null ? OG_HEIGHT - OG_MARGIN : row.top - PREVIEW_ROW_GAP
    const layers = [
      await previewLayer(capture, OG_MARGIN, bottom),
      ...row.layers,
    ]
    return { buffer: await toPng(background().composite(layers)), complete }
  }

  if (!user) return { buffer: await getGenericImage(), complete: false }

  const avatarOuter = AVATAR_LARGE_SIZE + 2 * AVATAR_RING
  const avatar = await buildAvatar(avatarUrl, AVATAR_LARGE_SIZE)
  if (!avatar.ok) complete = false
  const nameLayer = await renderName(name, OG_WIDTH - 2 * OG_MARGIN)
  if (!avatar.buffer && !nameLayer) {
    return { buffer: await getGenericImage(), complete: false }
  }
  const layers = authorOnlyLayers(avatar.buffer, avatarOuter, nameLayer)
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
    // does not count visits nor touch lastAccessedAt
    const share = await Share.findById(id, { ownerId: 1, preview: 1 }).lean()
    if (!share) return res.status(404).json({ error: 'Not found' })
    const user = await findUser(share.ownerId)
    const preview = await previewFile(share)
    const file = ogCachePath(id, versionFor(user, preview))

    try {
      return sendPng(res, await fs.promises.readFile(file))
    } catch (err) {
      // not cached yet
    }

    const { buffer, complete } = await buildShareImage(share, user, preview)
    // do not cache incomplete images, so a transient failure can heal later
    if (complete) {
      try {
        await fs.promises.mkdir(ogCacheDir(), { recursive: true })
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
        await fs.promises.writeFile(tmp, buffer)
        await fs.promises.rename(tmp, file)
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

// removes every cached version of a share (and the old `${id}.png` name)
const removeOgCache = async (id) => {
  const dir = ogCacheDir()
  let files
  try {
    files = await fs.promises.readdir(dir)
  } catch (err) {
    return
  }
  const cached = files.filter(
    (f) => f === `${id}.png` || (f.startsWith(`${id}-`) && f.endsWith('.png')),
  )
  for (const file of cached) {
    try {
      await fs.promises.unlink(path.join(dir, file))
    } catch (err) {
      if (err.code !== 'ENOENT')
        logger.warn(`og.png: cache delete failed: ${err.message}`)
    }
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

// ---- endpoints ----

// item shape of /mine and PATCH
const mineItem = (s) => ({
  id: s._id,
  title: s.title,
  description: s.description || '',
  generator: s.generator,
  lang: s.lang,
  createdAt: s.createdAt,
  lastAccessedAt: s.lastAccessedAt,
  visits: s.visits || 0,
  copies: s.copies || 0,
  listed: listedValue(s),
  hidden: !!s.hidden,
  featured: !!s.featured,
  preview: previewUrl(s),
  imagesCount: (s.images || []).length,
})

const LIST_PROJECTION = {
  data: 0,
  reports: 0,
  dismissedReports: 0,
  moderation: 0,
  searchText: 0,
  hash: 0,
}

const create = async (req, res) => {
  logger.debug('EXEC create sharesController')
  const ownerId = req.user.id
  const { data, generator, lang, images, preview } = req.body || {}

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

  let assets
  try {
    assets = await prepareAssets(project, images, preview)
  } catch (err) {
    if (err instanceof AssetError) {
      return res.status(400).json({ error: err.message })
    }
    logger.error(`Error checking share images: ${err.message}`)
    return res.status(500).json({ error: 'Error creating share' })
  }

  const title = cleanTitle(req.body.title)
  // the description is not part of the hash
  const description = cleanDescription(req.body.description)
  const cleanedLang = cleanLang(lang)
  // with the photos' final names: the capture is not part of the hash
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(project) + title + cleanedLang + ownerId)
    .digest('hex')

  const respond = (status, share) => {
    const url = `${FRONT_URL}/${share._id}`
    return res.status(status).json({
      id: share._id,
      url,
      editUrl: `${url}?edit`,
      listed: listedValue(share),
      description: share.description || '',
      preview: previewUrl(share),
    })
  }
  const findExisting = () =>
    Share.findOne(
      { ownerId, hash },
      { _id: 1, listed: 1, description: 1, preview: 1 },
    ).lean()

  const files = [...assets.photos, ...(assets.preview ? [assets.preview] : [])]
  // the stored project points to the files of this link
  const dataFor = (id) => {
    if (!assets.refs.length) return data
    assets.refs.forEach((ref) => {
      ref.src = assetUrl(id, ref.file)
    })
    return encodeProject(project)
  }

  try {
    // an existing share is returned as is (nothing is modified)
    const existing = await findExisting()
    if (existing) return respond(200, existing)

    // createLimiter answers 429 itself and never calls next in that case
    const allowed = await Promise.race([
      checkLimit(req, res),
      new Promise((resolve) => res.once('finish', () => resolve(false))),
    ])
    if (!allowed) return

    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId()
      if (files.length) {
        // the folder of an existing link is never touched
        if (await Share.exists({ _id: id })) continue
        try {
          await writeAssets(id, files)
        } catch (err) {
          if (err && err.code === 'EEXIST') continue
          throw err
        }
      }
      try {
        const share = await Share.create({
          _id: id,
          ownerId,
          hash,
          data: dataFor(id),
          generator,
          lang: cleanedLang,
          title,
          description,
          searchText: buildSearchText(title, description),
          preview: assets.preview ? assets.preview.name : null,
          images: assets.photos.map((photo) => photo.name),
        })
        return respond(201, share)
      } catch (err) {
        if (files.length) await removeAssets(id)
        if (err && err.code === 11000) {
          // duplicate: same content created concurrently, or id collision
          const same = await findExisting()
          if (same) return respond(200, same)
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
    const shares = await Share.find({ ownerId: req.user.id }, LIST_PROJECTION)
      .sort({ createdAt: -1 })
      .lean()
    return res.status(200).json(shares.map(mineItem))
  } catch (error) {
    logger.error(`Error listing shares: ${error.message}`)
    return res.status(500).json({ error: 'Error listing shares' })
  }
}

// owner: listed, description. admin: also hidden, on any share
const update = async (req, res) => {
  const { id } = req.params
  if (!ID_REGEX.test(id)) return res.status(404).json({ error: 'Not found' })
  const { listed, description, hidden, dismissReports, featured } =
    req.body || {}
  if (
    (listed !== undefined && typeof listed !== 'boolean') ||
    (description !== undefined && typeof description !== 'string') ||
    (hidden !== undefined && typeof hidden !== 'boolean') ||
    (dismissReports !== undefined && typeof dismissReports !== 'boolean') ||
    (featured !== undefined && typeof featured !== 'boolean')
  ) {
    return res.status(400).json({ error: 'Invalid fields' })
  }
  try {
    const share = await Share.findById(id, {
      ownerId: 1,
      title: 1,
      listed: 1,
      description: 1,
      searchText: 1,
      hidden: 1,
      featured: 1,
      reports: 1,
    }).lean()
    if (!share) return res.status(404).json({ error: 'Not found' })
    const isAdmin = req.user.role === 'admin'
    const isOwner = share.ownerId === req.user.id
    const adminOnly =
      hidden !== undefined ||
      dismissReports !== undefined ||
      featured !== undefined
    if ((!isOwner && !isAdmin) || (adminOnly && !isAdmin)) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const $set = {}
    if (listed !== undefined) {
      $set.listed = listed
      if (listed && share.listed !== true) $set.listedAt = new Date()
    }
    if (description !== undefined) {
      $set.description = cleanDescription(description)
      $set.searchText = buildSearchText(share.title, $set.description)
    } else if (listed === true && !share.searchText) {
      // Links created before the search existed have no searchText yet
      $set.searchText = buildSearchText(share.title, share.description || '')
    }
    if (featured !== undefined) {
      $set.featured = featured
      // featuredAt/featuredBy keep the first time it was featured; unfeaturing
      // keeps them as history
      if (featured && share.featured !== true) {
        $set.featuredAt = new Date()
        $set.featuredBy = String(req.user.id)
      }
      logger.info(
        `Share ${id} ${featured ? 'featured' : 'unfeatured'} by admin ${req.user.id}`,
      )
    }
    const update = {}
    if (hidden !== undefined || dismissReports === true) {
      const restoring = hidden === false && share.hidden === true
      let action = 'dismissed'
      if (hidden === true) action = 'hidden'
      else if (restoring) action = 'restored'
      if (hidden !== undefined) $set.hidden = hidden
      // Reviewed reports move to the history, so they do not hide it again
      if (restoring || dismissReports === true) {
        const pending = share.reports || []
        $set.reports = []
        if (pending.length)
          update.$push = { dismissedReports: { $each: pending } }
      }
      $set.moderation = { action, by: String(req.user.id), at: new Date() }
      logger.info(`Share ${id} ${action} by admin ${req.user.id}`)
    }
    if (Object.keys($set).length) update.$set = $set

    const updated = Object.keys(update).length
      ? await Share.findOneAndUpdate({ _id: id }, update, {
          new: true,
          projection: LIST_PROJECTION,
        }).lean()
      : await Share.findById(id, LIST_PROJECTION).lean()
    if (!updated) return res.status(404).json({ error: 'Not found' })
    return res.status(200).json(mineItem(updated))
  } catch (error) {
    logger.error(`Error updating share: ${error.message}`)
    return res.status(500).json({ error: 'Error updating share' })
  }
}

const parsePositiveInt = (value, fallback) => {
  if (value === undefined || value === '') return fallback
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) return NaN
  return Number(value)
}

const isGiven = (value) => value !== undefined && value !== ''

// true: only featured, false: no filter, null: invalid
const parseFeatured = (value) => {
  if (value === undefined || value === '' || value === '0' || value === 'false')
    return false
  if (value === '1' || value === 'true') return true
  return null
}

const search = async (req, res) => {
  const query = req.query || {}
  const { generator, author } = query
  if (query.q !== undefined && typeof query.q !== 'string') {
    return res.status(400).json({ error: 'Invalid q' })
  }
  const q = (query.q || '').trim().slice(0, MAX_QUERY)
  if (isGiven(generator) && !GENERATORS.includes(generator)) {
    return res.status(400).json({ error: 'Invalid generator' })
  }
  if (
    isGiven(author) &&
    (typeof author !== 'string' || !USER_ID_REGEX.test(author))
  ) {
    return res.status(400).json({ error: 'Invalid author' })
  }
  const sort = isGiven(query.sort) ? query.sort : 'relevance'
  if (!SORTS.includes(sort)) {
    return res.status(400).json({ error: 'Invalid sort' })
  }
  const featuredOnly = parseFeatured(query.featured)
  if (featuredOnly === null) {
    return res.status(400).json({ error: 'Invalid featured' })
  }
  const page = parsePositiveInt(query.page, 1)
  if (!Number.isInteger(page) || page < 1) {
    return res.status(400).json({ error: 'Invalid page' })
  }
  const limit = parsePositiveInt(query.limit, DEFAULT_SEARCH_LIMIT)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    return res.status(400).json({ error: 'Invalid limit' })
  }

  const filter = { listed: true, hidden: { $ne: true } }
  if (isGiven(generator)) filter.generator = generator
  if (isGiven(author)) filter.ownerId = author
  if (featuredOnly) filter.featured = true
  const tokens = tokenize(normalizeText(q))
  if (tokens.length) {
    filter.$and = tokens.map((token) => ({
      searchText: { $regex: prefixPattern(token) },
    }))
  }

  try {
    // featured first, so they are never cut by the candidates limit
    const candidates = await Share.find(filter, LIST_PROJECTION)
      .sort({ featured: -1, createdAt: -1 })
      .limit(MAX_SEARCH_CANDIDATES)
      .lean()
    const ranked = rankShares(candidates, { q, sort, now: Date.now() })
    const pageItems = ranked.slice((page - 1) * limit, page * limit)
    const users = await findUsers([
      ...pageItems.map((s) => s.ownerId),
      ...(isGiven(author) ? [author] : []),
    ])
    res.set('Cache-Control', 'public, max-age=60')
    return res.status(200).json({
      total: ranked.length,
      page,
      limit,
      items: pageItems.map((s) => ({
        id: s._id,
        title: s.title,
        description: s.description || '',
        generator: s.generator,
        lang: s.lang,
        createdAt: s.createdAt,
        visits: s.visits || 0,
        copies: s.copies || 0,
        featured: !!s.featured,
        author: authorFor(s.ownerId, users.get(String(s.ownerId))),
        preview: previewUrl(s),
      })),
      author:
        isGiven(author) && users.has(author)
          ? authorFor(author, users.get(author))
          : null,
    })
  } catch (error) {
    logger.error(`Error searching shares: ${error.message}`)
    return res.status(500).json({ error: 'Error searching shares' })
  }
}

// someone saved a copy of the link in their activities
const copy = async (req, res) => {
  const { id } = req.params
  if (!ID_REGEX.test(id)) return res.status(404).json({ error: 'Not found' })
  try {
    const share = await Share.findById(id, { ownerId: 1, hidden: 1 }).lean()
    if (!share) return res.status(404).json({ error: 'Not found' })
    if (isBlocked(req.user, share)) {
      return res.status(410).json({ error: 'Hidden' })
    }
    // the author saving their own link does not count
    if (share.ownerId !== req.user.id) {
      await Share.updateOne({ _id: id }, { $inc: { copies: 1 } })
    }
    return res.status(204).end()
  } catch (error) {
    logger.error(`Error counting share copy: ${error.message}`)
    return res.status(500).json({ error: 'Error counting copy' })
  }
}

// ---- Mattermost notices for moderators ----

const adminUrl = () =>
  (process.env.ARASAAC_ADMIN_URL || 'https://admin.arasaac.org').replace(
    /\/+$/,
    '',
  )

// user text in a notice: no @channel/@user mentions
const noticeText = (value) => String(value || '').replace(/@/g, '@​')

const noticeLinks = (id) =>
  `${FRONT_URL}/${id}?edit · Revisar: ${adminUrl()}/shared-activities`

const reasonLine = (report) =>
  `> ${noticeText(report.reason) || '(sin motivo)'}`

const buildReportNotice = (share, user, { hiddenNow, reason }) => {
  const title = noticeText(share.title) || 'Sin título'
  const name = noticeText(user && user.name) || 'autor desconocido'
  const reports = share.reports || []
  if (hiddenNow) {
    return (
      `⛔ Actividad ocultada automáticamente tras ${reports.length} denuncias: **${title}** de ${name}\n` +
      `${reports.map(reasonLine).join('\n')}\n${noticeLinks(share._id)}`
    )
  }
  return (
    `🚩 Nueva denuncia en ARActivities: **${title}** de ${name}\n` +
    `${reasonLine({ reason })}\n${noticeLinks(share._id)}`
  )
}

// pending notices, so tests can wait for them (flushNotices)
const pendingNotices = new Set()

const notifyReport = (share, options) => {
  const promise = (async () => {
    const user = await findUser(share.ownerId)
    await postToMattermost(buildReportNotice(share, user, options))
  })()
    .catch((err) => {
      logger.warn(`Could not notify the report of ${share._id}: ${err.message}`)
    })
    .finally(() => pendingNotices.delete(promise))
  pendingNotices.add(promise)
  return promise
}

const flushNotices = () => Promise.all([...pendingNotices])

const report = async (req, res) => {
  const { id } = req.params
  if (!ID_REGEX.test(id)) return res.status(404).json({ error: 'Not found' })
  const userId = String(req.user.id)
  const reason = cleanText((req.body || {}).reason, MAX_REASON)
  try {
    // atomic: a user can report a share only once
    const updated = await Share.findOneAndUpdate(
      { _id: id, 'reports.userId': { $ne: userId } },
      { $push: { reports: { userId, reason, at: new Date() } } },
      {
        new: true,
        projection: { reports: 1, hidden: 1, title: 1, ownerId: 1 },
      },
    ).lean()
    if (!updated) {
      const exists = await Share.exists({ _id: id })
      if (!exists) return res.status(404).json({ error: 'Not found' })
      return res.status(204).end()
    }
    const threshold =
      Number(process.env.SHARES_REPORT_HIDE_THRESHOLD) ||
      DEFAULT_REPORT_HIDE_THRESHOLD
    const count = (updated.reports || []).length
    let hiddenNow = false
    if (count >= threshold && !updated.hidden) {
      const result = await Share.updateOne(
        { _id: id, hidden: { $ne: true } },
        { $set: { hidden: true } },
      )
      if (result.nModified || result.modifiedCount) {
        hiddenNow = true
        logger.warn(`Share ${id} hidden after ${count} reports`)
      }
    }
    // fire and forget: the notice never delays nor breaks the response
    if (hiddenNow || (count === 1 && !updated.hidden)) {
      notifyReport(updated, { hiddenNow, reason })
    }
    return res.status(204).end()
  } catch (error) {
    logger.error(`Error reporting share: ${error.message}`)
    return res.status(500).json({ error: 'Error reporting share' })
  }
}

const GET_PROJECTION = {
  data: 1,
  generator: 1,
  lang: 1,
  title: 1,
  description: 1,
  listed: 1,
  hidden: 1,
  featured: 1,
  createdAt: 1,
  ownerId: 1,
  preview: 1,
  images: 1,
}

const get = async (req, res) => {
  const { id } = req.params
  if (!ID_REGEX.test(id)) return res.status(404).json({ error: 'Not found' })
  const visit = (filter) =>
    Share.findOneAndUpdate(
      filter,
      { $inc: { visits: 1 }, $set: { lastAccessedAt: new Date() } },
      { new: true, projection: GET_PROJECTION },
    ).lean()
  try {
    // hidden shares are not counted here: they need the owner or an admin
    let share = await visit({ _id: id, hidden: { $ne: true } })
    if (!share) {
      const hidden = await Share.findById(id, { ownerId: 1, hidden: 1 }).lean()
      if (!hidden) return res.status(404).json({ error: 'Not found' })
      if (isBlocked(req.user, hidden)) {
        return res.status(410).json({ error: 'Hidden' })
      }
      share = await visit({ _id: id })
      if (!share) return res.status(404).json({ error: 'Not found' })
    }
    const { data, generator, lang, title, createdAt, ownerId } = share
    const user = await findUser(ownerId)
    return res.status(200).json({
      data,
      generator,
      lang,
      title,
      description: share.description || '',
      listed: listedValue(share),
      hidden: !!share.hidden,
      featured: !!share.featured,
      createdAt,
      author: authorFor(ownerId, user),
      preview: previewUrl(share),
      images: imageUrls(share),
    })
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
    const isAdmin = req.user.role === 'admin'
    if (share.ownerId !== req.user.id && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    await Share.deleteOne({ _id: id })
    await removeOgCache(id)
    await removeAssets(id)
    if (share.ownerId !== req.user.id) {
      logger.info(`Share ${id} deleted by admin ${req.user.id}`)
    }
    return res.status(204).end()
  } catch (error) {
    logger.error(`Error deleting share: ${error.message}`)
    return res.status(500).json({ error: 'Error deleting share' })
  }
}

const DEFAULT_DESCRIPTION =
  'Actividad creada con ARActivities, de ARASAAC. Ábrela para verla y usarla.'

const page = async (req, res) => {
  const { id } = req.params
  res.set('Content-Type', 'text/html; charset=utf-8')
  try {
    const share = ID_REGEX.test(id)
      ? await Share.findById(id, {
          title: 1,
          description: 1,
          ownerId: 1,
          hidden: 1,
          preview: 1,
        }).lean()
      : null
    if (!share) {
      return res
        .status(404)
        .send(
          '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>No encontrado</title></head><body><p>Esta actividad no existe o ha caducado.</p></body></html>',
        )
    }
    // nothing of the activity while it is under review
    if (share.hidden === true) {
      return res
        .status(410)
        .send(
          '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>ARActivities</title></head><body><p>Esta actividad se ha retirado mientras se revisa.</p></body></html>',
        )
    }
    const user = await findUser(share.ownerId)
    const name = user ? cleanText(user.name, MAX_TITLE) : ''
    const url = `${FRONT_URL}/${id}`
    const ogTitle = `${share.title || 'Actividad'} · ARActivities`
    const baseDescription = share.description || DEFAULT_DESCRIPTION
    const description = name ? `${name} · ${baseDescription}` : baseDescription
    // the version changes with the avatar or name, so crawlers fetch it again
    const image = `${API_URL}/${id}/og.png?v=${await ogVersion(share, user)}`
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

// ---- administration ----

const ADMIN_STATUSES = [
  'all',
  'reported',
  'hidden',
  'listed',
  'unlisted',
  'featured',
]
const ADMIN_SORTS = ['recent', 'reports', 'visits', 'copies']
const ADMIN_MAX_LIMIT = 100
const ADMIN_DEFAULT_LIMIT = 25
const ADMIN_USER_FIELDS = {
  name: 1,
  email: 1,
  pictureProvider: 1,
  'google.picture': 1,
}

const statusFilter = (status) => {
  switch (status) {
    case 'reported':
      return { 'reports.0': { $exists: true } }
    case 'hidden':
      return { hidden: true }
    case 'listed':
      return { listed: true, hidden: { $ne: true } }
    case 'unlisted':
      return { listed: { $ne: true } }
    case 'featured':
      return { featured: true }
    default:
      return {}
  }
}

// Text: words in title/description, a link id, or an author's name or email
const adminTextFilter = async (q) => {
  const text = q.trim()
  if (!text) return {}
  const or = []
  if (ID_REGEX.test(text)) or.push({ _id: text })
  const tokens = tokenize(normalizeText(text))
  if (tokens.length) {
    or.push({
      $and: tokens.map((token) => ({
        searchText: { $regex: prefixPattern(token) },
      })),
    })
    or.push({ title: { $regex: escapeRegex(text), $options: 'i' } })
  }
  const users = await User.find(
    {
      $or: [
        { email: { $regex: `^${escapeRegex(text)}`, $options: 'i' } },
        { name: { $regex: escapeRegex(text), $options: 'i' } },
      ],
    },
    { _id: 1 },
  )
    .limit(200)
    .lean()
  if (users.length)
    or.push({ ownerId: { $in: users.map((u) => String(u._id)) } })
  return or.length ? { $or: or } : { _id: null }
}

const adminSort = (sort) => {
  switch (sort) {
    case 'reports':
      return { reportsCount: -1, createdAt: -1 }
    case 'visits':
      return { visits: -1, createdAt: -1 }
    case 'copies':
      return { copies: -1, createdAt: -1 }
    default:
      return { createdAt: -1 }
  }
}

const adminPerson = (id, user) => ({
  id: String(id),
  name: (user && user.name) || '',
  email: (user && user.email) || '',
  picture: pictureFor(user),
})

const adminReport = (report, users) => ({
  reason: report.reason || '',
  at: report.at,
  user: adminPerson(report.userId, users.get(String(report.userId))),
})

// GET /shares/admin (admins): every link, with reports and moderation
const adminList = async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' })
  }
  const query = req.query || {}
  const status = isGiven(query.status) ? query.status : 'all'
  const sort = isGiven(query.sort) ? query.sort : 'recent'
  const page = parsePositiveInt(query.page, 1)
  const limit = parsePositiveInt(query.limit, ADMIN_DEFAULT_LIMIT)
  if (
    !ADMIN_STATUSES.includes(status) ||
    !ADMIN_SORTS.includes(sort) ||
    (query.q !== undefined && typeof query.q !== 'string') ||
    (isGiven(query.generator) && !GENERATORS.includes(query.generator)) ||
    (isGiven(query.author) && !USER_ID_REGEX.test(query.author)) ||
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > ADMIN_MAX_LIMIT
  ) {
    return res.status(400).json({ error: 'Invalid parameters' })
  }
  try {
    const base = {}
    if (isGiven(query.generator)) base.generator = query.generator
    if (isGiven(query.author)) base.ownerId = query.author
    const text = await adminTextFilter((query.q || '').slice(0, 100))
    const match = { $and: [base, text, statusFilter(status)] }

    const [result] = await Share.aggregate([
      { $match: match },
      { $project: { data: 0, hash: 0, searchText: 0 } },
      {
        $addFields: { reportsCount: { $size: { $ifNull: ['$reports', []] } } },
      },
      { $sort: adminSort(sort) },
      {
        $facet: {
          items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
          total: [{ $count: 'n' }],
        },
      },
    ])
    const shares = (result && result.items) || []
    const total = (result && result.total[0] && result.total[0].n) || 0

    // tab counters, with the same text/type/author filters
    const [all, reported, hidden, listed, featured] = await Promise.all(
      ['all', 'reported', 'hidden', 'listed', 'featured'].map((s) =>
        Share.countDocuments({ $and: [base, text, statusFilter(s)] }),
      ),
    )

    const userIds = []
    shares.forEach((s) => {
      userIds.push(s.ownerId)
      ;(s.reports || []).forEach((r) => userIds.push(r.userId))
      if (s.moderation && s.moderation.by) userIds.push(s.moderation.by)
    })
    const valid = [...new Set(userIds.map(String))].filter((id) =>
      USER_ID_REGEX.test(id),
    )
    const users = new Map(
      (valid.length
        ? await User.find({ _id: { $in: valid } }, ADMIN_USER_FIELDS).lean()
        : []
      ).map((u) => [String(u._id), u]),
    )

    return res.status(200).json({
      total,
      page,
      limit,
      counts: { all, reported, hidden, listed, featured },
      items: shares.map((s) => ({
        ...mineItem(s),
        featuredAt: s.featuredAt || null,
        url: `${FRONT_URL}/${s._id}`,
        image: `${API_URL}/${s._id}/og.png`,
        images: imageUrls(s),
        author: adminPerson(s.ownerId, users.get(String(s.ownerId))),
        reportsCount: s.reportsCount || 0,
        reports: (s.reports || []).map((r) => adminReport(r, users)),
        dismissedReportsCount: (s.dismissedReports || []).length,
        moderation:
          s.moderation && s.moderation.action
            ? {
                action: s.moderation.action,
                at: s.moderation.at,
                by: adminPerson(
                  s.moderation.by,
                  users.get(String(s.moderation.by)),
                ),
              }
            : null,
      })),
    })
  } catch (error) {
    logger.error(`Error listing shares for admin: ${error.message}`)
    return res.status(500).json({ error: 'Error listing shares' })
  }
}

module.exports = {
  adminList,
  create,
  mine,
  update,
  search,
  copy,
  report,
  flushNotices,
  get,
  remove,
  page,
  ogImage,
  ogVersion,
  cleanOgCache,
  cleanShareAssets,
  buildGenericImage,
  buildShareImage,
  isSafeAvatarUrl,
  escapeHtml,
  GENERATORS,
}
