import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '../types/file.ts'
import {
  TRACK_SOURCE_MAX_AGE_MS,
  TrackSourceCache,
} from './trackSourceCache.ts'

const track = (id: string): Track => ({
  id,
  name: `${id}.mp3`,
  path: ['Music', `${id}.mp3`],
  size: 1,
  cTag: `ctag-${id}`,
})

const fetched = (item: Track) => ({
  url: `https://download.test/${item.id}`,
  remoteTrack: item,
})

test('deduplicates in-flight requests and reuses a fresh source', async () => {
  let calls = 0
  let complete!: () => void
  const gate = new Promise<void>(resolve => { complete = resolve })
  const cache = new TrackSourceCache(async item => {
    calls += 1
    await gate
    return fetched(item)
  })
  const item = track('one')

  const first = cache.resolve('account', item)
  const second = cache.resolve('account', item)
  complete()

  assert.equal(await first, await second)
  assert.equal((await cache.resolve('account', item)).url, 'https://download.test/one')
  assert.equal(calls, 1)
})

test('separates accounts and refreshes expired sources', async () => {
  let now = 0
  let calls = 0
  const cache = new TrackSourceCache(async item => {
    calls += 1
    return { ...fetched(item), url: `${fetched(item).url}/${calls}` }
  }, () => now)
  const item = track('one')

  assert.equal((await cache.resolve('a', item)).url, 'https://download.test/one/1')
  assert.equal((await cache.resolve('b', item)).url, 'https://download.test/one/2')
  now = TRACK_SOURCE_MAX_AGE_MS
  assert.equal((await cache.resolve('a', item)).url, 'https://download.test/one/3')
})

test('retains only the current and next sources and aborts stale work', async () => {
  const aborted: string[] = []
  const cache = new TrackSourceCache((item, signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => {
      aborted.push(item.id)
      reject(signal.reason)
    }, { once: true })
  }))
  const current = track('current')
  const oldNext = track('old-next')
  const newNext = track('new-next')

  void cache.resolve('account', current).catch(() => undefined)
  void cache.resolve('account', oldNext).catch(() => undefined)
  cache.retain('account', [current, newNext])

  assert.deepEqual(aborted, ['old-next'])
})

test('does not publish a source after its entry was cancelled', async () => {
  let complete!: (value: ReturnType<typeof fetched>) => void
  const item = track('stale')
  const cache = new TrackSourceCache(() => new Promise(resolve => { complete = resolve }))

  const pending = cache.resolve('account', item)
  cache.retain('account', [])
  complete(fetched(item))

  assert.equal((await pending).trackId, 'stale')
  assert.equal(cache.peek('account', item), undefined)
})

test('preserves the remote track version in the resolved source', async () => {
  const item = track('one')
  const updated = { ...item, cTag: 'new-ctag' }
  const thumbnail = {
    width: 800,
    height: 800,
    url: 'https://thumbnail.test/one',
  }
  const cache = new TrackSourceCache(async () => ({
    ...fetched(updated),
    thumbnail,
  }))

  const source = await cache.resolve('account', item)

  assert.equal(source.remoteTrack.cTag, 'new-ctag')
  assert.equal(source.accountId, 'account')
  assert.equal(source.thumbnail, thumbnail)
})

test('invalidates a media URL that failed after Graph resolution', async () => {
  let calls = 0
  const item = track('one')
  const cache = new TrackSourceCache(async value => {
    calls += 1
    return { ...fetched(value), url: `${fetched(value).url}/${calls}` }
  })

  assert.equal((await cache.resolve('account', item)).url, 'https://download.test/one/1')
  cache.invalidate('account', item)
  assert.equal((await cache.resolve('account', item)).url, 'https://download.test/one/2')
})
