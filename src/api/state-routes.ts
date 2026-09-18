import bodyParser from 'body-parser';
import type { Router } from 'express';
import type { StateTaskRunner } from '../ai/state-task-runner';
import { isStateTaskStatus } from '../storage/state-task-store';
import { ApiError } from './errors';
import { bodyObject, optionalInteger, optionalString, queryObject, requiredString, wrapRoute } from './request-utils';

export type StateRouteDependencies = {
  stateTasks: StateTaskRunner;
};

export function registerStateRoutes(router: Router, deps: StateRouteDependencies): void {
  const json = bodyParser.json({ limit: '2mb' });

  router.get('/state/tasks', wrapRoute(async req => {
    const query = queryObject(req);
    const status = optionalString(query.status, 'status');
    if (status !== undefined && !isStateTaskStatus(status)) throw new ApiError(400, 'WM_INVALID_REQUEST', 'status is invalid');
    const tasks = await deps.stateTasks.listTasks({
      chatId: requiredString(query.chatId, 'chatId'),
      branchId: optionalString(query.branchId, 'branchId'),
      floorId: optionalString(query.floorId, 'floorId'),
      status,
      limit: optionalInteger(query.limit, 'limit')
    });
    return { tasks };
  }));

  router.post('/state/tasks/run', json, wrapRoute(async req => {
    const body = bodyObject(req);
    return deps.stateTasks.requeueFloor(requiredString(body.chatId, 'chatId'), requiredString(body.floorId, 'floorId'));
  }));
}
