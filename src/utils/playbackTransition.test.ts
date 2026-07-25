import assert from 'node:assert/strict'
import test from 'node:test'
import type { QueuedTrack } from '../types/playQueue.ts'
import {
  getAutomaticTarget,
  getEndedTransition,
  getEndedSlotAction,
  getHandoffDelayMs,
  hasEnoughStandbyBuffer,
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
