const router = require('express').Router()
const passport = require('passport')
const aiController = require('../controllers/aiController')

// Chat completions proxy (allows public and authenticated access from arawrite / clients)
router.post(
  '/chat/completions',
  passport.authenticate(['bearer', 'anonymous'], { session: false }),
  (req, res) => {
    aiController.chatCompletions(req, res)
  },
)

// AI machines health and models availability
router.get(
  '/models',
  passport.authenticate(['bearer', 'anonymous'], { session: false }),
  (req, res) => {
    aiController.getModels(req, res)
  },
)

// AI Training record submission (curation / wrong translation learning)
router.post(
  '/training',
  passport.authenticate(['bearer', 'anonymous'], { session: false }),
  (req, res) => {
    aiController.submitTraining(req, res)
  },
)

module.exports = router
