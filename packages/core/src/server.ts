import { createServer, type Server } from "node:http";

/**
 * Creates the orchestrator HTTP server.
 *
 * The caller owns the server lifecycle and can choose which port to listen on.
 */
export function createHttpServer(): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/hello") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "hello world" }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });
}
