const { CTraderConnection } = require('@reiryoku/ctrader-layer');
require('dotenv').config();

async function lookupAccounts() {
  const connection = new CTraderConnection({
    host: process.env.CTRADER_HOST || 'demo.ctraderapi.com',
    port: parseInt(process.env.CTRADER_PORT || '5035'),
  });

  await connection.open();
  console.log('Connected to cTrader');

  await connection.sendCommand('ProtoOAApplicationAuthReq', {
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
  });
  console.log('Application authenticated');

  const res = await connection.sendCommand('ProtoOAGetAccountListByAccessTokenReq', {
    accessToken: process.env.ACCESS_TOKEN,
  });

  const accounts = res?.ctidTraderAccount ?? [];
  if (accounts.length === 0) {
    console.log('No accounts found for this access token.');
  } else {
    console.log(`\nFound ${accounts.length} account(s):\n`);
    for (const acc of accounts) {
      // traderLogin is the number shown in the cTrader UI ("the login"); the
      // ctidTraderAccountId is the internal id every trade request needs. The
      // .env CTRADER_ACCOUNTS entries take the login; ACCOUNT_ID takes the ctid.
      console.log(`  login                : ${acc.traderLogin ?? 'n/a'}`);
      console.log(`  ctidTraderAccountId  : ${acc.ctidTraderAccountId}`);
      console.log(`  brokerName           : ${acc.brokerName ?? 'n/a'}`);
      console.log(`  isLive               : ${acc.isLive}`);
      console.log('');
    }
  }

  connection.close();
  process.exit(0);
}

lookupAccounts().catch((err) => {
  console.error('Failed:', err.message || err);
  process.exit(1);
});
