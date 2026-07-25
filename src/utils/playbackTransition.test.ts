import assert from 'node:assert/strict'
import test from 'node:test'
import type { QueuedTrack } from '../types/playQueue.ts'
import {
  getAutomaticTarget,
  getEndedTransition,
  getEndedSlotAction,
  getFailureTransition,
  getHandoffDelayMs,
  getMediaErrorKind,
  getTerminalFailureRestart,
  hasMediaProgress,
  hasEnoughStandbyBuffer,
  isRecoverableMediaError,
  MAX_CONSECUTIVE_FAILED_TRACKS,
  MEDIA_PROGRESS_TIMEOUT_MS,
  MEDIA_SOURCE_MAX_RETRIES,
  type TerminalFailureState,
} from './playbackTransition.ts'

const queue: QueuedTrack[] = ['one', 'two'].map((id, index) => ({
  index,
  track: {
    id,
    name: `${id}.mp3`,
    path: ['Music', `${id}.mp3`],
    size: 1,
  },
}))

test('requires future data and two seconds buffered from the start', () => {
  assert.equal(hasEnoughStandbyBuffer(2, 180, [{ start: 0, end: 20 }]), false)
  assert.equal(hasEnoughStandbyBuffer(3, 180, [{ start: 0, end: 1.9 }]), false)
  assert.equal(hasEnoughStandbyBuffer(3, 180, [{ start: 0, end: 2 }]), true)
})

test('accepts a fully buffered track shorter than two seconds', () => {
  assert.equal(hasEnoughStandbyBuffer(3, 1.5, [{ start: 0, end: 1.5 }]), true)
})

test('calculates the handoff delay using playback rate and lead time', () => {
  assert.equal(getHandoffDelayMs(100, 98, 2), 880)
  assert.equal(getHandoffDelayMs(100, 99.95, 1), 0)
  assert.equal(getHandoffDelayMs(Number.NaN, 0, 1), undefined)
})

test('selects the next automatic target for queue and repeat modes', () => {
  assert.equal(getAutomaticTarget(queue, 0, 'off')?.index, 1)
  assert.equal(getAutomaticTarget(queue, 1, 'off'), null)
  assert.equal(getAutomaticTarget(queue, 1, 'all')?.index, 0)
  assert.equal(getAutomaticTarget(queue, 0, 'one'), null)
})

test('falls back after ended without advancing twice', () => {
  assert.deepEqual(getEndedTransition(queue, 0, 'off'), {
    action: 'select',
    autoPlay: true,
    index: 1,
  })
  assert.deepEqual(getEndedTransition(queue, 1, 'off'), {
    action: 'select',
    autoPlay: false,
    index: 0,
  })
  assert.deepEqual(getEndedTransition(queue, 1, 'all'), {
    action: 'select',
    autoPlay: true,
    index: 0,
  })
  assert.deepEqual(getEndedTransition(queue, 1, 'one'), { action: 'none' })
})

test('does not advance again when the retiring slot ends', () => {
  assert.equal(getEndedSlotAction('primary', 'secondary', {
    from: 'primary',
    promoted: true,
  }), 'cleanup-retiring')
  assert.equal(getEndedSlotAction('primary', 'primary', {
    from: 'primary',
    promoted: false,
  }), 'wait-handoff')
  assert.equal(getEndedSlotAction('secondary', 'primary', null), 'ignore')
  assert.equal(getEndedSlotAction('primary', 'primary', null), 'advance')
})

test('classifies only network and source media errors as recoverable', () => {
  assert.equal(getMediaErrorKind(1), 'aborted')
  assert.equal(getMediaErrorKind(2), 'network')
  assert.equal(getMediaErrorKind(3), 'decode')
  assert.equal(getMediaErrorKind(4), 'source')
  assert.equal(getMediaErrorKind(undefined), 'unknown')
  assert.equal(isRecoverableMediaError(2), true)
  assert.equal(isRecoverableMediaError(4), true)
  assert.equal(isRecoverableMediaError(1), false)
  assert.equal(isRecoverableMediaError(3), false)
})

test('uses the agreed recovery limits', () => {
  assert.equal(MEDIA_PROGRESS_TIMEOUT_MS, 15_000)
  assert.equal(MEDIA_SOURCE_MAX_RETRIES, 2)
  assert.equal(MAX_CONSECUTIVE_FAILED_TRACKS, 2)
})

test('recognizes playback or buffer growth as real media progress', () => {
  assert.equal(hasMediaProgress(10, 10.02, 20, 20), true)
  assert.equal(hasMediaProgress(10, 10, 20, 20.06), true)
  assert.equal(hasMediaProgress(10, 10.005, 20, 20.02), false)
})

test('advances a failed track according to repeat mode and stops after two failures', () => {
  assert.deepEqual(getFailureTransition(queue, 0, 'off', 1), {
    action: 'select',
    autoPlay: true,
    index: 1,
  })
  assert.deepEqual(getFailureTransition(queue, 1, 'off', 1), { action: 'none' })
  assert.deepEqual(getFailureTransition(queue, 1, 'all', 1), {
    action: 'select',
    autoPlay: true,
    index: 0,
  })
  assert.deepEqual(getFailureTransition(queue, 0, 'one', 1), { action: 'none' })
  assert.deepEqual(getFailureTransition(queue, 0, 'all', 2), { action: 'none' })
  assert.deepEqual(getFailureTransition(queue.slice(0, 1), 0, 'all', 1), { action: 'none' })
})

test('restarts a terminal failure with its original slot and saved position', () => {
  const failure: TerminalFailureState = {
    trackKey: 'id:first',
    slot: 'secondary',
    resumeTime: 73.5,
  }

  assert.deepEqual(getTerminalFailureRestart(failure, 'id:first'), failure)
  assert.equal(getTerminalFailureRestart(failure, 'id:other'), null)
  assert.equal(getTerminalFailureRestart(null, 'id:first'), null)
})
