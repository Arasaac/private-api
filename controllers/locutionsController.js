const filenamify = require('filenamify')
const { LOCUTIONS_DIR } = require('../utils/constants')

const getLocutionById = (req, res) => {
  const { locale, keyword } = req.params
  try {
    const locution = `${LOCUTIONS_DIR}/${locale}/${keyword}.mp3`
    let locutionName = `${filenamify(keyword, { replacement: '' })}.mp3`
    res.download(locution, locutionName)
  } catch (err) {
    console.log(err)
    return res.status(500).json({
      message: 'Error getting locution. See error field for detail',
      error: err
    })
  }
}

module.exports = {
  getLocutionById
}
