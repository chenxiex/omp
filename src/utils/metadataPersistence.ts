import type { LibraryDB } from '../db.ts'
import { rateLimitedFetch } from '../graph/rateLimiter.ts'
import type { FileNode, ThumbnailItem } from '../types/file.ts'
import type { MetaData, Picture, PicutreData } from '../types/metaData.ts'

export const ONEDRIVE_THUMBNAIL_DESCRIPTION = 'OneDrive thumbnail'

type MetadataState = FileNode['metadataState']

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
}

const arrayBufferToHex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer))
  .map(byte => byte.toString(16).padStart(2, '0'))
  .join('')

export const hasPersistedThumbnail = (metadata?: MetaData) => (
  metadata?.common.picture?.some(
    picture => picture.description === ONEDRIVE_THUMBNAIL_DESCRIPTION,
  ) ?? false
)

export const shouldRefreshPlaybackMetadata = (
  metadata: MetaData | undefined,
  metadataState: MetadataState,
) => (
  !metadata
  || metadata.source === 'filename'
  || metadataState === 'pending'
  || metadataState === 'failed'
)

export const mergeMetadataPicture = (
  metadata: MetaData,
  existing: MetaData | undefined,
  thumbnailPicture?: Picture,
): MetaData => ({
  ...metadata,
  common: {
    ...metadata.common,
    picture: thumbnailPicture
      ? [thumbnailPicture]
      : metadata.common.picture?.length
        ? metadata.common.picture
        : existing?.common.picture,
  },
})

export const fetchThumbnailPicture = async (
  thumbnail: ThumbnailItem,
  signal?: AbortSignal,
): Promise<{ picture: Picture, pictureData: PicutreData }> => {
  throwIfAborted(signal)
  const response = await rateLimitedFetch(
    thumbnail.url,
    { signal },
    { priority: 'low', scope: 'Content', retryNetworkErrors: true },
  )

  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Thumbnail request failed with status ${response.status}.`)
  }

  const data = new Uint8Array(await response.arrayBuffer())
  throwIfAborted(signal)
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    data as unknown as ArrayBuffer,
  )
  const sha256 = arrayBufferToHex(hashBuffer)
  const format = response.headers.get('Content-Type') ?? 'image/jpeg'

  return {
    picture: {
      sha256,
      format,
      description: ONEDRIVE_THUMBNAIL_DESCRIPTION,
    },
    pictureData: { id: sha256, data },
  }
}

export const persistMetadata = async (
  db: LibraryDB,
  metadata: MetaData,
  thumbnail?: ThumbnailItem,
  signal?: AbortSignal,
) => {
  let thumbnailPicture: Picture | undefined
  let thumbnailData: PicutreData | undefined

  if (thumbnail) {
    try {
      const result = await fetchThumbnailPicture(thumbnail, signal)
      thumbnailPicture = result.picture
      thumbnailData = result.pictureData
    } catch (error) {
      throwIfAborted(signal)
      console.warn(`Failed to persist thumbnail for ${metadata.id}:`, error)
    }
  }

  return db.transaction('rw', db.metadata, db.pictures, db.nodes, async transaction => {
    const handleAbort = () => transaction.abort()
    signal?.addEventListener('abort', handleAbort, { once: true })

    try {
      throwIfAborted(signal)
      const existing = await db.metadata.get(metadata.id)
      const nextMetadata = mergeMetadataPicture(metadata, existing, thumbnailPicture)
      await db.metadata.put(nextMetadata)
      if (thumbnailData) await db.pictures.put(thumbnailData)
      await db.nodes.update(metadata.id, { metadataState: 'completed' })
      throwIfAborted(signal)
      return nextMetadata
    } finally {
      signal?.removeEventListener('abort', handleAbort)
    }
  })
}
