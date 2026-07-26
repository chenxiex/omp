import type { FileNode } from '../types/file.ts'
import type { MetaData } from '../types/metaData.ts'
import type { QueuedTrack } from '../types/playQueue.ts'

export const ALBUM_ARTIST_SEPARATOR = '\u001f'
export const NO_ALBUM_ARTIST = '_NO_ARTIST_'

export type LibrarySearchContext =
  | { mode: 'files' }
  | { mode: 'albums' }
  | { mode: 'artists' }
  | { mode: 'songs' }
  | { mode: 'albumSongs', albumArtists: string[], album: string }
  | { mode: 'artistSongs', artist: string }

export type LocalLibrarySearchContext = Exclude<LibrarySearchContext, { mode: 'files' }>

export type LibrarySearchResult =
  | {
    kind: 'album'
    id: string
    album: string
    albumArtists: string[]
    metadata: MetaData
  }
  | {
    kind: 'artist'
    id: string
    artist: string
  }
  | {
    kind: 'song'
    id: string
    node: FileNode
    metadata: MetaData
  }

const safeDecodeURIComponent = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export const getLibrarySearchContext = (pathname: string): LibrarySearchContext => {
  const segments = pathname.split('/').filter(Boolean)

  if (segments[0] !== 'library') return { mode: 'files' }

  const tab = segments[1] ?? 'albums'

  if (tab === 'albums') {
    if (segments.length >= 4) {
      return {
        mode: 'albumSongs',
        albumArtists: safeDecodeURIComponent(segments[2]).split(ALBUM_ARTIST_SEPARATOR),
        album: safeDecodeURIComponent(segments[3]),
      }
    }
    return { mode: 'albums' }
  }

  if (tab === 'artists') {
    if (segments.length >= 3) {
      return {
        mode: 'artistSongs',
        artist: safeDecodeURIComponent(segments[2]),
      }
    }
    return { mode: 'artists' }
  }

  if (tab === 'songs') return { mode: 'songs' }

  return { mode: 'files' }
}

export const isLocalLibrarySearch = (
  context: LibrarySearchContext,
): context is LocalLibrarySearchContext => context.mode !== 'files'

const normalizeSearchText = (value: string) => value.trim().toLocaleLowerCase()

const matchesQuery = (values: Array<string | undefined>, query: string) => {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return false

  return values.some(value => value?.toLocaleLowerCase().includes(normalizedQuery))
}

const trackArtists = (metadata: MetaData) => [
  ...(metadata.common.artists ?? []),
  metadata.common.artist,
].filter((artist): artist is string => Boolean(artist))

const libraryArtists = (metadata: MetaData) => [
  ...(metadata.common.artists ?? []),
  ...(metadata.common.albumartists ?? []),
].filter((artist): artist is string => Boolean(artist))

const searchableSongArtists = (metadata: MetaData) => [
  ...trackArtists(metadata),
  ...(metadata.common.albumartists ?? []),
  metadata.common.albumartist,
].filter((artist): artist is string => Boolean(artist))

const searchCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

const compareText = (a: string, b: string) => searchCollator.compare(a, b)

const compareSongTitles = (a: LibrarySearchResult & { kind: 'song' }, b: LibrarySearchResult & { kind: 'song' }) => (
  compareText(a.metadata.common.title ?? a.node.name, b.metadata.common.title ?? b.node.name)
)

const compareAlbumSongs = (a: LibrarySearchResult & { kind: 'song' }, b: LibrarySearchResult & { kind: 'song' }) => {
  const diskResult = (a.metadata.common.disk?.no ?? 1) - (b.metadata.common.disk?.no ?? 1)
  if (diskResult !== 0) return diskResult

  const trackResult = (a.metadata.common.track.no ?? 0) - (b.metadata.common.track.no ?? 0)
  if (trackResult !== 0) return trackResult

  return compareSongTitles(a, b)
}

const compareArtistSongs = (a: LibrarySearchResult & { kind: 'song' }, b: LibrarySearchResult & { kind: 'song' }) => {
  const albumResult = compareText(a.metadata.common.album ?? '', b.metadata.common.album ?? '')
  if (albumResult !== 0) return albumResult
  return compareAlbumSongs(a, b)
}

const createSongResults = (nodes: FileNode[], metadata: MetaData[]) => {
  const audioNodeMap = new Map(
    nodes
      .filter(node => node.type === 'audio')
      .map(node => [node.id, node]),
  )

  return metadata
    .map(item => {
      const node = audioNodeMap.get(item.id)
      if (!node) return undefined

      return {
        kind: 'song' as const,
        id: item.id,
        node,
        metadata: item,
      }
    })
    .filter((item): item is LibrarySearchResult & { kind: 'song' } => item !== undefined)
}

const songMatchesQuery = (song: LibrarySearchResult & { kind: 'song' }, query: string) => matchesQuery([
  song.metadata.common.title,
  ...searchableSongArtists(song.metadata),
  song.metadata.common.album,
], query)

export const createLibrarySearchQueue = (results: LibrarySearchResult[]): QueuedTrack[] => results
  .filter((result): result is LibrarySearchResult & { kind: 'song' } => result.kind === 'song')
  .map((result, index) => ({
    track: {
      id: result.node.id,
      name: result.node.name,
      path: result.node.path,
      size: result.node.size,
      cTag: result.node.cTag,
    },
    index,
  }))

export const searchLibrary = (
  context: LocalLibrarySearchContext,
  nodes: FileNode[],
  metadata: MetaData[],
  query: string,
): LibrarySearchResult[] => {
  if (!normalizeSearchText(query)) return []

  const songs = createSongResults(nodes, metadata)

  if (context.mode === 'albums') {
    const albumMap = new Map<string, LibrarySearchResult & { kind: 'album' }>()

    for (const song of songs) {
      const album = song.metadata.common.album
      if (!album || !matchesQuery([album], query)) continue

      const albumArtists = song.metadata.common.albumartists ?? []
      const id = `${albumArtists.join(ALBUM_ARTIST_SEPARATOR)}::${album}`
      const existing = albumMap.get(id)

      if (!existing || (!existing.metadata.common.picture && song.metadata.common.picture)) {
        albumMap.set(id, {
          kind: 'album',
          id,
          album,
          albumArtists,
          metadata: song.metadata,
        })
      }
    }

    return Array.from(albumMap.values()).sort((a, b) => compareText(a.album, b.album))
  }

  if (context.mode === 'artists') {
    const artists = new Set(songs.flatMap(song => libraryArtists(song.metadata)))

    return Array.from(artists)
      .filter(artist => matchesQuery([artist], query))
      .sort(compareText)
      .map(artist => ({ kind: 'artist', id: artist, artist }))
  }

  let scopedSongs = songs

  if (context.mode === 'albumSongs') {
    scopedSongs = songs.filter(song => {
      if (song.metadata.common.album !== context.album) return false
      if (context.albumArtists[0] === NO_ALBUM_ARTIST) return true

      return context.albumArtists.every(
        artist => song.metadata.common.albumartists?.includes(artist),
      )
    })
  }

  if (context.mode === 'artistSongs') {
    scopedSongs = songs.filter(song => (
      song.metadata.common.artists?.includes(context.artist)
      || song.metadata.common.albumartists?.includes(context.artist)
    ))
  }

  const matchedSongs = scopedSongs.filter(song => songMatchesQuery(song, query))

  if (context.mode === 'albumSongs') return matchedSongs.sort(compareAlbumSongs)
  if (context.mode === 'artistSongs') return matchedSongs.sort(compareArtistSongs)
  return matchedSongs.sort(compareSongTitles)
}
