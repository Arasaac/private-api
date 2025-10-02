const router = require('express').Router()
const wordsController = require('../controllers/wordsController')

router.get('/synsets/:idSynset', (req, res) => {
  wordsController.getWordnetById(req, res)
})

module.exports = router
