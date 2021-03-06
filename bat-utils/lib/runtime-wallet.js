const BigNumber = require('bignumber.js')
const SDebug = require('sdebug')
const UpholdSDK = require('@uphold/uphold-sdk-javascript')
const crypto = require('crypto')
const underscore = require('underscore')
const { verify } = require('http-request-signature')

const braveHapi = require('./extras-hapi')
const braveUtils = require('./extras-utils')
const whitelist = require('./hapi-auth-whitelist')

const Currency = require('./runtime-currency')

const debug = new SDebug('wallet')

const upholdBaseUrls = {
  prod: 'https://api.uphold.com',
  sandbox: 'https://api-sandbox.uphold.com'
}

BigNumber.config({ EXPONENTIAL_AT: 28, DECIMAL_PLACES: 18 })

const Wallet = function (config, runtime) {
  if (!(this instanceof Wallet)) return new Wallet(config, runtime)

  if (!config.wallet) return

  this.config = config.wallet
  this.runtime = runtime
  if (config.wallet.uphold) {
    if ((process.env.FIXIE_URL) && (!process.env.HTTPS_PROXY)) process.env.HTTPS_PROXY = process.env.FIXIE_URL
    this.uphold = this.createUpholdSDK(this.config.uphold.accessToken)
  }

  if (config.currency) {
    this.currency = new Currency(config, runtime)
  }
}

Wallet.prototype.createCard = async function () {
  let f = Wallet.providers.mock.createCard
  if (this.config.uphold) {
    f = Wallet.providers.uphold.createCard
  }
  if (!f) return {}
  return f.apply(this, arguments)
}

Wallet.prototype.create = async function (requestType, request) {
  let f = Wallet.providers.mock.create
  if (this.config.uphold) {
    f = Wallet.providers.uphold.create
  }
  if (!f) return {}
  return f.bind(this)(requestType, request)
}

Wallet.prototype.balances = async function (info) {
  const f = Wallet.providers[info.provider].balances

  if (!f) throw new Error('provider ' + info.provider + ' balances not supported')
  return f.bind(this)(info)
}

Wallet.prototype.transfer = async function (info, satoshis) {
  const f = Wallet.providers[info.provider].transfer

  if (!f) throw new Error('provider ' + info.provider + ' transfer not supported')
  return f.bind(this)(info, satoshis)
}

Wallet.prototype.getTxProbi = function (info, txn) {
  if (info.altcurrency === 'BAT' && (info.provider === 'uphold' || info.provider === 'mockHttpSignature')) {
    return new BigNumber(txn.denomination.amount).times(this.currency.alt2scale(info.altcurrency))
  } else {
    throw new Error('getTxProbi not supported for ' + info.altcurrency + ' at ' + info.provider)
  }
}

Wallet.prototype.validateTxSignature = function (info, txn, signature) {
  if (info.altcurrency === 'BAT' && (info.provider === 'uphold' || info.provider === 'mockHttpSignature')) {
    if (!signature.headers.digest) throw new Error('a valid http signature must include the content digest')
    if (!underscore.isEqual(txn, JSON.parse(signature.octets))) throw new Error('the signed and unsigned transactions differed')
    const expectedDigest = 'SHA-256=' + crypto.createHash('sha256').update(signature.octets, 'utf8').digest('base64')
    if (expectedDigest !== signature.headers.digest) throw new Error('the digest specified is not valid for the unsigned transaction provided')

    const result = verify({headers: signature.headers, publicKey: info.httpSigningPubKey}, { algorithm: 'ed25519' })
    if (!result.verified) throw new Error('the http-signature is not valid')
  } else {
    throw new Error('wallet validateTxSignature for requestType ' + info.requestType + ' not supported for altcurrency ' + info.altcurrency)
  }
}

Wallet.prototype.unsignedTx = async function (info, amount, currency, balance) {
  const f = Wallet.providers[info.provider].unsignedTx

  if (!f) throw new Error('provider ' + info.provider + ' unsignedTx not supported')
  return f.bind(this)(info, amount, currency, balance)
}

Wallet.prototype.submitTx = async function (info, txn, signature) {
  const f = Wallet.providers[info.provider].submitTx

  if (!f) throw new Error('provider ' + info.provider + ' submitTx not supported')
  return f.bind(this)(info, txn, signature)
}

Wallet.prototype.ping = async function (provider) {
  const f = Wallet.providers[provider].ping

  if (!f) throw new Error('provider ' + provider + ' ping not supported')
  return f.bind(this)(provider)
}

Wallet.prototype.status = async function (info) {
  const f = Wallet.providers[info.provider].status

  if (!f) throw new Error('provider ' + info.provider + ' status not supported')
  return f.bind(this)(info)
}

Wallet.prototype.providers = function () {
  return underscore.keys(Wallet.providers)
}

Wallet.prototype.isGrantExpired = function (info, grant) {
  const { token } = grant

  const jws = braveUtils.extractJws(token)
  const { expiryTime } = jws

  return Date.now() > (expiryTime * 1000)
}

Wallet.prototype.expireGrant = async function (info, wallet, grant) {
  const { runtime } = this
  const { database } = runtime
  const { paymentId } = wallet
  const { grantId } = grant

  const wallets = database.get('wallets', debug)

  const $set = {
    'grants.$.status': 'expired'
  }
  const state = { $set }
  const where = {
    paymentId,
    'grants.grantId': grantId
  }
  await wallets.update(where, state)
}

Wallet.prototype.redeem = async function (info, txn, signature, request) {
  let balance, desired, grants, grantIds, payload, result

  if (!this.runtime.config.redeemer) return

  if (!info.grants) return

  // we could try to optimize the determination of which grant to use, but there's probably going to be only one...
  grants = info.grants.filter((grant) => grant.status === 'active')
  if (grants.length === 0) return

  if (!info.balances) info.balances = await this.balances(info)
  balance = new BigNumber(info.balances.confirmed)
  desired = new BigNumber(txn.denomination.amount).times(this.currency.alt2scale(info.altcurrency))

  const infoKeys = [
    'altcurrency', 'provider', 'providerId', 'paymentId'
  ]
  const wallet = underscore.extend(underscore.pick(info, infoKeys), { publicKey: info.httpSigningPubKey })
  payload = {
    grants: [],
    // TODO might need paymentId later
    wallet,
    transaction: Buffer.from(JSON.stringify(underscore.pick(signature, [ 'headers', 'octets' ]))).toString('base64')
  }
  grantIds = []
  let grantTotal = new BigNumber(0)
  for (let grant of grants) {
    if (this.isGrantExpired(info, grant)) {
      await this.expireGrant(info, wallet, grant)
      continue
    }
    payload.grants.push(grant.token)
    grantIds.push(grant.grantId)

    const grantContent = braveUtils.extractJws(grant.token)
    const probi = new BigNumber(grantContent.probi)
    balance = balance.plus(probi)
    grantTotal = grantTotal.plus(probi)
    if (grantTotal.greaterThanOrEqualTo(desired)) break
  }

  if (balance.lessThan(desired)) return

  if (info.cohort && this.runtime.config.testingCohorts.includes(info.cohort)) {
    return {
      probi: desired.toString(),
      altcurrency: info.altcurrency,
      address: txn.destination,
      fee: 0,
      status: 'accepted',
      grantIds: grantIds
    }
  }

  result = await braveHapi.wreck.post(this.runtime.config.redeemer.url + '/v1/grants', {
    headers: {
      'Authorization': 'Bearer ' + this.runtime.config.redeemer.access_token,
      'Content-Type': 'application/json',
      // Only pass "trusted" IP, not previous value of X-Forwarded-For
      'X-Forwarded-For': whitelist.ipaddr(request),
      'User-Agent': request.headers['user-agent']
    },
    payload: JSON.stringify(payload),
    useProxyP: true
  })
  if (Buffer.isBuffer(result)) try { result = JSON.parse(result) } catch (ex) { result = result.toString() }

  return underscore.extend(result, { grantIds: grantIds })
}

Wallet.prototype.purchaseBAT = async function (info, amount, currency, language) {
  // TBD: if there is more than one provider, use a "real" algorithm to determine which one
  for (let provider in Wallet.providers) {
    const f = Wallet.providers[provider].purchaseBAT
    let result

    if (!f) continue

    try {
      result = await f.bind(this)(info, amount, currency, language)
      if (result) return result
    } catch (ex) {
      debug('error in ' + provider + '.purchaseBAT: ' + ex.toString())
      console.log(ex.stack)
    }
  }

  return {}
}

Wallet.prototype.createUpholdSDK = function (token) {
  const options = {
    baseUrl: upholdBaseUrls[this.config.uphold.environment],
    clientId: this.config.uphold.clientId,
    clientSecret: this.config.uphold.clientSecret
  }
  const uphold = new UpholdSDK.default(options) // eslint-disable-line new-cap
  uphold.storage.setItem(uphold.options.accessTokenKey, token)
  return uphold
}

Wallet.providers = {}

Wallet.providers.uphold = {
  createCard: async function (info, {
    currency,
    label,
    options
  }) {
    const accessToken = info.parameters.access_token
    const uphold = this.createUpholdSDK(accessToken)
    return uphold.createCard(currency, label, Object.assign({
      authenticate: true
    }, options))
  },
  create: async function (requestType, request) {
    if (requestType === 'httpSignature') {
      const altcurrency = request.body.currency
      if (altcurrency === 'BAT') {
        let btcAddr, ethAddr, ltcAddr, wallet

        try {
          wallet = await this.uphold.api('/me/cards', { body: request.octets, method: 'post', headers: request.headers })
          ethAddr = await this.uphold.createCardAddress(wallet.id, 'ethereum')
          btcAddr = await this.uphold.createCardAddress(wallet.id, 'bitcoin')
          ltcAddr = await this.uphold.createCardAddress(wallet.id, 'litecoin')
        } catch (ex) {
          debug('create', {
            provider: 'uphold',
            reason: ex.toString(),
            operation: btcAddr ? 'litecoin' : ethAddr ? 'bitcoin' : wallet ? 'ethereum' : '/me/cards'
          })
          throw ex
        }
        return { 'wallet': { 'addresses': {
          'BAT': ethAddr.id,
          'BTC': btcAddr.id,
          'CARD_ID': wallet.id,
          'ETH': ethAddr.id,
          'LTC': ltcAddr.id
        },
          'provider': 'uphold',
          'providerId': wallet.id,
          'httpSigningPubKey': request.body.publicKey,
          'altcurrency': 'BAT' } }
      } else {
        throw new Error('wallet uphold create requestType ' + requestType + ' not supported for altcurrency ' + altcurrency)
      }
    } else {
      throw new Error('wallet uphold create requestType ' + requestType + ' not supported')
    }
  },
  balances: async function (info) {
    let cardInfo

    try {
      cardInfo = await this.uphold.getCard(info.providerId)
    } catch (ex) {
      debug('balances', { provider: 'uphold', reason: ex.toString(), operation: 'getCard' })
      throw ex
    }

    const balanceProbi = new BigNumber(cardInfo.balance).times(this.currency.alt2scale(info.altcurrency))
    const spendableProbi = new BigNumber(cardInfo.available).times(this.currency.alt2scale(info.altcurrency))
    return {
      balance: balanceProbi.toString(),
      spendable: spendableProbi.toString(),
      confirmed: spendableProbi.toString(),
      unconfirmed: balanceProbi.minus(spendableProbi).toString()
    }
  },
  unsignedTx: async function (info, amount, currency, balance) {
    if (info.altcurrency === 'BAT') {
      // TODO This logic should be abstracted out into the PUT wallet payment endpoint
      // such that this takes desired directly
      let desired = new BigNumber(amount.toString()).times(this.currency.alt2scale(info.altcurrency))

      currency = currency.toUpperCase()
      if (currency !== info.altcurrency) {
        const rate = this.currency.rates.BAT[currency]
        if (!rate) throw new Error('no conversion rate for ' + currency + ' to BAT')

        desired = desired.dividedBy(new BigNumber(rate.toString()))
      }
      const minimum = desired.times(0.90)

      debug('unsignedTx', { balance: balance, desired: desired, minimum: minimum })

      if (minimum.greaterThan(balance)) return

      desired = desired.floor()

      if (desired.greaterThan(balance)) desired = new BigNumber(balance)

      // NOTE skipping fee calculation here as transfers within uphold have none

      desired = desired.dividedBy(this.currency.alt2scale(info.altcurrency)).toString()

      return { 'requestType': 'httpSignature',
        'unsignedTx': { 'denomination': { 'amount': desired, currency: 'BAT' },
          'destination': this.config.settlementAddress['BAT']
        }
      }
    } else {
      throw new Error('wallet uphold unsignedTx for ' + info.altcurrency + ' not supported')
    }
  },
  submitTx: async function (info, txn, signature) {
    if (info.altcurrency === 'BAT') {
      let postedTx

      try {
        postedTx = await this.uphold.createCardTransaction(info.providerId,
                                                           // this will be replaced below, we're just placating
                                                           underscore.pick(underscore.extend(txn.denomination,
                                                                                             { destination: txn.destination }),
                                                                           ['amount', 'currency', 'destination']),
                                                           true,        // commit tx in one swoop
                                                           null,        // no otp code
                                                           { headers: signature.headers, body: signature.octets })
      } catch (ex) {
        debug('submitTx', { provider: 'uphold', reason: ex.toString(), operation: 'createCardTransaction' })
        throw ex
      }

      if (postedTx.fees.length !== 0) { // fees should be 0 with an uphold held settlement address
        throw new Error(`unexpected fee(s) charged: ${JSON.stringify(postedTx.fees)}`)
      }

      return {
        probi: new BigNumber(postedTx.destination.amount).times(this.currency.alt2scale(info.altcurrency)).toString(),
        altcurrency: info.altcurrency,
        address: txn.destination,
        fee: 0,
        status: postedTx.status
      }
    } else {
      throw new Error('wallet uphold submitTx for ' + info.altcurrency + ' not supported')
    }
  },
  ping: async function (provider) {
    try {
      return { result: await this.uphold.api('/ticker/BATUSD') }
    } catch (ex) {
      return { err: ex.toString() }
    }
  },
  status: async function (info) {
    let card, cards, currency, currencies, result, uphold, user

    try {
      uphold = this.createUpholdSDK(info.parameters.access_token)
      debug('uphold api', uphold.api)
      user = await uphold.api('/me')
      if (user.status !== 'pending') cards = await uphold.api('/me/cards')
    } catch (ex) {
      debug('status', { provider: 'uphold', reason: ex.toString(), operation: '/me' })
      throw ex
    }

    currency = user.settings.currency
    if (currency) {
      currencies = underscore.keys(user.balances.currencies) || []
      currencies.sort((a, b) => {
        return ((b === currency) ? 1
                : ((a === currency) || (a < b)) ? (-1)
                : (a > b) ? 1 : 0)
      })
      if (currencies.indexOf(currency) === -1) currencies.unshift(currency)
    } else currency = undefined

    result = {
      provider: info.provider,
      authorized: [ 'restricted', 'ok' ].indexOf(user.status) !== -1,
      defaultCurrency: info.defaultCurrency || currency,
      availableCurrencies: currencies,
      possibleCurrencies: user.currencies
    }
    if (result.authorized) {
      card = underscore.findWhere(cards, { currency: result.defaultCurrency })
      result.address = card && card.id
    }

    return result
  }
}

Wallet.providers.mock = {
  create: async function (requestType, request) {
    if (requestType === 'httpSignature') {
      const altcurrency = request.body.currency
      if (altcurrency === 'BAT') {
        // TODO generate random addresses?
        return { 'wallet': { 'addresses': {
          'BAT': this.config.settlementAddress['BAT']
        },
          'provider': 'mockHttpSignature',
          'httpSigningPubKey': request.body.publicKey,
          'altcurrency': 'BAT' } }
      } else {
        throw new Error('wallet mock create requestType ' + requestType + ' not supported for altcurrency ' + altcurrency)
      }
    } else {
      throw new Error('wallet mock create requestType ' + requestType + ' not supported')
    }
  },
  balances: async function (info) {
    if (info.altcurrency === 'BAT') {
      return {
        balance: '32061750000000000000',
        spendable: '32061750000000000000',
        confirmed: '32061750000000000000',
        unconfirmed: '0'
      }
    } else {
      throw new Error('wallet mock balances for ' + info.altcurrency + ' not supported')
    }
  },
  unsignedTx: async function (info, amount, currency, balance) {
    if (info.altcurrency === 'BAT' && info.provider === 'mockHttpSignature') {
      return { 'requestType': 'httpSignature',
        'unsignedTx': { 'denomination': { 'amount': '24.1235', currency: 'BAT' },
          'destination': this.config.settlementAddress['BAT']
        }
      }
    } else {
      throw new Error('wallet mock unsignedTx for ' + info.altcurrency + ' not supported')
    }
  },
  submitTx: async function (info, txn, signature) {
    if (info.altcurrency === 'BAT') {
      return {
        probi: new BigNumber(txn.denomination.amount).times(this.currency.alt2scale(info.altcurrency)).toString(),
        altcurrency: txn.denomination.currency,
        address: txn.destination,
        fee: '300',
        status: 'accepted'
      }
    }
  }
}
Wallet.providers.mockHttpSignature = Wallet.providers.mock

module.exports = Wallet
