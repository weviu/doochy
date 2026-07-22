import dotenv from "dotenv";
import { CTraderConnection } from "@reiryoku/ctrader-layer";

dotenv.config();

const POSITION_ID = 3300007;
const VOLUME = 200; // volumeCents from the placement log: BUY 0.02 lots (200 vol)

async function main() {
  const conn = new CTraderConnection({
    host: process.env.CTRADER_HOST || "demo.ctraderapi.com",
    port: parseInt(process.env.CTRADER_PORT || "5035"),
  });
  await conn.open();
  await conn.sendCommand("ProtoOAApplicationAuthReq", {
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
  });
  await conn.sendCommand("ProtoOAAccountAuthReq", {
    ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
    accessToken: process.env.ACCESS_TOKEN,
  });
  console.log(`Closing position ${POSITION_ID} volume ${VOLUME}...`);
  const res = await conn.sendCommand("ProtoOAClosePositionReq", {
    ctidTraderAccountId: parseInt(process.env.ACCOUNT_ID || "0"),
    positionId: POSITION_ID,
    volume: VOLUME,
  });
  console.log("Response:", JSON.stringify(res).substring(0, 300));
  process.exit(0);
}

main().catch((e) => {
  console.error("Close failed:", e.message || e);
  process.exit(1);
});
