import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { SourceRef } from "../core/project";
import type { Recognition } from "../omr/assemble";

/** Typed wrappers around the Rust commands in src-tauri/src/lib.rs. */

export const inDesktopApp = isTauri();

const PROJECT_FILTER = { name: "Beatmark project", extensions: ["beatmark"] };
const SOURCE_FILTER = { name: "Sheet music (images or PDF)", extensions: ["pdf", "png", "jpg", "jpeg", "tif", "tiff"] };

function requireDesktop(): void {
  if (!inDesktopApp) throw new Error("File access needs the desktop app (npm run tauri dev).");
}

export async function newProjectWorkspace(): Promise<void> {
  if (inDesktopApp) await invoke("new_project");
}

export async function pickProjectToOpen(): Promise<string | null> {
  requireDesktop();
  return (await open({ filters: [PROJECT_FILTER] })) as string | null;
}

export async function pickSaveLocation(title: string): Promise<string | null> {
  requireDesktop();
  return save({ filters: [PROJECT_FILTER], defaultPath: `${title || "Untitled"}.beatmark` });
}

export async function openProject(path: string): Promise<string> {
  return invoke<string>("open_project", { path });
}

export async function saveProject(path: string, projectJson: string): Promise<void> {
  requireDesktop();
  await invoke("save_project", { path, projectJson });
}

interface ImportedSource {
  id: string;
  fileName: string;
  originalName: string;
  width: number;
  height: number;
}

/**
 * Import screenshots and PDFs. Each PDF page becomes its own source image, rendered at 200 dpi
 * (the resolution the recognizer was checked against). Originals are never modified.
 */
export async function importSources(onProgress?: (text: string) => void): Promise<SourceRef[]> {
  requireDesktop();
  const picked = await open({ multiple: true, filters: [SOURCE_FILTER] });
  if (!picked) return [];
  const paths = Array.isArray(picked) ? picked : [picked];
  const out: SourceRef[] = [];
  for (const path of paths) {
    if (path.toLowerCase().endsWith(".pdf")) {
      out.push(...(await importPdf(path, onProgress)));
    } else {
      const s = await invoke<ImportedSource>("import_image", { path });
      out.push({ id: s.id, fileName: s.fileName, originalName: s.originalName });
    }
  }
  return out;
}

async function importPdf(path: string, onProgress?: (text: string) => void): Promise<SourceRef[]> {
  const name = path.split(/[\\/]/).pop() ?? "document.pdf";
  const { renderPdfPages } = await import("./pdf");
  const bytes = new Uint8Array(await invoke<ArrayBuffer>("read_pdf", { path }));
  const out: SourceRef[] = [];
  for await (const { page, pageCount, png } of renderPdfPages(bytes)) {
    onProgress?.(`Importing ${name}: page ${page} of ${pageCount}…`);
    const s = await invoke<ImportedSource>("import_png", png, { headers: { "x-original-name": `${name} — page ${page}` } });
    out.push({ id: s.id, fileName: s.fileName, originalName: s.originalName, page });
  }
  return out;
}

/** Source images as object URLs, cached by file name. */
const urlCache = new Map<string, string>();
export async function sourceUrl(fileName: string): Promise<string> {
  const cached = urlCache.get(fileName);
  if (cached) return cached;
  const bytes = await invoke<ArrayBuffer>("read_source", { fileName });
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  urlCache.set(fileName, url);
  return url;
}

export async function recognizeSource(fileName: string): Promise<Recognition> {
  return invoke<Recognition>("recognize_source", { fileName });
}

export async function autosave(projectJson: string, filePath: string | null): Promise<void> {
  if (inDesktopApp) await invoke("autosave", { projectJson, filePath });
}

export async function takeRecovery(): Promise<{ projectJson: string; filePath: string | null } | null> {
  if (!inDesktopApp) return null;
  return invoke("take_recovery");
}

export async function clearRecovery(): Promise<void> {
  if (inDesktopApp) await invoke("clear_recovery");
}

export async function saveTextFile(defaultName: string, ext: string, contents: string): Promise<string | null> {
  requireDesktop();
  const path = await save({ defaultPath: defaultName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (!path) return null;
  await invoke("write_text_file", { path, contents });
  return path;
}
