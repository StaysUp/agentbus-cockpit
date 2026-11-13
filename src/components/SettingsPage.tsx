import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  changeOf,
  flatPolicy,
  isEmpty,
  lines,
  nestPolicy,
  Policy,
  SandboxOffer,
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

// The Settings page (/settings): control's settings, one global set for every machine.
// Every setting of the policy is a plain control, in groups (Agents, Files, Home files, Commands, Network, Sandbox,
// Limits); then the instructions every turn gets, the subscriptions, and the whole policy as JSON (Advanced). Each
// part saves on its own, with the version it read; a change made elsewhere in between is refused, and the page
// reads everything again.
//
// A save sends only the keys the person changed (PATCH), never a full copy with the defaults filled in: a copy
// would keep every default at today's value after a later build changes it.

interface SettingsPageProps {
  api: SettingsApi;
  onBack: () => void;
  // Whether this setup can honour the sandbox switch, from the machines'
  // own reports (sandboxOffer). Absent: the switch is offered as it is.
  sandbox?: SandboxOffer;
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
  key: string; // the policy key, dotted
  name: string;
  line: string; // one short plain line: what it does
  kind: Kind;
  more?: string; // a second line, only where it must be said
}

type GroupId = "agents" | "files" | "home" | "commands" | "network" | "sandbox" | "limits";
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
    id: "agents",
    name: "Agents",
    sub: "What agents may do through AgentBus",
    controls: [
      { key: "agent_api.tools", name: "AgentBus tools", kind: { t: "switch" },
        line: "Agents get AgentBus's own tools to ask other agents, review and read turns." },
      { key: "subagents", name: "Subagents", kind: { t: "switch" },
        line: "Agents may start their own hidden subagents. Off, they ask through AgentBus, where the work is recorded.",
        more: "agy cannot turn its own subagents off, so this does not apply to agy." },
      { key: "agent_api.apply", name: "Agents may apply", kind: { t: "switch" },
        line: "An agent may apply a turn's changes to your folder. You always may." },
    ],
    side: [
      "Agents may always read, list agents, start, review, stop and rename work within the request they belong to.",
      "The limits cap how much they ask for.",
    ],
  },
  {
    id: "files",
    name: "Files",
    sub: "Where turns read, edit and run",
    controls: [
      { key: "edit", name: "Edit", kind: { t: "seg", options: [["session", "Its own folder"], ["none", "Nowhere"]] },
        line: "Where a turn may change files without asking." },
      { key: "read_folders", name: "Read folders", kind: { t: "list", placeholder: "~/notes", mono: true },
        line: "Folders claude may read beyond its own, one per line." },
      { key: "isolation", name: "Isolation",
        kind: { t: "seg", options: [["auto", "Auto"], ["overlay", "Overlay"], ["copy", "Copy"], ["git", "Git worktree"], ["none", "Your folder"]] },
        line: "Where a new session's turns run. Auto makes the fastest copy this machine can." },
      { key: "share_read_only", name: "Shared folders", kind: { t: "list", placeholder: "node_modules", mono: true },
        line: "Not copied, read-only, such as node_modules. A turn cannot write there." },
    ],
    side: [
      "Your folder is not changed until a turn is applied, unless isolation is Your folder.",
      "Shared folders are one name each, at the top of the session's folder.",
    ],
  },
  {
    id: "home",
    name: "Home files",
    sub: "Files each conversation gets",
    controls: [
      { key: "home_files", name: "Home files", kind: { t: "list", placeholder: "~/.aws/config", mono: true },
        line: "Files from your home copied into each conversation's own home, such as ~/.aws/config." },
    ],
    side: ["Copied at the start of each turn, with the sandbox on or off.", "A file the conversation already has is never replaced."],
  },
  {
    id: "commands",
    name: "Commands",
    sub: "What agents may run",
    controls: [
      { key: "allow", name: "Allow", kind: { t: "list", placeholder: "go test", mono: true },
        line: "Commands claude may run without asking, one per line." },
      { key: "forbid", name: "Forbid", kind: { t: "list", placeholder: "git push", mono: true },
        line: "Commands claude and codex may never run, one per line." },
    ],
    side: ["Forbid reads the command text. It is not a sandbox: a command built at run time is not seen."],
  },
  {
    id: "network",
    name: "Network",
    sub: "What agents may reach",
    controls: [
      { key: "network.contain", name: "Contain", kind: { t: "onoff" },
        line: "Agents reach only their runner, control and the hosts below." },
      { key: "network.allow", name: "Allow hosts", kind: { t: "list", placeholder: "github.com", mono: true },
        line: "Hosts a contained agent may reach, one per line. *.example.com takes every name under it." },
    ],
    side: ["Linux only. On a Mac, contain refuses every turn unless the sandbox is on."],
  },
  {
    id: "sandbox",
    name: "Sandbox",
    sub: "A wall around each session",
    controls: [
      { key: "sandbox.mode", name: "Run each session in a sandbox", kind: { t: "onoff" },
        line: "Each session reads and writes only its own folder and its own home." },
    ],
    side: ["A machine that cannot build it refuses the turn."],
  },
  {
    id: "limits",
    name: "Limits",
    sub: "How much agents may ask for",
    controls: [
      { key: "limits.max_depth", name: "Max depth", kind: { t: "number", whole: true },
        line: "Levels of asking below your own turn." },
      { key: "limits.max_jobs_per_turn", name: "Jobs per turn", kind: { t: "number", whole: true },
        line: "Turns and reviews one turn may ask for." },
      { key: "limits.max_jobs_per_tree", name: "Jobs per tree", kind: { t: "number", whole: true },
        line: "Turns and reviews all the work from one of your turns may ask for." },
      { key: "limits.max_cost_usd_per_tree", name: "Cost per tree (USD)", kind: { t: "number", whole: false },
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

export const SettingsPage: React.FC<SettingsPageProps> = ({ api, onBack, sandbox, subscriptions, atSubscriptions }) => {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The drafts, reset from what was read.
  const [draft, setDraft] = useState<Draft>({});
  const [policyText, setPolicyText] = useState("");
  const [instructions, setInstructions] = useState("");
  // Which part is saving, and what the last save said.
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ part: string; text: string; ok: boolean } | null>(null);
  // The part on screen.
  const [part, setPart] = useState<Part>(atSubscriptions && subscriptions ? "subscriptions" : "agents");

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
        setDraft((cur) => {
          const next: Draft = { ...cur };
          for (const g of GROUPS) {
            if (keep(g.id)) continue;
            for (const c of g.controls) next[c.key] = draftOf(c, flat[c.key]);
          }
          return next;
        });
        if (!keep("advanced")) setPolicyText(json(policy.value));
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
      <div className={message.ok ? "nd-note ok" : "form-error"}>
        {message.text}
        {!message.ok && (
          <>
            {" "}
            <button type="button" className="link-btn" onClick={load}>
              Read again
            </button>
          </>
        )}
      </div>
    );

  const flatRead = loaded ? flatPolicy(loaded.policy.value) : {};
  // groupChange is what a group's drafts change from what was read: only
  // those keys. An entry that is not a value yet holds an error instead.
  const groupChange = (g: Group): { change: Record<string, unknown>; errors: Record<string, string> } => {
    const change: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    for (const c of g.controls) {
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
    const change = changeOf(loaded.policy.value, p);
    if (isEmpty(change)) {
      setMessage({ part: "advanced", text: "Nothing changed. A key left out keeps its value.", ok: true });
      setPolicyText(json(loaded.policy.value));
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
  dirty.advanced = !!loaded && policyText !== json(loaded.policy.value);
  dirty.instructions = !!loaded && instructions !== loaded.instructions.value;
  // Each connect is done at once, so nothing waits to be saved.
  dirty.subscriptions = false;
  dirtyRef.current = dirty;

  // The left column: the parts, each saved on its own. Advanced is last.
  const parts: [Part, string, string][] = GROUPS.map((g) => [g.id, g.name, g.sub]);
  parts.push(["instructions", "Instructions", "What every turn is told"]);
  if (subscriptions) parts.push(["subscriptions", "Subscriptions", "The sign-in every turn uses"]);
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
      <Button kind="quiet" className="pg-save" disabled={!ready || !!busy || !dirty[part] || !can} onClick={onClick}>
        {busy === part ? "Saving…" : label}
      </Button>
    </span>
  );

  const head = (title: string, action?: React.ReactNode) => <ColHead title={title} action={action} />;
  const status = (
    <>
      {loadError && (
        <div className="form-error">
          {loadError}{" "}
          <button type="button" className="link-btn" onClick={load}>
            Read again
          </button>
        </div>
      )}
      {!loaded && !loadError && <div className="nd-note">Reading…</div>}
    </>
  );

  const set = (key: string, v: string | boolean) => setDraft((cur) => ({ ...cur, [key]: v }));

  // control is one setting: its name, the control, and its one plain line.
  const control = (c: Control, error?: string) => {
    const d = draft[c.key];
    let input: React.ReactNode;
    switch (c.kind.t) {
      case "switch":
      case "onoff": {
        const isSandbox = c.key === "sandbox.mode";
        // The sandbox is offered only when an online machine can build it.
        // One that is on can always be turned off.
        const off = isSandbox && !!sandbox && !sandbox.can && d !== true;
        input = <Switch name={c.key} label={d === true ? "On" : "Off"} on={d === true} disabled={off} onChange={(v) => set(c.key, v)} />;
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
    return (
      <div className="pg-ctl" key={c.key} data-key={c.key}>
        <span className="pg-ctl-n">{c.name}</span>
        <span className="pg-note">{c.line}</span>
        {c.more && <span className="nd-note">{c.more}</span>}
        {input}
        {error && <span className="form-error">{error}</span>}
        {c.key === "sandbox.mode" && sandbox && !sandbox.can && (
          <p className="pg-why" data-sandbox-why>
            {d === true ? "On, but no machine can build it now, so its turns are refused. " : "Not offered. "}
            {sandbox.why}
          </p>
        )}
        {c.key === "sandbox.mode" && sandbox?.can && sandbox.machines && (
          <p className="nd-note">Online and able to build it: {sandbox.machines.join(", ")}.</p>
        )}
      </div>
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
          <p className="f-note first">The same on every machine. The next turn runs under what you save. Only what you change is saved.</p>
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
          <p className="pg-note">
            Every turn uses the subscription connected here, on this machine and on your runners. A tool&apos;s own
            sign-in on a machine is not used.
          </p>
          <p className="pg-note">
            OpenRouter agents use the OpenRouter key set here. Control adds it to each call; no runner or agent ever
            holds it, and it is never shown again.
          </p>
          <p className="f-note first">A turn whose tool is not connected is refused, and says so.</p>
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
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && setAsking(null)}>
      <div
        className="new-dialog leave-ask"
        role="alertdialog"
        aria-label="Unsaved changes"
        onKeyDown={(e) => e.key === "Escape" && setAsking(null)}
      >
        <div className="nd-title">Unsaved changes</div>
        <div className="nd-note">Your changes to {unsaved.join(" and ").replace(/ and (?=.* and )/g, ", ")} are not saved. Leave and lose them?</div>
        <div className="nd-actions">
          <Button kind="primary" className="leave-stay" onClick={() => setAsking(null)} autoFocus>
            Stay
          </Button>
          <Button
            kind="secondary"
            className="leave-go"
            onClick={() => {
              const leave = asking;
              setAsking(null);
              setLeaveGuard(null);
              leave();
            }}
          >
            Leave without saving
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <>
    {leaveAsk}
    <PageFrame
      title="Settings"
      onBack={onBack}
      list={list}
      foot={
        <>
          One set for every machine. Each part saves on its own.
          {info?.changed && <> Last changed {new Date(info.changed).toLocaleString()}.</>}
        </>
      }
      main={main}
      side={side}
    />
    </>
  );
};

// SETTINGS_CONTROLS are every control, for tests: each key of the policy a
// person may set has one.
export const SETTINGS_CONTROLS = CONTROLS.map((c) => c.key);

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
  useEffect(() => {
    let alive = true;
    api.list().then(
      (l) => alive && setList(l),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [api]);
  if (error) return <div className="form-error">{error}</div>;
  if (list === undefined) return <div className="nd-note">Reading…</div>;
  if (list === null) return <div className="nd-note">This service keeps no subscriptions.</div>;
  return (
    <>
      {list.subscriptions.map((s) => (
        <ConnectStep key={s.harness} harness={s.harness} api={api} />
      ))}
      <OpenRouterKey api={api} />
      {Object.keys(list.api_keys ?? {})
        .sort()
        .map((name) => (
          <APIKey key={name} api={api} name={name} />
        ))}
    </>
  );
};
