import express, { Router } from 'express';
import { resolve } from 'node:path';

// The same origin serves /r and the compiled landing outside Vite development.
export function frontendRoutes(directory = resolve('dist')) {
  const router = Router();
  router.use(express.static(directory, { index: false }));
  router.get(['/', '/demo/campana', '/demo/landing'], (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(resolve(directory, 'index.html'));
  });
  return router;
}
