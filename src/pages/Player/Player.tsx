import { useCallback, useState } from 'react'
import { Box } from '@mui/material'
import useUiStore from '@/store/useUiStore'
import useMediaSession from '@/hooks/player/useMediaSession'
import usePlayerCore from '@/hooks/player/usePlayerCore'
import VideoPlayer from './VideoPlayer'
import Audio from './Audio/Audio'
import PlayerControl from './PlayerControl'
import PlayQueue from './PlayQueue'
import VideoPlayerTopbar from './VideoPlayerTopbar'
import type { PlayerElements, PlayerSlotId } from '@/hooks/player/usePlayerCore'

const Player = () => {

  const controlIsShow = useUiStore((state) => state.controlIsShow)

  // 两个媒体元素长期挂载，切歌时只交换 active/standby 角色
  const [players, setPlayers] = useState<PlayerElements>({
    primary: null,
    secondary: null,
  })
  const setPlayer = useCallback((
    slot: PlayerSlotId,
    player: HTMLVideoElement | null,
  ) => {
    setPlayers(previous => (
      previous[slot] === player ? previous : { ...previous, [slot]: player }
    ))
  }, [])

  const { activePlayer, activeSlot, onEnded } = usePlayerCore(players)

  // 向 mediaSession 发送当前播放进度
  useMediaSession(activePlayer)

  return (
    <>
      <VideoPlayer
        activeSlot={activeSlot}
        onEnded={onEnded}
        setPlayer={setPlayer}
      />
      <VideoPlayerTopbar />
      <Box
        sx={{
          position: 'fixed',
          padding: '0 0.5rem 0.5rem 0.5rem',
          transform: controlIsShow ? 'none' : 'translateY(8rem)',
          transition: 'all 0.2s ease-out',
          bottom: 0,
          width: '100%',
        }}
      >
        <PlayerControl player={activePlayer} />
      </Box>
      <Audio player={activePlayer} />
      <PlayQueue />
    </>
  )
}

export default Player
