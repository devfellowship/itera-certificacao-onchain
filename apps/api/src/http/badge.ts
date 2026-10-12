import { makeBadge } from "badge-maker";

/**
 * README badge of U16: shields-style SVG made by badge-maker, in the TestMyAgent colors of the
 * design (label #1c1916, message #1c3a2a). badge-maker fixes the text color at white, so the two
 * `<text>` elements get the brand text colors after the render.
 */
export const BADGE_LABEL = "testmyagent";
const LABEL_BG = "#1c1916";
const LABEL_FG = "#f4ede2";
const MESSAGE_BG = "#1c3a2a";
const MESSAGE_FG = "#8fe9b1";
const NOT_FOUND_BG = "#35382f";
const NOT_FOUND_FG = "#a2aaa1";

function recolor(svg: string, label: string, message: string): string {
  let i = 0;
  return svg.replace(/<text /g, () => `<text fill="${i++ === 0 ? label : message}" `);
}

/** "91.2 · 6 tasks". A score of 100 reads "100.0", as on the screens. */
export function badgeMessage(score: number | null, taskCount: number): string {
  const tasks = `${taskCount} ${taskCount === 1 ? "task" : "tasks"}`;
  return score === null ? tasks : `${score.toFixed(1)} · ${tasks}`;
}

export function renderBadge(score: number | null, taskCount: number): string {
  const svg = makeBadge({ label: BADGE_LABEL, message: badgeMessage(score, taskCount), color: MESSAGE_BG, labelColor: LABEL_BG, style: "flat-square" });
  return recolor(svg, LABEL_FG, MESSAGE_FG);
}

/** Same body for an unknown and for a private subject: a badge never says which one it is. */
export function renderNotFoundBadge(): string {
  const svg = makeBadge({ label: BADGE_LABEL, message: "not found", color: NOT_FOUND_BG, labelColor: LABEL_BG, style: "flat-square" });
  return recolor(svg, LABEL_FG, NOT_FOUND_FG);
}
