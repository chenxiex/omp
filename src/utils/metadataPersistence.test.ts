import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { MetaData, Picture } from '../types/metaData.ts'
import {
  fetchThumbnailPicture,
  hasPersistedThumbnail,
  mergeMetadataPicture,
  ONEDRIVE_THUMBNAIL_DESCRIPTION,
  shouldRefreshPlaybackMetadata,
} from './metadataPersistence.ts'

const originalFetch = globalThis.fetch

const metadata = (source: MetaData['source'] = 'range'): MetaData => ({
  id: 'track',
  source,
  common: {
    title: 'Track',
    track: { no: null, of: null },
    disk: { no: null, of: null },
  },
  format: { trackInfo: [], tagTypes: [] },
} as MetaData)

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('playback metadata refresh policy', () => {
  it('refreshes missing, filename, pending, and failed metadata only', () => {
    assert.equal(shouldRefreshPlaybackMetadata(undefined, 'completed'), true)
    assert.equal(shouldRefreshPlaybackMetadata(metadata('filename'), 'completed'), true)
    assert.equal(shouldRefreshPlaybackMetadata(metadata('range'), 'pending'), true)
    assert.equal(shouldRefreshPlaybackMetadata(metadata('graph'), 'failed'), true)
    assert.equal(shouldRefreshPlaybackMetadata(metadata('range'), 'completed'), false)
    assert.equal(shouldRefreshPlaybackMetadata(metadata('graph'), 'completed'), false)
    assert.equal(shouldRefreshPlaybackMetadata(metadata('stream'), 'completed'), false)
  })
})

describe('thumbnail metadata persistence', () => {
  const legacyPicture: Picture = {
    sha256: 'legacy',
    format: 'image/jpeg',
    description: 'Embedded cover',
  }
  const thumbnailPicture: Picture = {
    sha256: 'thumbnail',
    format: 'image/jpeg',
    description: ONEDRIVE_THUMBNAIL_DESCRIPTION,
  }

  it('uses a new thumbnail and recognizes it on later playback', () => {
    const result = mergeMetadataPicture(
      metadata(),
      { ...metadata('stream'), common: { ...metadata().common, picture: [legacyPicture] } },
      thumbnailPicture,
    )

    assert.deepEqual(result.common.picture, [thumbnailPicture])
    assert.equal(hasPersistedThumbnail(result), true)
  })

  it('preserves the existing cover when no thumbnail was downloaded', () => {
    const existing = {
      ...metadata('stream'),
      common: { ...metadata().common, picture: [legacyPicture] },
    }
    const result = mergeMetadataPicture(metadata('graph'), existing)

    assert.deepEqual(result.common.picture, [legacyPicture])
    assert.equal(hasPersistedThumbnail(result), false)
  })

  it('downloads and hashes a thumbnail without touching the media file', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    globalThis.fetch = async input => {
      assert.equal(input, 'https://thumbnail.test/track')
      return new Response(bytes as unknown as ArrayBuffer, {
        status: 200,
        headers: { 'Content-Type': 'image/webp' },
      })
    }

    const result = await fetchThumbnailPicture({
      width: 800,
      height: 800,
      url: 'https://thumbnail.test/track',
    })

    assert.equal(result.picture.format, 'image/webp')
    assert.equal(result.picture.description, ONEDRIVE_THUMBNAIL_DESCRIPTION)
    assert.equal(result.picture.sha256.length, 64)
    assert.deepEqual(result.pictureData.data, bytes)
  })
})
