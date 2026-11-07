/**
 * Reads a PDF statement in the browser. This module (and pdf.js with it) is loaded only when a PDF is picked.
 */
import { getDocument, GlobalWorkerOptions, Util } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { extractItems } from './pdfItems';
import { parsePdfStatement } from './pdfStatement';
import type { ParsedStatement } from './statement';

GlobalWorkerOptions.workerSrc = workerUrl;

export async function readPdfStatement(data: ArrayBuffer): Promise<ParsedStatement> {
  let pages;
  try {
    pages = await extractItems({ getDocument, Util }, new Uint8Array(data));
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'PasswordException') throw new Error('This PDF is locked with a password. Download it again from your bank, or save a copy without the password, then pick that.');
    throw new Error("This PDF couldn't be opened. Try downloading the statement again.");
  }
  return parsePdfStatement(pages);
}
