const router = require('express').Router()
const passport = require('passport')
const sharesController = require('../controllers/sharesController')

const auth = passport.authenticate('bearer', { session: false })

// sets req.user when a valid bearer token comes; otherwise goes on anonymous
// (a missing, invalid or unverifiable token never answers 401 here)
const optionalAuth = (req, res, next) => {
  if (!req.headers.authorization) return next()
  return passport.authenticate('bearer', { session: false }, (err, user) => {
    if (!err && user) req.user = user
    next()
  })(req, res, next)
}

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

// admins: every link, with reports (must be before '/:id')
router.get('/admin', auth, (req, res) => {
  sharesController.adminList(req, res)
})

// public: listed links (must be before '/:id')
router.get('/search', (req, res) => {
  sharesController.search(req, res)
})

router.post('/:id/copy', auth, (req, res) => {
  sharesController.copy(req, res)
})

router.post('/:id/report', auth, (req, res) => {
  sharesController.report(req, res)
})

router.get('/:id/page', (req, res) => {
  sharesController.page(req, res)
})

router.get('/:id/og.png', (req, res) => {
  sharesController.ogImage(req, res)
})

router.get('/:id', optionalAuth, (req, res) => {
  sharesController.get(req, res)
})

router.patch('/:id', auth, (req, res) => {
  sharesController.update(req, res)
})

router.delete('/:id', auth, (req, res) => {
  sharesController.remove(req, res)
})

module.exports = router
