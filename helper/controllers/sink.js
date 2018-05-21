const Joi = require('joi')
const boom = require('boom')
const underscore = require('underscore')
const uuid = require('uuid')

const braveHapi = require('bat-utils').extras.hapi

const v1 = {}

/*
  PUT /v1/ads/reports/{reporterId}
*/

const schema =
  Joi.object({
    braveVersion: Joi.string().required().description('Brave version'),
    platform: Joi.string().valid('mac', 'winia32', 'winx64', 'android', 'ios', 'linux').required().description('platform identifier'),
    reportId: Joi.string().guid().required().description('identifier for this report'),
    reportStamp: Joi.date().iso().required().description('timestamp in ISO 8601 format').example('2018-03-22T23:26:01.234Z'),

    events: Joi.array().min(0).items(Joi.object().keys({
      type: Joi.string().valid('load', 'focus', 'blur', 'notify', 'foreground', 'restart', 'settings').required(),
      stamp: Joi.date().iso().required(),

      // load, focus, blur
      tabId: Joi.string(),
      // load
      tabType: Joi.string().valid('manual', 'click', 'submit', 'search', 'notification'),
      // load
      tabUrl: Joi.string().uri({ allowRelative: true }),
      // load
      tabClassification: Joi.array().min(1).items(Joi.string()),

      // notify, load with tabType=notification
      notificationId: Joi.string().guid(),
      // notify
      notificationType: Joi.string().valid('generated', 'clicked', 'dismissed', 'timeout'),
      // notify with notificationType=generated
      notificationClassification: Joi.array().min(1).items(Joi.string()),
      // notify with notificationType=generated
      notificationCatlog: Joi.string(),

      // foreground, restart
      place: Joi.string(),

      // settings
      settings: Joi.object().keys({
        operatingMode: Joi.string().valid('A', 'B').required(),
        adsPerHour: Joi.number().integer().min(1).max(20).required(),
        adsPerDay: Joi.number().integer().min(1).max(6).required()
      }).unknown(true)
    }).unknown(true)
/*
    .when('type', {
      is: 'load',
      then: Joi.object({
        tabId: Joi.required(),
        tabType: Joi.required(),
        tabUrl: Joi.required(),
        tabClassification: Joi.required()
      }),
      otherwise: Joi.object({
        tabId: Joi.forbidden(),
        tabType: Joi.forbidden(),
        tabUrl: Joi.forbidden(),
        tabClassification: Joi.forbidden()
      })
    })

    .when('type', {
      is: 'notify',
      then: Joi.object({
        notificationId: Joi.required(),
        notificationType: Joi.required()
      }),
      otherwise: Joi.object({
        notificationId: Joi.forbidden(),
        notificationType: Joi.forbidden()
      })
    })

    .when('tabType', {
      is: 'notification',
      then: Joi.object({
        notificationId: Joi.required()
      })
    })

    .when('notificationType', {
      is: 'generated',
      then: Joi.object({
        notificationClassification: Joi.required(),
        notificationCatalog: Joi.required()
      }),
      otherwise: Joi.object({
        notificationClassification: Joi.forbidden(),
        notificationCatalog: Joi.forbidden()
      })
    })

    .when('type', {
      is: 'foreground',  // or restart
      then: Joi.object({
        place: Joi.required()
      }),
      otherwise: Joi.object({
        place: Joi.forbidden()
      })
    })

    .when('type', {
      is: 'settings',
      then: Joi.object({
        settings: Joi.required()
      }),
      otherwise: Joi.object({
        settings: Joi.forbidden()
      })
    })
 */
  )}).required()

const pairs = {
  example: {
    load: {
      type: 'load',
      stamp: new Date().toISOString(),
      tabId: '1',
      tabType: 'manual',
      tabUrl: 'http://wsj.com',
      tabClassification: [ 'business', 'business' ]
    },
    loadNotification: {
      type: 'load',
      stamp: new Date().toISOString(),
      tabId: '1',
      tabType: 'notification',
      tabUrl: 'http://wsj.com',
      tabClassification: [ 'business', 'business' ],
      notificationId: uuid.v4().toLowerCase()
    },
    focus: {
      type: 'focus',
      stamp: new Date().toISOString(),
      tabId: '1'
    },
    blur: {
      type: 'blur',
      stamp: new Date().toISOString(),
      tabId: '1'
    },
    generated: {
      type: 'notify',
      stamp: new Date().toISOString(),
      notificationId: uuid.v4().toLowerCase(),
      notificationType: 'generated',
      notificationClassification: [ 'business', 'business' ],
      notificationCatalog: 'demo'
    },
    clicked: {
      type: 'notify',
      stamp: new Date().toISOString(),
      notificationId: uuid.v4().toLowerCase(),
      notificationType: 'clicked'
    },
    dismissed: {
      type: 'notify',
      stamp: new Date().toISOString(),
      notificationId: uuid.v4().toLowerCase(),
      notificationType: 'dismissed'
    },
    timeout: {
      type: 'notify',
      stamp: new Date().toISOString(),
      notificationId: uuid.v4().toLowerCase(),
      notificationType: 'timeout'
    },
    foreground: {
      type: 'foreground',
      stamp: new Date().toISOString(),
      place: 'Shell Beach'
    },
    restart: {
      type: 'restart',
      stamp: new Date().toISOString(),
      place: 'Mir'
    },
    settings: {
      type: 'settings',
      stamp: new Date().toISOString(),
      settings: {
        operatingMode: 'A',
        adsPerHour: 20,
        adsPerDay: 6
      }
    }
  }
}

v1.sink1 = { handler: (runtime) => {
  return async (request, reply) => {
    const reporterId = request.params.reporterId
    const reportId = request.payload.reportid

    if (!pairs[reporterId]) pairs[reporterId] = {}
    if (pairs[reporterId][reportId]) return reply(boom.badData('previously seen reportId: ' + reportId))

    pairs[reporterId][reportId] = request.payload
    reply({})
  }
},

  description: 'Ad reporter sink for testing',
  tags: [ 'api' ],

  validate: {
    params: { reporterId: Joi.string().guid().required().description('opaque-identifier of the reporter') },
    payload: schema
  },

  response: { schema: Joi.any() }
}

module.exports.routes = [
  braveHapi.routes.async().put().path('/v1/ads/reports/{reporderId}').config(v1.sink1)
]

module.exports.initialize = async (debug, runtime) => {
  underscore.keys(pairs).forEach((reporterId) => {
    underscore.keys(pairs[reporterId]).forEach((reportId) => {
      const report = {
        braveVersion: '0.22.714',
        platform: 'mac',
        reportId: uuid.v4().toLowerCase(),
        reportStamp: pairs[reporterId][reportId].stamp,
        events: [ pairs[reporterId][reportId] ]
      }
      const validity = Joi.validate(report, schema)

      console.log(reporterId + '.' + reportId + ': ' + (validity.error || 'OK'))
      if (validity.error) console.log(JSON.stringify(pairs[reporterId][reportId], null, 2))
    })
  })
}
