import { useId, useLayoutEffect, useRef } from "react";
import { Button } from "@ui-sdk/react/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@ui-sdk/react/collapsible";
import { ThreadChat, UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { CalmRow } from "./board";

type ConversationMember = Pick<
  CalmRow,
  "key" | "repo" | "number" | "title" | "url"
>;

export function ConversationPanel({
  threadId,
  members,
  shownKeys,
  onClose,
}: {
  threadId: string;
  members: readonly ConversationMember[];
  shownKeys: ReadonlySet<string>;
  onClose: () => void;
}) {
  const navigate = useBbNavigate();
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    title.current?.focus();
  }, [threadId]);
  const shown = members.filter((member) => shownKeys.has(member.key)).length;
  const scope = members.length
    ? `${members.length} ${members.length === 1 ? "PR" : "PRs"} in ${members.length > 1 ? "shared " : ""}conversation${shown < members.length ? ` · ${shown} shown` : ""}`
    : "Conversation scope is unavailable";
  return (
    <aside
      className="calm-conversation"
      aria-labelledby={titleId}
      data-agent-hidden=""
    >
      <header
        className="calm-conversation-header"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="calm-conversation-heading">
          <h2 id={titleId} ref={title} tabIndex={-1}>
            Agent conversation
          </h2>
          <Button
            className="calm-conversation-button"
            aria-label="Close conversation"
            onClick={onClose}
          >
            Close
          </Button>
        </div>
        <Collapsible>
          <CollapsibleTrigger className="calm-conversation-scope">
            {scope}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <ul className="calm-conversation-members">
              {members.map((member) => (
                <li key={member.key}>
                  <UrlLink href={member.url}>
                    {member.repo} #{member.number} · {member.title}
                  </UrlLink>
                </li>
              ))}
            </ul>
          </CollapsiblePanel>
        </Collapsible>
        <Button
          className="calm-conversation-button"
          onClick={() => navigate.toThread(threadId)}
        >
          Open in full thread
        </Button>
      </header>
      <div className="calm-conversation-chat">
        <ThreadChat
          key={threadId}
          threadId={threadId}
          variant="compact"
          layout="contained"
          permissionPolicy="inherit"
        />
      </div>
    </aside>
  );
}
