import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  addFound,
  changeOf,
  flatPolicy,
  isEmpty,
  lines,
  nestPolicy,
  Policy,
  SettingsApi,
  SettingsInfo,
  Versioned,
} from "../data/settings";
import { ColHead, PageFrame } from "./PageFrame";
import { Button, Seg, Switch } from "./Controls";
import { setLeaveGuard } from "../page";
import { ConnectStep, SubscriptionApi } from "./ConnectStep";
import { APIKey, OpenRouterKey } from "./OpenRouterKey";
import { SubscriptionList } from "../types";
import { ConfirmDialog } from "./Dialog";
import { Loading, Notice } from "./Notice";
import { KEPT, LOADING, PRODUCT } from "../words";

// The Settings page (/settings): AgentBus's settings, one global set for every machine.
// Every setting of the policy is a plain control, in groups (Permissions, Config, Limits); then the instructions every turn gets, the subscriptions, and the whole policy as JSON (Advanced). Each
// part saves on its own, with the version it read; a change made elsewhere in between is refused, and the page
// reads everything again.
//
// The sandbox and network settings were retired (every conversation works in a
// copy now; a session's mode is Direct, Copy or Locked), so there is no
// Isolation group. The isolation backend key stays in Advanced.
//
// A save sends only the keys the person changed (PATCH), never a full copy with the defaults filled in: a copy
// would keep every default at today's value after a later build changes it.

interface SettingsPageProps {
  api: SettingsApi;
  onBack: () => void;
  // The foot nav targets, passed through to PageFrame: the sibling pages and
  // the Feedback box. The Settings row is left out here (this is that page).
  onApps?: () => void;
  onRunners?: () => void;
  onSettings?: () => void;
  runnersOnline?: number;
  version?: string;
  // The AgentBus card at the foot, the same as the cockpit's.
  sourceLabel?: string;
  streamUp?: boolean;
  onDisconnect?: () => void;
  disconnectLabel?: string;
  // The subscriptions control keeps, which every turn uses. Absent: a
  // service that keeps none, and no Subscriptions part.
  subscriptions?: SubscriptionApi;
  // Open on Subscriptions rather than the first part: an agent's sign-in dot
  // brings the person here to connect.
  atSubscriptions?: boolean;
}

interface Loaded {
  info: Versioned<SettingsInfo>;
  policy: Versioned<Policy>;
  instructions: Versioned<string>;
}

// How a control edits its key. A list is one entry per line; a number is
// typed as text and checked.
type Kind =
  | { t: "switch" }
  | { t: "onoff" } // a string key that is "on" or "off", as a switch
  | { t: "seg"; options: [string, string][] }
  | { t: "list"; placeholder: string; mono?: boolean }
  | { t: "number"; whole: boolean };

interface Control {
  key: string; // the draft slot: a policy key, dotted, or a rule half's own slot
  name: string;
  line: string; // one short plain line: what it does
  kind: Kind;
  more?: string; // a second line, only where it must be said
  head?: string; // a small heading above it, where a group holds two kinds
  // A rule half: the policy list this edits (allow/ask/forbid) and which half.
  // Commands and tools share one stored list; a tool rule carries the TOOL
  // prefix (B16), so the page splits by it on read and adds it on save. The
  // person never types the prefix.
  policyKey?: string;
  of?: "cmd" | "tool";
}

// A tool rule is stored in the same list as commands, with this prefix.
const TOOL = "tool:";
// The policy list a control edits: its own key, or the list a rule half splits.
const pkey = (c: Control): string => c.policyKey ?? c.key;
const isTool = (s: string): boolean => s.startsWith(TOOL);

type GroupId = "permissions" | "config" | "limits";
type Part = GroupId | "instructions" | "subscriptions" | "advanced";

interface Group {
  id: GroupId;
  name: string;
  sub: string;
  controls: Control[];
  side: string[];
}

const GROUPS: Group[] = [
  {
    id: "permissions",
    name: "Permissions",
    sub: "What agents may do through AgentBus",
    controls: [
      { key: "agent_api.apply", name: "Agents may apply", kind: { t: "switch" },
        line: "An agent may apply a turn's changes to your folder. You always may." },
      // Commands and tools are one stored list each; the Tools boxes hold the
      // same list's entries that carry the TOOL prefix, shown without it.
      { key: "allow", policyKey: "allow", of: "cmd", name: "Allow", head: "Commands", kind: { t: "list", placeholder: "go test", mono: true },
        line: "Commands agents may run without asking, one per line." },
      { key: "ask", policyKey: "ask", of: "cmd", name: "Ask", kind: { t: "list", placeholder: "git push", mono: true },
        line: "Commands that wait for you, one per line." },
      { key: "forbid", policyKey: "forbid", of: "cmd", name: "Refuse", kind: { t: "list", placeholder: "git push", mono: true },
        line: "Commands they may never run, one per line." },
      { key: "allow.tool", policyKey: "allow", of: "tool", name: "Allow", head: "Tools", kind: { t: "list", placeholder: "tool:*", mono: true },
        line: "Tools agents may use without asking, one per line." },
      { key: "ask.tool", policyKey: "ask", of: "tool", name: "Ask", kind: { t: "list", placeholder: "ask_agent", mono: true },
        line: "Tools that wait for you, one per line." },
      { key: "forbid.tool", policyKey: "forbid", of: "tool", name: "Refuse", kind: { t: "list", placeholder: "subagent", mono: true },
        line: "Tools they may never use, one per line." },
    ],
    side: [
      "Agents may always read, list agents, start, review, stop and rename work within the request they belong to.",
      "The limits cap how much they ask for.",
      "AgentBus decides every command and tool: Refuse wins, then Ask, then Allow. By default Allow holds * (every command) and tool:* (every tool), so a command or tool on none of the lists is held for you.",
      "On a held command or tool, Allow once lets it run that turn only; Always allow adds it to the allow list.",
    ],
  },
  {
    id: "config",
    name: "Config",
    sub: "Settings, skills and MCP servers each session gets",
    controls: [
      { key: "home_files", name: "Copied from your home", kind: { t: "list", placeholder: "~/.aws/config", mono: true },
        line: "Files and folders from your home, one per line, such as ~/.aws/config." },
    ],
    side: [
      "Use my config adds the usual config files found on the folder's machine. Look them over, then save.",
      "Copied into each session's home at the start of each turn.",
      "MCP servers in your config load on every turn, reviews included. What a server does is outside AgentBus's record.",
      "The browser cannot run in AgentBus sessions.",
    ],
  },
  {
    id: "limits",
    name: "Limits",
    sub: "How much agents may ask for",
    controls: [
      { key: "limits.max_depth", name: "Depth", kind: { t: "number", whole: true },
        line: "Levels of asking below your own turn." },
      { key: "limits.max_jobs_per_turn", name: "Turns per request", kind: { t: "number", whole: true },
        line: "Turns and reviews one turn may ask for." },
      { key: "limits.max_jobs_per_tree", name: "Turns per request tree", kind: { t: "number", whole: true },
        line: "Turns and reviews all the work from one of your turns may ask for." },
      { key: "limits.max_cost_usd_per_tree", name: "Cost per request tree (USD)", kind: { t: "number", whole: false },
        line: "What all the work from one of your turns may cost before asking stops. 0 is off." },
    ],
    side: ["A request tree is your turn and all the work asked for from it, at any depth.", "A limit reached refuses the request and says which."],
  },
];

const CONTROLS = GROUPS.flatMap((g) => g.controls);

// A control's draft: text for a list or a number, a boolean for a switch,
// the value for a choice.
type Draft = Record<string, string | boolean>;

function draftOf(c: Control, v: unknown): string | boolean {
  // A rule half reads its share of the one stored list: the commands box takes
  // the entries without the TOOL prefix; the tools box takes the prefixed ones,
  // shown without it.
  if (c.of) {
    const all = Array.isArray(v) ? (v as string[]) : [];
    if (c.of === "tool") return all.filter(isTool).map((e) => e.slice(TOOL.length)).join("\n");
    return all.filter((e) => !isTool(e)).join("\n");
  }
  switch (c.kind.t) {
    case "switch":
      return v === true;
    case "onoff":
      return v === "on";
    case "list":
      return Array.isArray(v) ? v.join("\n") : "";
    case "number":
      return typeof v === "number" ? String(v) : "";
    case "seg":
      return typeof v === "string" ? v : "";
  }
}

// ruleChange is one policy list rebuilt from its two draft boxes: the commands
// as typed, then the tools with the TOOL prefix. A Tools line already written
// with the prefix (the form the policy documents and Advanced shows) keeps the
// one prefix, never a doubled tool:tool:. Undefined when the result matches what
// was read (commands then tools), so a save sends nothing.
function ruleChange(draft: Draft, cmdKey: string, toolKey: string, read: unknown): string[] | undefined {
  const cmd = lines(String(draft[cmdKey] ?? ""));
  const tool = lines(String(draft[toolKey] ?? "")).map((e) => (isTool(e) ? e : TOOL + e));
  const next = [...cmd, ...tool];
  const was = Array.isArray(read) ? (read as string[]) : [];
  const canon = [...was.filter((e) => !isTool(e)), ...was.filter(isTool)];
  return JSON.stringify(next) === JSON.stringify(canon) ? undefined : next;
}

// valueOf is a draft as the policy value it writes, or an error in words.
function valueOf(c: Control, d: string | boolean): { v: unknown } | { error: string } {
  switch (c.kind.t) {
    case "switch":
      return { v: d === true };
    case "onoff":
      return { v: d === true ? "on" : "off" };
    case "list":
      return { v: lines(String(d)) };
    case "seg":
      return { v: d };
    case "number": {
      const t = String(d).trim();
      const n = Number(t);
      if (t === "" || !Number.isFinite(n) || n < 0 || (c.kind.whole && !Number.isInteger(n))) {
        return { error: c.kind.whole ? "A whole number, 0 or more." : "A number, 0 or more." };
      }
      return { v: n };
    }
  }
}

const json = (p: Policy) => JSON.stringify(p, null, 2);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const SettingsPage: React.FC<SettingsPageProps> = ({ api, onBack, onApps, onRunners, onSettings, runnersOnline, version, sourceLabel, streamUp, onDisconnect, disconnectLabel, subscriptions, atSubscriptions }) => {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The drafts, reset from what was read.
  const [draft, setDraft] = useState<Draft>({});
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [policyText, setPolicyText] = useState("");
  // The policy the Advanced draft was made from. A save of another part
  // reads a newer policy but keeps an unsaved Advanced draft; the draft's
  // change is what the person edited against this, never a revert of that
  // save.
  const [advancedBase, setAdvancedBase] = useState<Policy | null>(null);
  // The flat policy of the last read: a kept group's untouched controls
  // follow a newer read, so they write nothing back.
  const lastRead = useRef<Record<string, unknown>>({});
  const [instructions, setInstructions] = useState("");
  // Which part is saving, and what the last save said.
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ part: string; text: string; ok: boolean } | null>(null);
  // The part on screen.
  const [part, setPart] = useState<Part>(atSubscriptions && subscriptions ? "subscriptions" : "permissions");

  // Which parts hold changes not saved, as of the last render: a read
  // after one part's save leaves another part's unsaved draft as it is.
  const dirtyRef = useRef<Partial<Record<Part, boolean>>>({});
  const read = useCallback(
    async (parts: { policy: boolean; instructions: boolean }, saved?: Part | "all") => {
      const keep = (p: Part) => saved !== "all" && p !== saved && !!dirtyRef.current[p];
      const [info, policy, ins] = await Promise.all([
        api.getSettings(),
        parts.policy ? api.getPolicy() : undefined,
        parts.instructions ? api.getInstructions() : undefined,
      ]);
      setLoaded((cur) => ({
        info,
        policy: policy ?? cur!.policy,
        instructions: ins ?? cur!.instructions,
      }));
      if (policy) {
        const flat = flatPolicy(policy.value);
        const before = lastRead.current;
        lastRead.current = flat;
        setDraft((cur) => {
          const next: Draft = { ...cur };
          for (const g of GROUPS) {
            const kept = keep(g.id);
            for (const c of g.controls) {
              if (kept && c.key in cur && cur[c.key] !== draftOf(c, before[pkey(c)])) continue;
              next[c.key] = draftOf(c, flat[pkey(c)]);
            }
          }
          return next;
        });
        if (!keep("advanced")) {
          setPolicyText(json(policy.value));
          setAdvancedBase(policy.value);
        }
      }
      if (ins && !keep("instructions")) setInstructions(ins.value);
    },
    [api],
  );

  // load reads everything again, and drops every draft.
  const load = useCallback(async () => {
    try {
      await read({ policy: true, instructions: true }, "all");
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [read]);

  useEffect(() => {
    load();
  }, [load]);

  // save runs one part's write, then reads the settings' state and what the
  // write changed. A draft of a part it did not change stays.
  const save = async (part: Part, write: () => Promise<unknown>, changes: { policy: boolean; instructions: boolean }) => {
    if (busy) return;
    setBusy(part);
    setMessage(null);
    try {
      await write();
      setMessage({ part, text: "Saved.", ok: true });
      await read(changes, part);
    } catch (err) {
      const e = err as Error & { status?: number };
      const text =
        e.status === 412 ? "Changed elsewhere since this page read it. Read again, then make your change." : e.message;
      setMessage({ part, text, ok: false });
    } finally {
      setBusy(null);
    }
  };

  const note = (part: string) =>
    message?.part === part && (
      message.ok ? (
        <div className="nd-note ok">{message.text}</div>
      ) : (
        <Notice kind="error">
          {message.text}{" "}
          <Button kind="link" onClick={load}>
            Read again
          </Button>
        </Notice>
      )
    );

  const flatRead = loaded ? flatPolicy(loaded.policy.value) : {};
  // groupChange is what a group's drafts change from what was read: only
  // those keys. An entry that is not a value yet holds an error instead.
  const groupChange = (g: Group): { change: Record<string, unknown>; errors: Record<string, string> } => {
    const change: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    // A rule list is rebuilt from its Commands and Tools boxes into one list.
    for (const k of [...new Set(g.controls.filter((c) => c.of).map(pkey))]) {
      const cmd = g.controls.find((c) => pkey(c) === k && c.of === "cmd");
      const tool = g.controls.find((c) => pkey(c) === k && c.of === "tool");
      if (!cmd || !tool || !(cmd.key in draft) || !(tool.key in draft)) continue;
      const next = ruleChange(draft, cmd.key, tool.key, flatRead[k]);
      if (next !== undefined) change[k] = next;
    }
    for (const c of g.controls) {
      if (c.of) continue;
      // Untouched is no change, whatever was read (a key an older control
      // does not have reads as empty).
      if (!(c.key in draft) || draft[c.key] === draftOf(c, flatRead[c.key])) continue;
      const r = valueOf(c, draft[c.key]);
      if ("error" in r) {
        errors[c.key] = r.error;
        continue;
      }
      if (!same(r.v, flatRead[c.key])) change[c.key] = r.v;
    }
    return { change, errors };
  };

  const saveGroup = (g: Group) => {
    if (!loaded) return;
    const { change, errors } = groupChange(g);
    if (Object.keys(errors).length > 0 || Object.keys(change).length === 0) return;
    save(g.id, () => api.patchPolicy(nestPolicy(change), loaded.policy.etag), { policy: true, instructions: false });
  };

  const saveAdvanced = () => {
    if (!loaded) return;
    let p: Policy;
    try {
      p = JSON.parse(policyText);
    } catch {
      setMessage({ part: "advanced", text: "The policy is not valid JSON.", ok: false });
      return;
    }
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      setMessage({ part: "advanced", text: "The policy must be one JSON object.", ok: false });
      return;
    }
    const change = changeOf(advancedBase ?? loaded.policy.value, p);
    if (isEmpty(change)) {
      setMessage({ part: "advanced", text: "Nothing changed. A key left out keeps its value.", ok: true });
      setPolicyText(json(loaded.policy.value));
      setAdvancedBase(loaded.policy.value);
      return;
    }
    save("advanced", () => api.patchPolicy(change, loaded.policy.etag), { policy: true, instructions: false });
  };

  const info = loaded?.info.value;
  const ready = !!(loaded && info);

  // What each part holds that is not saved: its draft against what was read.
  const dirty: Partial<Record<Part, boolean>> = {};
  for (const g of GROUPS) {
    const { change, errors } = groupChange(g);
    dirty[g.id] = !!loaded && (Object.keys(change).length > 0 || Object.keys(errors).length > 0);
  }
  dirty.advanced = !!loaded && policyText !== json(advancedBase ?? loaded.policy.value);
  dirty.instructions = !!loaded && instructions !== loaded.instructions.value;
  // Each connect is done at once, so nothing waits to be saved.
  dirty.subscriptions = false;
  dirtyRef.current = dirty;

  // The left column: the parts, each saved on its own. Advanced is last.
  const parts: [Part, string, string][] = GROUPS.map((g) => [g.id, g.name, g.sub]);
  parts.push(["instructions", "Instructions", "What every turn is told"]);
  if (subscriptions) parts.push(["subscriptions", "Subscriptions", "Sign-ins and API keys every turn uses"]);
  parts.push(["advanced", "Advanced", "The whole policy, as JSON"]);
  const unsaved = parts.filter(([k]) => dirty[k]).map(([, n]) => n);

  // Leaving with changes not saved asks first: a move within the cockpit
  // through the page guard, a reload or a closed tab through the browser.
  const [asking, setAsking] = useState<(() => void) | null>(null);
  const anyDirty = unsaved.length > 0;
  // Asked while a save was landing, and nothing is unsaved now: nothing
  // would be lost, so the move goes on.
  useEffect(() => {
    if (anyDirty || !asking) return;
    setAsking(null);
    asking();
  }, [anyDirty, asking]);
  useEffect(() => {
    if (!anyDirty) return;
    setLeaveGuard((leave) => setAsking(() => leave));
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      setLeaveGuard(null);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [anyDirty]);

  const list = parts.map(([k, name, sub]) => (
    <button
      type="button"
      key={k}
      className={`prow pick${part === k ? " on" : ""}`}
      data-part={k}
      aria-current={part === k}
      onClick={() => setPart(k)}
    >
      <span className="pr-n">
        {name}
        {dirty[k] && <span className="pr-dirty">Unsaved</span>}
      </span>
      <span className="pr-m2">{sub}</span>
    </button>
  ));

  // Save is open only while the part on screen holds a change it can save.
  const saveBtn = (label: string, onClick: () => void, can = true) => (
    <span className="pg-save-at">
      {dirty[part] && <span className="pg-dirty">Unsaved changes</span>}
      <Button kind="primary" className="pg-save" disabled={!ready || !!busy || !dirty[part] || !can} onClick={onClick}>
        {busy === part ? "Saving…" : label}
      </Button>
    </span>
  );

  const head = (title: string, action?: React.ReactNode) => <ColHead title={title} action={action} />;
  const status = (
    <>
      {loadError && (
        <Notice kind="error">
          {loadError}{" "}
          <Button kind="link" onClick={load}>
            Read again
          </Button>
        </Notice>
      )}
      {!loaded && !loadError && <Loading />}
    </>
  );

  const set = (key: string, v: string | boolean) => setDraft((cur) => ({ ...cur, [key]: v }));

  // Use my config: the usual config paths found on the folder's machine,
  // added to the list as unsaved changes. What it last said, beside it.
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<{ ok: boolean; text: string; over?: string[] } | null>(null);
  const useMyConfig = async () => {
    if (!api.findConfig || finding) return;
    setFinding(true);
    setFound(null);
    try {
      const got = await api.findConfig();
      // The list as it is now: the person may have typed while it looked.
      const { text, added } = addFound(String(draftRef.current.home_files ?? ""), got.paths);
      if (added.length > 0) set("home_files", text);
      const from = got.from ? ` from ${got.from}` : "";
      const over = got.paths.filter((f) => f.over).map((f) => `${f.path} is too big to copy (over 10,000 files or 64 MiB).`);
      setFound({
        ok: true,
        text: added.length > 0 ? `Added ${plural(added.length, "path")}${from}. Save to keep them.` : `Nothing new found${from}.`,
        over,
      });
    } catch (err) {
      setFound({ ok: false, text: (err as Error).message });
    } finally {
      setFinding(false);
    }
  };

  // control is one setting: its name, the control, and its one plain line.
  const control = (c: Control, error?: string) => {
    const d = draft[c.key];
    let input: React.ReactNode;
    switch (c.kind.t) {
      case "switch":
      case "onoff": {
        input = <Switch name={c.key} label={d === true ? "On" : "Off"} on={d === true} onChange={(v) => set(c.key, v)} />;
        break;
      }
      case "seg":
        input = (
          <Seg
            label={c.name}
            value={String(d ?? "")}
            options={c.kind.options.map(([value, label]) => ({ value, label }))}
            onChange={(v) => set(c.key, v)}
          />
        );
        break;
      case "list":
        input = (
          <textarea
            name={c.key}
            rows={4}
            className={c.kind.mono ? "pg-mono" : undefined}
            value={String(d ?? "")}
            onChange={(e) => set(c.key, e.target.value)}
            placeholder={c.kind.placeholder}
            spellCheck={false}
            aria-label={c.name}
          />
        );
        break;
      case "number":
        input = (
          <input
            type="text"
            inputMode={c.kind.whole ? "numeric" : "decimal"}
            name={c.key}
            className="pg-num"
            value={String(d ?? "")}
            onChange={(e) => set(c.key, e.target.value)}
            aria-label={c.name}
          />
        );
        break;
    }
    const home = c.key === "home_files";
    return (
      <React.Fragment key={c.key}>
      {c.head && <div className="pg-ctl-h">{c.head}</div>}
      <div className="pg-ctl" data-key={c.key}>
        {home && api.findConfig && (
          <span className="pg-find">
            <Button kind="secondary" small className="pg-find-btn" disabled={finding} onClick={useMyConfig}>
              {finding ? LOADING : "Use my config"}
            </Button>
            {found &&
              (found.ok ? (
                <span className="nd-note" data-found>
                  {found.text}
                </span>
              ) : (
                <Notice kind="error" inline>
                  <span data-found>{found.text}</span>
                </Notice>
              ))}
            {found?.over?.map((t) => (
              <span className="pg-why" data-over key={t}>
                {t}
              </span>
            ))}
          </span>
        )}
        <span className="pg-ctl-n">{c.name}</span>
        <span className="pg-note">{c.line}</span>
        {c.more && <span className="nd-note">{c.more}</span>}
        {input}
        {home && (
          <span className="nd-note">Copied into each session&apos;s home at each turn. Sign-ins are never copied.</span>
        )}
        {error && (
          <Notice kind="error" inline>
            {error}
          </Notice>
        )}
      </div>
      </React.Fragment>
    );
  };

  let main: React.ReactNode;
  let side: React.ReactNode;
  const group = GROUPS.find((g) => g.id === part);
  if (group) {
    const { errors } = groupChange(group);
    const can = Object.keys(errors).length === 0;
    main = (
      <>
        {head(group.name, saveBtn(`Save ${group.name.toLowerCase()}`, () => saveGroup(group), can))}
        <div className="colbody pg-body">
          {status}
          {ready && (
            <>
              {note(group.id)}
              <fieldset className="pg-edit pg-ctls" disabled={!!busy}>
                {group.controls.map((c) => control(c, errors[c.key]))}
              </fieldset>
            </>
          )}
        </div>
      </>
    );
    side = (
      <>
        {head("How it applies")}
        <div className="colbody pg-body">
          {group.side.map((t, i) => (
            <p className="pg-note" key={i}>
              {t}
            </p>
          ))}
          <p className="f-note first">The next turn runs under what you save.</p>
        </div>
      </>
    );
  } else if (part === "subscriptions" && subscriptions) {
    main = (
      <>
        {head("Subscriptions")}
        <div className="colbody pg-body">
          <SubscriptionsPart api={subscriptions} />
        </div>
      </>
    );
    side = (
      <>
        {head("How it applies")}
        <div className="colbody pg-body">
          <p className="pg-note">Every turn uses the sign-ins and keys set here, on this machine and on your runners.</p>
          <p className="pg-note">
            {PRODUCT} adds them to each call. No runner or agent holds them. {KEPT.replace("It stays", "Each stays")}
          </p>
          <p className="pg-note">A tool&apos;s own sign-in on a machine is not used.</p>
          <p className="f-note first">A turn whose sign-in or key is missing is refused, and says so.</p>
        </div>
      </>
    );
  } else if (part === "advanced") {
    let keys: [string, string][] = [];
    if (loaded) keys = flatKeys(loaded.policy.value);
    main = (
      <>
        {head("Advanced", saveBtn("Save policy", saveAdvanced))}
        <div className="colbody pg-body">
          {status}
          {ready && (
            <>
              <div className="tab-sum">
                <b>The whole policy, as JSON</b>
                <span className="sep">·</span>only the keys you change are saved
              </div>
              {note("advanced")}
              <textarea
                name="policy"
                className="st-code pg-code"
                value={policyText}
                onChange={(e) => setPolicyText(e.target.value)}
                disabled={!!busy}
                spellCheck={false}
              />
            </>
          )}
        </div>
      </>
    );
    side = (
      <>
        {head("As saved")}
        <div className="colbody pg-body">
          {ready && (
            <>
              <p className="pg-note">The next turn runs under what you save. No restart.</p>
              <table className="grid pg-kv" aria-label="Saved policy">
                <tbody>
                  {keys.map(([k, v]) => (
                    <tr key={k}>
                      <td>
                        <code>{k}</code>
                      </td>
                      <td>
                        <code className="pg-val">{v}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </>
    );
  } else {
    const words = instructions.trim() ? instructions.trim().split(/\s+/).length : 0;
    main = (
      <>
        {head(
          "Instructions",
          saveBtn("Save instructions", () =>
            loaded &&
            save("instructions", () => api.putInstructions(instructions, loaded.instructions.etag), {
              policy: false,
              instructions: true,
            }),
          ),
        )}
        <div className="colbody pg-body">
          {status}
          {ready && (
            <>
              <div className="tab-sum">
                <b>{plural(words, "word")}</b>
                <span className="sep">·</span>every turn gets them
              </div>
              {note("instructions")}
              <textarea
                name="instructions"
                className="pg-text"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                disabled={!!busy}
              />
            </>
          )}
        </div>
      </>
    );
    side = (
      <>
        {head("How it applies")}
        <div className="colbody pg-body">
          <p className="pg-note">
            Every turn gets these words. <code>{"{session}"}</code> becomes the turn's session id.
          </p>
          <p className="f-note first">At most 64 KiB. The next turn gets what you save.</p>
        </div>
      </>
    );
  }

  const leaveAsk = asking && (
    <ConfirmDialog
      className="leave-ask"
      title="Unsaved changes"
      line={`Your changes to ${unsaved.join(" and ").replace(/ and (?=.* and )/g, ", ")} are not saved. Leave and lose them?`}
      action="Leave without saving"
      busyAction="Leaving…"
      onConfirm={async () => {
        const leave = asking;
        setLeaveGuard(null);
        leave();
      }}
      onClose={() => setAsking(null)}
    />
  );

  return (
    <>
    {leaveAsk}
    <PageFrame
      title="Settings"
      current="settings"
      subtitle={info?.changed ? `Last changed ${shortWhen(info.changed)}` : undefined}
      onBack={onBack}
      onApps={onApps}
      onRunners={onRunners}
      onSettings={onSettings}
      runnersOnline={runnersOnline}
      version={version}
      sourceLabel={sourceLabel}
      streamUp={streamUp}
      onDisconnect={onDisconnect}
      disconnectLabel={disconnectLabel}
      list={list}
      main={main}
      side={side}
    />
    </>
  );
};

// SETTINGS_CONTROLS are every control, for tests: each key of the policy a
// person may set has one.
export const SETTINGS_CONTROLS = [...new Set(CONTROLS.map(pkey))];

// flatKeys is the policy as rows: a nested key as its dotted path
// (limits.max_depth), each value as JSON, an empty list as "none".
function flatKeys(v: unknown, at = ""): [string, string][] {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => flatKeys(x, at ? `${at}.${k}` : k));
  }
  if (Array.isArray(v) && v.length === 0) return [[at, "none"]];
  return [[at, Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ") : typeof v === "string" ? v : JSON.stringify(v)]];
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

// SubscriptionsPart is one Connect step per subscription control can keep.
const SubscriptionsPart: React.FC<{ api: SubscriptionApi }> = ({ api }) => {
  const [list, setList] = useState<SubscriptionList | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Read again after a failed read.
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    setList(undefined);
    api.list().then(
      (l) => alive && setList(l),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [api, reads]);
  if (error)
    return (
      <Notice kind="error">
        {error}{" "}
        <Button kind="link" onClick={() => setReads((n) => n + 1)}>
          Read again
        </Button>
      </Notice>
    );
  if (list === undefined) return <Loading />;
  if (list === null) return <div className="nd-note">This service keeps no subscriptions.</div>;
  return (
    <div className="subs-list">
      {list.subscriptions.map((s) => (
        <ConnectStep key={s.harness} harness={s.harness} api={api} />
      ))}
      {/* OpenRouter has its own card; its api_keys entry is shown there, not
          again by the vendor-key loop below. */}
      <OpenRouterKey api={api} />
      {Object.keys(list.api_keys ?? {})
        .filter((name) => name !== 'openrouter')
        .sort()
        .map((name) => (
          <APIKey key={name} api={api} name={name} />
        ))}
    </div>
  );
};

// shortWhen is a date and time short enough for one line of the side column:
// "16 Nov, 15:47" in the reader's own locale and clock.
export function shortWhen(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time}`;
}
