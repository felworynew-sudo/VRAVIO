import type { EnvironmentKind } from "@vravio/kernel";
import { environmentMeta } from "./environment";

export function EnvironmentIcon({ kind, className = "" }: { kind: EnvironmentKind; className?: string }) {
  // `import.meta.env.BASE_URL`, not a hardcoded `/` — GitHub Pages serves
  // this app at `/VRAVIO/`, not the domain's own root (`vite.config.ts`'s
  // own `base`), and a hardcoded leading slash 404s every icon under that
  // base — found live, not by reading the config: the built site's home
  // screen showed broken-image icons until this was fixed.
  return <img className={`environment-icon ${className}`} data-kind={kind} src={`${import.meta.env.BASE_URL}${environmentMeta[kind].iconFile}`} alt="" aria-hidden="true" />;
}
