import { useNavigate, useParams } from 'react-router-dom'
import useUser from '@/hooks/graph/useUser'
import useDb from '@/hooks/useDb'
import { useLiveQuery } from 'dexie-react-hooks'
import usePlayQueueStore from '@/store/usePlayQueueStore'
import usePlayerStore from '@/store/usePlayerStore'
import { Box, Typography, IconButton, Grid, CardMedia, ListItem, ListItemButton, ListItemText, ListItemIcon } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import Loading from '../Loading'
import { useLingui } from '@lingui/react/macro'
import useUiStore from '@/store/useUiStore'
import useCreateImageUrl from '@/hooks/useCreateImageUrl'
import { CSSProperties, useMemo, useState } from 'react'
import { AutoSizer } from 'react-virtualized'
import { FixedSizeList } from 'react-window'
import { MetaData } from '@/types/metaData'
import { FileNode } from '@/types/file'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import ShuffleIcon from '@mui/icons-material/Shuffle'
import shufflePlayQueue from '@/utils/shufflePlayQueue'
import { fileNodeToTrack } from '@/utils/track'
import LibrarySongMenu, {
  LibrarySongMenuButton,
  LibrarySongMenuPosition,
  LibrarySongMenuTarget,
} from '@/components/CommonList/LibrarySongMenu'

const SEPARATOR = '\u001f'

const AlbumDetail = () => {
  const params = useParams<{ albumartists: string, album: string }>()
  const { t } = useLingui()
  const navigate = useNavigate()
  const { account } = useUser()
  const db = useDb(account)

  const { albumartists, album } = useMemo(() => ({
    albumartists: decodeURIComponent(params.albumartists || '').split(SEPARATOR),
    album: decodeURIComponent(params.album || ''),
  }), [params])

  const shuffle = useUiStore.use.shuffle()
  const updateShuffle = useUiStore.use.updateShuffle()
  const updatePlayQueue = usePlayQueueStore.use.updatePlayQueue()
  const updateCurrentIndex = usePlayQueueStore.use.updateCurrentIndex()
  const updateAutoPlay = usePlayerStore.use.updateAutoPlay()
  const [menuTarget, setMenuTarget] = useState<LibrarySongMenuTarget | null>(null)

  const fileNodes = useLiveQuery(async () => await db?.nodes.where('type').equals('audio').toArray(), [db])
  const fileNodeIds = useMemo(() => fileNodes?.map(node => node.id) ?? [], [fileNodes])

  const songs = useLiveQuery(
    async () => {
      if (!db)
        return []

      if (fileNodeIds.length === 0) {
        return []
      }

      if (albumartists[0] === '_NO_ARTIST_') {
        return db.metadata
          .where('common.album')
          .equals(album)
          .filter(song => fileNodeIds.includes(song.id))
          .toArray()
          .then(songs => songs.sort((a, b) => {
            const diskA = a.common.disk?.no ?? 1
            const diskB = b.common.disk?.no ?? 1

            if (diskA !== diskB) {
              return diskA - diskB
            }

            return (a.common.track.no ?? 0) - (b.common.track.no ?? 0)
          }))
      }

      return db.metadata
        .where('common.album')
        .equals(album)
        .filter(song => fileNodeIds.includes(song.id) && albumartists.every(artist => song.common.albumartists?.includes(artist)))
        .toArray()
        .then(songs => songs.sort((a, b) => {
          const diskA = a.common.disk?.no ?? 1
          const diskB = b.common.disk?.no ?? 1

          if (diskA !== diskB) {
            return diskA - diskB
          }

          return (a.common.track.no ?? 0) - (b.common.track.no ?? 0)
        }))
    },
    [db, albumartists, album, fileNodeIds],
    []
  )

  const songItems = useMemo(() => {
    const nodeMap = new Map(fileNodes?.map(node => [node.id, node]))

    // 菜单需要 FileNode；在这里按专辑曲序与元数据配对，播放和菜单共用同一索引。
    return songs
      ?.map(song => {
        const node = nodeMap.get(song.id)
        return node ? { node, song } : undefined
      })
      .filter((item): item is { node: FileNode; song: MetaData } => item !== undefined)
      ?? []
  }, [fileNodes, songs])

  const albumInfo = useMemo(() => songItems[0]?.song, [songItems])
  const coverUrl = useCreateImageUrl(db, albumInfo)

  const totalDiscs = useMemo(() => {
    if (songItems.length === 0) return 1
    return Math.max(...songItems.map(item => item.song.common.disk?.no ?? 1))
  }, [songItems])

  const isMultiDisc = totalDiscs > 1

  const open = (index: number) => {
    if (songItems.length > 0) {
      const list = songItems.map((item, itemIndex) => ({ track: fileNodeToTrack(item.node), index: itemIndex }))
      if (shuffle) {
        updateShuffle(false)
      }
      updatePlayQueue(list)
      updateCurrentIndex(index)
      updateAutoPlay(true)
    }
  }

  const playAll = () => {
    if (songItems.length > 0) {
      open(0)
    }
  }

  const shuffleAll = () => {
    if (songItems.length > 0) {
      const list = songItems.map((item, index) => ({ track: fileNodeToTrack(item.node), index }))
      if (!shuffle) {
        updateShuffle(true)
      }
      const shuffledList = shufflePlayQueue(list)
      updatePlayQueue(shuffledList)
      updateCurrentIndex(shuffledList[0]?.index ?? 0)
      updateAutoPlay(true)
    }
  }

  if (!songs || !albumInfo || !db) {
    return <Loading />
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Box sx={{ p: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <IconButton onClick={() => navigate('/library/albums')}>
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h5" sx={{ wordBreak: 'break-word' }}>{album}</Typography>
      </Box>
      <Grid container sx={{ px: 2, pb: 2 }}>
        <Grid>
          <CardMedia
            component="img"
            sx={{ width: '100%', aspectRatio: '1/1', borderRadius: 1, height: 96 }}
            image={coverUrl}
            alt={album}
          />
        </Grid>
        <Grid sx={{ pl: 2, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <Typography variant="body1" color="text.secondary">{albumartists.join('; ')}</Typography>
          <Typography variant="body2" color="text.secondary">
            {t`${songItems.length} songs`}
          </Typography>
          <Box sx={{ mt: 1, display: 'flex', gap: 1 }}>
            <IconButton onClick={playAll}><PlayArrowIcon /></IconButton>
            <IconButton onClick={shuffleAll}><ShuffleIcon /></IconButton>
          </Box>
        </Grid>
      </Grid>
      <Box sx={{ flexGrow: 1 }}>
        <AutoSizer>
          {({ height, width }) => (
            <FixedSizeList
              height={height}
              width={width}
              itemCount={songItems.length}
              itemSize={72}
            >
              {({ index, style }) => (
                <SongRow
                  key={songItems[index]?.node.id ?? index}
                  style={style}
                  song={songItems[index].song}
                  isMultiDisc={isMultiDisc}
                  onPlay={() => open(index)}
                  onOpenMenu={anchorPosition => setMenuTarget({ anchorPosition, fileNode: songItems[index].node })}
                />
              )}
            </FixedSizeList>
          )}
        </AutoSizer>
      </Box>
      <LibrarySongMenu target={menuTarget} onClose={() => setMenuTarget(null)} />
    </Box>
  )
}

const SongRow = (
  {
    style,
    song,
    isMultiDisc,
    onPlay,
    onOpenMenu,
  }: {
    style: CSSProperties,
    song: MetaData,
    isMultiDisc: boolean,
    onPlay: () => void,
    onOpenMenu: (anchorPosition: LibrarySongMenuPosition) => void,
  }
) => {
  const trackDisplay = useMemo(() => {
    const track = song.common.track.no ?? 0
    if (!isMultiDisc) {
      return track
    }

    const disc = song.common.disk?.no ?? 1
    const paddedTrack = String(track).padStart(2, '0')

    return `${disc}. ${paddedTrack}`
  }, [song, isMultiDisc])

  return (
    <ListItem
      style={style}
      disablePadding
      secondaryAction={<LibrarySongMenuButton onClick={onOpenMenu} />}
    >
      <ListItemButton onClick={onPlay}>
        <ListItemIcon sx={{ minWidth: 40, justifyContent: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            {trackDisplay}
          </Typography>
        </ListItemIcon>
        <ListItemText
          primary={song?.common.title}
          secondary={song?.common.artists?.join('; ')}
        />
      </ListItemButton>
    </ListItem>
  )
}

export default AlbumDetail
