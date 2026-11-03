// The one-step path to a project, surfaced where a new developer first looks.
//
// The form that clones a git URL and creates the project lives in the
// multi-repo plugin; bb core's own New project dialog cannot be pointed at it.
// A plugin bundle is built on its own, so team-setup cannot mount multi-repo's
// component across the package boundary. It deep-links to the Repos panel
// instead, with the sub-path that opens the New project form — no second clone
// path, and `createProject`'s contract is untouched (BB-218).
import { Button } from "@/components/ui/button";

/**
 * The multi-repo nav panel and the sub-path that opens its New project form.
 *
 * These are hard-coded rather than imported: a plugin bundle is built on its
 * own, so multi-repo's constants are not reachable from here. The route is
 * `/plugins/<pluginId>/<panel path>/<subPath>`, and multi-repo's `shared.ts`
 * holds the matching `NEW_PROJECT_SUBPATH`. Keep the two in step.
 */
export const MULTI_REPO_ID = "multi-repo";
export const MULTI_REPO_REPOS_PATH = "repos";
export const NEW_PROJECT_SUBPATH = "new";
export const NEW_PROJECT_HREF = `/plugins/${MULTI_REPO_ID}/${MULTI_REPO_REPOS_PATH}/${NEW_PROJECT_SUBPATH}`;

/**
 * A deep link into multi-repo's New project form.
 *
 * It is shown only while the server has no projects, so it is the primary
 * call to action: the first thing a brand-new developer should press. Once a
 * project exists the checklist step hides it.
 */
export function CreateProjectEntry() {
  return (
    <Button asChild size="sm">
      <a href={NEW_PROJECT_HREF}>Create a project from a git URL</a>
    </Button>
  );
}
