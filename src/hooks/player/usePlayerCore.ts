import { useEffect, useMemo, useRef, useState } from 'react'
import useHistoryStore from '@/store/useHistoryStore'
import usePlayQueueStore from '@/store/usePlayQueueStore'
import usePlayerStore from '@/store/usePlayerStore'
import useUiStore from '@/store/useUiStore'
import { isAudio } from '@/utils/checkFileType'
import {
  getAutomaticTarget,
  getEndedSlotAction,
  getEndedTransition,
  getHandoffDelayMs,
  HANDOFF_ARM_WINDOW_MS,
  HANDOFF_MAX_OVERLAP_MS,
  hasEnoughStandbyBuffer,
} from '@/utils/playbackTransition'
import {
  getTrackSourceKey,
  type ResolvedTrackSource,
} from '@/utils/trackSourceCache'
import { useShallow } from 'zustand/shallow'
import useMetaData from './useMetaData'
import useUrl from './useUrl'

export type PlayerSlotId = 'primary' | 'secondary'

export interface PlayerElements {
  primary: HTMLVideoElement | null
  secondary: HTMLVideoElement | null
}

type SlotPhase = 'empty' | 'loading' | 'standby' | 'active' | 'handoff' | 'retiring' | 'failed'

interface SlotRuntime {
  phase: SlotPhase
  source: ResolvedTrackSource | null
}

interface HandoffState {
  token: number
  from: PlayerSlotId
  to: PlayerSlotId
  targetIndex: number
  targetKey: string
  promoted: boolean
}

interface MediaEventHandlers {
  loadedMetadata: (slot: PlayerSlotId) => void
  canPlay: (slot: PlayerSlotId) => void
  playing: (slot: PlayerSlotId) => void
  pause: (slot: PlayerSlotId) => void
  waiting: (slot: PlayerSlotId) => void
  error: (slot: PlayerSlotId) => void
  timeUpdate: (slot: PlayerSlotId) => void
  progress: (slot: PlayerSlotId) => void
  seeking: (slot: PlayerSlotId) => void
  seeked: (slot: PlayerSlotId) => void
  rateChange: (slot: PlayerSlotId) => void
}

const otherSlot = (slot: PlayerSlotId): PlayerSlotId => (
  slot === 'primary' ? 'secondary' : 'primary'
)

const isAbortError = (error: unknown) => (
  typeof error === 'object'
  && error !== null
  && 'name' in error
  && error.name === 'AbortError'
)

const getBufferedRanges = (player: HTMLVideoElement) => {
  try {
    return Array.from(
      { length: player.buffered.length },
      (_, index) => ({
        start: player.buffered.start(index),
        end: player.buffered.end(index),
      }),
    )
  } catch {
    // 浏览器更新 TimeRanges 的瞬间可能使旧索引失效，下一次 progress 会重试
    return []
  }
}

const usePlayerCore = (players: PlayerElements) => {
  const [
    autoPlay,
    updateAutoPlay,
    updateIsLoading,
    updateCurrentTime,
    updateDuration,
  ] = usePlayerStore(
    useShallow(
      (state) => [
        state.autoPlay,
        state.updateAutoPlay,
        state.updateIsLoading,
        state.updateCurrentTime,
        state.updateDuration,
      ],
    ),
  )

  const playQueue = usePlayQueueStore.use.playQueue()
  const currentIndex = usePlayQueueStore.use.currentIndex()
  const updateCurrentIndex = usePlayQueueStore.use.updateCurrentIndex()
  const repeat = useUiStore(state => state.repeat)

  const currentPosition = useMemo(
    () => playQueue.findIndex(item => item.index === currentIndex),
    [currentIndex, playQueue],
  )
  const currentTrack = currentPosition >= 0 ? playQueue[currentPosition] : undefined
  const currentTrackKey = currentTrack ? getTrackSourceKey(currentTrack.track) : ''
  const automaticTarget = useMemo(
    () => getAutomaticTarget(playQueue, currentIndex, repeat),
    [currentIndex, playQueue, repeat],
  )
  const automaticTargetKey = automaticTarget
    ? getTrackSourceKey(automaticTarget.track)
    : ''

  const {
    accountKey,
    invalidateSource,
    resolveSource,
    retainSources,
  } = useUrl()

  const [activeSlot, setActiveSlot] = useState<PlayerSlotId>('primary')
  const [activeSource, setActiveSource] = useState<ResolvedTrackSource | null>(null)
  const [playingTrackKey, setPlayingTrackKey] = useState('')
  const [slotRevision, setSlotRevision] = useState(0)

  // Range 元数据与 thumbnail 只在歌曲成为 active 后按需读取。
  useMetaData(activeSource?.url ?? '', activeSource?.thumbnail)

  const playersRef = useRef(players)
  const activeSlotRef = useRef<PlayerSlotId>('primary')
  const repeatRef = useRef(repeat)
  const slotRuntimeRef = useRef<Record<PlayerSlotId, SlotRuntime>>({
    primary: { phase: 'empty', source: null },
    secondary: { phase: 'empty', source: null },
  })
  const selectionTokenRef = useRef(0)
  const prefetchTokenRef = useRef(0)
  const handoffSequenceRef = useRef(0)
  const handoffRef = useRef<HandoffState | null>(null)
  const handoffTimerRef = useRef<number | null>(null)
  const overlapTimerRef = useRef<number | null>(null)
  const recordedSourceRef = useRef('')

  playersRef.current = players
  repeatRef.current = repeat

  const getPlayer = (slot: PlayerSlotId) => playersRef.current[slot]

  const playerMatchesSlotSource = (slot: PlayerSlotId) => {
    const player = getPlayer(slot)
    const source = slotRuntimeRef.current[slot].source
    const expectedUrl = source ? new URL(source.url, document.baseURI).href : ''
    if (
      !player
      || !source
      || player.dataset.accountId !== source.accountId
      || player.dataset.trackKey !== source.trackKey
      || player.src !== expectedUrl
    ) return false

    // currentSrc 仍指向旧资源时，忽略旧资源最后到达的媒体事件
    return !player.currentSrc || player.currentSrc === expectedUrl
  }

  const clearHandoffTimer = () => {
    if (handoffTimerRef.current !== null) {
      window.clearTimeout(handoffTimerRef.current)
      handoffTimerRef.current = null
    }
  }

  const clearOverlapTimer = () => {
    if (overlapTimerRef.current !== null) {
      window.clearTimeout(overlapTimerRef.current)
      overlapTimerRef.current = null
    }
  }

  const markSlot = (slot: PlayerSlotId, phase: SlotPhase) => {
    slotRuntimeRef.current[slot].phase = phase
    const player = getPlayer(slot)
    if (player) player.dataset.slotPhase = phase
  }

  const resetSlot = (slot: PlayerSlotId, notify = true) => {
    const player = getPlayer(slot)
    markSlot(slot, 'empty')
    slotRuntimeRef.current[slot].source = null

    if (player) {
      player.pause()
      player.loop = false
      player.removeAttribute('src')
      player.removeAttribute('data-account-id')
      player.removeAttribute('data-track-key')
      player.load()
    }
    if (notify) setSlotRevision(value => value + 1)
  }

  const cancelHandoff = (cleanRetiring: boolean) => {
    clearHandoffTimer()
    clearOverlapTimer()
    const handoff = handoffRef.current
    handoffSequenceRef.current += 1
    handoffRef.current = null

    if (cleanRetiring && handoff?.promoted && handoff.from !== activeSlotRef.current) {
      resetSlot(handoff.from)
    }
  }

  const bindSource = (
    slot: PlayerSlotId,
    source: ResolvedTrackSource,
    phase: SlotPhase,
  ) => {
    const player = getPlayer(slot)
    if (!player) return false

    markSlot(slot, phase)
    slotRuntimeRef.current[slot].source = source
    player.dataset.accountId = source.accountId
    player.dataset.trackKey = source.trackKey
    player.preload = 'auto'
    player.loop = false
    player.src = source.url

    const uiState = useUiStore.getState()
    player.volume = Number.isFinite(uiState.volume / 100) ? uiState.volume / 100 : 0.8
    player.playbackRate = uiState.playbackRate
    player.load()
    setSlotRevision(value => value + 1)
    return true
  }

  const promoteSlot = (slot: PlayerSlotId, source: ResolvedTrackSource) => {
    const player = getPlayer(slot)
    if (!player) return

    activeSlotRef.current = slot
    setActiveSlot(slot)
    setActiveSource(source)
    updateCurrentTime(Number.isFinite(player.currentTime) ? player.currentTime : 0)
    updateDuration(Number.isFinite(player.duration) ? player.duration : 0)
  }

  const stopForCurrentFailure = (
    slot: PlayerSlotId,
    error: unknown,
    expectedTrackKey?: string,
  ) => {
    const source = slotRuntimeRef.current[slot].source
    const queueState = usePlayQueueStore.getState()
    const selected = queueState.playQueue.find(item => item.index === queueState.currentIndex)
    const targetKey = expectedTrackKey ?? (selected ? getTrackSourceKey(selected.track) : '')
    if (
      !source
      || !targetKey
      || source.trackKey !== targetKey
    ) return

    console.error('Failed to start or load the current track.', error)
    invalidateSource(source)
    cancelHandoff(true)
    resetSlot('primary')
    resetSlot('secondary')
    setActiveSource(null)
    setPlayingTrackKey('')
    updateAutoPlay(false)
    updateIsLoading(false)
  }

  const playCurrentSlot = (slot: PlayerSlotId, source: ResolvedTrackSource) => {
    const player = getPlayer(slot)
    if (!player) return

    void player.play().catch(error => {
      if (
        isAbortError(error)
        || activeSlotRef.current !== slot
        || player.dataset.trackKey !== source.trackKey
      ) return
      stopForCurrentFailure(slot, error)
    })
  }

  const finishRetiringSlot = (slot: PlayerSlotId) => {
    if (slot === activeSlotRef.current) return

    const handoff = handoffRef.current
    if (handoff?.from === slot) {
      clearOverlapTimer()
      handoffRef.current = null
    }
    resetSlot(slot)
  }

  const recordHistory = (slot: PlayerSlotId) => {
    const player = getPlayer(slot)
    const source = slotRuntimeRef.current[slot].source
    if (!player || !source) return

    const historyState = useHistoryStore.getState()
    const queueState = usePlayQueueStore.getState()
    const selected = queueState.playQueue.find(item => item.index === queueState.currentIndex)
    const historyKey = `${source.trackKey}\u0000${source.url}`
    if (
      selected
      && getTrackSourceKey(selected.track) === source.trackKey
      && historyState.historys !== null
      && recordedSourceRef.current !== historyKey
    ) {
      recordedSourceRef.current = historyKey
      historyState.insertHistory(selected.track)
    }
  }

  const promoteAutomaticHandoff = (handoff: HandoffState) => {
    const currentHandoff = handoffRef.current
    const source = slotRuntimeRef.current[handoff.to].source
    const player = getPlayer(handoff.to)
    if (
      !currentHandoff
      || currentHandoff.token !== handoff.token
      || currentHandoff.promoted
      || !source
      || !player
      || source.trackKey !== handoff.targetKey
    ) return

    currentHandoff.promoted = true
    markSlot(handoff.from, 'retiring')
    markSlot(handoff.to, 'active')
    promoteSlot(handoff.to, source)
    updateCurrentIndex(handoff.targetIndex)
    updateIsLoading(false)
    setPlayingTrackKey(handoff.targetKey)
    recordHistory(handoff.to)

    // 正常情况下旧歌会先自然结束；超时只用于限制异常重叠
    clearOverlapTimer()
    overlapTimerRef.current = window.setTimeout(() => {
      finishRetiringSlot(handoff.from)
    }, HANDOFF_MAX_OVERLAP_MS)
  }

  const standbyIsReady = (slot: PlayerSlotId, targetKey: string) => {
    const player = getPlayer(slot)
    const runtime = slotRuntimeRef.current[slot]
    if (
      !player
      || runtime.source?.accountId !== accountKey
      || runtime.source.trackKey !== targetKey
      || !playerMatchesSlotSource(slot)
    ) return false

    return hasEnoughStandbyBuffer(
      player.readyState,
      player.duration,
      getBufferedRanges(player),
    )
  }

  const beginAutomaticHandoff = () => {
    const from = activeSlotRef.current
    const activePlayer = getPlayer(from)
    const queueState = usePlayQueueStore.getState()
    const selected = queueState.playQueue.find(item => item.index === queueState.currentIndex)
    const target = getAutomaticTarget(
      queueState.playQueue,
      queueState.currentIndex,
      repeatRef.current,
    )
    if (!activePlayer || !selected || !target || !usePlayerStore.getState().autoPlay) return

    const targetKey = getTrackSourceKey(target.track)
    const to = otherSlot(from)
    if (
      !isAudio(selected.track.name)
      || !isAudio(target.track.name)
      || !standbyIsReady(to, targetKey)
      || handoffRef.current
    ) return

    const remainingMs = (
      (activePlayer.duration - activePlayer.currentTime) * 1000
    ) / activePlayer.playbackRate
    if (
      activePlayer.paused
      || activePlayer.seeking
      || activePlayer.ended
      || !Number.isFinite(activePlayer.playbackRate)
      || activePlayer.playbackRate <= 0
      || !Number.isFinite(remainingMs)
      || remainingMs <= 0
    ) return

    if (remainingMs > HANDOFF_MAX_OVERLAP_MS) {
      armHandoff(from)
      return
    }

    const standbyPlayer = getPlayer(to)
    if (!standbyPlayer) return

    const handoff: HandoffState = {
      token: ++handoffSequenceRef.current,
      from,
      to,
      targetIndex: target.index,
      targetKey,
      promoted: false,
    }
    handoffRef.current = handoff
    markSlot(to, 'handoff')

    void standbyPlayer.play().catch(error => {
      if (handoffRef.current?.token !== handoff.token || isAbortError(error)) return
      console.warn('Failed to start the prefetched track before ended.', error)
      handoffRef.current = null
      markSlot(to, 'standby')
      if (activePlayer.ended) stopForCurrentFailure(to, error, handoff.targetKey)
    })
  }

  const armHandoff = (slot: PlayerSlotId) => {
    if (slot !== activeSlotRef.current || handoffRef.current || handoffTimerRef.current !== null) {
      return
    }

    const player = getPlayer(slot)
    const queueState = usePlayQueueStore.getState()
    const selected = queueState.playQueue.find(item => item.index === queueState.currentIndex)
    const target = getAutomaticTarget(
      queueState.playQueue,
      queueState.currentIndex,
      repeatRef.current,
    )
    if (!player || !selected || !target || !usePlayerStore.getState().autoPlay) return

    const remainingMediaMs = (player.duration - player.currentTime) * 1000
    const targetKey = getTrackSourceKey(target.track)
    if (
      !isAudio(selected.track.name)
      || !isAudio(target.track.name)
      || player.paused
      || player.seeking
      || player.ended
      || !Number.isFinite(remainingMediaMs)
      || remainingMediaMs <= 0
      || remainingMediaMs > HANDOFF_ARM_WINDOW_MS
      || !standbyIsReady(otherSlot(slot), targetKey)
    ) return

    const delay = getHandoffDelayMs(player.duration, player.currentTime, player.playbackRate)
    if (delay === undefined) return

    handoffTimerRef.current = window.setTimeout(() => {
      handoffTimerRef.current = null
      beginAutomaticHandoff()
    }, delay)
  }

  const startEndedFallback = (slot: PlayerSlotId) => {
    const queueState = usePlayQueueStore.getState()
    const transition = getEndedTransition(
      queueState.playQueue,
      queueState.currentIndex,
      repeatRef.current,
    )
    if (transition.action === 'none') {
      updateAutoPlay(false)
      updateIsLoading(false)
      return
    }

    if (!transition.autoPlay) {
      updateAutoPlay(false)
      updateIsLoading(false)
      updateCurrentIndex(transition.index)
      return
    }

    const target = queueState.playQueue.find(item => item.index === transition.index)
    const to = otherSlot(slot)
    const standbyPlayer = getPlayer(to)
    const source = slotRuntimeRef.current[to].source
    const targetKey = target ? getTrackSourceKey(target.track) : ''

    if (standbyPlayer && source?.trackKey === targetKey) {
      const handoff: HandoffState = {
        token: ++handoffSequenceRef.current,
        from: slot,
        to,
        targetIndex: transition.index,
        targetKey,
        promoted: false,
      }
      handoffRef.current = handoff
      markSlot(to, 'handoff')
      updateIsLoading(true)
      void standbyPlayer.play().catch(error => {
        if (handoffRef.current?.token !== handoff.token || isAbortError(error)) return
        stopForCurrentFailure(to, error, handoff.targetKey)
      })
      return
    }

    updateIsLoading(true)
    updateCurrentIndex(transition.index)
  }

  // 当前选择变化时优先复用已经预加载的 slot
  useEffect(() => {
    const targetTrack = currentTrack?.track
    const targetKey = currentTrackKey
    const requestToken = ++selectionTokenRef.current

    if (!targetTrack || !targetKey || !accountKey) {
      cancelHandoff(true)
      resetSlot('primary')
      resetSlot('secondary')
      setActiveSource(null)
      setPlayingTrackKey('')
      updateAutoPlay(false)
      updateIsLoading(false)
      return
    }

    const currentSlot = activeSlotRef.current
    const currentPlayer = getPlayer(currentSlot)
    const currentRuntime = slotRuntimeRef.current[currentSlot]
    if (
      currentPlayer?.dataset.accountId === accountKey
      && currentPlayer.dataset.trackKey === targetKey
      && currentRuntime.source
    ) {
      currentPlayer.loop = repeatRef.current === 'one'
      setActiveSource(currentRuntime.source)
      return
    }

    cancelHandoff(true)
    clearHandoffTimer()
    setPlayingTrackKey('')
    updateIsLoading(true)

    const preparedSlot = (['primary', 'secondary'] as PlayerSlotId[]).find(slot => {
      const player = getPlayer(slot)
      return player?.dataset.accountId === accountKey && player.dataset.trackKey === targetKey
    })

    const activatePreparedSlot = (slot: PlayerSlotId, source: ResolvedTrackSource) => {
      const outgoing = activeSlotRef.current
      const outgoingPlayer = getPlayer(outgoing)
      markSlot(slot, usePlayerStore.getState().autoPlay ? 'loading' : 'active')
      promoteSlot(slot, source)
      getPlayer(slot)!.loop = repeatRef.current === 'one'

      if (outgoing !== slot) {
        markSlot(outgoing, 'retiring')
        outgoingPlayer?.pause()
        resetSlot(outgoing)
      }

      if (usePlayerStore.getState().autoPlay) {
        playCurrentSlot(slot, source)
      } else if ((getPlayer(slot)?.readyState ?? 0) >= 3) {
        updateIsLoading(false)
      }
    }

    if (preparedSlot) {
      const source = slotRuntimeRef.current[preparedSlot].source
      if (source) activatePreparedSlot(preparedSlot, source)
      return
    }

    const outgoing = activeSlotRef.current
    const outgoingPlayer = getPlayer(outgoing)
    const targetSlot = slotRuntimeRef.current[outgoing].source ? otherSlot(outgoing) : outgoing
    if (targetSlot !== outgoing) {
      markSlot(outgoing, 'retiring')
      outgoingPlayer?.pause()
      if (slotRuntimeRef.current[targetSlot].phase !== 'empty') resetSlot(targetSlot)
    }

    void resolveSource(targetTrack)
      .then(source => {
        const queueState = usePlayQueueStore.getState()
        const selected = queueState.playQueue.find(item => item.index === queueState.currentIndex)
        if (
          selectionTokenRef.current !== requestToken
          || !selected
          || source.accountId !== accountKey
          || source.trackKey !== getTrackSourceKey(selected.track)
        ) return

        if (!bindSource(targetSlot, source, 'loading')) return
        promoteSlot(targetSlot, source)
        getPlayer(targetSlot)!.loop = repeatRef.current === 'one'
        if (outgoing !== targetSlot) resetSlot(outgoing)

        if (usePlayerStore.getState().autoPlay) {
          playCurrentSlot(targetSlot, source)
        } else if ((getPlayer(targetSlot)?.readyState ?? 0) >= 3) {
          updateIsLoading(false)
        }
      })
      .catch(error => {
        if (selectionTokenRef.current !== requestToken || isAbortError(error)) return
        markSlot(targetSlot, 'failed')
        slotRuntimeRef.current[targetSlot].source = {
          accountId: accountKey,
          trackId: targetTrack.id,
          trackKey: targetKey,
          url: '',
          fetchedAt: Date.now(),
          remoteTrack: targetTrack,
        }
        stopForCurrentFailure(targetSlot, error)
      })
    // 只按歌曲身份和媒体元素变化换源，cTag 更新不会重新加载正在播放的歌曲
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey, currentTrackKey, players.primary, players.secondary, resolveSource])

  // repeat one 使用原生 loop，避免产生 ended 空窗
  useEffect(() => {
    const player = getPlayer(activeSlotRef.current)
    if (player) player.loop = repeat === 'one'
  }, [activeSlot, repeat])

  // 播放意图变化时同时约束两个 slot，避免重叠窗口内漏停另一个元素
  useEffect(() => {
    const slot = activeSlotRef.current
    const player = getPlayer(slot)
    const source = slotRuntimeRef.current[slot].source

    if (!autoPlay) {
      clearHandoffTimer()
      const handoff = handoffRef.current
      if (handoff?.promoted) {
        getPlayer(handoff.from)?.pause()
        finishRetiringSlot(handoff.from)
      } else if (handoff) {
        getPlayer(handoff.to)?.pause()
        markSlot(handoff.to, 'standby')
        handoffRef.current = null
      }
      player?.pause()
      return
    }

    const queueState = usePlayQueueStore.getState()
    const selected = queueState.playQueue.find(item => item.index === queueState.currentIndex)
    if (
      player
      && source
      && selected
      && player.paused
      && source.trackKey === getTrackSourceKey(selected.track)
      && slotRuntimeRef.current[slot].phase !== 'standby'
      && slotRuntimeRef.current[slot].phase !== 'retiring'
    ) playCurrentSlot(slot, source)
    // 播放器及 source 由 slot 状态维护，歌曲切换由主 effect 负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, activeSlot, currentTrackKey])

  // active 真正开始播放后滚动准备下一首音频
  useEffect(() => {
    const pendingHandoff = handoffRef.current
    if (
      pendingHandoff
      && !pendingHandoff.promoted
      && pendingHandoff.targetKey !== automaticTargetKey
    ) {
      handoffRef.current = null
      getPlayer(pendingHandoff.to)?.pause()
      resetSlot(pendingHandoff.to)
    }

    const activeRuntime = slotRuntimeRef.current[activeSlotRef.current]
    const activeTrack = currentTrack?.track
    const nextTrack = automaticTarget?.track
    const canPrefetch = Boolean(
      accountKey
      && activeTrack
      && nextTrack
      && playingTrackKey === currentTrackKey
      && activeRuntime.source?.trackKey === currentTrackKey
      && isAudio(activeTrack.name)
      && isAudio(nextTrack.name),
    )

    retainSources([
      ...(activeTrack ? [activeTrack] : []),
      ...(canPrefetch && nextTrack ? [nextTrack] : []),
    ])

    const standbySlot = otherSlot(activeSlotRef.current)
    const standbyRuntime = slotRuntimeRef.current[standbySlot]
    if (!canPrefetch || !nextTrack) {
      prefetchTokenRef.current += 1
      if (standbyRuntime.phase === 'standby' || standbyRuntime.phase === 'loading') {
        resetSlot(standbySlot)
      }
      return
    }

    if (standbyRuntime.phase === 'retiring' || handoffRef.current?.promoted) return
    if (
      standbyRuntime.source?.accountId === accountKey
      && standbyRuntime.source.trackKey === automaticTargetKey
    ) return

    const requestToken = ++prefetchTokenRef.current
    if (standbyRuntime.phase !== 'empty') resetSlot(standbySlot)

    void resolveSource(nextTrack)
      .then(source => {
        const queueState = usePlayQueueStore.getState()
        const expected = getAutomaticTarget(
          queueState.playQueue,
          queueState.currentIndex,
          repeatRef.current,
        )
        if (
          prefetchTokenRef.current !== requestToken
          || activeSlotRef.current === standbySlot
          || !expected
          || source.accountId !== accountKey
          || source.trackKey !== getTrackSourceKey(expected.track)
        ) return

        bindSource(standbySlot, source, 'standby')
      })
      .catch(error => {
        if (prefetchTokenRef.current !== requestToken || isAbortError(error)) return
        console.warn('Failed to preload the next track.', error)
        markSlot(standbySlot, 'failed')
      })
    // slotRevision 用于 retiring 清理后立即启动下一轮预加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    accountKey,
    activeSlot,
    automaticTargetKey,
    currentTrackKey,
    playingTrackKey,
    resolveSource,
    retainSources,
    slotRevision,
  ])

  const eventHandlersRef = useRef<MediaEventHandlers>({
    loadedMetadata: () => undefined,
    canPlay: () => undefined,
    playing: () => undefined,
    pause: () => undefined,
    waiting: () => undefined,
    error: () => undefined,
    timeUpdate: () => undefined,
    progress: () => undefined,
    seeking: () => undefined,
    seeked: () => undefined,
    rateChange: () => undefined,
  })

  eventHandlersRef.current = {
    loadedMetadata: slot => {
      const player = getPlayer(slot)
      if (slot === activeSlotRef.current && player && playerMatchesSlotSource(slot)) {
        updateDuration(Number.isFinite(player.duration) ? player.duration : 0)
      }
    },
    canPlay: slot => {
      const player = getPlayer(slot)
      if (!playerMatchesSlotSource(slot)) return
      if (
        slot === activeSlotRef.current
        && player
        && !usePlayerStore.getState().autoPlay
      ) updateIsLoading(false)
      if (slot !== activeSlotRef.current) armHandoff(activeSlotRef.current)
    },
    playing: slot => {
      if (!playerMatchesSlotSource(slot)) return
      const handoff = handoffRef.current
      if (handoff?.to === slot && !handoff.promoted) {
        if (!usePlayerStore.getState().autoPlay) {
          getPlayer(slot)?.pause()
          markSlot(slot, 'standby')
          handoffRef.current = null
          return
        }
        promoteAutomaticHandoff(handoff)
        return
      }

      if (slot !== activeSlotRef.current) {
        if (slotRuntimeRef.current[slot].phase !== 'retiring') getPlayer(slot)?.pause()
        return
      }
      const source = slotRuntimeRef.current[slot].source
      const queueState = usePlayQueueStore.getState()
      const selected = queueState.playQueue.find(item => item.index === queueState.currentIndex)
      if (!source || !selected || source.trackKey !== getTrackSourceKey(selected.track)) return

      markSlot(slot, 'active')
      updateIsLoading(false)
      setPlayingTrackKey(source.trackKey)
      recordHistory(slot)
      armHandoff(slot)
    },
    pause: slot => {
      clearHandoffTimer()
      if (slot !== activeSlotRef.current || slotRuntimeRef.current[slot].phase !== 'active') return

      const player = getPlayer(slot)
      if (!player || player.ended || !player.paused) return
      if (handoffRef.current?.from === slot && !handoffRef.current.promoted) {
        if (!usePlayerStore.getState().autoPlay) {
          getPlayer(handoffRef.current.to)?.pause()
          markSlot(handoffRef.current.to, 'standby')
          handoffRef.current = null
          updateIsLoading(false)
        }
        return
      }

      // 浏览器最终保持暂停时同步真实状态，避免通知继续虚假走动
      if (usePlayerStore.getState().autoPlay) updateAutoPlay(false)
      updateIsLoading(false)
    },
    waiting: slot => {
      if (slot !== activeSlotRef.current) return
      clearHandoffTimer()
      if (usePlayerStore.getState().autoPlay) updateIsLoading(true)
    },
    error: slot => {
      if (!playerMatchesSlotSource(slot)) return
      if (slot === activeSlotRef.current) {
        stopForCurrentFailure(slot, getPlayer(slot)?.error)
      } else if (slotRuntimeRef.current[slot].phase === 'retiring') {
        finishRetiringSlot(slot)
      } else {
        console.warn('The standby media source failed to preload.', getPlayer(slot)?.error)
        const source = slotRuntimeRef.current[slot].source
        if (!source) return
        invalidateSource(source)
        resetSlot(slot, false)
        markSlot(slot, 'failed')
      }
    },
    timeUpdate: slot => {
      const player = getPlayer(slot)
      if (slot !== activeSlotRef.current || !player || !playerMatchesSlotSource(slot)) return
      updateCurrentTime(player.currentTime)
      armHandoff(slot)
    },
    progress: slot => {
      if (!playerMatchesSlotSource(slot)) return
      if (slot !== activeSlotRef.current) armHandoff(activeSlotRef.current)
    },
    seeking: slot => {
      if (slot === activeSlotRef.current) clearHandoffTimer()
    },
    seeked: slot => {
      if (slot === activeSlotRef.current) armHandoff(slot)
    },
    rateChange: slot => {
      if (slot !== activeSlotRef.current) return
      clearHandoffTimer()
      armHandoff(slot)
    },
  }

  // 两个元素长期挂载，所有事件都按 slot 验证身份
  useEffect(() => {
    const cleanups = (['primary', 'secondary'] as PlayerSlotId[]).flatMap(slot => {
      const player = players[slot]
      if (!player) return []

      const listeners = {
        loadedmetadata: () => eventHandlersRef.current.loadedMetadata(slot),
        canplay: () => eventHandlersRef.current.canPlay(slot),
        playing: () => eventHandlersRef.current.playing(slot),
        pause: () => eventHandlersRef.current.pause(slot),
        waiting: () => eventHandlersRef.current.waiting(slot),
        error: () => eventHandlersRef.current.error(slot),
        timeupdate: () => eventHandlersRef.current.timeUpdate(slot),
        progress: () => eventHandlersRef.current.progress(slot),
        seeking: () => eventHandlersRef.current.seeking(slot),
        seeked: () => eventHandlersRef.current.seeked(slot),
        ratechange: () => eventHandlersRef.current.rateChange(slot),
      }

      for (const [event, listener] of Object.entries(listeners)) {
        player.addEventListener(event, listener)
      }

      return [() => {
        for (const [event, listener] of Object.entries(listeners)) {
          player.removeEventListener(event, listener)
        }
      }]
    })

    return () => cleanups.forEach(cleanup => cleanup())
  }, [players])

  useEffect(() => () => {
    clearHandoffTimer()
    clearOverlapTimer()
  }, [])

  const onEnded = (slot: PlayerSlotId) => {
    clearHandoffTimer()
    const handoff = handoffRef.current
    const action = getEndedSlotAction(slot, activeSlotRef.current, handoff)
    if (action === 'cleanup-retiring') {
      finishRetiringSlot(slot)
      return
    }
    if (action === 'ignore') return
    if (action === 'wait-handoff') {
      updateIsLoading(true)
      return
    }

    setPlayingTrackKey('')
    startEndedFallback(slot)
  }

  return {
    activePlayer: players[activeSlot],
    activeSlot,
    onEnded,
  }
}

export default usePlayerCore
