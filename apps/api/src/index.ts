import { createServer } from "./server.js";
import { attachSubscriptionServer } from "./subscription.js";
import { prisma } from "./db.js";

const PORT = parseInt(process.env.PORT ?? "8080", 10);

const server = createServer();
attachSubscriptionServer(server, "/v1/graphql");

server.listen(PORT, () => {
    console.log(`api listening on :${PORT} (graphql at /v1/graphql)`);
});

async function shutdown(): Promise<void> {
    server.close();
    await prisma.$disconnect();
    process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
