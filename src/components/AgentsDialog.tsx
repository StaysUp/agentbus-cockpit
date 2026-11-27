import React, { useEffect, useRef, useState } from "react";
import { Button, Combo, Seg, Select } from "./Controls";
import { Dialog, DialogActions } from "./Dialog";
import { Loading, Notice } from "./Notice";
import { harnessName, PRODUCT } from "../words";
import { AccessOption, AgentFields, Harness, ModelList, SavedAgent } from "../types";
import { ConnectStep, ConnectStepHandle, SubscriptionApi } from "./ConnectStep";
import { APIKey, OpenRouterKey, vendorKeys } from "./OpenRouterKey";
import { AgentLogo, DownIcon } from "./Icons";

// The "+ Agent" form, and the same form to edit a saved agent: Harness,
// then Access (only what that harness offers), then Model (what that harness
// and access offer; any id for OpenRouter), then Name (filled from harness
// and model until the person types one). Only what works is offered: a
// harness or an access the service marks not available is left out. An
// agent says nothing about where it runs. The agents themselves
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
  return `${harnessName(a.harness, h?.label)} · ${a.model || "default model"} · ${accessText(a)}`;
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

// A dropdown action, distinct from Default (empty) and every non-blank model ID.
const customModelOption = { value: " ", label: "Custom model ID…" };

function autoName(f: FormState, harnesses: Harness[]): string {
  const label = harnessName(f.harness, harnesses.find((h) => h.name === f.harness)?.label);
  return f.model ? `${label} · ${f.model}` : label;
}

// startModel is a new agent's model on acc: none on a subscription, so the
// harness uses its own default (a fixed name can be one the account
// refuses, as gpt-5.5 on a ChatGPT sign-in); the first offered on
// OpenRouter or a provider such as xAI, which need one.
function startModel(acc: AccessOption | undefined): string {
  if (!acc || acc.kind === "subscription" || acc.kind === "api") return "";
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
      return keyName ? `the models ${PRODUCT} suggests; any other id works too` : `${label}'s aliases, always the newest of each`;
  }
  return "the service";
}

// when is a time as the person's clock reads it, to the minute.
const when = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const today = d.toDateString() === new Date().toDateString();
  return today ? d.toLocaleTimeString(undefined, { timeStyle: "short" }) : d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
};

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
  const [signingIn, setSigningIn] = useState(false);
  const signIn = useRef<ConnectStepHandle>(null);
  const [showOptions, setShowOptions] = useState(!!edit);
  const [enterCustomModel, setEnterCustomModel] = useState(false);

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

  // The list of models for the form's harness and access, read when either
  // changes; a typed name is still taken, and none is the tool's default.
  const [models, setModels] = useState<ModelList | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const modelsFor = form ? `${form.harness} ${form.access}` : "";
  useEffect(() => {
    setEnterCustomModel(false);
  }, [modelsFor]);
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
  // Its name on screen: the service's label, else the product name.
  const hName = form ? harnessName(form.harness, harness?.label) : "";
  const access = form
    ? accessesOf(harness).find((x) => x.kind === form.access)
    : undefined;

  // Each change keeps the form valid: an access the harness lacks moves to
  // its first, a model the access lacks moves to its first, and the name
  // follows until the person types one.
  const update = (patch: Partial<FormState>) =>
    setForm((cur) => {
      if (!cur || signingIn || busy) return cur;
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
    if (!form || busy || signingIn) return;
    if (!form.name.trim()) {
      setShowOptions(true);
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
  const modelRequired = !!access && access.kind !== "subscription" && access.kind !== "api";
  const searchableModels = modelRequired && access.any_model;
  const canEnterCustomModel = !modelRequired && !!access?.any_model;
  const modelOptions = [
    { value: "", label: "Default" },
    ...offered.filter((id) => id.trim()).map((id) => ({
      value: id,
      label: modelLabels[id] || id,
      hint: modelLabels[id] && modelLabels[id] !== id ? id : undefined,
    })),
    ...(form?.model.trim() && !offered.includes(form.model)
      ? [{ value: form.model, label: form.model }]
      : []),
    ...(canEnterCustomModel ? [customModelOption] : []),
  ];
  const pickModel = (value: string) => {
    if (signingIn || busy) return;
    const custom = value === customModelOption.value;
    setEnterCustomModel(custom);
    if (!custom) update({ model: value });
  };
  // A key set in Settings that the access uses: the vendor's (access "api")
  // or a provider's, such as xAI's (access "xai"). The service names it.
  const apiKey = form?.access === "api" || (!openRouter && !!access?.key_name);
  const optionsToggle = (
    <button type="button" className="ad-options" hidden={signingIn} aria-expanded={showOptions}
      aria-controls={modelRequired ? "ad-name" : "ad-model ad-name"} onClick={() => setShowOptions(!showOptions)}>
      <DownIcon /> {modelRequired ? "Agent name" : "Model and name"}
      {!modelRequired && !showOptions && <span>{form?.model || "Default model"}</span>}
    </button>
  );

  // While a save is in flight nothing closes: its answer would land on
  // whatever came next.
  return (
    <Dialog
      title={signingIn ? `Connect ${hName}` : editing ? `Edit ${edit?.name}` : "New agent"}
      label={signingIn ? `Connect ${hName}` : editing ? "Edit agent" : "New agent"}
      className="agents-dialog"
      onClose={() => {
        if (signingIn) signIn.current?.leave();
        else onClose();
      }}
      busy={busy}
    >
        {loadError && <Notice kind="error">{loadError}</Notice>}
        {!form && !loadError && <Loading />}
        {!form && loadError && <DialogActions />}
        {form && (
          <form className="agent-form" onSubmit={save}>
            {/* While a save is in flight nothing in the form changes: the
                answer closes the form with what was sent. */}
            <fieldset className="ad-set" disabled={busy}>
              <div className="ad-tool" hidden={signingIn}>
                <span className="ad-label">Coding tool</span>
                <Seg
                  label="Coding tool"
                  dataKey="harness"
                  value={form.harness}
                  options={hs
                    .filter((h) => !h.disabled || h.name === form.harness)
                    .map((h) => ({
                      value: h.name,
                      label: (
                        <>
                          <AgentLogo harness={h.name} />
                          {harnessName(h.name, h.label)}
                        </>
                      ),
                      disabled: !usable(h),
                      title: !h.found ? `Not installed where ${PRODUCT} runs` : undefined,
                    }))}
                  onChange={(v) => update({ harness: v })}
                />
                {harness && !harness.found && (
                  <span className="nd-note">Not installed where {PRODUCT} runs.</span>
                )}
              </div>
              <div className={signingIn ? undefined : "ad-group ad-access"}
                role={signingIn ? undefined : "group"} aria-labelledby={signingIn ? undefined : "ad-access-label"}>
                <label hidden={signingIn}>
                  <span id="ad-access-label">Model access</span>
                  <Select
                    label="Model access"
                    name="access"
                    value={form.access}
                    disabled={signingIn || busy}
                    options={accessesOf(harness)
                      .filter((x) => !x.disabled || x.kind === form.access)
                      .map((x) => ({
                        value: x.kind,
                        // Settings says whose API key; here the choice is only "API key".
                        label: x.kind === "api" ? "API key" : x.label,
                        disabled: !!x.disabled,
                      }))}
                    onChange={(v) => update({ access: v })}
                  />
                </label>
                {(openRouter || apiKey) && (
                  <span className="nd-note" hidden={signingIn}>
                    {PRODUCT} adds your {openRouter
                      ? "OpenRouter key"
                      : vendorKeys[access?.key_name ?? ""]?.label ?? access?.label ?? "API key"} to each call.
                  </span>
                )}
                {subscriptions && form.access === "subscription" && form.harness && (
                  <ConnectStep key={form.harness} ref={signIn} harness={form.harness} api={subscriptions} onSigningInChange={setSigningIn} />
                )}
                {subscriptions && openRouter && <OpenRouterKey api={subscriptions} />}
                {subscriptions && apiKey && access?.key_name && (
                  <APIKey key={access.key_name} api={subscriptions} name={access.key_name} onChange={() => readModels(true)} />
                )}
              </div>
              {!modelRequired && optionsToggle}
              <div id="ad-model" className="ad-group" role="group" aria-labelledby="ad-model-label"
                hidden={signingIn || (!modelRequired && !showOptions)}>
                <label>
                  <span id="ad-model-label">Model</span>
                  {searchableModels ? (
                    <Combo
                      name="model"
                      label="Model"
                      value={form.model}
                      disabled={signingIn || busy}
                      onChange={(v) => update({ model: v })}
                      placeholder={openRouter ? "an OpenRouter model id" : "a model id"}
                      suggestions={offered}
                      labels={modelLabels}
                    />
                  ) : (
                    <Select
                      name="model"
                      label="Model"
                      value={enterCustomModel && canEnterCustomModel ? customModelOption.value : form.model}
                      disabled={signingIn || busy || (!modelRequired && !showOptions)}
                      onChange={pickModel}
                      options={modelOptions}
                    />
                  )}
                </label>
                {enterCustomModel && canEnterCustomModel && (
                  <label>
                    <span>Custom model ID</span>
                    <input
                      name="custom_model"
                      type="text"
                      value={form.model}
                      onChange={(e) => update({ model: e.target.value })}
                      spellCheck={false}
                      autoComplete="off"
                      autoFocus
                    />
                  </label>
                )}
                {loadModels && access?.any_model && (modelsBusy || modelsError || listed) && (
                  <div className="ad-models" data-source={listed?.source ?? ""}>
                    <span role="status" title={listed ? `From ${sourceText(listed.source, hName, apiKey ? access?.key_name : undefined)}` : undefined}>
                      {modelsBusy
                        ? "Loading…"
                        : modelsError
                          ? modelsError
                          : listed && listed.models.length === 0 && listed.source !== "fixed"
                            ? `No list of ${hName}'s models yet.${searchableModels ? " Type a model id above." : ""}`
                            : listed?.error
                              ? listed.error
                              : listed
                                ? `${listed.models.length} ${listed.models.length === 1 ? "model" : "models"}${listed.fetched_at ? ` · updated ${when(listed.fetched_at)}` : ""}`
                                : ""}
                    </span>
                    {listed && listed.source !== "fixed" && (
                      <Button kind="link" className="ad-models-refresh" onClick={() => readModels(true)} disabled={modelsBusy}>
                        Refresh
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {modelRequired && optionsToggle}
              <label id="ad-name" hidden={signingIn || !showOptions}>
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
              <div hidden={signingIn}>
                {error && <Notice kind="error">{error}</Notice>}
                <DialogActions>
                  <Button kind="primary" type="submit" className="ad-save" disabled={busy || !form.harness || !form.access}>
                    {busy ? "Saving…" : editing ? "Save" : "Create agent"}
                  </Button>
                </DialogActions>
              </div>
            </fieldset>
          </form>
        )}
    </Dialog>
  );
};
