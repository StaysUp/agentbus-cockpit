// Whether this browser has already been asked about the setup guide. It is
// kept in the browser, not on control: the question is about this person's
// first visit, not about the data folder.
export const GUIDE_PROMPT_KEY = 'agentbus.guide.prompted';

export function guidePromptAnswered(): boolean {
  return localStorage.getItem(GUIDE_PROMPT_KEY) === '1';
}

export function answerGuidePrompt(): void {
  localStorage.setItem(GUIDE_PROMPT_KEY, '1');
}
