import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { handleRequest, testing } from '../src/index.ts'
import type { Env } from '../src/index.ts'

interface ControlRequestOptions {
  headers?: Record<string, string>
}

interface MediaPayload {
  v: number
  iat: number
  exp: number
  url: string
}

const origin = 'https://player.example'
const workerOrigin = 'https://proxy.example'
const sourceUrl = 'https://media.files.1drv.com/music/song.mp3?download=secret'
const accessKey = 'proxy access key with arbitrary encoding'
const defaultNow = 1_720_000_000_000
const env: Env = {
  ALLOWED_ORIGINS: origin,
  ALLOWED_UPSTREAM_SUFFIXES: '.1drv.com,.sharepoint.com',
  PROXY_ACCESS_KEY: accessKey,
}

const controlRequest = (path: string, options: ControlRequestOptions = {}) => new Request(`${workerOrigin}${path}`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessKey}`,
    Origin: origin,
    ...options.headers,
  },
})

const signPayloadSegment = (
  payloadSegment: string,
  signingOrigin = workerOrigin,
  key = accessKey,
) => createHmac('sha256', key)
  .update(`${testing.MEDIA_SIGNATURE_DOMAIN}\n${signingOrigin}\n${payloadSegment}`)
  .digest('base64url')

const signedMediaUrl = (
  payloadOverrides: Partial<MediaPayload> = {},
  requestOrigin = workerOrigin,
) => {
  const payload: MediaPayload = {
    v: testing.MEDIA_URL_VERSION,
    iat: defaultNow,
    exp: defaultNow + testing.MEDIA_URL_TTL_MS,
    url: sourceUrl,
    ...payloadOverrides,
  }
  const payloadSegment = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = signPayloadSegment(payloadSegment, requestOrigin)
  const url = new URL('/v1/media', requestOrigin)
  url.searchParams.set('payload', payloadSegment)
  url.searchParams.set('signature', signature)
  return url.toString()
}

test('health reports HMAC capabilities without exposing configuration', async () => {
  const response = await handleRequest(new Request(`${workerOrigin}/v1/health`), env)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.mediaAuth, testing.MEDIA_AUTH_SCHEME)
  assert.equal(body.mediaUrlVersion, testing.MEDIA_URL_VERSION)
  assert.equal(body.mediaUrlTtlSeconds, testing.MEDIA_URL_TTL_MS / 1000)
  assert.deepEqual(body.supports, ['GET', 'HEAD', 'Range'])
  assert.equal(JSON.stringify(body).includes(accessKey), false)
})

test('auth check requires an allowed origin, key, and reports protocol compatibility', async () => {
  const valid = await handleRequest(controlRequest('/v1/auth-check'), env)
  const body = await valid.json()
  assert.equal(valid.status, 200)
  assert.equal(valid.headers.get('Access-Control-Allow-Origin'), origin)
  assert.deepEqual(body, {
    ok: true,
    mediaAuth: testing.MEDIA_AUTH_SCHEME,
    mediaUrlVersion: testing.MEDIA_URL_VERSION,
  })

  const invalidKey = await handleRequest(controlRequest('/v1/auth-check', {
    headers: { Authorization: 'Bearer wrong' },
  }), env)
  assert.equal(invalidKey.status, 401)

  const invalidOrigin = await handleRequest(controlRequest('/v1/auth-check', {
    headers: { Origin: 'https://attacker.example' },
  }), env)
  assert.equal(invalidOrigin.status, 403)
})

test('media endpoint verifies signatures and binds them to the Worker origin', async () => {
  const valid = await handleRequest(new Request(signedMediaUrl()), env, {
    now: () => defaultNow,
    fetch: async () => new Response('media'),
  })
  assert.equal(valid.status, 200)

  const tamperedUrl = signedMediaUrl().slice(0, -1) + 'x'
  const tampered = await handleRequest(new Request(tamperedUrl), env, { now: () => defaultNow })
  assert.equal(tampered.status, 401)

  const original = new URL(signedMediaUrl())
  const payload = original.searchParams.get('payload') ?? ''
  const changedPayload = `${payload[0] === 'e' ? 'f' : 'e'}${payload.slice(1)}`
  const payloadTamperedUrl = new URL(original)
  payloadTamperedUrl.searchParams.set('payload', changedPayload)
  const payloadTampered = await handleRequest(new Request(
    payloadTamperedUrl,
  ), env, { now: () => defaultNow })
  assert.equal(payloadTampered.status, 401)

  const invalidBase64Url = new URL(original)
  invalidBase64Url.searchParams.set('signature', 'invalid!signature')
  const invalidBase64 = await handleRequest(new Request(
    invalidBase64Url,
  ), env, { now: () => defaultNow })
  assert.equal(invalidBase64.status, 401)

  const replayedAtAnotherOrigin = new URL(original)
  replayedAtAnotherOrigin.host = 'other-proxy.example'
  const replayed = await handleRequest(new Request(replayedAtAnotherOrigin), env, {
    now: () => defaultNow,
  })
  assert.equal(replayed.status, 401)
})

test('media endpoint requires one payload and one signature query parameter', async () => {
  for (const path of [
    '/v1/media',
    '/v1/media?payload=value',
    '/v1/media?signature=value',
    '/v1/media?payload=one&payload=two&signature=value',
    '/v1/media?payload=value&signature=one&signature=two',
    '/v1/media?payload=value&signature=value&extra=value',
  ]) {
    const response = await handleRequest(new Request(`${workerOrigin}${path}`), env, {
      now: () => defaultNow,
    })
    assert.equal(response.status, 401, path)
  }

  const legacyPath = await handleRequest(new Request(`${workerOrigin}/v1/media/value`), env)
  assert.equal(legacyPath.status, 404)
})

test('media endpoint rejects invalid, expired, and future payloads', async () => {
  const expired = await handleRequest(new Request(signedMediaUrl()), env, {
    now: () => defaultNow + testing.MEDIA_URL_TTL_MS,
  })
  assert.equal(expired.status, 410)

  const futureIat = defaultNow + testing.MAX_CLOCK_SKEW_MS + 1
  const future = await handleRequest(new Request(signedMediaUrl({
    iat: futureIat,
    exp: futureIat + testing.MEDIA_URL_TTL_MS,
  })), env, { now: () => defaultNow })
  assert.equal(future.status, 401)

  const wrongVersion = await handleRequest(new Request(signedMediaUrl({ v: 2 })), env, {
    now: () => defaultNow,
  })
  assert.equal(wrongVersion.status, 401)

  const wrongTtl = await handleRequest(new Request(signedMediaUrl({
    exp: defaultNow + testing.MEDIA_URL_TTL_MS + 1,
  })), env, { now: () => defaultNow })
  assert.equal(wrongTtl.status, 401)

  const invalidPayloadSegment = Buffer.from('{invalid json').toString('base64url')
  const invalidJsonUrl = new URL('/v1/media', workerOrigin)
  invalidJsonUrl.searchParams.set('payload', invalidPayloadSegment)
  invalidJsonUrl.searchParams.set('signature', signPayloadSegment(invalidPayloadSegment))
  const invalidJson = await handleRequest(new Request(invalidJsonUrl), env, {
    now: () => defaultNow,
  })
  assert.equal(invalidJson.status, 401)
})

test('media endpoint rejects unsafe, unapproved, and overlong upstream URLs', async () => {
  for (const candidate of [
    'http://media.files.1drv.com/song.mp3',
    'https://127.0.0.1/song.mp3',
    'https://10.0.0.1/song.mp3',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/song.mp3',
    'https://localhost/song.mp3',
    'https://media.files.1drv.com:8443/song.mp3',
    'https://example.com/song.mp3',
    'https://user:password@media.files.1drv.com/song.mp3',
    `https://media.files.1drv.com/${'a'.repeat(8_000)}`,
  ]) {
    const response = await handleRequest(new Request(signedMediaUrl({ url: candidate })), env, {
      now: () => defaultNow,
    })
    assert.equal(response.status, 403, candidate.slice(0, 100))
  }

  const oversizedUrl = signedMediaUrl({
    url: `https://media.files.1drv.com/${'a'.repeat(12_000)}`,
  })
  assert.ok(oversizedUrl.length > testing.MAX_SIGNED_MEDIA_URL_LENGTH)
  const oversized = await handleRequest(new Request(oversizedUrl), env, { now: () => defaultNow })
  assert.equal(oversized.status, 401)
})

test('media endpoint forwards only range headers and preserves partial response metadata', async () => {
  let captured: { url: RequestInfo | URL, init?: RequestInit } | undefined
  const fetchMock: typeof fetch = async (url, init) => {
    captured = { url, init }
    return new Response('partial', {
      status: 206,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Range': 'bytes 10-16/100',
        'Content-Type': 'audio/mpeg',
        'ETag': 'track-etag',
        'Set-Cookie': 'do-not-forward=true',
      },
    })
  }
  const response = await handleRequest(new Request(signedMediaUrl(), {
    headers: {
      Authorization: 'Bearer graph-token',
      Cookie: 'private=true',
      Origin: origin,
      Range: 'bytes=10-16',
      'If-Range': 'track-etag',
      Referer: 'https://player.example/private',
      'X-Unrelated': 'value',
    },
  }), env, { fetch: fetchMock, now: () => defaultNow })

  assert.equal(response.status, 206)
  assert.equal(await response.text(), 'partial')
  assert.ok(captured)
  assert.equal(captured.url, sourceUrl)
  assert.equal(captured.init?.method, 'GET')
  const capturedHeaders = new Headers(captured.init?.headers)
  assert.equal(capturedHeaders.get('Range'), 'bytes=10-16')
  assert.equal(capturedHeaders.get('If-Range'), 'track-etag')
  assert.equal(capturedHeaders.has('Authorization'), false)
  assert.equal(capturedHeaders.has('Cookie'), false)
  assert.equal(capturedHeaders.has('Origin'), false)
  assert.equal(capturedHeaders.has('Referer'), false)
  assert.equal(response.headers.get('Content-Range'), 'bytes 10-16/100')
  assert.equal(response.headers.get('Set-Cookie'), null)
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0')
})

test('media endpoint validates every upstream redirect hop', async () => {
  const blocked = await handleRequest(new Request(signedMediaUrl()), env, {
    now: () => defaultNow,
    fetch: async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://attacker.example/collect' },
    }),
  })
  assert.equal(blocked.status, 403)

  const calls: Array<{ url: RequestInfo | URL, init?: RequestInit }> = []
  const allowed = await handleRequest(new Request(signedMediaUrl(), {
    headers: { Range: 'bytes=0-3' },
  }), env, {
    now: () => defaultNow,
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (calls.length === 1) {
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://redirect.files.1drv.com/final' },
        })
      }
      return new Response('data', { status: 206 })
    },
  })
  assert.equal(allowed.status, 206)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init?.redirect, 'manual')
  assert.equal(calls[1].url, 'https://redirect.files.1drv.com/final')
  assert.equal(new Headers(calls[1].init?.headers).get('Range'), 'bytes=0-3')
})

test('media endpoint preserves 416 responses and supports HEAD without a body', async () => {
  const rangeFailure = await handleRequest(new Request(signedMediaUrl()), env, {
    now: () => defaultNow,
    fetch: async () => new Response(null, {
      status: 416,
      headers: { 'Content-Range': 'bytes */100' },
    }),
  })
  assert.equal(rangeFailure.status, 416)
  assert.equal(rangeFailure.headers.get('Content-Range'), 'bytes */100')

  let method: string | undefined
  const head = await handleRequest(new Request(signedMediaUrl(), { method: 'HEAD' }), env, {
    now: () => defaultNow,
    fetch: async (_url, init) => {
      method = init?.method
      return new Response(null, { headers: { 'Content-Length': '100' } })
    },
  })
  assert.equal(method, 'HEAD')
  assert.equal(head.body, null)
  assert.equal(head.headers.get('Content-Length'), '100')
})

test('media response stays streaming until consumed', async () => {
  let pulls = 0
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1
      controller.enqueue(new TextEncoder().encode('streamed'))
      controller.close()
    },
  })
  const response = await handleRequest(new Request(signedMediaUrl()), env, {
    now: () => defaultNow,
    fetch: async () => new Response(body),
  })

  assert.ok(response.body)
  assert.equal(await response.text(), 'streamed')
  assert.ok(pulls >= 1)
})

test('CORS preflight excludes the removed ticket endpoint', async () => {
  const control = await handleRequest(new Request(`${workerOrigin}/v1/auth-check`, {
    method: 'OPTIONS',
    headers: { Origin: origin },
  }), env)
  assert.equal(control.status, 204)
  assert.equal(control.headers.get('Access-Control-Allow-Origin'), origin)

  const media = await handleRequest(new Request(`${workerOrigin}/v1/media`, {
    method: 'OPTIONS',
  }), env)
  assert.equal(media.status, 204)
  assert.equal(media.headers.get('Access-Control-Allow-Origin'), '*')

  const tickets = await handleRequest(controlRequest('/v1/tickets'), env)
  assert.equal(tickets.status, 404)
  const ticketsPreflight = await handleRequest(new Request(`${workerOrigin}/v1/tickets`, {
    method: 'OPTIONS',
    headers: { Origin: origin },
  }), env)
  assert.equal(ticketsPreflight.status, 404)
})
