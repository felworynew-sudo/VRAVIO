/**
 * Native window controls for the Tauri shell — minimize/maximize/close, and
 * telling whether the app is even running inside Tauri at all.
 *
 * The web build has no window to control: it runs in a browser tab, which
 * already has its own minimize/maximize/close in the OS chrome. Importing
 * `@tauri-apps/api/window` unconditionally would be harmless at build time
 * (it is plain JS, not a native binding) but calling its functions outside
 * Tauri throws, since there is no `__TAURI_INTERNALS__` bridge for it to
 * talk to — so every export here is a no-op, not an error, when `isDesktop`
 * is false. `App.tsx` checks `isDesktop` before rendering the window-control
 * buttons at all, so these no-op paths are a safety net, not the normal one.
 */
export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export async function minimizeWindow(): Promise<void> {
  if (!isDesktop) return;
  await (await currentWindow()).minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!isDesktop) return;
  await (await currentWindow()).toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  if (!isDesktop) return;
  await (await currentWindow()).close();
}
