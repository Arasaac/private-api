/*
 * Script to import World Locations from Google Spreadsheet CSV into MongoDB.
 *
 * Usage:
 *   node management/importWorldLocations.js [optional_csv_path_or_url]
 *
 * Defaults to the Google Spreadsheet export URL if no argument is provided.
 */

const fs = require('fs')
const https = require('https')
const http = require('http')

// Prevent auto-connection on require
const savedNodeEnv = process.env.NODE_ENV
process.env.NODE_ENV = 'test'
const db = require('../db')
if (savedNodeEnv) {
  process.env.NODE_ENV = savedNodeEnv
} else {
  delete process.env.NODE_ENV
}

const WorldLocation = require('../models/WorldLocation')
const logger = require('../utils/logger')

const DEFAULT_URL =
  'https://docs.google.com/spreadsheets/d/1iI25agwGgC3HV7sXsU7zj6llIqJ7-BDbMBj2Jed83Mk/export?format=csv'

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    client
      .get(url, (res) => {
        // Handle HTTP redirects (e.g. 301, 302, 307)
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          return resolve(fetchUrl(res.headers.location))
        }

        if (res.statusCode !== 200) {
          return reject(
            new Error(`Failed to fetch URL. Status code: ${res.statusCode}`),
          )
        }

        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => resolve(data))
      })
      .on('error', reject)
  })
}

function parseCSV(text) {
  const rows = []
  let currentRow = []
  let currentCell = ''
  let insideQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const nextChar = text[i + 1]

    if (insideQuotes) {
      if (char === '"' && nextChar === '"') {
        currentCell += '"'
        i++
      } else if (char === '"') {
        insideQuotes = false
      } else {
        currentCell += char
      }
    } else {
      if (char === '"') {
        insideQuotes = true
      } else if (char === ',') {
        currentRow.push(currentCell.trim())
        currentCell = ''
      } else if (char === '\r') {
        // Ignore carriage return
      } else if (char === '\n') {
        currentRow.push(currentCell.trim())
        if (currentRow.length > 1 || currentRow[0] !== '') {
          rows.push(currentRow)
        }
        currentRow = []
        currentCell = ''
      } else {
        currentCell += char
      }
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim())
    rows.push(currentRow)
  }

  return rows
}

const TIPO_MAP = {
  ayutamiento: 'Ayuntamiento',
  ayntamiento: 'Ayuntamiento',
  ayujntamiento: 'Ayuntamiento',
  ayuntamienrto: 'Ayuntamiento',
  asociacion: 'Asociación',
  bibliotreca: 'Biblioteca',
  policia: 'Policía',
  'centro de salud': 'Centro de salud',
  'servicio salud': 'Centro de salud',
  salud: 'Centro de salud',
  'edficio administrativo': 'Edificio Administrativo',
}

function normalizeTipo(rawTipo) {
  if (!rawTipo) return 'Otro'
  const key = rawTipo.trim().toLowerCase()
  return TIPO_MAP[key] || rawTipo.trim()
}

function normalizeImageUrl(url) {
  if (!url) return ''
  return url.replace('static.arasaac.org//map', 'static.arasaac.org/map').trim()
}

async function run() {
  const target = process.argv[2] || DEFAULT_URL
  console.log(`Loading CSV data from: ${target}`)

  let csvContent = ''
  if (target.startsWith('http://') || target.startsWith('https://')) {
    csvContent = await fetchUrl(target)
  } else {
    csvContent = fs.readFileSync(target, 'utf8')
  }

  const rows = parseCSV(csvContent)
  console.log(`Parsed ${rows.length} total rows from CSV.`)

  if (rows.length < 3) {
    console.error('CSV does not contain sufficient data rows.')
    process.exit(1)
  }

  // Connect to DB
  await db.open()
  console.log('Connected to MongoDB.')

  let importedCount = 0
  let skippedCount = 0

  // Row 0 is header, Row 1 is metadata, data starts at Row 2
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i]
    const id = parseInt(r[0], 10)
    if (isNaN(id)) {
      skippedCount++
      continue
    }

    const rawCoords = r[1] || ''
    let lat = parseFloat(r[2])
    let lng = parseFloat(r[3])

    // Fix coordinate errors (e.g. lat === lng) using raw coordinate string
    if (lat === lng || isNaN(lat) || isNaN(lng)) {
      if (rawCoords && rawCoords.includes(',')) {
        const parts = rawCoords.split(',')
        lat = parseFloat(parts[0])
        lng = parseFloat(parts[1])
      }
    }

    if (isNaN(lat) || isNaN(lng)) {
      console.warn(
        `Row with id ${id} has invalid coordinates (${lat}, ${lng}), skipping.`,
      )
      skippedCount++
      continue
    }

    const tipo = normalizeTipo(r[4])
    const name = r[5] ? r[5].trim() : ''
    const address = r[6] ? r[6].trim() : ''
    const postalCode = r[7] ? r[7].trim() : ''
    const city = r[8] ? r[8].trim() : ''
    const province = r[9] ? r[9].trim() : ''
    const country = r[10] ? r[10].trim() : ''

    const mainWeb = r[11] ? r[11].trim() : ''
    const proyectWeb = r[12] ? r[12].trim() : ''
    const urlNews = r[13] ? r[13].trim() : ''

    const description = r[14] ? r[14].trim() : ''
    const awards = r[15] ? r[15].trim() : ''
    const urlAward = r[16] ? r[16].trim() : ''

    const picture = normalizeImageUrl(r[17])
    const rawPictures = r[18] || ''
    const pictures = rawPictures
      .split(';')
      .map((p) => normalizeImageUrl(p))
      .filter((p) => p.length > 0)

    const video = r[19] ? r[19].trim() : ''
    const email = r[20] ? r[20].trim() : ''

    const locationDoc = {
      id,
      name,
      tipo,
      description,
      latitude: lat,
      longitude: lng,
      location: {
        type: 'Point',
        coordinates: [lng, lat],
      },
      address: {
        address,
        postalCode,
        city,
        province,
        country,
      },
      links: {
        mainWeb,
        proyectWeb,
        urlNews,
      },
      awards,
      urlAward,
      picture,
      pictures,
      video,
      email,
      status: 1, // Published
      lastUpdated: new Date(),
    }

    await WorldLocation.findOneAndUpdate({ id }, locationDoc, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    })

    importedCount++
  }

  console.log(`\nImport completed successfully!`)
  console.log(`Total locations imported/updated: ${importedCount}`)
  console.log(`Skipped rows: ${skippedCount}`)

  await db.close()
  process.exit(0)
}

run().catch((err) => {
  console.error('Import error:', err)
  process.exit(1)
})
