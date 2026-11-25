const {
  normalizeText,
  buildSearchText,
  tokenize,
  prefixPattern,
  scoreShare,
  rankShares,
} = require('../../utils/sharesSearch')

const NOW = Date.UTC(2026, 0, 31)
const DAY = 24 * 3600 * 1000
let n = 0
const share = (fields = {}) => {
  n++
  return {
    _id: `id${String(n).padStart(6, '0')}`,
    title: '',
    description: '',
    visits: 0,
    copies: 0,
    createdAt: new Date(NOW - DAY),
    listedAt: new Date(NOW - DAY),
    ...fields,
  }
}
const order = (list, opts) =>
  rankShares(list, { now: NOW, ...opts }).map((s) => s._id)

describe('sharesSearch helpers', () => {
  it('normalizes case, diacritics and spaces', () => {
    expect(normalizeText('  Pájaros   del\tBOSQUE ñandú ')).toBe(
      'pajaros del bosque nandu',
    )
    expect(normalizeText(undefined)).toBe('')
    expect(buildSearchText('Título', 'Descripción  larga')).toBe(
      'titulo descripcion larga',
    )
    expect(buildSearchText('Solo', '')).toBe('solo')
  })

  it('tokenizes into at most 8 tokens', () => {
    expect(tokenize('a b  c')).toEqual(['a', 'b', 'c'])
    expect(tokenize('1 2 3 4 5 6 7 8 9 10')).toHaveLength(8)
    expect(tokenize('')).toEqual([])
  })

  it('prefix pattern matches only at the start of words, escaping regex', () => {
    const re = (t) => new RegExp(prefixPattern(t))
    expect(re('paj').test('los pajaros')).toBe(true)
    expect(re('paj').test('pajaros')).toBe(true)
    expect(re('aros').test('los pajaros')).toBe(false)
    expect(re('ros').test('pajaros-rosas')).toBe(true)
    expect(re('.*').test('anything')).toBe(false)
    expect(re('c++').test('juego c++')).toBe(true)
  })
})

describe('rankShares', () => {
  it('exact title beats a title that starts with q, which beats a partial one', () => {
    const partial = share({ title: 'Mis gatos favoritos' })
    const starts = share({ title: 'Gatos y perros' })
    const exact = share({ title: 'Gatos' })
    expect(order([partial, starts, exact], { q: 'gatos' })).toEqual([
      exact._id,
      starts._id,
      partial._id,
    ])
    expect(scoreShare(exact, { q: 'Gatos', now: NOW })).toBeGreaterThan(120)
  })

  it('title match beats description match', () => {
    const inDescription = share({ title: 'Animales', description: 'perros' })
    const inTitle = share({ title: 'Los perros', description: '' })
    expect(order([inDescription, inTitle], { q: 'perr' })).toEqual([
      inTitle._id,
      inDescription._id,
    ])
  })

  it('a whole word match beats a prefix match', () => {
    const prefix = share({ title: 'El soles' })
    const word = share({ title: 'El sol' })
    expect(order([prefix, word], { q: 'sol' })).toEqual([word._id, prefix._id])
    const a = scoreShare(word, { q: 'sol', now: NOW })
    const b = scoreShare(prefix, { q: 'sol', now: NOW })
    expect(a - b).toBeCloseTo(2)
  })

  it('popularity breaks ties between equal text matches', () => {
    const quiet = share({ title: 'Sumas' })
    const popular = share({ title: 'Sumas', visits: 50, copies: 10 })
    expect(order([quiet, popular], { q: 'sumas' })).toEqual([
      popular._id,
      quiet._id,
    ])
  })

  it('freshness breaks ties between equal text and popularity', () => {
    const old = share({ title: 'Restas', listedAt: new Date(NOW - 200 * DAY) })
    const fresh = share({ title: 'Restas', listedAt: new Date(NOW) })
    expect(order([old, fresh], { q: 'restas' })).toEqual([fresh._id, old._id])
    // without listedAt, createdAt is used
    const created = share({
      title: 'Restas',
      listedAt: undefined,
      createdAt: new Date(NOW - 2 * DAY),
    })
    expect(order([old, created], { q: 'restas' })[0]).toBe(created._id)
  })

  it('relevance without q mixes popularity and freshness', () => {
    const fresh = share({ listedAt: new Date(NOW) })
    const popularOld = share({
      visits: 9999,
      listedAt: new Date(NOW - 365 * DAY),
    })
    const quietOld = share({ listedAt: new Date(NOW - 365 * DAY) })
    expect(order([quietOld, fresh, popularOld], {})).toEqual([
      popularOld._id,
      fresh._id,
      quietOld._id,
    ])
    const s = share({ visits: 9, listedAt: new Date(NOW) })
    expect(scoreShare(s, { now: NOW })).toBeCloseTo(1 + 3)
  })

  it('popular sorts by visits + 5 * copies, then newest', () => {
    const a = share({ visits: 10 })
    const b = share({ copies: 3 })
    const c = share({ visits: 1, createdAt: new Date(NOW - 5 * DAY) })
    const d = share({ visits: 1, createdAt: new Date(NOW - 1 * DAY) })
    expect(order([a, b, c, d], { sort: 'popular' })).toEqual([
      b._id,
      a._id,
      d._id,
      c._id,
    ])
  })

  it('recent sorts by listedAt (or createdAt) desc', () => {
    const a = share({ listedAt: new Date(NOW - 3 * DAY) })
    const b = share({ listedAt: undefined, createdAt: new Date(NOW - 2 * DAY) })
    const c = share({ listedAt: new Date(NOW - DAY) })
    expect(order([a, b, c], { sort: 'recent' })).toEqual([c._id, b._id, a._id])
  })

  it('does not modify the input array', () => {
    const list = [share({ visits: 1 }), share({ visits: 2 })]
    const copy = [...list]
    rankShares(list, { sort: 'popular', now: NOW })
    expect(list).toEqual(copy)
  })
})
