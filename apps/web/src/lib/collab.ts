/** The collab WebSocket endpoint, proxied next to the app (Vite in dev, Caddy in production). */
export const collabUrl = () => `${location.origin.replace(/^http/, 'ws')}/collab`;
