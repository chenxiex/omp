import usePlayQueueStore from '@/store/usePlayQueueStore'
import useUiStore from '@/store/useUiStore'
import type { Track } from '@/types/file'
import { resolveMediaTransport } from '@/utils/mediaProxy'
import { remoteItemToTrack } from '@/utils/track'
import {
  getTrackSourceKey,
  TrackSourceCache,
  type ResolvedTrackSource,
} from '@/utils/trackSourceCache'
import { useMsal } from '@azure/msal-react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import useGraph from '../graph/useGraph'
import useUser from '../graph/useUser'

const useUrl = () => {
  const { instance } = useMsal()
  const { account } = useUser()
  const { getFileData } = useGraph(instance, account)
  const getFileDataRef = useRef(getFileData)
  getFileDataRef.current = getFileData

  const mediaProxyEnabled = useUiStore.use.mediaProxyEnabled()
  const mediaProxyUrl = useUiStore.use.mediaProxyUrl()
  const mediaProxyAccessKey = useUiStore.use.mediaProxyAccessKey()
  const proxyConfigured = Boolean(mediaProxyEnabled && mediaProxyUrl && mediaProxyAccessKey)

  const accountKey = account?.homeAccountId ?? account?.username ?? ''
  // 当前曲和 standby 共用解析器，避免同一首歌重复请求 Graph
  const sourceCache = useMemo(
    () => new TrackSourceCache(async (track, signal, options) => {
      if (!accountKey) throw new Error('Cannot resolve a track without an account.')

      const remoteItem = await getFileDataRef.current(
        track.id,
        track.path,
        signal,
        'high',
        true,
      )
      const url = remoteItem?.['@microsoft.graph.downloadUrl']
      if (!url) throw new Error('No download URL returned for track.')

      const { proxyFailure, ...transportSource } = await resolveMediaTransport(
        url,
        proxyConfigured && !options?.bypassProxy
          ? {
            url: mediaProxyUrl,
            accessKey: mediaProxyAccessKey,
          }
          : undefined,
        signal,
      )
      if (proxyFailure) {
        console.warn('Failed to create a signed media URL; using a direct source.', proxyFailure)
      }

      return {
        ...transportSource,
        remoteTrack: remoteItemToTrack(remoteItem),
        thumbnail: remoteItem.thumbnails?.[0]?.large,
      }
    }),
    [accountKey, mediaProxyAccessKey, mediaProxyUrl, proxyConfigured],
  )

  useEffect(() => () => sourceCache.clear(), [sourceCache])

  const resolveSource = useCallback(async (
    track: Track,
    options?: { forceRefresh?: boolean, bypassProxy?: boolean },
  ) => {
    if (!accountKey) throw new Error('Cannot resolve a track without an account.')

    if (options?.forceRefresh) sourceCache.invalidate(accountKey, track)

    const source = await sourceCache.resolve(accountKey, track, {
      bypassProxy: options?.bypassProxy,
    })
    const queueState = usePlayQueueStore.getState()
    const hasUpdatedTrack = queueState.playQueue.some(item => (
      getTrackSourceKey(item.track) === source.trackKey
      && item.track.cTag !== source.remoteTrack.cTag
    ))

    if (hasUpdatedTrack) {
      // standby 解析到新版本时也同步队列，但不改变歌曲索引
      queueState.updatePlayQueue(queueState.playQueue.map(item => (
        getTrackSourceKey(item.track) === source.trackKey
          ? { ...item, track: source.remoteTrack }
          : item
      )))
    }

    return source
  }, [accountKey, sourceCache])

  const retainSources = useCallback((tracks: Track[]) => {
    sourceCache.retain(accountKey, tracks)
  }, [accountKey, sourceCache])

  const invalidateSource = useCallback((source: ResolvedTrackSource) => {
    if (accountKey) sourceCache.invalidateKey(accountKey, source.trackKey)
  }, [accountKey, sourceCache])

  return {
    accountKey,
    invalidateSource,
    resolveSource,
    retainSources,
  }
}

export default useUrl
