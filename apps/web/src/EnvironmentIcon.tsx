import type { EnvironmentKind } from "@vravio/kernel";
import { environmentMeta } from "./environment";

export function EnvironmentIcon({ kind, className = "" }: { kind: EnvironmentKind; className?: string }) {
  return <img className={`environment-icon ${className}`} data-kind={kind} src={`/${environmentMeta[kind].iconFile}`} alt="" aria-hidden="true" />;
}
