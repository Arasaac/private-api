const axios = require('axios')
const logger = require('../utils/logger')

const getSyntax = async (req, res) => {
  logger.debug('EXEC getSyntax phraseController')

  const { phrase } = req.params

  try {
    const url = `http://backend_freeling:5000/syntax?frase=${encodeURIComponent(phrase)}`
    const { data } = await axios.get(url, {
      headers: { Accept: 'application/json' },
      timeout: 5000, // opcional
    })

    return res.json(data)
  } catch (error) {
    logger.error(
      `Error getting getSyntax for phrase "${phrase}". See error: ${error.message}`,
    )
    return res.status(500).json({
      error: error.message,
    })
  }
}

module.exports = {
  getSyntax,
}
