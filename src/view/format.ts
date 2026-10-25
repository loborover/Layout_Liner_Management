export type DisplayUnit = 'mm' | 'm';

/** Formats a length given in mm for display. */
export function formatLength(mm: number, unit: DisplayUnit): string {
  if (unit === 'm') return `${(mm / 1000).toFixed(3)} m`;
  return `${Math.abs(mm) >= 100 ? mm.toFixed(0) : mm.toFixed(1)} mm`;
}

export function formatAngle(deg: number): string {
  return `${deg.toFixed(1)}°`;
}

/** Area given in mm² shown in m², the usual unit for floor plans. */
export function formatArea(mm2: number): string {
  return `${(Math.abs(mm2) / 1e6).toFixed(2)} m²`;
}
