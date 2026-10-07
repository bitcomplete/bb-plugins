---
name: linear
description: Read, search, comment on, or move Linear issues from a bb thread through the Linear plugin's tools, or diagnose why they say Linear is not connected.
---

# Linear

The `linear` plugin connects this bb server to the developer's Linear
account once, and gives every thread native tools that act as them. The
token stays on the server; a thread never sees it and needs no API key.

## Tools

| Tool | Use it to |
|---|---|
| `linear_issue` | Read one issue by key (`ENG-123`): state, assignee, labels, project, parent, sub-issues, description, latest comments. |
| `linear_search` | Find issues by free text and/or team key, state name, assignee (`me` for the connected user). Open issues only by default. |
| `linear_comment` | Add a Markdown comment. It is signed with the thread id so a reader can find the conversation. |
| `linear_set_state` | Move an issue to a state by name. On a mismatch the error lists the team's states. |
| `linear_query` | Any read-only GraphQL query, for projects, cycles, teams, documents and anything the tools above lack. Mutations are refused. |

Ticket keys appear in branch names, PR titles and thread titles
(`ENG-123`, `eng-123-fix-login`). Read the ticket before starting work on
one, and prefer these tools over asking the user to paste its contents.

## Writing back

Comment when there is something a reader in Linear needs: a PR link, a
decision, a question for the reporter. Do not narrate progress. Move an
issue's state only when the user asked for it or the team's convention is
clear (for example In Review when the PR opens).

## Not connected

Connecting is a browser approval and cannot be done by an agent. Tell the
user to open Settings → Plugins → Linear and choose **Connect Linear**, or
the Linear row of the Team setup checklist on the home page. If the
section says no client ID is set, the server's operator has to enter the
Linear OAuth application's client ID first; the plugin README explains
the application.

A token that stops working (a 401 the refresh cannot fix) means the
developer revoked the application in Linear or the refresh token
expired: connect again the same way.
