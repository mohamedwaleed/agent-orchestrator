import { createServer, type Server } from "node:http";
import { products } from "./product-store.js";

/** Creates the HTTP server used to expose the orchestrator's API. */
export function createHttpServer(): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/hello") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "hello world" }));
      return;
    }

    if (request.method === "GET" && request.url === "/goodbye") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "goodbye world" }));
      return;
    }

    if (request.method === "GET" && request.url === "/ping") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "pong" }));
      return;
    }

    if (request.method === "GET" && request.url === "/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", version: "1.0.0" }));
      return;
    }

    if (request.method === "GET" && request.url === "/products") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(products));
      return;
    }

    response.writeHead(404);
    response.end();
  });
}
