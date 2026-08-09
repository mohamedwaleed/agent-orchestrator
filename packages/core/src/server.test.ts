import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer } from "./server.js";

describe("HTTP server", () => {
  const server = createHttpServer();

  afterEach(() => {
    server.close();
  });

  it("returns a hello world message from GET /hello", async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/hello`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "hello world" });
  });
});
