const mongoose = require('mongoose')
const { Schema } = mongoose

const BugReportSchema = new Schema(
  {
    postId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userEmail: {
      type: String,
      required: true,
      trim: true,
    },
    userName: {
      type: String,
      trim: true,
    },
    activityName: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    created: {
      type: Date,
      default: Date.now,
    },
  },
  {
    strict: false,
  },
)

const BugReport = mongoose.model('BugReport', BugReportSchema, 'bugreports')

module.exports = BugReport
