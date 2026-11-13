import { useT } from "../../i18n/I18nProvider";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { BlockDocument, BlockCatalogEntry, BlockNode } from "./types";
import BlockLibrary from "./BlockLibrary";
import BlockInspector from "./BlockInspector";
import { PageCanvas } from "./BlockCanvas";
import { BuilderDragProvider } from "./DragContext";
import { createBlock } from "./block-defaults";
import {
  findBlockPath,
  getBlockAtPath,
  insertBlock,
  reassignBlockIds,
  cloneBlocks,
  updateBlockProps,
  updateBlockTree,
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
import { useOptionalSessionUserId } from "../SessionProvider";

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
}: PageBuilderProps) {
  const { t } = useT();
  const [prefs, setPrefs] = useBuilderPrefs(useOptionalSessionUserId());
  const shellContext: BuilderContext = context ?? (headerOnly ? "header" : isPage ? "page" : "post");
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const blocks = Array.isArray(value?.blocks) ? value.blocks : [];
  const headerBlocks = Array.isArray(pageHeader.blocks) ? (pageHeader.blocks as BlockNode[]) : [];

  const history = useBuilderHistory<BlockNode[]>(
    blocks,
    useCallback((restored: BlockNode[]) => onChange({ version: 1, blocks: restored }), [onChange]),
    { enableShortcut: enableKeyboardShortcut },
  );

  const emit = useCallback(
    (nextBlocks: BlockNode[]) => {
      history.record(nextBlocks);
      onChange({ version: 1, blocks: nextBlocks });
    },
    [history, onChange],
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
      {!headerOnly && (
        <PageCanvas
          blocks={blocks}
          catalog={catalogMap}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onChange={emit}
          compact={compact}
          rootQuickAll={flatCanvas}
        />
      )}
    </div>
  );

  const inspector =
    (selectedId === HEADER_SELECTED_ID || (headerOnly && !selectedBlock)) &&
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
      <BlockInspector
        block={selectedBlock}
        catalogEntry={catalogMap.get(selectedBlock.type)}
        onChange={handlePropsChange}
        onSyncBlock={handleSyncBlock}
        parentType={selectedParent?.type ?? null}
        parentListStyle={selectedParent?.type === "core.list" ? String(selectedParent.props.listStyle ?? "bullet") : undefined}
        parentColumns={selectedParent?.type === GRID_BLOCK_TYPE ? gridColumns(selectedParent) : 12}
        reusable={reusable}
        onReloadReusable={reloadReusable}
        onConvertToReusable={convertToReusable}
        tab={prefs.inspectorTab}
        onTabChange={(inspectorTab) => setPrefs({ inspectorTab })}
      />
    ) : (
      <PageJsonPanel
        blocks={blocks}
        {...(enableHeader && onHeaderChange ? { header: pageHeader } : {})}
        compact={compact}
        onApply={applyPageJson}
      />
    );

  return (
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
      </BuilderDragProvider>
      </PreviewSchemeContext.Provider>
    </MergeTagsContext.Provider>
  );
}
