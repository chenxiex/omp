import type { ThumbnailItem, Track } from '../types/file.ts'

// Graph 临时下载地址只在当前播放会话中短期复用
export const TRACK_SOURCE_MAX_AGE_MS = 45 * 60 * 1000

export interface FetchedTrackSource {
  url: string
  remoteTrack: Track
  thumbnail?: ThumbnailItem
}

export interface ResolvedTrackSource extends FetchedTrackSource {
  accountId: string
  trackId: string
  trackKey: string
  fetchedAt: number
}

export type FetchTrackSource = (
  track: Track,
  signal: AbortSignal,
) => Promise<FetchedTrackSource>

interface CacheEntry {
  controller: AbortController
  promise?: Promise<ResolvedTrackSource>
  source?: ResolvedTrackSource
}

export const getTrackSourceKey = (track: Track) =>
  track.id ? `id:${track.id}` : `path:${track.path.join('/')}`

// 同一首歌在不同账户下不能共用下载地址
const cacheKey = (accountId: string, track: Track) =>
  `${accountId}\u0000${getTrackSourceKey(track)}`

// 仅在内存中缓存当前歌曲和预取的下一首
export class TrackSourceCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly fetchSource: FetchTrackSource
  private readonly now: () => number

  constructor(
    fetchSource: FetchTrackSource,
    now: () => number = Date.now,
  ) {
    this.fetchSource = fetchSource
    this.now = now
  }

  peek(accountId: string, track: Track, maxAgeMs = TRACK_SOURCE_MAX_AGE_MS) {
    const source = this.entries.get(cacheKey(accountId, track))?.source
    if (!source || this.now() - source.fetchedAt >= maxAgeMs) return undefined

    return source
  }

  resolve(accountId: string, track: Track) {
    const key = cacheKey(accountId, track)
    const existing = this.entries.get(key)
    const cached = this.peek(accountId, track)

    // 优先复用有效缓存，并合并相同歌曲的并发请求
    if (cached) return Promise.resolve(cached)
    if (existing?.promise) return existing.promise

    const controller = new AbortController()
    const entry: CacheEntry = {
      controller,
      source: existing?.source,
    }

    const promise = this.fetchSource(track, controller.signal)
      .then(result => {
        const source: ResolvedTrackSource = {
          ...result,
          accountId,
          trackId: track.id,
          trackKey: getTrackSourceKey(track),
          fetchedAt: this.now(),
        }

        if (this.entries.get(key) === entry) {
          entry.source = source
          entry.promise = undefined
        }

        return source
      })
      .catch(error => {
        if (this.entries.get(key) === entry) {
          if (entry.source) {
            entry.promise = undefined
          } else {
            this.entries.delete(key)
          }
        }
        throw error
      })

    entry.promise = promise
    this.entries.set(key, entry)
    return promise
  }

  retain(accountId: string, tracks: Track[]) {
    const retainedKeys = new Set(tracks.map(track => cacheKey(accountId, track)))

    // 队列变化后取消不再属于当前曲或下一首的请求
    for (const [key, entry] of this.entries) {
      if (!retainedKeys.has(key)) {
        entry.controller.abort()
        this.entries.delete(key)
      }
    }
  }

  invalidate(accountId: string, track: Track) {
    this.invalidateKey(accountId, getTrackSourceKey(track))
  }

  invalidateKey(accountId: string, trackKey: string) {
    const key = `${accountId}\u0000${trackKey}`
    const entry = this.entries.get(key)
    entry?.controller.abort()
    this.entries.delete(key)
  }

  clear() {
    for (const entry of this.entries.values()) entry.controller.abort()
    this.entries.clear()
  }
}
