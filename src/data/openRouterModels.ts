// OpenRouter's public model list (GET https://openrouter.ai/api/v1/models).
// No key: the cockpit calls it itself, and never sends the AgentBus token.
// Prices on the wire are USD per token, as decimal strings. A screen shows
// USD per million tokens, by moving the decimal point six places.

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export const OPENROUTER_LOAD_ERROR = "OpenRouter's model list could not be loaded. Type a model id.";

// A refresh failed after a list had already loaded. The kept list stays.
export const OPENROUTER_REFRESH_ERROR = 'The model list could not be refreshed. Previously loaded models are still available.';

export const OPENROUTER_EMPTY = 'No models returned. Type a model id.';

// The same shape the service accepts on an agent (run.ModelShape). An id
// outside it is left out of the catalogue; typing one still submits, and
// the service still refuses it.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export const SUGGESTED_GROUP = 'Suggested';
export const ALL_MODELS_GROUP = 'All models';

export interface OpenRouterModel {
  id: string;
  name: string;
  // name after the first colon, or the whole name when it has none.
  title: string;
  // The text before the first colon, or the author slug when name has none.
  provider: string;
  // The id's author, the part before "/", with one leading "~" removed.
  author: string;
  contextLength: number;
  // pricing.prompt and pricing.completion, unchanged.
  inputPerToken: string;
  outputPerToken: string;
}

export interface ModelRow {
  id: string;
  title: string;
  detail: string;
  group: typeof SUGGESTED_GROUP | typeof ALL_MODELS_GROUP;
  search: string;
}

export function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// The author slug of an OpenRouter id. "~openai/gpt" is "openai".
export function authorSlug(id: string): string {
  const bare = id.startsWith('~') ? id.slice(1) : id;
  const cut = bare.indexOf('/');
  return cut === -1 ? bare : bare.slice(0, cut);
}

export function modelTitle(name: string): string {
  const cut = name.indexOf(':');
  if (cut === -1) return name.trim();
  const title = name.slice(cut + 1).trim();
  return title || name.trim();
}

export function modelProvider(name: string, id: string): string {
  const cut = name.indexOf(':');
  if (cut === -1) return authorSlug(id);
  const provider = name.slice(0, cut).trim();
  return provider || authorSlug(id);
}

// USD per token → USD per million tokens, by shifting the decimal six
// places. No binary float: "0.00000014" is $0.14, "0.0000025" is $2.50.
// A negative string, including the "-1" sentinel on routers, is "varies".
export function formatPerMillion(raw: string): string {
  const s = raw.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m || m[1] === '-') return 'varies';
  const whole = m[2];
  const frac = m[3] ?? '';
  const digits = whole + frac;
  const pointAt = whole.length + 6;
  const padded = pointAt > digits.length ? digits + '0'.repeat(pointAt - digits.length) : digits;
  let intPart = padded.slice(0, pointAt).replace(/^0+(?=\d)/, '');
  let fracPart = padded.slice(pointAt).replace(/0+$/, '');
  if (!intPart) intPart = '0';
  if (!fracPart) return `$${intPart}`;
  // A price of at least $1 shows cents ($2.50). A smaller one keeps every
  // significant digit ($0.14, $0.075).
  if (intPart !== '0' && fracPart.length < 2) fracPart = fracPart.padEnd(2, '0');
  return `$${intPart}.${fracPart}`;
}

export function formatContext(n: number): string {
  const whole = Math.trunc(n);
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function modelDetail(m: OpenRouterModel): string {
  return `${m.id} · ${m.provider} · ${formatContext(m.contextLength)} · ${formatPerMillion(m.inputPerToken)} in · ${formatPerMillion(m.outputPerToken)} out`;
}

// What a query may match. The detail line's "in" and "out" are presentation
// only, so they are not here; the prices and the context length are.
function searchText(m: OpenRouterModel): string {
  return [
    m.title,
    m.name,
    m.id,
    m.provider,
    m.author,
    formatContext(m.contextLength),
    String(Math.trunc(m.contextLength)),
    formatPerMillion(m.inputPerToken),
    formatPerMillion(m.outputPerToken),
  ].join('\n');
}

export function modelMatches(m: OpenRouterModel, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return searchText(m).toLowerCase().includes(q);
}

function parseOne(item: unknown): OpenRouterModel | null {
  if (!isRecord(item)) return null;
  const id = item.id;
  const name = item.name;
  const context = item.context_length;
  const pricing = item.pricing;
  if (typeof id !== 'string' || !MODEL_ID.test(id)) return null;
  if (typeof name !== 'string' || !name.trim()) return null;
  if (typeof context !== 'number' || !Number.isFinite(context)) return null;
  if (!isRecord(pricing) || typeof pricing.prompt !== 'string' || typeof pricing.completion !== 'string') return null;
  const trimmed = name.trim();
  return {
    id,
    name: trimmed,
    title: modelTitle(trimmed),
    provider: modelProvider(trimmed, id),
    author: authorSlug(id),
    contextLength: context,
    inputPerToken: pricing.prompt,
    outputPerToken: pricing.completion,
  };
}

// data must be an array. A model whose id the service would refuse, or
// whose name, context or prices are the wrong shape, is skipped. An empty
// data array is a real answer. A non-empty array with nothing usable is not:
// it must not be cached as an empty catalogue.
export function parseOpenRouterBody(body: unknown): OpenRouterModel[] {
  if (!isRecord(body) || !Array.isArray(body.data)) throw new Error(OPENROUTER_LOAD_ERROR);
  if (body.data.length === 0) return [];
  const out: OpenRouterModel[] = [];
  for (const item of body.data) {
    const model = parseOne(item);
    if (model) out.push(model);
  }
  if (out.length === 0) throw new Error(OPENROUTER_LOAD_ERROR);
  return out;
}

// Suggested ids stay in the harness's order, ahead of the rest of the
// catalogue. An id in both is listed once. A suggested id the catalogue
// does not have is still a row: its id, and no invented price or context.
export function orderModels(catalogue: readonly OpenRouterModel[], suggested: readonly string[]): ModelRow[] {
  const byId = new Map(catalogue.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const out: ModelRow[] = [];
  for (const id of suggested) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const model = byId.get(id);
    if (model) {
      out.push({ id, title: model.title, detail: modelDetail(model), group: SUGGESTED_GROUP, search: searchText(model) });
    } else {
      out.push({ id, title: id, detail: '', group: SUGGESTED_GROUP, search: id });
    }
  }
  for (const model of catalogue) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push({ id: model.id, title: model.title, detail: modelDetail(model), group: ALL_MODELS_GROUP, search: searchText(model) });
  }
  return out;
}

let cached: OpenRouterModel[] | null = null;
let pending: { controller: AbortController; promise: Promise<OpenRouterModel[]> } | null = null;

export function resetOpenRouterModelsCache(): void {
  pending?.controller.abort();
  pending = null;
  cached = null;
}

async function fetchModels(signal: AbortSignal): Promise<OpenRouterModel[]> {
  let res: Response;
  try {
    res = await fetch(OPENROUTER_MODELS_URL, {
      method: 'GET',
      signal,
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new Error(OPENROUTER_LOAD_ERROR);
  }
  if (!res.ok) throw new Error(OPENROUTER_LOAD_ERROR);
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new Error(OPENROUTER_LOAD_ERROR);
  }
  return parseOpenRouterBody(body);
}

function listen(
  promise: Promise<OpenRouterModel[]>,
  controller: AbortController,
  signal?: AbortSignal,
): Promise<OpenRouterModel[]> {
  if (!signal) return promise;
  // Drop the shared promise now, not when the abort rejection arrives, so a
  // caller that starts again in the same turn (the dialog closing its last
  // request) does not wait on the aborted one.
  const stop = () => {
    if (pending?.controller !== controller) return;
    controller.abort();
    pending = null;
  };
  if (signal.aborted) {
    stop();
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      stop();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (models) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(abortError());
        else resolve(models);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

// One shared list. refresh fetches again. A failure or an abort drops the
// in-flight promise, so the next call tries again; a list already kept is
// replaced only when a later fetch succeeds.
export function loadOpenRouterModels(refresh = false, signal?: AbortSignal): Promise<OpenRouterModel[]> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (refresh) {
    pending?.controller.abort();
    pending = null;
  } else if (pending?.controller.signal.aborted) {
    pending = null;
  }
  if (!refresh && cached && !pending) return Promise.resolve(cached);
  if (!pending) {
    const controller = new AbortController();
    const promise = fetchModels(controller.signal).then(
      (models) => {
        if (pending?.controller === controller) {
          cached = models;
          pending = null;
        }
        return models;
      },
      (err) => {
        if (pending?.controller === controller) pending = null;
        throw err;
      },
    );
    pending = { controller, promise };
  }
  return listen(pending.promise, pending.controller, signal);
}
