// Screens that stay in the code but are off by default.
//
// The review screens (the Review bar on a turn, Fix, the CI/CD tab and the
// session's turn list) are hidden: reviews are asked for in the chat ("have
// codex check it"), not with buttons on each turn. The turn queue and the
// runners underneath are unchanged. Turn the screens on with VITE_REVIEW_UI=1
// when running or building the cockpit.
//
// A turn's changes are not behind this: since 0.5.1 an agent may not apply a
// turn by default, so each turn that changed files shows "N files changed ·
// Review" in its header, which opens its diff and "Apply to my folder".
export function reviewUI(): boolean {
  return import.meta.env.VITE_REVIEW_UI === '1';
}
