/**
 * @file main.ts
 *
 * Browser entry point of the editor page (index.html). Creates the App and exposes it on `window` for
 * debugging and for scripted/AI control (see docs/API.md).
 */
import { App } from './app';
import { showVersion } from './ui/version';

const app = new App();
// Exposed for debugging from the browser console.
(window as unknown as { app: App }).app = app;

showVersion(document.querySelector<HTMLElement>('#app-version')!);
