import { useT } from "../../i18n/I18nProvider";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BLOCK_CLIPBOARD_MIME, breakpointForWidth, isBlockLocked, type EditorLockFlag } from "@justflows/blocks";
import type { BlockDocument, BlockCatalogEntry, BlockNode } from "./types";
import BlockLibrary from "./BlockLibrary";
import BlockInspector from "./BlockInspector";
import Navigator from "./Navigator";
import { CORE_INLINE_FIELDS, InlineFieldsContext } from "./inline-field";
import { PageCanvas } from "./BlockCanvas";
import { BuilderDragProvider, useBuilderDrag, type DropStatus } from "./DragContext";
import { createBlock } from "./block-defaults";
import {
  findBlockPath,
  getBlockAtPath,
  insertBlock,
  reassignBlockIds,
  cloneBlocks,
  updateBlockProps,
  updateBlockTree,
  historyStepKey,
} from "./block-tree";
import { getChildCount, getParentType, libraryTargetParent, HEADER_SLOT_PARENT_TYPE } from "./dnd";
import HeaderChrome, { HeaderInspector, previewNavLabels, type HeaderMenu } from "./HeaderChrome";
import PageJsonPanel from "./PageJsonPanel";
import { GRID_BLOCK_TYPE, gridColumns } from "./grid";
import { useBuilderHistory } from "./useBuilderHistory";
import { useReusableBlocks } from "./ReusablePanel";
import { mergePatternBlocks } from "./pattern-insert";
import {
  DEFAULT_PAGE_HEADER,
  HEADER_SELECTED_ID,
  type PageHeaderConfig,
} from "../../lib/page-header";
import { MergeTagsContext } from "../../lib/merge-tags";
import { PreviewSchemeContext, THEME_PREVIEW_SCOPE, type PreviewScheme } from "./BlockPreview";
import BuilderShell, { type BuilderContext, type BuilderShellBar } from "./shell/BuilderShell";
import { useBuilderPrefs } from "./shell/builder-prefs";
import { selectionCrumbs } from "./shell/breadcrumbs";
import { useOptionalCapability, useOptionalSessionRole, useOptionalSessionUserId } from "../SessionProvider";
import { uid } from "../../lib/uid";
import {
  actionStates,
  duplicateBlocks,
  extendSelection,
  groupBlocks,
  insertBlocksAt,
  pasteTarget,
  removeBlocks,
  resetBlockStyles,
  siblingSet,
  ungroupBlock,
  type BlockAction,
} from "./block-actions";
import BlockActionsMenu from "./BlockActionsMenu";
import { ancestorElementsOf } from "./LayoutControls";
import { TemplateDefaultsContext, type TemplateContextValue } from "./template-defaults-context";
import SiteContextFrame, { type SiteContextMeta } from "./SiteContextFrame";
import type { SiteContextData, SiteRegion } from "../../lib/site-context";
import MultiSelectionInspector from "./MultiSelectionInspector";
import SaveSelectionDialog, { type SaveKind } from "./SaveSelectionDialog";
import { blocksFromClipboard, canPasteBlocks, readClipboardText, writeBlockClipboard } from "./builder-clipboard";
import { saveBlockPattern, saveReusableBlocks } from "./builder-library";
import { BuilderSelectionContext, anchorFor, type BuilderSelection, type MenuAnchor, type SelectModifiers } from "./selection-context";

const PREVIEW_SCHEME_KEY = "jf-builder-preview-scheme";

/** The editor's last choice, else the admin's own scheme (which follows the OS). */
function initialPreviewScheme(): PreviewScheme {
  try {
    const saved = localStorage.getItem(PREVIEW_SCHEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* storage blocked */
  }
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export type { BlockDocument, BlockNode } from "./types";

interface PageBuilderProps {
  value: BlockDocument;
  onChange: (doc: BlockDocument) => void;
  compact?: boolean;
  enableHeader?: boolean;
  header?: PageHeaderConfig;
  onHeaderChange?: (header: PageHeaderConfig) => void;
  /** Edit only the header chrome — no page-body canvas or JSON panel. For the theme customizer. */
  headerOnly?: boolean;
  /** Full standalone page vs. a post/article body. Hides page-only library items (whole-page patterns, site chrome widgets). */
  isPage?: boolean;
  /** Values for `{{tags}}` supplied by plugins through `content.mergeTags`. */
  mergeTags?: Record<string, string>;
  /** Restrict the block library/inserters to these types (e.g. a mega-menu region's safe subset).
   * Omit for the full catalog. Blocks already in `value` keep rendering even if not in this list —
   * this only narrows what can be *added*, it does not strip existing content. */
  allowedBlockTypes?: string[];
  /** Set false when embedding more than one `PageBuilder` at once (e.g. one per mega-menu region
   * inside a page that already has its own undo/redo) — each instance's ⌘Z/⌘⇧Z is a global
   * listener, so more than one live at a time means a single keypress undoes all of them. */
  enableKeyboardShortcut?: boolean;
  /** This value is a content fragment (a mega-menu region, a reusable snippet), not a whole page —
   * its root offers every allowed block directly instead of requiring a Section wrapper first. */
  flatCanvas?: boolean;
  /** What is being edited; drives the shell's context badge and site-wide warning. */
  context?: BuilderContext;
  /** Top bar for a stand-alone builder route. Embedded builders leave it out. */
  shellBar?: BuilderShellBar;
  /** Site navigation and document controls shown beside the block library. */
  sitePanel?: ReactNode;
  /** Global styles and presets panel (justflows-ce#301). */
  stylesPanel?: ReactNode;
  /** The template this document renders through and its style defaults, when wrapped by one. */
  templateContext?: TemplateContextValue | null;
  /** The page's surroundings, drawn read-only around the content (justflows-ce#303). */
  siteContext?: SiteContextData | null;
  siteContextMeta?: SiteContextMeta;
  /** Step into editing a site-wide region; receives the current selection so it can be restored on return. */
  onEnterSiteContext?: (region: SiteRegion, slug: string | null | undefined, selectedId: string | null) => void;
  /** A block to select once the document is loaded, e.g. after returning from a site-wide part. */
  initialSelectedId?: string | null;
}

export default function PageBuilder({
  value,
  onChange,
  compact = false,
  enableHeader = false,
  header,
  onHeaderChange,
  headerOnly = false,
  isPage = false,
  mergeTags,
  allowedBlockTypes,
  enableKeyboardShortcut = true,
  flatCanvas = false,
  context,
  shellBar,
  sitePanel,
  stylesPanel,
  templateContext = null,
  siteContext = null,
  siteContextMeta,
  onEnterSiteContext,
  initialSelectedId = null,
}: PageBuilderProps) {
  const { t } = useT();
  const [prefs, setPrefs] = useBuilderPrefs(useOptionalSessionUserId());
  const shellContext: BuilderContext = context ?? (headerOnly ? "header" : isPage ? "page" : "post");
  /**
   * Selected block ids and the anchor a Shift+click range starts from
   * (justflows-ce#298). One id is an ordinary selection; several are always
   * siblings of one parent in one region.
   */
  const [selection, setSelection] = useState<{ ids: string[]; anchor: string | null }>({ ids: [], anchor: null });
  const setSelectedId = useCallback(
    (id: string | null) => setSelection(id ? { ids: [id], anchor: id } : { ids: [], anchor: null }),
    [],
  );
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** Restore a remembered selection once, as soon as the block exists. */
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !initialSelectedId) return;
    const list = Array.isArray(value?.blocks) ? value.blocks : [];
    if (findBlockPath(list, initialSelectedId)) {
      restoredRef.current = true;
      setSelection({ ids: [initialSelectedId], anchor: initialSelectedId });
    }
  }, [initialSelectedId, value]);
  /** Measured canvas width, so the Responsive tab starts at the breakpoint being previewed. */
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [saveDialog, setSaveDialog] = useState<SaveKind | null>(null);
  const announceRef = useRef<(status: DropStatus) => void>(() => {});
  const canManageLocks = useOptionalCapability("content:locks:manage");
  const role = useOptionalSessionRole();
  const canSaveLibrary = role === "administrator" || role === "editor";
  const [previewScheme, setPreviewSchemeState] = useState<PreviewScheme>(initialPreviewScheme);
  const setPreviewScheme = (scheme: PreviewScheme) => {
    setPreviewSchemeState(scheme);
    try {
      localStorage.setItem(PREVIEW_SCHEME_KEY, scheme);
    } catch {
      /* storage blocked */
    }
  };
  const [fullCatalog, setFullCatalog] = useState<BlockCatalogEntry[]>([]);
  const catalog = useMemo(
    () =>
      allowedBlockTypes
        ? fullCatalog.filter((entry) => allowedBlockTypes.includes(entry.type))
        : fullCatalog,
    [fullCatalog, allowedBlockTypes],
  );
  const [menus, setMenus] = useState<HeaderMenu[]>([]);
  const [identity, setIdentity] = useState({ siteTitle: t("ui.pageBuilder.siteTitle"), logoUrl: "" });
  const [siteDefaultSlug, setSiteDefaultSlug] = useState("primary");
  const pageHeader = header ?? DEFAULT_PAGE_HEADER;
  const { items: reusable, reload: reloadReusable } = useReusableBlocks();

  useEffect(() => {
    fetch("/api/blocks")
      .then((r) => r.json())
      .then((data: { blocks: BlockCatalogEntry[] }) => setFullCatalog(data.blocks ?? []))
      .catch(() => setFullCatalog([]));
  }, []);

  useEffect(() => {
    if (!enableHeader) return;
    fetch("/api/menus")
      .then((r) => r.json())
      .then((data: { menus?: HeaderMenu[] }) => setMenus(data.menus ?? []))
      .catch(() => setMenus([]));
    fetch("/api/site/identity")
      .then((r) => r.json())
      .then((data: { siteTitle?: string; logoUrl?: string; headerMenu?: string }) => {
        setIdentity({
          siteTitle: data.siteTitle ?? t("ui.pageBuilder.siteTitle"),
          logoUrl: data.logoUrl ?? "",
        });
        if (data.headerMenu?.trim()) setSiteDefaultSlug(data.headerMenu.trim());
      })
      .catch(() => {});
  }, [enableHeader]);

  const catalogMap = useMemo(() => new Map(catalog.map((b) => [b.type, b])), [catalog]);
  const inlineFields = useMemo(
    () =>
      new Map([
        ...CORE_INLINE_FIELDS,
        ...catalog.filter((b) => b.inline && Object.keys(b.inline).length > 0).map((b) => [b.type, b.inline!] as const),
      ]),
    [catalog],
  );
  const blocks = Array.isArray(value?.blocks) ? value.blocks : [];
  const headerBlocks = Array.isArray(pageHeader.blocks) ? (pageHeader.blocks as BlockNode[]) : [];
  /** Ids that still exist after an undo, a remote reload, or a delete. */
  const selectedIds = useMemo(
    () =>
      selection.ids.filter(
        (id) => id === HEADER_SELECTED_ID || Boolean(findBlockPath(blocks, id) || findBlockPath(headerBlocks, id)),
      ),
    [selection.ids, blocks, headerBlocks],
  );
  const selectedId =
    selectedIds.length === 0
      ? null
      : selection.anchor && selectedIds.includes(selection.anchor)
        ? selection.anchor
        : selectedIds[selectedIds.length - 1]!;

  const history = useBuilderHistory<BlockNode[]>(
    blocks,
    useCallback((restored: BlockNode[]) => onChange({ version: 1, blocks: restored }), [onChange]),
    { enableShortcut: enableKeyboardShortcut },
  );

  const emit = useCallback(
    (nextBlocks: BlockNode[]) => {
      history.record(nextBlocks, { coalesce: historyStepKey(blocks, nextBlocks) });
      onChange({ version: 1, blocks: nextBlocks });
    },
    [history, onChange, blocks],
  );

  const emitHeaderBlocks = useCallback(
    (nextBlocks: BlockNode[]) => {
      onHeaderChange?.({ ...pageHeader, blocks: nextBlocks });
    },
    [onHeaderChange, pageHeader],
  );

  const selectedInHeader = Boolean(
    selectedId && selectedId !== HEADER_SELECTED_ID && findBlockPath(headerBlocks, selectedId),
  );

  const selectedBlock = useMemo(() => {
    if (!selectedId || selectedId === HEADER_SELECTED_ID) return null;
    const headerPath = findBlockPath(headerBlocks, selectedId);
    if (headerPath) return getBlockAtPath(headerBlocks, headerPath);
    const path = findBlockPath(blocks, selectedId);
    if (!path) return null;
    return getBlockAtPath(blocks, path);
  }, [blocks, headerBlocks, selectedId]);

  /** The block the selection sits in, so the inspector can offer grid placement. */
  const selectedParent = useMemo(() => {
    if (!selectedId) return null;
    const walk = (list: BlockNode[]): BlockNode | null => {
      for (const node of list) {
        if (node.children?.some((child) => child.id === selectedId)) return node;
        const nested = node.children ? walk(node.children) : null;
        if (nested) return nested;
      }
      return null;
    };
    return walk(blocks) ?? walk(headerBlocks);
  }, [blocks, headerBlocks, selectedId]);

  const libraryParentType = useMemo(() => {
    if (selectedId === HEADER_SELECTED_ID) return HEADER_SLOT_PARENT_TYPE;
    if (selectedInHeader) {
      return getParentType(headerBlocks, libraryTargetParent(headerBlocks, selectedId, catalogMap));
    }
    return getParentType(blocks, libraryTargetParent(blocks, selectedId, catalogMap));
  }, [blocks, headerBlocks, selectedId, selectedInHeader, catalogMap]);

  const addFromLibrary = useCallback(
    (type: string) => {
      const inHeader = selectedId === HEADER_SELECTED_ID || selectedInHeader;
      if (inHeader && onHeaderChange) {
        const parentId =
          selectedId === HEADER_SELECTED_ID
            ? null
            : libraryTargetParent(headerBlocks, selectedId, catalogMap);
        const index = getChildCount(headerBlocks, parentId);
        const block = createBlock(type, t);
        emitHeaderBlocks(insertBlock(headerBlocks, parentId, index, block));
        setSelectedId(block.id);
        return;
      }
      const parentId = libraryTargetParent(blocks, selectedId, catalogMap);
      const index = getChildCount(blocks, parentId);
      const block = createBlock(type, t);
      emit(insertBlock(blocks, parentId, index, block));
      setSelectedId(block.id);
    },
    [
      blocks,
      headerBlocks,
      selectedId,
      selectedInHeader,
      catalogMap,
      emit,
      emitHeaderBlocks,
      onHeaderChange,
    ],
  );

  const importPattern = useCallback(
    (patternBlocks: BlockNode[], syncedRef?: string, replaceCanvas = false) => {
      const fresh: BlockNode[] = syncedRef
        ? [
            {
              id: crypto.randomUUID(),
              type: "core.reusable",
              version: 1,
              props: { ref: syncedRef },
            },
          ]
        : reassignBlockIds(cloneBlocks(patternBlocks));

      if (
        replaceCanvas &&
        blocks.length > 0 &&
        !window.confirm(t("ui.pageBuilder.replaceTheCurrentPageWithThisFullPagePattern"))
      ) {
        return;
      }

      emit(mergePatternBlocks(blocks, fresh, replaceCanvas));
      if (fresh[0]) setSelectedId(fresh[0].id);
    },
    [blocks, emit],
  );

  const handlePropsChange = useCallback(
    (props: Record<string, unknown>) => {
      if (!selectedId) return;
      if (selectedInHeader) {
        emitHeaderBlocks(updateBlockProps(headerBlocks, selectedId, props));
        return;
      }
      emit(updateBlockProps(blocks, selectedId, props));
    },
    [blocks, headerBlocks, selectedId, selectedInHeader, emit, emitHeaderBlocks],
  );

  const handleSyncBlock = useCallback(
    (block: BlockNode) => {
      if (!selectedId) return;
      if (selectedInHeader) {
        emitHeaderBlocks(updateBlockTree(headerBlocks, selectedId, () => block));
        return;
      }
      emit(updateBlockTree(blocks, selectedId, () => block));
    },
    [blocks, headerBlocks, selectedId, selectedInHeader, emit, emitHeaderBlocks],
  );

  /** Replace the page from the JSON panel: blocks, and header chrome when edited here. */
  const applyPageJson = useCallback(
    (next: { blocks: BlockNode[]; header?: PageHeaderConfig }) => {
      emit(next.blocks);
      if (next.header && onHeaderChange) onHeaderChange(next.header);
    },
    [emit, onHeaderChange],
  );

  /** Swap the selected block for a reference to the saved copy of it. */
  const convertToReusable = useCallback(
    (ref: string) => {
      if (!selectedId || !ref) return;
      handleSyncBlock({
        id: selectedId,
        type: "core.reusable",
        version: 1,
        props: { ref },
      });
    },
    [selectedId, handleSyncBlock],
  );

  /**
   * The block list the selection lives in. The header chrome and the page body
   * are separate regions; a selection never spans both.
   */
  const regionIsHeader = Boolean(onHeaderChange) && (selectedInHeader || (headerOnly && selectedId !== HEADER_SELECTED_ID));
  const regionBlocks = regionIsHeader ? headerBlocks : blocks;
  const emitRegion = regionIsHeader ? emitHeaderBlocks : emit;
  const actionIds = useMemo(() => selectedIds.filter((id) => id !== HEADER_SELECTED_ID), [selectedIds]);
  const states = useMemo(
    () =>
      actionStates({
        blocks: regionBlocks,
        selection: actionIds,
        catalog: catalogMap,
        hasClipboard: canPasteBlocks(),
        canSaveLibrary,
        librarySaves: true,
      }),
    [regionBlocks, actionIds, catalogMap, canSaveLibrary, menu],
  );
  const selectedNodes = useMemo(() => siblingSet(regionBlocks, actionIds)?.nodes ?? [], [regionBlocks, actionIds]);
  const lockFlags = useMemo(() => {
    const flags = new Set<EditorLockFlag>();
    if (selectedNodes.length === 0) return flags;
    for (const flag of ["move", "remove", "edit"] as const) {
      if (selectedNodes.every((node) => isBlockLocked(node, flag))) flags.add(flag);
    }
    return flags;
  }, [selectedNodes]);

  const announce = (tone: DropStatus["tone"], text: string) => announceRef.current({ tone, text });
  const blockName = (node: BlockNode) => node.editor?.label || catalogMap.get(node.type)?.title || node.type;
  const countText = (count: number, one: BlockNode | undefined) =>
    count === 1 && one ? blockName(one) : t("builder.actions.blocks", { count });

  const selectMany = (ids: string[]) =>
    setSelection({ ids, anchor: ids[ids.length - 1] ?? null });

  /** Place blocks from the clipboard next to the selection, or say why they cannot go anywhere. */
  const pasteBlocks = useCallback(
    (text: string | null) => {
      const parsed = blocksFromClipboard(text);
      if (!parsed.ok) {
        announce("error", t(`builder.actions.pasteFailed.${parsed.reason}`));
        return;
      }
      const target = pasteTarget(regionBlocks, actionIds, parsed.blocks, catalogMap);
      if (!target) {
        announce("error", t("builder.actions.pasteFailed.nesting"));
        return;
      }
      emitRegion(insertBlocksAt(regionBlocks, target.parentId, target.index, parsed.blocks));
      selectMany(parsed.blocks.map((b) => b.id));
      announce("ok", t("builder.actions.done.paste", { what: countText(parsed.blocks.length, parsed.blocks[0]) }));
    },
    [regionBlocks, actionIds, catalogMap, emitRegion, t],
  );

  const runAction = useCallback(
    (action: BlockAction) => {
      const state = states[action];
      if (!state.ok) {
        announce("error", t(`builder.actions.blocked.${state.reason}`));
        return;
      }
      if (action === "paste") {
        void readClipboardText().then(pasteBlocks);
        return;
      }
      const nodes = selectedNodes;
      const what = countText(nodes.length, nodes[0]);
      switch (action) {
        case "duplicate": {
          const out = duplicateBlocks(regionBlocks, actionIds, uid);
          if (!out) return;
          emitRegion(out.blocks);
          selectMany(out.ids);
          break;
        }
        case "copy":
          writeBlockClipboard(nodes);
          break;
        case "cut":
          writeBlockClipboard(nodes);
          emitRegion(removeBlocks(regionBlocks, actionIds));
          setSelectedId(null);
          break;
        case "delete":
          emitRegion(removeBlocks(regionBlocks, actionIds));
          setSelectedId(null);
          break;
        case "group": {
          const out = groupBlocks(regionBlocks, actionIds, uid);
          if (!out) return;
          emitRegion(out.blocks);
          setSelectedId(out.id);
          break;
        }
        case "ungroup": {
          const out = ungroupBlock(regionBlocks, actionIds[0]!);
          if (!out) return;
          emitRegion(out.blocks);
          selectMany(out.ids);
          break;
        }
        case "resetStyle":
          emitRegion(resetBlockStyles(regionBlocks, actionIds));
          break;
        case "saveReusable":
        case "savePattern":
          setSaveDialog(action === "saveReusable" ? "reusable" : "pattern");
          return;
      }
      announce("ok", t(`builder.actions.done.${action}`, { what }));
    },
    [states, selectedNodes, regionBlocks, actionIds, emitRegion, pasteBlocks, setSelectedId, t],
  );

  const toggleLock = useCallback(
    (flag: EditorLockFlag) => {
      if (!canManageLocks || selectedNodes.length === 0) return;
      const on = !lockFlags.has(flag);
      const next = actionIds.reduce(
        (acc, id) =>
          updateBlockTree(acc, id, (node) => {
            const lock = { ...(node.editor?.lock ?? {}) };
            if (on) lock[flag] = true;
            else delete lock[flag];
            const editor = { ...(node.editor ?? {}) };
            if (Object.keys(lock).length > 0) editor.lock = lock;
            else delete editor.lock;
            const out: BlockNode = { ...node };
            if (Object.keys(editor).length > 0) out.editor = editor;
            else delete out.editor;
            return out;
          }),
        regionBlocks,
      );
      emitRegion(next);
      announce("ok", t(on ? "builder.actions.done.locked" : "builder.actions.done.unlocked", { what: countText(selectedNodes.length, selectedNodes[0]) }));
    },
    [canManageLocks, selectedNodes, lockFlags, actionIds, regionBlocks, emitRegion, t],
  );

  const saveSelection = useCallback(
    async (kind: SaveKind, input: { name: string; synced: boolean }) => {
      const nodes = selectedNodes;
      if (kind === "pattern") {
        await saveBlockPattern(
          { title: input.name, description: t("builder.patterns.saveDescription"), blocks: nodes, synced: input.synced },
          t("builder.patterns.saveError"),
        );
        announce("ok", t("builder.actions.done.savePattern", { what: input.name }));
        return;
      }
      const ref = await saveReusableBlocks(input.name, nodes, t("ui.reusablePanel.couldNotSave"));
      reloadReusable();
      const set = siblingSet(regionBlocks, actionIds);
      if (!set) return;
      const reference: BlockNode = { id: uid(), type: "core.reusable", version: 1, props: { ref } };
      const without = removeBlocks(regionBlocks, set.ids);
      emitRegion(insertBlocksAt(without, set.parentId, set.indices[0]!, [reference]));
      setSelectedId(reference.id);
      announce("ok", t("builder.actions.done.saveReusable", { what: input.name || countText(nodes.length, nodes[0]) }));
    },
    [selectedNodes, regionBlocks, actionIds, emitRegion, reloadReusable, setSelectedId, t],
  );

  /** Ctrl/Cmd+click toggles a block, Shift+click selects the sibling range from the anchor. */
  const extend = useCallback(
    (id: string, mods: SelectModifiers) => {
      if (!(mods.shiftKey || mods.metaKey || mods.ctrlKey)) return false;
      const list = findBlockPath(blocks, id) ? blocks : headerBlocks;
      const current = selection.ids.filter((x) => x !== HEADER_SELECTED_ID);
      const result = extendSelection(list, current, selection.anchor, id, mods.shiftKey ? "range" : "toggle");
      if (result.refused) announce("error", t(`builder.actions.selectRefused.${result.refused}`));
      setSelection({ ids: result.ids, anchor: result.anchor });
      return true;
    },
    [blocks, headerBlocks, selection, t],
  );

  const openMenu = useCallback(
    (id: string, at: MenuAnchor) => {
      if (!selection.ids.includes(id)) setSelectedId(id);
      setMenu(at);
    },
    [selection.ids, setSelectedId],
  );

  const selectionContext = useMemo<BuilderSelection>(
    () => ({ selectedIds: new Set(selectedIds), extend, openMenu }),
    [selectedIds, extend, openMenu],
  );

  /**
   * Keyboard shortcuts and clipboard events for the selection. They stay out of
   * the way of text editing: anything typed in a field, an inline editor, a
   * menu, or a dialog is left alone.
   */
  const shortcutState = useRef({ runAction, pasteBlocks, actionIds, selectedNodes, multi: selectedIds.length > 1, setSelectedId, selectedId });
  shortcutState.current = { runAction, pasteBlocks, actionIds, selectedNodes, multi: selectedIds.length > 1, setSelectedId, selectedId };
  useEffect(() => {
    if (!enableKeyboardShortcut) return;
    const editing = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog']"));
    const textSelected = () => Boolean(window.getSelection()?.toString());

    const onKey = (e: KeyboardEvent) => {
      if (editing(e.target) || e.defaultPrevented) return;
      const state = shortcutState.current;
      if (state.actionIds.length === 0) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      let action: BlockAction | null = null;
      if (mod && !e.shiftKey && key === "d") action = "duplicate";
      else if (mod && key === "g") action = e.shiftKey ? "ungroup" : "group";
      else if (!mod && (e.key === "Delete" || e.key === "Backspace")) action = "delete";
      else if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
        e.preventDefault();
        const el = document.querySelector(`[data-block-id="${CSS.escape(state.selectedId ?? "")}"]`);
        setMenu(anchorFor(el));
        return;
      } else if (e.key === "Escape" && state.multi) {
        e.preventDefault();
        state.setSelectedId(state.selectedId);
        return;
      }
      if (!action) return;
      e.preventDefault();
      state.runAction(action);
    };
    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      const state = shortcutState.current;
      if (editing(e.target) || textSelected() || state.actionIds.length === 0) return;
      e.preventDefault();
      if (cut) {
        state.runAction("cut");
        return;
      }
      const text = writeBlockClipboard(state.selectedNodes);
      e.clipboardData?.setData(BLOCK_CLIPBOARD_MIME, text);
      e.clipboardData?.setData("text/plain", text);
      state.runAction("copy");
    };
    const onPaste = (e: ClipboardEvent) => {
      if (editing(e.target)) return;
      const text = e.clipboardData?.getData(BLOCK_CLIPBOARD_MIME) || e.clipboardData?.getData("text/plain") || null;
      if (!text) return;
      e.preventDefault();
      shortcutState.current.pasteBlocks(text);
    };
    const copy = (e: ClipboardEvent) => onCopy(e, false);
    const cut = (e: ClipboardEvent) => onCopy(e, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("copy", copy);
    document.addEventListener("cut", cut);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("copy", copy);
      document.removeEventListener("cut", cut);
      document.removeEventListener("paste", onPaste);
    };
  }, [enableKeyboardShortcut]);

  const navLabels = useMemo(
    () => previewNavLabels(pageHeader, menus, siteDefaultSlug),
    [pageHeader, menus, siteDefaultSlug],
  );

  const breadcrumbs = useMemo(
    () =>
      selectionCrumbs({
        selectedId,
        blocks,
        headerBlocks,
        headerSelectedId: HEADER_SELECTED_ID,
        headerOnly,
        rootLabel: t(`builder.shell.context.${shellContext}`),
        headerLabel: t("builder.shell.context.header"),
        typeLabel: (type) => catalogMap.get(type)?.title,
      }),
    [selectedId, blocks, headerBlocks, headerOnly, catalogMap, shellContext, t],
  );

  const canvas = (
    <div className={`jf-admin-scheme-${previewScheme}`}>
      {enableHeader && onHeaderChange && (
        <HeaderChrome
          header={pageHeader}
          identity={identity}
          navLabels={navLabels}
          selected={selectedId === HEADER_SELECTED_ID}
          selectedId={selectedId}
          catalog={catalogMap}
          compact={compact}
          onSelect={() => setSelectedId(HEADER_SELECTED_ID)}
          onSelectBlock={setSelectedId}
          onBlocksChange={emitHeaderBlocks}
        />
      )}
      {!headerOnly && (() => {
        const pageCanvas = (
          <PageCanvas
            blocks={blocks}
            catalog={catalogMap}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChange={emit}
            compact={compact}
            rootQuickAll={flatCanvas}
          />
        );
        if (!siteContext || compact) return pageCanvas;
        return (
          <SiteContextFrame
            context={siteContext}
            meta={siteContextMeta ?? { title: "" }}
            onEnter={(region, slug) => onEnterSiteContext?.(region, slug, selectedId)}
          >
            {pageCanvas}
          </SiteContextFrame>
        );
      })()}
    </div>
  );

  const editLocked = Boolean(selectedBlock && isBlockLocked(selectedBlock, "edit"));
  const inspector =
    actionIds.length > 1 ? (
      <MultiSelectionInspector
        nodes={selectedNodes}
        catalog={catalogMap}
        states={states}
        onRun={runAction}
        onChangeProps={(changes) =>
          emitRegion([...changes].reduce((acc, [id, props]) => updateBlockProps(acc, id, props), regionBlocks))
        }
      />
    ) : (selectedId === HEADER_SELECTED_ID || (headerOnly && !selectedBlock)) &&
    enableHeader &&
    onHeaderChange ? (
      <HeaderInspector
        header={pageHeader}
        menus={menus}
        siteDefaultSlug={siteDefaultSlug}
        onChange={onHeaderChange}
        libraryMode={headerOnly}
      />
    ) : selectedBlock ? (
      <fieldset className="jf-inspector-lock" disabled={editLocked}>
      {editLocked && (
        <p className="jf-inspector-lock__notice" role="note">
          {t(canManageLocks ? "builder.actions.editLockedManage" : "builder.actions.editLocked")}
        </p>
      )}
      <BlockInspector
        block={selectedBlock}
        catalogEntry={catalogMap.get(selectedBlock.type)}
        onChange={handlePropsChange}
        onSyncBlock={handleSyncBlock}
        parentType={selectedParent?.type ?? null}
        parentListStyle={selectedParent?.type === "core.list" ? String(selectedParent.props.listStyle ?? "bullet") : undefined}
        parentColumns={selectedParent?.type === GRID_BLOCK_TYPE ? gridColumns(selectedParent) : 12}
        parentLayout={selectedParent?.props.containerLayout}
        ancestorElements={ancestorElementsOf(selectedInHeader ? headerBlocks : blocks, selectedBlock.id)}
        previewing={canvasWidth > 0 ? breakpointForWidth(canvasWidth) : "desktop"}
        onPreviewBreakpoint={(bp) => setPrefs({ breakpoint: bp, previewWidth: null })}
        reusable={reusable}
        onReloadReusable={reloadReusable}
        onConvertToReusable={convertToReusable}
        tab={prefs.inspectorTab}
        onTabChange={(inspectorTab) => setPrefs({ inspectorTab })}
      />
      </fieldset>
    ) : (
      <PageJsonPanel
        blocks={blocks}
        {...(enableHeader && onHeaderChange ? { header: pageHeader } : {})}
        compact={compact}
        onApply={applyPageJson}
      />
    );

  return (
    <InlineFieldsContext.Provider value={inlineFields}>
    <TemplateDefaultsContext.Provider value={templateContext}>
    <MergeTagsContext.Provider value={mergeTags}>
      <PreviewSchemeContext.Provider value={previewScheme}>
      <BuilderDragProvider
        blocks={blocks}
        headerBlocks={headerBlocks}
        catalog={catalogMap}
        onChange={emit}
        onHeaderBlocksChange={enableHeader && onHeaderChange ? emitHeaderBlocks : undefined}
        onSelect={setSelectedId}
      >
        <AnnounceBridge target={announceRef} />
        <BuilderSelectionContext.Provider value={selectionContext}>
        {compact ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 260px",
              gap: "1rem",
              minHeight: 400,
            }}
          >
            {canvas}
            <aside
              style={{
                background: "var(--jf-surface-2)",
                border: "1px solid var(--jf-border)",
                borderRadius: 8,
                padding: "1rem",
              }}
            >
              {inspector}
            </aside>
          </div>
        ) : (
          <BuilderShell
            context={shellContext}
            bar={shellBar}
            prefs={prefs}
            onPrefsChange={setPrefs}
            history={history}
            previewScheme={previewScheme}
            onPreviewSchemeChange={setPreviewScheme}
            blockCount={headerOnly ? headerBlocks.length : blocks.length}
            breadcrumbs={breadcrumbs}
            onSelectCrumb={setSelectedId}
            onCanvasBackgroundClick={() => setSelectedId(null)}
            onCanvasWidthChange={setCanvasWidth}
            library={
              <BlockLibrary
                catalog={catalog}
                onAdd={addFromLibrary}
                onImportPattern={importPattern}
                currentBlocks={selectedBlock ? [selectedBlock] : blocks}
                parentType={libraryParentType}
                isPage={isPage}
                headerOnly={headerOnly}
              />
            }
            sitePanel={sitePanel}
            stylesPanel={stylesPanel}
            layers={
              <Navigator
                blocks={headerOnly ? headerBlocks : blocks}
                catalog={catalogMap}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onChange={headerOnly ? emitHeaderBlocks : emit}
              />
            }
            inspector={inspector}
            canvasBackdrop={
              /**
               * The page's own background in the previewed scheme. A separate layer, so the
               * theme's scoped rules never reach the editor chrome around the blocks.
               */
              <div aria-hidden="true" className={`jf-shell__backdrop ${THEME_PREVIEW_SCOPE}`} data-theme={previewScheme} />
            }
            canvas={canvas}
          />
        )}
        {menu && actionIds.length > 0 && (
          <BlockActionsMenu
            anchor={menu}
            states={states}
            lock={{ flags: lockFlags, canManage: canManageLocks }}
            onRun={runAction}
            onToggleLock={toggleLock}
            onClose={() => setMenu(null)}
          />
        )}
        {saveDialog && (
          <SaveSelectionDialog
            kind={saveDialog}
            onSave={(input) => saveSelection(saveDialog, input)}
            onClose={() => setSaveDialog(null)}
          />
        )}
        </BuilderSelectionContext.Provider>
      </BuilderDragProvider>
      </PreviewSchemeContext.Provider>
    </MergeTagsContext.Provider>
    </TemplateDefaultsContext.Provider>
    </InlineFieldsContext.Provider>
  );
}

/** Lets the builder announce action results through the drag provider's live region. */
function AnnounceBridge({ target }: { target: { current: (status: DropStatus) => void } }) {
  const { announce } = useBuilderDrag();
  useEffect(() => {
    target.current = announce;
  }, [announce, target]);
  return null;
}
