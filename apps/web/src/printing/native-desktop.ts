import { isDesktop } from "../desktop-window";
import type { PageLayout, PrintOrientation } from "../printImage";

export interface NativePrinter {
  readonly name: string;
  readonly driverName: string;
  readonly status: "ready" | "offline" | "error" | "busy" | string;
  readonly isDefault: boolean;
}

export async function listNativePrinters(): Promise<readonly NativePrinter[]> {
  if (!isDesktop) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NativePrinter[]>("list_printers");
}

export async function sendNativePrint(params: {
  readonly printerName: string;
  readonly title: string;
  readonly page: HTMLCanvasElement;
  readonly layout: PageLayout;
  readonly orientation: PrintOrientation;
  readonly copies: number;
  readonly grayscale: boolean;
}): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("print_page", {
    request: {
      printerName: params.printerName,
      title: params.title,
      pageDataUrl: params.page.toDataURL("image/png"),
      pageWidthIn: params.layout.widthIn,
      pageHeightIn: params.layout.heightIn,
      orientation: params.orientation,
      copies: params.copies,
      grayscale: params.grayscale,
    },
  });
}
