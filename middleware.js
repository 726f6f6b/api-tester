// Vercel Edge Middleware — gates the whole app (static UI + /proxy function)
// behind HTTP basic auth when the TESTER_PASSWORD env var is set.
// Username is "codi"; password is the value of TESTER_PASSWORD.

export const config = { matcher: '/(.*)' };

export default function middleware(request) {
  const password = process.env.TESTER_PASSWORD;
  if (!password) return; // no password configured -> open (local/preview use)

  const expected = 'Basic ' + btoa('codi:' + password);
  if (request.headers.get('authorization') !== expected) {
    return new Response('Authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Codi API Tester"' },
    });
  }
}
