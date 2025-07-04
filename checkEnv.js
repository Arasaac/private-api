const logger = require('./utils/logger')

const checkEnvs = envVars =>
  envVars.forEach(envVar => {
    if (!process.env[envVar]) {
      logger.error(`Variable ${envVar} not defined`)
      process.exit(1)
    }
  })

checkEnvs([
  'EMAIL_FROM',
  'EMAIL_USER',
  'EMAIL_PASSWORD',
  'EMAIL_SMTP',
  'EMAIL_PORT',
  // 'SFTP_SERVER',
  'LOG_LEVEL',
  'CROWDIN_ARASAAC_API_KEY',
  'MONGO_DB_USER',
  'MONGO_DB_PWD',
  'CRONTAB'
])

module.exports = checkEnvs
