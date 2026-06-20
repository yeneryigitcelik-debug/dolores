/**
 * Cheap, dependency-free token estimate. ~4 chars/token is the conventional
 * rule of thumb for English-ish text; good enough for budgeting + savings
 * reporting (we never bill against it).
 */
export function tokenEstimate(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
