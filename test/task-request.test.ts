import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  cancelTaskRequest,
  retryTaskRequest,
  runTaskRequest,
  TASK_RETRY_MAX_MS,
  taskRetryDelay,
  TaskRequestError
} from '../src/main/task-request.js';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('keeps a caller-owned operation retrying on a short capped backoff until it succeeds', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(1);
  const work = vi.fn().mockRejectedValueOnce(new TaskRequestError('rate_limited', true))
    .mockRejectedValueOnce(new TaskRequestError('http_503', true))
    .mockRejectedValueOnce(new TaskRequestError('rate_limited', true)).mockResolvedValue('ready');
  const result = retryTaskRequest(work, new AbortController().signal, vi.fn());
  await vi.advanceTimersByTimeAsync(104999);
  expect(work).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe('ready');
  expect(work).toHaveBeenCalledTimes(4);
});

it('turns an excessive Retry-After into a bounded recheck instead of a terminal sleep', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(1);
  const delay = 30 * 24 * 60 * 60 * 1000;
  const work = vi.fn().mockRejectedValueOnce(new TaskRequestError('rate_limited', true, delay)).mockResolvedValue('ready');
  const result = retryTaskRequest(work, new AbortController().signal, vi.fn());
  await vi.advanceTimersByTimeAsync(TASK_RETRY_MAX_MS - 1);
  expect(work).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe('ready');
  expect(work).toHaveBeenCalledTimes(2);
});

it('honors Retry-After, coalesces the same invocation and never retries a successful result', async () => {
  vi.useFakeTimers(); const id = randomUUID(), progress = vi.fn();
  vi.spyOn(Math, 'random').mockReturnValue(1);
  const work = vi.fn().mockRejectedValueOnce(new TaskRequestError('rate_limited', true, 30000)).mockResolvedValue('validated');
  const result = runTaskRequest(id, 'same task', work, progress);
  expect(runTaskRequest(id, 'same task', work, progress)).toBe(result);
  await vi.advanceTimersByTimeAsync(29999); expect(work).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'retrying', attempt: 2 }));
  await vi.advanceTimersByTimeAsync(1); expect(await result).toBe('validated');
  expect(await runTaskRequest(id, 'same task', work, progress)).toBe('validated');
  expect(work).toHaveBeenCalledTimes(2);
  await expect(runTaskRequest(id, 'different task', work, progress)).rejects.toThrow('task_request_conflict');
});

it('cancels a retry wait without another attempt and aborts an active provider signal', async () => {
  vi.useFakeTimers(); const id = randomUUID(), progress = vi.fn();
  const work = vi.fn().mockRejectedValue(new TaskRequestError('http_503', true));
  const result = runTaskRequest(id, 'task', work, progress); void result.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  expect(cancelTaskRequest(id)).toBe(true);
  await expect(result).rejects.toThrow('task_cancelled');
  await vi.advanceTimersByTimeAsync(30000); expect(work).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'cancelled' }));
  const activeId = randomUUID(); let signal!: AbortSignal;
  const active = runTaskRequest(activeId, 'active', async value => {
    signal = value; return new Promise((_resolve, reject) => value.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }, progress); void active.catch(() => undefined);
  cancelTaskRequest(activeId); expect(signal.aborted).toBe(true);
  await expect(active).rejects.toThrow('task_cancelled');
});

it('bounds transient retries and never retries terminal/ambiguous failures', async () => {
  vi.useFakeTimers(); const progress = vi.fn();
  vi.spyOn(Math, 'random').mockReturnValue(1);
  const work = vi.fn().mockRejectedValue(new TaskRequestError('rate_limited', true));
  const result = runTaskRequest(randomUUID(), 'task', work, progress); void result.catch(() => undefined);
  await vi.runAllTimersAsync(); await expect(result).rejects.toThrow('rate_limited');
  expect(work).toHaveBeenCalledTimes(3);
  const refused = vi.fn().mockRejectedValue(new TaskRequestError('goal_browser_send_unconfirmed'));
  await expect(runTaskRequest(randomUUID(), 'browser', refused, progress)).rejects.toThrow('goal_browser_send_unconfirmed');
  expect(refused).toHaveBeenCalledTimes(1);
  const delayed = vi.fn().mockRejectedValue(new TaskRequestError('rate_limited', true, 600000));
  const bounded = runTaskRequest(randomUUID(), 'long backoff', delayed, progress); void bounded.catch(() => undefined);
  await vi.runAllTimersAsync();
  await expect(bounded).rejects.toThrow('rate_limited');
  expect(delayed).toHaveBeenCalledTimes(3);
});

it('jitters provider retries inside the short bounded window', () => {
  const error = new TaskRequestError('rate_limited', true, 30 * 60_000);
  expect(taskRetryDelay(error, 1, 0)).toBe(45_000);
  expect(taskRetryDelay(error, 1, 1)).toBe(TASK_RETRY_MAX_MS);
});
