const path = require('path')
const fs = require('fs-extra')
const formidable = require('formidable')
const WorldLocation = require('../models/WorldLocation')
const User = require('../models/User')
const logger = require('../utils/logger')
const CustomError = require('../utils/CustomError')
const { MAP_DIR } = require('../utils/constants')
const { saveFiles } = require('./utils')
const {
  sendNewWorldLocationEmail,
  sendReceivedWorldLocationEmail,
  sendApprovedWorldLocationEmail,
} = require('../emails')

const PUBLISHED = 1
const PENDING = 2

const parseRequestBody = (req) =>
  new Promise((resolve, reject) => {
    if (req.is('multipart/form-data')) {
      const form = formidable({
        encoding: 'utf-8',
        keepExtensions: true,
        multiples: true,
        maxFileSize: 100 * 1024 * 1024,
      })
      form.parse(req, (err, fields, files) => {
        if (err) return reject(err)
        return resolve({ fields, files })
      })
    } else {
      resolve({ fields: req.body || {}, files: {} })
    }
  })

const getAll = async (req, res) => {
  try {
    const { tipo, country, search, status } = req.query
    const isAdmin = req.user && req.user.role === 'admin'

    const query = {}

    // Status filter: only admins can see unpublished / pending
    if (isAdmin && status !== undefined) {
      query.status = parseInt(status, 10)
    } else {
      query.status = PUBLISHED
    }

    if (tipo) {
      query.tipo = tipo
    }

    if (country) {
      query['address.country'] = new RegExp('^' + country + '$', 'i')
    }

    if (search) {
      query.$or = [
        { name: new RegExp(search, 'i') },
        { description: new RegExp(search, 'i') },
        { 'address.city': new RegExp(search, 'i') },
        { 'address.country': new RegExp(search, 'i') },
      ]
    }

    const locations = await WorldLocation.find(query, { __v: 0 })
      .sort({ id: 1 })
      .lean()

    return res.status(200).json(locations)
  } catch (err) {
    logger.error('Error fetching world locations: ' + err.message)
    return res.status(500).json({
      message: 'Error fetching world locations',
      error: err.message,
    })
  }
}

const getById = async (req, res) => {
  try {
    const { id } = req.params
    const isAdmin = req.user && req.user.role === 'admin'

    let query
    if (isNaN(id)) {
      query = { _id: id }
    } else {
      query = { id: parseInt(id, 10) }
    }

    const location = await WorldLocation.findOne(query, { __v: 0 }).lean()
    if (!location) {
      return res.status(404).json({ message: 'Location not found' })
    }

    // Only admins can see non-published locations
    if (location.status !== PUBLISHED && !isAdmin) {
      return res.status(404).json({ message: 'Location not found' })
    }

    return res.status(200).json(location)
  } catch (err) {
    logger.error('Error fetching world location by id: ' + err.message)
    return res.status(500).json({
      message: 'Error fetching world location',
      error: err.message,
    })
  }
}

const create = async (req, res) => {
  try {
    const { fields, files } = await parseRequestBody(req)

    let data = {}
    if (fields.formData) {
      try {
        data =
          typeof fields.formData === 'string'
            ? JSON.parse(fields.formData)
            : fields.formData
      } catch (e) {
        data = fields
      }
    } else {
      data = { ...fields }
    }

    // Parse nested JSON if passed as strings (common with FormData)
    if (typeof data.address === 'string') {
      try {
        data.address = JSON.parse(data.address)
      } catch (e) {}
    }
    if (typeof data.links === 'string') {
      try {
        data.links = JSON.parse(data.links)
      } catch (e) {}
    }
    if (typeof data.pictures === 'string') {
      try {
        data.pictures = JSON.parse(data.pictures)
      } catch (e) {}
    }

    const {
      name,
      tipo,
      description,
      latitude,
      longitude,
      address,
      links,
      awards,
      urlAward,
      video,
      email,
    } = data

    if (!name || !tipo) {
      return res.status(422).json({
        message: 'Name and tipo are required fields',
      })
    }

    const lat =
      latitude !== undefined && latitude !== null ? parseFloat(latitude) : null
    const lng =
      longitude !== undefined && longitude !== null
        ? parseFloat(longitude)
        : null

    if (lat === null || lng === null || isNaN(lat) || isNaN(lng)) {
      return res.status(422).json({
        message: 'Valid latitude and longitude are required',
      })
    }

    // Get next sequential id
    const lastLocation = await WorldLocation.findOne().sort({ id: -1 }).lean()
    const nextId = lastLocation && lastLocation.id ? lastLocation.id + 1 : 1

    // Process uploaded images
    const uploadedFiles = []
    Object.keys(files || {}).forEach((key) => {
      const item = files[key]
      if (Array.isArray(item)) {
        uploadedFiles.push(...item)
      } else if (item && item.path) {
        uploadedFiles.push(item)
      }
    })

    if (uploadedFiles.length > 0) {
      const targetDir = path.resolve(MAP_DIR, String(nextId))
      await saveFiles(uploadedFiles, targetDir)
    }

    const uploadedUrls = uploadedFiles.map(
      (f) => `https://static.arasaac.org/map/${nextId}/${f.name}`,
    )

    let allPictures = []
    if (Array.isArray(data.pictures)) {
      allPictures = [...data.pictures]
    } else if (typeof data.pictures === 'string' && data.pictures) {
      allPictures = [data.pictures]
    }
    allPictures = [...allPictures, ...uploadedUrls]

    const mainPicture =
      data.picture || (allPictures.length > 0 ? allPictures[0] : '')

    const isAdmin = req.user && req.user.role === 'admin'
    const status =
      isAdmin && data.status !== undefined ? parseInt(data.status, 10) : PENDING

    const newLocation = new WorldLocation({
      id: nextId,
      name,
      tipo,
      description: description || '',
      latitude: lat,
      longitude: lng,
      location: {
        type: 'Point',
        coordinates: [lng, lat],
      },
      address: address || {},
      links: links || {},
      awards: awards || '',
      urlAward: urlAward || '',
      picture: mainPicture,
      pictures: allPictures,
      video: video || '',
      email: email || '',
      status,
      author: req.user && req.user.id ? req.user.id : undefined,
      created: Date.now(),
      lastUpdated: Date.now(),
    })

    const saved = await newLocation.save()
    logger.info(
      'Created new world location with id ' +
        nextId +
        ' (status: ' +
        status +
        ')',
    )

    // Send email notification to arasaac@aragon.es
    try {
      let authorEmail = email || ''
      let authorName = ''
      if (req.user && req.user.id) {
        const userDoc = await User.findById(req.user.id).lean()
        if (userDoc) {
          authorEmail = authorEmail || userDoc.email
          authorName = userDoc.name
        }
      }
      // 1. Send notification email to arasaac@aragon.es
      sendNewWorldLocationEmail({
        name: saved.name,
        tipo: saved.tipo,
        address: saved.address,
        description: saved.description,
        authorEmail,
        authorName,
      }).catch((e) => {
        logger.error(
          'Error sending world location email to ARASAAC: ' + e.message,
        )
      })

      // 2. Send receipt confirmation email to author
      if (authorEmail) {
        sendReceivedWorldLocationEmail({
          name: saved.name,
          authorEmail,
          authorName,
        }).catch((e) => {
          logger.error(
            'Error sending world location receipt email to author: ' +
              e.message,
          )
        })
      }
    } catch (err) {
      logger.error('Error dispatching world location email: ' + err.message)
    }

    return res.status(201).json(saved)
  } catch (err) {
    logger.error('Error creating world location: ' + err.message)
    return res.status(500).json({
      message: 'Error creating world location',
      error: err.message,
    })
  }
}

const update = async (req, res) => {
  try {
    const { id } = req.params

    let query
    if (isNaN(id)) {
      query = { _id: id }
    } else {
      query = { id: parseInt(id, 10) }
    }

    const location = await WorldLocation.findOne(query)
    if (!location) {
      return res.status(404).json({ message: 'Location not found' })
    }

    const wasPublished =
      location.status !== PUBLISHED &&
      req.body.status !== undefined &&
      parseInt(req.body.status, 10) === PUBLISHED

    const allowedFields = [
      'name',
      'tipo',
      'description',
      'address',
      'links',
      'awards',
      'urlAward',
      'picture',
      'pictures',
      'video',
      'email',
      'status',
    ]

    for (let i = 0; i < allowedFields.length; i++) {
      const field = allowedFields[i]
      if (req.body[field] !== undefined) {
        location[field] = req.body[field]
      }
    }

    if (req.body.latitude !== undefined && req.body.longitude !== undefined) {
      const lat = parseFloat(req.body.latitude)
      const lng = parseFloat(req.body.longitude)
      if (!isNaN(lat) && !isNaN(lng)) {
        location.latitude = lat
        location.longitude = lng
        location.location = {
          type: 'Point',
          coordinates: [lng, lat],
        }
      }
    }

    location.lastUpdated = Date.now()
    const updated = await location.save()

    logger.info('Updated world location id ' + location.id)

    // If location was just approved/published, send email to author
    if (wasPublished) {
      try {
        let authorEmail = updated.email || ''
        let authorName = ''
        if (updated.author) {
          const userDoc = await User.findById(updated.author).lean()
          if (userDoc) {
            authorEmail = authorEmail || userDoc.email
            authorName = userDoc.name
          }
        }
        if (authorEmail) {
          sendApprovedWorldLocationEmail({
            name: updated.name,
            authorEmail,
            authorName,
          }).catch((e) => {
            logger.error(
              'Error sending approved world location email: ' + e.message,
            )
          })
        }
      } catch (err) {
        logger.error(
          'Error dispatching approved world location email: ' + err.message,
        )
      }
    }

    return res.status(200).json(updated)
  } catch (err) {
    logger.error('Error updating world location: ' + err.message)
    return res.status(500).json({
      message: 'Error updating world location',
      error: err.message,
    })
  }
}

const remove = async (req, res) => {
  try {
    const { id } = req.params

    let query
    if (isNaN(id)) {
      query = { _id: id }
    } else {
      query = { id: parseInt(id, 10) }
    }

    const location = await WorldLocation.findOne(query)
    if (!location) {
      return res.status(404).json({ message: 'Location not found' })
    }

    await WorldLocation.deleteOne({ _id: location._id })
    logger.info('Deleted world location id ' + location.id)

    return res.status(200).json({
      message: 'Location deleted successfully',
      id: location.id,
    })
  } catch (err) {
    logger.error('Error deleting world location: ' + err.message)
    return res.status(500).json({
      message: 'Error deleting world location',
      error: err.message,
    })
  }
}

module.exports = {
  getAll,
  getById,
  create,
  update,
  remove,
}
