/** BB answered HTTP 409, as the error's status or in its message. */
export function bbConflict(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : null;
  return status === 409 || /\bHTTP\s*409\b/u.test(String(error));
}

/** BB rejects these paths before it creates a thread, so the launch cannot be ambiguous. */
export function rejectedScratchPlacement(error: unknown): boolean {
  const message = String(error);
  return bbConflict(error) && [
    "Workspace path is inside bb-managed storage but is not a workspace of this project",
    "Workspace path is a bb-managed workspace owned by another project",
  ].some((refusal) => message.includes(refusal));
}
