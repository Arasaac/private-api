const router = require('express').Router()
const passport = require('passport')
const bugReportsController = require('../controllers/bugReportsController')

router.post(
  '/',
  passport.authenticate('bearer', { session: false }),
  (req, res) => {
    bugReportsController.create(req, res)
  },
)

router.post('/webhook', (req, res) => {
  bugReportsController.webhook(req, res)
})

module.exports = router
