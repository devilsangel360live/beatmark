import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";

// pdf.js parses in a worker; Vite bundles it and hands back its URL.
GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

/** Rendering resolution. Staff detection and the recognizer were checked on 200 dpi pages. */
const DPI = 200;

/** Each page of a PDF as PNG bytes, one at a time. */
export async function* renderPdfPages(data: Uint8Array): AsyncGenerator<{ page: number; pageCount: number; png: Uint8Array }> {
  const task = getDocument({ data });
  const pdf = await task.promise;
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: DPI / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d")!;
      // PDFs can have transparent backgrounds; the recognizer expects white paper.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport }).promise;
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`Could not render page ${n}`))), "image/png"),
      );
      yield { page: n, pageCount: pdf.numPages, png: new Uint8Array(await blob.arrayBuffer()) };
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
}
