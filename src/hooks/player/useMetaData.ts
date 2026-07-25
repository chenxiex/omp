import usePlayQueueStore from '@/store/usePlayQueueStore'
import { isAudio } from '@/utils/checkFileType'
import { useEffect, useMemo } from 'react'
import useUser from '@/hooks/graph/useUser'
import useDb from '@/hooks/useDb'
import usePlayerStore from '@/store/usePlayerStore'
import { useShallow } from 'zustand/shallow'
import createImageUrl from '@/utils/createImageUrl'
import type { ThumbnailItem } from '@/types/file'
import { getRangeMetadata } from '@/utils/rangeMetadata'
import {
  hasPersistedThumbnail,
  persistMetadata,
  shouldRefreshPlaybackMetadata,
} from '@/utils/metadataPersistence'

const useMetaData = (url: string, thumbnail?: ThumbnailItem) => {
  const { account } = useUser()

  const db = useDb(account)

  const [
    metadataUpdate,
    updateCurrentMetaData,
    updateMetadataUpdate,
    updateCover,
  ] = usePlayerStore(
    useShallow(
      (state) => [
        state.metadataUpdate,
        state.updateCurrentMetaData,
        state.updateMetadataUpdate,
        state.updateCover,
      ]
    )
  )

  const playQueue = usePlayQueueStore.use.playQueue()
  const currentIndex = usePlayQueueStore.use.currentIndex()

  const currentTrack = useMemo(() => playQueue?.find(item => item.index === currentIndex), [currentIndex, playQueue])

  // 更新当前 metadata
  useEffect(
    () => {
      void (async () => {
        if (currentTrack?.track.id && db) {
          const metaData = await db.metadata.get(currentTrack.track.id)

          if (!metaData) {
            updateCover('./cover.svg')
            updateCurrentMetaData(null)
          } else {
            console.log('Update current metaData: ', metaData)
            updateCurrentMetaData(metaData)
            if (metaData.common.picture && metaData.common.picture.length > 0) {
              const cover = metaData.common.picture[0]
              if (cover && 'sha256' in cover) {
                const coverUrl = await createImageUrl(db, metaData.common.picture)
                updateCover(coverUrl)
              }
            } else {
              updateCover('./cover.svg')
            }
          }
        }
      })()
    },
    [metadataUpdate, db, currentTrack, updateCover, updateCurrentMetaData]
  )

  // 使用 Range 请求补全 metadata，并按需持久化 OneDrive thumbnail。
  useEffect(
    () => {
      const controller = new AbortController()
      const { signal } = controller

      void (async () => {
        if (currentTrack && currentTrack.track.id && isAudio(currentTrack.track.name) && db && url) {
          const localMetaData = await db.metadata.get(currentTrack.track.id)
          const node = await db.nodes.get(currentTrack.track.id)
          const needsMetadata = shouldRefreshPlaybackMetadata(
            localMetaData,
            node?.metadataState,
          )
          const needsThumbnail = Boolean(thumbnail) && !hasPersistedThumbnail(localMetaData)

          if (!needsMetadata && !needsThumbnail) return

          const metadata = needsMetadata
            ? await getRangeMetadata(currentTrack.track, url, signal)
            : localMetaData
          if (!metadata) return

          await persistMetadata(db, metadata, needsThumbnail ? thumbnail : undefined, signal)
          if (!signal.aborted) updateMetadataUpdate()
        }
      })().catch(error => {
        if (!signal.aborted) {
          console.error('Failed to refresh playback metadata:', error)
        }
      })

      return () => controller.abort()
    },
    [currentTrack, db, thumbnail, updateMetadataUpdate, url]
  )

}

export default useMetaData
