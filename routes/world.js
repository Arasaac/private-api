const router = require('express').Router()
const passport = require('passport')
const { hasRole } = require('../middlewares')
const worldController = require('../controllers/worldController')

router.get(
  '/',
  passport.authenticate(['bearer', 'anonymous'], { session: false }),
  (req, res) => {
    worldController.getAll(req, res)
  },
)

router.get(
  '/:id',
  passport.authenticate(['bearer', 'anonymous'], { session: false }),
  (req, res) => {
    worldController.getById(req, res)
  },
)

router.post(
  '/',
  passport.authenticate('bearer', { session: false }),
  (req, res) => {
    worldController.create(req, res)
  },
)

router.put(
  '/:id',
  passport.authenticate('bearer', { session: false }),
  hasRole('admin'),
  (req, res) => {
    worldController.update(req, res)
  },
)

router.delete(
  '/:id',
  passport.authenticate('bearer', { session: false }),
  hasRole('admin'),
  (req, res) => {
    worldController.remove(req, res)
  },
)

module.exports = router
