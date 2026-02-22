async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' , ...(opts.headers || {})},
    credentials: 'same-origin',
    ...opts,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function whoAmI() {
  try {
    const { user } = await api('/api/me');
    return user;
  } catch {
    return null;
  }
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  location.href = '/login';
}

function qs(sel){return document.querySelector(sel)}
function qsa(sel){return Array.from(document.querySelectorAll(sel))}

window.FM = { api, whoAmI, logout, qs, qsa };
