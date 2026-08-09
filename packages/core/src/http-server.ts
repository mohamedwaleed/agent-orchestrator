import { createServer, type Server } from "node:http";

/** Creates the HTTP server used to expose the orchestrator's API. */
export function createHttpServer(): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/hello") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "hello world" }));
      return;
    }

    response.writeHead(404);
    response.end();
  });
}
