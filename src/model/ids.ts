import type { Id } from './types';

let counter = 0;

/** Short, collision-resistant id; unique within a session and across saved files. */
export function newId(prefix: string): Id {
  counter = (counter + 1) % 0xffff;
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}
