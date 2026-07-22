const { CTraderConnection } = require('@reiryoku/ctrader-layer');
require('dotenv').config();

async function main() {
  const connection = new CTraderConnection({
    host: process.env.CTRADER_HOST || 'demo.ctraderapi.com',
    port: parseInt(process.env.CTRADER_PORT || '5035'),
  });

  await connection.open();
  await connection.sendCommand('ProtoOAApplicationAuthReq', {
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
  });
  await connection.sendCommand('ProtoOAAccountAuthReq', {
    ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID),
    accessToken: process.env.ACCESS_TOKEN,
  });

  const res = await connection.sendCommand('ProtoOASymbolsListReq', {
    ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID),
    includeArchivedSymbols: false,
  });

  const symbols = (res.symbol || []).map((s) => s.symbolName);
  const matches = symbols.filter((n) =>
    /US ?\d|NAS|TECH|DOW|SPX|S&P|500|100|30|2000|GER|UK|EUROPE|JP|JPN|NIKKEI/i.test(n || '')
  );
  console.log('Index-like symbols on this account:');
  for (const n of matches.sort()) console.log('  ', n);

  connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err.message || err);
  process.exit(1);
});
