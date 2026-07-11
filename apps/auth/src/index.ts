import { createApp } from "./app.js";
import { config } from "./config.js";

const app = createApp();
app.listen(config.port, () => {
    console.log(
        `auth listening on :${config.port}` +
        (config.devMode ? ` (dev mode, auto-login: ${config.debugAutoLoginUsername})` : ""),
    );
});
