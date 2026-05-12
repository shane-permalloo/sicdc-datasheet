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

const { webcrypto }  = require('crypto');

const OWNER          = 'shane-permalloo';
const REPO           = 'sicdc-datasheet';
const BRANCH         = 'main';
const ALLOWED_FOLDER = 'data';   // only files inside this folder are accessible

// Netlify Identity URL — must match the site that issues the JWTs
const IDENTITY_URL   = 'https://sicdc-datasheet.netlify.app/.netlify/identity';

// ── JWKS cache (reused across warm Lambda invocations) ────────────────────────
let _jwksKeys      = null;
let _jwksFetchedAt = 0;

async function _getSigningKeys() {
  const now = Date.now();
  if (_jwksKeys && now - _jwksFetchedAt < 3_600_000) return _jwksKeys;
  const res = await fetch(`${IDENTITY_URL}/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys } = await res.json();
  _jwksKeys      = keys;
  _jwksFetchedAt = now;
  return keys;
}

/**
 * Verify a Netlify Identity JWT (RS256) against the published JWKS.
 * Returns the decoded payload on success, null on any failure.
 */
async function _verifyIdentityToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSig] = parts;

  let header, payload;
  try {
    header  = JSON.parse(Buffer.from(rawHeader,  'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8'));
  } catch { return null; }

  // Reject expired tokens
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  // Must have a subject (user id)
  if (!payload.sub) return null;

  try {
    const keys      = await _getSigningKeys();
    const jwk       = keys.find(k => !header.kid || k.kid === header.kid);
    if (!jwk) return null;

    const { subtle } = webcrypto;
    const cryptoKey  = await subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );
    const data      = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
    const signature = Buffer.from(rawSig, 'base64url');
    const valid     = await subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, data);
    return valid ? payload : null;
  } catch (e) {
    console.error('JWT verification error:', e.message);
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

  // ── Auth: extract + cryptographically verify the Netlify Identity JWT ─────
  // event.clientContext.user is NOT used — Netlify no longer injects it reliably.
  // Instead we extract the Bearer token from the Authorization header and verify
  // it directly against the site's JWKS (RS256 public key).
  const authHeader  = (event.headers.authorization || event.headers.Authorization || '').trim();
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!bearerToken) {
    return {
      statusCode: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Authentication required. Please sign in.' })
    };
  }

  const userPayload = await _verifyIdentityToken(bearerToken).catch(() => null);
  if (!userPayload) {
    return {
      statusCode: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Invalid or expired session. Please sign in again.' })
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
