# Privacy and trust

Self improve needs enough context to recognize a recurring mistake. It does not need to preserve your conversation verbatim in its problem ledger.

## What is sent and what is retained

The miner reads bounded eligible session context through the BB SDK. Before external analysis and ledger persistence, the privacy adapter removes configured secret values and names, recognized credential patterns, email addresses, URLs and common absolute local paths. Text also has size limits.

Model requests can still contain generalized descriptions of your work. Pattern-based redaction cannot recognize every secret or private name. Configure `redactedNames`, keep worker scope deliberate, and inspect the first records before enabling recurring learning across sensitive work.

The problem and solution ledgers retain generalized text, predictions, history and evidence pointers. Pointers let you reopen an original thread or identify a task/job run without copying its transcript into the ledger. Native accounting retains execution identities, usage observations and collection state. Historical cost entries may also retain account identifiers. These accounting records do not contain authentication credentials or prompt bodies.

BB task and chat histories are separate from the ledgers. They can retain the prompts, responses and tool events created during analysis. The ledger's redaction policy does not erase those histories or control other context that BB or the provider supplies.

Before candidate ranking, instruction proposal, risk review and model-change reassessment, retained ledger prose passes the current privacy policy in a fresh allowlisted context. This does not rewrite stored snapshots, attempts or evidence pointers. A wording retry revalidates its saved cause and symptom evidence before generation; a newly disallowed value stops that request. Wording prompts omit private source IDs and timestamps.

Ledger chat reads also apply the current privacy policy to a fresh structured copy, including notes and audit snapshots. Edit references and public citations remain exact; a reference that conflicts with the policy stops that read. Changing privacy rules revokes affected worker and ledger-chat authorization. The plugin rejects subsequent requests through its dispatch hook and attempts to stop/archive the affected threads. Reopen a chat from the ledger for a fresh conversation. Old history remains; stop/archive can require recovery, and BB operations outside the hook are not a global execution barrier. Pending miner results may still be recovered locally and revalidated before use.

Revalidation test cases, including their expected answers, are stored as you wrote them and are sent to the model only as the case input; expected answers never are. Agent threads with shell access, such as the editing chat or a test run under a permissive worker permission mode, can call Self improve's owner actions through `bb plugin rpc call` and read its data, including expected answers. BB does not yet tell a plugin whether a call came from the app or from inside a thread. Choose a worker permission mode you trust for revalidation. Model answers are not stored: each run keeps a SHA-256 fingerprint of the answer and whether it matched. A short answer such as `42` can be recovered from its fingerprint by anyone who can read the plugin's database.

Your test cases are stored exactly as you wrote them. Only development cases are sent to test threads, as case inputs; expected answers stay on the server. Test threads can see ordinary BB and workspace context, so keep private material out of worker environments.

Public research has a separate cache. The scout can cache extracted public arXiv article text. Its assessment records retain the versioned URL, text hash and bounded exact quotations, not another full-text copy. Article text remains untrusted input; a citation cannot authorize a tool call or a change.

The `dairToken` and `evaluationSuite` settings are secret settings and are not returned as dashboard settings. BB owns model authentication; there is no plugin model-account or credential pool setting. Do not put secrets in ordinary `config`, objective descriptions, filenames or chat requests. Development inputs and model outputs can appear in their BB task history even though the suite setting itself is secret.

## The important trust boundaries

| Input or action | Authority |
| --- | --- |
| Paper, web result, mined text or model completion | Data to inspect; it cannot grant permission or create trusted proof. |
| Owner problem/goal form | Records owner intent. It does not create observed evidence. |
| Native agent stage | A task-specific plugin prompt under the selected BB execution permissions. Ordinary BB/provider/workspace tools and context may remain. |
| Editing chat | Native BB thread permissions plus this plugin's bounded read, edit and re-test tools. Other tools may remain available. |
| Applied improvements | Instruction text from fixes that passed their test runs, added to turns in the projects that receive improvements. You can disable each one or turn off automatic applying. |
| Export draft | Produces inspectable text files. It does not install or publish. |
| Create draft PR | Explicit owner review of the exact bundle fingerprint and an allowed repository/new directory. |

The inventor receives a fresh, minimal problem prompt from this plugin. That is the scope of its zero-shot input, not a promise that the BB thread has no other instructions or tools. The ranker sees estimates and prior attempts. Neither can turn its own prediction into trusted evaluation evidence.

The dashboard inherits the selected chat thread's permissions. It does not present an editable permission picker that widens them. Concurrent ledger mutations use record versions, and native BB navigation owns opening source threads.

## Plugin permissions are not global tool isolation

Self improve contributes no ledger tools to its autonomous workers. For an authorized ledger chat, it contributes `self_improve_read`, `self_improve_edit` and `self_improve_retest`. Those tools paginate reads, limit edits to permitted fields and notes, and preserve the evaluation gates for re-testing. They cannot write trusted receipts or replace active artifacts.

These contribution rules control this plugin's tools. They do not remove tools supplied by BB, the provider, the workspace or another plugin. The current execution path uses BB threads and existing authentication; it has no private model gateway that filters all tool responses.

Use a dedicated scratch worker environment and a permission mode you trust. Agent sessions run there with that environment's ordinary tools.

## Export safely

Export requires an active or proven solution, confirmed wiring execution, a matching trusted evaluation receipt and the exact validated artifact revision. File paths are bounded relative paths; content and metadata pass publication privacy checks. The bundle includes evidence and exact undo context.

A **skill** carries project scope as instructions. That is guidance, not an access-control boundary. An exported **plugin** enforces explicit project selection and starts disabled. Review a draft before applying it elsewhere: a pass on one model, provider or project is not proof on another.

The dashboard's download is a JSON bundle containing file paths and content. Preview text is escaped. **Create draft PR** is a separate, explicit action: select an allowed `owner/repo` destination, choose a new directory, and confirm that you reviewed the files, evidence and destination. The server verifies the exact bundle digest and active artifact revision before submitting a draft review PR. It never merges or installs the result.

Export works for fixes recorded by the older proof path; fixes applied by the builder cannot be exported yet. A draft PR is a review submission, not a release or an installation.
