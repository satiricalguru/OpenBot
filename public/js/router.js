// Minimal history-API router.
const routes = [];
let notFound = null;
export function route(pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\/:(\w+)(\?)?/g, (_, k, opt) => { keys.push(k); return opt ? '(?:/([^/]+))?' : '/([^/]+)'; }) + '/?$');
  routes.push({ re, keys, handler });
}
export const fallback = (fn) => (notFound = fn);

let current = null;
export function navigate(url, { replace = false } = {}) {
  if (url === location.pathname + location.search && !replace) return dispatch();
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
  dispatch();
}
export function dispatch() {
  const path = location.pathname;
  const query = Object.fromEntries(new URLSearchParams(location.search));
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) {
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1] && decodeURIComponent(m[i + 1])]));
      current?.cleanup?.();
      current = { cleanup: r.handler(params, query) };
      return;
    }
  }
  notFound?.();
}
window.addEventListener('popstate', dispatch);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.target === '_blank' || e.metaKey || e.ctrlKey || a.hasAttribute('download')) return;
  const href = a.getAttribute('href');
  if (!href.startsWith('/') || href.startsWith('/media') || href.startsWith('/api') || href.startsWith('/embed')) return;
  e.preventDefault();
  navigate(href);
});
