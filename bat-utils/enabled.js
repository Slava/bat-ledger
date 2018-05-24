const SPACES = process.env.BATUTIL_SPACES || '*'
const namespaces = SPACES.split(/[\s,]+/)
const ignores = []
const req = []

const utilspaces = {
  ignores,
  require: req
}

namespaces.forEach((namespace) => {
  namespace = namespace.replace(/\*/g, '.*?')
  if (namespace[0] === '-') {
    ignores.push(new RegExp('^' + namespace.substr(1) + '$'))
  } else {
    req.push(new RegExp('^' + namespace + '$'))
  }
})

module.exports = enabled

function enabled (namespace) {
  const memberP = (member) => {
    let result = false
    const list = utilspaces[member]
    list.forEach((entry) => {
      if (entry.test(namespace)) {
        result = true
      }
    })
    return result
  }

  if (memberP('ignores')) {
    return false
  }

  return memberP('require')
}
