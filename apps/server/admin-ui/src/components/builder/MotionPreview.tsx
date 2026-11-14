import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { isActiveAnimation, parseBlockAnimation } from "@justflows/blocks";

export const PREVIEW_ANIMATION_EVENT = "jf:preview-animation";

export function dispatchPreviewAnimation(blockId: string): void {
  window.dispatchEvent(new CustomEvent(PREVIEW_ANIMATION_EVENT, { detail: { id: blockId } }));
}

/**
 * The animation library loads only when a block on the canvas has an active
 * animation and the reader has not asked for reduced motion
 * (justflows-ce#308). Until it has loaded, the block shows without animation.
 */
const AnimatedPreview = lazy(() => import("./MotionPreviewAnimated"));

function usePrefersReducedMotion(): boolean {
  const query = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const [reduced, setReduced] = useState(Boolean(query?.matches));
  useEffect(() => {
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, [query]);
  return reduced;
}

export default function MotionPreview({
  blockId,
  animation,
  children,
}: {
  blockId: string;
  animation: unknown;
  children: ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const anim = parseBlockAnimation(animation);
  if (reduced || !isActiveAnimation(anim)) return <>{children}</>;
  return (
    <Suspense fallback={<>{children}</>}>
      <AnimatedPreview blockId={blockId} anim={anim}>
        {children}
      </AnimatedPreview>
    </Suspense>
  );
}
