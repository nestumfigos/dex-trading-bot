const axios = require('axios');

axios.get('https://api.kucoin.com/api/v1/symbols?symbol=UB-USDT')
  .then(r => {
    const list = Array.isArray(r.data?.data) ? r.data.data : [r.data?.data];
    const sym = list.find(s => s?.symbol === 'UB-USDT') || list[0];
    console.log('UB-USDT market info:', JSON.stringify(sym, null, 2));
  })
  .catch(e => console.log('err:', e.response?.data || e.message));
