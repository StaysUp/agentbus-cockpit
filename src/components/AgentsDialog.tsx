import React, { useEffect, useState } from "react";
import { Combo, Seg, Select } from "./Controls";
import { AccessOption, AgentFields, Harness, ModelList, SavedAgent } from "../types";
import { ConnectStep, SubscriptionApi } from "./ConnectStep";
import { APIKey, OpenRouterKey, vendorKeys } from "./OpenRouterKey";

// The "+ Agent" form, and the same form to edit a saved agent: Harness,
// then Access (only what that harness offers), then Model (what that harness
// and access offer; any id for OpenRouter), then Name (filled from harness
// and model until the person types one), then the extras, shown and
// disabled. An agent says nothing about where it runs. The agents themselves
// are listed in the left column (AgentsColumn), which edits and removes them.

interface AgentsDialogProps {
  loadHarnesses: () => Promise<Harness[]>;
  createAgent: (f: AgentFields) => Promise<SavedAgent>;
  updateAgent: (id: string, f: AgentFields) => Promise<SavedAgent>;
  onClose: () => void;
  // The agent to edit; absent, the form makes a new one.
  edit?: SavedAgent;
  // Called after a save, so other screens can list the agents again.
  onChanged?: () => void;
  // A control that adds the person's own subscription to their runners'
  // calls: the Connect step of a subscription agent.
  subscriptions?: SubscriptionApi;
  // The models a harness's access can use now (GET /api/v0/harnesses/<h>/
  // models), offered beside the harness's own. Absent: only those.
  loadModels?: (harness: string, access: string, refresh?: boolean) => Promise<ModelList>;
}

// What a harness, an access and a model are called on screen.
export const accessText = (a: { access: string; key_env?: string }): string =>
  a.access === "subscription"
    ? "subscription"
    : a.access === "openrouter"
      ? a.key_env && a.key_env !== "OPENROUTER_API_KEY"
        ? `OpenRouter · ${a.key_env}`
        : "OpenRouter"
      : a.access === "api"
        ? "API key"
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

// startModel is a new agent's model on acc: none on a subscription, so the
// harness uses its own default (a fixed name can be one the account
// refuses, as gpt-5.5 on a ChatGPT sign-in); the first offered on
// OpenRouter, which needs one.
function startModel(acc: AccessOption | undefined): string {
  if (!acc || acc.kind !== "openrouter") return "";
  return acc.models[0] ?? "";
}

function freshForm(harnesses: Harness[]): FormState {
  const h = harnesses.find(usable);
  const acc = firstAccess(h);
  const f: FormState = {
    harness: h?.name ?? "",
    access: acc?.kind ?? "",
    model: startModel(acc),
    // No variable: the OpenRouter key is pasted in Settings only. Control
    // still reads the variable an agent saved before names.
    keyEnv: "",
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

// The vendor whose list-models call a key's list comes from, by the key's
// name in Settings.
const vendorOf: Record<string, string> = { anthropic: "Anthropic's", openai: "OpenAI's", gemini: "the Gemini API's" };

// sourceText says where a list of models came from; keyName is the API key
// of access "api" (anthropic, openai, gemini), absent for OpenRouter.
function sourceText(source: string, label: string, keyName?: string): string {
  switch (source) {
    case "api":
      return keyName ? `${vendorOf[keyName] ?? "the vendor's"} list, read with your API key` : "OpenRouter's list";
    case "command":
      return `${label} itself, where its sign-in is`;
    case "runner":
      return `${label}'s own list, after its last turn`;
    case "fixed":
      return `${label}'s aliases, always the newest of each`;
  }
  return "the service";
}

// when is a time as the person's clock reads it, to the minute.
const when = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
};

const Off: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <label className="f-off">
    <span>{label}</span>
    <Select label={label} value="v" options={[{ value: "v", label: value }]} onChange={() => undefined} disabled />
    <span className="nd-note">Not available yet.</span>
  </label>
);

export const AgentsDialog: React.FC<AgentsDialogProps> = ({
  loadHarnesses,
  createAgent,
  updateAgent,
  onClose,
  edit,
  onChanged,
  subscriptions,
  loadModels,
}) => {
  const [harnesses, setHarnesses] = useState<Harness[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The form, once the harnesses are known.
  const [form, setForm] = useState<FormState | null>(null);
  const editing = edit?.id ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadHarnesses().then(
      (hs) => {
        if (!active) return;
        setHarnesses(hs);
        setForm(edit ? formOf(edit) : freshForm(hs));
      },
      (err: Error) => active && setLoadError(err.message),
    );
    return () => {
      active = false;
    };
    // The form is made once, for the agent the dialog opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadHarnesses]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While a save is in flight nothing closes: its answer would land on
      // whatever came next.
      if (e.key !== "Escape" || busy) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  // The list of models for the form's harness and access, read when either
  // changes; a typed name is still taken, and none is the tool's default.
  const [models, setModels] = useState<ModelList | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const modelsFor = form ? `${form.harness} ${form.access}` : "";
  const readModels = (refresh: boolean) => {
    if (!loadModels || !form?.harness || !form.access) return () => undefined;
    let active = true;
    const [h, a] = [form.harness, form.access];
    setModelsBusy(true);
    setModelsError(null);
    loadModels(h, a, refresh)
      .then(
        (l) => active && setModels(l),
        (err: Error) => active && setModelsError(err.message),
      )
      .finally(() => active && setModelsBusy(false));
    return () => {
      active = false;
    };
  };
  useEffect(() => {
    setModels(null);
    return readModels(false);
    // The list follows the harness and access only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsFor, loadModels]);

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
          f.model = startModel(acc);
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
    // An agent saved before keys were pasted in Settings keeps the variable
    // it names; the form has no field for one.
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
    let saved = false;
    try {
      if (editing) await updateAgent(editing, fields(form));
      else await createAgent(fields(form));
      saved = true;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
    if (saved) {
      onChanged?.();
      onClose();
    }
  };

  // What the Model field offers: the harness's own, then the list read now.
  const listed = models && models.harness === form?.harness && models.access === form?.access ? models : null;
  const offered = [...(access?.models ?? [])];
  const modelLabels: Record<string, string> = {};
  for (const m of listed?.models ?? []) {
    if (!offered.includes(m.id)) offered.push(m.id);
    if (m.label) modelLabels[m.id] = m.label;
  }
  const openRouter = form?.access === "openrouter";
  const apiKey = form?.access === "api";

  return (
    <div
      className="modal-back"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        className="new-dialog agents-dialog"
        role="dialog"
        aria-label={editing ? "Edit agent" : "New agent"}
      >
        <div className="nd-title">{editing ? `Edit ${edit?.name}` : "New agent"}</div>
        {loadError && <div className="form-error">{loadError}</div>}
        {!form && !loadError && <div className="nd-note">Looking…</div>}
        {form && (
          <form className="agent-form" onSubmit={save}>
            {/* While a save is in flight nothing in the form changes: the
                answer closes the form with what was sent. */}
            <fieldset className="ad-set" disabled={busy}>
              <label>
                <span>Harness</span>
                <Seg
                  label="Harness"
                  dataKey="harness"
                  value={form.harness}
                  options={hs.map((h) => ({
                    value: h.name,
                    label: h.label ?? h.name,
                    disabled: !usable(h),
                    title: h.disabled
                      ? "Not available yet"
                      : !h.found
                        ? "Not installed where the service runs"
                        : undefined,
                  }))}
                  onChange={(v) => update({ harness: v })}
                />
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
                <Seg
                  label="Access"
                  dataKey="access"
                  value={form.access}
                  options={accessesOf(harness).map((x) => ({
                    value: x.kind,
                    // Settings says whose API key; here the choice is only "API key".
                    label: x.kind === "api" ? "API key" : x.label,
                    disabled: !!x.disabled,
                    title: x.disabled ? "Not available yet" : undefined,
                  }))}
                  onChange={(v) => update({ access: v })}
                />
                <span className="nd-note">
                  {openRouter
                    ? "Control adds your OpenRouter key, set once in Settings, Subscriptions. No runner or agent ever holds it."
                    : apiKey
                      ? `Control adds your ${vendorKeys[access?.key_name ?? ""]?.label ?? access?.label ?? "API key"}, set once in Settings, Subscriptions. No runner or agent ever holds it.`
                      : `Uses the ${access?.label ?? "harness sign-in"}.`}
                </span>
              </label>
              {subscriptions && form.access === "subscription" && form.harness && (
                <ConnectStep key={form.harness} harness={form.harness} api={subscriptions} />
              )}
              {subscriptions && openRouter && <OpenRouterKey api={subscriptions} />}
              {subscriptions && apiKey && access?.key_name && (
                <APIKey key={access.key_name} api={subscriptions} name={access.key_name} onChange={() => readModels(true)} />
              )}
              <label>
                <span>Model</span>
                {access?.any_model ? (
                  <Combo
                    name="model"
                    label="Model"
                    value={form.model}
                    onChange={(v) => update({ model: v })}
                    placeholder={
                      access.kind === "openrouter"
                        ? "an OpenRouter model id"
                        : `empty: ${harness?.label ?? form.harness}'s default`
                    }
                    suggestions={offered}
                    labels={modelLabels}
                  />
                ) : (
                  <Select
                    name="model"
                    label="Model"
                    value={form.model}
                    onChange={(v) => update({ model: v })}
                    options={[
                      ...(access?.models ?? []).map((m) => ({ value: m, label: m })),
                      ...(form.model && !(access?.models ?? []).includes(form.model)
                        ? [{ value: form.model, label: form.model }]
                        : []),
                      { value: "", label: "Harness default" },
                    ]}
                  />
                )}
                {loadModels && access?.any_model && (
                  <span className="nd-note ad-models" data-source={listed?.source ?? ""}>
                    {modelsBusy
                      ? "Reading the models this access can use…"
                      : modelsError
                        ? modelsError
                        : listed?.error
                          ? listed.error
                          : listed
                            ? `${listed.models.length} models from ${sourceText(listed.source, harness?.label ?? form.harness, apiKey ? access?.key_name : undefined)}${listed.fetched_at ? `, read ${when(listed.fetched_at)}` : ""}.`
                            : ""}{" "}
                    {listed && listed.source !== "fixed" && (
                      <button type="button" className="btn btn-secondary btn-sm ad-models-refresh" onClick={() => readModels(true)} disabled={modelsBusy}>
                        Refresh
                      </button>
                    )}
                  </span>
                )}
                <span className="nd-note">
                  {access?.kind !== "openrouter" && access?.any_model ? (
                    <>
                      Empty uses {harness?.label ?? form.harness}&apos;s own
                      default. A name your account does not offer fails the
                      turn with the vendor&apos;s words.
                    </>
                  ) : (
                    <>
                      Only what {harness?.label ?? form.harness} offers for this
                      access
                      {access?.any_model ? ", or any OpenRouter model id" : ""}.
                    </>
                  )}
                </span>
              </label>
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
                  className="btn btn-primary connect-go"
                  disabled={busy || !form.harness || !form.access}
                >
                  {editing ? "Save" : "Create agent"}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary nd-cancel"
                  onClick={onClose}
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
