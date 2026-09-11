import type { PageLayout } from "../printImage";

/** Creates one physical-size PDF page from the final print canvas. */
export async function createPrintPdf(page: HTMLCanvasElement, layout: PageLayout): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({
    orientation: layout.widthIn >= layout.heightIn ? "landscape" : "portrait",
    unit: "in",
    format: [layout.widthIn, layout.heightIn],
    compress: true,
  });
  pdf.addImage(page.toDataURL("image/png"), "PNG", 0, 0, layout.widthIn, layout.heightIn, undefined, "FAST");
  return pdf.output("blob");
}

export function printPdfFileName(documentName: string): string {
  const stem = documentName.replace(/\s*\([^()]*\)\s*$/, "").replace(/\.[^.]+$/, "").trim() || "untitled";
  return `${stem}-print.pdf`;
}
