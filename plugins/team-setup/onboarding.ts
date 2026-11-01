// The first-run redirect's decision, kept out of the React component so the
// condition matrix is a plain unit test. The overlay in app.tsx is a thin
// wrapper: it reads the route once per page load, asks this, and navigates.

/** The onboarding panel's id and URL segment under `/plugins/team-setup/`. */
export const GET_STARTED_PANEL_ID = "get-started";
export const GET_STARTED_PATH = "get-started";

export interface GetStartedDecisionInput {
  /** `window.location.pathname` at first mount. */
  pathname: string;
  /** The server's persisted "Don't show this again" flag. */
  dismissed: boolean;
  /** Every required step done; optional steps do not count. */
  requiredComplete: boolean;
}

/**
 * Whether a page load that landed on the compose root should be sent to the
 * onboarding page. A deep link (a thread, settings, a plugin page) is left
 * alone, and the dismissal and required completion each stop it on their own.
 */
export function shouldOpenGetStarted({ pathname, dismissed, requiredComplete }: GetStartedDecisionInput): boolean {
  return pathname === "/" && !dismissed && !requiredComplete;
}
