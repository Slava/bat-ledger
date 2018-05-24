
const hapi = require('./boot-hapi')
const extras = require('./boot-extras')
const runtime = require('./boot-runtime')
const hash = {
  hapi,
  extras,
  runtime
}

module.exports = Object.keys(hash).reduce((memo, key) => {
  const uppercase = key.charAt(0).toUpperCase() + key.slice(1)
  memo[uppercase] = memo[key] = hash[key]
  return memo
}, {})
