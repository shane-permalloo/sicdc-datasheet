/**
 * Netlify serverless function: github-proxy
 * ─────────────────────────────────────────
 * Proxies read (GET) and write (PUT) requests to the GitHub Contents API,
 * injecting the GITHUB_TOKEN environment variable server-side so the token
 * is never exposed in browser source code or the repository.
 *
 * Set GITHUB_TOKEN in: Netlify dashboard → Site → Environment variables
 *
 * Endpoints used by export-word.js:
 *   GET  /.netlify/functions/github-proxy?file=data/submissions-disbursements.json
 *   PUT  /.netlify/functions/github-proxy?file=data/submissions-disbursements.json
 */

const OWNER         = 'shane-permalloo';
const REPO          = 'sicdc-datasheet';
const BRANCH        = 'main';
const ALLOWED_FOLDER = 'data';   // only files inside this folder are accessible

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

  // ── Netlify Identity auth check ───────────────────────
  // Netlify automatically validates the Bearer JWT from the Authorization header
  // and populates event.clientContext.user when the token is valid.
  const netlifyUser = event.clientContext && event.clientContext.user;
  if (!netlifyUser) {
    return {
      statusCode: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Authentication required. Please sign in.' })
    };
  }

  // Token must be present in environment
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'GITHUB_TOKEN environment variable is not set in Netlify.' })
    };
  }

  // Validate the requested file path
  const filePath = event.queryStringParameters?.file;
  if (!filePath) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ message: 'Missing ?file= parameter' }) };
  }
  // Guard against path traversal and restrict to the allowed folder
  const normalised = filePath.replace(/\\/g, '/');
  if (normalised.includes('..') || !normalised.startsWith(ALLOWED_FOLDER + '/')) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ message: 'Access denied' }) };
  }

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
    // PUT — forward the body from the browser as-is
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
