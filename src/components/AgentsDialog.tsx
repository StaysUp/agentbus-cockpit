import React, { useEffect, useRef, useState } from "react";
import { Button, Combo, ComboChoice, Seg, Select } from "./Controls";
import { Dialog, DialogActions } from "./Dialog";
import { Loading, Notice } from "./Notice";
import { harnessName, PRODUCT } from "../words";
import { AccessOption, AgentFields, Harness, ModelList, SavedAgent } from "../types";
import { ConnectStep, SubscriptionApi } from "./ConnectStep";
import { APIKey, OpenRouterKey, vendorKeys } from "./OpenRouterKey";
import {
  isAbortError,
  OPENROUTER_EMPTY,
  OPENROUTER_LOAD_ERROR,
  OPENROUTER_REFRESH_ERROR,
  OpenRouterModel,
  orderModels,
} from "../data/openRouterModels";

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
  // OpenRouter does not use it: that list has no price or context.
  loadModels?: (harness: string, access: string, refresh?: boolean) => Promise<ModelList>;
  // OpenRouter's public catalogue. Absent: the field keeps the harness's
  // own model ids, and typing an id still works.
  loadOpenRouterModels?: (refresh?: boolean, signal?: AbortSignal) => Promise<OpenRouterModel[]>;
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
  loadOpenRouterModels,
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

  // The list of models for the form's harness and access, read when either
  // changes; a typed name is still taken, and none is the tool's default.
  const [models, setModels] = useState<ModelList | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const modelsFor = form ? `${form.harness} ${form.access}` : "";
  const readModels = (refresh: boolean) => {
    if (!loadModels || !form?.harness || !form.access || form.access === "openrouter") return () => undefined;
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
    if (form?.access === "openrouter") {
      setModelsBusy(false);
      setModelsError(null);
      return;
    }
    return readModels(false);
    // The list follows the harness and access only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsFor, loadModels]);

  // OpenRouter's own catalogue. The harness's access.models stay selectable
  // when this has not arrived, or when the call fails.
  const [catalogue, setCatalogue] = useState<OpenRouterModel[] | null>(null);
  const [catBusy, setCatBusy] = useState(false);
  const [catError, setCatError] = useState<string | null>(null);
  const catGen = useRef(0);
  const catAbort = useRef<AbortController | null>(null);
  const readCatalogue = (refresh: boolean) => {
    if (!loadOpenRouterModels || form?.access !== "openrouter") return;
    const gen = ++catGen.current;
    catAbort.current?.abort();
    const ac = new AbortController();
    catAbort.current = ac;
    setCatBusy(true);
    setCatError(null);
    // A refresh that fails keeps this list. The note says so, instead of
    // the first-load error, which would claim that nothing loaded.
    const kept = catalogue;
    loadOpenRouterModels(refresh, ac.signal).then(
      (models) => {
        if (gen !== catGen.current) return;
        setCatalogue(models);
        setCatError(null);
      },
      (err: unknown) => {
        if (gen !== catGen.current || isAbortError(err)) return;
        setCatError(refresh && kept !== null ? OPENROUTER_REFRESH_ERROR : OPENROUTER_LOAD_ERROR);
      },
    ).finally(() => {
      if (gen === catGen.current) setCatBusy(false);
    });
  };
  useEffect(() => {
    if (form?.access !== "openrouter" || !loadOpenRouterModels) {
      catGen.current += 1;
      catAbort.current?.abort();
      setCatalogue(null);
      setCatError(null);
      setCatBusy(false);
      return;
    }
    readCatalogue(false);
    return () => {
      catGen.current += 1;
      catAbort.current?.abort();
    };
    // The catalogue follows the access, not the harness: it is one list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.access, loadOpenRouterModels]);

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
  // A key set in Settings that the access uses: the vendor's (access "api")
  // or a provider's, such as xAI's (access "xai"). The service names it.
  const apiKey = form?.access === "api" || (!openRouter && !!access?.key_name);
  // Suggested ids from the harness, then the rest of OpenRouter's catalogue.
  const orChoices: ComboChoice[] | undefined =
    openRouter && loadOpenRouterModels
      ? orderModels(catalogue ?? [], access?.models ?? []).map((row) => ({
          value: row.id,
          label: row.title,
          detail: row.detail || undefined,
          group: row.group,
          search: row.search,
        }))
      : undefined;
  const catCount = catalogue?.length ?? 0;
  const catNote = !openRouter || !loadOpenRouterModels
    ? ""
    : catBusy || (catalogue === null && !catError)
      ? "Loading…"
      : catError
        ? catError
        : catalogue === null
          ? "Loading…"
          : catCount === 0
            ? OPENROUTER_EMPTY
            : `${catCount} ${catCount === 1 ? "model" : "models"}`;

  // While a save is in flight nothing closes: its answer would land on
  // whatever came next.
  return (
    <Dialog
      title={editing ? `Edit ${edit?.name}` : "New agent"}
      label={editing ? "Edit agent" : "New agent"}
      className="agents-dialog"
      onClose={onClose}
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
              <label>
                <span>Harness</span>
                <Seg
                  label="Harness"
                  dataKey="harness"
                  value={form.harness}
                  options={hs
                    .filter((h) => !h.disabled || h.name === form.harness)
                    .map((h) => ({
                      value: h.name,
                      label: harnessName(h.name, h.label),
                      disabled: !usable(h),
                      title: !h.found ? `Not installed where ${PRODUCT} runs` : undefined,
                    }))}
                  onChange={(v) => update({ harness: v })}
                />
                <span className="nd-note">
                  {harness && !harness.found
                    ? `Not installed where ${PRODUCT} runs.`
                    : "The agent's loop and tools."}
                </span>
              </label>
              <label>
                <span>Access</span>
                <Seg
                  label="Access"
                  dataKey="access"
                  value={form.access}
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
                <span className="nd-note">
                  {openRouter
                    ? `${PRODUCT} adds your OpenRouter key to each call.`
                    : apiKey
                      ? `${PRODUCT} adds your ${vendorKeys[access?.key_name ?? ""]?.label ?? access?.label ?? "API key"} to each call.`
                      : `${PRODUCT} adds your ${hName} sign-in to each call.`}
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
                        : access.kind !== "api" && access.key_name
                          ? "a model id"
                          : `empty: ${hName}'s default`
                    }
                    suggestions={offered}
                    labels={modelLabels}
                    choices={orChoices}
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
                {openRouter && loadOpenRouterModels && (
                  <span className="nd-note ad-models" data-source="openrouter">
                    {catNote}{" "}
                    {!catBusy && (catalogue !== null || catError) && (
                      <Button kind="secondary" small className="ad-models-refresh" onClick={() => readCatalogue(true)} disabled={catBusy}>
                        Refresh
                      </Button>
                    )}
                  </span>
                )}
                {loadModels && access?.any_model && !openRouter && (
                  <span className="nd-note ad-models" data-source={listed?.source ?? ""} title={listed ? `From ${sourceText(listed.source, hName, apiKey ? access?.key_name : undefined)}` : undefined}>
                    {modelsBusy
                      ? "Loading…"
                      : modelsError
                        ? modelsError
                        : listed && listed.models.length === 0 && listed.source !== "fixed"
                          ? `No list of ${hName}'s models yet. Type a model id above.`
                          : listed?.error
                          ? listed.error
                          : listed
                            ? `${listed.models.length} ${listed.models.length === 1 ? "model" : "models"}${listed.fetched_at ? ` · updated ${when(listed.fetched_at)}` : ""}`
                            : ""}{" "}
                    {listed && listed.source !== "fixed" && (
                      <Button kind="secondary" small className="ad-models-refresh" onClick={() => readModels(true)} disabled={modelsBusy}>
                        Refresh
                      </Button>
                    )}
                  </span>
                )}
                <span className="nd-note">
                  {access?.kind !== "openrouter" && access?.any_model ? (
                    <>Empty uses {hName}&apos;s default.</>
                  ) : (
                    <>
                      What {hName} offers here
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
              {error && <Notice kind="error">{error}</Notice>}
              <DialogActions>
                <Button kind="primary" type="submit" className="ad-save" disabled={busy || !form.harness || !form.access}>
                  {busy ? "Saving…" : editing ? "Save" : "Create agent"}
                </Button>
              </DialogActions>
            </fieldset>
          </form>
        )}
    </Dialog>
  );
};
