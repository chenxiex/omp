const MEDIA_URL_VERSION = 1
const WORKER_VERSION = '1.1.0'
const MEDIA_URL_TTL_MS = 30 * 60 * 1000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const MAX_SOURCE_URL_LENGTH = 8_000
const MAX_SIGNED_MEDIA_URL_LENGTH = 15_000
const MAX_PAYLOAD_LENGTH = 12_000
const MEDIA_AUTH_SCHEME = 'hmac-sha256'
const MEDIA_SIGNATURE_DOMAIN = 'omp-media-proxy:v1'
const MEDIA_REQUEST_HEADERS = ['range', 'if-range']
const MEDIA_RESPONSE_HEADERS = [
  'accept-ranges',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
]
const MEDIA_EXPOSE_HEADERS = [
  'Accept-Ranges',
  'Content-Disposition',
  'Content-Length',
  'Content-Range',
  'Content-Type',
  'ETag',
  'Last-Modified',
].join(', ')

export interface Env {
  ALLOWED_ORIGINS?: string
  ALLOWED_UPSTREAM_SUFFIXES?: string
  PROXY_ACCESS_KEY?: string
}

export interface WorkerRuntime {
  crypto: Crypto
  fetch: typeof fetch
  now: () => number
}

type WorkerRuntimeOverrides = Partial<WorkerRuntime>
type UpstreamRequest = Pick<Request, 'method' | 'headers'>

class MediaUrlExpiredError extends Error {}
class InvalidMediaUrlError extends Error {}
class ForbiddenUpstreamError extends Error {}
class WorkerConfigurationError extends Error {}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

const splitList = (value: unknown) => String(value ?? '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean)

const base64UrlToBytes = (value: string) => {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new InvalidMediaUrlError()
  const standard = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4)
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new InvalidMediaUrlError()
  }
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

const importHmacKey = async (env: Env, cryptoImpl: Crypto, usage: KeyUsage[]) => {
  const accessKey = String(env.PROXY_ACCESS_KEY ?? '')
  if (!accessKey) throw new WorkerConfigurationError()
  return cryptoImpl.subtle.importKey(
    'raw',
    textEncoder.encode(accessKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage,
  )
}

const secureEqual = async (left: string, right: string, cryptoImpl: Crypto) => {
  const [leftHash, rightHash] = await Promise.all([
    cryptoImpl.subtle.digest('SHA-256', textEncoder.encode(left)),
    cryptoImpl.subtle.digest('SHA-256', textEncoder.encode(right)),
  ])
  const leftBytes = new Uint8Array(leftHash)
  const rightBytes = new Uint8Array(rightHash)
  let difference = 0
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index]
  }
  return difference === 0
}

const getBearerToken = (request: Request) => {
  const authorization = request.headers.get('Authorization') ?? ''
  return authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : ''
}

const isAllowedOrigin = (request: Request, env: Env) => {
  const origin = request.headers.get('Origin')
  return Boolean(origin && splitList(env.ALLOWED_ORIGINS).includes(origin))
}

const isIPv4 = (hostname: string) => {
  const parts = hostname.split('.')
  return parts.length === 4 && parts.every(part => (
    /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255
  ))
}

const normalizedSuffixes = (env: Env) => splitList(env.ALLOWED_UPSTREAM_SUFFIXES)
  .map(suffix => suffix.toLowerCase().replace(/^\*\./, '').replace(/^\./, ''))
  .filter(suffix => suffix.includes('.'))

const validateUpstreamUrl = (sourceUrl: unknown, env: Env) => {
  if (
    typeof sourceUrl !== 'string'
    || sourceUrl.length === 0
    || sourceUrl.length > MAX_SOURCE_URL_LENGTH
  ) throw new ForbiddenUpstreamError()

  let url: URL
  try {
    url = new URL(sourceUrl)
  } catch {
    throw new ForbiddenUpstreamError()
  }

  const hostname = url.hostname.toLowerCase()
  const suffixes = normalizedSuffixes(env)
  const unsafeHostname = (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || isIPv4(hostname)
    || hostname.includes(':')
  )
  const allowedHostname = suffixes.some(suffix => (
    hostname === suffix || hostname.endsWith(`.${suffix}`)
  ))

  if (
    url.protocol !== 'https:'
    || (url.port !== '' && url.port !== '443')
    || url.username !== ''
    || url.password !== ''
    || unsafeHostname
    || suffixes.length === 0
    || !allowedHostname
  ) throw new ForbiddenUpstreamError()

  return url.toString()
}

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) => new Response(
  JSON.stringify(body),
  {
    status,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  },
)

const controlCorsHeaders = (request: Request): Record<string, string> => ({
  'Access-Control-Allow-Origin': request.headers.get('Origin') ?? '',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
})

const mediaCorsHeaders = (): Record<string, string> => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-Range',
  'Access-Control-Expose-Headers': MEDIA_EXPOSE_HEADERS,
  'Access-Control-Max-Age': '86400',
})

const hasValidAccessKey = async (request: Request, env: Env, cryptoImpl: Crypto) => {
  const expected = String(env.PROXY_ACCESS_KEY ?? '')
  const received = getBearerToken(request)
  if (!expected || !received) return false
  return secureEqual(received, expected, cryptoImpl)
}

const openSignedMediaUrl = async (
  payloadSegment: string,
  signatureSegment: string,
  workerOrigin: string,
  env: Env,
  now: number,
  cryptoImpl: Crypto,
) => {
  if (!payloadSegment || payloadSegment.length > MAX_PAYLOAD_LENGTH) {
    throw new InvalidMediaUrlError()
  }

  const signature = base64UrlToBytes(signatureSegment)
  if (signature.byteLength !== 32) throw new InvalidMediaUrlError()
  const key = await importHmacKey(env, cryptoImpl, ['verify'])
  const message = `${MEDIA_SIGNATURE_DOMAIN}\n${workerOrigin}\n${payloadSegment}`
  const signatureValid = await cryptoImpl.subtle.verify(
    'HMAC',
    key,
    signature,
    textEncoder.encode(message),
  )
  if (!signatureValid) throw new InvalidMediaUrlError()

  let payload: unknown
  try {
    payload = JSON.parse(textDecoder.decode(base64UrlToBytes(payloadSegment)))
  } catch {
    throw new InvalidMediaUrlError()
  }
  if (
    typeof payload !== 'object'
    || payload === null
    || !('v' in payload)
    || payload.v !== MEDIA_URL_VERSION
    || !('iat' in payload)
    || typeof payload.iat !== 'number'
    || !Number.isInteger(payload.iat)
    || !('exp' in payload)
    || typeof payload.exp !== 'number'
    || !Number.isInteger(payload.exp)
    || payload.exp - payload.iat !== MEDIA_URL_TTL_MS
    || payload.iat > now + MAX_CLOCK_SKEW_MS
    || !('url' in payload)
    || typeof payload.url !== 'string'
  ) throw new InvalidMediaUrlError()
  if (payload.exp <= now) throw new MediaUrlExpiredError()

  return { sourceUrl: validateUpstreamUrl(payload.url, env) }
}

const handleOptions = (request: Request, env: Env, pathname: string) => {
  if (pathname === '/v1/media') {
    return new Response(null, { status: 204, headers: mediaCorsHeaders() })
  }
  if (pathname === '/v1/auth-check') {
    if (!isAllowedOrigin(request, env)) return jsonResponse({ error: 'origin_not_allowed' }, 403)
    return new Response(null, { status: 204, headers: controlCorsHeaders(request) })
  }
  return jsonResponse({ error: 'not_found' }, 404)
}

const handleAuthCheck = async (request: Request, env: Env, runtime: WorkerRuntime) => {
  if (!isAllowedOrigin(request, env)) {
    return jsonResponse({ error: 'origin_not_allowed' }, 403)
  }
  const headers = controlCorsHeaders(request)
  if (!await hasValidAccessKey(request, env, runtime.crypto)) {
    return jsonResponse({ error: 'unauthorized' }, 401, headers)
  }
  return jsonResponse({
    ok: true,
    mediaAuth: MEDIA_AUTH_SCHEME,
    mediaUrlVersion: MEDIA_URL_VERSION,
  }, 200, headers)
}

const fetchAllowedUpstream = async (
  sourceUrl: string,
  request: UpstreamRequest,
  env: Env,
  runtime: WorkerRuntime,
) => {
  let currentUrl = sourceUrl
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const upstream = await runtime.fetch(currentUrl, {
      method: request.method,
      headers: request.headers,
      redirect: 'manual',
    })
    if (![301, 302, 303, 307, 308].includes(upstream.status)) return upstream

    const location = upstream.headers.get('Location')
    await upstream.body?.cancel()
    if (!location || redirectCount === 5) throw new ForbiddenUpstreamError()
    currentUrl = validateUpstreamUrl(new URL(location, currentUrl).toString(), env)
  }
  throw new ForbiddenUpstreamError()
}

const handleMediaRequest = async (
  request: Request,
  env: Env,
  runtime: WorkerRuntime,
  payloadSegment: string,
  signatureSegment: string,
  workerOrigin: string,
) => {
  let payload: { sourceUrl: string }
  try {
    payload = await openSignedMediaUrl(
      payloadSegment,
      signatureSegment,
      workerOrigin,
      env,
      runtime.now(),
      runtime.crypto,
    )
  } catch (error) {
    if (error instanceof WorkerConfigurationError) throw error
    if (error instanceof MediaUrlExpiredError) {
      return jsonResponse({ error: 'media_url_expired' }, 410, mediaCorsHeaders())
    }
    if (error instanceof ForbiddenUpstreamError) {
      return jsonResponse({ error: 'upstream_not_allowed' }, 403, mediaCorsHeaders())
    }
    return jsonResponse({ error: 'invalid_media_url' }, 401, mediaCorsHeaders())
  }

  const upstreamHeaders = new Headers()
  for (const name of MEDIA_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) upstreamHeaders.set(name, value)
  }

  let upstream: Response
  try {
    upstream = await fetchAllowedUpstream(
      payload.sourceUrl,
      { method: request.method, headers: upstreamHeaders },
      env,
      runtime,
    )
  } catch (error) {
    if (error instanceof ForbiddenUpstreamError) {
      return jsonResponse({ error: 'upstream_not_allowed' }, 403, mediaCorsHeaders())
    }
    return jsonResponse({ error: 'upstream_unavailable' }, 502, mediaCorsHeaders())
  }

  const responseHeaders = new Headers(mediaCorsHeaders())
  for (const name of MEDIA_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value !== null) responseHeaders.set(name, value)
  }
  responseHeaders.set('Cache-Control', 'private, no-store, max-age=0')
  responseHeaders.set('Referrer-Policy', 'no-referrer')

  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

export const handleRequest = async (
  request: Request,
  env: Env,
  overrides: WorkerRuntimeOverrides = {},
) => {
  const runtime: WorkerRuntime = {
    crypto: overrides.crypto ?? globalThis.crypto,
    fetch: overrides.fetch ?? globalThis.fetch.bind(globalThis),
    now: overrides.now ?? Date.now,
  }
  const url = new URL(request.url)

  try {
    if (request.method === 'OPTIONS') return handleOptions(request, env, url.pathname)
    if (request.method === 'GET' && url.pathname === '/v1/health') {
      return jsonResponse({
        name: 'omp-media-proxy',
        version: WORKER_VERSION,
        mediaAuth: MEDIA_AUTH_SCHEME,
        mediaUrlVersion: MEDIA_URL_VERSION,
        mediaUrlTtlSeconds: MEDIA_URL_TTL_MS / 1000,
        supports: ['GET', 'HEAD', 'Range'],
      })
    }
    if (request.method === 'POST' && url.pathname === '/v1/auth-check') {
      return handleAuthCheck(request, env, runtime)
    }
    if (
      (request.method === 'GET' || request.method === 'HEAD')
      && url.pathname === '/v1/media'
    ) {
      const payloadSegments = url.searchParams.getAll('payload')
      const signatureSegments = url.searchParams.getAll('signature')
      if (
        request.url.length > MAX_SIGNED_MEDIA_URL_LENGTH
        || payloadSegments.length !== 1
        || signatureSegments.length !== 1
        || [...url.searchParams.keys()].some(name => (
          name !== 'payload' && name !== 'signature'
        ))
      ) {
        return jsonResponse({ error: 'invalid_media_url' }, 401, mediaCorsHeaders())
      }
      return handleMediaRequest(
        request,
        env,
        runtime,
        payloadSegments[0],
        signatureSegments[0],
        url.origin,
      )
    }
    return jsonResponse({ error: 'not_found' }, 404)
  } catch {
    return jsonResponse({ error: 'internal_error' }, 500)
  }
}

export default {
  fetch(request: Request, env: Env) {
    return handleRequest(request, env)
  },
}

export const testing = {
  MAX_CLOCK_SKEW_MS,
  MAX_SIGNED_MEDIA_URL_LENGTH,
  MEDIA_AUTH_SCHEME,
  MEDIA_SIGNATURE_DOMAIN,
  MEDIA_URL_TTL_MS,
  MEDIA_URL_VERSION,
}
