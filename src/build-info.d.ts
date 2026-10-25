/**
 * @file build-info.d.ts
 *
 * Ambient declarations for build-time constants injected by vite.config.ts (`define`).
 * Used by src/ui/version.ts to show the version label.
 */
// Injected by vite.config.ts at build time.
declare const __APP_VERSION__: string;
declare const __GIT_SHA__: string;
declare const __BUILD_TIME__: string;
