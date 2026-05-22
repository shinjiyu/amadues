import { Hono } from 'hono';
import { identityMiddleware } from '../identity-mw.js';
import type { UserStore } from '../users.js';

export function buildUsersRouter(users: UserStore): Hono {
  const r = new Hono();
  r.use('*', identityMiddleware(users));

  r.get('/me', (c) => {
    const userId = c.get('userId');
    const u = users.get(userId)!;
    return c.json({ ...u, online: users.isOnline(userId) });
  });

  r.get('/users', (c) => {
    return c.json({ users: users.listWithPresence() });
  });

  r.get('/users/online', (c) => {
    return c.json({ users: users.listWithPresence().filter((u) => u.online) });
  });

  return r;
}
