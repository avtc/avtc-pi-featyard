// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TodoReadyApi } from "../../src/snippets/vendored/subscribe-to-todo.js";

type MockHandler = (...args: unknown[]) => unknown;

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  _setAreAllTodosDoneOverride,
  areAllTodosDone,
  getTodoCompletedItemId,
  getTodoInProgressItem,
  initTodoIntegration,
  resetTodoIntegration,
} from "../../src/integrations/todo-integration.js";

/** Override: all todos are done */
const ALL_TODOS_DONE = true;

/** Override: not all todos are done */
const NOT_ALL_TODOS_DONE = false;

/** Clear override (use real implementation) */
const NO_TODO_OVERRIDE: boolean | null = null;

function createFakePi() {
  const eventHandlers = new Map<string, MockHandler[]>();
  return {
    pi: {
      on(_channel: string, _handler: MockHandler) {
        // session_shutdown etc.
        return () => {};
      },
      events: {
        on(channel: string, handler: MockHandler) {
          const list = eventHandlers.get(channel) ?? [];
          list.push(handler);
          eventHandlers.set(channel, list);
          return () => {
            const handlers = eventHandlers.get(channel);
            if (handlers) {
              const idx = handlers.indexOf(handler);
              if (idx >= 0) handlers.splice(idx, 1);
            }
          };
        },
        off: vi.fn(),
        emit: vi.fn(),
      },
    } as unknown as ExtensionAPI,
    eventHandlers,
    fireReady(api: TodoReadyApi) {
      const handlers = eventHandlers.get("pi-todo:ready");
      if (!handlers) return;
      for (const h of handlers) h(api);
    },
  };
}

describe("initTodoIntegration", () => {
  afterEach(() => {
    resetTodoIntegration();
  });

  test("subscribes to pi-todo:ready and registers disableBuiltInFollowUp", () => {
    const { pi, eventHandlers, fireReady } = createFakePi();

    initTodoIntegration(pi);

    // Should have subscribed to the ready event
    expect(eventHandlers.has("pi-todo:ready")).toBe(true);

    // Emit the ready event with a mock API
    const disableBuiltInFollowUp = vi.fn();
    fireReady({ disableBuiltInFollowUp, getCompletedItemId: () => null, getInProgressItem: () => null });

    // disableBuiltInFollowUp should have been called (queued from init)
    expect(disableBuiltInFollowUp).toHaveBeenCalledTimes(1);
  });
});

describe("getTodoCompletedItemId / getTodoInProgressItem", () => {
  test("return null when pi-todo has not emitted ready", () => {
    resetTodoIntegration();
    expect(getTodoCompletedItemId()).toBeNull();
    expect(getTodoInProgressItem()).toBeNull();
  });

  test("delegate to API after :ready fires", () => {
    resetTodoIntegration();
    const { pi, fireReady } = createFakePi();

    initTodoIntegration(pi);

    fireReady({
      disableBuiltInFollowUp: vi.fn(),
      getCompletedItemId: () => "3.1",
      getInProgressItem: () => "In progress: ▶ 3.2: Add validation",
    });

    expect(getTodoCompletedItemId()).toBe("3.1");
    expect(getTodoInProgressItem()).toBe("In progress: ▶ 3.2: Add validation");
    resetTodoIntegration();
  });

  test("return null after resetTodoIntegration even if ready was received", () => {
    resetTodoIntegration();
    const { pi, fireReady } = createFakePi();

    initTodoIntegration(pi);
    fireReady({
      disableBuiltInFollowUp: vi.fn(),
      getCompletedItemId: () => "3.1",
      getInProgressItem: () => "In progress: ▶ 3.2: Add validation",
    });

    // Confirm they return data before reset
    expect(getTodoCompletedItemId()).toBe("3.1");
    expect(getTodoInProgressItem()).toBe("In progress: ▶ 3.2: Add validation");

    // After reset, should return null
    resetTodoIntegration();
    expect(getTodoCompletedItemId()).toBeNull();
    expect(getTodoInProgressItem()).toBeNull();
  });

  test("session_shutdown cleanup removes :ready listener, preventing duplicate hooks on reload", () => {
    const shutdownHandlers: MockHandler[] = [];
    const eventHandlers = new Map<string, MockHandler[]>();

    const fakePi = {
      on(event: string, handler: MockHandler) {
        if (event === "session_shutdown") shutdownHandlers.push(handler);
        return () => {};
      },
      events: {
        on(channel: string, handler: MockHandler) {
          const list = eventHandlers.get(channel) ?? [];
          list.push(handler);
          eventHandlers.set(channel, list);
          return () => {
            const handlers = eventHandlers.get(channel);
            if (handlers) {
              const idx = handlers.indexOf(handler);
              if (idx >= 0) handlers.splice(idx, 1);
            }
          };
        },
        off: vi.fn(),
        emit: vi.fn(),
      },
    } as unknown as ExtensionAPI;

    // First subscription
    initTodoIntegration(fakePi);
    expect(eventHandlers.get("pi-todo:ready")?.length).toBe(1);

    // Fire session_shutdown — should clean up :ready listener
    for (const h of shutdownHandlers) h();
    expect(eventHandlers.get("pi-todo:ready")?.length ?? 0).toBe(0);

    // Re-subscribe (simulates reload)
    shutdownHandlers.length = 0;
    initTodoIntegration(fakePi);
    expect(eventHandlers.get("pi-todo:ready")?.length).toBe(1);

    // Fire :ready and verify hook fires exactly once
    const handlers = eventHandlers.get("pi-todo:ready");
    if (!handlers) return;
    handlers[0]?.({
      disableBuiltInFollowUp: vi.fn(),
      getCompletedItemId: () => null,
      getInProgressItem: () => null,
    });

    resetTodoIntegration();
  });
});

describe("areAllTodosDone", () => {
  test("returns true when pi-todo has not emitted ready", () => {
    resetTodoIntegration();
    expect(areAllTodosDone()).toBe(true);
  });

  test("delegates to API after :ready fires", () => {
    resetTodoIntegration();
    const { pi, fireReady } = createFakePi();
    initTodoIntegration(pi);

    fireReady({
      disableBuiltInFollowUp: vi.fn(),
      getCompletedItemId: () => null,
      getInProgressItem: () => null,
      areAllTodosDone: () => false,
    });

    expect(areAllTodosDone()).toBe(false);
    resetTodoIntegration();
  });

  test("override takes precedence over API", () => {
    resetTodoIntegration();
    const { pi, fireReady } = createFakePi();
    initTodoIntegration(pi);

    fireReady({
      disableBuiltInFollowUp: vi.fn(),
      getCompletedItemId: () => null,
      getInProgressItem: () => null,
      areAllTodosDone: () => false,
    });

    _setAreAllTodosDoneOverride(ALL_TODOS_DONE);
    expect(areAllTodosDone()).toBe(true);

    _setAreAllTodosDoneOverride(NO_TODO_OVERRIDE);
    expect(areAllTodosDone()).toBe(false);

    resetTodoIntegration();
  });

  test("resetTodoIntegration clears override", () => {
    resetTodoIntegration();
    _setAreAllTodosDoneOverride(NOT_ALL_TODOS_DONE);
    expect(areAllTodosDone()).toBe(false);

    resetTodoIntegration();
    // After reset, override is null so defaults to true (no API)
    expect(areAllTodosDone()).toBe(true);
  });
});
