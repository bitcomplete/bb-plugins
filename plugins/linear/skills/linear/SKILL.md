---
name: linear
description: Read, search, file, comment on, or update Linear issues from a bb thread through the Linear plugin's tools, or diagnose why they say Linear is not connected.
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
| `linear_create_issue` | File a new issue in a team by key: title, Markdown description, and optionally a state, assignee (`me`), labels, priority and parent issue. The description is signed with the thread id. |
| `linear_comment` | Add a Markdown comment. It is signed with the thread id so a reader can find the conversation. |
| `linear_update_issue` | Change an issue: state by name, assignee (`me`, a name or email, `nobody`), labels to add or remove, priority. Give only the fields to change; a name that does not match is an error listing the choices. |
| `linear_query` | Any read-only GraphQL query, for projects, cycles, teams, documents and anything the tools above lack. Mutations are refused. |

Ticket keys appear in branch names, PR titles and thread titles
(`ENG-123`, `eng-123-fix-login`). Read the ticket before starting work on
one, and prefer these tools over asking the user to paste its contents.

## From a script

The same reads are a `bb linear` command (`status`, `issue <key>`,
`search`, `query <document>`), each with `--json`. It runs on the server
inside the plugin, so a script automation can poll Linear with no token of
its own: `bb linear search --team ENG --state "Build Ready" --json`. Prefer
the tools inside a thread; reach for the command when writing a script
automation or a shell pipeline.

## Writing back

Comment when there is something a reader in Linear needs: a PR link, a
decision, a question for the reporter. Do not narrate progress. Move an
issue's state only when the user asked for it or the team's convention is
clear (for example In Review when the PR opens). Assign an issue when
taking it on is the point of the task — picking up a ticket, handing it to
someone — not as a side effect of reading it.

File an issue only when the user asks for one. Put the team key, a short
title and a description with the reproduction or the ask in it; the plugin
signs the description with the thread id. If the user did not name a team,
`linear_search` with `assignee: me` shows which teams they work in. A state,
label or assignee that does not match is an error that lists the choices,
so retry with one of those rather than inventing a name.

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
