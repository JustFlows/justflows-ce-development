import { useBuilderDrag } from "./DragContext";
import { startPointerDrag } from "./pointer-drag";

/**
 * Pointer handler for a block's drag handle: move the block to another valid
 * place on the canvas. A move-locked block (`locked`) never starts a drag.
 */
export function useBlockMoveHandle(blockId: string, blockType: string, locked = false) {
  const { startPointerMove, commitPointerMove, setDropTarget, cancelDrag } = useBuilderDrag();

  function onPointerDown(e: React.PointerEvent) {
    if (locked || (e.target as HTMLElement).closest("button")) return;
    startPointerDrag(e, {
      onStart: () => startPointerMove(blockId, blockType),
      onTarget: setDropTarget,
      onCommit: commitPointerMove,
      onCancel: cancelDrag,
    });
  }

  return { onPointerDown };
}
