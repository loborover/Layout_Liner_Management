import { App } from './app';
import { showVersion } from './ui/version';

const app = new App();
// Exposed for debugging from the browser console.
(window as unknown as { app: App }).app = app;

showVersion(document.querySelector<HTMLElement>('#app-version')!);
