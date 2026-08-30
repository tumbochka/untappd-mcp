type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  appId: string;
  projectId?: string;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    };
    return entities[character];
  });
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function document(title: string, body: string, nonce?: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style nonce="${nonce ?? ''}">
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { max-width: 42rem; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.5; }
      .card { border: 1px solid #7776; border-radius: .75rem; padding: 1.5rem; }
      button { padding: .7rem 1rem; border: 0; border-radius: .45rem; font: inherit; cursor: pointer; }
      .primary { background: #2563eb; color: white; }
      .secondary { background: #6b7280; color: white; margin-left: .75rem; }
      #error { color: #b91c1c; min-height: 1.5rem; }
      code { overflow-wrap: anywhere; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

export function firebaseLoginPage(input: {
  firebase: FirebaseWebConfig;
  continueTo: string;
  nonce: string;
}): string {
  const body = `<main class="card">
  <h1>Sign in to Untappd MCP</h1>
  <p>Sign in with the Firebase account whose Untappd data you want to connect.</p>
  <button id="sign-in" class="primary">Sign in with Google</button>
  <p id="error" role="alert"></p>
</main>
<script nonce="${input.nonce}" src="https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js"></script>
<script nonce="${input.nonce}" src="https://www.gstatic.com/firebasejs/10.13.2/firebase-auth-compat.js"></script>
<script nonce="${input.nonce}">
  const firebaseConfig = ${jsonForScript(input.firebase)};
  const continueTo = ${jsonForScript(input.continueTo)};
  const error = document.getElementById('error');
  const button = document.getElementById('sign-in');
  firebase.initializeApp(firebaseConfig);
  button.addEventListener('click', async () => {
    button.disabled = true;
    error.textContent = '';
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      const result = await firebase.auth().signInWithPopup(provider);
      const idToken = await result.user.getIdToken();
      const response = await fetch('/oauth/firebase/session', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + idToken }
      });
      if (!response.ok) throw new Error('Could not create a secure session.');
      window.location.assign(continueTo);
    } catch (exception) {
      error.textContent = exception instanceof Error ? exception.message : 'Sign-in failed.';
      button.disabled = false;
    }
  });
</script>`;
  return document('Sign in to Untappd MCP', body, input.nonce);
}

export function authorizationConsentPage(input: {
  clientName: string;
  redirectUri: string;
  scopes: string[];
  transactionId: string;
  nonce: string;
}): string {
  const permissions = input.scopes
    .map(scope => `<li><code>${escapeHtml(scope)}</code></li>`)
    .join('');
  const body = `<main class="card">
  <h1>Authorize ${escapeHtml(input.clientName)}</h1>
  <p>This MCP client requests permission to use your connected Untappd account.</p>
  <p><strong>Redirect destination:</strong> <code>${escapeHtml(input.redirectUri)}</code></p>
  <p><strong>Permissions:</strong></p>
  <ul>${permissions}</ul>
  <form action="/oauth/authorize/consent" method="post">
    <input type="hidden" name="transaction_id" value="${escapeHtml(input.transactionId)}">
    <button class="primary" type="submit" name="decision" value="approve">Allow</button>
    <button class="secondary" type="submit" name="decision" value="deny">Deny</button>
  </form>
</main>`;
  return document('Authorize Untappd MCP', body, input.nonce);
}
