import { ICON_PATHS } from "./icons";
import type { IconName } from "./samples";

export function BrandIcon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
