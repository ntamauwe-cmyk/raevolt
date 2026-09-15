import { useId } from "react";
import { cn } from "@/lib/utils";

// RAEVOLT brand system — single source of truth for the approved identity.
// The mark is the geometric R/V monogram: a metallic white R with the
// electric-violet V integrated at its lower right (per the approved reference).
// Do not alter the geometry or proportions here; every branded surface
// renders this component (or the matching /logo.svg asset).
export const RAEVOLT_TAGLINE = "THE INFRASTRUCTURE BEHIND EVERY PAYMENT.";

// Shared geometry — identical to public/logo.svg and src/assets/logo.svg.
const R_PATH =
  "M8 4 H27 C35 4 40 9 40 16 C40 22 36 26.5 30 27.8 L44 44 H32.5 L20.5 28.5 H20 V44 H8 Z M20 11 H26.5 C29.8 11 31.8 12.8 31.8 15.8 C31.8 18.8 29.8 20.6 26.5 20.6 H20 Z M8 36 L20 44 L8 44 Z";
const V_PATH = "M25 22 L37 44 L48 22 L42.5 22 L37 31 L31.5 22 Z";

export function RaevoltMark({
  className,
  bare = false,
  onClick,
}: {
  className?: string;
  /** Render the monogram alone (dark surfaces only — the R is near-white). */
  bare?: boolean;
  onClick?: () => void;
}) {
  const uid = useId().replace(/:/g, "");
  const rGrad = `rv-r-${uid}`;
  const vGrad = `rv-v-${uid}`;
  const tGrad = `rv-t-${uid}`;
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="RAEVOLT"
      onClick={onClick}
      className={cn("shrink-0", className)}
    >
      <defs>
        <radialGradient id={tGrad} cx="24" cy="20" r="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#14173B" />
          <stop offset="1" stopColor="#080A24" />
        </radialGradient>
        <linearGradient id={rGrad} x1="17" y1="14" x2="35" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#C7CBDA" />
        </linearGradient>
        <linearGradient id={vGrad} x1="25" y1="22" x2="48" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7C4DFF" />
          <stop offset="1" stopColor="#4A1FE0" />
        </linearGradient>
      </defs>
      {!bare && <rect width="48" height="48" rx="10.5" fill={`url(#${tGrad})`} />}
      <g transform={bare ? undefined : "translate(9.6 9.6) scale(0.6)"}>
        <path d={V_PATH} fill={`url(#${vGrad})`} />
        <path d={R_PATH} fillRule="evenodd" clipRule="evenodd" fill={`url(#${rGrad})`} />
      </g>
    </svg>
  );
}

/** Full lockup: mark beside the RAEVOLT wordmark. */
export function RaevoltLogo({
  className,
  markClassName,
  wordClassName,
}: {
  className?: string;
  markClassName?: string;
  wordClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <RaevoltMark className={cn("size-7", markClassName)} />
      <span className={cn("text-sm font-bold uppercase tracking-[0.22em]", wordClassName)}>
        Raevolt
      </span>
    </span>
  );
}
