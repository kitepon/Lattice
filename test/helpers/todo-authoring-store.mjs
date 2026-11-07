import { appendTodoEvent as appendStoreEvent } from '../../src/todo-store.mjs';
import { validateProspectiveEvent } from '../../src/todo-readiness.mjs';

export function appendTodoEvent(options) {
  return appendStoreEvent({ validateProspectiveEvent, ...options });
}
