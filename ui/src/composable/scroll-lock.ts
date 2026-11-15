/**
 * Body scroll lock shared by every overlay (dialogs and sheets).
 *
 * Stacked overlays (e.g. a confirm dialog over the import dialog, or a
 * dialog opened from the navigation sheet) share one counter: the lock is
 * released only when the last one closes, so an inner overlay unmounting
 * early cannot unlock the page beneath an open one.
 */
let scrollLockCount = 0;

export function acquireScrollLock(): void {
  scrollLockCount += 1;
  if (scrollLockCount === 1) document.body.style.overflow = "hidden";
}

export function releaseScrollLock(): void {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) document.body.style.overflow = "";
}
