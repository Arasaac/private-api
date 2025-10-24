const router = require('express').Router()
const phraseController = require('../controllers/phraseController')

router.get('/syntax/:phrase', (req, res) => {
  phraseController.getSyntax(req, res)
})

module.exports = router
