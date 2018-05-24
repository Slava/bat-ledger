const dotenv = require('dotenv')
const os = require('os')
const {
  parse,
  join
} = require('path')
const tldjs = require('tldjs')

const config = require('../config.js')

const { newrelic } = config

dotenv.config()

if (newrelic) {
  if (!newrelic.appname) {
    const appname = parse(__filename).name

    if (process.env.NODE_ENV === 'production') {
      newrelic.appname = appname + '.' + tldjs.getSubdomain(process.env.HOST)
    } else {
      newrelic.appname = 'bat-' + process.env.SERVICE + '-' + appname + '@' + os.hostname()
    }
  }
  process.env.NEW_RELIC_APP_NAME = newrelic.appname

  require(join('..', 'bat-utils', 'lib', 'runtime-newrelic'))(config)
}

const hapiControllersIndex = require(lib('hapi-controllers-index'))
const hapiControllersLogin = require(lib('hapi-controllers-login'))
const hapiControllersPing = require(lib('hapi-controllers-ping'))
const hapiServer = require(lib('hapi-server'))
const Runtime = require(utils('boot-runtime'))

const controllers = {
  index: hapiControllersIndex,
  login: hapiControllersLogin,
  ping: hapiControllersPing
}

const options = {
  parent: join(__dirname, 'controllers'),
  routes: controllers.index,
  controllers: controllers,
  module: module
}

config.database = false
config.queue = false

module.exports = hapiServer(options, new Runtime(config))

function utils (name) {
  return join('..', 'bat-utils', name)
}

function lib (name) {
  return utils(join('lib', name))
}
