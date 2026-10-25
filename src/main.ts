/**
 * @file main.ts
 *
 * Browser entry point of the editor page (index.html). Creates the App and exposes the scripting API on
 * `window.layoutLiner` so an AI agent driving a browser, a test or a user in the console can edit the drawing:
 *
 *   layoutLiner.call('addRectangle', { x: 0, y: 0, width: 6000, height: 4000, name: '사무실' })
 *   layoutLiner.methods            // names, descriptions and parameter schemas (src/api/rpc.ts)
 *
 * `window.app` is the App itself, for debugging. See docs/API.md.
 */
import { App } from './app';
import { METHODS } from './api/rpc';
import { showVersion } from './ui/version';

const app = new App();
const scripting = {
  api: app.api,
  call: (method: string, params?: Record<string, unknown>) => app.call(method, params),
  methods: Object.fromEntries(Object.entries(METHODS).map(([k, m]) => [k, { description: m.description, params: m.params, mutates: m.mutates }])),
};
Object.assign(window, { app, layoutLiner: scripting });

showVersion(document.querySelector<HTMLElement>('#app-version')!);
