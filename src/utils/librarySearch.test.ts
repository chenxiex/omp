import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FileNode } from '../types/file.ts'
import type { MetaData } from '../types/metaData.ts'
import {
  createLibrarySearchQueue,
  getLibrarySearchContext,
  searchLibrary,
} from './librarySearch.ts'

const node = (id: string, type: FileNode['type'] = 'audio'): FileNode => ({
  id,
  name: `${id}.mp3`,
  path: ['Music', `${id}.mp3`],
  type,
  size: 1,
  lastModifiedDateTime: '2026-01-01T00:00:00Z',
})

const song = ({
  id,
  title,
  artists,
  albumArtists,
  album,
  disk = 1,
  track = 1,
  picture = false,
}: {
  id: string
  title: string
  artists?: string[]
  albumArtists?: string[]
  album?: string
  disk?: number
  track?: number
  picture?: boolean
}): MetaData => ({
  id,
  common: {
    title,
    artist: artists?.[0],
    artists,
    albumartist: albumArtists?.[0],
    albumartists: albumArtists,
    album,
    picture: picture ? [{ sha256: id, format: 'image/jpeg' }] : undefined,
    track: { no: track, of: null },
    disk: { no: disk, of: null },
    movementIndex: { no: null, of: null },
  },
  format: { trackInfo: [], tagTypes: [] },
})

describe('library search route context', () => {
  it('distinguishes library lists, details, folders, and external pages', () => {
    assert.deepEqual(getLibrarySearchContext('/library'), { mode: 'albums' })
    assert.deepEqual(getLibrarySearchContext('/library/albums'), { mode: 'albums' })
    assert.deepEqual(getLibrarySearchContext('/library/artists'), { mode: 'artists' })
    assert.deepEqual(getLibrarySearchContext('/library/songs'), { mode: 'songs' })
    assert.deepEqual(getLibrarySearchContext('/library/folders'), { mode: 'files' })
    assert.deepEqual(getLibrarySearchContext('/library/folders/folder-id'), { mode: 'files' })
    assert.deepEqual(getLibrarySearchContext('/files/Music'), { mode: 'files' })
  })

  it('decodes album and artist detail parameters', () => {
    assert.deepEqual(
      getLibrarySearchContext('/library/albums/First%20Artist%1FSecond/An%20Album'),
      { mode: 'albumSongs', albumArtists: ['First Artist', 'Second'], album: 'An Album' },
    )
    assert.deepEqual(
      getLibrarySearchContext('/library/artists/An%20Artist'),
      { mode: 'artistSongs', artist: 'An Artist' },
    )
  })
})

describe('library entity search', () => {
  const nodes = [node('one'), node('two'), node('three'), node('stale'), node('video', 'video')]
  const metadata = [
    song({ id: 'one', title: 'Opening Song', artists: ['Track Artist'], albumArtists: ['Album Artist'], album: 'Shared Album' }),
    song({ id: 'two', title: 'Second Song', artists: ['Guest Artist'], albumArtists: ['Album Artist'], album: 'Shared Album', picture: true }),
    song({ id: 'three', title: 'Another Song', artists: ['Other Artist'], albumArtists: ['Other Artist'], album: 'Another Album' }),
    song({ id: 'missing', title: 'Missing Node', artists: ['Ghost'], album: 'Lost Album' }),
    song({ id: 'video', title: 'Video Metadata', artists: ['Video Artist'], album: 'Video Album' }),
  ]

  it('matches album names case-insensitively and deduplicates album identities', () => {
    const results = searchLibrary({ mode: 'albums' }, nodes, metadata, ' shared ')

    assert.equal(results.length, 1)
    assert.equal(results[0].kind, 'album')
    if (results[0].kind === 'album') {
      assert.equal(results[0].album, 'Shared Album')
      assert.equal(results[0].metadata.id, 'two')
    }
  })

  it('combines track and album artists without returning stale or non-audio metadata', () => {
    const results = searchLibrary({ mode: 'artists' }, nodes, metadata, 'artist')

    assert.deepEqual(
      results.map(result => result.kind === 'artist' ? result.artist : ''),
      ['Album Artist', 'Guest Artist', 'Other Artist', 'Track Artist'],
    )
  })

  it('matches cached songs by title, artist, and album only for audio nodes', () => {
    assert.deepEqual(
      searchLibrary({ mode: 'songs' }, nodes, metadata, 'opening').map(result => result.id),
      ['one'],
    )
    assert.deepEqual(
      searchLibrary({ mode: 'songs' }, nodes, metadata, 'guest artist').map(result => result.id),
      ['two'],
    )
    assert.deepEqual(
      searchLibrary({ mode: 'songs' }, nodes, metadata, 'shared album').map(result => result.id),
      ['one', 'two'],
    )
    assert.deepEqual(searchLibrary({ mode: 'songs' }, nodes, metadata, 'missing node'), [])
    assert.deepEqual(searchLibrary({ mode: 'songs' }, nodes, metadata, 'video metadata'), [])
  })
})

describe('library detail song search', () => {
  const nodes = [node('track-1'), node('track-2'), node('track-3'), node('track-4')]
  const metadata = [
    song({ id: 'track-1', title: 'Finale', artists: ['Selected Artist'], albumArtists: ['Selected Artist'], album: 'Selected Album', disk: 2, track: 1 }),
    song({ id: 'track-2', title: 'First Song', artists: ['Selected Artist'], albumArtists: ['Selected Artist'], album: 'Selected Album', disk: 1, track: 2 }),
    song({ id: 'track-3', title: 'Other Album Song', artists: ['Selected Artist'], albumArtists: ['Selected Artist'], album: 'Other Album', disk: 1, track: 1 }),
    song({ id: 'track-4', title: 'Unrelated Song', artists: ['Other Artist'], albumArtists: ['Other Artist'], album: 'Other Album', disk: 1, track: 2 }),
  ]

  it('limits album details to the current album and keeps disc/track order', () => {
    const results = searchLibrary({
      mode: 'albumSongs',
      albumArtists: ['Selected Artist'],
      album: 'Selected Album',
    }, nodes, metadata, 'selected artist')

    assert.deepEqual(results.map(result => result.id), ['track-2', 'track-1'])
    assert.deepEqual(
      createLibrarySearchQueue(results).map(item => ({ id: item.track.id, index: item.index })),
      [{ id: 'track-2', index: 0 }, { id: 'track-1', index: 1 }],
    )
  })

  it('limits artist details to the current artist and keeps album order', () => {
    const results = searchLibrary({ mode: 'artistSongs', artist: 'Selected Artist' }, nodes, metadata, 'song')

    assert.deepEqual(results.map(result => result.id), ['track-3', 'track-2'])
  })
})
