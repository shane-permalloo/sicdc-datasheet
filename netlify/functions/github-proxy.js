/**
 * Netlify serverless function: github-proxy
 * -----------------------------------------
 * Proxies read (GET) and write (PUT) requests to the GitHub Contents API,
 * injecting the GITHUB_TOKEN environment variable server-side so the token
 * is never exposed in browser source code or the repository.
 *
 * Set GITHUB_TOKEN in: Netlify dashboard ? Site ? Environment variables
 *
 * Endpoints used by export-word.js:
 *   GET  /.netlify/functions/github-proxy?file=data/submissions-disbursements.json
 *   PUT  /.netlify/functions/github-proxy?file=data/submissions-disbursements.json
 */

const OWNER          = 'shane-permalloo';
const REPO           = 'sicdc-datasheet';
const BRANCH         = 'main';
const ALLOWED_FOLDER = 'data';

// Netlify Identity / GoTrue base URL for this site
const IDENTITY_URL = 'https://sicdc-datasheet.netlify.app/.netlify/identity';

/**
 * Verify a Netlify Identity JWT by calling GoTrue's own /user endpoint.
 * Returns the user object on success, null if the token is invalid/expired.
 * This avoids all local crypto and is always correct regardless of algorithm.
 */
async function _verifyIdentityToken(bearerToken) {
  try {
    const res = await fetch(`${IDENTITY_URL}/user`, {
      headers: { Authorization: `Bearer ${bearerToken}` }
    });
    if (!res.ok) return null;
    return await res.json();   // { id, email, ... }
  } catch (e) {
    console.error('Identity token verification failed:', e.message);
    return null;
  }
}

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization'
  };

  // Handle CORS pre-flight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // Only allow GET and PUT
  if (!['GET', 'PUT'].includes(event.httpMethod)) {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ message: 'Method not allowed' }) };
  }

  // -- Auth: verify the Netlify Identity Bearer token via GoTrue /user --------
  const authHeader  = (event.headers.authorization || event.headers.Authorization || '').trim();
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!bearerToken) {
    return {
      statusCode: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Authentication required. Please sign in.' })
    };
  }

  const identityUser = await _verifyIdentityToken(bearerToken);
  if (!identityUser) {
    return {
      statusCode: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Invalid or expired session. Please sign in again.' })
    };
  }

  // -- GitHub token -----------------------------------------------------------
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'GITHUB_TOKEN environment variable is not set in Netlify.' })
    };
  }

  // -- Validate file path -----------------------------------------------------
  const filePath = event.queryStringParameters?.file;
  if (!filePath) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ message: 'Missing ?file= parameter' }) };
  }
  const normalised = filePath.replace(/\\/g, '/');
  if (normalised.includes('..') || !normalised.startsWith(ALLOWED_FOLDER + '/')) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ message: 'Access denied' }) };
  }

  // -- Proxy to GitHub Contents API ------------------------------------------
  const githubUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${normalised}`;
  const ghHeaders = {
    Authorization: `token ${token}`,
    Accept:        'application/vnd.github+json',
    'User-Agent':  'sicdc-datasheet-proxy'
  };

  let res;
  if (event.httpMethod === 'GET') {
    res = await fetch(`${githubUrl}?ref=${BRANCH}`, { headers: ghHeaders });
  } else {
    res = await fetch(githubUrl, {
      method:  'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body:    event.body
    });
  }

  const responseText = await res.text();
  return {
    statusCode: res.status,
    headers:    { ...CORS, 'Content-Type': 'application/json' },
    body:       responseText
  };
};
