import type { Policy, SettingsInfo, Versioned } from './data/settings';
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
  // The person's words with system reminders taken out. From the list this
  // is a preview of the first 500 characters; promptTruncated says it was cut.
  prompt: string;
  promptTruncated?: boolean;
  // From the list, for a turn whose events are not loaded: the reply to the
  // turn's last model call (its first 500 characters; replyTruncated says it
  // was cut), the model that call asked for, and how many model calls the
  // turn made. Undefined when the source does not give them. A loaded turn
  // reads all three from its detail instead.
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
  // True when the session was closed (PATCH closed: true): it takes no more
  // turns, so the cockpit offers no Send.
  closed?: boolean;
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
  // Whether key_env is set where the service runs. Never its value.
  key_set?: boolean;
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
  // The machine's id: a new session on it names it as connector. Absent
  // before its first report, and from a service before 0.5.
  connector?: string;
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
  // Whether it can build a session's wall (the sandbox setting), and why
  // not. Absent from a runner of a build before it reported it.
  sandbox?: SandboxInfo;
}

export interface SandboxInfo {
  can: boolean;
  why?: string;
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
  sandbox?: SandboxInfo;
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
  key_set?: boolean;
  created?: string;
  updated?: string;
}

// POST /api/v0/turns: a saved agent and a folder, with the first message.
// The service gives the session its own copy of the folder. The folder is a
// path typed for the machine in connector, or a listed folder by folder_ref
// and connector (GET /api/v0/folders). The session runs on that machine.
export interface RunRequest {
  agent: string;
  folder?: string;
  folder_ref?: string;
  connector?: string;
  isolate?: boolean;
  prompt: string;
  model?: string;
  read_only?: boolean;
  idempotency_key?: string;
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
  conflicts?: { path: string; why: string }[];
  error?: string;
}

export interface TurnDiff {
  turn: string;
  session: string;
  state: string;
  files: {
    isolated: boolean;
    count: number;
    truncated?: boolean;
    changes: TurnDiffFile[];
    git_diff?: string;
  } | null;
  model_calls: { count: number };
  tools: { count: number };
  commands: string[];
  apply: ApplyState;
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
}
export interface SubscriptionList {
  subscriptions: SubscriptionState[];
}

export interface DataSource {
  getSessions(): Promise<SessionSummary[]>;
  // The sessions with the cursor they were taken at. A source without it is
  // read through getSessions, and its lists always replace the shown one.
  getSessionList?(): Promise<SessionList>;
  // True when the service says this session is closed
  // (GET /api/v0/sessions/<id>). A source without it has no closed sessions.
  sessionClosed?(sessionId: string): Promise<boolean>;
  // Every turn of one session, oldest first, without their events.
  getTurns(sessionId: string): Promise<TurnList>;
  // One turn's events, paired. null when the turn has no events.
  getTurn(sessionId: string, turnId: string): Promise<TurnDetail | null>;
  // A source that keeps saved agents has these: the harnesses they can run
  // on, and the agents to list, save, edit and remove. Each rejects with the
  // API's own words.
  getHarnesses?(): Promise<Harness[]>;
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
  // The settings routes (/api/v0/settings), for the Settings page.
  getSettings?(): Promise<Versioned<SettingsInfo>>;
  getPolicy?(): Promise<Versioned<Policy>>;
  putPolicy?(p: Policy, etag: string): Promise<Versioned<Policy>>;
  getInstructions?(): Promise<Versioned<string>>;
  putInstructions?(text: string, etag: string): Promise<Versioned<string>>;
  // A source that can start and continue sessions has these two. Each
  // rejects with an Error whose message is the API's own words. Starting
  // resolves with the session id and, from the live API, the new turn's id.
  startRun?(req: RunRequest): Promise<Started>;
  // agent names a saved agent: the turn runs on it, in the session's folder.
  sendMessage?(
    sessionId: string,
    req: { prompt: string; read_only?: boolean; model?: string; agent?: string; idempotency_key?: string }
  ): Promise<Started>;
  // A source that keeps a record has this: the session's "!" command events
  // from before AgentBus 0.5, oldest first, each as a ShellRun in the state
  // that event says. Rejects with an Error in the API's own words.
  getCommands?(sessionId: string): Promise<ShellRun[]>;
  // A source that can name sessions has this: a new title for one. Rejects
  // with an Error in the API's own words.
  renameSession?(sessionId: string, title: string): Promise<void>;
  // A source that runs turns can stop one: 'stopping' when the service took
  // the stop (202, also when it was already stopping), 'not-running' when the
  // turn has already ended (409). Rejects with an Error in the API's own words.
  stopTurn?(turnId: string): Promise<'stopping' | 'not-running'>;
  // A source that keeps isolated copies has these: one turn's full diff, and
  // applying its changes to the person's folder. apply resolves with the
  // API's answer on 200, 202 and 409 (a refusal names each file); any other
  // failure rejects with the API's words.
  getTurnDiff?(sessionId: string, turnId: string): Promise<TurnDiff>;
  applyTurn?(turnId: string): Promise<ApplyState>;
  // A source that keeps request bodies has this: one model call's request
  // and reply by its turn and exchange. Rejects with an Error in the API's
  // own words.
  getCallContext?(turn: string, exchange: string, full: boolean): Promise<CallContext>;
  // Calls onEvent for each new event, and onSnapshot with the sessions of the
  // snapshot the stream starts from: once at the start, and again whenever it
  // starts over (the store changed). Show that list, so the list and the
  // stream share one cursor.
  subscribe?(
    onEvent: (event: CockpitEvent) => void,
    onSnapshot?: (sessions: SessionSummary[], cursor?: { store: string; seq: number }) => void
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
