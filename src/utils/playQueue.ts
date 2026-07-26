import type { Track } from '../types/file.ts'
import type { QueuedTrack } from '../types/playQueue.ts'

export const appendTracksToPlayQueue = (
  playQueue: QueuedTrack[],
  tracks: Track[],
): QueuedTrack[] => {
  if (tracks.length === 0) return playQueue

  // 队列索引可能因删除或随机播放而不连续，新增项应从当前最大索引之后开始。
  const nextIndex = playQueue.length > 0
    ? Math.max(...playQueue.map(item => item.index)) + 1
    : 0

  // 返回新数组，避免直接修改 Zustand 中保存的原队列。
  return [
    ...playQueue,
    ...tracks.map((track, offset) => ({ track, index: nextIndex + offset })),
  ]
}

export const insertTracksNextInPlayQueue = (
  playQueue: QueuedTrack[],
  currentIndex: number,
  tracks: Track[],
): QueuedTrack[] => {
  if (tracks.length === 0) return playQueue

  const nextIndex = playQueue.length > 0
    ? Math.max(...playQueue.map(item => item.index)) + 1
    : 0
  const queuedTracks = tracks.map((track, offset) => ({
    track,
    index: nextIndex + offset,
  }))
  const currentPosition = playQueue.findIndex(item => item.index === currentIndex)
  const insertPosition = currentPosition >= 0 ? currentPosition + 1 : playQueue.length

  // 实际播放顺序由数组位置决定；index 只作为队列项的稳定标识继续保持唯一。
  return [
    ...playQueue.slice(0, insertPosition),
    ...queuedTracks,
    ...playQueue.slice(insertPosition),
  ]
}
