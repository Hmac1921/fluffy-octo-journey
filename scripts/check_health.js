import http from 'http';

const opts = { hostname: 'localhost', port: process.env.PORT || 3000, path: '/health', method: 'GET' };

const req = http.request(opts, (res) => {
  let body = '';
  res.on('data', (c) => (body += c));
  res.on('end', () => {
    console.log('status', res.statusCode);
    console.log('body', body);
    process.exit(res.statusCode === 200 ? 0 : 2);
  });
});
req.on('error', (e) => { console.error('request failed', e.message); process.exit(2); });
req.end();
