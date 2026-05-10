import http from "node:http";

import { createRouter } from "./router.js";

const port = Number(process.env.PORT ?? 8797);
const server = http.createServer(createRouter());

server.listen(port, "0.0.0.0", () => {
  console.log(`subscription-billing-js listening on ${port}`);
});
