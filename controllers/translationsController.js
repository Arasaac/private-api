const axios = require('axios')
const { CROWDIN_ARASAAC_API_KEY, CROWDIN_ADMIN_ARASAAC_API_KEY } = process.env
const Translations = require('../models/Translation')
// const CustomError = require('../utils/CustomError')
const logger = require('../utils/logger')
const languages = require('../utils/languages')
const setPictogramModel = require('../models/Pictogram')

const Pictograms = languages.reduce((dict, language) => {
  dict[language] = setPictogramModel(language)
  return dict
}, {})

const postTranslationStatus = async (req, res) => {
  const { language } = req.params
  logger.debug(
    `EXEC postTranslationsStatus for language ${language}`
  )

  try {
    let config
    let getArasaacCrowdin
    let getAdminArasaacCrowdin
    if (language === 'en') {
      getArasaacCrowdin = Promise.resolve(100)
      getAdminArasaacCrowdin = Promise.resolve(100)
    } else {
      config = {
        headers: {
          'Authorization': `Bearer ${CROWDIN_ARASAAC_API_KEY}`,
          'Accept': 'application/json',
        }
      };
    }
    let crowdinLanguage
    switch (language) {
        case 'es':
          crowdinLanguage = 'es-ES'
          break
        case 'val':
          crowdinLanguage = 'val-ES'
          break
        case 'zh':
          crowdinLanguage = 'zh-CN'
          break
        case 'pt':
          crowdinLanguage = 'pt-PT'
          break
        case 'br':
          // we use pt with crowdin
          crowdinLanguage = 'pt-PT'
          break
        default:
          crowdinLanguage = language
      }
      getArasaacCrowdin = axios.get(
        `https://api.crowdin.com/api/v2/projects/236406/languages/${crowdinLanguage}/progress`,
        config
      )

      getAdminArasaacCrowdin = axios.get(
        `https://api.crowdin.com/api/v2/projects/318533/languages/${crowdinLanguage}/progress`,
        config
      )

    const getTotalPictograms = Pictograms[language]
      .find({ available: true })
      .countDocuments()
      .exec()

    const getPictogramsValidated = Pictograms[language]
      .find({ available: true, validated: true })
      .countDocuments()
      .exec()

    const [
      arasaacCrowdin,
      adminArasaacCrowdin,
      totalPictograms,
      pictogramsValidated
    ] = await Promise.all([
      getArasaacCrowdin,
      getAdminArasaacCrowdin,
      getTotalPictograms,
      getPictogramsValidated
    ])

    const arasaacPhrases = language === 'en' ? 100 : arasaacCrowdin.data.data[0].data.phrases.total
    const arasaacTranslated = language === 'en' ? 100 : arasaacCrowdin.data.data[0].data.phrases.translated
    const adminPhrases = language === 'en' ? 100 : adminArasaacCrowdin.data.data[0].data.phrases.total
    const adminTranslated = language === 'en' ? 100 : adminArasaacCrowdin.data.data[0].data.phrases.translated
    const updated = Date.now()
    await Translations.findOneAndUpdate(
      { language },
      { language, arasaacPhrases, arasaacTranslated, adminPhrases, adminTranslated, totalPictograms, pictogramsValidated, updated },
      { upsert: true }
    )

    logger.debug(`DONE postTranslationStatus for language ${language}.`)

    return res.status(200).json({
      totalPictograms,
      pictogramsValidated,
      arasaacPhrases,
      arasaacTranslated,
      adminPhrases,
      adminTranslated,
      updated
    })
  } catch (error) {
    logger.error(
      `Error executing postTranslationStatus for language ${language}. See error: ${error}`
    )
    return res.status(500).json({
      error: error.message
    })
  }
}

const postTranslationStatusByCrontab = async (language) => {
  logger.debug(
    `EXEC postTranslationsStatusByCrontab for language ${language}`
  )

  try {
    let config
    let getArasaacCrowdin
    let getAdminArasaacCrowdin
    if (language === 'en') {
      getArasaacCrowdin = Promise.resolve(100)
      getArasaacCrowdin = Promise.resolve(100)
    } else {
      config = {
        headers: {
          Authorization: `Bearer ${CROWDIN_ARASAAC_API_KEY}`,
          Accept: 'application/json'
        }
      }
      let crowdinLanguage
      switch (language) {
        case 'es':
          crowdinLanguage = 'es-ES'
          break
        case 'val':
          crowdinLanguage = 'val-ES'
          break
        case 'zh':
          crowdinLanguage = 'zh-CN'
          break
        case 'pt':
          crowdinLanguage = 'pt-PT'
          break
        case 'sv':
          crowdinLanguage = 'sv-SE'
          break
        case 'br':
          // we use pt with crowdin
          crowdinLanguage = 'pt-PT'
          break
        default:
          crowdinLanguage = language
      }
      getArasaacCrowdin = axios.post(
        `https://api.crowdin.com/api/v2/projects/236406/languages/${crowdinLanguage}/progress`,
        config
      )

      getAdminArasaacCrowdin = axios.post(
        `https://api.crowdin.com/api/v2/projects/318533/languages/${crowdinLanguage}/progress`,
        config
      )
    }

    const getTotalPictograms = Pictograms[language]
      .find({ available: true })
      .countDocuments()
      .exec()

    const getPictogramsValidated = Pictograms[language]
      .find({ available: true, validated: true })
      .countDocuments()
      .exec()

    const [
      arasaacCrowdin,
      adminArasaacCrowdin,
      totalPictograms,
      pictogramsValidated
    ] = await Promise.all([
      getArasaacCrowdin,
      getAdminArasaacCrowdin,
      getTotalPictograms,
      getPictogramsValidated
    ])


    const arasaacPhrases = language === 'en' ? 100 : arasaacCrowdin.data.data[0].data.phrases.total
    const arasaacTranslated = language === 'en' ? 100 : arasaacCrowdin.data.data[0].data.phrases.translated
    const adminPhrases = language === 'en' ? 100 : adminArasaacCrowdin.data.data[0].data.phrases.total
    const adminTranslated = language === 'en' ? 100 : adminArasaacCrowdin.data.data[0].data.phrases.translated
    const updated = Date.now()
    await Translations.findOneAndUpdate(
      { language },
      { language, arasaacPhrases, arasaacTranslated, adminPhrases, adminTranslated, totalPictograms, pictogramsValidated, updated },
      { upsert: true }
    )

    logger.debug(`DONE postTranslationStatusByCrontab for language ${language}.`)

    return true
  } catch (error) {
    logger.error(
      `Error executing postTranslationStatusByCrontab for language ${language}. See error: ${error}`
    )
    return false
  }
}

const getTranslationStatus = async (req, res) => {
  const { language } = req.params
  logger.debug(
    `EXEC getTranslationStatus for language ${language}`
  )

  try {
    const translation = await Translations.findOne({ language }, { __v: 0 })
    if (!translation) {
      logger.debug(`Not found translation for language ${language}`)
      return res.status(404).json({})
    }
    return res.json(translation)
  } catch (error) {
    logger.error(
      `Error getting translationStatus for language ${language}. See error: ${error}`
    )
    return res.status(500).json({
      error: error.message
    })
  }
}

module.exports = {
  postTranslationStatus,
  postTranslationStatusByCrontab,
  getTranslationStatus
}
