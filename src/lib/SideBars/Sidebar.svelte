<script lang="ts">
    import {
    CharEmotion,
    DynamicGUI,
    botMakerMode,
    selectedCharID,
    settingsOpen,
    sideBarClosing,
    sideBarStore,
    OpenRealmStore,
    PlaygroundStore,

    QuickSettings,

    additionalHamburgerMenu,

    leftBarCollapsed


  } from "../../ts/stores.svelte";
    import { setDatabase, folderDisplayMode, type folder, type ArchivedCharacterStub, type FolderDisplayMode } from "../../ts/storage/database.svelte";
    import { promptActivateCharacter } from "../../ts/characterArchive";
    import { ArchiveIcon } from "@lucide/svelte";
    import { DBState, openCharacterManager } from 'src/ts/stores.svelte';
    import { tooltipRight } from "src/ts/gui/tooltip";
    import { folderIconComponent } from "../CharacterManager/folderIcons";
    import BarIcon from "./BarIcon.svelte";
    import SidebarIndicator from "./SidebarIndicator.svelte";
    import {
    Columns2,
    Settings,
    ListIcon,
    LayoutGridIcon,
    FolderIcon,
    FolderOpenIcon,
    SearchIcon,
    HomeIcon,
    WrenchIcon,
    User2Icon,
    ChevronsLeft,
    ArrowRight,
  } from "@lucide/svelte";
    import { isEmbeddedRisuPane, splitChatOpen, toggleSplitChat } from 'src/ts/chatSplitPane';
    import {
  addCharacter,
    cancelCharacterChatPrefetch,
    changeChar,
    deselectCharacter,
    getCharThumbnail,
    prefetchCharacterChat,
    removeChar,
    scheduleCharacterChatPrefetch,
    warmRecentCharacterChats,
  } from "../../ts/characters";
    import { language } from "../../lang";
    import isEqual from "lodash/isEqual";
    import SidebarAvatar from "./SidebarAvatar.svelte";
    import BaseRoundedButton from "../UI/BaseRoundedButton.svelte";
    import { getCharacterIndexObject, makeAgoText, selectSingleFile } from "src/ts/util";
    import { v4 } from "uuid";
    import { onMount } from "svelte";
    import { checkCharOrder, getFileSrc, saveAsset } from "src/ts/globalApi.svelte";
    import { alertInput, alertSelect } from "src/ts/alert";
    import { editCharacterTitleColor } from "src/ts/gui/characterTitleColor";
    import { isRealmAssetRecoveryAvailable, listTitleColor } from "src/ts/gui/titleColors";
    import { promoteCharacterFolder, promoteRecentlyViewedCharacter } from "src/ts/characterRecentOrder";
    import MeasuredVirtualList from "../UI/Virtual/MeasuredVirtualList.svelte";
    import { initSupport } from "src/ts/support";

  import { sideBarSize } from "src/ts/gui/guisize";
  import LazyComponent from "../Others/LazyComponent.svelte";
    import { loadCharConfig, loadDevTool, loadQuickSettings, loadSideChatList, preloadCharacterSidebarPanel, preloadChatSidebarPanel } from "./sidebarPanelLoaders";
    import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
  const isTouchDevice = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const touchDragEnabled = $derived(isTouchDevice && !DBState.db.disableMobileDragDrop);
    import { RISU_SIDEBAR_DRAG_TYPE } from "src/ts/dragTypes";
    import {
      applySidebarItemDrop,
      moveSidebarItem,
      type SidebarDragItem,
      type SidebarInsertTarget,
      type SidebarItemTarget,
    } from './sidebarDrag';

  let sideBarMode = $state(0);
  let hasEditableCharacter = $derived(
    $selectedCharID >= 0
      && DBState.db.characters[$selectedCharID]?.chaId !== '§playground'
  )
  let quickSettingsVisible = $derived(
    QuickSettings.open
      && sideBarMode === 0
  )
  let editMode = $state(false);
  let menuMode = $state(0);
  let devTool = $state(false)

  function reseter() {
    menuMode = 0;
    sideBarMode = 0;
    editMode = false;
    QuickSettings.open = false;
    settingsOpen.set(false);
    CharEmotion.set({});
  }

  function openChatTab() {
    void preloadChatSidebarPanel()
    QuickSettings.open = false;
    devTool = false;
    botMakerMode.set(false);
  }

  function openCharacterTab() {
    void preloadCharacterSidebarPanel()
    QuickSettings.open = false;
    devTool = false;
    if (!hasEditableCharacter) {
      openCharacterManager.set(true);
      return;
    }
    botMakerMode.set(true);
  }

  function openModuleTab() {
    devTool = false;
    QuickSettings.open = true;
    QuickSettings.index = 2;
  }

  type DragData = SidebarDragItem
  type sortTypeNormal = { type:'normal',id:string,img: string, index: number, name:string, favorite?:boolean, folderIndex?:number }
  // Deactivated characters are rendered in place but remain non-draggable
  // because their full records no longer live in DBState.db.characters.
  type sortTypeArchived = { type:'archived',img:string,chaId:string,name:string,folderIndex?:number }
  type sortTypeEntry = sortTypeNormal | sortTypeArchived
  type sortTypeFolder = {type:'folder',folder:sortTypeEntry[],id:string,name:string,color:string,favorite?:boolean,img?:string,icon?:string,display:FolderDisplayMode}
  type sortType = sortTypeEntry | sortTypeFolder
  function sidebarDragItem(item: sortTypeNormal | sortTypeFolder): SidebarDragItem {
    return item.type === 'normal'
      ? { kind: 'character', id: item.id }
      : { kind: 'folder', id: item.id }
  }
  type sidebarCatalogBlock =
    | { type: 'control', position: 'top' | 'bottom' }
    | { type: 'character', char: sortType, index: number }
  let charImages: sortType[] = $state([]);
  let catalogSearch = $state('')
  let catalogQuery = $derived(catalogSearch.trim().toLocaleLowerCase())
  const splitCatalogStorageKey = 'pocketrisu-sidebar-catalog-split-v1'
  let splitCatalogMode = $state(
    typeof localStorage !== 'undefined' && localStorage.getItem(splitCatalogStorageKey) === 'split'
  )
  type splitCatalogCharacter = {
    type: 'character'
    char: sortTypeEntry
    drag?: DragData
    sourceOrder: number
  }
  type splitCatalogBlock = { type: 'control', position: 'top' | 'bottom' } | splitCatalogCharacter
  let filteredCatalogItems = $derived.by(() => charImages
    .map((char, sourceOrder) => {
      if (!catalogQuery) return { char, sourceOrder }
      if (char.type === 'normal' || char.type === 'archived') {
        return char.name.toLocaleLowerCase().includes(catalogQuery) ? { char, sourceOrder } : null
      }
      const folderMatches = char.name.toLocaleLowerCase().includes(catalogQuery)
      const matchingMembers = folderMatches
        ? char.folder
        : char.folder.filter((member) => member.name.toLocaleLowerCase().includes(catalogQuery))
      return folderMatches || matchingMembers.length > 0
        ? { char: { ...char, folder: matchingMembers }, sourceOrder }
        : null
    })
    .filter((item): item is { char: sortType, sourceOrder: number } => !!item))
  let sidebarCatalogBlocks = $derived<sidebarCatalogBlock[]>([
    { type: 'control', position: 'top' },
    ...filteredCatalogItems.map(({ char, sourceOrder }) => ({ type: 'character' as const, char, index: sourceOrder })),
    { type: 'control', position: 'bottom' },
  ])
  let splitFolderItems = $derived(filteredCatalogItems
    .filter((item): item is { char: Extract<sortType, { type: 'folder' }>, sourceOrder: number } => item.char.type === 'folder'))
  let splitCharacterBlocks = $derived.by<splitCatalogBlock[]>(() => {
    const blocks: splitCatalogBlock[] = [{ type: 'control', position: 'top' }]
    filteredCatalogItems.forEach(({ char, sourceOrder }) => {
      if(char.type === 'normal' || char.type === 'archived') blocks.push({
        type: 'character',
        char,
        drag: char.type === 'normal' ? { kind: 'character', id: char.id } : undefined,
        sourceOrder,
      })
    })
    blocks.push({ type: 'control', position: 'bottom' })
    return blocks
  })
  let sidebarScrollIndex = $state<number | null>(null)
  let sidebarScrollRequest = $state(0)
  // Recently interacted characters for the home sidebar. Character-level
  // `lastInteraction` is already in memory (no chat hydration needed), so this
  // sort is cheap; the $derived is only read while on the home screen.
  let recentChars = $derived(
    DBState.db.characters
      .map((c, index) => ({ index, name: c.name, image: c.image, favorite: !!c.favorite, lastInteraction: c.lastInteraction ?? 0 }))
      .filter((c) => c.lastInteraction > 0)
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.lastInteraction - a.lastInteraction)
  );
  // Progressive reveal: render `recentVisible` items, "Load more" adds 10.
  // Avoids mounting hundreds of avatar components at once (no list virtualization).
  let recentVisible = $state(10);
  let IconRounded = $state(false)
  let openFolders:string[] = $state([])
  let currentDrag: DragData | null = $state(null)
  interface Props {
    hidden?: boolean;
  }

  let { hidden = false }: Props = $props();

  onMount(() => {
    initSupport()
    let active = true
    const timer = setTimeout(() => {
      const recentIndices = recentChars.slice(0, recentVisible).map((recent) => recent.index)
      void warmRecentCharacterChats(recentIndices, () => active)
    }, 900)
    return () => {
      active = false
      clearTimeout(timer)
    }
  })

  sideBarClosing.set(false)

  $effect(() => {
    let newCharImages: sortType[] = [];
    const idObject = getCharacterIndexObject()
    // Deactivated characters keep their slot in characterOrder; resolve those
    // ids against the stub list (unless the user chose to hide them).
    const archivedById = new Map<string, ArchivedCharacterStub>()
    if (!DBState.db.nodeOnlyHideArchivedCharacters) {
      for (const stub of DBState.db.nodeOnlyArchivedCharacters ?? []) {
        if (stub?.chaId && !stub.trashedAt) archivedById.set(stub.chaId, stub)
      }
    }
    // Sidebar-hidden characters (display only; the character manager still lists them).
    const hiddenSet = new Set(DBState.db.nodeOnlyHiddenCharacterIds ?? [])
    const archivedEntry = (id: string): sortTypeArchived | null => {
      const stub = archivedById.get(id)
      return stub ? { type: 'archived', img: stub.image ?? '', chaId: stub.chaId, name: stub.name ?? '' } : null
    }
    for (const id of DBState.db.characterOrder) {
      if(typeof(id) === 'string'){
        if (hiddenSet.has(id)) continue
        const index = idObject[id] ?? -1
        if(index !== -1){
          const cha = DBState.db.characters[index]
          newCharImages.push({
            id: cha.chaId,
            img:cha.image ?? "",
            index:index,
            type: "normal",
            name: cha.name,
            favorite: !!cha.favorite,
          });
        } else {
          const archived = archivedEntry(id)
          if (archived) newCharImages.push(archived)
        }
      }
      else{
        const folder = id
        let folderCharImages: sortTypeEntry[] = []
        for(const [folderIndex, id] of folder.data.entries()){
          if (hiddenSet.has(id)) continue
          const index = idObject[id] ?? -1
          if(index !== -1){
            const cha = DBState.db.characters[index]
            folderCharImages.push({
              id: cha.chaId,
              img:cha.image ?? "",
              index:index,
              type: "normal",
              name: cha.name,
              favorite: !!cha.favorite,
              folderIndex,
            });
          } else {
            const archived = archivedEntry(id)
            if (archived) folderCharImages.push({ ...archived, folderIndex })
          }
        }
        newCharImages.push({
          folder: folderCharImages,
          type: "folder",
          id: folder.id,
          name: folder.name,
          color: folder.color,
          favorite: !!folder.favorite,
          // A folder without a custom cover borrows its top member's
          // thumbnail. SidebarAvatar clips it into a folder silhouette so it
          // remains visibly distinct from an ordinary character card.
          img: folder.imgFile || folderCharImages[0]?.img || '',
          icon: folder.nodeOnlyIcon,
          display: folder.nodeOnlyDisplay
            ? folderDisplayMode(folder)
            : (folder.imgFile || folderCharImages[0]?.img ? 'image' : 'icon'),
        });
      }
    }
    if (!isEqual(charImages, newCharImages)) {
      charImages = newCharImages;
    }
    if(IconRounded !== DBState.db.roundIcons){
      IconRounded = DBState.db.roundIcons
    }
  })


  function commitSidebarOrder(nextOrder: Array<string | folder> | null) {
    if(!nextOrder || isEqual(nextOrder, DBState.db.characterOrder)) return
    DBState.db.characterOrder = nextOrder
    checkCharOrder()
  }

  const inserter = (source:DragData, target:SidebarInsertTarget) => {
    commitSidebarOrder(moveSidebarItem(DBState.db.characterOrder, source, target))
  }

  function setSplitCatalogMode(enabled:boolean){
    splitCatalogMode = enabled
    localStorage.setItem(splitCatalogStorageKey, splitCatalogMode ? 'split' : 'normal')
  }

  function favoriteCharacterIds(): Set<string> {
    return new Set(DBState.db.characters
      .filter((character) => character.favorite && !character.trashTime)
      .map((character) => character.chaId))
  }

  function toggleSidebarFolderFavorite(ind:number) {
    const current = DBState.db.characterOrder[ind]
    if(typeof current === 'string') return
    const next = { ...current, favorite: !current.favorite }
    const order = DBState.db.characterOrder.slice()
    order[ind] = next
    DBState.db.characterOrder = promoteCharacterFolder(order, next.id, favoriteCharacterIds())
    checkCharOrder()
  }

  function toggleSidebarCharacterFavorite(characterIndex:number) {
    const character = DBState.db.characters[characterIndex]
    if(!character) return
    character.favorite = !character.favorite
    DBState.db.characters[characterIndex] = character
    DBState.db.characterOrder = promoteRecentlyViewedCharacter(
      DBState.db.characterOrder,
      character.chaId,
      favoriteCharacterIds(),
    )
    checkCharOrder()
  }

  async function editSidebarFolder(ind:number, char: Extract<sortType, { type: 'folder' }>, e:MouseEvent){
    e.preventDefault()
    e.stopPropagation()
    const sel = parseInt(await alertSelect([
      language.renameFolder,
      language.changeFolderColor,
      language.changeFolderImage,
      char.favorite ? '즐겨찾기 해제' : '즐겨찾기 (맨위로)',
      language.cancel,
    ]))
    if(sel === 0){
      const value = await alertInput(language.changeFolderName, [], char.name)
      const entry = DBState.db.characterOrder[ind]
      if(value && typeof entry !== 'string'){
        entry.name = value
        DBState.db.characterOrder[ind] = entry
      }
      return
    }
    if(sel === 1){
      const colors = ["red","green","blue","yellow","indigo","purple","pink","default"]
      const colorIndex = parseInt(await alertSelect(colors))
      const entry = DBState.db.characterOrder[ind]
      if(typeof entry !== 'string' && colors[colorIndex]){
        entry.color = colors[colorIndex].toLocaleLowerCase()
        DBState.db.characterOrder[ind] = entry
      }
      return
    }
    if(sel === 3){
      toggleSidebarFolderFavorite(ind)
      return
    }
    if(sel !== 2) return
    const imageChoice = parseInt(await alertSelect(['Reset to Default Image', 'Select Image File']))
    const entry = DBState.db.characterOrder[ind]
    if(typeof entry === 'string') return
    if(imageChoice === 0){
      entry.imgFile = null
      entry.img = ''
      DBState.db.characterOrder[ind] = entry
      return
    }
    if(imageChoice !== 1) return
    const folderImage = await selectSingleFile(['png','jpg','webp'])
    if(!folderImage) return
    const folderImageData = await saveAsset(folderImage.data)
    entry.imgFile = folderImageData
    entry.img = await getFileSrc(folderImageData)
    DBState.db.characterOrder[ind] = entry
  }

  async function editSidebarCharacter(characterIndex:number, e:MouseEvent){
    e.preventDefault()
    e.stopPropagation()
    const character = DBState.db.characters[characterIndex]
    if(!character) return
    const selected = parseInt(await alertSelect([
      '봇 설정 수정',
      '제목 색변경',
      character.favorite ? '즐겨찾기 해제' : '즐겨찾기 (맨위로)',
      language.remove,
      language.cancel,
    ]))
    if(selected === 0){
      changeChar(characterIndex, { reseter })
      botMakerMode.set(true)
      return
    }
    if(selected === 1){
      await editCharacterTitleColor(character.chaId)
      return
    }
    if(selected === 2){
      toggleSidebarCharacterFavorite(characterIndex)
      return
    }
    if(selected === 3){
      await removeChar(character.chaId, character.name)
    }
  }

  function scrollToActiveCharacter() {
    const selectedId = $selectedCharID
    if (selectedId === -1) return
    
    const characterId = DBState.db.characters[selectedId]?.chaId
    if (!characterId) return
    
    let targetFolderId: string | null = null
    let targetTopLevelIndex = -1
    
    for (let index = 0; index < charImages.length; index++) {
      const item = charImages[index]
      if (item.type === 'normal' && DBState.db.characters[item.index]?.chaId === characterId) {
        targetTopLevelIndex = index
        break
      }
      if (item.type === 'folder') {
        const foundChar = item.folder.find(c => 
          c.type === 'normal' && DBState.db.characters[c.index]?.chaId === characterId
        )
        if (foundChar) {
          targetFolderId = item.id
          targetTopLevelIndex = index
          break
        }
      }
    }
    
    if (targetFolderId && !openFolders.includes(targetFolderId)) {
      openFolders.push(targetFolderId)
      openFolders = openFolders
    }

    if (targetTopLevelIndex >= 0) {
      // +1 accounts for the virtual catalog's top add-character control.
      sidebarScrollIndex = targetTopLevelIndex + 1
      sidebarScrollRequest += 1
    }
    setTimeout(() => {
      const activeElement = document.querySelector(`[data-char-id="${characterId}"]`)
      activeElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 160)
  }

  $effect(() => {
    if (typeof window === 'undefined') return
    
    const handler = () => {
      scrollToActiveCharacter()
    }
    
    window.addEventListener('scrollToActiveCharacter', handler)
    
    return () => {
      window.removeEventListener('scrollToActiveCharacter', handler)
    }
  })


  const createFolder = (source:DragData, target:SidebarItemTarget) => {
    commitSidebarOrder(applySidebarItemDrop(
      DBState.db.characterOrder,
      source,
      target,
      () => ({ name: 'New Folder', color: '', id: v4() }),
    ))
  }

  type DragEv = DragEvent & {
    currentTarget: EventTarget & HTMLDivElement;
  }
  const avatarDragStart = (ind:DragData, e:DragEv) => {
    e.dataTransfer.setData('text/plain', '');
    e.dataTransfer.setData(RISU_SIDEBAR_DRAG_TYPE, 'true');
    currentDrag = ind
    const avatar = e.currentTarget.querySelector('.avatar')
    if(avatar){
      e.dataTransfer.setDragImage(avatar, 10, 10);
    }
  }

  const clearCurrentDrag = () => {
    currentDrag = null
  }

  $effect(() => {
    if (typeof window === 'undefined') return

    window.addEventListener('dragend', clearCurrentDrag)
    window.addEventListener('drop', clearCurrentDrag)
    window.addEventListener('blur', clearCurrentDrag)

    return () => {
      window.removeEventListener('dragend', clearCurrentDrag)
      window.removeEventListener('drop', clearCurrentDrag)
      window.removeEventListener('blur', clearCurrentDrag)
    }
  })

  const getCurrentSidebarDrag = (e:DragEvent) => {
    if(!currentDrag || !e.dataTransfer?.types.includes(RISU_SIDEBAR_DRAG_TYPE)){
      return null
    }
    return currentDrag
  }

  const avatarDragOver = (e:DragEv) => {
    if(!getCurrentSidebarDrag(e)){
      return
    }
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
  }

  const avatarDrop = (target:SidebarItemTarget, e:DragEv) => {
    const drag = getCurrentSidebarDrag(e)
    if(!drag){
      return
    }
    e.preventDefault()
    e.stopPropagation()
    try {
      createFolder(drag,target)
    } catch (error) {
      console.error('avatarDrop error:', error)
    } finally {
      clearCurrentDrag()
    }
  }

  const preventAll = (e:DragEvent) => {
    if(!getCurrentSidebarDrag(e)){
      return
    }
    e.preventDefault()
    e.stopPropagation()
    return false
  }

  function sidebarItemTargetFromElement(element: HTMLElement): SidebarItemTarget | null {
    const kind = element.dataset.dragKind
    const id = element.dataset.dragId
    if(!id || (kind !== 'character' && kind !== 'folder')) return null
    return { kind, id }
  }

  function sidebarInsertTargetFromElement(element: HTMLElement): SidebarInsertTarget | null {
    const index = Number.parseInt(element.dataset.spacerIndex ?? '', 10)
    if(!Number.isInteger(index) || index < 0) return null
    const folderId = element.dataset.spacerFolder
    return folderId
      ? { kind: 'folder', folderId, index }
      : { kind: 'root', index }
  }

  // Touch long-press drag for mobile devices
  let touchDragState: {
    data: DragData
    element: HTMLElement
    ghost: HTMLElement | null
    highlighted: HTMLElement | null
  } | null = null
  let touchDragTimer = 0
  let touchStartPos = { x: 0, y: 0 }
  let suppressNextClick = false

  function onTouchDragStart(data: DragData, e: TouchEvent & { currentTarget: HTMLElement }) {
    const touch = e.touches[0]
    touchStartPos = { x: touch.clientX, y: touch.clientY }
    const el = e.currentTarget

    if (touchDragTimer) clearTimeout(touchDragTimer)
    touchDragTimer = window.setTimeout(() => {
      touchDragState = { data, element: el, ghost: null, highlighted: null }
      el.style.opacity = '0.4'
      try { navigator.vibrate?.(30) } catch {}

      const rect = el.getBoundingClientRect()
      const ghost = el.cloneNode(true) as HTMLElement
      ghost.style.cssText = `position:fixed;pointer-events:none;z-index:9999;opacity:0.7;width:${rect.width}px;left:${touch.clientX - rect.width / 2}px;top:${touch.clientY - rect.height / 2}px;`
      document.body.appendChild(ghost)
      touchDragState.ghost = ghost
    }, 400)
  }

  function onTouchDragMove(e: TouchEvent) {
    const touch = e.touches[0]

    if (!touchDragState) {
      const dx = Math.abs(touch.clientX - touchStartPos.x)
      const dy = Math.abs(touch.clientY - touchStartPos.y)
      if (dx > 8 || dy > 8) {
        if (touchDragTimer) { clearTimeout(touchDragTimer); touchDragTimer = 0 }
      }
      return
    }

    e.preventDefault()

    if (touchDragState.ghost) {
      const rect = touchDragState.element.getBoundingClientRect()
      touchDragState.ghost.style.left = `${touch.clientX - rect.width / 2}px`
      touchDragState.ghost.style.top = `${touch.clientY - rect.height / 2}px`
    }

    // Find drop target under finger
    if (touchDragState.ghost) touchDragState.ghost.style.display = 'none'
    const el = document.elementFromPoint(touch.clientX, touch.clientY)
    if (touchDragState.ghost) touchDragState.ghost.style.display = ''

    if (touchDragState.highlighted) {
      touchDragState.highlighted.classList.remove('bg-green-500', 'ring-2', 'ring-green-400')
      touchDragState.highlighted = null
    }

    if (!el) return
    const spacer = el.closest('[data-spacer-index]') as HTMLElement | null
    const item = el.closest('[data-drag-id]') as HTMLElement | null

    if (spacer) {
      spacer.classList.add('bg-green-500')
      touchDragState.highlighted = spacer
    } else if (item && item !== touchDragState.element) {
      item.classList.add('ring-2', 'ring-green-400')
      touchDragState.highlighted = item
    }
  }

  function cleanupTouchDrag() {
    if (touchDragTimer) { clearTimeout(touchDragTimer); touchDragTimer = 0 }
    if (!touchDragState) return false
    touchDragState.element.style.opacity = ''
    if (touchDragState.highlighted) {
      touchDragState.highlighted.classList.remove('bg-green-500', 'ring-2', 'ring-green-400')
    }
    if (touchDragState.ghost) touchDragState.ghost.remove()
    touchDragState = null
    return true
  }

  function onTouchDragEnd(e: TouchEvent) {
    if (touchDragTimer) { clearTimeout(touchDragTimer); touchDragTimer = 0 }
    if (!touchDragState) return

    const touch = e.changedTouches[0]

    if (touchDragState.ghost) touchDragState.ghost.style.display = 'none'
    const el = document.elementFromPoint(touch.clientX, touch.clientY)

    const spacer = el?.closest('[data-spacer-index]') as HTMLElement | null
    const item = el?.closest('[data-drag-id]') as HTMLElement | null

    if (spacer) {
      const target = sidebarInsertTargetFromElement(spacer)
      if(target) inserter(touchDragState.data, target)
    } else if (item && item !== touchDragState.element) {
      const target = sidebarItemTargetFromElement(item)
      if(target) createFolder(touchDragState.data, target)
    }

    cleanupTouchDrag()
    suppressNextClick = true
    requestAnimationFrame(() => { suppressNextClick = false })
  }

  function onTouchDragCancel() {
    cleanupTouchDrag()
  }

  function touchDragContainer(node: HTMLElement) {
    node.addEventListener('touchmove', onTouchDragMove, { passive: false })
    node.addEventListener('touchend', onTouchDragEnd)
    node.addEventListener('touchcancel', onTouchDragCancel)
    return {
      destroy() {
        node.removeEventListener('touchmove', onTouchDragMove)
        node.removeEventListener('touchend', onTouchDragEnd)
        node.removeEventListener('touchcancel', onTouchDragCancel)
      }
    }
  }
</script>

{#snippet addCharacterButton(position: 'top' | 'bottom')}
  <div class="flex flex-col items-center gap-2 px-2" data-add-character-button={position}>
    <BaseRoundedButton
      onClick={async () => {
        addCharacter({
          reseter,
          setCatalogLayout: (mode) => setSplitCatalogMode(mode === 'split'),
        })
      }}
      ><svg viewBox="0 0 24 24" width="1.2em" height="1.2em"
        ><path
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M12 6v6m0 0v6m0-6h6m-6 0H6"
        /></svg
      ></BaseRoundedButton
    >
  </div>
{/snippet}

{#snippet splitFolderColumn()}
  <div class="h-full w-20 min-w-20 overflow-y-auto overflow-x-hidden border-r border-selected" aria-label="캐릭터 폴더">
    <div class="h-4 min-h-4 w-full" role="listitem" data-spacer-index="0" ondragover={(e) => {
      if(!getCurrentSidebarDrag(e)) return
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'
      e.currentTarget.classList.add('bg-green-500')
    }} ondragleave={(e) => e.currentTarget.classList.remove('bg-green-500')} ondrop={(e) => {
      const drag = getCurrentSidebarDrag(e)
      if(!drag) return
      e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('bg-green-500')
      try { inserter(drag, { kind: 'root', index: 0 }) } finally { clearCurrentDrag() }
    }}></div>
    {#each splitFolderItems as item (item.char.id)}
      <div class="flex w-full flex-col items-center">
        <div
          class="group relative flex items-center px-2"
          role="listitem"
          data-drag-kind="folder"
          data-drag-id={item.char.id}
          draggable={!isTouchDevice ? "true" : undefined}
          ondragstart={!isTouchDevice ? (e) => avatarDragStart({ kind: 'folder', id: item.char.id }, e) : undefined}
          ondragend={!isTouchDevice ? clearCurrentDrag : undefined}
          ondragover={!isTouchDevice ? avatarDragOver : undefined}
          ondrop={!isTouchDevice ? (e) => {
            const drag = getCurrentSidebarDrag(e)
            if(!drag) return
            e.preventDefault(); e.stopPropagation()
            try { createFolder(drag, { kind: 'folder', id: item.char.id }) } finally { clearCurrentDrag() }
          } : undefined}
          ontouchstart={touchDragEnabled ? (e) => onTouchDragStart({ kind: 'folder', id: item.char.id }, e) : undefined}
        >
          <SidebarAvatar
            src="slot"
            size="56"
            rounded={IconRounded}
            folderShape
            name={item.char.name}
            color={item.char.color}
            favorite={item.char.favorite}
            backgroundimg={item.char.display === 'image' && item.char.img ? () => getCharThumbnail(item.char.img, "plain") : ""}
            oncontextmenu={(e) => { void editSidebarFolder(item.sourceOrder, item.char, e) }}
            onClick={() => {
              if(suppressNextClick) return
              if(openFolders.includes(item.char.id)) openFolders.splice(openFolders.indexOf(item.char.id), 1)
              else openFolders.push(item.char.id)
              openFolders = openFolders
            }}
          >
            {@const CustomIcon = folderIconComponent(item.char.icon)}
            {#if item.char.display === 'name'}
              <div class="flex h-full w-full items-center justify-center">
                <span class="truncate font-bold">{item.char.name}</span>
              </div>
            {:else if item.char.display === 'icon' && CustomIcon}
              <CustomIcon />
            {:else if openFolders.includes(item.char.id)}
              <FolderOpenIcon />
            {:else}
              <FolderIcon />
            {/if}
          </SidebarAvatar>
        </div>
        {#if openFolders.includes(item.char.id)}
          <div class="relative mt-1 flex w-full flex-col items-center rounded-lg border border-selected py-1">
            <div
              class="h-4 min-h-4 w-full"
              role="listitem"
              data-spacer-index="0"
              data-spacer-folder={item.char.id}
              ondragover={(e) => {
                if(!getCurrentSidebarDrag(e)) return
                e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'
                e.currentTarget.classList.add('bg-green-500')
              }}
              ondragleave={(e) => e.currentTarget.classList.remove('bg-green-500')}
              ondrop={(e) => {
                const drag = getCurrentSidebarDrag(e)
                if(!drag) return
                e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('bg-green-500')
                try { inserter(drag, { kind: 'folder', folderId: item.char.id, index: 0 }) } finally { clearCurrentDrag() }
              }}
            ></div>
            {#each item.char.folder as folderChar, folderIndex}
              {@const sourceFolderIndex = folderChar.folderIndex ?? folderIndex}
              <div
                class="sidebar-folder-character group relative flex items-center px-2"
                role="listitem"
                data-drag-kind={folderChar.type === 'normal' ? 'character' : undefined}
                data-drag-id={folderChar.type === 'normal' ? folderChar.id : undefined}
                draggable={!isTouchDevice && folderChar.type === 'normal' ? "true" : undefined}
                ondragstart={!isTouchDevice && folderChar.type === 'normal' ? (e) => avatarDragStart({ kind: 'character', id: folderChar.id }, e) : undefined}
                ondragend={!isTouchDevice && folderChar.type === 'normal' ? clearCurrentDrag : undefined}
                ondragover={!isTouchDevice && folderChar.type === 'normal' ? avatarDragOver : undefined}
                ontouchstart={touchDragEnabled && folderChar.type === 'normal' ? (e) => onTouchDragStart({ kind: 'character', id: folderChar.id }, e) : undefined}
              >
                <SidebarIndicator isActive={folderChar.type === 'normal' && $selectedCharID === folderChar.index && sideBarMode !== 1}/>
                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <div
                  role="button"
                  tabindex="0"
                  onpointerenter={() => folderChar.type === 'normal' && scheduleCharacterChatPrefetch(folderChar.index)}
                  onpointerleave={() => folderChar.type === 'normal' && cancelCharacterChatPrefetch(folderChar.index)}
                  onpointerdown={() => folderChar.type === 'normal' && void prefetchCharacterChat(folderChar.index)}
                  onclick={() => {
                    if(suppressNextClick) return
                    if(folderChar.type === 'normal') changeChar(folderChar.index, { reseter })
                    else void promptActivateCharacter(folderChar.chaId, { reseter })
                  }}
                  onkeydown={(e) => {
                    if(e.key !== 'Enter') return
                    if(folderChar.type === 'normal') changeChar(folderChar.index, { reseter })
                    else void promptActivateCharacter(folderChar.chaId, { reseter })
                  }}
                >
                  {#if folderChar.type === 'archived'}
                    <div class="relative grayscale opacity-60 archived-character-muted">
                      <SidebarAvatar
                        src={folderChar.img ? () => getCharThumbnail(folderChar.img, "plain") : ""}
                        size="56"
                        rounded={IconRounded}
                        name={`${folderChar.name} (${language.deactivatedBadge})`}
                        chaId={folderChar.chaId}
                      />
                      <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55" class:rounded-md={!IconRounded} class:rounded-full={IconRounded}>
                        <ArchiveIcon size={20} class="text-white/90" />
                      </div>
                    </div>
                  {:else}
                    <SidebarAvatar
                      src={folderChar.img ? () => getCharThumbnail(folderChar.img, "plain") : ""}
                      size="56"
                      rounded={IconRounded}
                      name={folderChar.name}
                      favorite={folderChar.favorite}
                      titleColor={listTitleColor(DBState.db.characters[folderChar.index]?.titleColor, Number(DBState.db.characters[folderChar.index]?.sourceInfo?.missingAssetCount) > 0)}
                      missingAssets={Number(DBState.db.characters[folderChar.index]?.sourceInfo?.missingAssetCount) > 0}
                      realmRecoveryAvailable={isRealmAssetRecoveryAvailable(DBState.db.characters[folderChar.index])}
                      chaId={DBState.db.characters[folderChar.index]?.chaId}
                      oncontextmenu={(e) => { void editSidebarCharacter(folderChar.index, e) }}
                    />
                  {/if}
                </div>
              </div>
              <div
                class="h-4 min-h-4 w-full"
                role="listitem"
                data-spacer-index={sourceFolderIndex + 1}
                data-spacer-folder={item.char.id}
                ondragover={(e) => {
                  if(!getCurrentSidebarDrag(e)) return
                  e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'
                  e.currentTarget.classList.add('bg-green-500')
                }}
                ondragleave={(e) => e.currentTarget.classList.remove('bg-green-500')}
                ondrop={(e) => {
                  const drag = getCurrentSidebarDrag(e)
                  if(!drag) return
                  e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('bg-green-500')
                  try { inserter(drag, { kind: 'folder', folderId: item.char.id, index: sourceFolderIndex + 1 }) } finally { clearCurrentDrag() }
                }}
              ></div>
            {/each}
          </div>
        {/if}
        <div class="h-4 min-h-4 w-full" role="listitem" data-spacer-index={item.sourceOrder + 1} ondragover={(e) => {
          if(!getCurrentSidebarDrag(e)) return
          e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'
          e.currentTarget.classList.add('bg-green-500')
        }} ondragleave={(e) => e.currentTarget.classList.remove('bg-green-500')} ondrop={(e) => {
          const drag = getCurrentSidebarDrag(e)
          if(!drag) return
          e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('bg-green-500')
          try { inserter(drag, { kind: 'root', index: item.sourceOrder + 1 }) } finally { clearCurrentDrag() }
        }}></div>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet splitCharacterRow(block: splitCatalogBlock)}
  {#if block.type === 'control'}
    <div class="flex w-full flex-col items-center">
      {@render addCharacterButton(block.position)}
      {#if block.position === 'top'}
        <div
          class="h-4 min-h-4 w-full"
          role="listitem"
          data-spacer-index="0"
          ondragover={(e) => {
            if(!getCurrentSidebarDrag(e)) return
            e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'
            e.currentTarget.classList.add('bg-green-500')
          }}
          ondragleave={(e) => e.currentTarget.classList.remove('bg-green-500')}
          ondrop={(e) => {
            const drag = getCurrentSidebarDrag(e)
            if(!drag) return
            e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('bg-green-500')
            try { inserter(drag, { kind: 'root', index: 0 }) } finally { clearCurrentDrag() }
          }}
        ></div>
      {/if}
    </div>
  {:else}
    <div class="flex w-full flex-col items-center">
      <div
        class="group relative flex items-center px-2"
        role="listitem"
        data-drag-kind={block.char.type === 'normal' ? 'character' : undefined}
        data-drag-id={block.char.type === 'normal' ? block.char.id : undefined}
        draggable={!isTouchDevice && block.char.type === 'normal' ? "true" : undefined}
        ondragstart={!isTouchDevice && block.drag ? (e) => avatarDragStart(block.drag!, e) : undefined}
        ondragend={!isTouchDevice && block.char.type === 'normal' ? clearCurrentDrag : undefined}
        ondragover={!isTouchDevice && block.char.type === 'normal' ? avatarDragOver : undefined}
        ondrop={!isTouchDevice && block.drag ? (e) => avatarDrop(block.drag!, e) : undefined}
        ontouchstart={touchDragEnabled && block.drag ? (e) => onTouchDragStart(block.drag!, e) : undefined}
      >
        <SidebarIndicator isActive={block.char.type === 'normal' && $selectedCharID === block.char.index && sideBarMode !== 1}/>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          role="button"
          tabindex="0"
          onpointerenter={() => block.char.type === 'normal' && scheduleCharacterChatPrefetch(block.char.index)}
          onpointerleave={() => block.char.type === 'normal' && cancelCharacterChatPrefetch(block.char.index)}
          onpointerdown={() => block.char.type === 'normal' && void prefetchCharacterChat(block.char.index)}
          onclick={() => {
            if(suppressNextClick) return
            if(block.char.type === 'normal') changeChar(block.char.index, { reseter })
            else void promptActivateCharacter(block.char.chaId, { reseter })
          }}
          onkeydown={(e) => {
            if(e.key !== 'Enter') return
            if(block.char.type === 'normal') changeChar(block.char.index, { reseter })
            else void promptActivateCharacter(block.char.chaId, { reseter })
          }}
        >
          {#if block.char.type === 'archived'}
            <div class="relative grayscale opacity-60 archived-character-muted">
              <SidebarAvatar
                src={block.char.img ? () => getCharThumbnail(block.char.img, "plain") : ""}
                size="56"
                rounded={IconRounded}
                name={`${block.char.name} (${language.deactivatedBadge})`}
                chaId={block.char.chaId}
              />
              <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55" class:rounded-md={!IconRounded} class:rounded-full={IconRounded}>
                <ArchiveIcon size={20} class="text-white/90" />
              </div>
            </div>
          {:else}
            {@const normalChar = block.char as sortTypeNormal}
            <SidebarAvatar
              src={normalChar.img ? () => getCharThumbnail(normalChar.img, "plain") : ""}
              size="56"
              rounded={IconRounded}
              name={normalChar.name}
              favorite={normalChar.favorite}
              titleColor={listTitleColor(DBState.db.characters[normalChar.index]?.titleColor, Number(DBState.db.characters[normalChar.index]?.sourceInfo?.missingAssetCount) > 0)}
              missingAssets={Number(DBState.db.characters[normalChar.index]?.sourceInfo?.missingAssetCount) > 0}
              realmRecoveryAvailable={isRealmAssetRecoveryAvailable(DBState.db.characters[normalChar.index])}
              chaId={DBState.db.characters[normalChar.index]?.chaId}
              oncontextmenu={(e) => { void editSidebarCharacter(normalChar.index, e) }}
            />
          {/if}
        </div>
      </div>
      <div
        class="h-4 min-h-4 w-full"
        role="listitem"
        data-spacer-index={block.sourceOrder + 1}
        ondragover={(e) => {
          if(!getCurrentSidebarDrag(e)) return
          e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'
          e.currentTarget.classList.add('bg-green-500')
        }}
        ondragleave={(e) => e.currentTarget.classList.remove('bg-green-500')}
        ondrop={(e) => {
          const drag = getCurrentSidebarDrag(e)
          if(!drag) return
          e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('bg-green-500')
          try { inserter(drag, { kind: 'root', index: block.sourceOrder + 1 }) } finally { clearCurrentDrag() }
        }}
      ></div>
    </div>
  {/if}
{/snippet}

{#if DBState.db.menuSideBar}
<div
  class="h-full w-20 min-w-20 flex-col items-center bg-bgcolor text-textcolor shadow-lg relative rs-sidebar"
  class:editMode
  class:risu-sub-sidebar={$sideBarClosing}
  class:risu-sub-sidebar-close={$sideBarClosing}
  class:hidden={hidden}
  class:flex={!hidden}
>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full mt-4"
  class:text-textcolor2={!(
    $selectedCharID < 0 &&
    $PlaygroundStore === 0 &&
    !$settingsOpen
  )}
  onclick={() => {
    reseter();
    deselectCharacter()
    PlaygroundStore.set(0)
    OpenRealmStore.set(false)
  }}
>
  <HomeIcon />
  <span class="text-xs">{language.home}</span>
</button>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full"
  class:text-textcolor2={!$settingsOpen}
  onclick={() => {
    if ($settingsOpen) {
      reseter();
      settingsOpen.set(false);
    } else {
      reseter();
      settingsOpen.set(true);
    }
  }}
>
  <Settings />
  <span class="text-xs">{language.settings}</span>
</button>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full"
  class:text-textcolor2={!(
    $selectedCharID >= 0
  )}
  onclick={() => {
    reseter();
    openCharacterManager.set(true);
  }}
>
  <User2Icon />
  <span class="text-xs">{language.character}</span>
</button>
{#if !isEmbeddedRisuPane}
  <button
    class="flex items-center justify-center py-2 flex-col gap-1 w-full"
    class:text-textcolor2={!$splitChatOpen}
    class:text-primary={$splitChatOpen}
    aria-pressed={$splitChatOpen}
    aria-label="분할 채팅"
    title="분할 채팅 켜기/끄기"
    onclick={() => {
      toggleSplitChat()
    }}
  >
    <Columns2 />
    <span class="text-xs">분할</span>
  </button>
{/if}
</div>
{:else}
<div
  class="h-full flex-col items-center bg-bgcolor text-textcolor shadow-lg relative rs-sidebar"
  class:w-40={splitCatalogMode}
  class:min-w-40={splitCatalogMode}
  class:w-20={!splitCatalogMode}
  class:min-w-20={!splitCatalogMode}
  class:max-xs:hidden={$leftBarCollapsed}
  class:editMode
  class:risu-sub-sidebar={$sideBarClosing}
  class:risu-sub-sidebar-close={$sideBarClosing}
  class:hidden={hidden}
  class:flex={!hidden}
>
  {#if !DBState.db.hamburgerButtonBottom}
  <button
    class="flex h-8 min-h-8 w-14 min-w-14 cursor-pointer text-white mt-2 items-center justify-center rounded-md bg-textcolor2 transition-colors hover:bg-primary"
    class:max-xs:hidden={$leftBarCollapsed}
    aria-label="사이드바 메뉴"
    onclick={() => {
      menuMode = 1 - menuMode;
    }}><ListIcon />
  </button>
  {#if !DBState.db.hideLeftBarCollapseButton}
  <button
    class="hidden max-xs:flex h-8 min-h-8 w-14 min-w-14 cursor-pointer mt-2 items-center justify-center rounded-md border border-borderc text-textcolor transition-colors hover:border-primary hover:text-primary"
    aria-label="Collapse sidebar"
    onclick={() => leftBarCollapsed.set(true)}
  >
    <ChevronsLeft size={20} />
  </button>
  {/if}
  <div class="mt-2 border-b border-b-selected w-full relative text-white" class:max-xs:hidden={$leftBarCollapsed}>
    {#if menuMode === 1}
      <div class="absolute w-20 min-w-20 flex border-b-selected border-b bg-bgcolor flex-col items-center pt-2 rounded-b-md z-20 pb-2 max-h-[calc(100dvh-4rem)] overflow-x-hidden overflow-y-auto hamburger-menu">
        <BarIcon
        onClick={() => {
          if ($settingsOpen) {
            reseter();
            settingsOpen.set(false);
          } else {
            reseter();
            settingsOpen.set(true);
          }
        }}><Settings /></BarIcon
      >
      <div class="mt-2"></div>
      <BarIcon
        onClick={() => {
          reseter();
          deselectCharacter()
          PlaygroundStore.set(0)
          OpenRealmStore.set(false)
        }}><HomeIcon /></BarIcon>
      {#if !isEmbeddedRisuPane}
        <div class="mt-2"></div>
        <BarIcon
          ariaLabel="분할 채팅"
          title="분할 채팅 켜기/끄기"
          pressed={$splitChatOpen}
          onClick={() => {
            toggleSplitChat()
          }}
        ><Columns2 class={$splitChatOpen ? 'text-primary' : ''} /></BarIcon>
      {/if}
      <div class="mt-2"></div>
      <BarIcon
        onClick={() => {
          reseter();
          openCharacterManager.set(true);
        }}><LayoutGridIcon /></BarIcon
      >
      {#if additionalHamburgerMenu.length > 0}
        <div class="mt-2 h-px w-10 bg-selected shrink-0"></div>
        {#each additionalHamburgerMenu as menu}
          <div class="mt-2"></div>
          <BarIcon
            onClick={() => {
              reseter();
              menu.callback();
            }}>
              <PluginDefinedIcon ico={menu} />
            </BarIcon
          >
        {/each}
      {/if}
    </div>
    {/if}
  </div>
  {/if}
  <div class="mx-1 mb-1 flex w-[calc(100%_-_0.5rem)] shrink-0 items-center gap-1 rounded-md border border-selected bg-darkbg px-1.5"
    class:max-xs:hidden={$leftBarCollapsed}>
    <SearchIcon size={13} class="shrink-0 text-textcolor2"/>
    <input
      bind:value={catalogSearch}
      aria-label="캐릭터 검색"
      placeholder={splitCatalogMode ? language.search : ''}
      class="min-w-0 grow bg-transparent py-1 text-xs text-textcolor outline-none"
    />
  </div>
  <div class="flex grow min-h-0 w-full" class:max-xs:hidden={$leftBarCollapsed} use:touchDragContainer>
  {#if splitCatalogMode}
    {@render splitFolderColumn()}
    <MeasuredVirtualList
      items={splitCharacterBlocks}
      estimatedItemHeight={76}
      overscan={5}
      smallListThreshold={36}
      className="character-list h-full w-20 min-w-20 pr-0"
      ariaLabel="폴더 밖 개별 캐릭터"
      key={(block) => block.type === 'control'
        ? `split-control-${block.position}`
        : block.char.type === 'normal'
          ? `split-character-root-${DBState.db.characters[block.char.index]?.chaId ?? block.sourceOrder}`
          : `split-archived-root-${block.char.chaId}`}
    >
      {#snippet children(block)}
        {@render splitCharacterRow(block)}
      {/snippet}
    </MeasuredVirtualList>
  {:else}
  <MeasuredVirtualList
    items={sidebarCatalogBlocks}
    estimatedItemHeight={76}
    overscan={5}
    smallListThreshold={36}
    className="character-list h-full w-full pr-0"
    ariaLabel="Characters"
    scrollToIndex={sidebarScrollIndex}
    scrollRequestKey={sidebarScrollRequest}
      key={(block) => block.type === 'control'
        ? `control-${block.position}`
        : block.char.type === 'folder'
          ? `folder-${block.char.id}`
          : block.char.type === 'normal'
            ? `character-${DBState.db.characters[block.char.index]?.chaId ?? block.index}`
            : `archived-${block.char.chaId}`}
  >
    {#snippet children(block)}
    {#if block.type === 'control'}
      <div class="flex w-full flex-col items-center">
      {#if block.position === 'top'}
      {@render addCharacterButton('top')}
    <div class="h-4 min-h-4 w-14" role="listitem" data-spacer-index="0" ondragover={(e) => {
      if(!getCurrentSidebarDrag(e)){ return }
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      e.currentTarget.classList.add('bg-green-500')
    }} ondragleave={(e) => {
      e.currentTarget.classList.remove('bg-green-500')
    }} ondrop={(e) => {
      const drag = getCurrentSidebarDrag(e)
      if(!drag){ return }
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.classList.remove('bg-green-500')
      try {
        inserter(drag,{kind:'root',index:0})
      } finally {
        clearCurrentDrag()
      }
    }} ondragenter={preventAll}></div>
      {:else}
        {@render addCharacterButton('bottom')}
      {/if}
      </div>
    {:else}
      {@const char = block.char}
      {@const ind = block.index}
      <div class="flex w-full flex-col items-center">
      <div class="group relative flex items-center px-2"
        role="listitem"
        data-drag-kind={char.type === 'normal' ? 'character' : char.type === 'folder' ? 'folder' : undefined}
        data-drag-id={char.type === 'normal' || char.type === 'folder' ? char.id : undefined}
        draggable={!isTouchDevice && char.type !== 'archived' ? "true" : undefined}
        ondragstart={!isTouchDevice && char.type !== 'archived' ? (e) => {avatarDragStart(sidebarDragItem(char), e)} : undefined}
        ondragend={!isTouchDevice && char.type !== 'archived' ? clearCurrentDrag : undefined}
        ondragover={!isTouchDevice && char.type !== 'archived' ? avatarDragOver : undefined}
        ondrop={!isTouchDevice && char.type !== 'archived' ? (e) => {avatarDrop(sidebarDragItem(char), e)} : undefined}
        ondragenter={!isTouchDevice && char.type !== 'archived' ? preventAll : undefined}
        ontouchstart={touchDragEnabled && char.type !== 'archived' ? (e) => {onTouchDragStart(sidebarDragItem(char), e)} : undefined}
      >
        <SidebarIndicator
          isActive={char.type === 'normal' && $selectedCharID === char.index && sideBarMode !== 1}
        />
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
            role="button" tabindex="0"
            onpointerenter={() => char.type === "normal" && scheduleCharacterChatPrefetch(char.index)}
            onpointerleave={() => char.type === "normal" && cancelCharacterChatPrefetch(char.index)}
            onpointerdown={() => char.type === "normal" && void prefetchCharacterChat(char.index)}
            onfocus={() => char.type === "normal" && scheduleCharacterChatPrefetch(char.index)}
            onblur={() => char.type === "normal" && cancelCharacterChatPrefetch(char.index)}
            onclick={() => {
              if(suppressNextClick) return
              if(char.type === "normal"){
                changeChar(char.index, {reseter});
              } else if(char.type === "archived"){
                void promptActivateCharacter(char.chaId, {reseter});
              }
            }}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                if(char.type === "normal"){
                  changeChar(char.index, {reseter});
                } else if(char.type === "archived"){
                  void promptActivateCharacter(char.chaId, {reseter});
                }
              }
            }}
          >
          {#if char.type === 'normal'}
            <SidebarAvatar 
              src={char.img ? () => getCharThumbnail(char.img, "plain") : ""}
              size="56" 
              rounded={IconRounded} 
              name={char.name}
              favorite={char.favorite}
              titleColor={listTitleColor(DBState.db.characters[char.index]?.titleColor, Number(DBState.db.characters[char.index]?.sourceInfo?.missingAssetCount) > 0)}
              missingAssets={Number(DBState.db.characters[char.index]?.sourceInfo?.missingAssetCount) > 0}
              realmRecoveryAvailable={isRealmAssetRecoveryAvailable(DBState.db.characters[char.index])}
              chaId={DBState.db.characters[char.index]?.chaId}
              oncontextmenu={(e) => { void editSidebarCharacter(char.index, e) }}
            />
          {:else if char.type === 'archived'}
            <div class="relative grayscale opacity-60 archived-character-muted">
              <SidebarAvatar
                src={char.img ? () => getCharThumbnail(char.img, "plain") : ""}
                size="56"
                rounded={IconRounded}
                name={`${char.name} (${language.deactivatedBadge})`}
                chaId={char.chaId}
              />
              <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55" class:rounded-md={!IconRounded} class:rounded-full={IconRounded}>
                <ArchiveIcon size={20} class="text-white/90" />
              </div>
            </div>
          {:else if char.type === "folder"}
            {#key char.color}
            {#key char.name}
              <SidebarAvatar src="slot" size="56" rounded={IconRounded} folderShape name={char.name} color={char.color} favorite={char.favorite} backgroundimg={char.display === 'image' && char.img ? () => getCharThumbnail(char.img, "plain") : ""}
              oncontextmenu={(e) => { void editSidebarFolder(ind, char, e) }}
              onClick={() => {
                if(suppressNextClick) return
                if(char.type !== 'folder'){
                  return
                }
                if(openFolders.includes(char.id)){
                  openFolders.splice(openFolders.indexOf(char.id), 1)
                }
                else{
                  openFolders.push(char.id)
                }
                openFolders = openFolders
              }}>
                {@const CustomIcon = folderIconComponent(char.icon)}
                {#if char.display === 'name'}
                  <div class="h-full w-full flex justify-center items-center">
                    <span class="hyphens-auto truncate font-bold">{char.name}</span>
                  </div>
                {:else if char.display === 'icon' && CustomIcon}
                  <CustomIcon />
                {:else if openFolders.includes(char.id)}
                  <FolderOpenIcon />
                {:else}
                  <FolderIcon />
                {/if}
              </SidebarAvatar>
            {/key}
            {/key}
          {/if}
        </div>
      </div>
      {#if char.type === 'folder' && openFolders.includes(char.id)}
        {#key char.color}
        <div class="p-1 flex flex-col items-center py-1 mt-1 rounded-lg relative">
          <div class="absolute top-0 left-1 border border-selected w-full h-full rounded-lg z-0 {
            char.color === 'red' ? 'bg-red-700/20' :
            char.color === 'yellow' ? 'bg-yellow-700/20' :
            char.color === 'green' ? 'bg-green-700/20' :
            char.color === 'blue' ? 'bg-blue-700/20' :
            char.color === 'indigo' ? 'bg-indigo-700/20' :
            char.color === 'purple' ? 'bg-purple-700/20' :
            char.color === 'pink' ? 'bg-pink-700/20' :
            'bg-darkbg/20'
          }"></div>
          <div class="h-4 min-h-4 w-14 relative z-10" role="listitem" data-spacer-index="0" data-spacer-folder={char.type === 'folder' ? char.id : undefined} ondragover={(e) => {
            if(!getCurrentSidebarDrag(e)){ return }
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            e.currentTarget.classList.add('bg-green-500')
          }} ondragleave={(e) => {
            e.currentTarget.classList.remove('bg-green-500')
          }} ondrop={(e) => {
            const drag = getCurrentSidebarDrag(e)
            if(!drag){ return }
            e.preventDefault()
            e.stopPropagation()
            e.currentTarget.classList.remove('bg-green-500')
            try {
              if(char.type === 'folder'){
                inserter(drag,{kind:'folder',folderId:char.id,index:0})
              }
            } finally {
              clearCurrentDrag()
            }
          }} ondragenter={preventAll}></div>
          {#each char.folder as char2, ind}
              {@const sourceFolderIndex = char2.folderIndex ?? ind}
              <div class="sidebar-folder-character group relative flex items-center px-2 z-10"
              role="listitem"
              data-drag-kind={char2.type === 'normal' ? 'character' : undefined}
              data-drag-id={char2.type === 'normal' ? char2.id : undefined}
              draggable={!isTouchDevice && char2.type === 'normal' ? "true" : undefined}
              ondragstart={!isTouchDevice && char2.type === 'normal' ? (e) => {avatarDragStart({kind:'character', id:char2.id}, e)} : undefined}
              ondragend={!isTouchDevice && char2.type === 'normal' ? clearCurrentDrag : undefined}
              ondragover={!isTouchDevice && char2.type === 'normal' ? avatarDragOver : undefined}
              ondrop={!isTouchDevice && char2.type === 'normal' ? (e) => {avatarDrop({kind:'character', id:char2.id}, e)} : undefined}
              ondragenter={!isTouchDevice && char2.type === 'normal' ? preventAll : undefined}
              ontouchstart={touchDragEnabled && char2.type === 'normal' ? (e) => {onTouchDragStart({kind:'character', id:char2.id}, e)} : undefined}
            >
              <SidebarIndicator
                isActive={char2.type === 'normal' && $selectedCharID === char2.index && sideBarMode !== 1}
              />
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <div
                  role="button" tabindex="0"
                  onpointerenter={() => char2.type === "normal" && scheduleCharacterChatPrefetch(char2.index)}
                  onpointerleave={() => char2.type === "normal" && cancelCharacterChatPrefetch(char2.index)}
                  onpointerdown={() => char2.type === "normal" && void prefetchCharacterChat(char2.index)}
                  onfocus={() => char2.type === "normal" && scheduleCharacterChatPrefetch(char2.index)}
                  onblur={() => char2.type === "normal" && cancelCharacterChatPrefetch(char2.index)}
                  onclick={() => {
                    if(suppressNextClick) return
                    if(char2.type === "normal"){
                      changeChar(char2.index, {reseter});
                    } else if(char2.type === "archived"){
                      void promptActivateCharacter(char2.chaId, {reseter});
                    }
                  }}
                  onkeydown={(e) => {
                    if (e.key === "Enter") {
                      if(char2.type === "normal"){
                        changeChar(char2.index, {reseter});
                      } else if(char2.type === "archived"){
                        void promptActivateCharacter(char2.chaId, {reseter});
                      }
                    }
                  }}
                >
                {#if char2.type === 'archived'}
                  <div class="relative grayscale opacity-60 archived-character-muted">
                    <SidebarAvatar
                      src={char2.img ? () => getCharThumbnail(char2.img, "plain") : ""}
                      size="56"
                      rounded={IconRounded}
                      name={`${char2.name} (${language.deactivatedBadge})`}
                      chaId={char2.chaId}
                    />
                    <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55" class:rounded-md={!IconRounded} class:rounded-full={IconRounded}>
                      <ArchiveIcon size={20} class="text-white/90" />
                    </div>
                  </div>
                {:else}
                  <SidebarAvatar
                    src={char2.img ? () => getCharThumbnail(char2.img, "plain") : ""}
                    size="56"
                    rounded={IconRounded}
                    name={char2.name}
                    favorite={char2.favorite}
                    titleColor={listTitleColor(DBState.db.characters[char2.index]?.titleColor, Number(DBState.db.characters[char2.index]?.sourceInfo?.missingAssetCount) > 0)}
                    missingAssets={Number(DBState.db.characters[char2.index]?.sourceInfo?.missingAssetCount) > 0}
                    realmRecoveryAvailable={isRealmAssetRecoveryAvailable(DBState.db.characters[char2.index])}
                    chaId={DBState.db.characters[char2.index]?.chaId}
                    oncontextmenu={(e) => { void editSidebarCharacter(char2.index, e) }}
                  />
                {/if}
              </div>
            </div>
            <div class="h-4 min-h-4 w-14 relative z-20" role="listitem" data-spacer-index={sourceFolderIndex+1} data-spacer-folder={char.type === 'folder' ? char.id : undefined} ondragover={(e) => {
              if(!getCurrentSidebarDrag(e)){ return }
              e.preventDefault()
              e.stopPropagation()
              e.dataTransfer.dropEffect = 'move'
              e.currentTarget.classList.add('bg-green-500')
            }} ondragleave={(e) => {
              e.currentTarget.classList.remove('bg-green-500')
            }} ondrop={(e) => {
              const drag = getCurrentSidebarDrag(e)
              if(!drag){ return }
              e.preventDefault()
              e.stopPropagation()
              e.currentTarget.classList.remove('bg-green-500')
              try {
                if(char.type === 'folder'){
                  inserter(drag,{kind:'folder',folderId:char.id,index:sourceFolderIndex+1})
                }
              } finally {
                clearCurrentDrag()
              }
            }} ondragenter={preventAll}></div>
          {/each}
        </div>
        {/key}
      {/if}
      <div class="h-4 min-h-4 w-14" role="listitem" data-spacer-index={ind+1} ondragover={((e) => {
        if(!getCurrentSidebarDrag(e)){ return }
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        e.currentTarget.classList.add('bg-green-500')
      })} ondragleave={(e) => {
        e.currentTarget.classList.remove('bg-green-500')
      }} ondrop={(e) => {
        const drag = getCurrentSidebarDrag(e)
        if(!drag){ return }
        e.preventDefault()
        e.stopPropagation()
        e.currentTarget.classList.remove('bg-green-500')
        try {
          inserter(drag,{kind:'root',index:ind+1})
        } finally {
          clearCurrentDrag()
        }
      }} ondragenter={preventAll}></div>
      </div>
    {/if}
    {/snippet}
  </MeasuredVirtualList>
  {/if}
  </div>
  {#if DBState.db.hamburgerButtonBottom}
  <div class="border-t border-t-selected w-full relative text-white" class:max-xs:hidden={$leftBarCollapsed}>
    {#if menuMode === 1}
      <div class="absolute bottom-full w-20 min-w-20 flex border-t-selected border-t bg-bgcolor flex-col items-center pt-2 rounded-t-md z-20 pb-2 max-h-[calc(100dvh-4rem)] overflow-x-hidden overflow-y-auto hamburger-menu">
        <BarIcon
        onClick={() => {
          if ($settingsOpen) {
            reseter();
            settingsOpen.set(false);
          } else {
            reseter();
            settingsOpen.set(true);
          }
        }}><Settings /></BarIcon
      >
      <div class="mt-2"></div>
      <BarIcon
        onClick={() => {
          reseter();
          deselectCharacter()
          PlaygroundStore.set(0)
          OpenRealmStore.set(false)
        }}><HomeIcon /></BarIcon>
      {#if !isEmbeddedRisuPane}
        <div class="mt-2"></div>
        <BarIcon
          ariaLabel="분할 채팅"
          title="분할 채팅 켜기/끄기"
          pressed={$splitChatOpen}
          onClick={() => {
            toggleSplitChat()
          }}
        ><Columns2 class={$splitChatOpen ? 'text-primary' : ''} /></BarIcon>
      {/if}
      <div class="mt-2"></div>
      <BarIcon
        onClick={() => {
          reseter();
          openCharacterManager.set(true);
        }}><LayoutGridIcon /></BarIcon
      >
      {#if additionalHamburgerMenu.length > 0}
        <div class="mt-2 h-px w-10 bg-selected shrink-0"></div>
        {#each additionalHamburgerMenu as menu}
          <div class="mt-2"></div>
          <BarIcon
            onClick={() => {
              reseter();
              menu.callback();
            }}>
              <PluginDefinedIcon ico={menu} />
            </BarIcon
          >
        {/each}
      {/if}
    </div>
    {/if}
  </div>
  {#if !DBState.db.hideLeftBarCollapseButton}
  <button
    class="hidden max-xs:flex h-8 min-h-8 w-14 min-w-14 cursor-pointer mt-2 items-center justify-center rounded-md border border-borderc text-textcolor transition-colors hover:border-primary hover:text-primary"
    aria-label="Collapse sidebar"
    onclick={() => leftBarCollapsed.set(true)}
  >
    <ChevronsLeft size={20} />
  </button>
  {/if}
  <button
    class="flex h-8 min-h-8 w-14 min-w-14 cursor-pointer text-white mb-2 mt-2 items-center justify-center rounded-md bg-textcolor2 transition-colors hover:bg-primary"
    class:max-xs:hidden={$leftBarCollapsed}
    aria-label="사이드바 메뉴"
    onclick={() => {
      menuMode = 1 - menuMode;
    }}><ListIcon />
  </button>
  {/if}
</div>
{/if}
<div
  class="setting-area h-full max-xs:relative flex-col overflow-x-hidden bg-darkbg py-6 text-textcolor max-h-full"
  class:overflow-y-auto={!quickSettingsVisible}
  class:overflow-y-hidden={quickSettingsVisible}
  class:risu-sidebar={!$sideBarClosing}
  class:w-96={$sideBarSize === 0}
  class:w-110={$sideBarSize === 1}
  class:w-124={$sideBarSize === 2}
  class:w-138={$sideBarSize === 3}
  class:risu-sidebar-close={$sideBarClosing}
  class:min-w-96={!$DynamicGUI && $sideBarSize === 0}
  class:min-w-110={!$DynamicGUI && $sideBarSize === 1}
  class:min-w-124={!$DynamicGUI && $sideBarSize === 2}
  class:min-w-138={!$DynamicGUI && $sideBarSize === 3}
  class:px-2={$DynamicGUI}
  class:px-4={!$DynamicGUI}
  class:dynamic-sidebar={$DynamicGUI}
  class:hidden={hidden}
  class:flex={!hidden}
  onanimationend={() => {
    if($sideBarClosing){
      $sideBarClosing = false
      sideBarStore.set(false)
    }
  }}
>
  <button
    class="flex w-full justify-end text-textcolor"
    onclick={async () => {
      if($sideBarClosing){
        return
      }
      $sideBarClosing = true;
    }}
  >
    <!-- <button class="border-none bg-transparent p-0 text-textcolor"><X /></button> -->
  </button>
  {#if $leftBarCollapsed}
    <button
      class="hidden max-xs:flex absolute top-3 left-0 h-12 w-12 border-r border-b border-t border-borderc rounded-r-md bg-darkbg hover:border-neutral-200 transition-colors items-center justify-center text-textcolor opacity-50 hover:opacity-90 z-20"
      aria-label="Expand sidebar"
      onclick={() => leftBarCollapsed.set(false)}
    >
      <ArrowRight />
    </button>
  {/if}
  {#if sideBarMode === 0}
    <!-- Keep the primary sidebar destinations stable on the recent-chat home,
         selected-character views, and the module panel alike. Previously the
         home hid this row until Modules was opened, which made navigation
         appear as a one-off module-only control. -->
    <div class="w-full h-8 min-h-8 border-l border-b border-r border-selected relative bottom-6 rounded-b-md flex">
      <button
        type="button"
        onclick={openChatTab}
        class="grow border-r border-r-selected rounded-bl-md"
        class:text-textcolor2={QuickSettings.open || $botMakerMode || devTool}
        aria-pressed={!QuickSettings.open && !$botMakerMode && !devTool}
      >{language.Chat}</button>
      <button
        type="button"
        onclick={openCharacterTab}
        class="grow border-r border-r-selected"
        class:text-textcolor2={QuickSettings.open || !$botMakerMode || devTool}
        aria-pressed={!QuickSettings.open && $botMakerMode && !devTool}
      >{language.character}</button>
      <button
        type="button"
        onclick={openModuleTab}
        class="grow rounded-br-md"
        class:text-textcolor2={!QuickSettings.open || (hasEditableCharacter && QuickSettings.index !== 2)}
        aria-pressed={QuickSettings.open && (!hasEditableCharacter || QuickSettings.index === 2)}
      >{language.module}</button>
      {#if DBState.db.enableDevTools}
        <button
          type="button"
          onclick={() => {
            QuickSettings.open = false
            devTool = true
          }}
          class="border-l border-l-selected rounded-br-md px-1"
          class:text-textcolor2={!devTool || QuickSettings.open}
          aria-label="Developer tools"
          aria-pressed={devTool && !QuickSettings.open}
        >
          <WrenchIcon size={18} />
        </button>
      {/if}
    </div>
    {#if QuickSettings.open}
      <LazyComponent loader={loadQuickSettings} />
    {:else if $selectedCharID < 0 || $settingsOpen}
      <span class="block text-base font-semibold text-textcolor mt-2">{language.recentChatsTitle}</span>
      {#if DBState.db.nodeOnlyHideRecentChats}
        <!-- list hidden by user preference -->
      {:else if recentChars.length === 0}
        <span class="block text-sm text-textcolor2 mt-2">{language.noRecentChatsDesc}</span>
      {:else}
        <div class="flex flex-col gap-1.5 mt-2">
          {#each recentChars.slice(0, recentVisible) as rc (rc.index)}
            <button
              type="button"
              class="group flex items-center gap-2.5 rounded-md border border-borderc/10 bg-darkbg p-2 text-left transition-colors hover:border-borderc/30 hover:bg-selected/50"
              onpointerenter={() => scheduleCharacterChatPrefetch(rc.index)}
              onpointerleave={() => cancelCharacterChatPrefetch(rc.index)}
              onpointerdown={() => void prefetchCharacterChat(rc.index)}
              onfocus={() => scheduleCharacterChatPrefetch(rc.index)}
              onblur={() => cancelCharacterChatPrefetch(rc.index)}
              onclick={() => changeChar(rc.index, {reseter})}
            >
              <div class="shrink-0">
                <SidebarAvatar
                  src={rc.image ? () => getCharThumbnail(rc.image, "plain") : ""}
                  size="36"
                  rounded={IconRounded}
                  name={rc.name}
                  favorite={rc.favorite}
                  titleColor={listTitleColor(DBState.db.characters[rc.index]?.titleColor, Number(DBState.db.characters[rc.index]?.sourceInfo?.missingAssetCount) > 0)}
                  missingAssets={Number(DBState.db.characters[rc.index]?.sourceInfo?.missingAssetCount) > 0}
                  realmRecoveryAvailable={isRealmAssetRecoveryAvailable(DBState.db.characters[rc.index])}
                  chaId={DBState.db.characters[rc.index]?.chaId}
                />
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-semibold text-textcolor leading-tight truncate" style:color={listTitleColor(DBState.db.characters[rc.index]?.titleColor, Number(DBState.db.characters[rc.index]?.sourceInfo?.missingAssetCount) > 0)}>{rc.name || "Unnamed"}</div>
                <div class="text-xs text-textcolor2 leading-tight truncate">{makeAgoText(rc.lastInteraction)}</div>
              </div>
            </button>
          {/each}
          {#if recentVisible < recentChars.length}
            <button
              type="button"
              class="w-full rounded-md border border-borderc/10 bg-darkbg p-2 text-center text-sm text-textcolor2 transition-colors hover:border-borderc/30 hover:bg-selected/50 hover:text-textcolor"
              onclick={() => recentVisible += 10}
            >
              {language.loadMore}
            </button>
          {/if}
        </div>
      {/if}
    {:else if DBState.db.characters[$selectedCharID]?.chaId === '§playground'}
      <LazyComponent loader={loadSideChatList} props={{ chara: DBState.db.characters[$selectedCharID] }} />
    {:else}
      {#if devTool}
        <LazyComponent loader={loadDevTool} />
      {:else if $botMakerMode}
        <LazyComponent loader={loadCharConfig} />
      {:else}
        <LazyComponent loader={loadSideChatList} props={{ chara: DBState.db.characters[$selectedCharID] }} />
      {/if}
    {/if}
  {/if}
</div>

{#if $DynamicGUI}
    <div role="button" tabindex="0" class="grow h-full min-w-12"
      class:max-xs:!min-w-8={!$leftBarCollapsed}
      class:max-xs:!min-w-6={$leftBarCollapsed}
      class:hidden={hidden} onclick={() => {
      if($sideBarClosing){
        return
      }
      $sideBarClosing = true;
    }}
      onkeydown={(e)=>{
        if(e.key === 'Enter'){
            e.currentTarget.click()
        }
      }}
      class:sidebar-dark-animation={!$sideBarClosing}
      class:sidebar-dark-close-animation={$sideBarClosing}>

    </div>

{/if}

<style>
  .editMode {
    min-width: 6rem;
  }
  @keyframes sidebar-transition {
    from {
      width: 0rem;
    }
    to {
      width: var(--sidebar-size);
    }
  }
  @keyframes sidebar-transition-close {
    from {
      width: var(--sidebar-size);
      right:0rem;
    }
    to {
      width: 0rem;
      right: 10rem;
    }
  }
  @keyframes sidebar-transition-non-dynamic {
    from {
      width: 0rem;
      min-width: 0rem;
    }
    to {
      width: var(--sidebar-size);
      min-width: var(--sidebar-size);
    }
  }
  @keyframes sidebar-transition-close-non-dynamic {
    from {
      width: var(--sidebar-size);
      min-width: var(--sidebar-size);
      right:0rem;
    }
    to {
      width: 0rem;
      min-width: 0rem;
      right:3rem;
    }
  }
  @keyframes sub-sidebar-transition {
    from {
      width: 0rem;
      min-width: 0rem;
    }
    to {
      width: 5rem;
      min-width: 5rem;
    }
  }
  @keyframes sub-sidebar-transition-close {
    from {
      width: 5rem;
      min-width: 5rem;
      max-width: 5rem;
      right:0rem;

    }
    to {
      width: 0rem;
      min-width: 0rem;
      max-width: 0rem;
      right: 10rem;
    }
  }
  @keyframes sidebar-dark-animation{
    from {
      background-color: rgba(0,0,0,0) !important;
    }
    to {
      background-color: rgba(0,0,0,0.5) !important;
    }
  }
  @keyframes sidebar-dark-closing-animation{
    from {
      background-color: rgba(0,0,0,0.5) !important;
    }
    to {
      background-color: rgba(0,0,0,0) !important;
    }
  }

  .risu-sidebar:not(.dynamic-sidebar) {
    animation-name: sidebar-transition-non-dynamic;
    animation-duration: var(--risu-animation-speed);
  }
  .risu-sidebar-close:not(.dynamic-sidebar) {
    animation-name: sidebar-transition-close-non-dynamic;
    animation-duration: var(--risu-animation-speed);
    position: relative;
  }
  .risu-sidebar.dynamic-sidebar {
    animation-name: sidebar-transition;
    animation-duration: var(--risu-animation-speed);
  }
  .risu-sidebar-close.dynamic-sidebar {
    animation-name: sidebar-transition-close;
    animation-duration: var(--risu-animation-speed);
    position: relative;
    right: 3rem;
  }


  .risu-sub-sidebar {
    animation-name: sub-sidebar-transition;
    animation-duration: var(--risu-animation-speed);
  }
  .risu-sub-sidebar-close {
    animation-name: sub-sidebar-transition-close;
    animation-duration: var(--risu-animation-speed);
    position: relative;
  }
  .sidebar-dark-animation{
    animation-name: sidebar-dark-transition;
    animation-duration: var(--risu-animation-speed);
    background-color: rgba(0,0,0,0.5)
  }
  .sidebar-dark-close-animation{
    animation-name: sidebar-dark-closing-transition;
    animation-duration: var(--risu-animation-speed);
    background-color: rgba(0,0,0,0)
  }
  .hamburger-menu {
    scrollbar-width: none;
    overscroll-behavior: none;
  }
  .hamburger-menu::-webkit-scrollbar {
    display: none;
  }
  :global(.character-list) {
    scrollbar-width: none;
  }
  :global(.character-list::-webkit-scrollbar) {
    display: none;
  }
  .sidebar-folder-character {
    content-visibility: auto;
    contain-intrinsic-size: 56px 56px;
  }
</style>
