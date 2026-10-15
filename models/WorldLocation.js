const mongoose = require('mongoose')
const { Schema } = mongoose

const addressSchema = new Schema(
  {
    address: String,
    postalCode: String,
    city: String,
    province: String,
    country: String,
  },
  { _id: false },
)

const linkSchema = new Schema(
  {
    url: {
      type: String,
      alias: 'enlace',
      required: true,
    },
    type: {
      type: String,
      alias: 'tipo',
      default: 'web',
    },
  },
  {
    _id: false,
    id: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
)

const locationSchema = new Schema(
  {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      required: true,
    },
  },
  { _id: false },
)

const worldLocationSchema = new Schema({
  id: {
    type: Number,
    unique: true,
    index: true,
  },
  name: {
    type: String,
    required: true,
  },
  tipo: {
    type: String,
    required: true,
    index: true,
  },
  description: String,
  location: locationSchema,
  latitude: Number,
  longitude: Number,
  address: addressSchema,
  links: [linkSchema],
  awards: String,
  urlAward: String,
  picture: String,
  pictures: [String],
  video: String,
  email: String,
  status: {
    type: Number,
    default: 1, // 0: unpublished/rejected, 1: published, 2: pending review
    index: true,
  },
  author: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  created: {
    type: Date,
    default: Date.now,
  },
  lastUpdated: {
    type: Date,
    default: Date.now,
  },
})

worldLocationSchema.index({ location: '2dsphere' })
worldLocationSchema.index({
  name: 'text',
  description: 'text',
  'address.city': 'text',
  'address.country': 'text',
})

const WorldLocation = mongoose.model('WorldLocation', worldLocationSchema)

module.exports = WorldLocation
