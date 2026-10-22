/** Where the API lives. Set NEXT_PUBLIC_API_URL in apps/web/.env.local to change it. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1').replace(
  /\/+$/,
  '',
);
export const TOKEN_KEY = 'apiwatch.token';
