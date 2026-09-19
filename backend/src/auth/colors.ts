// A small, high-contrast palette used for user avatars, cursors and
// presence highlights. Assigned deterministically per-user at signup so a
// person's color stays stable across sessions and documents.
export const PRESENCE_PALETTE = [
  "#F45D5D", // coral red
  "#F2994A", // orange
  "#F2C94C", // amber
  "#6FCF97", // mint green
  "#2FD4C6", // teal
  "#56CCF2", // sky blue
  "#5B8DEF", // indigo
  "#9B51E0", // violet
  "#EB5FA8", // pink
  "#B7791F", // bronze
];

export function pickColorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % PRESENCE_PALETTE.length;
  return PRESENCE_PALETTE[index];
}
