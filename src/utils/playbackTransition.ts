import type { QueuedTrack } from '../types/playQueue.ts'
import type { UiState } from '../types/ui.ts'

export const HANDOFF_LEAD_MS = 120
export const HANDOFF_MAX_OVERLAP_MS = 150
export const HANDOFF_ARM_WINDOW_MS = 3_000
export const STANDBY_BUFFER_SECONDS = 2
export const MEDIA_PROGRESS_TIMEOUT_MS = 15_000
export const MEDIA_SOURCE_MAX_RETRIES = 2
export const MEDIA_RETRY_DELAY_MS = 1_000
export const MAX_CONSECUTIVE_FAILED_TRACKS = 2

export type MediaErrorKind = 'aborted' | 'network' | 'decode' | 'source' | 'unknown'

export interface TerminalFailureState {
  trackKey: string
  slot: 'primary' | 'secondary'
  resumeTime: number
}

export const getTerminalFailureRestart = (
  failure: TerminalFailureState | null,
  selectedTrackKey: string,
) => failure?.trackKey === selectedTrackKey ? failure : null

export const getMediaErrorKind = (code?: number | null): MediaErrorKind => {
  if (code === 1) return 'aborted'
  if (code === 2) return 'network'
  if (code === 3) return 'decode'
  if (code === 4) return 'source'
  return 'unknown'
}

export const isRecoverableMediaError = (code?: number | null) => {
  const kind = getMediaErrorKind(code)
  return kind === 'network' || kind === 'source'
}

export const hasMediaProgress = (
  previousTime: number,
  currentTime: number,
  previousBufferedEnd: number,
  currentBufferedEnd: number,
) => (
  Math.abs(currentTime - previousTime) > 0.01
  || currentBufferedEnd - previousBufferedEnd > 0.05
)

export interface BufferedRange {
  start: number
  end: number
}

// standby 至少要有两秒可播放内容，避免刚交接就再次缓冲
export const hasEnoughStandbyBuffer = (
  readyState: number,
  duration: number,
  ranges: BufferedRange[],
  requiredSeconds = STANDBY_BUFFER_SECONDS,
) => {
  if (readyState < 3 || ranges.length === 0) return false

  const requiredEnd = Number.isFinite(duration) && duration > 0
    ? Math.min(duration, requiredSeconds)
    : requiredSeconds

  return ranges.some(range => range.start <= 0.05 && range.end >= requiredEnd)
}

// 按媒体时间和倍速计算交接定时器，定时器触发后仍需复核播放器状态
export const getHandoffDelayMs = (
  duration: number,
  currentTime: number,
  playbackRate: number,
  leadMs = HANDOFF_LEAD_MS,
) => {
  if (
    !Number.isFinite(duration)
    || !Number.isFinite(currentTime)
    || !Number.isFinite(playbackRate)
    || duration <= 0
    || currentTime < 0
    || playbackRate <= 0
  ) return undefined

  return Math.max(0, ((duration - currentTime) * 1000) / playbackRate - leadMs)
}

export interface AutomaticTarget {
  index: number
  track: QueuedTrack['track']
}

// repeat one 交给媒体元素原生 loop，其余模式在这里计算自动播放目标
export const getAutomaticTarget = (
  playQueue: QueuedTrack[],
  currentIndex: number,
  repeat: UiState['repeat'],
): AutomaticTarget | null => {
  if (repeat === 'one') return null

  const currentPosition = playQueue.findIndex(item => item.index === currentIndex)
  if (currentPosition < 0) return null

  const next = playQueue[currentPosition + 1]
  if (next) return { index: next.index, track: next.track }
  if (repeat === 'all' && playQueue[0]) {
    return { index: playQueue[0].index, track: playQueue[0].track }
  }

  return null
}

export type EndedTransition =
  | { action: 'none' }
  | { action: 'select'; autoPlay: boolean; index: number }

export type EndedSlotAction = 'advance' | 'cleanup-retiring' | 'wait-handoff' | 'ignore'

// 双播放器交接期间，旧元素 ended 只能清理，不能再次推进队列
export const getEndedSlotAction = (
  eventSlot: string,
  activeSlot: string,
  handoff?: { from: string, promoted: boolean } | null,
): EndedSlotAction => {
  if (handoff?.promoted && handoff.from === eventSlot) return 'cleanup-retiring'
  if (eventSlot !== activeSlot) return 'ignore'
  if (handoff?.from === eventSlot && !handoff.promoted) return 'wait-handoff'
  return 'advance'
}

// ended 是提前交接未命中时的降级路径
export const getEndedTransition = (
  playQueue: QueuedTrack[],
  currentIndex: number,
  repeat: UiState['repeat'],
): EndedTransition => {
  const automaticTarget = getAutomaticTarget(playQueue, currentIndex, repeat)
  if (automaticTarget) {
    return { action: 'select', autoPlay: true, index: automaticTarget.index }
  }

  const currentPosition = playQueue.findIndex(item => item.index === currentIndex)
  if (currentPosition < 0 || playQueue.length === 0 || repeat === 'one') {
    return { action: 'none' }
  }

  return { action: 'select', autoPlay: false, index: playQueue[0].index }
}

// 播放失败遵循循环模式，但连续失败达到上限时必须停止，避免列表循环无限请求。
export const getFailureTransition = (
  playQueue: QueuedTrack[],
  currentIndex: number,
  repeat: UiState['repeat'],
  consecutiveFailures: number,
): EndedTransition => {
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILED_TRACKS) return { action: 'none' }

  const target = getAutomaticTarget(playQueue, currentIndex, repeat)
  return target && target.index !== currentIndex
    ? { action: 'select', autoPlay: true, index: target.index }
    : { action: 'none' }
}
