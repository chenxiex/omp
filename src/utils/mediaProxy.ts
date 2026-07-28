export const MEDIA_URL_VERSION = 1
export const MEDIA_URL_TTL_MS = 30 * 60 * 1000
export const MAX_MEDIA_SOURCE_URL_LENGTH = 8_000
export const MAX_SIGNED_MEDIA_URL_LENGTH = 15_000
export const MEDIA_AUTH_SCHEME = 'hmac-sha256'

const MEDIA_SIGNATURE_DOMAIN = 'omp-media-proxy:v1'
const textEncoder = new TextEncoder()

export interface MediaProxyConfig {
  url: string
  accessKey: string
}

export interface SignedMediaSource {
  mediaUrl: string
  expiresAt: number
}

export type MediaTransportSource =
  | {
      url: string
      transport: 'direct'
      proxyFailure?: { name: string, status?: number }
      expiresAt?: never
    }
  | {
      url: string
      transport: 'proxy'
      expiresAt: number
      proxyFailure?: never
    }

type SignedMediaUrlCreator = (
  config: MediaProxyConfig,
  sourceUrl: string,
  signal?: AbortSignal,
) => Promise<SignedMediaSource>

export const shouldBypassMediaProxyForRecovery = (
  failedTransport: 'proxy' | 'direct',
  attempt: number,
) => failedTransport === 'direct' || attempt >= 2

export class MediaProxyRequestError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'MediaProxyRequestError'
    this.status = status
  }
}

export const normalizeMediaProxyUrl = (value: string) => {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new MediaProxyRequestError('Media proxy URL is invalid.')
  }

  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || (url.pathname !== '' && url.pathname !== '/')
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new MediaProxyRequestError('Media proxy URL must be an HTTPS origin.')
  }

  return url.origin
}

const bytesToBase64Url = (bytes: Uint8Array) => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError')
}

export const createSignedMediaUrl = async (
  config: MediaProxyConfig,
  sourceUrl: string,
  signal?: AbortSignal,
  now: () => number = Date.now,
  cryptoImpl: Crypto = globalThis.crypto,
): Promise<SignedMediaSource> => {
  const baseUrl = normalizeMediaProxyUrl(config.url)
  if (!config.accessKey) throw new MediaProxyRequestError('Media proxy access key is required.')
  if (!sourceUrl || sourceUrl.length > MAX_MEDIA_SOURCE_URL_LENGTH) {
    throw new MediaProxyRequestError('Media source URL exceeds the supported length.')
  }

  const issuedAt = Math.trunc(now())
  if (!Number.isFinite(issuedAt)) {
    throw new MediaProxyRequestError('Cannot create a signed media URL.')
  }
  const expiresAt = issuedAt + MEDIA_URL_TTL_MS
  const payload = bytesToBase64Url(textEncoder.encode(JSON.stringify({
    v: MEDIA_URL_VERSION,
    iat: issuedAt,
    exp: expiresAt,
    url: sourceUrl,
  })))
  const message = `${MEDIA_SIGNATURE_DOMAIN}\n${baseUrl}\n${payload}`

  throwIfAborted(signal)
  let signature: ArrayBuffer
  try {
    const key = await cryptoImpl.subtle.importKey(
      'raw',
      textEncoder.encode(config.accessKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    signature = await cryptoImpl.subtle.sign('HMAC', key, textEncoder.encode(message))
  } catch {
    throwIfAborted(signal)
    throw new MediaProxyRequestError('Cannot create a signed media URL.')
  }
  throwIfAborted(signal)

  const signedMediaUrlObject = new URL('/v1/media', baseUrl)
  signedMediaUrlObject.searchParams.set('payload', payload)
  signedMediaUrlObject.searchParams.set(
    'signature',
    bytesToBase64Url(new Uint8Array(signature)),
  )
  const signedMediaUrl = signedMediaUrlObject.toString()
  if (signedMediaUrl.length > MAX_SIGNED_MEDIA_URL_LENGTH) {
    throw new MediaProxyRequestError('Signed media URL exceeds the supported length.')
  }

  return { mediaUrl: signedMediaUrl, expiresAt }
}

const proxyFetch = async (
  config: MediaProxyConfig,
  path: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
) => {
  const baseUrl = normalizeMediaProxyUrl(config.url)
  if (!config.accessKey) throw new MediaProxyRequestError('Media proxy access key is required.')

  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessKey}` },
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new MediaProxyRequestError('Media proxy request failed.')
  }

  if (!response.ok) {
    await response.body?.cancel()
    throw new MediaProxyRequestError('Media proxy rejected the request.', response.status)
  }

  return response
}

export const checkMediaProxy = async (
  config: MediaProxyConfig,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
) => {
  const response = await proxyFetch(config, '/v1/auth-check', signal, fetchImpl)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new MediaProxyRequestError('Media proxy returned an invalid response.')
  }
  if (
    typeof body !== 'object'
    || body === null
    || !('ok' in body)
    || body.ok !== true
    || !('mediaAuth' in body)
    || body.mediaAuth !== MEDIA_AUTH_SCHEME
    || !('mediaUrlVersion' in body)
    || body.mediaUrlVersion !== MEDIA_URL_VERSION
  ) throw new MediaProxyRequestError('Media proxy uses an incompatible media URL protocol.')
}

export const resolveMediaTransport = async (
  sourceUrl: string,
  config?: MediaProxyConfig,
  signal?: AbortSignal,
  createMediaUrl: SignedMediaUrlCreator = createSignedMediaUrl,
): Promise<MediaTransportSource> => {
  if (!config) return { url: sourceUrl, transport: 'direct' }

  try {
    const source = await createMediaUrl(config, sourceUrl, signal)
    return {
      url: source.mediaUrl,
      transport: 'proxy',
      expiresAt: source.expiresAt,
    }
  } catch (error) {
    if (signal?.aborted) throw error
    return {
      url: sourceUrl,
      transport: 'direct',
      proxyFailure: {
        name: error instanceof Error ? error.name : typeof error,
        ...(error instanceof MediaProxyRequestError && error.status !== undefined
          ? { status: error.status }
          : {}),
      },
    }
  }
}
