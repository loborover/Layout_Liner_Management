/**
 * @file version.ts
 *
 * Shows version, commit and build time in the status bar (values from vite.config.ts).
 */
/** Fills the status bar label with the build's version, commit and build time. */
export function showVersion(el: HTMLElement): void {
  const built = new Date(__BUILD_TIME__);
  const when = Number.isNaN(built.getTime())
    ? __BUILD_TIME__
    : built.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  el.textContent = `v${__APP_VERSION__} · ${__GIT_SHA__}`;
  el.title = `버전 ${__APP_VERSION__}\n커밋 ${__GIT_SHA__}\n빌드 ${when}`;
}
