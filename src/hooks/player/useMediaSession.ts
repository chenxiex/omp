import { useCallback, useEffect, useMemo, useRef } from 'react'
import usePlayerControl from './usePlayerControl'
import usePlayerStore from '@/store/usePlayerStore'
import { useShallow } from 'zustand/shallow'
import usePlayQueueStore from '@/store/usePlayQueueStore'

const defaultSkipTime = 10

const useMediaSession = (player: HTMLVideoElement | null) => {
  const [currentMetaData, cover, autoPlay] = usePlayerStore(
    useShallow(
      (state) => [
        state.currentMetaData,
        state.cover,
        state.autoPlay,
      ],
    ),
  )

  const controls = usePlayerControl(player)
  // action handler 始终调用最新的队列和播放器操作
  const controlsRef = useRef(controls)
  const playerRef = useRef(player)
  controlsRef.current = controls
  playerRef.current = player

  const playQueue = usePlayQueueStore.use.playQueue()
  const currentIndex = usePlayQueueStore.use.currentIndex()
  const currentTrack = useMemo(
    () => playQueue.find(item => item.index === currentIndex),
    [currentIndex, playQueue],
  )

  // 新源取得有效时长后再更新系统媒体进度
  const updatePositionState = useCallback(() => {
    const activePlayer = playerRef.current
    if (
      !('mediaSession' in navigator)
      || !activePlayer
      || !Number.isFinite(activePlayer.duration)
      || activePlayer.duration <= 0
      || !Number.isFinite(activePlayer.playbackRate)
      || activePlayer.playbackRate <= 0
    ) return

    navigator.mediaSession.setPositionState({
      duration: activePlayer.duration,
      playbackRate: activePlayer.playbackRate,
      position: Math.min(Math.max(activePlayer.currentTime, 0), activePlayer.duration),
    })
  }, [])

  // action handler 只随播放器页面挂载和卸载，不随 active slot 重建
  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    const setHandler = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler | null,
    ) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler)
      } catch (error) {
        console.warn(`Media Session action ${action} is not supported.`, error)
      }
    }

    setHandler('play', () => controlsRef.current.handleClickPlay())
    setHandler('pause', () => controlsRef.current.handleClickPause())
    setHandler('nexttrack', () => controlsRef.current.handleClickNext())
    setHandler('previoustrack', () => controlsRef.current.handleClickPrev())
    setHandler('seekbackward', details => {
      controlsRef.current.handleClickSeekbackward(details.seekOffset ?? defaultSkipTime)
    })
    setHandler('seekforward', details => {
      controlsRef.current.handleClickSeekforward(details.seekOffset ?? defaultSkipTime)
    })
    setHandler('seekto', details => {
      if (details.seekTime !== undefined) controlsRef.current.seekTo(details.seekTime)
    })

    return () => {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.setPositionState(undefined)
      setHandler('play', null)
      setHandler('pause', null)
      setHandler('nexttrack', null)
      setHandler('previoustrack', null)
      setHandler('seekbackward', null)
      setHandler('seekforward', null)
      setHandler('seekto', null)
    }
  }, [])

  // 歌曲变化时原位更新 metadata，避免主动终止 Media Session
  useEffect(() => {
    if (!('mediaSession' in navigator) || !currentTrack) return

    const metadataMatchesTrack = currentMetaData?.id === currentTrack.track.id
    navigator.mediaSession.metadata = new MediaMetadata({
      title: metadataMatchesTrack
        ? currentMetaData.common.title || currentTrack.track.name
        : currentTrack.track.name,
      artist: metadataMatchesTrack ? currentMetaData.common.artist : undefined,
      album: metadataMatchesTrack ? currentMetaData.common.album : undefined,
      artwork: [{ src: metadataMatchesTrack ? cover : './cover.svg' }],
    })
  }, [cover, currentMetaData, currentTrack])

  // 加载和缓冲期间沿用播放意图，保持系统通知为 playing
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = currentTrack
      ? (autoPlay ? 'playing' : 'paused')
      : 'none'
  }, [autoPlay, currentTrack])

  // 新源 metadata 就绪或开始播放时刷新系统进度
  useEffect(() => {
    if (!player) return
    updatePositionState()
    player.addEventListener('loadedmetadata', updatePositionState)
    player.addEventListener('playing', updatePositionState)
    player.addEventListener('pause', updatePositionState)

    return () => {
      player.removeEventListener('loadedmetadata', updatePositionState)
      player.removeEventListener('playing', updatePositionState)
      player.removeEventListener('pause', updatePositionState)
    }
  }, [player, updatePositionState])
}

export default useMediaSession
