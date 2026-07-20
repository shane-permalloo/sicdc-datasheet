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
    // First try the standard Contents API
    res = await fetch(`${githubUrl}?ref=${BRANCH}`, { headers: ghHeaders });
    
    // If successful, check if we got the content
    if (res.ok) {
      const data = await res.json();
      
      // If content field is missing, the file is likely too large (>1MB).
      // Fall back to the raw content endpoint which has no size limits.
      if (!data.content) {
        console.log('[Proxy] File too large for Contents API, fetching from raw endpoint...');
        const rawUrl = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${normalised}`;
        const rawRes = await fetch(rawUrl, {
          headers: { Authorization: `token ${token}` }
        });
        
        if (!rawRes.ok) {
          return {
            statusCode: rawRes.status,
            headers:    { ...CORS, 'Content-Type': 'application/json' },
            body:       JSON.stringify({ message: `Failed to fetch from raw endpoint: ${rawRes.statusText}` })
          };
        }
        
        // Get the raw file content and base64-encode it for consistency
        const rawContent = await rawRes.text();
        const encoded = Buffer.from(rawContent).toString('base64');
        
        // Return in the same format as Contents API so the browser code doesn't change
        const responseBody = JSON.stringify({
          name:    data.name || normalised.split('/').pop(),
          path:    normalised,
          sha:     data.sha || 'unknown',
          size:    data.size || rawContent.length,
          content: encoded
        });
        
        return {
          statusCode: 200,
          headers:    { ...CORS, 'Content-Type': 'application/json' },
          body:       responseBody
        };
      }
      
      // For smaller files that have content, return the API response as-is
      // (already parsed as JSON, so stringify it back)
      return {
        statusCode: res.status,
        headers:    { ...CORS, 'Content-Type': 'application/json' },
        body:       JSON.stringify(data)
      };
    }
    
    // If the initial request failed, return the error
    const responseText = await res.text();
    return {
      statusCode: res.status,
      headers:    { ...CORS, 'Content-Type': 'application/json' },
      body:       responseText
    };
  } else {
    // PUT request (write)
    res = await fetch(githubUrl, {
      method:  'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body:    event.body
    });
    
    const responseText = await res.text();
    return {
      statusCode: res.status,
      headers:    { ...CORS, 'Content-Type': 'application/json' },
      body:       responseText
    };
  }
};
