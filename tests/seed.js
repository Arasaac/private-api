const mongoose = require('mongoose')
const fs = require('fs')
const path = require('path')

async function seedDatabase() {
  const fixturesDir = path.resolve(__dirname, 'fixtures')

  // 1. Seed pictos_es
  const esFile = path.join(fixturesDir, 'pictos_es.json')
  if (fs.existsSync(esFile)) {
    const raw = JSON.parse(fs.readFileSync(esFile, 'utf8'))
    const docs = raw.map((item) => ({
      ...item,
      created: item.created ? new Date(item.created) : new Date(),
      lastUpdated: item.lastUpdated ? new Date(item.lastUpdated) : new Date(),
    }))
    const col = mongoose.connection.collection('pictos_es')
    await col.deleteMany({})
    if (docs.length > 0) {
      await col.insertMany(docs)
    }
    await col.createIndex(
      { 'keywords.keyword': 'text', tags: 'text' },
      {
        weights: { 'keywords.keyword': 10, tags: 1 },
        default_language: 'none',
        language_override: 'language',
      },
    )
  }

  // 2. Seed pictos_en
  const enFile = path.join(fixturesDir, 'pictos_en.json')
  if (fs.existsSync(enFile)) {
    const raw = JSON.parse(fs.readFileSync(enFile, 'utf8'))
    const docs = raw.map((item) => ({
      ...item,
      created: item.created ? new Date(item.created) : new Date(),
      lastUpdated: item.lastUpdated ? new Date(item.lastUpdated) : new Date(),
    }))
    const col = mongoose.connection.collection('pictos_en')
    await col.deleteMany({})
    if (docs.length > 0) {
      await col.insertMany(docs)
    }
    await col.createIndex(
      { 'keywords.keyword': 'text', tags: 'text' },
      {
        weights: { 'keywords.keyword': 10, tags: 1 },
        default_language: 'none',
        language_override: 'language',
      },
    )
  }

  // 3. Seed materials
  const matFile = path.join(fixturesDir, 'materials.json')
  if (fs.existsSync(matFile)) {
    const raw = JSON.parse(fs.readFileSync(matFile, 'utf8'))
    const docs = raw.map((item) => ({
      ...item,
      _id:
        item._id && mongoose.isValidObjectId(item._id)
          ? new mongoose.Types.ObjectId(item._id)
          : item._id,
      created: item.created ? new Date(item.created) : new Date(),
      lastUpdated: item.lastUpdated ? new Date(item.lastUpdated) : new Date(),
      translations: (item.translations || []).map((t) => ({
        ...t,
        created: t.created ? new Date(t.created) : new Date(),
        lastUpdated: t.lastUpdated ? new Date(t.lastUpdated) : new Date(),
        authors: (t.authors || []).map((a) => ({
          ...a,
          author:
            a.author && mongoose.isValidObjectId(a.author)
              ? new mongoose.Types.ObjectId(a.author)
              : a.author,
        })),
      })),
      authors: (item.authors || []).map((a) => ({
        ...a,
        author:
          a.author && mongoose.isValidObjectId(a.author)
            ? new mongoose.Types.ObjectId(a.author)
            : a.author,
      })),
    }))
    const col = mongoose.connection.collection('materials')
    await col.deleteMany({})
    if (docs.length > 0) {
      await col.insertMany(docs)
    }
    await col.createIndex(
      { 'translations.title': 'text', 'translations.desc': 'text' },
      {
        weights: { 'translations.desc': 1, 'translations.title': 30 },
        default_language: 'spanish',
        language_override: 'language',
      },
    )
  }

  // 4. Seed categories
  const catFile = path.join(fixturesDir, 'categories.json')
  if (fs.existsSync(catFile)) {
    const raw = JSON.parse(fs.readFileSync(catFile, 'utf8'))
    const docs = raw.map((item) => {
      const rawId = item._id && item._id.$oid ? item._id.$oid : item._id
      const rawDate =
        item.lastUpdated && item.lastUpdated.$date
          ? item.lastUpdated.$date
          : item.lastUpdated
      return {
        ...item,
        _id:
          rawId && mongoose.isValidObjectId(rawId)
            ? new mongoose.Types.ObjectId(rawId)
            : undefined,
        lastUpdated: rawDate ? new Date(rawDate) : new Date(),
      }
    })
    const col = mongoose.connection.collection('categories')
    await col.deleteMany({})
    if (docs.length > 0) {
      await col.insertMany(docs)
    }
    await col.createIndex({ locale: 1 }, { unique: true })
  }

  // 5. Seed synsets
  const synFile = path.join(fixturesDir, 'synsets.json')
  if (fs.existsSync(synFile)) {
    const raw = JSON.parse(fs.readFileSync(synFile, 'utf8'))
    const col = mongoose.connection.collection('synsets')
    await col.deleteMany({})
    if (raw.length > 0) {
      await col.insertMany(raw)
    }
  }

  // 6. Seed keywords
  const kwFile = path.join(fixturesDir, 'keywords.json')
  if (fs.existsSync(kwFile)) {
    const raw = JSON.parse(fs.readFileSync(kwFile, 'utf8'))
    const docs = raw.map((item) => ({
      ...item,
      _id:
        item._id && mongoose.isValidObjectId(item._id)
          ? new mongoose.Types.ObjectId(item._id)
          : item._id,
    }))
    const col = mongoose.connection.collection('keywords')
    await col.deleteMany({})
    if (docs.length > 0) {
      await col.insertMany(docs)
    }
  }

  // 7. Seed users
  const userFile = path.join(fixturesDir, 'users.json')
  if (fs.existsSync(userFile)) {
    const raw = JSON.parse(fs.readFileSync(userFile, 'utf8'))
    const docs = raw.map((item) => ({
      ...item,
      _id:
        item._id && mongoose.isValidObjectId(item._id)
          ? new mongoose.Types.ObjectId(item._id)
          : item._id,
    }))
    const col = mongoose.connection.collection('users')
    await col.deleteMany({})
    if (docs.length > 0) {
      await col.insertMany(docs)
    }
  }

  // 8. Seed worldlocations
  const worldFile = path.join(fixturesDir, 'world.json')
  if (fs.existsSync(worldFile)) {
    const raw = JSON.parse(fs.readFileSync(worldFile, 'utf8'))
    const docs = raw.map((item) => ({
      ...item,
      created: item.created ? new Date(item.created) : new Date(),
      lastUpdated: item.lastUpdated ? new Date(item.lastUpdated) : new Date(),
    }))
    const col = mongoose.connection.collection('worldlocations')
    await col.deleteMany({})
    if (docs.length > 0) {
      await col.insertMany(docs)
    }
    await col.createIndex({ id: 1 }, { unique: true })
    await col.createIndex({ location: '2dsphere' })
  }
}

async function clearDatabase() {
  const collections = [
    'pictos_es',
    'pictos_en',
    'materials',
    'categories',
    'synsets',
    'keywords',
    'users',
    'worldlocations',
  ]
  for (const name of collections) {
    try {
      await mongoose.connection.collection(name).deleteMany({})
    } catch (_) {}
  }
}

module.exports = {
  seedDatabase,
  clearDatabase,
}
