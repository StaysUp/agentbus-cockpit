import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Grants,
  grantsOf,
  homeFilesOf,
  lines,
  Policy,
  SandboxOffer,
  SettingsApi,
  SettingsInfo,
  Versioned,
  withGrants,
  withHomeFiles,
} from "../data/settings";
import { ColHead, PageFrame } from "./PageFrame";
import { Button, Seg, Switch } from "./Controls";
import { setLeaveGuard } from "../page";
import { ConnectStep, SubscriptionApi } from "./ConnectStep";
import { OpenRouterKey } from "./OpenRouterKey";
import { SubscriptionList } from "../types";

// The Settings page (/settings): control's settings, one global set for every machine.
// The grants (the sandbox, the network, and one action), the files from
// the person's home each conversation gets, the whole policy as JSON, and the instructions every turn gets,
// with when the settings last changed. Each part saves on its
// own, with the version it read; a change made elsewhere in between is
// refused, and the page reads everything again.

interface SettingsPageProps {
  api: SettingsApi;
  onBack: () => void;
  // Whether this setup can honour the sandbox switch, from the machines'
  // own reports (sandboxOffer). Absent: the switch is offered as it is.
  sandbox?: SandboxOffer;
  // The subscriptions control keeps, which every turn uses. Absent: a
  // service that keeps none, and no Subscriptions part.
  subscriptions?: SubscriptionApi;
  // Open on Subscriptions rather than Grants: an agent's sign-in dot
  // brings the person here to connect.
  atSubscriptions?: boolean;
}

interface Loaded {
  info: Versioned<SettingsInfo>;
  policy: Versioned<Policy>;
  instructions: Versioned<string>;
}

const json = (p: Policy) => JSON.stringify(p, null, 2);

export const SettingsPage: React.FC<SettingsPageProps> = ({ api, onBack, sandbox, subscriptions, atSubscriptions }) => {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The drafts, reset from what was read.
  const [grants, setGrants] = useState<Grants | null>(null);
  const [homeText, setHomeText] = useState("");
  const [hostsText, setHostsText] = useState("");
  const [policyText, setPolicyText] = useState("");
  const [instructions, setInstructions] = useState("");
  // Which part is saving, and what the last save said.
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ part: string; text: string; ok: boolean } | null>(null);
  // The part on screen, and the grant picked in it.
  const [part, setPart] = useState<Part>(atSubscriptions && subscriptions ? "subscriptions" : "grants");
  const [grant, setGrant] = useState<GrantKey>("sandbox");

  // read reads the settings' state, and the parts named: each part read
  // resets its own drafts, and leaves the other part's as they are.
  // Which parts hold changes not saved, as of the last render: a read
  // after one part's save leaves another part's unsaved draft as it is.
  const dirtyRef = useRef<Record<Part, boolean>>({ grants: false, home: false, policy: false, instructions: false, subscriptions: false });
  const read = useCallback(
    async (parts: { policy: boolean; instructions: boolean }, saved?: Part | "all") => {
      const keep = (p: Part) => saved !== "all" && p !== saved && dirtyRef.current[p];
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
        if (!keep("grants")) {
          const g = grantsOf(policy.value);
          setGrants(g);
          setHostsText(g.hosts.join("\n"));
        }
        if (!keep("home")) setHomeText(homeFilesOf(policy.value).join("\n"));
        if (!keep("policy")) setPolicyText(json(policy.value));
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
  const save = async (
    part: Part,
    write: () => Promise<unknown>,
    changes: { policy: boolean; instructions: boolean },
  ) => {
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
        e.status === 412
          ? "Changed elsewhere since this page read it. Read again, then make your change."
          : e.message;
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

  const saveGrants = () =>
    loaded &&
    grants &&
    save("grants", () =>
      api.putPolicy(
        withGrants(loaded.policy.value, {
          ...grants,
          hosts: lines(hostsText),
        }),
        loaded.policy.etag,
      ),
      { policy: true, instructions: false },
    );

  const saveHomeFiles = () =>
    loaded &&
    save("home", () => api.putPolicy(withHomeFiles(loaded.policy.value, lines(homeText)), loaded.policy.etag), {
      policy: true,
      instructions: false,
    });

  const savePolicy = () => {
    if (!loaded) return;
    let p: Policy;
    try {
      p = JSON.parse(policyText);
    } catch {
      setMessage({ part: "policy", text: "The policy is not valid JSON.", ok: false });
      return;
    }
    save("policy", () => api.putPolicy(p, loaded.policy.etag), { policy: true, instructions: false });
  };

  const info = loaded?.info.value;
  const ready = !!(loaded && grants && info);

  // What each part holds that is not saved: its draft against what was read.
  const grantsDraft = grants && { ...grants, hosts: lines(hostsText) };
  const dirty: Record<Part, boolean> = {
    grants:
      !!loaded &&
      !!grantsDraft &&
      JSON.stringify(withGrants(loaded.policy.value, grantsDraft)) !==
        JSON.stringify(withGrants(loaded.policy.value, grantsOf(loaded.policy.value))),
    home: !!loaded && JSON.stringify(lines(homeText)) !== JSON.stringify(homeFilesOf(loaded.policy.value)),
    policy: !!loaded && policyText !== json(loaded.policy.value),
    instructions: !!loaded && instructions !== loaded.instructions.value,
    // Each connect is done at once, so nothing waits to be saved.
    subscriptions: false,
  };
  dirtyRef.current = dirty;
  const unsaved = PART_NAMES.filter(([k]) => dirty[k]).map(([, n]) => n);

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

  // The left column: the three parts, each saved on its own.
  const parts: [Part, string, string][] = [
    ["grants", "Grants", "Sandbox, network and one action"],
    ["home", "Home files", "Files each conversation gets"],
    ["policy", "Policy", "All of it, as JSON"],
    ["instructions", "Instructions", "What every turn is told"],
  ];
  if (subscriptions) parts.push(["subscriptions", "Subscriptions", "The sign-in every turn uses"]);
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
        {k === "grants" && <span className="pl-n">{GRANTS.length}</span>}
        {dirty[k] && <span className="pr-dirty">Unsaved</span>}
      </span>
      <span className="pr-m2">{sub}</span>
    </button>
  ));

  // Save is open only while the part on screen holds a change.
  const saveBtn = (label: string, onClick: () => void) => (
    <span className="pg-save-at">
      {dirty[part] && <span className="pg-dirty">Unsaved changes</span>}
      <Button kind="quiet" className="pg-save" disabled={!ready || !!busy || !dirty[part]} onClick={onClick}>
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

  let main: React.ReactNode;
  let side: React.ReactNode;
  if (part === "subscriptions" && subscriptions) {
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
  } else if (part === "grants") {
    const g = grants;
    const sel = GRANTS.find((x) => x[0] === grant) ?? GRANTS[0];
    main = (
      <>
        {head("Grants", saveBtn("Save grants", saveGrants))}
        <div className="colbody pg-body">
          {status}
          {ready && g && (
            <>
              <div className="tab-sum">
                <b>{GRANTS.length} grants</b>
                <span className="sep">·</span>the same on every machine
                <span className="sep">·</span>pick one to change it
              </div>
              {note("grants")}
              <table className="grid pg-t" aria-label="Grants">
                <thead>
                  <tr>
                    <th />
                    <th>Grant</th>
                    <th>Now</th>
                    <th>Policy key</th>
                  </tr>
                </thead>
                <tbody>
                  {GRANTS.map(([k, name, key]) => (
                    <tr
                      key={k}
                      data-grant={k}
                      className={k === sel[0] ? "sel" : ""}
                      aria-selected={k === sel[0]}
                      onClick={() => setGrant(k)}
                    >
                      <td className="c">›</td>
                      <td>{name}</td>
                      <td className="nw">{grantValue(k, g, hostsText)}</td>
                      <td className="nw">
                        <code>{key}</code>
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
    side = (
      <>
        {head(sel[1])}
        <div className="colbody pg-body">
          {ready && g && (
            <fieldset className="pg-edit" disabled={!!busy}>
              {sel[0] === "sandbox" && (
                <>
                  <p className="pg-note">On, each session runs in a sandbox with its own home.</p>
                  {/* Offered only when an online machine can build it. One
                      that is on can always be turned off. */}
                  <Switch
                    name="sandbox"
                    label="Run each session in a sandbox"
                    on={g.sandbox === "on"}
                    disabled={!!sandbox && !sandbox.can && g.sandbox !== "on"}
                    onChange={(v) => setGrants({ ...g, sandbox: v ? "on" : "off" })}
                  />
                  {sandbox && !sandbox.can && (
                    <p className="pg-why" data-sandbox-why>
                      {g.sandbox === "on" ? "On, but no machine can build it now, so its turns are refused. " : "Not offered. "}
                      {sandbox.why}
                    </p>
                  )}
                  {sandbox?.can && sandbox.machines && (
                    <p className="nd-note">Online and able to build it: {sandbox.machines.join(", ")}.</p>
                  )}
                </>
              )}
              {sel[0] === "network" && (
                <>
                  <div className="pg-field">
                    <span className="pg-note">
                      {g.network === "off" && "Agents reach only their runner and control."}
                      {g.network === "list" && "Agents reach their runner, control and these hosts. An empty list is off."}
                      {g.network === "on" && "Agents reach any host."}
                    </span>
                    <Seg
                      label="Network"
                      value={g.network}
                      options={[
                        { value: "off", label: "Off" },
                        { value: "list", label: "A list" },
                        { value: "on", label: "On" },
                      ]}
                      onChange={(v) => setGrants({ ...g, network: v as Grants["network"] })}
                    />
                  </div>
                  {g.network === "list" && (
                    <label>
                      <span className="sub-h">Hosts</span>
                      <textarea
                        name="hosts"
                        rows={5}
                        value={hostsText}
                        onChange={(e) => setHostsText(e.target.value)}
                        placeholder="github.com"
                        spellCheck={false}
                      />
                      <span className="nd-note">One per line. *.example.com takes every name under it.</span>
                    </label>
                  )}
                </>
              )}
              {sel[0] === "apply" && (
                <>
                  <p className="pg-note">May a turn's own token apply its changes to your folder. Your own token always may.</p>
                  <Switch
                    name="agents_apply"
                    label="Agents may apply changes to your folder"
                    on={g.agentsApply}
                    onChange={(v) => setGrants({ ...g, agentsApply: v })}
                  />
                </>
              )}
              <p className="f-note">A change here is kept on this page until you save the grants.</p>
            </fieldset>
          )}
        </div>
      </>
    );
  } else if (part === "home") {
    const n = lines(homeText).length;
    main = (
      <>
        {head("Home files", saveBtn("Save home files", saveHomeFiles))}
        <div className="colbody pg-body">
          {status}
          {ready && (
            <>
              <div className="tab-sum">
                <b>{plural(n, "file")}</b>
                <span className="sep">·</span>the same on every machine
              </div>
              {note("home")}
              <fieldset className="pg-edit" disabled={!!busy}>
                <label>
                  <span className="pg-note">{HOME_FILES_LINE}</span>
                  <textarea
                    name="home_files"
                    rows={5}
                    value={homeText}
                    onChange={(e) => setHomeText(e.target.value)}
                    placeholder="~/.aws/config"
                    spellCheck={false}
                  />
                  <span className="nd-note">One per line, each starting with ~/.</span>
                </label>
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
          <p className="pg-note">Copied at the start of each turn, with the sandbox on or off.</p>
          <p className="f-note first">
            A file the conversation already has is never replaced. Policy key <code>home_files</code>.
          </p>
        </div>
      </>
    );
  } else if (part === "policy") {
    let keys: [string, string][] = [];
    if (loaded) keys = flatKeys(loaded.policy.value);
    main = (
      <>
        {head("Policy", saveBtn("Save policy", savePolicy))}
        <div className="colbody pg-body">
          {status}
          {ready && (
            <>
              <div className="tab-sum">
                <b>{plural(loaded ? Object.keys(loaded.policy.value).length : 0, "key")}</b>
                <span className="sep">·</span>all of it, as JSON
                <span className="sep">·</span>a key left out takes its default
              </div>
              {note("policy")}
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

type Part = "grants" | "home" | "policy" | "instructions" | "subscriptions";
const PART_NAMES: [Part, string][] = [
  ["grants", "Grants"],
  ["home", "Home files"],
  ["policy", "Policy"],
  ["instructions", "Instructions"],
];
type GrantKey = "sandbox" | "network" | "apply";

// The one plain line that says what Home files are.
const HOME_FILES_LINE = "Files from your home copied into each conversation's own home, such as ~/.aws/config.";

// The grants as rows: the key, its name, and the policy key it writes.
const GRANTS: [GrantKey, string, string][] = [
  ["sandbox", "Sandbox", "sandbox.mode"],
  ["network", "Network", "network"],
  ["apply", "Agents may apply changes", "agent_api.apply"],
];

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

// grantValue is a grant as the draft holds it now, in a few words.
function grantValue(k: GrantKey, g: Grants, hostsText: string): React.ReactNode {
  switch (k) {
    case "sandbox":
      return g.sandbox === "on" ? "On" : "Off";
    case "network":
      return g.network === "list" ? `A list · ${plural(lines(hostsText).length, "host")}` : g.network === "on" ? "On" : "Off";
    case "apply":
      return g.agentsApply ? "On" : "Off";
  }
}

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
    </>
  );
};
