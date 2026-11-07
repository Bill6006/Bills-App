/**
 * Pulls the positioned text out of a PDF with pdf.js. The pdf.js build is passed in, so the app can load it only
 * when a PDF is picked (pdfRead.ts) and tests can use the Node build.
 */
import type * as PdfJs from 'pdfjs-dist';
import type { PdfItem } from './pdfStatement';

type PdfLib = Pick<typeof PdfJs, 'getDocument' | 'Util'>;

/** Most statements are a few pages; legal pages after the transactions don't matter. */
const MAX_PAGES = 40;

export async function extractItems(lib: PdfLib, data: Uint8Array): Promise<PdfItem[][]> {
  const task = lib.getDocument({ data, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: PdfItem[][] = [];
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items: PdfItem[] = [];
      for (const it of tc.items) {
        if (!('str' in it) || !it.str) continue;
        // Into page space as displayed (handles rotated pages), y measured up from the bottom.
        const m = lib.Util.transform(vp.transform, it.transform) as number[];
        if (Math.abs(m[1]) > 0.01 || Math.abs(m[2]) > 0.01 || m[0] <= 0) continue; // turned text: watermarks, side notes
        items.push({ str: it.str, x: m[4], y: vp.height - m[5], w: it.width, size: Math.abs(m[3]) || Math.abs(m[0]) });
      }
      pages.push(items);
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** Starts like a PDF file ("%PDF-"). */
export const isPdfBytes = (head: Uint8Array) => head.length >= 5 && String.fromCharCode(...head.slice(0, 5)) === '%PDF-';
