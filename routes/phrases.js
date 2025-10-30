const router = require('express').Router()
const phraseController = require('../controllers/phraseController')

router.get('/syntax/:phrase', (req, res) => {
  phraseController.getSyntax(req, res)
})

router.get('/flex/:phrase', (req, res) => {
  phraseController.getFlex(req, res)
})

module.exports = router
