import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Track } from '../types/file.ts'
import type { QueuedTrack } from '../types/playQueue.ts'
import { appendTracksToPlayQueue, insertTracksNextInPlayQueue } from './playQueue.ts'

const track = (id: string): Track => ({
  id,
  name: `${id}.mp3`,
  path: ['Music', `${id}.mp3`],
  size: 1,
})

describe('appendTracksToPlayQueue', () => {
  it('starts an empty queue at index zero', () => {
    assert.deepEqual(
      appendTracksToPlayQueue([], [track('one')]),
      [{ track: track('one'), index: 0 }],
    )
  })

  it('appends after the greatest existing index', () => {
    const queue: QueuedTrack[] = [
      { track: track('one'), index: 2 },
      { track: track('two'), index: 7 },
    ]

    assert.deepEqual(
      appendTracksToPlayQueue(queue, [track('three'), track('four')])
        .map(item => ({ id: item.track.id, index: item.index })),
      [
        { id: 'one', index: 2 },
        { id: 'two', index: 7 },
        { id: 'three', index: 8 },
        { id: 'four', index: 9 },
      ],
    )
  })

  it('does not mutate the original queue', () => {
    const queue: QueuedTrack[] = [{ track: track('one'), index: 0 }]
    const snapshot = structuredClone(queue)

    const result = appendTracksToPlayQueue(queue, [track('two')])

    assert.deepEqual(queue, snapshot)
    assert.notEqual(result, queue)
  })
})

describe('insertTracksNextInPlayQueue', () => {
  it('inserts tracks immediately after the current queue item', () => {
    const queue: QueuedTrack[] = [
      { track: track('one'), index: 2 },
      { track: track('two'), index: 7 },
      { track: track('three'), index: 4 },
    ]

    assert.deepEqual(
      insertTracksNextInPlayQueue(queue, 7, [track('next-one'), track('next-two')])
        .map(item => ({ id: item.track.id, index: item.index })),
      [
        { id: 'one', index: 2 },
        { id: 'two', index: 7 },
        { id: 'next-one', index: 8 },
        { id: 'next-two', index: 9 },
        { id: 'three', index: 4 },
      ],
    )
  })

  it('appends when there is no current queue item', () => {
    const queue: QueuedTrack[] = [{ track: track('one'), index: 3 }]

    assert.deepEqual(
      insertTracksNextInPlayQueue(queue, 99, [track('next')])
        .map(item => item.track.id),
      ['one', 'next'],
    )
  })

  it('creates the first queue item without starting playback', () => {
    assert.deepEqual(
      insertTracksNextInPlayQueue([], 0, [track('next')]),
      [{ track: track('next'), index: 0 }],
    )
  })
})
