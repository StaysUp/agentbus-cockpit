import React, { useCallback, useEffect, useState } from "react";
import {
  Grants,
  grantsOf,
  lines,
  Policy,
  SettingsApi,
  SettingsInfo,
  Versioned,
  withGrants,
} from "../data/settings";
import { PageFrame } from "./PageFrame";

// The Settings page (/settings): control's settings, one global set for every machine.
// The grants (files a session gets, the sandbox, the network, and two
// actions), the whole policy as JSON, and the instructions every turn gets,
// with when the settings last changed. Each part saves on its
// own, with the version it read; a change made elsewhere in between is
// refused, and the page reads everything again.

interface SettingsPageProps {
  api: SettingsApi;
  onBack: () => void;
}

interface Loaded {
  info: Versioned<SettingsInfo>;
  policy: Versioned<Policy>;
  instructions: Versioned<string>;
}

const json = (p: Policy) => JSON.stringify(p, null, 2);

export const SettingsPage: React.FC<SettingsPageProps> = ({ api, onBack }) => {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The drafts, reset from what was read.
  const [grants, setGrants] = useState<Grants | null>(null);
  const [readText, setReadText] = useState("");
  const [hostsText, setHostsText] = useState("");
  const [policyText, setPolicyText] = useState("");
  const [instructions, setInstructions] = useState("");
  // Which part is saving, and what the last save said.
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ part: string; text: string; ok: boolean } | null>(null);

  // read reads the settings' state, and the parts named: each part read
  // resets its own drafts, and leaves the other part's as they are.
  const read = useCallback(
    async (parts: { policy: boolean; instructions: boolean }) => {
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
        const g = grantsOf(policy.value);
        setGrants(g);
        setReadText(g.read.join("\n"));
        setHostsText(g.hosts.join("\n"));
        setPolicyText(json(policy.value));
      }
      if (ins) setInstructions(ins.value);
    },
    [api],
  );

  // load reads everything again.
  const load = useCallback(async () => {
    try {
      await read({ policy: true, instructions: true });
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
    part: string,
    write: () => Promise<unknown>,
    changes: { policy: boolean; instructions: boolean },
  ) => {
    if (busy) return;
    setBusy(part);
    setMessage(null);
    try {
      await write();
      setMessage({ part, text: "Saved.", ok: true });
      await read(changes);
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
            <button type="button" className="use-recorded" onClick={load}>
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
          read: lines(readText),
          hosts: lines(hostsText),
        }),
        loaded.policy.etag,
      ),
      { policy: true, instructions: false },
    );

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

  return (
    <PageFrame title="Settings" onBack={onBack}>
      <div className="new-dialog settings-dialog settings-page">
        {loadError && (
          <div className="form-error">
            {loadError}{" "}
            <button type="button" className="use-recorded" onClick={load}>
              Read again
            </button>
          </div>
        )}
        {!loaded && !loadError && <div className="nd-note">Reading…</div>}
        {loaded && grants && info && (
          <fieldset className="ad-set" disabled={!!busy}>
            {info.changed && (
              <div className="nd-note">Last changed {new Date(info.changed).toLocaleString()}.</div>
            )}

            <section className="st-part" aria-label="Grants">
              <div className="st-head">Grants</div>
              <div className="nd-note">The same on every machine.</div>
              <label>
                <span>Files a session gets in its home</span>
                <textarea
                  name="read"
                  rows={3}
                  value={readText}
                  onChange={(e) => setReadText(e.target.value)}
                  placeholder="~/.aws/config"
                  spellCheck={false}
                />
                <span className="nd-note">One per line, each starting with ~/. Used when the sandbox is on.</span>
              </label>
              <label>
                <span>Sandbox</span>
                <Seg
                  name="Sandbox"
                  value={grants.sandbox}
                  options={[
                    ["off", "Off"],
                    ["on", "On"],
                  ]}
                  onChange={(v) => setGrants({ ...grants, sandbox: v as Grants["sandbox"] })}
                />
              </label>
              <label>
                <span>Network</span>
                <Seg
                  name="Network"
                  value={grants.network}
                  options={[
                    ["off", "Off"],
                    ["list", "A list"],
                    ["on", "On"],
                  ]}
                  onChange={(v) => setGrants({ ...grants, network: v as Grants["network"] })}
                />
                <span className="nd-note">
                  {grants.network === "off" && "Agents reach only their runner and control."}
                  {grants.network === "list" && "Agents reach their runner, control and these hosts. An empty list is off."}
                  {grants.network === "on" && "Agents reach any host."}
                </span>
              </label>
              {grants.network === "list" && (
                <label>
                  <span>Hosts</span>
                  <textarea
                    name="hosts"
                    rows={3}
                    value={hostsText}
                    onChange={(e) => setHostsText(e.target.value)}
                    placeholder="github.com"
                    spellCheck={false}
                  />
                  <span className="nd-note">One per line. *.example.com takes every name under it.</span>
                </label>
              )}
              <label className="st-check">
                <input
                  type="checkbox"
                  name="agents_apply"
                  checked={grants.agentsApply}
                  onChange={(e) => setGrants({ ...grants, agentsApply: e.target.checked })}
                />
                <span>Agents may apply changes to your folder</span>
              </label>
              <label className="st-check">
                <input
                  type="checkbox"
                  name="commands"
                  checked={grants.commands}
                  onChange={(e) => setGrants({ ...grants, commands: e.target.checked })}
                />
                <span>! commands run</span>
              </label>
              <div className="nd-actions">
                <button type="button" className="connect-go" onClick={saveGrants}>
                  Save grants
                </button>
              </div>
              {note("grants")}
            </section>

            <section className="st-part" aria-label="Policy">
              <div className="st-head">Policy</div>
              <div className="nd-note">All of it, as JSON. A key left out takes its default.</div>
              <textarea
                name="policy"
                className="st-code"
                rows={12}
                value={policyText}
                onChange={(e) => setPolicyText(e.target.value)}
                spellCheck={false}
              />
              <div className="nd-actions">
                <button type="button" className="connect-go" onClick={savePolicy}>
                  Save policy
                </button>
              </div>
              {note("policy")}
            </section>

            <section className="st-part" aria-label="Instructions">
              <div className="st-head">Instructions</div>
              <div className="nd-note">Every turn gets them. {"{session}"} becomes the turn's session id.</div>
              <textarea
                name="instructions"
                rows={6}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
              <div className="nd-actions">
                <button
                  type="button"
                  className="connect-go"
                  onClick={() =>
                    save("instructions", () => api.putInstructions(instructions, loaded.instructions.etag), {
                      policy: false,
                      instructions: true,
                    })
                  }
                >
                  Save instructions
                </button>
              </div>
              {note("instructions")}
            </section>
          </fieldset>
        )}
      </div>
    </PageFrame>
  );
};

const Seg: React.FC<{
  name: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}> = ({ name, value, options, onChange }) => (
  <span className="nd-seg" role="radiogroup" aria-label={name}>
    {options.map(([v, label]) => (
      <button
        type="button"
        role="radio"
        key={v}
        aria-checked={value === v}
        className={value === v ? "on" : ""}
        onClick={() => onChange(v)}
      >
        {label}
      </button>
    ))}
  </span>
);
