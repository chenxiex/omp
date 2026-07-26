import {
  Avatar,
  Box,
  ButtonBase,
  Dialog,
  DialogContent,
  IconButton,
  InputAdornment,
  InputBase,
  LinearProgress,
  ListItem,
  ListItemAvatar,
  ListItemButton,
  ListItemText,
  useTheme,
} from '@mui/material'
import { CSSProperties, useMemo, useState } from 'react'
import AlbumRoundedIcon from '@mui/icons-material/AlbumRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import MusicNoteRoundedIcon from '@mui/icons-material/MusicNoteRounded'
import PersonRoundedIcon from '@mui/icons-material/PersonRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import useGraph from '@/hooks/graph/useGraph'
import useUser from '@/hooks/graph/useUser'
import useSWR from 'swr'
import useDebounce from '@/hooks/useDebounce'
import CommonList from '@/components/CommonList/CommonList'
import { useLocation, useNavigate } from 'react-router-dom'
import { animated, useSpring } from '@react-spring/web'
import useStyles from '@/hooks/ui/useStyles'
import { useLingui } from '@lingui/react/macro'
import { useMsal } from '@azure/msal-react'
import { remoteItemToFileNode } from '@/utils/remote'
import { isAudio, isVideo } from '@/utils/checkFileType'
import useDb from '@/hooks/useDb'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  ALBUM_ARTIST_SEPARATOR,
  createLibrarySearchQueue,
  getLibrarySearchContext,
  isLocalLibrarySearch,
  LibrarySearchResult,
  NO_ALBUM_ARTIST,
  searchLibrary,
} from '@/utils/librarySearch'
import { FileNode } from '@/types/file'
import { AutoSizer } from 'react-virtualized'
import { FixedSizeList } from 'react-window'
import useCreateImageUrl from '@/hooks/useCreateImageUrl'
import { LibraryDB } from '@/db'
import useUiStore from '@/store/useUiStore'
import usePlayQueueStore from '@/store/usePlayQueueStore'
import usePlayerStore from '@/store/usePlayerStore'
import LibrarySongMenu, {
  LibrarySongMenuButton,
  LibrarySongMenuPosition,
  LibrarySongMenuTarget,
} from '@/components/CommonList/LibrarySongMenu'

type SearchResult =
  | { kind: 'file', id: string, node: FileNode }
  | LibrarySearchResult

const Search = ({ type = 'icon' }: { type?: 'icon' | 'bar' }) => {
  const { t } = useLingui()
  const theme = useTheme()
  const styles = useStyles(theme)
  const location = useLocation()
  const navigate = useNavigate()

  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)

  const searchContext = useMemo(
    () => getLibrarySearchContext(location.pathname),
    [location.pathname],
  )
  const isFileSearch = searchContext.mode === 'files'
  const debouncedSearchQuery = useDebounce(
    searchQuery,
    isFileSearch && searchQuery.length > 0 ? 1000 : 0,
  )

  const { instance } = useMsal()
  const { account } = useUser()
  const db = useDb(account)
  const { getSearchData } = useGraph(instance, account)

  const shuffle = useUiStore.use.shuffle()
  const updateShuffle = useUiStore.use.updateShuffle()
  const updatePlayQueue = usePlayQueueStore.use.updatePlayQueue()
  const updateCurrentIndex = usePlayQueueStore.use.updateCurrentIndex()
  const updateAutoPlay = usePlayerStore.use.updateAutoPlay()

  const handleCloseSearch = () => {
    setSearchOpen(false)
    setSearchQuery('')
  }

  const searchFetcher = async (query: string) => {
    if (!account) return []
    const { value } = await getSearchData(query)
    return value.map(item => remoteItemToFileNode(item, { includeVisuals: true }))
  }

  const { data: searchData, isLoading: searchIsLoading } = useSWR(
    isFileSearch && debouncedSearchQuery.length > 0 && account
      ? `${account.username}/${debouncedSearchQuery}`
      : null,
    () => searchFetcher(debouncedSearchQuery),
  )

  const fileResults = useMemo<SearchResult[]>(() => (
    searchData
      ?.filter(item => isAudio(item.name) || isVideo(item.name) || item.folder === 1)
      .map(node => ({ kind: 'file', id: node.id, node }))
    ?? []
  ), [searchData])

  const localSearchActive = searchOpen
    && searchQuery.trim().length > 0
    && isLocalLibrarySearch(searchContext)

  const libraryData = useLiveQuery(async () => {
    if (!db || !localSearchActive) return null

    const nodes = await db.nodes.where('type').equals('audio').toArray()
    const nodeIds = nodes.map(node => node.id)
    const metadata = nodeIds.length > 0
      ? await db.metadata.where('id').anyOf(nodeIds).toArray()
      : []

    return { nodes, metadata }
  }, [db, localSearchActive])

  const localResults = useMemo<LibrarySearchResult[]>(() => {
    if (!isLocalLibrarySearch(searchContext) || !libraryData) return []
    return searchLibrary(searchContext, libraryData.nodes, libraryData.metadata, searchQuery)
  }, [libraryData, searchContext, searchQuery])

  const results: SearchResult[] = isFileSearch ? fileResults : localResults

  const open = (index: number) => {
    const current = results[index]
    if (!current) return

    if (current.kind === 'file') {
      handleCloseSearch()
      if (current.node.folder === 1) {
        navigate(`/files/${current.node.path.join('/')}`)
      } else {
        navigate(`/files/${current.node.path.slice(0, -1).join('/')}`)
      }
      return
    }

    if (current.kind === 'album') {
      handleCloseSearch()
      const artistsParam = current.albumArtists.join(ALBUM_ARTIST_SEPARATOR) || NO_ALBUM_ARTIST
      navigate(`/library/albums/${encodeURIComponent(artistsParam)}/${encodeURIComponent(current.album)}`)
      return
    }

    if (current.kind === 'artist') {
      handleCloseSearch()
      navigate(`/library/artists/${encodeURIComponent(current.artist)}`)
      return
    }

    const songResults = results.filter(
      (result): result is LibrarySearchResult & { kind: 'song' } => result.kind === 'song',
    )
    const currentSongIndex = songResults.findIndex(song => song.id === current.id)
    if (currentSongIndex < 0) return

    if (shuffle) updateShuffle(false)
    updatePlayQueue(createLibrarySearchQueue(songResults))
    updateCurrentIndex(currentSongIndex)
    updateAutoPlay(true)
    handleCloseSearch()
  }

  const isShow = results.length > 0

  const [{ height }] = useSpring(
    () => ({
      from: {
        height: isShow ? '0' : '100dvh',
      },
      to: {
        height: isShow ? '100dvh' : '0',
      },
      config: {
        mass: 1,
        tension: 190,
        friction: 20,
      },
    }),
    [isShow],
  )

  return (
    <>
      {
        type === 'icon'
        && <IconButton
          onClick={() => setSearchOpen(true)}
          aria-label={t`Search`}
          sx={{
            borderRadius: '0.2rem',
            '.MuiTouchRipple-ripple .MuiTouchRipple-child': {
              borderRadius: '0.2rem',
            },
            width: 'var(--titlebar-height)',
            height: 'var(--titlebar-height)',
          }}
        >
          <SearchRoundedIcon />
        </IconButton>
      }
      {
        type === 'bar'
        && <ButtonBase
          sx={{
            background: `${theme.palette.background.paper}99`,
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: '0.5rem',
            width: '100%',
            height: '100%',
            color: theme.palette.text.secondary,
          }}
          onClick={() => setSearchOpen(true)}
          aria-label={t`Search`}
        >
          {t`Search`}
        </ButtonBase>
      }

      <Dialog
        open={searchOpen}
        onClose={handleCloseSearch}
        maxWidth='xs'
        fullWidth
        disableRestoreFocus
        sx={{
          ...styles.scrollbar,
        }}
      >
        <Box
          sx={{
            padding: '0.5rem 0.75rem',
            borderRadius: '0.5rem',
          }}
        >
          <InputBase
            autoFocus
            placeholder={t`Search`}
            sx={{ width: '100%', fontSize: '1rem' }}
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
            startAdornment={
              <InputAdornment position='start'>
                <SearchRoundedIcon />
              </InputAdornment>
            }
            endAdornment={
              searchQuery.length > 0
              && <InputAdornment position='end'>
                <IconButton
                  aria-label={t`Clear`}
                  onClick={() => setSearchQuery('')}
                >
                  <CloseRoundedIcon fontSize='small' />
                </IconButton>
              </InputAdornment>
            }
          />
          {isFileSearch && searchIsLoading && <LinearProgress sx={{ borderRadius: '0.5rem', height: '2px' }} />}
        </Box>

        <animated.div style={{ height, overflow: 'hidden' }}>
          <DialogContent sx={{ padding: '0.125rem', height: '100%', borderTop: `1px solid ${theme.palette.divider}` }}>
            {
              isFileSearch
                ? <CommonList
                  listData={fileResults
                    .filter((result): result is SearchResult & { kind: 'file' } => result.kind === 'file')
                    .map(result => result.node)}
                  listType='files'
                  disableFAB
                  func={{ open: async index => open(index) }}
                />
                : db && <LibrarySearchList
                  db={db}
                  results={localResults}
                  onOpen={open}
                  onNavigate={handleCloseSearch}
                />
            }
          </DialogContent>
        </animated.div>
      </Dialog>
    </>
  )
}

const LibrarySearchList = ({
  db,
  results,
  onOpen,
  onNavigate,
}: {
  db: LibraryDB
  results: LibrarySearchResult[]
  onOpen: (index: number) => void
  onNavigate: () => void
}) => {
  const [menuTarget, setMenuTarget] = useState<LibrarySongMenuTarget | null>(null)

  return (
    <Box sx={{ width: '100%', height: '100%' }}>
      <AutoSizer>
        {({ height, width }) => (
          <FixedSizeList
            height={height}
            width={width}
            itemCount={results.length}
            itemSize={72}
            overscanCount={10}
          >
            {({ index, style }) => {
              const result = results[index]

              return (
                <LibrarySearchRow
                  key={result.id}
                  db={db}
                  result={result}
                  style={style}
                  onOpen={() => onOpen(index)}
                  // 专辑和艺术家结果只负责导航，三点菜单仅对可播放的歌曲开放。
                  onOpenMenu={result.kind === 'song'
                    ? anchorPosition => setMenuTarget({ anchorPosition, fileNode: result.node })
                    : undefined}
                />
              )
            }}
          </FixedSizeList>
        )}
      </AutoSizer>
      <LibrarySongMenu
        target={menuTarget}
        onClose={() => setMenuTarget(null)}
        onNavigate={onNavigate}
      />
    </Box>
  )
}

const LibrarySearchRow = ({
  db,
  result,
  style,
  onOpen,
  onOpenMenu,
}: {
  db: LibraryDB
  result: LibrarySearchResult
  style: CSSProperties
  onOpen: () => void
  onOpenMenu?: (anchorPosition: LibrarySongMenuPosition) => void
}) => {
  const metadata = result.kind === 'artist' ? undefined : result.metadata
  const coverUrl = useCreateImageUrl(db, metadata)

  const primary = result.kind === 'album'
    ? result.album
    : result.kind === 'artist'
      ? result.artist
      : result.metadata.common.title ?? result.node.name

  const secondary = result.kind === 'album'
    ? result.albumArtists.join('; ')
    : result.kind === 'song'
      ? [
        result.metadata.common.artists?.join('; ') ?? result.metadata.common.artist,
        result.metadata.common.album,
      ].filter(Boolean).join(' • ')
      : undefined

  return (
    <ListItem
      style={style}
      disablePadding
      secondaryAction={onOpenMenu && <LibrarySongMenuButton onClick={onOpenMenu} />}
    >
      <ListItemButton onClick={onOpen}>
        <ListItemAvatar>
          <Avatar
            variant='square'
            alt={primary}
            src={result.kind === 'artist' ? undefined : coverUrl}
            slotProps={{ img: { loading: 'lazy' } }}
          >
            {result.kind === 'album' && <AlbumRoundedIcon />}
            {result.kind === 'artist' && <PersonRoundedIcon />}
            {result.kind === 'song' && <MusicNoteRoundedIcon />}
          </Avatar>
        </ListItemAvatar>
        <ListItemText primary={primary} secondary={secondary} />
      </ListItemButton>
    </ListItem>
  )
}

export default Search
