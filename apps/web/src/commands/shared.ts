import { isRasterDocumentState, type RasterDocumentState } from "@vravio/env-raster";
import type { CommandContext } from "@vravio/kernel";
import { kernel } from "../kernel";

/**
 * Helpers shared by command definitions, in the file the definitions sit
 * beside rather than closed over inside one long registration function.
 *
 * These were local `const`s inside `ensureCommandsRegistered` — which is
 * exactly why that function could not be split without them: every definition
 * after them captured them. Hoisting them here is what makes each family of
 * commands a file of its own.
 */

/**
 * Asks the shell to do something the kernel cannot.
 *
 * File commands own the shortcut and the menu entry, but the actual write
 * lives in the shell (it needs the platform port and the export dialog), so
 * they dispatch instead of saving here. Marking the document clean without
 * writing anything would lose work.
 */
export const dispatch = (type: string): void => { window.dispatchEvent(new Event(type)); };

/** True while a raster document is the active one. */
export const isRasterActive = ({ activeDocumentId }: CommandContext): boolean =>
  kernel.documents.get(activeDocumentId ?? "")?.kind === "raster";

/** True while any document is open at all. */
export const hasActiveDocument = ({ activeDocumentId }: CommandContext): boolean => Boolean(activeDocumentId);

/** The active document's raster state, or null when it is not a raster document. */
export function activeRasterState(activeDocumentId: string | null | undefined): RasterDocumentState | null {
  const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
  return document && isRasterDocumentState(document.state) ? document.state : null;
}
