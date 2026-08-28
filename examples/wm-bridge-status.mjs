import { connect } from "../lib/client.mjs";

const { rpc, close } = await connect(9222);

const status = await rpc("agent.status");
console.log("AGENT_STATUS", JSON.stringify(status, null, 2));

const tabs = await rpc("tabs.list");
console.log("TABS", JSON.stringify(tabs, null, 2));

close();
