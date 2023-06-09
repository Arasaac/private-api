const router = require('express').Router()
const locutionsController = require('../controllers/locutionsController')

router.get('/:locale/:keyword', (req, res) => locutionsController.getLocutionById(req, res))

module.exports = router
