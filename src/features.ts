// Screens that stay in the code but are off by default.
//
// The review screens (the Review bar on a turn, Fix, the CI/CD tab and the
// session's job list) and a turn's Changes dialog with "Apply to my folder"
// are hidden: reviews and applies are asked for in the chat ("have codex
// check it", "apply that"), not with buttons on each turn. The job queue and the
// runners underneath are unchanged. Turn the screens on with
// VITE_REVIEW_UI=1 when running or building the cockpit.
export function reviewUI(): boolean {
  return import.meta.env.VITE_REVIEW_UI === '1';
}
