import React, { useEffect, useState } from "react";
import { AccessOption, AgentFields, Harness, SavedAgent } from "../types";

// The saved agents (GET /api/v0/agents) with edit and remove, and the
// "+ Agent" form: Harness, then Access (only what that harness offers), then
// Model (what that harness and access offer; any id for OpenRouter), then
// Name (filled from harness and model until the person types one), then the
// extras, shown and disabled. An agent says nothing about where it runs.

interface AgentsDialogProps {
  loadAgents: () => Promise<SavedAgent[]>;
  loadHarnesses: () => Promise<Harness[]>;
  createAgent: (f: AgentFields) => Promise<SavedAgent>;
  updateAgent: (id: string, f: AgentFields) => Promise<SavedAgent>;
  removeAgent: (id: string) => Promise<void>;
  onClose: () => void;
  // Open with the form for a new agent.
  startNew?: boolean;
  // Called after any change, so other screens can list the agents again.
  onChanged?: () => void;
}

// What a harness, an access and a model are called on screen.
export const accessText = (a: { access: string; key_env?: string }): string =>
  a.access === "subscription"
    ? "subscription"
    : a.access === "openrouter"
      ? `OpenRouter · ${a.key_env ?? "OPENROUTER_API_KEY"}`
      : a.access;

export function agentLine(a: SavedAgent, harnesses?: Harness[]): string {
  const h = harnesses?.find((x) => x.name === a.harness);
  return `${h?.label ?? a.harness} · ${a.model || "default model"} · ${accessText(a)}`;
}

interface FormState {
  harness: string;
  access: string;
  model: string;
  keyEnv: string;
  name: string;
  // The person typed a name: it no longer follows harness and model.
  named: boolean;
}

const usable = (h: Harness) =>
  !h.disabled && (h.access ?? []).some((x) => !x.disabled);
const accessesOf = (h?: Harness): AccessOption[] => h?.access ?? [];
const firstAccess = (h?: Harness) => accessesOf(h).find((x) => !x.disabled);

function autoName(f: FormState, harnesses: Harness[]): string {
  const label = harnesses.find((h) => h.name === f.harness)?.label ?? f.harness;
  return f.model ? `${label} · ${f.model}` : label;
}

function freshForm(harnesses: Harness[]): FormState {
  const h = harnesses.find(usable);
  const acc = firstAccess(h);
  const f: FormState = {
    harness: h?.name ?? "",
    access: acc?.kind ?? "",
    model: acc?.models[0] ?? "",
    keyEnv: acc?.key_env ?? "",
    name: "",
    named: false,
  };
  f.name = autoName(f, harnesses);
  return f;
}

function formOf(a: SavedAgent): FormState {
  return {
    harness: a.harness,
    access: a.access,
    model: a.model ?? "",
    keyEnv: a.key_env ?? "",
    name: a.name,
    named: true,
  };
}

const Off: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <label className="f-off">
    <span>{label}</span>
    <select disabled>
      <option>{value}</option>
    </select>
    <span className="nd-note">Not available yet.</span>
  </label>
);

export const AgentsDialog: React.FC<AgentsDialogProps> = ({
  loadAgents,
  loadHarnesses,
  createAgent,
  updateAgent,
  removeAgent,
  onClose,
  startNew,
  onChanged,
}) => {
  const [agents, setAgents] = useState<SavedAgent[] | null>(null);
  const [harnesses, setHarnesses] = useState<Harness[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The form: null when closed; editing names the agent being edited.
  const [form, setForm] = useState<FormState | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [wantNew, setWantNew] = useState(!!startNew);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = () =>
    loadAgents().then(
      (list) => setAgents(list),
      (err: Error) => setLoadError(err.message),
    );
  useEffect(() => {
    let active = true;
    Promise.all([loadAgents(), loadHarnesses()]).then(
      ([list, hs]) => {
        if (!active) return;
        setAgents(list);
        setHarnesses(hs);
      },
      (err: Error) => active && setLoadError(err.message),
    );
    return () => {
      active = false;
    };
  }, [loadAgents, loadHarnesses]);
  useEffect(() => {
    if (wantNew && harnesses) {
      setForm(freshForm(harnesses));
      setEditing(null);
      setWantNew(false);
    }
  }, [wantNew, harnesses]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While a save or a remove is in flight nothing closes: its answer
      // would land on whatever came next.
      if (e.key !== "Escape" || busy) return;
      if (form) {
        setForm(null);
        setError(null);
      } else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [form, onClose, busy]);

  const hs = harnesses ?? [];
  const harness = form ? hs.find((h) => h.name === form.harness) : undefined;
  const access = form
    ? accessesOf(harness).find((x) => x.kind === form.access)
    : undefined;

  // Each change keeps the form valid: an access the harness lacks moves to
  // its first, a model the access lacks moves to its first, and the name
  // follows until the person types one.
  const update = (patch: Partial<FormState>) =>
    setForm((cur) => {
      if (!cur) return cur;
      const f = { ...cur, ...patch };
      const h = hs.find((x) => x.name === f.harness);
      let acc = accessesOf(h).find((x) => x.kind === f.access && !x.disabled);
      if (!acc) {
        acc = firstAccess(h);
        f.access = acc?.kind ?? "";
      }
      if ("harness" in patch || "access" in patch) {
        // A model typed for OpenRouter stays when only the harness changes.
        const keep =
          acc?.any_model && cur.access === f.access && f.model !== "";
        if (acc && !keep && !acc.models.includes(f.model))
          f.model = acc.models[0] ?? "";
        if (acc?.kind === "openrouter" && !f.keyEnv)
          f.keyEnv = acc.key_env ?? "";
      }
      if (!f.named) f.name = autoName(f, hs);
      return f;
    });

  const fields = (f: FormState): AgentFields => {
    const out: AgentFields = {
      name: f.name.trim(),
      harness: f.harness,
      access: f.access,
    };
    if (f.model.trim()) out.model = f.model.trim();
    if (f.access === "openrouter" && f.keyEnv.trim())
      out.key_env = f.keyEnv.trim();
    return out;
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || busy) return;
    if (!form.name.trim()) {
      setError("Give the agent a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editing) await updateAgent(editing, fields(form));
      else await createAgent(fields(form));
      setForm(null);
      setEditing(null);
      await reload();
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await removeAgent(id);
      setConfirming(null);
      await reload();
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openRouter = form?.access === "openrouter";
  const keyKnown =
    openRouter && access?.key_env === form?.keyEnv.trim()
      ? access?.key_set
      : undefined;

  return (
    <div
      className="modal-back"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        className="new-dialog agents-dialog"
        role="dialog"
        aria-label="Agents"
      >
        <div className="nd-title">Agents</div>
        {loadError && <div className="form-error">{loadError}</div>}
        {!agents && !loadError && <div className="nd-note">Looking…</div>}
        {agents && !form && (
          // While a remove is in flight every control waits for it.
          <fieldset className="ad-set" disabled={busy}>
            <ul className="ad-list">
              {agents.length === 0 && <li className="dim">No agents yet.</li>}
              {agents.map((a) => (
                <li key={a.id} data-agent={a.id}>
                  <span className="ad-t">
                    <b>{a.name}</b>
                    <span>
                      {agentLine(a, hs)}
                      {a.access === "openrouter" && a.key_set === false && (
                        <>
                          {" "}
                          · <span className="warn">key not set</span>
                        </>
                      )}
                    </span>
                  </span>
                  {confirming === a.id ? (
                    <span className="ad-act">
                      <span>Remove?</span>
                      <button
                        type="button"
                        className="ad-yes"
                        disabled={busy}
                        onClick={() => remove(a.id)}
                      >
                        Remove
                      </button>
                      <button type="button" onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <span className="ad-act">
                      <button
                        type="button"
                        className="ad-edit"
                        disabled={!harnesses}
                        onClick={() => {
                          setForm(formOf(a));
                          setEditing(a.id);
                          setError(null);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="ad-remove"
                        onClick={() => setConfirming(a.id)}
                      >
                        Remove
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {error && <div className="form-error">{error}</div>}
            <div className="nd-actions">
              <button
                type="button"
                className="connect-go ad-new"
                disabled={!harnesses}
                onClick={() => {
                  setForm(freshForm(hs));
                  setEditing(null);
                  setError(null);
                }}
              >
                + Agent
              </button>
              <button type="button" className="use-recorded" onClick={onClose}>
                Close
              </button>
            </div>
          </fieldset>
        )}
        {form && (
          <form className="agent-form" onSubmit={save}>
            {/* While a save is in flight nothing in the form changes: the
                answer closes the form with what was sent. */}
            <fieldset className="ad-set" disabled={busy}>
              <label>
                <span>Harness</span>
                <span className="nd-seg" role="radiogroup" aria-label="Harness">
                  {hs.map((h) => (
                    <button
                      type="button"
                      role="radio"
                      key={h.name}
                      data-harness={h.name}
                      aria-checked={form.harness === h.name}
                      className={form.harness === h.name ? "on" : ""}
                      disabled={!usable(h)}
                      title={
                        h.disabled
                          ? "Not available yet"
                          : !h.found
                            ? "Not installed where the service runs"
                            : undefined
                      }
                      onClick={() => update({ harness: h.name })}
                    >
                      {h.label ?? h.name}
                    </button>
                  ))}
                </span>
                <span className="nd-note">
                  It decides the loop, the tools and how the agent reaches a
                  model.
                  {harness &&
                    !harness.found &&
                    " It is not installed where the service runs."}
                </span>
              </label>
              <label>
                <span>Access</span>
                <span className="nd-seg" role="radiogroup" aria-label="Access">
                  {accessesOf(harness).map((x) => (
                    <button
                      type="button"
                      role="radio"
                      key={x.kind}
                      data-access={x.kind}
                      aria-checked={form.access === x.kind}
                      className={form.access === x.kind ? "on" : ""}
                      disabled={!!x.disabled}
                      title={x.disabled ? "Not available yet" : undefined}
                      onClick={() => update({ access: x.kind })}
                    >
                      {x.label}
                    </button>
                  ))}
                </span>
                <span className="nd-note">
                  {openRouter
                    ? "The key is read from an environment variable where the turn runs. Its value is never shown or stored."
                    : `Uses the ${access?.label ?? "harness sign-in"}.`}
                </span>
              </label>
              <label>
                <span>Model</span>
                {access?.any_model ? (
                  <>
                    <input
                      name="model"
                      type="text"
                      list="ad-models"
                      value={form.model}
                      onChange={(e) => update({ model: e.target.value })}
                      placeholder="an OpenRouter model id"
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <datalist id="ad-models">
                      {access.models.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </>
                ) : (
                  <select
                    name="model"
                    value={form.model}
                    onChange={(e) => update({ model: e.target.value })}
                  >
                    {(access?.models ?? []).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    {form.model &&
                      !(access?.models ?? []).includes(form.model) && (
                        <option value={form.model}>{form.model}</option>
                      )}
                    <option value="">Harness default</option>
                  </select>
                )}
                <span className="nd-note">
                  Only what {harness?.label ?? form.harness} offers for this
                  access
                  {access?.any_model ? ", or any OpenRouter model id" : ""}.
                </span>
              </label>
              {openRouter && (
                <label>
                  <span>Key variable</span>
                  <input
                    name="key_env"
                    type="text"
                    value={form.keyEnv}
                    onChange={(e) => update({ keyEnv: e.target.value })}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <span className="nd-note">
                    {keyKnown === true && (
                      <span className="ok">Set where the service runs.</span>
                    )}
                    {keyKnown === false && (
                      <span className="warn">
                        Not set where the service runs.
                      </span>
                    )}
                    {keyKnown === undefined &&
                      "The name of the variable, never the key."}
                  </span>
                </label>
              )}
              <label>
                <span>Name</span>
                <input
                  name="name"
                  type="text"
                  value={form.name}
                  onChange={(e) =>
                    update({ name: e.target.value, named: true })
                  }
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <Off label="Models this agent can use" value="None" />
              <Off label="MCP servers" value="Harness default" />
              <Off label="Skills" value="Harness default" />
              <Off label="Instruction files" value="Harness default" />
              <Off label="Programs that run on it" value="None" />
              {error && <div className="form-error">{error}</div>}
              <div className="nd-actions">
                <button
                  type="submit"
                  className="connect-go"
                  disabled={busy || !form.harness || !form.access}
                >
                  {editing ? "Save" : "Create agent"}
                </button>
                <button
                  type="button"
                  className="use-recorded"
                  onClick={() => {
                    setForm(null);
                    setEditing(null);
                    setError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </fieldset>
          </form>
        )}
      </div>
    </div>
  );
};
