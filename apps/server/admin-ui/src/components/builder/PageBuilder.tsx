import { useCallback, useEffect, useMemo, useState } from "react";
import type { BlockDocument, BlockCatalogEntry, BlockNode } from "./types";
import BlockLibrary from "./BlockLibrary";
import BlockInspector from "./BlockInspector";
import { PageCanvas } from "./BlockCanvas";
import { BuilderDragProvider } from "./DragContext";
import { createBlock } from "./block-defaults";
import { findBlockPath, getBlockAtPath, insertBlock, reassignBlockIds, cloneBlocks, updateBlockProps, updateBlockTree } from "./block-tree";
import { getChildCount, getParentType, libraryTargetParent, HEADER_SLOT_PARENT_TYPE } from "./dnd";
import HeaderChrome, { HeaderInspector, previewNavLabels, type HeaderMenu } from "./HeaderChrome";
import PageJsonPanel from "./PageJsonPanel";
import { GRID_BLOCK_TYPE, gridColumns } from "./grid";
import { useBuilderHistory } from "./useBuilderHistory";
import { useReusableBlocks } from "./ReusablePanel";
import {
  DEFAULT_PAGE_HEADER,
  HEADER_SELECTED_ID,
  type PageHeaderConfig,
} from "../../lib/page-header";
import { ProductTagsContext } from "../../lib/product-tags";

export type { BlockDocument, BlockNode } from "./types";

interface PageBuilderProps {
  value: BlockDocument;
  onChange: (doc: BlockDocument) => void;
  compact?: boolean;
  enableHeader?: boolean;
  header?: PageHeaderConfig;
  onHeaderChange?: (header: PageHeaderConfig) => void;
  /** Full standalone page vs. a post/article body. Hides page-only library items (whole-page patterns, site chrome widgets). */
  isPage?: boolean;
  /** Fill `{{price}}` and other product tags from catalog + content fields. */
  mergeTags?: Record<string, string>;
  enableProductTags?: boolean;
}

export default function PageBuilder({
  value,
  onChange,
  compact = false,
  enableHeader = false,
  header,
  onHeaderChange,
  isPage = false,
  mergeTags,
  enableProductTags = false,
}: PageBuilderProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<BlockCatalogEntry[]>([]);
  const [menus, setMenus] = useState<HeaderMenu[]>([]);
  const [identity, setIdentity] = useState({ siteTitle: "Site title", logoUrl: "" });
  const [siteDefaultSlug, setSiteDefaultSlug] = useState("primary");
  const pageHeader = header ?? DEFAULT_PAGE_HEADER;
  const { items: reusable, reload: reloadReusable } = useReusableBlocks();

  useEffect(() => {
    fetch("/api/blocks")
      .then((r) => r.json())
      .then((data: { blocks: BlockCatalogEntry[] }) => setCatalog(data.blocks ?? []))
      .catch(() => setCatalog([]));
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
          siteTitle: data.siteTitle ?? "Site title",
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
  );

  const emit = useCallback((nextBlocks: BlockNode[]) => {
    history.record(nextBlocks);
    onChange({ version: 1, blocks: nextBlocks });
  }, [history, onChange]);

  const emitHeaderBlocks = useCallback((nextBlocks: BlockNode[]) => {
    onHeaderChange?.({ ...pageHeader, blocks: nextBlocks });
  }, [onHeaderChange, pageHeader]);

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

  const addFromLibrary = useCallback((type: string) => {
    const inHeader = selectedId === HEADER_SELECTED_ID || selectedInHeader;
    if (inHeader && onHeaderChange) {
      const parentId = selectedId === HEADER_SELECTED_ID
        ? null
        : libraryTargetParent(headerBlocks, selectedId, catalogMap);
      const index = getChildCount(headerBlocks, parentId);
      const block = createBlock(type);
      emitHeaderBlocks(insertBlock(headerBlocks, parentId, index, block));
      setSelectedId(block.id);
      return;
    }
    const parentId = libraryTargetParent(blocks, selectedId, catalogMap);
    const index = getChildCount(blocks, parentId);
    const block = createBlock(type);
    emit(insertBlock(blocks, parentId, index, block));
    setSelectedId(block.id);
  }, [blocks, headerBlocks, selectedId, selectedInHeader, catalogMap, emit, emitHeaderBlocks, onHeaderChange]);

  const importPattern = useCallback((patternBlocks: BlockNode[]) => {
    const fresh = reassignBlockIds(cloneBlocks(patternBlocks));
    const replace =
      blocks.length === 0 ||
      window.confirm("Replace all blocks with this pattern? Cancel to append instead.");
    emit(replace ? fresh : [...blocks, ...fresh]);
    if (fresh[0]) setSelectedId(fresh[0].id);
  }, [blocks, emit]);

  const handlePropsChange = useCallback((props: Record<string, unknown>) => {
    if (!selectedId) return;
    if (selectedInHeader) {
      emitHeaderBlocks(updateBlockProps(headerBlocks, selectedId, props));
      return;
    }
    emit(updateBlockProps(blocks, selectedId, props));
  }, [blocks, headerBlocks, selectedId, selectedInHeader, emit, emitHeaderBlocks]);

  const handleSyncBlock = useCallback((block: BlockNode) => {
    if (!selectedId) return;
    if (selectedInHeader) {
      emitHeaderBlocks(updateBlockTree(headerBlocks, selectedId, () => block));
      return;
    }
    emit(updateBlockTree(blocks, selectedId, () => block));
  }, [blocks, headerBlocks, selectedId, selectedInHeader, emit, emitHeaderBlocks]);

  /** Replace the page from the JSON panel: blocks, and header chrome when edited here. */
  const applyPageJson = useCallback((next: { blocks: BlockNode[]; header?: PageHeaderConfig }) => {
    emit(next.blocks);
    if (next.header && onHeaderChange) onHeaderChange(next.header);
  }, [emit, onHeaderChange]);

  /** Swap the selected block for a reference to the saved copy of it. */
  const convertToReusable = useCallback((ref: string) => {
    if (!selectedId || !ref) return;
    handleSyncBlock({
      id: selectedId,
      type: "core.reusable",
      version: 1,
      props: { ref },
    });
  }, [selectedId, handleSyncBlock]);

  const navLabels = useMemo(
    () => previewNavLabels(pageHeader, menus, siteDefaultSlug),
    [pageHeader, menus, siteDefaultSlug],
  );

  const toolbar = (
    <div className="jf-builder-toolbar">
      <button
        type="button"
        className="jf-builder-toolbar__btn"
        onClick={history.undo}
        disabled={!history.canUndo}
        title="Undo (⌘Z)"
      >
        ↩ Undo
      </button>
      <button
        type="button"
        className="jf-builder-toolbar__btn"
        onClick={history.redo}
        disabled={!history.canRedo}
        title="Redo (⇧⌘Z)"
      >
        ↪ Redo
      </button>
      <span className="jf-builder-toolbar__count">
        {blocks.length} {blocks.length === 1 ? "block" : "blocks"}
      </span>
    </div>
  );

  const canvas = (
    <div>
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
      <PageCanvas
        blocks={blocks}
        catalog={catalogMap}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onChange={emit}
      />
    </div>
  );

  const inspector = selectedId === HEADER_SELECTED_ID && enableHeader && onHeaderChange ? (
    <HeaderInspector
      header={pageHeader}
      menus={menus}
      siteDefaultSlug={siteDefaultSlug}
      onChange={onHeaderChange}
    />
  ) : selectedBlock ? (
    <BlockInspector
      block={selectedBlock}
      catalogEntry={catalogMap.get(selectedBlock.type)}
      onChange={handlePropsChange}
      onSyncBlock={handleSyncBlock}
      parentType={selectedParent?.type ?? null}
      parentColumns={selectedParent?.type === GRID_BLOCK_TYPE ? gridColumns(selectedParent) : 12}
      reusable={reusable}
      onReloadReusable={reloadReusable}
      onConvertToReusable={convertToReusable}
      enableProductTags={enableProductTags}
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
    <ProductTagsContext.Provider value={mergeTags}>
    <BuilderDragProvider
      blocks={blocks}
      headerBlocks={headerBlocks}
      catalog={catalogMap}
      onChange={emit}
      onHeaderBlocksChange={enableHeader && onHeaderChange ? emitHeaderBlocks : undefined}
      onSelect={setSelectedId}
    >
      {compact ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 260px", gap: "1rem", minHeight: 400 }}>
          {canvas}
          <aside style={{ background: "var(--jf-surface-2)", border: "1px solid var(--jf-border)", borderRadius: 8, padding: "1rem" }}>{inspector}</aside>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr 280px", height: "100%", minHeight: 0, background: "var(--jf-surface-3)" }}>
          <aside style={{ background: "#fff", borderRight: "1px solid var(--jf-border)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <BlockLibrary catalog={catalog} onAdd={addFromLibrary} onImportPattern={importPattern} parentType={libraryParentType} isPage={isPage} />
          </aside>
          <main style={{ overflow: "auto", padding: "1.25rem" }} onClick={() => setSelectedId(null)}>
            <div style={{ maxWidth: 900, margin: "0 auto" }} onClick={(e) => e.stopPropagation()}>
              {toolbar}
            </div>
            <div style={{ maxWidth: 900, margin: "0 auto", background: "#fff", borderRadius: 12, boxShadow: "0 1px 3px rgba(0,0,0,.06)", padding: "1rem", minHeight: "100%" }}>
              {canvas}
            </div>
          </main>
          <aside style={{ background: "#fff", borderLeft: "1px solid var(--jf-border)", overflow: "auto", padding: "1rem" }}>{inspector}</aside>
        </div>
      )}
    </BuilderDragProvider>
    </ProductTagsContext.Provider>
  );
}
