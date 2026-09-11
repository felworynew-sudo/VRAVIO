/**
 * The operating system is the only truthful source for a printer's driver
 * options (duplex, trays, paper type and colour profile). This one adapter is
 * intentionally used by the browser and by Tauri's WebView: both expose their
 * native system print dialog after receiving the exact same rendered page.
 */
import { isDesktop } from "../desktop-window";
import { openPrintPreview, type PageLayout } from "../printImage";

export type PrintDispatchResult = { readonly target: "web" | "desktop" };

export async function dispatchSystemPrint(page: HTMLCanvasElement, layout: PageLayout): Promise<PrintDispatchResult> {
  openPrintPreview(page.toDataURL("image/png"), layout);
  return { target: isDesktop ? "desktop" : "web" };
}
