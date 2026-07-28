import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import {
  checkMediaProxy,
  createSignedMediaUrl,
  MEDIA_AUTH_SCHEME,
  MEDIA_URL_TTL_MS,
  MEDIA_URL_VERSION,
  MediaProxyRequestError,
  normalizeMediaProxyUrl,
  resolveMediaTransport,
  shouldBypassMediaProxyForRecovery,
} from '../src/utils/mediaProxy.ts'
import { handleRequest } from '../worker/src/index.ts'

const config = {
  url: 'https://proxy.example/',
  accessKey: 'private proxy key with no required encoding',
}
const sourceUrl = 'https://media.files.1drv.com/song.mp3?download=secret'

test('normalizes a proxy origin and rejects unsafe endpoint shapes', () => {
  assert.equal(normalizeMediaProxyUrl(' https://proxy.example/ '), 'https://proxy.example')

  for (const value of [
    'http://proxy.example',
    'http://localhost:8787',
    'https://user:password@proxy.example',
    'https://proxy.example/path',
    'https://proxy.example?secret=value',
  ]) {
    assert.throws(() => normalizeMediaProxyUrl(value), MediaProxyRequestError)
  }
})

test('auth check validates the key and signed media protocol capability', async () => {
  let captured: { input: string, init?: RequestInit } | undefined
  await checkMediaProxy(config, undefined, async (input, init) => {
    captured = { input: String(input), init }
    return Response.json({
      ok: true,
      mediaAuth: MEDIA_AUTH_SCHEME,
      mediaUrlVersion: MEDIA_URL_VERSION,
    })
  })

  assert.equal(captured?.input, 'https://proxy.example/v1/auth-check')
  assert.equal(new Headers(captured?.init?.headers).get('Authorization'), `Bearer ${config.accessKey}`)
  assert.equal(captured?.init?.body, undefined)

  await assert.rejects(
    checkMediaProxy(config, undefined, async () => Response.json({ ok: true })),
    MediaProxyRequestError,
  )
})

test('creates the versioned HMAC media URL locally with a reversible payload', async () => {
  const now = 1_720_000_000_000
  const signed = await createSignedMediaUrl(config, sourceUrl, undefined, () => now)
  const url = new URL(signed.mediaUrl)
  const payloadSegment = url.searchParams.get('payload') ?? ''
  const signatureSegment = url.searchParams.get('signature')
  const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'))
  const message = `omp-media-proxy:v1\n${url.origin}\n${payloadSegment}`
  const expectedSignature = createHmac('sha256', config.accessKey)
    .update(message)
    .digest('base64url')

  assert.deepEqual(payload, {
    v: MEDIA_URL_VERSION,
    iat: now,
    exp: now + MEDIA_URL_TTL_MS,
    url: sourceUrl,
  })
  assert.equal(signatureSegment, expectedSignature)
  assert.equal(signed.expiresAt, now + MEDIA_URL_TTL_MS)
  assert.equal(signed.mediaUrl.includes(config.accessKey), false)
})

test('browser-generated signed media URLs are accepted by the Worker', async () => {
  const now = 1_720_000_000_000
  const signed = await createSignedMediaUrl(config, sourceUrl, undefined, () => now)
  let upstreamUrl = ''
  const response = await handleRequest(new Request(signed.mediaUrl, {
    headers: { Range: 'bytes=0-3' },
  }), {
    ALLOWED_ORIGINS: 'https://player.example',
    ALLOWED_UPSTREAM_SUFFIXES: '.1drv.com,.sharepoint.com',
    PROXY_ACCESS_KEY: config.accessKey,
  }, {
    now: () => now,
    fetch: async (input) => {
      upstreamUrl = String(input)
      return new Response('data', { status: 206 })
    },
  })

  assert.equal(response.status, 206)
  assert.equal(upstreamUrl, sourceUrl)
})

test('keeps direct playback unchanged while signing success and falling back safely', async () => {
  let calls = 0
  const creator = async () => {
    calls += 1
    return {
      mediaUrl: 'https://proxy.example/v1/media?payload=value&signature=signed-value',
      expiresAt: Date.now() + 60_000,
    }
  }

  assert.deepEqual(
    await resolveMediaTransport(sourceUrl, undefined, undefined, creator),
    { url: sourceUrl, transport: 'direct' },
  )
  assert.equal(calls, 0)

  const proxied = await resolveMediaTransport(sourceUrl, config, undefined, creator)
  assert.equal(proxied.transport, 'proxy')
  assert.equal(
    proxied.url,
    'https://proxy.example/v1/media?payload=value&signature=signed-value',
  )
  assert.equal(calls, 1)

  const fallback = await resolveMediaTransport(sourceUrl, config, undefined, async () => {
    throw new Error('local signing failed')
  })
  assert.equal(fallback.url, sourceUrl)
  assert.equal(fallback.transport, 'direct')
  assert.deepEqual(fallback.proxyFailure, { name: 'Error' })
})

test('falls back locally when a source or resulting signed URL is too long', async () => {
  const fallback = await resolveMediaTransport('https://example.com/' + 'a'.repeat(8_000), config)

  assert.equal(fallback.transport, 'direct')
  assert.deepEqual(fallback.proxyFailure, { name: 'MediaProxyRequestError' })
})

test('refreshes one failed proxy source before falling back to direct media', () => {
  assert.equal(shouldBypassMediaProxyForRecovery('proxy', 1), false)
  assert.equal(shouldBypassMediaProxyForRecovery('proxy', 2), true)
  assert.equal(shouldBypassMediaProxyForRecovery('direct', 1), true)
})
