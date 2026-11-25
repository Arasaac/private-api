const axios = require('axios')
const logger = require('./logger')

const TIMEOUT_MS = 5000

// Posts a message to a Mattermost channel. Does nothing when Mattermost is not
// configured, and never throws: resolves true when posted, false otherwise.
const postToMattermost = async (message, { channelId } = {}) => {
  const url = process.env.MATTERMOST_URL
  const token = process.env.MATTERMOST_TOKEN
  const channel =
    channelId ||
    process.env.MATTERMOST_CHANNEL_ID_ARACTIVITIES ||
    process.env.MATTERMOST_CHANNEL_ID
  if (!url || !token || !channel) return false
  try {
    await axios.post(
      `${url.replace(/\/+$/, '')}/api/v4/posts`,
      { channel_id: channel, message },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT_MS,
      },
    )
    return true
  } catch (err) {
    logger.warn(`Mattermost post failed: ${err.message}`)
    return false
  }
}

module.exports = { postToMattermost }
