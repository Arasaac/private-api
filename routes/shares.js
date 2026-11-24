const router = require('express').Router()
const passport = require('passport')
const sharesController = require('../controllers/sharesController')

const auth = passport.authenticate('bearer', { session: false })

router.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow')
  next()
})

router.post('/', auth, (req, res) => {
  sharesController.create(req, res)
})

router.get('/mine', auth, (req, res) => {
  sharesController.mine(req, res)
})

router.get('/:id/page', (req, res) => {
  sharesController.page(req, res)
})

router.get('/:id/og.png', (req, res) => {
  sharesController.ogImage(req, res)
})

router.get('/:id', (req, res) => {
  sharesController.get(req, res)
})

router.delete('/:id', auth, (req, res) => {
  sharesController.remove(req, res)
})

module.exports = router
