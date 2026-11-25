const mongoose = require('mongoose')
const { Schema } = mongoose

// 24 months without visits
const SHARE_TTL_SECONDS = 63072000

const ShareSchema = new Schema(
  {
    _id: { type: String },
    ownerId: { type: String, required: true },
    hash: { type: String, required: true },
    data: { type: String, required: true },
    generator: { type: String, required: true },
    lang: { type: String },
    title: { type: String, default: '' },
    pictogramIds: { type: [Number], default: [] },
    createdAt: { type: Date, default: Date.now },
    lastAccessedAt: { type: Date, default: Date.now },
    visits: { type: Number, default: 0 },
    description: { type: String, default: '' },
    // undefined: the author never decided. Only `true` appears in search
    listed: { type: Boolean },
    listedAt: { type: Date },
    // times someone saved a copy in their activities
    copies: { type: Number, default: 0 },
    // chosen by admins: shown first in search
    featured: { type: Boolean, default: false },
    featuredAt: { type: Date },
    featuredBy: { type: String },
    // moderation
    hidden: { type: Boolean, default: false },
    reports: {
      type: [
        {
          userId: String,
          reason: { type: String, maxlength: 300 },
          at: Date,
          _id: false,
        },
      ],
      default: [],
    },
    // reports an admin already reviewed (moved here when restoring or dismissing)
    dismissedReports: {
      type: [
        {
          userId: String,
          reason: { type: String, maxlength: 300 },
          at: Date,
          _id: false,
        },
      ],
      default: [],
    },
    // last moderation by an admin: 'hidden' | 'restored' | 'dismissed'
    moderation: {
      action: String,
      by: String,
      at: Date,
    },
    // normalized `${title} ${description}` (lowercase, no diacritics)
    searchText: { type: String, default: '' },
  },
  { versionKey: false },
)

ShareSchema.index({ ownerId: 1, hash: 1 }, { unique: true })
ShareSchema.index({ ownerId: 1, createdAt: -1 })
ShareSchema.index({ listed: 1, hidden: 1, generator: 1 })
ShareSchema.index({ listed: 1, ownerId: 1 })
ShareSchema.index({ listed: 1, hidden: 1, featured: 1 })
ShareSchema.index({ hidden: 1, createdAt: -1 })
ShareSchema.index(
  { lastAccessedAt: 1 },
  { expireAfterSeconds: SHARE_TTL_SECONDS },
)

const Share = mongoose.model('Share', ShareSchema, 'shares')

module.exports = Share
module.exports.SHARE_TTL_SECONDS = SHARE_TTL_SECONDS
