const fetch = global.fetch || require('node-fetch');
(async () => {
  try {
    const res = await fetch('http://127.0.0.1:3002/api/status');
    const body = await res.json();
    console.log('status code', res.status);
    console.log('open count', body.portfolio?.openPositionCount);
    if (Array.isArray(body.portfolio?.positions)) {
      body.portfolio.positions.slice(0, 20).forEach((p) => {
        console.log(`${p.symbol} ${p.chain} ${p.address}`);
      });
    } else {
      console.log('positions not array', body.portfolio?.positions);
    }
  } catch (e) {
    console.error('error', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
