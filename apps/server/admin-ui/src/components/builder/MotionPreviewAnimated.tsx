import { useEffect, useState, type ReactNode } from "react";
import { motion, type Transition } from "framer-motion";
import { ENTRANCE_VARIANTS, HOVER_VARIANTS, TAP_VARIANTS, type BlockAnimation } from "@justflows/blocks";
import { PREVIEW_ANIMATION_EVENT } from "./MotionPreview";

/** The animated canvas preview of one block; loaded on demand by `MotionPreview` (justflows-ce#308). */

function transitionFor(anim: BlockAnimation): Transition {
  if (anim.easing === "spring" || anim.entrance === "bounce") {
    return { type: "spring" as const, bounce: anim.entrance === "bounce" ? 0.45 : 0.25, duration: anim.duration, delay: anim.delay };
  }
  const ease: "easeIn" | "easeInOut" | "linear" | "easeOut" =
    anim.easing === "ease-in" ? "easeIn" :
    anim.easing === "ease-in-out" ? "easeInOut" :
    anim.easing === "linear" ? "linear" :
    "easeOut";
  return { type: "tween" as const, duration: anim.duration, delay: anim.delay, ease };
}

export default function MotionPreviewAnimated({
  blockId,
  anim,
  children,
}: {
  blockId: string;
  anim: BlockAnimation;
  children: ReactNode;
}) {
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    function onReplay(event: Event) {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (id === blockId) setNonce((n) => n + 1);
    }
    window.addEventListener(PREVIEW_ANIMATION_EVENT, onReplay);
    return () => window.removeEventListener(PREVIEW_ANIMATION_EVENT, onReplay);
  }, [blockId]);

  const entrance = anim.entrance !== "none" ? ENTRANCE_VARIANTS[anim.entrance] : null;
  const hover = anim.hover !== "none" ? HOVER_VARIANTS[anim.hover] : undefined;
  const tap = anim.tap !== "none" ? TAP_VARIANTS[anim.tap] : undefined;

  return (
    <motion.div
      key={`${blockId}-${nonce}-${anim.entrance}-${anim.trigger}-${anim.duration}-${anim.delay}-${anim.easing}`}
      initial={entrance?.from}
      animate={anim.trigger === "load" && entrance ? entrance.to : undefined}
      whileInView={anim.trigger === "in-view" && entrance ? entrance.to : undefined}
      viewport={anim.trigger === "in-view" ? { once: anim.once, amount: 0.2 } : undefined}
      whileHover={hover}
      whileTap={tap}
      transition={transitionFor(anim)}
      style={{ display: "block", width: "100%" }}
    >
      {children}
    </motion.div>
  );
}
