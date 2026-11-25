// Helpers for searching shared links (pure functions, unit tested)

const MAX_TOKENS = 8
const DAY_MS = 24 * 60 * 60 * 1000
const FRESHNESS_DAYS = 60

// lowercase, without diacritics ("Pájaros" -> "pajaros"), collapsed spaces
const normalizeText = (value) =>
  String(value === undefined || value === null ? '' : value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

const buildSearchText = (title, description) =>
  normalizeText(`${title || ''} ${description || ''}`)

const tokenize = (normalizedQuery) =>
  normalizedQuery.split(' ').filter(Boolean).slice(0, MAX_TOKENS)

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

// token must match the START of a word
const prefixPattern = (token) => `(^|[^a-z0-9])${escapeRegex(token)}`
const wordPattern = (token) => `(^|[^a-z0-9])${escapeRegex(token)}($|[^a-z0-9])`

const popularityCount = (share) =>
  (Number(share.visits) || 0) + 5 * (Number(share.copies) || 0)

const listedTime = (share) => {
  const date = share.listedAt || share.createdAt
  const time = date ? new Date(date).getTime() : 0
  return Number.isFinite(time) ? time : 0
}

const createdTime = (share) => {
  const time = share.createdAt ? new Date(share.createdAt).getTime() : 0
  return Number.isFinite(time) ? time : 0
}

const popularity = (share) => Math.log10(1 + popularityCount(share))

const freshness = (share, now) => {
  const ageDays = Math.max(0, (now - listedTime(share)) / DAY_MS)
  return Math.exp(-ageDays / FRESHNESS_DAYS)
}

const textScore = (share, normalizedQuery, tokens) => {
  const title = normalizeText(share.title)
  const description = normalizeText(share.description)
  let score = 0
  if (title === normalizedQuery) score += 100
  if (title.startsWith(normalizedQuery)) score += 20
  tokens.forEach((token) => {
    const prefix = new RegExp(prefixPattern(token))
    if (prefix.test(title)) score += 10
    else if (prefix.test(description)) score += 3
    if (new RegExp(wordPattern(token)).test(title)) score += 2
  })
  return score
}

const scoreShare = (share, { q, now = Date.now() } = {}) => {
  const normalizedQuery = normalizeText(q)
  const base = popularity(share) + 3 * freshness(share, now)
  if (!normalizedQuery) return base
  return base + textScore(share, normalizedQuery, tokenize(normalizedQuery))
}

const byNewest = (a, b) => createdTime(b) - createdTime(a)
const byId = (a, b) =>
  String(a._id || a.id).localeCompare(String(b._id || b.id))

// Returns a new array sorted for sort = relevance | popular | recent
const rankShares = (
  shares,
  { q, sort = 'relevance', now = Date.now() } = {},
) => {
  const list = [...shares]
  if (sort === 'popular') {
    return list.sort(
      (a, b) =>
        popularityCount(b) - popularityCount(a) || byNewest(a, b) || byId(a, b),
    )
  }
  if (sort === 'recent') {
    return list.sort(
      (a, b) => listedTime(b) - listedTime(a) || byNewest(a, b) || byId(a, b),
    )
  }
  const scores = new Map(list.map((s) => [s, scoreShare(s, { q, now })]))
  return list.sort(
    (a, b) => scores.get(b) - scores.get(a) || byNewest(a, b) || byId(a, b),
  )
}

module.exports = {
  MAX_TOKENS,
  normalizeText,
  buildSearchText,
  tokenize,
  escapeRegex,
  prefixPattern,
  scoreShare,
  rankShares,
}
