const mongoose = require('mongoose')
const logger = require('./utils/logger')

let mongoServer

mongoose.Promise = global.Promise
mongoose.set('useFindAndModify', false)
mongoose.set('useCreateIndex', true)

const opts = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}

const open = async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      return
    }
    if (process.env.MONGO_DB_HOST === 'inmemory') {
      logger.debug('connecting to inmemory mongo db')
      if (!mongoServer) {
        const { MongoMemoryServer } = require('mongodb-memory-server')
        mongoServer = await MongoMemoryServer.create()
      }
      const mongoUrl = mongoServer.getUri()
      await mongoose.connect(mongoUrl, opts)
      logger.info('Connected to inmemory database')
    } else {
      const MONGO_DB_USER = process.env.MONGO_DB_USER
      const MONGO_DB_PWD = process.env.MONGO_DB_PWD
      const MONGO_DB_HOST = process.env.MONGO_DB_HOST
      const databaseUrl = `mongodb://${MONGO_DB_USER}:${MONGO_DB_PWD}@${MONGO_DB_HOST}/arasaac?authSource=admin`
      await mongoose.connect(databaseUrl, opts)
      logger.info(`Connected to database: ${databaseUrl}`)
    }
  } catch (err) {
    logger.error(`Database connection error: ${err}`)
    throw err
  }
}

const close = async () => {
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect()
    }
    if (process.env.MONGO_DB_HOST === 'inmemory' && mongoServer) {
      await mongoServer.stop()
      mongoServer = undefined
    }
  } catch (err) {
    logger.error(`Database close error: ${err}`)
    throw err
  }
}

if (process.env.NODE_ENV !== 'test') {
  open().catch((err) => {
    logger.error(`Initial database connection error: ${err}`)
  })
}

process.on('SIGINT', () =>
  mongoose.connection.close(() => {
    console.log('Finished App and disconnected from database')
    process.exit(0)
  }),
)

module.exports = {
  open,
  close,
  connect: open,
  disconnect: close,
}
