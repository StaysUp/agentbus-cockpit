import type { ConfigFound, Policy, SettingsInfo, Versioned } from './data/settings';
import type { FolderInfo } from './data/folders';
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface CockpitEvent {
  id: string;
  seq?: number;
  kind: string;
  time: string;
  session: string;
  turn?: string;
  exchange?: string;
  vendor?: string;
  client?: string;
  text?: string;
  model?: string;
  tools_offered?: string[];
  stop_reason?: string;
  usage?: Usage;
  latency_ms?: number;
  status?: number;
  tool_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown> | string;
  tool_output?: string;
  tool_error?: boolean;
  outcome?: string;
  // The harness's own check, not a person's request; it belongs to no turn.
  probe?: boolean;
  // On model.responded: the call's price in USD, and whether it is exact.
  cost_usd?: number;
  cost_complete?: boolean;
  [key: string]: unknown;
}

// A shell command the person ran in a session's copy with "!" in AgentBus
// 0.4, from its events: command.queued, command.started, then command.ran or
// command.failed. It sits between turns and started none. 0.5 removed the
// route; a session from before shows these read-only.
export interface ShellRun {
  // The command's id (cmd_…), as its events carry it.
  id: string;
  sessionId: string;
  state: 'queued' | 'running' | 'ran' | 'failed';
  // When its latest event happened, and when it was queued.
  time: string;
  queuedAt?: string;
  line: string;
  // With state ran:
  exitCode: number;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
  // All it wrote; truncated says some of it was cut.
  outputBytes: number;
  truncated?: boolean;
  durationMs: number;
  // With state failed: why, in the API's words.
  error?: string;
}


export interface ModelCallPair {
  requested: CockpitEvent;
  responded?: CockpitEvent;
}

export interface ToolCallPair {
  requested: CockpitEvent;
  completed?: CockpitEvent;
}

// A turn's state as GET /api/v0/turns gives it (CLIENT_API.md). A turn
// started through POST /turns is queued until a runner starts it, running
// until its agent exits, then finished on exit code 0, stopped when someone
// stopped it, else failed. Any other turn is finished once it has a
// turn.completed, else running.
export type TurnState = 'queued' | 'running' | 'finished' | 'failed' | 'stopped';

// One row of the turn list: what GET /api/v0/turns says about a turn.
export interface Turn {
  id: string;
  // 1-based, oldest first, within the session.
  turnNumber: number;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  // From start to end; undefined while the turn runs.
  durationMs?: number;
  // The person's words with system reminders taken out. The list carries no
  // text, so this is loaded from the single turn (getTurnText) for a live
  // turn, or from the recorded events for a file; empty until it is loaded.
  prompt: string;
  promptTruncated?: boolean;
  // The reply to the turn's last model call, loaded from the single turn or
  // the record; and the model that call asked for and how many calls the
  // turn made (facts the list carries). Undefined when not loaded. A loaded
  // turn reads the reply from its detail instead.
  reply?: string;
  replyTruncated?: boolean;
  model?: string;
  modelCalls?: number;
  // From the turn's turn.started: the agent (harness) and folder of the run
  // that started it, and the saved agent that ran it (agentId). Turns of one
  // session may name different agents. Absent for a turn no run started,
  // and in older files.
  agent?: string;
  agentId?: string;
  // The idempotency_key the turn was sent with: the cockpit matches a
  // message it queued to the turn that runs it.
  key?: string;
  folder?: string;
  // The reference of the person's folder (turn.started folder_ref): GET
  // /api/v0/folders gives its name. Absent in older records.
  folderRef?: string;
  // From the turn's turn.started: who started it when the person did not.
  // kind result: AgentBus delivered the result of work this session asked
  // for, and the prompt is that result. kind asked: another session's turn
  // asked for this one. Absent for a turn the person started.
  origin?: TurnOrigin;
  state: TurnState;
  // Why the turn failed, in the service's own words, when it says.
  error?: string;
  // True when the person stopped the turn (POST /api/v0/turns/<id>/stop).
  stopped?: boolean;
  // True when a Discard dropped this turn's file changes (its id was in a
  // workspace.discarded event's dropped_turns). The conversation stays; the
  // turn carries a small "Discarded" mark. The record keeps it durably; the
  // cockpit also sets it live when a discard it made returns.
  discarded?: boolean;
  outcome?: string;
  // Sums the turn's replies that carried usage; null when none did.
  usage: Usage | null;
  // Sum of cost_usd over the turn's model.responded events; null when none has one.
  costUsd: number | null;
  // False when a reply lacks a complete cost, or events of the session were dropped.
  costComplete: boolean;
  // The seq of the turn's turn.started, when the source has seq.
  startedSeq?: number;
  // The turn's own events, paired, once they are loaded
  // (GET /api/v0/sessions/{id}/events?turn=). Only loaded turns have it.
  detail?: TurnDetail;
}

// Who started a turn when the person did not (origin on GET /api/v0/turns).
export interface TurnOrigin {
  kind: 'asked' | 'result';
  // asked: the session and turn that asked. result: the session and turn the
  // work ran in.
  session?: string;
  turn?: string;
  // result: the kind of the work's turn, turn or review, and the agent.
  turnKind?: string;
  agent?: string;
}

// One turn's events, and what the cockpit reads from them.
export interface TurnDetail {
  events: CockpitEvent[];
  modelCalls: ModelCallPair[];
  toolCalls: ToolCallPair[];
  // The whole prompt from the turn's turn.started, cleaned and raw.
  prompt?: string;
  rawPrompt?: string;
  // The text of the last call's reply.
  agentResponse?: string;
}

// The turns of one session, oldest first, and the cursor (store, seq) they
// were computed at. A source with no cursor leaves store and seq out.
export interface TurnList {
  store?: string;
  seq?: number;
  turns: Turn[];
}

export interface SessionSummary {
  id: string;
  // The agent (harness) of the session's latest turn, and of its first:
  // a session whose later turns ran on another agent keeps its first.
  agent: string;
  first_agent?: string;
  // The saved agent the session started on (from the same event as
  // first_agent). Absent when that turn named a harness alone.
  first_agent_id?: string;
  client: string;
  folder?: string;
  // The reference of the folder, when the source gives it.
  folder_ref?: string;
  // The session's workspace, where its turns run (GET /api/v0/sessions folds
  // it in). Apply, Discard and the changes preview act on this workspace; with
  // none, the cockpit offers neither (there is no backward-compatible path).
  workspace?: string;
  // The session's mode, its workspace's: true when it runs in a copy behind a
  // wall (a sandbox) whose changes are applied on request, false when it runs
  // in the folder as it is.
  sandbox?: boolean;
  title: string;
  started: string;
  last: string;
  open: boolean;
  turns: number;
  usage: Usage;
  cost_usd?: number | null;
  cost_complete?: boolean;
  // True when the service can take a next message for this session
  // (POST /api/v0/turns with session).
  resumable?: boolean;
  // True when the session is archived (PATCH archived: true): hidden from the
  // default list. Only a view -- the session keeps its copy and can still take
  // a turn -- so the cockpit still offers Send. Reversible.
  archived?: boolean;
  // The origin of the session's first turn (GET /api/v0/sessions): kind asked
  // when an agent's turn asked for this session (ask_agent). Absent for a
  // session the person started. The list shows only sessions without an asked
  // origin; an asked session is reached from the ask inside its asking session.
  origin?: TurnOrigin;
}

// GET /api/v0/sessions: the rows and the cursor (store, seq) they were computed at.
// A source with no cursor leaves store and seq out.
export interface SessionList {
  store?: string;
  seq?: number;
  sessions: SessionSummary[];
}

// The session on screen: its row and its turns.
export interface SessionDetail extends SessionSummary {
  turnsList: Turn[];
}

// One way a harness reaches a model, from GET /api/v0/harnesses.
export interface AccessOption {
  kind: string; // subscription, openrouter or api
  label: string;
  disabled?: boolean;
  // Models to offer. A new subscription agent names none, so the harness
  // picks its own; an OpenRouter one starts with the first.
  models: string[];
  // Any model name is accepted: an OpenRouter model id, or any name for a
  // subscription. A name the vendor refuses fails the turn in its words.
  any_model?: boolean;
  key_env?: string;
  // For api: the key it uses, as Settings names it (anthropic, openai, gemini).
  // Whether a key is set is on GET /api/v0/subscriptions (api_keys, env_keys),
  // not here.
  key_name?: string;
}

// One harness the service can run an agent on, from GET /api/v0/harnesses.
export interface Harness {
  name: string;
  label?: string;
  disabled?: boolean;
  found: boolean;
  version?: string;
  signed_in?: boolean;
  access?: AccessOption[];
}

// One harness as one runner last probed it (GET /api/v0/runners).
export interface RunnerHarness {
  name: string;
  found: boolean;
  version?: string;
  signed_in?: boolean;
}

// One machine's runner, from GET /api/v0/runners: one row per machine.
export interface RunnerInfo {
  id: string;
  name: string;
  // runner: the one program of its machine, which holds its folders and runs
  // their sessions. connector: one from before 0.5, which takes no work.
  role: string;
  // The machine's id: a new session on it names it as machine. Absent
  // before its first report, and from a service before 0.5.
  machine?: string;
  // It asked control for work in the last minute.
  online: boolean;
  last_seen: string;
  // When it first enrolled, and how many turns it runs at once.
  enrolled?: string;
  capacity?: number;
  labels: string[];
  // From its report; absent before its first one.
  os?: string;
  arch?: string;
  harnesses: RunnerHarness[];
}

// A machine that ran agentbus login and waits for the person, from pending
// in GET /api/v0/runners. Its code is never in the list: the person types
// the one the machine shows.
export interface PendingMachine {
  id: string;
  name: string;
  os?: string;
  arch?: string;
  labels: string[];
  capacity: number;
  asked: string;
  expires: string;
}

// GET /api/v0/runners whole: the runners and the machines waiting.
export interface RunnersRead {
  runners: RunnerInfo[];
  pending: PendingMachine[];
}

// Which build the service is, from GET /api/v0/version.
export interface VersionInfo {
  version: string;
  commit?: string;
  modified?: boolean;
}

// What a person sets on a saved agent (POST and PUT /api/v0/agents).
export interface AgentFields {
  name: string;
  harness: string;
  access: string;
  model?: string;
  key_env?: string;
}

// A saved agent, from GET /api/v0/agents. A turn names it by id.
export interface SavedAgent extends AgentFields {
  id: string;
  created?: string;
  updated?: string;
}

// POST /api/v0/turns: a saved agent and a folder, with the first message.
// The service gives the session its own copy of the folder. The folder is a
// path typed for the machine in machine, or a listed folder by folder_ref
// and machine (GET /api/v0/folders). The session runs on that machine.
// A new session, the cockpit's New Session send. The source creates it as three
// calls in order: POST /api/v0/workspaces (the folder and the mode), POST
// /api/v0/sessions (the workspace and the name), then POST /api/v0/turns (the
// first message). The turn carries no folder or mode; its workspace owns them.
export interface RunRequest {
  agent: string;
  folder?: string;
  folder_ref?: string;
  // In place of folder and folder_ref: a session in several folders, all on
  // machine. Its copy holds each folder side by side, and Review, Apply,
  // Discard and Update cover them together. Copy only.
  folders?: WorkspaceFolderReq[];
  machine?: string;
  // True (the default) for a sandbox: a copy of the folder behind a wall whose
  // changes are applied on request. False: the agent works in the folder as it
  // is. The workspace's one mode, set when it is created.
  sandbox?: boolean;
  // The session's name, set on POST /api/v0/sessions. Absent leaves the first
  // message as its title.
  title?: string;
  prompt: string;
  model?: string;
  idempotency_key?: string;
}

// One folder of a session in several: a listed folder by its reference, or
// a typed path.
export type WorkspaceFolderReq = { folder_ref: string } | { folder: string };

// GET /api/v0/workspaces/<id>, as the cockpit reads it: the folders, each
// with the name its files are listed under. One folder has no name.
export interface WorkspaceInfo {
  workspace: string;
  folders?: { name?: string; folder?: string; folder_ref?: string }[];
}

// One row of GET /api/v0/workspaces, as the Runners page reads it. machine is
// the con_ id of the machine that owns the folder, absent for the service's
// own; closed is when Close removed the copy; head_turn is the latest turn
// with changes and applied_turn the latest one applied.
export interface WorkspaceRow {
  workspace: string;
  sandbox: boolean;
  created: string;
  machine?: string;
  folder?: string;
  folder_ref?: string;
  folders?: { name?: string; folder?: string; folder_ref?: string }[];
  closed?: string;
  head_turn?: string;
  applied_turn?: string;
}

// POST /api/v0/workspaces/<id>/close: queued, running, closed or failed
// (error says why); already when it was closed before.
export interface CloseState {
  state?: string;
  already?: boolean;
  error?: string;
}

// GET /api/v0/turns/<id>/diff, as the cockpit reads it: what one turn
// changed, ran and called.
export interface TurnDiffFile {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  size: number;
  diff?: string;
  diff_left_out?: boolean;
  content?: string;
}

export interface ApplyState {
  // none, queued, running, applied, refused or failed.
  state: string;
  // The turn the apply was asked for. An apply makes the folder as the
  // session was at that turn: every turn not yet applied, up to it. With
  // already, the turn whose apply covered this one.
  turn?: string;
  already?: boolean;
  files?: string[];
  // All the files written or removed: files may list fewer (truncated).
  count?: number;
  truncated?: boolean;
  conflicts?: { path: string; why: string; markers?: boolean }[];
  error?: string;
}

// POST /api/v0/workspaces/<id>/discard: dropping a sandbox workspace's
// unapplied changes. already is true when there was nothing to drop;
// dropped_turns are the turns whose file changes were dropped (the
// conversation stays), so the cockpit can mark them "Discarded" at once.
export interface DiscardState {
  // queued, running, discarded, or already (nothing to drop). A source may
  // answer with no state when the discard is done; the cockpit treats a
  // resolved call as a discard.
  state?: string;
  already?: boolean;
  dropped_turns?: string[];
  error?: string;
}

// POST /api/v0/workspaces/<id>/update: merging the person's folder as it is
// now into the sandbox copy, so the session's unapplied work sits on top of the
// folder and the next apply writes only that work. updated is true on a clean
// merge; on a conflict, conflicts names the files that changed on both sides and
// nothing changed.
export interface UpdateState {
  // queued, running, updated (the folder was merged in), conflict, or failed.
  state?: string;
  updated?: boolean;
  conflicts?: string[];
  // On a merge (state merged): the files now holding both sides between
  // conflict markers, for the agent to combine.
  unresolved?: string[];
  // On a merge that changed nothing: the files conflict markers cannot show
  // (not text, a link, removed on one side); error says so.
  unmergeable?: string[];
  error?: string;
}

// GET /api/v0/sessions/<id>/changes: what applying the conversation now
// would do, computed by the runner with the same code as Apply, writing
// nothing. files lists every file the apply would write or remove and each
// conflicting file, each diffed against the person's folder now.
export interface ApplyPreviewFile {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  added?: number;
  removed?: number;
  diff?: string;
  diff_left_out?: boolean;
}

export interface ApplyPreview {
  session: string;
  isolated: boolean;
  // Files or conflicts are not empty.
  unapplied: boolean;
  // The turn "Apply to my folder" applies (POST /api/v0/turns/<turn>/apply).
  turn?: string;
  turns?: string[];
  files: ApplyPreviewFile[];
  count: number;
  truncated?: boolean;
  diffs_cut?: boolean;
  // When this preview was taken; a reused preview is as of then, not now.
  previewed_at?: string;
  // The changes.previewed event this is from, and the store; next_before
  // pages the same preview.
  event?: string;
  store?: string;
  next_before?: number | null;
  // Out of date: the session changed after this preview was taken, but a fresh
  // one could not run (the runner is offline). why says so.
  stale?: boolean;
  // Each file the person changed in their folder since: an apply refuses it.
  // markers: the file still holds the conflict markers an update's merge
  // left (the agent combining it clears it), rather than a folder change.
  conflicts: { path: string; why: string; markers?: boolean }[];
  // Why there is nothing to apply (not isolated, or closed), or why it is stale.
  why?: string;
}

// GET /api/v0/turns/<id>/diff: the turn's summary. Each list is on its own
// paged route: the file changes at /changes, the model calls at /calls, the
// tool calls (with their commands) at /tools.
export interface TurnDiff {
  turn: string;
  session: string;
  state: string;
  files: {
    isolated: boolean;
    count: number;
  } | null;
  model_calls: { count: number };
  tools: { count: number };
  apply: ApplyState;
}

// GET /api/v0/turns/<id>/changes: a page of the turn's changed files. Page
// older files with before set to the previous page's next_before.
export interface TurnChangesPage {
  count: number;
  truncated?: boolean;
  diffs_cut?: boolean;
  content_left_out?: boolean;
  changes: TurnDiffFile[];
  next_before: number | null;
}

// The reply to POST /api/v0/turns: the session, and the turn it started.
// Every event of that turn carries the turn id.
export interface Started {
  session: string;
  // The turn's id: there from the answer on, even while it waits.
  turn: string;
  // running, or queued: it waits behind the session's earlier turns (ahead
  // says how many), or for a runner.
  state: 'running' | 'queued';
  ahead?: number;
  // The idempotency key had made this turn already.
  existing?: boolean;
  base_url?: string;
}

// Where a queued message's turn stands (GET /api/v0/turns/<id>): ended, and
// why it ended without running when it did.
export interface QueuedTurn {
  ended: boolean;
  failed: boolean;
  why?: string;
}

// GET /api/v0/turns/<turn>/calls/<exchange>: what one model call sent, split into
// pieces in the request's order, and the reply kept for it. With full=false
// every json is left out: kinds, labels and sizes only. size is the piece's
// exact byte count; approx_tokens is the service's estimate (size / 2.66),
// not the vendor's count.
export interface ContextPiece {
  kind: string;
  label: string;
  hash: string;
  size: number;
  approx_tokens?: number;
  json?: unknown;
}

// The practical context view: how big a turn's or a session's context is, how
// much came from the prompt cache, and what a prompt is made of. GET
// /api/v0/turns/{id}/context and GET /api/v0/sessions/{id}/context.

// One kind of piece in a prompt, summed: a part of made_of.
export interface ContextPart {
  kind: string;
  label?: string;
  approx_tokens: number;
  bytes: number;
  count: number;
}

// What a prompt was made of, from its stored request pieces (approximate).
export interface Composition {
  exchange: string;
  vendor: string;
  bytes: number;
  approx_tokens: number;
  parts: ContextPart[];
  note: string;
}

// How full a prompt is against the model's window, and where the vendor's
// harness compacts. The practical number of the context view.
export interface ContextWindow {
  model: string;
  harness: string;
  window_tokens: number;
  window_known: boolean;
  used_tokens: number;
  percent_full: number;
  compaction_point?: number; // share (0..1); absent for an unknown harness
  compaction_pct?: number; // rounded percent of the window
  compaction_source?: string; // 'vendor' | 'default'
  compaction_is_default: boolean;
}

// One turn's context: its size, cache split and what its largest prompt holds.
export interface TurnContext {
  store: string;
  seq: number;
  turn: string;
  session: string;
  model: string;
  window: ContextWindow | null;
  calls: number;
  context_tokens: number;
  cache_read_tokens: number;
  fresh_tokens: number;
  output_tokens: number;
  made_of: Composition | null;
}

// One turn in a session's growth.
export interface SessionContextTurn {
  turn: string;
  started: string;
  calls: number;
  context_tokens: number;
  cache_read_tokens: number;
  fresh_tokens: number;
  output_tokens: number;
}

// A session's context: its totals and a page of its turns, newest first.
export interface SessionContext {
  store: string;
  seq: number;
  session: string;
  turns: number;
  peak_context_tokens: number;
  cache_read_tokens: number;
  fresh_tokens: number;
  output_tokens: number;
  growth: SessionContextTurn[];
  next_before: number | null;
}

export interface CallContext {
  exchange: string;
  session?: string;
  vendor?: string;
  time?: string;
  size: number;
  stop_reason?: string;
  reply?: ContextPiece;
  // Every other top-level field of the request, in its order.
  request?: Record<string, unknown>;
  pieces: ContextPiece[];
}

// The person's own subscription for a harness, kept on control: every turn
// uses it, on one machine as on many (GET /api/v0/subscriptions). Never the
// token.
export interface ConnectView {
  harness: string;
  state: 'running' | 'connected' | 'failed';
  // While it runs: the links the login printed. Empty once it ended.
  output: string[];
  // While it runs: a one-time code to enter at the link (codex's device
  // login); nothing is typed back here.
  code?: string;
  // While it runs: the login waits for the code the sign-in page shows
  // (claude, agy).
  paste: boolean;
  // Why a failed one ended: the login did not take the code sent, or it was
  // cancelled. error says it in full.
  rejected?: boolean;
  cancelled?: boolean;
  error?: string;
}
export interface SubscriptionState {
  harness: string;
  connected: boolean;
  connected_at?: string;
  expires_at?: string;
  // Control renews the token itself before it expires (codex).
  renews?: boolean;
  expired: boolean;
  // Why it cannot be used, when it cannot.
  error?: string;
  connect?: ConnectView;
  // How much of the plan is used, per window, shortest first, as the vendor
  // said on the latest model reply on this subscription. Absent until one.
  usage?: PlanReading[];
  // Whether plan usage is known: false when connected with no reading yet.
  usage_known?: boolean;
}
// One window of a subscription's plan (GET /api/v0/subscriptions, usage).
export interface PlanReading {
  // The vendor's name for it: 5h or 7d (claude), primary or secondary (codex).
  window: string;
  // Its length, such as 300 or 10080. Absent when the vendor did not say.
  window_minutes?: number;
  // 0 to 100; it can pass 100 over the limit.
  used_percent: number;
  resets_at?: string;
  // The vendor's own word, such as allowed or rejected (claude).
  status?: string;
  // When it was read. It is stored when it changes, and at most every 10
  // minutes while calls keep it the same.
  read_at: string;
}
export interface SubscriptionList {
  subscriptions: SubscriptionState[];
  // Whether each vendor's key (anthropic, openai, gemini, openrouter) is set
  // on control, by name. The one place a stored key's "is it set" is answered.
  // Never a key. Absent: a control too old to keep them.
  api_keys?: Record<string, { set: boolean; set_at?: string }>;
  // Whether each environment variable a saved openrouter agent names in
  // key_env is set where control runs, by name. Never a value. Absent: a
  // control too old to report it.
  env_keys?: Record<string, boolean>;
}

// One command (or several, from one reply) a person must allow or refuse, as
// GET /api/v0/approvals lists it.
export interface HeldApproval {
  id: string;
  session: string;
  turn?: string;
  agent?: string;
  tool_id?: string;
  tool_name?: string;
  commands: string[];
  rule: string;
  requested: string;
}

// ApprovalGone is thrown by decideApproval when the command was already
// answered or is being answered (HTTP 409 or 404): the card should step aside.
export const ApprovalGone = 'approval-gone';

// ApprovalDecision is how a person answers a card: once lets the commands run
// this continuation turn only and writes nothing to the settings; always moves
// the matched command to the allow list, from now on; refuse records the
// decision only.
export type ApprovalDecision = 'once' | 'always' | 'refuse';

// AppSummary is an app as the list carries it (GET /api/v0/tools): facts only.
// The full definition is read from GET /api/v0/tools/{name}. An app carries no
// effect: nothing about it is trusted, and a call is decided by its name
// against the rules (his decision, 2026-11-18).
export interface AppSummary {
  name: string;
  description: string;
  // Where a call runs: 'control' in 0.6.
  where: string;
}

// AppStep is one step of an app's workflow (kind 'app'): an API operation,
// named by its operationId, with its request values and the outputs it exposes.
export interface AppStep {
  stepId: string;
  operationId: string;
  requestBody?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  outputs?: Record<string, string>;
}

// AppWorkflow is an app's Arazzo workflow: ordered steps over the API, and the
// app's own outputs read from step outputs.
export interface AppWorkflow {
  steps: AppStep[];
  outputs?: Record<string, string>;
}

// AppRun is what an app's call runs. An 'api' app runs one AgentBus API route
// (the method/path fields describe it); an 'app' runs an Arazzo workflow over
// several operations (the app field), B15.
export interface AppRun {
  kind: string;
  method?: string;
  path?: string;
  id_input?: string;
  own_session?: boolean;
  query?: string[];
  body?: boolean;
  app?: AppWorkflow;
}

// AppDef is an app's whole definition (GET /api/v0/tools/{name}): the summary's
// facts plus the inputs schema and the run.
export interface AppDef extends AppSummary {
  inputs: Record<string, unknown>;
  run: AppRun;
}

export interface DataSource {
  getSessions(): Promise<SessionSummary[]>;
  // The sessions with the cursor they were taken at. A source without it is
  // read through getSessions, and its lists always replace the shown one.
  getSessionList?(): Promise<SessionList>;
  // Every turn of one session, oldest first, without their events.
  getTurns(sessionId: string): Promise<TurnList>;
  // One turn's events, paired. null when the turn has no events.
  getTurn(sessionId: string, turnId: string): Promise<TurnDetail | null>;
  // The whole prompt and reply of one turn, read from the single turn (GET
  // /api/v0/turns/{id}). The turn list carries neither, so the cockpit loads
  // each shown turn's text from here. A source whose list already carries the
  // text (a recorded file) leaves this out.
  getTurnText?(sessionId: string, turnId: string): Promise<{ prompt: string; reply?: string }>;
  // A source that keeps saved agents has these: the harnesses they can run
  // on, and the agents to list, save, edit and remove. Each rejects with the
  // API's own words.
  getHarnesses?(): Promise<Harness[]>;
  // GET /api/v0/harnesses/<harness>/models?access=<access>: the models that
  // access can use now, from each source's own data. refresh fetches the
  // list again now.
  getModels?(harness: string, access: string, refresh?: boolean): Promise<ModelList>;
  // The folders the runners own (GET /api/v0/folders), each by its
  // reference and name.
  listFolders?(): Promise<FolderInfo[]>;
  // The machines control knows, one runner each (GET /api/v0/runners). null
  // when the service has no such route.
  listRunners?(): Promise<RunnerInfo[] | null>;
  // The same read with the machines waiting for approval, and the person's
  // decisions on the Runners page: approve a waiting machine with the code
  // it shows, refuse it, or remove an offline runner. Each rejects with the
  // API's own words.
  readRunners?(): Promise<RunnersRead | null>;
  approveMachine?(id: string, code: string): Promise<void>;
  refuseMachine?(id: string): Promise<void>;
  removeRunner?(id: string): Promise<void>;
  // The commands waiting for a person (GET /api/v0/approvals): the gateway held
  // a command on the ask list, or one on none of the lists under the ask
  // default, and recorded it. null when the service has no such route.
  listApprovals?(): Promise<HeldApproval[] | null>;
  // Answer one (POST /api/v0/approvals/<id>): once runs the commands this
  // continuation turn only (settings unchanged); always moves the matched
  // command to the allow list and continues; refuse records the decision.
  // Rejects with ApprovalGone when another answer already took it (409).
  decideApproval?(id: string, decision: ApprovalDecision): Promise<void>;
  // GET /api/v0/version: which build the service is. Read once.
  getVersion?(): Promise<VersionInfo>;
  listAgents?(): Promise<SavedAgent[]>;
  // Where a queued message's turn stands, by the session and turn
  // POST /api/v0/turns answered with.
  queuedTurn?(session: string, turn: string): Promise<QueuedTurn>;
  createAgent?(f: AgentFields): Promise<SavedAgent>;
  updateAgent?(id: string, f: AgentFields): Promise<SavedAgent>;
  removeAgent?(id: string): Promise<void>;
  // A control that adds the person's own subscription to their runners'
  // calls has these: the subscriptions (null when the service keeps none),
  // a connect started with the harness's own login, its output with the
  // token taken out, and a line typed into it.
  listSubscriptions?(): Promise<SubscriptionList | null>;
  connectSubscription?(harness: string): Promise<ConnectView>;
  getConnect?(harness: string): Promise<ConnectView>;
  connectInput?(harness: string, line: string): Promise<void>;
  // DELETE /api/v0/subscriptions/<harness>/connect: stop a running login.
  cancelConnect?(harness: string): Promise<void>;
  // PUT and DELETE /api/v0/subscriptions/openrouter/key: set the OpenRouter
  // key on control, sent once and never read back, or remove it.
  setOpenRouterKey?(key: string): Promise<void>;
  // PUT and DELETE /api/v0/subscriptions/<name>/key for a vendor's API key.
  setAPIKey?(name: string, key: string): Promise<void>;
  removeAPIKey?(name: string): Promise<void>;
  removeOpenRouterKey?(): Promise<void>;
  // The settings routes (/api/v0/settings), for the Settings page.
  getSettings?(): Promise<Versioned<SettingsInfo>>;
  getPolicy?(): Promise<Versioned<Policy>>;
  putPolicy?(p: Policy, etag: string): Promise<Versioned<Policy>>;
  patchPolicy?(change: Policy, etag: string): Promise<Versioned<Policy>>;
  getInstructions?(): Promise<Versioned<string>>;
  putInstructions?(text: string, etag: string): Promise<Versioned<string>>;
  // The usual config paths in the home of a folder's machine, for Use my
  // config on the Settings page (GET /api/v0/folders/{ref}/home-files).
  findConfig?(): Promise<ConfigFound>;
  // The apps (tools) control serves, for the Apps page. The list carries facts
  // only; getApp reads one app's full definition (GET /api/v0/tools/{name}).
  // addApp adds a custom app and removeApp drops one (a built-in re-added as
  // custom, or any custom one). Each rejects with the API's own words; a source
  // without these has no Apps page.
  listApps?(): Promise<AppSummary[]>;
  getApp?(name: string): Promise<AppDef>;
  addApp?(def: AppDef): Promise<AppDef>;
  removeApp?(name: string): Promise<void>;
  // A source that can start and continue sessions has these. Each rejects with
  // an Error whose message is the API's own words. Starting resolves with the
  // session id and, from the live API, the new turn's id.
  startRun?(req: RunRequest): Promise<Started>;
  // The two halves of startRun, for a session opened empty (no first message).
  // createWorkspace makes only the workspace, which is where the runner checks
  // the folder, so a bad folder is refused before any draft or session exists.
  // startInWorkspace makes the session and its first turn in a workspace
  // createWorkspace already made, so the folder is never re-checked there.
  createWorkspace?(req: RunRequest): Promise<string>;
  startInWorkspace?(workspace: string, req: RunRequest): Promise<Started>;
  // agent names a saved agent: the turn runs on it, in the session's folder.
  sendMessage?(
    sessionId: string,
    req: { prompt: string; model?: string; agent?: string; idempotency_key?: string }
  ): Promise<Started>;
  // A source that keeps a record has this: the session's "!" command events
  // from before AgentBus 0.5, oldest first, each as a ShellRun in the state
  // that event says. Rejects with an Error in the API's own words.
  getCommands?(sessionId: string): Promise<ShellRun[]>;
  // A source that can name sessions has this: a new title for one. Rejects
  // with an Error in the API's own words.
  renameSession?(sessionId: string, title: string): Promise<void>;
  // Archive a session (true) or un-archive it (false): only a view, so it
  // hides the session from the default list and removes nothing; the session
  // keeps its copy and can still take a turn. 'ok' when done, 'running' when
  // the session has not finished a turn on this service yet (so it has no
  // record to carry the flag). Rejects with the API's words.
  archiveSession?(sessionId: string, archived: boolean): Promise<'ok' | 'running'>;
  // A source that keeps a record has this: every event of one session, oldest
  // first, as the API sends them. Rejects with the API's words.
  getSessionEvents?(sessionId: string): Promise<unknown[]>;
  // A source that runs turns can stop one: 'stopping' when the service took
  // the stop (202, also when it was already stopping), 'not-running' when the
  // turn has already ended (409). Rejects with an Error in the API's own words.
  stopTurn?(turnId: string): Promise<'stopping' | 'not-running'>;
  // A source that keeps isolated copies has these: one turn's full diff, and
  // applying its changes to the person's folder. apply resolves with the
  // API's answer on 200, 202 and 409 (a refusal names each file); any other
  // failure rejects with the API's words.
  getTurnDiff?(sessionId: string, turnId: string): Promise<TurnDiff>;
  getTurnChanges?(sessionId: string, turnId: string, before?: number): Promise<TurnChangesPage>;
  // A source that keeps sandbox workspaces has these, each on the workspace the
  // session's turns run in (its `workspace` field). applyWorkspace writes the
  // workspace's unapplied changes to the person's folder, up to `turn` when
  // given (POST /api/v0/workspaces/{id}/apply); it resolves on 200, 202 and 409
  // (a refusal names each file). discardWorkspace drops them instead (POST
  // /api/v0/workspaces/{id}/discard). Any other failure rejects with the API's
  // words.
  applyWorkspace?(workspace: string, turn?: string): Promise<ApplyState>;
  discardWorkspace?(workspace: string): Promise<DiscardState>;
  // updateWorkspace merges the person's folder as it is now into the copy, so a
  // later apply writes only the session's work (POST
  // /api/v0/workspaces/{id}/update): the calm way forward when an apply is
  // refused because the folder changed. It resolves on 200 (updated or
  // conflict), 202 and 409; any other failure rejects with the API's words.
  // mode merge: a conflict leaves both sides in the files between conflict
  // markers for the agent to combine (state merged, unresolved), instead of
  // changing nothing.
  updateWorkspace?(workspace: string, mode?: 'merge'): Promise<UpdateState>;
  // What applying the workspace now would do (a dry run,
  // GET /api/v0/workspaces/{id}/changes): the files not yet in the person's
  // folder, their diffs and conflicts. Rejects with the API's words.
  getWorkspaceChanges?(workspace: string, fresh?: boolean): Promise<ApplyPreview>;
  // The workspace's record (GET /api/v0/workspaces/{id}): its folders, for
  // grouping a review by folder. Rejects with the API's words.
  getWorkspace?(workspace: string): Promise<WorkspaceInfo>;
  // Every workspace (GET /api/v0/workspaces), for the Runners page; null on a
  // service without the route. closeWorkspace removes a sandbox workspace's
  // copy (POST /api/v0/workspaces/{id}/close); sessions and the record stay.
  // It resolves on 200 and 202; any other answer rejects with the API's words.
  listWorkspaces?(): Promise<WorkspaceRow[] | null>;
  closeWorkspace?(workspace: string): Promise<CloseState>;
  // A source that keeps request bodies has this: one model call's request
  // and reply by its turn and exchange. Rejects with an Error in the API's
  // own words.
  getCallContext?(turn: string, exchange: string, full: boolean): Promise<CallContext>;
  // A source that serves the context view has these: one turn's context size,
  // cache split and made_of, and a session's totals and per-turn growth. Reject
  // with an Error in the API's own words.
  getTurnContext?(sessionId: string, turnId: string): Promise<TurnContext>;
  getSessionContext?(sessionId: string, before?: number): Promise<SessionContext>;
  // Calls onEvent for each new event, and onSnapshot with the sessions of the
  // snapshot the stream starts from: once at the start, and again whenever it
  // starts over (the store changed). Show that list, so the list and the
  // stream share one cursor.
  // onState says whether the stream is up: true once a connection is open,
  // false when it drops and while it reconnects.
  subscribe?(
    onEvent: (event: CockpitEvent) => void,
    onSnapshot?: (sessions: SessionSummary[], cursor?: { store: string; seq: number }) => void,
    onState?: (up: boolean) => void
  ): () => void;
}

// One click on an event. The nonce changes on every click, so the same id
// selected twice is still two selections. id null clears the selection.
export interface EventSelection {
  id: string | null;
  nonce: number;
}

// What the right panel shows, and what carries the mark in the conversation:
// the whole session, one turn in it, or one model call in that turn.
export type Level = 'session' | 'turn' | 'call';

// One model an access offers (GET /api/v0/harnesses/<harness>/models).
export interface ModelOption {
  id: string;
  // Its name for a screen, when the source gives one.
  label?: string;
}

// The models a harness can use now on one access, and where the list came
// from: api (OpenRouter's list), command (agy models on control), runner
// (codex's own cache, reported after a turn) or fixed (claude's aliases).
export interface ModelList {
  harness: string;
  access: string;
  models: ModelOption[];
  source: string;
  fetched_at?: string;
  // Why the list is empty or old, in the service's words.
  error?: string;
}
