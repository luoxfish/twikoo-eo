import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

process.env.TWIKOO_LOG_LEVEL = 'error'
const { onRequest } = await import('../cloud-functions/index.js')
const { onRequest: onKVRequest } = await import('../edge-functions/api/kv.js')
const { signKVRequest } = await import('../lib/kv-auth.js')
const { searchSync } = await import('../node-functions/ip2region-searcher.js')
const { getIp2RegionBuffer } = await import('../node-functions/ip2region-data.js')

const token = 'test-internal-token'
const md5 = value => createHash('md5').update(value).digest('hex')
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const sample = (id, created, values = {}) => ({
  _id: id, nick: 'Visitor', mail: 'visitor@example.test', ua,
  comment: '<p>Hello</p>', url: '/post', created, updated: created, ...values
})

function storage (initial = {}, strict = true) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    async get (key) {
      if (strict && !/^[a-zA-Z0-9_]{1,512}$/.test(key)) throw new Error('Invalid key')
      return values.get(key) ?? null
    },
    async put (key, value) {
      assert.match(key, /^[a-zA-Z0-9_]{1,512}$/)
      values.set(key, value)
    }
  }
}

function backend (t, { config = {}, comments = [], kv = storage(), beforeFetch } = {}) {
  if (!kv.values.has('config_main') && !kv.values.has('config:main')) kv.values.set('config_main', JSON.stringify(config))
  if (!kv.values.has('comments_all') && !kv.values.has('comments:all')) kv.values.set('comments_all', JSON.stringify(comments))
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/kv')
    assert.equal(new URL(url).hostname, 'backend.test')
    if (beforeFetch) await beforeFetch(JSON.parse(options.body).action)
    return onKVRequest({
      request: new Request(url, options),
      env: { TWIKOO_KV: kv, TWIKOO_INTERNAL_TOKEN: token }
    })
  })
  async function call (body, { method = 'POST', headers = {}, env = {}, raw } = {}) {
    const response = await onRequest({
      request: new Request('https://backend.test/', {
        method, headers: { 'Content-Type': 'application/json', ...headers },
        ...(method === 'POST' ? { body: raw ?? JSON.stringify(body) } : {})
      }),
      env: { TWIKOO_INTERNAL_TOKEN: token, ...env }, clientIp: '192.0.2.1'
    })
    const text = await response.text()
    return { response, data: text ? JSON.parse(text) : null }
  }
  return { call, kv }
}

test('current cloud entry and legacy Node entry both start in native ESM', async () => {
  const legacy = await import('../node-functions/index.js')
  assert.equal(typeof legacy.default, 'function')
  const response = await legacy.default({ request: new Request('https://backend.test/') })
  assert.equal(response.status, 200)
  assert.equal(typeof (await response.json()).version, 'string')
})

test('version is a string and anonymous requests receive an access token', async t => {
  const { call } = backend(t)
  const { data } = await call({ event: 'GET_FUNC_VERSION' })
  assert.equal(data.code, 0)
  assert.equal(data.version, '1.7.1')
  assert.match(data.accessToken, /^[a-f0-9]{32}$/)
})

test('set password, login, save config, export and delete are authenticated', async t => {
  const { call } = backend(t, { comments: [sample('first', 1)] })
  assert.equal((await call({ event: 'SET_PASSWORD', password: 'client-password-hash' })).data.code, 0)
  const { data: login } = await call({ event: 'LOGIN', password: 'client-password-hash', accessToken: 'anonymous' })
  assert.equal(login.accessToken, 'client-password-hash')
  assert.equal((await call({ event: 'LOGIN', password: 'wrong' })).data.code, 1023)
  assert.equal((await call({ event: 'COMMENT_EXPORT_FOR_ADMIN', accessToken: 'anonymous' })).data.code, 1024)
  const accessToken = login.accessToken
  assert.equal((await call({ event: 'SET_CONFIG', accessToken, config: { SITE_NAME: 'Blog' } })).data.code, 0)
  assert.equal((await call({ event: 'GET_CONFIG_FOR_ADMIN', accessToken })).data.config.SITE_NAME, 'Blog')
  assert.equal((await call({ event: 'COMMENT_EXPORT_FOR_ADMIN', accessToken })).data.data.length, 1)
  assert.equal((await call({ event: 'COMMENT_DELETE_FOR_ADMIN', accessToken, id: 'first' })).data.deleted, 1)
  assert.equal((await call({ event: 'SET_PASSWORD', password: 'attacker' })).data.code, 1010)
})

test('comments, replies, counts, moderation visibility and recent comments work', async t => {
  const { call } = backend(t, { config: { ADMIN_PASS: md5('admin') } })
  const { data: root } = await call({ event: 'COMMENT_SUBMIT', url: '/post', ua, comment: '<script>alert(1)</script><p>Hello</p>', accessToken: 'owner' })
  assert.ok(root.id)
  const { data: reply } = await call({ event: 'COMMENT_SUBMIT', url: '/post', ua, comment: 'Reply', rid: root.id, accessToken: 'other' })
  assert.ok(reply.id)
  let result = await call({ event: 'COMMENT_GET', url: '/post/', accessToken: 'owner' })
  assert.equal(result.data.data.length, 1)
  assert.equal(result.data.data[0].replies[0].id, reply.id)
  assert.equal(result.data.data[0].isOwner, true)
  assert.doesNotMatch(result.data.data[0].comment, /<script>/)
  assert.equal(result.data.data[0].mail, undefined)
  assert.equal(result.data.data[0].uid, undefined)
  assert.equal((await call({ event: 'GET_COMMENTS_COUNT', urls: ['/post'], includeReply: true })).data.data[0].count, 2)
  assert.equal((await call({ event: 'GET_RECENT_COMMENTS' })).data.data.length, 1)
  await call({ event: 'COMMENT_SET_FOR_ADMIN', accessToken: 'admin', id: root.id, set: { isSpam: true } })
  assert.equal((await call({ event: 'COMMENT_GET', url: '/post', accessToken: 'stranger' })).data.data.length, 0)
  assert.equal((await call({ event: 'COMMENT_GET', url: '/post', accessToken: 'owner' })).data.data.length, 1)
})

test('upvotes, downvotes, toggles and legacy likes round trip to the frontend', async t => {
  const { call } = backend(t, { comments: [sample('first', 1, { like: ['legacy'] })] })
  await call({ event: 'COMMENT_LIKE', id: 'first', accessToken: 'visitor' })
  let comment = (await call({ event: 'COMMENT_GET', url: '/post', accessToken: 'visitor' })).data.data[0]
  assert.equal(comment.like, 2)
  assert.equal(comment.ups, 2)
  assert.equal(comment.liked, true)
  await call({ event: 'COMMENT_LIKE', id: 'first', type: 'down', accessToken: 'visitor' })
  comment = (await call({ event: 'COMMENT_GET', url: '/post', accessToken: 'visitor' })).data.data[0]
  assert.equal(comment.ups, 1)
  assert.equal(comment.downs, 1)
  assert.equal(comment.disliked, true)
  await call({ event: 'COMMENT_LIKE', id: 'first', type: 'down', accessToken: 'visitor' })
  comment = (await call({ event: 'COMMENT_GET', url: '/post', accessToken: 'visitor' })).data.data[0]
  assert.equal(comment.downs, 0)
})

test('oldest pagination advances and pinned comments do not reappear', async t => {
  const { call } = backend(t, {
    config: { COMMENT_PAGE_SIZE: '1' },
    comments: [sample('pinned', 1500, { top: true }), sample('first', 1000), sample('second', 2000)]
  })
  const first = (await call({ event: 'COMMENT_GET', url: '/post', sort: 'oldest' })).data
  assert.deepEqual(first.data.map(c => c.id), ['pinned', 'first'])
  assert.equal(first.more, true)
  const second = (await call({ event: 'COMMENT_GET', url: '/post', sort: 'oldest', before: 1000 })).data
  assert.deepEqual(second.data.map(c => c.id), ['second'])
})

test('per-minute throttle allows older comments and rejects at the configured limit', async t => {
  const { call } = backend(t, {
    config: { LIMIT_PER_MINUTE: '1', LIMIT_PER_MINUTE_ALL: '0' },
    comments: [sample('old', Date.now() - 120000, { ip: '192.0.2.1' })]
  })
  const event = { event: 'COMMENT_SUBMIT', url: '/post', ua, comment: 'Hello' }
  assert.ok((await call(event)).data.id)
  assert.match((await call(event)).data.message, /发言频率过高/)
})

test('CORS respects domain lists and preflight, including stored configuration', async t => {
  const { call } = backend(t, { config: { CORS_ALLOW_ORIGIN: 'blog.test, https://other.test/' } })
  const allowed = await call({}, { method: 'OPTIONS', headers: { Origin: 'https://blog.test' } })
  assert.equal(allowed.response.status, 204)
  assert.equal(allowed.response.headers.get('Access-Control-Allow-Origin'), 'https://blog.test')
  const denied = await call({ event: 'GET_CONFIG' }, { headers: { Origin: 'https://attacker.test' } })
  assert.equal(denied.response.status, 403)
  assert.equal(denied.response.headers.get('Access-Control-Allow-Origin'), null)
  assert.equal((await call({}, { method: 'OPTIONS', headers: { Origin: 'null' } })).response.status, 403)
  const override = await call({}, { method: 'OPTIONS', headers: { Origin: 'https://env.test' }, env: { CORS_ALLOW_ORIGIN: 'env.test' } })
  assert.equal(override.response.status, 204)
})

test('malformed JSON, null bodies and invalid fields are rejected', async t => {
  const { call } = backend(t)
  for (const raw of ['{', 'null', '[]', '1']) assert.equal((await call({}, { raw })).response.status, 400)
  assert.equal((await call({ event: 'LOGIN', password: {} })).data.code, 1000)
  assert.equal((await call({ event: 'COMMENT_GET', url: { $ne: null } })).data.code, 1000)
  assert.equal((await call({ event: 'SET_PASSWORD' })).data.code, 1000)
})

test('a KV configuration read failure cannot reset the administrator password', async t => {
  const kv = storage()
  const { call } = backend(t, { kv, config: { ADMIN_PASS: md5('existing') } })
  t.mock.method(kv, 'get', async () => { throw new Error('storage unavailable') })
  const { response } = await call({ event: 'SET_PASSWORD', password: 'attacker' })
  assert.equal(response.status, 503)
  assert.equal(JSON.parse(kv.values.get('config_main')).ADMIN_PASS, md5('existing'))
})

test('overlapping requests keep their own configuration during submission', async t => {
  let release
  const paused = new Promise(resolve => { release = resolve })
  let firstComments = true
  let notifyPaused
  const isPaused = new Promise(resolve => { notifyPaused = resolve })
  const { call, kv } = backend(t, {
    config: { BLOGGER_EMAIL: 'first@example.test' },
    beforeFetch: async action => {
      if (action === 'getComments' && firstComments) {
        firstComments = false
        notifyPaused()
        await paused
      }
    }
  })
  const first = call({ event: 'COMMENT_SUBMIT', url: '/post', ua, comment: 'Hello', mail: 'second@example.test' })
  await isPaused
  kv.values.set('config_main', JSON.stringify({ BLOGGER_EMAIL: 'second@example.test' }))
  await call({ event: 'GET_CONFIG' })
  release()
  assert.ok((await first).data.id)
})

test('KV endpoint rejects the old public header and protects config reads', async () => {
  const kv = storage({ config_main: JSON.stringify({ ADMIN_PASS: 'private' }) })
  for (const supplied of ['', 'true', 'wrong']) {
    const response = await onKVRequest({
      request: new Request('https://backend.test/api/kv', { method: 'POST', headers: { 'X-Twikoo-Internal': supplied }, body: JSON.stringify({ action: 'getConfig', data: {} }) }),
      env: { TWIKOO_KV: kv, TWIKOO_INTERNAL_TOKEN: token }
    })
    assert.equal(response.status, 403)
    assert.doesNotMatch(await response.text(), /private/)
  }
})

test('generated private token works in both runtimes without extra environment setup', async t => {
  const kv = storage({ config_main: '{}' })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers['X-Twikoo-Internal'], undefined)
    assert.match(options.headers['X-Twikoo-Signature'], /^[a-f0-9]{64}$/)
    return onKVRequest({ request: new Request(url, options), env: { TWIKOO_KV: kv } })
  })
  const response = await onRequest({ request: new Request('https://backend.test/', { method: 'POST', body: JSON.stringify({ event: 'GET_CONFIG' }) }) })
  assert.equal((await response.json()).code, 0)
})

test('KV signatures reject changed bodies, different hosts and expired requests', async () => {
  const url = 'https://backend.test/api/kv'
  const body = JSON.stringify({ action: 'getConfig', data: {} })
  const headers = await signKVRequest(token, url, body)
  const kv = storage({ config_main: '{}' })
  const check = (requestUrl, requestBody, requestHeaders) => onKVRequest({
    request: new Request(requestUrl, { method: 'POST', body: requestBody, headers: requestHeaders }),
    env: { TWIKOO_KV: kv, TWIKOO_INTERNAL_TOKEN: token }
  })
  assert.equal((await check(url, body, headers)).status, 200)
  assert.equal((await check(url, body + ' ', headers)).status, 403)
  assert.equal((await check('https://other.test/api/kv', body, headers)).status, 403)
  const expired = await signKVRequest(token, url, body, String(Date.now() - 120000))
  assert.equal((await check(url, body, expired)).status, 403)
})

test('platform public host is used when the Node runtime receives an internal URL', async t => {
  backend(t)
  const response = await onRequest({
    request: new Request('https://internal.node/', {
      method: 'POST', headers: { 'eo-pages-host': 'backend.test', 'x-forwarded-host': 'untrusted.test' },
      body: JSON.stringify({ event: 'GET_CONFIG' })
    }), env: { TWIKOO_INTERNAL_TOKEN: token }
  })
  assert.equal((await response.json()).code, 0)
})

test('legacy config, comments and counters survive safe-key migration', async t => {
  const kv = storage({
    'config:main': JSON.stringify({ ADMIN_PASS: md5('admin'), SITE_NAME: 'Existing blog' }),
    'comments:all': JSON.stringify([sample('existing', 1)]),
    'counter:%2Fpost': JSON.stringify({ url: '/post', time: 7 })
  }, false)
  const { call } = backend(t, { kv })
  assert.equal((await call({ event: 'GET_CONFIG' })).data.config.SITE_NAME, 'Existing blog')
  assert.equal((await call({ event: 'COMMENT_GET', url: '/post' })).data.data[0].id, 'existing')
  assert.equal((await call({ event: 'COUNTER_GET', url: '/post' })).data.time, 7)
  assert.equal((await call({ event: 'COUNTER_GET', url: '/post' })).data.time, 8)
  await call({ event: 'SET_CONFIG', accessToken: 'admin', config: { SITE_NAME: 'Updated' } })
  assert.equal(JSON.parse(kv.values.get('config_main')).ADMIN_PASS, md5('admin'))
  await call({ event: 'COMMENT_LIKE', id: 'existing', accessToken: 'visitor' })
  assert.equal(JSON.parse(kv.values.get('comments_all'))[0]._id, 'existing')
})

test('counter keys accept long URLs with unicode and punctuation', async t => {
  const { call, kv } = backend(t)
  const url = '/中文/' + 'a'.repeat(700) + '?x=1&y=2'
  await call({ event: 'COUNTER_GET', url })
  assert.equal((await call({ event: 'COUNTER_GET', url })).data.time, 1)
  assert.ok([...kv.values.keys()].some(key => /^counter_[a-f0-9]{64}$/.test(key)))
})

test('Twikoo imports sanitize HTML instead of using a no-op DOMPurify', async t => {
  const { call } = backend(t, { config: { ADMIN_PASS: md5('admin') } })
  const result = await call({
    event: 'COMMENT_IMPORT_FOR_ADMIN', accessToken: 'admin', source: 'twikoo',
    file: JSON.stringify([sample('imported', 1, { comment: '<img src=x onerror=alert(1)><script>alert(1)</script>' })])
  })
  assert.match(result.data.log, /导入成功/)
  const comments = (await call({ event: 'COMMENT_GET', url: '/post' })).data.data
  assert.equal(comments.length, 1)
  assert.doesNotMatch(comments[0].comment, /onerror|<script>/)
})

test('IP database search includes the first and last index blocks', () => {
  const buffer = getIp2RegionBuffer()
  for (const pointer of [buffer.readUInt32LE(0), buffer.readUInt32LE(4)]) {
    const value = buffer.readUInt32LE(pointer)
    const ip = [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
    assert.ok(searchSync(ip), ip)
  }
})
