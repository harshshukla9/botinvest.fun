import { config as loadEnvironment } from "dotenv";
import { loadConfig } from "./config.js";
import { createServerApp } from "./bootstrap.js";

loadEnvironment({ path: ".env.local" });
loadEnvironment({ path: ".env" });

const config = loadConfig();
const app = createServerApp();

app.listen(config.PORT, () => {
  console.log(
    JSON.stringify({
      event: "server_started",
      port: config.PORT,
      network: config.networkName,
      chainId: config.network.chainId,
      lumora: config.LUMORA_API_BASE,
    }),
  );
});
