import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_MODELS_GROUP,
  OPENROUTER_EMPTY,
  OPENROUTER_LOAD_ERROR,
  OPENROUTER_MODELS_URL,
  SUGGESTED_GROUP,
  authorSlug,
  formatContext,
  formatPerMillion,
  loadOpenRouterModels,
  modelDetail,
  modelMatches,
  modelProvider,
  modelTitle,
  orderModels,
  parseOpenRouterBody,
  resetOpenRouterModelsCache,
} from '../data/openRouterModels';

const flash = {
  id: 'deepseek/deepseek-v4.1-flash',
  name: 'DeepSeek: DeepSeek V4.1 Flash',
  context_length: 1048576,
  pricing: { prompt: '0.00000014', completion: '0.00000042' },
};

const oss = {
  id: 'openai/gpt-oss-120b',
  name: 'OpenAI: gpt-oss-120b',
  context_length: 131072,
  pricing: { prompt: '0.00000005', completion: '0.00000025' },
};

const grok = {
  id: 'x-ai/grok-4.7',
  name: 'SpaceXSI: Grok 4.7',
  context_length: 256000,
  pricing: { prompt: '0.0000025', completion: '0.00001' },
};

const router = {
  id: 'openrouter/auto',
  name: 'Auto Router',
  context_length: 200000,
  pricing: { prompt: '-1', completion: '-1' },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  resetOpenRouterModelsCache();
  vi.unstubAllGlobals();
});

describe('price per million tokens', () => {
  it('shifts the decimal six places, with cents once the price reaches a dollar', () => {
    expect(formatPerMillion('0.00000014')).toBe('$0.14');
    expect(formatPerMillion('0.00000042')).toBe('$0.42');
    expect(formatPerMillion('0.0000025')).toBe('$2.50');
    expect(formatPerMillion('0.00000250')).toBe('$2.50');
    expect(formatPerMillion('0.00001')).toBe('$10');
    expect(formatPerMillion('0')).toBe('$0');
    expect(formatPerMillion('0.000000075')).toBe('$0.075');
    expect(formatPerMillion('0.0000084023')).toBe('$8.4023');
    expect(formatPerMillion('0.00000005')).toBe('$0.05');
  });

  it('treats a negative sentinel as not a price', () => {
    expect(formatPerMillion('-1')).toBe('varies');
    expect(formatPerMillion('-0.5')).toBe('varies');
    expect(formatPerMillion('')).toBe('varies');
    expect(formatPerMillion('free')).toBe('varies');
  });
});

describe('names, providers and ids', () => {
  it('takes the provider from the name, and the author from the id', () => {
    expect(modelTitle(flash.name)).toBe('DeepSeek V4.1 Flash');
    expect(modelProvider(flash.name, flash.id)).toBe('DeepSeek');
    expect(authorSlug(flash.id)).toBe('deepseek');
    expect(modelTitle('Mistral Large')).toBe('Mistral Large');
    expect(modelProvider('Mistral Large', 'mistralai/mistral-large')).toBe('mistralai');
    expect(authorSlug('~openai/gpt-astra-latest')).toBe('openai');
    expect(modelProvider(grok.name, grok.id)).toBe('SpaceXSI');
    expect(authorSlug(grok.id)).toBe('x-ai');
  });

  it('keeps context on the model and drops an id the service would refuse', () => {
    const models = parseOpenRouterBody({
      data: [
        flash,
        { id: '~openai/gpt-astra-latest', name: 'OpenAI: GPT Astra', context_length: 1, pricing: { prompt: '0', completion: '0' } },
        { id: 'not a model', name: 'Bad', context_length: 1, pricing: { prompt: '0', completion: '0' } },
        { id: 'openai/gpt-4o', name: 'OpenAI: GPT-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } },
        { name: 'No id', context_length: 1, pricing: { prompt: '0', completion: '0' } },
        grok,
      ],
    });
    expect(models.map((m) => m.id)).toEqual([flash.id, grok.id]);
    expect(models[0].contextLength).toBe(1048576);
    expect(formatContext(models[0].contextLength)).toBe('1,048,576');
    expect(modelDetail(models[0])).toBe('deepseek/deepseek-v4.1-flash · DeepSeek · 1,048,576 · $0.14 in · $0.42 out');
    expect(models[1].provider).toBe('SpaceXSI');
    expect(models[1].author).toBe('x-ai');
    expect(models[1].title).toBe('Grok 4.7');
  });

  it('rejects a body that is not a list, keeps valid rows, and refuses a list with none', () => {
    expect(() => parseOpenRouterBody(null)).toThrow(OPENROUTER_LOAD_ERROR);
    expect(() => parseOpenRouterBody({ models: [] })).toThrow(OPENROUTER_LOAD_ERROR);
    expect(() => parseOpenRouterBody({ data: 'no' })).toThrow(OPENROUTER_LOAD_ERROR);
    expect(parseOpenRouterBody({ data: [] })).toEqual([]);
    expect(parseOpenRouterBody({ data: [flash, { id: 'not a model' }, null] }).map((m) => m.id)).toEqual([flash.id]);
    expect(() => parseOpenRouterBody({ data: [{ id: 'not a model' }, { no: true }] })).toThrow(OPENROUTER_LOAD_ERROR);
    expect(OPENROUTER_EMPTY).toBe('No models returned. Type a model id.');
  });
});

describe('search and suggested order', () => {
  const catalogue = parseOpenRouterBody({ data: [oss, flash, grok, router] });

  it('matches the title, the id, the provider and the author', () => {
    const deepseek = catalogue.find((m) => m.id === flash.id)!;
    const space = catalogue.find((m) => m.id === grok.id)!;
    expect(modelMatches(deepseek, 'deepseek v4')).toBe(true);
    expect(modelMatches(deepseek, 'deepseek-v4.1-flash')).toBe(true);
    expect(modelMatches(deepseek, 'DeepSeek')).toBe(true);
    expect(modelMatches(space, 'SpaceXSI')).toBe(true);
    expect(modelMatches(space, 'x-ai')).toBe(true);
    expect(modelMatches(space, 'grok 4.7')).toBe(true);
    expect(modelMatches(space, 'anthropic')).toBe(false);
    expect(modelMatches(deepseek, '1,048,576')).toBe(true);
    expect(modelMatches(deepseek, '1048576')).toBe(true);
    expect(modelMatches(deepseek, '0.14')).toBe(true);
    expect(modelMatches(deepseek, '$0.42')).toBe(true);
    // The detail line says "in" and "out" on every priced model. Those words
    // are not part of the model, so they must not match it.
    expect(modelDetail(deepseek)).toContain(' in ');
    expect(modelDetail(deepseek)).toContain(' out');
    expect(modelMatches(deepseek, 'in')).toBe(false);
    expect(modelMatches(deepseek, 'out')).toBe(false);
    expect(modelMatches(space, 'in')).toBe(false);
    expect(modelMatches(space, 'out')).toBe(false);
  });

  it('lists suggested ids first, once, and keeps a missing id with no invented price', () => {
    const rows = orderModels(catalogue, [flash.id, 'missing/one', flash.id, oss.id]);
    expect(rows.map((r) => [r.group, r.id])).toEqual([
      [SUGGESTED_GROUP, flash.id],
      [SUGGESTED_GROUP, 'missing/one'],
      [SUGGESTED_GROUP, oss.id],
      [ALL_MODELS_GROUP, grok.id],
      [ALL_MODELS_GROUP, router.id],
    ]);
    expect(rows[0].title).toBe('DeepSeek V4.1 Flash');
    expect(rows[0].detail).toContain('$0.14 in');
    expect(rows[0].search).toContain('$0.14');
    expect(rows[0].search).not.toContain(' in ');
    expect(rows[0].search).not.toContain(' out');
    expect(rows[1]).toMatchObject({ title: 'missing/one', detail: '', search: 'missing/one' });
    expect(rows[4].detail).toContain('varies in · varies out');
  });
});

describe('loadOpenRouterModels', () => {
  it('sends a plain GET, shares one request, and fetches again on refresh', async () => {
    const fetchMock = vi.fn(async () => json({ data: [flash] }));
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([loadOpenRouterModels(), loadOpenRouterModels()]);
    expect(a.map((m) => m.id)).toEqual([flash.id]);
    expect(b).toEqual(a);
    await loadOpenRouterModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await loadOpenRouterModels(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENROUTER_MODELS_URL);
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(JSON.stringify(init.headers)).not.toContain('Authorization');
  });

  it('does not keep a failed or aborted request', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) return Promise.resolve(json({ error: 'no' }, 500));
        if (calls === 2) return Promise.resolve(json({ data: { id: flash.id } }));
        if (calls === 3) {
          return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
              reject(new DOMException('aborted', 'AbortError'));
              return;
            }
            signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        }
        return Promise.resolve(json({ data: [flash, grok] }));
      }),
    );
    await expect(loadOpenRouterModels()).rejects.toThrow(OPENROUTER_LOAD_ERROR);
    await expect(loadOpenRouterModels()).rejects.toThrow(OPENROUTER_LOAD_ERROR);
    const ac = new AbortController();
    const aborted = loadOpenRouterModels(false, ac.signal);
    await Promise.resolve();
    ac.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    await expect(loadOpenRouterModels().then((ms) => ms.map((m) => m.id))).resolves.toEqual([flash.id, grok.id]);
    expect(calls).toBe(4);
  });

  it('keeps an empty list as a real answer', async () => {
    const fetchMock = vi.fn(async () => json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadOpenRouterModels()).resolves.toEqual([]);
    await expect(loadOpenRouterModels()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the last catalogue when a refresh fails', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return json({ data: [flash] });
        return json({ error: 'no' }, 500);
      }),
    );
    await expect(loadOpenRouterModels().then((ms) => ms.map((m) => m.id))).resolves.toEqual([flash.id]);
    await expect(loadOpenRouterModels(true)).rejects.toThrow(OPENROUTER_LOAD_ERROR);
    await expect(loadOpenRouterModels().then((ms) => ms.map((m) => m.id))).resolves.toEqual([flash.id]);
    expect(calls).toBe(2);
  });

  it('does not cache a list that has no usable model', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return json({ data: [{ id: 'not a model' }, { no: true }] });
        return json({ data: [flash] });
      }),
    );
    await expect(loadOpenRouterModels()).rejects.toThrow(OPENROUTER_LOAD_ERROR);
    await expect(loadOpenRouterModels().then((ms) => ms.map((m) => m.id))).resolves.toEqual([flash.id]);
    expect(calls).toBe(2);
  });
});
