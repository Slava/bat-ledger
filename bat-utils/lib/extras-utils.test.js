'use strict'
import test from 'ava'
import {
  ObjectID
} from 'mongodb'
import {
  createdTimestamp,
  timeout,
  documentOlderThan
} from './extras-utils'

import dotenv from 'dotenv'
dotenv.config()

const objectId = ObjectID('5b11685dd28b11258d50c1f4')
const objectDate = (new Date('2018-06-01T15:38:05.000Z')).getTime()
test('createdTimestamp', (t) => {
  t.plan(1)
  const fromId = createdTimestamp(objectId)
  t.is(fromId, objectDate)
})

test('timeout', (t) => {
  t.plan(1)
  let bool = false
  timeout(495).then(() => {
    bool = true
  })
  const justRight = timeout(500).then(() => {
    t.true(bool)
  })
  const tooLate = timeout(505).then(() => {
    throw new Error('bad timeout')
  })
  return Promise.race([
    justRight,
    tooLate
  ])
})

test('documentOlderThan', (t) => {
  t.plan(3)
  t.true(documentOlderThan(-1, objectDate, objectId))
  t.false(documentOlderThan(1, objectDate, objectId))
  // lt not lte
  t.false(documentOlderThan(0, objectDate, objectId))
})
