// Reads [{url, method, headers, payload}] on stdin, fetches them (20 at a time), prints [{code, body, headers}].
let input = '';
process.stdin.on('data', d => (input += d)).on('end', async () => {
  const reqs = JSON.parse(input || '[]');
  const one = async r => {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
      const res = await fetch(r.url, { method: String(r.method || 'get').toUpperCase(), headers: r.headers || {}, body: r.payload, signal: ctl.signal });
      const body = await res.text(); clearTimeout(t);
      const h = {}; res.headers.forEach((v, k) => { h[k] = v; h[k.replace(/(^|-)([a-z])/g, (m, a, b) => a + b.toUpperCase())] = v; });
      return { code: res.status, body, headers: h };
    } catch (e) { return { code: 599, body: String(e), headers: {} }; }
  };
  const out = [];
  for (let i = 0; i < reqs.length; i += 20) out.push(...(await Promise.all(reqs.slice(i, i + 20).map(one))));
  process.stdout.write(JSON.stringify(out));
});
