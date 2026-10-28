import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  models: [] as Array<{ id: string; label: string; efforts: string[]; aliases?: string[] }>,
  goal: { helperModel: 'gpt-5.6-sol', helperReasoning: 'xhigh' } as Record<string, unknown>
}));

vi.mock('../src/main/chat-models.js', async original => ({
  ...(await original<object>()),
  getChatModels: () => ({ state: 'ready', models: state.models })
}));
vi.mock('../src/main/config.js', async original => {
  const real = await original<typeof import('../src/main/config.js')>();
  return { ...real, getConfig: () => ({ ...real.defaultConfig(), goal: { ...real.defaultConfig().goal, ...state.goal } }) };
});

const { goalHelperSelection, goalProgressFor } = await import('../src/main/goal.js');

beforeEach(() => {
  state.models = [
    { id: 'gpt-5-6-thinking', label: '5.6', efforts: ['medium', 'high', 'xhigh'], aliases: ['gpt-5.6-sol'] },
    { id: 'gpt-5-5-thinking', label: '5.5', efforts: ['medium', 'high'] }
  ];
  state.goal = { helperModel: 'gpt-5.6-sol', helperReasoning: 'xhigh' };
});

it('keeps a saved helper model and reasoning the account offers', () => {
  expect(goalHelperSelection()).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' });
});

it('uses the same GPT-6 default for execution and progress when helper settings are absent', () => {
  state.models = [];
  state.goal = { helperModel: undefined, helperReasoning: undefined };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-6-thinking', reasoningEffort: 'high' });
  expect(goalProgressFor('loop').model).toBe('gpt-6-thinking');
  expect(goalProgressFor('goal').model).toBe('gpt-6-thinking');
});

it('resolves the stable 5.6 profile setting to the observed thinking picker instead of inheriting Medium or Instant', () => {
  state.models = [
    { id: 'gpt-5-6-thinking', label: '5.6', efforts: ['medium', 'high'] },
    { id: 'gpt-5-5-instant', label: '5.5 Instant', efforts: ['none'] }
  ];
  state.goal = { helperModel: '5.6', helperReasoning: 'high' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'high' });
});

it('holds the exact 5.6 Extra High pin instead of falling to Medium', () => {
  state.models = [
    { id: 'gpt-5-6-thinking', label: '5.6', efforts: ['medium'] },
    { id: 'gpt-5-5-instant', label: '5.5 Instant', efforts: ['none'] }
  ];
  state.goal = { helperModel: '5.6', helperReasoning: 'xhigh' };
  expect(goalHelperSelection()).toEqual({ model: '5.6', reasoningEffort: 'xhigh' });
});

it('fails closed instead of inheriting Instant when no verified 5.6 High or Medium choice exists', () => {
  state.models = [
    { id: 'gpt-5-5-instant', label: '5.5 Instant', efforts: ['none'] }
  ];
  state.goal = { helperModel: '5.6', helperReasoning: 'high' };
  expect(goalHelperSelection()).toEqual({ model: '5.6', reasoningEffort: 'high' });
});

it('keeps an exact 5.6 High pin when the observed picker exposes no allowed effort', () => {
  state.models = [
    { id: 'gpt-5-6-thinking', label: '5.6', efforts: ['none'] },
    { id: 'gpt-5-5-instant', label: '5.5 Instant', efforts: ['none'] }
  ];
  state.goal = { helperModel: 'gpt-5-6-thinking', helperReasoning: 'high' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'high' });
});

it('preserves a saved GPT-6 Pro pair when unavailable rather than inheriting the browser model', () => {
  state.goal = { helperModel: 'gpt-6-pro', helperReasoning: 'pro' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-6-pro', reasoningEffort: 'pro' });
});

it('holds GPT-6 High when only older models are currently offered', () => {
  state.goal = { helperModel: 'gpt-6-thinking', helperReasoning: 'high' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-6-thinking', reasoningEffort: 'high' });
});

it('holds GPT-6 High when GPT-6 exists but High is not offered for this account', () => {
  state.models = [{ id: 'gpt-6-thinking', label: 'GPT-6 Thinking', efforts: ['medium'] }];
  state.goal = { helperModel: 'gpt-6-thinking', helperReasoning: 'high' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-6-thinking', reasoningEffort: 'high' });
});

it('resolves the stable GPT-6 alias to the verified High native picker', () => {
  state.models = [{ id: 'gpt-6-thinking', label: 'GPT-6 Thinking', efforts: ['medium', 'high'] }];
  state.goal = { helperModel: '6', helperReasoning: 'high' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-6-thinking', reasoningEffort: 'high' });
});

it('never promotes a generic GPT-6 High alias to the account-specific Pro variant', () => {
  state.models = [
    { id: 'gpt-6-pro', label: 'GPT-6 Pro', efforts: ['high', 'pro'] },
    { id: 'gpt-6-thinking', label: 'GPT-6 Thinking', efforts: ['high'] }
  ];
  state.goal = { helperModel: '6', helperReasoning: 'high' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-6-thinking', reasoningEffort: 'high' });
});

it('keeps the explicitly authorized 5.5 Extra High pin when that effort is not yet observed', () => {
  state.goal = { helperModel: 'gpt-5-5-thinking', helperReasoning: 'xhigh' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-5-5-thinking', reasoningEffort: 'xhigh' });
});

it('resolves the authorized GPT-5.5 display setting to this account\'s observed High model', () => {
  state.models = [
    { id: 'gpt-6', label: 'GPT-6', efforts: ['none'] },
    { id: 'gpt-5-5', label: 'GPT-5.5', efforts: ['none', 'medium', 'high'],
      aliases: ['gpt-5-5-instant', 'gpt-5-5-thinking'] }
  ];
  state.goal = { helperModel: 'gpt-5.5', helperReasoning: 'high' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-5-5', reasoningEffort: 'high' });
});

it('never inherits GPT-6 Instant when the explicitly authorized 5.5 High fallback is absent', () => {
  state.models = [{ id: 'gpt-6', label: 'GPT-6', efforts: ['none'] }];
  state.goal = { helperModel: 'gpt-5.5', helperReasoning: 'high' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-5.5', reasoningEffort: 'high' });
});

it('does not choose between ambiguous observed 5.5 High variants', () => {
  state.models = [
    { id: 'gpt-5-5-thinking', label: 'GPT-5.5 Thinking', efforts: ['high'] },
    { id: 'gpt-5-5-pro', label: 'GPT-5.5 Pro', efforts: ['high'] }
  ];
  state.goal = { helperModel: 'gpt-5.5', helperReasoning: 'high' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-5.5', reasoningEffort: 'high' });
});

it('changes nothing before the account catalog has been observed', () => {
  state.models = [];
  state.goal = { helperModel: 'gpt-6-pro', helperReasoning: 'pro' };
  expect(goalHelperSelection()).toEqual({ model: 'gpt-6-pro', reasoningEffort: 'pro' });
});
