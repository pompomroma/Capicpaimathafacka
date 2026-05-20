(() => {
  const form = document.getElementById('auth-form');
  const emailEl = document.getElementById('email');
  const pwEl = document.getElementById('password');
  const err = document.getElementById('auth-error');
  const registerBtn = document.getElementById('register-btn');

  function showError(msg) { err.textContent = msg; err.hidden = !msg; }

  async function submit(path) {
    showError('');
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailEl.value.trim(), password: pwEl.value }),
        credentials: 'include',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return showError(j.error || `error ${r.status}`);
      location.href = '/';
    } catch (e) { showError(e.message); }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); submit('/api/login'); });
  registerBtn.addEventListener('click', () => submit('/api/register'));
})();
