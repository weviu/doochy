import { motion, useReducedMotion, type Variants } from "framer-motion";
import type { ReactNode } from "react";

// Entrance-only motion per the design system: fade + 12px rise, 300ms ease-out.
// Reduced motion drops the translate and keeps a near-instant fade.

const OUT_SOFT = [0.16, 1, 0.3, 1] as const;

export function FadeRise({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: reduce ? 0 : 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0.01 : 0.3, ease: OUT_SOFT, delay }}
    >
      {children}
    </motion.div>
  );
}

export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  const container: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: 0.04 } },
  };
  return (
    <motion.div className={className} variants={container} initial="hidden" animate="show">
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  const item: Variants = {
    hidden: { opacity: 0, y: reduce ? 0 : 12 },
    show: { opacity: 1, y: 0, transition: { duration: reduce ? 0.01 : 0.3, ease: OUT_SOFT } },
  };
  return (
    <motion.div className={className} variants={item}>
      {children}
    </motion.div>
  );
}
