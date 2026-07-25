import { useCallback, useMemo } from 'react'
import useFullscreen from '@/hooks/ui/useFullscreen'
import useUiStore from '@/store/useUiStore'
import type { PlayerSlotId } from '@/hooks/player/usePlayerCore'
import { animated, useSpring } from '@react-spring/web'

interface VideoPlayerProps {
  activeSlot: PlayerSlotId
  onEnded: (slot: PlayerSlotId) => void
  setPlayer: (slot: PlayerSlotId, player: HTMLVideoElement | null) => void
}

const VideoPlayer = ({ activeSlot, onEnded, setPlayer }: VideoPlayerProps) => {
  const videoViewIsShow = useUiStore(state => state.videoViewIsShow)
  const { handleClickFullscreen } = useFullscreen()

  const [{ top, borderRadius }, api] = useSpring(() => ({
    from: {
      top: videoViewIsShow ? '0' : '100dvh',
      borderRadius: videoViewIsShow ? '0' : '0.5rem',
    },
  }))

  const show = () => api.start({
    to: { top: '0', borderRadius: '0' },
  })

  const hide = () => {
    api.start({
      to: { top: '100dvh' },
    })
  }

  useMemo(
    () => videoViewIsShow ? show() : hide(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videoViewIsShow],
  )

  const primaryRef = useCallback(
    (player: HTMLVideoElement | null) => setPlayer('primary', player),
    [setPlayer],
  )
  const secondaryRef = useCallback(
    (player: HTMLVideoElement | null) => setPlayer('secondary', player),
    [setPlayer],
  )

  const renderPlayer = (
    slot: PlayerSlotId,
    ref: (player: HTMLVideoElement | null) => void,
  ) => (
    <video
      width='100%'
      height='100%'
      preload='auto'
      ref={ref}
      onEnded={() => onEnded(slot)}
      onDoubleClick={() => handleClickFullscreen()}
      style={{
        position: 'absolute',
        inset: 0,
        opacity: activeSlot === slot ? 1 : 0,
        pointerEvents: activeSlot === slot ? 'auto' : 'none',
      }}
    />
  )

  return (
    <animated.div
      style={{
        width: '100%',
        height: '100dvh',
        position: 'fixed',
        backgroundColor: 'black',
        top,
        borderRadius,
      }}
    >
      {renderPlayer('primary', primaryRef)}
      {renderPlayer('secondary', secondaryRef)}
    </animated.div>
  )
}

export default VideoPlayer
