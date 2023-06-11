import { create } from 'zustand'
import { PLayerStatus, PLayerAction } from '../type'

const usePlayerStore = create<PLayerStatus & PLayerAction>((set) => ({
  url: '',
  playing: false,
  loop: false,
  light: true,
  muted: false,
  currentTime: 0,
  duration: 0,
  containerIsHiding: true,
  updateUrl: (url) => set(() => ({ url: url })),
  updatePlaying: (playing) => set(() => ({ playing: playing })),
  updateLoop: (loop) => set(() => ({ loop: loop })),
  updateCurrentTime: (currentTime) => set(() => ({ currentTime: currentTime })),
  updateDuration: (duration) => set(() => ({ duration: duration })),
  updateContainerIsHiding: (containerIsHiding) => set(() => ({ containerIsHiding: containerIsHiding }))
}))

export default usePlayerStore